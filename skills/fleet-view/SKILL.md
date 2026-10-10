---
name: fleet-view
description: Drive other Claude Code sessions through Fleet View's `fv` command. Use when delegating work to another Claude session, running several sessions in parallel, sending a message to another conversation or a teammate, checking on or reading another conversation, answering a question another session is asking, resuming an old conversation with a follow-up, working in a Fleet View team, or spawning a test conversation to try a Fleet View feature.
---

# Fleet View: running other Claude sessions

`fv` (on PATH: `fv.cmd` in cmd and PowerShell, `fv` in Git Bash, both in the Fleet View folder) talks to Fleet View's automation API. Every session it starts is a real interactive `claude` in the Fleet View desktop app: the user can watch it and type into it in the panel. It needs the desktop app running (else every call says so, `503`).

## When to use it

- **Parallel, independent work.** Several tasks that don't touch the same files: start one session each, then wait on each.
- **A cheaper model for lookups.** `--model haiku` (or `sonnet`) with `--effort low` for reading logs, listing call sites, summarising a folder.
- **Testing Fleet View itself** with a real session (a menu, the panel, the API).
- **Talking to a conversation that already exists**: a follow-up, a check on how it is doing, answering its question.
- **Working in a team**: messages to the other conversations of a Fleet View team (below).

Don't use it for work you can do yourself in a few tool calls; a session costs a start-up and a full context.

## Commands

```
fv ls [--all] [--state S] [--repo R]     every conversation: id, name, state, repo (hosted ones marked)
fv hosted                                sessions the desktop app runs
fv start <repo> <prompt> [--account A|B|C…] [--name N] [--model M] [--effort E]
         [--fork <id>] [--temp] [--chrome|--no-chrome] [--wait [s]]
fv send <id> <text> [--wait [s]] [--from <id>] [--no-open]
fv wait <id> [--timeout s]               until its turn ends, it asks something, or it ends
fv read <id> [--tail n]                  status and latest reply (--tail: its screen)
fv transcript <id> [--since n] [--limit m]
fv menu <id>                             the question or prompt on its screen, numbered
fv answer <id> <n|esc> [--text T] [--sig S] [--allow-permission] [--wait [s]]
fv interrupt <id>                        Esc mid-turn
fv open <id> [--account A|B|C…] [--prompt P] [--wait [s]]   resume an old conversation
fv stop <id> [--remove]
fv rm <id>                               take a conversation off the map
fv teams                                 the teams and their members
fv team new <id> <id>... --order T [--name N]   make a team and give it its order
fv team add <team> <id>                  add a conversation to a team
fv team rm <team> <id>                   take one out of a team
fv team disband <team>                   end a team (its conversations keep working)
fv team say <team> <text> [--from <id>]  a message to every member
fv api                                   every endpoint
fv version                               Fleet View's version (1.0.12), here and on the running server
```

- Ids: the first 8+ characters are enough when they are unique. `<team>` is a team's id, a unique start of it, or its unique name.
- `<repo>` must be a folder Fleet View lists (a repo root or a conversation's checkout).
- Text arguments may be `-` to read stdin: use it for long or multi-line prompts.
- `--wait` with no number waits up to 30 minutes. A wait that ends on a question or a menu prints it with the exact `fv answer` command to run.
- `--json` prints the raw reply. Exit code 0 ok, 1 refused or failed, 2 bad usage.

## Recipes

**Spawn one, wait, read the reply**

```
fv start C:\code\my-app "List every endpoint server.js serves, one line each." --model haiku --effort low --temp --wait
```

The reply is printed when the turn ends. `--temp` takes the session off the map once it stops.

**Several in parallel, then collect**

```
fv start C:\code\my-app "Find every caller of formatPrice. Report file:line only." --name "callers" --temp
fv start C:\code\my-app "List the routes under app/api that skip auth." --name "routes" --temp
fv wait 3f2a9c1e
fv wait 8b71d0e4
fv stop 3f2a9c1e --remove
fv stop 8b71d0e4 --remove
```

Start them all first (without `--wait`), then wait on each; the ids are printed by `start`.

**A child asks a question**

When a wait ends with `endedBy: question` or `menu`:

```
fv menu 3f2a9c1e                  # title, options 1..n with descriptions, kind, sig
fv answer 3f2a9c1e 2 --wait       # pick option 2, then wait for the turn
fv answer 3f2a9c1e 4 --text "Use the existing helper in lib/money.ts" --wait   # a "Type something" option
fv answer 3f2a9c1e esc            # dismiss it
```

Pass `--sig <sig>` from `fv menu` so the answer is refused if the menu changed meanwhile.

**Resume an old conversation with a follow-up**

```
fv ls --repo my-app --state DONE
fv open 5c09e2aa --prompt "The fix merged. Write the README section for it." --wait
fv stop 5c09e2aa
```

Don't `--remove` a conversation you didn't start; just stop it if you opened it only for this.

## Rules

- **Clean up everything you start.** Use `--temp` for anything spawned to test something or for a one-off, and before you finish, `fv stop <id> --remove` every session you started (check with `fv hosted`). Stale test conversations left on the map are for the user to remove by hand; don't leave them any.
- **Never `--allow-permission` unless the user asked for it.** Every menu but a question (permission and trust prompts, the plan approval) is refused without it on purpose: approving another session's tool use is the user's call. Report the prompt (`fv menu`) and let them decide.
- Only stop, remove, interrupt or message sessions you started, or ones the user named.
- Sessions run on the user's own Claude logins, the accounts `fv ls` shows: `B` is the default `~/.claude`, and each `~/.claude-<letter>` is that letter (`~/.claude-a` is `A`). `fv start` uses `B` unless `--account` says otherwise.
- They run with the permission settings of their account, as a terminal would: one may stop on a permission prompt (`fv menu` shows it) unless the user set it to skip them. Either way, tell each exactly what to touch and what not to (a worktree, no pushes, no merges), as you would brief a subagent. Every session Fleet View starts may run `fv send` without asking, and nothing else.
- Give each child a complete prompt: the goal, the files, what "done" means, and what to report back. It knows nothing of your conversation.
- A plain `fv send` to a session that shows a menu is refused (an Enter would answer it): answer the menu first. With `--from` it waits instead and goes in once the menu is answered ("queued").

## Teammates

Conversations told to work together (a Fleet View team, from Give orders > Work together or `fv team new`) talk to each other with a message marked as coming from you:

```
fv send <their id> "message" --from <my id>
fv team say <team> "message" --from <my id>      # every member but you
```

Your own id is in `fv ls` (the conversation you are in) and in the order that made the team, with the others' ids. Quote the message (`"…"`), or pass `-` and the text on stdin. A teammate's message comes into your conversation starting with `[Message from teammate "<name>" (<their id>). Reply with: …]`: answer it with `fv send <their id> "…" --from <my id>`.

- A teammate that handed off (or ran `/clear`) is followed: the message goes to the conversation that carries on, and `fv` says so ("sent to <new> (it picked up <old>)"). Use that id from then on; the team is told it too.
- A teammate showing a question or a prompt gets the message once that is answered ("queued").
- A teammate not running in Fleet View is resumed first; `--no-open` refuses instead. One open in a terminal outside Fleet View can't be reached: tell the user.
- Notes from Fleet View about the team (who joined, left or carries on) start with `[Fleet View · team "<name>"]`. You don't need to answer them.
