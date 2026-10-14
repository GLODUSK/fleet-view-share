// Code graphs: every repo Fleet View lists, and every checkout a conversation works in, gets a CodeGraph index
// (github.com/colbymchenry/codegraph, `npm install -g @colbymchenry/codegraph`), so Claude Code can answer "who
// calls X, what does a change to X touch" from the graph instead of grepping. It is local and free: no API key,
// no model calls. Without the `codegraph` command on PATH all of this does nothing.
//   - each checkout keeps its own index in <checkout>\.codegraph; a worktree is a checkout of its own. CodeGraph
//     looks in a folder and then every folder above it, so a worktree inside the main checkout
//     (.claude\worktrees\<name>) is answered from the main checkout's index until its own is built.
//   - indexes are built one at a time at below-normal priority (detailforge-web: ~3 min, ~550 MB). Once built,
//     Claude Code's MCP server (`codegraph serve --mcp`) keeps one in step with edits by itself.
//   - .codegraph goes in the repo's .git\info\exclude, so it never shows up in git status or a commit.
//   - a failed build is retried after an hour; the log is %LOCALAPPDATA%\fleet-view\codegraph.log.
//   - a build outlives the server that started it: Fleet View restarts itself after every update, and a build cut off
//     each time might never finish. The server's own child (cmd.exe) dies with it (node puts its children in a job
//     that ends them when it exits), and CodeGraph stops a build whose parent went away (its PPID watchdog), so a
//     build runs with that watchdog off (CODEGRAPH_PPID_POLL_MS=0) and its stderr goes to a file
//     (codegraph-builds\<id>.log), not a pipe into the server. codegraph-builds\<id>.json names each build Fleet View
//     started; the next server finds it still running, waits for it as for its own (one build at a time still) and
//     stops it after BUILD_MAX_MS too. A failed build's file keeps its hour's wait across restarts.
//   - an index left part way (CodeGraph's index_state is not "complete") with no build of it running is built again
//     at once: no process runs codegraph init/index on that checkout, and its codegraph.lock names a process that is
//     gone or no CodeGraph (its pid reused). Such a lock is deleted first: CodeGraph would refuse to build past it.
//   - a newer CodeGraph can extract more than the one that built an index (its "extraction version" goes up), and
//     only a rebuild adds that. When the installed version changes, a tiny index built in codegraph-probe tells the
//     extraction version it stamps, and every index stamped lower is rebuilt. Updating CodeGraph itself, and what
//     to do when a new one needs this file changed: docs\codegraph-update.md.
//   - every 5 min, Claude Code's own `codegraph serve --mcp` processes whose session is gone are ended and logged
//     (strays(), below).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const P = require('./platform');

const LOG = path.join(P.dataDir(), 'codegraph.log');
const DIR = '.codegraph';
const RETRY_MS = 3600e3, BUILD_MAX_MS = 30 * 60e3, FIND_EVERY_MS = 10 * 60e3;
const POLL_MS = Number(process.env.FV_CODEGRAPH_POLL_MS) || 15e3; // how often a build an earlier server started is looked at
const BUILD_ENV = { CODEGRAPH_PPID_POLL_MS: '0' }; // a build goes on when the server that started it exits
const BUILDS = path.join(path.dirname(LOG), 'codegraph-builds');
const UNSAFE = /["%^&|<>\x00-\x1f]/;

let found = null, foundAt = 0, finding = false; // is `codegraph` on PATH (null: not checked yet)
const queue = []; // { top, root } checkouts waiting, in order
const failed = new Map(); // checkout key -> when its build failed
let building = null; // the checkout being built now
const orphans = new Map(); // checkout key -> { top, started }: builds an earlier server started that still run
let adopted = false, adopting = false; // looked for those yet

const key = (p) => P.foldCase(path.resolve(p));
function log(text) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, `${new Date().toISOString().replace('T', ' ').slice(0, 19)} ${text}\n`);
  } catch {}
}
const dbOf = (top) => path.join(top, DIR, 'codegraph.db');
const lockOf = (top) => path.join(top, DIR, 'codegraph.lock');
const complete = new Set(); // checkout keys whose index was found complete: not opened again
const checking = new Set(); // checkout keys being checked now
const busy = (k) => (building && key(building) === k) || orphans.has(k) || queue.some((q) => key(q.top) === k);
// codegraph-builds\<id>.json: a build Fleet View started ({ top, root, started }) or one that failed ({ top, failed });
// <id>.log: that build's stderr
const idOf = (top) => crypto.createHash('sha1').update(key(top)).digest('hex').slice(0, 12);
const recOf = (top) => path.join(BUILDS, `${idOf(top)}.json`);
const errOf = (top) => path.join(BUILDS, `${idOf(top)}.log`);

// check(top, cb): is the checkout's index finished and current? CodeGraph's own project_metadata says it:
// index_state reads "complete" once a build is done, and indexed_with_extraction_version is the extraction version
// of the CodeGraph that built it. cb(state, { extraction, updated }) gets 'done' (complete, or a state it can't read:
// an older CodeGraph, no node:sqlite, a file it is better to leave alone), 'busy' (the database is being written),
// 'partial' (not complete: a build runs now or stopped part way; updated: when index_state was set) or 'stale'
// (built by a CodeGraph that extracted less than the installed one).
// A child process opens the database: one a daemon let go of can take half a minute to open (its write-ahead log
// is played back), which the server must never wait on. Electron's node runs it as plain node.
// scripts\codegraph-contract.js checks each new CodeGraph still writes what this reads.
const CHECK = `let d, r;
try {
  d = new (require('node:sqlite').DatabaseSync)(process.argv[1]);
  const get = (k) => d.prepare('select value, updated_at from project_metadata where key = ?').get(k);
  const s = get('index_state') || {}, x = get('indexed_with_extraction_version');
  r = { value: s.value, updated_at: s.updated_at, extraction: x && /^\\d+$/.test(x.value) ? Number(x.value) : null };
} catch (e) { r = { error: String(e.message) }; } finally { try { if (d) d.close(); } catch {} }
process.stdout.write(JSON.stringify(r));`;
function check(top, cb) {
  execFile(process.execPath, ['--no-warnings', '-e', CHECK, dbOf(top)], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 120e3 }, (err, out) => {
    let r = null;
    try { r = JSON.parse(out); } catch {}
    if (!r) return cb(err && err.killed ? 'busy' : 'done', {});
    if (r.error) return cb(/locked|busy/i.test(r.error) ? 'busy' : 'done', {});
    const info = { extraction: r.extraction };
    if (r.value && r.value !== 'complete') return cb('partial', { ...info, updated: Number(r.updated_at) || 0 });
    // an index with no stamp is left alone: rebuilding it would not add one if CodeGraph stopped writing it
    cb(engine && r.extraction !== null && r.extraction < engine.extraction ? 'stale' : 'done', info);
  });
}

// the builds running now. nodes(cb): cb([{ pid, command }]) of the node processes, or null when it can't tell.
// runs(command, top): is that command line a CodeGraph build of top? `init` or `index` with the checkout as the last
// argument, the way next() starts it: the npm shim (npm-shim.js) and the bundled node running codegraph.js both read so
const nodes = (cb) => P.commandLines(cb, 'node.exe');
function runs(command, top) {
  const norm = (s) => P.foldCase(P.isWin ? s.replace(/\//g, '\\') : s);
  const c = norm(String(command).trim()), t = norm(path.resolve(top));
  return c.includes('codegraph') && /\s(init|index)\s/.test(c) && (c.endsWith(` ${t}`) || c.endsWith(` "${t}"`));
}
// CodeGraph's lock, <checkout>\.codegraph\codegraph.lock, holds the pid of the process writing the index
function lockPid(top) {
  try { const n = parseInt(fs.readFileSync(lockOf(top), 'utf8').trim(), 10); return n > 0 ? n : null; } catch { return null; }
}

// the installed CodeGraph: { version, extraction }, kept in codegraph-engine.json across restarts
const ENGINE_FILE = path.join(path.dirname(LOG), 'codegraph-engine.json');
const PROBE = path.join(path.dirname(LOG), 'codegraph-probe');
let engine = null, probing = false;
try { const e = JSON.parse(fs.readFileSync(ENGINE_FILE, 'utf8')); if (e && e.version && Number.isInteger(e.extraction)) engine = e; } catch {}

// codegraph(args, cwd, stdio, env): runs the command with the paths quoted. On Windows the npm command is a .cmd, so
// cmd.exe runs it, named in full: a bare `codegraph` can find a .js file of that name first (PATHEXT). Paths were
// checked for characters cmd treats specially. macOS and Linux: found on the login shell's PATH (with node, which it
// runs on), in a process group of its own, so kill() ends it with its workers
function codegraph(args, cwd, stdio, env) {
  if (!P.isWin) return spawn(P.which('codegraph') || 'codegraph', args, { cwd, stdio, env: { ...process.env, PATH: P.loginShellPath(), ...env }, ...P.detachGroup });
  const line = ['codegraph.cmd', ...args].map((a) => (/^[\w.-]+$/.test(a) ? a : `"${a}"`)).join(' ');
  return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { cwd, windowsHide: true, windowsVerbatimArguments: true, stdio, env: { ...process.env, ...env } });
}

// is the installed CodeGraph new? Then build a one-file index in PROBE and read the extraction version it stamps.
// When that went up, every index is checked again, and the ones an older CodeGraph built are rebuilt.
function probeEngine() {
  if (probing) return;
  probing = true;
  let out = '';
  const v = codegraph(['--version'], os.tmpdir(), ['ignore', 'pipe', 'ignore']);
  v.stdout.on('data', (d) => { out += d; });
  v.on('error', () => { probing = false; });
  v.on('exit', () => {
    const version = (out.match(/\d+\.\d+\.\d+[\w.-]*/) || [])[0];
    if (!version || (engine && engine.version === version)) { probing = false; return; }
    try {
      fs.rmSync(PROBE, { recursive: true, force: true });
      fs.mkdirSync(PROBE, { recursive: true });
      fs.writeFileSync(path.join(PROBE, 'probe.js'), 'function probe() { return 1; }\nmodule.exports = { probe };\n');
    } catch (e) { probing = false; return log(`could not make ${PROBE}: ${e.code || e.message}`); }
    const p = codegraph(['init', '--yes', PROBE], PROBE, 'ignore');
    p.on('error', () => { probing = false; });
    p.on('exit', () => check(PROBE, (s, { extraction }) => {
      probing = false;
      if (!Number.isInteger(extraction)) return log(`CodeGraph ${version}: could not read the extraction version it stamps (probe: ${s})`);
      const was = engine;
      engine = { version, extraction };
      try { fs.writeFileSync(ENGINE_FILE, JSON.stringify(engine)); } catch {}
      log(`CodeGraph ${version}, extraction ${extraction}${was ? ` (was ${was.version}, extraction ${was.extraction})` : ''}`);
      if (!was || was.extraction !== extraction) complete.clear();
    }));
  });
}

// the repo's own .git\info\exclude (a worktree's root is its main repo) gets the folder once
function exclude(root) {
  const f = path.join(root, '.git', 'info', 'exclude');
  try {
    if (!fs.statSync(path.join(root, '.git')).isDirectory()) return;
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch {}
    if (text.split(/\r?\n/).some((l) => l.trim() === `/${DIR}/`)) return;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, `${text && !text.endsWith('\n') ? '\n' : ''}# CodeGraph indexes (Fleet View)\n/${DIR}/\n`);
  } catch (e) { log(`could not update ${f}: ${e.code || e.message}`); }
}

function findCodegraph() {
  if (finding || (found !== null && Date.now() - foundAt < FIND_EVERY_MS)) return;
  finding = true;
  const look = P.isWin ? (cb) => execFile('where', ['codegraph.cmd'], { windowsHide: true, timeout: 10e3 }, cb) : (cb) => setImmediate(() => cb(P.which('codegraph') ? null : new Error('not found')));
  look((err) => {
    finding = false;
    const was = found;
    found = !err; foundAt = Date.now();
    if (found !== was) log(found ? 'codegraph found on PATH: indexing checkouts' : 'codegraph is not on PATH: no indexes are built');
    if (found) { probeEngine(); adopt(); }
    next();
  });
}

// once, before the first build: the builds an earlier server started (codegraph-builds\*.json). One still running is
// waited for as this server's own; one that stopped left its index part way, which want() then builds again. A failed
// one keeps its hour's wait
function adopt() {
  if (adopted || adopting) return;
  adopting = true;
  let recs = [];
  try {
    for (const f of fs.readdirSync(BUILDS)) {
      if (!f.endsWith('.json')) continue;
      try { const r = JSON.parse(fs.readFileSync(path.join(BUILDS, f), 'utf8')); if (r && typeof r.top === 'string') recs.push(r); } catch {}
    }
  } catch {}
  for (const r of recs.filter((x) => x.failed)) {
    if (Date.now() - r.failed < RETRY_MS) failed.set(key(r.top), r.failed);
    else try { fs.unlinkSync(recOf(r.top)); } catch {}
  }
  recs = recs.filter((x) => !x.failed);
  const end = () => { adopted = true; adopting = false; if (orphans.size) watchOrphans(); next(); };
  if (!recs.length) return end();
  nodes((list) => {
    for (const r of recs) {
      if (list && list.some((p) => runs(p.command, r.top))) {
        orphans.set(key(r.top), { top: r.top, started: Number(r.started) || Date.now() });
        log(`${r.top}: still building (started ${Math.round((Date.now() - (Number(r.started) || Date.now())) / 1000)}s ago, before Fleet View restarted)`);
      } else try { fs.unlinkSync(recOf(r.top)); } catch {}
    }
    end();
  });
}

// every POLL_MS: has an adopted build ended? It is then logged and counted as this server's own would be, and one
// still going after BUILD_MAX_MS is stopped (its processes, found by their command line, never by a pid alone)
let watching = null;
function watchOrphans() {
  if (watching) return;
  watching = setInterval(() => nodes((list) => {
    if (!list) return;
    for (const [k, o] of orphans) {
      if (o.ending) continue;
      const pids = list.filter((p) => runs(p.command, o.top)).map((p) => p.pid);
      if (pids.length) {
        if (!o.stopped && Date.now() - o.started > BUILD_MAX_MS) { o.stopped = true; log(`${o.top}: still building after ${BUILD_MAX_MS / 60e3} min, stopped`); for (const pid of pids) P.killTree(pid); }
        continue;
      }
      o.ending = true;
      check(o.top, (s) => {
        if (s === 'busy') { o.ending = false; return watchOrphans(); } // being written (an MCP server opened it): later
        orphans.delete(k);
        finish(o, s === 'done', o.stopped ? 'stopped' : 'ended part way');
        next();
      });
    }
    if (![...orphans.values()].some((o) => !o.ending)) { clearInterval(watching); watching = null; }
  }), POLL_MS);
}

// a build ended: ok, or failed with how (an exit code, or how an adopted one ended) and what it wrote to stderr
function finish(job, ok, how) {
  const s = Math.round((Date.now() - job.started) / 1000), k = key(job.top);
  if (ok) {
    complete.add(k);
    log(`${job.top}: built in ${s}s`);
    for (const f of [recOf(job.top), errOf(job.top)]) try { fs.unlinkSync(f); } catch {}
    return;
  }
  failed.set(k, Date.now());
  try { fs.writeFileSync(recOf(job.top), JSON.stringify({ top: job.top, failed: Date.now() })); } catch {}
  let err = '';
  try { const b = fs.readFileSync(errOf(job.top)); err = b.subarray(Math.max(0, b.length - 4000)).toString('utf8').trim(); } catch {}
  log(`${job.top}: failed after ${s}s (${how})${err ? `\n    ${err.slice(-800).replace(/\r?\n/g, '\n    ')}` : ''}`);
}

// want(top, root): the checkout at top (root: its main repo) should have an index
function want(top, root) {
  if (!top || UNSAFE.test(top)) return;
  findCodegraph();
  if (found === false) return;
  const k = key(top);
  if (busy(k)) return;
  if (Date.now() - (failed.get(k) || 0) < RETRY_MS) return;
  if (!fs.existsSync(dbOf(top))) {
    complete.delete(k);
    queue.push({ top, root: root || top });
    return next();
  }
  if (complete.has(k) || checking.has(k)) return;
  checking.add(k);
  const rebuild = (why) => { if (!busy(k)) { queue.push({ top, root: root || top, rebuild: why }); next(); } };
  check(top, (s, { extraction, updated }) => {
    if (s === 'done') complete.add(k);
    if (s === 'stale') rebuild(`built by an older CodeGraph: extraction ${extraction}, now ${engine.extraction}`);
    if (s !== 'partial' || busy(k)) return checking.delete(k);
    // part way: built again at once, unless a build of it runs (an earlier server's is adopted before any build)
    nodes((list) => {
      checking.delete(k);
      if (!list) { if (Date.now() - updated > BUILD_MAX_MS) rebuild('the last build stopped part way'); return; } // can't tell: as before
      if (list.some((p) => runs(p.command, top))) return; // someone's own `codegraph index`, say: left to finish
      const pid = lockPid(top), holder = pid && list.find((p) => p.pid === pid);
      // a CodeGraph that holds the lock without building (an MCP server's sync) gets a build's time to let go
      if (holder && /codegraph/i.test(holder.command) && Date.now() - updated < BUILD_MAX_MS) return;
      if (pid) try { fs.unlinkSync(lockOf(top)); } catch {}
      rebuild(`the last build stopped part way${pid ? `; its lock named pid ${pid}, ${holder ? 'now another process' : 'gone'}` : ''}`);
    });
  });
}

function next() {
  if (building || orphans.size || !adopted || !found) return;
  let job;
  // (a failure an earlier server saw is known only once adopt() has run)
  while ((job = queue.shift()) && ((!job.rebuild && fs.existsSync(dbOf(job.top))) || Date.now() - (failed.get(key(job.top)) || 0) < RETRY_MS)) {}
  if (!job) return;
  try { if (!fs.statSync(job.top).isDirectory()) return next(); } catch { return next(); }
  building = job.top;
  exclude(job.root);
  const t0 = Date.now();
  // `init` makes a new index; one a build left part way, or an older CodeGraph built, is made again by `index`
  log(`${job.top}: ${job.rebuild ? `rebuilding (${job.rebuild})` : 'building'}`);
  let err = 'ignore';
  try {
    fs.mkdirSync(BUILDS, { recursive: true });
    fs.writeFileSync(recOf(job.top), JSON.stringify({ top: job.top, root: job.root, started: t0 }));
    err = fs.openSync(errOf(job.top), 'w');
  } catch (e) { log(`could not write to ${BUILDS}: ${e.code || e.message}`); }
  let p;
  try { p = codegraph([...(job.rebuild ? ['index', '--quiet'] : ['init', '--yes']), job.top], job.top, ['ignore', 'ignore', err], BUILD_ENV); }
  finally { if (typeof err === 'number') try { fs.closeSync(err); } catch {} }
  try { os.setPriority(p.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
  const timer = setTimeout(() => { log(`${job.top}: still building after ${BUILD_MAX_MS / 60e3} min, stopped`); kill(p); }, BUILD_MAX_MS);
  const done = (code, e) => {
    if (building !== job.top) return;
    clearTimeout(timer);
    building = null;
    if (e) try { fs.appendFileSync(errOf(job.top), `\n${e}`); } catch {}
    finish({ top: job.top, started: t0 }, code === 0 && fs.existsSync(dbOf(job.top)), `exit ${code}`);
    next();
  };
  p.on('error', (e) => done(-1, e.message));
  p.on('exit', (code) => done(code));
}
function kill(p) {
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(p.pid), '/t', '/f'], { windowsHide: true }, () => {});
  else P.killTree(p.pid);
}

// ---------- stray MCP servers ----------
// Claude Code starts `codegraph serve --mcp` for every session: on Windows claude.exe -> cmd.exe (codegraph.cmd)
// -> node npm-shim.js -> the bundled node running codegraph.js, each `serve --mcp`; on macOS node running the npm
// `codegraph` (the shim) -> the bundled codegraph.js. That last one is a thin proxy: it pipes the session to one
// shared daemon per checkout, `codegraph.js serve --mcp --path <checkout>`, which the first proxy starts detached
// and which ends by itself 30 s (the accounts' CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS) after its last proxy goes.
// A proxy watches only the shim and cmd.exe above it, never claude.exe itself, so a chain whose session ended
// without closing its pipes can stay up for good, holding its daemon up with it. Every SWEEP_MS strays() picks:
//   - a proxy chain whose top has lost its parent: on Windows the parent pid runs no more, or now names a process
//     that started after the child (a pid reused); on macOS the child went to launchd (ppid 1). The whole chain
//     goes, each process on its own (never a tree kill: a daemon is a child of the proxy that started it).
//   - a daemon only when no session can be using it: its parent is gone too (always so once the proxy that started
//     it ended, while other sessions still use it), it is over DAEMON_MIN_AGE_MS old, every live proxy belongs to a
//     Claude session whose cwd is known (~/.claude*/sessions/<pid>.json; another program's proxy: nothing is
//     ended), and no live session's cwd is the daemon's checkout, inside it, or above it.
// Fleet View's own builds run `init`/`index`, never `serve`, so they never match. Each one ended is logged.
// scripts\codegraph-contract.js checks that a new CodeGraph's processes still read so (serverKind()).
const SWEEP_MS = 5 * 60e3, DAEMON_MIN_AGE_MS = 10 * 60e3;
// serverKind(command): null, { kind: 'proxy' } or { kind: 'daemon', path }, from a command line
function serverKind(command) {
  const c = String(command || '');
  const m = /(?:^|[\s"'\\/])(?:codegraph(?:\.js|\.cmd)?|npm-shim\.js)["']?\s+serve\s+--mcp(?=["']?(?:\s|$))["']?(.*)$/i.exec(c);
  if (!m) return null;
  const p = /^\s+--path\s+(.+)$/.exec(m[1]);
  if (!p) return { kind: 'proxy' };
  const v = p[1].trim();
  return { kind: 'daemon', path: /^"[^"]*"$/.test(v) || /^'[^']*'$/.test(v) ? v.slice(1, -1) : v };
}
// strays(list, o): the servers to end, [{ pid, kind, path, mb, why }]. list: [{ pid, ppid, started, mb, command }]
// (P.processTable). o: { win (Windows rules; default this platform), sessions (Map of a live session's claude pid
// -> its cwd; null: not known, no daemon is ended), now, minAge (DAEMON_MIN_AGE_MS), self (never ended: this pid) }
function strays(list, o = {}) {
  const win = o.win === undefined ? P.isWin : !!o.win, now = o.now || Date.now();
  const minAge = o.minAge === undefined ? DAEMON_MIN_AGE_MS : o.minAge, sessions = o.sessions || null;
  const fold = (s) => String(s).replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();
  const byPid = new Map((list || []).map((p) => [p.pid, p]));
  const kinds = new Map();
  for (const p of list || []) { const k = serverKind(p.command); if (k) kinds.set(p.pid, k); }
  const parentGone = (p) => {
    if (!win) return p.ppid <= 1 || !byPid.has(p.ppid);
    const parent = byPid.get(p.ppid);
    return !parent || (parent.started != null && p.started != null && parent.started > p.started);
  };
  // orphaned(p): a proxy chain member whose chain lost its parent. Memoized; a loop (never seen) counts as alive
  const memo = new Map();
  const orphaned = (p) => {
    if (memo.has(p.pid)) return memo.get(p.pid);
    memo.set(p.pid, false);
    let r = parentGone(p);
    if (!r) { const parent = byPid.get(p.ppid), pk = kinds.get(p.ppid); r = !!(pk && pk.kind === 'proxy' && orphaned(parent)); }
    memo.set(p.pid, r);
    return r;
  };
  const out = [];
  const proxies = [...kinds].filter(([, k]) => k.kind === 'proxy').map(([pid]) => byPid.get(pid));
  for (const p of proxies) if (p.pid !== o.self && orphaned(p)) out.push({ pid: p.pid, kind: 'proxy', path: null, mb: p.mb, why: parentGone(p) ? 'its parent is gone' : 'its chain lost its parent' });
  // daemons: only with every live proxy's session known
  if (!sessions) return out;
  const live = proxies.filter((p) => !orphaned(p));
  const tops = live.filter((p) => { const k = kinds.get(p.ppid); return !(k && k.kind === 'proxy'); });
  if (tops.some((p) => !sessions.has(p.ppid))) return out;
  const cwds = [...sessions].filter(([pid]) => byPid.has(pid)).map(([, cwd]) => cwd && fold(cwd));
  if (cwds.some((c) => !c)) return out;
  for (const [pid, k] of kinds) {
    if (k.kind !== 'daemon' || pid === o.self) continue;
    const d = byPid.get(pid), parent = byPid.get(d.ppid), pk = kinds.get(d.ppid);
    if (!parentGone(d) && !(pk && pk.kind === 'proxy' && orphaned(parent))) continue; // its proxy still runs
    if (d.started == null || now - d.started < minAge) continue;
    const at = fold(k.path);
    if (!at || cwds.some((c) => c === at || c.startsWith(`${at}/`) || at.startsWith(`${c}/`))) continue;
    out.push({ pid, kind: 'daemon', path: k.path, mb: d.mb, why: 'no live session works in its checkout' });
  }
  return out;
}
// the live Claude sessions: claude pid -> cwd, from every account's sessions folder (null when none can be read)
function sessionCwds() {
  let SC;
  try { SC = require('./sync-common'); } catch { return null; }
  const map = new Map();
  try {
    for (const dir of SC.sessionDirs(os.homedir())) {
      let names = [];
      try { names = fs.readdirSync(dir); } catch {}
      for (const f of names) {
        if (!/^\d+\.json$/.test(f)) continue;
        const j = SC.readState(path.join(dir, f), null);
        map.set(Number(f.slice(0, -5)), j && typeof j.cwd === 'string' ? j.cwd : null);
      }
    }
  } catch { return null; }
  return map;
}
let sweeping = false;
function sweepStrays() {
  if (sweeping || found === false) return;
  sweeping = true;
  P.processTable((list) => {
    sweeping = false;
    if (!list) return;
    for (const s of strays(list, { sessions: sessionCwds(), self: process.pid })) {
      if (P.isWin) execFile('taskkill', ['/f', '/pid', String(s.pid)], { windowsHide: true }, () => {});
      else try { process.kill(s.pid, 'SIGTERM'); } catch {}
      log(`ended a stray CodeGraph MCP ${s.kind}: pid ${s.pid}, ${s.path ? `--path ${s.path}` : 'no --path'}, ${s.mb == null ? '?' : s.mb} MB (${s.why})`);
    }
  }, 'codegraph');
}
// started by fleet-view.js (not in its demo): a first look 2 min after start, then every SWEEP_MS
let sweepTimer = null;
function startSweeping() {
  if (sweepTimer) return;
  sweepTimer = setInterval(sweepStrays, SWEEP_MS);
  setTimeout(sweepStrays, 2 * 60e3).unref?.();
}

module.exports = {
  want, check, runs, lockPid, nodes, BUILD_ENV, serverKind, strays, sweepStrays, startSweeping,
  status: () => {
    const o = [...orphans.values()].map((x) => x.top);
    return { found, engine, building: building || o[0] || null, queued: [...o.slice(building ? 0 : 1), ...queue.map((q) => q.top)] };
  },
};
