// Bots view (the tab users see as Bots; its id, file, storage keys and ?solo=chats keep the old name "chats"):
// Fleet View as a phone messenger for the overseers only: Henry's bots (bots.js), never a conversation of the map's.
// On the left, one row per contact (chats-model.js): every bot (one row however many conversations it went through)
// and every team of overseers as a group chat, each with its blob mascot (mascot.js), name, time and a one-line
// preview; on the right, the picked one's chat (all its conversations as one chat, the oldest first: historyOf,
// chat.js opts.history): a running bot's is the same chat pane
// and chat box as the Projects view (chat.js), in its messenger look (opts.bubbles: the replies in bubbles on the
// left, Fleet View's setup notes as small grey lines), a team's is its thread as bubbles with
// a box that sends to every member the way the team menu's "Message the team" does (ui.messageTeam in app.js).
//
// "+" opens a small menu: New bot and New team (Henry, 2026-10-13: "it should be within the same bots menu"), each a
// form in the chat side. New team: a name (else "Bots · <the order's first words>"), the members ticked from the
// bots (one with no conversation yet, or that this window can't reach, is greyed with the reason; at
// most ui.teamMax), Lead (one of them, or No lead: peers), Team above (only with a lead: an overseers' team its lead
// reports in, teams nest) and the order. Make team goes the way the team menus' orders go (ui.makeTeam in app.js:
// POST /teams, then /teams/add for the team above), and the new team's group chat is picked; the server's reason
// shows in the form when it refuses (the form's rules are team-form.js's, which the phone's New team shares). A bot's right-click has the conversation menu's Team ▸ too (ui.teamItems), whose
// Start team ▸ lists the other overseers, since every bot works in a folder of its own.
// Bots: "New bot" opens the New bot form in the chat side (name, what it does, account, model, effort, its shape and colour;
// account B and a Dynamic model and effort by default (the account may be Dynamic too: the one with the most usage left), the shape and colour picked for it unless you pick), which POSTs
// /bots: the server makes its folder ~/Bots/<slug> with its CLAUDE.md and starts it, and the new row is picked.
// Account, model, effort, shape and colour are styled pickers (picker.js, in the chat box's model-menu look), not
// browser dropdowns; their choices come from chats-model.js botChoices. Model and effort may each be Dynamic (a new
// bot's are): every message you send it is sized from its words and the session switched first when it needs to
// (compose.js, which asks this view which conversations are a dynamic bot's: setDynamicBots). A bot's Edit bot panel
// is the same form filled in (from the settings button in its chat header, its card's Edit bot button or its
// right-click menu): Save POSTs /bots/:id with only what changed
// (chats-model.js botEdits) and goes back to its chat. A bot that is not running (state.bots live false) shows Start in
// its header, its last chat read only (or, never started, a card with its instructions and a Start button) and a box of
// its own: what you type there starts it (POST /bots/:id/start: its running conversation, else its last one resumed,
// else a new one), and goes in once its session is up (handto.js hands it to that conversation's chat box, which sends
// it). Right-click a bot: Start, Profile... (the Edit bot form: its name, role, instructions, look and what it runs on;
// Henry, 2026-10-13: "remove shape color rename from right click options all of that in their profile only"), Put in
// team ▸ (or, under a team: Take out of team, Make lead, Move to team ▸), Team ▸, Remove bot (asks first; POST
// /bots/:id/remove). With no bot yet, the list says what bots are for, with a New bot button.
// A bot's role (Edit bot's Role: "Reviewer", at most 60 characters) shows under its name in its chat's header and on
// its row under a team; its CLAUDE.md and its team briefs say it (bots.js).
// Its profile (Edit bot) shows its tasks under the instructions, read only (Henry, 2026-10-13: "if i go into their
// profile i can see what their tasks are"): the open and paused ones, next run soonest first, then how many are done
// (a click shows them). They follow /state while the form is open, without touching what is typed in its fields.
//
// Teams are groups in the list (Henry, 2026-10-13: "if i make a team i can see them in the team ... expand take them
// out put them in etc dynamically"): a team's row has a chevron that folds it; open, its members show under it, one
// step in (★ on the lead, each with its role), and a bot in a team is there only, never also a row of its own. A team
// whose lead reports in a team above shows inside that one, in its lead's place (chats-model.js contactTree). Folded,
// its row says how many are in it, and a member that needs you or has something new shows on the team's row. Folded
// or open is kept in this window's storage (fv.chats.folded: the folded ones; open by default). Drag a bot onto a
// team's row or its group to put it in (the group lights up; POST /teams/add: one in another team
// leaves that one), out of its group into the list to take it out (POST /teams/leave), or from one group to another
// to move it; between rows it is the order, as before. Each goes the way the team menus' do (ui.teamAdd,
// ui.teamLeave, ui.teamLead in app.js, with their toasts), and asks first when it would end a team (left with one).
//
// The list's order is Henry's (Henry, 2026-10-12: "dont move them up and down when one sends a message"):
// settings.chatOrder (chats-model.js sortContacts), the pinned rows on top, then the rest; activity shows in the row,
// never its place. Drag a row (mouse or pen) to move it: a line shows where it goes, among the pinned rows it is
// pinned, among the rest not (Esc cancels); every row's right-click menu has Pin / Unpin. Each change POSTs /settings
// { chatOrder } and shows at once (held until /state has it); a row the order lacks (a new bot or team) goes on top of
// the rest and is added (chatOrderAdd), so it stays there.
//
// The avatars are alive (mascot.js): a bot wears its own shape and colour when it has one (state.bots; a bot can
// change its own with fv look; kept with the bot, so a new conversation wears it too), its face follows what it does
// (thinking about a fresh message, working, needs you, ...), it hops when you send it a message (the chat box's 'fv-chat-sent', or the box of one not
// running), and hovering its avatar in the list or the chat's header says what it is doing now (chats-model.js doingOf).
// They move whenever this tab shows (mascot.css; a hidden tab draws nothing, so they cost nothing elsewhere), and while
// a bot works on its reply a small copy of its face bobs at the bottom right of its chat with typing dots (drawTyping).
//
// Tasks and routines: above a bot's chat (running or not) a Tasks strip lists its tasks.json (state.bots[].tasks:
// bots.js, bot-tasks.js), which the bot keeps itself as you give it work: one-offs and recurring ones with their
// schedule ("Daily 9:00", "Once Oct 12 15:00"), next run, last run and its result, status. Folded, it says how many
// are open and which runs next; open, each row has Run now (POST /bots/:id/tasks/:taskId { action: 'run' }: sent to
// the bot now, started first if it is not running) and Pause / Resume, and a ⋯ button (or a right-click) with Delete
// too (asks first). Fleet View delivers each one that comes due to its bot by itself (bots.js schedule). Folded or
// open is kept in this window's storage (fv.chats.tasks); the list follows /state, so it updates as the file changes.
//
// Built once and patched on each render; the list is patched in place only where what it shows changed (morphHTML),
// so its faces keep moving. The pick
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
// With ?fixture=1 nothing is posted: a bot made with the form is kept in the page, and Start, Edit bot and Remove bot
// only record their POSTs (a team's member in or out too: app.js's post records them).
import { C, esc, setHTML, badge, acctColor, isAcct, repoChip } from './cards.js';
import { icon } from './icons.js';
import { renderChatPane } from './chat.js';
import { onRekey, hosts, termApi } from './term.js';
import { openCtxMenu } from './ctxmenu.js';
import { mascotSVG, mascotState, mascotAck, SHAPES } from './mascot.js';
import { MODEL_IDS, EFFORTS, modelLabel, setDynamicBots } from './compose.js';
import { handToChat } from './handto.js';
import { buildContacts, sortContacts, teamThread, unread, asksYou, ownColorOf, doingOf, botChoices, botEdits, DYNAMIC, taskSchedule, taskLine, tasksHead, profileTasks, setupNote,
  fullChatOrder, moveInChatOrder, pinInChatOrder, sameChatOrder, contactTree, teamFlags, ROLE_MAX } from './chats-model.js';
import { mountPicker } from './picker.js';
// New team's rules (who can be ticked, the lead and team above choices, the small lines), shared with the phone app,
// and the list's team groups' (a member in or out)
import { TEAM_MAX, newTeamWhy, teamChoices as teamChoicesOf, memberRow, settleTeam, leadChoices, aboveChoices, countNote, orderHint, joinPlan, leavePlan } from './team-form.js';

export const SOLO = new URLSearchParams(location.search).get('solo') === 'chats';
const NARROW = 640; // px: under this the view shows the list or the chat, not both
const SEL_KEY = SOLO ? 'fv.chats.solo.sel' : 'fv.chats.sel';
const SEEN_KEY = 'fv.chats.seen';
const TOP_KEY = 'fv.chats.onTop';
const TASKS_KEY = SOLO ? 'fv.chats.solo.tasks' : 'fv.chats.tasks';
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const desk = () => window.fleetDesktop || null;
const HEX = /^#[0-9a-f]{3,8}$/i;

let selKey = store.get(SEL_KEY, null);
let seen = (() => { const s = store.get(SEEN_KEY, {}); return s && typeof s === 'object' && !Array.isArray(s) ? s : {}; })();
let query = '';
let open = false; // narrow layout: the chat is over the list
let popped = false; // Bots is in its own window (main window only)
let onTop = !!store.get(TOP_KEY, false);
let tasksOpen = !!store.get(TASKS_KEY, false); // the Tasks strip is open (else folded to its one line)
// the teams folded in the list (their keys); every other one is open
const FOLD_KEY = 'fv.chats.folded';
const folded = new Set((() => { const v = store.get(FOLD_KEY, []); return Array.isArray(v) ? v.filter((k) => typeof k === 'string') : []; })());
function setFold(key, shut, ui) {
  if (shut === folded.has(key)) return;
  if (shut) folded.add(key); else folded.delete(key);
  store.set(FOLD_KEY, [...folded].slice(-200));
  ui.refresh();
}
let syncedSel = null; // the last ui.selectedId this view followed
let selLast = null; // the last copy of the picked bot's conversation, kept if it leaves the lists
let pane = null;

const FIXTURE = new URLSearchParams(location.search).has('fixture');
const BOT_WAIT = 90000; // a start with a message: how long the message waits for the bot's session to be up
const MADE_MS = 15000; // a bot just made shows from POST /bots's answer until /state lists it, at most this long
const DEF = { account: 'B', model: DYNAMIC, effort: DYNAMIC }; // a new bot's (bots.js NEW_BOT): sized for each message
// Dynamic (compose.js): which conversations are a bot's and which of its model and effort are dynamic, from the bots
// the last render saw (a fixed bot's too: its model menu offers Dynamic)
let dynBots = [];
setDynamicBots((s) => {
  if (!s || !s.id) return null;
  const b = dynBots.find((x) => x && !x.removed && ((s.bot && x.id === s.bot) || x.convId === s.id));
  return b ? { botId: b.id, name: b.name || '', model: b.model === DYNAMIC, effort: b.effort === DYNAMIC } : null;
});
// bot id -> what this page is doing with it: { starting (its POST), wait ({ text, id, at }: a message waiting for it to
// be up), err, note, draft (its box), restore (the draft goes back in the box) }
const botUi = new Map();
const bu = (id) => { let u = botUi.get(id); if (!u) botUi.set(id, (u = { starting: false, wait: null, err: '', note: '', draft: '', restore: false })); return u; };
// the New bot form, a bot's Edit bot panel or the New team form while it shows: { mode: 'new' | 'edit' | 'team',
// botId (edit), busy, err, fresh, v: { account, model, effort, shape, color } as picked (team: { members: [ids],
// lead, above }), pk: the pickers, doneOpen (edit: its done tasks shown) }
let form = null;
const made = new Map(); // bot id -> { bot, at }: made here, until /state lists it (?fixture=1: for good)
// a bot of this machine's; another machine's (elsewhere: bots.js) has no Start, Edit, menu or Tasks here
const botOf = (state, id) => (state.bots || []).find((b) => b && b.id === id && !b.elsewhere) || null;
// a bot's conversations before the one its chat shows, oldest first (chat.js opts.history: they show as
// one chat): the bot's own list (state.bots ids, another machine's bot's too) and the ones /state tags with it
function historyOf(state, c) {
  if (!c || !c.id) return [];
  const b = c.botId ? (state.bots || []).find((x) => x && x.id === c.botId) : null;
  const all = [...new Set([...(b && Array.isArray(b.ids) ? b.ids : []), ...(c.ids || [])])];
  const at = all.indexOf(c.id);
  return at >= 0 ? all.slice(0, at) : all;
}
const elsewhereBot = (state, id) => (state.bots || []).some((b) => b && b.id === id && b.elsewhere);
// a bot's look as just picked here (bot id -> { shape?, color?, at }), worn until /state agrees or LOOK_MS passes
const looks = new Map();
const LOOK_MS = 15000;
// colours to pick from (the form): steady, readable on the dark page; none picked: its account's colour
const PALETTE = [['#58a6ff', 'Blue'], ['#3fd8ff', 'Cyan'], ['#4eba65', 'Green'], ['#7ee0a1', 'Mint'], ['#ffc857', 'Gold'],
  ['#ff9f5a', 'Orange'], ['#ff6b80', 'Coral'], ['#f78fd0', 'Pink'], ['#af87ff', 'Violet'], ['#c9d1d9', 'Silver']];
const SHAPE_NAMES = { hex: 'Hexagon', drop: 'Drop', round: 'Round', pill: 'Pill', tri: 'Triangle', square: 'Square', star: 'Star', clover: 'Clover', flower: 'Flower', heart: 'Heart' };
const COLOR6 = /^#[0-9a-f]{6}$/i;
// a contact with the look just picked here laid over it
function lookOf(c) {
  const l = c && c.botId ? looks.get(c.botId) : null;
  if (!l) return c;
  const agrees = (!('shape' in l) || l.shape === c.shape) && (!('color' in l) || l.color === c.color);
  if (Date.now() - l.at > LOOK_MS || agrees) { looks.delete(c.botId); return c; }
  return { ...c, ...('shape' in l ? { shape: l.shape } : {}), ...('color' in l ? { color: l.color } : {}) };
}

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
// a conversation's own colour, picked with Colour on its right-click (app.js settings.sessHues): id -> CSS colour or null
let pickedColor = () => null;
export function setPickedColors(fn) { pickedColor = typeof fn === 'function' ? fn : () => null; }
const colorOf = (c) => {
  const own = ownColorOf(c); // a bot's look (state.bots)
  if (own) return own;
  const r = c && c.repo && c.repo.color;
  if (HEX.test(String(r || ''))) return r;
  if (c && c.kind === 'team' && HEX.test(String(c.statusColor || ''))) return c.statusColor;
  return c && isAcct(c.account) ? acctColor(c.account) : C.cyan;
};
const sessionsOf = (state) => (state.allSessions || []).concat(state.finishedSessions || [], state.pending || []);
const findSession = (state, id) => (id ? sessionsOf(state).find((x) => x.id === id) || null : null);
const inState = (state, id) => !!id && (state.allSessions || []).some((x) => x.id === id);
// a member's mascot: its own state and colour (the one picked for it, else from the conversation when it is listed)
function memberMascot(state, m, size) {
  const s = findSession(state, m.id);
  const col = pickedColor(m.id) || (s && s.repo && HEX.test(String(s.repo.color || '')) ? s.repo.color : s && isAcct(s.account) ? acctColor(s.account) : C.violet);
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
const faceOf = (c) => mascotState(c);
const avatar = (state, c, size = 40) => (c.kind === 'team' ? cluster(state, c, size)
  : mascotSVG(c.key, { state: faceOf(c), color: colorOf(c), size, shape: c.shape || undefined }));
// the hover on a bot's avatar: what it is doing now
const doingTip = (c) => {
  if (!c || c.kind === 'team') return '';
  const u = c.botId ? botUi.get(c.botId) : null;
  if (u && (u.starting || u.wait)) return 'Starting...';
  return doingOf(c, faceOf(c));
};
// the "got it" hop, on its avatar in the header and in the list; a bot's mascot on the Map hops too (map-bots.js
// listens for fv-bot-ack), so it answers wherever it is drawn
function ackBot(el, key) {
  if (!el) return;
  if (typeof window !== 'undefined' && typeof key === 'string' && key.startsWith('bot:')) window.dispatchEvent(new CustomEvent('fv-bot-ack', { detail: { key } }));
  if (el._cur && el._cur.key === key) mascotAck(el._headAv);
  const row = [...el._list.querySelectorAll('.ch-row')].find((r) => r.dataset.key === key);
  if (row) mascotAck(row.querySelector('.ch-av'));
}
const previewOf = (c) => {
  const p = typeof c.preview === 'string' ? c.preview : '';
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

// node: its place in the list (chats-model.js contactTree): depth, the team it shows under, a team's open and rows
function rowHtml(state, c, now, node) {
  const on = c.key === selKey;
  const team = c.kind === 'team';
  const depth = (node && node.depth) || 0;
  const shut = team && node && node.open === false;
  // a folded team shows what its members have: gold when one needs you, the dot when one has something new
  const fl = shut ? teamFlags(node, seen) : { asks: false, unread: false };
  const un = !on && (unread(c, seen) || fl.unread);
  const ask = !on && (asksYou(c, seen) || fl.asks); // opening it clears the gold, as it does the unread dot
  // a pin only at the top: a row under a team goes where its team goes
  const pinned = c.pinned && !depth;
  const pin = pinned ? `<span class="ch-pin" title="pinned">${icon('pin', 11)}</span>` : '';
  // under a team: ★ on its lead, and its role
  const par = depth && node.parent ? (pane?._contacts || []).find((x) => x.key === node.parent) : null;
  const mem = par && !team ? (par.members || []).find((m) => m.key === c.key) : null;
  const role = !team && c.role ? `<span class="ch-role" title="${esc(`${c.name}'s role`)}">${esc(c.role)}</span>` : '';
  const n = team ? (c.members || []).length : 0;
  const tree = !!(node && 'open' in node); // a search lists the matches flat: nothing to fold
  const fold = team && tree ? `<span class="ch-fold" data-fold="1" role="button" aria-expanded="${!shut}" aria-label="${shut ? 'Show' : 'Hide'} its members" title="${shut ? 'Show its members' : 'Fold it'}">${icon('chevron', 13)}</span>` : '';
  return `<button type="button" class="ch-row${on ? ' on' : ''}${ask ? ' needs' : ''}${un ? ' unread' : ''}${!team && !c.id ? ' ghost' : ''}${depth ? ' nest' : ''}${team ? ' grp' : ''}${shut ? ' shut' : ''}" role="option" aria-selected="${on}"`
    + ` data-key="${esc(c.key)}"${pinned ? ' data-pin="1"' : ''}${c.id ? ` data-id="${esc(c.id)}"` : ''}${c.teamId ? ` data-team="${esc(c.teamId)}"` : ''}${c.botId ? ` data-bot="${esc(c.botId)}"` : ''}`
    + ` data-depth="${depth}"${node && node.parent ? ` data-parent="${esc(node.parent)}" data-path="${esc(node.path.join(' '))}"` : ''}${mem ? ` data-member="${esc(mem.memberId)}"` : ''}`
    + ` style="--rc:${esc(colorOf(c))};--dep:${depth}" title="${esc(c.name || '')}${mem && mem.lead ? ` leads ${par.name}` : ''}${team ? ` · ${n} member${n === 1 ? '' : 's'}` : ''}">`
    + fold
    + `<span class="ch-av"${team ? '' : ` title="${esc(doingTip(c))}"`}>${avatar(state, c, depth ? 32 : 40)}</span>`
    + `<span class="ch-body"><span class="ch-l1"><span class="ch-name">${mem && mem.lead ? '<span class="ch-star" aria-label="lead">★</span>' : ''}${esc(c.name || 'bot')}</span>${depth ? role : ''}`
    + `<span class="ch-time">${pin}${esc(when(c.at, now))}</span></span>`
    + `<span class="ch-l2">${shut ? `<span class="ch-cnt">${n} member${n === 1 ? '' : 's'}</span>` : ''}<span class="ch-prev">${esc(previewOf(c))}</span>${ask ? '<span class="ch-flag" title="needs you">!</span>' : un ? '<span class="ch-dot" aria-label="unread"></span>' : ''}</span>`
    + `</span></button>`;
}

// with no bot yet: what bots are for, and the New bot button
const BOTS_FOR = 'Bots are overseers you give standing tasks, away from the map.';
const newBotBtn = () => `<button type="button" class="btn primary ch-newbot" data-newbot="1">${icon('plus', 14)}<span>New bot</span></button>`;
// nodes: the rows as drawn (contactTree; a search: the matches, flat)
function listHtml(state, nodes, now, noBots) {
  const intro = noBots && !query ? `<div class="ch-none ch-intro"><div>${esc(BOTS_FOR)}</div>${newBotBtn()}</div>` : '';
  if (!nodes.length) return query ? `<div class="ch-none">No bots match “${esc(query)}”.</div>` : intro || '<div class="ch-none">No bots yet. Make one with +.</div>';
  // a hairline under the pinned rows, when the rest follow (rows under a team go with it)
  let lastTop = null;
  return nodes.map((x) => {
    const sep = !x.depth && lastTop && lastTop.pinned && !x.c.pinned ? '<div class="ch-pinsep" aria-hidden="true"></div>' : '';
    if (!x.depth) lastTop = x.c;
    return sep + rowHtml(state, x.c, now, x);
  }).join('') + intro;
}
// The list drawn again in place: only what changed is touched, so a face whose drawing is the same keeps its motion.
// Rewriting the list's HTML whenever any row changed (a working bot's step, a preview, the time) started every face's
// animation over from its first frame, about once a second while a bot worked, which held them all still (Henry,
// 2026-10-13: "their faces should be moving once im in the bots section"). Rows are matched by data-key, anything
// else by its place and tag; a face drawn differently (another state) is put in anew.
const SVG_NS = 'http://www.w3.org/2000/svg';
function morphHTML(el, html) {
  if (el._html === html) return;
  el._html = html;
  const t = document.createElement('template');
  t.innerHTML = html;
  morphKids(el, t.content);
}
function morphKids(to, from) {
  const keyed = new Map();
  for (const n of to.children) if (n.hasAttribute('data-key')) keyed.set(n.getAttribute('data-key'), n);
  let cur = to.firstChild;
  for (const w of [...from.childNodes]) {
    const k = w.nodeType === 1 ? w.getAttribute('data-key') : null;
    let o = k != null ? keyed.get(k) : cur && cur.nodeType === w.nodeType && !(cur.nodeType === 1 && cur.hasAttribute('data-key')) ? cur : null;
    if (k != null) keyed.delete(k);
    if (o && o.nodeName !== w.nodeName) o = null;
    if (!o) { to.insertBefore(w, cur); continue; }
    if (o === cur) cur = cur.nextSibling;
    else to.insertBefore(o, cur); // moved (its face starts over, as a new row's does)
    morphNode(o, w);
  }
  while (cur) { const nx = cur.nextSibling; cur.remove(); cur = nx; }
}
function morphNode(o, w) {
  if (o.nodeType !== 1) { if (o.nodeValue !== w.nodeValue) o.nodeValue = w.nodeValue; return; }
  if (o.isEqualNode(w)) return;
  if (o.namespaceURI === SVG_NS) { o.replaceWith(w); return; }
  for (const a of [...o.attributes]) if (!w.hasAttribute(a.name)) o.removeAttribute(a.name);
  for (const a of w.attributes) if (o.getAttribute(a.name) !== a.value) o.setAttribute(a.name, a.value);
  morphKids(o, w);
}

// ---------- the order: drag, Pin / Unpin ----------
const HELD_MS = 8000; // a change made here shows until /state has it, at most this long
const NO_ORDER = { pinned: [], keys: [] };
let held = null; // { order, at }: the order as just changed here (?fixture=1: kept)
// the order the list shows: the one just changed here, else /state's; null from a server that keeps none (the old sort)
function orderNow(state) {
  const srv = state && state.settings ? state.settings.chatOrder : undefined;
  if (held && !FIXTURE && (Date.now() - held.at > HELD_MS || sameChatOrder(srv, held.order))) held = null;
  return held ? held.order : srv || (FIXTURE ? NO_ORDER : null);
}
async function saveOrder(ui, next) {
  if (!next) return;
  held = { order: next, at: Date.now() };
  ui.refresh();
  const r = await postJson('/settings', { chatOrder: next });
  if (!r.ok && !FIXTURE) { held = null; console.warn('chats: the order was not saved', r.status); ui.refresh(); }
}
// rows the saved order lacks (a new bot or team, or every row the first time): added where they show, so they stay
let addSent = '', addAt = 0;
function addNew(state, contacts) {
  const srv = state.settings && state.settings.chatOrder;
  if (FIXTURE || held || drag || !srv || !contacts.length) return;
  const full = fullChatOrder(srv, contacts), have = new Set([...(srv.pinned || []), ...(srv.keys || [])]);
  const add = { pinned: full.pinned.filter((k) => !have.has(k)), keys: full.keys.filter((k) => !have.has(k)) };
  if (!add.pinned.length && !add.keys.length) return;
  const sig = JSON.stringify(add);
  if (sig === addSent && Date.now() - addAt < 10e3) return;
  addSent = sig;
  addAt = Date.now();
  postJson('/settings', { chatOrderAdd: add });
}
const pinItem = (ui, c) => ({ label: c.pinned ? 'Unpin' : 'Pin', icon: 'pin', note: c.pinned ? 'back with the rest' : 'on top of the list',
  run: () => saveOrder(ui, pinInChatOrder(orderNow(pane?._state || {}), pane?._contacts || [], c.key, !c.pinned)) });

// dragging a row (mouse or pen; a touch scrolls): it starts once the pointer goes DRAG_PX, the list holds still
// meanwhile (renderChats leaves it alone). Between the rows at the top a line shows where it goes; dropped in the
// pinned rows it is pinned, in the rest it is not. A bot held over a team's row (its middle) or any row
// of its group lights that group up: dropped there it goes in that team; one under a team dropped between the rows at
// the top comes out of it, and stays where it was dropped. Esc cancels. The click that ends a drag picks nothing
const DRAG_PX = 5;
let drag = null; // { key, id (pointer), y0, x, y, on, slot: { pin, before, y } | null, into: team key | null }
let dragEnded = 0;
// the team rows' contacts, and whether a row is in a team's group already (as a member, or as the lead of a team in it)
const teamRowOf = (el, key) => (el._contacts || []).find((x) => x.kind === 'team' && x.key === key) || null;
const inGroup = (t, c) => !!t && (t.members || []).some((m) => m.key === c.key || (c.kind === 'team' && (c.members || []).some((x) => x.lead && x.key === m.key)));
function dragOver(el, y) {
  const list = el._list, rows = [...list.querySelectorAll('.ch-row')];
  if (!drag || !rows.length) return;
  const box = list.getBoundingClientRect();
  if (y < box.top + 28) list.scrollTop -= 12;
  else if (y > box.bottom - 28) list.scrollTop += 12;
  const d = (el._contacts || []).find((x) => x.key === drag.key);
  const nested = !!(d && d.parentTeam && teamRowOf(el, d.parentTeam));
  // a team goes in no team from here (its lead does: Lead team ▸ in its menu)
  const canIn = !!(d && d.kind !== 'team' && d.id && typeof curUi().teamAdd === 'function');
  const over = rows.find((r) => { const b = r.getBoundingClientRect(); return y >= b.top && y < b.bottom; });
  const dep = over ? Number(over.dataset.depth) || 0 : 0;
  let into = null, stay = false;
  if (over && (dep > 0 || over.dataset.team)) {
    const b = over.getBoundingClientRect(), mid = y > b.top + b.height * 0.25 && y < b.bottom - b.height * 0.25;
    // the innermost group under the pointer: a team's own row (its middle, or any part of it inside a group), else
    // the group the row is in
    const g = over.dataset.team && (dep > 0 || mid) ? over.dataset.key : dep > 0 ? over.dataset.parent : null;
    if (g && (canIn || nested)) {
      // over its own group: it stays (the order in a team is the team's); else it goes in
      if (inGroup(teamRowOf(el, g), d) || g === d.key || (over.dataset.path || '').split(' ').includes(d.key)) stay = true;
      else if (canIn) into = g;
      else stay = true;
    }
  }
  if (nested && dep === 0 && !into && !stay && d.kind === 'team') stay = true; // a team under a team comes out through its lead's menu
  drag.into = into;
  for (const r of list.querySelectorAll('.ch-row.ch-into')) r.classList.remove('ch-into');
  if (into) for (const r of rows) if (r.dataset.key === into || (r.dataset.path || '').split(' ').includes(into)) r.classList.add('ch-into');
  if (into || stay) { drag.slot = null; if (el._drop) { el._drop.remove(); el._drop = null; } return; }
  // the rows at the top: the first whose middle is below the pointer, in front of it, unless the pointer is still over
  // the last pinned row's lower half or the line under it (then: the end of the pinned rows)
  const tops = rows.filter((r) => !Number(r.dataset.depth));
  const i = tops.findIndex((r) => { const b = r.getBoundingClientRect(); return y < b.top + b.height / 2; });
  const prev = i < 0 ? tops[tops.length - 1] : tops[i - 1] || null, next = i < 0 ? null : tops[i];
  const edge = next && prev && !!prev.dataset.pin && !next.dataset.pin && y < next.getBoundingClientRect().top;
  // after a row: under its group's last row
  const after = (r) => { let e = r; for (let k = rows.indexOf(r) + 1; k < rows.length && Number(rows[k].dataset.depth); k++) e = rows[k]; return e.offsetTop + e.offsetHeight + 1; };
  let slot;
  if (next && !edge) slot = { pin: !!next.dataset.pin, before: next.dataset.key, y: next.offsetTop - 1 };
  else slot = { pin: !!prev.dataset.pin, before: null, y: after(prev) };
  drag.slot = slot;
  if (!el._drop || !el._drop.isConnected) { el._drop = document.createElement('div'); el._drop.className = 'ch-drop'; list.appendChild(el._drop); }
  el._drop.classList.toggle('pin', slot.pin);
  el._drop.classList.toggle('out', nested); // out of its team
  el._drop.style.top = `${slot.y}px`;
}
function dragKey(e) {
  if (e.key !== 'Escape' || !drag) return;
  e.preventDefault();
  e.stopPropagation();
  if (pane) endDrag(pane, pane._ui, false);
}
function endDrag(el, ui, drop) {
  const d = drag;
  drag = null;
  document.removeEventListener('keydown', dragKey, true);
  if (!d || !d.on) return;
  dragEnded = Date.now();
  el._list.classList.remove('ch-dragging');
  el._list.querySelector('.ch-row.ch-drag')?.classList.remove('ch-drag');
  for (const r of el._list.querySelectorAll('.ch-row.ch-into')) r.classList.remove('ch-into');
  if (el._drop) { el._drop.remove(); el._drop = null; }
  const c = (el._contacts || []).find((x) => x.key === d.key);
  if (drop && c && d.into) { const g = teamRowOf(el, d.into); if (g) putIn(el, ui, c, g, d.x, d.y); ui.refresh(); return; }
  if (drop && d.slot) {
    const cur = orderNow(el._state || {});
    const next = moveInChatOrder(cur, el._contacts || [], d.key, { pin: d.slot.pin, before: d.slot.before });
    const par = c && c.kind !== 'team' && c.parentTeam ? teamRowOf(el, c.parentTeam) : null;
    // out of its team: it shows where it was dropped once it is out
    if (par) { takeOut(el, ui, c, par, d.x, d.y, () => { if (!sameChatOrder(next, fullChatOrder(cur, el._contacts || []))) saveOrder(ui, next); }); ui.refresh(); return; }
    if (!sameChatOrder(next, fullChatOrder(cur, el._contacts || []))) { saveOrder(ui, next); return; }
  }
  ui.refresh();
}

// ---------- the teams' groups: a member in, out, made the lead ----------
// the conversation a team knows a row by (the one it lists; a bot's current one when it is in none)
function teamIdOf(state, c) {
  if (!c) return null;
  const ids = [c.id, ...[...(c.ids || [])].reverse()].filter(Boolean);
  for (const t of state.teams || []) { const m = (t.members || []).find((x) => ids.includes(x)); if (m) return m; }
  return c.id || null;
}
const nameIn = (el) => (id) => ((el._contacts || []).find((x) => x.kind !== 'team' && (x.id === id || (x.ids || []).includes(id))) || {}).name || String(id || '').slice(0, 8);
// what putting c in team row g does (team-form.js joinPlan), in a few words
function joinNote(p) {
  return p.why || [p.leaves ? `it leaves "${p.leaves.name}"` : '', p.ends ? `"${p.ends.name}" ends: one is left` : '', p.nests ? `"${p.nests.name}" goes under it` : ''].filter(Boolean).join(' · ');
}
// c in team row g (a drop on its group, Move to team ▸, Put in team ▸): refused with a toast, asked first when it
// would end the team it leaves (x, y: where to ask), else at once
function putIn(el, ui, c, g, x, y) {
  const st = el._state || {};
  const p = joinPlan(st.teams || [], teamIdOf(st, c), g.teamId, teamMax(), nameIn(el));
  if (p.why) { ui.toast?.(`${c.name} can't go in "${g.name}": ${p.why}`, 'bad'); return; }
  const go = () => ui.teamAdd(g.teamId, c.id);
  if (!p.ends) { go(); return; }
  openCtxMenu({ x, y, title: `Move ${c.name} to "${g.name}"?`, sub: `"${p.ends.name}" is left with one member and ends`, items: [
    { label: `Move ${c.name}`, icon: 'merge', danger: true, run: go }, { label: 'Cancel', icon: 'close', run: () => {} }] });
}
// c out of team row g (a drop out of its group, Take out of team): asked first when it ends the team, else at once;
// then() once it is asked for
function takeOut(el, ui, c, g, x, y, then) {
  const st = el._state || {}, id = teamIdOf(st, c);
  const p = leavePlan(st.teams || [], id, g.teamId);
  if (p.why) { ui.toast?.(`${c.name}: ${p.why}`, 'bad'); return; }
  const go = () => { ui.teamLeave(g.teamId, id); then?.(); };
  if (!p.ends) { go(); return; }
  openCtxMenu({ x, y, title: `Take ${c.name} out of "${g.name}"?`, sub: 'It is left with one member and ends', items: [
    { label: 'Take it out', icon: 'close', danger: true, run: go }, { label: 'Cancel', icon: 'close', run: () => {} }] });
}
// a row's team items on its right-click (Henry, 2026-10-13: "take them out put them in"): under a team, Take out of
// team, Make lead and Move to team ▸; at the top, Put in team ▸ (each team of overseers)
function groupItems(el, ui, c) {
  if (!c || c.kind === 'team' || typeof ui.teamAdd !== 'function') return [];
  const st = el._state || {}, teams = st.teams || [], groups = (el._contacts || []).filter((x) => x.kind === 'team');
  const par = c.parentTeam ? teamRowOf(el, c.parentTeam) : null;
  if (!par && !groups.length) return [];
  if (!c.id) return [{ label: 'Put in team', icon: 'merge', disabled: true, note: 'start it first' }];
  const id = teamIdOf(st, c), nameOf = nameIn(el);
  const into = (g) => {
    const p = joinPlan(teams, id, g.teamId, teamMax(), nameOf);
    return { label: g.name, icon: 'merge', disabled: !!p.why, note: joinNote(p) || `${(g.members || []).length} members`,
      ...(p.ends ? { confirm: { text: `Move ${c.name} to "${g.name}"? "${p.ends.name}" is left with one member and ends.`, yes: 'Move' } } : {}),
      run: () => ui.teamAdd(g.teamId, c.id) };
  };
  // the teams it is in already are not offered
  const others = groups.filter((g) => !(g.members || []).some((m) => m.key === c.key));
  if (!par) return [{ label: 'Put in team', icon: 'merge', note: `${groups.length} team${groups.length === 1 ? '' : 's'}`, children: others.map(into) }];
  const lp = leavePlan(teams, id, par.teamId);
  const out = [{ label: 'Take out of team', icon: 'close', disabled: !!lp.why, note: lp.why || `"${par.name}"`,
    confirm: { text: lp.ends ? `Take ${c.name} out of "${par.name}"? It is left with one member and ends.`
      : lp.lead ? `Take ${c.name} out of "${par.name}"? It leads it: the others go on as peers.` : `Take ${c.name} out of "${par.name}"? It and the team are told.`, yes: 'Take out' },
    run: () => ui.teamLeave(par.teamId, id) }];
  const mem = (par.members || []).find((m) => m.key === c.key);
  if (mem && !mem.lead && typeof ui.teamLead === 'function') out.push({ label: 'Make lead', icon: 'star', note: `of "${par.name}": the others report to it`, run: () => ui.teamLead(par.teamId, id) });
  if (others.length) out.push({ label: 'Move to team', icon: 'merge', children: others.map(into) });
  return out;
}

// ---------- build ----------
function build(el, ui) {
  // the side panel's copy for one bot (renderBotPanel): no list, no pop-out, no keys of its own
  const inPanel = el.classList.contains('ch-panel');
  el.innerHTML = `${SOLO && !inPanel ? `<header class="ch-solo-top"><span class="ch-solo-m">${mascotSVG('chats', { state: 'idle', color: C.cyan, size: 20 })}</span>`
    + `<span class="ch-solo-t">Bots</span><span class="grow"></span>`
    + `<button type="button" class="ch-ib ch-ontop" aria-pressed="false" title="Keep on top">${icon('pin', 14)}</button>`
    + `<button type="button" class="ch-ib ch-dock" title="Back into the main window">${icon('open', 14)}</button></header>` : ''}`
    + `<div class="ch-popped" hidden><div class="ch-popped-in">${mascotSVG('chats', { state: 'idle', color: C.cyan, size: 56 })}`
    + `<div class="ch-popped-t">Bots is open in its own window</div><div class="ch-popped-b">`
    + `<button type="button" class="btn" data-dock="1">Bring it back</button><button type="button" class="btn primary" data-show="1">Show it</button></div></div></div>`
    + `<div class="ch"><nav class="ch-side" aria-label="bots">`
    + `<div class="ch-top"><span class="ch-title">Bots</span><span class="grow"></span>`
    + `<button type="button" class="ch-ib ch-pop" title="Open Bots in its own window" hidden>${icon('external', 15)}</button>`
    + `<button type="button" class="ch-ib ch-new" title="New bot or team" aria-label="New bot or team" aria-haspopup="menu">${icon('plus', 16)}</button></div>`
    + `<label class="ch-search">${icon('search', 14)}<input type="search" spellcheck="false" autocomplete="off" placeholder="Search bots" aria-label="Search bots"></label>`
    + `<div class="ch-list" role="listbox" aria-label="bots"></div></nav>`
    + `<section class="ch-main"><header class="ch-head" hidden><button type="button" class="ch-ib ch-back" title="Back to the bots (Esc)" aria-label="Back">${icon('chevron', 16)}</button>`
    + `<span class="ch-head-av"></span><div class="ch-head-t"></div><div class="ch-head-b"></div></header>`
    + `<div class="ch-tasks" hidden></div><div class="ch-chat" hidden></div>`
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
    _ch: q('.ch'), _side: q('.ch-side'), _list: q('.ch-list'), _pop: q('.ch-pop'), _new: q('.ch-new'),
    _search: q('.ch-search input'), _head: q('.ch-head'), _headAv: q('.ch-head-av'), _headT: q('.ch-head-t'), _headB: q('.ch-head-b'),
    _chat: q('.ch-chat'), _team: q('.ch-team'), _thread: q('.ch-thread'), _ta: q('.ch-team textarea'), _send: q('.ch-team .ch-send'),
    _tnote: q('.ch-team .ch-tnote'), _blank: q('.ch-blank'), _popped: q('.ch-popped'), _onTop: q('.ch-ontop'),
    _bot: q('.ch-bot'), _bchat: q('.ch-bot-chat'), _bintro: q('.ch-bot-intro'), _bta: q('.ch-bcomp textarea'), _bsend: q('.ch-bcomp .ch-send'),
    _bnote: q('.ch-bcomp .ch-tnote'), _form: q('.ch-form'), _tasks: q('.ch-tasks'),
  });
  el._built = true;
  el._ui = ui;
  pane = el;
  if (inPanel) {
    // always the narrow layout with its chat open, and a ✕ where the back arrow is: it closes the panel
    el.classList.add('ch-narrow');
    const x = q('.ch-back');
    x.innerHTML = icon('close', 16);
    x.title = 'Close (Esc)';
    x.setAttribute('aria-label', 'Close');
  }

  // the narrow layout follows the element's own width
  try {
    new ResizeObserver((es) => {
      const w = es[es.length - 1].contentRect.width;
      const n = inPanel || (w > 0 && w < NARROW);
      el.classList.toggle('ch-mid', w >= NARROW && w < 1000); // the chat's buttons drop their words
      if (n !== el.classList.contains('ch-narrow')) { el.classList.toggle('ch-narrow', n); ui.refresh(); }
    }).observe(el);
  } catch {}

  el._list.addEventListener('click', (e) => {
    if (Date.now() - dragEnded < 400) return; // the end of a drag
    if (e.target.closest('[data-newbot]')) { openForm(el, ui); return; }
    const r = e.target.closest('.ch-row');
    if (!r) return;
    // a team's chevron folds or opens it, and picks nothing
    if (e.target.closest('[data-fold]')) { setFold(r.dataset.key, !folded.has(r.dataset.key), ui); return; }
    pick(r.dataset.key, ui, true);
  });
  // every row's menu starts with Pin / Unpin (a row at the top: one under a team goes where its team goes), then its
  // team items (groupItems)
  el._list.addEventListener('contextmenu', (e) => {
    const r = e.target.closest('.ch-row');
    if (!r) return;
    e.preventDefault();
    const st = el._state || {};
    const c = (el._contacts || []).find((x) => x.key === r.dataset.key);
    const top = !Number(r.dataset.depth);
    const extra = c && top ? [pinItem(ui, c)] : [];
    if (r.dataset.team) { ui.contextMenu({ kind: 'team', id: r.dataset.team, extra }, e.clientX, e.clientY); return; }
    if (r.dataset.bot && botOf(st, r.dataset.bot)) { botMenu(el, ui, r.dataset.bot, e.clientX, e.clientY); return; }
    if (r.dataset.id && inState(st, r.dataset.id) && !(r.dataset.bot && elsewhereBot(st, r.dataset.bot))) { ui.contextMenu({ kind: 'session', id: r.dataset.id, extra }, e.clientX, e.clientY); return; }
    // another machine's bot (run on its own machine), a gone conversation: Pin / Unpin alone
    if (c) openCtxMenu({ x: e.clientX, y: e.clientY, title: c.name, dot: colorOf(c), items: extra });
  });
  // drag a row to move it (see dragOver)
  el._list.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.pointerType === 'touch' || e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return;
    const r = e.target.closest('.ch-row');
    if (r && r.dataset.key && !e.target.closest('[data-fold]')) drag = { key: r.dataset.key, id: e.pointerId, y0: e.clientY, x: e.clientX, y: e.clientY, on: false, slot: null, into: null };
  });
  el._list.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (!drag.on) {
      if (!(e.buttons & 1)) { drag = null; return; }
      if (Math.abs(e.clientY - drag.y0) < DRAG_PX) return;
      drag.on = true;
      try { el._list.setPointerCapture(e.pointerId); } catch {}
      el._list.classList.add('ch-dragging');
      [...el._list.querySelectorAll('.ch-row')].find((x) => x.dataset.key === drag.key)?.classList.add('ch-drag');
      document.addEventListener('keydown', dragKey, true);
    }
    e.preventDefault();
    dragOver(el, e.clientY);
  });
  el._list.addEventListener('pointerup', (e) => { if (drag && e.pointerId === drag.id) endDrag(el, ui, true); });
  el._list.addEventListener('pointercancel', (e) => { if (drag && e.pointerId === drag.id) endDrag(el, ui, false); });
  el._list.addEventListener('lostpointercapture', (e) => { if (drag && drag.on && e.pointerId === drag.id) endDrag(el, ui, false); });
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
    if (e.target.closest('.ch-back')) { if (inPanel) ui.closeBotPanel?.(); else back(ui); return; }
    if (e.target.closest('[data-start]')) { if (el._cur && el._cur.botId) startBot(ui, el._cur.botId); return; }
    if (e.target.closest('[data-edit]')) { if (el._cur && el._cur.botId) openForm(el, ui, el._cur.botId); return; }
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
  // a message sent from the chat box (compose.js): its bot hops, "got it"
  el._chat.addEventListener('fv-chat-sent', () => { if (el._cur && el._cur.kind !== 'team') ackBot(el, el._cur.key); });
  el._bintro.addEventListener('click', (e) => {
    if (!el._cur || !el._cur.botId) return;
    if (e.target.closest('[data-start]')) startBot(ui, el._cur.botId);
    else if (e.target.closest('[data-edit]')) openForm(el, ui, el._cur.botId);
  });
  el._blank.addEventListener('click', (e) => { if (e.target.closest('[data-newbot]')) openForm(el, ui); });
  // the New bot form, Edit bot and New team: Enter in the name (or Ctrl+Enter anywhere) makes or saves it, Esc or
  // Cancel closes it (a picker's open menu takes Esc first: picker.js)
  el._form.addEventListener('submit', (e) => { e.preventDefault(); submitForm(el, ui); });
  el._form.addEventListener('click', (e) => {
    if (e.target.closest('[data-cancel]')) closeForm(ui);
    // the profile's "Done (N)": its done tasks shown or folded
    else if (e.target.closest('[data-tdone]') && form) { form.doneOpen = !form.doneOpen; ui.refresh(); }
  });
  // New team: a member ticked or unticked
  el._form.addEventListener('change', (e) => { if (e.target.name === 'tm') tickMember(el, e.target.value, e.target.checked); });
  el._form.addEventListener('keydown', (e) => {
    e.stopPropagation(); // the page's one-key shortcuts stay out of the form
    if (e.key === 'Escape') { e.preventDefault(); closeForm(ui); }
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submitForm(el, ui); }
  });
  // the Tasks strip: its head folds it, a row's buttons act on that task, ⋯ or a right-click opens the task's menu
  el._tasks.addEventListener('click', (e) => {
    const c = el._cur;
    if (e.target.closest('.ch-tk-h')) { tasksOpen = !tasksOpen; store.set(TASKS_KEY, tasksOpen); ui.refresh(); return; }
    const row = e.target.closest('.ch-tk-row');
    if (!row || !c || !c.botId) return;
    const a = e.target.closest('[data-tact]');
    if (a) { taskAct(ui, c.botId, row.dataset.task, a.dataset.tact); return; }
    const m = e.target.closest('[data-tmenu]');
    if (m) { const r = m.getBoundingClientRect(); taskMenu(el, ui, c.botId, row.dataset.task, r.left, r.bottom + 4); }
  });
  el._tasks.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.ch-tk-row');
    if (!row || !el._cur || !el._cur.botId) return;
    e.preventDefault();
    taskMenu(el, ui, el._cur.botId, row.dataset.task, e.clientX, e.clientY);
  });

  if (inPanel) return;
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
    // ← folds the team picked, → opens it
    if ((k === 'ArrowLeft' || k === 'ArrowRight') && el._cur && el._cur.kind === 'team' && !query) { setFold(el._cur.key, k === 'ArrowLeft', ui); return true; }
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

// ---------- bots: + New bot / New team, Start, the right-click menu ----------
// "+": a small menu under it, New bot and New team
function newMenu(el, ui) {
  const r = el._new.getBoundingClientRect();
  const off = newTeamWhy(el._contacts || []);
  openCtxMenu({ x: r.left, y: r.bottom + 4, title: 'New', items: [
    { label: 'New bot', icon: 'plus', note: 'an overseer with standing tasks', run: () => openForm(el, ui) },
    !off ? { label: 'New team', icon: 'merge', note: 'bots working on one order, in a group chat', run: () => openForm(el, ui, null, 'team') }
      : { label: 'New team', icon: 'merge', disabled: true, note: off },
  ] });
}
// the New bot form, in place of the chat (over the list in the narrow layout); with a bot's id, its Edit bot panel
// (the same form, filled in); mode 'team': the New team form
function openForm(el, ui, botId = null, mode = null) {
  if (form) for (const p of Object.values(form.pk || {})) p.close();
  form = { mode: mode || (botId ? 'edit' : 'new'), botId, busy: false, err: '', fresh: true, v: null, pk: null };
  if (el.classList.contains('ch-narrow')) open = true;
  ui.refresh();
}
function closeForm(ui) {
  if (!form) return;
  const edit = form.mode === 'edit';
  for (const p of Object.values(form.pk || {})) p.close();
  form = null;
  // Edit bot goes back to the bot's chat; New bot back to the list in the narrow layout
  if (!edit && pane && pane.classList.contains('ch-narrow')) open = false;
  ui.refresh();
}
// the colour the form's bot wears as picked: its own pick, else its account's
const formColor = () => form.v.color || (isAcct(form.v.account) ? acctColor(form.v.account) : C.cyan);
const effortHtml = (x) => `<span class="eff eff-${esc(x.value)}">${esc(x.label)}</span>`;
const acctHtml = (a) => (a === DYNAMIC ? '<span class="ch-acct ch-acct-dyn">~</span>' : `<span class="ch-acct" style="background:${esc(acctColor(a))}">${esc(a)}</span>`);
const formAccounts = (state) => (Array.isArray(state.accounts) && state.accounts.some(isAcct) ? state.accounts.filter(isAcct) : ['A', 'B']);
// the pickers' choices (chats-model.js botChoices: one more entry there is one more choice here), drawn: effort in
// its Claude Code colour, the account's dot, each shape as a mascot in the colour picked, colours as swatches. Each
// is a function, read on every draw, so the shapes follow the colour picked
function formChoices(state, bot) {
  const ch = botChoices({ accounts: formAccounts(state), models: MODEL_IDS, efforts: EFFORTS, modelLabel, current: bot || {} });
  const seed = bot ? `bot:${bot.id}` : 'new-bot';
  return {
    account: () => ch.account.map((x) => ({ ...x, art: acctHtml(x.value), btn: `${acctHtml(x.value)}<span>${esc(x.label)}</span>` })),
    model: () => ch.model.map((x) => ({ ...x, btn: `<span class="pk-mono">${esc(x.label)}</span>` })),
    effort: () => ch.effort.map((x) => ({ ...x, html: effortHtml(x), btn: effortHtml(x) })),
    shape: () => {
      const col = formColor();
      const art = (k, size) => mascotSVG(`pick-${k}`, { state: 'idle', color: col, size, shape: k });
      return [{ value: '', label: 'Pick for me', wide: true, art: '<span class="pk-auto">Auto</span>', btn: `${mascotSVG(seed, { state: 'idle', color: col, size: 20 })}<span>Auto</span>` },
        ...SHAPES.map((k) => ({ value: k, label: SHAPE_NAMES[k] || k, art: art(k, 28), btn: `${art(k, 20)}<span>${esc(SHAPE_NAMES[k] || k)}</span>` }))];
    },
    color: () => {
      const auto = isAcct(form.v.account) ? acctColor(form.v.account) : C.cyan;
      const sw = (hex, cls = '') => `<span class="pk-sw${cls}"${hex ? ` style="--sw:${esc(hex)}"` : ''}></span>`;
      const named = PALETTE.map(([hex, name]) => ({ value: hex, label: name, art: sw(hex), btn: `${sw(hex)}<span>${esc(name)}</span>` }));
      // a colour from the dialog (or a bot's own one not in the palette) is a choice too, after the palette
      const own = form.v.color && !PALETTE.some((x) => x[0] === form.v.color)
        ? [{ value: form.v.color, label: `Custom ${form.v.color}`, art: sw(form.v.color), btn: `${sw(form.v.color)}<span class="pk-mono">${esc(form.v.color)}</span>` }] : [];
      return [{ value: '', label: "Its account's colour", wide: true, art: `${sw(auto, ' sm')}<span class="pk-auto">Auto</span>`, btn: `${sw(auto)}<span>Auto${isAcct(form.v.account) ? ` (account ${esc(form.v.account)})` : ''}</span>` },
        ...named, ...own, { custom: true, label: 'Any colour...', wide: true, art: `${sw('', ' sm any')}<span class="pk-auto">Any...</span>` }];
    },
  };
}
function drawForm(el, state) {
  if (form.mode === 'team') { drawTeamForm(el, state); return; }
  const edit = form.mode === 'edit';
  const bot = edit ? botOf(state, form.botId) : null;
  if (form.fresh) {
    form.fresh = false;
    const accts = formAccounts(state);
    form.v = edit
      ? { account: bot.account || DEF.account, model: bot.model || DEF.model, effort: bot.effort || DEF.effort, shape: bot.shape || '', color: COLOR6.test(String(bot.color || '')) ? bot.color.toLowerCase() : '' }
      : { account: accts.includes(DEF.account) ? DEF.account : accts[0], model: DEF.model, effort: DEF.effort, shape: '', color: '' };
    const field = (k, label) => `<div class="ch-f"><span id="ch-nb-${k}">${label}</span><div data-pk="${k}"></div></div>`;
    el._form.innerHTML = `<form class="ch-nb" novalidate autocomplete="off">`
      + `<div class="ch-nb-h"><span class="ch-nb-av"></span><div><div class="ch-nb-t">${edit ? `${esc(bot.name)}'s profile` : 'New bot'}</div>`
      + `<div class="ch-nb-s">${edit ? 'Its name, role, instructions and look change at once (a running bot reads its instructions again), and so does Dynamic: each message you send is sized for it. Account, and a fixed model or effort, apply from its next new conversation.'
        : 'An overseer you give standing tasks. It works in a folder of its own (~/Bots), never on the map, and starts once it is made.'}</div></div></div>`
      + `<label class="ch-f"><span>Name</span><input name="name" maxlength="40" spellcheck="false" placeholder="e.g. Deploy watch" value="${edit ? esc(bot.name) : ''}"></label>`
      // what it is for in its teams: its CLAUDE.md and team briefs say it (bots.js)
      + `<label class="ch-f"><span>Role</span><input name="role" maxlength="${ROLE_MAX}" spellcheck="true" placeholder="e.g. Reviewer, Release manager" value="${edit ? esc(bot.role || '') : ''}"></label>`
      + `<label class="ch-f"><span>${edit ? 'Instructions' : 'What it does'}</span><textarea name="brief" maxlength="4000" rows="6" placeholder="Its standing instructions: what it watches, what it does, when it tells you">${edit ? esc(bot.brief || '') : ''}</textarea></label>`
      // its tasks, read only: drawn on every render (profileTasksHtml), so they follow /state
      + (edit ? `<div class="ch-f"><span id="ch-nb-tasks">Tasks</span><div class="ch-pt" role="group" aria-labelledby="ch-nb-tasks"></div></div>` : '')
      + `<div class="ch-f-row">${field('account', 'Account')}${field('model', 'Model')}${field('effort', 'Effort')}</div>`
      + `<div class="ch-f-row two">${field('shape', 'Shape')}${field('color', 'Colour')}</div>`
      + `<div class="ch-nb-err" role="alert" hidden></div>`
      + `<div class="ch-nb-b"><button type="button" class="btn" data-cancel="1">Cancel</button><button type="submit" class="btn primary" data-make="1"></button></div></form>`;
    const ch = formChoices(state, bot);
    const grid = { shape: 6, color: 6 }; // tiles per row
    form.pk = {};
    for (const k of ['account', 'model', 'effort', 'shape', 'color']) {
      form.pk[k] = mountPicker(el._form.querySelector(`[data-pk="${k}"]`), {
        options: ch[k], value: form.v[k], labelId: `ch-nb-${k}`, grid: grid[k] || 0,
        onChange: (v) => { if (!form || !form.v) return; form.v[k] = v; if (k !== 'model' && k !== 'effort') drawLook(el); },
      });
    }
    drawLook(el);
    requestAnimationFrame(() => el._form.querySelector('input[name="name"]')?.focus());
  }
  const f = el._form.querySelector('form');
  // only the Tasks list is drawn again here: the fields keep what is typed in them
  const pt = edit && bot ? f.querySelector('.ch-pt') : null;
  if (pt) setHTML(pt, profileTasksHtml(bot, Date.now()));
  const er = f.querySelector('.ch-nb-err');
  er.textContent = form.err;
  er.hidden = !form.err;
  const mk = f.querySelector('[data-make]');
  mk.disabled = form.busy;
  mk.textContent = edit ? (form.busy ? 'Saving...' : 'Save') : form.busy ? 'Making it...' : 'Make it';
}
// a bot's tasks in its profile (chats-model.js profileTasks): the open and paused ones, next run soonest first, each
// as the Tasks strip phrases it (taskSchedule, taskLine), then "Done (N)", whose rows show when it is clicked
function profileTasksHtml(b, now) {
  const { live, done } = profileTasks(tasksOf(b));
  if (!live.length && !done.length) return '<div class="ch-pt-none">No tasks yet.</div>';
  const row = (t) => `<div class="ch-tk-row ${esc(t.status)}${t.valid === false ? ' bad' : ''}"${t.detail ? ` title="${esc(t.detail)}"` : ''}>`
    + `<span class="ch-tk-ic" aria-hidden="true">${icon(taskIcon(t), 13)}</span>`
    + `<div class="ch-tk-m"><div class="ch-tk-l1"><span class="ch-tk-title">${esc(t.title)}</span><span class="ch-tk-sch">${esc(taskSchedule(t))}</span></div>`
    + `<div class="ch-tk-l2">${esc(taskLine(t, now))}</div></div></div>`;
  const shut = !(form && form.doneOpen);
  return (live.length ? live.map(row).join('') : '<div class="ch-pt-none">Nothing open.</div>')
    + (done.length ? `<button type="button" class="ch-pt-done" data-tdone="1" aria-expanded="${!shut}"><span class="ch-tk-chev">${icon('chevron', 12)}</span><span>Done (${done.length})</span></button>`
      + (shut ? '' : done.map(row).join('')) : '');
}
// a shape, colour or account picked: the shape and colour pickers (drawn in the colour picked) and the header's
// preview of the bot as picked follow
function drawLook(el) {
  if (!form || !form.pk) return;
  form.pk.shape.redraw();
  form.pk.color.redraw();
  const seed = form.mode === 'edit' ? `bot:${form.botId}` : 'new-bot';
  setHTML(el._form.querySelector('.ch-nb-av'), mascotSVG(seed, { state: 'new', color: formColor(), size: 44, shape: form.v.shape || undefined }));
}
async function submitForm(el, ui) {
  if (!form || form.busy) return;
  if (form.mode === 'team') { submitTeam(el, ui); return; }
  const f = el._form.querySelector('form');
  const v = (n) => String((f && f.elements[n] && f.elements[n].value) || '');
  const vals = { name: v('name'), role: v('role'), brief: v('brief'), ...form.v };
  if (!vals.name.trim()) { form.err = 'Give it a name.'; ui.refresh(); f.elements.name.focus(); return; }
  if (form.mode === 'edit') { saveEdit(el, ui, vals); return; }
  const body = { name: vals.name.trim(), brief: vals.brief.trim(), account: vals.account, model: vals.model, effort: vals.effort };
  const role = vals.role.replace(/\s+/g, ' ').trim().slice(0, ROLE_MAX);
  if (role) body.role = role;
  // the look only when picked: else the server leaves it out and the page picks one from the bot's id
  if (vals.shape) body.shape = vals.shape;
  if (vals.color) body.color = vals.color;
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
// Edit bot's Save: POST /bots/:id with only what changed; back to its chat once saved, else the form says why
async function saveEdit(el, ui, vals) {
  const id = form.botId;
  const bot = botOf(el._state || {}, id);
  if (!bot) { closeForm(ui); return; }
  const body = botEdits(bot, vals);
  if (!Object.keys(body).length) { closeForm(ui); return; }
  form.busy = true;
  form.err = '';
  ui.refresh();
  const r = await postJson(`/bots/${id}`, body);
  if (!form || form.botId !== id) return; // closed meanwhile
  if (FIXTURE) { const m = made.get(id); if (m) Object.assign(m.bot, body); }
  else if (!r.ok) { form.busy = false; form.err = failText(r, 'Could not save it'); ui.refresh(); return; }
  // the new look shows at once, before /state has it
  const lk = {};
  if ('shape' in body) lk.shape = body.shape;
  if ('color' in body) lk.color = body.color;
  if (Object.keys(lk).length) looks.set(id, { ...(looks.get(id) || {}), ...lk, at: Date.now() });
  closeForm(ui);
}

// ---------- New team ----------
const teamMax = () => Number(curUi().teamMax) || TEAM_MAX;
// a contact's face at rest (the form's rows stay put while it works)
const restFace = (c, size) => mascotSVG(c.key, { state: 'idle', color: colorOf(c), size, shape: c.shape || undefined });
// who can be in it: every bot (team-form.js teamChoices); why not comes from app.js (ui.teamJoinWhy:
// the orders' checks)
function teamChoices(state) {
  const ui = curUi();
  const joinWhy = typeof ui.teamJoinWhy === 'function' ? (id) => ui.teamJoinWhy(id) : () => 'this page cannot make a team yet';
  return teamChoicesOf(pane?._contacts || [], (state && state.teams) || [], joinWhy);
}
const tickedOf = () => (form && form.v ? form.v.members : []).map((id) => (pane?._contacts || []).find((c) => c.id === id)).filter(Boolean);
// Lead ▸: No lead (peers), then each one ticked, with its face
function leadOptions() {
  return leadChoices(tickedOf(), (pane?._state || {}).teams || []).map(({ c, ...o }, i) => (!c ? o
    : { ...o, sep: i === 1, art: restFace(c, 18), btn: `${restFace(c, 18)}<span>${esc(c.name)} leads</span>` }));
}
// Team above ▸: None, then each overseers' team (a group chat here); its lead reports there (teams nest)
function aboveOptions() {
  return aboveChoices(pane?._contacts || [], (pane?._state || {}).teams || [], teamMax()).map((o, i) => (i === 1 ? { ...o, sep: true } : o));
}
function drawTeamForm(el, state) {
  if (form.fresh) {
    form.fresh = false;
    form.v = { members: [], lead: '', above: '' };
    const field = (k, label) => `<div class="ch-f" data-f="${k}"><span id="ch-nt-${k}">${label}</span><div data-pk="${k}"></div></div>`;
    el._form.innerHTML = `<form class="ch-nb ch-nt" novalidate autocomplete="off">`
      + `<div class="ch-nb-h"><span class="ch-nb-av"></span><div><div class="ch-nb-t">New team</div>`
      + `<div class="ch-nb-s">Bots that work on one order together, with a group chat here. Each gets the order, its teammates and how to reach them; under a lead, the lead directs and the others report to it.</div></div></div>`
      + `<label class="ch-f"><span>Name</span><input name="name" maxlength="80" spellcheck="false" placeholder="Bots · the order's first words"></label>`
      + `<div class="ch-f"><span id="ch-nt-members">Members</span><div class="ch-tm-list" role="group" aria-labelledby="ch-nt-members"></div><div class="ch-tm-n"></div></div>`
      + `<div class="ch-f-row two">${field('lead', 'Lead')}${field('above', 'Team above')}</div>`
      + `<label class="ch-f"><span>The order</span><textarea name="order" maxlength="4000" rows="5"></textarea></label>`
      + `<div class="ch-nb-err" role="alert" hidden></div>`
      + `<div class="ch-nb-b"><button type="button" class="btn" data-cancel="1">Cancel</button><button type="submit" class="btn primary" data-make="1"></button></div></form>`;
    form.pk = {
      lead: mountPicker(el._form.querySelector('[data-pk="lead"]'), { options: leadOptions, value: '', labelId: 'ch-nt-lead',
        onChange: (v) => { if (!form || !form.v) return; form.v.lead = v; if (!v) form.v.above = ''; curUi().refresh?.(); } }),
      above: mountPicker(el._form.querySelector('[data-pk="above"]'), { options: aboveOptions, value: '', labelId: 'ch-nt-above',
        onChange: (v) => { if (form && form.v) form.v.above = v; } }),
    };
    requestAnimationFrame(() => el._form.querySelector('input[name="name"]')?.focus());
  }
  const f = el._form.querySelector('form');
  const max = teamMax(), choices = teamChoices(state);
  // a member that can't be in it any more (gone, ended elsewhere) is unticked; the lead and the team above follow
  Object.assign(form.v, settleTeam(form.v, choices, pane?._contacts || [], max));
  const teams = (pane?._contacts || []).filter((c) => c.kind === 'team');
  const ms = form.v.members, n = ms.length;
  // the rows (rewritten only when something in them changed; the focus stays on the row it was on)
  const rows = choices.map((x) => {
    const mr = memberRow(x, ms, max), { on, off } = mr;
    const note = [x.c.role, mr.note].filter(Boolean).join(' · '); // its role first
    return `<label class="ch-tm${on ? ' on' : ''}${off ? ' off' : ''}" title="${esc(x.why ? `${x.c.name}: ${x.why}` : x.c.name)}">`
      + `<input type="checkbox" name="tm" value="${esc(x.id || x.c.key)}"${on ? ' checked' : ''}${off || form.busy ? ' disabled' : ''}>`
      + `<span class="ch-tm-av">${restFace(x.c, 26)}</span><span class="ch-tm-b"><span class="ch-tm-name">${esc(x.c.name)}</span>`
      + `${note ? `<span class="ch-tm-note">${esc(note)}</span>` : ''}</span></label>`;
  }).join('') || '<div class="ch-tm-none">No bots yet: make two first.</div>';
  const list = f.querySelector('.ch-tm-list');
  if (list._html !== rows) {
    const had = document.activeElement && list.contains(document.activeElement) ? document.activeElement.value : null;
    list.innerHTML = rows;
    list._html = rows;
    if (had) [...list.querySelectorAll('input[name="tm"]')].find((i) => i.value === had)?.focus();
  }
  f.querySelector('.ch-tm-n').textContent = countNote(n, max);
  // the header: the ones ticked, overlapping as on a team's row
  const show = tickedOf().slice(0, 3);
  const sz = Math.round(44 * (show.length === 1 ? 1 : 0.62));
  setHTML(el._form.querySelector('.ch-nb-av'), !show.length ? mascotSVG('new-team', { state: 'new', color: C.cyan, size: 44 })
    : `<span class="ch-cluster n${show.length}" style="--cb:44px;--cs:${sz}px">${show.map((c, i) => `<span class="ch-cm m${i}">${restFace(c, Math.round(sz * 0.84))}</span>`).join('')}</span>`);
  // Lead and Team above follow the ticks; Team above only with a lead, and only when there is a team to report to
  // (each one drawn again only when its choices or its pick changed: a redraw while its menu is open moves the focus)
  const sig = `${ms.join(',')}|${teams.map((c) => `${c.teamId}:${c.name}:${(c.members || []).length}`).join(',')}`;
  if (form.pk.lead.value !== form.v.lead) form.pk.lead.set(form.v.lead);
  if (form.pk.above.value !== form.v.above) form.pk.above.set(form.v.above);
  if (form.sig !== sig) { form.sig = sig; form.pk.lead.redraw(); form.pk.above.redraw(); }
  form.pk.lead.disable(form.busy || n < 2);
  form.pk.above.disable(form.busy);
  f.querySelector('[data-f="above"]').hidden = !form.v.lead || !teams.length;
  const lead = form.v.lead ? tickedOf().find((c) => c.id === form.v.lead) : null;
  f.elements.order.placeholder = orderHint(lead);
  const er = f.querySelector('.ch-nb-err');
  er.textContent = form.err;
  er.hidden = !form.err;
  const mk = f.querySelector('[data-make]');
  mk.disabled = form.busy;
  mk.textContent = form.busy ? 'Making it...' : 'Make team';
}
// a member ticked or unticked: the lead and the team above follow (drawTeamForm)
function tickMember(el, id, on) {
  if (!form || form.mode !== 'team' || !form.v) return;
  form.v.members = form.v.members.filter((x) => x !== id);
  if (on) form.v.members.push(id);
  form.err = '';
  curUi().refresh?.();
}
// Make team: ui.makeTeam (app.js) does what the team menus' orders do; the new team's group chat is picked once
// it is made, else the form says why (the server's reason when it refuses)
async function submitTeam(el, ui) {
  const mine = form;
  const f = el._form.querySelector('form');
  const v = (n) => String((f && f.elements[n] && f.elements[n].value) || '');
  const say = (m, focus) => { mine.err = m; ui.refresh(); focus?.focus(); };
  const members = [...mine.v.members];
  if (members.length < 2) { say('Tick two or more to make a team.'); return; }
  const order = v('order').trim();
  if (!order) { say('Write the order: what the team is to do.', f.elements.order); return; }
  if (typeof ui.makeTeam !== 'function') { say('This page cannot make a team yet.'); return; }
  mine.busy = true;
  mine.err = '';
  ui.refresh();
  let r;
  try { r = await ui.makeTeam({ members, lead: mine.v.lead || null, name: v('name').trim(), order, above: (mine.v.lead && mine.v.above) || null }); }
  catch (e) { r = { ok: false, message: String((e && e.message) || e) }; }
  if (form !== mine) return; // closed meanwhile
  if (!r || !r.ok) { mine.busy = false; mine.err = (r && r.message) || 'Could not make the team'; ui.refresh(); return; }
  for (const p of Object.values(mine.pk || {})) p.close();
  form = null;
  if (r.team && typeof r.team.id === 'string') pick(`team:${r.team.id}`, ui, true);
  else ui.refresh();
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
  ackBot(el, c.key);
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

// the right-click menu of a bot's row: Pin / Unpin (at the top), Start, Profile... (its Edit bot panel: name, role,
// look and the rest live there only), its team items (groupItems), Team ▸, Remove bot
function botMenu(el, ui, botId, x, y) {
  const b = botOf(el._state || {}, botId);
  if (!b) return;
  const c = (el._contacts || []).find((k) => k.botId === botId);
  const u = bu(botId);
  const top = !(c && c.parentTeam && teamRowOf(el, c.parentTeam));
  const grp = groupItems(el, ui, c);
  openCtxMenu({
    x, y, title: b.name, dot: colorOf(c), sub: [b.live ? 'running' : 'not running', c && c.role].filter(Boolean).join(' · '),
    items: [
      ...(c && top ? [pinItem(ui, c), { sep: true }] : []),
      ...(b.live ? [] : [u.starting || u.wait ? { label: 'Start', icon: 'shell', disabled: true, note: 'starting...' }
        : { label: 'Start', icon: 'shell', note: b.convId ? 'goes on in its last conversation' : 'its first conversation', run: () => startBot(ui, botId) }]),
      { label: 'Profile...', icon: 'mode', note: 'name, role, instructions, look, model', run: () => { pick(`bot:${botId}`, ui, true); openForm(el, ui, botId); } },
      ...(grp.length ? [{ sep: true }, ...grp] : []),
      ...botTeamItems(ui, c),
      { sep: true },
      { label: 'Remove bot', icon: 'trash', danger: true, note: 'its folder and chats are kept', confirm: { text: `Remove ${b.name}? Its session ends. Its folder and its conversations are kept.`, yes: 'Remove' }, run: () => removeBot(ui, botId, b.name) },
    ],
  });
}
// Team ▸: the conversation menu's (app.js teamItems: Start team ▸ with the other bots, Add to team ▸, Lead team ▸,
// its teams), for the conversation its row opens; one that never started has none yet
function botTeamItems(ui, c) {
  if (typeof ui.teamItems !== 'function') return [];
  if (!c || !c.id) return [{ label: 'Team', icon: 'merge', disabled: true, note: 'start it first' }];
  try { return ui.teamItems(c.id) || []; } catch (e) { console.warn('chats: team items', e); return []; }
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
  // (no scroll: the side panel's copy may still be sliding in, and a scroll there would push the view sideways)
  const o = { preventScroll: true };
  if (c && c.kind === 'team') el._ta.focus(o);
  else if (!el._bot.hidden) el._bta.focus(o);
  else el._chat.querySelector('.chat-compose textarea')?.focus(o);
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
// A bot working on its reply: a small copy of its face at the bottom left of its chat, above the box,
// bobbing beside three typing dots, Grok-style (Henry, 2026-10-13: "when they are typing back i should them bottom
// right in a smaller version like in grokbot"; then "move the bot animation thinking from right to left and remove
// the regular cooking status"): while it shows, the box's "Cooking…" line hides (chats.css). Gone once it is idle,
// done or asks you something. Its face from the conversation /state already gives (mascotState: working or
// thinking), nothing polled. The feed leaves room for it under the last message (.ch-typing-on), and one at its end
// stays there.
function drawTyping(el, c, s) {
  const main = el._chat.querySelector('.chat-main');
  if (!main) return;
  const f = s && c && c.kind !== 'team' ? mascotState(s) : 'idle';
  const on = f === 'working' || f === 'thinking';
  let t = el._typing;
  if (!t && !on) return;
  if (!t) {
    t = el._typing = document.createElement('div');
    t.className = 'ch-typing';
    t.setAttribute('role', 'status');
    t.innerHTML = '<span class="ch-typing-av"></span><span class="ch-typing-dots" aria-hidden="true"><i></i><i></i><i></i></span>';
    t._av = t.querySelector('.ch-typing-av');
  }
  if (t.parentNode !== main) main.appendChild(t); // (a pane built again: put back)
  if (on) {
    setHTML(t._av, mascotSVG(c.key, { state: 'working', color: colorOf(c), size: 28, shape: c.shape || undefined }));
    const say = `${c.name || 'It'} is working on a reply`;
    if (t.getAttribute('aria-label') !== say) { t.setAttribute('aria-label', say); t.title = say; }
  }
  t.hidden = !on;
  if (el._chat.classList.contains('ch-typing-on') !== on) {
    const feed = el._chat.querySelector('.chat-feed');
    const atEnd = !!feed && feed.scrollHeight - feed.scrollTop - feed.clientHeight < 8;
    el._chat.classList.toggle('ch-typing-on', on);
    if (on && atEnd) feed.scrollTop = feed.scrollHeight;
  }
}
function drawHead(el, state, c, s) {
  const narrow = el.classList.contains('ch-narrow');
  el._head.querySelector('.ch-back').hidden = !narrow;
  if (c.kind === 'team') {
    setHTML(el._headAv, cluster(state, c, 36));
    el._headAv.title = '';
    const ms = (c.members || []).map((m) => `<span class="ch-mem${m.lead ? ' lead' : ''}" title="${esc([m.lead ? `${m.name} leads the team` : m.name, m.role].filter(Boolean).join(' · '))}">${memberMascot(state, m, 16)}<span>${m.lead ? '★ ' : ''}${esc(m.name)}</span>${m.role ? `<span class="ch-mrole">${esc(m.role)}</span>` : ''}</span>`).join('');
    setHTML(el._headT, `<div class="ch-head-n"><span class="name">${esc(c.name)}</span><span class="state" style="color:${esc(colorOf(c))}">GROUP</span></div><div class="ch-head-m ch-mems">${ms}</div>`);
    setHTML(el._headB, '');
    return;
  }
  setHTML(el._headAv, avatar(state, c, 36));
  el._headAv.title = doingTip(c);
  // a bot that is not running: Start, nothing that would open its conversation without its role
  const u = c.botId ? bu(c.botId) : null;
  // a bot's settings: its Edit bot panel
  const edit = c.kind === 'bot' && c.botId && botOf(state, c.botId)
    ? `<button type="button" class="ch-ib ch-edit" data-edit="1" title="Profile: name, role, instructions, model, effort and look" aria-label="Profile">${icon('mode', 15)}</button>` : '';
  const start = c.kind === 'bot' && c.live === false
    ? `<button type="button" class="btn primary" data-start="1"${u.starting || u.wait ? ' disabled' : ''} title="Start it: its running conversation, else its last one, else a new one in its folder">${icon('shell', 14)}<span>${u.starting || u.wait ? 'Starting...' : 'Start'}</span></button>` : null;
  // its role under its name (its Profile's Role)
  const role = c.role ? `<span class="ch-role" title="${esc(`${c.name}'s role`)}">${esc(c.role)}</span>` : '';
  if (!s) {
    setHTML(el._headT, `<div class="ch-head-n"><span class="name">${esc(c.name || 'Bot')}</span></div><div class="ch-head-m">${role}<span class="ch-goal">${esc(previewOf(c))}</span></div>`);
    setHTML(el._headB, edit + (start || ''));
    return;
  }
  setHTML(el._headT, `<div class="ch-head-n"><span class="name">${esc(c.name || s.name)}</span>${badge(s)}</div>`
    + `<div class="ch-head-m">${role}${repoChip(s)}${s.goal && setupNote(s.goal) == null ? `<span class="ch-goal" title="${esc(s.goal)}">${esc(s.goal)}</span>` : ''}</div>`);
  if (start) { setHTML(el._headB, edit + start); return; }
  const live = !s.past && inState(state, s.id);
  const solo = SOLO && typeof desk()?.showMain === 'function';
  const where = solo ? 'in the main window' : 'in the side panel (again: close it)';
  // the one whose tab the side panel shows is lit, and a click on it closes the panel (ui.panel)
  const on = (p) => (!solo && el._ui?.panelTab?.(s.id) === p ? ' on" aria-pressed="true' : '" aria-pressed="false');
  setHTML(el._headB, edit + (live ? `<button type="button" class="btn${on('session')}" data-pane="session" title="the live session, ${where}">${icon('shell', 14)}<span>Session</span></button>`
    + `<button type="button" class="btn${on('details')}" data-pane="details" title="plan, ship track, files and cost, ${where}">${icon('info', 14)}<span>Details</span></button>` : '')
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

// ---------- posting ----------
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

function blankHtml(state, c, noBots) {
  if (c && c.kind === 'bot') {
    return `<div class="ch-empty">${mascotSVG(c.key, { state: 'new', color: colorOf(c), size: 72, shape: c.shape || undefined })}<div class="ch-empty-t">${esc(c.name)}</div>`
      + `<div class="ch-empty-s">Starting: its chat shows once Fleet View lists its conversation.</div></div>`;
  }
  if (noBots) {
    return `<div class="ch-empty">${mascotSVG('chats', { state: 'idle', color: C.cyan, size: 72 })}<div class="ch-empty-t">Bots</div>`
      + `<div class="ch-empty-s">${esc(BOTS_FOR)}</div>${newBotBtn()}</div>`;
  }
  return `<div class="ch-empty">${mascotSVG('chats', { state: 'idle', color: C.cyan, size: 72 })}<div class="ch-empty-t">Pick a bot</div>`
    + `<div class="ch-empty-s">Your bots and their teams are on the left.</div></div>`;
}

// a bot that is not running: its last chat to read (or, none yet, a card with its instructions and Start), and its box
function introHtml(c, b, u) {
  const busy = u.starting || !!u.wait;
  const dynBoth = b && b.model === DYNAMIC && b.effort === DYNAMIC;
  const defs = b ? [dynBoth ? 'Dynamic model and effort' : b.model === DYNAMIC ? 'Dynamic model' : b.model ? modelLabel(b.model) : '',
    dynBoth ? '' : b.effort === DYNAMIC ? 'dynamic effort' : b.effort || ''].filter(Boolean).join(' · ') : '';
  return `<div class="ch-empty ch-start">${mascotSVG(c.key, { state: 'new', color: colorOf(c), size: 72, shape: c.shape || undefined })}<div class="ch-empty-t">${esc(c.name)}</div>`
    + (b && b.brief ? `<div class="ch-brief">${esc(b.brief)}</div>` : '<div class="ch-empty-s">No instructions yet: give it some in its Profile.</div>')
    + (defs ? `<div class="ch-defaults" title="What it starts with">${esc(defs)}</div>` : '')
    + `<div class="ch-intro-b"><button type="button" class="btn" data-edit="1">${icon('mode', 14)}<span>Profile</span></button>`
    + `<button type="button" class="btn primary ch-start-btn" data-start="1"${busy ? ' disabled' : ''}>${busy ? 'Starting...' : `Start ${esc(c.name)}`}</button></div></div>`;
}
function drawBot(el, state, c, s, visible) {
  const u = bu(c.botId);
  const busy = u.starting || !!u.wait;
  el._bchat.hidden = !s;
  el._bintro.hidden = !!s;
  if (s) renderChatPane(el._bchat, s, { readOnly: true, visible, bubbles: true, history: historyOf(state, c) });
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

// ---------- a bot's tasks ----------
const taskBusy = new Map(); // '<bot id>:<task id>' -> the action on its way
const taskOver = new Map(); // '<bot id>:<task id>' -> { task?, gone?, at }: what an action did, until /state says it too
const OVER_MS = 6000;
let taskErr = { botId: null, text: '' };
const BUSY_TEXT = { run: 'sending it now...', pause: 'pausing...', resume: 'resuming...', delete: 'deleting...' };
// state.bots[].tasks with what an action just did laid over it (the list redraws before /state has it)
function tasksOf(b) {
  const now = Date.now();
  const out = [];
  for (const t of b.tasks || []) {
    const k = `${b.id}:${t.id}`;
    const o = taskOver.get(k);
    if (o && now - o.at > OVER_MS) taskOver.delete(k);
    else if (o && o.gone) continue;
    else if (o && o.task) { out.push(o.task); continue; }
    out.push(t);
  }
  return out;
}
// a task's icon: done, paused, recurring, timed once, or a plain to-do
const taskIcon = (t) => (t.status === 'done' ? 'check' : t.status === 'paused' ? 'pause' : t.kind === 'recurring' ? 'repeat' : t.schedule ? 'clock' : 'dot');
function taskRow(b, t, now) {
  const busy = taskBusy.get(`${b.id}:${t.id}`);
  const timed = !!t.schedule && t.status !== 'done';
  const dis = busy ? ' disabled' : '';
  return `<div class="ch-tk-row ${esc(t.status)}${t.valid === false ? ' bad' : ''}" role="listitem" data-task="${esc(t.id)}">`
    + `<span class="ch-tk-ic" aria-hidden="true">${icon(taskIcon(t), 13)}</span>`
    + `<div class="ch-tk-m"${t.detail ? ` title="${esc(t.detail)}"` : ''}><div class="ch-tk-l1"><span class="ch-tk-title">${esc(t.title)}</span>`
    + `<span class="ch-tk-sch">${esc(taskSchedule(t))}</span></div><div class="ch-tk-l2">${esc(busy ? BUSY_TEXT[busy] || '...' : taskLine(t, now))}</div></div>`
    + `<span class="ch-tk-b">`
    + (t.status !== 'done' ? `<button type="button" class="ch-ib ch-tk-btn" data-tact="run"${dis} title="Run now: send it to ${esc(b.name)} now (it starts first if it is not running)" aria-label="Run now">${icon('play', 13)}</button>` : '')
    + (timed ? (t.status === 'paused'
      ? `<button type="button" class="ch-ib ch-tk-btn" data-tact="resume"${dis} title="Resume: from its next time on" aria-label="Resume">${icon('repeat', 13)}</button>`
      : `<button type="button" class="ch-ib ch-tk-btn" data-tact="pause"${dis} title="Pause: it does not run until you resume it" aria-label="Pause">${icon('pause', 13)}</button>`) : '')
    + `<button type="button" class="ch-ib ch-tk-btn" data-tmenu="1" title="More: run now, pause, delete" aria-label="More" aria-haspopup="menu">⋯</button>`
    + `</span></div>`;
}
// the strip above a bot's chat: one line folded (how many are open, which runs next), the list open
function drawTasks(el, state, c) {
  const b = c && c.kind === 'bot' && c.botId ? botOf(state, c.botId) : null;
  el._tasks.hidden = !b;
  if (!b) return;
  const now = Date.now();
  const tasks = tasksOf(b);
  const head = tasksHead(tasks, now);
  const err = taskErr.botId === b.id ? taskErr.text : b.tasksError ? `${b.name}'s task list can't be read: ${b.tasksError}. Nothing in it runs until that is fixed (ask ${b.name}).` : '';
  const body = !tasksOpen ? '' : tasks.length ? `<div class="ch-tk-list" role="list" aria-label="${esc(b.name)}'s tasks">${tasks.map((t) => taskRow(b, t, now)).join('')}</div>`
    : `<div class="ch-tk-empty">Give ${esc(b.name)} a task in the chat, once or recurring ("every weekday at 9, check the deploys"). It keeps this list, and Fleet View wakes it when one comes due.</div>`;
  setHTML(el._tasks, `<button type="button" class="ch-tk-h" aria-expanded="${tasksOpen}" title="${tasksOpen ? 'Fold the tasks' : 'Show the tasks'}">`
    + `<span class="ch-tk-chev">${icon('chevron', 12)}</span><span class="ch-tk-t">Tasks</span>${head.open ? `<span class="ch-tk-n">${head.open}</span>` : ''}`
    + `<span class="ch-tk-s">${esc(head.text)}</span></button>${err ? `<div class="ch-tk-err" role="alert">${esc(err)}</div>` : ''}${body}`);
}
// POST /bots/:id/tasks/:taskId { action }; the list shows what it did at once, and why not when it failed
async function taskAct(ui, botId, taskId, action) {
  const k = `${botId}:${taskId}`;
  if (!taskId || taskBusy.has(k)) return;
  taskBusy.set(k, action);
  taskErr = { botId: null, text: '' };
  ui.refresh();
  const r = await postJson(`/bots/${botId}/tasks/${encodeURIComponent(taskId)}`, { action });
  taskBusy.delete(k);
  const b = botOf(pane?._state || {}, botId);
  if (r.ok) {
    if (action === 'run') ackBot(pane, `bot:${botId}`);
    else if (action === 'delete') taskOver.set(k, { gone: true, at: Date.now() });
    else {
      const was = ((b && b.tasks) || []).find((t) => t.id === taskId);
      const task = (r.body && r.body.task) || (was ? { ...was, status: action === 'pause' ? 'paused' : 'open', ...(action === 'pause' ? { nextRun: null } : {}) } : null);
      if (task) taskOver.set(k, { task, at: Date.now() });
    }
    if (FIXTURE && b) applyFixtureTask(b, taskId, action);
  } else taskErr = { botId, text: failText(r, `Could not ${action} it`) };
  ui.refresh();
}
// ?fixture=1: nothing is posted, so the action is done to the page's copy
function applyFixtureTask(b, taskId, action) {
  const t = (b.tasks || []).find((x) => x.id === taskId);
  if (!t) return;
  if (action === 'delete') b.tasks = b.tasks.filter((x) => x !== t);
  else if (action === 'pause') Object.assign(t, { status: 'paused', nextRun: null });
  else if (action === 'resume') t.status = 'open';
  else if (action === 'run') Object.assign(t, { lastRun: Date.now(), runs: [...(t.runs || []), { at: Date.now(), by: 'henry' }] });
}
// a task's menu (⋯ or a right-click on its row): Run now, Pause or Resume, Delete task (asks first)
function taskMenu(el, ui, botId, taskId, x, y) {
  const b = botOf(el._state || {}, botId);
  const t = b && tasksOf(b).find((k) => k.id === taskId);
  if (!t) return;
  const busy = taskBusy.has(`${botId}:${taskId}`);
  const timed = !!t.schedule && t.status !== 'done';
  openCtxMenu({
    x, y, title: t.title, sub: `${taskSchedule(t)} · ${t.status}`,
    items: [
      { label: 'Run now', icon: 'play', disabled: busy || t.status === 'done', note: t.status === 'done' ? 'it is done' : `send it to ${b.name} now`, run: () => taskAct(ui, botId, taskId, 'run') },
      ...(timed ? [t.status === 'paused' ? { label: 'Resume', icon: 'repeat', disabled: busy, note: 'from its next time on', run: () => taskAct(ui, botId, taskId, 'resume') }
        : { label: 'Pause', icon: 'pause', disabled: busy, note: 'it does not run until resumed', run: () => taskAct(ui, botId, taskId, 'pause') }] : []),
      { sep: true },
      { label: 'Delete task', icon: 'trash', danger: true, disabled: busy, confirm: { text: `Delete "${t.title}" from ${b.name}'s tasks?`, yes: 'Delete' }, run: () => taskAct(ui, botId, taskId, 'delete') },
    ],
  });
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

// when each contact was last opened, read afresh: the pop-out window writes it too -> { [contact key]: ms }
export function seenNow() {
  const s = store.get(SEEN_KEY, {});
  return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
}

// a contact opened from outside this tab by its key ('bot:<id>': the map's bot menu, app.js openBotChat), even a bot
// with no conversation yet; the next renderChats shows it
export function selectChat(key) {
  if (typeof key !== 'string' || !key) return;
  selKey = key;
  store.set(SEL_KEY, key);
  form = null;
  open = true;
}

// a bot's look for a note outside this tab (botnote.js): its row's name, colour and mascot, wearing face ('done',
// 'needs', ...), for the conversation sid (raw /state or the derived one) -> { key, name, color, face, preview } or
// null when sid is no bot's
export function botFace(state, sid, face, size = 34) {
  let list;
  try { list = buildContacts(state).map(lookOf); } catch { return null; }
  const c = list.find((x) => x.kind !== 'team' && (x.id === sid || (x.ids || []).includes(sid)));
  if (!c) return null;
  const color = colorOf(c);
  return { key: c.key, name: c.name || 'Bot', color, preview: c.preview || '',
    face: mascotSVG(c.key, { state: face, color, size, shape: c.shape || undefined }) };
}

// a bot's look by its id, exactly as its row here draws it (the Map's mascot and the menus' "Add bot ▸" and "Have a
// bot watch it ▸", map-bots.js): -> { color, shape, face, svg(size, face?) } or null when it has no row. The rows are
// built once per state (the map asks every frame); a look just picked here counts at once (lookOf)
const rowsOf = new WeakMap();
export function botLook(state, botId) {
  if (!state || typeof state !== 'object' || !botId) return null;
  let rows = rowsOf.get(state);
  if (!rows) {
    try { rows = buildContacts(withMade(state)); } catch { rows = []; }
    rowsOf.set(state, rows);
  }
  const row = rows.find((x) => x.kind === 'bot' && x.botId === botId);
  if (!row) return null;
  const c = lookOf(row), color = colorOf(c), face = faceOf(c), shape = c.shape || undefined;
  return { color, shape: shape || null, face, svg: (size, f = face) => mascotSVG(c.key, { state: f, color, size, shape }) };
}

// A bot picked on the Map: its chat as this view shows it, drawn into el, the side panel's box (detail.js
// renderBotDetail gives it the class ch-panel): the narrow layout with the chat open and the list hidden (chats.css), a
// ✕ in the back arrow's place (ui.closeBotPanel). It is this view's own pick, so the Bots tab shows the same bot after.
// focus: put the cursor in its chat box (a pick by click)
export function renderBotPanel(el, view, ui, botId, focus = false) {
  const key = `bot:${botId}`;
  if (selKey !== key) {
    selKey = key;
    store.set(SEL_KEY, key);
    if (form && !(form.mode === 'edit' && form.botId === botId)) form = null;
  }
  open = true;
  renderChats(el, view, ui);
  if (focus) focusCompose(el);
}

// the teams of bots as this view's list has them (its group rows), for the Map's "Add bot ▸": [{ id, name, color, art(size),
// members: [{ botId, name, lead, role }] }], the lead first; a member that is no bot of this machine is left out
export function botTeams(state) {
  if (!state || typeof state !== 'object') return [];
  let rows;
  try { rows = buildContacts(withMade(state)).map(lookOf); } catch { return []; }
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return rows.filter((r) => r.kind === 'team').map((t) => ({
    id: t.teamId, name: t.name || 'team', color: colorOf(t), art: (size) => cluster(state, t, size),
    members: (t.members || []).map((m) => {
      const r = byKey.get(m.key);
      return r && r.botId && botOf(state, r.botId) ? { botId: r.botId, name: m.name, lead: !!m.lead, role: m.role || '' } : null;
    }).filter(Boolean),
  })).filter((t) => t.members.length);
}

export function renderChats(el, view, ui) {
  if (!el._built) build(el, ui);
  // the Bots tab or the side panel's copy (renderBotPanel), whichever draws now: the one clicks and keys act on
  pane = el;
  const inPanel = el.classList.contains('ch-panel');
  const state = withMade(view);
  el._ui = ui;
  el._state = state;
  dynBots = FIXTURE ? [] : state.bots || []; // (?fixture=1 has no server to switch through)
  const now = Date.now();
  const canPop = !SOLO && typeof desk()?.popChats === 'function';
  const away = popped && !SOLO && !inPanel; // Bots is in its own window (the panel's copy shows here all the same)
  el._pop.hidden = !canPop || inPanel;
  el._popped.hidden = !away;
  el._ch.hidden = away;
  if (away) return;

  let contacts = [];
  try {
    contacts = sortContacts(buildContacts(state), orderNow(state)).map(lookOf);
  } catch (e) { console.error('chats: contacts', e); }
  el._contacts = contacts;
  try { addNew(state, contacts); } catch (e) { console.error('chats: order', e); }
  try { pumpBots(state); } catch (e) { console.error('chats: bots', e); }
  // an overseer's conversation picked from outside (?select=, the mini window) carries over to its row
  if (!inPanel && ui.selectedId && ui.selectedId !== syncedSel) {
    syncedSel = ui.selectedId;
    const c = contacts.find((x) => x.id === ui.selectedId || (x.ids || []).includes(ui.selectedId));
    if (c && c.key !== selKey) { selKey = c.key; store.set(SEL_KEY, selKey); markSeen(c); }
  }
  const noBots = !contacts.some((x) => x.kind === 'bot');
  // the rows as drawn: teams with their members under them (folded ones without), a search's matches flat
  let nodes;
  try { nodes = query ? contacts.filter((c) => matches(c, query)).map((c) => ({ c, depth: 0, parent: null, path: [] })) : contactTree(contacts, folded); }
  catch (e) { console.error('chats: tree', e); nodes = contacts.map((c) => ({ c, depth: 0, parent: null, path: [] })); }
  if (!(drag && drag.on)) {
    el._shown = nodes.map((x) => x.c);
    morphHTML(el._list, listHtml(state, nodes, now, noBots));
  }

  const c = contacts.find((x) => x.key === selKey) || null;
  // the open chat stays read: new activity in it is not "unread"
  if (c && !form && (!el.classList.contains('ch-narrow') || open)) markSeen(c);
  el._cur = form ? null : c;
  const narrow = el.classList.contains('ch-narrow');
  el.classList.toggle('ch-open', narrow && open && (!!c || !!form));
  if (!c && !form) open = false;

  // Edit bot for a bot that is gone (removed elsewhere): it closes
  if (form && form.mode === 'edit' && !botOf(state, form.botId)) form = null;
  // + New bot and Edit bot: the form in place of the chat
  el._form.hidden = !form;
  if (form) {
    for (const x of [el._head, el._chat, el._team, el._bot, el._blank, el._tasks]) x.hidden = true;
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
  el._team.hidden = !team;
  drawTasks(el, state, c);
  el._blank.hidden = !!(s || team || off);
  if (off) { drawHead(el, state, c, s); drawBot(el, state, c, s, !narrow || open); return; }
  if (!s && !team) { setHTML(el._blank, blankHtml(state, c, noBots)); if (c) drawHead(el, state, c, null); return; }
  drawHead(el, state, c, s);
  if (team) { drawTeam(el, state, c); return; }
  renderChatPane(el._chat, s, { visible: !narrow || open, bubbles: true, history: historyOf(state, c) });
  drawTyping(el, c, s);
}
