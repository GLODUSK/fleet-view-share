// Live sessions: the real, interactive Claude Code session of a conversation, in the detail panel's Session tab.
//
// The desktop window (desktop/main.js) hosts a pseudo-terminal per conversation that runs `claude --resume <id>`
// (interactive, never headless) and keeps it alive across page and server reloads. The page reaches it only
// through window.fleetDesktop.term (desktop/preload.js):
//   term.open({ id, cwd, account }) -> Promise<{ ok, message, pid? }>   (ok without spawning when it already runs)
//   term.create({ cwd, account }) -> Promise<{ ok, message, key? }>   a new conversation (plain `claude`) in a
//                                     repo folder, keyed "new-<n>" until Claude Code reports its id (onRekey);
//                                     forkFrom: a fork of that conversation instead (claude --resume --fork-session)
//   term.write(id, data)  term.resize(id, cols, rows)  term.kill(id)
//   term.list() -> Promise<[{ id, pid, alive, exitCode|null, startedAt, pending, created, cwd, account, status,
//                             interrupted, waitingFor, autoContinue, slashPanel }]>   interrupted: resumed after Fleet
//                             View quit while it was mid-turn; waitingFor: what a 'waiting' session waits on ("dialog
//                             open", "approve …"); autoContinue: the host types "carry on" into it by itself once it
//                             has loaded; slashPanel: the "/" command whose panel is open ("/usage"; the host closes
//                             it after a minute left alone)
//   term.snapshot(id) -> Promise<string>          the last ~512 KB of output, replayed when a view attaches
//   term.onData(cb(id, chunk)) / term.onExit(cb(id, code)) / term.onRekey(cb(oldKey, id))  -> unsubscribe functions
// Edge and plain browsers have no fleetDesktop.term: the Session tab then says so and offers the usual
// "Open conversation" (a Windows Terminal tab) instead.
//
// Opening by itself: a click on a conversation (renderSessionPane's o.auto) starts its session here, unless a
// live claude process elsewhere has it open (/state's openElsewhere, ignored for the ones this window hosts):
// then the tab says so and offers "Open here anyway". Such a session is a preview until the user types or
// pastes into it; previews end (term.kill) when the panel moves to another conversation or closes. Arrow keys
// only show the tab ("press Enter"); Enter, a double-click or a button opens a session that stays.
//
// The terminal is xterm.js, vendored in vendor/xterm/ and loaded the first time a session is shown. One xterm
// per hosted conversation, kept while its pty exists, so switching between conversations keeps each one's
// screen and scrollback. Live output for a conversation with no xterm yet is dropped: the snapshot covers it
// when the view first attaches. Calm by rule: the cursor never blinks (cursorBlink off, and views.css stops a
// blinking cursor a program asks for), and there is no bell.
//
// The Chat tab (chat.js, compose.js) types into the same sessions without showing this terminal: ensureLive(s)
// starts one the way an explicit open does and waits until Claude is idle, and screenText(id) reads the rendered
// lines of its xterm buffer. A view the Session tab never showed is made off-screen for that, fed the snapshot and
// the live output like any other, and kept at the pty's size (the last size this page gave the pty, or a guess it
// then gives it), so its lines wrap where Claude's do. The Session tab later opens that same view.
// sendText(id, text) types a message into a running session and sends it (the bracketed paste, 300 ms, Enter),
// and interruptSession(id) presses Esc in it: orders.js and the right-click menus' orders use them.
//
// Test without the desktop host: ?fixture=1&fakeTerm=1 installs a fake fleetDesktop.term (installFakeTerm below)
// that echoes what you type and prints some coloured output. Nothing here runs without that query.

import { esc } from './cards.js';
import { icon } from './icons.js';

// a Claude account letter: one letter (A, B, C, ...), else B, the default login
const acctOf = (a) => (typeof a === 'string' && /^[a-z]$/i.test(a) ? a.toUpperCase() : 'B');

const ID_RE = /^[0-9a-f-]{36}$/i;
// a hosted session's key: a conversation id, or new-<n> for a new conversation that has no id yet
const KEY_RE = /^(?:[0-9a-f-]{36}|new-\d{1,9})$/i;
export const isNewKey = (id) => /^new-\d{1,9}$/.test(String(id || ''));

export function termApi() {
  const t = window.fleetDesktop && window.fleetDesktop.term;
  return t && typeof t.open === 'function' && typeof t.list === 'function' && typeof t.write === 'function' ? t : null;
}

// ---------- which conversations Fleet View hosts (term.list, every 2 s, and onExit at once) ----------
export const hosts = new Map(); // id -> { id, pid, alive, exitCode, startedAt, pending, created, cwd, account, status, interrupted,
//                                        waitingFor, autoContinue, slashPanel (null/false from an older host),
//                                        handoffFrom (it picked up a handoff of that conversation, desktop/host.js) }
const listeners = new Set();
const rekeyListeners = new Set();
// a new conversation was given its id: cb(oldKey, id), after this module has moved everything over
export function onRekey(cb) { rekeyListeners.add(cb); return () => rekeyListeners.delete(cb); }
let hostsKey = '', started = false;
// an exited session the user closed: hidden until a newer one (another startedAt) appears for that id
const dismissed = new Map(); // id -> startedAt
// Preview sessions: the panel opened them by itself (a click on a conversation) and nobody has typed into them
// yet. They end when the panel moves to another conversation or closes (endPreviews). A key or a paste in the
// terminal, or an explicit open (a button, Enter, a double-click), makes one a normal session that stays.
const preview = new Set();
// sessions being ended from here (they take up to ~4 s to quit): hidden from the hosted list meanwhile, and a
// few seconds after, while the server still sees their pid file ("open elsewhere" would be about ourselves)
const ending = new Map(); // id -> { startedAt, goneAt }
const ENDING_GRACE = 5000;
// the size this page last gave each pty (open, create, resize): an off-screen view takes it, so it wraps like Claude
const sizes = new Map(); // id -> { cols, rows }

const notify = () => { for (const f of listeners) { try { f(); } catch (e) { console.error(e); } } };
const hostKey = () => [...hosts.values()].map((p) => `${p.id}:${p.alive ? 1 : 0}:${p.exitCode}:${p.startedAt}:${preview.has(p.id) ? 1 : 0}:${p.status}:${p.pending ? 1 : 0}:${p.interrupted ? 1 : 0}:${p.autoContinue ? 1 : 0}:${p.waitingFor}:${p.slashPanel}`).sort().join('|');

function applyList(list) {
  hosts.clear();
  const listed = new Map();
  for (const p of Array.isArray(list) ? list : []) {
    if (!p || typeof p.id !== 'string' || !KEY_RE.test(p.id)) continue;
    listed.set(p.id, p.startedAt ?? 0);
    const e = ending.get(p.id);
    if (e && (e.startedAt == null || e.startedAt === (p.startedAt ?? 0))) continue;
    if (dismissed.has(p.id) && !p.alive && dismissed.get(p.id) === p.startedAt) continue;
    hosts.set(p.id, {
      id: p.id, pid: p.pid ?? null, alive: !!p.alive, exitCode: p.exitCode ?? null, startedAt: p.startedAt ?? 0,
      pending: !!p.pending, created: !!p.created, cwd: typeof p.cwd === 'string' ? p.cwd : null, account: acctOf(p.account),
      status: typeof p.status === 'string' ? p.status : null, interrupted: !!p.interrupted,
      waitingFor: typeof p.waitingFor === 'string' ? p.waitingFor.slice(0, 300) : null, autoContinue: !!p.autoContinue,
      slashPanel: typeof p.slashPanel === 'string' && /^\/[\w:-]{1,39}$/.test(p.slashPanel) ? p.slashPanel : null,
      handoffFrom: typeof p.handoffFrom === 'string' && ID_RE.test(p.handoffFrom) ? p.handoffFrom : null,
    });
  }
  const now = Date.now();
  for (const [id, e] of [...ending]) {
    if (listed.has(id) && (e.startedAt == null || listed.get(id) === e.startedAt)) continue;
    if (!e.goneAt) e.goneAt = now;
    else if (now - e.goneAt > ENDING_GRACE) ending.delete(id);
  }
  for (const id of [...preview]) if (hosts.has(id) && !hosts.get(id).alive) preview.delete(id); // it ended by itself
  for (const id of [...views.keys()]) if (!hosts.has(id)) disposeView(id);
  const key = hostKey();
  if (key !== hostsKey) { hostsKey = key; notify(); }
}

export async function refreshHosts() {
  const t = termApi();
  if (!t) return;
  let list;
  try { list = await t.list(); } catch { return; }
  applyList(list);
}

// starts the polling and the live wiring once; onChange runs whenever the hosted set or a state changes
export function watchHosts(onChange) {
  if (onChange) listeners.add(onChange);
  const t = termApi();
  if (!t || started) return;
  started = true;
  try { t.onData((id, chunk) => { const v = views.get(id); if (v && v.term && !v.replaying) v.term.write(chunk); }); } catch (e) { console.warn(e); }
  try {
    t.onExit((id, code) => {
      const h = hosts.get(id);
      if (h) { h.alive = false; h.exitCode = code ?? null; }
      hostsKey = hostKey();
      notify();
      refreshHosts();
    });
  } catch (e) { console.warn(e); }
  try { if (typeof t.onRekey === 'function') t.onRekey((oldKey, id) => rekeyLocal(oldKey, id)); } catch (e) { console.warn(e); }
  refreshHosts();
  setInterval(refreshHosts, 2000);
}

// a new conversation got its id: its entry, its terminal view and its marks move to the id
function rekeyLocal(oldKey, id) {
  if (typeof oldKey !== 'string' || typeof id !== 'string' || !ID_RE.test(id) || oldKey === id) return;
  const h = hosts.get(oldKey);
  if (h) { hosts.delete(oldKey); h.id = id; h.pending = false; hosts.set(id, h); }
  const v = views.get(oldKey);
  if (v) { views.delete(oldKey); v.id = id; views.set(id, v); }
  if (preview.delete(oldKey)) preview.add(id);
  if (dismissed.has(oldKey)) { dismissed.set(id, dismissed.get(oldKey)); dismissed.delete(oldKey); }
  if (ending.has(oldKey)) { ending.set(id, ending.get(oldKey)); ending.delete(oldKey); }
  if (sizes.has(oldKey)) { sizes.set(id, sizes.get(oldKey)); sizes.delete(oldKey); }
  for (const f of rekeyListeners) { try { f(oldKey, id); } catch (e) { console.error(e); } }
  hostsKey = hostKey();
  notify();
  refreshHosts();
}

// start a new conversation (plain `claude`) in a repo folder, or with forkFrom a fork of that conversation in its
// folder; resolves { ok, message, key }
export async function createSession({ cwd, account, cols, rows, forkFrom } = {}) {
  const t = termApi();
  if (!t || typeof t.create !== 'function') return { ok: false, message: 'new sessions need the Fleet View desktop window' };
  let r;
  try { r = await t.create({ cwd, account: acctOf(account), cols, rows, ...(forkFrom ? { forkFrom } : {}) }); } catch (e) { r = { ok: false, message: String(e?.message || e) }; }
  // a host from before forks would start a plain new conversation: it says forkFrom back when it forked
  if (forkFrom && r && r.ok && r.forkFrom !== forkFrom.toLowerCase()) {
    if (typeof r.key === 'string') { try { t.kill(r.key); } catch {} }
    return { ok: false, message: 'forking needs the newer session host: restart Fleet View once' };
  }
  if (!r || !r.ok || typeof r.key !== 'string') return r || { ok: false, message: 'could not start the session' };
  if (cols > 0 && rows > 0) sizes.set(r.key, { cols, rows });
  await refreshHosts();
  return r;
}

// "Send to Claude A/B": the host ends it here if it runs, and resumes it under `account` with /handoff; the
// handoff's pickup then takes its place there (host.js sendTo). Its terminal view starts over with the new process.
export async function sendToAccount(s, account, size = {}) {
  const t = termApi();
  if (!t || typeof t.sendTo !== 'function') return { ok: false, message: 'sending to the other account needs the Fleet View desktop window' };
  if (!s || !ID_RE.test(String(s.id || ''))) return { ok: false, message: 'not a conversation' };
  preview.delete(s.id);
  disposeView(s.id);
  let r;
  try { r = await t.sendTo({ id: s.id, cwd: s.cwd || null, account: acctOf(account), cols: size.cols, rows: size.rows }); } catch (e) { r = { ok: false, message: String(e?.message || e) }; }
  if (r && r.ok && size.cols > 0 && size.rows > 0) sizes.set(s.id, { cols: size.cols, rows: size.rows });
  await refreshHosts();
  return r || { ok: false, message: 'could not send it' };
}

// what its claude says it is doing: 'busy', 'idle', or null when unknown
export const hostStatus = (id) => (id && hosts.get(id)?.status) || null;

// end a hosted session on purpose (the context menu's "End session")
export function endSession(id) {
  if (!hosts.has(id)) return false;
  endHosted(id);
  hostsKey = hostKey();
  notify();
  return true;
}

export const isHosted = (id) => !!(id && hosts.get(id)?.alive);
export const isPreview = (id) => !!(id && preview.has(id) && hosts.get(id)?.alive);
// another claude process has it open: the server's flag, minus the processes this window runs (or just ended)
export const openElsewhere = (s) => !!(s && s.openElsewhere && !hosts.has(s.id) && !ending.has(s.id));

// the user typed or pasted into it (or opened it on purpose): it is theirs now, never ended by moving on
function keep(id) {
  if (!preview.delete(id)) return;
  hostsKey = hostKey();
  notify();
}
export const keepSession = keep;

// end one hosted session from here (the desktop asks claude to quit, then ends its process tree)
function endHosted(id) {
  const t = termApi();
  const h = hosts.get(id);
  preview.delete(id);
  ending.set(id, { startedAt: h ? h.startedAt : null, goneAt: 0 }); // null: not listed yet, any run of it
  try { t?.kill(id); } catch {}
  disposeView(id);
  hosts.delete(id);
}

// the panel moved on (another conversation, or closed): end every preview session but keepId's
export function endPreviews(keepId = null) {
  let n = 0;
  for (const id of [...preview]) if (id !== keepId) { endHosted(id); n++; }
  if (n) { hostsKey = hostKey(); notify(); }
}

// ---------- xterm.js, loaded on first use ----------
let xtermLoad = null;
function loadXterm() {
  if (!xtermLoad) {
    if (!document.querySelector('link[data-xterm]')) {
      const l = document.createElement('link');
      l.rel = 'stylesheet'; l.href = 'vendor/xterm/xterm.css'; l.dataset.xterm = '1';
      document.head.appendChild(l);
    }
    xtermLoad = Promise.all([import('./vendor/xterm/xterm.mjs'), import('./vendor/xterm/addon-fit.mjs')])
      .then(([x, f]) => ({ Terminal: x.Terminal, FitAddon: f.FitAddon }))
      .catch((e) => { xtermLoad = null; throw e; });
  }
  return xtermLoad;
}

const glass = () => document.documentElement.classList.contains('glass');
// the app's accents (app.css), a little softer for the normal colours so long runs of text stay readable
const PALETTE = {
  black: '#262b3d', red: '#ff5c6c', green: '#3fd88a', yellow: '#ffc24a', blue: '#71a9ff', magenta: '#a47bff', cyan: '#3fd8ff', white: '#c9cee3',
  brightBlack: '#6b7394', brightRed: '#ff8591', brightGreen: '#3dffa8', brightYellow: '#ffd47a', brightBlue: '#9cc3ff', brightMagenta: '#c4a6ff', brightCyan: '#8ae8ff', brightWhite: '#ffffff',
};
const termOptions = () => ({
  allowTransparency: glass(),
  cursorBlink: false,
  cursorStyle: 'block',
  fontFamily: '"Cascadia Mono", Consolas, monospace',
  fontSize: 13,
  lineHeight: 1.15,
  scrollback: 5000,
  convertEol: false,
  // the scrollbar's lane (xterm sizes it from the overview ruler); views.css draws a thin rounded thumb in it
  overviewRuler: { width: 12 },
  theme: {
    scrollbarSliderBackground: 'rgba(138, 146, 178, 0.22)',
    scrollbarSliderHoverBackground: 'rgba(63, 216, 255, 0.38)',
    scrollbarSliderActiveBackground: 'rgba(63, 216, 255, 0.6)',
    overviewRulerBorder: 'rgba(0, 0, 0, 0)',
    background: glass() ? 'rgba(0, 0, 0, 0)' : '#0a0c13',
    foreground: '#e6e9f5',
    cursor: '#3fd8ff',
    cursorAccent: '#0a0c13',
    selectionBackground: 'rgba(63, 216, 255, 0.25)',
    ...PALETTE,
  },
});

// ---------- one view (xterm) per hosted conversation ----------
const views = new Map(); // id -> { id, term, fit, wrap, opened, replaying }

function copyText(t) {
  if (!t) return;
  try { navigator.clipboard.writeText(t).catch(() => {}); } catch {}
}

async function ensureView(id) {
  let v = views.get(id);
  if (v) return v.ready;
  // fed: the snapshot was replayed into it (once, by whoever needed it first: the Session tab or screenText)
  v = { id, term: null, fit: null, wrap: document.createElement('div'), opened: false, replaying: true, fed: false, parsed: false };
  v.wrap.className = 'term-wrap';
  views.set(id, v);
  v.ready = (async () => {
    const { Terminal, FitAddon } = await loadXterm();
    if (views.get(v.id) !== v) return null;
    const term = new Terminal(termOptions());
    const fit = new FitAddon();
    term.loadAddon(fit);
    v.term = term; v.fit = fit;
    // v.id, not id: a new conversation's key becomes its id while the view lives
    term.onData((d) => { const t = termApi(); if (t && hosts.get(v.id)?.alive) t.write(v.id, d); });
    // the pty follows the view's size, once it settles (a panel resize fits on every frame; Claude redraws on each)
    let resizeTimer = null;
    term.onResize(({ cols, rows }) => {
      clearTimeout(resizeTimer);
      if (v.quietResize) return; // an off-screen view taking the size the pty already has
      resizeTimer = setTimeout(() => { const t = termApi(); if (t && hosts.get(v.id)?.alive) { try { t.resize(v.id, cols, rows); sizes.set(v.id, { cols, rows }); } catch {} } }, 90);
    });
    // a paste counts as typing (a preview session becomes the user's)
    v.wrap.addEventListener('paste', () => keep(v.id), true);
    wireReply(v);
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const ctrl = e.ctrlKey && !e.altKey && !e.metaKey;
      const k = e.key.toLowerCase();
      // Ctrl+C copies when text is selected (else it goes to Claude, which stops the turn); Ctrl+Shift+C copies
      if (ctrl && k === 'c' && (e.shiftKey || term.hasSelection())) { copyText(term.getSelection()); term.clearSelection(); e.preventDefault(); return false; }
      // any other key that reaches Claude is typing (modifier keys alone are not)
      if (!['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'NumLock', 'ScrollLock'].includes(e.key)) keep(v.id);
      // Ctrl+V / Ctrl+Shift+V: let the browser's paste reach xterm (bracketed paste); images go with Alt+V
      if (ctrl && k === 'v') return false;
      // Shift+Enter: a new line in the prompt, the way Claude Code reads Alt+Enter
      if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        const t = termApi();
        if (t && hosts.get(v.id)?.alive) t.write(v.id, '\x1b\r');
        e.preventDefault();
        return false;
      }
      return true;
    });
    return v;
  })();
  return v.ready;
}

// ---------- Reply: select text in the terminal, quote it into Claude's prompt ----------
// Selecting (drag, double-click a word, triple-click a line) shows a small Reply button by the mouse. A click
// pastes the selection into the prompt as "> " lines plus a new line, so you type your answer under it; nothing
// is sent until you press Enter. It goes as a bracketed paste (term.paste), so the new lines don't submit.

// the selection as a quote: trailing spaces and blank edge lines gone, the common indent removed, and Claude
// Code's own line marks (● and ⎿) dropped from the start of a line
export function quoteSelection(text) {
  let lines = String(text || '').replace(/ /g, ' ').split(/\r?\n/).map((l) => l.replace(/\s+$/, ''));
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (!lines.length) return '';
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
  lines = lines.map((l) => l.slice(indent).replace(/^[●⎿]\s+/, ''));
  return lines.map((l) => (l ? `> ${l}` : '>')).join('\n') + '\n';
}

function wireReply(v) {
  const term = v.term;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'term-reply';
  btn.hidden = true;
  btn.title = 'Quote the selection into the prompt and reply to it';
  btn.innerHTML = `${icon('reply', 13)}<span>Reply</span>`;
  v.wrap.appendChild(btn);
  const hide = () => { btn.hidden = true; };
  const showAt = (x, y) => {
    const r = v.wrap.getBoundingClientRect();
    btn.hidden = false;
    const bw = btn.offsetWidth || 72, bh = btn.offsetHeight || 26;
    let left = x - r.left + 8, top = y - r.top + 14;
    if (top + bh > r.height) top = y - r.top - bh - 10;
    btn.style.left = `${Math.max(0, Math.min(r.width - bw, left))}px`;
    btn.style.top = `${Math.max(0, Math.min(r.height - bh, top))}px`;
  };
  // a press in the terminal starts a new selection (or clears it); the release shows the button if text is selected
  v.wrap.addEventListener('mousedown', (e) => { if (e.target !== btn && !btn.contains(e.target)) hide(); });
  v.wrap.addEventListener('mouseup', (e) => {
    if (e.button !== 0 || btn.contains(e.target)) return;
    const { clientX, clientY } = e;
    setTimeout(() => { if (term.hasSelection() && term.getSelection().trim()) showAt(clientX, clientY); }, 0);
  });
  term.onSelectionChange(() => { if (!term.hasSelection()) hide(); });
  term.onScroll(hide);
  v.wrap.addEventListener('wheel', hide, { passive: true });
  // keep the selection (and the keyboard where it is) through the press
  btn.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const quote = quoteSelection(term.getSelection());
    hide();
    term.clearSelection();
    const t = termApi();
    if (!quote || !t || !hosts.get(v.id)?.alive) return;
    keep(v.id); // replying is typing: a preview session becomes the user's
    term.focus();
    term.paste(quote);
  });
}

function disposeView(id) {
  const v = views.get(id);
  views.delete(id);
  if (!v) return;
  v.wrap.remove();
  try { v.term && v.term.dispose(); } catch {}
}

// replay the buffered output once, then live chunks (dropped while the snapshot is on its way: they are in it,
// since the host answers the snapshot and sends data over the same ordered channel)
// v.parsed: xterm has drawn the snapshot (it parses a write in slices, later): only then is its screen readable
async function replay(v) {
  const t = termApi();
  v.replaying = true;
  v.parsed = false;
  let snap = '';
  try { snap = (t && (await t.snapshot(v.id))) || ''; } catch {}
  if (snap) {
    let done = false;
    const mark = () => { if (!done) { done = true; v.parsed = true; } };
    try { v.term.write(snap, mark); } catch { mark(); }
  } else v.parsed = true;
  v.replaying = false;
}

// ---------- the Session tab ----------
// pane: the tab's element; s: the conversation; o: { ui, visible, onOpened(), auto }
// o.auto, once per pick: 'preview' (a click: start it unless another window has it, as a preview session),
// 'explicit' (Enter, a double-click: the same, kept; a preview already running becomes a kept one), or null
export function renderSessionPane(pane, s, o) {
  if (!pane._built) buildPane(pane);
  pane._s = s;
  pane._o = { ...o, auto: null }; // a pick acts once; later redraws only draw
  const t = termApi();
  const h = t ? hosts.get(s.id) : null;
  if (pane._id !== s.id) {
    pane._id = s.id;
    pane._err = '';
    if (!pane._opening || pane._opening.id !== s.id) pane._opening = null;
  }
  if (h && pane._opening && pane._opening.id === s.id) pane._opening = null;
  if (t && o.auto) {
    if (h && h.alive) { if (o.auto === 'explicit') { keep(s.id); pane._focusNext = s.id; } }
    else if (pane._opening?.id === s.id) { if (o.auto === 'explicit') pane._opening.explicit = true; } // a double-click: the first click is starting it
    else if (!h && !pane._opening && !openElsewhere(s)) { openHere(pane, s, o.auto === 'preview'); return; }
  }
  const mode = !t ? 'nodesk' : h ? 'term' : 'open';
  pane.dataset.mode = mode;

  // the card (no desktop host, or not hosted yet)
  const cardHtml = mode === 'nodesk' ? noDeskHtml()
    : mode === 'open' ? openHtml(s, pane)
      : '';
  if (pane._cardHtml !== cardHtml) { pane._card.innerHTML = cardHtml; pane._cardHtml = cardHtml; }
  pane._card.hidden = mode === 'term';
  pane._termBox.hidden = mode !== 'term';

  if (mode !== 'term') { unmount(pane); return; }
  const ended = !h.alive;
  // resumed after Fleet View quit (or the PC restarted) while Claude was mid-turn: one quiet line until it works again
  // (with autoContinue the host types the "carry on" itself, so the line says that instead of asking for it)
  const bar = ended ? `<span class="s-end-t">${icon('error', 14)}<span>Session ended${h.exitCode != null ? ` (code ${esc(h.exitCode)})` : ''}</span></span>`
    + '<span class="grow"></span><button type="button" class="btn s-btn" data-s="reopen">Reopen</button><button type="button" class="btn s-btn" data-s="dismiss">Close</button>'
    : h.interrupted ? `<span class="s-end-t s-int-t"><span>Was interrupted when Fleet View closed — ${h.autoContinue ? 'it carries on by itself once it has loaded' : 'tell it to continue'}</span></span>` : '';
  if (pane._barHtml !== bar) { pane._bar.innerHTML = bar; pane._barHtml = bar; }
  pane._bar.hidden = !bar;
  pane._termBox.classList.toggle('ended', ended);
  if (o.visible) mount(pane, s.id);
}

function noDeskHtml() {
  return `<div class="s-card"><div class="s-ic">${icon('shell', 20)}</div><div class="s-title">Live sessions need the Fleet View desktop window</div>`
    + '<div class="s-text">In the desktop window this tab runs the conversation itself, live, and you can type into it here. In this window, open it in Windows Terminal instead.</div>'
    + `<div class="s-actions"><button type="button" class="btn primary d-open-btn" data-open>${icon('open', 15)}<span>Open conversation</span></button></div></div>`;
}

function openHtml(s, pane) {
  if (pane._opening) {
    return `<div class="s-card"><div class="s-ic">${icon('shell', 20)}</div><div class="s-title">Starting the session…</div>`
      + `<div class="s-text mono">claude --resume ${esc(s.id.slice(0, 8))}…</div></div>`;
  }
  const where = s.cwd || '';
  const whereHtml = where ? `<div class="s-where"><span class="s-k">${icon('folder', 13)}<span>in</span></span><span class="s-v mono">${esc(where)}</span></div>` : '';
  const errHtml = pane._err ? `<div class="s-err">${icon('error', 14)}<span>${esc(pane._err)}</span></div>` : '';
  if (openElsewhere(s)) {
    // a terminal (or another Claude window) has it open right now: say where, open here only on purpose
    return `<div class="s-card s-elsewhere"><div class="s-ic">${icon('shell', 20)}</div><div class="s-title">Open in another window</div>`
      + `<div class="s-text">A Claude Code window has this conversation open right now. Type into it there: look for the terminal tab named <b>${esc(s.name)}</b>`
      + `${/^[A-Z]$/.test(s.account || '') ? ` (account ${esc(s.account)})` : ''}. Opening it here as well runs a second copy, and both write to the same log.</div>`
      + whereHtml + errHtml
      + `<div class="s-actions"><button type="button" class="btn s-go" data-s="open-anyway">${icon('shell', 15)}<span>Open here anyway</span></button></div></div>`;
  }
  return `<div class="s-card"><div class="s-ic">${icon('shell', 20)}</div><div class="s-title">Press Enter to open the session</div>`
    + '<div class="s-text">Runs the real Claude Code session in this panel: the same one a terminal shows, live, and you type into it here. Clicking a conversation opens it straight away.</div>'
    + whereHtml + errHtml
    + `<div class="s-actions"><button type="button" class="btn primary s-go" data-s="open">${icon('shell', 15)}<span>Open here</span></button></div></div>`;
}

function buildPane(pane) {
  pane.innerHTML = '<div class="s-cardbox"></div><div class="s-term" hidden><div class="s-bar" hidden></div><div class="term-host"></div></div>';
  pane._card = pane.querySelector('.s-cardbox');
  pane._termBox = pane.querySelector('.s-term');
  pane._bar = pane.querySelector('.s-bar');
  pane._host = pane.querySelector('.term-host');
  pane._built = true;
  pane.addEventListener('click', (e) => {
    const b = e.target.closest('[data-s]');
    if (!b) {
      // a click anywhere on the terminal area types into it
      if (e.target.closest('.term-host')) pane._mounted?.term?.focus();
      return;
    }
    const s = pane._s;
    if (!s) return;
    const act = b.dataset.s;
    // a button is an explicit open: the session stays when the panel moves on
    if (act === 'open' || act === 'open-anyway') openHere(pane, s, false);
    else if (act === 'reopen') reopen(pane, s);
    else if (act === 'dismiss') dismiss(pane, s);
  });
  const ro = new ResizeObserver(() => { cancelAnimationFrame(pane._fitRaf); pane._fitRaf = requestAnimationFrame(() => fitMounted(pane)); });
  ro.observe(pane._host);
}

const rerender = (pane) => { if (pane._s) renderSessionPane(pane, pane._s, pane._o || {}); };

// cols and rows for a pty about to start, from the space the terminal will get (fit corrects it once shown)
function guessSize(pane) {
  const r = pane.getBoundingClientRect();
  const cols = Math.floor((r.width - 20) / 7.83), rows = Math.floor((r.height - 12) / 17);
  return { cols: Math.max(40, Math.min(400, cols || 120)), rows: Math.max(10, Math.min(200, rows || 32)) };
}

// asPreview: opened by a click on the conversation (ends when the panel moves on unless the user types);
// otherwise an explicit open, which stays and takes the keyboard
async function openHere(pane, s, asPreview = false) {
  const t = termApi();
  if (!t || pane._opening) return;
  pane._err = '';
  pane._opening = { id: s.id, t: Date.now() };
  rerender(pane);
  const r = await startPty(s, guessSize(pane), () => pane._opening?.id === s.id);
  if (r === null) return; // the panel moved on while an earlier run of it was still ending
  if (pane._opening?.id !== s.id) {
    // the panel moved on while it started: a preview nobody saw is ended at once
    if (asPreview && r && r.ok) { preview.add(s.id); endPreviews(pane._id); }
    return;
  }
  if (!r || !r.ok) {
    pane._opening = null;
    pane._err = (r && r.message) || 'could not start the session';
    rerender(pane);
    return;
  }
  dismissed.delete(s.id);
  ending.delete(s.id);
  if (pane._opening.explicit) asPreview = false;
  if (asPreview) preview.add(s.id);
  else { preview.delete(s.id); pane._focusNext = s.id; } // the terminal takes the keyboard once it shows
  await refreshHosts();
  // not listed yet: try again shortly, and give up waiting after 6 s
  if (!hosts.has(s.id)) {
    setTimeout(() => { refreshHosts().then(() => { if (pane._opening?.id === s.id && !hosts.has(s.id)) { pane._opening = null; pane._err = 'the session did not start'; rerender(pane); } }); }, 6000);
  }
  pane._o?.onOpened?.(s.id);
  rerender(pane);
}

// Start the pty of a conversation (term.open, which attaches when it already runs): first let a run of it this
// window is still ending go (moved away and straight back), or open() finds it running. stillWanted() is asked
// after that wait; null when it says no. Resolves term.open's { ok, message, pid? }.
async function startPty(s, { cols, rows }, stillWanted = () => true) {
  const t = termApi();
  for (let i = 0; i < 40 && ending.get(s.id) && !ending.get(s.id).goneAt; i++) {
    await new Promise((r) => setTimeout(r, 150));
    await refreshHosts();
  }
  if (!stillWanted()) return null;
  let r = null;
  try { r = await t.open({ id: s.id, cwd: s.cwd || null, account: acctOf(s.account), cols, rows }); } catch (e) { r = { ok: false, message: String(e?.message || e) }; }
  if (r && r.ok) sizes.set(s.id, { cols, rows });
  return r;
}

// ---------- for the Chat tab: start a session without the Session tab, and read its screen ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const starting = new Map(); // id -> the ensureLive promise on its way, so two sends start it once
const READY_MS = 60000, SETTLE_MS = 1000;

// Make sure the conversation runs here, ready for typing: a live one is kept (sending is typing, so a preview
// becomes the user's); one that isn't hosted starts like an explicit open (it stays), and one that ended starts
// again (like Reopen). Then it waits until Claude says it is idle (at most 60 s) and a second more, so the
// prompt is drawn before anything is pasted into it. o.sizeEl: the element to size a new pty from; o.onStep(text)
// hears what it is doing. Resolves { ok, started, message? }.
export function ensureLive(s, o = {}) {
  const t = termApi();
  if (!t) return Promise.resolve({ ok: false, message: 'Sending needs the desktop window' });
  if (!s || !KEY_RE.test(String(s.id || ''))) return Promise.resolve({ ok: false, message: 'not a conversation' });
  const h = hosts.get(s.id);
  if (h?.alive) { keep(s.id); return Promise.resolve({ ok: true, started: false }); }
  if (starting.has(s.id)) return starting.get(s.id);
  if (!ID_RE.test(s.id)) return Promise.resolve({ ok: false, message: 'this new session has ended' });
  const step = (x) => { try { o.onStep?.(x); } catch {} };
  const p = (async () => {
    if (h && !h.alive) {
      try { await t.kill(s.id); } catch {}
      disposeView(s.id);
      hosts.delete(s.id);
      hostsKey = hostKey();
      notify(); // a Session tab showing the ended one lets go of its disposed view
    }
    step('Starting session…');
    const r = await startPty(s, o.sizeEl ? guessSize(o.sizeEl) : sizes.get(s.id) || { cols: 120, rows: 32 });
    if (!r || !r.ok) return { ok: false, message: (r && r.message) || 'could not start the session' };
    dismissed.delete(s.id);
    ending.delete(s.id);
    preview.delete(s.id); // started on purpose: it stays
    await refreshHosts();
    notify();
    // ready when Claude reports idle; a host that reports no status at all gets 20 s to draw its prompt
    const t0 = Date.now();
    for (;;) {
      const x = hosts.get(s.id);
      if (x && !x.alive) return { ok: false, message: 'the session ended while starting' };
      if (x?.alive && (x.status === 'idle' || (x.status == null && Date.now() - t0 > 20000))) break;
      if (Date.now() - t0 > READY_MS) return { ok: false, message: 'the session did not get ready within 60 s' };
      await sleep(500);
      await refreshHosts();
    }
    step('');
    await sleep(SETTLE_MS);
    return { ok: true, started: true };
  })().finally(() => starting.delete(s.id));
  starting.set(s.id, p);
  return p;
}
export const isStarting = (id) => starting.has(id);

// A panel open in a hosted session (/usage, /config: its claude waits on "dialog open") would take typed text.
// One a "/" command opened (the host's slashPanel) gets Esc, as the host itself does after a minute left alone,
// and this waits until the host's list says it closed; any other (a startup dialog: Esc could refuse it) is left
// to you. An older host sends no waitingFor: nothing to do. -> null when none is open (any more), else why text
// can't go in. The compose box and sendText call it before they type.
const PANEL_CLOSE_WAIT_MS = 4000; // the host re-reads the pid files every 800 ms
export async function closePanel(id) {
  const open = () => { const h = hosts.get(id); return !!(h?.alive && h.status === 'waiting' && h.waitingFor === 'dialog open'); };
  if (!open()) return null;
  const cmd = hosts.get(id).slashPanel;
  if (!cmd) return 'A panel is open in that session (like /usage): close it first';
  try { termApi().write(id, '\x1b'); } catch (e) { return String(e?.message || e); }
  for (const end = Date.now() + PANEL_CLOSE_WAIT_MS; Date.now() < end;) {
    await sleep(250);
    await refreshHosts();
    if (!open()) return null;
  }
  return `The ${cmd} panel is still open: close it in the Session tab first`;
}

// The writes that type text into Claude Code's prompt as the user's own words: each line as bracketed pastes
// (ESC[200~ text ESC[201~) of at most PASTE_MAX characters (never splitting a surrogate pair), Alt+Enter (a new
// line in the prompt) between lines. Claude Code wraps a paste of several lines, or a long one, in
// <pasted_content> tags, which tell the model the text is not the user's own request; pieces this small stay
// plain. Kept in step with api.js pasteWrites.
const PASTE_MAX = 400, PASTE_GAP_MS = 40;
export function pasteWrites(text) {
  const out = [];
  String(text).split('\n').forEach((line, x) => {
    if (x) out.push('\x1b\r');
    for (let i = 0; i < line.length;) {
      let j = Math.min(line.length, i + PASTE_MAX);
      if (j < line.length && /[\ud800-\udbff]/.test(line[j - 1])) j--;
      out.push(`\x1b[200~${line.slice(i, j)}\x1b[201~`);
      i = j;
    }
  });
  return out;
}
// Write pasteWrites(text) with write(data) (false: it could not), PASTE_GAP_MS apart: an Alt+Enter Claude Code
// reads in one chunk with the pastes around it is lost. -> true when every write went
export async function typeInto(write, text) {
  for (const [x, w] of pasteWrites(text).entries()) {
    if (x) await sleep(PASTE_GAP_MS);
    if (write(w) === false) return false;
  }
  return true;
}

// Type a message into a hosted session and send it, the way the compose box and api.js do: typeInto, 300 ms,
// then Enter on its own. Control characters other than new lines and tabs are dropped first, so nothing can end
// a paste early or press a key.
// The session must already run here (ensureLive first). Typing makes a preview session the user's.
// Resolves { ok, message?, menu? }. Used by orders.js (orders, team messages, notes to a conversation).
// o.beforeEnter: a check just before the Enter (async is fine); when it answers true the Enter is not sent and
// the result is { ok: false, menu: true }: a menu came up, and Enter would have picked its highlighted option.
export const SEND_ENTER_MS = 300;
export async function sendText(id, text, o = {}) {
  const t = termApi();
  if (!t) return { ok: false, message: 'Sending needs the desktop window' };
  if (!id || !hosts.get(id)?.alive) return { ok: false, message: 'it is not running here' };
  const msg = String(text ?? '').replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').trim();
  if (!msg) return { ok: false, message: 'nothing to send' };
  try {
    const panel = await closePanel(id);
    if (panel) return { ok: false, message: panel };
    await typeInto((w) => t.write(id, w), msg);
    await sleep(SEND_ENTER_MS);
    if (!hosts.get(id)?.alive) return { ok: false, message: 'the session ended before Enter' };
    if (o.beforeEnter && await o.beforeEnter()) {
      keep(id);
      return { ok: false, menu: true, message: 'Claude started asking something before Enter: the text is in its prompt box, not sent' };
    }
    t.write(id, '\r');
  } catch (e) { return { ok: false, message: String(e?.message || e) }; }
  keep(id);
  return { ok: true };
}
// Esc into a hosted session (the compose box's Stop): Claude stops the step it is on. false when it isn't here.
export function interruptSession(id) {
  const t = termApi();
  if (!t || !id || !hosts.get(id)?.alive) return false;
  try { t.write(id, '\x1b'); } catch { return false; }
  keep(id);
  return true;
}

// The rendered lines of a hosted session's screen, the last lastN of them (soft-wrapped rows joined, blank rows at
// the bottom dropped), as Claude drew them: what the Chat tab reads for the spinner and the mode. o.rows: the rows
// as drawn, not joined, for menus (Claude Code pads a menu's rows to the full width, which ConPTY then marks as
// wrapped, and joined they'd hide its options: "❯ 1. Yes      Some description   2. No" on one line). [] until
// its view holds the screen: the first call makes the view off-screen (o.sizeEl sizes it when this page never
// sized its pty) and feeds it the snapshot, so call it again on the next poll.
const preparing = new Set();
export function screenText(id, lastN = 40, o = {}) {
  if (!id || !hosts.get(id)?.alive) return [];
  const v = views.get(id);
  if (!v || !v.term || !v.fed) { prepareView(id, o.sizeEl); return []; }
  if (v.replaying || !v.parsed) return [];
  const b = v.term.buffer.active;
  const out = [];
  for (let y = Math.max(0, b.length - lastN * 3 - 10); y < b.length; y++) {
    const line = b.getLine(y);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && out.length && !o.rows) out[out.length - 1] += text; else out.push(text);
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.slice(-lastN);
}
// screenText with what is drawn on a coloured background (or inverse) marked: such a run of a line reads
// "\x01text\x02". A command's panel draws its selected tab that way ("Settings  Status  [Usage]  Stats"), which
// plain text loses. Rows stay as drawn, not joined: a panel fills each row to the edge, which the terminal flags
// as wrapped. [] when screenText would be.
export function screenMarked(id, lastN = 40) {
  if (!screenReady(id)) return [];
  const b = views.get(id).term.buffer.active;
  const cell = b.getNullCell();
  const out = [];
  for (let y = Math.max(0, b.length - lastN - 10); y < b.length; y++) {
    const line = b.getLine(y);
    if (!line) continue;
    let text = '', on = false;
    for (let x = 0; x < line.length; x++) {
      if (!line.getCell(x, cell) || !cell.getWidth()) continue; // the second half of a wide character
      const hl = !cell.isBgDefault() || !!cell.isInverse();
      if (hl !== on) { text += hl ? '\x01' : '\x02'; on = hl; }
      text += cell.getChars() || ' ';
    }
    if (on) text += '\x02';
    out.push(text.replace(/\s+$/, ''));
  }
  while (out.length && !out[out.length - 1].replace(/[\x01\x02]/g, '').trim()) out.pop();
  return out.slice(-lastN);
}
// screenText reads the real screen now: the view was fed its snapshot and xterm has drawn it
export function screenReady(id) {
  const v = id ? views.get(id) : null;
  return !!(v && v.term && v.fed && !v.replaying && v.parsed && hosts.get(id)?.alive);
}
// a pty shorter than rows gets that many (its view resizes, and the pty follows it): a list such as /rewind's
// has no room for its ❯ on a screen started from a small split slice. -> true when it grew
export function growRows(id, rows) {
  const v = id ? views.get(id) : null;
  if (!v || !v.term || !hosts.get(id)?.alive || v.term.rows >= rows) return false;
  v.term.resize(v.term.cols, rows);
  return true;
}

async function prepareView(id, sizeEl) {
  if (preparing.has(id)) return;
  preparing.add(id);
  try {
    const v = await ensureView(id);
    if (!v || views.get(id) !== v || v.fed) return;
    if (!v.opened) {
      // the pty's size when this page gave it one (then nothing is sent), else a guess the pty then takes
      const known = sizes.get(id);
      const { cols, rows } = known || (sizeEl ? guessSize(sizeEl) : { cols: 120, rows: 32 });
      v.quietResize = !!known;
      try { v.term.resize(cols, rows); } finally { v.quietResize = false; }
    }
    v.fed = true;
    await replay(v);
  } catch (e) { console.warn(e); } finally { preparing.delete(id); }
}

async function reopen(pane, s) {
  const t = termApi();
  if (!t) return;
  try { await t.kill(s.id); } catch {}
  disposeView(s.id);
  hosts.delete(s.id);
  hostsKey = hostKey();
  openHere(pane, s);
}

async function dismiss(pane, s) {
  const t = termApi();
  const h = hosts.get(s.id);
  if (h) dismissed.set(s.id, h.startedAt);
  try { await t?.kill(s.id); } catch {}
  disposeView(s.id);
  hosts.delete(s.id);
  hostsKey = hostKey();
  notify();
  rerender(pane);
}

function unmount(pane) {
  pane._mountFor = null;
  if (pane._mounted) { pane._mounted.wrap.remove(); pane._mounted = null; }
}

async function mount(pane, id) {
  if (pane._mounted?.id === id && pane._mounted === views.get(id)) { if (pane._focusNext === id) { pane._focusNext = null; focusSoon(pane, pane._mounted); } return; }
  if (pane._mountFor === id) return; // already on its way
  unmount(pane);
  pane._mountFor = id;
  let v;
  try { v = await ensureView(id); } catch (e) {
    console.error(e);
    pane._mountFor = null;
    pane._host.innerHTML = '<div class="s-err">The terminal (vendor/xterm) did not load.</div>';
    return;
  }
  if (pane._mountFor !== id) return;
  pane._mountFor = null;
  if (!v || pane._id !== id || !hosts.has(id)) return;
  pane._host.querySelectorAll('.s-err').forEach((x) => x.remove());
  pane._host.appendChild(v.wrap);
  pane._mounted = v;
  if (!v.opened) {
    v.opened = true;
    v.term.open(v.wrap);
    fitMounted(pane);
    // a view the Chat tab made off-screen already holds the screen
    if (!v.fed) { v.fed = true; await replay(v); }
  } else {
    fitMounted(pane);
  }
  if (pane._focusNext === id) { pane._focusNext = null; focusSoon(pane, v); }
}

// give the terminal the keyboard; a panel that is still sliding in (or a menu that just closed) can drop the
// first try, so it tries again on the next frames, for up to ~0.6 s, while that view is still the one shown
function focusSoon(pane, v) {
  const has = () => !!document.activeElement && v.wrap.contains(document.activeElement);
  let n = 0;
  const go = () => {
    if (pane._mounted !== v || has()) return;
    // something else took the keyboard meanwhile (the filter box, a button): leave it there
    if (n && document.activeElement && document.activeElement !== document.body) return;
    try { v.term?.focus(); } catch {}
    if (!has() && ++n < 36) requestAnimationFrame(go);
  };
  go();
}

function fitMounted(pane) {
  const v = pane._mounted;
  if (!v || !v.fit || !pane._host.offsetWidth || !pane._host.offsetHeight) return;
  try { v.fit.fit(); } catch {}
}

// ---------- the fake host, for tests and screenshots (?fixture=1&fakeTerm=1 only) ----------
export function installFakeTerm() {
  const ptys = new Map(), dataL = new Set(), exitL = new Set();
  const MAX = 512 * 1024;
  const emit = (id, chunk) => {
    const p = ptys.get(id);
    if (!p) return;
    p.buf = (p.buf + chunk).slice(-MAX);
    for (const f of dataL) f(id, chunk);
  };
  const rekeyL = new Set();
  const end = (id, code) => {
    const p = ptys.get(id);
    if (!p || !p.alive) return;
    p.alive = false; p.exitCode = code;
    for (const f of exitL) f(id, code);
    if (p.isNew) ptys.delete(id); // a new one that never got an id is forgotten, like the desktop host does
  };
  let newSeq = 0;
  const HEX = '0123456789abcdef';
  const uuid = () => 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => HEX[Math.floor(Math.random() * 16)]);
  const rekey = (key, id = uuid()) => {
    const p = ptys.get(key);
    if (!p || !p.isNew || !p.alive) return null;
    ptys.delete(key);
    p.id = id; p.isNew = false;
    ptys.set(id, p);
    for (const f of rekeyL) f(key, id);
    return id;
  };
  const E = '\x1b[';
  const rgb = (h) => `${E}38;2;${parseInt(h.slice(1, 3), 16)};${parseInt(h.slice(3, 5), 16)};${parseInt(h.slice(5, 7), 16)}m`;
  const box = (styled, visible) => `${rgb('#ff6a2b')}│${E}0m${styled}${' '.repeat(Math.max(0, 46 - visible))}${rgb('#ff6a2b')}│${E}0m`;
  const banner = (p) => '\x1b[?2004h' + [
    `${rgb('#ff6a2b')}╭──────────────────────────────────────────────╮${E}0m`,
    box(` ${rgb('#ff6a2b')}✻${E}0m ${E}1mWelcome back!${E}0m`, 16),
    box(`   ${E}2mresumed ${p.id.slice(0, 8)}  ·  account ${p.account}${E}0m`, 3 + `resumed ${p.id.slice(0, 8)}  ·  account ${p.account}`.length),
    `${rgb('#ff6a2b')}╰──────────────────────────────────────────────╯${E}0m`,
    '',
    `${E}1m> ${E}0mFix the review findings, merge, and watch the deploy`,
    '',
    `${rgb('#3fd8ff')}●${E}0m I'll start with the failing check. ${E}2m(fake output for tests)${E}0m`,
    '',
    `${rgb('#3dffa8')}●${E}0m ${E}1mBash${E}0m(npx vitest run web/term.test.js)`,
    `  ⎿  ${rgb('#3dffa8')}✓${E}0m 12 passed ${E}2m(1.4s)${E}0m`,
    '',
    `${rgb('#a47bff')}●${E}0m ${E}1mUpdate${E}0m(web/detail.js)`,
    `  ⎿  Updated web/detail.js with ${rgb('#3dffa8')}14 additions${E}0m and ${rgb('#ff5c6c')}3 removals${E}0m`,
    `      ${E}48;2;20;60;40m+  const tabs = el.querySelector('.d-tabs');${E}0m`,
    `      ${E}48;2;70;24;32m-  el._body.hidden = false;${E}0m`,
    '',
    `${rgb('#ffc24a')}●${E}0m Checks are green. Want me to merge it?`,
    '',
    `${E}2m──────────────────────────────────────────────────${E}0m`,
    `${E}1m>${E}0m `,
  ].join('\r\n');
  const FAKE_MODES = ['? for shortcuts', '⏵⏵ accept edits on (shift+tab to cycle)', '⏸ plan mode on (shift+tab to cycle)'];
  const welcome = (p) => '\x1b[?2004h' + [
    `${rgb('#ff6a2b')}╭──────────────────────────────────────────────╮${E}0m`,
    box(` ${rgb('#ff6a2b')}✻${E}0m ${E}1mWelcome to Claude Code!${E}0m`, 25),
    box(`   ${E}2mnew session  ·  account ${p.account}${E}0m`, 3 + `new session  ·  account ${p.account}`.length),
    `${rgb('#ff6a2b')}╰──────────────────────────────────────────────╯${E}0m`,
    '',
    `${E}2m──────────────────────────────────────────────────${E}0m`,
    `${E}1m>${E}0m `,
  ].join('\r\n');
  const rcMenu = (p) => `\r\n\r\n   ${E}1mRemote Control${E}0m\r\n   This session is available in the Claude mobile app.\r\n`
    + ['Disconnect this session', 'Show QR code', 'Continue'].map((t, i) => `   ${i === p.rcMenu ? '❯' : ' '} ${t}`).join('\r\n')
    + '\r\n   Enter to select · Esc to continue\r\n';
  // /usage and /status: Claude Code's Settings panel (a ▔ edge on top, its tabs with the one on in colour, its
  // keys at the bottom). Tab goes to the next tab; Esc closes it and the prompt comes back under a rule.
  const TABS = ['Status', 'Config', 'Usage', 'Stats'];
  const settings = (p) => {
    const bar = (n, pct) => `   ${rgb('#b1b9f9')}${'█'.repeat(n)}${E}0m${' '.repeat(24 - n)} ${pct}% used`;
    const body = {
      Status: ['Version:           2.1.294 (fake)', `Session ID:        ${p.id}`, `cwd:               ${p.cwd || '-'}`, 'Model:             opus (claude-opus-5-5)'],
      Config: ['❯ Auto-compact                                true', '  Show tips                                   true'],
      Usage: ['Current session', bar(6, 12), 'Resets 1:40pm (America/Los_Angeles)', '', 'Current week (all models)', bar(14, 28), 'Resets Oct 14, 7pm (America/Los_Angeles)'],
      Stats: ['Sessions: 412 · Messages: 9,810 · Longest streak: 23 days'],
    }[TABS[p.panel]];
    const tabs = TABS.map((t, i) => (i === p.panel ? `${E}38;2;0;0;0m${E}48;2;177;185;249m ${t} ${E}0m` : ` ${t} `)).join(' ');
    return `\r\n${'▔'.repeat(40)}\r\n   ${E}1mSettings${E}0m ${tabs}\r\n\r\n${body.map((l) => (l.startsWith('   ') ? l : `   ${l}`)).join('\r\n')}\r\n\r\n   ${E}2mEsc to cancel${E}0m\r\n`;
  };
  const fake = {
    async open({ id, cwd, account } = {}) {
      if (!ID_RE.test(String(id))) return { ok: false, message: 'not a conversation id' };
      const old = ptys.get(id);
      if (old) return { ok: true, message: 'already running here', pid: old.pid };
      const p = { id, cwd, account: account || 'B', pid: 41000 + ptys.size, alive: true, exitCode: null, startedAt: Date.now(), buf: '', line: '', raw: '', status: 'idle' };
      ptys.set(id, p);
      setTimeout(() => emit(id, banner(p)), 80);
      return { ok: true, message: 'started (fake)', pid: p.pid };
    },
    write(id, data) {
      const p = ptys.get(id);
      if (!p || !p.alive) return;
      data = String(data);
      p.raw = (p.raw + data).slice(-4096); // what was typed, exactly as sent, for tests
      // a bracketed paste (the banner turns the mode on, as Claude Code does): new lines stay in the prompt
      if (data.startsWith('\x1b[200~')) {
        const body = data.slice(6).replace(/\x1b\[201~$/, '');
        p.line += body.replace(/\r/g, '\n');
        emit(id, body.replace(/\r/g, '\r\n'));
        return;
      }
      // /remote-control's menu (while it is on): ↑ / ↓ move the pointer, Enter picks, Esc continues
      if (p.rcMenu != null) {
        if (data === '\x1b[A' || data === '\x1b[B') { p.rcMenu = (p.rcMenu + (data === '\x1b[A' ? 2 : 1)) % 3; emit(id, rcMenu(p)); return; }
        if (data === '\r' || data === '\x1b') {
          const pick = data === '\r' ? p.rcMenu : 2;
          p.rcMenu = null;
          if (pick === 0) p.rc = false;
          emit(id, `\r\n${pick === 0 ? `${E}2mRemote Control disconnected.${E}0m\r\n` : ''}${E}1m>${E}0m `);
        }
        return;
      }
      if (p.panel != null) {
        if (data === '\t' || data === '\x1b[C') { p.panel = (p.panel + 1) % TABS.length; emit(id, settings(p)); }
        else if (data === '\x1b[D') { p.panel = (p.panel + TABS.length - 1) % TABS.length; emit(id, settings(p)); }
        else if (data === '\x1b') { p.panel = null; emit(id, `\r\n${E}2m${'─'.repeat(50)}${E}0m\r\n${E}1m>${E}0m `); }
        return;
      }
      if (data === '\x1b\r') { p.line += '\n'; emit(id, '\r\n'); return; } // Alt+Enter: a new line in the prompt
      if (data === '\x1b') { p.status = 'idle'; emit(id, `\r\n${E}2m(Esc reached the session)${E}0m\r\n${E}1m>${E}0m ${p.line}`); return; }
      // Shift+Tab: the next permission mode, shown as Claude Code's footer line (the Chat tab's mode picker reads it)
      if (data === '\x1b[Z') {
        p.mode = ((p.mode || 0) + 1) % FAKE_MODES.length;
        emit(id, `\r\n${E}2m${FAKE_MODES[p.mode]}${E}0m\r\n${E}1m>${E}0m ${p.line}`);
        return;
      }
      if (data.startsWith('\x1b')) return; // arrows and other keys: ignored, like a prompt with no history
      for (const ch of data) {
        if (ch === '\r') {
          const line = p.line; p.line = '';
          // /remote-control: on (the line Claude Code prints), or its menu while it is on
          if (line.trim() === '/remote-control') {
            if (p.rc) { p.rcMenu = 2; emit(id, rcMenu(p)); return; }
            p.rc = true;
            emit(id, `\r\n  /remote-control is active · Continue here, on your phone, or at https://claude.ai/code/session_fake\r\n\r\n${E}1m>${E}0m `);
            return;
          }
          if (line.trim() === '/usage' || line.trim() === '/status') { p.panel = TABS.indexOf(line.trim() === '/usage' ? 'Usage' : 'Status'); emit(id, settings(p)); return; }
          if (line.trim() === 'exit') { emit(id, `\r\n${E}2mbye${E}0m\r\n`); setTimeout(() => end(id, 0), 30); return; }
          emit(id, `\r\n\r\n${rgb('#3fd8ff')}●${E}0m You said: ${E}1m${line}${E}0m\r\n\r\n${E}1m>${E}0m `);
        } else if (ch === '\x7f' || ch === '\b') {
          if (p.line) { p.line = p.line.slice(0, -1); emit(id, '\b \b'); }
        } else if (ch >= ' ') { p.line += ch; emit(id, ch); }
      }
    },
    // a new conversation: keyed new-<n>, given an id after autoRekeyMs (as Claude Code's pid file would)
    async create({ cwd, account } = {}) {
      if (typeof cwd !== 'string' || !cwd) return { ok: false, message: 'no folder given' };
      const key = `new-${++newSeq}`;
      const p = { id: key, cwd, account: acctOf(account), pid: 42000 + newSeq, alive: true, exitCode: null, startedAt: Date.now(), buf: '', line: '', raw: '', isNew: true, created: true, status: 'idle' };
      ptys.set(key, p);
      setTimeout(() => emit(p.id, welcome(p)), 80);
      if (fake.autoRekeyMs > 0) setTimeout(() => rekey(key), fake.autoRekeyMs);
      return { ok: true, message: 'started (fake)', key, pid: p.pid };
    },
    resize(id, cols, rows) { const p = ptys.get(id); if (p) { p.cols = cols; p.rows = rows; } },
    kill(id) { if (ptys.get(id)?.alive) end(id, 1); ptys.delete(id); },
    async list() {
      return [...ptys.values()].map(({ id, pid, alive, exitCode, startedAt, isNew, created, cwd, account, status }) => ({
        id, pid, alive, exitCode, startedAt, pending: !!isNew, created: !!created, cwd: cwd || null, account: account || 'B', status: alive ? status || null : null,
      }));
    },
    async snapshot(id) { return ptys.get(id)?.buf || ''; },
    onData(cb) { dataL.add(cb); return () => dataL.delete(cb); },
    onExit(cb) { exitL.add(cb); return () => exitL.delete(cb); },
    onRekey(cb) { rekeyL.add(cb); return () => rekeyL.delete(cb); },
    autoRekeyMs: 1500,
    // tests only: end a session with a code, as if claude exited; give a new one its id; set a status
    _end: end,
    _rekey: rekey,
    _status(id, status) { const p = ptys.get(id); if (p) p.status = status; },
    // tests only: print anything (a permission menu, a spinner line) as if Claude drew it
    _emit: emit,
    _ptys: ptys,
  };
  window.fleetDesktop = Object.assign({}, window.fleetDesktop || {}, { term: fake });
  return fake;
}
