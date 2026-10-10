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
const indexed = (top) => fs.existsSync(path.join(top, DIR, 'codegraph.db'));

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
  if (indexed(top)) return;
  queue.push({ top, root: root || top });
  next();
}

function next() {
  if (building || !found) return;
  let job;
  while ((job = queue.shift()) && indexed(job.top)) {}
  if (!job) return;
  try { if (!fs.statSync(job.top).isDirectory()) return next(); } catch { return next(); }
  building = job.top;
  exclude(job.root);
  const t0 = Date.now();
  log(`${job.top}: building`);
  const win = process.platform === 'win32';
  // the npm command is a .cmd on Windows, so cmd.exe runs it, named in full: a bare `codegraph` can find a .js file of
  // that name first (PATHEXT). The path was checked for characters cmd treats specially
  const p = win
    ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"codegraph.cmd init --yes "${job.top}""`], { cwd: job.top, windowsHide: true, windowsVerbatimArguments: true, stdio: ['ignore', 'ignore', 'pipe'] })
    : spawn('codegraph', ['init', '--yes', job.top], { cwd: job.top, stdio: ['ignore', 'ignore', 'pipe'] });
  try { os.setPriority(p.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
  let err = '';
  p.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
  const timer = setTimeout(() => { log(`${job.top}: still building after ${BUILD_MAX_MS / 60e3} min, stopped`); kill(p); }, BUILD_MAX_MS);
  const done = (code) => {
    if (building !== job.top) return;
    clearTimeout(timer);
    building = null;
    const s = Math.round((Date.now() - t0) / 1000);
    if (code === 0 && indexed(job.top)) log(`${job.top}: built in ${s}s`);
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

module.exports = { want, status: () => ({ found, building, queued: queue.map((q) => q.top) }) };
