// Bots view (the tab users see as Bots; its id, file, storage keys and ?solo=chats keep the old name "chats"):
// Fleet View as a phone messenger for the overseers only: the Chief and Henry's bots (bots.js), never a conversation
// of the map's. On the left, one row per contact (chats-model.js): the Chief pinned on top, then every bot (one row
// however many conversations it went through) and every team of overseers as a group chat, each with its blob
// mascot (mascot.js), name, time and a one-line preview; on the right, the picked one's chat: a running bot's or the
// Chief's is the same chat pane and chat box as the Projects view (chat.js), a team's is its thread as bubbles with
// a box that sends to every member the way the team menu's "Message the team" does (ui.messageTeam in app.js).
//
// Bots: "+" opens the New bot form in the chat side (name, what it does, account, model, effort; the Chief's defaults),
// which POSTs /bots: the server makes its folder ~/Bots/<slug> with its CLAUDE.md and starts it, and the new row is
// picked. A bot that is not running (state.bots live false) shows Start in its header, its last chat read only (or,
// never started, a card with its instructions and a Start button) and a box of its own: what you type there starts
// it (POST /bots/:id/start: its running conversation, else its last one resumed, else a new one), and goes in once
// its session is up (handto.js hands it to that conversation's chat box, which sends it). Right-click a bot: Start,
// Rename and Edit instructions (POST /bots/:id), Remove bot (asks first; POST /bots/:id/remove). With no bot yet, the
// list says what bots are for, with a New bot button.
//
// Built once and patched on each render; the list's HTML is rewritten only when what it shows changed. The pick
// (a contact key) is kept in this window's storage (fv.chats.sel; the pop-out window keeps its own), and when each
// contact was last opened in fv.chats.seen (the unread dots; shared by both windows). Picking a contact clears the
// shell's pick (ui.selectedId): an overseer is no conversation of the other views'. Keys: ↑↓ (or j/k) move, Enter
// puts the cursor in the chat box, / the search box, Esc goes back to the list in the narrow layout.
//
// Narrow (the view itself under 640px wide, measured on the element: the pop-out window can be narrow): the list
// only; a pick slides the chat over it, with a back arrow.
// Pop-out (desktop window; every call feature-detected): a button in the list's top bar calls
// fleetDesktop.popChats(); fleetDesktop.onChatsPopped(cb) says when Bots is in its own window, and this view then
// shows a calm placeholder with "Bring it back" (dockChats) and "Show it" (popChats). The pop-out window's page is
// this one with ?solo=chats (SOLO): only this view, under a small 36px header that drags the window, with a
// pin-on-top toggle (setChatsOnTop) and a dock-back button (dockChats); Session and Details there open the
// conversation in the main window (showMain).
//
// The Chief: with none started (settings.chief.id null) its pane is a short card with a Start button (POST
// /api/chief/start). Once there is one, its pane is a bot's chat with a strip above the thread: the briefing card
// (GET /chief/briefing when the pane opens and at most every 60 s while it shows; free, it sends the Chief nothing)
// and the Watch mode switch (POST /settings { chief: { watch } }). With ?fixture=1 nothing is posted: Start fakes
// a Chief from a fixture conversation and the briefing is built here from the fixture sessions; a bot made with the
// form is kept in the page, and Start, Rename, Edit instructions and Remove bot only record their POSTs.
import { C, esc, setHTML, badge, acctTag, acctColor, isAcct, repoChip } from './cards.js';
import { icon } from './icons.js';
import { renderChatPane } from './chat.js';
import { onRekey, hosts, termApi } from './term.js';
import { openCtxMenu } from './ctxmenu.js';
import { mascotSVG, mascotState } from './mascot.js';
import { MODEL_IDS, EFFORTS, modelLabel } from './compose.js';
import { handToChat } from './handto.js';
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
let popped = false; // Bots is in its own window (main window only)
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
const BOT_WAIT = 90000; // a start with a message: how long the message waits for the bot's session to be up
const MADE_MS = 15000; // a bot just made shows from POST /bots's answer until /state lists it, at most this long
const DEF = { account: 'B', model: 'claude-sonnet-5-5', effort: 'medium' }; // a new bot's: the Chief's (chief.js DEFAULTS)
// bot id -> what this page is doing with it: { starting (its POST), wait ({ text, id, at }: a message waiting for it to
// be up), err, note, draft (its box), restore (the draft goes back in the box) }
const botUi = new Map();
const bu = (id) => { let u = botUi.get(id); if (!u) botUi.set(id, (u = { starting: false, wait: null, err: '', note: '', draft: '', restore: false })); return u; };
let form = null; // the New bot form while it shows: { busy, err, fresh }
const made = new Map(); // bot id -> { bot, at }: made here, until /state lists it (?fixture=1: for good)
const botOf = (state, id) => (state.bots || []).find((b) => b && b.id === id) || null;

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
  const u = c.botId ? botUi.get(c.botId) : null;
  if (u && (u.starting || u.wait)) return 'Starting...';
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
  return `<button type="button" class="ch-row${on ? ' on' : ''}${c.needsYou ? ' needs' : ''}${un ? ' unread' : ''}${c.kind !== 'team' && !c.id ? ' ghost' : ''}" role="option" aria-selected="${on}"`
    + ` data-key="${esc(c.key)}"${c.id ? ` data-id="${esc(c.id)}"` : ''}${c.teamId ? ` data-team="${esc(c.teamId)}"` : ''}${c.botId ? ` data-bot="${esc(c.botId)}"` : ''} style="--rc:${esc(colorOf(c))}" title="${esc(c.name || '')}">`
    + `<span class="ch-av">${avatar(state, c, 40)}</span>`
    + `<span class="ch-body"><span class="ch-l1"><span class="ch-name">${esc(c.name || 'bot')}</span>${c.kind === 'team' ? '' : acctTag(c.account)}`
    + `<span class="ch-time">${pin}${esc(when(c.at, now))}</span></span>`
    + `<span class="ch-l2"><span class="ch-prev">${esc(previewOf(c))}</span>${c.needsYou ? '<span class="ch-flag" title="needs you">!</span>' : un ? '<span class="ch-dot" aria-label="unread"></span>' : ''}</span>`
    + `</span></button>`;
}

// with no bot yet (the Chief aside): what bots are for, and the New bot button
const BOTS_FOR = 'Bots are overseers you give standing tasks, away from the map.';
const newBotBtn = () => `<button type="button" class="btn primary ch-newbot" data-newbot="1">${icon('plus', 14)}<span>New bot</span></button>`;
function listHtml(state, list, now, noBots) {
  const intro = noBots && !query ? `<div class="ch-none ch-intro"><div>${esc(BOTS_FOR)}</div>${newBotBtn()}</div>` : '';
  if (!list.length) return query ? `<div class="ch-none">No bots match “${esc(query)}”.</div>` : intro || '<div class="ch-none">No bots yet. Make one with +.</div>';
  return list.map((c) => rowHtml(state, c, now)).join('') + intro;
}

function acctDots(state, contacts) {
  const list = Array.isArray(state.accounts) && state.accounts.length ? state.accounts.filter(isAcct)
    : [...new Set(contacts.map((c) => c.account).filter(isAcct))].sort();
  return list.map((a) => `<span class="ch-acct" style="background:${esc(acctColor(a))}" title="Claude account ${esc(a)}">${esc(a)}</span>`).join('');
}

// ---------- build ----------
function build(el, ui) {
  el.innerHTML = `${SOLO ? `<header class="ch-solo-top"><span class="ch-solo-m">${mascotSVG('chats', { state: 'idle', color: C.cyan, size: 20 })}</span>`
    + `<span class="ch-solo-t">Bots</span><span class="grow"></span>`
    + `<button type="button" class="ch-ib ch-ontop" aria-pressed="false" title="Keep on top">${icon('pin', 14)}</button>`
    + `<button type="button" class="ch-ib ch-dock" title="Back into the main window">${icon('open', 14)}</button></header>` : ''}`
    + `<div class="ch-popped" hidden><div class="ch-popped-in">${mascotSVG('chats', { state: 'idle', color: C.cyan, size: 56 })}`
    + `<div class="ch-popped-t">Bots is open in its own window</div><div class="ch-popped-b">`
    + `<button type="button" class="btn" data-dock="1">Bring it back</button><button type="button" class="btn primary" data-show="1">Show it</button></div></div></div>`
    + `<div class="ch"><nav class="ch-side" aria-label="bots">`
    + `<div class="ch-top"><span class="ch-title">Bots</span><span class="ch-accts"></span><span class="grow"></span>`
    + `<button type="button" class="ch-ib ch-pop" title="Open Bots in its own window" hidden>${icon('external', 15)}</button>`
    + `<button type="button" class="ch-ib ch-new" title="New bot" aria-label="New bot">${icon('plus', 16)}</button></div>`
    + `<label class="ch-search">${icon('search', 14)}<input type="search" spellcheck="false" autocomplete="off" placeholder="Search bots" aria-label="Search bots"></label>`
    + `<div class="ch-list" role="listbox" aria-label="bots"></div></nav>`
    + `<section class="ch-main"><header class="ch-head" hidden><button type="button" class="ch-ib ch-back" title="Back to the bots (Esc)" aria-label="Back">${icon('chevron', 16)}</button>`
    + `<span class="ch-head-av"></span><div class="ch-head-t"></div><div class="ch-head-b"></div></header>`
    + `<div class="ch-chief" hidden></div><div class="ch-chat" hidden></div>`
    + `<div class="ch-team" hidden><div class="ch-thread" role="log" aria-live="polite"></div>`
    + `<div class="ch-tcomp"><textarea rows="1" spellcheck="true" placeholder="Message the team"></textarea>`
    + `<button type="button" class="ch-send" title="Send to every member (Enter)" aria-label="Send">${icon('send', 16)}</button><div class="ch-tnote" hidden></div></div></div>`
    // a bot that is not running: its last chat (read only) or its card, and a box that starts it, then sends
    + `<div class="ch-bot" hidden><div class="ch-bot-chat" hidden></div><div class="ch-bot-intro" hidden></div>`
    + `<div class="ch-tcomp ch-bcomp"><textarea rows="1" spellcheck="true"></textarea>`
    + `<button type="button" class="ch-send" title="Start it, then send this (Enter)" aria-label="Start and send">${icon('send', 16)}</button><div class="ch-tnote" hidden></div></div></div>`
    + `<div class="ch-form" hidden></div>`
    + `<div class="ch-blank"></div></section></div>`;
  const q = (s) => el.querySelector(s);
  Object.assign(el, {
    _ch: q('.ch'), _side: q('.ch-side'), _list: q('.ch-list'), _accts: q('.ch-accts'), _pop: q('.ch-pop'), _new: q('.ch-new'),
    _search: q('.ch-search input'), _head: q('.ch-head'), _headAv: q('.ch-head-av'), _headT: q('.ch-head-t'), _headB: q('.ch-head-b'),
    _chat: q('.ch-chat'), _chief: q('.ch-chief'), _team: q('.ch-team'), _thread: q('.ch-thread'), _ta: q('.ch-team textarea'), _send: q('.ch-team .ch-send'),
    _tnote: q('.ch-team .ch-tnote'), _blank: q('.ch-blank'), _popped: q('.ch-popped'), _onTop: q('.ch-ontop'),
    _bot: q('.ch-bot'), _bchat: q('.ch-bot-chat'), _bintro: q('.ch-bot-intro'), _bta: q('.ch-bcomp textarea'), _bsend: q('.ch-bcomp .ch-send'),
    _bnote: q('.ch-bcomp .ch-tnote'), _form: q('.ch-form'),
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
    if (e.target.closest('[data-newbot]')) { openForm(el, ui); return; }
    const r = e.target.closest('.ch-row');
    if (!r) return;
    pick(r.dataset.key, ui, true);
  });
  el._list.addEventListener('contextmenu', (e) => {
    const r = e.target.closest('.ch-row');
    if (!r) return;
    const st = el._state;
    if (r.dataset.team) { e.preventDefault(); ui.contextMenu({ kind: 'team', id: r.dataset.team }, e.clientX, e.clientY); return; }
    if (r.dataset.bot && botOf(st || {}, r.dataset.bot)) { e.preventDefault(); botMenu(el, ui, r.dataset.bot, e.clientX, e.clientY); return; }
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
  el._new.addEventListener('click', (e) => { e.stopPropagation(); openForm(el, ui); });
  el._pop.addEventListener('click', (e) => { e.stopPropagation(); desk()?.popChats?.(); });
  el._popped.addEventListener('click', (e) => {
    if (e.target.closest('[data-dock]')) desk()?.dockChats?.();
    else if (e.target.closest('[data-show]')) desk()?.popChats?.();
  });
  el._head.addEventListener('click', (e) => {
    if (e.target.closest('.ch-back')) { back(ui); return; }
    if (e.target.closest('[data-start]')) { if (el._cur && el._cur.botId) startBot(ui, el._cur.botId); return; }
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
  // a bot that is not running: its box starts it, then sends (Enter), Shift+Enter starts a new line; its draft is kept per bot
  const growB = () => { const t = el._bta; t.style.height = 'auto'; t.style.height = `${Math.min(160, t.scrollHeight)}px`; };
  el._growB = growB;
  el._bta.addEventListener('input', () => {
    growB();
    const c = el._cur;
    if (c && c.botId) { const u = bu(c.botId); u.draft = el._bta.value; if (u.err || u.note) { u.err = ''; u.note = ''; el._bnote.hidden = true; } }
  });
  el._bta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendBot(el, ui); }
    else if (e.key === 'Escape') { e.preventDefault(); el._bta.blur(); if (el.classList.contains('ch-narrow')) back(ui); }
  });
  el._bsend.addEventListener('click', () => sendBot(el, ui));
  el._bintro.addEventListener('click', (e) => { if (e.target.closest('[data-start]') && el._cur && el._cur.botId) startBot(ui, el._cur.botId); });
  el._blank.addEventListener('click', (e) => {
    if (e.target.closest('[data-newbot]')) openForm(el, ui);
    else if (e.target.closest('.ch-start-btn')) startChief(el, ui);
  });
  // the New bot form: Enter in the name (or Ctrl+Enter anywhere) makes it, Esc or Cancel closes it
  el._form.addEventListener('submit', (e) => { e.preventDefault(); submitForm(el, ui); });
  el._form.addEventListener('click', (e) => { if (e.target.closest('[data-cancel]')) closeForm(ui); });
  el._form.addEventListener('keydown', (e) => {
    e.stopPropagation(); // the page's one-key shortcuts stay out of the form
    if (e.key === 'Escape') { e.preventDefault(); closeForm(ui); }
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submitForm(el, ui); }
  });
  el._chief.addEventListener('click', (e) => {
    const o = e.target.closest('[data-open]');
    if (o) {
      // a bot's row here; a conversation of the map's opens in the side panel (the main window's, from the pop-out)
      const id = o.dataset.open;
      const t = (el._contacts || []).find((x) => x.id === id || (x.ids || []).includes(id));
      if (t) pick(t.key, ui, true);
      else if (SOLO && typeof desk()?.showMain === 'function') desk().showMain(id);
      else if (inState(el._state || {}, id)) ui.panel(id, 'chat');
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
    if (form && k === 'Escape') { closeForm(ui); return true; }
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

// ---------- bots: + New bot, Start, the right-click menu ----------
// "+": the New bot form, in place of the chat (over the list in the narrow layout)
function openForm(el, ui) {
  form = { busy: false, err: '', fresh: true };
  if (el.classList.contains('ch-narrow')) open = true;
  ui.refresh();
}
function closeForm(ui) {
  if (!form) return;
  form = null;
  if (pane && pane.classList.contains('ch-narrow')) open = false;
  ui.refresh();
}
function drawForm(el, state) {
  if (form.fresh) {
    form.fresh = false;
    const accts = Array.isArray(state.accounts) && state.accounts.some(isAcct) ? state.accounts.filter(isAcct) : ['A', 'B'];
    const acct = accts.includes(DEF.account) ? DEF.account : accts[0];
    const opt = (v, label, on) => `<option value="${esc(v)}"${on ? ' selected' : ''}>${esc(label)}</option>`;
    el._form.innerHTML = `<form class="ch-nb" novalidate autocomplete="off">`
      + `<div class="ch-nb-h">${mascotSVG('new-bot', { state: 'new', color: C.cyan, size: 44 })}<div><div class="ch-nb-t">New bot</div>`
      + `<div class="ch-nb-s">An overseer you give standing tasks. It works in a folder of its own (~/Bots), never on the map, and starts once it is made.</div></div></div>`
      + `<label class="ch-f"><span>Name</span><input name="name" maxlength="40" spellcheck="false" placeholder="e.g. Deploy watch"></label>`
      + `<label class="ch-f"><span>What it does</span><textarea name="brief" maxlength="4000" rows="6" placeholder="Its standing instructions: what it watches, what it does, when it tells you"></textarea></label>`
      + `<div class="ch-f-row"><label class="ch-f"><span>Account</span><select name="account">${accts.map((a) => opt(a, a, a === acct)).join('')}</select></label>`
      + `<label class="ch-f"><span>Model</span><select name="model">${MODEL_IDS.map((m) => opt(m, modelLabel(m), m === DEF.model)).join('')}</select></label>`
      + `<label class="ch-f"><span>Effort</span><select name="effort">${EFFORTS.map((x) => opt(x, x, x === DEF.effort)).join('')}</select></label></div>`
      + `<div class="ch-nb-err" role="alert" hidden></div>`
      + `<div class="ch-nb-b"><button type="button" class="btn" data-cancel="1">Cancel</button><button type="submit" class="btn primary" data-make="1"></button></div></form>`;
    requestAnimationFrame(() => el._form.querySelector('input[name="name"]')?.focus());
  }
  const f = el._form.querySelector('form');
  const er = f.querySelector('.ch-nb-err');
  er.textContent = form.err;
  er.hidden = !form.err;
  const mk = f.querySelector('[data-make]');
  mk.disabled = form.busy;
  mk.textContent = form.busy ? 'Making it...' : 'Make it';
}
async function submitForm(el, ui) {
  if (!form || form.busy) return;
  const f = el._form.querySelector('form');
  const v = (n) => String((f && f.elements[n] && f.elements[n].value) || '');
  const body = { name: v('name').trim(), brief: v('brief').trim(), account: v('account'), model: v('model'), effort: v('effort') };
  if (!body.name) { form.err = 'Give it a name.'; ui.refresh(); f.elements.name.focus(); return; }
  form.busy = true;
  form.err = '';
  ui.refresh();
  const r = await postJson('/bots', body);
  if (!form) return; // closed meanwhile
  let bot = r.body && r.body.bot;
  // ?fixture=1: nothing was made; this page keeps one for good
  if (FIXTURE) bot = { id: [...crypto.getRandomValues(new Uint8Array(6))].map((x) => x.toString(16).padStart(2, '0')).join(''), ...body, folder: `~/Bots/${body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, createdAt: Date.now(), convId: null, live: false };
  // made but not started: ok false, with the bot; its pane says why
  if (!bot || typeof bot.id !== 'string') { form.busy = false; form.err = failText(r, 'Could not make the bot'); ui.refresh(); return; }
  made.set(bot.id, { bot, at: Date.now() });
  if (!r.ok) bu(bot.id).err = (r.body && r.body.message) || 'It was made, but did not start.';
  form = null;
  pick(`bot:${bot.id}`, ui, true);
}

// Start, and with text: the text goes in once its session is up (pumpBots). The text is back in its box when it fails
async function startBot(ui, botId, text = '') {
  const u = bu(botId);
  if (u.starting || u.wait) return;
  u.starting = true;
  u.err = '';
  u.note = '';
  if (text) u.draft = '';
  ui.refresh();
  const r = await postJson(`/bots/${botId}/start`, {});
  u.starting = false;
  const back = () => { if (text) { u.draft = text; u.restore = true; } };
  if (FIXTURE) { u.note = 'Fixture data: nothing starts here.'; back(); }
  else if (!r.ok) { u.err = failText(r, 'Could not start it'); back(); }
  else if (text) u.wait = { text, id: (r.body && typeof r.body.id === 'string' && r.body.id) || null, at: Date.now() };
  ui.refresh();
}
function sendBot(el, ui) {
  const c = el._cur;
  const text = el._bta.value.trim();
  if (!c || !c.botId || !text) return;
  el._bta.value = '';
  el._growB();
  startBot(ui, c.botId, text);
}
// each render: a message waiting for its bot goes to that conversation's chat box once the session is up (the box
// sends it: handto.js), or comes back to the bot's box after BOT_WAIT
function pumpBots(state) {
  for (const [bid, u] of botUi) {
    const w = u.wait;
    if (!w) continue;
    const b = botOf(state, bid);
    const id = (b && b.live && b.convId) || w.id;
    const s = id ? findSession(state, id) : null;
    const h = id ? hosts.get(id) : null;
    // the desktop window: the host runs it and Claude says how it is; a browser can't type into it anyway
    const up = !!(b && s && (termApi() ? h && h.alive && h.status : b.live));
    if (up) { u.wait = null; handToChat(id, { text: w.text, send: true }); continue; }
    if (b && Date.now() - w.at < BOT_WAIT) continue;
    u.wait = null;
    if (b && s && b.live) handToChat(id, { text: w.text }); // it runs but never said it is ready: the text waits in its chat box
    else { u.draft = w.text; u.restore = true; u.err = b ? `${b.name} did not come up within ${BOT_WAIT / 1000} s; your message is back in the box.` : 'This bot is gone.'; }
  }
}

// the right-click menu of a bot's row: Start, Rename, Edit instructions, Remove bot (the Chief keeps the conversation menu)
function botMenu(el, ui, botId, x, y) {
  const b = botOf(el._state || {}, botId);
  if (!b) return;
  const c = (el._contacts || []).find((k) => k.botId === botId);
  const u = bu(botId);
  openCtxMenu({
    x, y, title: b.name, dot: colorOf(c), sub: b.live ? 'running' : 'not running',
    items: [
      ...(b.live ? [] : [u.starting || u.wait ? { label: 'Start', icon: 'shell', disabled: true, note: 'starting...' }
        : { label: 'Start', icon: 'shell', note: b.convId ? 'goes on in its last conversation' : 'its first conversation', run: () => startBot(ui, botId) }]),
      { label: 'Rename', icon: 'edit', input: { value: b.name, placeholder: 'its name: 1 to 40 characters', hint: 'Enter saves · Esc', empty: 'a bot needs a name', busy: 'saving…', submit: (t) => saveBot(ui, botId, { name: t.trim() }) } },
      { label: 'Edit instructions', icon: 'plan', input: {
        value: b.brief || '', multiline: true, allowEmpty: true, placeholder: 'What it does: its standing instructions', busy: 'saving…',
        hint: 'Enter saves · Shift+Enter new line · Esc · a running bot reads them again at once', submit: (t) => saveBot(ui, botId, { brief: t }),
      } },
      { sep: true },
      { label: 'Remove bot', icon: 'trash', danger: true, note: 'its folder and chats are kept', confirm: { text: `Remove ${b.name}? Its session ends. Its folder and its conversations are kept.`, yes: 'Remove' }, run: () => removeBot(ui, botId, b.name) },
    ],
  });
}
// POST /bots/:id -> null when it is saved (the menu's box closes), else why not
async function saveBot(ui, botId, body) {
  const r = await postJson(`/bots/${botId}`, body);
  if (FIXTURE) { const m = made.get(botId); if (m) Object.assign(m.bot, body); ui.refresh(); return null; }
  if (!r.ok) return failText(r, 'Could not save it');
  ui.refresh();
  return null;
}
async function removeBot(ui, botId, name) {
  const r = await postJson(`/bots/${botId}/remove`, {});
  made.delete(botId);
  if (!FIXTURE && !r.ok) bu(botId).err = failText(r, `Could not remove ${name}`);
  ui.refresh();
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
  else if (!el._bot.hidden) el._bta.focus();
  else el._chat.querySelector('.chat-compose textarea')?.focus();
});

function pick(key, ui, byHand) {
  const el = pane;
  if (!el) return;
  if (byHand) form = null;
  selKey = key;
  store.set(SEL_KEY, key);
  const c = (el._contacts || []).find((x) => x.key === key);
  markSeen(c);
  // an overseer is never the other views' pick: the shell's goes, so their keys (Delete, Enter) never act on one
  // picked there, and Projects doesn't take this one up; the panel stays shut
  if (c && ui.selectedId) { ui.selectedId = null; syncedSel = null; }
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
  // a bot that is not running: Start, nothing that would open its conversation without its role
  const u = c.botId ? bu(c.botId) : null;
  const start = c.kind === 'bot' && c.live === false
    ? `<button type="button" class="btn primary" data-start="1"${u.starting || u.wait ? ' disabled' : ''} title="Start it: its running conversation, else its last one, else a new one in its folder">${icon('shell', 14)}<span>${u.starting || u.wait ? 'Starting...' : 'Start'}</span></button>` : null;
  if (!s) {
    setHTML(el._headT, `<div class="ch-head-n"><span class="name">${esc(c.name || 'Chief')}</span></div><div class="ch-head-m">${esc(previewOf(c))}</div>`);
    setHTML(el._headB, start || '');
    return;
  }
  setHTML(el._headT, `<div class="ch-head-n"><span class="name">${esc(c.name || s.name)}</span>${acctTag(s.account)}${badge(s)}</div>`
    + `<div class="ch-head-m">${repoChip(s)}${s.goal ? `<span class="ch-goal" title="${esc(s.goal)}">${esc(s.goal)}</span>` : ''}</div>`);
  if (start) { setHTML(el._headB, start); return; }
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

function blankHtml(state, c, noBots) {
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
  if (c && c.kind === 'bot') {
    return `<div class="ch-empty">${mascotSVG(c.key, { state: 'new', color: colorOf(c), size: 72 })}<div class="ch-empty-t">${esc(c.name)}</div>`
      + `<div class="ch-empty-s">Starting: its chat shows once Fleet View lists its conversation.</div></div>`;
  }
  if (noBots) {
    return `<div class="ch-empty">${mascotSVG('chats', { state: 'idle', color: C.cyan, size: 72 })}<div class="ch-empty-t">Bots</div>`
      + `<div class="ch-empty-s">${esc(BOTS_FOR)}</div>${newBotBtn()}</div>`;
  }
  return `<div class="ch-empty">${mascotSVG('chats', { state: 'idle', color: C.cyan, size: 72 })}<div class="ch-empty-t">Pick a bot</div>`
    + `<div class="ch-empty-s">The Chief, your bots and their teams are on the left.</div></div>`;
}

// a bot that is not running: its last chat to read (or, none yet, a card with its instructions and Start), and its box
function introHtml(c, b, u) {
  const busy = u.starting || !!u.wait;
  const defs = b ? [b.model ? modelLabel(b.model) : '', b.effort || '', b.account ? `account ${b.account}` : ''].filter(Boolean).join(' · ') : '';
  return `<div class="ch-empty ch-start">${mascotSVG(c.key, { state: 'new', color: colorOf(c), size: 72 })}<div class="ch-empty-t">${esc(c.name)}</div>`
    + (b && b.brief ? `<div class="ch-brief">${esc(b.brief)}</div>` : '<div class="ch-empty-s">No instructions yet: right-click it, Edit instructions.</div>')
    + (defs ? `<div class="ch-defaults" title="What it starts with">${esc(defs)}</div>` : '')
    + `<button type="button" class="btn primary ch-start-btn" data-start="1"${busy ? ' disabled' : ''}>${busy ? 'Starting...' : `Start ${esc(c.name)}`}</button></div>`;
}
function drawBot(el, state, c, s, visible) {
  const u = bu(c.botId);
  const busy = u.starting || !!u.wait;
  el._bchat.hidden = !s;
  el._bintro.hidden = !!s;
  if (s) renderChatPane(el._bchat, s, { readOnly: true, visible });
  else setHTML(el._bintro, introHtml(c, botOf(state, c.botId), u));
  if (el._bta._for !== c.botId || u.restore) { el._bta.value = u.draft || ''; el._bta._for = c.botId; u.restore = false; el._growB(); }
  el._bta.disabled = busy;
  el._bsend.disabled = busy;
  el._bta.placeholder = busy ? `Starting ${c.name}...` : `Message ${c.name}: it starts, then gets it`;
  const msg = u.err || u.note || (u.wait ? 'Starting it: your message goes in once it is up.' : '');
  el._bnote.textContent = msg;
  el._bnote.classList.toggle('bad', !!u.err);
  el._bnote.hidden = !msg;
}

// ---------- render ----------
// state.bots and the bots made here that /state does not list yet (?fixture=1: every one made here)
function withMade(state) {
  const now = Date.now();
  const listed = new Set((state.bots || []).map((b) => b && b.id));
  const extra = [];
  for (const [id, m] of made) {
    if (listed.has(id) || (!FIXTURE && now - m.at > MADE_MS)) { if (!FIXTURE) made.delete(id); continue; }
    extra.push(m.bot);
  }
  return extra.length ? { ...state, bots: [...extra, ...(state.bots || [])] } : state;
}

export function renderChats(el, view, ui) {
  if (!el._built) build(el, ui);
  const state = withMade(view);
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
  try { pumpBots(state); } catch (e) { console.error('chats: bots', e); }
  // an overseer's conversation picked from outside (?select=, the mini window) carries over to its row
  if (ui.selectedId && ui.selectedId !== syncedSel) {
    syncedSel = ui.selectedId;
    const c = contacts.find((x) => x.id === ui.selectedId || (x.ids || []).includes(ui.selectedId));
    if (c && c.key !== selKey) { selKey = c.key; store.set(SEL_KEY, selKey); markSeen(c); }
  }
  const noBots = !contacts.some((x) => x.kind === 'bot');
  const shown = contacts.filter((c) => matches(c, query));
  el._shown = shown;
  setHTML(el._accts, acctDots(state, contacts));
  setHTML(el._list, listHtml(state, shown, now, noBots));

  const c = contacts.find((x) => x.key === selKey) || null;
  // the open chat stays read: new activity in it is not "unread"
  if (c && !form && (!el.classList.contains('ch-narrow') || open)) markSeen(c);
  el._cur = form ? null : c;
  const narrow = el.classList.contains('ch-narrow');
  el.classList.toggle('ch-open', narrow && open && (!!c || !!form));
  if (!c && !form) open = false;

  // + New bot: its form in place of the chat
  el._form.hidden = !form;
  if (form) {
    for (const x of [el._head, el._chat, el._chief, el._team, el._bot, el._blank]) x.hidden = true;
    chief.briefOn = false;
    drawForm(el, state);
    return;
  }
  let s = c && c.kind !== 'team' ? findSession(state, c.id) : null;
  if (c && c.kind !== 'team' && !s && selLast && selLast.id === c.id) s = selLast;
  if (s) selLast = s;
  const team = c && c.kind === 'team';
  // a bot that is not running: Start, its last chat read only, and a box that starts it
  const off = !!(c && c.kind === 'bot' && c.live === false);
  el._head.hidden = !c;
  el._chat.hidden = !s || off;
  el._bot.hidden = !off;
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
  el._blank.hidden = !!(s || team || off);
  if (off) { drawHead(el, state, c, s); drawBot(el, state, c, s, !narrow || open); return; }
  if (!s && !team) { setHTML(el._blank, blankHtml(state, c, noBots)); if (c) drawHead(el, state, c, null); return; }
  drawHead(el, state, c, s);
  if (team) { drawTeam(el, state, c); return; }
  renderChatPane(el._chat, s, { visible: !narrow || open });
}
