// Fleet View: the Preview tab's server side (web/preview.js shows it): which local dev servers a conversation has
// used, whether they answer, and starting and stopping the ones its folder's .claude/launch.json describes.
// fleet-view.js hands every /preview… request here (handle), with ctx = { sendJson, readBody, folders, log } and,
// when it offers them, ctx.find(id) -> { file } (the conversation's transcript, as the Chat tab finds it),
// ctx.remote(req) -> null for this PC's own page, else { name, login, device } (an approved browser on another
// device, remote.js), and ctx.tailnet (remote.js's instance: whoAt, servePort, unservePort; see "From another
// device" below).
//
//   GET  /preview/urls?id=<conversation>&cwd=<folder>[&current=<url>][&frame=1]
//        -> { urls: [...], current?, remote? }
//        urls, newest first: the addresses found in the transcript, { url, from: 'transcript', at, up }, then the
//        launch.json configurations, { name, port, url, from: 'launch.json', launch: true, running, up }.
//        current (when asked): { url, up, frame?, share? }; frame=1 also fetches that page's headers and says
//        whether it lets another page show it in a frame (X-Frame-Options, CSP frame-ancestors): the Edge window
//        needs it, the desktop window strips those headers for previews itself (desktop/main.js).
//        remote: true when the asking page is a browser on another device. Then current.share is how that browser
//        reaches the page: { ok: true, url: 'https://<pc>.<tailnet>.ts.net:<port>/<path>', gen } (gen changes when
//        the share was made again, so the frame loads it again), or { ok: false, message }.
//   POST /preview/start { cwd, name } -> { ok, url, already?, message? }   starts that launch.json configuration
//   POST /preview/stop  { cwd, name } -> { ok, message? }                  stops it, with its whole process tree
//   POST /preview/shot  { id, cwd, url, width, height, scale? } -> image/png, or JSON { ok: false, message }
//        a screenshot of that page taken on this PC by headless Edge, for a browser that can't capture the frame
//        itself (anything but the desktop window); see "Screenshots" below
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
// any other page (an Origin that isn't this server's own, such as the previewed dev page itself) is refused; for a
// remote browser its own is https://<this PC's tailnet name>.
//
// From another device (Henry's Mac over Tailscale). There, http://localhost:<port> is the Mac's own localhost, so
// the dev server has to be reached through the PC. How, and why this way:
//   - A path-prefix proxy on Fleet View's own address (https://<pc>/preview-proxy/5173/…) breaks most dev servers:
//     their pages load /@vite/client, /_next/static/…, /assets/… from the root and open their HMR WebSocket there.
//   - `tailscale serve --https=<port>` straight at the dev server keeps the paths, but (measured 2026-10-10) Vite
//     8 answers 403 "Blocked request. This host ("<pc>.ts.net") is not allowed" (server.allowedHosts, every Vite
//     since 5.4.12), and Next 16 refuses /_next/* and its HMR socket from an Origin that isn't localhost
//     (allowedDevOrigins); any device on the tailnet could open it with no approval at all; the browser would send
//     it Fleet View's fv_device cookie (cookies don't care about the port); and X-Frame-Options would still keep
//     it out of the frame.
//   - So: `tailscale serve --bg --https=<the dev server's port>` points at a small proxy here on 127.0.0.1 (one
//     listener for every shared port; tailscaled keeps the Host, so <pc>:<port> says which dev server). Each request
//     and WebSocket is let through only for an approved device (ctx.tailnet.whoAt: the owner's Tailscale login and
//     the fv_device cookie, as for the page itself; an open WebSocket is asked again every RECHECK_MS), and is
//     passed on as the PC's own browser would send it: Host localhost:<port>, an Origin or Referer of the shared
//     address turned back into http://localhost:<port>, Fleet View's cookies and tailscaled's Tailscale-* and
//     X-Forwarded-* headers taken out. On the way back X-Frame-Options and CSP frame-ancestors go (as the desktop
//     window drops them) and frame-ancestors 'self' https://<pc> is set instead, so only Fleet View's page (and
//     the dev page itself) may frame it; a Location back to localhost:<port> becomes the shared address; a
//     Set-Cookie for Fleet View's own cookie names is dropped and Domain=localhost taken off. Bodies pass as they
//     are: a page that writes http://localhost:<port> into its own HTML or JS (rare: Vite and Next build HMR's
//     address from the page's location) still points at the Mac's localhost there.
//   - Only a port the Preview tab lists for that conversation (transcript or launch.json, so never Fleet View's own,
//     never 443 or below 1024) is shared, only when an approved remote browser's poll names it as the page it
//     shows, and only while it answers. A share nobody used (no poll naming it, no request through it) for
//     SHARE_IDLE_MS is turned off, as is one whose launch.json configuration Stop ended; remote.js turns them all
//     off when remote access is switched off, and on the next start any a stopped server left (its record in
//     %LOCALAPPDATA%\fleet-view\preview-serve.json). Ports another tailscale serve entry uses are never taken.
//   Cross-site: the dev page at https://<pc>:<port> is another origin than Fleet View's https://<pc> but the same
//   site, so remote.js's check that refuses same-site requests keeps it from Fleet View's routes and /live. It can
//   still set cookies on <pc> (not HttpOnly ones it didn't make, and not through this proxy under Fleet View's
//   names); that dev code already runs on this PC anyway.
//
// Screenshots. The desktop window captures the frame's area itself (fleetDesktop.capture). Any other browser can't
// read a cross-origin frame's pixels (getDisplayMedia could, but asks every time and shares a whole tab), so
// POST /preview/shot loads the same address in headless Edge on this PC at the frame's size and returns the PNG
// (one at a time, SHOT_MS at most, SHOT_MAX bytes, a fresh profile in a temp folder that is removed after). It
// shows the page as a fresh load: signed out, scrolled to the top. A remote browser may only ask for a port its
// conversation lists, as for sharing.
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
const P = require(path.join(__dirname, 'platform.js'));
const WIN = P.isWin;
const DATA = P.dataDir();
const PROCS_FILE = path.join(DATA, 'preview-procs.json');
const LOG_DIR = path.join(DATA, 'preview-logs');
const SHARE_IDLE_MS = 10 * 60e3; // a share nobody used for this long is turned off
const SWEEP_MS = 30e3;
const RECHECK_MS = 5000; // an open WebSocket through a share: its device asked again this often
const SOCKETS_MAX = 200; // open WebSockets through all shares together
const SHOT_MS = 15000; // headless Edge, start to PNG
const SHOT_MAX = 15 << 20;
const SHOT_VT_MS = 4000; // Edge's virtual time for the page's scripts, before it takes the picture
const FV_COOKIES = new Set(['__Host-fv_device', 'fv_pair', 'fv_device']); // remote.js's; never passed to a dev server, never set by one

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
  const out = [path.join(os.homedir(), '.claude', 'projects')];
  try { for (const e of fs.readdirSync(os.homedir())) if (/^\.claude-[a-z]$/i.test(e)) out.push(path.join(os.homedir(), e, 'projects')); } catch {}
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
const norm = (p) => { const r = path.resolve(p).replace(/[\\/]+$/, '') || path.resolve(p); return P.foldCase(r); };
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
// (macOS: the marker is in its environment, which `ps -E` shows; Linux: /proc/<pid>/environ)
function ours(e) {
  if (e.child) return Promise.resolve(e.child.exitCode === null);
  if (!WIN && !P.isMac) {
    try { return Promise.resolve(fs.readFileSync(`/proc/${Number(e.pid)}/environ`, 'utf8').includes(e.marker)); } catch { return Promise.resolve(alive(e.pid)); }
  }
  if (P.isMac) {
    return new Promise((resolve) => execFile('ps', ['-E', '-ww', '-o', 'command=', '-p', String(Number(e.pid))], { timeout: 10000, maxBuffer: 4 << 20 },
      (err, out) => resolve(!err && String(out).includes(e.marker))));
  }
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
      // macOS and Linux: started straight, in a process group of its own (detached), with the login shell's PATH
      // (npm, node and the rest; an app started from Finder has a bare one)
      const fd = fs.openSync(log, 'a');
      try { child = spawn(cfg.exe, [...cfg.args], { cwd: cfg.dir, env: { ...env, PATH: P.loginShellPath(), FV_PREVIEW: marker }, detached: true, stdio: ['ignore', fd, fd] }); } finally { fs.closeSync(fd); }
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
    if (!WIN) { P.killTree(pid); return resolve(true); }
    execFile('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, timeout: 15000 }, (err) => resolve(!err || !alive(pid)));
  });
}

// ---------- sharing a dev server with another device (see "From another device" at the top) ----------
let gate = null; // ctx.tailnet (remote.js), from the first request that brings it
const shares = new Map(); // dev port -> { port, host, url, gen, lastUsed, sockets: Set, making? }
let shareGen = 0;
let proxy = null; // { server, port: Promise<number> }
let sweeper = null;

// the one proxy listener every share points at; its port
function proxyPort() {
  if (proxy) return proxy.port;
  const server = http.createServer(proxyRequest);
  server.on('upgrade', proxyUpgrade);
  server.on('clientError', (e, sock) => { try { sock.destroy(); } catch {} });
  server.headersTimeout = 30e3;
  server.requestTimeout = 0; // a dev server's event stream may stay open
  const port = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  proxy = { server, port };
  port.catch(() => { proxy = null; });
  return port;
}
const portOfHost = (host) => { const m = /:(\d{2,5})$/.exec(String(host || '')); return m ? Number(m[1]) : 0; };
// the share a request through the proxy is for, when its device may use it: { sh, who } or null
function admit(req) {
  const p = portOfHost(req.headers.host);
  const sh = shares.get(p);
  if (!sh || sh.making || !gate) return null;
  // another site's page never uses a share with the device's cookie: only the shared page's own requests, and a
  // navigation into it (the Preview frame on Fleet View's page is same-site)
  const site = req.headers['sec-fetch-site'], mode = req.headers['sec-fetch-mode'];
  if (site === 'cross-site' || (site === 'same-site' && mode !== 'navigate' && mode !== 'nested-navigate')) return null;
  const who = gate.whoAt(req, p);
  if (!who) return null;
  return { sh, who };
}
const localOrigin = (sh) => `http://${sh.host}:${sh.port}`;
// a Cookie header without Fleet View's own cookies
function dropOurCookies(v) {
  const kept = String(v || '').split(';').map((x) => x.trim()).filter((x) => x && !FV_COOKIES.has(x.split('=')[0].trim()));
  return kept.length ? kept.join('; ') : null;
}
// the request's headers as the PC's own browser would send them to the dev server (see the top). upgrade: keep the
// WebSocket's Connection and Upgrade
function forwardHeaders(h, sh, who, upgrade) {
  const remoteOrigin = `https://${who.name}:${sh.port}`;
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    if (/^(tailscale-|x-forwarded-)/.test(k) || k === 'forwarded' || k === 'host' || k === 'proxy-connection' || k === 'keep-alive' || k === 'te' || k === 'trailer' || k === 'transfer-encoding') continue;
    if (!upgrade && (k === 'connection' || k === 'upgrade')) continue;
    out[k] = v;
  }
  out.host = `${sh.host}:${sh.port}`;
  if (out.origin === remoteOrigin) out.origin = localOrigin(sh);
  if (typeof out.referer === 'string' && (out.referer === remoteOrigin || out.referer.startsWith(remoteOrigin + '/'))) out.referer = localOrigin(sh) + out.referer.slice(remoteOrigin.length);
  if (out.cookie !== undefined) { const c = dropOurCookies(out.cookie); if (c) out.cookie = c; else delete out.cookie; }
  return out;
}
// the dev server's answer headers, for the remote browser (see the top); raw: [name, value, name, value, …]
function backHeaders(raw, sh, who) {
  const remoteOrigin = `https://${who.name}:${sh.port}`;
  const local = new RegExp(`^https?://(localhost|127\\.0\\.0\\.1|\\[::1\\]):${sh.port}(?=/|$)`, 'i');
  const out = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i], k = name.toLowerCase();
    let v = raw[i + 1];
    if (k === 'x-frame-options' || k === 'strict-transport-security' || k === 'connection' || k === 'keep-alive' || k === 'transfer-encoding' || k === 'proxy-connection') continue;
    if (k === 'content-security-policy') {
      v = v.split(';').filter((d) => !/^\s*frame-ancestors(\s|$)/i.test(d)).join(';').trim();
      if (!v.replace(/;/g, '').trim()) continue;
    } else if (k === 'location' || k === 'content-location' || k === 'access-control-allow-origin') {
      v = v.replace(local, remoteOrigin);
    } else if (k === 'set-cookie') {
      if (FV_COOKIES.has(v.split('=')[0].trim())) continue;
      v = v.replace(/;\s*domain=\.?(localhost|127\.0\.0\.1|\[::1\])\s*(?=;|$)/ig, '');
    }
    out.push(name, v);
  }
  out.push('Content-Security-Policy', `frame-ancestors 'self' https://${who.name}`);
  return out;
}
function proxyRequest(req, res) {
  const a = admit(req);
  if (!a) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    return res.end('Fleet View: this preview is for the browsers approved on the PC, while the Preview tab shows it.\n');
  }
  const { sh, who } = a;
  sh.lastUsed = Date.now();
  const up = http.request({ host: connectHost(sh.host), port: sh.port, method: req.method, path: req.url, headers: forwardHeaders(req.headers, sh, who, false), autoSelectFamily: true });
  up.on('response', (r) => {
    res.writeHead(r.statusCode, r.statusMessage, backHeaders(r.rawHeaders, sh, who));
    r.pipe(res);
    res.on('close', () => r.destroy());
  });
  up.on('error', () => {
    if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(`Fleet View: nothing answers at ${sh.host}:${sh.port} on the PC right now.\n`); }
    else res.destroy();
  });
  res.on('close', () => { if (!res.writableFinished) up.destroy(); }); // the browser went away mid-answer
  req.pipe(up);
}
// a WebSocket (a dev server's HMR): checked like a request, and only from the shared page itself (its Origin). The
// dev server's answer is read before anything is joined: only a 101 joins the two sockets (its headers filtered as
// any answer's, so it sets no Fleet View cookie); any other answer goes back with the connection closed, so a refused
// upgrade never leaves a plain pipe to the dev server open for tailscaled's next request (another device's, ungated).
// Its device is asked again every RECHECK_MS while it stays open.
function proxyUpgrade(req, sock, head) {
  const a = admit(req);
  const total = [...shares.values()].reduce((n, s) => n + s.sockets.size, 0);
  const own = !!a && req.headers.origin === `https://${a.who.name}:${a.sh.port}`;
  if (!own || total >= SOCKETS_MAX) { try { sock.end(`HTTP/1.1 ${own ? '503 Service Unavailable' : '403 Forbidden'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch {} return; }
  const { sh, who } = a;
  sh.lastUsed = Date.now();
  const up = http.request({ host: connectHost(sh.host), port: sh.port, method: req.method, path: req.url, headers: forwardHeaders(req.headers, sh, who, true), agent: false, autoSelectFamily: true });
  const pair = { sock, up, req }; // up: the request, then the dev server's socket once it switched
  let ended = false;
  const end = () => { if (ended) return; ended = true; sh.sockets.delete(pair); sock.destroy(); pair.up.destroy(); up.destroy(); };
  // not switched: this answer, then the connection closes (sock.end lets the answer out first)
  const refuse = (status) => {
    if (ended) return;
    ended = true;
    sh.sockets.delete(pair);
    up.destroy();
    try { sock.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { sock.destroy(); }
  };
  sh.sockets.add(pair);
  sock.on('error', end);
  sock.on('close', end);
  up.on('response', (r) => { r.resume(); refuse(`${r.statusCode} ${String(r.statusMessage || '').replace(/[\r\n]/g, '')}`); });
  up.on('upgrade', (r, upSock, upHead) => {
    pair.up = upSock;
    if (ended) return void upSock.destroy();
    const h = backHeaders(r.rawHeaders, sh, who);
    let text = 'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\n';
    for (let i = 0; i + 1 < h.length; i += 2) text += `${h[i]}: ${h[i + 1]}\r\n`;
    sock.write(text + '\r\n');
    if (upHead && upHead.length) sock.write(upHead);
    if (head && head.length) upSock.write(head);
    upSock.on('error', end);
    upSock.on('close', end);
    upSock.pipe(sock);
    sock.pipe(upSock);
  });
  up.on('error', () => { if (pair.up === up) refuse('502 Bad Gateway'); else end(); });
  up.end();
}
// every RECHECK_MS: open WebSockets whose device may no longer use Fleet View close; every SWEEP_MS: idle shares go
function startSweeper(ctx) {
  if (sweeper) return;
  let n = 0;
  sweeper = setInterval(() => {
    for (const sh of shares.values()) for (const pair of [...sh.sockets]) if (!gate || !gate.whoAt(pair.req, sh.port)) { pair.sock.destroy(); pair.up.destroy(); sh.sockets.delete(pair); }
    if (++n % Math.round(SWEEP_MS / RECHECK_MS)) return;
    for (const sh of [...shares.values()]) if (!sh.making && Date.now() - sh.lastUsed > SHARE_IDLE_MS) unshare(ctx, sh.port, 'not used for 10 minutes');
  }, RECHECK_MS);
  if (sweeper.unref) sweeper.unref();
}
// share this local dev page (a URL) with the remote browser asking: { ok, url, gen } or { ok: false, message }
async function share(ctx, cur, rem) {
  if (!gate) return { ok: false, message: 'this Fleet View server can\'t share previews with other devices' };
  const p = Number(cur.port);
  let sh = shares.get(p);
  if (sh && sh.making) await sh.making;
  sh = shares.get(p);
  // gone on the tailscale side meanwhile (remote access was switched off and on): made again
  if (sh && !gate.servedPorts().includes(p)) { unshare(ctx, p, 'tailscale serve no longer has it'); sh = null; }
  if (!sh) {
    sh = { port: p, host: cur.hostname, url: null, gen: 0, lastUsed: Date.now(), sockets: new Set(), making: null };
    shares.set(p, sh);
    sh.making = (async () => {
      let target;
      try { target = `http://127.0.0.1:${await proxyPort()}`; } catch (e) { return { ok: false, message: `could not start the preview proxy: ${e.message}` }; }
      return gate.servePort(p, target);
    })();
    const r = await sh.making;
    sh.making = null;
    if (!r.ok) { shares.delete(p); return { ok: false, message: r.message }; }
    sh.url = r.url;
    sh.gen = ++shareGen;
    startSweeper(ctx);
    ctx.log(`preview: ${cur.host} shared at ${r.url} for ${rem.device} (${rem.login})`);
  }
  sh.host = cur.hostname; // the address the conversation uses for it (localhost, 127.0.0.1, [::1])
  sh.lastUsed = Date.now();
  return { ok: true, url: `${sh.url}${cur.pathname}${cur.search}`, gen: sh.gen };
}
function unshare(ctx, p, why) {
  const sh = shares.get(p);
  if (!sh || sh.making) return;
  shares.delete(p);
  for (const pair of sh.sockets) { pair.sock.destroy(); pair.up.destroy(); }
  if (gate) gate.unservePort(p);
  ctx.log(`preview: stopped sharing port ${p} (${why})`);
}

// ---------- screenshots on this PC (see "Screenshots" at the top) ----------
// (macOS: Chrome or Edge from /Applications; Linux: google-chrome, chromium or microsoft-edge on PATH)
function edgeExe() {
  if (P.isMac) return ['Google Chrome', 'Microsoft Edge'].map((a) => `/Applications/${a}.app/Contents/MacOS/${a}`).find((f) => fs.existsSync(f)) || null;
  if (!WIN) return ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge'].map((n) => P.which(n)).find(Boolean) || null;
  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  for (const r of roots) { const f = path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'); if (fs.existsSync(f)) return f; }
  return null;
}
let shooting = false;
// -> { ok: true, png } or { ok: false, code, message }
function shoot(url, width, height, scale) {
  const exe = edgeExe();
  if (!exe) return Promise.resolve({ ok: false, code: 501, message: WIN ? 'Microsoft Edge was not found on the PC, so it can\'t take the screenshot' : 'neither Chrome nor Edge was found here, so it can\'t take the screenshot' });
  if (shooting) return Promise.resolve({ ok: false, code: 429, message: 'a screenshot is being taken; try again in a moment' });
  shooting = true;
  let dir;
  try { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-shot-')); } catch (e) { shooting = false; return Promise.resolve({ ok: false, code: 500, message: `no temp folder: ${e.message}` }); }
  const out = path.join(dir, 'shot.png');
  const args = ['--headless', '--disable-gpu', '--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-sync', '--disable-background-networking', '--disable-component-update', '--disable-features=msEdgeFRE',
    `--user-data-dir=${path.join(dir, 'profile')}`, `--window-size=${width},${height}`, `--force-device-scale-factor=${scale}`,
    `--virtual-time-budget=${SHOT_VT_MS}`, `--screenshot=${out}`, url];
  return new Promise((resolve) => {
    let done = false, child = null;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      shooting = false;
      // Edge may still hold its profile for a moment after it exits
      fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 }, () => {});
      resolve(r);
    };
    const timer = setTimeout(() => {
      if (child && child.pid) killTree(child.pid);
      finish({ ok: false, code: 504, message: `Edge took longer than ${SHOT_MS / 1000} s` });
    }, SHOT_MS);
    try {
      child = execFile(exe, args, { windowsHide: true, maxBuffer: 1 << 20 }, () => {
        let st = null;
        try { st = fs.statSync(out); } catch {}
        if (!st || !st.size) return finish({ ok: false, code: 502, message: 'Edge did not write a screenshot' });
        if (st.size > SHOT_MAX) return finish({ ok: false, code: 413, message: 'the screenshot is too large' });
        let png;
        try { png = fs.readFileSync(out); } catch (e) { return finish({ ok: false, code: 500, message: e.message }); }
        finish({ ok: true, png });
      });
    } catch (e) { finish({ ok: false, code: 500, message: `could not start Edge: ${e.message}` }); }
  });
}
// a whole number in [lo, hi], else d
const clampInt = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

// ---------- requests ----------
// the ports a conversation's Preview tab lists (transcript and launch.json), with their urls entries
function listed(u, ctx, ownPort) {
  const id = u.get('id') || '';
  const cwdRaw = u.get('cwd') || '';
  const cwd = cwdRaw ? folderOk(ctx, cwdRaw) : null;
  const found = id && id.length <= 100 ? (() => { const f = findLog(id, cwd || cwdRaw, ctx); return f ? scanLog(f, ownPort) : []; })() : [];
  const launch = cwd ? readLaunch(ctx, cwd, ownPort) : [];
  const ports = new Set();
  for (const x of [...found, ...launch]) { if (x.url) { const p = Number(new URL(x.url).port); if (p) ports.add(p); } }
  return { cwd, found, launch, ports };
}
async function urls(u, ctx, ownPort, rem) {
  const { cwd, found, launch, ports } = listed(u.searchParams, ctx, ownPort);
  const upOf = (url) => { if (!url) return Promise.resolve(false); const x = new URL(url); return tcpUp(x.hostname, Number(x.port)); };
  const [ups, lups] = await Promise.all([Promise.all(found.map((f) => upOf(f.url))), Promise.all(launch.map((c) => upOf(c.url)))]);
  const out = found.map((f, i) => ({ ...f, up: ups[i] }));
  launch.forEach((c, i) => out.push({ name: c.name, port: c.port, url: c.url, from: 'launch.json', launch: true, running: !!running(keyOf(cwd, c.name)), up: lups[i] }));
  const reply = { urls: out };
  if (rem) reply.remote = true;
  const cur = localUrl(u.searchParams.get('current') || '', ownPort);
  if (cur) {
    reply.current = { url: cur.href, up: await tcpUp(cur.hostname, Number(cur.port)) };
    if (rem) {
      // another device: shown through a share (which drops the framing headers), only for a port listed here
      if (!ports.has(Number(cur.port))) reply.current.share = { ok: false, message: 'Only the dev servers this conversation used (or its launch.json lists) can be shown on another device.' };
      else if (reply.current.up) { reply.current.share = await share(ctx, cur, rem); reply.current.frame = true; }
      else reply.current.share = { ok: false, message: '' };
    } else if (u.searchParams.get('frame') === '1' && reply.current.up) reply.current.frame = (await frameCheck(cur)).frame;
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
  // shared with another device: that goes too
  const port = e.url ? Number(new URL(e.url).port) : 0;
  if (port && shares.has(port)) unshare(ctx, port, `"${e.name}" was stopped`);
  ctx.log(`preview: stopped "${e.name}" (pid ${e.pid})${done ? '' : ', taskkill failed'}`);
  return [done ? 200 : 500, done ? { ok: true } : { ok: false, message: 'could not stop it' }];
}

// POST /preview/shot: [code, png] or [code, { ok: false, message }]
async function shot(ctx, b, ownPort, rem) {
  const u = localUrl(b && b.url, ownPort);
  if (!u) return [400, { ok: false, message: 'only a local dev server\'s page can be taken' }];
  if (rem) {
    const q = new URLSearchParams({ id: typeof b.id === 'string' ? b.id : '', cwd: typeof b.cwd === 'string' ? b.cwd : '' });
    if (!listed(q, ctx, ownPort).ports.has(Number(u.port))) return [403, { ok: false, message: 'only a dev server this conversation used can be taken from another device' }];
  }
  if (!(await tcpUp(u.hostname, Number(u.port)))) return [409, { ok: false, message: `nothing answers at ${u.host} right now` }];
  const scale = Math.min(2, Math.max(1, Math.round((Number(b.scale) || 1) * 4) / 4));
  const r = await shoot(u.href, clampInt(b.width, 200, 2560, 1280), clampInt(b.height, 150, 1600, 800), scale);
  if (r.ok) ctx.log(`preview: screenshot of ${u.host} taken (${r.png.length} bytes)${rem ? ` for ${rem.device}` : ''}`);
  return r.ok ? [200, r.png] : [r.code, { ok: false, message: r.message }];
}

function handle(req, res, pathname, ctx) {
  if (ctx.tailnet && !gate) gate = ctx.tailnet;
  // only Fleet View's own page: the previewed dev page runs in the same browser and could otherwise post here.
  // Its own address is http://<Host> here, and https://<this PC's tailnet name> for an approved remote browser
  const rem = typeof ctx.remote === 'function' ? ctx.remote(req) : null;
  const origin = req.headers.origin;
  const own = rem ? `https://${rem.name}` : `http://${String(req.headers.host || '').toLowerCase()}`;
  if (origin && origin !== own) return ctx.sendJson(res, 403, { ok: false, message: 'bad origin' });
  const ownPort = req.socket && req.socket.localPort;
  const fail = (e) => { ctx.log(`preview: ${pathname} failed: ${e && e.stack || e}`); if (!res.headersSent) ctx.sendJson(res, 500, { ok: false, message: 'server error' }); };
  if (pathname === '/preview/urls' && req.method === 'GET') {
    return urls(new URL(req.url, 'http://x'), ctx, ownPort, rem).then((r) => ctx.sendJson(res, 200, r), fail);
  }
  if ((pathname === '/preview/start' || pathname === '/preview/stop' || pathname === '/preview/shot') && req.method === 'POST') {
    return ctx.readBody(req, res, (b) => {
      if (!b || typeof b !== 'object') return ctx.sendJson(res, 400, { ok: false, message: 'bad json' });
      if (pathname === '/preview/shot') {
        return shot(ctx, b, ownPort, rem).then(([code, out]) => {
          if (!Buffer.isBuffer(out)) return ctx.sendJson(res, code, out);
          res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': out.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          res.end(out);
        }, fail);
      }
      (pathname === '/preview/start' ? start(ctx, b, ownPort) : stop(ctx, b)).then(([code, out]) => ctx.sendJson(res, code, out), fail);
    });
  }
  return ctx.sendJson(res, 404, { ok: false, message: 'not found' });
}

module.exports = { handle, _test: { localUrl, scanLines, framable, stripComments, readLaunch, inside, quoteArg, forwardHeaders, backHeaders, dropOurCookies, shares, proxyPort, share, unshare, shoot, edgeExe, setGate: (g) => { gate = g; } } };
