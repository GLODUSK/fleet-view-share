# Keeping CodeGraph up to date

CodeGraph (`@colbymchenry/codegraph`, installed with npm) gives every session the `codegraph_explore` tool and Fleet View its code indexes. Three things keep it current without breaking what relies on it:

1. **The updater**, `scripts/codegraph-update.ps1`, installs each new release once nothing holds CodeGraph open.
2. **The contract test**, `scripts/codegraph-contract.js`, checks that the new release still does everything our setup relies on. If it doesn't, the updater goes back to the last good version and starts a session to adapt our code (see [When the contract fails](#when-the-contract-fails)).
3. **Fleet View** (`code-index.js`) notices the new version within 10 minutes and rebuilds every index an older release built, when the new one extracts more.

## The updater

On Henry's PC, the `ClaudeCode-SafeUpdate` scheduled task runs `C:\Users\henry\agent-tools\claude-update\Update-ClaudeSafe.ps1` every 10 minutes. That script updates Claude Code, then calls `Z:\Github\fleet-view\scripts\codegraph-update.ps1`, which:

- Asks npm for the latest release, at most once an hour.
- Installs it with `npm i -g @colbymchenry/codegraph@<version>`, but only when no `claude.exe` runs (every session runs a CodeGraph MCP server) and no CodeGraph process runs (a Fleet View index build). npm can't replace CodeGraph's bundled `node.exe` while it runs.
- Never runs `codegraph upgrade` or `codegraph install`: they also rewrite CLAUDE.md and the agent configs.
- Doesn't install a release whose npm package has install scripts.
- Runs the contract test against what it installed. On a pass it keeps the release. On a fail it reinstalls the last good one, saves the test's output in `%LOCALAPPDATA%\fleet-view\codegraph-contract-<version>.txt`, and starts a Fleet View session (`fv start`) to adapt our code. If the desktop app isn't running, it tries the session again on the next run.
- Doesn't try a release that failed again until `code-index.js` or `scripts/codegraph-contract.js` changes on main (the fix), or someone runs it with `-Force`.

Its log is `%LOCALAPPDATA%\fleet-view\codegraph-update.log`, and its state (last check, last good version, the blocked version and its session) is `codegraph-update.json` beside it.

Run it by hand: `powershell -NoProfile -ExecutionPolicy Bypass -File Z:\Github\fleet-view\scripts\codegraph-update.ps1 [-Force]`. It still waits for no sessions to be open. To try the updater itself, point `APPDATA` and `LOCALAPPDATA` at scratch folders with a CodeGraph installed in the scratch npm folder, and add `-Test` (skips the open-sessions check and starts its session with `--temp`) and `-Version <x.y.z>` (tries that version instead of the latest).

## The contract

`node scripts/codegraph-contract.js [--bin <codegraph.cmd>]` builds a one-file project in a temp folder (about 10 s) and checks everything we rely on:

| Check | What relies on it |
|---|---|
| `codegraph --version` prints a version | `code-index.js` `probeEngine()` |
| `init --yes <dir>` builds an index that `code-index.js` `check()` reads as complete, stamped with an extraction version (`project_metadata`: `index_state`, `indexed_with_extraction_version`) | Fleet View's first build of each checkout; finding cut-short and stale indexes |
| `index --quiet <dir>` rebuilds it, still complete | Fleet View's rebuilds |
| Nothing is written outside `.codegraph` | No surprise CLAUDE.md, AGENTS.md or `.mcp.json` edits in our repos |
| `serve --mcp`, started like the accounts' `.claude.json` start it, lists `codegraph_explore`, and a call returns the project's code | The MCP server in all three accounts; CLAUDE.md and the agent prompts name `codegraph_explore` |
| The npm package has no install scripts | An `npm i -g` must not touch agent configs |
| Telemetry is off (it turns it off first, then checks it stuck) | A CodeGraph's first run can write a fresh "enabled" default over the saved choice |

Commands the test runs get `CODEGRAPH_TELEMETRY=0`, as does Henry's user environment.

A new dependency on CodeGraph gets a check here in the same change. That's what makes the updater safe: anything missing from this list can break without anyone noticing.

## Indexes after an update

Each index is stamped with the extraction version of the CodeGraph that built it. CodeGraph raises that number only when a release extracts more (a new language, new kinds of edges), and only a rebuild adds that. It doesn't rebuild old indexes by itself; `codegraph status` just suggests it.

So Fleet View checks `codegraph --version` every 10 minutes. When the version changes, it builds a one-file index in `%LOCALAPPDATA%\fleet-view\codegraph-probe`, reads the extraction version from it, and saves both in `codegraph-engine.json`. Every index stamped lower is then rebuilt, one at a time, and `codegraph.log` says `rebuilding (built by an older CodeGraph: extraction N, now M)`.

## When the contract fails

The updater starts a session in `Z:\Github\fleet-view` with a prompt naming the version and the file holding the test's output. That session does this:

1. **Read the failure:** the output file, and what changed upstream:
   - `gh release view v<version> -R colbymchenry/codegraph`
   - the releases between the last good version and this one: `gh release list -R colbymchenry/codegraph`
2. **Make a worktree:** `git worktree add .claude/worktrees/codegraph-<version> -b fix/codegraph-<version> origin/main`.
3. **Install the new version beside the global one.** Running sessions hold the global one open, so never `npm i -g` from a session:
   - `npm i --prefix <scratchpad>\cg-<version> @colbymchenry/codegraph@<version>`
   - its command is `<scratchpad>\cg-<version>\node_modules\.bin\codegraph.cmd`
4. **Reproduce:** `node scripts/codegraph-contract.js --bin <that codegraph.cmd>`.
5. **Decide whose problem it is.**
   - **CodeGraph changed something on purpose** (a renamed option, a moved metadata key, a renamed tool): adapt our side. The places that depend on CodeGraph:
     - `code-index.js`: the `CHECK` query, `probeEngine()`, the `init`/`index` arguments. Keep it working with both the old and the new version, because the fix merges before the updater installs the new one.
     - `scripts/codegraph-contract.js`: change a check only to follow a deliberate change, never to make a real break pass.
     - the MCP entry in `~/.claude.json`, `~/.claude-a/.claude.json` and `~/.claude-c/.claude.json`, plus `install.ps1` and the README section "Code graphs (CodeGraph)" that set it up for others.
     - the "Code graph" section of `C:\Users\henry\.claude-c\CLAUDE.md` (and the other accounts' copies), if the tool names or how to call them changed.
   - **CodeGraph broke** (a crash, a wrong result): don't bend our code around a bug. Leave the release blocked, and tell Henry what broke. Reporting it upstream is outward-facing, so ask Henry first.
6. **Check against both versions:** `node scripts/codegraph-contract.js --bin <new codegraph.cmd>`, and `node scripts/codegraph-contract.js` against the installed one.
7. **Ship it:** commit, open the PR, merge, then restart, check and publish as the repo's CLAUDE.md says.
8. **The updater takes it from there.** The change to `code-index.js` or the contract test lifts the block, and the next run with no sessions open installs the release and runs the test again. If the fix only touched files outside the repo, add a contract check for it so the block lifts. Otherwise Henry runs the updater with `-Force` once no sessions are open.
9. **Clean up:** delete the side install and the worktree, then tell Henry in one line what changed and that the release installs on the next quiet moment.
