---
name: fleet-view
description: Drive other Claude Code sessions through Fleet View's `fv` command. Use when delegating work to another Claude session, running several sessions in parallel, sending a message to another conversation, checking on or reading another conversation, answering a question another session is asking, resuming an old conversation with a follow-up, or spawning a test conversation to try a Fleet View feature.
---

# Fleet View: running other Claude sessions

`fv` (on PATH; `Z:\Github\fleet-view\fv.cmd`, or `fv` in Git Bash) talks to Fleet View's automation API. Every session it starts is a real interactive `claude` in the Fleet View desktop app: Henry can watch it and type into it in the panel. It needs the desktop app running (else every call says so, `503`).

## When to use it

- **Parallel, independent work.** Several tasks that don't touch the same files: start one session each, then wait on each.
- **A cheaper model for lookups.** `--model haiku` (or `sonnet`) with `--effort low` for reading logs, listing call sites, summarising a folder.
- **Testing Fleet View itself** with a real session (a menu, the panel, the API).
- **Talking to a conversation that already exists**: a follow-up, a check on how it is doing, answering its question.

Don't use it for work you can do yourself in a few tool calls; a session costs a start-up and a full context.

## Commands

```
fv ls [--all] [--state S] [--repo R]     every conversation: id, name, state, repo (hosted ones marked)
fv hosted                                sessions the desktop app runs
fv start <repo> <prompt> [--account A|B] [--name N] [--model M] [--effort E]
         [--fork <id>] [--temp] [--chrome|--no-chrome] [--wait [s]]
fv send <id> <text> [--wait [s]] [--from <id>]
fv wait <id> [--timeout s]               until its turn ends, it asks something, or it ends
fv read <id> [--tail n]                  status and latest reply (--tail: its screen)
fv transcript <id> [--since n] [--limit m]
fv menu <id>                             the question or prompt on its screen, numbered
fv answer <id> <n|esc> [--text T] [--sig S] [--allow-permission] [--wait [s]]
fv interrupt <id>                        Esc mid-turn
fv open <id> [--account A|B] [--prompt P] [--wait [s]]   resume an old conversation
fv stop <id> [--remove]
fv rm <id>                               take a conversation off the map
fv api                                   every endpoint
```

- Ids: the first 8+ characters are enough when they are unique.
- `<repo>` must be a folder Fleet View lists (a repo root or a conversation's checkout).
- Text arguments may be `-` to read stdin: use it for long or multi-line prompts.
- `--wait` with no number waits up to 30 minutes. A wait that ends on a question or a menu prints it with the exact `fv answer` command to run.
- `--json` prints the raw reply. Exit code 0 ok, 1 refused or failed, 2 bad usage.

## Recipes

**Spawn one, wait, read the reply**

```
fv start Z:\Github\fleet-view "List every endpoint api.js serves, one line each." --model haiku --effort low --temp --wait
```

The reply is printed when the turn ends. `--temp` takes the session off the map once it stops.

**Several in parallel, then collect**

```
fv start Z:\Github\detailforge-web "Find every caller of formatPrice. Report file:line only." --name "callers" --temp
fv start Z:\Github\detailforge-web "List the routes under app/api that skip auth." --name "routes" --temp
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
fv ls --repo fleet-view --state DONE
fv open 5c09e2aa --prompt "The fix merged. Write the README section for it." --wait
fv stop 5c09e2aa
```

Don't `--remove` a conversation you didn't start; just stop it if you opened it only for this.

## Rules

- **Clean up everything you start.** Use `--temp` for anything spawned to test something or for a one-off, and before you finish, `fv stop <id> --remove` every session you started (check with `fv hosted`). Henry had to remove stale test conversations by hand on 2026-10-09; don't leave him any.
- **Never `--allow-permission` unless the user asked for it.** Every menu but a question (permission and trust prompts, the plan approval) is refused without it on purpose: approving another session's tool use is the user's call. Report the prompt (`fv menu`) and let them decide.
- Only stop, remove, interrupt or message sessions you started, or ones the user named.
- Sessions run on Henry's Max plan (account `B` by default, `A` with `--account A`), never API credits. They inherit bypass permissions: tell them exactly what to touch and what not to (a worktree, no pushes, no merges), as you would brief a subagent.
- Give each child a complete prompt: the goal, the files, what "done" means, and what to report back. It knows nothing of your conversation.
- A message to a session that shows a menu is refused (an Enter would answer it): answer the menu first.

## Teammates

For conversations told to work together (a Fleet View team), send a message that is marked as coming from you:

```
node Z:\Github\fleet-view\scripts\fleet-msg.js --from <my id> --to <their id> "text" [--wait 600]
```

`fv send <id> <text> --from <my id>` does the same. Your own id is in `fv ls` (the conversation you are in).
