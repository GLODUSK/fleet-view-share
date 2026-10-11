# Housekeeping

Fleet View's clean-up for the repos it knows. It looks at three kinds of things in each repo:

- **git worktrees** (the folders under `.claude\worktrees` and anywhere else `git worktree list` shows),
- **local branches** (`refs/heads`),
- **GitHub branches** (what `git ls-remote --heads origin` shows).

For each one it gives a verdict: **remove** (every rule below allows it), **keep** (some rule holds it; the
reasons say which), or **ask** (only a person should decide). It removes nothing on its own. Henry sees the
report first; a clean-up runs only when he clicks it, or each night once he turns the nightly switch on.

The code is `housekeeping.js`. Its test is `node scripts/housekeeping-test.js`.

## Where the facts come from

All of it is read, never written, while the report is made: no `git fetch`, no `--prune`, no index lock.

- `git worktree list --porcelain`: each worktree's folder, branch, commit, and whether it is locked.
- `git for-each-ref` over `refs/heads` and `refs/remotes/origin`: every branch and its commit. The
  `origin/*` refs are what the last fetch saw; they are not refreshed.
- `git for-each-ref --merged refs/remotes/origin/<default>`: the local branches already in the default branch.
- `git --no-optional-locks status --porcelain` in each worktree (six at a time): uncommitted changes. New
  (untracked) files count. Ignored files (`node_modules`, `.env.local`) do not.
- `git rev-list --count HEAD --not --remotes=origin` in each worktree: commits that are on no `origin/*` ref.
- One `git ls-remote --heads origin`: every GitHub branch and its commit, as GitHub has it now.
- `gh api graphql --paginate`: every pull request of the repo, all pages (detailforge-web has ~1000). If fewer
  come back than GitHub says there are, the repo gets an error and **nothing in it is removed**.
- `gh api repos/<owner>/<name>/branches?protected=true`: the protected branches. `gh api repos/<owner>/<name>`:
  the default branch.
- Every Claude login's `projects` folder (`~\.claude\projects`, `~\.claude-a\projects`, ...): when a
  conversation last worked in each worktree.
- Fleet View itself: which folders a live session works in, whether CodeGraph is building an index there, and
  whether any session is mid-turn.

A branch is matched to its pull request by name (`headRefName`). When several PRs used the same name, the
newest one counts. A PR from a fork never counts for a branch here. A worktree on a detached commit is matched
by commit instead (`headRefOid`).

## The rules

### A worktree is removed only if all of these hold

1. It is not the main checkout.
2. It is not locked (`git worktree lock`), and its folder still exists.
3. `git status --porcelain` is empty: no changed files and no new files.
4. Nothing is unpushed: every commit on it is on some `origin/*` branch, or it sits exactly at its merged or
   closed PR's last commit (GitHub keeps that commit under `refs/pull/<n>/head` for good).
5. Its PR is merged or closed. With no PR, its commit must already be in `origin/<default>`.
   Any open PR on its branch keeps it.
6. No Claude conversation worked there in the last 7 days. This is the newest `.jsonl` (subagents' too) in its
   slug folder in every login's `projects` folder. The slug is the folder path with every character that is not
   a letter or digit turned into `-`. A conversation started in a subfolder has a longer slug, so every slug
   folder that **starts with** the worktree's slug counts. That also catches a sibling worktree whose name
   starts the same way (`ember` and `ember-tools`); such a match keeps, it never removes.
7. git itself has not made or used it in the last 7 days (its folder, its HEAD and index files, the newest entry
   of its reflog). A subagent's conversation is filed under the session that started it, not under the worktree,
   so this catches a fresh worktree that rule 6 cannot see.
8. No live Fleet View session works in it (or in a folder inside it).
9. CodeGraph is not building its index there.
10. Henry has not pinned it ("kept by you").
11. No other worktree is inside its folder. Both repos ignore `.claude/`, so `git status` cannot see a worktree
    at `<this one>\.claude\worktrees\<x>`, and removing this one would delete it with its work.

It is **ask** when its PR merged and the only things holding it are uncommitted changes or unpushed commits.
Anything else that fails makes it **keep**.

### A local branch is removed only if all of these hold

1. No worktree has it checked out (the main checkout included), and no rebase or bisect is working on it.
2. It is not the default branch.
3. No open PR uses it.
4. Its commit is its merged or closed PR's last commit, **or** its commit is already in `origin/<default>`.
5. Henry has not pinned it.

A branch with commits after its PR, or with no PR and commits not in `origin/<default>`, is kept.

### A GitHub branch is removed only if all of these hold

1. Its PR is **merged**.
2. The branch on GitHub still points at that PR's last commit (nobody pushed to it after the merge).
3. It is not the default branch, and not protected.
4. No open PR uses it, as the branch it comes from or the branch it merges into.
5. Henry has not pinned it.

A branch whose PR was closed without merging is **ask**. A branch with no PR is kept.

## What a clean-up does

A clean-up takes a list of ids from the page. Each id is looked up in the current report; an id that is not in
it is refused, and no path or name is ever built from the id text. Then, for each item, right before acting,
every rule is checked again with fresh facts (things change between the report and the click), and only what is
**remove** at that moment goes. **ask** never goes.

- **Worktree:** first its whole folder is walked with `lstat`, never following a link. If a `.git` file or folder
  is anywhere below the top (another worktree, or a clone), it is left alone: "a git checkout is inside it".
  Then every symlink or junction inside it that points outside it (a shared `node_modules`, say) is unlinked.
  Deleting through such a link would wipe the shared folder. Then `git worktree remove <path>`, without `--force`,
  so git refuses on its own if the worktree changed. If git fails and still lists the worktree, it refused: the
  links are put back. If git fails but no longer lists it, it got past its point of no return (git takes a
  worktree off its list even when deleting its files failed, say CodeGraph holds its index open, or a terminal
  has the folder open): Fleet View waits 30 seconds and deletes what is left of the folder without following
  links. Either way it is logged. When something still holds part of the folder, the log entry says
  `"partial": true` and the result says what could not be deleted. It never runs `git worktree prune`: that
  would clear every other worktree whose folder is missing too, such as one on a drive that is not mounted.
- **Local branch:** `git branch -d` when its commit is in `origin/<default>`. For a squash-merged PR's branch,
  `git branch -D`, right after checking it still points at the PR's last commit. Both refuse a branch a
  worktree has checked out.
- **GitHub branch:** a fresh `git ls-remote` right before the push (50 branches at a time), and only branches
  still at the merged PR's last commit go, with one push:
  `git push --porcelain --force-with-lease=refs/heads/<name>:<commit> ... origin :refs/heads/<name> ...`.
  The full `refs/heads/` name means a tag of the same name is never deleted. The lease means a branch someone
  pushed to, or deleted, after the ls-remote is refused on its own ("stale info") while the rest still go.
  A refused one is looked up once more: gone is "already gone from GitHub", moved is "it moved on GitHub since
  it was checked". Nothing is ever pushed over.

Worktrees go first, then local branches (checked again after the worktrees are gone), then GitHub branches.

## The log and Restore

Each removal is one JSON line in `%LOCALAPPDATA%\fleet-view\housekeeping\log.jsonl`:

```
{ "id": "...", "repo": "Z:\\Github\\detailforge-web", "kind": "worktree" | "branch" | "remote",
  "name": "<branch>", "path": "<worktree folder>" | null, "sha": "<commit>", "pr": <number> | null, "at": <ms>,
  "links": [{ "path", "target", "isDir" }],   (a worktree's unlinked links, when it had any)
  "partial": true }                           (a worktree whose folder could not all be deleted)
```

If the log line cannot be written, the item's result says so and the run goes on with the next one.

Restore puts one back:

- **worktree:** `git worktree add <path> <branch>`, or `git worktree add -b <branch> <path> <sha>` when the branch
  is gone too. An empty folder at the path is fine. What a partial removal left is moved aside first, to
  `<path>.leftover-<time>`, and the message says where. Anything else at the path is never touched, and the
  restore is refused. Then the links it had are made again, each only where nothing is now and only when what
  it pointed at is still there; the message says how many came back and which did not. Ignored files
  (`node_modules`, `.env.local`) are not in git and do not come back.
- **branch:** `git branch <name> <sha>`.
- **GitHub branch:** `git push origin <sha>:refs/heads/<name>`. If GitHub has a branch of that name again, it is
  left alone.

If the commit is gone from this PC (git cleaned it up), it is fetched first from GitHub's `refs/pull/<n>/head`,
which only writes `FETCH_HEAD`. A restore is a line in the same log (`{ "restoreOf": <id>, "at": <ms> }`), and the
entry shows as restored.

Each clean-up's totals also go to `runs.jsonl`, and the last one shows on the page ("lastRun").

## Pins and the nightly clean-up

`prefs.json` in the same folder holds the pins (items Henry keeps; always **keep**, "kept by you") and the
nightly switch. The switch is off at first. When it is on, once a day between 02:00 and 05:00, and only when no
session is mid-turn, Fleet View makes a fresh report and cleans up every **remove** item in it, the same way a
click does.

## Who can do what

Run, Restore and the nightly switch work only on the PC's own page. Another device on the tailnet sees the
report and the log, and can pin and refresh, but gets "only on the PC" for the rest.

## A dry run

```
node housekeeping.js --report --repo Z:\Github\detailforge-web --repo Z:\Github\fleet-view [--json]
```

It reads only and writes nothing, not even the report file: counts per verdict and reason, or the full report
as JSON.
