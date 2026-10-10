// Updates: Fleet View's folder is a git checkout (the share repo for people it was shared with). Every 30 minutes,
// and once a minute after start, it fetches its upstream and says how far behind it is; the page shows an
// "Update available" pill with what changed (the commit messages), and "Update now" pulls it in:
//   git pull --ff-only, refused when files were changed here (a desktop/package-lock.json that `npm install`
//   rewrote only when the update changes it too) or, where the desktop window is installed, desktop/'s packages
//   changed (those need install.ps1, which quits Fleet View first: the window and the session host hold Electron
//   and node-pty open);
//   then the fleet-view skill's copies in ~/.claude* are refreshed (refreshSkill);
//   fleet-view.js, api.js and web/ reload by themselves after the pull (watchForUpdates, the page's version poll);
//   host.js or handoff.js changed: desktop\restart-host.js, which waits until no session is mid-turn and resumes them;
//   anything else in desktop/ changed: the page asks the window to restart itself (fleetDesktop.relaunch).
// With "update automatically" on (%LOCALAPPDATA%\fleet-view\update.json), an update found is put in once no
// conversation is working.
// Versions are numbers (version.js: 1.0.12, the same on every PC for the same code); the short commits stay
// alongside (current, upstream) for when there is no version.json.
//   GET  /update          { ok, version, enabled, current, upstream, currentVersion, upstreamVersion, behind, notes[], checkedAt,
//                           error?, dirty, dirtyLock, needsInstall, install, auto, busy, last? }
//                         dirtyLock: the one clashing change is desktop/package-lock.json; install: the command that
//                         puts in an update that needsInstall
//                         version: the folder's version now (the page's "v1.0.12" in the footer)
//   POST /update/check    fetch now, -> the same
//   POST /update/apply    -> { ok, message, from, to, fromVersion, toVersion, relaunch, hostRestart } or { ok: false, message }
//   POST /update/auto     { on } -> the same as GET
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const VERSION = require('./version.js');

const DIR = __dirname;
const CHECK_MS = 30 * 60e3, FIRST_MS = 60e3, AUTO_EVERY_MS = 60e3;
const DATA = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'fleet-view');
const PREFS = path.join(DATA, 'update.json');
const HOST_FILES = /^(?:desktop\/host\.js|handoff\.js)$/;
const NEEDS_INSTALL = /^desktop\/(?:package(?:-lock)?\.json)$/;
const LOCK = 'desktop/package-lock.json';
// what puts in an update that changes the desktop window's packages (it quits Fleet View first, see install.ps1)
const INSTALL = `powershell -NoProfile -ExecutionPolicy Bypass -File "${path.join(DIR, 'install.ps1')}"`;

const git = (args, ms = 60e3) => new Promise((resolve) => {
  execFile('git', ['-C', DIR, ...args], { timeout: ms, windowsHide: true, maxBuffer: 8 << 20, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
    (err, out, errOut) => resolve({ ok: !err, out: String(out || '').trim(), err: String(errOut || (err && err.message) || '').trim() }));
});

let state = { enabled: false, current: '', upstream: '', currentVersion: '', upstreamVersion: '', behind: 0, notes: [], checkedAt: 0, error: '', dirty: false, dirtyLock: false, needsInstall: false, install: '' };
let last = null; // the last update put in: { at, from, to, fromVersion, toVersion, message }
let checking = null, applying = false, ctx = null;

function readPrefs() { try { return JSON.parse(fs.readFileSync(PREFS, 'utf8')) || {}; } catch { return {}; } }
function writePrefs(p) { try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(PREFS, JSON.stringify(p, null, 2)); } catch {} }

// what changed between HEAD and its upstream: the commit messages, newest first, at most 40 lines. A share commit
// is "Fleet View 1.0.12" (or, before versions, "Fleet View <sha>") over "- <PR title>" lines: the title line is left
// out (the card shows the versions) and so is each line's own dash (the card draws its bullets); so is "Merge pull
// request #N from …" over its PR's title
async function notesFor(range) {
  const r = await git(['log', '--format=%x1e%B', range]);
  if (!r.ok) return [];
  const lines = [];
  for (const msg of r.out.split('\x1e').map((m) => m.trim()).filter(Boolean)) {
    msg.split(/\r?\n/).forEach((l, i, all) => {
      const t = l.trim().replace(/^[-*•]\s+/, '');
      // the trailers say nothing to the reader
      if (!t || /^(?:Co-Authored-By|Signed-off-by):/i.test(t) || /Generated with \[Claude Code\]/.test(t)) return;
      if (i === 0 && /^Fleet View (?:v?\d+\.\d+(?:\.\d+)?|[0-9a-f]{7,40})$/i.test(t)) return;
      if (i === 0 && /^Merge (?:pull request|branch)\b/.test(t) && all.slice(1).some((x) => x.trim())) return;
      lines.push(t);
    });
  }
  return lines.slice(0, 40);
}

// The fleet-view skill is a copy in each Claude login (~/.claude, ~/.claude-<letter>; install.ps1 puts it there), so
// after a pull the new text goes there too, the same way: into every login, only where it differs. Never onto this
// folder's own file (a skills folder that links here). Returns the logins it wrote to.
function refreshSkill() {
  const src = path.join(DIR, 'skills', 'fleet-view', 'SKILL.md');
  let text;
  try { text = fs.readFileSync(src); } catch { return []; }
  const home = process.env.USERPROFILE || os.homedir();
  let logins = [];
  try { logins = fs.readdirSync(home).filter((n) => /^\.claude(?:-[a-z])?$/i.test(n) && fs.statSync(path.join(home, n)).isDirectory()); } catch {}
  const out = [];
  for (const n of logins) {
    try {
      const to = path.join(home, n, 'skills', 'fleet-view', 'SKILL.md');
      let have = null;
      try { have = fs.readFileSync(to); } catch {}
      if (have && have.equals(text)) continue;
      fs.mkdirSync(path.dirname(to), { recursive: true });
      if (fs.realpathSync(path.dirname(to)).toLowerCase() === fs.realpathSync(path.dirname(src)).toLowerCase()) continue;
      fs.writeFileSync(to, text);
      out.push(`~/${n}`);
    } catch {}
  }
  return out;
}

function check() {
  if (checking) return checking;
  checking = (async () => {
    const at = Date.now();
    const inside = await git(['rev-parse', '--is-inside-work-tree'], 5000);
    const currentVersion = VERSION.refresh().version;
    if (!inside.ok || inside.out !== 'true') { state = { ...state, currentVersion, enabled: false, checkedAt: at, error: 'not a git checkout' }; return; }
    const up = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], 5000);
    if (!up.ok) { state = { ...state, currentVersion, enabled: false, checkedAt: at, error: 'this branch has no upstream to update from' }; return; }
    const remote = up.out.split('/')[0];
    const f = await git(['fetch', '--quiet', remote]);
    const current = (await git(['rev-parse', '--short', 'HEAD'], 5000)).out;
    const upstream = (await git(['rev-parse', '--short', '@{u}'], 5000)).out;
    const behind = +(await git(['rev-list', '--count', 'HEAD..@{u}'], 5000)).out || 0;
    const upstreamVersion = behind ? VERSION.versionAt(DIR, '@{u}').version : currentVersion;
    const changed = behind ? (await git(['diff', '--name-only', 'HEAD', '@{u}'], 10e3)).out.split(/\r?\n/).filter(Boolean) : [];
    // files changed here; a changed desktop/package-lock.json (an `npm install` in desktop/ rewrites it) only gets in
    // the way when the update changes it too
    const edited = (await git(['status', '--porcelain', '--untracked-files=no'], 10e3)).out.split(/\r?\n/).filter(Boolean).map((l) => l.trim().replace(/^\S+\s+/, ''));
    const clash = edited.filter((x) => x !== LOCK || changed.includes(x));
    // new desktop packages need install.ps1 only where the desktop window is installed; an Edge window just pulls
    const needsInstall = changed.some((x) => NEEDS_INSTALL.test(x)) && fs.existsSync(path.join(DIR, 'desktop', 'node_modules'));
    state = {
      enabled: true, current, upstream, currentVersion, upstreamVersion, behind, notes: behind ? await notesFor('HEAD..@{u}') : [], checkedAt: at,
      error: f.ok ? '' : `could not reach ${remote}: ${f.err.split(/\r?\n/)[0].slice(0, 200)}`,
      dirty: clash.length > 0, dirtyLock: clash.length === 1 && clash[0] === LOCK, needsInstall, install: needsInstall ? INSTALL : '',
    };
    if (!f.ok && ctx) ctx.log(`update: fetch from ${remote} failed: ${f.err.split(/\r?\n/)[0]}`);
  })().finally(() => { checking = null; });
  return checking;
}

const busyNow = () => { try { return ctx ? ctx.busy() : 0; } catch { return 0; } };
const status = () => ({ ok: true, version: VERSION.current().version, ...state, auto: !!readPrefs().auto, busy: busyNow(), applying, ...(last ? { last } : {}) });

async function apply() {
  if (applying) return { ok: false, message: 'an update is already going in' };
  applying = true;
  try {
    await check();
    if (!state.enabled) return { ok: false, message: `updates are off here: ${state.error}` };
    if (!state.behind) return { ok: false, message: 'already up to date' };
    if (state.dirtyLock) return { ok: false, message: `desktop\\package-lock.json was changed here (npm install does that), and this update changes it too. Put it back with: git -C "${DIR}" checkout -- desktop/package-lock.json` };
    if (state.dirty) return { ok: false, message: 'files in the Fleet View folder were changed here, so it was not updated (git pull would clash). Undo them, or update by hand.' };
    if (state.needsInstall) return { ok: false, message: `this update changes the desktop window's packages, so it goes in with install.ps1 (it quits Fleet View, asking first, and starts it again): ${INSTALL}` };
    const from = (await git(['rev-parse', 'HEAD'], 5000)).out;
    const fromVersion = VERSION.refresh().version;
    const pull = await git(['pull', '--ff-only', '--quiet']);
    if (!pull.ok) return { ok: false, message: `git pull failed: ${pull.err.split(/\r?\n/)[0].slice(0, 300)}` };
    const to = (await git(['rev-parse', 'HEAD'], 5000)).out;
    const toVersion = VERSION.refresh().version;
    const changed = (await git(['diff', '--name-only', from, to], 10e3)).out.split(/\r?\n/).filter(Boolean);
    const hostRestart = changed.some((x) => HOST_FILES.test(x));
    const relaunch = changed.some((x) => /^desktop\//.test(x) && !HOST_FILES.test(x));
    const skillTo = refreshSkill();
    if (skillTo.length && ctx) ctx.log(`update: the fleet-view skill refreshed in ${skillTo.join(', ')}`);
    if (hostRestart) {
      // detached: it outlives this server's own reload; it waits until no session is mid-turn
      try {
        const c = spawn(process.execPath, [path.join(DIR, 'desktop', 'restart-host.js')], { detached: true, stdio: 'ignore', windowsHide: true });
        c.unref();
      } catch (e) { if (ctx) ctx.log(`update: could not restart the session host: ${e.message}`); }
    }
    // "updated 1.0.10 → 1.0.12"; the short commits only when there is no version to say
    const both = fromVersion && toVersion;
    const message = `updated ${both ? fromVersion : from.slice(0, 7)} → ${both ? toVersion : to.slice(0, 7)}${hostRestart ? '; the session host restarts once no session is mid-turn' : ''}${relaunch ? '; the window restarts' : ''}`;
    last = { at: Date.now(), from: from.slice(0, 7), to: to.slice(0, 7), fromVersion, toVersion, message };
    if (ctx) ctx.log(`update: ${message}`);
    state = { ...state, current: to.slice(0, 7), currentVersion: toVersion, behind: 0, notes: [] };
    return { ok: true, message, from: from.slice(0, 7), to: to.slice(0, 7), fromVersion, toVersion, relaunch, hostRestart };
  } finally { applying = false; }
}

// once an update is found and nothing is working: put it in (only what needs no install, never over local edits)
async function autoTick() {
  if (!readPrefs().auto || applying || !state.behind || state.dirty || state.needsInstall || busyNow()) return;
  const r = await apply();
  if (!r.ok && ctx) ctx.log(`update: automatic update not done: ${r.message}`);
  // the desktop window can't be told from here; it asks on its next poll of /update (relaunchWanted). Kept on
  // disk: this server reloads itself after the pull
  if (r.ok && r.relaunch) writePrefs({ ...readPrefs(), relaunchWanted: r.toVersion || r.to });
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
