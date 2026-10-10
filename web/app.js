// Fleet View web shell: polls GET /state once a second and draws the Cards, Map, Wall or Projects view.
//
// ---- the ui object (third argument of renderCards / renderWall / renderMap) ----
//   ui.selectedId          id of the picked conversation, or null
//   ui.setSelected(id, how) pick a conversation (null picks nothing); the current view redraws at once.
//                          how: 'click' (default) or 'keys' (arrow moves). In the desktop window a click also
//                          starts the conversation's live session in the panel (a preview, term.js); keys don't.
//   ui.open(id)            desktop window: open the live session in the panel's Session tab, kept (Enter,
//                          double-click). Edge: open it in Windows Terminal; asks first unless it is DONE,
//                          then shows the server's reply as a toast
//   ui.openTerminal(id)    always Windows Terminal (the panel's "Open conversation" button)
//   ui.saveSettings(obj)   save any of { view, zoom, query, repo, compact, steady, webBounds, notify, mapLens,
//                          mapViews } (POST /settings)
//   ui.keys                {}: a view may set ui.keys[viewName] = (KeyboardEvent) => boolean. While that view
//                          is shown, every key not taken by the shell goes to it first; return true when handled.
//                          The shell always handles: v / Tab (next view), / (filter), r (repo menu),
//                          Esc (close menu, filter, pick), Enter / o (open ui.selectedId), s (steady / live
//                          order), m (mini window, desktop only), Delete (remove the pick: see deleteKey), and, in Cards and
//                          Wall only, arrows/hjkl (pick) and c (compact). In the Map, arrows, + / -, 0, l
//                          and the mouse belong to map.js.
//   ui.compact             read only: compact cards on/off
//   ui.showDetail(id, how) open the detail panel for that conversation (finished ones too); null closes it.
//                          how 'click' counts as a pick (see setSelected); without it, it only redraws.
//                          ui.setSelected(id) opens it as well, and setSelected(null) closes it.
//   ui.detailId            read only: the conversation the panel shows, or null
//   ui.reveal({ kind: 'file'|'folder', path, line? })   POST /reveal: a file opens in VS Code, a folder in
//                          Explorer (the server only allows paths that are in /state); the reply shows as a toast
//   ui.openUrl(url)        opens an https:// URL (PR, branch, deploy) in the browser; anything else is ignored
//   ui.isHosted(id)        true while that conversation runs live in this window (desktop only, term.js); cards
//                          and the map mark it. The list is polled every 2 s and redraws the page when it changes.
//   ui.refresh()           redraw now
//   ui.contextMenu(target, clientX, clientY)   the right-click menu (ctxmenu.js) for { kind: 'session', id },
//                          { kind: 'repo', root, name?, color? }, { kind: 'sessions', ids } (a multi-selection of 2+),
//                          { kind: 'team', id } (state.teams) or { kind: 'conflict', id, kind2, label, sessions: [ids],
//                          rel? } (state.conflicts, or a file clash: kind2 'clash' with rel); the map calls it, cards /
//                          tiles / chips / the finished strip are caught by the page's own contextmenu listener
//   ui.setMulti(ids)       the map's multi-selection changed (Ctrl+click, Shift+drag): the shell keeps one list for
//                          every view and outlines those cards and tiles; the shell tells the map with map.js
//                          setMapSelection(ids). ui.multi: that list (read only). ui.toggleMulti(id) / ui.clearMulti():
//                          the cards' and tiles' Ctrl+click and plain click (cards.js wirePick)
//   ui.takeTab(id)         detail.js: the panel tab asked for once ('details' from the menu), or null
//   Links: any element with data-act="url" data-url="…", or data-act="reveal" data-kind="file|folder"
//   data-path="…" [data-line="n"], or data-act="session" data-id="…" (another conversation: the handoff
//   lines), opens on click anywhere on the page, before the card or tile under it sees the click (cards.js has
//   urlLink / revealLink / sessionLink to write them).
//
// ---- the state a view gets ----
// The /state JSON with the shell's filters applied: state.sessions holds only the shown conversations
// (repo menu, / filter, DONE hidden), most urgent first; state.clashes keeps the clashes with 2+ shown
// sessions and state.feed only their tool calls. In steady order (the default, key s) the conversations that
// need you come first (ASKING, QUESTION, ERROR, STALLED, then longest waiting) and the rest keep the order they
// first appeared in; in live order everything is sorted by today's activity. state.allSessions and state.allClashes are unfiltered.
// state.settings.zoom is the saved map zoom.
//
// Test without the server: ?fixture=1 loads ./fixtures/state-sample.json (timestamps moved to now);
// ?view=cards|map|wall|projects picks the starting view; ?select=<id> picks that conversation and opens its panel.
// ?fixture=1&fakeTerm=1 also installs a fake live-session host (term.js) that echoes what you type, to test the
// Session tab without the desktop window; without fixture=1 the query does nothing.
// window.fvSelect(id) does the same from outside (the desktop mini window): it keeps the current view, picks
// the conversation, opens its panel and scrolls its card or tile into view.
// With ?fixture=1 or ?debug=1, window.__mapNodes() lists the map's nodes with their client positions and
// window.__fv exposes the shell's state for tests (with ?fixture=1, POSTs are recorded in window.__fvPosts).
//
// Right-click (ctxmenu.js): a repo (map anchor, repo chip) offers New session · A / B (desktop window) and
// Open folder; a conversation offers Open session, Open in terminal and Remove (ends it if hosted here and takes it off the map; was End session / Hide from map) (DONE and
// QUESTION), Open in terminal, Rename (renameMenuItem) and Move to workspace (moveMenuItem). A repo also offers "Removed conversations"
// (a submenu of state.removed) to continue one (see continueConversation). A repo also offers "Remove repo", and
// empty space "Add workspace" and "Add recent workspace ▸" (removed repos, to add one back). The browser's own menu
// is kept only in text inputs and the live terminal (and in Edge outside those targets).
//
// New sessions (term.js createSession) are listed in state.pending (and state.allSessions) as stand-ins
// { id: 'new-<n>' or its id, pending: true, name: 'new session', state: 'NEW', repo, account, cwd } until
// /state lists the conversation; the map draws them, the panel shows their Session tab. A session here that
// handed off is the same: its pickup runs under the old conversation's key, is re-keyed to the new id (onRekey
// moves the pick and the panel), and stands in as 'picked-up session' until /state lists it.
//
// One repo list for every view: the repo menu, the map's repo anchors (view.repoAnchors; a listed repo with no
// conversation in view still gets its anchor and territory) and the repos the cards, wall and strip show.
// Removing a repo (the menu's ×, Delete on the picked row, "Remove from list" on a row's right-click, or "Remove
// repo" on a repo's right-click in any view; settings.hiddenRepos, [{ root, at }], POST /settings) takes it and its
// conversations out of every view: the menu, its map anchor, territory and nodes, the cards, wall tiles and the
// finished strip. "Undo" stays on a toast for 6 s. One comes back by itself when a conversation in it works after
// `at` (the server drops it from the list; the page follows). Removing the picked repo switches to All workspaces.
// Adding a repo ("Add workspace" at the bottom of the repo menu, or on empty space's right-click) offers three
// ways: "Paste path" (a path box; quotes around a pasted path are dropped, forward slashes are fine), "New
// scratchpad" (POST /repos/scratch: the server makes an empty scratch-YYYY-MM-DD folder under ~/Scratchpads and
// adds it) and "Browse" (the system folder picker, fleetDesktop.pickFolder; desktop window only). POST
// /repos/add checks the folder and stores its git root in settings.addedRepos, and /state lists it in repos[]
// (added: true) even with no conversations. Removing an added repo also drops it from addedRepos (POST /repos/remove; Undo adds it back).
// Hidden conversations (settings.hidden, [{ id, at }], POST /settings) are left out of every view and the
// finished strip until they work again: a state other than DONE / QUESTION with activity after `at`, which
// also drops them from the list.
//
// Map command center (the shell's side; map.js, map-overlay.js and replay.js draw the rest):
// - Orders (orders.js, through the live sessions of term.js, never a headless claude): a repo's right-click menu
//   (map hub, repo chips, the repo menu's rows) has "Give orders ▸" (Prompt, Model, Effort, Fast mode): one text to every unfinished
//   conversation in it, made one team (POST /teams) when there are 2+, so each gets its teammates' ids and the
//   fleet-msg.js command. A multi-selection's menu has "Give orders ▸" (Work together: a team, Send to each, Model, Effort, Fast mode), "Interrupt all",
//   "Open all here", "Clear selection" and "Remove N conversations"; a team's has "Message the team", "Add <picked>", "Pick <member>" and
//   "Disband team"; a conflict's or clash's has "Send a note to all"
//   (prefilled by kind), "Open the file in VS Code", "Pick" and "Interrupt" per conversation; one
//   conversation's gains "Leave team".
// - Replay: window 'fv-replay' { on, state } from the map overlay (see the replay section below).
// - "Since you looked" (since.js): key w, the header's clock button, and by itself after 30+ min away.
// - Desktop notifications for new state.alerts (settings.notify; see notifyAlerts).

import { renderCards } from './cards.js';
import { renderWall } from './wall.js';
import { renderProjects } from './projects.js';
import { renderDetail, openPeek } from './detail.js';
import { C, esc, needsYou, ago, fmtCost, acctTag, acctColor, isAcct, repoChip, clockTime, isHttps, setAccounts, singleAccount } from './cards.js';
import { watchHosts, isHosted, installFakeTerm, termApi, hosts, createSession, endSession, hostStatus, onRekey, openElsewhere, isNewKey, sendToAccount, ensureLive, interruptSession, sendText, screenText, screenMarked, screenReady } from './term.js';
import { openCtxMenu, closeCtxMenu, ctxMenuOpen } from './ctxmenu.js';
import { sendOrder, sendEach, sendNote, summary as orderSummary, teamBrief, firstWords, unreachable } from './orders.js';
import { mountSince, sinceFromState } from './since.js';
import { mountUpdate } from './update.js';
import { MODEL_IDS, EFFORTS, modelLabel, parseMenu, parsePromptBox, parseSpinner } from './compose.js';

const VIEWS = ['cards', 'map', 'wall', 'projects'];
const params = new URLSearchParams(location.search);
const FIXTURE = params.has('fixture');
const DEBUG = FIXTURE || params.has('debug');
const $ = (id) => document.getElementById(id);
if (FIXTURE && params.has('fakeTerm')) installFakeTerm();

// icons for the header pills and toasts; the page works without them (no icons) if icons.js is missing
let icon = () => '', iconsReady = false;
import('./icons.js').then((m) => { if (typeof m.icon === 'function') { icon = m.icon; iconsReady = true; render(); } }).catch(() => {});

let renderMap = null, mapRekey = null, mapPins = null, mapMod = null;
let mapMissing = false;
import('./map.js').then((m) => {
  mapMod = m;
  renderMap = m.renderMap;
  mapRekey = m.rekeyNode || null;
  mapPins = m.mapPinned && m.mapUnpin ? { pinned: m.mapPinned, unpin: m.mapUnpin } : null;
  if (DEBUG) window.__mapNodes = () => m.mapNodes();
  render();
}).catch((e) => { mapMissing = true; console.warn('map.js did not load', e); render(); });

// ---------- settings ----------
const local = { view: VIEWS.includes(params.get('view')) ? params.get('view') : 'cards', zoom: 1, query: '', repo: null, compact: false, finishedOpen: true, steady: true, notify: true };
let settingsLoaded = false;
let pendingSave = {}, saveTimer = null;

if (FIXTURE) window.__fvPosts = [];
function post(url, body, keepalive = false) {
  if (FIXTURE) { window.__fvPosts.push({ url, body: JSON.parse(JSON.stringify(body)) }); return Promise.resolve(null); }
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive })
    .then((r) => r.json()).catch(() => null);
}
function saveSettings(obj) {
  Object.assign(pendingSave, obj);
  for (const k of ['view', 'zoom', 'query', 'repo', 'compact', 'finishedOpen', 'steady', 'notify']) if (k in obj) local[k] = obj[k];
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSettings, 400);
}
function flushSettings(keepalive = false) {
  clearTimeout(saveTimer);
  if (!Object.keys(pendingSave).length) return;
  const body = pendingSave;
  pendingSave = {};
  post('/settings', body, keepalive);
}

// ---------- the ui object ----------
// How the panel's conversation was last picked, for the panel to act on once (detail.js, ui.takeIntent):
// 'preview' (a click, the mini window, the finished strip: in the desktop window the live session starts by
// itself), 'explicit' (Enter, a double-click: starts and stays), 'keys' (arrows: the panel shows, nothing starts)
let pickIntent = null; // { id, kind }
let tabWant = null; // { id, tab }: the panel tab to show once (the Projects view's Session / Details buttons)
// the Projects view shows the chat itself, so the panel opens there only when asked (ui.panel)
let projPanel = false;
// the panel pinned to one conversation (its pin button, detail.js): no pick, Esc or view switch closes or swaps it;
// only its pin again (or that conversation leaving the list) lets go. Kept in this browser's storage across reloads.
let pinnedId = null;
try { pinnedId = localStorage.getItem('fv.pin') || null; } catch {}
function setPin(id) {
  pinnedId = id || null;
  try { if (pinnedId) localStorage.setItem('fv.pin', pinnedId); else localStorage.removeItem('fv.pin'); } catch {}
}
const intentOf = (how) => (how === 'keys' ? 'keys' : how === 'explicit' ? 'explicit' : how ? 'preview' : null);
const ui = {
  selectedId: null,
  detailId: null,
  // how: 'click' (the default: cards, tiles, map nodes), 'keys' (arrow-key moves), 'explicit'
  setSelected(id, how = 'click') {
    ui.selectedId = id || null;
    ui.detailId = pinnedId || id || null;
    pickIntent = id ? { id, kind: intentOf(how) } : null;
    render();
    if (id && local.view !== 'map') document.querySelector(`#view-${local.view} [data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
  },
  // how: none for a redraw of the panel (its own tab buttons), 'click' when a conversation is picked
  showDetail(id, how = null) {
    if (pinnedId && id !== pinnedId) {
      if (id && how) toast('the panel is pinned: unpin it to open another conversation', C.dim);
      id = pinnedId;
    }
    ui.detailId = id || null;
    if (!id) projPanel = false;
    pickIntent = id && how ? { id, kind: intentOf(how) } : null;
    render();
  },
  // the Projects view's Session / Details buttons: the side panel on that tab (it stays shut there otherwise)
  panel(id, tab) {
    tabWant = { id, tab };
    projPanel = true;
    ui.showDetail(id);
  },
  pinned: () => pinnedId,
  // the panel's pin button: pins the panel to that conversation, or (the same one again) lets go
  togglePin(id) {
    setPin(pinnedId === id ? null : id);
    if (pinnedId) ui.detailId = pinnedId;
    render();
  },
  takeIntent(id) {
    const p = pickIntent;
    if (!p || p.id !== id) return null;
    pickIntent = null;
    return p.kind;
  },
  takeTab(id) {
    const w = tabWant;
    if (!w || w.id !== id) return null;
    tabWant = null;
    return w.tab;
  },
  contextMenu: (target, x, y) => openContextMenu(target, x, y),
  // the map: a conversation dropped on another repo moves there (as the menu's "Move to workspace")
  moveSession: (id, root) => {
    const s = (view?.allSessions || state?.sessions || []).find((x) => x.id === id);
    return s && root ? moveConversation(s, root) : false;
  },
  // the panel's title, edited in place (detail.js): the conversation's name in Fleet View ('' clears it).
  // Resolves to null when it worked, else a message
  rename: (id, name) => {
    const s = (view?.allSessions || state?.sessions || []).find((x) => x.id === id);
    return s ? renameConversation(s, name) : Promise.resolve('that conversation is no longer listed');
  },
  reveal: (what) => reveal(what),
  openUrl: (url) => openUrl(url),
  // in the desktop window: the live session in the panel (started and kept); elsewhere: Windows Terminal
  open: (id) => {
    if (!termApi()) { openSession(id); return; }
    const s = state?.sessions?.find((x) => x.id === id) || view?.allSessions?.find((x) => x.id === id && x.continued);
    if (!s) return;
    if (s.state === 'DONE') { ui.selectedId = null; ui.showDetail(s.id, 'explicit'); } else ui.setSelected(s.id, 'explicit');
  },
  openTerminal: (id) => openSession(id),
  saveSettings,
  keys: {},
  get compact() { return local.compact; },
  isHosted: (id) => isHosted(id),
  refresh: () => render(),
  // the multi-selection (Ctrl+click on cards, tiles or map nodes; Shift+drag on the map): the map calls
  // setMulti(ids) when its selection changes; ui.multi is the current list (read only)
  setMulti: (ids) => setMulti(ids, 'map'),
  get multi() { return [...multi]; },
  toggleMulti: (id) => toggleMulti(id),
  selectMany: (ids) => setMulti(ids, 'cards'),
  // the right-click menu is open: the map keeps its hover tooltip hidden meanwhile
  menuOpen: () => ctxMenuOpen(),
};

// ---------- polling ----------
let state = null; // last good /state
let online = false;
let pageBuild = null; // the server's code version this page was loaded with
// the reload for new page code keeps the picked conversation and its open chat (this tab's storage, read once)
function keepPickForReload() {
  try { sessionStorage.setItem('fv.reopen', JSON.stringify({ sel: ui.selectedId, detail: ui.detailId })); } catch {}
}
function restorePickAfterReload() {
  let r = null;
  try { r = JSON.parse(sessionStorage.getItem('fv.reopen') || 'null'); sessionStorage.removeItem('fv.reopen'); } catch {}
  if (!r) return;
  if (typeof r.sel === 'string') ui.selectedId = r.sel;
  if (typeof r.detail === 'string') ui.detailId = r.detail;
}

function rebase(st) {
  // fixture timestamps are fixed; move them so "4s ago" reads as it was written
  const d = Date.now() - (st.now || Date.now());
  const sh = (t) => (typeof t === 'number' ? t + d : t);
  st.now = sh(st.now);
  if (st.alert) st.alert.t = sh(st.alert.t);
  for (const s of st.sessions || []) {
    s.last = sh(s.last); s.turnStart = sh(s.turnStart); s.endedAt = sh(s.endedAt);
    if (s.lastAction) s.lastAction.t = sh(s.lastAction.t);
    for (const r of s.running || []) r.at = sh(r.at);
    for (const f of s.files || []) f.t = sh(f.t);
    for (const c of s.calls || []) c.t = sh(c.t);
    if (s.ship && s.ship.app) s.ship.app.at = sh(s.ship.app.at);
    if (s.handoff) s.handoff.at = sh(s.handoff.at);
  }
  for (const f of st.finished || []) f.endedAt = sh(f.endedAt);
  for (const r of st.removed || []) { r.removedAt = sh(r.removedAt); r.lastActive = sh(r.lastActive); }
  for (const e of st.feed || []) e.t = sh(e.t);
  for (const a of st.alerts || []) a.t = sh(a.t);
  for (const t of st.teams || []) { t.at = sh(t.at); for (const m of t.messages || []) m.t = sh(m.t); }
  for (const x of st.deploys || []) { x.createdAt = sh(x.createdAt); x.readyAt = sh(x.readyAt); }
  for (const w of st.worktrees || []) w.lastCommit = sh(w.lastCommit);
  for (const h of st.settings?.hidden || []) if (h && typeof h === 'object') h.at = sh(h.at);
  return st;
}

async function poll() {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 4000);
  try {
    const r = await fetch(FIXTURE ? './fixtures/state-sample.json' : '/state', { cache: 'no-store', signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    let st = await r.json();
    if (FIXTURE) st = rebase(st);
    // new page code on the server (a merge changed web/ or fleet-view.js): load it, settings saved first
    if (st.build) {
      if (!pageBuild) pageBuild = st.build;
      else if (st.build !== pageBuild) { flushSettings(); keepPickForReload(); location.reload(); return; }
    }
    applyRenames(st);
    state = st;
    setAccounts(st.accounts);
    online = true;
    if (st.settings) syncHiddenRepos(st.settings.hiddenRepos);
    if (st.settings && Array.isArray(st.settings.offAccounts) && !('offAccounts' in pendingSave) && Date.now() - offSentAt > 3000) offAccts = st.settings.offAccounts.filter(isAcct);
    if (settingsLoaded && st.settings) mergeServerHidden(st.settings.hidden);
    if (!settingsLoaded && st.settings) {
      settingsLoaded = true;
      const s = st.settings;
      if (!params.has('view') && VIEWS.includes(s.view)) local.view = s.view;
      if (s.zoom > 0) local.zoom = s.zoom;
      if (typeof s.query === 'string') local.query = s.query;
      local.repo = typeof s.repo === 'string' ? s.repo : null;
      local.compact = !!s.compact;
      if (typeof s.finishedOpen === 'boolean') local.finishedOpen = s.finishedOpen;
      if (typeof s.steady === 'boolean') local.steady = s.steady;
      local.notify = s.notify !== false;
      if (Array.isArray(s.hidden)) { hidden.clear(); for (const h of s.hidden) if (h && typeof h.id === 'string') hidden.set(h.id, Number(h.at) || Date.now()); }
      // ?select=<id>: pick that conversation and open its panel (finished ones open the panel only)
      const pick = params.get('select');
      const ps = pick && (st.sessions || []).find((x) => x.id === pick || x.name === pick);
      if (ps) { if (ps.state === 'DONE') ui.detailId = ps.id; else { ui.selectedId = ps.id; ui.detailId = ps.id; } }
      else if (!pick) restorePickAfterReload();
    }
    if (pendingSelect) { const id = pendingSelect; pendingSelect = null; queueMicrotask(() => fvSelect(id)); }
    try { notifyAlerts(st); } catch (e) { console.warn(e); }
  } catch {
    online = false;
  } finally {
    clearTimeout(timer);
  }
  render();
  setTimeout(poll, 1000);
}

// ---------- filtering ----------
const normRoot = (p) => String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
// the home folder (state.home) is "no repo": where conversations sit until they work in a repo; listed last
const isHomeRoot = (root) => !!root && !!state?.home && normRoot(root) === normRoot(state.home);
const repoName = (root) => (isHomeRoot(root) ? 'no workspace' : String(root || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'no workspace');
function inRepo(repo) {
  if (!local.repo) return true;
  if (!repo) return false;
  if (/[\\/]/.test(local.repo)) return normRoot(repo.root) === normRoot(local.repo);
  return String(repo.name || repoName(repo.root)).toLowerCase() === local.repo.toLowerCase();
}
function queryRe() {
  if (!local.query) return null;
  try { return new RegExp(local.query, 'i'); } catch { return new RegExp(local.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
}
const RANK = { ASKING: 0, QUESTION: 1, ERROR: 1, STALLED: 1, WORKING: 2, AGENTS: 2, DONE: 3 };
// steady order: who needs you first, in this priority, then the longest waiting
const NEED = { ASKING: 0, QUESTION: 1, ERROR: 2, STALLED: 3 };
// the order each conversation first appeared in this page (kept in memory only); new ones go to the end
const firstSeen = new Map();
let seenSeq = 0;
// a handing-off stand-in sorts by the state it last showed live, so it keeps its slot until the pickup takes it
const rk = (s) => s.rankState || s.state;
const liveOrder = (a, b) => (RANK[rk(a)] ?? 3) - (RANK[rk(b)] ?? 3) || b.last - a.last;
function steadyOrder(a, b) {
  const na = NEED[rk(a)] ?? 9, nb = NEED[rk(b)] ?? 9;
  if (na !== nb) return na - nb;
  if (na < 9) return (a.last || 0) - (b.last || 0) || firstSeen.get(a.id) - firstSeen.get(b.id);
  return firstSeen.get(a.id) - firstSeen.get(b.id);
}

// ---------- hidden conversations ----------
const hidden = new Map(); // id -> when it was hidden (ms)
let hiddenSaveDue = false;
function saveHidden() {
  // newest last, at most 500 (the server's limit)
  const list = [...hidden].sort((a, b) => a[1] - b[1]).slice(-500).map(([id, at]) => ({ id, at }));
  saveSettings({ hidden: list });
}
// when it last worked: its last prompt or reply (s.active), not its log's time, which a resumed claude moves
// with cost records; s.last for a server that doesn't send it
const activeAt = (s) => (Number.isFinite(s.active) ? s.active : s.last || 0);
// hidden, unless it works again: a state that isn't DONE or QUESTION, with activity after it was hidden
function isHidden(s) {
  const at = hidden.get(s.id);
  if (at === undefined) return false;
  if (s.state !== 'DONE' && s.state !== 'QUESTION' && activeAt(s) > at) { unhide(s.id); hiddenSaveDue = true; return false; }
  return true;
}
// takes one off the local list, and remembers when, so the server's copy (which still has it until the page's
// save lands) doesn't put it back on the next /state
const unhiddenAt = new Map(); // id -> when the page took it off the list (ms)
function unhide(id) {
  hidden.delete(id);
  unhiddenAt.set(id, Date.now());
}
// The server hides conversations too (the automation API: stop {remove}, remove, temp sessions), and the page
// loads settings.hidden only once at start. So each /state adds the server's entries the page doesn't have:
// never drops a local one (the page's own saves are the source of the list), and skips an entry the page took off
// the list itself unless the server hid it again after that. True when it added any (render() follows the poll).
function mergeServerHidden(list) {
  if (!Array.isArray(list)) return false;
  const now = Date.now();
  for (const [id, t] of unhiddenAt) if (now - t > 120e3) unhiddenAt.delete(id);
  let added = false;
  for (const h of list) {
    const id = h && typeof h === 'object' ? h.id : h;
    if (typeof id !== 'string' || hidden.has(id)) continue;
    const at = (h && Number(h.at)) || now, gone = unhiddenAt.get(id);
    if (gone !== undefined && at <= gone) continue;
    hidden.set(id, at);
    unhiddenAt.delete(id);
    continued.delete(id);
    if (ui.selectedId === id) ui.selectedId = null;
    if (ui.detailId === id) ui.detailId = null;
    if (pinnedId === id) setPin(null);
    added = true;
  }
  return added;
}
function hideConversation(s, how = 'hidden') {
  hidden.set(s.id, Date.now());
  continued.delete(s.id);
  saveHidden();
  if (ui.selectedId === s.id) ui.selectedId = null;
  if (ui.detailId === s.id) ui.detailId = null;
  if (pinnedId === s.id) setPin(null);
  const undo = () => { if (hidden.has(s.id)) { unhide(s.id); saveHidden(); render(); } };
  toast(how === 'removed' ? `Removed ${s.name}. It comes back if it works again` : `${s.name} is hidden until it works again`, C.dim, { label: 'Undo', run: undo, ms: 6000 });
  render();
}

// ---------- repos taken off the repo menu ----------
const hiddenRepos = new Map(); // normRoot -> { root, at }
let hiddenReposSentAt = 0;
function saveHiddenRepos() {
  hiddenReposSentAt = Date.now();
  // newest last, at most 200 (the server's limit)
  saveSettings({ hiddenRepos: [...hiddenRepos.values()].sort((a, b) => a.at - b.at).slice(-200) });
}
// the server's list wins, except while a change of ours may not have reached it yet
function syncHiddenRepos(list) {
  if (!Array.isArray(list) || 'hiddenRepos' in pendingSave || Date.now() - hiddenReposSentAt < 3000) return;
  hiddenRepos.clear();
  for (const h of list) if (h && typeof h.root === 'string') hiddenRepos.set(normRoot(h.root), { root: h.root, at: Number(h.at) || Date.now() });
}
// off the menu, unless a conversation in it worked after it was taken off (the server drops it then as well)
function repoIsHidden(root) {
  const k = normRoot(root), h = hiddenRepos.get(k);
  if (!h) return false;
  if ((state?.sessions || []).some((s) => s.repo && normRoot(s.repo.root) === k && activeAt(s) > h.at)) { hiddenRepos.delete(k); return false; }
  return true;
}
// the hidden repos' keys, less the ones that came back (worked again); once per derive
function hiddenRepoKeys() {
  const out = new Set();
  for (const [k, h] of [...hiddenRepos]) if (repoIsHidden(h.root)) out.add(k);
  return out;
}
function unhideRepo(root) {
  const k = normRoot(root);
  if (!hiddenRepos.has(k)) return;
  hiddenRepos.delete(k);
  saveHiddenRepos();
}
// Ctrl+Z's list: { run, text, el, at } for each toast that offered Undo, newest last (see undoLast)
const undoStack = [];
const UNDO_MS = 10 * 60e3;
let lastRemoved = null; // { undo, until }: what "Undo" (or u in the menu) puts back
// it: { root, name } from the repo menu, a map anchor or a repo chip (a checkout folder maps to its repo)
function removeRepo(it) {
  if (!it || !it.root) return;
  const listed = (state?.repos || []).find((r) => normRoot(r.root) === normRoot(it.root));
  const root = listed ? listed.root : repoForFolder(state || {}, it.root).root || it.root;
  const name = it.name && it.name !== 'All workspaces' ? it.name : repoName(root);
  const k = normRoot(root), before = hiddenRepos.get(k);
  const wasPicked = isCurrent({ root, name }), prevRepo = local.repo;
  // an added repo leaves addedRepos for good (Undo adds it back)
  const wasAdded = !!(addedLocal.has(k) || (state?.repos || []).some((r) => r.added && normRoot(r.root) === k));
  const localAdd = addedLocal.get(k) || null;
  hiddenRepos.set(k, { root, at: Date.now() });
  saveHiddenRepos();
  if (wasAdded) { addedLocal.delete(k); post('/repos/remove', { root }); }
  if (wasPicked) { ui.selectedId = null; saveSettings({ repo: null }); }
  // its conversations leave every view, the panel too
  const inIt = (id) => { const s = id && view?.allSessions?.find((x) => x.id === id); return !!(s && s.repo && normRoot(s.repo.root) === k); };
  if (inIt(ui.selectedId)) ui.selectedId = null;
  if (inIt(ui.detailId)) ui.detailId = null;
  if (inIt(pinnedId)) setPin(null);
  const undo = () => {
    if (lastRemoved?.undo === undo) lastRemoved = null;
    if (before) hiddenRepos.set(k, before); else hiddenRepos.delete(k);
    saveHiddenRepos();
    if (wasAdded) { addedLocal.set(k, localAdd || { root, name, at: Date.now() }); post('/repos/add', { path: root }); }
    if (wasPicked && !local.repo) saveSettings({ repo: prevRepo });
    if (menuOpen) drawMenu();
    render();
  };
  lastRemoved = { undo, until: Date.now() + 6000 };
  if (menuOpen) drawMenu();
  render();
  toast(`Removed ${name}${wasPicked ? ' · showing every workspace' : ''}. It comes back if it works again`, C.dim, { label: 'Undo', run: undo, ms: 6000 });
}

// ---------- adding a repo ----------
// added here and not yet in /state's repos[] (with ?fixture=1, where nothing reaches a server: for good)
const addedLocal = new Map(); // normRoot -> { root, name, at }
// the path checked by the server (POST /repos/add); resolves to null when it worked, else the reason
// at: { x, y } in client coordinates when added from the map's empty-space menu: its hub goes there
async function addRepoPath(p, at = null) {
  // quotes around a pasted path ("Copy as path") are dropped; forward slashes are fine (the server turns them)
  const text = String(p || '').trim().replace(/^(["'])(.*)\1$/, '$2').trim();
  if (!text) return 'paste or type a folder path first';
  const r = await post('/repos/add', { path: text });
  return repoAdded(r, FIXTURE ? { root: text.replace(/[\\/]+$/, '') || text, name: repoName(text) } : null, false, at);
}
// "New scratchpad": the server makes a new empty folder (scratch-YYYY-MM-DD under ~/Scratchpads) and adds it;
// resolves like addRepoPath, and shows a failure itself
async function addScratchRepo(at = null) {
  const r = await post('/repos/scratch', {});
  const err = repoAdded(r, FIXTURE ? { root: 'C:\\Users\\you\\Scratchpads\\scratch-fixture', name: 'scratch-fixture' } : null, true, at);
  if (err) toast(err, C.red);
  return err;
}
// the server's reply to an add (fake: what ?fixture=1 pretends it got); null when it worked, else the reason
function repoAdded(r, fake = null, scratch = false, at = null) {
  const repo = fake || (r && r.ok ? r.repo : null);
  if (!repo) return (r && r.message) || 'could not reach Fleet View to add it';
  const k = normRoot(repo.root);
  addedLocal.set(k, { root: repo.root, name: repo.name || repoName(repo.root), color: repo.color || null, at: Date.now() });
  // a repo that was removed comes back (the server takes it off its list too)
  unhideRepo(repo.root);
  // added from the map's empty space: the hub goes where the menu was opened, not the nearest free spot
  if (at && !(r && r.already) && local.view === 'map' && mapMod && typeof mapMod.mapPlaceRepo === 'function') mapMod.mapPlaceRepo(repo.root, at.x, at.y);
  toast(r && r.already ? `${repo.name} is already listed` : scratch ? `Added ${repo.name} · ${repo.root}` : `Added ${repo.name}`, C.mint);
  if (menuOpen) drawMenu();
  render();
  return null;
}
// "Browse" (desktop window only): the system folder picker
async function pickAndAddRepo(at = null) {
  const fd = window.fleetDesktop;
  if (!fd || typeof fd.pickFolder !== 'function') return false;
  let r = null;
  try { r = await fd.pickFolder(); } catch { r = null; }
  if (r && r.ok && r.path) { const err = await addRepoPath(r.path, at); if (err) toast(err, C.red); }
  else if (r && r.message) toast(r.message, C.dim);
  return true;
}
const canPickFolder = () => !!(window.fleetDesktop && typeof window.fleetDesktop.pickFolder === 'function');
const ADD_HINT = 'Paste a folder path, e.g. Z:\\Github\\my-project';
// the right-click menu's item: a submenu of the three ways (Browse is a quiet line outside the desktop window);
// at: where the menu was opened, so the map puts the new repo there
function addRepoMenuItem(at = null) {
  return {
    label: 'Add workspace', icon: 'plus',
    children: [
      { label: 'Paste path', icon: 'plus', input: { placeholder: ADD_HINT, hint: 'Enter adds · Esc closes', submit: (text) => addRepoPath(text, at) } },
      { label: 'New scratchpad', icon: 'plus', note: 'an empty folder', run: () => addScratchRepo(at) },
      canPickFolder() ? { label: 'Browse', icon: 'folder', run: () => pickAndAddRepo(at) } : { label: 'Browse', icon: 'folder', disabled: true, note: 'desktop window only' },
    ],
  };
}
// ---------- short lists ----------
// The "recent" lists (these menus and the finished strip) start short: today's, at most SHORT_N (or the
// SHORT_NONE newest when none is from today). The rest waits behind "Show N more". list: newest first.
const SHORT_N = 5, SHORT_NONE = 3;
function shortCount(list, timeOf) {
  const today = new Date().setHours(0, 0, 0, 0);
  const n = list.filter((x) => (timeOf(x) || 0) >= today).length;
  return Math.min(list.length, n ? Math.min(SHORT_N, n) : SHORT_NONE);
}
// a submenu's items cut to the short list, with "Show N more" opening the rest in place (ctxmenu.js)
function shortMenu(kids, timeOf) {
  const n = shortCount(kids, timeOf);
  if (kids.length - n < 2) return kids; // one more row is no shorter than its "Show 1 more"
  return [...kids.slice(0, n), { label: `Show ${kids.length - n} more`, icon: 'chevron', more: kids.slice(n) }];
}

// "Add recent workspace ▸" (empty space's right-click): the removed repos (hiddenRepos), newest first, up to 20; picking
// one adds it back like "Add workspace" (POST /repos/add takes it off the server's hidden list too)
function recentRepoMenuItem(at = null) {
  const now = Date.now();
  const keys = hiddenRepoKeys();
  const list = [...hiddenRepos].filter(([k]) => keys.has(k)).map(([, h]) => h).sort((a, b) => b.at - a.at).slice(0, 20);
  if (!list.length) return { label: 'Add recent workspace', icon: 'folder', disabled: true, note: 'none removed' };
  return {
    label: 'Add recent workspace', icon: 'folder',
    children: shortMenu(list.map((h) => ({
      label: repoName(h.root), icon: 'folder', note: `removed ${removedAgo(now - h.at)}`, at: h.at,
      run: async () => { const err = await addRepoPath(h.root, at); if (err) toast(err, C.red); },
    })), (k) => k.at),
  };
}

// ---------- removed conversations: continue one (right-click a repo) ----------
// state.removed: the server's 50 most recently removed, newest first ({ id, name, account, repo, cwd, removedAt,
// lastActive }). Continue takes one off the hidden list and opens it (desktop: its live session in the panel,
// kept; Edge: a Windows Terminal tab). Until /state shows it working again it stays on the page as a dim
// stand-in card and map node (continued), even when it is outside the activity window: while it runs here,
// else for 15 minutes.
const continued = new Map(); // id -> { at, r }
const CONTINUED_MS = 15 * 60e3;
// the removed ones the menus offer, optionally only a repo's (folder: a repo root or one of its checkouts)
function removedFor(folder = null) {
  const keys = folder ? new Set([normRoot(folder), normRoot(repoForFolder(state || {}, folder).root)]) : null;
  return (state?.removed || []).filter((r) => r && typeof r.id === 'string' && hidden.has(r.id) && !continued.has(r.id)
    && (!keys || (r.repo && keys.has(normRoot(r.repo.root)))));
}
const removedAgo = (ms) => (ms < 60e3 ? 'just now' : ms < 3600e3 ? `${Math.round(ms / 60e3)}m ago` : ms < 48 * 3600e3 ? `${Math.round(ms / 3600e3)}h ago` : `${Math.round(ms / 86400e3)}d ago`);
// the "Removed conversations" item with its submenu, or null when there are none
function removedMenuItem(list, withRepo) {
  if (!list.length) return null;
  const now = Date.now();
  return {
    label: 'Removed conversations', icon: 'hide',
    children: shortMenu(list.map((r) => ({
      label: r.name, tag: isAcct(r.account) ? r.account : null, icon: 'shell',
      note: `${withRepo ? `${r.repo ? r.repo.name : 'no workspace'} · ` : ''}removed ${removedAgo(now - (r.removedAt || now))}`, at: r.removedAt || now,
      run: () => continueConversation(r),
    })), (k) => k.at),
  };
}
async function continueConversation(r) {
  if (!r || !r.id) return;
  if (r.repo && r.repo.root) unhideRepo(r.repo.root);
  if (hidden.has(r.id)) { unhide(r.id); saveHidden(); }
  flushSettings();
  continued.set(r.id, { at: Date.now(), r });
  toast(`Continuing ${r.name}`, C.mint);
  if (termApi()) {
    // the desktop window: its live session in the panel (claude --resume), opened on purpose: kept, with the keyboard
    ui.setSelected(r.id, 'explicit');
    return;
  }
  render();
  const res = await post('/open', { id: r.id });
  if (FIXTURE) return; // fixture data: the POST is only recorded (window.__fvPosts)
  if (!res || !res.ok) toast((res && res.message) || 'could not reach Fleet View to open it', C.red);
}

// stand-ins for the continued ones: a dim card and map node until /state shows them working again
function continuedSessions(st) {
  const out = [], now = Date.now();
  for (const [id, c] of continued) {
    const real = (st.sessions || []).find((x) => x.id === id);
    if (hidden.has(id) || (real && real.state !== 'DONE') || (!isHosted(id) && now - c.at > CONTINUED_MS)) { continued.delete(id); continue; }
    const r = c.r;
    const base = real || {
      id, name: r.name, account: isAcct(r.account) ? r.account : 'B', repo: r.repo || null, cwd: r.cwd || null,
      last: r.lastActive || c.at, turnStart: null, goal: null, lastAction: null, waitingOn: null, agents: [], files: [], calls: [], spark: [],
      ship: null, progress: { mode: 'ship', pct: 0 }, planSteps: null, context: null, branch: null, worktree: null, model: null,
      links: { pr: null, branch: null, deploy: null, repoFolder: r.cwd || null }, lastReply: null, tokens: 0, cost: 0,
      endedAt: r.lastActive || c.at, openElsewhere: false, calls20: 0,
    };
    out.push({ ...base, cwd: base.cwd || r.cwd || null, continued: true, state: 'DONE', label: 'CONTINUED', stateColor: C.dim, hue: base.hue || r.repo?.color || C.dim });
  }
  return out;
}

// ---------- new sessions, before /state lists them ----------
// the repo a folder belongs to: a conversation working in that checkout, else a listed repo, else the folder
function repoForFolder(st, folder) {
  const f = normRoot(folder);
  for (const s of st.sessions || []) if (s.repo && (normRoot(s.links?.repoFolder) === f || normRoot(s.repo.root) === f)) return s.repo;
  const r = (st.repos || []).find((x) => normRoot(x.root) === f);
  return { root: r ? r.root : folder, name: r ? r.name : repoName(folder), color: C.dim };
}
function pendingSessions(st) {
  const listed = new Set((st.sessions || []).map((s) => s.id));
  const out = [];
  for (const h of hosts.values()) {
    // started here, or the pickup of a handoff (re-keyed from the conversation it took over: the panel follows it)
    if (!(h.created || h.handoffFrom) || !h.alive || listed.has(h.id) || !h.cwd) continue;
    const color = acctColor(h.account);
    out.push({
      id: h.id, pending: true, name: h.forkFrom ? 'forked session' : h.handoffFrom && !h.created ? 'picked-up session' : 'new session', account: h.account, state: 'NEW', label: 'NEW SESSION', stateColor: color, hue: color,
      repo: repoForFolder(st, h.cwd), cwd: h.cwd, last: h.startedAt || Date.now(), turnStart: null, goal: null, lastAction: null, waitingOn: null,
      agents: [], files: [], calls: [], spark: [], ship: null, progress: { mode: 'ship', pct: 0 }, planSteps: null, context: null,
      links: { pr: null, branch: null, deploy: null, repoFolder: h.cwd }, lastReply: null, tokens: 0, cost: 0, endedAt: null, openElsewhere: false, calls20: 0,
    });
  }
  return out;
}

// ---------- handoffs: the old card holds its place until its pickup takes it ----------
// A conversation that hands off (handoff.js) doesn't just go quiet and vanish: from the moment it hands off
// it stands in as HANDING OFF (PICKING UP once its pickup runs), in its own slot, and when the pickup shows
// up it takes that same slot (same first-seen place) while the old card dissolves into it (views.css
// .is-handing / .is-picking; the map sends the old node over to the new one). Held at most HANDOFF_MS.
const HANDOFF_MS = 3 * 60e3;
const lastLive = new Map(); // id -> the state it last showed live (the stand-in's place in the live order)
function handoffView(all) {
  const now = Date.now();
  const live = new Set(all.filter((s) => s.state !== 'DONE').map((s) => s.id));
  const byFrom = new Map();
  for (const s of all) if (s.pickedUpFrom?.id) byFrom.set(s.pickedUpFrom.id, s.id);
  // a pickup running here, re-keyed to its own id (before that it runs under the old one's key)
  const hostFrom = new Map();
  for (const h of hosts.values()) if (h.handoffFrom && h.alive && h.id !== h.handoffFrom) hostFrom.set(h.handoffFrom, h.id);
  const stand = new Map(), pairs = new Map();
  for (const s of all) {
    if (s.state !== 'DONE' && !s.handoff) lastLive.set(s.id, s.state);
    const h = s.handoff;
    if (!h || !(now - (h.at || 0) < HANDOFF_MS)) continue;
    const next = h.next || byFrom.get(s.id) || hostFrom.get(s.id) || null;
    if (next) pairs.set(s.id, next);
    if (next && live.has(next)) continue; // its pickup is on the board: it took the slot
    if (!firstSeen.has(s.id)) continue; // never on this board: nothing to hand over
    const picking = !!(next || hostFrom.has(s.id));
    stand.set(s.id, {
      ...s, handing: true, state: 'HANDOFF', label: picking ? 'PICKING UP' : 'HANDING OFF', stateColor: C.violet,
      rankState: lastLive.get(s.id) || 'WORKING', pendingNext: hostFrom.get(s.id) || null, waitingOn: null,
    });
  }
  return { stand, pairs };
}

function derive(st) {
  const q = queryRe();
  const all = st.sessions || [];
  const cont = continuedSessions(st);
  const contIds = new Set(cont.map((s) => s.id));
  // conversations in a removed repo are out of every view, like the repo
  const hidR = hiddenRepoKeys();
  const offRepo = (s) => !!(s && s.repo && hidR.has(normRoot(s.repo.root)));
  const ho = handoffView(all);
  const inR = all.filter((s) => s.state !== 'DONE' && !ho.stand.has(s.id) && inRepo(s.repo) && !isHidden(s) && !contIds.has(s.id) && !offRepo(s))
    .concat([...ho.stand.values()].filter((s) => inRepo(s.repo) && !isHidden(s) && !contIds.has(s.id) && !offRepo(s)))
    .concat(cont.filter((s) => inRepo(s.repo) && !offRepo(s)));
  // a pickup takes the place its predecessor had
  for (const [from, to] of ho.pairs) if (!firstSeen.has(to) && firstSeen.has(from)) firstSeen.set(to, firstSeen.get(from));
  const shown = inR.filter((s) => !q || q.test(`${s.name} ${s.goal || ''} ${s.repo?.name || ''} ${s.repo?.root || ''} ${s.branch || ''}`));
  // first sighting in live order, so the first steady order starts out like the live one
  for (const s of [...inR].sort(liveOrder)) if (!firstSeen.has(s.id)) firstSeen.set(s.id, seenSeq++);
  shown.sort(local.steady ? steadyOrder : liveOrder);
  const ids = new Set(shown.map((s) => s.id));
  const clashes = (st.clashes || []).map((c) => ({ ...c, sessions: c.sessions.filter((x) => ids.has(x.id)) })).filter((c) => c.sessions.length >= 2);
  const feed = (st.feed || []).filter((e) => ids.has(e.sid));
  let filterNote = '';
  if (!shown.length && inR.length && q) filterNote = `nothing matches the filter "${local.query}" (Esc clears it)`;
  else if (!shown.length && local.repo) filterNote = `no live conversations in ${repoName(local.repo)}`;
  if (hiddenSaveDue) { hiddenSaveDue = false; saveHidden(); }
  const pending = pendingSessions(st);
  // a conversation that handed off to a fresh one (handoff.js) is replaced by it: off the strip and the map
  // (its successor's "picked up from" link still opens it)
  // (one still handing off is on the board as its stand-in, not in the strip)
  const replaced = new Set(all.filter((s) => (s.state === 'DONE' && s.handoff && s.handoff.next) || ho.stand.has(s.id)).map((s) => s.id));
  const finished = (st.finished || []).filter((f) => f && !replaced.has(f.id) && !(hidden.has(f.id) && all.some((s) => s.id === f.id && isHidden(s))) && !offRepo(f));
  // the map shows the strip's conversations too, so removing one from either takes it off both
  const finIds = new Set(finishedRows(finished).map((f) => f.id));
  return {
    ...st, settings: { ...(st.settings || {}), ...local }, sessions: shown,
    allSessions: all.filter((s) => !contIds.has(s.id)).concat(cont, pending),
    pending: pending.filter((s) => inRepo(s.repo)), clashes, allClashes: st.clashes || [], feed, filterNote,
    // handoffs in the last few minutes: old id -> its pickup's id (the views' hand-over motion)
    handoffPairs: ho.pairs,
    // continued stand-ins show on the map as dim nodes too, like the strip's
    finished, finishedSessions: all.filter((s) => s.state === 'DONE' && finIds.has(s.id) && !isHidden(s) && !contIds.has(s.id) && !offRepo(s)).concat(cont.filter((s) => inRepo(s.repo) && !offRepo(s))),
    // every listed repo in the picked one(s) gets its anchor on the map, conversations or not (the menu's list)
    repoAnchors: repoList(st).filter((r) => inRepo(r)).map((r) => ({ root: r.root, name: r.name, color: r.color })),
  };
}

// ---------- drawing ----------
let view = null; // the derived state last drawn
const viewEls = { cards: $('view-cards'), map: $('view-map'), wall: $('view-wall'), projects: $('view-projects') };

function render() {
  for (const v of VIEWS) viewEls[v].hidden = v !== local.view;
  for (const b of document.querySelectorAll('.tabs button')) {
    b.classList.toggle('on', b.dataset.view === local.view);
    b.setAttribute('aria-selected', String(b.dataset.view === local.view));
  }
  placeTabInd();
  $('view-map').classList.toggle('active', local.view === 'map');
  $('reconnecting').hidden = online || FIXTURE;
  $('reconnecting').textContent = state ? 'reconnecting…' : 'connecting…';
  drawClock();
  drawFooter();
  if (!state) return;
  view = derive(state);
  if (ui.selectedId && !view.allSessions.some((s) => s.id === ui.selectedId)) ui.selectedId = null;
  // a new session that ended before it ever spoke has nothing left to show
  if (ui.detailId && isNewKey(ui.detailId) && !view.allSessions.some((s) => s.id === ui.detailId)) ui.detailId = null;
  drawHeader(view);
  placeMiniButton();
  fitHeader();
  drawAlert(view);
  drawFinished(view);
  drawDetail(view);
  if (menuOpen) drawMenu();
  const el = viewEls[local.view];
  try {
    if (local.view === 'cards') renderCards(el, view, ui);
    else if (local.view === 'wall') renderWall(el, view, ui);
    else if (local.view === 'projects') renderProjects(el, view, ui);
    else if (renderMap) { el.classList.remove('map-missing'); renderMap(el, replay ? replayView(replay) : view, ui); }
    else if (mapMissing) { el.classList.add('map-missing'); el.textContent = 'The map view (map.js) is not available yet.'; }
  } catch (e) {
    console.error(e);
  }
  markMulti(el);
  drawReplayPill();
}

function drawClock() {
  $('clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// the server's title follows the saved repo (or a fixed --title); right after a pick it lags one poll behind
function brandText() {
  const serverRepo = state.settings?.repo ?? null;
  if (state.title && serverRepo === (local.repo || null)) return state.title;
  return (local.repo ? repoName(local.repo) : 'all workspaces').toUpperCase();
}

// what is left of each account's weekly Claude limit: "A 3%  B 98%  C 70% week left"
function weekPill(wk) {
  const acs = Object.keys(wk || {}).filter((a) => isAcct(a) && wk[a]).sort();
  if (!acs.length) return '';
  const col = (n) => (n <= 10 ? C.red : n <= 25 ? C.gold : C.text);
  const tip = acs.map((a) => `account ${a}: ${wk[a].left}% of the week left${wk[a].resets ? ', resets ' + new Date(wk[a].resets).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : ''}`).join('\n');
  return `<span class="count week" title="${esc(tip)}">`
    + acs.map((a) => `${singleAccount() ? '' : `<span class="acct acct-${a}">${a}</span>`}<b style="color:${col(wk[a].left)}">${wk[a].left}%</b>`).join('')
    + `<span class="count-k">week left</span></span>`;
}

// why an account can't start a conversation now ("1% of its week left, resets Fri 3 PM"), or '' when it can.
// 2% or less counts as out: a fresh conversation's first turns use about that. No usage data for it (not read
// yet, a failed read) counts as fine: nothing is held back on a guess.
const EMPTY_AT = 2;
function acctEmpty(a) {
  const w = state?.week?.[a], now = Date.now();
  if (!w) return '';
  const when = (t) => (t ? ', resets ' + new Date(t).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '');
  if (w.left <= EMPTY_AT) return `${w.left}% of its week left${when(w.resets)}`;
  const f = w.five;
  if (f && f.left <= EMPTY_AT && !(f.resets && f.resets < now)) return `${f.left}% of its 5-hour limit left${when(f.resets)}`;
  return '';
}

function drawHeader(v) {
  $('brand-name').textContent = brandText();
  const list = v.sessions;
  const agents = list.reduce((n, s) => n + (s.agents || []).filter((a) => a.state === 'run').length, 0);
  const waiting = list.filter((s) => needsYou(s.state)).length;
  const c = v.counts || {};
  const pill = (n, k, col, name, tip) => `<span class="count" title="${esc(tip)}"><span class="pill-ic" style="color:${col}">${icon(name, 13)}</span>`
    + `<b style="color:${col}">${esc(n)}</b><span class="count-k">${k}</span></span>`;
  const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  const html = [
    pill(list.length, 'live', C.cyan, 'live', n(list.length, 'live conversation', 'live conversations')),
    pill(agents, 'agents', C.violet, 'agent', n(agents, 'agent running', 'agents running')),
    pill(waiting, 'waiting', C.gold, 'waiting', `${waiting} waiting on you`),
    pill(c.mergedToday ?? 0, 'merged today', C.mint, 'merge', n(c.mergedToday ?? 0, 'PR merged today', 'PRs merged today')),
  ].join('') + (c.cost ? pill(fmtCost(c.cost), 'API cost', C.text, 'cost', `${fmtCost(c.cost)} at API prices, every conversation seen since Fleet View started`) : '')
    + weekPill(v.week);
  if ($('counts')._html !== html) { $('counts').innerHTML = html.replace(/<span class="pill-ic"[^>]*><\/span>/g, ''); $('counts')._html = html; }
}

// the alert's icon follows what happened
const alertIcon = (text) => {
  const t = String(text || '').toLowerCase();
  const name = /fail|error|stuck/.test(t) ? 'error' : /merged/.test(t) ? 'merge' : /\blive\b|production|deploy/.test(t) ? 'live'
    : /ask|question|waits|needs you/.test(t) ? 'waiting' : /finished|done|passed/.test(t) ? 'checks' : 'alert';
  return icon(name, 14) || icon('alert', 14);
};
// the alert line is rebuilt only when the alert changes (so a new one fades in once); its age ticks in place
let alertKey = '';
function drawAlert(v) {
  const al = v.alert && Date.now() - v.alert.t < 120e3 ? v.alert : null;
  const el = $('alert');
  if (!al) { if (alertKey) { el.innerHTML = ''; alertKey = ''; } return; }
  const s = v.allSessions.find((x) => x.id === al.sid);
  const name = s && !String(al.text).includes(s.name) ? `<b>${esc(s.name)}</b>` : '';
  const key = `${al.t}|${al.sid}|${al.text}|${al.color}|${name}|${iconsReady}`;
  if (key !== alertKey || !el.firstChild) {
    alertKey = key;
    el.innerHTML = `<span class="al"><span class="al-ic" style="color:${esc(al.color)}">${alertIcon(al.text) || '⚑'}</span>${name}`
      + `<span style="color:${esc(al.color)}">${esc(al.text)}</span><span class="al-ago"></span></span>`;
  }
  const t = `${ago(Date.now() - al.t)} ago`;
  const agoEl = el.querySelector('.al-ago');
  if (agoEl && agoEl.textContent !== t) agoEl.textContent = t;
}

// ---------- view switch: the selection glides between the tabs ----------
let tabPos = '';
function placeTabInd() {
  const tabs = document.querySelector('.tabs'), ind = tabs?.querySelector('.tab-ind');
  const on = tabs?.querySelector('button.on');
  if (!ind || !on || !on.offsetWidth) return;
  const pos = `${on.offsetLeft}|${on.offsetWidth}`;
  if (pos === tabPos) return;
  const first = !ind.classList.contains('placed');
  tabPos = pos;
  ind.style.transform = `translateX(${on.offsetLeft}px)`;
  ind.style.width = `${on.offsetWidth}px`;
  tabs.classList.add('has-ind');
  if (first) { ind.classList.add('placed'); requestAnimationFrame(() => ind.classList.add('glide')); }
}
window.addEventListener('resize', placeTabInd);
document.fonts?.ready.then(() => { tabPos = ''; placeTabInd(); });

// ---------- the desktop window's title bar: room for the native min / max / close buttons ----------
const wco = navigator.windowControlsOverlay;
function placeWindowControls() {
  if (!document.documentElement.classList.contains('titlebar')) return;
  let right = 140;
  try {
    const r = wco && wco.visible ? wco.getTitlebarAreaRect() : null;
    if (r && r.width > 0) right = Math.max(0, Math.round(window.innerWidth - (r.x + r.width)));
  } catch {}
  document.documentElement.style.setProperty('--wco-right', `${right}px`);
}
placeWindowControls();
wco?.addEventListener?.('geometrychange', () => { placeWindowControls(); fitHeader(true); });
window.addEventListener('resize', () => { placeWindowControls(); fitHeader(true); });

// there the header is one row of fixed height: when its contents don't fit (a narrow window, the filter box
// open, a long repo name), it drops the least needed parts, one step at a time (fit-1 .. fit-6 in app.css)
const FIT_STEPS = 6;
let fitKey = '';
function fitHeader(force = false) {
  if (!document.documentElement.classList.contains('titlebar')) return;
  const top = document.querySelector('.top');
  const key = `${window.innerWidth}|${$('brand-name').textContent}|${$('counts')._html || ''}|${filterBox.hidden}|${document.documentElement.style.getPropertyValue('--wco-right')}`;
  if (!force && key === fitKey) return;
  fitKey = key;
  const overflows = () => {
    const limit = top.getBoundingClientRect().right - parseFloat(getComputedStyle(top).paddingRight) + 0.5;
    return [...top.children].some((el) => el.offsetParent && el.getBoundingClientRect().right > limit);
  };
  for (let i = 1; i <= FIT_STEPS; i++) top.classList.remove(`fit-${i}`);
  for (let i = 1; i <= FIT_STEPS && overflows(); i++) top.classList.add(`fit-${i}`);
  tabPos = ''; placeTabInd(); // the tabs may have narrowed
}

// ---------- recently finished strip ----------
const finCache = {};
const setOnce = (id, html) => { if (finCache[id] !== html) { $(id).innerHTML = html; finCache[id] = html; } };
// minutes only, so a row is not rewritten every second under the pointer
const minsAgo = (ms) => (ms < 60e3 ? 'just now' : `${ago(ms)} ago`);
// the strip starts short (shortCount); "Show N more" opens the rest until the page reloads
let finMore = false;

// the strip's rows: the last 10 in the picked repo, newest first (the map shows the same ones); drawn short
function finishedRows(fin) {
  return (fin || []).filter((f) => f && f.id && inRepo(f.repo)).sort((a, b) => b.endedAt - a.endedAt).slice(0, 10);
}
function drawFinished(v) {
  const box = $('finished');
  const list = finishedRows(v.finished);
  box.hidden = !list.length;
  if (!list.length) return;
  const open = !!local.finishedOpen, now = Date.now();
  $('finished-toggle').setAttribute('aria-expanded', String(open));
  $('finished-toggle').title = open ? 'hide the recently finished list' : 'show the recently finished list';
  // folded, the list stays in the page (its height glides to 0) but can't be reached by Tab
  box.classList.toggle('collapsed', !open);
  $('finished-list').inert = !open;
  $('finished-count').textContent = String(list.length);
  setOnce('finished-peek', open ? '' : `<b>${esc(list[0].name)}</b> <span class="dim">${minsAgo(now - list[0].endedAt)}</span>`);
  const n = finMore ? list.length : shortCount(list, (f) => f.endedAt);
  const rest = list.length - n;
  const moreRow = rest >= 2 ? `<button type="button" class="fin-more" data-more="1">Show ${rest} more</button>`
    : finMore && shortCount(list, (f) => f.endedAt) < list.length - 1 ? '<button type="button" class="fin-more" data-more="0">Show less</button>' : '';
  setOnce('finished-list', list.slice(0, rest >= 2 ? n : list.length).map((f) => `<div class="fin-row${ui.detailId === f.id ? ' picked' : ''}" data-id="${esc(f.id)}" role="button" tabindex="0" title="show ${esc(f.name)} in the panel">`
    + `<span class="fin-time">${clockTime(f.endedAt, false)}</span><span class="fin-ago">${minsAgo(now - f.endedAt)}</span>${acctTag(f.account) || '<span></span>'}`
    + `<span class="fin-name">${esc(f.name)}</span><span class="fin-repo">${f.repo ? repoChip({ repo: f.repo }) : ''}</span>`
    + `<span class="fin-sum">${esc(f.summary || '')}</span>`
    + `<button type="button" class="fin-x" data-x="1" aria-label="Remove ${esc(f.name)}" title="Remove">${icon('close', 13) || '×'}</button></div>`).join('') + moreRow);
}
// the row's x: the menu's Remove (ends it first when it runs here; asks first if Claude is mid-turn)
function removeFinished(id, x, y) {
  const s = view?.allSessions.find((o) => o.id === id);
  if (!s) { toast('that conversation is no longer in the list', C.dim); return; }
  const hosted = isHosted(id), st = hosted ? hostStatus(id) : null;
  const busy = hosted && (st ? st === 'busy' : s.state === 'WORKING' || s.state === 'AGENTS');
  if (!busy) { removeFromMenu(id); return; }
  openCtxMenu({ x, y, title: s.name, dot: statusColor(s), sub: BUSY_Q, items: [
    { label: 'Remove anyway', icon: 'close', danger: true, run: () => removeFromMenu(id) },
    { label: 'Cancel', icon: 'close', cancel: true },
  ] });
}
$('finished-toggle').addEventListener('click', () => { saveSettings({ finishedOpen: !local.finishedOpen }); render(); });
function pickFinished(row) {
  const id = row?.dataset.id;
  if (!id) return;
  if (!state?.sessions?.some((s) => s.id === id)) { toast('that conversation is no longer in the list', C.dim); return; }
  ui.showDetail(id, 'click');
}
$('finished-list').addEventListener('click', (e) => {
  const more = e.target.closest('.fin-more');
  if (more) { e.stopPropagation(); finMore = more.dataset.more === '1'; render(); return; }
  const x = e.target.closest('.fin-x');
  if (x) {
    e.stopPropagation();
    const r = x.getBoundingClientRect();
    removeFinished(x.closest('.fin-row')?.dataset.id, e.clientX || r.left, e.clientY || r.bottom);
    return;
  }
  pickFinished(e.target.closest('.fin-row'));
});
$('finished-list').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  if (e.target.closest('.fin-x, .fin-more')) { e.stopPropagation(); return; } // the button clicks itself
  e.preventDefault(); e.stopPropagation();
  pickFinished(e.target.closest('.fin-row'));
});

// ---------- detail panel ----------
let splitKey = ''; // the selection the panel last opened for by itself (drawDetail)
let detailLast = null; // the panel's last copy of its conversation, shown (marked) if it leaves the list
function drawDetail(v) {
  // a pinned conversation that left the list (removed, hidden) lets go of the pin; otherwise it holds the panel
  if (pinnedId && state && !v.allSessions.some((x) => x.id === pinnedId)) setPin(null);
  if (pinnedId) ui.detailId = pinnedId;
  const shut = local.view === 'projects' && !projPanel && !pinnedId;
  let s = ui.detailId && !shut ? v.allSessions.find((x) => x.id === ui.detailId) : null;
  // 2+ selected: their chats share the panel (detail.js drawSplits, SPLIT_MAX at most); with none shown, the first opens it
  const sel = multi.size >= 2 ? [...multi].map((id) => v.allSessions.find((x) => x.id === id)).filter(Boolean) : [];
  // (once per selection: a panel closed by hand stays closed until the selection changes)
  const key = sel.map((x) => x.id).join(',');
  if (!s && !shut && sel.length >= 2 && key !== splitKey) { s = sel[0]; ui.detailId = s.id; }
  splitKey = key;
  const extras = s ? sel.filter((x) => x.id !== s.id) : [];
  let gone = false;
  if (!shut && ui.detailId && !s && detailLast?.id === ui.detailId) { s = detailLast; gone = true; }
  if (!s) { if (!shut) ui.detailId = null; }
  else if (!gone) detailLast = s;
  try { renderDetail($('detail'), s, ui, gone, extras); } catch (e) { console.error(e); }
  if (s && !$('work').classList.contains('detail-open')) detailShownAt = performance.now();
  $('work').classList.toggle('detail-open', !!s);
}
// The first click of a double-click on a card or tile opens the panel, which slides in over (or beside) the
// view, so the second click can land on the panel: on a link, a button or the ×. That second click is not
// for the panel. It is dropped, and the double-click opens the conversation the first click picked.
let detailShownAt = -1e9;
const panelJustOpened = (e) => performance.now() - detailShownAt < 700 && !!e.target.closest?.('#detail');
document.addEventListener('click', (e) => { if (e.detail >= 2 && panelJustOpened(e)) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
document.addEventListener('dblclick', (e) => {
  if (!panelJustOpened(e)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (local.view !== 'map' && ui.detailId) ui.open(ui.detailId);
}, true);

// ---------- links: PR / branch / deploy in the browser, files in VS Code, folders in Explorer ----------
function openUrl(url) {
  if (!isHttps(url)) return false;
  window.open(url, '_blank', 'noopener');
  return true;
}
async function reveal(w) {
  if (!w || (w.kind !== 'file' && w.kind !== 'folder') || !w.path) return;
  const name = String(w.path).split(/[\\/]/).filter(Boolean).pop() || String(w.path);
  if (FIXTURE) { toast(`fixture data: would open ${w.kind === 'file' ? `${name} in VS Code` : `${w.path} in Explorer`}`, C.dim); return; }
  const body = { kind: w.kind, path: String(w.path) };
  if (Number.isInteger(w.line) && w.line > 0) body.line = w.line;
  const r = await post('/reveal', body);
  if (!r) toast('could not reach Fleet View to open it', C.red);
  else toast(r.message || (r.ok ? `opened ${name}` : `could not open ${name}`), r.ok ? C.mint : C.red);
}
// caught before the card, tile or panel under the link sees the click, so a link never picks a card.
// A slot can be rewritten between press and release (a "working 45s" timer beside a link). The browser then
// sends no click at all, so a link whose element went away under a press that didn't move opens on the
// release instead, and a click that may still follow is dropped.
let pressed = null; // { el, d: its dataset, x, y, t }
let lastAct = { key: '', t: 0 };
let dropClickUntil = 0;
function activate(d) {
  if (menuOpen) closeMenu();
  // one gesture, one open: a double-click on a link opens it once
  const key = `${d.act}|${d.url || ''}|${d.kind || ''}|${d.path || ''}|${d.id || ''}`, now = performance.now();
  if (key === lastAct.key && now - lastAct.t < 600) return;
  lastAct = { key, t: now };
  if (d.act === 'url') ui.openUrl(d.url);
  else if (d.act === 'reveal') ui.reveal({ kind: d.kind, path: d.path, line: parseInt(d.line, 10) || undefined });
  else if (d.act === 'session') showSession(d.id);
  else if (d.act === 'peek') openPeekFor(d.for, d.kind);
}
// a picked-up conversation's previous one, under its chat in the panel (detail.js openPeek): its chat, read only,
// or its handoff summary. It doesn't come back on the map and nothing starts.
function openPeekFor(forId, kind) {
  const s = (view?.allSessions || state?.sessions || []).find((x) => x.id === forId);
  const p = s && s.pickedUpFrom;
  if (!p || !p.id) return;
  openPeek({ for: s.id, kind, id: p.id, name: p.name, file: p.file || null });
  tabWant = { id: s.id, tab: 'chat' };
  if (local.view === 'projects') projPanel = true;
  ui.showDetail(s.id);
}
// a picked-up conversation's "Previous conversation ▸": its chat (read only) and the handoff summary, under its chat
function previousMenuItem(s) {
  const p = s.pickedUpFrom;
  if (!p || !p.id) return null;
  return { label: 'Previous conversation', icon: 'clock', note: p.name || null, children: [
    { label: 'Read its chat', icon: 'read', note: 'under this one, read only', run: () => openPeekFor(s.id, 'chat') },
    p.file ? { label: 'Read the handoff summary', icon: 'file', run: () => openPeekFor(s.id, 'summary') } : { label: 'Read the handoff summary', icon: 'file', disabled: true, note: 'no summary file' },
  ] };
}
// a link to another conversation (handoffs): a shown one is picked like a click on it; a finished or filtered
// out one opens in the panel
function showSession(id) {
  if (!state || !id) return;
  if ((state.sessions || []).some((x) => x.id === id)) return fvSelect(id);
  if ((state.allSessions || []).some((x) => x.id === id)) return ui.showDetail(id, 'click');
  toast('that conversation is no longer listed', C.dim);
}
document.addEventListener('pointerdown', (e) => {
  const a = e.button === 0 ? e.target.closest?.('[data-act]') : null;
  pressed = a ? { el: a, d: { ...a.dataset }, x: e.clientX, y: e.clientY, t: performance.now() } : null;
}, true);
document.addEventListener('pointerup', (e) => {
  const p = pressed;
  pressed = null;
  if (!p || p.el.isConnected || e.button !== 0) return;
  if (performance.now() - p.t > 1000 || Math.abs(e.clientX - p.x) > 5 || Math.abs(e.clientY - p.y) > 5) return;
  dropClickUntil = performance.now() + 500;
  activate(p.d);
}, true);
document.addEventListener('click', (e) => {
  const a = e.target.closest?.('[data-act]');
  if (!a && performance.now() > dropClickUntil) return;
  e.preventDefault();
  e.stopPropagation();
  if (performance.now() <= dropClickUntil) { dropClickUntil = 0; return; } // opened on the release already
  activate(a.dataset);
}, true);
// a double-click on a link must not also open the conversation of the card under it
for (const type of ['dblclick', 'auxclick']) {
  document.addEventListener(type, (e) => {
    if (e.target.closest?.('[data-act]') || (type === 'dblclick' && performance.now() - lastAct.t < 700)) { e.preventDefault(); e.stopPropagation(); }
  }, true);
}

// footer keys: [keys (each drawn as a key cap; '/' between two of them reads "or"), what they do]
const KEYS = {
  cards: [['v', 'view'], ['↑↓←→', 'pick'], ['enter/o', 'open'], ['double-click', 'open'], ['ctrl+click', 'select more'], ['right-click', 'menu'], ['ctrl+c', 'copy'], ['ctrl+z', 'undo'], ['c', 'compact'], ['s', 'ORDER'], ['/', 'filter'], ['r', 'workspace'], ['w', 'since you looked'], ['esc', 'clear']],
  map: [['v', 'view'], ['click', 'select'], ['ctrl+click', 'select more'], ['double-click', 'open'], ['right-click', 'menu'], ['ctrl+c', 'copy'], ['ctrl+z', 'undo'], ['wheel', 'zoom'], ['drag', 'pan'], ['0', 'recenter'], ['n/N', 'needs you'], ['k', 'lens'], ['t', 'replay'], ['l', 'legend'], ['/', 'filter'], ['r', 'workspace']],
  wall: [['v', 'view'], ['↑↓←→', 'pick'], ['enter/o', 'open'], ['double-click', 'open'], ['ctrl+click', 'select more'], ['right-click', 'menu'], ['ctrl+c', 'copy'], ['ctrl+z', 'undo'], ['s', 'ORDER'], ['/', 'filter'], ['r', 'workspace'], ['w', 'since you looked'], ['esc', 'clear']],
  projects: [['v', 'view'], ['↑↓', 'pick'], ['enter', 'type'], ['right-click', 'menu'], ['/', 'filter'], ['r', 'workspace'], ['esc', 'clear']],
};
const MOUSE = new Set(['click', 'double-click', 'right-click', 'wheel', 'drag', 'ctrl+click']);
const keyHtml = ([keys, label]) => {
  const caps = keys === '/' ? ['/'] : keys.split('/');
  const k = MOUSE.has(keys) ? `<kbd class="mouse">${keys}</kbd>` : caps.map((c) => `<kbd>${esc(c)}</kbd>`).join('<span class="key-or">/</span>');
  return `<span class="key">${k}<span class="key-l">${esc(label)}</span></span>`;
};
let footKeys = '', footInfo = '';
function drawFooter() {
  const order = local.steady ? 'steady order' : 'live order';
  // while the live terminal has the keyboard, every key goes to Claude; say how to get the shortcuts back
  const keys = (termFocused() ? [['click', 'outside the terminal or chat box for the shortcuts'], ['ctrl+c', 'copy a selection']]
    : KEYS[local.view].map(([k, l]) => [k, l === 'ORDER' ? order : l])
      .concat(isDesktop() ? [['m', 'mini']] : [], ui.detailId && !pinnedId ? [['esc', 'close panel']] : [])).map(keyHtml).join('');
  if (keys !== footKeys) { $('keys').innerHTML = keys; footKeys = keys; }
  const bits = [];
  if (local.query) bits.push(`<span class="note">filter: ${esc(local.query)} (esc clears)</span>`);
  if (state?.hiddenDone) bits.push(`<span class="note">${state.hiddenDone} finished, hidden</span>`);
  if (FIXTURE) bits.push('<span class="note demo">fixture data, nothing here is real</span>');
  else if (state?.demo) bits.push('<span class="note demo">demo data, nothing here is real</span>');
  const info = bits.join('');
  if (info !== footInfo) { $('foot-info').innerHTML = info; footInfo = info; }
}

// ---------- steady / live order (key s) ----------
function toggleSteady() {
  saveSettings({ steady: !local.steady });
  toast(local.steady ? 'steady order: who needs you first, the rest stay put' : 'live order: most recent activity first', C.dim);
  render();
}

// ---------- mini window (desktop only, key m) ----------
const isDesktop = () => !!(window.fleetDesktop && window.fleetDesktop.isDesktop);
function toggleMini() {
  if (isDesktop() && typeof window.fleetDesktop.toggleMini === 'function') window.fleetDesktop.toggleMini();
}
// the header button is the header's last item: before the native window buttons, outside the drag region
function placeMiniButton() {
  const old = $('mini-btn');
  if (!isDesktop()) { old?.remove(); return; }
  if (old) { if (!old._ic && iconsReady) { old.innerHTML = icon('open', 15); old._ic = true; } return; }
  const b = document.createElement('button');
  b.id = 'mini-btn'; b.type = 'button'; b.className = 'mini-btn';
  b.title = 'Mini view (m)'; b.setAttribute('aria-label', 'Mini view');
  b.innerHTML = icon('open', 15) || '<span class="mini-fb" aria-hidden="true"></span>';
  b._ic = iconsReady;
  b.addEventListener('click', (e) => { e.stopPropagation(); toggleMini(); });
  document.querySelector('.top')?.appendChild(b);
  fitHeader(true);
}

// ---------- select from outside (the desktop mini window) ----------
let pendingSelect = null;
function fvSelect(id) {
  if (!id) return;
  if (!state) { pendingSelect = id; return; }
  const s = (state.sessions || []).find((x) => x.id === id || x.name === id);
  if (!s) return;
  if (s.state === 'DONE') { ui.showDetail(s.id, 'click'); return; }
  ui.setSelected(s.id, 'click'); // keeps the current view, opens the panel, scrolls the card or tile into view
  // again once the panel has slid in (main's margin glides for 0.2s), which can narrow the grid and move the card
  if (local.view !== 'map') setTimeout(() => { if (ui.selectedId === s.id) document.querySelector(`#view-${local.view} [data-id="${CSS.escape(s.id)}"]`)?.scrollIntoView({ block: 'nearest' }); }, 260);
}
window.fvSelect = fvSelect;

// ---------- views ----------
function setView(v) {
  if (!VIEWS.includes(v) || v === local.view) return;
  projPanel = false;
  saveSettings({ view: v });
  render();
}
for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => setView(b.dataset.view));

// ---------- repo menu ----------
let menuOpen = false, menuSel = 0, menuItems = [];
// the repo list every view shares: /state's repos[] (and the ones added here that it doesn't list yet), less the
// removed ones; each with its colour (the server's, else its conversations', else dim)
function repoList(st) {
  const out = [], seen = new Set();
  const colorOf = (root) => (st?.sessions || []).find((s) => s.repo && normRoot(s.repo.root) === normRoot(root))?.repo.color || null;
  for (const r of st?.repos || []) {
    const k = normRoot(r.root);
    if (!r.root || seen.has(k) || repoIsHidden(r.root)) continue;
    seen.add(k);
    if (!FIXTURE && addedLocal.has(k)) addedLocal.delete(k); // /state lists it now
    out.push({ root: r.root, name: r.name || repoName(r.root), live: r.live || 0, added: !!r.added || addedLocal.has(k), color: r.color || colorOf(r.root) || C.dim });
  }
  for (const [k, a] of addedLocal) {
    if (seen.has(k) || repoIsHidden(a.root)) continue;
    seen.add(k);
    out.push({ root: a.root, name: a.name, live: 0, added: true, color: a.color || colorOf(a.root) || C.dim });
  }
  return out;
}
function buildMenuItems() {
  const repos = repoList(state).sort((a, b) => isHomeRoot(a.root) - isHomeRoot(b.root) || b.live - a.live || a.name.localeCompare(b.name));
  if (local.repo && !repoIsHidden(local.repo) && !repos.some((r) => inRepo({ root: r.root, name: r.name }))) repos.push({ root: local.repo, name: repoName(local.repo), live: 0 });
  const total = repos.reduce((n, r) => n + (r.live || 0), 0);
  return [{ root: null, name: 'All workspaces', live: total }, ...repos];
}
const isCurrent = (it) => (it.root ? !!local.repo && inRepo({ root: it.root, name: it.name }) : !local.repo);
function openMenu() {
  if (!state) return;
  menuOpen = true;
  menuItems = buildMenuItems();
  menuSel = Math.max(0, menuItems.findIndex(isCurrent));
  $('repo-menu').hidden = false;
  $('brand').setAttribute('aria-expanded', 'true');
  drawMenu();
  render();
}
function closeMenu() {
  menuOpen = false;
  addBox = null; addChoose = false;
  $('repo-menu').hidden = true;
  $('brand').setAttribute('aria-expanded', 'false');
  render();
}
// "Add workspace" in the menu: picking it shows its three ways in its place (addChoose); "Paste path" then
// becomes a path box ({ value, msg, err }), null while it is a row
let addBox = null, addChoose = false;
const ADD_WAYS = [
  { way: 'path', key: 'p', icon: 'plus', label: 'Paste path', title: 'type or paste a folder path' },
  { way: 'scratch', key: 's', icon: 'plus', label: 'New scratchpad', title: 'make a new empty folder under Scratchpads and add it' },
  { way: 'browse', key: 'b', icon: 'folder', label: 'Browse', title: 'pick the folder in a window' },
];
function drawMenu() {
  menuItems = buildMenuItems();
  menuSel = Math.min(menuSel, menuItems.length - 1);
  const colorOf = (root) => menuItems.find((r) => r.root && normRoot(r.root) === normRoot(root))?.color || C.dim;
  // written only when it changed: the open menu is redrawn on every poll, and rewriting it would drop the
  // row under the pointer and repaint the frosted box for nothing
  const html = menuItems.map((it, i) => `<div class="menu-item${i === menuSel ? ' sel' : ''}" data-i="${i}" role="option" aria-selected="${isCurrent(it)}">
    <span class="mi-n">${i < 9 ? i + 1 : ''}</span><span class="dot" style="background:${it.root ? colorOf(it.root) : C.text}"></span>
    <span class="mi-name">${esc(it.name)}</span><span class="mi-live">${it.live} live</span><span class="mi-cur">${isCurrent(it) ? '✓' : ''}</span>`
    + (it.root ? `<button type="button" class="mi-x" data-rm="${i}" tabindex="-1" aria-label="Remove ${esc(it.name)} from the list" title="Remove from the list">×</button>` : '<span></span>')
    + '</div>').join('')
    + (addBox
      ? `<div class="mi-add-box"><input class="mi-add-input path-input" type="text" spellcheck="false" autocomplete="off" placeholder="${esc(ADD_HINT)}" aria-label="Add workspace: folder path">`
        + `<div class="mi-add-msg${addBox.err ? ' err' : ''}" aria-live="polite">${esc(addBox.msg || 'Enter adds · Esc goes back')}</div></div>`
      : addChoose
      ? '<div class="mi-ways">' + ADD_WAYS.map((w) => {
        const off = w.way === 'browse' && !canPickFolder();
        return `<div class="menu-item mi-add mi-way${off ? ' off' : ''}" data-way="${w.way}" role="option" aria-selected="false"${off ? ' aria-disabled="true"' : ''} title="${esc(off ? 'only in the desktop window' : w.title)}">`
          + `<span class="mi-add-ic" aria-hidden="true">${icon(w.icon, 14) || '+'}</span><span></span><span class="mi-name">${esc(w.label)}</span>`
          + `<span class="mi-key">${off ? 'desktop window only' : w.key}</span></div>`;
      }).join('') + '</div>'
      : `<div class="menu-item mi-add" data-add="1" role="option" aria-selected="false" title="add a workspace: paste a path, a new scratchpad or browse">`
        + `<span class="mi-add-ic" aria-hidden="true">${icon('plus', 14) || '+'}</span><span></span><span class="mi-name">Add workspace</span></div>`)
    + `<div class="menu-hint">${addChoose ? 'p path · s scratchpad · b browse · esc back' : '↑↓ pick · enter show · 1-9 jump · del remove · a add · esc close'}</div>`;
  const menu = $('repo-menu');
  if (menu._html !== html) {
    // a rewrite keeps the path box's text, caret and focus
    const box = menu.querySelector('.mi-add-input'), had = box && document.activeElement === box, caret = box ? box.selectionStart : null;
    menu.innerHTML = html; menu._html = html;
    const nb = menu.querySelector('.mi-add-input');
    if (nb && addBox) { nb.value = addBox.value; if (had || addBox.focus) { addBox.focus = false; nb.focus({ preventScroll: true }); if (caret !== null) nb.setSelectionRange(caret, caret); } }
  }
}
// the menu's "Add workspace": its three ways in its place
function chooseAddInMenu(on = true) {
  addChoose = on; addBox = null;
  drawMenu();
}
// one of them: the path box in its place, a new scratchpad, or the system folder picker (desktop window)
function addWayInMenu(way) {
  if (way === 'path') {
    addChoose = false;
    addBox = { value: '', msg: '', err: false, focus: true };
    $('repo-menu')._html = ''; // rewrite it, with the box focused
    drawMenu();
  } else if (way === 'scratch') { closeMenu(); addScratchRepo(); }
  else if (way === 'browse' && canPickFolder()) { closeMenu(); pickAndAddRepo(); }
}
async function submitAddBox() {
  if (!addBox) return;
  const text = addBox.value.trim();
  if (!text) { addBox.msg = 'paste or type a folder path first'; addBox.err = true; drawMenu(); return; }
  addBox.msg = 'adding…'; addBox.err = false; drawMenu();
  const err = await addRepoPath(text);
  if (!addBox) return;
  if (err) { addBox.msg = err; addBox.err = true; addBox.focus = true; drawMenu(); return; }
  addBox = null;
  drawMenu();
}
function pickRepo(it) {
  closeMenu();
  if (!it) return;
  ui.selectedId = null;
  saveSettings({ repo: it.root });
  toast(`showing ${it.root ? repoName(it.root) : 'every workspace'}`, C.mint);
  render();
}
$('brand').addEventListener('click', (e) => { e.stopPropagation(); menuOpen ? closeMenu() : openMenu(); });
$('repo-menu').addEventListener('click', (e) => {
  e.stopPropagation();
  if (e.target.closest('.mi-add-box')) return;
  const way = e.target.closest('[data-way]');
  if (way) { addWayInMenu(way.dataset.way); return; }
  if (e.target.closest('[data-add]')) { chooseAddInMenu(); return; }
  const x = e.target.closest('.mi-x');
  if (x) { removeRepo(menuItems[+x.dataset.rm]); return; }
  const row = e.target.closest('.menu-item');
  if (row) pickRepo(menuItems[+row.dataset.i]);
});
// the path box's keys: typing is its own; Enter adds, Esc goes back to the three ways (nothing reaches the shortcuts)
$('repo-menu').addEventListener('input', (e) => { if (addBox && e.target.closest('.mi-add-input')) addBox.value = e.target.value; });
$('repo-menu').addEventListener('keydown', (e) => {
  if (!e.target.closest('.mi-add-input')) return;
  e.stopPropagation();
  if (e.key === 'Enter') { e.preventDefault(); submitAddBox(); }
  else if (e.key === 'Escape') { e.preventDefault(); chooseAddInMenu(); }
});
// a right-click on a row: show it or take it off the list
$('repo-menu').addEventListener('contextmenu', (e) => {
  if (e.target.closest('.mi-add-input')) { e.stopPropagation(); return; } // the browser's own menu (paste)
  e.preventDefault();
  e.stopPropagation();
  const row = e.target.closest('.menu-item[data-i]');
  const it = row && menuItems[+row.dataset.i];
  if (!it) return;
  const color = it.root ? state?.sessions?.find((s) => s.repo && normRoot(s.repo.root) === normRoot(it.root))?.repo.color || C.dim : C.text;
  closeMenu();
  const items = [{ label: it.root ? `Show only ${it.name}` : 'Show every workspace', icon: 'repo', run: () => pickRepo(it) }];
  if (it.root) items.push(...repoOrderItems(it.root, it.name), { sep: true }, { label: 'Remove from list', icon: 'hide', run: () => removeRepo(it) });
  openCtxMenu({ x: e.clientX, y: e.clientY, title: it.name, dot: color, sub: it.root || `${it.live} live`, items });
});
document.addEventListener('click', () => { if (menuOpen) closeMenu(); });

// ---------- / filter ----------
const filterBox = $('filter-box'), filterInput = $('filter-input');
function openFilter() {
  filterBox.hidden = false;
  filterInput.value = local.query;
  fitHeader();
  filterInput.focus();
  filterInput.select();
}
function closeFilter(clear) {
  if (clear) { local.query = ''; filterInput.value = ''; }
  saveSettings({ query: local.query });
  filterBox.hidden = !local.query;
  filterInput.blur();
  render();
}
filterInput.addEventListener('input', () => { local.query = filterInput.value; render(); });
filterInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); closeFilter(false); }
  else if (e.key === 'Escape') { e.preventDefault(); closeFilter(true); }
  e.stopPropagation();
});
filterInput.addEventListener('blur', () => { if (!local.query) { filterBox.hidden = true; fitHeader(); } });

// ---------- opening a conversation ----------
let confirmFor = null, lastOpen = { id: null, t: 0 };
function openSession(id) {
  const s = state?.sessions?.find((x) => x.id === id) || view?.allSessions?.find((x) => x.id === id && x.continued);
  if (!s) return;
  if (lastOpen.id === id && Date.now() - lastOpen.t < 600) return; // one gesture, one open
  lastOpen = { id, t: Date.now() };
  if (s.state !== 'DONE') showConfirm(s);
  else doOpen(s);
}
function showConfirm(s) {
  confirmFor = s;
  $('confirm-text').innerHTML = `<b>${esc(s.name)}</b> may still be open in another window. Open a second copy?`;
  $('confirm-yes').textContent = 'Open a second copy';
  $('confirm').hidden = false;
  $('confirm-yes').focus();
}
// the same box for any yes/no: html is the question, run happens on yes
function askConfirm(html, yes, run) {
  confirmFor = { run };
  $('confirm-text').innerHTML = html;
  $('confirm-yes').textContent = yes;
  $('confirm').hidden = false;
  $('confirm-yes').focus();
}
function hideConfirm() { confirmFor = null; $('confirm').hidden = true; }
$('confirm-yes').addEventListener('click', () => { const s = confirmFor; hideConfirm(); if (s && s.run) s.run(); else if (s) doOpen(s); });
$('confirm-no').addEventListener('click', hideConfirm);
async function doOpen(s) {
  if (FIXTURE) { toast(`fixture data: ${s.name} is not a real conversation`, C.dim); return; }
  const r = await post('/open', { id: s.id });
  if (!r) toast('could not reach Fleet View to open it', C.red);
  else toast(r.message || (r.ok ? `opened ${s.name}` : `could not open ${s.name}`), r.ok ? C.mint : C.red);
}

// ---------- toasts: appear, then fade out by age ----------
// action: { label, run, ms? } adds a button (e.g. "Undo") that works until the toast goes (ms, 4 s by default)
// ms: how long it stays without an action (4 s by default; a long outcome line stays longer)
function toast(text, color = C.text, action = null, ms = 0) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span class="toast-dot" style="background:${esc(color)}"></span><span class="toast-t">${esc(text)}</span>`;
  const life = action?.ms || ms || 4000;
  let entry = null;
  if (action && action.label === 'Undo') { entry = { run: action.run, text, el, at: Date.now() }; undoStack.push(entry); if (undoStack.length > 30) undoStack.shift(); }
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'toast-act';
    b.textContent = action.label;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (el.classList.contains('gone')) return;
      el.classList.add('gone');
      setTimeout(() => el.remove(), 800);
      if (entry) dropUndo(entry);
      action.run();
    });
    el.appendChild(b);
  }
  $('toasts').appendChild(el);
  setTimeout(() => el.classList.add('gone'), life);
  setTimeout(() => el.remove(), life + 800);
}

// ---------- Ctrl+Z: undo the newest change that offered Undo (removing, moving, renaming), up to 10 minutes back ----------
function dropUndo(entry) { const i = undoStack.indexOf(entry); if (i >= 0) undoStack.splice(i, 1); }
function undoLast() {
  while (undoStack.length && Date.now() - undoStack[undoStack.length - 1].at > UNDO_MS) undoStack.pop();
  const u = undoStack.pop();
  if (!u) { toast('Nothing to undo', C.dim); return; }
  if (u.el.isConnected) { u.el.classList.add('gone'); setTimeout(() => u.el.remove(), 800); }
  if (lastRemoved?.undo === u.run) lastRemoved = null;
  try { u.run(); } catch (e) { console.error(e); }
  toast(`Undone: ${u.text.replace(/\. (It|Each) comes back.*$/, '')}`, C.mint);
}
// ---------- Ctrl+C: copy what is picked (outside text boxes, with no text selected) ----------
// conversations: "name (id)" a line each, the multi-selection or the picked one; a workspace picked on the map or
// the workspace menu's highlighted row: its folder path
async function copyPicked() {
  let text = '', what = '';
  const p = local.view === 'map' ? mapMod?.mapPicked?.() : null;
  const list = sessionsOf(multi.size ? [...multi] : ui.selectedId ? [ui.selectedId] : ui.detailId ? [ui.detailId] : []);
  if (menuOpen && menuItems[menuSel]?.root) { text = menuItems[menuSel].root; what = menuItems[menuSel].name || repoName(text); }
  else if (p && p.kind === 'repo' && p.root) { text = p.root; what = p.name || repoName(p.root); }
  else if (list.length) {
    text = list.map((s) => (s.pending ? s.name : `${s.name} (${s.id})`)).join('\n');
    what = list.length === 1 ? list[0].name : `${list.length} conversations`;
  }
  if (!text) { toast('Pick a conversation or workspace to copy', C.dim); return; }
  try { await navigator.clipboard.writeText(text); toast(`Copied ${what}`, C.mint); }
  catch { toast('Could not reach the clipboard', C.red); }
}
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
  const k = e.key.toLowerCase();
  if (k !== 'c' && k !== 'z') return;
  if (e.target.closest?.('.term-host, .chat-compose, input, textarea, select, [contenteditable]')) return;
  if (!$('confirm').hidden) return;
  if (k === 'c') {
    // selected text copies as usual
    const sel = window.getSelection?.();
    if (sel && !sel.isCollapsed && String(sel).trim()) return;
    e.preventDefault();
    copyPicked();
    return;
  }
  e.preventDefault();
  undoLast();
});

// ---------- keys ----------
// the live terminal (term.js) owns the keyboard while it has focus: no shortcut fires, Esc goes to Claude
const termFocused = () => !!document.activeElement?.closest?.('.term-host, .chat-compose');
document.addEventListener('focusin', () => drawFooter());
document.addEventListener('focusout', () => setTimeout(drawFooter, 0));
function gridCols() {
  const g = viewEls[local.view].querySelector('.grid');
  if (!g) return 1;
  return Math.max(1, getComputedStyle(g).gridTemplateColumns.split(' ').filter(Boolean).length);
}
function movePick(dx, dy) {
  const ids = view ? view.sessions.map((s) => s.id) : [];
  if (!ids.length) return;
  let i = ids.indexOf(ui.selectedId);
  if (i < 0) { ui.setSelected(ids[0], 'keys'); return; }
  const cols = gridCols();
  i = Math.max(0, Math.min(ids.length - 1, i + dx + dy * cols));
  if (ids[i] !== ui.selectedId) ui.setSelected(ids[i], 'keys');
}

document.addEventListener('keydown', (e) => {
  if (e.target.closest?.('.term-host')) return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  const k = e.key;
  if (!$('confirm').hidden) {
    if (k === 'Escape' || k === 'n') { e.preventDefault(); hideConfirm(); }
    else if (k === 'Enter' || k === 'y') { e.preventDefault(); $('confirm-yes').click(); }
    return;
  }
  if (menuOpen) {
    e.preventDefault();
    if (addChoose && (k === 'Escape' || k === 'a')) chooseAddInMenu(false);
    else if (addChoose && ADD_WAYS.some((w) => w.key === k)) addWayInMenu(ADD_WAYS.find((w) => w.key === k).way);
    else if (k === 'Escape') closeMenu();
    else if (k === 'ArrowDown' || k === 'j') { menuSel = (menuSel + 1) % menuItems.length; drawMenu(); }
    else if (k === 'ArrowUp' || k === 'k') { menuSel = (menuSel - 1 + menuItems.length) % menuItems.length; drawMenu(); }
    else if (k === 'Enter') pickRepo(menuItems[menuSel]);
    else if (k === 'Delete') removeRepo(menuItems[menuSel]);
    else if (k === 'a') chooseAddInMenu();
    else if (k === 'u' && lastRemoved && Date.now() < lastRemoved.until) lastRemoved.undo();
    else if (/^[1-9]$/.test(k) && menuItems[+k - 1]) pickRepo(menuItems[+k - 1]);
    else if (k === 'r') closeMenu();
    return;
  }
  // Enter on a focused link, panel button or finished row belongs to it
  if ((k === 'Enter' || k === ' ') && e.target.closest?.('a[data-act], .detail button, .fin-head, .fin-row')) return;
  // Esc closes the innermost thing first: confirm, repo menu, filter box (above), "Since you looked", the map's
  // legend (and its own multi-selection), the multi-selection, the panel
  if (k === 'Escape' && since.isOpen()) { e.preventDefault(); since.close(); return; }
  if (k === 'Escape' && local.view === 'map' && ui.keys.map && ui.keys.map(e)) return;
  if (k === 'Escape' && multi.size) { e.preventDefault(); setMulti([], 'keys'); return; }
  if (k === 'Escape' && ui.detailId && !pinnedId) { e.preventDefault(); ui.showDetail(null); return; }
  // arrows and paging inside the panel scroll it instead of moving the pick
  if (e.target.closest?.('#detail') && /^(Arrow|Page|Home|End)/.test(k)) return;
  if (k === 'v' || k === 'Tab') { e.preventDefault(); setView(VIEWS[(VIEWS.indexOf(local.view) + (e.shiftKey && k === 'Tab' ? VIEWS.length - 1 : 1)) % VIEWS.length]); return; }
  if (k === '/') { e.preventDefault(); openFilter(); return; }
  if (k === 'r') { e.preventDefault(); openMenu(); return; }
  if (k === 'w') { e.preventDefault(); since.toggle(); return; }
  if (k === 'Escape') {
    let handled = false;
    if (local.view === 'map' && ui.keys.map) handled = !!ui.keys.map(e);
    if (!handled) {
      if (local.query) closeFilter(true);
      ui.setSelected(null);
    }
    return;
  }
  if (local.view === 'projects' && ui.keys.projects && ui.keys.projects(e)) { e.preventDefault(); return; }
  if ((k === 'Enter' || k === 'o') && ui.selectedId) {
    if (local.view === 'map' && ui.keys.map && ui.keys.map(e)) return;
    e.preventDefault();
    ui.open(ui.selectedId);
    return;
  }
  if (k === 'm') { e.preventDefault(); toggleMini(); return; }
  if (k === 'Delete' && deleteKey(e)) { e.preventDefault(); return; }
  const handler = ui.keys[local.view];
  if (handler && handler(e)) { e.preventDefault(); return; }
  if (k === 's') { e.preventDefault(); toggleSteady(); return; }
  if (local.view === 'map' || local.view === 'projects') return;
  const moves = { ArrowLeft: [-1, 0], h: [-1, 0], ArrowRight: [1, 0], l: [1, 0], ArrowUp: [0, -1], k: [0, -1], ArrowDown: [0, 1], j: [0, 1] };
  if (moves[k]) { e.preventDefault(); movePick(...moves[k]); return; }
  if (k === 'c' && local.view === 'cards') { saveSettings({ compact: !local.compact }); render(); }
});

// Delete: removes what is picked. A multi-selection of 2+ asks first; one conversation asks only when Claude is
// mid-turn in it; a repo picked on the map goes at once (Undo on the toast), like Delete in the repo menu
function deleteKey(e) {
  if (e.target.closest?.('input, textarea, select, [contenteditable], #detail')) return false;
  const list = sessionsOf([...multi]);
  if (list.length >= 2) {
    const it = removeAllItem(list);
    askConfirm(esc(it.confirm.text), it.confirm.yes, it.run);
    return true;
  }
  const p = local.view === 'map' ? mapMod?.mapPicked?.() : null;
  if (p && p.kind === 'repo' && p.root) { removeRepo({ root: p.root, name: p.name }); return true; }
  const id = list.length === 1 ? list[0].id : ui.selectedId;
  const s = id && view?.allSessions.find((x) => x.id === id);
  if (!s) return false;
  const st = isHosted(id) ? hostStatus(id) : null;
  const busy = isHosted(id) && (st ? st === 'busy' : s.state === 'WORKING' || s.state === 'AGENTS');
  if (busy) askConfirm(`<b>${esc(s.name)}</b>: ${BUSY_Q}`, 'Remove anyway', () => removeFromMenu(id));
  else removeFromMenu(id);
  return true;
}

// ---------- window position and size, kept for the next launch ----------
// (the desktop window saves its own: in Electron, screenX/outerWidth are not the window's frame bounds)
const SELF_BOUNDS = navigator.userAgent.includes('Electron');
const bounds = () => ({ x: window.screenX, y: window.screenY, w: window.outerWidth, h: window.outerHeight });
let lastBounds = bounds(), boundsTimer = null;
function checkBounds() {
  if (SELF_BOUNDS) return;
  const b = bounds();
  if (b.x === lastBounds.x && b.y === lastBounds.y && b.w === lastBounds.w && b.h === lastBounds.h) return;
  lastBounds = b;
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => post('/settings', { webBounds: lastBounds }), 1000);
}
setInterval(checkBounds, 2000);
window.addEventListener('resize', checkBounds);
window.addEventListener('beforeunload', () => {
  if (!SELF_BOUNDS) Object.assign(pendingSave, { webBounds: bounds() });
  flushSettings(true);
});

// ---------- the right-click menu ----------
const BUSY_Q = 'Claude is mid-turn. End it anyway?';
function ctxTargetOf(el) {
  if (!el || !el.closest) return null;
  const chip = el.closest('[data-act="reveal"][data-kind="folder"]');
  if (chip && chip.dataset.path) return { kind: 'repo', root: chip.dataset.path };
  const row = el.closest('.fin-row[data-id], .card[data-id], .tile[data-id]');
  // a card or tile of a multi-selection of 2+: the "N conversations" menu
  if (row && multi.size >= 2 && multi.has(row.dataset.id) && !row.classList.contains('fin-row')) return { kind: 'sessions', ids: [...multi] };
  if (row) return { kind: 'session', id: row.dataset.id };
  return null;
}
function openContextMenu(target, x, y) {
  if (!target || !state) return;
  if (menuOpen) closeMenu();
  if (!$('confirm').hidden) hideConfirm();
  const desk = !!termApi();
  if (target.kind === 'sessions') {
    const list = sessionsOf(target.ids);
    if (list.length === 1) return openContextMenu({ kind: 'session', id: list[0].id }, x, y);
    if (list.length >= 2) sessionsMenu(list, x, y);
    return;
  }
  if (target.kind === 'team') {
    const t = (state.teams || []).find((k) => k.id === target.id);
    if (t) teamMenu(t, x, y);
    return;
  }
  if (target.kind === 'conflict') { conflictMenu(target, x, y); return; }
  if (target.kind === 'repo') {
    const folder = String(target.root || '');
    if (!folder) return;
    const repo = repoForFolder(state, folder);
    const color = target.color || repo.color || C.dim;
    const items = [];
    if (desk) {
      // an account out of its weekly or 5-hour limit is left out; both out: one quiet line saying so
      const all = allAccounts(), here = onAccounts();
      const ok = here.filter((a) => !acctEmpty(a));
      for (const a of ok) items.push({ label: all.length === 1 ? 'New session' : `New session · ${a}`, icon: 'plus', run: () => newSession(folder, a) });
      if (!ok.length) items.push({ label: 'New session', icon: 'plus', disabled: true, note: here.map((a) => (here.length === 1 ? '' : a + ' ') + acctEmpty(a)).join(' · ') });
      items.push({ sep: true });
    }
    items.push({ label: 'Open folder', icon: 'folder', run: () => ui.reveal({ kind: 'folder', path: folder }) });
    items.push(repoPushItem(folder, repo.push || 'production'));
    if (unpinItem(target)) items.push(unpinItem(target));
    // orders for every unfinished conversation in it (one team), or the same text to each
    items.push({ sep: true }, ...repoOrderItems(folder, target.name || repo.name || repoName(folder)));
    // its removed conversations (only when it has any), to continue one
    const rm = removedMenuItem(removedFor(folder).slice(0, 15), false);
    if (rm) items.push({ sep: true }, rm);
    // the repo and its conversations leave every view (the repo menu too); Undo on the toast
    items.push({ sep: true }, { label: 'Remove workspace', icon: 'close', danger: true, run: () => removeRepo({ root: folder, name: target.name || repo.name }) });
    openCtxMenu({ x, y, title: target.name || repo.name || repoName(folder), dot: color, sub: folder, items });
    return;
  }
  if (target.kind === 'space') {
    // empty space on the map, or around the cards or tiles: add a repo (removed conversations are on a repo's menu)
    const extra = [{ sep: true }, notifyMenuItem()];
    if (accountsMenuItem()) extra.push(accountsMenuItem());
    if (multi.size) extra.push({ label: `Clear selection (${multi.size})`, icon: 'close', run: () => setMulti([], 'menu') });
    openCtxMenu({ x, y, items: [addRepoMenuItem({ x, y }), recentRepoMenuItem({ x, y }), ...extra] });
    return;
  }
  const s = (view?.allSessions || state.sessions || []).find((x) => x.id === target.id);
  if (!s) return;
  const hosted = isHosted(s.id);
  const items = [];
  if (desk) {
    if (openElsewhere(s) && !hosted) items.push({ label: 'Open in another window — end it there', icon: 'shell', disabled: true });
    else items.push({ label: 'Open session', icon: 'shell', run: () => openHereFromMenu(s.id) });
  }
  if (!s.pending) items.push({ label: 'Open in terminal', icon: 'open', run: () => ui.openTerminal(s.id) });
  if (previousMenuItem(s)) items.push(previousMenuItem(s));
  items.push(renameMenuItem(s));
  if (desk && !s.pending && !s.demo) items.push(forkMenuItem(s));
  if (!s.pending && !s.demo) { const mv = moveMenuItem(s); if (mv) items.push(mv); }
  if (desk && !s.pending && !s.demo && !singleAccount()) items.push(...sendToMenuItems(s, hosted));
  if (!s.pending && !s.demo) items.push(sessionPushItem(s));
  if (leaveTeamItem(s)) items.push(leaveTeamItem(s));
  if (unpinItem(target)) items.push(unpinItem(target));
  // Remove: ends the session if it runs here, and takes the conversation off the map, cards and strip (Henry: "to me end
  // is delete"). Its log stays on disk; it comes back by itself if it works again (open in another window, say).
  const st = hosted ? hostStatus(s.id) : null;
  const busy = hosted && (st ? st === 'busy' : s.state === 'WORKING' || s.state === 'AGENTS');
  items.push({ sep: true });
  items.push({ label: 'Remove conversation', icon: 'close', danger: true, confirm: busy ? { text: BUSY_Q, yes: 'Remove anyway' } : null, run: () => removeFromMenu(s.id) });
  const sub = s.pending ? `${s.repo?.name || ''} · account ${s.account}` : `${s.label || s.state}${s.repo ? ` · ${s.repo.name}` : ''}`;
  openCtxMenu({ x, y, title: s.name, dot: s.pending ? s.hue : statusColor(s), sub, items });
}
const statusColor = (s) => s.stateColor || C.dim;
// "Push to": where the work goes when it's done. Production is the standing rule (merge to main and ship); Preview
// pushes the branch for a preview and doesn't merge. A repo's choice is the default for its conversations, a
// conversation's own wins; the server keeps both (POST /push-target) and a hook tells the conversation at every
// prompt (scripts/push-target-hook.py).
const PUSH_NAME = { production: 'Production', preview: 'Preview' };
const pushPick = (on, label, run) => ({ label, icon: on ? 'check' : null, run });
function sessionPushItem(s) {
  const own = s.push?.own || null, repo = s.push?.repo || 'production';
  const children = [
    pushPick(!own, `Workspace default (${PUSH_NAME[repo]})`, () => setPushTarget({ id: s.id }, null, `${s.name} follows its workspace again: ${PUSH_NAME[repo]}`)),
    { sep: true },
    ...['production', 'preview'].map((t) => pushPick(own === t, PUSH_NAME[t], () => setPushTarget({ id: s.id }, t, `${s.name} pushes to ${PUSH_NAME[t]}`))),
  ];
  return { label: 'Push to', icon: 'push', badge: PUSH_NAME[own || repo].toLowerCase(), children };
}
function repoPushItem(folder, cur) {
  const name = repoName(folder);
  const children = ['production', 'preview'].map((t) => pushPick(cur === t, t === 'production' ? 'Production (default)' : 'Preview',
    () => setPushTarget({ root: folder }, t, `${name} pushes to ${PUSH_NAME[t]}; its conversations follow unless set on their own`)));
  return { label: 'Push to', icon: 'push', badge: cur, children };
}
function setPushTarget(who, target, done) {
  return post('/push-target', { ...who, target }).then((r) => {
    if (FIXTURE) return;
    if (!r || !r.ok) { toast(r?.message || 'could not set where it pushes', C.red); return; }
    toast(done, C.mint);
    poll();
  });
}
// on the map, a repo or conversation dragged into place can be let go again
function unpinItem(target) {
  if (local.view !== 'map' || !mapPins || !mapPins.pinned(target)) return null;
  return { label: 'Unpin from the map', icon: 'reply', run: () => mapPins.unpin(target) };
}
// "Move to workspace": a submenu of the other listed repos; a moved one also offers going back to the repo its own
// tool calls point at. The server keeps the move (POST /sessions/move), and a pickup of this conversation's
// handoff stays in the repo it was moved to. Undo on the toast.
function moveMenuItem(s) {
  const cur = s.repo ? normRoot(s.repo.root) : null;
  const repos = (state?.repos || []).filter((r) => r.root && normRoot(r.root) !== cur && !repoIsHidden(r.root))
    .sort((a, b) => isHomeRoot(a.root) - isHomeRoot(b.root) || repoName(a.root).localeCompare(repoName(b.root)));
  const children = repos.map((r) => ({ label: r.name || repoName(r.root), icon: 'folder', run: () => moveConversation(s, r.root) }));
  if (s.moved) children.unshift({ label: 'Back to the workspace it started in', icon: 'reply', run: () => moveConversation(s, null) }, ...(children.length ? [{ sep: true }] : []));
  if (!children.length) return { label: 'Move to workspace', icon: 'folder', disabled: true, note: 'no other workspace listed' };
  return { label: 'Move to workspace', icon: 'folder', children };
}
function moveConversation(s, root) {
  const before = s.moved && s.repo ? s.repo.root : null;
  // resolves to whether it moved (the map drops a conversation's pin when it didn't)
  return post('/sessions/move', { id: s.id, root }).then((r) => {
    if (FIXTURE) return false;
    if (!r || !r.ok) { toast(r?.message || 'could not move it', C.red); return false; }
    const undo = () => post('/sessions/move', { id: s.id, root: before }).then(() => poll());
    toast(root ? `Moved ${s.name} to ${r.name}` : `${s.name} is back in the workspace it started in`, C.mint, { label: 'Undo', run: undo });
    poll();
    return true;
  });
}
// "Send to Claude A / B / C ...", one for each other account here: it writes a handoff summary and a fresh conversation
// picks it up under that account, in a panel here (term.js sendToAccount). One running here is ended first; one open
// in another window has to be ended there.
function sendToMenuItems(s, hosted) {
  return onAccounts().filter((a) => a !== (s.account || 'B')).map((to) => sendToMenuItem(s, hosted, to));
}
function sendToMenuItem(s, hosted, to) {
  const label = `Send to Claude ${to}`;
  if (acctEmpty(to)) return { label, icon: 'push', disabled: true, note: acctEmpty(to) };
  if (openElsewhere(s) && !hosted) return { label, icon: 'push', disabled: true, note: 'open in another window; end it there' };
  const st = hosted ? hostStatus(s.id) : null;
  const busy = hosted && (st ? st === 'busy' : s.state === 'WORKING' || s.state === 'AGENTS');
  return { label, icon: 'push', confirm: busy ? { text: `Claude is mid-turn. Stop it and send it to account ${to}?`, yes: 'Send anyway' } : null, run: () => sendToFromMenu(s, to) };
}
async function sendToFromMenu(s, to) {
  toast(`Sending ${s.name} to Claude ${to}: it writes a summary, then a fresh conversation picks it up`, C.text);
  const r = await sendToAccount(s, to, newSize());
  if (!r.ok) { toast(r.message || `could not send it to Claude ${to}`, C.red); return; }
  ui.setSelected(s.id, 'explicit');
}
// Fork: a new conversation in the panel with this one's history (claude --resume <id> --fork-session, in its folder,
// under its account); the original carries on untouched
function forkMenuItem(s) {
  const label = 'Fork';
  if (!s.cwd) return { label, icon: 'branch', disabled: true, note: 'no folder known for it' };
  if (acctEmpty(s.account)) return { label, icon: 'branch', disabled: true, note: acctEmpty(s.account) };
  return { label, icon: 'branch', run: () => forkFromMenu(s) };
}
async function forkFromMenu(s) {
  const r = await createSession({ cwd: s.cwd, account: s.account, forkFrom: s.id, ...newSize() });
  if (!r || !r.ok) { toast((r && r.message) || `could not fork ${s.name}`, C.red); return; }
  toast(`Forked ${s.name}: a new conversation with its history`, C.text);
  ui.setSelected(r.key, 'explicit');
}
// ---------- Rename ----------
// A conversation's name in Fleet View: right-click "Rename" (a text box in the menu) or the panel's title (detail.js,
// double-click, the pencil or F2). POST /rename keeps it in settings.names, and it wins over Claude Code's own title
// in every view. An empty name goes back to Claude Code's title. The new name shows at once (renamesNow, until
// /state has it). When the conversation runs here and Claude is idle with an empty prompt, "/rename <name>" is also
// typed into it (term.js sendText, as the chat box sends), so Claude Code's own title follows; otherwise only Fleet
// View's name changes, and the toast says so. A new session can't be renamed until it has an id.
const renamesNow = new Map(); // id -> { name (null: back to its own title), until }
const RENAME_SHOW_MS = 8000;
const cleanName = (v) => String(v ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80).trim();
function applyRenames(st) {
  if (!renamesNow.size || !st) return;
  const now = Date.now();
  for (const [id, r] of renamesNow) {
    const s = (st.sessions || []).find((x) => x.id === id);
    // the server has it (or it has been long enough): /state's name from now on
    if (now > r.until || (s && (r.name ? s.renamed && s.name === r.name : !s.renamed))) { renamesNow.delete(id); continue; }
    if (!r.name) continue; // cleared: Claude Code's own title comes with the next /state
    for (const list of [st.sessions, st.finished, st.removed]) for (const x of list || []) if (x.id === id) { x.name = r.name; x.renamed = true; }
  }
}
function renameMenuItem(s) {
  if (s.pending) return { label: 'Rename', icon: 'edit', disabled: true, note: 'once it has started' };
  return {
    label: 'Rename', icon: 'edit',
    input: { value: s.name || '', placeholder: 'a name (empty: Claude Code\'s own title)', hint: 'Enter saves · empty goes back to Claude Code\'s title · Esc', busy: 'renaming…', allowEmpty: true, submit: (text) => renameConversation(s, text) },
  };
}
// -> null when it worked, else a message (the menu's box shows it)
async function renameConversation(s, raw) {
  if (!s || s.pending || isNewKey(s.id)) return 'a new conversation can be renamed once it has started';
  const name = cleanName(raw);
  if ((name && name === s.name) || (!name && !s.renamed)) return null; // nothing changes
  const before = s.renamed ? s.name : '';
  renamesNow.set(s.id, { name: name || null, until: Date.now() + RENAME_SHOW_MS });
  applyRenames(state);
  render();
  const r = await post('/rename', { id: s.id, name });
  if (FIXTURE) return null;
  if (!r || !r.ok) { renamesNow.delete(s.id); render(); return (r && r.message) || 'could not reach Fleet View to rename it'; }
  const undo = () => renameConversation({ ...s, name: name || s.name, renamed: !!name }, before);
  if (!name) { toast(`${r.shown || 'It'} goes by Claude Code's own title again`, C.mint, { label: 'Undo', run: undo }); return null; }
  // Claude Code too, after the menu has closed (the typing takes a moment)
  tellClaudeName(s, name).then((why) => {
    toast(why ? `Renamed to ${name} in Fleet View; Claude Code keeps its own title (${why})` : `Renamed to ${name}, in Claude Code too`, C.mint, { label: 'Undo', run: undo }, why ? 7000 : 0);
  });
  return null;
}
// "/rename <name>" into the live session when that is safe -> null when it went in, else why not (for the toast)
const SCREEN_WAIT_MS = 3000;
async function tellClaudeName(s, name) {
  const id = s.id;
  if (!termApi() || !isHosted(id)) return 'it is not running here';
  if (hostStatus(id) !== 'idle') return 'Claude is busy';
  // the first look at a screen builds its off-screen view; wait a little for it
  for (const until = Date.now() + SCREEN_WAIT_MS; !screenReady(id) || !screenText(id, 40).length;) {
    if (Date.now() >= until || !isHosted(id)) return 'its screen could not be read';
    await new Promise((res) => setTimeout(res, 200));
  }
  const lines = screenText(id, 40);
  if (parseMenu(lines)) return 'Claude is asking something';
  if (parseSpinner(lines)) return 'Claude is busy';
  const box = parsePromptBox(screenMarked(id, 40).map((l) => l.replace(/[\x01\x02]/g, '')));
  if (!box) return 'something covers its prompt';
  if (box.text) return 'its prompt has text in it';
  const w = await sendText(id, `/rename ${name}`, { beforeEnter: () => { const l = screenText(id, 40); return !l.length || !!parseMenu(l); } });
  return w.ok ? null : w.menu ? 'a question came up' : w.message || 'it could not be typed';
}
function openHereFromMenu(id) {
  const s = view?.allSessions.find((x) => x.id === id);
  if (!s) return;
  if (s.state === 'DONE') { ui.selectedId = null; ui.showDetail(id, 'explicit'); } else ui.setSelected(id, 'explicit');
}
function removeFromMenu(id) {
  const s = view?.allSessions.find((x) => x.id === id);
  if (!s) return;
  if (isHosted(id)) endSession(id);
  continued.delete(id);
  if (s.pending) { if (ui.selectedId === id) ui.selectedId = null; if (ui.detailId === id) ui.detailId = null; if (pinnedId === id) setPin(null); render(); return; }
  hideConversation(s, 'removed');
}
// cols and rows for the new pty, from the room the panel will give it (the terminal fits itself once shown)
function newSize() {
  const w = Math.min(parseFloat(getComputedStyle($('work')).getPropertyValue('--detail-w')) || 504, window.innerWidth), h = window.innerHeight - 140;
  return { cols: Math.max(40, Math.min(400, Math.floor((w - 20) / 7.83))), rows: Math.max(10, Math.min(200, Math.floor(h / 17))) };
}
async function newSession(folder, account) {
  unhideRepo(repoForFolder(state || {}, folder).root || folder);
  const r = await createSession({ cwd: folder, account, ...newSize() });
  if (!r || !r.ok) { toast((r && r.message) || 'could not start a new session', C.red); return; }
  // its stand-in shows at once (map node, panel on Chat with the cursor in the chat box: detail.js)
  ui.setSelected(r.key, 'explicit');
}
onRekey((oldKey, id) => {
  if (ui.selectedId === oldKey) ui.selectedId = id;
  if (ui.detailId === oldKey) ui.detailId = id;
  if (pinnedId === oldKey) setPin(id);
  if (pickIntent?.id === oldKey) pickIntent.id = id;
  if (tabWant?.id === oldKey) tabWant.id = id;
  if (mapRekey) { try { mapRekey(oldKey, id); } catch (e) { console.error(e); } }
  render();
});
// cards, tiles, repo chips and finished rows; the map opens its own (ui.contextMenu). The browser's menu stays
// in text inputs and the live terminal; in the desktop window it is gone everywhere else.
document.addEventListener('contextmenu', (e) => {
  const t = e.target;
  if (t?.closest?.('.term-host')) return;
  if (t?.closest?.('input, textarea, [contenteditable="true"], [contenteditable=""]')) return;
  if (e.defaultPrevented) return; // the map opened one
  // empty space: the map (the map opens its own menu on a node), or the Cards or Wall view around the cards
  const space = t?.closest?.('#view-map, #view-cards, #view-wall, #view-projects .pj-side') && !t.closest('.stream, a, button') ? { kind: 'space' } : null;
  const target = ctxTargetOf(t) || space;
  if (target) { e.preventDefault(); openContextMenu(target, e.clientX, e.clientY); return; }
  if (ctxMenuOpen()) closeCtxMenu(false);
  if (isDesktop()) e.preventDefault();
});
// ---------- multi-selection: Ctrl+click on cards, tiles and map nodes, Shift+drag on the map ----------
// One list for every view: the map tells the shell (ui.setMulti) and the shell tells the map
// (map.js setMapSelection). Selected cards and tiles get a steady outline (.multi); right-click on one of them
// with 2+ selected opens the "N conversations" menu. A plain click picks one and clears it; so does Esc.
const multi = new Set();
function setMulti(ids, from = 'shell') {
  const next = [...new Set((ids || []).filter((x) => typeof x === 'string' && x))];
  if (next.length === multi.size && next.every((id) => multi.has(id))) return;
  multi.clear();
  for (const id of next) multi.add(id);
  if (from !== 'map') { try { mapMod?.setMapSelection?.([...multi]); } catch (e) { console.error(e); } }
  render();
}
function toggleMulti(id) {
  if (!id) return;
  const next = new Set(multi);
  // the first Ctrl+click takes the picked conversation along: Ctrl+click on a second card makes two
  if (!next.size && ui.selectedId && ui.selectedId !== id) next.add(ui.selectedId);
  if (next.has(id)) next.delete(id); else next.add(id);
  setMulti([...next], 'cards');
}
ui.clearMulti = () => setMulti([], 'cards');
// a split chat's ✕ (detail.js): out of the selection; the panel's own conversation hands its place to the next one
ui.dropMulti = (id) => {
  const rest = [...multi].filter((x) => x !== id);
  if (ui.detailId === id) ui.detailId = rest[0] || null;
  setMulti(rest.length >= 2 ? rest : [], 'cards');
  render();
};
function markMulti(el) {
  if (!el || local.view === 'map') return;
  // conversations that left every view leave the selection too
  if (multi.size && view) {
    const ids = new Set(view.allSessions.map((s) => s.id));
    const gone = [...multi].filter((id) => !ids.has(id));
    if (gone.length) { for (const id of gone) multi.delete(id); try { mapMod?.setMapSelection?.([...multi]); } catch {} }
  }
  for (const c of el.querySelectorAll('.card[data-id], .tile[data-id], .pj-row[data-id]')) c.classList.toggle('multi', multi.has(c.dataset.id));
}
const sessionsOf = (ids) => (ids || []).map((id) => (view?.allSessions || state?.sessions || []).find((s) => s.id === id)).filter(Boolean);

// ---------- orders (orders.js): one text to several conversations, as a team or to each ----------
// item: an input item for the right-click menu; the menu closes at once and the sending goes on behind it
// (starting a conversation can take a while), with a toast when it starts and one with the outcome.
// o: { team, name(text), prefix, placeholder, value, note: true (sendNote: each gets the others' ids) }
function orderItem(label, list, o = {}) {
  const ic = o.icon || 'send';
  if (!termApi()) return { label, icon: ic, disabled: true, note: 'desktop window only' };
  if (!list.length) return { label, icon: ic, disabled: true, note: o.none || 'no conversation to reach' };
  // none of them can be typed into from here: say why now, not after the order is written
  const reachable = list.filter((s) => !unreachable(s));
  if (!reachable.length) return { label, icon: ic, disabled: true, note: list.length === 1 ? unreachable(list[0]) : `none can be reached here · ${unreachable(list[0])}` };
  const away = list.length - reachable.length;
  return {
    label, icon: ic, note: [o.subnote, away && list.length > 1 ? `${away} can't be reached here` : ''].filter(Boolean).join(' · ') || null,
    input: {
      multiline: true, value: o.value || '', placeholder: o.placeholder || 'What should they do?',
      hint: 'Enter sends · Shift+Enter new line · Esc closes', busy: 'sending…', empty: 'write it first',
      submit: (text) => {
        const reach = list.filter((s) => !unreachable(s));
        if (!reach.length) return `none of them can be reached here: ${unreachable(list[0])}`;
        runOrder(list, text, o);
        return null;
      },
    },
  };
}
async function runOrder(list, text, o) {
  const n = list.filter((s) => !unreachable(s)).length;
  toast(`Sending to ${n === 1 ? list.find((s) => !unreachable(s)).name : `${n} conversations`}…`, C.dim);
  let res;
  try {
    if (o.note) {
      const results = await sendNote(list, text, state, o.prefix);
      res = { ok: results.some((x) => x.ok), team: null, results };
    } else {
      res = await sendOrder(list, text, { team: !!o.team, state, post, fixture: FIXTURE, prefix: o.prefix || null, name: o.name ? o.name(text) : null });
    }
  } catch (e) { res = { ok: false, results: [], message: String(e?.message || e) }; }
  toast(orderSummary(res), res.ok ? C.mint : C.red, null, res.results?.some((x) => !x.ok) ? 9000 : 0);
  if (DEBUG) window.__fvOrders = (window.__fvOrders || []).concat([{ text, team: res.team || null, results: res.results || [] }]);
  render();
  return res;
}
// a repo's unfinished conversations (the repo's root or one of its checkouts), not removed
function repoSessions(folder) {
  const k = normRoot(repoForFolder(state || {}, folder).root || folder);
  return (state?.sessions || []).filter((s) => s.repo && normRoot(s.repo.root) === k && s.state !== 'DONE' && !isHidden(s));
}
// "Give orders ▸" (4 conversations): Prompt (one text to each, made one team when 2+), then Model ▸, Effort ▸ and
// Fast mode ▸ for all of them, folded into one row to keep the menu short. The count is the conversations it will reach: one open in another window can't be typed into from here
// (it is named in the item's note and left out of the team).
function repoOrderItems(folder, name) {
  const all = repoSessions(folder);
  const off = (msg) => [{ label: 'Give orders', icon: 'send', disabled: true, note: msg }];
  if (!all.length) return off(`no unfinished conversation in ${name}`);
  if (!termApi()) return off('desktop window only');
  const list = all.filter((s) => !unreachable(s));
  const away = all.length - list.length;
  const awayNote = away ? `${away} more ${away === 1 ? 'is' : 'are'} open in another window` : '';
  if (!list.length) return off(`${away === 1 ? 'its one conversation is' : `all ${away} are`} open in another window`);
  const n = list.length;
  const count = `${n} conversation${n === 1 ? '' : 's'}`;
  const prompt = orderItem('Prompt', list, {
    team: n >= 2, name: (text) => `${name} · ${firstWords(text, 4, 34)}`,
    subnote: n >= 2 ? 'as one team: they get each other\'s ids and can talk' : null,
    placeholder: n >= 2 ? `The order for every conversation in ${name}. They become one team.` : `The order for ${list[0].name}`,
  });
  const set = setItems(list);
  return [{ label: 'Give orders', icon: 'send', note: [count, awayNote].filter(Boolean).join(' · '), children: [prompt, ...(set.length ? [{ sep: true }, ...set] : [])] }];
}
// "Model ▸", "Effort ▸", "Fast mode ▸": one setting for each of them, typed in as /model <id>, /effort <level> or
// /fast on|off. Claude Code runs these at once, even mid-turn. A tick: every one of them has it already; "2 of 5":
// some do (read from each one's latest reply). /model and /effort also become the default for new sessions.
function setItems(list) {
  const reach = list.filter((s) => !unreachable(s));
  if (!termApi() || !reach.length) return [];
  const n = reach.length;
  const kid = (label, has, cmd) => {
    const k = reach.filter(has).length;
    return { label, icon: k === n ? 'check' : null, badge: k && k < n ? `${k} of ${n}` : null, run: () => runSet(reach, cmd) };
  };
  const modelOf = (s) => (s.model ? (s.context?.limit === 1000000 ? `${String(s.model).replace(/\[1m\]$/i, '')}[1m]` : s.model) : null);
  const who = n === 1 ? reach[0].name : `all ${n}`;
  return [
    { label: 'Model', icon: 'model', note: who, children: MODEL_IDS.map((id) => kid(modelLabel(id), (s) => modelOf(s) === id, `/model ${id}`)) },
    { label: 'Effort', icon: 'think', note: who, children: EFFORTS.map((e) => kid(e === 'xhigh' ? 'Extra high' : e[0].toUpperCase() + e.slice(1), (s) => s.effort === e, `/effort ${e}`)) },
    { label: 'Fast mode', icon: 'fast', note: who, children: [kid('On', (s) => s.fast === true, '/fast on'), kid('Off', (s) => s.fast === false, '/fast off')] },
  ];
}
async function runSet(list, cmd) {
  toast(`${cmd} → ${list.length === 1 ? list[0].name : `${list.length} conversations`}…`, C.dim);
  let res;
  try { res = { results: await sendEach(list, cmd) }; res.ok = res.results.some((x) => x.ok); } catch (e) { res = { ok: false, results: [], message: String(e?.message || e) }; }
  toast(`${cmd} · ${orderSummary(res)}`, res.ok ? C.mint : C.red, null, res.results.some((x) => !x.ok) ? 9000 : 0);
  render();
}
// the "N conversations" menu (a multi-selection). "Give orders ▸" as on a workspace: Work together (one team),
// Send to each, then Model ▸, Effort ▸ and Fast mode ▸ for all of them
function sessionsMenu(list, x, y) {
  const desk = !!termApi();
  const live = list.filter((s) => isHosted(s.id));
  const set = setItems(list);
  const orders = desk
    ? { label: 'Give orders', icon: 'send', note: `${list.length} conversations`, children: [
      orderItem('Work together', list, { team: true, icon: 'merge', subnote: 'as one team: they get each other\'s ids and can talk', placeholder: 'The order for all of them. They become a team and can message each other.' }),
      orderItem('Send to each', list, { team: false, icon: 'reply', placeholder: 'The same message to each of them' }),
      ...(set.length ? [{ sep: true }, ...set] : []),
    ] }
    : { label: 'Give orders', icon: 'send', disabled: true, note: 'desktop window only' };
  openCtxMenu({ x, y, title: `${list.length} conversations`, dot: C.cyan, sub: list.map((s) => s.name).join(' · '), items: [
    orders, { sep: true },
    live.length ? { label: 'Interrupt all', icon: 'stop', note: `${live.length} running here`, run: () => interruptAll(live) } : { label: 'Interrupt all', icon: 'stop', disabled: true, note: 'none of them runs here' },
    desk ? { label: 'Open all here', icon: 'shell', run: () => openAllHere(list) } : { label: 'Open all here', icon: 'shell', disabled: true, note: 'desktop window only' },
    { sep: true },
    { label: 'Clear selection', icon: 'close', run: () => setMulti([], 'menu') },
    removeAllItem(list),
  ] });
}
// "Remove N conversations": the single Remove for each (ends the ones running here, takes them off every view)
function removeAllItem(list) {
  const busy = list.filter((s) => isHosted(s.id) && (hostStatus(s.id) ? hostStatus(s.id) === 'busy' : s.state === 'WORKING' || s.state === 'AGENTS')).length;
  const text = `Remove ${list.length} conversations?${busy ? ` Claude is mid-turn in ${busy === 1 ? 'one of them' : busy}; ${busy === 1 ? 'it ends' : 'they end'} too.` : ''}`;
  return { label: `Remove ${list.length} conversations`, icon: 'close', danger: true, confirm: { text, yes: 'Remove' }, run: () => removeMany(list.map((s) => s.id)) };
}
function removeMany(ids) {
  let n = 0, first = null;
  for (const id of ids) {
    const s = view?.allSessions.find((x) => x.id === id);
    if (!s) continue;
    if (isHosted(id)) endSession(id);
    continued.delete(id);
    if (!s.pending) hidden.set(id, Date.now());
    if (ui.selectedId === id) ui.selectedId = null;
    if (ui.detailId === id) ui.detailId = null;
    if (pinnedId === id) setPin(null);
    n++; first = first || s;
  }
  if (!n) return;
  saveHidden();
  multi.clear();
  try { mapMod?.setMapSelection?.([]); } catch (e) { console.error(e); }
  const gone = ids.filter((id) => hidden.has(id));
  const undo = () => { const back = gone.filter((id) => hidden.has(id)); if (!back.length) return; for (const id of back) unhide(id); saveHidden(); render(); };
  toast(n === 1 ? `Removed ${first.name}. It comes back if it works again` : `Removed ${n} conversations. Each comes back if it works again`, C.dim, { label: 'Undo', run: undo, ms: 6000 });
  render();
}
function interruptAll(list) {
  const n = list.filter((s) => interruptSession(s.id)).length;
  toast(n ? `Interrupted ${n === 1 ? list[0].name : `${n} conversations`} (Esc)` : 'none of them runs here', n ? C.text : C.dim);
}
async function openAllHere(list) {
  const go = list.filter((s) => !unreachable(s));
  const left = list.length - go.length;
  if (!go.length) { toast(`none of them can be opened here: ${unreachable(list[0])}`, C.red); return; }
  toast(`Opening ${go.length} here${left ? ` · ${left} open elsewhere or finished` : ''}…`, C.dim);
  const rs = await Promise.all(go.map((s) => ensureLive(s).catch((e) => ({ ok: false, message: String(e?.message || e) }))));
  const bad = rs.filter((r) => !r || !r.ok).length;
  toast(bad ? `${go.length - bad} running here · ${bad} did not start` : `${go.length} running here`, bad ? C.red : C.mint);
}
// a team (right-click its link or pill on the map)
function teamMenu(t, x, y) {
  const members = sessionsOf(t.members);
  const sel = ui.selectedId && !t.members.includes(ui.selectedId) ? sessionsOf([ui.selectedId])[0] : null;
  const items = [
    orderItem('Message the team', members, { team: false, prefix: `[Fleet View · team ${t.name}]`, placeholder: `A message to every conversation in "${t.name}"` }),
    sel && sel.state !== 'DONE' && !sel.pending
      ? { label: `Add ${sel.name}`, icon: 'plus', note: 'the picked conversation', run: () => addToTeam(t, sel, members) }
      : { label: 'Add picked conversation', icon: 'plus', disabled: true, note: ui.selectedId ? 'it is in this team already, or finished' : 'pick one first' },
    { sep: true },
    ...members.map((s) => ({ label: `Pick ${s.name}`, icon: 'shell', run: () => pickFromAnywhere(s.id) })),
    { sep: true },
    { label: 'Disband team', icon: 'close', danger: true, confirm: { text: `Disband "${t.name}"? Its conversations keep working; they stop being a team.`, yes: 'Disband' }, run: () => disbandTeam(t) },
  ];
  openCtxMenu({ x, y, title: t.name, dot: t.color || C.cyan, sub: `${members.length} conversations · ${firstWords(t.order, 10, 70)}`, items });
}
async function addToTeam(t, s, members) {
  if (t.members.length >= 12) { toast('a team has at most 12 conversations', C.red); return; }
  const r = await post('/teams', { members: [...t.members, s.id], order: t.order, name: t.name });
  const team = r && r.ok && r.team ? r.team : FIXTURE && r == null ? { ...t, members: [...t.members, s.id] } : null;
  if (!team) { toast((r && r.message) || 'could not add it to the team', C.red); return; }
  const all = [...members, s];
  // the newcomer gets the order with its teammates; the others hear who joined
  const [a, b] = await Promise.all([
    sendEach([s], teamBrief(team, s, all, state, t.order)),
    sendNote(members, `${s.name} joined the team "${t.name}".`, state, `[Fleet View · team ${t.name}]`),
  ]);
  const res = { ok: a.some((x) => x.ok), team: null, results: [...a, ...b] };
  toast(`Added ${s.name} to "${t.name}" · ${orderSummary(res, 'told')}`, res.ok ? C.mint : C.red);
}
async function disbandTeam(t) {
  const r = await post('/teams/remove', { id: t.id });
  if (!FIXTURE && (!r || !r.ok)) { toast((r && r.message) || 'could not disband it', C.red); return; }
  toast(`Disbanded "${t.name}"`, C.dim);
}
// a conflict or a clash (right-click its node on the map): kind2 'branch' | 'worktree' | 'migration', else a file
const CONFLICT_NOTE = {
  branch: (l) => `Heads up: you are both on branch ${l}. Coordinate before pushing: agree who pushes first, and do not force-push.`,
  worktree: (l) => `Heads up: you are both working in the same worktree folder (${l}). Only one of you should edit there; agree who moves to a new worktree.`,
  migration: (l) => `Heads up: you both wrote a migration numbered ${l}. Agree who renumbers theirs before either of you pushes.`,
  file: (l) => `Heads up: you are both editing ${l}. Agree who changes what in it before editing further.`,
};
function conflictMenu(target, x, y) {
  const c = (state.conflicts || []).find((k) => k.id === target.id) || null;
  const kind2 = target.kind2 || c?.kind || 'file';
  const kind = CONFLICT_NOTE[kind2] ? kind2 : 'file';
  const label = target.label || c?.label || target.rel || '';
  const list = sessionsOf(target.sessions || c?.sessions || []);
  // the file to open: a migration's (any of them), or the clashing file in one of its conversations' checkouts
  let file = null;
  if (kind === 'migration') file = c?.files?.find((f) => f && f.abs)?.abs || null;
  else if (kind === 'file') {
    const rel = target.rel || label;
    for (const s of list) { const f = (s.files || []).find((x) => x.rel === rel && x.abs); if (f) { file = f.abs; break; } }
  }
  const title = { branch: `Same branch: ${label}`, worktree: `Same worktree: ${label}`, migration: `Same migration number: ${label}`, file: `Same file: ${label}` }[kind];
  const items = [
    orderItem('Send a note to all', list, { note: true, prefix: '[Fleet View · note]', value: CONFLICT_NOTE[kind](label), placeholder: 'A note to each of them' }),
  ];
  if (file) items.push({ label: 'Open the file in VS Code', icon: 'file', run: () => ui.reveal({ kind: 'file', path: file }) });
  items.push({ sep: true });
  for (const s of list) items.push({ label: `Pick ${s.name}`, icon: 'shell', run: () => pickFromAnywhere(s.id) });
  items.push({ sep: true });
  for (const s of list) items.push(isHosted(s.id) ? { label: `Interrupt ${s.name}`, icon: 'stop', run: () => interruptAll([s]) } : { label: `Interrupt ${s.name}`, icon: 'stop', disabled: true, note: 'not running here' });
  openCtxMenu({ x, y, title, dot: kind === 'branch' || kind === 'file' ? C.gold : C.red, sub: list.map((s) => s.name).join(' · '), items });
}
// pick a conversation from a menu or a list: a shown one like a click on it, else its panel
function pickFromAnywhere(id) {
  if ((state?.sessions || []).some((s) => s.id === id && s.state !== 'DONE')) return fvSelect(id);
  if ((view?.allSessions || state?.sessions || []).some((s) => s.id === id)) return ui.showDetail(id, 'click');
  toast('that conversation is no longer listed', C.dim);
}
function leaveTeamItem(s) {
  const t = s.team && (state?.teams || []).find((x) => x.id === s.team);
  if (!t) return null;
  return { label: `Leave team "${t.name}"`, icon: 'close', run: async () => {
    const r = await post('/teams/leave', { id: t.id, member: s.id });
    if (!FIXTURE && (!r || !r.ok)) { toast((r && r.message) || 'could not leave the team', C.red); return; }
    toast(`${s.name} left "${t.name}"${r && r.disbanded ? ' · the team is gone' : ''}`, C.dim);
  } };
}

// ---------- replay (the map overlay's replay bar, map-overlay.js / replay.js) ----------
// The overlay dispatches window 'fv-replay' { detail: { on: true, state } } for every replay state as the
// scrubber moves or plays, and { on: false } once when it goes back to live. While it is on, the map is drawn
// from that state (map.js setMapReplay(true): no saved spots, no births, comets from the given feed) instead of
// the live one; the other views and the header counts stay live. The header shows "Replay · 10:42 PM"; a click
// on it goes back to live (and tells the overlay with window 'fv-replay-exit').
let replay = null;
window.addEventListener('fv-replay', (e) => {
  const d = (e && e.detail) || {};
  if (d.on && d.state && typeof d.state === 'object') {
    if (!replay) { try { mapMod?.setMapReplay?.(true); } catch (err) { console.error(err); } }
    replay = d.state;
  } else if (!d.on) {
    if (!replay) return;
    replay = null;
    try { mapMod?.setMapReplay?.(false); } catch (err) { console.error(err); }
  } else return;
  render();
});
function exitReplay() {
  if (!replay) return;
  replay = null;
  try { mapMod?.setMapReplay?.(false); } catch (err) { console.error(err); }
  window.dispatchEvent(new CustomEvent('fv-replay-exit'));
  render();
}
// the replay state with the shell's filters (repo menu, / filter), shaped like derive()'s output
function replayView(rs) {
  const q = queryRe();
  const all = (rs.sessions || []).filter((s) => s && inRepo(s.repo));
  const shown = all.filter((s) => s.state !== 'DONE' && (!q || q.test(`${s.name} ${s.goal || ''} ${s.repo?.name || ''} ${s.repo?.root || ''} ${s.branch || ''}`)));
  const ids = new Set(all.map((s) => s.id));
  const shownIds = new Set(shown.map((s) => s.id));
  const clashes = (rs.clashes || []).map((c) => ({ ...c, sessions: (c.sessions || []).filter((x) => shownIds.has(x.id)) })).filter((c) => c.sessions.length >= 2);
  return {
    ...rs, settings: { ...(state?.settings || {}), ...(rs.settings || {}), ...local }, sessions: shown, allSessions: all, pending: [],
    clashes, allClashes: rs.clashes || [], feed: (rs.feed || []).filter((e) => ids.has(e.sid)), filterNote: '',
    finished: [], finishedSessions: all.filter((s) => s.state === 'DONE').slice(0, 10),
    repoAnchors: repoList(rs).filter((r) => inRepo(r)).map((r) => ({ root: r.root, name: r.name, color: r.color })),
  };
}
function drawReplayPill() {
  const b = $('replay-pill');
  if (!b) return;
  const on = !!replay && local.view === 'map';
  b.hidden = !on;
  if (!on) return;
  const t = replay.replay?.t || replay.now;
  const text = `Replay · ${t ? clockTime(t, false) : ''}`;
  if (b._t !== text) { b._t = text; b.innerHTML = `${icon('clock', 13)}<b>${esc(text)}</b><span class="count-k">Live</span>`; }
}
$('replay-pill')?.addEventListener('click', (e) => { e.stopPropagation(); exitReplay(); });

// ---------- "Since you looked" (since.js; key w, the header's clock button) ----------
async function getJson(url) {
  if (FIXTURE) return null; // no server behind fixture pages: since.js falls back to sinceFromState
  try { const r = await fetch(url, { cache: 'no-store' }); return r.ok ? await r.json() : null; } catch { return null; }
}
const since = mountSince({ fetchJson: getJson, onPick: (id) => pickFromAnywhere(id), fallback: (t) => sinceFromState(state, t) });
$('since-btn')?.addEventListener('click', (e) => { e.stopPropagation(); since.toggle(); });

// ---------- "Update available" (update.js; updater.js on the server) ----------
if (!FIXTURE) mountUpdate({ pill: $('update-pill'), getJson });

// ---------- desktop notifications ----------
// New entries in state.alerts (n only grows) of these kinds raise a Notification while the window is not
// focused; a click on it brings the window up and picks the conversation. Each one once: the last n told is
// kept in localStorage (fv.alertN); on the very first run nothing old is announced. The permission is asked
// once, on the first click or key on the page. settings.notify (default on) turns it off: the empty-space
// right-click menu has the switch.
const NOTIFY_KINDS = new Set(['question', 'error', 'stalled', 'deployFail', 'checks', 'stuckAgent', 'overLimit', 'conflict', 'message']);
const ALERT_N_KEY = 'fv.alertN';
let alertN = (() => { try { const v = Number(localStorage.getItem(ALERT_N_KEY)); return Number.isFinite(v) && v > 0 ? v : null; } catch { return null; } })();
const notified = []; // what was raised (tests: window.__fv.notified)
function notifyAlerts(st) {
  const list = Array.isArray(st?.alerts) ? st.alerts : [];
  const top = list.reduce((m, a) => Math.max(m, Number(a && a.n) || 0), 0);
  if (!top) return;
  const save = () => { try { localStorage.setItem(ALERT_N_KEY, String(alertN)); } catch {} };
  // first run, or a server whose numbers started over: catch up without announcing
  if (alertN == null || top < alertN) { alertN = top; save(); return; }
  const fresh = list.filter((a) => a && Number(a.n) > alertN && NOTIFY_KINDS.has(a.kind)).sort((a, b) => a.n - b.n);
  if (top === alertN) return;
  alertN = top; save();
  if (!fresh.length || local.notify === false || document.hasFocus()) return;
  for (const a of fresh.filter(notifyOnce).slice(-3)) raise(a);
}
// a 'message' notification: one per sender and receiver every 10 minutes (the server raises its alert that
// seldom too; this also covers an older server, and a message alert per pair that still slips through)
const MSG_NOTIFY_MS = 10 * 60e3;
const msgNotified = new Map(); // 'from>to' -> when
function notifyOnce(a) {
  if (a.kind !== 'message') return true;
  const now = Date.now(), pair = `${a.from || a.text || ''}>${a.sid || ''}`;
  for (const [k, at] of msgNotified) if (now - at >= MSG_NOTIFY_MS) msgNotified.delete(k);
  if (msgNotified.has(pair)) return false;
  msgNotified.set(pair, now);
  return true;
}
function raise(a) {
  const rec = { n: a.n, kind: a.kind, sid: a.sid, title: a.name || 'Fleet View', body: a.text, shown: false };
  notified.push(rec);
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(rec.title, { body: a.text || '', tag: `fv-${a.n}`, silent: false });
    rec.shown = true;
    n.onclick = () => {
      try { window.focus(); window.fleetDesktop?.focus?.(); } catch {}
      if (a.sid) pickFromAnywhere(a.sid);
      n.close();
    };
  } catch (e) { console.warn(e); }
}
function askNotify() {
  if (!('Notification' in window) || Notification.permission !== 'default' || local.notify === false) return;
  try { if (localStorage.getItem('fv.notifyAsked')) return; localStorage.setItem('fv.notifyAsked', '1'); } catch {}
  try { Promise.resolve(Notification.requestPermission()).catch(() => {}); } catch {}
}
document.addEventListener('pointerdown', askNotify, { once: true, capture: true });
document.addEventListener('keydown', askNotify, { once: true, capture: true });
// ---------- accounts turned on and off (right-click on empty space · Accounts ▸ ✓ A ✓ B ✓ C) ----------
// One turned off: the server leaves its conversations (and workspaces only it uses) out of /state, and the menus
// offer no "New session · X" or "Send to Claude X" on it. Sessions running on it keep running. At least one stays on.
let offAccts = [], offSentAt = 0;
const allAccounts = () => (Array.isArray(state?.accounts) && state.accounts.length ? state.accounts : ['A', 'B']);
const onAccounts = () => allAccounts().filter((a) => !offAccts.includes(a));
function setAccountOn(a, on) {
  const next = on ? offAccts.filter((x) => x !== a) : [...new Set([...offAccts, a])].sort();
  if (!on && !allAccounts().some((x) => !next.includes(x))) { toast('Keep at least one account on', C.dim); return; }
  offAccts = next;
  offSentAt = Date.now();
  saveSettings({ offAccounts: next });
  flushSettings();
  toast(on ? `Account ${a} is on: its conversations show again` : `Account ${a} is off: its conversations are hidden and get no new sessions`, C.dim);
  setTimeout(poll, 500);
}
function accountsMenuItem() {
  const all = allAccounts();
  if (all.length < 2) return null;
  const off = all.filter((a) => offAccts.includes(a));
  return { label: 'Accounts', icon: 'agent', badge: off.length ? `${off.join(' ')} off` : null,
    children: all.map((a) => ({ label: `Claude ${a}`, tag: a, icon: offAccts.includes(a) ? null : 'check', run: () => setAccountOn(a, offAccts.includes(a)) })) };
}

function notifyMenuItem() {
  const on = local.notify !== false;
  return { label: on ? 'Turn off desktop notifications' : 'Turn on desktop notifications', icon: 'alert',
    note: on ? 'questions, errors, failed checks and deploys, messages' : null,
    run: () => { saveSettings({ notify: !on }); if (!on) askNotify(); toast(on ? 'Desktop notifications are off' : 'Desktop notifications are on', C.dim); render(); } };
}

if (DEBUG) {
  window.__fv = {
    ui, hosts, hidden, hiddenRepos, continued, addedLocal, multi, since, notified,
    notifyAlerts: (st) => notifyAlerts(st),
    get replay() { return replay; },
    setMulti: (ids) => setMulti(ids, 'test'),
    addRepoPath: (p) => addRepoPath(p),
    removeRepo: (root) => removeRepo({ root }),
    openRepoMenu: () => openMenu(),
    get menuItems() { return menuItems; },
    get view() { return view; },
    get state() { return state; },
    contextMenu: (target, x = 200, y = 200) => openContextMenu(target, x, y),
  };
}

// the clock keeps going while the server is away
setInterval(() => { drawClock(); }, 1000);
render();
poll();
// conversations that run live in this window (desktop only): the panel, cards and map follow them
watchHosts(() => render());
