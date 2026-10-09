// Updates: Fleet View's folder is a git checkout (the share repo for people it was shared with). Every 30 minutes,
// and once a minute after start, it fetches its upstream and says how far behind it is; the page shows an
// "Update available" pill with what changed (the commit messages), and "Update now" pulls it in:
//   git pull --ff-only, refused when files were changed here or desktop/'s packages changed (those need
//   install.ps1: the session host holds node-pty open, so "Quit everything" first);
//   fleet-view.js, api.js and web/ reload by themselves after the pull (watchForUpdates, the page's version poll);
//   host.js or handoff.js changed: desktop\restart-host.js, which waits until no session is mid-turn and resumes them;
//   anything else in desktop/ changed: the page asks the window to restart itself (fleetDesktop.relaunch).
// With "update automatically" on (%LOCALAPPDATA%\fleet-view\update.json), an update found is put in once no
// conversation is working.
//   GET  /update          { ok, enabled, current, upstream, behind, notes[], checkedAt, error?, dirty, needsInstall, auto, busy, last? }
//   POST /update/check    fetch now, -> the same
//   POST /update/apply    -> { ok, message, from, to, relaunch, hostRestart } or { ok: false, message }
//   POST /update/auto     { on } -> the same as GET
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const DIR = __dirname;
const CHECK_MS = 30 * 60e3, FIRST_MS = 60e3, AUTO_EVERY_MS = 60e3;
const DATA = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'fleet-view');
const PREFS = path.join(DATA, 'update.json');
const HOST_FILES = /^(?:desktop\/host\.js|handoff\.js)$/;
const NEEDS_INSTALL = /^desktop\/(?:package(?:-lock)?\.json)$/;

const git = (args, ms = 60e3) => new Promise((resolve) => {
  execFile('git', ['-C', DIR, ...args], { timeout: ms, windowsHide: true, maxBuffer: 8 << 20, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
    (err, out, errOut) => resolve({ ok: !err, out: String(out || '').trim(), err: String(errOut || (err && err.message) || '').trim() }));
});

let state = { enabled: false, current: '', upstream: '', behind: 0, notes: [], checkedAt: 0, error: '', dirty: false, needsInstall: false };
let last = null; // the last update put in: { at, from, to, message }
let checking = null, applying = false, ctx = null;

function readPrefs() { try { return JSON.parse(fs.readFileSync(PREFS, 'utf8')) || {}; } catch { return {}; } }
function writePrefs(p) { try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(PREFS, JSON.stringify(p, null, 2)); } catch {} }

// what changed between HEAD and its upstream: the commit messages, newest first, at most 40 lines
async function notesFor(range) {
  const r = await git(['log', '--format=%x1e%B', range]);
  if (!r.ok) return [];
  const lines = [];
  for (const msg of r.out.split('\x1e').map((m) => m.trim()).filter(Boolean)) {
    for (const l of msg.split(/\r?\n/)) {
      const t = l.trim();
      // the trailers say nothing to the reader
      if (!t || /^(?:Co-Authored-By|Signed-off-by):/i.test(t) || /Generated with \[Claude Code\]/.test(t)) continue;
      lines.push(t);
    }
  }
  return lines.slice(0, 40);
}

function check() {
  if (checking) return checking;
  checking = (async () => {
    const at = Date.now();
    const inside = await git(['rev-parse', '--is-inside-work-tree'], 5000);
    if (!inside.ok || inside.out !== 'true') { state = { ...state, enabled: false, checkedAt: at, error: 'not a git checkout' }; return; }
    const up = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], 5000);
    if (!up.ok) { state = { ...state, enabled: false, checkedAt: at, error: 'this branch has no upstream to update from' }; return; }
    const remote = up.out.split('/')[0];
    const f = await git(['fetch', '--quiet', remote]);
    const current = (await git(['rev-parse', '--short', 'HEAD'], 5000)).out;
    const upstream = (await git(['rev-parse', '--short', '@{u}'], 5000)).out;
    const behind = +(await git(['rev-list', '--count', 'HEAD..@{u}'], 5000)).out || 0;
    const dirty = !!(await git(['status', '--porcelain', '--untracked-files=no'], 10e3)).out;
    const changed = behind ? (await git(['diff', '--name-only', 'HEAD', '@{u}'], 10e3)).out.split(/\r?\n/).filter(Boolean) : [];
    state = {
      enabled: true, current, upstream, behind, notes: behind ? await notesFor('HEAD..@{u}') : [], checkedAt: at,
      error: f.ok ? '' : `could not reach ${remote}: ${f.err.split(/\r?\n/)[0].slice(0, 200)}`,
      dirty, needsInstall: changed.some((x) => NEEDS_INSTALL.test(x)),
    };
    if (!f.ok && ctx) ctx.log(`update: fetch from ${remote} failed: ${f.err.split(/\r?\n/)[0]}`);
  })().finally(() => { checking = null; });
  return checking;
}

const busyNow = () => { try { return ctx ? ctx.busy() : 0; } catch { return 0; } };
const status = () => ({ ok: true, ...state, auto: !!readPrefs().auto, busy: busyNow(), applying, ...(last ? { last } : {}) });

async function apply() {
  if (applying) return { ok: false, message: 'an update is already going in' };
  applying = true;
  try {
    await check();
    if (!state.enabled) return { ok: false, message: `updates are off here: ${state.error}` };
    if (!state.behind) return { ok: false, message: 'already up to date' };
    if (state.dirty) return { ok: false, message: 'files in the Fleet View folder were changed here, so it was not updated (git pull would clash). Undo them, or update by hand.' };
    if (state.needsInstall) return { ok: false, message: 'this update changes the desktop window\'s packages: choose "Quit everything" from the tray icon, then run install.ps1 in the Fleet View folder' };
    const from = (await git(['rev-parse', 'HEAD'], 5000)).out;
    const pull = await git(['pull', '--ff-only', '--quiet']);
    if (!pull.ok) return { ok: false, message: `git pull failed: ${pull.err.split(/\r?\n/)[0].slice(0, 300)}` };
    const to = (await git(['rev-parse', 'HEAD'], 5000)).out;
    const changed = (await git(['diff', '--name-only', from, to], 10e3)).out.split(/\r?\n/).filter(Boolean);
    const hostRestart = changed.some((x) => HOST_FILES.test(x));
    const relaunch = changed.some((x) => /^desktop\//.test(x) && !HOST_FILES.test(x));
    if (hostRestart) {
      // detached: it outlives this server's own reload; it waits until no session is mid-turn
      try {
        const c = spawn(process.execPath, [path.join(DIR, 'desktop', 'restart-host.js')], { detached: true, stdio: 'ignore', windowsHide: true });
        c.unref();
      } catch (e) { if (ctx) ctx.log(`update: could not restart the session host: ${e.message}`); }
    }
    const message = `updated ${from.slice(0, 7)} → ${to.slice(0, 7)}${hostRestart ? '; the session host restarts once no session is mid-turn' : ''}${relaunch ? '; the window restarts' : ''}`;
    last = { at: Date.now(), from: from.slice(0, 7), to: to.slice(0, 7), message };
    if (ctx) ctx.log(`update: ${message}`);
    state = { ...state, current: to.slice(0, 7), behind: 0, notes: [] };
    return { ok: true, message, from: from.slice(0, 7), to: to.slice(0, 7), relaunch, hostRestart };
  } finally { applying = false; }
}

// once an update is found and nothing is working: put it in (only what needs no install, never over local edits)
async function autoTick() {
  if (!readPrefs().auto || applying || !state.behind || state.dirty || state.needsInstall || busyNow()) return;
  const r = await apply();
  if (!r.ok && ctx) ctx.log(`update: automatic update not done: ${r.message}`);
  // the desktop window can't be told from here; it asks on its next poll of /update (relaunchWanted). Kept on
  // disk: this server reloads itself after the pull
  if (r.ok && r.relaunch) writePrefs({ ...readPrefs(), relaunchWanted: r.to });
}

// c: { log(text), busy() -> how many conversations are working }
function start(c) {
  ctx = c;
  setTimeout(() => { check().catch(() => {}); setInterval(() => check().catch(() => {}), CHECK_MS); }, FIRST_MS);
  setInterval(() => { autoTick().catch(() => {}); }, AUTO_EVERY_MS);
}

// the page's routes (fleet-view.js has already checked the Host and Origin)
function handle(req, res, pathname, h) {
  const send = (code, o) => h.sendJson(res, code, o);
  if (pathname === '/update' && req.method === 'GET') return send(200, { ...status(), ...(readPrefs().relaunchWanted ? { relaunchWanted: readPrefs().relaunchWanted } : {}) });
  if (req.method !== 'POST') return send(405, { ok: false, message: 'POST' });
  if (pathname === '/update/check') return void check().then(() => send(200, status()), (e) => send(500, { ok: false, message: e.message }));
  if (pathname === '/update/apply') return void apply().then((r) => { send(r.ok ? 200 : 409, r); }, (e) => send(500, { ok: false, message: e.message }));
  if (pathname === '/update/relaunched') { const p = readPrefs(); delete p.relaunchWanted; writePrefs(p); return send(200, { ok: true }); }
  if (pathname === '/update/auto') {
    return h.readBody(req, res, (b) => {
      if (!b || typeof b.on !== 'boolean') return send(400, { ok: false, message: 'on must be true or false' });
      writePrefs({ ...readPrefs(), auto: b.on });
      send(200, status());
    });
  }
  return send(404, { ok: false, message: 'no such route' });
}

module.exports = { start, handle, check, apply, status };
