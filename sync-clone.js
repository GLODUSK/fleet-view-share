// sync-clone.js: "Clone what's missing" (docs/sync-follow.md, item 5; docs/sync.md "Repos this machine lacks"). The
// materializer skips a synced conversation whose repo has no checkout on this machine ("no checkout of its repo here",
// sync-down.js missing()). This clones such a repo into this machine's clone folder, registers it with Fleet View the
// way the page's "Add workspace" does (POST /repos/add), so the materializer's next scan finds it by its origin and
// brings its conversations down, then installs its dependencies in the background.
//
//   createCloner({ dataDir, log, now, home, missing, roots, register, rescan, settings, urlOf, git, run, which, gh,
//                  platform })
//     -> { view(), clone(origins, { folder, auto, skip }), job(id), setPolicy({ notNow, auto, folder }), tick(),
//          idle() }
//
//   missing()   -> { at, repos: [{ origin, name, chats, newest }] }: sync-run.js missing(), the materializer's list
//               (at null before its first whole scan). Only origins a host can clone from (https://<host>/<path>, as
//               sync-common.js normalizeOrigin writes them) are offered: never the home row, never a bound one.
//   roots()     -> [folder]: the repos this machine knows (fleet-view.js pageRepos()), for the default clone folder
//   register(dir) -> { ok, message? }: fleet-view.js addRepo, exactly as POST /repos/add
//   rescan()    the materializer scans again now (sync-run.js rescan), so the new checkout's chats come at once
//   settings    { read() -> the saved policy | undefined, write(policy) }: this machine's own (fleet-view.js keeps it as
//               ~/.fleet-view.json's syncClone; sync-prefs.js never carries it to another machine)
//   urlOf(origin) -> the URL git clones from: the origin itself by default (tests point it at a local bare repo). The
//               clone's origin remote is always the synced origin afterwards, so the materializer matches it.
//   git(args, { cwd, timeoutMs }), run(file, args, { cwd, timeoutMs }) -> Promise<{ code, out, err }>; which(name) ->
//   a path or null; gh: the gh command's path (by default which('gh'); null: none). For tests, all of them.
//
// The clone folder: settings' folder when Henry picked one, else the folder most of this machine's checkouts with an
// origin live in (Z:\Github on the PC, ~/code on the Mac), else ~/code on macOS, else the home folder. It is made when
// it is not there. A repo goes in <folder>/<its name> (the origin's last segment); a taken name gets -2, -3…, never a
// write into a folder that is there. A folder already there holding a checkout of that very origin at its top is
// registered as it is (found), nothing cloned. The clone goes into a hidden sibling first (.<name>.fv-clone-<random>)
// and is renamed into place once complete, so a failed or cut clone leaves nothing a scan or Henry could take for the
// repo (leftovers of a crash, over an hour old, are removed on the next clone into that folder).
//
// git runs as the user, with no terminal prompt (GIT_TERMINAL_PROMPT=0, GCM_INTERACTIVE=never): the credential
// helper this machine has (the Keychain, gh's) answers or the clone fails at once. A GitHub repo that fails for want
// of a sign-in is tried once more through gh repo clone when gh is here (it uses gh's own sign-in). Still failing:
// "Sign in to GitHub on this machine: gh auth login".
//
// Dependencies, once a new clone is registered (a clone counts as done without them; a checkout found already there
// is left as it is): the first lockfile found at its
// top picks the tool: package-lock.json npm ci, pnpm-lock.yaml pnpm install --frozen-lockfile, yarn.lock yarn install
// --frozen-lockfile, bun.lock or bun.lockb bun install. A tool that is not on this machine is a note ("pnpm is not on
// this machine: …"), and so is an install that fails; their output goes to <dataDir>/clone.log. Installs run one at a
// time, after the clones.
//
// The policy (Henry, 2026-10-11: ask once, then automatic), kept per machine as
//   { v: 1, folder: string | null, auto: boolean, notNow: [origin], declined: [origin], tried: { <origin>: ms } }
//   view().ask is true (the page shows its card: the repos, the folder, "Clone new repos automatically from now on",
//     Clone and Not now) while auto is off and some missing repo is neither put off (notNow), declined, tried already
//     (cloned, or a clone that failed: the Sync card offers it again) nor under way.
//   clone(origins, { auto: true }) turns auto on; skip (the repos Henry unticked) go to declined with auto (never
//     cloned by themselves) and to notNow without it. Not now (setPolicy({ notNow: true })) puts off every repo missing
//     now: the card comes back when a new one goes missing.
//   tick() (fleet-view.js calls it every 30 s): with auto on, every missing repo not declined and never tried is
//     cloned, each once: one that fails is not tried again by itself (the Sync card's Clone does). Only a repo under an
//     account this machine has a checkout from already (https://<host>/<owner>: Henry's GLODUSK) goes by itself: the
//     list comes from Supabase and a clone runs code (its install), so any other one waits in the card (ask is true
//     for it, auto or not) until Henry clones it. view()'s repos say trusted.
//   ownerOf(origin) -> https://<host>/<owner>, or null.
// Jobs run one at a time, their repos one after another. A job: { id, at, folder, auto, done, items: [{ origin, name,
// state: 'queued' | 'cloning' | 'done' | 'found' | 'failed', dir, message, install: null | { tool, state: 'waiting' |
// 'running' | 'done' | 'failed' | 'missing' | 'none', message } }] }, kept for the page for 30 minutes after it ends.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const P = require(path.join(__dirname, 'platform.js'));
const C = require(path.join(__dirname, 'sync-common.js'));

const CLONE_MS = 60 * 60e3; // one clone at most this long
const INSTALL_MS = 30 * 60e3; // one install at most this long
const GIT_MS = 30e3; // any other git call
const JOB_KEEP_MS = 30 * 60e3;
const LEFTOVER_MS = 3600e3; // a hidden .<name>.fv-clone-* this old is a crash's leftover
const LIST_MAX = 500; // notNow, declined, tried: at most this many each
const DEFAULT_MS = 60e3; // the default folder is worked out again after this
const LOG_MAX = 256 * 1024; // one install's output in clone.log at most this much (its end)
const UNSAFE = /["%^&|<>\x00-\x1f]/; // what fleet-view.js addRepo refuses in a path (cmd.exe's specials, control characters)
// a lockfile at the repo's top -> the install that goes with it, in this order
const INSTALLS = [
  ['package-lock.json', 'npm', ['ci']],
  ['pnpm-lock.yaml', 'pnpm', ['install', '--frozen-lockfile']],
  ['yarn.lock', 'yarn', ['install', '--frozen-lockfile']],
  ['bun.lock', 'bun', ['install']],
  ['bun.lockb', 'bun', ['install']],
];
// what git and gh say when a sign-in is missing or refused
const AUTH_RE = /authentication failed|could not read (username|password)|terminal prompts disabled|permission denied \(publickey\)|repository not found|returned error: 40[13]|access denied|gh auth login|not logged in/i;
const SIGN_IN = 'Sign in to GitHub on this machine: gh auth login';

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const there = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
const fold = (p) => P.foldCase(path.resolve(p));
const lastLine = (t) => String(t || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() || '';
const clip = (s, n = 300) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
// an origin a host can clone from: https://<host>/<path>, exactly as normalizeOrigin writes it
const cloneable = (o) => typeof o === 'string' && /^https:\/\/[a-z0-9.-]+\/\S+$/.test(o) && C.normalizeOrigin(o) === o;
// the account a repo is under: https://<host>/<first path segment> (GLODUSK on GitHub), or null
const ownerOf = (o) => { const m = typeof o === 'string' ? /^(https:\/\/[a-z0-9.-]+\/[^/\s]+)\/\S+$/.exec(o) : null; return m ? m[1] : null; };
// the folder a repo goes in: the origin's last segment, made safe for a folder name
function nameOf(origin) {
  const n = String(origin).split('/').pop() || 'repo';
  const safe = n.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '');
  return safe && !/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(safe) ? safe.slice(0, 100) : 'repo';
}
// a folder Henry gives: absolute (or ~/...), no character Fleet View will not pass on -> the resolved path or null
function folderOk(p, home) {
  if (typeof p !== 'string') return null;
  let f = p.trim().replace(/^(["'])(.*)\1$/, '$2').trim();
  if (!f || f.length > 1000 || UNSAFE.test(f)) return null;
  if (f === '~' || f.startsWith('~/') || f.startsWith('~\\')) f = path.join(home, f.slice(1));
  if (!path.isAbsolute(f)) return null;
  f = path.resolve(f);
  if (there(f) && !isDir(f)) return null;
  return f;
}

// ---------- running things ----------
// a program's path: on Windows the first of `where`'s answers that Windows can start (npm's folder has a bash script
// "npm" before npm.cmd), elsewhere platform.js which (the login shell's PATH)
function findTool(name) {
  if (typeof name !== 'string' || !/^[\w.+-]{1,80}$/.test(name)) return null;
  if (!P.isWin) return P.which(name);
  try {
    const r = require('child_process').spawnSync('where', [name], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    if (r.status !== 0) return null;
    return String(r.stdout).split(/\r?\n/).map((l) => l.trim()).find((l) => /\.(exe|cmd|bat)$/i.test(l)) || null;
  } catch { return null; }
}
function gitDefault(args, { cwd, timeoutMs = GIT_MS } = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
    try {
      execFile('git', args, { cwd, env, windowsHide: true, timeout: timeoutMs, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
        (err, out, errOut) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(out || ''), err: String(errOut || (err && !err.code ? err.message : '') || '') }));
    } catch (e) { resolve({ code: 1, out: '', err: e.message }); }
  });
}
// a program by its path, with fixed arguments; a Windows .cmd or .bat goes through cmd.exe (Node refuses to spawn one
// directly). Its whole output (stdout then stderr, as it came) is kept, to LOG_MAX
function runDefault(file, args, { cwd, timeoutMs = INSTALL_MS, env } = {}) {
  return new Promise((resolve) => {
    let c;
    const opts = { cwd, env: env || { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] };
    try {
      if (P.isWin && /\.(cmd|bat)$/i.test(file)) {
        const line = `"${[`"${file}"`, ...args].join(' ')}"`;
        c = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', line], { ...opts, windowsVerbatimArguments: true });
      } else c = spawn(file, args, { ...opts, ...P.detachGroup });
    } catch (e) { resolve({ code: 1, out: '', err: e.message }); return; }
    let out = '', err = '', done = false;
    const keep = (s, b) => { const t = s + b.toString('utf8'); return t.length > LOG_MAX ? t.slice(-LOG_MAX) : t; };
    c.stdout.on('data', (b) => { out = keep(out, b); });
    c.stderr.on('data', (b) => { err = keep(err, b); });
    const timer = setTimeout(() => { if (!done) { err += `\n(stopped after ${Math.round(timeoutMs / 60e3)} minutes)`; try { P.killTree(c.pid); } catch { try { c.kill(); } catch {} } } }, timeoutMs);
    c.on('error', (e) => { if (done) return; done = true; clearTimeout(timer); resolve({ code: 1, out, err: err + e.message }); });
    c.on('close', (code) => { if (done) return; done = true; clearTimeout(timer); resolve({ code: typeof code === 'number' ? code : 1, out, err }); });
  });
}

function createCloner(o = {}) {
  const dataDir = o.dataDir || P.dataDir();
  const home = o.home || os.homedir();
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const log = typeof o.log === 'function' ? o.log : () => {};
  const missingOf = typeof o.missing === 'function' ? o.missing : () => ({ at: null, repos: [] });
  const roots = typeof o.roots === 'function' ? o.roots : () => [];
  const register = typeof o.register === 'function' ? o.register : () => ({ ok: false, message: 'nothing to register with' });
  const rescan = typeof o.rescan === 'function' ? o.rescan : () => {};
  const urlOf = typeof o.urlOf === 'function' ? o.urlOf : (origin) => origin;
  const git = typeof o.git === 'function' ? o.git : gitDefault;
  const run = typeof o.run === 'function' ? o.run : runDefault;
  const which = typeof o.which === 'function' ? o.which : findTool;
  const platform = o.platform || process.platform;
  const logFile = path.join(dataDir, 'clone.log');
  const settings = o.settings && typeof o.settings.read === 'function' ? o.settings : { read: () => undefined, write: () => {} };
  let ghPath; // undefined: look once
  const ghOf = () => {
    if (ghPath === undefined) ghPath = o.gh !== undefined ? o.gh : which('gh');
    return ghPath || null;
  };

  // ---------- the policy ----------
  const strList = (a) => (Array.isArray(a) ? [...new Set(a.filter(cloneable))].slice(-LIST_MAX) : []);
  function load() {
    const s = (() => { try { return settings.read(); } catch { return undefined; } })();
    const j = s && typeof s === 'object' && !Array.isArray(s) ? s : {};
    const tried = {};
    if (j.tried && typeof j.tried === 'object' && !Array.isArray(j.tried)) for (const [k, v] of Object.entries(j.tried)) if (cloneable(k) && Number.isFinite(v)) tried[k] = v;
    return { v: 1, folder: folderOk(j.folder, home), auto: j.auto === true, notNow: strList(j.notNow), declined: strList(j.declined), tried };
  }
  let policy = load();
  function save() {
    const t = Object.entries(policy.tried).sort((a, b) => a[1] - b[1]).slice(-LIST_MAX);
    policy = { ...policy, notNow: strList(policy.notNow), declined: strList(policy.declined), tried: Object.fromEntries(t) };
    try { settings.write({ ...policy }); } catch (e) { log(`sync-clone: the policy could not be saved: ${e.message}`); }
  }
  const add = (list, origins) => [...new Set([...list, ...origins])];

  // ---------- the default clone folder ----------
  let defaultCache = { at: -Infinity, value: null };
  async function defaultFolder() {
    if (defaultCache.value && now() - defaultCache.at < DEFAULT_MS) return defaultCache.value;
    const counts = new Map(); // folded parent -> { dir, n, first }
    let i = 0;
    let list = [];
    try { list = roots() || []; } catch {}
    for (const r of Array.isArray(list) ? list : []) {
      if (typeof r !== 'string' || !path.isAbsolute(r)) continue;
      let repo = null;
      try { repo = await C.repoOf(r); } catch {}
      if (!repo || !repo.origin || fold(repo.mainRoot) === fold(home)) continue;
      const parent = path.dirname(path.resolve(repo.mainRoot));
      const k = fold(parent);
      const c = counts.get(k) || { dir: parent, n: 0, first: i++ };
      c.n++;
      counts.set(k, c);
    }
    const best = [...counts.values()].sort((a, b) => b.n - a.n || a.first - b.first)[0];
    const value = best ? best.dir : platform === 'darwin' ? path.join(home, 'code') : home;
    defaultCache = { at: now(), value };
    return value;
  }

  // ---------- the owners clones may come from by themselves ----------
  // A clone runs code: its install (npm ci's scripts) and later its CLAUDE.md. The synced repo list comes from
  // Supabase, so what is cloned without Henry's click is only a repo under an account (host and owner) this machine
  // has a checkout from already: Henry's own (GLODUSK). Any other one waits in the card for his Clone, auto or not.
  let ownersCache = { at: -Infinity, value: new Set() };
  async function trustedOwners() {
    if (now() - ownersCache.at < DEFAULT_MS) return ownersCache.value;
    const out = new Set();
    let list = [];
    try { list = roots() || []; } catch {}
    for (const r of Array.isArray(list) ? list : []) {
      if (typeof r !== 'string' || !path.isAbsolute(r)) continue;
      let repo = null;
      try { repo = await C.repoOf(r); } catch {}
      const o = repo && ownerOf(repo.origin);
      if (o) out.add(o);
    }
    ownersCache = { at: now(), value: out };
    return out;
  }

  // ---------- jobs ----------
  const jobs = new Map(); // id -> job
  const queue = []; // jobs waiting their turn
  const inFlight = new Set(); // origins queued or cloning
  const failed = new Map(); // origin -> message of its last failed clone
  let working = null; // the job running now
  const installs = []; // { item, dir } waiting for their install
  let installing = null;
  const idleWaiters = [];

  function pruneJobs() {
    for (const [id, j] of jobs) if (j.done && j.endedAt && now() - j.endedAt > JOB_KEEP_MS && !j.items.some((x) => x.install && ['waiting', 'running'].includes(x.install.state))) jobs.delete(id);
  }
  const copy = (j) => (j ? { id: j.id, at: j.at, folder: j.folder, auto: j.auto, done: j.done, items: j.items.map((x) => ({ ...x, install: x.install ? { ...x.install } : null })) } : null);

  function startJob(origins, folder, auto) {
    pruneJobs();
    const job = {
      id: crypto.randomBytes(8).toString('hex'), at: new Date(now()).toISOString(), folder, auto: !!auto, done: false, endedAt: 0,
      items: origins.map((origin) => ({ origin, name: nameOf(origin), state: 'queued', dir: null, message: '', install: null })),
    };
    for (const x of job.items) inFlight.add(x.origin);
    jobs.set(job.id, job);
    queue.push(job);
    pump();
    return job;
  }
  function pump() {
    if (working || !queue.length) { settleIdle(); return; }
    working = queue.shift();
    const job = working;
    (async () => {
      for (const item of job.items) {
        try { await cloneOne(item, job.folder); } catch (e) {
          item.state = 'failed';
          item.message = clip((e && e.message) || e);
        }
        inFlight.delete(item.origin);
        if (item.state === 'failed') { failed.set(item.origin, item.message); log(`sync-clone: ${item.origin}: ${item.message}`); } else failed.delete(item.origin);
      }
    })().finally(() => {
      job.done = true;
      job.endedAt = now();
      working = null;
      pump();
      pumpInstalls();
    });
  }

  // a leftover of a clone cut short (a crash): hidden, ours by its name, over an hour old
  function sweep(folder) {
    let names = [];
    try { names = fs.readdirSync(folder); } catch { return; }
    for (const n of names) {
      if (!/^\..+\.fv-clone-[0-9a-f]{8,}$/.test(n)) continue;
      const p = path.join(folder, n);
      try { if (now() - fs.lstatSync(p).mtimeMs > LEFTOVER_MS) fs.rmSync(p, { recursive: true, force: true }); } catch {}
    }
  }
  // <folder>/<name>, -2, -3…: the first one not there -> { dir }, or one there that is a checkout of origin at its top
  // -> { dir, found: true }
  async function placeFor(folder, name, origin, skip = new Set()) {
    for (let n = 1; n <= 100; n++) {
      const dir = path.join(folder, n === 1 ? name : `${name}-${n}`);
      if (skip.has(fold(dir))) continue;
      if (!there(dir)) return { dir };
      if (!isDir(dir)) continue;
      let r = null;
      try { r = await C.repoOf(dir, { fresh: true }); } catch {}
      if (r && r.origin === origin && fold(r.root) === fold(dir)) return { dir, found: true };
    }
    throw new Error(`${folder} has ${name} up to ${name}-100 already`);
  }
  const rm = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} };

  async function cloneOne(item, folder) {
    const { origin } = item;
    item.state = 'cloning';
    if (!cloneable(origin)) throw new Error('not a repo Fleet View can clone');
    try { fs.mkdirSync(folder, { recursive: true }); } catch (e) { throw new Error(`could not make ${folder}: ${e.code || e.message}`); }
    if (!isDir(folder)) throw new Error(`${folder} is not a folder`);
    sweep(folder);
    let place = await placeFor(folder, item.name, origin);
    if (place.found) {
      const reg = register(place.dir) || {};
      if (!reg.ok) throw new Error(`found ${place.dir}, but Fleet View could not add it: ${reg.message || 'refused'}`);
      item.state = 'found';
      item.dir = place.dir;
      item.message = `already here: ${place.dir}`;
      log(`sync-clone: ${origin}: a checkout was already at ${place.dir}; added it`);
      try { rescan(); } catch {}
      return; // a checkout Henry had: its dependencies are his (npm ci would empty its node_modules first)
    }
    const tmp = path.join(folder, `.${item.name}.fv-clone-${crypto.randomBytes(6).toString('hex')}`);
    const url = urlOf(origin);
    let r = await git(['clone', '--quiet', '--', url, tmp], { cwd: folder, timeoutMs: CLONE_MS });
    if (r.code !== 0) {
      rm(tmp);
      const gh = /^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(origin) && AUTH_RE.test(`${r.err}\n${r.out}`) ? ghOf() : null;
      if (gh) {
        const slug = origin.slice('https://github.com/'.length);
        log(`sync-clone: ${origin}: git could not sign in; trying gh repo clone`);
        r = await run(gh, ['repo', 'clone', slug, tmp, '--', '--quiet'], { cwd: folder, timeoutMs: CLONE_MS });
        if (r.code !== 0) rm(tmp);
      }
    }
    if (r.code !== 0) {
      const said = `${r.err}\n${r.out}`;
      throw new Error(AUTH_RE.test(said) ? SIGN_IN : `git clone failed: ${clip(lastLine(r.err) || lastLine(r.out) || `exit ${r.code}`)}`);
    }
    try {
      // the synced origin, whatever URL it came from, so the materializer matches it
      const got = await git(['remote', 'get-url', 'origin'], { cwd: tmp });
      if (C.normalizeOrigin(got.out.trim()) !== origin) {
        const set = await git(['remote', 'set-url', 'origin', origin], { cwd: tmp });
        if (set.code !== 0) throw new Error(`could not set its origin: ${clip(lastLine(set.err))}`);
      }
      // into place: a name taken while it cloned goes on to the next one, never into a folder that is there
      const tried = new Set();
      for (;;) {
        if (place.found) throw new Error(`a checkout of it appeared at ${place.dir} while it cloned`);
        try {
          fs.mkdirSync(place.dir); // claims the name (EEXIST: taken)
          fs.rmdirSync(place.dir);
          fs.renameSync(tmp, place.dir);
          break;
        } catch (e) {
          if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(e.code) || tried.size > 100) throw e;
          tried.add(fold(place.dir));
          place = await placeFor(folder, item.name, origin, tried);
        }
      }
    } catch (e) { rm(tmp); throw e; }
    item.dir = place.dir;
    const reg = register(place.dir) || {};
    if (!reg.ok) {
      item.state = 'failed';
      item.message = `cloned to ${place.dir}, but Fleet View could not add it: ${reg.message || 'refused'}`;
      return;
    }
    item.state = 'done';
    item.message = `cloned to ${place.dir}`;
    log(`sync-clone: ${origin}: cloned to ${place.dir}`);
    try { rescan(); } catch {}
    queueInstall(item, place.dir);
  }

  // ---------- dependencies ----------
  function queueInstall(item, dir) {
    const hit = INSTALLS.find(([f]) => there(path.join(dir, f)));
    if (!hit) { item.install = { tool: null, state: 'none', message: '' }; return; }
    const [, tool, args] = hit;
    item.install = { tool, state: 'waiting', message: `${tool} ${args.join(' ')}` };
    installs.push({ item, dir, tool, args });
    pumpInstalls();
  }
  function logText(text) {
    try { fs.mkdirSync(dataDir, { recursive: true }); fs.appendFileSync(logFile, text); } catch {}
  }
  function pumpInstalls() {
    if (installing || working || !installs.length) { settleIdle(); return; } // clones first: they bring the chats
    const t = installs.shift();
    installing = t;
    (async () => {
      const { item, dir, tool, args } = t;
      const cmd = `${tool} ${args.join(' ')}`;
      const file = which(tool);
      if (!file) {
        item.install = { tool, state: 'missing', message: `${tool} is not on this machine: install it, then run ${cmd} in ${dir}` };
        logText(`--- ${new Date(now()).toISOString()} ${dir}: ${cmd} skipped: ${tool} is not on this machine\n`);
        return;
      }
      item.install = { tool, state: 'running', message: cmd };
      logText(`--- ${new Date(now()).toISOString()} ${dir}: ${cmd}\n`);
      const r = await run(file, args, { cwd: dir, timeoutMs: INSTALL_MS });
      logText(`${r.out}${r.err ? `\n${r.err}` : ''}\n--- exit ${r.code}\n`);
      item.install = r.code === 0 ? { tool, state: 'done', message: cmd }
        : { tool, state: 'failed', message: `${cmd} failed (${clip(lastLine(r.err) || lastLine(r.out) || `exit ${r.code}`, 160)}); see clone.log` };
      log(`sync-clone: ${dir}: ${cmd} ${r.code === 0 ? 'done' : `failed (exit ${r.code})`}`);
    })().catch((e) => {
      t.item.install = { tool: t.tool, state: 'failed', message: clip((e && e.message) || e) };
    }).finally(() => {
      installing = null;
      pumpInstalls();
    });
  }
  function settleIdle() {
    if (working || queue.length || installing || installs.length) return;
    while (idleWaiters.length) idleWaiters.shift()();
  }
  // resolves once no clone or install is waiting or running (tests)
  const idle = () => new Promise((r) => { idleWaiters.push(r); settleIdle(); });

  // ---------- what the page reads and does ----------
  function missingNow() {
    let m = null;
    try { m = missingOf(); } catch {}
    const repos = m && Array.isArray(m.repos) ? m.repos.filter((r) => r && cloneable(r.origin)) : [];
    return { at: m && m.at ? m.at : null, repos };
  }
  async function view() {
    const m = missingNow();
    const notNow = new Set(policy.notNow), declined = new Set(policy.declined);
    const repos = m.repos.map((r) => {
      const state = inFlight.has(r.origin) ? (working && working.items.some((x) => x.origin === r.origin && x.state === 'cloning') ? 'cloning' : 'queued')
        : failed.has(r.origin) ? 'failed' : declined.has(r.origin) ? 'declined' : 'missing';
      // fresh: one the card asks about (neither put off, declined, tried already nor under way)
      const fresh = !notNow.has(r.origin) && !declined.has(r.origin) && !(r.origin in policy.tried) && !inFlight.has(r.origin);
      return { origin: r.origin, name: nameOf(r.origin), chats: Number(r.chats) || 0, newest: r.newest || null, state, fresh, ...(state === 'failed' ? { message: failed.get(r.origin) } : {}) };
    });
    const owners = await trustedOwners();
    for (const r of repos) r.trusted = owners.has(ownerOf(r.origin));
    // the card asks while auto is off, and with it on for a repo under an account this machine has nothing from
    const ask = repos.some((r) => r.fresh && (!policy.auto || !r.trusted));
    pruneJobs();
    const def = await defaultFolder();
    return {
      ok: true, at: m.at, repos, ask, auto: policy.auto, folder: policy.folder || def, defaultFolder: def, picked: !!policy.folder,
      jobs: [...jobs.values()].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 10).map(copy),
    };
  }
  const bad = (message) => Object.assign(new Error(message), { code: 'bad_request' });
  // clone these (each must be missing now) into folder (or this machine's clone folder); auto: turn "clone new repos
  // automatically" on or off; skip: the repos Henry left out (declined with auto, put off without)
  async function clone(origins, opts = {}) {
    if (!Array.isArray(origins) || !origins.length || origins.length > 100) throw bad('give the repos to clone');
    const m = missingNow();
    const known = new Set(m.repos.map((r) => r.origin));
    const want = [...new Set(origins.filter((x) => typeof x === 'string'))];
    const not = want.filter((x) => !known.has(x));
    if (not.length) throw bad(`not a repo this machine lacks: ${clip(not[0], 120)}`);
    const busy = want.filter((x) => inFlight.has(x));
    const go = want.filter((x) => !inFlight.has(x));
    let folder = null;
    if (opts.folder !== undefined && opts.folder !== null && opts.folder !== '') {
      folder = folderOk(opts.folder, home);
      if (!folder) throw bad('give the full path of a folder (no " % ^ & | < >)');
    }
    if (typeof opts.auto === 'boolean') policy.auto = opts.auto;
    if (folder) policy.folder = folder;
    const skip = Array.isArray(opts.skip) ? opts.skip.filter((x) => known.has(x) && !want.includes(x)) : [];
    if (skip.length) {
      if (policy.auto) policy.declined = add(policy.declined, skip);
      else policy.notNow = add(policy.notNow, skip);
    }
    for (const x of want) { policy.tried[x] = now(); policy.declined = policy.declined.filter((d) => d !== x); }
    save();
    if (!go.length) return { ok: true, job: null, busy };
    const job = startJob(go, folder || policy.folder || await defaultFolder(), policy.auto);
    return { ok: true, job: copy(job), busy };
  }
  // notNow: put off every repo missing now; auto: on or off; folder: this machine's clone folder ('' or null: the default)
  async function setPolicy(p = {}) {
    if (p.notNow === true) policy.notNow = add(policy.notNow, missingNow().repos.map((r) => r.origin));
    if (typeof p.auto === 'boolean') policy.auto = p.auto;
    if (p.folder !== undefined) {
      if (p.folder === null || p.folder === '') policy.folder = null;
      else {
        const f = folderOk(p.folder, home);
        if (!f) throw bad('give the full path of a folder (no " % ^ & | < >)');
        policy.folder = f;
      }
    }
    save();
    if (policy.auto) await tick();
    return view();
  }
  // auto: clone every missing repo never declined or tried, each once -> the job started, or null
  async function tick() {
    if (!policy.auto) return null;
    const m = missingNow();
    if (!m.at) return null;
    const declined = new Set(policy.declined), owners = await trustedOwners();
    const want = m.repos.map((r) => r.origin).filter((x) => owners.has(ownerOf(x)) && !declined.has(x) && !(x in policy.tried) && !inFlight.has(x));
    if (!want.length) return null;
    for (const x of want) policy.tried[x] = now();
    save();
    log(`sync-clone: cloning ${want.length} repo${want.length === 1 ? '' : 's'} by itself (clone new repos automatically is on)`);
    return startJob(want, policy.folder || await defaultFolder(), true);
  }
  const job = (id) => copy(typeof id === 'string' ? jobs.get(id) : null);

  return { view, clone, job, setPolicy, tick, idle, defaultFolder };
}

module.exports = { createCloner, cloneable, ownerOf, nameOf, folderOk, INSTALLS, SIGN_IN, runTool: runDefault, findTool };
