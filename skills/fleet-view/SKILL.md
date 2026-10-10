---
name: fleet-view
description: Drive other Claude Code sessions through Fleet View's `fv` command. Use when delegating work to another Claude session, running several sessions in parallel, sending a message to another conversation or a teammate, checking on or reading another conversation, asking other sessions or a team for their status (leading a team), answering a question another session is asking, resuming an old conversation with a follow-up, working in a Fleet View team, or spawning a test conversation to try a Fleet View feature.
---

# Fleet View: running other Claude sessions

`fv` (on PATH: `fv.cmd` in cmd and PowerShell, `fv` in Git Bash, both in the Fleet View folder) talks to Fleet View's automation API. Every session it starts is a real interactive `claude` in the Fleet View desktop app: the user can watch it and type into it in the panel. It needs the desktop app running (else every call says so, `503`).

## When to use it

- **Parallel, independent work.** Several tasks that don't touch the same files: start one session each, then wait on each.
- **A cheaper model for lookups.** `--model haiku` (or `sonnet`) with `--effort low` for reading logs, listing call sites, summarising a folder.
- **Testing Fleet View itself** with a real session (a menu, the panel, the API).
- **Talking to a conversation that already exists**: a follow-up, a check on how it is doing, answering its question.
- **Working in a team**: messages to the other conversations of a Fleet View team (below).
- **Leading others** ("ask the others for status", "what are the other chats doing?"): `fv status` reads it for free, `fv ask` asks them all one question (see Leading a team).

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
fv answer <id> <n|submit|esc> [--text T] [--sig S] [--allow-permission] [--wait [s]]
fv interrupt <id>                        Esc mid-turn
fv open <id> [--account A|B|C…] [--prompt P] [--wait [s]]   resume an old conversation
fv stop <id> [--remove]
fv rm <id>                               take a conversation off the map
fv teams                                 the teams and their members (★ the lead)
fv team new <id> <id>... --order T [--name N] [--lead <id>]   make a team and give it its order
fv team add <team> <id> [--lead]         add a conversation to a team (--lead: as its lead)
fv team lead <team> <id>|none            make a member the lead, or none: peers again
fv team rm <team> <id>                   take one out of a team
fv team disband <team>                   end a team (its conversations keep working)
fv team say <team> <text> [--from <id>]  a message to every member
fv status [<team>|<id>...] [--from <id>] what each is doing, last reply, branch, PR, context (free)
fv ask <team>|<id>... <question> --from <id> [--within s] [--wait [s]]   ask each one; answers come back to you
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
fv answer 3f2a9c1e 1; fv answer 3f2a9c1e 3; fv answer 3f2a9c1e submit   # multiple choice: tick 1 and 3, then Submit
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
- They run with the permission settings of their account, as a terminal would: one may stop on a permission prompt (`fv menu` shows it) unless the user set it to skip them. Either way, tell each exactly what to touch and what not to (a worktree, no pushes, no merges), as you would brief a subagent. Every session Fleet View starts may run `fv send`, `status`, `ask`, `read`, `ls`, `teams`, `team` and `transcript` without asking, and nothing else.
- Give each child a complete prompt: the goal, the files, what "done" means, and what to report back. It knows nothing of your conversation.
- A plain `fv send` to a session that shows a menu is refused (an Enter would answer it): answer the menu first. With `--from` it waits instead and goes in once the menu is answered ("queued").

## Teammates

Conversations told to work together (a Fleet View team, from Give orders > Work together or Under a lead, or `fv team new`) talk to each other with a message marked as coming from you:

```
fv send <their id> "message" --from <my id>
fv team say <team> "message" --from <my id>      # every member but you
```

Your own id is in `fv ls` (the conversation you are in) and in the order that made the team, with the others' ids. Quote the message (`"…"`), or pass `-` and the text on stdin. A teammate's message comes into your conversation starting with `[Message from teammate "<name>" (<their id>). Reply with: …]` (`your lead` from your team's lead): answer it with `fv send <their id> "…" --from <my id>`.

- A teammate that handed off (or ran `/clear`) is followed: the message goes to the conversation that carries on, and `fv` says so ("sent to <new> (it picked up <old>)"). Use that id from then on; the team is told it too.
- A teammate showing a question or a prompt gets the message once that is answered ("queued").
- A teammate not running in Fleet View is resumed first; `--no-open` refuses instead. One open in a terminal outside Fleet View can't be reached: tell the user.
- Notes from Fleet View about the team (who joined, left or carries on) start with `[Fleet View · team "<name>"]`. You don't need to answer them.
- **In a team with a lead** (★ in `fv teams`), and you are not it: the order is context; the lead gives you your part, so carry on with what you were doing until it does. Report to the lead with `fv send <lead id> "…" --from <my id>` when you finish, when you are blocked, and before you merge. Don't message the other members unless the lead says so.
- **A question** arrives as `[Question from … · answer it in your reply …]`: just answer it in your reply. Fleet View passes the reply back to the asker; don't `fv send` it too.

## Leading a team

Any conversation can lead the others: direct them, check on them, and ask them things. When the user says "ask the others for status", "check on the team" or "what are the other chats doing", start here.

```
fv status <team>                                   # what each is doing now, last reply, branch, PR, context
fv status --from <my id>                           # the same for your own team
fv status 3f2a9c1e 8b71d0e4                        # these conversations (a team and ids may be mixed)
fv ask <team> "Where are you, and what's left?" --from <my id>
fv ask 3f2a9c1e 8b71d0e4 "Which files do you touch?" --from <my id> --wait
```

- **`fv status` first.** It is free: it reads Fleet View's state and types nothing into them, so it costs them no turn. Often it already answers the question.
- **`fv ask` when you need their own words.** Each gets the question and answers it in its own turn (queued behind a menu, resumed if not running). Fleet View then types **one** message with all the answers into your conversation, `[Fleet View · answers to your question "…"]`, once all have answered or `--within` seconds have passed (default 600); a slow one's answer comes later on its own. **Don't poll and don't wait**: carry on (or end your turn) and the answers arrive by themselves. `--wait [s]` prints here the ones that come within `s` (default 100: a Bash call stops at 2 minutes) when you need them before going on; the rest are still typed in.
- Asks are kept in Fleet View's memory for 2 hours and lost when it restarts; if answers never come, use `fv status` and `fv transcript <id>`.
- **Make a lead team**: `fv team new <id> <id>… --order "…" --lead <my id>` (you lead these), or `fv team lead <team> <my id>` for a team you are in, or `fv team add <team> <my id> --lead` to join one as its lead. `fv team lead <team> none` makes them peers again. The lead gets the order and the commands; the others get the order for context and report to it.
- **As the lead**: split the work so no two edit the same files, and give each its part with `fv send <id> "…" --from <my id>` (they wait for it). Tell them all with `fv team say <team> "…" --from <my id>`. Their reports come in as `[Message from teammate …]`. The user talks to you; you talk to them.
- The lead follows a handoff (the conversation that carries on leads). If the lead leaves the team, there is none and the rest carry on as peers.
