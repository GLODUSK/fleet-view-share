// Stray CodeGraph MCP servers: which processes code-index.js strays() picks to end, from a made-up process table.
//   node scripts/codegraph-strays-test.js
// Pure (no process is started or ended), so it runs on any platform; the Windows and macOS rules are both tested.
// Exit 0 = all pass.
'use strict';
const os = require('os');
const path = require('path');
process.env.LOCALAPPDATA = path.join(os.tmpdir(), 'fv-codegraph-strays-test'); // code-index.js's log folder: never the real one
const CI = require(path.join(__dirname, '..', 'code-index.js'));

let failures = 0, passes = 0;
const ok = (cond, what) => { if (cond) { passes++; console.log(`ok:   ${what}`); } else { failures++; console.log(`FAIL: ${what}`); } };
const same = (a, b) => JSON.stringify([...a].sort((x, y) => x - y)) === JSON.stringify([...b].sort((x, y) => x - y));

const NOW = 1_800_000_000_000, MIN = 60e3, HOUR = 3600e3;
const NPM = 'C:\\Users\\henry\\AppData\\Roaming\\npm\\node_modules\\@colbymchenry\\codegraph';
const BUNDLE = `${NPM}\\node_modules\\@colbymchenry\\codegraph-win32-x64`;
const W = {
  claude: 'C:\\Users\\henry\\.local\\bin\\claude.exe',
  cmd: 'cmd /c codegraph.cmd serve --mcp',
  shim: `"node"   "${NPM}\\npm-shim.js" serve --mcp`,
  proxy: `"${BUNDLE}\\node.exe" --liftoff-only --disable-warning=ExperimentalWarning ${BUNDLE}\\lib\\dist\\bin\\codegraph.js serve --mcp`,
  daemon: (p) => `"${BUNDLE}\\node.exe" --liftoff-only --disable-warning=ExperimentalWarning ${BUNDLE}\\lib\\dist\\bin\\codegraph.js serve --mcp --path ${/\s/.test(p) ? `"${p}"` : p}`,
  build: (p) => `"${BUNDLE}\\node.exe" --liftoff-only ${BUNDLE}\\lib\\dist\\bin\\codegraph.js init --yes ${p}`,
};
// a Windows session: claude (pid c) -> cmd -> shim -> proxy, started at t
const chain = (c, t) => [
  { pid: c, ppid: 1000, started: t, mb: 300, command: W.claude },
  { pid: c + 1, ppid: c, started: t + 3000, mb: 14, command: W.cmd },
  { pid: c + 2, ppid: c + 1, started: t + 3100, mb: 61, command: W.shim },
  { pid: c + 3, ppid: c + 2, started: t + 3200, mb: 97, command: W.proxy },
];
const explorer = { pid: 1000, ppid: 4, started: NOW - 48 * HOUR, mb: 100, command: '' };
const win = (list, sessions, o = {}) => CI.strays(list, { win: true, now: NOW, sessions, ...o }).map((s) => s.pid);
const mac = (list, sessions, o = {}) => CI.strays(list, { win: false, now: NOW, sessions, ...o }).map((s) => s.pid);

// serverKind: the command lines
ok(CI.serverKind(W.cmd).kind === 'proxy', 'serverKind: cmd.exe running codegraph.cmd serve --mcp is a proxy chain member');
ok(CI.serverKind(W.shim).kind === 'proxy', 'serverKind: the npm shim is a proxy chain member');
ok(CI.serverKind(W.proxy).kind === 'proxy', 'serverKind: the bundled codegraph.js without --path is a proxy');
ok(CI.serverKind(W.daemon('Z:\\Github\\fleet-view')).path === 'Z:\\Github\\fleet-view', 'serverKind: --path names a daemon and its checkout');
ok(CI.serverKind(W.daemon('Z:\\My Repos\\x')).path === 'Z:\\My Repos\\x', 'serverKind: a quoted --path with a space');
ok(CI.serverKind('node /opt/homebrew/bin/codegraph serve --mcp').kind === 'proxy', 'serverKind: the macOS npm command (no npm-shim.js in its name)');
ok(CI.serverKind('/opt/homebrew/lib/node_modules/@colbymchenry/codegraph/node_modules/@colbymchenry/codegraph-darwin-arm64/node --liftoff-only /x/lib/dist/bin/codegraph.js serve --mcp --path /Users/henry/code/my repo').path === '/Users/henry/code/my repo', 'serverKind: a macOS daemon, its path with a space as ps prints it');
ok(CI.serverKind(W.build('Z:\\Github\\fleet-view')) === null, "serverKind: Fleet View's build (codegraph init) is no server");
ok(CI.serverKind(`${W.proxy.replace('serve --mcp', 'index --quiet')} Z:\\x`) === null, 'serverKind: codegraph index is no server');
ok(CI.serverKind('node C:\\tools\\codegraph-viewer.js serve --mcp') === null, 'serverKind: another program named codegraph-something is not matched');
ok(CI.serverKind('node codegraph.js serve --mcpx') === null, 'serverKind: --mcp must be a whole argument');

// 1. a live session's chain and its daemon (a child of the proxy that started it): nothing ended
{
  const list = [explorer, ...chain(100, NOW - HOUR), { pid: 200, ppid: 103, started: NOW - HOUR + 4000, mb: 400, command: W.daemon('Z:\\Github\\fleet-view') }];
  ok(same(win(list, new Map([[100, 'Z:\\Github\\fleet-view']])), []), 'a live session: its chain and daemon are kept');
  ok(same(win(list, new Map([[100, 'Z:\\Elsewhere']])), []), 'a daemon whose parent proxy runs is kept even with no session working in its checkout');
}

// 2. claude.exe is gone: cmd.exe lost its parent, so the whole chain goes, each process on its own
{
  const list = [explorer, ...chain(100, NOW - HOUR).slice(1)];
  const s = CI.strays(list, { win: true, now: NOW, sessions: new Map() });
  ok(same(s.map((x) => x.pid), [101, 102, 103]), 'claude gone: cmd.exe, the shim and the proxy are ended');
  ok(s.every((x) => x.kind === 'proxy' && x.path === null && typeof x.mb === 'number'), 'each comes with its kind, no --path and its MB');
}

// 3. a pid reused: cmd.exe's parent pid now names a process that started after it
{
  const list = [explorer, { pid: 100, ppid: 1000, started: NOW - 5 * MIN, mb: 5, command: 'notepad.exe' }, ...chain(100, NOW - HOUR).slice(1)];
  ok(same(win(list, new Map()), [101, 102, 103]), 'parent pid reused by a newer process: the chain is ended');
  const older = list.map((p) => (p.pid === 100 ? { ...p, started: NOW - 2 * HOUR } : p));
  ok(same(win(older, new Map()), []), 'parent pid held by a process older than the child: kept');
}

// 4. a lone shim whose parent is gone (seen 2026-10-14: no child left under it)
{
  const list = [explorer, { pid: 31076, ppid: 80680, started: NOW - 9 * HOUR, mb: 41, command: W.shim }];
  ok(same(win(list, null), [31076]), 'a shim with no parent is ended, even with the sessions unknown');
}

// 5. daemons: their parent is gone once the proxy that started them ended, so only the sessions decide
{
  const d = (pid, at, age) => ({ pid, ppid: 77777, started: NOW - age, mb: 320, command: W.daemon(at) });
  const fv = d(300, 'Z:\\Github\\fleet-view', 3 * HOUR), web = d(301, 'Z:\\Github\\detailforge-web\\.claude\\worktrees\\feat-x', 3 * HOUR);
  const base = [explorer, ...chain(100, NOW - HOUR), fv, web];
  ok(same(win(base, new Map([[100, 'Z:\\Github\\fleet-view']])), [301]), 'daemon: the one no session works in is ended, the one a session works in is kept');
  ok(same(win(base, new Map([[100, 'z:/github/fleet-view/.claude/worktrees/agent-1']])), [301]), 'daemon: a session in a worktree inside its checkout keeps it (any case, any slash)');
  ok(same(win(base, new Map([[100, 'Z:\\Github']])), []), 'daemon: a session in a folder above its checkout keeps it');
  ok(same(win(base, new Map([[100, 'Z:\\Github\\fleet-view-share']])), [300, 301]), 'daemon: a sibling folder sharing the name start does not keep it');
  ok(same(win(base, null), []), 'daemon: sessions unknown, nothing ended');
  ok(same(win(base, new Map([[999, 'Z:\\Github\\fleet-view']])), []), "daemon: a live proxy whose host is no known session (another program's), nothing ended");
  ok(same(win(base, new Map([[100, 'Z:\\Github\\fleet-view'], [555, 'Z:\\Github\\detailforge-web']])), [301]), 'daemon: a session file whose claude has ended does not keep one');
  ok(same(win(base, new Map([[100, null]])), []), 'daemon: a live session with no cwd known, nothing ended');
  const young = [explorer, ...chain(100, NOW - HOUR), d(302, 'Z:\\Github\\other', 5 * MIN)];
  ok(same(win(young, new Map([[100, 'Z:\\Github\\fleet-view']])), []), 'daemon: one started under 10 min ago is kept');
  const noTime = [explorer, ...chain(100, NOW - HOUR), { ...d(303, 'Z:\\Github\\other', 0), started: null }];
  ok(same(win(noTime, new Map([[100, 'Z:\\Github\\fleet-view']])), []), 'daemon: one whose start time is unknown is kept');
  // a daemon whose parent proxy belongs to a dead chain goes with it, unless a session works there
  const dead = [explorer, ...chain(100, NOW - HOUR).slice(1), { pid: 304, ppid: 103, started: NOW - HOUR, mb: 300, command: W.daemon('Z:\\Github\\old') }];
  ok(same(win(dead, new Map()), [101, 102, 103, 304]), 'daemon: under a dead chain, with no session there, it is ended with the chain');
  const dead2 = [...dead, ...chain(400, NOW - HOUR)];
  ok(same(win(dead2, new Map([[400, 'Z:\\Github\\old']])), [101, 102, 103]), 'daemon: under a dead chain but a live session works there: kept');
}

// 6. Fleet View's own builds and this process are never picked
{
  const list = [explorer, { pid: 500, ppid: 66666, started: NOW - HOUR, mb: 500, command: W.build('Z:\\Github\\fleet-view') }, { pid: 501, ppid: 66666, started: NOW - HOUR, mb: 40, command: W.shim }];
  ok(same(win(list, new Map()), [501]), "a build Fleet View started (init) is never picked, even with its parent gone");
  ok(same(win(list, new Map(), { self: 501 }), []), 'the process doing the sweep is never picked');
}

// 7. macOS: an orphan is reparented to launchd (ppid 1)
{
  const M = {
    shim: 'node /opt/homebrew/bin/codegraph serve --mcp',
    proxy: '/opt/homebrew/lib/node_modules/@colbymchenry/codegraph/node_modules/@colbymchenry/codegraph-darwin-arm64/node --liftoff-only /opt/homebrew/lib/node_modules/@colbymchenry/codegraph/node_modules/@colbymchenry/codegraph-darwin-arm64/lib/dist/bin/codegraph.js serve --mcp',
  };
  const launchd = { pid: 1, ppid: 0, started: NOW - 48 * HOUR, mb: 20, command: '' };
  const live = [launchd, { pid: 700, ppid: 1, started: NOW - HOUR, mb: 300, command: 'claude' }, { pid: 701, ppid: 700, started: NOW - HOUR, mb: 50, command: M.shim }, { pid: 702, ppid: 701, started: NOW - HOUR, mb: 90, command: M.proxy }];
  ok(same(mac(live, new Map([[700, '/Users/henry/code/fleet-view']])), []), 'macOS: a live chain is kept');
  const orphan = [launchd, { pid: 701, ppid: 1, started: NOW - HOUR, mb: 50, command: M.shim }, { pid: 702, ppid: 701, started: NOW - HOUR, mb: 90, command: M.proxy }];
  ok(same(mac(orphan, new Map()), [701, 702]), 'macOS: a shim reparented to launchd is ended with its proxy');
  // a pid reused is no concern on macOS (ppid changes to 1): the Windows start-time rule is not applied
  const newer = [launchd, { pid: 700, ppid: 1, started: NOW - MIN, mb: 300, command: 'claude' }, { pid: 701, ppid: 700, started: NOW - HOUR, mb: 50, command: M.shim }];
  ok(same(mac(newer, new Map([[700, '/x']])), []), 'macOS: a parent that started after the child (a clock quirk) still counts as its parent');
  const daemon = [...live, { pid: 703, ppid: 1, started: NOW - 2 * HOUR, mb: 300, command: `${M.proxy} --path /Users/henry/code/old` }];
  ok(same(mac(daemon, new Map([[700, '/Users/henry/code/fleet-view']])), [703]), 'macOS: a daemon no session works in is ended');
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
