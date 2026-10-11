// Chats view: Fleet View as a phone messenger. On the left, one row per contact (chats-model.js): the Chief
// pinned on top, then every bot (one row per chain of handoffs) and every team as a group chat, each with its
// blob mascot (mascot.js), name, time and a one-line preview; on the right, the picked one's chat: a bot's or the
// Chief's is the same chat pane and chat box as the Projects view (chat.js), a team's is its thread as bubbles with
// a box that sends to every member the way the team menu's "Message the team" does (ui.messageTeam in app.js).
//
// Built once and patched on each render; the list's HTML is rewritten only when what it shows changed. The pick
// (a contact key) is kept in this window's storage (fv.chats.sel; the pop-out window keeps its own), and when each
// contact was last opened in fv.chats.seen (the unread dots; shared by both windows). A pick made in another view
// (ui.selectedId) carries over to the contact that holds it. Keys: ↑↓ (or j/k) move, Enter puts the cursor in
// the chat box, / the search box, Esc goes back to the list in the narrow layout.
//
// Narrow (the view itself under 640px wide, measured on the element: the pop-out window can be narrow): the list
// only; a pick slides the chat over it, with a back arrow.
// Pop-out (desktop window; every call feature-detected): a button in the list's top bar calls
// fleetDesktop.popChats(); fleetDesktop.onChatsPopped(cb) says when Chats is in its own window, and this view then
// shows a calm placeholder with "Bring it back" (dockChats) and "Show it" (popChats). The pop-out window's page is
// this one with ?solo=chats (SOLO): only this view, under a small 36px header that drags the window, with a
// pin-on-top toggle (setChatsOnTop) and a dock-back button (dockChats); Session and Details there open the
// conversation in the main window (showMain).
//
// The Chief: with none started (settings.chief.id null) its pane is a short card with a Start button (POST
// /api/chief/start). Once there is one, its pane is a bot's chat with a strip above the thread: the briefing card
// (GET /chief/briefing when the pane opens and at most every 60 s while it shows; free, it sends the Chief nothing)
// and the Watch mode switch (POST /settings { chief: { watch } }). With ?fixture=1 nothing is posted: Start fakes
// a Chief from a fixture conversation and the briefing is built here from the fixture sessions.
import { C, esc, setHTML, badge, acctTag, acctColor, isAcct, repoChip } from './cards.js';
import { icon } from './icons.js';
import { renderChatPane } from './chat.js';
import { onRekey } from './term.js';
import { openCtxMenu } from './ctxmenu.js';
import { mascotSVG, mascotState } from './mascot.js';
import { buildContacts, sortContacts, teamThread, createChainStore, unread } from './chats-model.js';

export const SOLO = new URLSearchParams(location.search).get('solo') === 'chats';
const NARROW = 640; // px: under this the view shows the list or the chat, not both
const SEL_KEY = SOLO ? 'fv.chats.solo.sel' : 'fv.chats.sel';
const SEEN_KEY = 'fv.chats.seen';
const TOP_KEY = 'fv.chats.onTop';
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const desk = () => window.fleetDesktop || null;
const HEX = /^#[0-9a-f]{3,8}$/i;

let selKey = store.get(SEL_KEY, null);
let seen = (() => { const s = store.get(SEEN_KEY, {}); return s && typeof s === 'object' && !Array.isArray(s) ? s : {}; })();
let chains = null; // the model's chain store, made once
let query = '';
let open = false; // narrow layout: the chat is over the list
let popped = false; // Chats is in its own window (main window only)
let onTop = !!store.get(TOP_KEY, false);
let syncedSel = null; // the last ui.selectedId this view followed
let selLast = null; // the last copy of the picked bot's conversation, kept if it leaves the lists
let pane = null;

const FIXTURE = new URLSearchParams(location.search).has('fixture');
const BRIEF_MS = 60000; // the briefing card reads again at most this often while the Chief's pane shows
const START_WAIT = 30000; // after Start: how long "Starting..." waits for the Chief to be listed
const NEEDS = new Set(['ASKING', 'QUESTION', 'ERROR', 'STALLED']);
const BUSY = new Set(['WORKING', 'AGENTS']);
const chief = {
  fakeId: null, // ?fixture=1 only: the fixture conversation standing in for a started Chief
  starting: false, startedAt: 0, err: '',
  watch: false, // ?fixture=1: the local switch
  watchSet: null, watchAt: 0, watchErr: '', // the switch as just flipped, until /state agrees
  brief: null, briefAt: 0, briefBusy: false, briefOn: false, more: false,
};

onRekey((oldKey, id) => {
  if (selKey === oldKey) { selKey = id; store.set(SEL_KEY, id); }
  if (seen[oldKey]) { seen[id] = seen[oldKey]; delete seen[oldKey]; saveSeen(); }
});

function saveSeen() {
  const keys = Object.keys(seen);
  if (keys.length > 400) for (const k of keys.sort((a, b) => seen[a] - seen[b]).slice(0, keys.length - 400)) delete seen[k];
  store.set(SEEN_KEY, seen);
}
function markSeen(c) {
  if (!c) return;
  const t = Math.max(Date.now(), c.at || 0);
  if ((seen[c.key] || 0) >= (c.at || 0) && seen[c.key]) return;
  seen[c.key] = t;
  saveSeen();
}

// ---------- small pieces ----------
const DAY = 864e5;
// HH:MM today, "Yesterday", the weekday within 6 days, else a short date
function when(ms, now) {
  if (!ms) return '';
  const n = new Date(now), d = new Date(ms);
  const day0 = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
  if (ms >= day0) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  if (ms >= day0 - DAY) return 'Yesterday';
  if (ms >= day0 - 6 * DAY) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
const colorOf = (c) => {
  if (c && c.kind === 'chief') return C.gold; // the Chief keeps its own colour whatever folder it runs in
  const r = c && c.repo && c.repo.color;
  if (HEX.test(String(r || ''))) return r;
  if (c && c.kind === 'team' && HEX.test(String(c.statusColor || ''))) return c.statusColor;
  return c && isAcct(c.account) ? acctColor(c.account) : C.cyan;
};
const sessionsOf = (state) => (state.allSessions || []).concat(state.finishedSessions || [], state.pending || []);
const findSession = (state, id) => (id ? sessionsOf(state).find((x) => x.id === id) || null : null);
const inState = (state, id) => !!id && (state.allSessions || []).some((x) => x.id === id);
// a member's mascot: its own state and colour, from the conversation when it is listed
function memberMascot(state, m, size) {
  const s = findSession(state, m.id);
  const col = s && s.repo && HEX.test(String(s.repo.color || '')) ? s.repo.color : s && isAcct(s.account) ? acctColor(s.account) : C.violet;
  return mascotSVG(m.id, { state: s ? mascotState(s) : 'idle', color: col, size });
}
// a team's avatar: 2-3 member mascots, overlapping
function cluster(state, c, box = 40) {
  const ms = (c.members || []).slice(0, 3);
  if (!ms.length) return mascotSVG(c.key, { state: 'idle', color: colorOf(c), size: box });
  const sz = Math.round(box * (ms.length === 1 ? 1 : 0.62));
  return `<span class="ch-cluster n${ms.length}" style="--cb:${box}px;--cs:${sz}px">`
    + ms.map((m, i) => `<span class="ch-cm m${i}">${memberMascot(state, m, Math.round(sz * 0.84))}</span>`).join('') + '</span>';
}
const avatar = (state, c, size = 40) => (c.kind === 'team' ? cluster(state, c, size)
  : mascotSVG(c.kind === 'chief' ? 'chief' : c.key, { state: c.kind === 'chief' && !c.id ? 'new' : mascotState(c), color: colorOf(c), size }));
const previewOf = (c) => {
  const p = typeof c.preview === 'string' ? c.preview : '';
  if (c.kind === 'chief') return c.id ? p || 'Ready' : chief.starting || Date.now() - chief.startedAt < START_WAIT ? 'Starting...' : p || 'Not started yet';
  if (c.kind === 'team' && !p) return 'Group chat';
  return p;
};

function matches(c, q) {
  if (!q) return true;
  const hay = `${c.name || ''} ${c.repo ? c.repo.name || '' : ''} ${previewOf(c)} ${(c.members || []).map((m) => m.name).join(' ')}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

function rowHtml(state, c, now) {
  const on = c.key === selKey;
  const un = !on && unread(c, seen);
  const pin = c.pinned ? `<span class="ch-pin" title="pinned">${icon('pin', 11)}</span>` : '';
  return `<button type="button" class="ch-row${on ? ' on' : ''}${c.needsYou ? ' needs' : ''}${un ? ' unread' : ''}${c.kind === 'chief' && !c.id ? ' ghost' : ''}" role="option" aria-selected="${on}"`
    + ` data-key="${esc(c.key)}"${c.id ? ` data-id="${esc(c.id)}"` : ''}${c.teamId ? ` data-team="${esc(c.teamId)}"` : ''} style="--rc:${esc(colorOf(c))}" title="${esc(c.name || '')}">`
    + `<span class="ch-av">${avatar(state, c, 40)}</span>`
    + `<span class="ch-body"><span class="ch-l1"><span class="ch-name">${esc(c.name || 'chat')}</span>${c.kind === 'team' ? '' : acctTag(c.account)}`
    + `<span class="ch-time">${pin}${esc(when(c.at, now))}</span></span>`
    + `<span class="ch-l2"><span class="ch-prev">${esc(previewOf(c))}</span>${c.needsYou ? '<span class="ch-flag" title="needs you">!</span>' : un ? '<span class="ch-dot" aria-label="unread"></span>' : ''}</span>`
    + `</span></button>`;
}

function listHtml(state, list, now) {
  if (!list.length) return query ? `<div class="ch-none">No chats match “${esc(query)}”.</div>` : '<div class="ch-none">No chats yet. Start one with +.</div>';
  return list.map((c) => rowHtml(state, c, now)).join('');
}

function acctDots(state, contacts) {
  const list = Array.isArray(state.accounts) && state.accounts.length ? state.accounts.filter(isAcct)
    : [...new Set(contacts.map((c) => c.account).filter(isAcct))].sort();
  return list.map((a) => `<span class="ch-acct" style="background:${esc(acctColor(a))}" title="Claude account ${esc(a)}">${esc(a)}</span>`).join('');
}

// ---------- build ----------
function build(el, ui) {
  el.innerHTML = `${SOLO ? `<header class="ch-solo-top"><span class="ch-solo-m">${mascotSVG('chats', { state: 'idle', color: C.cyan, size: 20 })}</span>`
    + `<span class="ch-solo-t">Chats</span><span class="grow"></span>`
    + `<button type="button" class="ch-ib ch-ontop" aria-pressed="false" title="Keep on top">${icon('pin', 14)}</button>`
    + `<button type="button" class="ch-ib ch-dock" title="Back into the main window">${icon('open', 14)}</button></header>` : ''}`
    + `<div class="ch-popped" hidden><div class="ch-popped-in">${mascotSVG('chats', { state: 'idle', color: C.cyan, size: 56 })}`
    + `<div class="ch-popped-t">Chats is open in its own window</div><div class="ch-popped-b">`
    + `<button type="button" class="btn" data-dock="1">Bring it back</button><button type="button" class="btn primary" data-show="1">Show it</button></div></div></div>`
    + `<div class="ch"><nav class="ch-side" aria-label="chats">`
    + `<div class="ch-top"><span class="ch-title">Chats</span><span class="ch-accts"></span><span class="grow"></span>`
    + `<button type="button" class="ch-ib ch-pop" title="Open Chats in its own window" hidden>${icon('external', 15)}</button>`
    + `<button type="button" class="ch-ib ch-new" title="New chat: pick a workspace" aria-haspopup="menu">${icon('plus', 16)}</button></div>`
    + `<label class="ch-search">${icon('search', 14)}<input type="search" spellcheck="false" autocomplete="off" placeholder="Search chats" aria-label="Search chats"></label>`
    + `<div class="ch-list" role="listbox" aria-label="chats"></div></nav>`
    + `<section class="ch-main"><header class="ch-head" hidden><button type="button" class="ch-ib ch-back" title="Back to the chats (Esc)" aria-label="Back">${icon('chevron', 16)}</button>`
    + `<span class="ch-head-av"></span><div class="ch-head-t"></div><div class="ch-head-b"></div></header>`
    + `<div class="ch-chief" hidden></div><div class="ch-chat" hidden></div>`
    + `<div class="ch-team" hidden><div class="ch-thread" role="log" aria-live="polite"></div>`
    + `<div class="ch-tcomp"><textarea rows="1" spellcheck="true" placeholder="Message the team"></textarea>`
    + `<button type="button" class="ch-send" title="Send to every member (Enter)" aria-label="Send">${icon('send', 16)}</button><div class="ch-tnote" hidden></div></div></div>`
    + `<div class="ch-blank"></div></section></div>`;
  const q = (s) => el.querySelector(s);
  Object.assign(el, {
    _ch: q('.ch'), _side: q('.ch-side'), _list: q('.ch-list'), _accts: q('.ch-accts'), _pop: q('.ch-pop'), _new: q('.ch-new'),
    _search: q('.ch-search input'), _head: q('.ch-head'), _headAv: q('.ch-head-av'), _headT: q('.ch-head-t'), _headB: q('.ch-head-b'),
    _chat: q('.ch-chat'), _chief: q('.ch-chief'), _team: q('.ch-team'), _thread: q('.ch-thread'), _ta: q('.ch-tcomp textarea'), _send: q('.ch-send'),
    _tnote: q('.ch-tnote'), _blank: q('.ch-blank'), _popped: q('.ch-popped'), _onTop: q('.ch-ontop'),
  });
  el._built = true;
  el._ui = ui;
  pane = el;

  // the narrow layout follows the element's own width
  try {
    new ResizeObserver((es) => {
      const w = es[es.length - 1].contentRect.width;
      const n = w > 0 && w < NARROW;
      el.classList.toggle('ch-mid', w >= NARROW && w < 1000); // the chat's buttons drop their words
      if (n !== el.classList.contains('ch-narrow')) { el.classList.toggle('ch-narrow', n); ui.refresh(); }
    }).observe(el);
  } catch {}

  el._list.addEventListener('click', (e) => {
    const r = e.target.closest('.ch-row');
    if (!r) return;
    pick(r.dataset.key, ui, true);
  });
  el._list.addEventListener('contextmenu', (e) => {
    const r = e.target.closest('.ch-row');
    if (!r) return;
    const st = el._state;
    if (r.dataset.team) { e.preventDefault(); ui.contextMenu({ kind: 'team', id: r.dataset.team }, e.clientX, e.clientY); return; }
    if (r.dataset.id && inState(st, r.dataset.id)) { e.preventDefault(); ui.contextMenu({ kind: 'session', id: r.dataset.id }, e.clientX, e.clientY); return; }
    e.preventDefault(); // the Chief stand-in and gone conversations: no menu
  });
  el._search.addEventListener('input', () => { query = el._search.value.trim(); ui.refresh(); });
  el._search.addEventListener('keydown', (e) => {
    // the page's one-key shortcuts stay out of the box; arrows, Enter and Esc work the list from here
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); if (el._search.value) { el._search.value = ''; query = ''; ui.refresh(); } else el._search.blur(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); move(e.key === 'ArrowDown' ? 1 : -1, ui); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const first = el._shown && el._shown[0];
      if (!el._shown?.some((c) => c.key === selKey) && first) pick(first.key, ui, true);
      else focusCompose(el);
    }
  });
  el._new.addEventListener('click', (e) => { e.stopPropagation(); newMenu(el, ui); });
  el._pop.addEventListener('click', (e) => { e.stopPropagation(); desk()?.popChats?.(); });
  el._popped.addEventListener('click', (e) => {
    if (e.target.closest('[data-dock]')) desk()?.dockChats?.();
    else if (e.target.closest('[data-show]')) desk()?.popChats?.();
  });
  el._head.addEventListener('click', (e) => {
    if (e.target.closest('.ch-back')) { back(ui); return; }
    const b = e.target.closest('[data-pane]');
    const c = el._cur;
    if (!b || !c || !c.id) return;
    const id = c.id;
    if (b.dataset.pane === 'terminal') { ui.openTerminal(id); return; }
    // the pop-out window has no side panel of its own to spare: the conversation opens in the main window
    if (SOLO && typeof desk()?.showMain === 'function') { desk().showMain(id); return; }
    ui.panel(id, b.dataset.pane);
  });
  // a team's chat box: Enter sends to every member (as "Message the team"), Shift+Enter starts a new line
  const grow = () => { const t = el._ta; t.style.height = 'auto'; t.style.height = `${Math.min(160, t.scrollHeight)}px`; };
  el._ta.addEventListener('input', () => { grow(); el._tnote.hidden = true; });
  el._ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendTeam(el, ui); }
    else if (e.key === 'Escape') { e.preventDefault(); el._ta.blur(); if (el.classList.contains('ch-narrow')) back(ui); }
  });
  el._send.addEventListener('click', () => sendTeam(el, ui));
  el._blank.addEventListener('click', (e) => { if (e.target.closest('.ch-start-btn')) startChief(el, ui); });
  el._chief.addEventListener('click', (e) => {
    const o = e.target.closest('[data-open]');
    if (o) {
      const t = (el._contacts || []).find((x) => x.id === o.dataset.open || (x.ids || []).includes(o.dataset.open));
      if (t) pick(t.key, ui, true);
    } else if (e.target.closest('.ch-more')) { chief.more = !chief.more; ui.refresh(); }
    else if (e.target.closest('.ch-ask')) askBrief(el);
  });
  el._chief.addEventListener('change', (e) => { if (e.target.closest('.ch-watch')) setWatch(el, ui, e.target.checked); });

  if (SOLO) {
    const head = el.querySelector('.ch-solo-top');
    head.addEventListener('click', (e) => {
      if (e.target.closest('.ch-dock')) desk()?.dockChats?.();
      else if (e.target.closest('.ch-ontop')) setOnTop(!onTop, el);
    });
    head.addEventListener('dblclick', (e) => e.preventDefault());
    el.querySelector('.ch-ontop').hidden = typeof desk()?.setChatsOnTop !== 'function';
    el.querySelector('.ch-dock').hidden = typeof desk()?.dockChats !== 'function';
    if (onTop) setOnTop(true, el);
  } else if (typeof desk()?.onChatsPopped === 'function') {
    try { desk().onChatsPopped((on) => { popped = !!on; ui.refresh(); }); } catch (e) { console.warn(e); }
  }

  ui.keys.chats = (e) => {
    if (popped && !SOLO) return false;
    const k = e.key;
    if (k === '/') { el._search.focus(); el._search.select(); return true; }
    if (k === 'Escape') { if (el.classList.contains('ch-narrow') && open) { back(ui); return true; } return false; }
    if (k === 'Enter' || k === 'o') { if (!el._cur) return false; if (el.classList.contains('ch-narrow')) { open = true; ui.refresh(); } focusCompose(el); return true; }
    const d = k === 'ArrowDown' || k === 'j' ? 1 : k === 'ArrowUp' || k === 'k' ? -1 : 0;
    if (!d) return false;
    move(d, ui);
    return true;
  };
}

function setOnTop(on, el) {
  onTop = !!on;
  store.set(TOP_KEY, onTop);
  try { desk()?.setChatsOnTop?.(onTop); } catch {}
  const b = el.querySelector('.ch-ontop');
  if (b) { b.setAttribute('aria-pressed', String(onTop)); b.classList.toggle('on', onTop); b.title = onTop ? 'Kept on top: click to let other windows cover it' : 'Keep on top'; }
}

// "+": the workspaces, each opening its own menu (New session · A / B, ...), the one Projects' + opens
function newMenu(el, ui) {
  const st = el._state || {};
  const b = el._new.getBoundingClientRect();
  const repos = (st.repoAnchors || []).filter((r) => r && r.root);
  const x = Math.max(8, b.right - 240), y = b.bottom + 4;
  openCtxMenu({
    x, y, title: 'New chat', sub: repos.length ? 'pick the workspace it works in' : null,
    items: repos.length ? repos.map((r) => ({ label: r.name || r.root, icon: 'repo', run: () => ui.contextMenu({ kind: 'repo', root: r.root, name: r.name, color: r.color }, x, y) }))
      : [{ label: 'No workspaces listed', icon: 'repo', disabled: true, note: 'add one from the workspace menu (r)' }],
  });
}

function sendTeam(el, ui) {
  const c = el._cur;
  const text = el._ta.value.trim();
  if (!c || c.kind !== 'team' || !text) return;
  const note = (msg, bad) => { el._tnote.textContent = msg; el._tnote.classList.toggle('bad', !!bad); el._tnote.hidden = !msg; };
  if (typeof ui.messageTeam !== 'function') { note('This page cannot message a team yet.', true); return; }
  let why = null;
  try { why = ui.messageTeam(c.teamId, text); } catch (e) { why = String(e && e.message || e); }
  if (why) { note(why, true); return; }
  el._ta.value = '';
  el._ta.style.height = 'auto';
  note('', false);
}

const focusCompose = (el) => requestAnimationFrame(() => {
  const c = el._cur;
  if (c && c.kind === 'team') el._ta.focus();
  else el._chat.querySelector('.chat-compose textarea')?.focus();
});

function pick(key, ui, byHand) {
  const el = pane;
  if (!el) return;
  selKey = key;
  store.set(SEL_KEY, key);
  const c = (el._contacts || []).find((x) => x.key === key);
  markSeen(c);
  // the shell's pick follows a listed conversation, so the menus and the other views agree; the panel stays shut
  if (c && c.id && inState(el._state || {}, c.id)) { ui.selectedId = c.id; syncedSel = c.id; }
  if (byHand && el.classList.contains('ch-narrow')) open = true;
  ui.refresh();
  if (byHand && !el.classList.contains('ch-narrow')) focusCompose(el);
  requestAnimationFrame(() => el._list.querySelector('.ch-row.on')?.scrollIntoView({ block: 'nearest' }));
}
function move(d, ui) {
  const list = pane?._shown || [];
  if (!list.length) return;
  const i = list.findIndex((c) => c.key === selKey);
  pick(list[i < 0 ? 0 : Math.max(0, Math.min(list.length - 1, i + d))].key, ui, false);
}
function back(ui) {
  open = false;
  ui.refresh();
  requestAnimationFrame(() => pane?._list.querySelector('.ch-row.on')?.focus({ preventScroll: true }));
}

// ---------- the chat side ----------
function drawHead(el, state, c, s) {
  const narrow = el.classList.contains('ch-narrow');
  el._head.querySelector('.ch-back').hidden = !narrow;
  if (c.kind === 'team') {
    setHTML(el._headAv, cluster(state, c, 36));
    const ms = (c.members || []).map((m) => `<span class="ch-mem${m.lead ? ' lead' : ''}" title="${esc(m.lead ? `${m.name} leads the team` : m.name)}">${memberMascot(state, m, 16)}<span>${m.lead ? '★ ' : ''}${esc(m.name)}</span></span>`).join('');
    setHTML(el._headT, `<div class="ch-head-n"><span class="name">${esc(c.name)}</span><span class="state" style="color:${esc(colorOf(c))}">GROUP</span></div><div class="ch-head-m ch-mems">${ms}</div>`);
    setHTML(el._headB, '');
    return;
  }
  setHTML(el._headAv, avatar(state, c, 36));
  if (!s) {
    setHTML(el._headT, `<div class="ch-head-n"><span class="name">${esc(c.name || 'Chief')}</span></div><div class="ch-head-m">${esc(previewOf(c))}</div>`);
    setHTML(el._headB, '');
    return;
  }
  setHTML(el._headT, `<div class="ch-head-n"><span class="name">${esc(c.kind === 'chief' ? c.name : s.name || c.name)}</span>${acctTag(s.account)}${badge(s)}</div>`
    + `<div class="ch-head-m">${repoChip(s)}${s.goal ? `<span class="ch-goal" title="${esc(s.goal)}">${esc(s.goal)}</span>` : ''}</div>`);
  const live = !s.past && inState(state, s.id);
  const where = SOLO && typeof desk()?.showMain === 'function' ? 'in the main window' : 'in the side panel';
  setHTML(el._headB, (live ? `<button type="button" class="btn" data-pane="session" title="the live session, ${where}">${icon('shell', 14)}<span>Session</span></button>`
    + `<button type="button" class="btn" data-pane="details" title="plan, ship track, files and cost, ${where}">${icon('info', 14)}<span>Details</span></button>` : '')
    + `<button type="button" class="btn" data-pane="terminal" title="open it in Windows Terminal">${icon('open', 14)}<span>Terminal</span></button>`);
}

function bubbles(state, c, team) {
  let msgs = [];
  try { msgs = team ? teamThread(team, state) || [] : []; } catch (e) { console.error(e); }
  if (!msgs.length) return `<div class="ch-tempty">${cluster(state, c, 56)}<div>No messages in ${esc(c.name)} yet.</div><div class="faint">What you send here goes to every member.</div></div>`;
  const memberIds = new Set((c.members || []).map((m) => m.id));
  const lead = (c.members || []).find((m) => m.lead);
  // a member's name from the row when the thread only has its id
  const nameOf = (id, given) => (given && given !== id ? given : ((c.members || []).find((m) => m.id === id) || {}).name || given || String(id || '').slice(0, 8));
  let prevFrom = null, prevDay = '';
  const now = Date.now();
  return msgs.map((m) => {
    const mine = !m.from || !memberIds.has(m.from);
    const day = m.t ? new Date(m.t).toDateString() : '';
    const sep = day && day !== prevDay ? `<div class="ch-day">${esc(dayLabel(m.t, now))}</div>` : '';
    if (sep) prevFrom = null;
    prevDay = day || prevDay;
    const first = m.from !== prevFrom;
    prevFrom = m.from;
    const who = mine ? (m.fromName || 'You') : `${lead && lead.id === m.from ? '★ ' : ''}${nameOf(m.from, m.fromName)}`;
    const to = m.to && !mine ? `<span class="ch-to"> → ${esc(nameOf(m.to, m.toName))}</span>` : '';
    const av = mine ? '' : `<span class="ch-bav">${first ? memberMascot(state, { id: m.from }, 26) : ''}</span>`;
    return `${sep}<div class="ch-msg${mine ? ' mine' : ''}${first ? ' first' : ''}">${av}<div class="ch-bub">`
      + `${first ? `<div class="ch-from">${esc(who)}${to}</div>` : ''}<div class="ch-text">${esc(m.text || '')}</div>`
      + `<div class="ch-at">${esc(m.t ? new Date(m.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : '')}</div></div></div>`;
  }).join('');
}
function dayLabel(ms, now) {
  const w = when(ms, now);
  return /^\d/.test(w) ? 'Today' : w;
}

function drawTeam(el, state, c) {
  const team = (state.teams || []).find((t) => t.id === c.teamId) || null;
  const th = el._thread;
  const atEnd = th.scrollHeight - th.scrollTop - th.clientHeight < 40;
  const key = th._html;
  setHTML(th, bubbles(state, c, team));
  if (th._html !== key && (atEnd || th._for !== c.key)) th.scrollTop = th.scrollHeight;
  th._for = c.key;
  // can every member be reached from here? (the chat box says why not before anything is written)
  let why = null;
  if (!team) why = 'This team is gone.';
  else if (typeof curUi().teamReach === 'function') { try { why = curUi().teamReach(c.teamId); } catch {} }
  else if (typeof curUi().messageTeam !== 'function') why = 'This page cannot message a team yet.';
  el._ta.disabled = !!why;
  el._send.disabled = !!why;
  el._ta.placeholder = why || `Message everyone in ${c.name}`;
}
const curUi = () => pane?._ui || {};

// ---------- the Chief ----------
const ago = (ms, now) => {
  const m = Math.max(0, Math.round((now - ms) / 60000));
  return !ms ? '' : m < 1 ? 'now' : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};
async function postJson(url, body) {
  if (FIXTURE) { try { window.__fvPosts?.push({ url, body: JSON.parse(JSON.stringify(body)) }); } catch {} return { ok: true, status: 200, body: null }; }
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => null);
    return { ok: r.ok && !(j && j.ok === false), status: r.status, body: j };
  } catch { return { ok: false, status: 0, body: null }; }
}
const failText = (r, what) => (r.status === 503 ? "The desktop app's session host is not running"
  : r.status === 0 ? 'Could not reach Fleet View'
  : (r.body && (r.body.error || r.body.message)) || `${what} (error ${r.status})`);

async function startChief(el, ui) {
  if (chief.starting) return;
  chief.starting = true;
  chief.err = '';
  ui.refresh();
  if (FIXTURE) {
    // nothing is posted: a fixture conversation stands in for the started Chief
    const ss = (el._state && el._state.allSessions) || [];
    const s = ss.find((x) => x.state === 'IDLE') || ss.find((x) => x.state === 'DONE') || ss[ss.length - 1];
    chief.fakeId = s ? s.id : null;
    chief.starting = false;
    ui.refresh();
    return;
  }
  const r = await postJson('/api/chief/start', {});
  chief.starting = false;
  if (r.ok) chief.startedAt = Date.now();
  else chief.err = failText(r, 'Could not start the Chief');
  ui.refresh();
}

const watchOn = (state) => (FIXTURE ? chief.watch
  : chief.watchSet !== null && Date.now() - chief.watchAt < 6000 ? chief.watchSet : !!(state.settings && state.settings.chief && state.settings.chief.watch));
async function setWatch(el, ui, on) {
  chief.watchErr = '';
  if (FIXTURE) { chief.watch = on; ui.refresh(); return; } // kept local
  chief.watchSet = on;
  chief.watchAt = Date.now();
  ui.refresh();
  const r = await postJson('/settings', { chief: { watch: on } });
  if (!r.ok) { chief.watchSet = null; chief.watchErr = failText(r, 'Could not change Watch mode'); ui.refresh(); }
}

// "Ask the Chief": puts "Brief me" in the chat box. Nothing is sent; Enter does that.
function askBrief(el) {
  const ta = el._chat.querySelector('.chat-compose textarea');
  if (!ta) return;
  if (!ta.value.trim()) { ta.value = 'Brief me'; ta.dispatchEvent(new Event('input', { bubbles: true })); }
  ta.focus();
  try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch {}
}

// ?fixture=1: a briefing in the server's shape, built from the fixture sessions
function fixtureBriefing(state) {
  const now = Date.now(), ss = state.allSessions || [];
  const repoOf = (s) => (s.repo && s.repo.name) || '';
  const act = (s) => (s.lastAction && s.lastAction.what ? `${s.lastAction.verb || 'working'} ${s.lastAction.what}` : s.goal || s.label || '');
  const needsYou = ss.filter((s) => NEEDS.has(s.state)).slice(0, 10).map((s) => ({
    id: s.id, name: s.name, repo: repoOf(s), since: (s.lastAction && s.lastAction.t) || now,
    what: s.state === 'ERROR' ? 'hit an error' : s.state === 'STALLED' ? 'looks stalled' : (typeof s.waitingOn === 'string' ? s.waitingOn : s.waitingOn && s.waitingOn.text) || 'asked you a question',
  }));
  const working = ss.filter((s) => BUSY.has(s.state)).slice(0, 12).map((s) => ({ id: s.id, name: s.name, repo: repoOf(s), doing: act(s), since: s.turnStart || (s.lastAction && s.lastAction.t) || now }));
  const finished = (state.finished || []).slice(0, 10).map((f) => ({ id: f.id, name: f.name, repo: (f.repo && f.repo.name) || '', summary: f.summary || '', at: f.endedAt || now }));
  const deploys = (state.deploys || []).slice(0, 6).map((d) => ({ repo: d.name || d.repo, state: d.state, title: d.title || '', at: d.readyAt || d.createdAt || now }));
  const text = [];
  if (needsYou.length) text.push(`${needsYou.length} need${needsYou.length === 1 ? 's' : ''} you: ${needsYou.slice(0, 3).map((n) => `${n.name} (${n.what})`).join(', ')}${needsYou.length > 3 ? ` and ${needsYou.length - 3} more` : ''}`);
  if (working.length) text.push(`${working.length} working: ${working.slice(0, 3).map((w) => w.name).join(', ')}${working.length > 3 ? ` and ${working.length - 3} more` : ''}`);
  if (finished.length) text.push(`${finished.length} finished: ${finished.slice(0, 2).map((f) => `${f.name} (${f.summary})`).join(', ')}`);
  for (const d of deploys.slice(0, 2)) text.push(`Deploy ${d.state}: ${d.repo}${d.title ? ` · ${d.title}` : ''}`);
  return { at: now, needsYou, working, finished, deploys, text: text.join('\n') || 'Nothing is going on.' };
}

async function loadBrief(el, state) {
  if (chief.briefBusy) return;
  chief.briefBusy = true;
  chief.briefAt = Date.now();
  try {
    if (FIXTURE) chief.brief = fixtureBriefing(state);
    else {
      const r = await fetch('/chief/briefing', { cache: 'no-store' });
      if (!r.ok) throw new Error(String(r.status));
      chief.brief = await r.json();
    }
    chief.briefErr = '';
  } catch { chief.briefErr = 'Could not read the briefing.'; }
  chief.briefBusy = false;
  if (pane === el) curUi().refresh?.();
}

function briefRow(o, kind, a, b, c, when) {
  const tag = o.id ? 'button type="button"' : 'div';
  return `<${tag} class="ch-br-row ${kind}"${o.id ? ` data-open="${esc(o.id)}" title="Open ${esc(o.name || '')}"` : ''}>`
    + `<span class="ch-br-n">${esc(a)}</span>${b ? `<span class="ch-br-r">${esc(b)}</span>` : ''}<span class="ch-br-w">${esc(c)}</span><span class="ch-br-s">${esc(when)}</span></${o.id ? 'button' : 'div'}>`;
}
function briefHtml(b, now) {
  if (!b) return chief.briefErr ? `<div class="ch-br-lines bad">${esc(chief.briefErr)}</div>` : '<div class="ch-br-lines faint">Reading what is going on...</div>';
  if (!chief.more) return `<div class="ch-br-lines">${String(b.text || '').split('\n').filter(Boolean).map((l) => `<div>${esc(l)}</div>`).join('') || '<div class="faint">Nothing is going on.</div>'}</div>`;
  const sec = (title, list, row) => (list.length ? `<div class="ch-br-sec"><div class="ch-br-st">${title}<span>${list.length}</span></div>${list.map(row).join('')}</div>` : '');
  const body = sec('Needs you', b.needsYou || [], (x) => briefRow(x, 'needs', x.name, x.repo, x.what, ago(x.since, now)))
    + sec('Working', b.working || [], (x) => briefRow(x, 'work', x.name, x.repo, x.doing, ago(x.since, now)))
    + sec('Finished', b.finished || [], (x) => briefRow(x, 'done', x.name, x.repo, x.summary, ago(x.at, now)))
    + sec('Deploys', b.deploys || [], (x) => briefRow({}, `dep ${/^\w+$/.test(x.state) ? x.state : ''}`, x.repo, x.state, x.title, ago(x.at, now)));
  return body || '<div class="ch-br-lines faint">Nothing is going on.</div>';
}
function drawChief(el, state) {
  const now = Date.now(), b = chief.brief, on = watchOn(state);
  const at = b && b.at ? new Date(b.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : '';
  setHTML(el._chief, `<div class="ch-br"><div class="ch-br-h"><span class="ch-br-t">Briefing</span>${at ? `<span class="ch-br-at">${esc(at)}</span>` : ''}<span class="grow"></span>`
    + `<button type="button" class="ch-more" aria-expanded="${chief.more}">${chief.more ? 'Less' : 'More'}</button></div>`
    + `<div class="ch-br-body">${briefHtml(b, now)}</div>`
    + `<div class="ch-br-f"><button type="button" class="btn ch-ask" title="Types &quot;Brief me&quot; in the chat box. Free: reading the briefing sends the Chief nothing, and nothing is sent until you press Enter">Ask the Chief</button><span class="grow"></span>`
    + `<label class="ch-wsw"><input type="checkbox" class="ch-watch" role="switch"${on ? ' checked' : ''} aria-label="Watch mode"><span class="ch-track"></span><span class="ch-wl">Watch mode</span></label></div></div>`
    + `<div class="ch-wnote${chief.watchErr ? ' bad' : ''}">${esc(chief.watchErr || 'Off: the Chief acts only when you tell it. On: it checks in every 15 min at most and may nudge stalled bots.')}</div>`);
}

function blankHtml(state, c) {
  if (c && c.kind === 'chief') {
    const mas = mascotSVG('chief', { state: 'new', color: C.gold, size: 72 });
    if (c.id) return `<div class="ch-empty">${mas}<div class="ch-empty-t">The Chief</div><div class="ch-empty-s">Opening its chat...</div></div>`;
    const wait = chief.starting || Date.now() - chief.startedAt < START_WAIT;
    return `<div class="ch-empty ch-start">${mas}<div class="ch-empty-t">The Chief</div>`
      + `<div class="ch-empty-s">Briefs you, answers what's going on, passes your orders on</div>`
      + `<div class="ch-defaults" title="What it starts with">Sonnet 5.5 · medium · account B</div>`
      + `<button type="button" class="btn primary ch-start-btn"${wait ? ' disabled' : ''}>${wait ? 'Starting...' : 'Start the Chief'}</button>`
      + `${chief.err ? `<div class="ch-start-err" role="alert">${esc(chief.err)}</div>` : ''}</div>`;
  }
  return `<div class="ch-empty">${mascotSVG('chats', { state: 'idle', color: C.cyan, size: 72 })}<div class="ch-empty-t">Pick a chat</div>`
    + `<div class="ch-empty-s">Every bot, team and the Chief are on the left.</div></div>`;
}

// ---------- render ----------
export function renderChats(el, state, ui) {
  if (!el._built) build(el, ui);
  el._ui = ui;
  el._state = state;
  const now = Date.now();
  const canPop = !SOLO && typeof desk()?.popChats === 'function';
  el._pop.hidden = !canPop;
  el._popped.hidden = !popped || SOLO;
  el._ch.hidden = popped && !SOLO;
  if (popped && !SOLO) return;

  if (!chains) { try { chains = createChainStore(); } catch (e) { console.warn(e); chains = undefined; } }
  let contacts = [];
  try {
    contacts = sortContacts(buildContacts(state, { chiefId: state.settings?.chief?.id || (FIXTURE ? chief.fakeId : null), chiefPlaceholder: true, chains: chains || undefined }));
  } catch (e) { console.error('chats: contacts', e); }
  el._contacts = contacts;
  // a pick made in another view (a card, the map) carries over to the row that holds it
  if (ui.selectedId && ui.selectedId !== syncedSel) {
    syncedSel = ui.selectedId;
    const c = contacts.find((x) => x.id === ui.selectedId || (x.ids || []).includes(ui.selectedId));
    if (c && c.key !== selKey) { selKey = c.key; store.set(SEL_KEY, selKey); markSeen(c); }
  }
  const shown = contacts.filter((c) => matches(c, query));
  el._shown = shown;
  setHTML(el._accts, acctDots(state, contacts));
  setHTML(el._list, listHtml(state, shown, now));

  const c = contacts.find((x) => x.key === selKey) || null;
  // the open chat stays read: new activity in it is not "unread"
  if (c && (!el.classList.contains('ch-narrow') || open)) markSeen(c);
  el._cur = c;
  const narrow = el.classList.contains('ch-narrow');
  el.classList.toggle('ch-open', narrow && open && !!c);
  if (!c) open = false;

  let s = c && c.kind !== 'team' ? findSession(state, c.id) : null;
  if (c && c.kind !== 'team' && !s && selLast && selLast.id === c.id) s = selLast;
  if (s) selLast = s;
  const team = c && c.kind === 'team';
  el._head.hidden = !c;
  el._chat.hidden = !s;
  // the Chief's strip (briefing + Watch mode) sits above its thread, scrolling inside itself when it is tall; the briefing reads only while that pane shows
  const isChief = !!(s && c.kind === 'chief' && c.id);
  el._chief.hidden = !isChief;
  if (isChief) {
    if (!narrow || open) {
      if (!chief.briefOn) { chief.briefOn = true; chief.briefAt = 0; }
      if (Date.now() - chief.briefAt >= BRIEF_MS) loadBrief(el, state);
    } else chief.briefOn = false;
    drawChief(el, state);
  } else chief.briefOn = false;
  el._team.hidden = !team;
  el._blank.hidden = !!(s || team);
  if (!s && !team) { setHTML(el._blank, blankHtml(state, c)); if (c) drawHead(el, state, c, null); return; }
  drawHead(el, state, c, s);
  if (team) { drawTeam(el, state, c); return; }
  renderChatPane(el._chat, s, { visible: !narrow || open });
}
