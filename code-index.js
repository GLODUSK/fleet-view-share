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
//   - a build cut short (Fleet View restarted, the PC went down) leaves an index CodeGraph itself marks "indexing";
//     once it has sat like that for longer than a build may take, it is built again from scratch.
//   - a newer CodeGraph can extract more than the one that built an index (its "extraction version" goes up), and
//     only a rebuild adds that. When the installed version changes, a tiny index built in codegraph-probe tells the
//     extraction version it stamps, and every index stamped lower is rebuilt. Updating CodeGraph itself, and what
//     to do when a new one needs this file changed: docs\codegraph-update.md.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

const LOG = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'fleet-view', 'codegraph.log');
const DIR = '.codegraph';
const RETRY_MS = 3600e3, BUILD_MAX_MS = 30 * 60e3, FIND_EVERY_MS = 10 * 60e3;
const UNSAFE = /["%^&|<>\x00-\x1f]/;

let found = null, foundAt = 0, finding = false; // is `codegraph` on PATH (null: not checked yet)
const queue = []; // { top, root } checkouts waiting, in order
const failed = new Map(); // checkout key -> when its build failed
let building = null; // the checkout being built now

const key = (p) => path.resolve(p).toLowerCase();
function log(text) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, `${new Date().toISOString().replace('T', ' ').slice(0, 19)} ${text}\n`);
  } catch {}
}
const dbOf = (top) => path.join(top, DIR, 'codegraph.db');
const complete = new Set(); // checkout keys whose index was found complete: not opened again
const checking = new Set(); // checkout keys being checked now

// check(top, cb): is the checkout's index finished and current? CodeGraph's own project_metadata says it:
// index_state reads "complete" once a build is done, and indexed_with_extraction_version is the extraction version
// of the CodeGraph that built it. cb(state, { extraction }) gets 'done' (complete, or a state it can't read: an older
// CodeGraph, no node:sqlite, a file it is better to leave alone), 'busy' (a build may be running now), 'partial' (a
// build stopped part way) or 'stale' (built by a CodeGraph that extracted less than the installed one).
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
    if (r.value && r.value !== 'complete') return cb(Date.now() - Number(r.updated_at) < BUILD_MAX_MS ? 'busy' : 'partial', info);
    // an index with no stamp is left alone: rebuilding it would not add one if CodeGraph stopped writing it
    cb(engine && r.extraction !== null && r.extraction < engine.extraction ? 'stale' : 'done', info);
  });
}

// the installed CodeGraph: { version, extraction }, kept in codegraph-engine.json across restarts
const ENGINE_FILE = path.join(path.dirname(LOG), 'codegraph-engine.json');
const PROBE = path.join(path.dirname(LOG), 'codegraph-probe');
let engine = null, probing = false;
try { const e = JSON.parse(fs.readFileSync(ENGINE_FILE, 'utf8')); if (e && e.version && Number.isInteger(e.extraction)) engine = e; } catch {}

// codegraph(args, cwd): runs the command with the paths quoted. On Windows the npm command is a .cmd, so cmd.exe runs
// it, named in full: a bare `codegraph` can find a .js file of that name first (PATHEXT). Paths were checked for
// characters cmd treats specially
function codegraph(args, cwd, stdio) {
  if (process.platform !== 'win32') return spawn('codegraph', args, { cwd, stdio });
  const line = ['codegraph.cmd', ...args].map((a) => (/^[\w.-]+$/.test(a) ? a : `"${a}"`)).join(' ');
  return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { cwd, windowsHide: true, windowsVerbatimArguments: true, stdio });
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
  execFile(process.platform === 'win32' ? 'where' : 'which', [process.platform === 'win32' ? 'codegraph.cmd' : 'codegraph'], { windowsHide: true, timeout: 10e3 }, (err) => {
    finding = false;
    const was = found;
    found = !err; foundAt = Date.now();
    if (found !== was) log(found ? 'codegraph found on PATH: indexing checkouts' : 'codegraph is not on PATH: no indexes are built');
    if (found) probeEngine();
    next();
  });
}

// want(top, root): the checkout at top (root: its main repo) should have an index
function want(top, root) {
  if (!top || UNSAFE.test(top)) return;
  findCodegraph();
  if (found === false) return;
  const k = key(top);
  if ((building && key(building) === k) || queue.some((q) => key(q.top) === k)) return;
  if (Date.now() - (failed.get(k) || 0) < RETRY_MS) return;
  if (!fs.existsSync(dbOf(top))) {
    complete.delete(k);
    queue.push({ top, root: root || top });
    return next();
  }
  if (complete.has(k) || checking.has(k)) return;
  checking.add(k);
  check(top, (s, { extraction }) => {
    checking.delete(k);
    if (s === 'done') complete.add(k);
    else if ((s === 'partial' || s === 'stale') && !(building && key(building) === k) && !queue.some((q) => key(q.top) === k)) {
      const why = s === 'stale' ? `built by an older CodeGraph: extraction ${extraction}, now ${engine.extraction}` : 'the last build stopped part way';
      queue.push({ top, root: root || top, rebuild: why });
      next();
    }
  });
}

function next() {
  if (building || !found) return;
  let job;
  while ((job = queue.shift()) && !job.rebuild && fs.existsSync(dbOf(job.top))) {}
  if (!job) return;
  try { if (!fs.statSync(job.top).isDirectory()) return next(); } catch { return next(); }
  building = job.top;
  exclude(job.root);
  const t0 = Date.now();
  // `init` makes a new index; one a build left part way, or an older CodeGraph built, is made again by `index`
  log(`${job.top}: ${job.rebuild ? `rebuilding (${job.rebuild})` : 'building'}`);
  const p = codegraph([...(job.rebuild ? ['index', '--quiet'] : ['init', '--yes']), job.top], job.top, ['ignore', 'ignore', 'pipe']);
  try { os.setPriority(p.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
  let err = '';
  p.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
  const timer = setTimeout(() => { log(`${job.top}: still building after ${BUILD_MAX_MS / 60e3} min, stopped`); kill(p); }, BUILD_MAX_MS);
  const done = (code) => {
    if (building !== job.top) return;
    clearTimeout(timer);
    building = null;
    const s = Math.round((Date.now() - t0) / 1000);
    if (code === 0 && fs.existsSync(dbOf(job.top))) { complete.add(key(job.top)); log(`${job.top}: built in ${s}s`); }
    else { failed.set(key(job.top), Date.now()); log(`${job.top}: failed after ${s}s (exit ${code})${err.trim() ? `\n    ${err.trim().slice(-800).replace(/\r?\n/g, '\n    ')}` : ''}`); }
    next();
  };
  p.on('error', (e) => { err += e.message; done(-1); });
  p.on('exit', (code) => done(code));
}
function kill(p) {
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(p.pid), '/t', '/f'], { windowsHide: true }, () => {});
  else try { p.kill(); } catch {}
}

module.exports = { want, check, status: () => ({ found, engine, building, queued: queue.map((q) => q.top) }) };
