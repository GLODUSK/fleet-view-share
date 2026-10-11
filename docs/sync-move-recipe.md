# Moving a conversation to another checkout (the sync recipe)

Tested 2026-10-10 on Claude Code 2.1.296 (Windows), task T0 of the sync plan. A real test conversation was started in one
checkout and continued from a copy of its log in a second checkout of the same repo (standing in for the Mac), then
back. `scripts/sync-contract.js` checks after every Claude Code update that all of this still holds.

## The recipe

To continue conversation `<id>` in folder `X` on this machine (`X` = this machine's checkout of the repo the
conversation worked in):

1. **Where:** `<projects>/<slug of X>/<id>.jsonl`. `<projects>` is `~/.claude/projects` (account B) or
   `~/.claude-<x>/projects`. The slug is `X` with every character except letters and digits made `-`
   (`C:\Users\henry\Scratchpads\scratch-2026-10-10-8` becomes `C--Users-henry-Scratchpads-scratch-2026-10-10-8`).
   It must be the slug of the exact folder the conversation will be resumed in, not of the repo root, unless that is
   the same folder.
2. **What:** the log byte for byte, plus its side folder `<id>/` in the same slug folder: `subagents/` (every
   `agent-*.jsonl` and `agent-*.meta.json`), `tool-results/` and `workflows/` when present. `custom-title.json` is
   optional: Claude Code writes it again from the log's `custom-title` lines.
3. **Change nothing.** Leave `cwd` and every other path in the log as it is. Write to `<id>.jsonl.part`, then rename.
4. **The folder must be trusted** in that account (`~/.claude.json`, `projects["<X with forward slashes>"]
   .hasTrustDialogAccepted`). If not, the resume stops at "Do you trust the files in this folder?" (the default answer
   is "No, exit"), and Fleet View must not answer that question for Henry.
5. **Resume** with the session host's `open` op, `{ id, cwd: X, account }` (`claude --resume <id>` started in `X`).
   Not with `api.js` `openSession`/`fv open`: those resume in the folder the log last ran in.
6. **Coming back** (the other machine has an older copy): replace it only when it is a byte prefix of the new file
   (check first). If not, the two have both grown: keep both, as a new generation or a fork, and let Henry pick.

## Never

- Never rewrite lines in the log (cwd or any other path). It hides the move from Claude (no "Environment update"
  note, see below), and the copy is no longer a byte prefix of the original, which the append-only upload relies on.
- Never overwrite a longer copy with a shorter one, or a copy that is not a prefix of the new one.
- Never put the copy only in some other folder's slug folder. With one copy anywhere, `claude --resume <id>` finds it
  from any folder but keeps writing into that other folder's file. With two copies, neither in the folder's own slug
  folder, it says `No conversation found with session ID: <id>`.
- Never run one conversation on two machines at once. Even opening it and closing it again without a prompt appends
  lines (`cost-state`) to the log, so the two copies part ways at once.
- Don't sync `~/.claude/file-history/<id>` (code backups for /rewind; the conversation rewinds without them, the
  code does not), `session-env/`, `todos/`, `tasks/`, `sessions/<pid>.json` or `history.jsonl` (prompt history).

## Why cwd fields stay as they are

The log keeps an `environment` attachment with the folder the conversation last ran in. When a resumed conversation
gets its next prompt in another folder, Claude Code compares the two and adds a note for the model, and sends the new
folder's CLAUDE.md again. From the variant A log, the first line written in the new folder:

```
{"attachment":{"type":"environment","snapshot":{"workingDirectory":"C:\\Users\\henry\\Scratchpads\\scratch-2026-10-10-8",…},
 "changes":[{"field":"workingDirectory","from":"C:\\Users\\henry\\Scratchpads\\scratch-2026-10-10-7"},{"field":"scratchpadDirectory"}]},
 "rendered":[{"content":"<system-reminder>\n# Environment update\n - Primary working directory: C:\\Users\\henry\\Scratchpads\\scratch-2026-10-10-8 (was C:\\Users\\henry\\Scratchpads\\scratch-2026-10-10-7)\n …"}]}
```

With the paths rewritten (variant B) that note never came: Claude saw nothing that said the folder had changed, while
its own earlier tool calls still named the old folder. It only found out because the prompt asked it to run `pwd`.

## What was tested

Setup: two clones of fleet-view, `C:\Users\henry\Scratchpads\scratch-2026-10-10-7` ("PC") and `-8` ("Mac"), made
with Fleet View's New scratchpad so both were trusted (a test folder under `J:\` and clones under `Z:\` and under
the home folder stopped at the trust question, so they were not used). Test conversation `36314e9a` ("sync-t0-test", Sonnet, low
effort), started with `fv start` in the PC clone: it read two files, was given the made-up codeword PLUM-HARBOR-4417,
wrote `sync-scratch.txt`, ran one background subagent, and was renamed with `/rename`. Every resume below went through
the session host (`open` with an explicit `cwd`), with prompts sent by `fv send`, except the no-prompt screen checks,
which ran `claude --resume` in a pseudo-terminal the way the host does.

| # | What was done | What happened |
|---|---|---|
| 1 | Variant A: log copied as is (cwd = PC path) into the Mac slug folder, no side folder; resumed in the Mac clone | Full context: it answered PLUM-HARBOR-4417. Its shell ran in the Mac clone (`pwd` printed `…-8`) and it created `…-8\sync-scratch.txt`, nothing in the PC clone. New lines say `"cwd":"…scratch-2026-10-10-8"` and went to the Mac copy only (PC copy unchanged, same sha1). The Environment update above was written. |
| 2 | Variant B: same, every bookkeeping path rewritten to the Mac path (top-level `cwd`, environment `workingDirectory`/`scratchpadDirectory`, file-history `realParentDir`, `toolUseResult` file paths, the CLAUDE.md path; not the message text) | It also worked (codeword, pwd, file written in the Mac clone), but no Environment update or CLAUDE.md came. The rewritten copy is not a byte prefix of the PC copy. Rewriting is not needed and does some harm. |
| 3 | Side files: resumed with and without `<id>/subagents/` and `custom-title.json` | Title shown either way (screen border and the `/resume` picker read "sync-t0-test" from the log's `custom-title` line); Claude Code wrote `custom-title.json` again by itself. Without `subagents/`, continuing the earlier subagent failed: `Agent "ad65119c639bfc851" could not be resumed: No transcript found for agent ID`. With it copied, the same SendMessage worked (the subagent answered "1") and its new lines went to the Mac copy of the subagent file. |
| 4 | Mixed paths: PC copy (69 lines) checked to be a byte prefix of the Mac copy after variant A (88 lines), copied over it, resumed in the PC clone | Both halves loaded: codeword from the PC half, and it described what variant A wrote in the Mac clone. It said no "variant B" happened (that was only in the other copy). An Environment update "(was …-8)" was written on the way back. |
| 5 | Fork: `fv start <Mac clone> --fork 36314e9a` | New conversation `f9ead553` in the Mac slug folder, every line with the new id; it had the Mac copy's history (variant B). Both originals unchanged (same sha1). A fork gets no `subagents/` folder. |
| 6 | Two copies that differ (PC: variant A history, Mac: variant B) | Resumed in the PC clone it used the PC copy, in the Mac clone the Mac copy: `claude --resume` picks by the working folder. From a third folder: `No conversation found with session ID`. With only one copy on disk it is found from any folder, even one that is not a git repo, and the new lines (cwd = that folder) go into the found file; that folder's slug folder only got an empty `memory/`. |

Other things seen:
- Every resume and exit appends `cost-state` lines, even with no prompt; nothing else is rewritten (the contract checks
  the copy stays a byte prefix).
- The `/resume` picker lists one entry per conversation; with both copies on disk, its "all projects" view showed the
  newer copy's size with the PC path as its folder.
- In 2.1.296, Left arrow at an empty prompt parks the session as a background job: it wrote a `continued-in` line
  (`continuedInSessionId`) into the log and started `claude agents` workers. Fleet View should not send a bare Left
  arrow, and sync should follow `continuedInSessionId` to the session that carries on.
- Big tool outputs are saved under `<slug>/<id>/tool-results/`, and the message text names that absolute path. After a
  move the old path does not exist on the other machine; copying `tool-results/` keeps the files, but Claude would
  have to be told the new folder to read one again. Messages are never rewritten.
- A trusted parent folder did not cover the git clones tried (`Z:/` and `C:/Users/henry` are trusted, clones under
  both still asked); plain folders under the home folder did not ask.
- Not tested here (needs the Mac, task M4): a Windows log continued on macOS (backslash paths, `platform: win32` in the
  environment snapshot) and back.

## What this means for Fleet View

- `desktop/host.js` `findTranscript` (slug folder first, else any folder) matches Claude Code only while there is a
  single copy. Sync must always put the copy in the target folder's slug folder.
- `api.js` `resumable()`/`openSession` resume in the log's last folder; "Continue here" (S4) calls the host's `open`
  with the target folder instead.
- With two copies of one conversation, `fleet-view.js` follows the copy written last (newest mtime).

## The contract check

`node scripts/sync-contract.js` (about 20 s, no model tokens, never `claude -p`). It reads the format of the newest
real logs (slug rule, session ids, `cwd`/`uuid`/`version` fields, the `environment` attachment, the subagent layout),
then writes small made-up logs into two test slug folders and resumes them with the interactive `claude --resume` in a
pseudo-terminal: the copy in the folder's own slug folder loads with its title and is only appended to, it wins over a
second copy, and nothing is written into the folder. It ends each claude with Ctrl+C before anything is typed and
removes its files. Exit code 1 when the recipe stops holding; then sync must stop moving conversations until this
document and the code are updated.
