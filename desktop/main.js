// Fleet View desktop window: an Electron shell around the local page, with Windows 11 acrylic behind it,
// so the window is blurred and see-through like a Windows Terminal tab. fleet-view.js starts it with
//   electron <this folder> --url=http://127.0.0.1:PORT/?glass=1 [--bounds=x,y,w,h]
// The page only ever comes from that local server; anything else opens in the default browser (https only)
// or is refused.
//
// Besides the main window there is a mini view (web/mini.html): a small always-on-top glass window with what
// needs you, what is working and what just finished, and a tray icon (Show Fleet View, Mini view, Close window,
// Quit everything). The two
// take turns: opening the mini view hides the main window, and leaving it (its expand button, a row, Esc) brings
// the main window back as it was. A third window, the Chats window (the Chats tab popped out of the main window,
// ?solo=chats), is a normal window of its own next to the main one: see "Chats window" below. Closing the main
// window quits the app, mini view, Chats window and tray included, except
// while remote access is on (settings.remote.enabled, read from GET /state with the tray's counts): then closing
// it only hides it to the tray, so the server keeps answering the other computer, and the PC is kept from
// sleeping (powerSaveBlocker) for as long as it is the host. "Show Fleet View" or a tray click brings it back;
// "Quit everything" and an update's relaunch still quit.
//
// Window places: main.js is the source of truth. It keeps both windows' places in its own profile folder
// (window-state.json) and also posts them to the server (POST /settings: webBounds, miniBounds, miniOpen,
// chatsBounds, chatsOpen, chatsOnTop),
// so the Edge fallback and the next start-up see the same place. The page never saves bounds in Electron.
//
// Live sessions (terms.js, host.js): the detail panel can host the real interactive `claude --resume <id>` in a
// pseudo-terminal. The ptys live in the session host, a separate process this window starts when it is not
// running and connects to before the page loads, so page and server reloads, and closing the window, never end
// them: the next window reconnects and replays each screen. Only the main window's page may use them
// (fleetDesktop.term); the Chats window reaches them through the server's /live WebSocket, as a browser does
// (web/term.js, live.js). Closing the window just closes it (no question any more). The tray's "Quit everything"
// asks whether to move the sessions to Windows Terminal tabs (console windows on a PC without it) or close them, then has the host save the restore
// list, end every session and exit; the next start resumes the closed ones. Updating desktop/ restarts only the window; a changed host.js takes effect when
// the host next starts (it logs that a newer one is on disk).
// The page can also start a new conversation (term.create): a plain `claude` in a repo folder that /state
// lists (checked here against a fresh GET /state), keyed new-<n> until Claude Code reports its id (onRekey).
// "Add workspace…" asks for a folder with the system picker (fleetDesktop.pickFolder, main window only); a repo the
// server then lists (POST /repos/add) is in /state's repos[], so a new session may start there.
//
// Preview tab (web/preview.js): a local dev server's page in a frame of the main window. Only for such frames,
// X-Frame-Options and CSP frame-ancestors are dropped (previewFrames), where they go is sent to the page, and
// fleetDesktop.capture takes a PNG of the frame's area for "Screenshot to chat".
//
// macOS: vibrancy instead of acrylic, under the usual title bar (the page's header makes room for buttons on the
// right only, not for the traffic lights on the left); the application menu (app, Edit, View, Window: without it
// Cmd+C, Cmd+V and Cmd+Q do nothing); a menu bar icon (a template image) with the tray's menu; the dock icon.
// Closing the window hides it there, as remote access does on Windows: the dock icon, the menu bar icon or
// opening Fleet View again brings it back, and Cmd+Q quits the window app (the host and its sessions keep running).
// "Quit everything" moves sessions to Terminal windows (iTerm2 with FV_TERMINAL=iterm).
'use strict';
const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, nativeTheme, powerSaveBlocker, screen, shell, webFrameMain } = require('electron');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const P = require('../platform');
// macOS: an app started from Finder or the dock gets a bare PATH; the server, the session host and their sessions
// need the login shell's (claude, node, git, gh)
P.applyLoginPath();
const backdrop = require('./backdrop');
const { iconPng } = require('./icon');
const termHost = require('./terms');
const serverOwner = require('./server');
// a Claude account letter from the page: one letter (A, B, C, ...), else B, the default ~/.claude
const acctId = (a) => (typeof a === 'string' && /^[a-z]$/i.test(a) ? a.toUpperCase() : 'B');

function arg(name, argv = process.argv) {
  const pre = `--${name}=`;
  const hit = argv.find((a) => typeof a === 'string' && a.startsWith(pre));
  return hit ? hit.slice(pre.length) : null;
}

// only http://127.0.0.1:PORT/ or http://localhost:PORT/ is loaded
function parseUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(u.hostname) || !u.port) return null;
    return u;
  } catch { return null; }
}
const START = parseUrl(arg('url') || '') || new URL('http://127.0.0.1:4777/?glass=1');
if (!START.searchParams.has('glass')) START.searchParams.set('glass', '1');
// the window has no title bar of its own: the page's header is the title bar, and the native minimize,
// maximize and close buttons float over its right end. titlebar=overlay tells the page to make room for them
// (a window started by an older main.js keeps its frame, and the page then keeps its usual header).
const TITLEBAR_H = 44;
// macOS keeps its own title bar (see the top of this file)
if (!P.isMac) START.searchParams.set('titlebar', 'overlay');
const ORIGIN = START.origin;
const PORT = Number(START.port);
const MINI_URL = `${ORIGIN}/mini.html?glass=1`;
const CHATS_URL = `${ORIGIN}/?glass=1&solo=chats`;
const PRELOAD = path.join(__dirname, 'preload.js');

// one window per port: its own profile folder, which is also what the single-instance lock is keyed on,
// so a test server on another port never takes over the real window
app.setName('Fleet View');
app.setPath('userData', path.join(P.dataDir(), `electron-${PORT}`));
if (process.platform === 'win32') app.setAppUserModelId('FleetView');
// The taskbar names and draws a window from its app details, else from the exe it runs (electron.exe:
// "Electron" and Electron's logo on hover and on right-click). These give it Fleet View's name and icon,
// and right-click > Fleet View starts it through fleet-view.vbs (no console window).
const ICON = path.join(__dirname, 'fleet-view.ico');
const FV_VBS = path.join(__dirname, '..', 'fleet-view.vbs');
function brand(w) {
  if (process.platform !== 'win32' || !w || w.isDestroyed()) return;
  try {
    w.setAppDetails({
      appId: 'FleetView', appIconPath: ICON, appIconIndex: 0, relaunchDisplayName: 'Fleet View',
      relaunchCommand: `"${path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe')}" //nologo "${FV_VBS}"`,
    });
  } catch (e) { try { process.stdout.write(`[fleet-view] app details: ${e.message}\n`); } catch {} }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win = null, mini = null, chats = null, tray = null;
  const fvServer = serverOwner.create({ port: PORT, log: (m) => hlog(m) });
  let quitting = false;

  // FV_TEST_HIDDEN=1 (tests only, driven through --remote-debugging-port): the main window is created but never
  // shown or focused, with no mini view, no tray icon and no blur helper, and the "Quit everything" question
  // is answered yes by itself, so a test run never puts anything on the screen. The Chats window is made (so a test
  // can drive its page) but never shown either. global.__fvTest then offers quitEverything(), closeWindow(),
  // popChats(), dockChats() and chatsWindow() to a test attached to the main process (--inspect).
  const HIDDEN = process.env.FV_TEST_HIDDEN === '1';

  // ---------- live sessions (in the session host, host.js) ----------
  // FV_TERM_CMD (a harmless command instead of claude) is honoured by a test host only (FV_HOST_PIPE)
  const SELFTEST = process.env.FV_TERM_SELFTEST || '';
  const hlog = (m) => { try { process.stdout.write(`[fleet-view] ${m}\n`); } catch {} try { if (terms.isConnected()) terms.hostLog(m); } catch {} };
  const terms = termHost.createHost({
    send: (channel, ...args) => { if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, ...args); },
    onChange: () => updateTrayTip(true),
    log: (m) => hlog(m),
  });
  // what the page shows, kept with the restore list: the conversation in the panel, and the wide panel
  const UI_JS = "(() => { const d = document.getElementById('detail'); let w = null; try { w = localStorage.getItem('fv.detailWide') === '1'; } catch {} "
    + "return { selectedId: d && d.classList.contains('open') && typeof d._id === 'string' ? d._id : null, wide: !!w }; })()";
  function readUi() {
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return Promise.resolve(null);
    return Promise.race([
      win.webContents.executeJavaScript(UI_JS, true).catch(() => null),
      new Promise((r) => setTimeout(() => r(null), 400)),
    ]);
  }
  // The tray's "Quit everything": while sessions run, asks what happens to them (one question at a time):
  //   "Move to Terminal tabs" ("Move to console windows" on a PC without Windows Terminal): each conversation opens
  //     again outside Fleet View (moveToTerminal below), so the work goes on there, and leaves the restore list;
  //   "Close them": they stay on the restore list and the next start resumes them.
  // Either way the host saves the restore list (every running session, the busy ones marked), ends them all
  // (Ctrl+C twice, then their trees) and exits; then the app quits.
  let asking = null, dialogAbort = null, quittingAll = false;
  function quitEverything() {
    if (quittingAll) return Promise.resolve(true);
    if (asking) return asking;
    const busy = terms.busyCount(), n = terms.aliveCount();
    let go = Promise.resolve('close');
    if (n && !HIDDEN) {
      const ac = new AbortController();
      dialogAbort = ac;
      const parent = win && !win.isDestroyed() ? win : null;
      const s = n === 1 ? '' : 's';
      const wt = hasWt();
      // macOS and Linux: a terminal window each (Terminal.app, or iTerm2 with FV_TERMINAL=iterm)
      const term = P.isMac ? (String(process.env.FV_TERMINAL || '').toLowerCase() === 'iterm' ? 'iTerm2' : 'Terminal') : 'a terminal';
      const move = !P.isWin ? `Move to ${P.isMac ? term : 'terminal'} windows` : wt ? 'Move to Terminal tabs' : 'Move to console windows';
      const box = {
        type: busy ? 'warning' : 'question', title: 'Fleet View', noLink: true,
        message: `${n} Claude session${s} ${n === 1 ? 'is' : 'are'} open. Keep working in ${!P.isWin ? term : wt ? 'Windows Terminal' : 'console windows'}, or close ${n === 1 ? 'it' : 'them'}?`,
        detail: (!P.isWin ? `${move}: ${n === 1 ? 'it opens' : 'each opens'} again in a window of its own.\n`
          : wt ? `${move}: ${n === 1 ? 'it opens' : 'they open'} again in one Terminal window, a tab each in its account's colour.\n`
          : `${move}: ${n === 1 ? 'it opens' : 'each opens'} again in a console window of its own.\n`)
          + `Close them: ${n === 1 ? 'it opens' : 'they open'} again the next time Fleet View starts.`
          + (busy ? `\n\n${busy} ${busy === 1 ? 'is' : 'are'} mid-turn and will say ${busy === 1 ? 'it was' : 'they were'} interrupted.` : ''),
        buttons: [move, 'Close them', 'Cancel'], defaultId: 0, cancelId: 2, signal: ac.signal,
      };
      if (parent) { if (parent.isMinimized()) parent.restore(); parent.show(); }
      go = (parent ? dialog.showMessageBox(parent, box) : dialog.showMessageBox(box))
        .then(({ response }) => (ac.signal.aborted ? null : response === 0 ? 'move' : response === 1 ? 'close' : null), () => null);
    }
    asking = go.then(async (choice) => {
      if (!choice) return false;
      quittingAll = true;
      // the conversations to move, taken before they end (a new one still without its id can't be resumed)
      const moving = choice === 'move' ? terms.cached().filter((x) => x.alive && validId(x.id)) : [];
      const ui = await readUi();
      const r = await terms.quitEverything(ui);
      hlog(`quit everything: ${JSON.stringify(r)}`);
      if (moving.length) await moveToTerminal(moving);
      app.quit();
      return true;
    }).finally(() => { asking = null; dialogAbort = null; });
    return asking;
  }

  // Opens each conversation (ended here just before) again in its folder: as a tab of one new Windows Terminal window
  // when the PC has Windows Terminal, else each in a console window of its own (`cmd /c start`). Each runs
  // `cmd /k claude --resume <id>`, never through PowerShell (its script policy can refuse npm's claude.ps1). The
  // account is set in that command for any account but B (`set CLAUDE_CONFIG_DIR=%USERPROFILE%\.claude-<x>&&claude …`:
  // no space or quote in any word, so wt and start pass them on as they are), or it runs the account's launcher when
  // the machine has one (`claude-a --resume <id>`, ..., with its "Claude A" / ... Terminal profile). A conversation
  // leaves the restore list (sessions.json, which the host froze before ending them) only once its window started,
  // so the next start doesn't open it a second time and one that never opened is resumed then. Resolves when every
  // start was tried.
  // each account's Windows Terminal tab colour (claude-tabcolor.vbs uses the same ones)
  const TAB_COLOR = { A: '#3fb950', B: '#d97757', C: '#58a6ff', D: '#bc8cff', E: '#e3b341', F: '#f778ba' };
  // Windows Terminal is there: wt on PATH (Windows 11 has it; Windows 10 only once it was installed)
  let wtFound = null;
  function hasWt() {
    if (!P.isWin) return false;
    if (wtFound === null) {
      try { wtFound = require('child_process').spawnSync('where.exe', ['wt'], { windowsHide: true, stdio: 'ignore', timeout: 5000 }).status === 0; } catch { wtFound = false; }
    }
    return wtFound;
  }
  function moveToTerminal(list) {
    const { spawn } = require('child_process');
    const npmDir = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm');
    const items = list.map((x) => {
      const L = typeof x.account === 'string' && /^[a-z]$/i.test(x.account) ? x.account.toUpperCase() : 'B', l = L.toLowerCase();
      // wt splits its command line at ';', and cmd reads a '%' as a variable: such a folder opens in the home folder instead
      const cwd = typeof x.cwd === 'string' && x.cwd && !/[;%"]/.test(x.cwd) ? x.cwd.replace(/([^:])[\\/]+$/, '$1') : os.homedir();
      const launcher = fs.existsSync(path.join(npmDir, `claude-${l}.cmd`));
      const words = launcher ? [`claude-${l}`, '--resume', x.id] : L === 'B' ? ['claude', '--resume', x.id]
        : ['set', `CLAUDE_CONFIG_DIR=%USERPROFILE%\\.claude-${l}&&claude`, '--resume', x.id];
      return { id: x.id, L, cwd, launcher, words };
    });
    // the windows must not inherit this app's markers: a CLAUDE_CODE_CHILD_SESSION turns transcripts off, NO_COLOR greys Claude
    const env = { ...process.env, CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1' };
    for (const k of Object.keys(env)) if (k === 'NO_COLOR' || (/^CLAUDE/i.test(k) && k !== 'CLAUDE_CODE_FORCE_SESSION_PERSISTENCE')) delete env[k];
    const short = (xs) => xs.map((x) => x.id.slice(0, 8)).join(', ');
    // each in a console window of its own; ok once `start` said it started it (exit code 0)
    const consoles = (xs) => Promise.all(xs.map((x) => new Promise((resolve) => {
      const line = `/d /c start "Claude ${x.L}" /D "${x.cwd}" cmd /k ${x.words.join(' ').replace(/&/g, '^&')}`;
      try {
        const c = spawn(process.env.ComSpec || 'cmd.exe', [line], { env, windowsVerbatimArguments: true, windowsHide: true, stdio: 'ignore' });
        c.on('error', (e) => { hlog(`move to a console window: ${x.id.slice(0, 8)}: ${e.message}`); resolve(null); });
        c.on('exit', (code) => { if (code !== 0) hlog(`move to a console window: ${x.id.slice(0, 8)}: start said ${code}`); resolve(code === 0 ? x : null); });
      } catch (e) { hlog(`move to a console window: ${x.id.slice(0, 8)}: ${e.message}`); resolve(null); }
    }))).then((r) => {
      const ok = r.filter(Boolean);
      if (ok.length) hlog(`move to console windows: ${ok.length} window(s): ${short(ok)}`);
      return ok;
    });
    // one new Windows Terminal window, a tab each; console windows instead when wt won't start
    const tabs = (xs) => new Promise((resolve) => {
      const args = ['-w', 'new'];
      for (const x of xs) {
        if (args.length > 2) args.push(';');
        args.push('new-tab', ...(x.launcher ? ['-p', 'Claude ' + x.L] : []), '-d', x.cwd, '--tabColor', TAB_COLOR[x.L] || '#8b949e', 'cmd.exe', '/k', ...x.words);
      }
      let c;
      try { c = spawn('wt.exe', args, { env, detached: true, stdio: 'ignore', windowsHide: false }); } catch (e) {
        hlog(`move to Terminal: ${e.message}; console windows instead`);
        return resolve(consoles(xs));
      }
      c.on('spawn', () => { hlog(`move to Terminal: ${xs.length} tab(s): ${short(xs)}`); resolve(xs); });
      c.on('error', (e) => { hlog(`move to Terminal: ${e.message}; console windows instead`); resolve(consoles(xs)); });
      c.unref();
    });
    // macOS and Linux: one terminal window each, one after another (platform.js openTerminal)
    const windows = async (xs) => {
      const ok = [];
      for (const x of xs) {
        // the folder as the host had it (any characters are fine in sh quotes), when it is still there
        const raw = (list.find((y) => y.id === x.id) || {}).cwd;
        let cwd = os.homedir();
        try { if (typeof raw === 'string' && raw && fs.statSync(raw).isDirectory()) cwd = raw; } catch {}
        const r = await P.openTerminal({ cwd, cmd: P.resumeCommand(x.id, x.L, null), title: `Claude ${x.L}` });
        if (r.ok) ok.push(x); else hlog(`move to a terminal: ${x.id.slice(0, 8)}: ${r.message}`);
      }
      if (ok.length) hlog(`move to terminal windows: ${ok.length} window(s): ${short(ok)}`);
      return ok;
    };
    return (!P.isWin ? windows(items) : hasWt() ? tabs(items) : consoles(items)).then((moved) => {
      if (!moved.length) return;
      const f = path.join(termHost.dataDir(), 'sessions.json');
      try {
        const j = JSON.parse(fs.readFileSync(f, 'utf8'));
        const ids = new Set(moved.map((x) => x.id.toLowerCase()));
        j.sessions = (j.sessions || []).filter((s) => !(s && typeof s.id === 'string' && ids.has(s.id.toLowerCase())));
        j.reason = 'moved to Terminal';
        fs.writeFileSync(`${f}.tmp`, JSON.stringify(j, null, 1));
        fs.renameSync(`${f}.tmp`, f);
      } catch (e) { hlog(`move to Terminal: could not update the restore list: ${e.message}`); }
    });
  }
  app.on('before-quit', () => { quitting = true; });

  // ---------- remote access: keep hosting ----------
  // settings.remote.enabled (the page's remote switch, saved by the server). While it is on, closing the main
  // window hides it instead of quitting, and Windows is asked not to sleep (prevent-app-suspension: the screen may
  // still turn off). An unanswered /state keeps the last known value, so a server restart doesn't flip it.
  let remoteOn = false, awakeId = null;
  function setRemote(on) {
    on = !!on;
    if (on && awakeId === null) {
      try { awakeId = powerSaveBlocker.start('prevent-app-suspension'); hlog('remote access is on: closing the window keeps Fleet View running, and the PC stays awake'); } catch (e) { hlog(`could not keep the PC awake: ${e.message}`); }
    } else if (!on && awakeId !== null) {
      try { powerSaveBlocker.stop(awakeId); } catch {}
      awakeId = null;
      hlog('remote access is off: the PC may sleep again, and closing the window quits');
    }
    if (on === remoteOn) return;
    remoteOn = on;
    updateTrayMenu();
  }
  // Windows is signing out or shutting down: the window must really close then, never hide
  const endingSession = () => { quitting = true; };

  app.on('second-instance', () => showMain(null));

  // ---------- saved places: window-state.json in the profile folder ----------
  // { webBounds: {x,y,w,h}, maximized, miniBounds: {x,y,w,h}, miniOpen, chatsBounds: {x,y,w,h}, chatsMaximized,
  //   chatsOpen, chatsOnTop }, all in DIPs (Electron's own units)
  const STATE_FILE = path.join(app.getPath('userData'), 'window-state.json');
  const okRect = (r) => r && typeof r === 'object' && ['x', 'y', 'w', 'h'].every((k) => Number.isFinite(r[k]));
  const toRect = (b) => ({ x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) });
  const toBounds = (r) => ({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.w), height: Math.round(r.h) });
  let local = {};
  try { local = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {}; } catch {}
  function writeLocal() {
    try {
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
      const tmp = STATE_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(local, null, 2));
      fs.renameSync(tmp, STATE_FILE);
    } catch {}
  }

  // ---------- the server: POST /settings, GET /state ----------
  function postSettings(obj, done) {
    const body = JSON.stringify(obj);
    let finished = false;
    const end = () => { if (!finished) { finished = true; if (done) done(); } };
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: '/settings', method: 'POST', timeout: 1500,
      headers: { Host: `127.0.0.1:${PORT}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => { res.resume(); res.on('end', end); res.on('error', end); });
    req.on('timeout', () => req.destroy());
    req.on('error', end);
    req.end(body);
  }
  function getState(cb) {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/state', timeout: 2500, headers: { Host: `127.0.0.1:${PORT}` } }, (res) => {
      const parts = [];
      res.on('data', (d) => parts.push(d));
      res.on('end', () => { try { cb(res.statusCode === 200 ? JSON.parse(Buffer.concat(parts).toString('utf8')) : null); } catch { cb(null); } });
      res.on('error', () => cb(null));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => cb(null));
  }

  // ---------- screens ----------
  // at least a 100x60 piece of it lies on some display's work area
  function isVisible(b) {
    return screen.getAllDisplays().some(({ workArea: a }) =>
      Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x) >= 100 &&
      Math.min(b.y + b.height, a.y + a.height) - Math.max(b.y, a.y) >= 60);
  }
  // wholly inside the work area of the display it mostly lies on
  function inside(b) {
    const a = screen.getDisplayMatching(b).workArea;
    const width = Math.min(b.width, a.width), height = Math.min(b.height, a.height);
    const x = Math.min(Math.max(b.x, a.x), a.x + a.width - width);
    const y = Math.min(Math.max(b.y, a.y), a.y + a.height - height);
    return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
  }
  const sameBounds = (a, b) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

  // ---------- main window: where it opens ----------
  // the place main.js saved last time, else --bounds from the server (the Edge window's place), else centred
  function startBounds() {
    let r = okRect(local.webBounds) ? local.webBounds : null;
    if (!r) {
      const p = (arg('bounds') || '').split(',').map(Number);
      if (p.length === 4 && p.every(Number.isFinite)) r = { x: p[0], y: p[1], w: p[2], h: p[3] };
    }
    if (!r || r.w < 200 || r.h < 150) return null;
    const b = toBounds(r);
    if (isVisible(b)) return b;
    const a = screen.getPrimaryDisplay().workArea; // nowhere to be seen: centre it on the main display
    const width = Math.min(b.width, a.width), height = Math.min(b.height, a.height);
    return { x: Math.round(a.x + (a.width - width) / 2), y: Math.round(a.y + (a.height - height) / 2), width, height };
  }

  // ---------- main window: saving its place ----------
  // Always the restored (normal) outer bounds, in DIPs, read with getNormalBounds() and put back with
  // setBounds(): the same pair, so nothing is mixed (no content bounds, no frame offsets; the window has no
  // frame). Moves while it is being placed at start-up are not saved.
  let placing = true, saveTimer = null;
  function mainRect() {
    if (!win || win.isDestroyed() || win.isMinimized()) return null;
    return toRect(win.getNormalBounds());
  }
  function saveMain(done) {
    const r = mainRect();
    if (!r || placing || fullScreen(win)) return done && done();
    local.webBounds = r;
    local.maximized = win.isMaximized();
    writeLocal();
    postSettings({ webBounds: r }, done);
  }
  function saveMainSoon() { if (placing) return; clearTimeout(saveTimer); saveTimer = setTimeout(() => saveMain(), 1000); }

  function guardContents(wc, reload) {
    // links: http(s) and mailto open in the default browser or mail app; nothing opens a second Electron window
    const OUTSIDE = new Set(['https:', 'http:', 'mailto:']);
    wc.setWindowOpenHandler(({ url }) => {
      try { if (OUTSIDE.has(new URL(url).protocol)) shell.openExternal(url); } catch {}
      return { action: 'deny' };
    });
    // the window never leaves the local page
    const guard = (e, url) => {
      let u = null;
      try { u = new URL(url); } catch {}
      if (u && u.origin === ORIGIN) return;
      e.preventDefault();
      if (u && OUTSIDE.has(u.protocol)) shell.openExternal(url);
    };
    wc.on('will-navigate', guard); // the main frame only
    // will-redirect fires for frames too: a redirect inside a preview frame (web/preview.js) is the frame's own
    // business, so only the window's own page is guarded
    wc.on('will-redirect', (e, url, _inPlace, isMain) => {
      if ((e && typeof e.isMainFrame === 'boolean' ? e.isMainFrame : isMain) === false) return;
      guard(e, url);
    });
    wc.on('will-attach-webview', (e) => e.preventDefault());
    // only the microphone, for the chat box's mic (web/voice.js), and only for the local page; nothing else
    wc.session.setPermissionRequestHandler((_wc, perm, cb, details) => {
      let local = false;
      try { local = new URL(details.requestingUrl).origin === ORIGIN; } catch {}
      const types = (details && details.mediaTypes) || [];
      cb(perm === 'media' && local && types.length > 0 && types.every((t) => t === 'audio'));
    });
    // the server may still be starting (or restarting): try again until it answers
    wc.on('did-fail-load', (_e, code, _desc, _url, isMain) => {
      if (!isMain || code === -3) return; // -3: aborted by a newer load
      setTimeout(() => { if (!wc.isDestroyed()) reload(); }, 1500);
    });
    // keys the removed menu used to give: reload, dev tools
    wc.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown') return;
      const k = input.key.toLowerCase();
      if (k === 'f5' || (input.control && input.shift && k === 'r')) { e.preventDefault(); wc.reload(); } // plain Ctrl+R goes to the page (the chat box's history search)
      else if (k === 'f12' || (input.control && input.shift && k === 'i')) { e.preventDefault(); wc.toggleDevTools(); }
    });
  }

  // ---------- previews: a local dev server's page in a frame of the main window (web/preview.js) ----------
  // Dev servers often say they may not be framed (X-Frame-Options, CSP frame-ancestors). For a frame of the main
  // window's local page that loads http on localhost, 127.0.0.1 or [::1] at a port other than this window's
  // server's, those two are dropped from the frame document's response (the rest of its CSP stays). Every other
  // response, frame, window and request is left as it was. Where such a frame goes by itself (a link, a redirect,
  // an app's own routing) goes to the page (fv:preview-nav), so its address box follows. Its popups open in the
  // default browser (setWindowOpenHandler above), and it can't navigate the window (its sandbox, will-navigate).
  const PREVIEW_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
  function previewUrl(raw) {
    try { const u = new URL(raw); return u.protocol === 'http:' && PREVIEW_HOSTS.has(u.hostname) && !!u.port && Number(u.port) !== PORT; } catch { return false; }
  }
  const dropFrameAncestors = (v) => String(v).split(';').filter((d) => !/^\s*frame-ancestors(\s|$)/i.test(d)).join(';').trim();
  const pageIsLocal = (wc) => { try { return new URL(wc.getURL()).origin === ORIGIN; } catch { return false; } };
  // the main frame itself, a frame directly in it, or one already gone (null); never a frame deeper down
  function nearTop(wc, f) {
    if (!f) return true;
    try { const top = wc.mainFrame.frameTreeNodeId; return f.frameTreeNodeId === top || (!!f.parent && f.parent.frameTreeNodeId === top); } catch { return false; }
  }
  function previewFrames(wc) {
    const onHeaders = (d, cb) => {
      try {
        if (d.resourceType !== 'subFrame' || wc.isDestroyed() || d.webContentsId !== wc.id || !previewUrl(d.url) || !pageIsLocal(wc) || !nearTop(wc, d.frame)) return cb({});
        const out = {};
        let changed = false;
        for (const [k, v] of Object.entries(d.responseHeaders || {})) {
          const n = k.toLowerCase();
          if (n === 'x-frame-options') { changed = true; continue; }
          if (n === 'content-security-policy') {
            const was = [].concat(v), kept = was.map(dropFrameAncestors);
            if (kept.some((x, i) => x !== was[i])) changed = true;
            const left = kept.filter(Boolean);
            if (left.length) out[k] = left;
            continue;
          }
          out[k] = v;
        }
        cb(changed ? { responseHeaders: out } : {});
      } catch { cb({}); }
    };
    // only local http responses come here; a pattern this Electron doesn't take falls back to the next
    for (const urls of [['http://localhost:*/*', 'http://127.0.0.1:*/*', 'http://[::1]:*/*'], ['http://localhost:*/*', 'http://127.0.0.1:*/*'], null]) {
      try { if (urls) wc.session.webRequest.onHeadersReceived({ urls }, onHeaders); else wc.session.webRequest.onHeadersReceived(onHeaders); break; } catch {}
    }
    const nav = (url, isMain, pid, rid) => {
      if (isMain || !previewUrl(url) || !pageIsLocal(wc)) return;
      let f = null;
      try { f = webFrameMain.fromId(pid, rid) || null; } catch {}
      if (f && !(f.parent && f.parent.frameTreeNodeId === wc.mainFrame.frameTreeNodeId)) return; // a frame inside the preview
      if (!wc.isDestroyed()) wc.send('fv:preview-nav', url);
    };
    wc.on('did-frame-navigate', (_e, url, _code, _text, isMain, pid, rid) => nav(url, isMain, pid, rid));
    wc.on('did-navigate-in-page', (_e, url, isMain, pid, rid) => nav(url, isMain, pid, rid));
  }

  // Electron shows no right-click menu by itself: give text boxes (the chat box) and selected text the usual
  // edit menu. The page keeps its own menus elsewhere (it cancels the event before it gets here).
  function editMenu(w) {
    w.webContents.on('context-menu', (_e, p) => {
      const items = p.isEditable
        ? [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut', enabled: p.editFlags.canCut }, { role: 'copy', enabled: p.editFlags.canCopy },
          { role: 'paste', enabled: p.editFlags.canPaste }, { type: 'separator' }, { role: 'selectAll' }]
        : p.selectionText && p.selectionText.trim() ? [{ role: 'copy' }] : null;
      if (items && !w.isDestroyed()) Menu.buildFromTemplate(items).popup({ window: w });
    });
  }

  // hidden test mode: keep timers and animation frames running in the never-shown window
  const webPreferences = { nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false, preload: PRELOAD, ...(HIDDEN ? { backgroundThrottling: false } : {}) };

  function create() {
    nativeTheme.themeSource = 'dark'; // dark title bar and scrollbars
    Menu.setApplicationMenu(P.isMac ? macMenu() : null);
    const want = startBounds();
    win = new BrowserWindow({
      ...(want || { width: 1400, height: 900 }),
      minWidth: 480, minHeight: 320,
      title: 'Fleet View',
      backgroundColor: '#00000000',
      ...(P.isMac ? {
        // the usual title bar; vibrancy behind the page, kept while the window is inactive. Full screen is the
        // simple kind (FULL_SCREEN): the native kind moves the window to a Space of its own with nothing behind
        // it, so the vibrancy turns solid black there
        vibrancy: 'under-window', visualEffectState: 'active', simpleFullscreen: true,
      } : {
        icon: ICON,
        backgroundMaterial: 'acrylic', // Windows 11 22H2 and later; older Windows shows the page's own dark tint
        autoHideMenuBar: true,
        // frameless look, native buttons: the page's header is the drag region (-webkit-app-region: drag)
        titleBarStyle: 'hidden',
        titleBarOverlay: { color: '#00000000', symbolColor: '#c9cee6', height: TITLEBAR_H },
      }),
      show: false,
      webPreferences,
    });
    // Put it exactly where it was. The constructor places the window before it knows the target display's
    // scale, so on a screen with another scale the first placement lands off; setBounds() on the created
    // window, again just before it shows, lands where getNormalBounds() said.
    const place = () => { if (want && !win.isDestroyed() && !sameBounds(win.getBounds(), want)) win.setBounds(want); };
    place();
    let shown = false;
    const showIt = () => {
      if (shown || win.isDestroyed()) return;
      shown = true;
      place();
      if (HIDDEN) { placing = false; return; }
      if (local.maximized) win.maximize();
      win.show();
      // the Bots window, when it came back popped out and showed first, stays in front of the main window
      if (chatsPopped() && chats.isVisible()) chats.moveTop();
      setTimeout(() => { if (!win || win.isDestroyed()) return; if (!win.isMaximized()) place(); placing = false; }, 400);
    };
    brand(win);
    leaveFullScreenWhenHidden(win);
    win.once('ready-to-show', showIt);
    if (!HIDDEN) keepBlurWhenInactive(win);
    setTimeout(showIt, 3000);

    const wc = win.webContents;
    guardContents(wc, () => { if (win && !win.isDestroyed()) win.loadURL(START.href); });
    previewFrames(wc);
    wc.on('did-finish-load', () => { sendMiniOpen(); sendChatsPopped(); });
    editMenu(win);

    win.on('move', saveMainSoon);
    win.on('resize', saveMainSoon);
    win.on('maximize', saveMainSoon);
    win.on('unmaximize', saveMainSoon);
    // close = quit the app: save both places in one go (at most 1.2 s), then the whole app goes, mini view and
    // tray too. The sessions keep running in the host; what the panel showed goes with them.
    // While remote access is on (and nothing is quitting), close only hides: the place is saved, the mini view
    // goes too, and the tray brings the window back as it was.
    let closing = false;
    win.on('close', (e) => {
      if (closing) return;
      // macOS: closing a window never quits an app there; Cmd+Q (before-quit) does
      // (while it only hides, the Chats window stays where it is)
      if ((remoteOn || P.isMac) && !quitting && !quittingAll && !HIDDEN) {
        e.preventDefault();
        clearTimeout(saveTimer);
        if (!placing) saveMain();
        if (local.miniOpen || miniIsOpen()) closeMini();
        win.hide();
        hlog(remoteOn ? 'window closed while remote access is on: hidden to the tray, Fleet View keeps running' : 'window closed: hidden, Fleet View keeps running (the dock or menu bar icon brings it back)');
        return;
      }
      closing = true;
      e.preventDefault();
      clearTimeout(saveTimer);
      clearTimeout(miniSaveTimer);
      clearTimeout(chatsSaveTimer);
      const body = {};
      const r = placing ? null : mainRect();
      if (r) { local.webBounds = r; local.maximized = win.isMaximized(); body.webBounds = r; }
      if (mini && !mini.isDestroyed()) local.miniBounds = toRect(mini.getBounds());
      if (okRect(local.miniBounds)) body.miniBounds = local.miniBounds;
      body.miniOpen = !!local.miniOpen;
      // the Chats window goes with the app and opens again at the next start (chatsOpen stays as it is)
      keepChatsPlace();
      if (okRect(local.chatsBounds)) body.chatsBounds = local.chatsBounds;
      body.chatsOpen = !!local.chatsOpen;
      body.chatsOnTop = !!local.chatsOnTop;
      writeLocal();
      // this window, not `win`: when the 1.2 s timer wins, 'closed' sets win to null before the settings post
      // (slow while the server restarts) calls back, and win.isDestroyed() then threw a main-process error box
      const w = win;
      const t = setTimeout(() => { if (!w.isDestroyed()) w.destroy(); }, 1200);
      let left = 2;
      const one = () => { if (--left === 0) { clearTimeout(t); if (!w.isDestroyed()) w.destroy(); } };
      postSettings(body, one);
      if (quittingAll) one();
      else readUi().then((ui) => { if (ui) terms.setUi(ui); one(); });
    });
    win.on('closed', () => { win = null; app.quit(); });
    win.on('page-title-updated', (e) => e.preventDefault()); // keep "Fleet View"
    win.on('query-session-end', endingSession);
    win.on('session-end', endingSession);

    win.loadURL(START.href);
  }

  // U+2028 and U+2029: valid in JSON, escaped anyway so the literal reads the same in any JS parser
  const LINE_SEPS = new RegExp(`[${String.fromCharCode(0x2028, 0x2029)}]`, 'g');
  const BSLASH = String.fromCharCode(92);
  // bring the main window up and focus it; with an id, pick that conversation (the page's window.fvSelect).
  // The mini view gives way to it.
  function showMain(id) {
    if (!win || win.isDestroyed()) return;
    if (local.miniOpen || miniIsOpen()) closeMini();
    if (!HIDDEN) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.moveTop();
      win.focus();
    }
    if (typeof id === 'string' && id && id.length <= 200) {
      // the id goes in as a JSON string literal (U+2028/2029 escaped too), never as code
      const lit = JSON.stringify(id).replace(LINE_SEPS, (c) => `${BSLASH}u${c.charCodeAt(0).toString(16)}`);
      win.webContents.executeJavaScript(`window.fvSelect && window.fvSelect(${lit})`, true).catch(() => {});
    }
  }

  // ---------- mini view ----------
  // A small glass window that stays on top: counts, the clock, and the conversations that need you, work or just
  // finished. It takes the main window's place: opening it hides the main window, leaving it shows that again.
  // It opens at the bottom right of the main window's display and saves its place (miniBounds); the app always
  // starts on the main window. Its height follows its rows (fitMini).
  const MINI_W = 360, MINI_H = 220, MINI_MIN_W = 240, MINI_MIN_H = 84;
  let miniSaveTimer = null;
  function miniDefault() {
    const d = win && !win.isDestroyed() ? screen.getDisplayMatching(win.getBounds()) : screen.getPrimaryDisplay();
    const a = d.workArea;
    return { x: a.x + a.width - MINI_W - 16, y: a.y + a.height - MINI_H - 16, width: MINI_W, height: MINI_H };
  }
  function miniStart() {
    if (okRect(local.miniBounds) && local.miniBounds.w >= MINI_MIN_W && local.miniBounds.h >= MINI_MIN_H) {
      const b = toBounds(local.miniBounds);
      if (isVisible(b)) return inside(b);
    }
    return miniDefault();
  }
  const miniIsOpen = () => !!(mini && !mini.isDestroyed() && mini.isVisible());
  function saveMini() {
    if (mini && !mini.isDestroyed()) local.miniBounds = toRect(mini.getBounds());
    writeLocal();
    const body = { miniOpen: !!local.miniOpen };
    if (okRect(local.miniBounds)) body.miniBounds = local.miniBounds;
    postSettings(body);
  }
  function saveMiniSoon() { clearTimeout(miniSaveTimer); miniSaveTimer = setTimeout(saveMini, 800); }

  function createMini() {
    const want = miniStart();
    mini = new BrowserWindow({
      ...want,
      minWidth: MINI_MIN_W, minHeight: MINI_MIN_H,
      title: 'Fleet View mini',
      frame: false,
      resizable: true, maximizable: false, minimizable: false, fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      backgroundColor: '#00000000',
      ...(P.isMac ? { vibrancy: 'hud', visualEffectState: 'active', roundedCorners: true } : { icon: ICON, backgroundMaterial: 'acrylic' }),
      show: false,
      webPreferences,
    });
    mini.setAlwaysOnTop(true, 'floating');
    if (!sameBounds(mini.getBounds(), want)) mini.setBounds(want);
    keepBlurWhenInactive(mini);
    roundCorners(mini);
    const wc = mini.webContents;
    guardContents(wc, () => { if (mini && !mini.isDestroyed()) mini.loadURL(MINI_URL); });
    wc.on('before-input-event', (e, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') { e.preventDefault(); hideMini(); }
    });
    mini.once('ready-to-show', () => {
      if (!local.miniOpen || mini.isDestroyed()) return;
      if (!sameBounds(mini.getBounds(), want)) mini.setBounds(want);
      mini.show();
    });
    mini.on('show', () => roundCorners(mini));
    mini.on('move', saveMiniSoon);
    mini.on('resize', saveMiniSoon);
    // Alt+F4 on the mini view goes back to the main window; it only really closes when the app quits
    mini.on('close', (e) => { if (!quitting) { e.preventDefault(); hideMini(); } });
    mini.on('closed', () => { mini = null; });
    mini.on('page-title-updated', (e) => e.preventDefault());
    mini.loadURL(MINI_URL);
  }
  // the main window goes into the mini view: the mini view shows (and takes the keyboard), the main window hides
  function openMini() {
    local.miniOpen = true;
    if (!mini || mini.isDestroyed()) createMini(); // shows itself once its page is ready
    else {
      mini.setBounds(inside(mini.getBounds()));
      mini.show();
    }
    if (!HIDDEN && win && !win.isDestroyed() && win.isVisible()) win.hide();
    saveMini();
    miniChanged();
  }
  function closeMini() {
    local.miniOpen = false;
    if (mini && !mini.isDestroyed()) mini.hide();
    saveMini();
    miniChanged();
  }
  // leaving the mini view: the main window comes back as it was (maximized or not, same place), never nothing on screen
  function hideMini() {
    closeMini();
    if (win && !win.isDestroyed() && (!win.isVisible() || win.isMinimized())) showMain(null);
  }
  function toggleMini() { if (HIDDEN) return; if (local.miniOpen && miniIsOpen()) hideMini(); else openMini(); }
  function sendMiniOpen() {
    if (win && !win.isDestroyed()) win.webContents.send('fv:mini-open', !!local.miniOpen);
  }
  function miniChanged() { sendMiniOpen(); updateTrayMenu(); }

  // the page asks for the height its rows need; the width stays the user's. A mini view in the lower half
  // of its screen keeps its bottom edge and grows upward; one in the upper half keeps its top edge.
  function fitMini(h) {
    if (!mini || mini.isDestroyed() || !Number.isFinite(h) || h <= 0) return;
    const b = mini.getBounds();
    const a = screen.getDisplayMatching(b).workArea;
    const height = Math.round(Math.min(Math.max(h, MINI_MIN_H), a.height * 0.8));
    if (Math.abs(height - b.height) < 2) return;
    const lower = b.y + b.height / 2 > a.y + a.height / 2;
    const next = inside({ x: b.x, y: lower ? b.y + b.height - height : b.y, width: b.width, height });
    mini.setBounds(next);
  }

  // keep the mini view on a screen when screens come and go or change size
  function keepMiniOnScreen() {
    if (!mini || mini.isDestroyed()) return;
    const b = mini.getBounds();
    const next = isVisible(b) ? inside(b) : inside(miniDefault());
    if (!sameBounds(b, next)) mini.setBounds(next);
  }

  // ---------- Chats window (users see it as the Bots window) ----------
  // The Bots tab popped out (fleetDesktop.popChats): the same page as the main window's (?solo=chats shows only the
  // Bots tab), in a normal window of its own: frameless with the native buttons over the right end of the page's
  // 36 px header (as the main window's 44 px one), acrylic, resizable, no taskbar button of its own (Windows: the
  // taskbar shows Fleet View once, and the window can't be minimized), always on top when chatsOnTop. It does not
  // take turns with the main window the way the mini view does: both stay up. It saves its place (chatsBounds, plus
  // whether it was maximized), is put back on a screen when its old place is on none, and opens again at start-up
  // when it was open when the app quit (chatsOpen). Closing it docks it: chatsOpen false, and the main window comes
  // up (unless the mini view stands in for it). Quitting the app, or closing the main window (which quits it), closes
  // it but keeps chatsOpen, so it comes back next time. So does a close sent from outside (Windows: a bare WM_CLOSE,
  // see outsideClose below): it closes the whole app the way closing the main window does. When the app starts with
  // both windows, the Bots window ends up in front of the main one. Its page reaches live sessions through /live
  // (web/term.js).
  const CHATS_W = 440, CHATS_H = 720, CHATS_MIN_W = 340, CHATS_MIN_H = 420, CHATS_BAR_H = 36;
  let chatsSaveTimer = null;
  const chatsAlive = () => !!(chats && !chats.isDestroyed());
  const chatsPopped = () => !!local.chatsOpen && chatsAlive();
  // a new window: at the right of the main window's display, nearly its full height
  function chatsDefault() {
    const d = win && !win.isDestroyed() ? screen.getDisplayMatching(win.getBounds()) : screen.getPrimaryDisplay();
    const a = d.workArea;
    const width = Math.min(CHATS_W, a.width), height = Math.min(CHATS_H, a.height - 32);
    return { x: a.x + a.width - width - 16, y: a.y + Math.max(0, Math.round((a.height - height) / 2)), width, height };
  }
  function chatsStart() {
    const r = local.chatsBounds;
    if (okRect(r) && r.w >= CHATS_MIN_W && r.h >= CHATS_MIN_H) {
      const b = toBounds(r);
      if (isVisible(b)) return inside(b);
    }
    return chatsDefault();
  }
  // its restored (normal) place into local, as the main window's is kept (not while minimized)
  function keepChatsPlace() {
    if (!chatsAlive() || chats.isMinimized() || fullScreen(chats)) return;
    local.chatsBounds = toRect(chats.getNormalBounds());
    local.chatsMaximized = chats.isMaximized();
  }
  function saveChats() {
    clearTimeout(chatsSaveTimer);
    keepChatsPlace();
    writeLocal();
    const body = { chatsOpen: !!local.chatsOpen, chatsOnTop: !!local.chatsOnTop };
    if (okRect(local.chatsBounds)) body.chatsBounds = local.chatsBounds;
    postSettings(body);
  }
  function saveChatsSoon() { clearTimeout(chatsSaveTimer); chatsSaveTimer = setTimeout(saveChats, 800); }
  // Windows: tells a close Henry asked for from one sent from outside. The X (a native caption button: it hit-tests
  // as HTCLOSE) and Alt+F4 send WM_SYSCOMMAND SC_CLOSE, which then sends WM_CLOSE;
  // dockChats() ("Bring it back") closes the window without any WM_CLOSE. A WM_CLOSE with no SC_CLOSE just before it comes from another program:
  // Process.CloseMainWindow() when a desktop/ update restarts the window (Windows may hand it this window rather
  // than the main one) or taskkill without /f. Docking then would forget that Bots was popped out, so that close
  // closes the app instead. Returns () => true while the last WM_CLOSE was such a one (for 2 s).
  const WM_CLOSE = 0x0010, WM_SYSCOMMAND = 0x0112, SC_CLOSE = 0xF060;
  function outsideClose(w) {
    if (!P.isWin) return () => false;
    let sysAt = 0, bareAt = 0;
    try {
      // wParam arrives as a pointer-sized Buffer; the low 4 bits of a WM_SYSCOMMAND code are Windows' own
      w.hookWindowMessage(WM_SYSCOMMAND, (wp) => { try { if ((wp.readUInt32LE(0) & 0xFFF0) === SC_CLOSE) sysAt = Date.now(); } catch {} });
      w.hookWindowMessage(WM_CLOSE, () => { bareAt = Date.now() - sysAt > 1000 ? Date.now() : 0; });
    } catch (e) { hlog(`bots window close hook: ${e.message}`); }
    return () => bareAt > 0 && Date.now() - bareAt < 2000;
  }

  function createChats() {
    const want = chatsStart();
    chats = new BrowserWindow({
      ...want,
      minWidth: CHATS_MIN_W, minHeight: CHATS_MIN_H,
      title: 'Fleet View Bots',
      resizable: true,
      alwaysOnTop: !!local.chatsOnTop,
      backgroundColor: '#00000000',
      ...(P.isMac ? { vibrancy: 'under-window', visualEffectState: 'active', simpleFullscreen: true } : {
        icon: ICON,
        backgroundMaterial: 'acrylic',
        autoHideMenuBar: true,
        titleBarStyle: 'hidden',
        titleBarOverlay: { color: '#00000000', symbolColor: '#c9cee6', height: CHATS_BAR_H },
        // no taskbar button: Fleet View keeps one, the main window's (Alt+Tab still lists this window). With no
        // button to bring it back, it can't be minimized either.
        skipTaskbar: true, minimizable: false,
      }),
      show: false,
      webPreferences,
    });
    const w = chats;
    if (local.chatsOnTop) w.setAlwaysOnTop(true, 'floating');
    if (!sameBounds(w.getBounds(), want)) w.setBounds(want);
    leaveFullScreenWhenHidden(w);
    if (!HIDDEN) keepBlurWhenInactive(w);
    const wc = w.webContents;
    guardContents(wc, () => { if (!w.isDestroyed()) w.loadURL(CHATS_URL); });
    editMenu(w);
    wc.on('did-finish-load', () => sendChatsPopped());
    const fromOutside = outsideClose(w);
    let shown = false;
    const showIt = () => {
      if (shown || w.isDestroyed() || HIDDEN || !local.chatsOpen) return;
      shown = true;
      if (!sameBounds(w.getBounds(), want)) w.setBounds(want);
      if (local.chatsMaximized) w.maximize();
      w.show();
    };
    w.once('ready-to-show', showIt);
    setTimeout(showIt, 3000);
    w.on('move', saveChatsSoon);
    w.on('resize', saveChatsSoon);
    w.on('maximize', saveChatsSoon);
    w.on('unmaximize', saveChatsSoon);
    w.on('close', (e) => {
      clearTimeout(chatsSaveTimer);
      keepChatsPlace();
      // the app is quitting: it opens again at the next start, so chatsOpen stays
      if (quitting || quittingAll) { writeLocal(); return; }
      // closed from outside: the whole app goes (closing the main window quits it; this window closes again then,
      // with quitting set), and chatsOpen stays
      if (fromOutside()) {
        e.preventDefault();
        writeLocal();
        hlog('the Bots window was closed from outside: closing Fleet View, Bots opens popped out again next start');
        if (win && !win.isDestroyed()) win.close(); else { quitting = true; app.quit(); }
        return;
      }
      local.chatsOpen = false;
      saveChats();
      mainUp();
    });
    w.on('closed', () => { if (chats === w) chats = null; chatsChanged(); });
    w.on('page-title-updated', (e) => e.preventDefault()); // keep "Fleet View Bots"
    // Windows signing out or shutting down may reach this window first: that is quitting, never docking
    w.on('query-session-end', endingSession);
    w.on('session-end', endingSession);
    w.loadURL(CHATS_URL);
  }
  // after docking: the main window comes up, unless the mini view is standing in for it
  function mainUp() {
    if (local.miniOpen && miniIsOpen()) return;
    showMain(null);
  }
  function popChats() {
    local.chatsOpen = true;
    if (!chatsAlive()) createChats(); // shows itself once its page is ready
    else if (!HIDDEN) {
      if (chats.isMinimized()) chats.restore();
      if (!chats.isMaximized() && !isVisible(chats.getBounds())) chats.setBounds(inside(chatsDefault()));
      chats.show();
      chats.moveTop();
      chats.focus();
    }
    saveChats();
    chatsChanged();
  }
  function dockChats() {
    if (chatsAlive()) { chats.close(); return; } // its close handler docks it
    local.chatsOpen = false;
    saveChats();
    chatsChanged();
    mainUp();
  }
  function setChatsOnTop(on) {
    local.chatsOnTop = !!on;
    if (chatsAlive()) { if (on) chats.setAlwaysOnTop(true, 'floating'); else chats.setAlwaysOnTop(false); }
    saveChats();
  }
  function sendChatsPopped() {
    const v = chatsPopped();
    for (const w of [win, chats]) if (w && !w.isDestroyed() && !w.webContents.isDestroyed()) w.webContents.send('fv:chats-popped', v);
  }
  function chatsChanged() { sendChatsPopped(); updateTrayMenu(); }
  // keep it on a screen when screens come and go (a window still partly on one is left where it is)
  function keepChatsOnScreen() {
    if (!chatsAlive() || chats.isMaximized() || chats.isMinimized()) return;
    if (!isVisible(chats.getBounds())) chats.setBounds(inside(chatsDefault()));
  }

  // ---------- messages from the pages (preload.js) ----------
  // only from our own windows' top frames, on the local page
  function senderOk(e, onlyMini = false) {
    const wc = e.sender;
    const mine = (w) => !!(w && !w.isDestroyed() && wc === w.webContents);
    const ours = onlyMini ? mine(mini) : (mine(win) || mine(mini) || mine(chats));
    if (!ours) return false;
    if (e.senderFrame && e.senderFrame !== wc.mainFrame) return false;
    try { return new URL(wc.getURL()).origin === ORIGIN; } catch { return false; }
  }
  ipcMain.on('fv:toggle-mini', (e) => { if (senderOk(e)) toggleMini(); });
  ipcMain.on('fv:hide-mini', (e) => { if (senderOk(e)) hideMini(); });
  // an update changed desktop/ (updater.js): start the window again the way the Start menu does, after this one
  // quits (the server goes with it and comes back with the new one; the sessions live in the host and stay)
  // (macOS and Linux: the same binary with the same arguments)
  // (both the main window's page and the Chats window's may ask; only the first is acted on)
  let relaunching = false;
  ipcMain.on('fv:relaunch', (e) => {
    if (!senderOk(e) || relaunching) return;
    relaunching = true;
    if (P.isWin) app.relaunch({ execPath: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe'), args: ['//nologo', FV_VBS] });
    else app.relaunch();
    app.quit();
  });
  ipcMain.on('fv:show-main', (e, id) => { if (senderOk(e)) showMain(typeof id === 'string' ? id : null); });
  ipcMain.on('fv:fit-mini', (e, h) => { if (senderOk(e, true)) fitMini(Number(h)); });
  // the Chats window: pop it out (or show and focus it), dock it back, keep it on top
  ipcMain.on('fv:pop-chats', (e) => { if (senderOk(e)) popChats(); });
  ipcMain.on('fv:dock-chats', (e) => { if (senderOk(e)) dockChats(); });
  ipcMain.on('fv:chats-on-top', (e, on) => { if (senderOk(e) && typeof on === 'boolean') setChatsOnTop(on); });
  // the chat box's mic is on: the page keeps full speed while the window is behind another one or minimized
  // (Chromium otherwise slows a hidden page down, and the speech model on the GPU with it); off again after
  ipcMain.on('fv:keep-awake', (e, on) => {
    if (!pageSenderOk(e) || HIDDEN) return;
    try { e.sender.setBackgroundThrottling(!on); } catch {}
  });

  // live sessions: the main window's page only (never the mini view), on the local page, top frame
  function termSenderOk(e) {
    const wc = e.sender;
    if (!win || win.isDestroyed() || wc !== win.webContents) return false;
    if (e.senderFrame && e.senderFrame !== wc.mainFrame) return false;
    try { return new URL(wc.getURL()).origin === ORIGIN; } catch { return false; }
  }
  // the main window's page or the Chats window's (the same page): the folder picker and keep-awake
  function pageSenderOk(e) {
    const wc = e.sender;
    if (!((win && !win.isDestroyed() && wc === win.webContents) || (chats && !chats.isDestroyed() && wc === chats.webContents))) return false;
    if (e.senderFrame && e.senderFrame !== wc.mainFrame) return false;
    try { return new URL(wc.getURL()).origin === ORIGIN; } catch { return false; }
  }
  const validId = (id) => typeof id === 'string' && terms.ID_RE.test(id);
  // a hosted session's key: a conversation id, or new-<n> for a new one that has no id yet
  const validKey = (id) => typeof id === 'string' && terms.KEY_RE.test(id);
  // the folders a new session may start in: the repos and checkouts the server lists in /state
  function allowedFolders(st) {
    const out = new Set();
    const add = (p) => { if (typeof p === 'string' && p) out.add(termHost.normDir(p)); };
    for (const r of (st && st.repos) || []) add(r && r.root);
    for (const s of (st && st.sessions) || []) { add(s && s.repo && s.repo.root); add(s && s.links && s.links.repoFolder); }
    return out;
  }
  ipcMain.handle('fv:term-create', async (e, o) => {
    if (!termSenderOk(e)) throw new Error('not allowed');
    if (!o || typeof o !== 'object' || typeof o.cwd !== 'string' || !o.cwd || o.cwd.length > 1000) return { ok: false, message: 'no folder given' };
    const st = await new Promise((r) => getState(r));
    if (!st) return { ok: false, message: "Fleet View's server did not answer; try again" };
    const want = termHost.normDir(o.cwd);
    const allowed = allowedFolders(st);
    // a fork (forkFrom): a conversation /state lists, started in that conversation's own folder
    let forkFrom;
    if (o.forkFrom !== undefined) {
      if (!validId(o.forkFrom)) return { ok: false, message: 'bad conversation id' };
      const src = ((st && st.sessions) || []).find((x) => x && x.id === o.forkFrom);
      if (!src) return { ok: false, message: 'that conversation is not in the list' };
      if (typeof src.cwd === 'string' && src.cwd) allowed.add(termHost.normDir(src.cwd));
      forkFrom = o.forkFrom;
    }
    if (!allowed.has(want)) return { ok: false, message: 'that folder is not a repo Fleet View lists' };
    let isDir = false;
    try { isDir = fs.statSync(o.cwd).isDirectory(); } catch {}
    if (!isDir) return { ok: false, message: `the folder is gone: ${o.cwd}` };
    return terms.create({ cwd: o.cwd, account: acctId(o.account), cols: o.cols, rows: o.rows, forkFrom });
  });
  // "Add workspace…": the system folder picker, over the window that asked (the main or the Chats window). FV_TEST_PICK_FOLDER, honoured
  // only in a hidden test run (FV_TEST_HIDDEN=1), answers with that path instead of showing the dialog.
  // The server checks the folder again (POST /repos/add); this only picks it.
  let picking = false;
  ipcMain.handle('fv:pick-folder', async (e) => {
    if (!pageSenderOk(e)) throw new Error('not allowed');
    if (HIDDEN && process.env.FV_TEST_PICK_FOLDER) return { ok: true, path: process.env.FV_TEST_PICK_FOLDER };
    if (HIDDEN) return { ok: false, canceled: true };
    if (picking) return { ok: false, canceled: true, message: 'the folder picker is already open' };
    picking = true;
    try {
      const parent = BrowserWindow.fromWebContents(e.sender) || win;
      const r = await dialog.showOpenDialog(parent, { title: 'Add a workspace to Fleet View', properties: ['openDirectory'] });
      const p = !r.canceled && Array.isArray(r.filePaths) ? r.filePaths[0] : null;
      return p ? { ok: true, path: p } : { ok: false, canceled: true };
    } finally { picking = false; }
  });
  // the Preview tab's "Screenshot to chat": a PNG of this rectangle of the main window's page (CSS pixels, as
  // getBoundingClientRect gives them; the page's zoom is applied here, the screen's scale by capturePage)
  ipcMain.handle('fv:capture', async (e, r) => {
    if (!termSenderOk(e)) throw new Error('not allowed');
    if (!r || typeof r !== 'object' || !['x', 'y', 'width', 'height'].every((k) => Number.isFinite(r[k]))) return null;
    const wc = win.webContents;
    const z = wc.getZoomFactor() || 1;
    const [cw, ch] = win.getContentSize();
    const x = Math.max(0, Math.floor(r.x * z)), y = Math.max(0, Math.floor(r.y * z));
    const width = Math.min(cw - x, Math.ceil(r.width * z)), height = Math.min(ch - y, Math.ceil(r.height * z));
    if (width < 1 || height < 1) return null;
    const img = await wc.capturePage({ x, y, width, height });
    return img.isEmpty() ? null : img.toPNG();
  });
  // the right-click menu's frost (web/ctxmenu.js): over the acrylic, Chromium draws no backdrop-filter, so the menu
  // blurs a shot of the page instead. The whole page at a quarter size (it is only ever shown blurred), as a PNG.
  ipcMain.handle('fv:backdrop', async (e) => {
    if (!pageSenderOk(e)) throw new Error('not allowed');
    const img = await e.sender.capturePage();
    if (img.isEmpty()) return null;
    const { width } = img.getSize();
    return img.resize({ width: Math.max(1, Math.round(width / 4)), quality: 'good' }).toPNG();
  });
  ipcMain.handle('fv:term-open', (e, o) => {
    if (!termSenderOk(e)) throw new Error('not allowed');
    if (!o || typeof o !== 'object' || !validId(o.id)) throw new Error('bad conversation id');
    return terms.open({ id: o.id, cwd: typeof o.cwd === 'string' ? o.cwd : null, account: acctId(o.account), cols: o.cols, rows: o.rows });
  });
  ipcMain.handle('fv:term-send-to', (e, o) => {
    if (!termSenderOk(e)) throw new Error('not allowed');
    if (!o || typeof o !== 'object' || !validId(o.id)) throw new Error('bad conversation id');
    return terms.sendTo({ id: o.id, cwd: typeof o.cwd === 'string' ? o.cwd : null, account: acctId(o.account), cols: o.cols, rows: o.rows });
  });
  ipcMain.handle('fv:term-list', (e) => {
    if (!termSenderOk(e)) throw new Error('not allowed');
    return terms.list().catch(() => []);
  });
  // the snapshot comes back as a message on the same channel as the output (not as an invoke reply), so it
  // is ordered with it: output that arrived before it is in it, output after it is new. The host sends its
  // pending output before the snapshot, and terms.js hands both on in that order.
  ipcMain.on('fv:term-snapshot', (e, token, id) => {
    if (!termSenderOk(e) || !Number.isInteger(token)) return;
    const wc = e.sender;
    const reply = (text) => { if (!wc.isDestroyed()) wc.send('fv:term-snap', token, text); };
    if (validKey(id)) terms.snapshot(id, reply); else reply('');
  });
  ipcMain.on('fv:term-write', (e, id, data) => { if (termSenderOk(e) && validKey(id) && typeof data === 'string') terms.write(id, data); });
  ipcMain.on('fv:term-resize', (e, id, cols, rows) => { if (termSenderOk(e) && validKey(id)) terms.resize(id, Number(cols), Number(rows)); });
  ipcMain.on('fv:term-kill', (e, id) => { if (termSenderOk(e) && validKey(id)) terms.kill(id); });

  // ---------- tray ----------
  // the app icon (icon.js) without its tile, at 16 px and the larger sizes scaled screens use
  // macOS: a template image (black and alpha, 16 px and 32 px for Retina), which the menu bar tints itself
  function trayImage() {
    if (P.isMac) {
      const t = nativeImage.createFromBuffer(iconPng(16, { tile: false, template: true }), { scaleFactor: 1 });
      t.addRepresentation({ scaleFactor: 2, dataURL: `data:image/png;base64,${iconPng(32, { tile: false, template: true }).toString('base64')}` });
      t.setTemplateImage(true);
      return t;
    }
    const img = nativeImage.createFromBuffer(iconPng(16, { tile: false }), { scaleFactor: 1 });
    for (const [scale, size] of [[1.25, 20], [1.5, 24], [2, 32]]) {
      img.addRepresentation({ scaleFactor: scale, dataURL: `data:image/png;base64,${iconPng(size, { tile: false }).toString('base64')}` });
    }
    return img;
  }
  // the tray's items; macOS: also the Fleet View menu's (macMenu), where closing only hides the window
  function trayItems() {
    return [
      { label: 'Show Fleet View', click: () => showMain(null) },
      { label: 'Mini view', type: 'checkbox', checked: !!local.miniOpen && miniIsOpen(), click: (item) => (item.checked ? openMini() : hideMini()) },
      { label: 'Bots window', type: 'checkbox', checked: chatsPopped(), click: (item) => (item.checked ? popChats() : dockChats()) },
      { type: 'separator' },
      ...(remoteOn ? [{ label: 'Remote access is on (closing hides the window)', enabled: false }, { type: 'separator' }] : []),
      { label: remoteOn || P.isMac ? 'Hide window (Fleet View keeps running)' : 'Close window (sessions keep running)', click: () => { if (win && !win.isDestroyed()) win.close(); else app.quit(); } },
      ...(P.isMac ? [{ label: 'Quit the window (sessions keep running)', click: () => app.quit() }] : []),
      { label: 'Quit everything', click: () => { quitEverything(); } },
    ];
  }
  function updateTrayMenu() {
    if (P.isMac && !HIDDEN) Menu.setApplicationMenu(macMenu());
    if (!tray || tray.isDestroyed()) return;
    tray.setContextMenu(Menu.buildFromTemplate(trayItems()));
  }
  // macOS full screen, the simple (pre-Lion) kind: the window covers the screen on the Space it is on, the menu bar
  // and dock hide, and the desktop stays behind it, so the vibrancy keeps blending with it. The native kind (its
  // own Space) has nothing behind the window and the see-through page turns black. The windows' simpleFullscreen
  // option sends the green button the same way.
  const FULL_SCREEN = {
    label: 'Toggle Full Screen', accelerator: 'Ctrl+Cmd+F',
    click: (_item, w) => { if (w && !w.isDestroyed()) w.setSimpleFullScreen(!w.isSimpleFullScreen()); },
  };
  // in simple full screen getNormalBounds() reads the whole screen, so a window's place is not saved then
  const fullScreen = (w) => P.isMac && !!w && !w.isDestroyed() && w.isSimpleFullScreen();
  // a hidden or closed window leaves full screen, or the menu bar and dock it hid would stay hidden
  function leaveFullScreenWhenHidden(w) {
    if (!P.isMac) return;
    const out = () => { if (fullScreen(w)) w.setSimpleFullScreen(false); };
    w.on('hide', out);
    w.on('close', out);
  }
  // macOS: the application menu. The standard roles give Cmd+C / Cmd+V / Cmd+A in the page, Cmd+W, Cmd+M and
  // Cmd+Q; reload is Cmd+Shift+R as Ctrl+Shift+R on Windows (the page keeps Ctrl+R)
  function macMenu() {
    return Menu.buildFromTemplate([
      { label: 'Fleet View', submenu: [
        { role: 'about' }, { type: 'separator' },
        ...trayItems().filter((x) => x.type !== 'separator' && x.enabled !== false && !/^Show |^Quit the window/.test(x.label)),
        { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' },
        { role: 'quit', label: 'Quit Fleet View (sessions keep running)' },
      ] },
      { role: 'editMenu' },
      { label: 'View', submenu: [
        { role: 'reload', accelerator: 'CmdOrCtrl+Shift+R' }, { role: 'toggleDevTools', accelerator: 'Alt+CmdOrCtrl+I' }, { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, FULL_SCREEN,
      ] },
      { role: 'windowMenu' },
    ]);
  }
  let tipTimer = null, lastCounts = null;
  // the tooltip: the server's live and waiting counts, and the sessions the host runs for this window
  function updateTrayTip(hostOnly) {
    const show = () => {
      if (!tray || tray.isDestroyed()) return;
      const c = lastCounts, n = terms.aliveCount();
      const here = n ? ` · ${n} session${n === 1 ? '' : 's'} here` : '';
      const rem = remoteOn ? ' · remote on' : '';
      tray.setToolTip(c ? `Fleet View — ${c.live || 0} live, ${c.waiting || 0} waiting${here}${rem}` : `Fleet View — reconnecting${here}${rem}`);
    };
    if (hostOnly === true) return show();
    getState((st) => {
      lastCounts = (st && st.counts) || null;
      if (st && st.settings) setRemote(!!(st.settings.remote && st.settings.remote.enabled === true));
      show();
    });
  }
  function createTray() {
    try { tray = new Tray(trayImage()); } catch { tray = null; return; }
    tray.setToolTip('Fleet View');
    tray.on('click', () => showMain(null));
    updateTrayMenu();
    updateTrayTip();
    tipTimer = setInterval(updateTrayTip, 4000);
  }

  // Windows 11 drops the acrylic of an inactive window (flat grey). Each time the window loses focus, the
  // helper sends it WM_NCACTIVATE(TRUE), so DWM keeps drawing the backdrop as for an active window.
  // Real focus and keyboard input are untouched; only the caption is painted as active.
  let helper = null;
  function keepBlurWhenInactive(w) {
    if (process.platform !== 'win32') return;
    if (!helper) helper = backdrop.startHelper();
    if (!helper) return;
    const hwnd = backdrop.hwndOf(w);
    const keep = () => { if (!w.isDestroyed() && !w.isFocused()) helper.send(`nca ${hwnd}`); };
    w.on('blur', () => setTimeout(keep, 0));
    w.on('show', () => setTimeout(keep, 50));
    w.on('restore', () => setTimeout(keep, 50));
  }
  // Windows 11 corners on the frameless mini view (it usually has them already; this makes sure)
  function roundCorners(w) {
    if (process.platform !== 'win32' || w.isDestroyed()) return;
    if (!helper) helper = backdrop.startHelper();
    if (helper) helper.send(`round ${backdrop.hwndOf(w)}`);
  }
  app.on('will-quit', () => {
    fvServer.stop(); // the server it started goes with the app (a server started some other way is left alone)
    terms.close(); // the host and its sessions keep running
    clearInterval(tipTimer);
    if (awakeId !== null) { try { powerSaveBlocker.stop(awakeId); } catch {} awakeId = null; }
    if (tray && !tray.isDestroyed()) tray.destroy();
    tray = null;
    if (helper) helper.stop();
    helper = null;
  });

  // FV_TERM_SELFTEST: drive the live sessions from the page, report, quit (see selftest.js)
  function selfTest() {
    const st = require('./selftest');
    const { execFileSync } = require('child_process');
    const out = process.env.FV_TERM_SELFTEST_OUT || '';
    const log = (m) => { try { process.stdout.write(`[term-selftest] ${m}
`); } catch {} };
    log(`session host: ${terms.isConnected() ? `pid ${terms.info().pid}` : 'not connected'}`);
    const ps = (cmd) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    const ctx = {
      win, terms, mode: SELFTEST, log,
      quit: () => app.quit(),
      dialogAbort: () => dialogAbort,
      children: (pid) => { if (!P.isWin) return (P.processesSync() || []).filter((x) => x.ppid === Number(pid)).map((x) => ({ pid: x.pid, name: path.basename(x.command.split(' ')[0] || '') })); try { const v = JSON.parse(ps(`@(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${Number(pid)}' | Select-Object @{n='pid';e={$_.ProcessId}},@{n='name';e={$_.Name}}) | ConvertTo-Json -Compress`) || '[]'); return Array.isArray(v) ? v : [v]; } catch { return []; } },
      hidden: HIDDEN,
      miniPage: async () => {
        openMini();
        if (mini.webContents.isLoading()) await new Promise((r) => mini.webContents.once('did-finish-load', r));
        const v = await mini.webContents.executeJavaScript('typeof (window.fleetDesktop && window.fleetDesktop.term)', true);
        hideMini();
        return v;
      },
    };
    const go = () => st.run(ctx).then((results) => {
      const failed = results.filter((x) => !x.pass).length;
      log(`DONE ${results.length - failed}/${results.length} passed`);
      st.write(out, { host: terms.info() && terms.info().pid, electron: process.versions.electron, results });
      setTimeout(() => app.quit(), 300);
    }, (e) => {
      log(`ERROR ${e && e.stack}`);
      st.write(out, { error: String(e && e.stack) });
      terms.killAll().catch(() => {});
      setTimeout(() => app.quit(), 300);
    });
    win.webContents.once('did-finish-load', () => setTimeout(go, 1500));
  }

  // FV_TERM_SELFTEST only ever runs against a test host (FV_HOST_PIPE), never the real one
  if (SELFTEST && !process.env.FV_HOST_PIPE) { process.stdout.write('[term-selftest] needs FV_HOST_PIPE (a test host)\n'); app.exit(2); }

  // after the first page load: the conversation the panel showed last time, if the host still runs it
  function restoreSelection() {
    const ui = terms.info() && terms.info().ui;
    const id = ui && typeof ui.selectedId === 'string' ? ui.selectedId : null;
    if (!id || !terms.cached().some((x) => x.id === id && x.alive)) return;
    if (!win || win.isDestroyed()) return;
    const lit = JSON.stringify(id).replace(LINE_SEPS, (c) => `${BSLASH}u${c.charCodeAt(0).toString(16)}`);
    win.webContents.executeJavaScript(`window.fvSelect && window.fvSelect(${lit})`, true).catch(() => {});
  }

  app.whenReady().then(async () => {
    // the server belongs to the app: started hidden when nothing serves the port, stopped when the app quits
    if (!(await fvServer.ensure())) hlog(`the server on port ${PORT} did not answer yet; the page keeps retrying`);
    // the session host first, so the page finds its sessions on its first list()
    const ok = await terms.connect(10000);
    if (!ok) hlog('could not reach the session host; live sessions are off until it answers');
    // macOS: Fleet View's icon in the dock (an unpackaged Electron shows Electron's); a click on it brings the
    // window back
    if (P.isMac && app.dock) {
      if (HIDDEN) { try { app.dock.hide(); } catch {} } else {
        try { app.dock.setIcon(nativeImage.createFromBuffer(iconPng(256))); } catch {}
      }
      // (not before its first show, which places it first)
      app.on('activate', () => { if (!HIDDEN && !placing && win && !win.isDestroyed() && !win.isVisible()) showMain(null); });
    }
    create();
    win.webContents.once('did-finish-load', () => setTimeout(restoreSelection, 1500));
    if (HIDDEN) global.__fvTest = { quitEverything, closeWindow: () => { if (win && !win.isDestroyed()) win.close(); }, terms, popChats, dockChats, chatsWindow: () => chats };
    if (!HIDDEN) createTray();
    if (SELFTEST) selfTest();
    screen.on('display-removed', () => { keepMiniOnScreen(); keepChatsOnScreen(); });
    screen.on('display-metrics-changed', () => { keepMiniOnScreen(); keepChatsOnScreen(); });
    // the Chats window opens again when it was open when the app quit (main.js's own record; with none yet, the
    // server's settings below)
    if (local.chatsOpen === true) popChats();
    // the app starts on the main window; the mini view keeps only its place from last time (main.js's own
    // record first, else the server's settings)
    if (HIDDEN) return;
    if (local.miniOpen) { local.miniOpen = false; writeLocal(); }
    const chatsKnown = () => typeof local.chatsOpen === 'boolean' && okRect(local.chatsBounds) && typeof local.chatsOnTop === 'boolean';
    if (okRect(local.miniBounds) && chatsKnown()) return;
    let tries = 0;
    const ask = () => getState((st) => {
      const s = st && st.settings;
      if (!s) { if (++tries < 5) setTimeout(ask, 1500); return; }
      if (okRect(s.miniBounds) && !okRect(local.miniBounds)) local.miniBounds = s.miniBounds;
      // the Chats window's record, from the server when this profile has none (a new profile folder, an older main.js)
      if (okRect(s.chatsBounds) && !okRect(local.chatsBounds)) local.chatsBounds = s.chatsBounds;
      if (typeof local.chatsOnTop !== 'boolean' && typeof s.chatsOnTop === 'boolean') {
        local.chatsOnTop = s.chatsOnTop;
        if (chatsAlive() && s.chatsOnTop) chats.setAlwaysOnTop(true, 'floating');
      }
      if (typeof local.chatsOpen !== 'boolean') {
        local.chatsOpen = s.chatsOpen === true;
        if (local.chatsOpen && !chatsAlive()) popChats();
      }
      writeLocal();
    });
    ask();
  });
  // (macOS: the main window only hides until the app quits, so this comes only while it quits)
  app.on('window-all-closed', () => app.quit());
}
