// Fleet View: the Preview tab's server side (web/preview.js shows it): which local dev servers a conversation has
// used, whether they answer, and starting and stopping the ones its folder's .claude/launch.json describes.
// fleet-view.js hands every /preview… request here (handle), with ctx = { sendJson, readBody, folders, log } and,
// when it offers one, ctx.find(id) -> { file } (the conversation's transcript, as the Chat tab finds it).
//
//   GET  /preview/urls?id=<conversation>&cwd=<folder>[&current=<url>][&frame=1]
//        -> { urls: [...], current? }
//        urls, newest first: the addresses found in the transcript, { url, from: 'transcript', at, up }, then the
//        launch.json configurations, { name, port, url, from: 'launch.json', launch: true, running, up }.
//        current (when asked): { url, up, frame? }; frame=1 also fetches that page's headers and says whether it
//        lets another page show it in a frame (X-Frame-Options, CSP frame-ancestors): the Edge window needs it,
//        the desktop window strips those headers for previews itself (desktop/main.js).
//   POST /preview/start { cwd, name } -> { ok, url, already?, message? }   starts that launch.json configuration
//   POST /preview/stop  { cwd, name } -> { ok, message? }                  stops it, with its whole process tree
//
// Found addresses: the end of the transcript (its last TAIL bytes, then only what was appended) is searched for
// http://localhost:<port>, http://127.0.0.1:<port> and http://[::1]:<port> (0.0.0.0 counts as localhost), in
// tool output and replies alike, with terminal colour codes taken out first (Vite prints its port in bold).
// One entry per port, the newest mention wins; its path is the newest one that looks like a page (not /api/…,
// not a .json or .js file). Fleet View's own port (4777, and the port this server answers on) is never listed.
// "up" is a quick TCP connect (UP_MS), remembered for a moment so a poll every few seconds stays cheap.
//
// launch.json is Claude desktop's format: { configurations: [{ name, runtimeExecutable, runtimeArgs?, port?,
// url?, cwd?, env? }] } (comments allowed): the folder's own, else the nearest one above it inside a listed folder
// (a worktree's repo). Start runs it in the conversation's folder (or its cwd, which must stay inside the
// folder) as a hidden background process: on Windows `cmd /d /s /c "<exe> <args>"` under a small detached node
// helper (see HELPER), so npm.cmd and the like resolve as in a terminal, nothing opens a window, and it keeps
// running when the server restarts. PORT is set to its port unless the configuration's env sets it.
// Its output goes to %LOCALAPPDATA%\fleet-view\preview-logs\<key>.log. One process
// per folder and name: starting one that runs (or whose port already answers) only answers its url. What runs is
// kept in %LOCALAPPDATA%\fleet-view\preview-procs.json, so a restarted server can still stop it; such a process
// is first checked to be the one it started (its command line), so a reused pid is never killed. Stop ends the
// whole tree (taskkill /T /F).
//
// Only folders inside ctx.folders() (the conversations' folders and the repos) are read or run. A request from
// any other page (an Origin that isn't this server's own, such as the previewed dev page itself) is refused.
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const FV_PORT = 4777;
const TAIL = 4 << 20; // bytes of a transcript read the first time
const MAX_FOUND = 40; // ports remembered per transcript
const MAX_LIST = 8; // found addresses answered
const UP_MS = 700; // TCP connect timeout
const UP_CACHE_MS = 2000;
const FRAME_MS = 4000; // the frame check's GET, until its headers
const MISS_MS = 15000; // a transcript not found isn't looked for again for this long
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const WIN = process.platform === 'win32';
const DATA = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'fleet-view');
const PROCS_FILE = path.join(DATA, 'preview-procs.json');
const LOG_DIR = path.join(DATA, 'preview-logs');

// ---------- addresses ----------
// a local dev server's address, or null: http, localhost / 127.0.0.1 / [::1], an explicit port that isn't Fleet View's
function localUrl(raw, ownPort) {
  if (typeof raw !== 'string' || !raw || raw.length > 2000) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'http:' || !LOCAL_HOSTS.has(u.hostname) || !u.port) return null;
  const port = Number(u.port);
  if (!(port > 0 && port < 65536) || port === FV_PORT || port === ownPort) return null;
  if (u.username || u.password) return null;
  return u;
}
const connectHost = (h) => (h === '[::1]' ? '::1' : h);

// ---------- transcripts ----------
const URL_RE = /\bhttps?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0):(\d{2,5})((?:\/[^\s"'<>`\\|)\]}]*)?)/gi;
const HINT_RE = /localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0/i;
const ANSI_JSON_RE = /\\u001b\[[0-9;?]*[A-Za-z]/gi; // a colour code as JSON writes it
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
const TS_RE = /"timestamp":"([^"]+)"/;
// a path that is an API call or a file, not a page to look at
const notPage = (p) => /^\/(api|_next|__|graphql|trpc|socket\.io|ws|hmr)(\/|$)/i.test(p) || /\.(json|m?js|ts|css|map|png|jpe?g|gif|svg|ico|txt|xml|woff2?)$/i.test(p);
// a browser or Node debugging port (Chrome DevTools Protocol, --inspect), never a dev server
const debugPath = (p) => /^\/(json|devtools)(\/|$)/i.test(p);

// every address in these lines, into found (port -> { host, port, page, at, seq }); seq orders them, newest last
function scanLines(text, found, state, ownPort) {
  for (const line of text.split('\n')) {
    if (!HINT_RE.test(line)) continue;
    const clean = line.replace(ANSI_JSON_RE, '').replace(ANSI_RE, '');
    const ts = TS_RE.exec(line);
    const at = ts ? Date.parse(ts[1]) || 0 : 0;
    URL_RE.lastIndex = 0;
    for (const m of clean.matchAll(URL_RE)) {
      if (!/^http:/i.test(m[0])) continue; // a local https server's certificate would be refused anyway
      const port = Number(m[2]);
      if (!(port > 0 && port < 65536) || port === FV_PORT || port === ownPort) continue;
      const host = m[1].toLowerCase() === '0.0.0.0' ? 'localhost' : m[1].toLowerCase();
      const p = (m[3] || '').replace(/[.,;:!?'"]+$/, '');
      if (debugPath(p)) { (state.debug ||= new Set()).add(port); found.delete(port); continue; }
      if (state.debug && state.debug.has(port)) continue;
      const old = found.get(port);
      const page = p && p !== '/' && !notPage(p) ? p : (old && old.page) || '';
      found.delete(port); // set again: now the newest
      found.set(port, { host, port, page, at: at || (old && old.at) || 0, seq: ++state.seq });
    }
  }
  while (found.size > MAX_FOUND) found.delete(found.keys().next().value);
}

// per transcript: what was found, and how far it was read (an offset just past the last whole line)
const scans = new Map(); // file -> { size, end, found, state }
function scanLog(file, ownPort) {
  let st;
  try { st = fs.statSync(file); } catch { return []; }
  let c = scans.get(file);
  if (c && st.size < c.size) c = null; // shrank or replaced: read again from the start
  if (!c) {
    c = { size: 0, end: Math.max(0, st.size - TAIL), found: new Map(), state: { seq: 0 }, partial: st.size > TAIL };
    if (scans.size > 50) scans.clear();
    scans.set(file, c);
  }
  if (st.size > c.end) {
    const from = Math.max(c.end, st.size - TAIL);
    const buf = Buffer.alloc(st.size - from);
    let fd = null;
    try { fd = fs.openSync(file, 'r'); fs.readSync(fd, buf, 0, buf.length, from); } catch { return list(c); } finally { if (fd !== null) try { fs.closeSync(fd); } catch {} }
    let text = buf.toString('utf8');
    let skip = 0;
    if (c.partial) { skip = text.indexOf('\n') + 1; c.partial = false; } // started mid-line
    const last = text.lastIndexOf('\n');
    if (last < skip) return list(c); // no whole line yet
    scanLines(text.slice(skip, last), c.found, c.state, ownPort);
    c.end = from + Buffer.byteLength(text.slice(0, last + 1), 'utf8');
  }
  c.size = st.size;
  return list(c);
}
function list(c) {
  return [...c.found.values()].sort((a, b) => b.seq - a.seq).slice(0, MAX_LIST)
    .map((f) => ({ url: `http://${f.host}:${f.port}${f.page || '/'}`, from: 'transcript', at: f.at || null }));
}

// the conversation's transcript: ctx.find when fleet-view.js offers it, else the projects folders, its own folder first
const logPaths = new Map(); // id -> path
const logMiss = new Map(); // id -> when a look found nothing
function projectRoots() {
  const out = [path.join(os.homedir(), '.claude', 'projects'), path.join(os.homedir(), '.claude-a', 'projects')];
  if (process.env.CLAUDE_CONFIG_DIR) out.push(path.join(process.env.CLAUDE_CONFIG_DIR, 'projects'));
  return [...new Set(out)];
}
function findLog(id, cwd, ctx) {
  if (typeof ctx.find === 'function') {
    try { const r = ctx.find(id); if (r && r.file) return r.file; } catch {}
  }
  if (!UUID_RE.test(id)) return null;
  const known = logPaths.get(id);
  if (known && fs.existsSync(known)) return known;
  const miss = logMiss.get(id);
  if (miss && Date.now() - miss < MISS_MS) return null;
  let best = null, bm = 0;
  const look = (f) => { try { const m = fs.statSync(f).mtimeMs; if (m > bm) { bm = m; best = f; } } catch {} };
  for (const root of projectRoots()) {
    if (cwd) look(path.join(root, cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`));
    if (best) continue;
    let dirs = [];
    try { dirs = fs.readdirSync(root); } catch {}
    for (const d of dirs) look(path.join(root, d, `${id}.jsonl`));
  }
  if (logPaths.size > 200) logPaths.clear();
  if (logMiss.size > 200) logMiss.clear();
  if (best) { logPaths.set(id, best); logMiss.delete(id); } else logMiss.set(id, Date.now());
  return best;
}

// ---------- is it answering ----------
const upCache = new Map(); // host:port -> { at, p }
function tcpUp(host, port) {
  const k = `${host}:${port}`;
  const c = upCache.get(k);
  if (c && Date.now() - c.at < UP_CACHE_MS) return c.p;
  const p = new Promise((resolve) => {
    let done = false;
    const s = net.connect({ host: connectHost(host), port, autoSelectFamily: true, timeout: UP_MS });
    const end = (v) => { if (done) return; done = true; s.destroy(); resolve(v); };
    s.once('connect', () => end(true));
    s.once('error', () => end(false));
    s.once('timeout', () => end(false));
  });
  if (upCache.size > 200) upCache.clear();
  upCache.set(k, { at: Date.now(), p });
  return p;
}
// may this page show inside another page's frame? false when X-Frame-Options or CSP frame-ancestors forbid it
function framable(h) {
  if (h['x-frame-options']) return false;
  const csp = [].concat(h['content-security-policy'] || []).join(';');
  const fa = csp.split(';').map((d) => d.trim()).find((d) => /^frame-ancestors(\s|$)/i.test(d));
  if (!fa) return true;
  return fa.split(/\s+/).slice(1).some((src) => src === '*' || /^http:\/\/(127\.0\.0\.1|localhost)(:\*|:\d+)?$/i.test(src) || src === 'http:');
}
function frameCheck(u) {
  return new Promise((resolve) => {
    let done = false;
    const end = (v) => { if (!done) { done = true; resolve(v); } };
    const req = http.get({
      host: connectHost(u.hostname), port: Number(u.port), path: `${u.pathname}${u.search}`, timeout: FRAME_MS, autoSelectFamily: true,
      headers: { Host: u.host, Accept: 'text/html,*/*' },
    }, (res) => { end({ status: res.statusCode, frame: framable(res.headers) }); res.destroy(); });
    req.on('timeout', () => { req.destroy(); end({ status: 0, frame: null }); });
    req.on('error', () => end({ status: 0, frame: null }));
  });
}

// ---------- folders and launch.json ----------
const norm = (p) => { const r = path.resolve(p).replace(/[\\/]+$/, '') || path.resolve(p); return WIN ? r.toLowerCase() : r; };
const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
// links resolved first (a junction inside a known folder may point anywhere)
function inside(p, dir) { const a = norm(real(p)), b = norm(real(dir)); return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep); }
// the folder if it is one the page may use (inside a conversation's folder or a repo) and exists, else null
function folderOk(ctx, cwd) {
  if (typeof cwd !== 'string' || !cwd || cwd.length > 1000 || cwd.includes('\0') || !path.isAbsolute(cwd)) return null;
  let roots = [];
  try { roots = ctx.folders() || []; } catch {}
  if (!roots.some((r) => typeof r === 'string' && r && inside(cwd, r))) return null;
  try { if (!fs.statSync(cwd).isDirectory()) return null; } catch { return null; }
  return path.resolve(cwd);
}
// JSON with // and /* */ comments (outside strings) taken out
function stripComments(t) {
  let out = '', i = 0, str = false;
  while (i < t.length) {
    const c = t[i];
    if (str) { out += c; if (c === '\\') { out += t[i + 1] || ''; i += 2; continue; } if (c === '"') str = false; i++; continue; }
    if (c === '"') { str = true; out += c; i++; continue; }
    if (c === '/' && t[i + 1] === '/') { while (i < t.length && t[i] !== '\n') i++; continue; }
    if (c === '/' && t[i + 1] === '*') { const e = t.indexOf('*/', i + 2); i = e < 0 ? t.length : e + 2; continue; }
    out += c; i++;
  }
  return out;
}
// the .claude/launch.json for this folder: its own, else the nearest one above it that is still inside a listed
// folder (a worktree under <repo>\.claude\worktrees often lacks its own, as .claude is usually git-ignored)
function launchFile(cwd, roots) {
  let dir = cwd;
  for (let i = 0; i < 8; i++) {
    const f = path.join(dir, '.claude', 'launch.json');
    if (fs.existsSync(f)) return f;
    const up = path.dirname(dir);
    if (up === dir || !roots.some((r) => typeof r === 'string' && r && inside(up, r))) return null;
    dir = up;
  }
  return null;
}
// the folder's launch configurations: [{ name, exe, args, port, url, dir, env }] (invalid ones left out); they
// always run in this folder (a cwd in one is taken from here, and must stay inside it)
function readLaunch(ctx, cwd, ownPort) {
  let roots = [];
  try { roots = ctx.folders() || []; } catch {}
  const file = launchFile(cwd, roots);
  let t, j;
  try { t = stripComments(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return []; }
  try { j = JSON.parse(t); } catch { try { j = JSON.parse(t.replace(/,(\s*[}\]])/g, '$1')); } catch { return []; } } // trailing commas
  const out = [];
  for (const c of (j && Array.isArray(j.configurations) ? j.configurations : [])) {
    if (!c || typeof c.name !== 'string' || !c.name.trim() || typeof c.runtimeExecutable !== 'string' || !c.runtimeExecutable.trim()) continue;
    const args = Array.isArray(c.runtimeArgs) ? c.runtimeArgs.filter((a) => typeof a === 'string' || typeof a === 'number').map(String) : [];
    const port = Number.isInteger(c.port) && c.port > 0 && c.port < 65536 ? c.port : null;
    const given = localUrl(typeof c.url === 'string' ? c.url : '', ownPort);
    const url = given ? given.href : port && port !== FV_PORT && port !== ownPort ? `http://localhost:${port}/` : null;
    let dir = cwd;
    if (typeof c.cwd === 'string' && c.cwd.trim()) {
      const d = path.resolve(cwd, c.cwd.replace(/\$\{workspaceFolder\}/g, cwd));
      if (!inside(d, cwd)) continue;
      dir = d;
    }
    const env = {};
    if (c.env && typeof c.env === 'object') for (const [k, v] of Object.entries(c.env)) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && (typeof v === 'string' || typeof v === 'number')) env[k] = String(v);
    out.push({ name: c.name.trim().slice(0, 100), exe: c.runtimeExecutable.trim(), args, port: given ? Number(given.port) : port, url, dir, env });
  }
  return out;
}

// ---------- the processes started here ----------
const procs = new Map(); // key -> { pid, cwd, name, url, marker, startedAt, log, child? }
const keyOf = (cwd, name) => `${norm(cwd)}|${name}`;
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); } }
function saveProcs() {
  const list = [...procs.values()].map(({ child, ...e }) => e);
  try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(`${PROCS_FILE}.tmp`, JSON.stringify(list, null, 1)); fs.renameSync(`${PROCS_FILE}.tmp`, PROCS_FILE); } catch {}
}
(function loadProcs() {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(PROCS_FILE, 'utf8')); } catch {}
  for (const e of Array.isArray(list) ? list : []) {
    if (e && Number.isInteger(e.pid) && typeof e.cwd === 'string' && typeof e.name === 'string' && typeof e.marker === 'string' && alive(e.pid)) procs.set(keyOf(e.cwd, e.name), e);
  }
})();
function running(k) {
  const e = procs.get(k);
  if (!e) return null;
  if (e.child ? e.child.exitCode === null && e.child.signalCode === null : alive(e.pid)) return e;
  procs.delete(k);
  saveProcs();
  return null;
}
// still the process this server (or an earlier one) started? Its own child surely; one from before a restart only
// when that pid's command line is still the one it was started with
function ours(e) {
  if (e.child) return Promise.resolve(e.child.exitCode === null);
  if (!WIN) return Promise.resolve(alive(e.pid));
  return new Promise((resolve) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `(Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(e.pid)}').CommandLine`], { windowsHide: true, timeout: 10000 },
  (err, out) => resolve(!err && String(out).includes(e.marker))));
}
// cmd.exe can't carry these inside its quotes; the rest (& | < > ^ and spaces) stay literal there
const UNSAFE = /["%\r\n\0]/;
const quoteArg = (a) => `"${a.replace(/(\\+)$/, '$1$1')}"`;

// On Windows the server can't start the dev server's cmd itself: a detached console program gets no console, and
// the first console program it starts then opens a new, visible one (a Windows Terminal window). A non-detached
// child would end with the server (Node keeps them in a job that closes with it). So a detached node runs this
// helper, which starts cmd with a hidden console (windowsHide, no inherited handles) and lives as long as it does;
// the dev server inherits that console. Stopping the helper's tree (taskkill /T) ends them all.
// argv: <cmd.exe> <the /c argument, base64> <marker>
const HELPER = "const{spawn}=require('child_process');const a=process.argv.slice(1);"
  + "const c=spawn(a[0],['/d','/v:off','/s','/c',Buffer.from(a[1],'base64').toString('utf8')],{windowsHide:true,stdio:'ignore',windowsVerbatimArguments:true});"
  + "c.on('exit',(n)=>process.exit(n||0));c.on('error',()=>process.exit(1));";

function startConfig(cwd, cfg) {
  const k = keyOf(cwd, cfg.name);
  const parts = [cfg.exe, ...cfg.args];
  if (parts.some((a) => UNSAFE.test(a))) return { ok: false, message: 'launch.json: a quote, % or line break in runtimeExecutable or runtimeArgs can\'t be passed on safely' };
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
  const log = path.join(LOG_DIR, `${crypto.createHash('sha1').update(k).digest('hex').slice(0, 12)}.log`);
  try { fs.appendFileSync(log, `\n----- ${new Date().toISOString()} start "${cfg.name}" in ${cfg.dir}: ${parts.join(' ')}\n`); } catch {}
  const env = { ...process.env, ...(cfg.port && !cfg.env.PORT ? { PORT: String(cfg.port) } : {}), ...cfg.env };
  delete env.ELECTRON_RUN_AS_NODE; // the helper gets it back below when the server itself runs as Electron's node
  const marker = `fv-preview-${crypto.randomUUID()}`;
  let child;
  try {
    if (WIN) {
      if (UNSAFE.test(log)) return { ok: false, message: 'the log folder\'s path can\'t be passed to cmd' };
      const comspec = process.env.ComSpec || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
      // cmd /s /c "…": the outer quotes go, each argument stays quoted, the output goes to the log
      const line = `"${parts.map(quoteArg).join(' ')} >>${quoteArg(log)} 2>&1"`;
      const helperEnv = { ...env, ...(process.env.ELECTRON_RUN_AS_NODE ? { ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE } : {}) };
      child = spawn(process.execPath, ['-e', HELPER, comspec, Buffer.from(line, 'utf8').toString('base64'), marker],
        { cwd: cfg.dir, env: helperEnv, detached: true, windowsHide: true, stdio: 'ignore' });
    } else {
      const fd = fs.openSync(log, 'a');
      try { child = spawn(cfg.exe, [...cfg.args], { cwd: cfg.dir, env: { ...env, FV_PREVIEW: marker }, detached: true, stdio: ['ignore', fd, fd] }); } finally { fs.closeSync(fd); }
    }
  } catch (e) { return { ok: false, message: `could not start it: ${e.message}` }; }
  if (!child.pid) return { ok: false, message: `could not start ${cfg.exe}` };
  const entry = { pid: child.pid, cwd: norm(cwd), name: cfg.name, url: cfg.url, marker, startedAt: Date.now(), log, child };
  const gone = () => { if (procs.get(k) === entry) { procs.delete(k); saveProcs(); } };
  child.on('exit', gone);
  child.on('error', gone);
  child.unref();
  procs.set(k, entry);
  saveProcs();
  return { ok: true, url: cfg.url, log };
}

function killTree(pid) {
  return new Promise((resolve) => {
    if (!WIN) { try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch {} } return resolve(true); }
    execFile('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, timeout: 15000 }, (err) => resolve(!err || !alive(pid)));
  });
}

// ---------- requests ----------
async function urls(u, ctx, ownPort) {
  const id = u.searchParams.get('id') || '';
  const cwdRaw = u.searchParams.get('cwd') || '';
  const cwd = cwdRaw ? folderOk(ctx, cwdRaw) : null;
  const found = id && id.length <= 100 ? (() => { const f = findLog(id, cwd || cwdRaw, ctx); return f ? scanLog(f, ownPort) : []; })() : [];
  const launch = cwd ? readLaunch(ctx, cwd, ownPort) : [];
  const upOf = (url) => { if (!url) return Promise.resolve(false); const x = new URL(url); return tcpUp(x.hostname, Number(x.port)); };
  const [ups, lups] = await Promise.all([Promise.all(found.map((f) => upOf(f.url))), Promise.all(launch.map((c) => upOf(c.url)))]);
  const out = found.map((f, i) => ({ ...f, up: ups[i] }));
  launch.forEach((c, i) => out.push({ name: c.name, port: c.port, url: c.url, from: 'launch.json', launch: true, running: !!running(keyOf(cwd, c.name)), up: lups[i] }));
  const reply = { urls: out };
  const cur = localUrl(u.searchParams.get('current') || '', ownPort);
  if (cur) {
    reply.current = { url: cur.href, up: await tcpUp(cur.hostname, Number(cur.port)) };
    if (u.searchParams.get('frame') === '1' && reply.current.up) reply.current.frame = (await frameCheck(cur)).frame;
  }
  return reply;
}

async function start(ctx, b, ownPort) {
  const cwd = b && folderOk(ctx, b.cwd);
  if (!cwd) return [403, { ok: false, message: 'that folder is not one Fleet View lists' }];
  const cfg = readLaunch(ctx, cwd, ownPort).find((c) => c.name === (b && b.name));
  if (!cfg) return [404, { ok: false, message: `no configuration named "${String(b && b.name || '')}" in .claude/launch.json` }];
  const k = keyOf(cwd, cfg.name);
  const have = running(k);
  if (have && await ours(have)) return [200, { ok: true, url: cfg.url, already: true }];
  if (have) { procs.delete(k); saveProcs(); }
  const x = cfg.url ? new URL(cfg.url) : null;
  if (x && await tcpUp(x.hostname, Number(x.port))) return [200, { ok: true, url: cfg.url, already: true, message: `something already answers on port ${x.port}` }];
  const r = startConfig(cwd, cfg);
  if (r.ok) { upCache.clear(); ctx.log(`preview: started "${cfg.name}" in ${cfg.dir} (pid ${procs.get(k).pid})`); }
  return [r.ok ? 200 : 500, r];
}

async function stop(ctx, b) {
  const cwd = b && folderOk(ctx, b.cwd);
  if (!cwd) return [403, { ok: false, message: 'that folder is not one Fleet View lists' }];
  const k = keyOf(cwd, String(b.name || ''));
  const e = running(k);
  if (!e) return [200, { ok: true, message: 'it is not running' }];
  if (!(await ours(e))) { procs.delete(k); saveProcs(); return [200, { ok: true, message: 'it had already stopped' }]; }
  const done = await killTree(e.pid);
  if (procs.get(k) === e) procs.delete(k);
  saveProcs();
  upCache.clear();
  ctx.log(`preview: stopped "${e.name}" (pid ${e.pid})${done ? '' : ', taskkill failed'}`);
  return [done ? 200 : 500, done ? { ok: true } : { ok: false, message: 'could not stop it' }];
}

function handle(req, res, pathname, ctx) {
  // only Fleet View's own page: the previewed dev page runs in the same browser and could otherwise post here
  const origin = req.headers.origin;
  if (origin && origin !== `http://${String(req.headers.host || '').toLowerCase()}`) return ctx.sendJson(res, 403, { ok: false, message: 'bad origin' });
  const ownPort = req.socket && req.socket.localPort;
  const fail = (e) => { ctx.log(`preview: ${pathname} failed: ${e && e.stack || e}`); if (!res.headersSent) ctx.sendJson(res, 500, { ok: false, message: 'server error' }); };
  if (pathname === '/preview/urls' && req.method === 'GET') {
    return urls(new URL(req.url, 'http://x'), ctx, ownPort).then((r) => ctx.sendJson(res, 200, r), fail);
  }
  if ((pathname === '/preview/start' || pathname === '/preview/stop') && req.method === 'POST') {
    return ctx.readBody(req, res, (b) => {
      if (!b || typeof b !== 'object') return ctx.sendJson(res, 400, { ok: false, message: 'bad json' });
      (pathname === '/preview/start' ? start(ctx, b, ownPort) : stop(ctx, b)).then(([code, out]) => ctx.sendJson(res, code, out), fail);
    });
  }
  return ctx.sendJson(res, 404, { ok: false, message: 'not found' });
}

module.exports = { handle, _test: { localUrl, scanLines, framable, stripComments, readLaunch, inside, quoteArg } };
