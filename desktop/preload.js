// Fleet View desktop: the few things a page may ask of the window, exposed as window.fleetDesktop.
// Sandboxed with context isolation on: the page gets only these functions, never Node or ipcRenderer.
// Both windows (the main view and the mini view) load it; main.js checks every message's sender.
//   fleetDesktop.isDesktop       true (the page runs in the desktop window, not Edge or a browser)
//   fleetDesktop.toggleMini()    go into the mini view (the main window hides), or back out of it
//   fleetDesktop.showMain(id?)   bring the main window up (the mini view gives way) and focus it; with an id, pick that conversation
//                                (main.js calls the page's window.fvSelect(id))
//   fleetDesktop.hideMini()      leave the mini view: the main window comes back
//   fleetDesktop.fitMini(h)      mini view only: the height its content needs, in CSS pixels
//   fleetDesktop.onMiniChange(cb)  cb(open) now and whenever the mini view opens or closes
//   fleetDesktop.pickFolder() -> Promise<{ ok, path?, canceled? }>   main view only: the system folder picker
//                                ("Add workspace…"); the page then posts the path to the server (POST /repos/add)
//   fleetDesktop.pathForFile(file) -> string   main view only: where a dropped, picked or pasted File is on disk
//                                ('' when it has no file behind it, like a pasted screenshot); the chat box sends it
//   fleetDesktop.capture({ x, y, width, height }) -> Promise<Uint8Array|null>   main view only: a PNG of that part
//                                of the window (CSS pixels from getBoundingClientRect); the Preview tab's "Screenshot to chat"
//   fleetDesktop.onPreviewNav(cb(url)) -> unsubscribe   main view only: a preview frame (a local dev server's page
//                                in a frame of the page, see main.js previewFrames) went to url by itself
//   fleetDesktop.keepAwake(on)   main view only: true while the chat box's mic listens, so the page keeps full
//                                speed behind other windows (main.js turns Chromium's background slow-down off)
//   fleetDesktop.term            main view only (absent in the mini view): live Claude sessions hosted in the window
//     term.open({ id, cwd, account, cols?, rows? }) -> Promise<{ ok, message, pid? }>   starts the interactive
//         `claude --resume <id>` in a pty (rejects a bad id; cwd falls back to home; account: one letter, 'A', 'B', 'C', ...;
//         120x32 by default). Already running: ok without starting another. Ended: starts it again.
//     term.create({ cwd, account, cols?, rows? }) -> Promise<{ ok, message, key?, pid? }>   starts a new
//         conversation: the interactive `claude` (no --resume) in cwd, which must be a repo root or checkout
//         /state lists (main.js checks). forkFrom (a listed conversation's id) starts `claude --resume <id>
//         --fork-session` instead, in that conversation's folder: a new conversation with its history.
//         Keyed key ("new-<n>") until Claude Code writes its sessions/<pid>.json;
//         then onRekey fires and every call uses the conversation id instead
//     term.sendTo({ id, cwd, account, cols?, rows? }) -> Promise<{ ok, message, pid? }>   "Send to Claude A/B/C...":
//         ends its claude here if one runs, then resumes it under account with /handoff as the first prompt;
//         the handoff's pickup starts in its place under that account
//     term.write(id, data)  term.resize(id, cols, rows)
//     term.kill(id)         running: Ctrl+C twice, then (after 2.5 s) its whole process tree; onExit fires,
//                           then it is forgotten;
//                           ended: forgets it (the "Close" on the "Session ended" bar)
//     term.list() -> Promise<[{ id, pid, alive, exitCode|null, startedAt, pending, created, cwd, account,
//                           status, handoffFrom, pickingUp }]>   ended ones stay listed (alive false) until killed or opened again;
//                           pending: a new session still keyed new-<n>; created: started by create();
//                           status: "busy" / "idle" from its sessions/<pid>.json, null when unknown;
//                           a session that handed off (host.js, Handoffs) stays under its key while its pickup
//                           starts (pickingUp, no exit), then onRekey moves it to the new conversation;
//                           handoffFrom: the conversation it took over from
//     term.snapshot(id) -> Promise<string>   its last ~512 KB of output. Output and the snapshot arrive in
//                           order: while waiting for it, drop onData chunks for that id (they are in it), then
//                           write the snapshot and every later chunk
//     term.onData(cb(id, chunk)) / term.onExit(cb(id, code)) / term.onRekey(cb(oldKey, id))  -> unsubscribe function
'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const miniListeners = new Set();
let miniOpen = null;
ipcRenderer.on('fv:mini-open', (_e, open) => {
  miniOpen = !!open;
  for (const cb of miniListeners) { try { cb(miniOpen); } catch {} }
});

const dataListeners = new Set(), exitListeners = new Set(), rekeyListeners = new Set();
ipcRenderer.on('fv:term-data', (_e, id, chunk) => { for (const cb of dataListeners) { try { cb(id, chunk); } catch {} } });
ipcRenderer.on('fv:term-exit', (_e, id, code) => { for (const cb of exitListeners) { try { cb(id, code); } catch {} } });
ipcRenderer.on('fv:term-rekey', (_e, oldKey, id) => { for (const cb of rekeyListeners) { try { cb(oldKey, id); } catch {} } });
const snapWaits = new Map();
let snapToken = 0;
ipcRenderer.on('fv:term-snap', (_e, token, text) => {
  const done = snapWaits.get(token);
  if (done) { snapWaits.delete(token); done(typeof text === 'string' ? text : ''); }
});
const listen = (set) => (cb) => {
  if (typeof cb !== 'function') return () => {};
  set.add(cb);
  return () => { set.delete(cb); };
};
const term = {
  open: (o) => {
    const x = o && typeof o === 'object' ? o : {};
    return ipcRenderer.invoke('fv:term-open', {
      id: String(x.id || ''), cwd: typeof x.cwd === 'string' ? x.cwd : null, account: typeof x.account === 'string' && /^[a-z]$/i.test(x.account) ? x.account.toUpperCase() : 'B',
      cols: Number(x.cols) || undefined, rows: Number(x.rows) || undefined,
    });
  },
  sendTo: (o) => {
    const x = o && typeof o === 'object' ? o : {};
    return ipcRenderer.invoke('fv:term-send-to', {
      id: String(x.id || ''), cwd: typeof x.cwd === 'string' ? x.cwd : null, account: typeof x.account === 'string' && /^[a-z]$/i.test(x.account) ? x.account.toUpperCase() : 'B',
      cols: Number(x.cols) || undefined, rows: Number(x.rows) || undefined,
    });
  },
  create: (o) => {
    const x = o && typeof o === 'object' ? o : {};
    return ipcRenderer.invoke('fv:term-create', {
      cwd: typeof x.cwd === 'string' ? x.cwd : '', account: typeof x.account === 'string' && /^[a-z]$/i.test(x.account) ? x.account.toUpperCase() : 'B',
      cols: Number(x.cols) || undefined, rows: Number(x.rows) || undefined,
      ...(typeof x.forkFrom === 'string' ? { forkFrom: x.forkFrom } : {}),
    });
  },
  write: (id, data) => { if (typeof data === 'string' && data) ipcRenderer.send('fv:term-write', String(id), data); },
  resize: (id, cols, rows) => ipcRenderer.send('fv:term-resize', String(id), Math.floor(Number(cols)) || 0, Math.floor(Number(rows)) || 0),
  kill: (id) => ipcRenderer.send('fv:term-kill', String(id)),
  list: () => ipcRenderer.invoke('fv:term-list'),
  snapshot: (id) => new Promise((resolve) => {
    const token = ++snapToken;
    snapWaits.set(token, resolve);
    ipcRenderer.send('fv:term-snapshot', token, String(id));
  }),
  onData: listen(dataListeners),
  onExit: listen(exitListeners),
  onRekey: listen(rekeyListeners),
};
const pathForFile = (f) => { try { return webUtils.getPathForFile(f) || ''; } catch { return ''; } };
// the Preview tab: a screenshot of part of the window, and where its preview frame went
const capture = (r) => {
  const x = r && typeof r === 'object' ? r : {};
  return ipcRenderer.invoke('fv:capture', { x: Number(x.x), y: Number(x.y), width: Number(x.width), height: Number(x.height) })
    .then((png) => (png && png.byteLength ? new Uint8Array(png) : null), () => null);
};
const navListeners = new Set();
ipcRenderer.on('fv:preview-nav', (_e, url) => { if (typeof url === 'string') for (const cb of navListeners) { try { cb(url); } catch {} } });
// the mini view never gets it (main.js refuses it anyway)
const isMini = /\/mini\.html$/i.test(location.pathname);

contextBridge.exposeInMainWorld('fleetDesktop', {
  isDesktop: true,
  toggleMini: () => ipcRenderer.send('fv:toggle-mini'),
  showMain: (id) => ipcRenderer.send('fv:show-main', typeof id === 'string' ? id.slice(0, 200) : null),
  hideMini: () => ipcRenderer.send('fv:hide-mini'),
  relaunch: () => ipcRenderer.send('fv:relaunch'),
  fitMini: (h) => ipcRenderer.send('fv:fit-mini', Number(h) || 0),
  onMiniChange: (cb) => {
    if (typeof cb !== 'function') return () => {};
    miniListeners.add(cb);
    if (miniOpen !== null) { try { cb(miniOpen); } catch {} }
    return () => miniListeners.delete(cb);
  },
  ...(isMini ? {} : { term, pickFolder: () => ipcRenderer.invoke('fv:pick-folder'), pathForFile, capture, onPreviewNav: listen(navListeners), keepAwake: (on) => ipcRenderer.send('fv:keep-awake', !!on) }),
});
