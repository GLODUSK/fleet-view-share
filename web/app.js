// Fleet View web shell: polls GET /state once a second and draws the Cards, Map, Wall, Projects or Bots view (its id,
// in settings.view, ?view= and the code, is still 'chats').
//
// ---- the ui object (third argument of renderCards / renderWall / renderMap) ----
//   ui.selectedId          id of the picked conversation, or null
//   ui.setSelected(id, how) pick a conversation (null picks nothing); the current view redraws at once.
//                          how: 'click' (default) or 'keys' (arrow moves). In the desktop window a click also
//                          starts the conversation's live session in the panel (a preview, term.js); keys don't.
//   ui.open(id)            desktop window: open the live session in the panel's Session tab, kept (Enter,
//                          double-click). Edge: open it in Windows Terminal; asks first unless it is DONE,
//                          then shows the server's reply as a toast
//   ui.openTerminal(id)    always a terminal window (the panel's "Open in terminal" button); on a page from another
//                          computer (remotePage) the live session here instead, since a terminal would open on the PC
//   ui.saveSettings(obj)   save any of { view, zoom, query, repo, repos, compact, steady, webBounds, notify, mapLens,
//                          mapViews, mapCamera } (POST /settings)
//   ui.keys                {}: a view may set ui.keys[viewName] = (KeyboardEvent) => boolean. While that view
//                          is shown, every key not taken by the shell goes to it first; return true when handled.
//                          The shell always handles: v / Tab (next view), / (filter), r (the workspace list),
//                          Esc (close filter, pick), Enter / o (open ui.selectedId), s (steady / live
//                          order), m (mini window, desktop only), i (the Bots view), Delete (remove the pick: see
//                          deleteKey), and, in Cards and Wall only, arrows/hjkl (pick) and c (compact). In the Map,
//                          arrows, + / -, 0, l and the mouse belong to map.js. In Projects and Bots the view's
//                          handler sees Enter and the arrows first (Bots also / and Esc).
//   ui.compact             read only: compact cards on/off
//   ui.showDetail(id, how) open the detail panel for that conversation (finished ones too); null closes it.
//                          how 'click' counts as a pick (see setSelected); without it, it only redraws.
//                          ui.setSelected(id) opens it as well, and setSelected(null) closes it.
//   ui.detailId            read only: the conversation the panel shows, or null
//   ui.pickBot(id), ui.botPick, ui.closeBotPanel()   a bot clicked on the Map (map-bots.js): the panel shows its chat
//                          as the Bots tab does (detail.js renderBotDetail, chats.js renderBotPanel) until a
//                          conversation is picked, the map is clicked, its ✕ or Esc; ui.botPick is that bot's id
//   ui.reveal({ kind: 'file'|'folder', path, line? })   POST /reveal: a file opens in VS Code, a folder in
//                          Explorer (the server only allows paths that are in /state); the reply shows as a toast.
//                          On a page from another computer those open on the PC's screen: the menus and the toast
//                          say "on the PC" there (onPc)
//   ui.openUrl(url)        opens an https:// URL (PR, branch, deploy) in the browser; anything else is ignored
//   ui.isHosted(id)        true while that conversation runs live in this window (desktop only, term.js); cards
//                          and the map mark it. The list is polled every 2 s and redraws the page when it changes.
//   ui.refresh()           redraw now
//   ui.contextMenu(target, clientX, clientY)   the right-click menu (ctxmenu.js) for { kind: 'session', id },
//                          { kind: 'repo', root, name?, color? }, { kind: 'sessions', ids } (a multi-selection of 2+),
//                          { kind: 'team', id } (state.teams) or { kind: 'conflict', id, kind2, label, sessions: [ids],
//                          rel? } (state.conflicts, or a file clash: kind2 'clash' with rel), { kind: 'file', rel, abs?, wrote, sid }
//                          or { kind: 'pr', num, url?, sid } (the map's file and PR dots); a session's or a team's may
//                          carry extra: [menu items] put on top (the Bots list's Pin / Unpin); the map calls it, cards /
//                          tiles / chips / the finished strip are caught by the page's own contextmenu listener
//   ui.setMulti(ids)       the map's multi-selection changed (Ctrl+click, Ctrl+drag): the shell keeps one list for
//                          every view and outlines those cards and tiles; the shell tells the map with map.js
//                          setMapSelection(ids). ui.multi: that list (read only). ui.toggleMulti(id) / ui.clearMulti():
//                          the cards' and tiles' Ctrl+click and plain click (cards.js wirePick); ui.selectMany(ids): their
//                          Shift+click (the range from the last card or tile clicked) and the Projects list's. Ctrl+A
//                          selects every conversation the current view shows (selectAllShown); ui.selectRepo(root): a
//                          double-click on a workspace (the map's repo, the Projects list's header) selects its
//                          conversations; a team's right-click menu has "Select all conversations"; Ctrl+click on a
//                          finished row adds it too
//   ui.takeTab(id)         detail.js: the panel tab asked for once ('details' from the menu), or null
//   ui.panel(id, tab)      the Projects and Bots views' Session / Details buttons: the side panel on that tab
//   ui.messageTeam(teamId, text)   the Bots view's group chat box: the same as the team menu's "Message the team"
//                          (every member not removed, each on its own, prefixed with the team's name). Returns null
//                          when it went off (a toast says how it went), else why it can't. ui.teamReach(teamId):
//                          that "why" before anything is written, or null
//   ui.makeTeam({ members, lead, name, order, above })   the Bots view's New team form: one team of those
//                          conversations (ids, 2 to ui.teamMax), led by lead (one of them) or of peers (null), sent the
//                          order the way the team menus' orders go (runOrder: POST /teams, the server types each brief),
//                          named name or "Bots · <the order's first words>"; above: a team id its lead then joins as a
//                          member (teams nest: POST /teams/add). -> Promise of { ok, team, message? } or { ok: false,
//                          message } (the server's reason when it refuses). ui.teamJoinWhy(id): why that conversation
//                          can't be in a team made from this window, or null. ui.teamItems(id): its menu's "Team ▸" row
//                          (a bot's right-click in the Bots list). ui.teamMax: the most a team has
//   ui.teamAdd(teamId, id, lead?), ui.teamLeave(teamId, id), ui.teamLead(teamId, id)   the Bots list's team groups
//                          (drag a bot onto a team or out of one, a member's right-click: chats.js): the team menus' own
//                          paths with their toasts (POST /teams/add, /teams/leave { why: 'removed' }, /teams/lead); id
//                          a conversation. A refusal before anything is sent (full, can't be reached here) is a toast too.
//                          -> a Promise that settles once the reply is in
//   ui.toast(text, tone?)  a toast (tone 'bad': red, 'ok': green, else plain), for what a view says about its own action
//   ui.solo                read only: true on the Bots pop-out window's page (?solo=chats; see SOLO)
//   Links: any element with data-act="url" data-url="…", or data-act="reveal" data-kind="file|folder"
//   data-path="…" [data-line="n"], or data-act="session" data-id="…" (another conversation: the handoff
//   lines), opens on click anywhere on the page, before the card or tile under it sees the click (cards.js has
//   urlLink / revealLink / sessionLink to write them).
//
// ---- the state a view gets ----
// The /state JSON with the shell's filters applied: state.sessions holds only the shown conversations
// (workspace filter, / filter, DONE hidden), most urgent first; state.clashes keeps the clashes with 2+ shown
// sessions and state.feed only their tool calls. In steady order (the default, key s) the conversations that
// need you come first (ASKING, QUESTION, ERROR, STALLED, then longest waiting) and the rest keep the order they
// first appeared in; in live order everything is sorted by today's activity. state.allSessions and state.allClashes are unfiltered.
// The overseers (the bots: /state tags them bot) are in no list but allSessions: only Bots shows them.
// state.settings.zoom is the saved map zoom.
//
// Test without the server: ?fixture=1 loads ./fixtures/state-sample.json (timestamps moved to now);
// ?view=cards|map|wall|projects|chats picks the starting view; ?select=<id> picks that conversation and opens its panel.
// ?solo=chats is the Bots pop-out window's page (SOLO): only the Bots view, filling the window under its own
// small header (chats.js); no other views, no view switching or saving, no desktop notifications, mini view,
// "Since you looked", usage heads-ups, update pill, housekeeping, remote-access asks or saved window bounds, and
// no restored or pinned panel (those are the main window's). It still polls /state as usual.
// ?fixture=1&fakeTerm=1 also installs a fake live-session host (term.js) that echoes what you type, to test the
// Session tab without the desktop window; without fixture=1 the query does nothing.
// window.fvSelect(id) does the same from outside (the desktop mini window): it keeps the current view, picks
// the conversation, opens its panel and scrolls its card or tile into view.
// With ?fixture=1 or ?debug=1, window.__mapNodes() lists the map's nodes with their client positions and
// window.__fv exposes the shell's state for tests (with ?fixture=1, POSTs are recorded in window.__fvPosts).
//
// Right-click (ctxmenu.js): a repo (map anchor, repo chip) offers New session · A / B (desktop window), Give orders ▸,
// Open folder, Show ▸ (only it / too), Workspace settings ▸ (Rename, Colour, Push to, Never continue on another machine…), its
// removed conversations and Remove workspace; a conversation offers Remove (ends it if hosted here and takes it off the map; was End session / Hide from map),
// Send elsewhere ▸ (the other accounts), Rename (renameMenuItem) and Move to workspace (moveMenuItem). A repo also offers "Removed conversations"
// (a submenu of state.removed, all of them): each one's own ▸ has Continue (see continueConversation), Show again
// (un-hidden, nothing starts) and Forget (off the list for good: settings.forgotten), and the top of it "Show all
// again", "Continue all" and "Forget all" (one Undo each but Continue). A repo also offers "Remove repo", and
// empty space "Add workspace", "Removed workspaces ▸" (every removed repo, to add one back) and "Removed
// conversations ▸" (every removed conversation, its workspace in the note, those with none too). A repo's "Never continue
// on another machine…" (in Workspace settings) opens keeps.js's sheet for its stays-on rule (settings.hostRules): the
// chats it pins stay on that machine (no chat moves between machines anyway, Henry 2026-10-17). The browser's own menu
// is kept only in text inputs and the live terminal (and in Edge outside those targets).
// Bots on the map: empty space on the map has "Add bot ▸", a bot's mascot its own menu (watch a conversation with a
// job, its watches, Open chat, Start, Remove bot) and a conversation "Have a bot watch it ▸" (see "bots on the map").
//
// New sessions (term.js createSession) are listed in state.pending (and state.allSessions) as stand-ins
// { id: 'new-<n>' or its id, pending: true, name: 'new session', state: 'NEW', repo, account, cwd } until
// /state lists the conversation; the map draws them, the panel shows their Session tab. A session here that
// handed off is the same: its pickup runs under the old conversation's key, is re-keyed to the new id (onRekey
// moves the pick and the panel), and until /state lists it the old conversation's PICKING UP stand-in goes by that
// id (handoffView), so it stays one entry in its place, never a 'new session' beside it. One that had turns
// and aged off /state since (state.aged) is not new: no stand-in, it is off the map like any quiet conversation.
//
// One repo list for every view: the workspace list, the map's repo anchors (view.repoAnchors; a listed repo with no
// conversation in view still gets its anchor and territory) and the repos the cards, wall and strip show.
// The workspaces shown (a filter): every one until one is picked. "Show workspace ▸", the first item on empty space's
// right-click (the map, around the cards or tiles, the Projects list; never in Bots, which no workspace filters),
// lists All workspaces, then every active one (live conversations; settings.repoOrder first, then the busiest, no
// workspace last), each with its live count and a check on the shown one(s); a click shows only that one. A repo's
// right-click has "Show only this workspace", and while some are shown "Show it too" / "Stop showing it" for several at
// once. While a filter is on, a chip right of the view tabs names it (a colour dot each, then shownTitle(): one name,
// "A + B" or "3 workspaces"): its × shows every workspace again, a click on it opens the same list under it, and so
// does the r key under the tabs. Saved as settings.repos (2+ roots) with settings.repo its first, so an older page or
// server shows that one (shownSel, inRepo).
// Removing a repo ("Remove workspace" on a repo's right-click in any view, or Delete on a repo picked on the map;
// settings.hiddenRepos, [{ root, at }], POST /settings) takes it and its conversations out of every view: the workspace
// list, its map anchor, territory and nodes, the cards, wall tiles and the finished strip. "Undo" stays on a toast for
// 6 s. One comes back by itself when a conversation in it works after `at` (the server drops it from the list; the
// page follows). Removing the shown repo switches to All workspaces. Removing one with live (not DONE) conversations
// asks first, naming how many (askRemoveRepos); the rest go straight away. "Removed workspaces ▸" on empty space's
// right-click (only while there are some) lists every removed repo, newest first, each added back with a click (like
// "Add workspace"), then "Add back all" and "Clear list" (forgets them: off hiddenRepos, one Undo; the ones with recent
// conversations are kept, since the server would list them again at once; the rest come back on their own only when
// they work again).
// Renaming a workspace: "Rename" on its right-click (map hub, repo chip) names it in Fleet View only
// (settings.repoNames, [{ root, name }]; the folder stays as it is); the name shows wherever its folder's name would
// (repoName, applyRepoNames on /state's names); an empty name goes back to the folder's. One Undo.
// Adding a repo ("Add workspace ▸" on empty space's right-click) offers three ways: "Path" (a path box; quotes
// around a pasted path are dropped, forward slashes are fine), "New scratchpad" (POST /repos/scratch: the server makes
// an empty scratch-YYYY-MM-DD folder under ~/Scratchpads and adds it) and "Browse" (the Windows folder dialog in the
// desktop window, elsewhere pcfiles.js's in-page one over GET /folders: the PC's folders, the same on this PC's Edge
// and on the Mac). POST /repos/add checks the folder and stores its git root in settings.addedRepos, and /state lists
// it in repos[] (added: true) even with no conversations. Removing an added repo also drops it from addedRepos (POST
// /repos/remove; Undo adds it back).
// Hidden conversations (settings.hidden, [{ id, at }], POST /settings) are left out of every view and the
// finished strip until they work again: a state other than DONE / QUESTION with activity after `at`, which
// also drops them from the list. The strip's "Clear all" removes every row in it at once (one Undo).
//
// Map command center (the shell's side; map.js, map-overlay.js and replay.js draw the rest):
// - Orders (orders.js, through the live sessions of term.js, never a headless claude): a repo's right-click menu
//   (map hub, repo chips) has "Give orders ▸": Send to each (one text to every conversation in
//   it, no team), Work together (one team of peers, POST /teams, so each gets its teammates' ids and the fv send
//   command), Under a lead ▸ ("<name> leads" per conversation, "A new conversation leads": one team whose lead
//   gets the order and directs the others, who report to it; POST /teams { lead }), then Model, Effort, Fast mode.
//   A multi-selection's menu has "Give orders ▸" (Work together, Under a lead ▸, Send to each, Model, Effort, Fast
//   mode), "Add to team ▸", the single conversation's actions for each of them ("Fork each", "Move to workspace ▸",
//   "Send elsewhere ▸", "Push to ▸", "Cancel N waiting orders"; one toast each, one Undo for a
//   move or push, new sessions left out), "Interrupt all", "Open all here", "Clear selection" and "Remove N conversations"; a
//   team's has "Message the team", "Lead ▸" (who leads, or No lead: POST /teams/lead), "Rename team" (POST
//   /teams/rename: notes and orders from then on carry the new name; nobody is told), "Add <picked>", "Remove
//   member ▸", "Pick <member>" and "Disband team"; a conflict's or clash's has "Send a note to all" (prefilled by
//   kind), "Open the file in VS Code", "Pick" and "Interrupt" per conversation; one conversation's gains "Add to
//   team ▸", "Lead team ▸" (lead its own team, or join another as its lead) and, in a team, 'Team "<name>" ▸'
//   (Message the team, Lead ▸, Rename team, Leave team, Disband team). The server tells the members what changed (see the teams
//   section); Remove takes a conversation out of its team.
// - Replay: window 'fv-replay' { on, state } from the map overlay (see the replay section below).
// - "Since you looked" (since.js): key w, the header's clock button, and by itself after 30+ min away.
// - Desktop notifications for new state.alerts (settings.notify; see notifyAlerts).

import { renderCards } from './cards.js';
import { renderWall } from './wall.js';
import { renderProjects, followProjectsPick } from './projects.js';
import { renderChats, renderBotPanel, botTeams, botFace, seenNow, setPickedColors, setColorItem, selectChat } from './chats.js';
import { BOT_JOBS, jobLabel, ownBots, onMap, watchesOf, botMascot, botName, watchName } from './map-bots.js';
import { buildContacts } from './chats-model.js';
// the New team form's rules (a team's size, its lead, a name cleaned, the checks before Make team sends), shared with
// web/chats.js and the phone app; leadOf(t): a team's lead (★), its conversation id, or null (a team of peers)
import { TEAM_MAX, leadOf, cleanName, checkTeam, nestStep, nestFailed } from './team-form.js';
import { mountBotNotes } from './botnote.js';
import { renderDetail, renderBotDetail, openPeek, shownTab, SPLIT_MAX } from './detail.js';
import { setChatLookup } from './chat.js';
import { C, esc, needsYou, ago, fmtCost, acctTag, acctColor, isAcct, repoChip, clockTime, isHttps, setAccounts, singleAccount } from './cards.js';
import { watchHosts, isHosted, installFakeTerm, termApi, hosts, createSession, endSession, hostStatus, onRekey, openElsewhere, isNewKey, sendToAccount, ensureLive, interruptSession, sendText, screenText, screenMarked, screenReady, noTermMsg, noTermNote, setAccountPicker } from './term.js';
import { pickFolder, canPickFolder, uploads, upload, sizeText, droppedFolders } from './pcfiles.js';
import { openCtxMenu, closeCtxMenu, ctxMenuOpen } from './ctxmenu.js';
import { sendOrder, sendEach, sendNote, summary as orderSummary, firstWords, unreachable, handedOff, onQueueDone, queuedFor, cancelQueued, onTeamJoin, setServerQueued, sendWhenUp } from './orders.js';
import { mountSince, sinceFromState } from './since.js';
import { mountUpdate } from './update.js';
import { mountUsage } from './usage.js';
import { mountSync } from './sync.js';
import { mountClone, cloneWorkspaceItem } from './clone.js';
import { mountSetup } from './setup.js';
import { mountPhone } from './phone.js';
import { mountHousekeeping } from './housekeeping.js';
import { MODEL_IDS, EFFORTS, MENU_ROWS, modelLabel, parseMenu, parsePromptBox, parseSpinner, saveImage, messageText, setLaunchDefaults } from './compose.js';
import { forkAt } from './forkat.js';
import { handToChat } from './handto.js';
import { openKeeps, setRules } from './keeps.js';
import { mainMachine } from './main-machine.js';

const VIEWS = ['cards', 'map', 'wall', 'projects', 'chats'];
// the views the tabs offer: Cards, Map, Wall, Projects, Bots (Henry, 2026-10-11: Map and Projects tabs back after #260)
const TAB_VIEWS = ['cards', 'map', 'wall', 'projects', 'chats'];
const params = new URLSearchParams(location.search);
const SOLO = params.get('solo') === 'chats';
const FIXTURE = params.has('fixture');
const DEBUG = FIXTURE || params.has('debug');
const $ = (id) => document.getElementById(id);
if (FIXTURE && params.has('fakeTerm')) installFakeTerm();

// icons for the header pills and toasts; the page works without them (no icons) if icons.js is missing
let icon = () => '', iconsReady = false;
import('./icons.js').then((m) => { if (typeof m.icon === 'function') { icon = m.icon; iconsReady = true; fillStaticIcons(); render(); } }).catch(() => {});
// static markup (the view tabs in index.html) names its icon in data-icon; fill them in once icons.js is here
function fillStaticIcons() {
  for (const el of document.querySelectorAll('[data-icon]')) if (!el.firstChild) el.innerHTML = icon(el.dataset.icon, 14);
  tabPos = ''; fitHeader(true); // the tabs just got wider
}

let renderMap = null, mapRekey = null, mapMod = null;
let mapMissing = false;
import('./map.js').then((m) => {
  mapMod = m;
  renderMap = m.renderMap;
  mapRekey = m.rekeyNode || null;
  if (DEBUG) window.__mapNodes = () => m.mapNodes();
  render();
}).catch((e) => { mapMissing = true; console.warn('map.js did not load', e); render(); });

// ---------- settings ----------
const local = { view: SOLO ? 'chats' : VIEWS.includes(params.get('view')) ? params.get('view') : 'cards', zoom: 1, query: '', repo: null, repos: null, compact: false, finishedOpen: true, steady: true, notify: true };
let settingsLoaded = false;
let pendingSave = {}, saveTimer = null;

if (FIXTURE) window.__fvPosts = [];
function post(url, body, keepalive = false) {
  if (FIXTURE) { window.__fvPosts.push({ url, body: JSON.parse(JSON.stringify(body)) }); return Promise.resolve(null); }
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive })
    .then((r) => r.json()).catch(() => null);
}
// <group>Ops keys (single-item changes: hiddenReposOps, repoNamesOps, mapSpotsOps) add to the ones still waiting
// instead of replacing them
function saveSettings(obj) {
  for (const k of Object.keys(obj)) if (k.endsWith('Ops') && Array.isArray(obj[k]) && Array.isArray(pendingSave[k])) obj = { ...obj, [k]: [...pendingSave[k], ...obj[k]] };
  Object.assign(pendingSave, obj);
  for (const k of ['view', 'zoom', 'query', 'repo', 'repos', 'compact', 'finishedOpen', 'steady', 'notify']) if (k in obj) local[k] = obj[k];
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
// the Projects and Bots views show the chat themselves, so the panel opens there only when asked (ui.panel)
let projPanel = false;
// the panel pinned open (its pin button, detail.js): it still shows whatever conversation you pick, but no Esc,
// empty click or view switch closes it; it keeps the last one until you pick another. Its pin again lets go.
// The Projects and Bots views still hide it (pinned or not) unless asked there; it comes back on the other views.
// Kept in this browser's storage across reloads.
let pinned = false;
try { pinned = localStorage.getItem('fv.pin') === '1'; } catch {}
function setPin(on) {
  pinned = !!on;
  try { if (pinned) localStorage.setItem('fv.pin', '1'); else localStorage.removeItem('fv.pin'); } catch {}
}
// split chats pinned by their own pin (detail.js cell bars): they stay under the panel's chat when the selection
// clears or changes, until their pin or ✕ lets go. At most SPLIT_MAX - 1 (the oldest goes); kept like the pin.
let splitPins = [];
try { splitPins = JSON.parse(localStorage.getItem('fv.splitPins') || '[]').filter((x) => typeof x === 'string' && x).slice(-(SPLIT_MAX - 1)); } catch {}
function setSplitPins(ids) {
  splitPins = [...new Set(ids)].slice(-(SPLIT_MAX - 1));
  try { if (splitPins.length) localStorage.setItem('fv.splitPins', JSON.stringify(splitPins)); else localStorage.removeItem('fv.splitPins'); } catch {}
}
const intentOf = (how) => (how === 'keys' ? 'keys' : how === 'explicit' ? 'explicit' : how ? 'preview' : null);
const ui = {
  selectedId: null,
  detailId: null,
  // the bot picked on the Map (map-bots.js): the side panel shows its chat as the Bots tab does (drawDetail)
  botPick: null,
  // how: 'click' (the default: cards, tiles, map nodes), 'keys' (arrow-key moves), 'explicit'
  setSelected(id, how = 'click') {
    if (id || !pinned) ui.botPick = null;
    ui.selectedId = id || null;
    ui.detailId = id || (pinned ? ui.detailId : null);
    pickIntent = id ? { id, kind: intentOf(how) } : null;
    render();
    if (id && local.view !== 'map') document.querySelector(`#view-${local.view} [data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
  },
  // how: none for a redraw of the panel (its own tab buttons), 'click' when a conversation is picked
  showDetail(id, how = null) {
    if (id || !pinned) ui.botPick = null;
    if (pinned && !id) id = ui.detailId;
    ui.detailId = id || null;
    if (!id) projPanel = false;
    pickIntent = id && how ? { id, kind: intentOf(how) } : null;
    render();
  },
  // the Projects view's Session / Details buttons: the side panel on that tab (it stays shut there otherwise).
  // The button of the tab already showing closes it again (Henry, 2026-10-11: "if i click it twice it dissapears")
  panel(id, tab) {
    if (ui.panelTab(id) === tab) { projPanel = false; render(); return; }
    tabWant = { id, tab };
    projPanel = true;
    ui.showDetail(id);
  },
  // the tab the side panel shows for that conversation in the Projects and Bots views, or null while it is shut there
  panelTab(id) {
    const t = projPanel ? shownTab($('detail')) : null;
    return t && t.id === id ? t.tab : null;
  },
  // the view shows the conversation's chat itself (Projects, Bots): the panel there has no Chat tab (detail.js)
  chatInView: () => local.view === 'projects' || local.view === 'chats',
  pinned: () => pinned,
  // the panel's pin button: keeps the panel open, or lets it close again
  togglePin() {
    setPin(!pinned);
    render();
  },
  splitPinned: (id) => splitPins.includes(id),
  // a split chat's pin: keeps it in the panel after the selection goes, or lets it go with the selection
  toggleSplitPin(id) {
    setSplitPins(splitPins.includes(id) ? splitPins.filter((x) => x !== id) : splitPins.concat(id));
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
  // the map's bots (map-bots.js): a bot dragged to a spot (world units), dropped on a conversation, double-clicked
  placeBot: (id, x, y) => placeBot(id, { x, y }),
  watchBot: (id, convId, job) => watchBot(id, convId, job),
  openBotChat: (id) => openBotChat(id),
  // a bot clicked on the map: its chat in the side panel (a click on it again leaves it there)
  pickBot(id) {
    if (!botById(id)) return;
    if (multi.size) setMulti([], 'shell');
    ui.selectedId = null;
    if (ui.botPick !== id) botFocus = true;
    ui.botPick = id;
    render();
  },
  // the bot chat's ✕ in the side panel (chats.js renderBotPanel), and Esc on the map
  closeBotPanel() {
    if (!ui.botPick) return;
    ui.botPick = null;
    if (!pinned) ui.detailId = null;
    render();
  },
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
    if (!termApi()) {
      // another computer: a terminal window would open on the PC's screen, not here
      if (remotePage()) { toast(noTermMsg('Opening its live session'), C.red); return; }
      openSession(id);
      return;
    }
    const s = state?.sessions?.find((x) => x.id === id) || view?.allSessions?.find((x) => x.id === id && x.continued);
    if (!s) return;
    if (s.state === 'DONE') { ui.selectedId = null; ui.showDetail(s.id, 'explicit'); } else ui.setSelected(s.id, 'explicit');
  },
  openTerminal: (id) => {
    if (!remotePage()) { openSession(id); return; }
    if (termApi()) ui.open(id); else toast(noTermMsg('Opening its live session'), C.red);
  },
  saveSettings,
  keys: {},
  get compact() { return local.compact; },
  isHosted: (id) => isHosted(id),
  refresh: () => render(),
  // the multi-selection (Ctrl+click on cards, tiles or map nodes; Ctrl+drag on the map): the map calls
  // setMulti(ids) when its selection changes; ui.multi is the current list (read only)
  // (a first Ctrl+click there takes the panel's chat along, as on the cards: tell the map the list it grew to)
  setMulti: (ids) => { const w = withShown(ids); setMulti(w, w === ids ? 'map' : 'shell'); },
  get multi() { return [...multi]; },
  toggleMulti: (id) => toggleMulti(id),
  selectMany: (ids) => setMulti(ids, 'cards'),
  // the right-click menu is open: the map keeps its hover tooltip hidden meanwhile
  menuOpen: () => ctxMenuOpen(),
  // the Bots view's group chat: as the team menu's "Message the team" (teamMenuItems)
  teamReach: (id) => teamReach(teamById(id)),
  messageTeam: (id, text) => {
    const t = teamById(id), why = teamReach(t);
    if (why) return why;
    if (!String(text || '').trim()) return 'write it first';
    runOrder(teamMembers(t), String(text), teamMsgOpts(t));
    return null;
  },
  // the Bots view's New team form and a bot's right-click (chats.js): the team menus' own paths
  makeTeam: (o) => makeTeam(o || {}),
  teamJoinWhy: (id) => { const s = sessionsOf([id])[0]; return s ? memberWhy(s) : 'Fleet View does not list its conversation'; },
  teamItems: (id) => { const s = sessionsOf([id])[0]; return s ? teamItems(s) : []; },
  get teamMax() { return TEAM_MAX; },
  // the Bots list's team groups (chats.js): a member put in, taken out, made the lead, as the team menus do it
  teamAdd: async (teamId, id, lead = false) => {
    const t = teamById(teamId), s = sessionsOf([id])[0];
    const why = !t ? 'that team is gone' : !s ? 'Fleet View does not list its conversation' : joinWhy(s, t);
    if (why) { toast(why, C.red); return; }
    await addToTeam(t, s, !!lead);
  },
  teamLeave: async (teamId, id) => {
    const t = teamById(teamId);
    if (!t) { toast('that team is gone', C.red); return; }
    await leaveTeam(t, sessionsOf([id])[0] || { id, name: nameOfId(id) }, 'removed');
  },
  teamLead: async (teamId, id) => {
    const t = teamById(teamId), s = sessionsOf([id])[0];
    if (!t || !s) { toast(!t ? 'that team is gone' : 'Fleet View does not list its conversation', C.red); return; }
    await setLead(t, s);
  },
  toast: (text, tone) => toast(String(text || ''), tone === 'bad' ? C.red : tone === 'ok' ? C.mint : C.dim),
  solo: SOLO,
};

// ---------- polling ----------
let state = null; // last good /state
let online = false;
let pageBuild = null; // the server's code version this page was loaded with
// the reload for new page code keeps the picked conversation and its open chat (this tab's storage, read once).
// The window restarting for an update (a new tab storage) finds the same in localStorage, written as the page goes,
// for a minute; compose.js puts the cursor back in the box that had it (fv.typing).
const REOPEN_MS = 60e3;
function keepPickForReload() {
  try { sessionStorage.setItem('fv.reopen', JSON.stringify({ sel: ui.selectedId, detail: ui.detailId })); } catch {}
}
window.addEventListener('pagehide', () => {
  try { localStorage.setItem('fv.reopen', JSON.stringify({ sel: ui.selectedId, detail: ui.detailId, at: Date.now() })); } catch {}
});
function restorePickAfterReload() {
  let r = null, w = null;
  try { r = JSON.parse(sessionStorage.getItem('fv.reopen') || 'null'); sessionStorage.removeItem('fv.reopen'); } catch {}
  try { w = JSON.parse(localStorage.getItem('fv.reopen') || 'null'); localStorage.removeItem('fv.reopen'); } catch {}
  if (!r && w && Date.now() - Number(w.at) < REOPEN_MS) r = w;
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
  for (const f of st.finished || []) { f.endedAt = sh(f.endedAt); f.shownAgain = sh(f.shownAgain); }
  for (const r of st.removed || []) { r.removedAt = sh(r.removedAt); r.lastActive = sh(r.lastActive); }
  for (const r of st.leftMap || []) { r.leftAt = sh(r.leftAt); r.lastActive = sh(r.lastActive); }
  for (const e of st.feed || []) e.t = sh(e.t);
  for (const a of st.alerts || []) a.t = sh(a.t);
  for (const t of st.teams || []) { t.at = sh(t.at); for (const m of t.messages || []) m.t = sh(m.t); }
  for (const b of st.bots || []) {
    b.createdAt = sh(b.createdAt);
    // its tasks' runs (bots.js tasks); a schedule's own times are wall-clock times and stay as they are
    for (const t of b.tasks || []) { t.nextRun = sh(t.nextRun); t.lastRun = sh(t.lastRun); for (const r of t.runs || []) r.at = sh(r.at); }
    for (const w of b.watches || []) { w.since = sh(w.since); if (w.last) w.last.at = sh(w.last.at); }
  }
  for (const x of st.deploys || []) { x.createdAt = sh(x.createdAt); x.readyAt = sh(x.readyAt); }
  for (const w of st.worktrees || []) w.lastCommit = sh(w.lastCommit);
  for (const h of st.settings?.hidden || []) if (h && typeof h === 'object') h.at = sh(h.at);
  return st;
}

let usageUi = null; // usage.js: the plan-usage card and the "used somewhere else" heads-up (mounted below)
// /state comes with an ETag; the next poll sends it back and gets 304 with no body while nothing changed (nothing to
// read or draw then). A browser on another device that is no longer approved gets 401: back to the pairing page.
let stateTag = null;
// new page code: the reload waits for a pause in typing (TYPING_PAUSE_MS with no key or input in a text field), so
// no keystroke lands in the blink; the box saves its text on the way out and takes the cursor back after
const TYPING_PAUSE_MS = 1500;
let lastTypedAt = 0, reloadDue = false;
const noteTyping = (e) => { if (e.target?.closest?.('textarea, input, [contenteditable]')) lastTypedAt = Date.now(); };
document.addEventListener('keydown', noteTyping, true);
document.addEventListener('input', noteTyping, true);
function reloadForUpdate() {
  if (reloadDue) return;
  reloadDue = true;
  const go = () => {
    const quiet = Date.now() - lastTypedAt;
    if (quiet < TYPING_PAUSE_MS) { setTimeout(go, TYPING_PAUSE_MS - quiet + 50); return; }
    flushSettings(); keepPickForReload(); location.reload();
  };
  go();
}
// ---------- the /state loop ----------
// One loop reads /state, with at most one request in flight. pollSoon(ms) asks for a read within ms (the earlier
// time wins); asked while one is in flight, another runs right after it. The loop always books its next turn, also
// when the fetch or the drawing throws, and backs off while the server is away (1 s, 2 s, 4 s, then every 5 s).
// window.fvHealth says how it goes, for a look from the console or a test.
const fvHealth = window.fvHealth = { polls: 0, lastPollAt: 0, lastPollOk: 0, fails: 0, lastFail: null, errors: 0, lastError: null, steps: {} };
const loggedErr = new Map(); // step -> the last message logged for it, so an error that repeats every second logs once
function noteError(where, e) {
  const message = String((e && (e.stack || e.message)) || e);
  fvHealth.errors++;
  fvHealth.steps[where] = (fvHealth.steps[where] || 0) + 1;
  fvHealth.lastError = { where, message, at: Date.now() };
  if (loggedErr.get(where) !== message) { loggedErr.set(where, message); console.error(`[fv] ${where}:`, e); }
}
// one step of reading or drawing the state: a throw is logged and counted, and the steps after it still run
function step(where, fn) {
  try { return fn(); } catch (e) { noteError(where, e); }
}
let pollTimer = null, pollAt = 0, polling = false, pollAgain = false, pollStopped = false;
function pollSoon(ms = 0) {
  if (pollStopped) return;
  if (polling) { pollAgain = true; return; }
  const at = Date.now() + ms;
  if (pollTimer && pollAt <= at) return;
  clearTimeout(pollTimer);
  pollAt = at;
  pollTimer = setTimeout(runPoll, ms);
}
async function runPoll() {
  pollTimer = null;
  polling = true;
  pollAgain = false;
  let wait = 1000;
  try {
    const ok = await poll();
    fvHealth.polls++;
    fvHealth.lastPollAt = Date.now();
    if (ok === 'stop') pollStopped = true;
    else if (ok) { fvHealth.fails = 0; fvHealth.lastPollOk = Date.now(); }
    else wait = Math.min(5000, 1000 * 2 ** fvHealth.fails++);
  } catch (e) {
    noteError('poll', e);
  } finally {
    polling = false;
    pollSoon(pollAgain ? 100 : wait);
  }
}
// one read of /state: true when it was read (and drawn), false when the server could not be reached, 'stop' when the
// page is leaving (new page code, or this browser is no longer approved)
async function poll() {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 4000);
  let r, st = null;
  try {
    r = await fetch(FIXTURE ? './fixtures/state-sample.json' : '/state', { cache: 'no-store', signal: ctl.signal, headers: stateTag && state && !FIXTURE ? { 'If-None-Match': stateTag } : {} });
    if (r.status === 401 && !FIXTURE) { location.replace('/pair'); return 'stop'; }
    if (!(r.status === 304 && state)) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      st = await r.json();
    }
  } catch (e) {
    fvHealth.lastFail = { message: String((e && e.message) || e), at: Date.now() };
    online = false;
    render();
    return false;
  } finally {
    clearTimeout(timer);
  }
  // unchanged: drawn already, unless the page was showing "reconnecting…"
  if (!st) {
    const was = online;
    online = true;
    if (!was) render();
    return true;
  }
  if (FIXTURE) st = rebase(st);
  // new page code on the server (a merge changed web/ or fleet-view.js): load it, settings saved first. Checked before
  // anything reads the state, so a state the old code chokes on can't keep the new code from loading
  if (st.build) {
    if (!pageBuild) pageBuild = st.build;
    else if (st.build !== pageBuild) { reloadForUpdate(); return 'stop'; }
  }
  online = true;
  const errors = fvHealth.errors;
  step('bot edits', () => applyBotEdits(st));
  step('renames', () => applyRenames(st));
  state = st;
  step('launch defaults', () => setLaunchDefaults(st.launch));
  step('queued text', () => setServerQueued(st.queuedText));
  step('settings', () => {
    if (st.settings) syncHiddenRepos(st.settings.hiddenRepos);
    if (st.settings) syncRepoPrefs(st.settings);
    if (st.settings) setRules(st.settings.hostRules);
  });
  step('repo names', () => applyRepoNames(st));
  step('hidden', () => {
    if (st.settings && Array.isArray(st.settings.offAccounts) && !('offAccounts' in pendingSave) && Date.now() - offSentAt > 3000) offAccts = st.settings.offAccounts.filter(isAcct);
    if (st.settings) adoptSyncedHidden(st.settings);
    if (settingsLoaded && st.settings) mergeServerHidden(st.settings.hidden);
    if (st.settings) syncForgotten(st.settings.forgotten);
  });
  // after offAccts: with one account on, no letter tags, as with one account (Henry, 2026-10-15)
  step('accounts', () => setAccounts(onAccounts()));
  step('first settings', () => {
    if (!settingsLoaded && st.settings) {
      settingsLoaded = true;
      const s = st.settings;
      if (!SOLO && !params.has('view') && TAB_VIEWS.includes(s.view)) local.view = s.view;
      if (s.zoom > 0) local.zoom = s.zoom;
      if (typeof s.query === 'string') local.query = s.query;
      local.repo = typeof s.repo === 'string' ? s.repo : null;
      const several = Array.isArray(s.repos) ? s.repos.filter((x) => typeof x === 'string' && x) : [];
      local.repos = several.length >= 2 ? several : null;
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
  });
  if (pendingSelect) { const id = pendingSelect; pendingSelect = null; queueMicrotask(() => fvSelect(id)); }
  step('notify', () => notifyAlerts(st));
  step('bot notes', () => noteBots(st));
  step('usage', () => usageUi?.update(st));
  // its ETag only once all of it went in: after a step threw, the next read gets the whole state again, not a 304
  stateTag = fvHealth.errors === errors ? r.headers.get('ETag') : null;
  render();
  return true;
}

// ---------- filtering ----------
const normRoot = (p) => String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
// the home folder (state.home) is "no repo": where conversations sit until they work in a repo; listed last
const isHomeRoot = (root) => !!root && !!state?.home && normRoot(root) === normRoot(state.home);
const repoBase = (root) => (isHomeRoot(root) ? 'no workspace' : String(root || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'no workspace');
// the name a workspace shows: its name in Fleet View (Rename on its right-click, settings.repoNames), else its folder's
const repoNames = new Map(); // normRoot -> { root, name }
const repoName = (root) => repoNames.get(normRoot(root))?.name || repoBase(root);
// the workspaces shown (the workspace filter): several (settings.repos: "Show it too" on a repo's right-click), one
// (settings.repo: a root, or a bare folder name from --repo) or none (every workspace)
const shownSel = () => (Array.isArray(local.repos) && local.repos.length >= 2 ? local.repos : local.repo ? [local.repo] : []);
function selMatches(sel, repo) {
  if (/[\\/]/.test(sel)) return normRoot(repo.root) === normRoot(sel);
  return String(repo.root ? repoBase(repo.root) : repo.name || '').toLowerCase() === sel.toLowerCase();
}
function inRepo(repo) {
  const sel = shownSel();
  if (!sel.length) return true;
  if (!repo) return false;
  return sel.some((x) => selMatches(x, repo));
}
// what the header chip calls it: one workspace, "A + B", or "3 workspaces"
function shownTitle() {
  const sel = shownSel();
  if (!sel.length) return 'all workspaces';
  return sel.length === 1 ? repoName(sel[0]) : sel.length === 2 ? `${repoName(sel[0])} + ${repoName(sel[1])}` : `${sel.length} workspaces`;
}
// shows these (roots, or a bare name): several, one, or every workspace when empty; at most 50 (the server's limit)
function setShown(list) {
  const out = [], seen = new Set();
  for (const x of list || []) {
    const k = /[\\/]/.test(x) ? normRoot(x) : String(x).toLowerCase();
    if (x && !seen.has(k)) { seen.add(k); out.push(x); }
  }
  saveSettings({ repo: out[0] || null, repos: out.length >= 2 ? out.slice(0, 50) : null });
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
    added = true;
  }
  return added;
}
// Another device changed the list (sync-prefs.js: hidden, removed or shown again there): the server bumps
// settings.hiddenSync, and the page takes the server's list whole, drops included, once no save of its own waits
let hiddenSyncSeen = null;
function adoptSyncedHidden(s) {
  const n = s.hiddenSync;
  if (!Number.isFinite(n) || !Array.isArray(s.hidden)) return;
  if (!settingsLoaded || hiddenSyncSeen === null) { hiddenSyncSeen = n; return; } // the first /state loads it whole anyway
  if (n === hiddenSyncSeen || 'hidden' in pendingSave) return;
  hiddenSyncSeen = n;
  hidden.clear();
  for (const h of s.hidden) if (h && typeof h.id === 'string') hidden.set(h.id, Number(h.at) || Date.now());
  if (ui.selectedId && hidden.has(ui.selectedId)) ui.selectedId = null;
  if (ui.detailId && hidden.has(ui.detailId)) ui.detailId = null;
}
// removed ones taken off the Removed conversations list for good ("Forget"; settings.forgotten, ids still on hidden).
// The server's list wins, except while a change of ours may not have reached it yet (as hiddenRepos)
const forgotten = new Set();
let forgottenSentAt = 0;
function saveForgotten() {
  forgottenSentAt = Date.now();
  saveSettings({ forgotten: [...forgotten].filter((id) => hidden.has(id)).slice(-500) });
}
function syncForgotten(list) {
  if (!Array.isArray(list) || 'forgotten' in pendingSave || Date.now() - forgottenSentAt < 3000) return;
  forgotten.clear();
  for (const id of list) if (typeof id === 'string') forgotten.add(id);
}
function hideConversation(s, how = 'hidden') {
  hidden.set(s.id, Date.now());
  continued.delete(s.id);
  saveHidden();
  if (ui.selectedId === s.id) ui.selectedId = null;
  if (ui.detailId === s.id) ui.detailId = null;
  const undo = () => { if (hidden.has(s.id)) { unhide(s.id); saveHidden(); render(); } };
  toast(how === 'removed' ? `Removed ${s.name}. It comes back if it works again` : `${s.name} is hidden until it works again`, C.dim, { label: 'Undo', run: undo, ms: 6000 });
  render();
}

// ---------- repos taken off the list ----------
const hiddenRepos = new Map(); // normRoot -> { root, at }
let hiddenReposSentAt = 0;
// the server's list as last taken (normRoot -> { root, at }), with this page's own changes since: what its ops go against
let hiddenReposSeen = new Map();
// Only what changed here goes (settings.hiddenReposOps: { op: 'add', root, at } and { op: 'remove', root }), never the
// whole list: a whole list from a page that has not had the newest /state yet would take off what another device just
// removed, or put back what it brought back
function saveHiddenRepos() {
  hiddenReposSentAt = Date.now();
  const ops = [];
  for (const [k, h] of hiddenRepos) { const s = hiddenReposSeen.get(k); if (!s || s.at !== h.at) ops.push({ op: 'add', root: h.root, at: h.at }); }
  for (const [k, s] of hiddenReposSeen) if (!hiddenRepos.has(k)) ops.push({ op: 'remove', root: s.root });
  hiddenReposSeen = new Map([...hiddenRepos].map(([k, h]) => [k, { ...h }]));
  if (ops.length) saveSettings({ hiddenReposOps: ops });
}
// the server's list wins, except while a change of ours may not have reached it yet
function syncHiddenRepos(list) {
  if (!Array.isArray(list) || 'hiddenReposOps' in pendingSave || Date.now() - hiddenReposSentAt < 3000) return;
  hiddenRepos.clear();
  for (const h of list) if (h && typeof h.root === 'string') hiddenRepos.set(normRoot(h.root), { root: h.root, at: Number(h.at) || Date.now() });
  hiddenReposSeen = new Map([...hiddenRepos].map(([k, h]) => [k, { ...h }]));
}
// off the list, unless a conversation in it was given a prompt after it was taken off (turnStart: when its turn began,
// the server's promptAt), as the server's pruneHiddenRepos has it: one still replying from before (active, but its
// turn began earlier) does not bring it back
function repoIsHidden(root) {
  const k = normRoot(root), h = hiddenRepos.get(k);
  if (!h) return false;
  if ((state?.sessions || []).some((s) => s.repo && normRoot(s.repo.root) === k && (Number(s.turnStart) || 0) > h.at)) { hiddenRepos.delete(k); return false; }
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
// it: { root, name } from a map anchor or a repo chip (a checkout folder maps to its repo)
function removeRepo(it) { removeRepos([it]); }
// the repo root an item stands for: the listed one, else the repo of a checkout folder
function repoRootOf(it) {
  const listed = (state?.repos || []).find((r) => normRoot(r.root) === normRoot(it.root));
  return listed ? listed.root : repoForFolder(state || {}, it.root).root || it.root;
}
// one or several at once: one toast, one Undo for all of them. With live (not DONE) conversations in any of them it
// asks first, naming how many; else they go straight away
function removeRepos(list) { askRemoveRepos(list, () => dropRepos(list)); }
function askRemoveRepos(list, go) {
  const items = (list || []).filter((it) => it && it.root);
  const keys = new Set(items.map((it) => normRoot(repoRootOf(it))));
  const live = (state?.sessions || []).filter((s) => !s.pending && !s.bot && s.state !== 'DONE' && !hidden.has(s.id) && s.repo && keys.has(normRoot(s.repo.root)));
  if (!live.length) { go(); return; }
  const n = live.length, convs = n === 1 ? '1 live conversation' : `${n} live conversations`;
  const reposWith = new Set(live.map((s) => normRoot(s.repo.root))).size;
  const name = items.length === 1 ? (items[0].name && items[0].name !== 'All workspaces' ? items[0].name : repoName(items[0].root)) : '';
  const html = items.length === 1
    ? `<b>${esc(name)}</b> has ${convs}. Remove it from the list? ${n === 1 ? 'It leaves' : 'They leave'} every view too (nothing is ended); it comes back if one works again.`
    : `Remove ${keys.size} workspaces? ${reposWith === 1 ? 'One of them has' : `${reposWith} of them have`} ${convs}; ${n === 1 ? 'it leaves' : 'they leave'} every view too (nothing is ended).`;
  askConfirm(html, items.length === 1 ? 'Remove' : `Remove ${keys.size}`, go);
}
function dropRepos(list) {
  const done = [], seen = new Set(), prevSel = { repo: local.repo, repos: local.repos };
  let anyPicked = false;
  for (const it of list || []) {
    if (!it || !it.root) continue;
    const root = repoRootOf(it);
    const k = normRoot(root);
    if (seen.has(k)) continue;
    seen.add(k);
    const name = it.name && it.name !== 'All workspaces' ? it.name : repoName(root);
    const before = hiddenRepos.get(k);
    if (isCurrent({ root, name })) anyPicked = true;
    // an added repo leaves addedRepos for good (Undo adds it back)
    const wasAdded = !!(addedLocal.has(k) || (state?.repos || []).some((r) => r.added && normRoot(r.root) === k));
    const localAdd = addedLocal.get(k) || null;
    hiddenRepos.set(k, { root, at: Date.now() });
    if (wasAdded) { addedLocal.delete(k); post('/repos/remove', { root }); }
    done.push({ root, name, k, before, wasAdded, localAdd });
  }
  if (!done.length) return;
  saveHiddenRepos();
  // the shown ones it took leave the shown set; none left: every workspace
  const left = anyPicked ? shownSel().filter((x) => !done.some((d) => selMatches(x, { root: d.root, name: d.name }))) : null;
  if (anyPicked) { ui.selectedId = null; setShown(left); }
  const afterSel = JSON.stringify(shownSel());
  // their conversations leave every view, the panel too
  const inIt = (id) => { const s = id && view?.allSessions?.find((x) => x.id === id); return !!(s && s.repo && seen.has(normRoot(s.repo.root))); };
  if (inIt(ui.selectedId)) ui.selectedId = null;
  if (inIt(ui.detailId)) ui.detailId = null;
  const undo = () => {
    for (const d of done) {
      if (d.before) hiddenRepos.set(d.k, d.before); else hiddenRepos.delete(d.k);
      if (d.wasAdded) { addedLocal.set(d.k, d.localAdd || { root: d.root, name: d.name, at: Date.now() }); post('/repos/add', { path: d.root }); }
    }
    saveHiddenRepos();
    if (anyPicked && JSON.stringify(shownSel()) === afterSel) saveSettings(prevSel);
    render();
  };
  render();
  const what = done.length === 1 ? done[0].name : `${done.length} workspaces`;
  toast(`Removed ${what}${anyPicked && !left.length ? ' · showing every workspace' : ''}. ${done.length === 1 ? 'It comes' : 'Each comes'} back if it works again`, C.dim, { label: 'Undo', run: undo, ms: 6000 });
}

// ---------- renaming a workspace ----------
// "Rename" on a workspace's right-click (a map hub, a repo chip): the name it shows in every view (the workspace
// list, the map, cards, the header chip) instead of its folder's; nothing on disk changes. settings.repoNames
// ([{ root, name }], at most 200); an empty name (or the folder's own) goes back to the folder's name.
let repoNamesSentAt = 0;
// the server's names as last taken, with this page's own changes since (as hiddenReposSeen)
let repoNamesSeen = new Map();
// only the names changed here go (settings.repoNamesOps: { op: 'add', root, name } and { op: 'remove', root })
function saveRepoNames() {
  repoNamesSentAt = Date.now();
  const ops = [];
  for (const [k, r] of repoNames) { const s = repoNamesSeen.get(k); if (!s || s.name !== r.name) ops.push({ op: 'add', root: r.root, name: r.name }); }
  for (const [k, s] of repoNamesSeen) if (!repoNames.has(k)) ops.push({ op: 'remove', root: s.root });
  repoNamesSeen = new Map([...repoNames].map(([k, r]) => [k, { ...r }]));
  if (ops.length) saveSettings({ repoNamesOps: ops });
}
// the server's names and order win, except while a change of ours may not have reached it yet (as hiddenRepos)
function syncRepoPrefs(s) {
  if (Array.isArray(s.repoNames) && !('repoNamesOps' in pendingSave) && Date.now() - repoNamesSentAt > 3000) {
    repoNames.clear();
    for (const r of s.repoNames) if (r && typeof r.root === 'string' && typeof r.name === 'string' && r.name) repoNames.set(normRoot(r.root), { root: r.root, name: r.name });
    repoNamesSeen = new Map([...repoNames].map(([k, r]) => [k, { ...r }]));
  }
  syncHues(s);
  if (Array.isArray(s.repoOrder)) repoOrder = s.repoOrder.filter((x) => typeof x === 'string' && x);
}
// /state's workspace names (its repos, each conversation's repo, the deploys) become the shown ones; _n0 keeps the
// server's own, for a name that is cleared
function applyRepoNames(st) {
  if (!st) return;
  const set = (r) => {
    if (!r || !r.root) return;
    if (!('_n0' in r)) r._n0 = r.name;
    r.name = repoNames.get(normRoot(r.root))?.name || r._n0;
  };
  for (const r of st.repos || []) set(r);
  for (const list of [st.sessions, st.finished, st.removed]) for (const x of list || []) set(x && x.repo);
  for (const d of st.deploys || []) set(d);
}
// ---------- colouring a workspace or a conversation ----------
// "Colour" on a workspace's or a conversation's right-click: a tone round the colour wheel (settings.repoHues,
// settings.sessHues). A workspace's tone is its family's, so its conversations' shades follow it; a conversation's own
// wins. "Default" goes back to the automatic one. Single changes go as { repoHue: { root, hue } } / { sessHue: { id, hue } }.
const HUE_PICKS = [['Red', 8], ['Ember', 22], ['Gold', 44], ['Green', 120], ['Mint', 152], ['Cyan', 192], ['Blue', 212], ['Violet', 262], ['Purple', 288], ['Rose', 330]];
const hueCss = (h) => `hsl(${h} 85% 62%)`;
const repoHues = new Map(); // normRoot -> hue
const sessHues = new Map(); // id -> hue
function syncHues(s) {
  if (Array.isArray(s.repoHues) && !('repoHue' in pendingSave)) { repoHues.clear(); for (const x of s.repoHues) if (x && typeof x.root === 'string' && Number.isFinite(x.hue)) repoHues.set(normRoot(x.root), x.hue); }
  if (Array.isArray(s.sessHues) && !('sessHue' in pendingSave)) { sessHues.clear(); for (const x of s.sessHues) if (x && typeof x.id === 'string' && Number.isFinite(x.hue)) sessHues.set(x.id, x.hue); }
}
function hueItem(cur, pick) {
  return {
    label: 'Colour', icon: 'star', note: cur == null ? 'automatic' : (HUE_PICKS.find(([, h]) => h === cur) || [`${cur}°`])[0],
    children: [
      { label: 'Default', icon: cur == null ? 'check' : null, run: () => pick(null) },
      { sep: true },
      ...HUE_PICKS.map(([label, h]) => ({ label, swatch: hueCss(h), note: cur === h ? 'now' : null, run: () => pick(h) })),
    ],
  };
}
function repoColorItem(root) {
  const r = repoRootOf({ root }), k = normRoot(r);
  return hueItem(repoHues.has(k) ? repoHues.get(k) : null, (h) => {
    if (h == null) repoHues.delete(k); else repoHues.set(k, h);
    saveSettings({ repoHue: { root: r, hue: h } });
    toast(h == null ? `${repoName(r)} has its own colour again` : `${repoName(r)} is ${HUE_PICKS.find(([, x]) => x === h)?.[0].toLowerCase() || 'recoloured'}`, C.mint);
  });
}
function sessionColorItem(s) {
  if (s.pending) return { label: 'Colour', icon: 'star', disabled: true, note: 'once it has started' };
  return hueItem(sessHues.has(s.id) ? sessHues.get(s.id) : null, (h) => {
    if (h == null) sessHues.delete(s.id); else sessHues.set(s.id, h);
    saveSettings({ sessHue: { id: s.id, hue: h } });
    toast(h == null ? `${s.name} follows its workspace's colour again` : `${s.name} is ${HUE_PICKS.find(([, x]) => x === h)?.[0].toLowerCase() || 'recoloured'}`, C.mint);
    render(); // a team member's mascot in the Bots view reads sessHues itself (setPickedColors): it wears it now
  });
}
// the Bots view's rows and team members (chats.js) wear the colour picked for their conversation; a finished one's
// right-click there has Colour too
setPickedColors((id) => (sessHues.has(id) ? hueCss(sessHues.get(id)) : null));
setColorItem((id, name) => sessionColorItem({ id, name }));
function repoRenameItem(root) {
  const r = repoRootOf({ root });
  return {
    label: 'Rename', icon: 'edit',
    input: { value: repoName(r), placeholder: `a name (empty: ${repoBase(r)})`, hint: 'Enter saves · empty goes back to the folder name · Esc', allowEmpty: true, submit: (text) => renameRepo(r, text) },
  };
}
// -> null (the menu's box closes); Undo puts the name before back
function renameRepo(root, raw) {
  const k = normRoot(root), base = repoBase(root);
  const name = cleanName(raw), before = repoNames.get(k)?.name || '';
  const keep = !!name && name !== base;
  if ((keep ? name : '') === before) return null; // nothing changes
  if (keep) repoNames.set(k, { root, name }); else repoNames.delete(k);
  saveRepoNames();
  applyRepoNames(state);
  render();
  const undo = () => renameRepo(root, before);
  toast(keep ? `Renamed ${before || base} to ${name}` : `${before} goes by its folder name, ${base}, again`, C.mint, { label: 'Undo', run: undo });
  return null;
}

// ---------- the workspace list's order ----------
// settings.repoOrder (roots, at most 300; set by hand in the old repo menu, nothing sets it now): the ones in it come
// first in that order, the rest follow, busiest first
let repoOrder = [];

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
// ---------- drop files on the main view: a scratch conversation that analyzes them ----------
// Files dropped anywhere on #main (the chat pane keeps its own drops: an attachment) go into a new scratchpad (the
// server copies them in; a folder stays where it is), a new conversation starts there on the lead account, and its
// first message asks it to analyze them (orders.js sendWhenUp: it goes in once the session is up). On the map the
// scratchpad's hub goes where they were dropped. The desktop window knows a dropped file's path; a browser (Edge, the
// Mac) sends each file to the PC first (POST /upload, pcfiles.js) and the server copies it in from where it landed.
// A browser can't drop a folder this way (it has no path for one): those are left out, with a word.
const dropPath = (f) => { try { return String(window.fleetDesktop?.pathForFile?.(f) || ''); } catch { return ''; } };
const hasDropFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
function analyzePrompt(copied, dirs) {
  const names = copied.map((c) => c.name);
  const what = names.length === 1 ? `the file ${names[0]}` : names.length ? `these files: ${names.join(', ')}` : '';
  const lines = [];
  if (names.length) {
    lines.push(`Analyze ${what}. ${names.length === 1 ? 'It was' : 'They were'} dropped into Fleet View and copied into this folder from ${copied.map((c) => c.from).join(', ')}.`);
  }
  if (dirs.length) lines.push(`${names.length ? 'Also look at' : 'Analyze'} ${dirs.length === 1 ? 'this folder' : 'these folders'} (left where ${dirs.length === 1 ? 'it is' : 'they are'}, not copied): ${dirs.join(', ')}.`);
  lines.push('Say what it is, summarize what is in it, and point out anything notable, odd or wrong. Don\'t change the originals.');
  return lines.join('\n');
}
// a browser's dropped files, sent to the PC one after another, with how far it got on a toast -> [path…]; the
// names that didn't make it are said on a toast
async function sendDropToPc(list, dirs) {
  const files = list.filter((f) => f && !dirs.has(f.name));
  const skipped = list.length - files.length;
  const total = files.reduce((n, f) => n + f.size, 0);
  const paths = [], failed = [];
  let before = 0, shownAt = 0;
  const progress = (sent) => {
    const now = Date.now();
    if (now - shownAt < 1500 || total < (4 << 20)) return;
    shownAt = now;
    toast(`Sending to the PC… ${Math.min(100, Math.floor(((before + sent) / Math.max(1, total)) * 100))}% of ${sizeText(total)}`, C.dim, null, 1600);
  };
  for (const f of files) {
    const r = await upload(f, (sent) => progress(sent)).done;
    before += f.size;
    if (r.ok) paths.push(r.path); else failed.push(`${f.name} (${r.message})`);
  }
  if (failed.length || skipped) toast([failed.length ? `Couldn't send ${failed.join(', ')}` : '', skipped ? `${skipped === 1 ? 'a folder' : `${skipped} folders`} can't be sent from a browser` : ''].filter(Boolean).join(' · '), C.red, null, 9000);
  return paths;
}
// dirs: the names of the dropped folders (droppedFolders), which a browser can't send
async function analyzeDrop(files, at, folders = new Set()) {
  const list = [...(files || [])];
  const account = leadAccount();
  if (!account) { toast('No Claude account has room for a new conversation', C.red); return; }
  const paths = uploads() ? await sendDropToPc(list, folders) : [...new Set(list.map(dropPath).filter(Boolean))];
  if (!paths.length) { if (!uploads()) toast('Couldn\'t tell where those files are on disk', C.red); return; }
  toast(`Copying ${paths.length === 1 ? paths[0].split(/[\\/]/).pop() : `${paths.length} files`} into a new scratchpad…`, C.dim);
  const r = await post('/repos/scratch', { paths });
  if (!r || !r.ok) { toast((r && r.message) || 'could not reach Fleet View to make a scratchpad', C.red); return; }
  const copied = r.copied || [], dirs = r.dirs || [], failed = r.failed || [];
  if (!copied.length && !dirs.length) { toast(`Could not copy ${failed.map((x) => `${x.path.split(/[\\/]/).pop()} (${x.message})`).join(', ') || 'them'}`, C.red); return; }
  repoAdded(r, null, true, at && local.view === 'map' ? at : null);
  const s = await createSession({ cwd: r.repo.root, account, ...newSize() });
  if (!s || !s.ok) { toast(`${(s && s.message) || 'could not start a new session'} · the files are in ${r.repo.root}`, C.red, null, 9000); return; }
  sendWhenUp({ id: s.key, name: `the analysis in ${r.repo.name}` }, analyzePrompt(copied, dirs));
  ui.setSelected(s.key, 'explicit');
  const n = copied.length + dirs.length;
  toast(`New conversation in ${r.repo.name}: it analyzes ${n === 1 ? (copied[0]?.name || dirs[0].split(/[\\/]/).pop()) : `${n} items`} once it is up`
    + (failed.length ? ` (couldn't copy ${failed.map((x) => x.path.split(/[\\/]/).pop()).join(', ')})` : ''), failed.length ? C.gold : C.text);
}
(function wireDrop() {
  const main = $('main');
  if (!main) return;
  const veil = document.createElement('div');
  veil.className = 'drop-veil';
  veil.hidden = true;
  veil.innerHTML = '<div class="drop-veil-t">Drop to analyze in a new scratch conversation</div>';
  main.appendChild(veil);
  let depth = 0;
  const off = () => { depth = 0; veil.hidden = true; };
  main.addEventListener('dragenter', (e) => { if (!hasDropFiles(e) || !termApi()) return; depth++; veil.hidden = false; });
  main.addEventListener('dragleave', (e) => { if (!hasDropFiles(e)) return; if (--depth <= 0) off(); });
  main.addEventListener('dragover', (e) => {
    if (!hasDropFiles(e) || !termApi()) return;
    // the chat pane took it (an attachment): no veil here
    if (e.defaultPrevented) { veil.hidden = true; return; }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    veil.hidden = false;
  });
  main.addEventListener('drop', (e) => {
    if (!hasDropFiles(e)) return;
    const taken = e.defaultPrevented;
    off();
    if (taken || !termApi()) return;
    e.preventDefault();
    analyzeDrop(e.dataTransfer.files, { x: e.clientX, y: e.clientY }, uploads() ? droppedFolders(e.dataTransfer) : new Set()).catch((err) => { console.error(err); toast('could not start the analysis', C.red); });
  });
  window.addEventListener('dragend', off);
})();
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
  render();
  return null;
}
// "Browse": the Windows folder dialog in the desktop window, else the in-page one (pcfiles.js)
async function pickAndAddRepo(at = null) {
  if (!canPickFolder()) return false;
  let r = null;
  try { r = await pickFolder({ title: 'Add a workspace', button: 'Add this folder' }); } catch { r = null; }
  if (r && r.ok && r.path) { const err = await addRepoPath(r.path, at); if (err) toast(err, C.red); }
  else if (r && r.message) toast(r.message, C.dim);
  return true;
}
const ADD_HINT = 'Paste a folder path, e.g. C:\\Users\\you\\projects\\my-app';
// the right-click menu's item: a submenu of the three ways (Browse is a quiet line only with ?fixture=1);
// at: where the menu was opened, so the map puts the new repo there
function addRepoMenuItem(at = null) {
  return {
    label: 'Add workspace', icon: 'plus',
    children: [
      { label: 'Path', icon: 'plus', input: { placeholder: ADD_HINT, hint: 'Enter adds · Esc closes', submit: (text) => addRepoPath(text, at) } },
      { label: 'New scratchpad', icon: 'plus', note: 'an empty folder', run: () => addScratchRepo(at) },
      canPickFolder() ? { label: 'Browse', icon: 'folder', run: () => pickAndAddRepo(at) } : { label: 'Browse', icon: 'folder', disabled: true, note: 'not with fixture data' },
    ],
  };
}
// ---------- short lists ----------
// The finished strip starts short: today's, at most SHORT_N (or the
// SHORT_NONE newest when none is from today). The rest waits behind "Show N more". list: newest first.
const SHORT_N = 5, SHORT_NONE = 3;
function shortCount(list, timeOf) {
  const today = new Date().setHours(0, 0, 0, 0);
  const n = list.filter((x) => (timeOf(x) || 0) >= today).length;
  return Math.min(list.length, n ? Math.min(SHORT_N, n) : SHORT_NONE);
}

// the removed repos (hiddenRepos) still off the list, newest first, all of them
function removedRepoList() {
  const keys = hiddenRepoKeys();
  return [...hiddenRepos].filter(([k]) => keys.has(k)).map(([, h]) => h).sort((a, b) => b.at - a.at);
}
// "Add back all" ("Removed workspaces ▸"): each added back like "Add workspace", one toast for all
async function addBackRepos(list) {
  let n = 0, err = null;
  for (const h of list) {
    const r = await post('/repos/add', { path: h.root });
    const repo = FIXTURE ? { root: h.root, name: repoName(h.root) } : r && r.ok ? r.repo : null;
    if (!repo) { err = err || (r && r.message) || 'could not reach Fleet View to add it'; continue; }
    addedLocal.set(normRoot(repo.root), { root: repo.root, name: repo.name || repoName(repo.root), color: repo.color || null, at: Date.now() });
    hiddenRepos.delete(normRoot(h.root)); hiddenRepos.delete(normRoot(repo.root));
    n++;
  }
  if (n) saveHiddenRepos();
  if (n) toast(`Added back ${n === 1 ? repoName(list[0].root) : `${n} workspaces`}`, C.mint);
  if (err) toast(n ? `${list.length - n} not added: ${err}` : err, C.red);
  render();
}
// "Clear list": forgets the removed repos (off hiddenRepos, POST /settings), so "Removed workspaces ▸" no longer lists them.
// The server lists a repo that isn't hidden again whenever it has a conversation in the activity window, so the
// ones that have one now are kept (forgetting them would put them straight back); the rest come back by
// themselves only when they work again
function forgetRemovedRepos(list) {
  const showing = (h) => (state?.sessions || []).some((s) => s.repo && normRoot(s.repo.root) === normRoot(h.root));
  const gone = list.filter((h) => !showing(h)), kept = list.length - gone.length;
  if (!gone.length) { toast(`Nothing to forget: ${kept === 1 ? 'it has' : 'each has'} recent conversations and would show again. Add back puts one back`, C.dim, null, 6000); return; }
  for (const h of gone) hiddenRepos.delete(normRoot(h.root));
  saveHiddenRepos();
  const undo = () => { for (const h of gone) if (!hiddenRepos.has(normRoot(h.root))) hiddenRepos.set(normRoot(h.root), h); saveHiddenRepos(); render(); };
  toast(`Forgot ${gone.length === 1 ? repoName(gone[0].root) : `${gone.length} removed workspaces`}. ${gone.length === 1 ? 'It comes' : 'Each comes'} back on its own if it works again`
    + `${kept ? ` · kept ${kept} with recent conversations` : ''}`, C.dim, { label: 'Undo', run: undo, ms: 6000 });
  render();
}

// "Removed workspaces ▸" (empty space's right-click, only while there are some): "Add back all" and "Clear list", then
// every removed repo, newest first, in a box that scrolls (Henry, 2026-10-12: no 45-row menu), each added back with a
// click like "Add workspace" (POST /repos/add takes it off the server's hidden list too)
function removedReposMenuItem(at = null) {
  const list = removedRepoList();
  if (!list.length) return null;
  const now = Date.now();
  const rows = list.map((h) => ({
    label: repoName(h.root), icon: 'plus', note: `removed ${removedAgo(now - h.at)} · click adds it back`, at: h.at,
    run: async () => { const err = await addRepoPath(h.root, at); if (err) toast(err, C.red); },
  }));
  return {
    label: 'Removed workspaces', icon: 'hide', badge: String(list.length), scroll: true,
    children: [
      ...(list.length > 1 ? [{ label: 'Add back all', icon: 'plus', note: `${list.length} workspaces`, bulk: true, run: () => addBackRepos(list) }] : []),
      { label: 'Clear list', icon: 'close', note: 'forget them: each comes back on its own if it works again', bulk: true, run: () => forgetRemovedRepos(list) },
      { sep: true },
      ...rows,
    ],
  };
}

// ---------- removed conversations: continue, show again or forget one (right-click a repo, or empty space) ----------
// state.removed: the server's 50 most recently removed, less the forgotten, newest first ({ id, name, account, repo, cwd, removedAt,
// lastActive }). Continue takes one off the hidden list and opens it (desktop: its live session in the panel,
// kept; Edge: a Windows Terminal tab). Until /state shows it working again it stays on the page as a dim
// stand-in card and map node (continued), even when it is outside the activity window: while it runs here,
// else for 15 minutes.
const continued = new Map(); // id -> { at, r }
const CONTINUED_MS = 15 * 60e3;
// the removed ones the menus offer, optionally only a repo's (folder: a repo root or one of its checkouts)
function removedFor(folder = null) {
  const keys = folder ? new Set([normRoot(folder), normRoot(repoForFolder(state || {}, folder).root)]) : null;
  return (state?.removed || []).filter((r) => r && typeof r.id === 'string' && !r.bot && hidden.has(r.id) && !continued.has(r.id) && !forgotten.has(r.id)
    && (!keys || (r.repo && keys.has(normRoot(r.repo.root)))));
}
const removedAgo = (ms) => (ms < 60e3 ? 'just now' : ms < 3600e3 ? `${Math.round(ms / 60e3)}m ago` : ms < 48 * 3600e3 ? `${Math.round(ms / 3600e3)}h ago` : `${Math.round(ms / 86400e3)}d ago`);
// the "Removed conversations" item with its submenu, or null when there are none: all of them in a box that scrolls
// (Henry, 2026-10-12: no 45-row menu), each with its own ▸ (Continue, Show again, Forget), and with two or more
// "Show all again", "Continue all" and "Forget all" on top
function removedMenuItem(list, withRepo) {
  if (!list.length) return null;
  const now = Date.now(), n = list.length;
  const all = n < 2 ? [] : [
    { label: `Show all ${n} again`, icon: 'reply', note: 'nothing starts', bulk: true, run: () => showRemovedAgain(list) },
    { label: `Continue all ${n}`, icon: 'shell', bulk: true, confirm: { text: `Continue all ${n}? Each one's session starts${termApi() ? ' here' : ' in a terminal tab'}.`, yes: 'Continue all' }, run: () => continueAll(list) },
    { label: `Forget all ${n}`, icon: 'trash', danger: true, note: 'off this list for good', bulk: true, run: () => forgetRemoved(list) },
    { sep: true },
  ];
  return {
    label: 'Removed conversations', icon: 'hide', note: `${n}`, scroll: true,
    children: [...all, ...list.map((r) => ({
      label: r.name, tag: isAcct(r.account) ? r.account : null, icon: 'shell',
      note: `${withRepo ? `${r.repo ? r.repo.name : 'no workspace'} · ` : ''}removed ${removedAgo(now - (r.removedAt || now))}`, at: r.removedAt || now,
      children: [
        { label: 'Continue', icon: 'shell', note: 'opens it and starts its session', run: () => continueConversation(r) },
        { label: 'Show again', icon: 'reply', note: 'back on the page, nothing starts', run: () => showRemovedAgain([r]) },
        { label: 'Forget', icon: 'trash', note: 'off this list for good', run: () => forgetRemoved([r]) },
      ],
    }))],
  };
}
// "Show again": off the hidden list (its removed workspace back too, as Continue does) without starting anything.
// A finished one shows where finished ones do while it is inside the activity window; older, only Projects lists it
function showRemovedAgain(list) {
  const back = list.filter((r) => r && hidden.has(r.id));
  if (!back.length) return;
  const was = back.map((r) => [r.id, hidden.get(r.id)]), repos = [];
  for (const r of back) {
    const h = r.repo && r.repo.root ? hiddenRepos.get(normRoot(r.repo.root)) : null;
    if (h) { repos.push(h); unhideRepo(h.root); }
    unhide(r.id);
  }
  saveHidden();
  const listed = new Set([...(state?.sessions || []), ...(state?.finished || [])].map((s) => s.id));
  const old = back.filter((r) => !listed.has(r.id)).length;
  const undo = () => {
    for (const [id, at] of was) if (!hidden.has(id)) { hidden.set(id, at); unhiddenAt.delete(id); }
    saveHidden();
    if (repos.length) { for (const h of repos) if (!hiddenRepos.has(normRoot(h.root))) hiddenRepos.set(normRoot(h.root), h); saveHiddenRepos(); }
    render();
  };
  const what = back.length === 1 ? back[0].name : `${back.length} conversations`;
  const late = !old ? '' : back.length === 1 ? ' · it finished too long ago for this view: Projects lists it'
    : ` · ${old} finished too long ago for this view: Projects lists ${old === 1 ? 'it' : 'them'}`;
  toast(`Showing ${what} again${late}`, C.mint, { label: 'Undo', run: undo, ms: 6000 });
  render();
}
// "Continue all": each as Continue does, in one go (desktop: each one's session starts in the host and is kept;
// Edge: a Windows Terminal tab each). No Undo: sessions started
async function continueAll(list) {
  list = list.filter((r) => r && r.id);
  if (!list.length) return;
  if (!termApi() && remotePage()) { toast(noTermMsg('Continuing them'), C.red); return; } // tabs would open on the PC's screen
  const now = Date.now();
  for (const r of list) {
    if (r.repo && r.repo.root) unhideRepo(r.repo.root);
    if (hidden.has(r.id)) unhide(r.id);
    continued.set(r.id, { at: now, r });
  }
  saveHidden();
  flushSettings();
  toast(`Continuing ${list.length} conversations…`, C.dim);
  render();
  let bad = 0;
  if (termApi()) {
    const rs = await Promise.all(list.map((r) => ensureLive({ id: r.id, cwd: r.cwd || null, account: r.account }).catch((e) => ({ ok: false, message: String(e?.message || e) }))));
    bad = rs.filter((x) => !x || !x.ok).length;
  } else {
    // one at a time: the server takes each off its hidden list first (the save above), then opens its tab
    for (const r of list) { const res = await post('/open', { id: r.id }); if (!FIXTURE && (!res || !res.ok)) bad++; }
    if (FIXTURE) return; // fixture data: the POSTs are only recorded (window.__fvPosts)
  }
  toast(bad ? `${list.length - bad} continued · ${bad} did not start` : `Continued ${list.length} conversations`, bad ? C.red : C.mint);
}
// "Forget": off the Removed conversations list for good (settings.forgotten); they stay off the map until they
// work again, and one removed again later is listed again
function forgetRemoved(list) {
  const ids = list.filter((r) => r && hidden.has(r.id) && !forgotten.has(r.id)).map((r) => r.id);
  if (!ids.length) return;
  for (const id of ids) forgotten.add(id);
  saveForgotten();
  const undo = () => { for (const id of ids) forgotten.delete(id); saveForgotten(); };
  toast(ids.length === 1 ? `Forgot ${list.find((r) => r.id === ids[0]).name}: off the Removed list. It comes back only if it works again`
    : `Forgot ${ids.length} removed conversations. Each comes back only if it works again`, C.dim, { label: 'Undo', run: undo, ms: 6000 });
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
  if (remotePage()) { toast(noTermMsg('Continuing it'), C.red); return; } // a terminal would open on the PC's screen
  const res = await post('/open', { id: r.id });
  if (FIXTURE) return; // fixture data: the POST is only recorded (window.__fvPosts)
  if (!res || !res.ok) toast((res && res.message) || 'could not reach Fleet View to open it', C.red);
}

// ---------- left the map: the ones the age rules took off, back with a click (right-click a repo, or empty space) ----------
// state.leftMap: the server's 50 newest ({ id, name, account, repo, cwd, leftAt, rule, why, lastActive }), newest first,
// less hidden ones (Removed conversations lists those) and ones on the map again (Henry, 2026-10-16: one aged out
// overnight and only Projects still had it). Show again puts one back with nothing started, kept 3 hours from the
// click as if it had just finished, then it leaves by the usual rules; Continue opens it as for a removed one
const leftShown = new Map(); // id -> the leftAt of the entry shown again here: that entry stays off the list (a later departure is listed)
function leftMapFor(folder = null) {
  const keys = folder ? new Set([normRoot(folder), normRoot(repoForFolder(state || {}, folder).root)]) : null;
  const list = (state?.leftMap || []).filter((r) => r && typeof r.id === 'string');
  for (const r of list) if (leftShown.has(r.id) && (r.leftAt || 0) > leftShown.get(r.id)) leftShown.delete(r.id); // it left again since
  return list.filter((r) => !r.bot && !leftShown.has(r.id) && !hidden.has(r.id) && !continued.has(r.id) && (!keys || (r.repo && keys.has(normRoot(r.repo.root)))));
}
// the "Left the map" item with its submenu, or null when there are none, as removedMenuItem: a box that scrolls, each
// row with its own ▸ (Show again, Continue), and with two or more "Show all N again" on top
function leftMapMenuItem(list, withRepo) {
  if (!list.length) return null;
  const now = Date.now(), n = list.length;
  const all = n < 2 ? [] : [{ label: `Show all ${n} again`, icon: 'reply', note: 'nothing starts', bulk: true, run: () => showLeftAgain(list) }, { sep: true }];
  return {
    label: 'Left the map', icon: 'clock', note: `${n}`, scroll: true,
    children: [...all, ...list.map((r) => ({
      label: r.name, tag: isAcct(r.account) ? r.account : null, icon: 'shell',
      note: `${withRepo ? `${r.repo ? r.repo.name : 'no workspace'} · ` : ''}left ${removedAgo(now - (r.leftAt || now))}${r.why ? ` · ${r.why}` : ''}`, at: r.leftAt || now,
      children: [
        { label: 'Show again', icon: 'reply', note: 'back on the map, nothing starts', run: () => showLeftAgain([r]) },
        { label: 'Continue', icon: 'shell', note: 'opens it and starts its session', run: () => continueConversation(r) },
      ],
    }))],
  };
}
// "Show again": POST /left-map/show; off the list at once, Undo takes the server's time off again
async function showLeftAgain(list) {
  const back = list.filter((r) => r && r.id && !leftShown.has(r.id));
  if (!back.length) return;
  const ids = back.map((r) => r.id);
  for (const r of back) leftShown.set(r.id, r.leftAt || 0);
  const undo = () => { for (const id of ids) leftShown.delete(id); post('/left-map/show', { ids, undo: true }); render(); };
  toast(`Showing ${back.length === 1 ? back[0].name : `${back.length} conversations`} again`, C.mint, { label: 'Undo', run: undo, ms: 6000 });
  render();
  const res = await post('/left-map/show', { ids });
  if (FIXTURE) return; // fixture data: the POST is only recorded (window.__fvPosts)
  if (res && res.ok) return;
  const ok = new Set((res && res.shown) || []);
  for (const id of ids) if (!ok.has(id)) leftShown.delete(id);
  toast((res && res.message) || 'could not reach Fleet View to show it again', C.red);
  render();
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
// a pasted copy (Ctrl+V, pasteCopied) -> { name, from }: it goes by the name of the conversation it was copied from
// (its stand-in at once, POST /rename once it has its own id; a fork's first id can still be the original's, so
// that one waits for the next)
const pasteNames = new Map();
// covered: ids that already stand in as the conversation a handoff's pickup took over (handoffView): no second entry
function pendingSessions(st, covered = new Set()) {
  const listed = new Set((st.sessions || []).map((s) => s.id));
  // one that had turns and aged off /state (its panel left open for hours) isn't new: it is left off, not a stand-in
  const aged = new Set(st.aged || []);
  const out = [];
  // an overseer's (its role, or the pickup of one's handoff) is never a stand-in: it waits for /state in the Bots tab
  const over = new Set((st.sessions || []).filter((s) => s.bot).map((s) => s.id));
  for (const h of hosts.values()) {
    // started here, or the pickup of a handoff (re-keyed from the conversation it took over: the panel follows it)
    if (!(h.created || h.handoffFrom) || !h.alive || listed.has(h.id) || aged.has(h.id) || !h.cwd || h.role || over.has(h.handoffFrom) || covered.has(h.id)) continue;
    const color = acctColor(h.account);
    // a pickup whose predecessor /state still lists carries on as it (its name, workspace and colour, handing off),
    // not as a new session: a new one's workspace is guessed from its folder, and a worktree would sprout a hub
    const prev = h.handoffFrom && !h.created ? (st.sessions || []).find((s) => s.id === h.handoffFrom) : null;
    out.push({
      id: h.id, pending: true, name: pasteNames.get(h.id)?.name || (h.forkFrom ? 'forked session' : h.handoffFrom && !h.created ? 'picked-up session' : 'new session'), account: h.account, state: 'NEW', label: 'NEW SESSION', stateColor: color, hue: color,
      repo: repoForFolder(st, h.cwd), cwd: h.cwd, last: h.startedAt || Date.now(), turnStart: null, goal: null, lastAction: null, waitingOn: null,
      agents: [], files: [], calls: [], spark: [], ship: null, progress: { mode: 'ship', pct: 0 }, planSteps: null, context: null,
      links: { pr: null, branch: null, deploy: null, repoFolder: h.cwd }, lastReply: null, tokens: 0, cost: 0, endedAt: null, openElsewhere: false, calls20: 0,
      ...(prev ? {
        name: prev.name, repo: prev.repo, hue: prev.hue, goal: prev.goal || null, handing: true, state: 'HANDOFF', label: 'PICKING UP', stateColor: C.violet,
        pickedUpFrom: { id: prev.id, name: prev.name },
      } : {}),
    });
  }
  return out;
}

// ---------- handoffs: one conversation carrying on, not a new one beside the old ----------
// A conversation that hands off (handoff.js) doesn't just go quiet and vanish, and its pickup is not a new
// conversation (Henry, 2026-10-12): from the moment it hands off it stands in as HANDING OFF (PICKING UP once its
// pickup runs), in its own slot, and when the pickup shows up it carries on in that same place: the same card or
// tile (syncGrid re-keys it), the same map node (map.js carryNode), the same first-seen place, and the pick follows
// it (tookOver). A pickup running here goes by its own id as soon as the host has re-keyed it, before /state lists
// it: the stand-in takes that id, so it stays the one entry, never a "new session" beside it. Held at most HANDOFF_MS.
const HANDOFF_MS = 3 * 60e3;
const lastLive = new Map(); // id -> the state it last showed live (the stand-in's place in the live order)
let lastStand = new Set(); // the conversations that stood in as handing off at the last derive (old ids)
function handoffView(all) {
  const now = Date.now();
  const live = new Set(all.filter((s) => s.state !== 'DONE').map((s) => s.id));
  const listed = new Set(all.map((s) => s.id));
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
    // its pickup runs here under its own id, not listed yet: the stand-in goes by that id (pending, no log yet)
    const run = hostFrom.get(s.id);
    const key = run && !listed.has(run) ? run : s.id;
    stand.set(s.id, {
      ...s, handing: true, state: 'HANDOFF', label: picking ? 'PICKING UP' : 'HANDING OFF', stateColor: C.violet,
      rankState: lastLive.get(s.id) || 'WORKING', pendingNext: run || null, waitingOn: null,
      ...(key !== s.id ? { id: key, pending: true, handoff: null, pickedUpFrom: { id: s.id, name: s.name } } : {}),
    });
  }
  // the ones whose pickup took over since the last derive, seen here as they did: [old id, new id]
  const tookOver = [...pairs].filter(([from, to]) => lastStand.has(from) && !stand.has(from) && live.has(to));
  lastStand = new Set(stand.keys());
  return { stand, pairs, tookOver };
}
// a pickup took over: the pick, the panel and the multi-selection follow it once, as they follow a re-key (a later
// click on the old one stays there)
function followPickups(pairs) {
  for (const [from, to] of pairs) {
    if (ui.selectedId === from) ui.selectedId = to;
    if (ui.detailId === from) ui.detailId = to;
    if (pickIntent?.id === from) pickIntent.id = to;
    if (tabWant?.id === from) tabWant.id = to;
    followProjectsPick(from, to);
    if (multi.has(from)) { multi.delete(from); multi.add(to); try { mapMod?.setMapSelection?.([...multi]); } catch (e) { console.error(e); } }
  }
}

function derive(st) {
  const q = queryRe();
  // the overseers (the bots: /state tags them bot) are the Bots tab's alone: out of every list the map,
  // cards, wall, Projects, the strip and the counts read; allSessions keeps them, so their chats and panels open
  const over = (st.sessions || []).filter((s) => s && s.bot);
  const all = (st.sessions || []).filter((s) => !(s && s.bot));
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
  else if (!shown.length && shownSel().length) filterNote = `no live conversations in ${shownTitle()}`;
  if (hiddenSaveDue) { hiddenSaveDue = false; saveHidden(); }
  // a stand-in that goes by its pickup's id is that pickup's entry: listed with every conversation, never twice
  const standNew = [...ho.stand.values()].filter((s) => s.pending);
  const pending = pendingSessions(st, new Set(standNew.map((s) => s.id)));
  // a conversation that handed off to a fresh one (handoff.js) is replaced by it: off the strip and the map
  // (its successor's "picked up from" link still opens it)
  // (one still handing off is on the board as its stand-in, not in the strip)
  const replaced = new Set(all.filter((s) => (s.state === 'DONE' && s.handoff && s.handoff.next) || ho.stand.has(s.id)).map((s) => s.id));
  const finished = (st.finished || []).filter((f) => f && !f.bot && !replaced.has(f.id) && !(hidden.has(f.id) && all.some((s) => s.id === f.id && isHidden(s))) && !offRepo(f));
  // the map shows the strip's conversations too, so removing one from either takes it off both
  const finIds = new Set(finishedRows(finished).map((f) => f.id));
  return {
    ...st, settings: { ...(st.settings || {}), ...local }, sessions: shown,
    allSessions: all.filter((s) => !contIds.has(s.id)).concat(cont, pending, standNew, over),
    pending: pending.filter((s) => inRepo(s.repo)), clashes, allClashes: st.clashes || [], feed, filterNote,
    // handoffs in the last few minutes: old id -> its pickup's id (the views carry the old entry on as the new one)
    handoffPairs: ho.pairs, tookOver: ho.tookOver,
    // continued stand-ins show on the map as dim nodes too, like the strip's
    finished, finishedSessions: all.filter((s) => s.state === 'DONE' && finIds.has(s.id) && !isHidden(s) && !contIds.has(s.id) && !offRepo(s)).concat(cont.filter((s) => inRepo(s.repo) && !offRepo(s))),
    // every listed repo in the picked one(s) gets its anchor on the map, conversations or not (the workspace list)
    repoAnchors: repoList(st).filter((r) => inRepo(r)).map((r) => ({ root: r.root, name: r.name, color: r.color })),
  };
}

// ---------- drawing ----------
let view = null; // the derived state last drawn
// a chat follows a handoff chain back through these (chat.js handoffChain: the conversations a picked-up one came from)
setChatLookup((id) => (view?.allSessions || []).find((x) => x.id === id)
  || (state?.sessions || []).find((x) => x.id === id) || (state?.finished || []).find((x) => x && x.id === id) || null);
const viewEls = { cards: $('view-cards'), map: $('view-map'), wall: $('view-wall'), projects: $('view-projects'), chats: $('view-chats') };

// every part is its own step(): one that throws (a card, the map, a panel) is logged and the others still draw
function render() {
  step('tabs', () => {
    for (const v of VIEWS) if (viewEls[v]) viewEls[v].hidden = v !== local.view;
    for (const b of document.querySelectorAll('.tabs button')) {
      b.classList.toggle('on', b.dataset.view === local.view);
      b.setAttribute('aria-selected', String(b.dataset.view === local.view));
    }
    placeTabInd();
    $('view-map').classList.toggle('active', local.view === 'map');
  });
  step('reconnecting', () => {
    $('reconnecting').hidden = online || FIXTURE;
    $('reconnecting').textContent = state ? 'reconnecting…' : 'connecting…';
  });
  step('clock', drawClock);
  step('footer', drawFooter);
  if (!state) return;
  const next = step('derive', () => derive(state));
  if (!next) return;
  view = next;
  step('pickups', () => { if (view.tookOver.length) followPickups(view.tookOver); });
  if (ui.selectedId && !view.allSessions.some((s) => s.id === ui.selectedId)) ui.selectedId = null;
  // a new session that ended before it ever spoke has nothing left to show
  if (ui.detailId && isNewKey(ui.detailId) && !view.allSessions.some((s) => s.id === ui.detailId)) ui.detailId = null;
  step('header', () => { drawHeader(view); placeMiniButton(); fitHeader(); });
  step('alert', () => drawAlert(view));
  step('finished', () => drawFinished(view));
  step('detail', () => drawDetail(view));
  step('open notes', dropOpenNotes);
  if (!SOLO) step('remote', drawRemote);
  const el = viewEls[local.view];
  if (!el) return;
  step(local.view, () => {
    if (local.view === 'cards') renderCards(el, view, ui);
    else if (local.view === 'wall') renderWall(el, view, ui);
    else if (local.view === 'projects') renderProjects(el, view, ui);
    else if (local.view === 'chats') renderChats(el, view, ui);
    else if (renderMap) { el.classList.remove('map-missing'); renderMap(el, replay ? replayView(replay) : view, ui); }
    else if (mapMissing) { el.classList.add('map-missing'); el.textContent = 'The map view (map.js) is not available yet.'; }
  });
  // the map's sky is the page's backdrop behind every view (map.js renderSky); the Map draws it itself. Not in the
  // Bots pop-out window
  step('sky', () => { if (!SOLO && local.view !== 'map' && mapMod && typeof mapMod.renderSky === 'function') mapMod.renderSky(view, ui); });
  step('multi', () => markMulti(el));
  step('replay pill', drawReplayPill);
  step('notify button', drawNotifyBtn);
}

function drawClock() {
  $('clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// what is left of each account's weekly Claude limit: "A 3%  B 98%  C 70% week left"
function weekPill(wk) {
  const acs = Object.keys(wk || {}).filter((a) => isAcct(a) && wk[a]).sort();
  // no week figures yet (no account signed in): a plain "usage" pill, so the card and its Accounts list stay one click away
  if (!acs.length) return '<span class="count week" role="button" tabindex="0" title="plan usage and Claude accounts"><span class="count-k">usage</span></span>';
  const col = (n) => (n <= 10 ? C.red : n <= 25 ? C.gold : C.text);
  const tip = acs.map((a) => `account ${a}: ${wk[a].left}% of the week left${wk[a].resets ? ', resets ' + new Date(wk[a].resets).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : ''}`).join('\n');
  // a click opens the plan-usage card (usage.js); a rose dot: used somewhere other than this PC in the last 5 hours
  const away = acs.filter((a) => usageUi?.awayNow(a));
  const more = (away.length ? [`used somewhere else lately: ${away.join(', ')}`] : []).concat('click: plan usage, this PC vs. elsewhere');
  return `<span class="count week" role="button" tabindex="0" title="${esc([tip, ...more].join('\n'))}">`
    // letters whenever it lists more than one: an account turned off still has its week here (Henry, 2026-10-15)
    + acs.map((a) => `${singleAccount() && acs.length < 2 ? '' : `<span class="acct acct-${a}">${a}</span>`}<b style="color:${col(wk[a].left)}">${wk[a].left}%</b>${away.includes(a) ? '<i class="week-away" aria-label="used elsewhere"></i>' : ''}`).join('')
    + `<span class="count-k">week left</span></span>`;
}

// the sync pill, coloured by GET /sync/activity's health (sync.js reads it; sync-run.js health() decides): green, amber
// or red, its title naming the worst part and its error; cyan while sync is off or not read yet
const SYNC_TINT = { ok: C.mint, warn: C.gold, bad: C.rose };
function syncPill() {
  let h = null;
  try { h = syncUi ? syncUi.health() : null; } catch {} // syncUi is made further down
  const tint = h && SYNC_TINT[h.level];
  const tip = h && h.tip ? `${h.tip}. Click for sign-in and what sync is doing.` : 'Conversation sync: sign in or out, the sync passphrase, what it is doing';
  return `<span class="count sync${tint ? ` sync-${h.level}` : ''}" role="button" tabindex="0" title="${esc(tip)}"><span class="pill-ic" style="color:${tint || C.cyan}">${icon('sync', 13)}</span><span class="count-k">sync</span></span>`;
}

function drawHeader(v) {
  drawWsChip();
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
    + weekPill(v.week)
    // conversation sync: who is signed in, sign in / out, the sync key (sync.js)
    + (SOLO ? '' : syncPill())
    // the phone relay: pair an iPhone, the paired phones (phone.js); this PC only
    + (SOLO ? '' : `<span class="count phone" role="button" tabindex="0" title="Pair an iPhone with the Fleet View app, and the phones paired with this PC"><span class="pill-ic" style="color:${C.cyan}">${icon('phone', 13)}</span><span class="count-k">iPhone</span></span>`);
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
// open, a long workspace name in the chip), it drops the least needed parts, one step at a time (fit-1 .. fit-7 in app.css)
const FIT_STEPS = 7;
let fitKey = '';
function fitHeader(force = false) {
  if (!document.documentElement.classList.contains('titlebar')) return;
  const top = document.querySelector('.top');
  const key = `${window.innerWidth}|${$('ws-chip').hidden ? '' : $('ws-chip').textContent}|${$('counts')._html || ''}|${filterBox.hidden}|${document.documentElement.style.getPropertyValue('--wco-right')}`;
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

// the strip's rows: the last 10 in the picked repo, newest first (the map shows the same ones); drawn short. One shown
// again from "Left the map" sorts by that click (shownAgain), so it is not cut for being old
function finishedRows(fin) {
  const at = (f) => Math.max(f.endedAt || 0, f.shownAgain || 0);
  return (fin || []).filter((f) => f && f.id && inRepo(f.repo)).sort((a, b) => at(b) - at(a)).slice(0, 10);
}
let finList = []; // the strip's rows, all of them (not only the short list): what "Clear all" removes
function drawFinished(v) {
  const box = $('finished');
  const list = finishedRows(v.finished);
  finList = list;
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
  setOnce('finished-list', list.slice(0, rest >= 2 ? n : list.length).map((f) => `<div class="fin-row${ui.detailId === f.id ? ' picked' : ''}${multi.has(f.id) ? ' multi' : ''}" data-id="${esc(f.id)}" role="button" tabindex="0" title="show ${esc(f.name)} in the panel">`
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
// "Clear all": every row the strip has, through the same Remove as the row's x, with one Undo for all of them;
// asks first only when Claude is mid-turn in one that runs here
$('finished-clear').addEventListener('click', () => {
  const list = sessionsOf(finList.map((f) => f.id));
  if (!list.length) { toast('nothing to clear', C.dim); return; }
  const busy = list.filter((s) => isHosted(s.id) && (hostStatus(s.id) ? hostStatus(s.id) === 'busy' : s.state === 'WORKING' || s.state === 'AGENTS')).length;
  const go = () => removeMany(list.map((s) => s.id), list.length === 1 ? null : `Cleared ${list.length} finished conversations. Each comes back if it works again`);
  if (busy) askConfirm(`Clear ${list.length} finished conversations? Claude is mid-turn in ${busy === 1 ? 'one of them' : busy}; ${busy === 1 ? 'it ends' : 'they end'} too.`, 'Clear all', go);
  else go();
});
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
  // Ctrl+click adds the row to the multi-selection (the cards' and tiles' too) or takes it out; a plain click clears it
  const row = e.target.closest('.fin-row');
  if (row && (e.ctrlKey || e.metaKey)) { e.preventDefault(); toggleMulti(row.dataset.id); return; }
  if (row && multi.size) setMulti([], 'cards');
  pickFinished(row);
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
// The open panel (its conversation and the selection whose chats split it) is kept in this window's storage
// (fv.panelOpen) and opened again when the app or the page starts (Henry, 2026-10-10). Its place, size, spot and
// each conversation's tab are kept by detail.js. Put back once, on the first lists that have the conversation, if
// nothing was picked by then; given up after PANEL_RESTORE_MS (it may have been removed meanwhile).
const PANEL_RESTORE_MS = 30e3;
let panelSaved = null, panelKey = null, panelSince = 0;
try { const v = JSON.parse(localStorage.getItem('fv.panelOpen') || 'null'); if (v && typeof v.id === 'string') panelSaved = v; } catch {}
function restorePanel(v) {
  if (!panelSaved || SOLO) return;
  if (!panelSince) panelSince = Date.now();
  const p = panelSaved;
  if (ui.detailId || ui.selectedId || ui.botPick || multi.size || Date.now() - panelSince > PANEL_RESTORE_MS) { panelSaved = null; return; }
  if (!v.allSessions.some((x) => x.id === p.id)) return;
  panelSaved = null;
  ui.detailId = p.id;
  if (v.sessions.some((x) => x.id === p.id)) ui.selectedId = p.id;
  const ids = (Array.isArray(p.multi) ? p.multi : []).filter((id) => typeof id === 'string' && v.allSessions.some((x) => x.id === id));
  if (ids.length >= 2) {
    for (const id of ids) multi.add(id);
    splitKey = ids.join(','); // the panel keeps the conversation it had, not the selection's first
    setTimeout(() => { try { mapMod?.setMapSelection?.([...multi]); } catch (e) { console.error(e); } }, 0);
  }
}
function savePanel(id) {
  const key = id ? JSON.stringify({ id, multi: [...multi] }) : '';
  if (key === panelKey || panelSaved || SOLO) return; // unchanged, or not put back yet (the pop-out keeps none)
  panelKey = key;
  try { if (key) localStorage.setItem('fv.panelOpen', key); else localStorage.removeItem('fv.panelOpen'); } catch {}
}
let botFocus = false; // a bot just picked on the map: its chat box takes the keyboard once its panel is drawn
function drawDetail(v) {
  restorePanel(v);
  // a bot picked on the Map: the panel shows its chat as the Bots tab does (Henry, 2026-10-14), until a conversation
  // is picked, the map is clicked, its ✕ or Esc; on the other views the panel is as it was
  if (ui.botPick && !botById(ui.botPick)) ui.botPick = null;
  if (ui.botPick && local.view === 'map' && !replay) {
    const id = ui.botPick, focus = botFocus;
    botFocus = false;
    try { renderBotDetail($('detail'), ui, `bot:${id}`, (box) => renderBotPanel(box, v, ui, id, focus)); } catch (e) { console.error(e); }
    $('work').classList.add('detail-open');
    return;
  }
  // Projects and Bots show the chat themselves: the panel opens there only when asked, pinned or not
  const shut = (local.view === 'projects' || local.view === 'chats') && !projPanel;
  let s = ui.detailId && !shut ? v.allSessions.find((x) => x.id === ui.detailId) : null;
  // 2+ selected: their chats share the panel (detail.js drawSplits, SPLIT_MAX at most); with none shown, or one shown
  // that isn't in the selection (a pinned panel keeps its last chat; Ctrl+click took the shown one out), the first leads it
  const sel = multi.size >= 2 ? [...multi].map((id) => v.allSessions.find((x) => x.id === id)).filter(Boolean) : [];
  // (once per selection: a panel closed by hand stays closed until the selection changes)
  const key = sel.map((x) => x.id).join(',');
  if (!shut && sel.length >= 2 && key !== splitKey && !(s && sel.some((x) => x.id === s.id))) { s = sel[0]; ui.detailId = s.id; }
  splitKey = key;
  // under it: the pinned splits first (still listed, not the one leading), then the rest of the selection
  const pins = splitPins.map((id) => v.allSessions.find((x) => x.id === id)).filter(Boolean);
  const extras = s ? [...new Set(pins.concat(sel))].filter((x) => x.id !== s.id) : [];
  let gone = false;
  if (!shut && ui.detailId && !s && detailLast?.id === ui.detailId) { s = detailLast; gone = true; }
  if (!s) { if (!shut) ui.detailId = null; }
  else if (!gone) detailLast = s;
  try { renderDetail($('detail'), s, ui, gone, extras); } catch (e) { console.error(e); }
  if (!shut) savePanel(s && !gone ? s.id : null);
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
// This page came from another computer through Tailscale (remote.js lets only this PC's tailnet name in besides
// 127.0.0.1 and localhost): what POST /open and /reveal start (a terminal, VS Code, Explorer) opens on the PC's
// screen, not on this one. onPc(label) says so on a menu item there.
const remotePage = () => !/^(127\.0\.0\.1|localhost|\[::1\])$/i.test(location.hostname);
const onPc = (label) => (remotePage() ? `${label} on the PC` : label);
async function reveal(w) {
  if (!w || (w.kind !== 'file' && w.kind !== 'folder') || !w.path) return;
  const name = String(w.path).split(/[\\/]/).filter(Boolean).pop() || String(w.path);
  if (FIXTURE) { toast(`fixture data: would open ${w.kind === 'file' ? `${name} in VS Code` : `${w.path} in Explorer`}`, C.dim); return; }
  const body = { kind: w.kind, path: String(w.path) };
  if (Number.isInteger(w.line) && w.line > 0) body.line = w.line;
  const r = await post('/reveal', body);
  if (!r) toast('could not reach Fleet View to open it', C.red);
  else toast(onPc(r.message || (r.ok ? `opened ${name}` : `could not open ${name}`)), r.ok ? C.mint : C.red);
}
// caught before the card, tile or panel under the link sees the click, so a link never picks a card.
// A slot can be rewritten between press and release (a "working 45s" timer beside a link). The browser then
// sends no click at all, so a link whose element went away under a press that didn't move opens on the
// release instead, and a click that may still follow is dropped.
let pressed = null; // { el, d: its dataset, x, y, t }
let lastAct = { key: '', t: 0 };
let dropClickUntil = 0;
function activate(d) {
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
  openPeek({ for: s.id, kind, id: p.id, name: p.name, file: p.file || null, summary: !!(p.summary || p.file) });
  tabWant = { id: s.id, tab: 'chat' };
  if (local.view === 'projects' || local.view === 'chats') projPanel = true;
  ui.showDetail(s.id);
}
// a picked-up conversation's "Previous conversation ▸": its chat (read only) and the handoff summary, under its chat
function previousMenuItem(s) {
  const p = s.pickedUpFrom;
  if (!p || !p.id) return null;
  return { label: 'Previous conversation', icon: 'clock', note: p.name || null, children: [
    { label: 'Read its chat', icon: 'read', note: 'under this one, read only', run: () => openPeekFor(s.id, 'chat') },
    // (the file here, or the copy in this one's own log: both machines)
    p.summary || p.file ? { label: 'Read the handoff summary', icon: 'file', run: () => openPeekFor(s.id, 'summary') } : { label: 'Read the handoff summary', icon: 'file', disabled: true, note: 'no handoff summary' },
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
  cards: [['v', 'view'], ['↑↓←→', 'pick'], ['enter/o', 'open'], ['double-click', 'open'], ['ctrl+click', 'select more'], ['shift+click', 'select range'], ['ctrl+a', 'select all'], ['right-click', 'menu'], ['ctrl+c', 'copy'], ['ctrl+v', 'paste a copy'], ['ctrl+z', 'undo'], ['c', 'compact'], ['s', 'ORDER'], ['/', 'filter'], ['r', 'workspace'], ['w', 'since you looked'], ['esc', 'clear']],
  map: [['v', 'view'], ['click', 'select'], ['ctrl+click', 'select more'], ['ctrl+a', 'select all'], ['double-click', 'open'], ['right-click', 'menu'], ['ctrl+c', 'copy'], ['ctrl+v', 'paste a copy'], ['ctrl+z', 'undo'], ['wheel', 'zoom'], ['drag', 'pan'], ['0', 'recenter'], ['n/N', 'needs you'], ['k', 'lens'], ['t', 'replay'], ['l', 'legend'], ['/', 'filter'], ['r', 'workspace']],
  wall: [['v', 'view'], ['↑↓←→', 'pick'], ['enter/o', 'open'], ['double-click', 'open'], ['ctrl+click', 'select more'], ['shift+click', 'select range'], ['ctrl+a', 'select all'], ['right-click', 'menu'], ['ctrl+c', 'copy'], ['ctrl+v', 'paste a copy'], ['ctrl+z', 'undo'], ['s', 'ORDER'], ['/', 'filter'], ['r', 'workspace'], ['w', 'since you looked'], ['esc', 'clear']],
  projects: [['v', 'view'], ['↑↓', 'pick'], ['enter', 'type'], ['ctrl+click', 'select more'], ['shift+click', 'select range'], ['ctrl+a', 'select all'], ['right-click', 'menu'], ['/', 'filter'], ['r', 'workspace'], ['esc', 'clear']],
  chats: [['v', 'view'], ['i', 'bots'], ['↑↓', 'pick'], ['enter', 'type'], ['right-click', 'menu'], ['/', 'search'], ['esc', 'back']],
};
const MOUSE = new Set(['click', 'double-click', 'right-click', 'wheel', 'drag', 'ctrl+click', 'shift+click']);
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
      .concat(isDesktop() && !SOLO ? [['m', 'mini']] : [], ui.detailId && !pinned ? [['esc', 'close panel']] : [])).map(keyHtml).join('');
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
  if (SOLO) return;
  if (isDesktop() && typeof window.fleetDesktop.toggleMini === 'function') window.fleetDesktop.toggleMini();
}
// the header button is the header's last item: before the native window buttons, outside the drag region
function placeMiniButton() {
  const old = $('mini-btn');
  if (!isDesktop() || SOLO) { old?.remove(); return; }
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
  if (SOLO || !TAB_VIEWS.includes(v) || v === local.view) return;
  projPanel = false;
  saveSettings({ view: v });
  render();
}
for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => setView(b.dataset.view));

// ---------- the workspaces shown (a filter) ----------
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
    out.push({ root: a.root, name: repoNames.get(k)?.name || a.name, live: 0, added: true, color: a.color || colorOf(a.root) || C.dim });
  }
  return out;
}
// every workspace in the list's order: the order set by hand first (repoOrder), then the busiest; no workspace last;
// a shown one that isn't listed after them
function orderedRepos() {
  const ix = new Map(repoOrder.map((r, i) => [normRoot(r), i]));
  const at = (r) => ix.get(normRoot(r.root)) ?? Infinity;
  const repos = repoList(state).sort((a, b) => at(a) - at(b) || isHomeRoot(a.root) - isHomeRoot(b.root) || b.live - a.live || a.name.localeCompare(b.name));
  for (const x of shownSel()) if (!repoIsHidden(x) && !repos.some((r) => selMatches(x, r))) repos.push({ root: x, name: repoName(x), live: 0, color: C.dim });
  return repos;
}
const isCurrent = (it) => (it.root ? shownSel().length > 0 && inRepo({ root: it.root, name: it.name }) : !shownSel().length);
// shows only that workspace (it: { root, name }); root null shows every workspace
function pickRepo(it) {
  if (!it) return;
  ui.selectedId = null;
  saveSettings({ repo: it.root, repos: null });
  toast(`showing ${it.root ? repoName(it.root) : 'every workspace'}`, C.mint);
  render();
}
// "Show it too" / "Stop showing it": it joins the workspaces shown, or leaves them; the last one out shows every
// workspace again
function toggleShown(it) {
  if (!it) return;
  if (!it.root) { pickRepo(it); return; }
  const sel = shownSel(), has = sel.some((x) => selMatches(x, it));
  if (has) ui.selectedId = null;
  setShown(has ? sel.filter((x) => !selMatches(x, it)) : sel.concat(it.root));
  toast(`showing ${shownTitle()}`, C.mint);
  render();
}
// a repo's right-click: "Show only this workspace", unless it is the only one shown
const showOnlyItems = (it) => (isCurrent(it) && shownSel().length === 1 ? [] : [{ label: 'Show only this workspace', icon: 'repo', run: () => pickRepo(it) }]);
// and while some are shown, "Show it too" / "Stop showing it"
function showTooItems(it) {
  const n = shownSel().length, cur = isCurrent(it);
  if (!n || (cur && n === 1)) return [];
  return [{ label: cur ? 'Stop showing it' : 'Show it too', icon: cur ? 'hide' : 'plus', run: () => toggleShown(it) }];
}
// the workspace list ("Show workspace ▸" on empty space's right-click, the header chip, key r): All workspaces, then
// every active one (live conversations) in the list's order, and a shown one with none too, so it can be switched off.
// Each has its live count and a check on the shown one(s); a click shows only that one
function workspaceItems() {
  const all = orderedRepos();
  const list = all.filter((r) => r.live > 0 || isCurrent(r));
  const total = all.reduce((n, r) => n + (r.live || 0), 0);
  return [
    { label: 'All workspaces', icon: shownSel().length ? null : 'check', badge: `${total} live`, run: () => pickRepo({ root: null }) },
    { sep: true },
    ...(list.length ? list.map((r) => ({ label: r.name, icon: isCurrent(r) ? 'check' : null, badge: `${r.live || 0} live`, run: () => pickRepo(r) }))
      : [{ label: 'No workspace has live conversations', disabled: true }]),
  ];
}
const workspaceMenuItem = () => ({ label: 'Show workspace', icon: 'repo', note: shownSel().length ? shownTitle() : null, children: workspaceItems() });
// the same list as a menu of its own, under the chip (or under the tabs)
function openWorkspaceList(anchor = null) {
  if (!state) return;
  const r = (anchor || document.querySelector('.tabs')).getBoundingClientRect();
  openCtxMenu({ x: r.left - 2, y: r.bottom + 4, title: 'Show workspace', items: workspaceItems() });
}
// the workspace picker right of the tabs: always there on Cards and Wall ("All workspaces" with none picked),
// on the other views only while a filter is on (so it never goes unseen); a colour dot per shown workspace
// (3 at most), shownTitle() and its ✕
function drawWsChip() {
  const sel = shownSel(), chip = $('ws-chip');
  chip.hidden = SOLO || (!sel.length && local.view !== 'cards' && local.view !== 'wall');
  if (chip.hidden) return;
  const repos = repoList(state);
  const dots = sel.slice(0, 3).map((x) => repos.find((r) => selMatches(x, r))?.color || C.dim);
  const key = `${shownTitle()}|${dots.join()}`;
  if (chip._key === key) return;
  chip._key = key;
  chip.classList.toggle('all', !sel.length);
  $('ws-x').hidden = !sel.length;
  chip.querySelector('.ws-dots').innerHTML = dots.map((c) => `<span class="dot" style="background:${esc(c)}"></span>`).join('');
  chip.querySelector('.ws-t').textContent = sel.length ? shownTitle() : 'All workspaces';
  $('ws-pick').title = `${!sel.length ? 'every workspace shows' : sel.length === 1 ? 'only this workspace shows' : 'only these workspaces show'}: click to pick (r)`;
}
$('ws-pick').addEventListener('click', (e) => { e.stopPropagation(); openWorkspaceList($('ws-chip')); });
$('ws-x').addEventListener('click', (e) => { e.stopPropagation(); pickRepo({ root: null }); });

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
  try { u.run(); } catch (e) { console.error(e); }
  toast(`Undone: ${u.text.replace(/\. (It|Each) comes back.*$/, '')}`, C.mint);
}
// ---------- Ctrl+C: copy what is picked (outside text boxes, with no text selected) ----------
// conversations: "name (id)" a line each, the multi-selection or the picked one; a workspace picked on the map: its
// folder path
async function copyPicked() {
  let text = '', what = '';
  const p = local.view === 'map' ? mapMod?.mapPicked?.() : null;
  const list = sessionsOf(multi.size ? [...multi] : ui.selectedId ? [ui.selectedId] : ui.detailId ? [ui.detailId] : []);
  if (p && p.kind === 'repo' && p.root) { text = p.root; what = p.name || repoName(p.root); }
  else if (list.length) {
    text = list.map((s) => (s.pending ? s.name : `${s.name} (${s.id})`)).join('\n');
    what = list.length === 1 ? list[0].name : `${list.length} conversations`;
  }
  if (!text) { toast('Pick a conversation or workspace to copy', C.dim); return; }
  // conversations (new, empty ones too) can be pasted as copies (Ctrl+V); a workspace path can't
  copied = list.length && text && !(p && p.kind === 'repo' && p.root)
    ? list.map((s) => ({ id: s.id, name: s.name, empty: !!s.pending, cwd: s.cwd || s.links?.repoFolder || '', account: s.account, root: s.repo?.root || '' })).filter((c) => c.cwd)
    : [];
  try { await navigator.clipboard.writeText(text); toast(`Copied ${what}${copied.length && termApi() ? ': Ctrl+V pastes a copy where the mouse is' : ''}`, C.mint); }
  catch { toast('Could not reach the clipboard', C.red); }
}
// ---------- Ctrl+V: copies of the copied conversations, where the mouse is ----------
// A conversation with history comes back as a fork (claude --resume <id> --fork-session, like the menu's Fork); a
// new, empty one as a new session in the same folder and account. Over a workspace (its group on the map, or a
// card, tile, row or workspace heading of it) the copies go there: an empty one starts in that folder, a fork
// starts in its own folder (forks resume from there) and moves to it once it has its id (Move to workspace). On
// the map each copy sits where it was pasted. A copy only lasts while this window has the keyboard: one made in
// another app since would otherwise turn a stray Ctrl+V outside the chat box into forks.
let copied = [];
const mouseAt = { x: NaN, y: NaN };
document.addEventListener('mousemove', (e) => { mouseAt.x = e.clientX; mouseAt.y = e.clientY; }, { passive: true, capture: true });
window.addEventListener('blur', () => { copied = []; });
document.addEventListener('copy', () => { copied = []; }); // text copied in the page
const pasteMoves = new Map(); // a fork's key -> { root, x, y }: moved there once it has its id
// the workspace under the mouse, or null (each copy then stays in its own)
function pasteRoot(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (local.view === 'map') return mapMod?.mapRepoAt?.(x, y) || null;
  const el = document.elementFromPoint(x, y);
  const head = el?.closest?.('.pj-repo[data-root], [data-act="reveal"][data-kind="folder"][data-path]');
  if (head) return head.dataset.root || head.dataset.path || null;
  const row = el?.closest?.('.card[data-id], .tile[data-id], .fin-row[data-id], [data-pick]');
  const s = row && sessionsOf([row.dataset.id || row.dataset.pick])[0];
  return s?.repo?.root || null;
}
async function pasteCopied() {
  if (!copied.length) { toast('Ctrl+C a conversation first, then Ctrl+V where its copy should go', C.dim); return; }
  if (!termApi()) { toast(noTermMsg('Pasting a copy'), C.red); return; }
  const list = copied.slice(), x = mouseAt.x, y = mouseAt.y;
  const root = pasteRoot(x, y);
  let first = null, n = 0, there = null;
  for (const [i, c] of list.entries()) {
    const here = root && normRoot(root) !== normRoot(c.root) ? root : null;
    const folder = c.empty && here ? here : c.cwd;
    // where the new session shows by itself (its folder's repo), and where the copy belongs (a moved original's too)
    const natural = repoForFolder(state || {}, folder).root || folder, target = here || c.root || natural;
    unhideRepo(natural);
    // an empty one is a new chat: on the main computer when one is picked (startChat); a fork starts here
    const r = c.empty ? await startChat({ cwd: folder, account: c.account, ...newSize() }) : await createSession({ cwd: folder, account: c.account, forkFrom: c.id, ...newSize() });
    if (!r || !r.ok) { toast((r && r.message) || `could not copy ${c.name}`, C.red); continue; }
    n++;
    if (r.remote) { there = there || r; continue; } // (it shows where sync puts it)
    first = first || r.key;
    if (!c.empty && c.name) pasteNames.set(r.key, { name: c.name, from: c.id });
    // side by side when several land on one spot
    const px = x + i * 34, py = y;
    if (!c.empty && normRoot(target) !== normRoot(natural)) pasteMoves.set(r.key, { root: target, x: px, y: py });
    else mapMod?.mapPlaceSession?.(r.key, natural, px, py);
  }
  if (!n) return;
  const where = root ? ` in ${repoName(root)}` : '';
  toast((n === 1 ? `Pasted a copy of ${list[0].name}${where}` : `Pasted ${n} copies${where}`) + (there ? ` (new ones on ${there.remote.name}: they show here in a moment)` : ''), C.mint);
  if (first) ui.setSelected(first, 'explicit');
  else if (there) pickWhenListed(there.remote.id);
}
// a pasted fork that goes to another workspace: moved there once Claude Code gave it its id
onRekey((oldKey, id) => {
  const pn = pasteNames.get(oldKey);
  if (pn) {
    pasteNames.delete(oldKey);
    if (id === pn.from) pasteNames.set(id, pn);
    else {
      renamesNow.set(id, { name: pn.name, until: Date.now() + RENAME_SHOW_MS });
      post('/rename', { id, name: pn.name }).then((r) => { if (!(r && r.ok) && !FIXTURE) renamesNow.delete(id); pollSoon(); });
    }
  }
  const m = pasteMoves.get(oldKey);
  if (!m) return;
  pasteMoves.delete(oldKey);
  post('/sessions/move', { id, root: m.root }).then((r) => {
    if (!r || !r.ok) { if (!FIXTURE) toast(r?.message || 'could not move the copy', C.red); return; }
    mapMod?.mapPlaceSession?.(id, m.root, m.x, m.y);
    pollSoon();
  });
});
function pickKeys(e) {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
  const k = e.key.toLowerCase();
  if (k !== 'c' && k !== 'z' && k !== 'v' && k !== 'a') return;
  if (e.target.closest?.('.term-host')) return;
  // Ctrl+A: every conversation the view shows; in the chat box and other text it selects the text, as usual
  if (k === 'a') {
    if (local.view === 'chats' || e.target.closest?.('.chat-compose, input, textarea, select, [contenteditable]') || !$('confirm').hidden) return;
    e.preventDefault();
    if (!e.repeat) selectAllShown();
    return;
  }
  // the chat box often has the cursor just from picking a conversation: with the mouse away from the panel and
  // nothing selected in the box, Ctrl+C and Ctrl+V (with a copy waiting) still mean the conversations
  if (e.target.closest?.('.chat-compose')) {
    const ta = e.target, away = !document.elementFromPoint(mouseAt.x, mouseAt.y)?.closest?.('#detail');
    const ok = ta.matches?.('textarea') && away && (k === 'c' ? ta.selectionStart === ta.selectionEnd : k === 'v' && copied.length > 0);
    if (!ok) return;
  } else if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
  if (!$('confirm').hidden) return;
  if (k === 'v') {
    if (e.repeat) return;
    e.preventDefault();
    pasteCopied();
    return;
  }
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
}
// the chat box keeps its keys from the page (compose.js stops them), so its case is heard on the way down
document.addEventListener('keydown', (e) => { if (!e.target.closest?.('.chat-compose')) pickKeys(e); });
document.addEventListener('keydown', (e) => { if (e.target.closest?.('.chat-compose')) pickKeys(e); }, true);

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

// a box you type in (an email, a code, a passphrase) keeps every key but Esc from the one-key shortcuts
const typingIn = (t) => !!t?.closest?.('textarea, select, [contenteditable]') || (t?.matches?.('input') && !/^(checkbox|radio|button|submit|reset|range|color|file)$/i.test(t.type));
document.addEventListener('keydown', (e) => {
  if (e.target.closest?.('.term-host')) return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  const k = e.key;
  if (k !== 'Escape' && typingIn(e.target)) return;
  if (!$('confirm').hidden) {
    if (k === 'Escape' || k === 'n') { e.preventDefault(); hideConfirm(); }
    else if (k === 'Enter' || k === 'y') { e.preventDefault(); $('confirm-yes').click(); }
    return;
  }
  // Enter on a focused link, panel button or finished row belongs to it
  if ((k === 'Enter' || k === ' ') && e.target.closest?.('a[data-act], .detail button, .fin-head, .fin-row')) return;
  // Esc closes the innermost thing first: confirm, filter box (above), "Since you looked", the map's
  // legend (and its own multi-selection), the multi-selection, the panel
  if (k === 'Escape' && since.isOpen()) { e.preventDefault(); since.close(); return; }
  if (k === 'Escape' && local.view === 'map' && ui.keys.map && ui.keys.map(e)) return;
  if (k === 'Escape' && local.view === 'map' && ui.botPick && !pinned) { e.preventDefault(); ui.closeBotPanel(); return; }
  if (k === 'Escape' && multi.size) { e.preventDefault(); setMulti([], 'keys'); return; }
  if (k === 'Escape' && ui.detailId && !pinned) { e.preventDefault(); ui.showDetail(null); return; }
  // arrows and paging inside the panel scroll it instead of moving the pick
  if (e.target.closest?.('#detail') && /^(Arrow|Page|Home|End)/.test(k)) return;
  // Bots: / is its own search box, Esc goes back to its list (narrow layout) before it clears the pick
  if ((k === '/' || k === 'Escape') && local.view === 'chats' && ui.keys.chats && ui.keys.chats(e)) { e.preventDefault(); return; }
  // the pop-out window (SOLO) has no other views, header, filter, workspace list, "Since you looked" or mini view
  if (SOLO && ['v', 'Tab', '/', 'r', 'w', 'm', 's', 'i'].includes(k)) return;
  if (k === 'v' || k === 'Tab') { e.preventDefault(); setView(TAB_VIEWS[(Math.max(0, TAB_VIEWS.indexOf(local.view)) + (e.shiftKey && k === 'Tab' ? TAB_VIEWS.length - 1 : 1)) % TAB_VIEWS.length]); return; }
  if (k === 'i') { e.preventDefault(); setView('chats'); return; }
  if (k === '/') { e.preventDefault(); openFilter(); return; }
  if (k === 'r') { e.preventDefault(); openWorkspaceList(); return; }
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
  if ((local.view === 'projects' || local.view === 'chats') && ui.keys[local.view] && ui.keys[local.view](e)) { e.preventDefault(); return; }
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
  if (local.view === 'map' || local.view === 'projects' || local.view === 'chats') return;
  const moves = { ArrowLeft: [-1, 0], h: [-1, 0], ArrowRight: [1, 0], l: [1, 0], ArrowUp: [0, -1], k: [0, -1], ArrowDown: [0, 1], j: [0, 1] };
  if (moves[k]) { e.preventDefault(); movePick(...moves[k]); return; }
  if (k === 'c' && local.view === 'cards') { saveSettings({ compact: !local.compact }); render(); }
});

// Delete: removes what is picked. A multi-selection of 2+ asks first; one conversation asks only when Claude is
// mid-turn in it; a repo picked on the map goes at once (Undo on the toast)
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
  if (!s || s.bot) return false; // an overseer goes from its own menu in Bots, never by a key
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
  if (SELF_BOUNDS || SOLO) return;
  const b = bounds();
  if (b.x === lastBounds.x && b.y === lastBounds.y && b.w === lastBounds.w && b.h === lastBounds.h) return;
  lastBounds = b;
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => post('/settings', { webBounds: lastBounds }), 1000);
}
setInterval(checkBounds, 2000);
window.addEventListener('resize', checkBounds);
window.addEventListener('beforeunload', () => {
  if (!SELF_BOUNDS && !SOLO) Object.assign(pendingSave, { webBounds: bounds() });
  flushSettings(true);
});

// ---------- the right-click menu ----------
const BUSY_Q = 'Claude is mid-turn. End it anyway?';
function ctxTargetOf(el) {
  if (!el || !el.closest) return null;
  const chip = el.closest('[data-act="reveal"][data-kind="folder"]');
  if (chip && chip.dataset.path) return { kind: 'repo', root: chip.dataset.path };
  const row = el.closest('.fin-row[data-id], .card[data-id], .tile[data-id]');
  // a card, tile or finished row of a multi-selection of 2+: the "N conversations" menu
  if (row && multi.size >= 2 && multi.has(row.dataset.id)) return { kind: 'sessions', ids: [...multi] };
  if (row) return { kind: 'session', id: row.dataset.id };
  return null;
}
function openContextMenu(target, x, y) {
  if (!target || !state) return;
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
    if (t) teamMenu(t, x, y, target.extra);
    return;
  }
  if (target.kind === 'conflict') { conflictMenu(target, x, y); return; }
  if (target.kind === 'file' || target.kind === 'pr') { dotMenu(target, x, y); return; }
  if (target.kind === 'bot') { const b = botById(target.id); if (b) botMenu(b, x, y); return; }
  if (target.kind === 'repo') {
    const folder = String(target.root || '');
    if (!folder) return;
    const repo = repoForFolder(state, folder);
    const color = target.color || repo.color || C.dim;
    const items = [];
    if (desk) {
      // every account that is on, however little of its weekly or 5-hour limit is left (Henry, 2026-10-10),
      // less those with none left at all (Henry, 2026-10-10); all of them out: one greyed line saying so. One line,
      // "New session ▸ Claude A / B ...", the account picked in its submenu (Henry, 2026-10-13); only one usable (the
      // rest off or out): a plain "New session" on it, its tag showing which (Henry, 2026-10-15)
      const all = allAccounts(), ok = onAccounts().filter((a) => !acctOut(a));
      if (!ok.length) items.push({ label: 'New session', icon: 'plus', disabled: true, note: 'every account is out of its limit' });
      else if (ok.length === 1) items.push({ label: 'New session', icon: 'plus', ...(all.length > 1 ? { tag: ok[0] } : {}), run: () => newSession(folder, ok[0]) });
      else items.push({ label: 'New session', icon: 'plus', children: ok.map((a) => ({ label: `Claude ${a}`, tag: a, run: () => newSession(folder, a) })) });
    }
    const rIt = { root: repoRootOf({ root: folder }), name: target.name || repo.name || repoName(folder) };
    // orders for every conversation in it, idle and new ones too (one team), or the same text to each
    // (selecting them all is a double-click on the workspace, ui.selectRepo, Henry 2026-10-12)
    items.push(...repoOrderItems(folder, rIt.name));
    items.push({ label: onPc('Open folder'), icon: 'folder', run: () => ui.reveal({ kind: 'folder', path: folder }) });
    // grouped to keep the menu short (Henry, 2026-10-12): Show ▸ (whether it is shown: only it, or with the others;
    // not in Bots, which no workspace filters), then its settings in one submenu, then its removed conversations
    items.push({ sep: true });
    const shows = local.view === 'chats' ? [] : [...showOnlyItems(rIt), ...showTooItems(rIt)];
    if (shows.length === 1) items.push(shows[0]);
    else if (shows.length) items.push({ label: 'Show', icon: 'repo', note: 'in the views', children: shows });
    // push sits with the rest; a repo has no "Unpin from the map" (Henry, 2026-10-10); keeps: which machine its files
    // and some of its chats stay on (keeps.js, fleet-view.js hostRules)
    items.push({
      label: 'Workspace settings', icon: 'settings',
      children: [repoRenameItem(folder), repoColorItem(folder), { sep: true }, ...(pushHook() ? [repoPushItem(folder, repo.push || 'production')] : []), keepsItem(rIt.root, rIt.name)],
    });
    // its removed conversations (only when it has any), all of them: continue, show again or forget each; then the
    // ones the age rules took off the map (Left the map ▸): show again or continue each
    const rm = removedMenuItem(removedFor(folder), false);
    if (rm) items.push(rm);
    const lm = leftMapMenuItem(leftMapFor(folder), false);
    if (lm) items.push(lm);
    // the other computer's chats in it, copied to this machine as its own (clone.js; only when that machine has some)
    const cw = cloneWorkspaceItem({ root: rIt.root, name: rIt.name, sessions: state?.sessions || [] });
    if (cw) items.push(cw);
    // the repo and its conversations leave every view (the workspace list too); Undo on the toast
    items.push({ sep: true }, { label: 'Remove workspace', icon: 'close', danger: true, run: () => removeRepo({ root: folder, name: target.name || repo.name }) });
    openCtxMenu({ x, y, title: target.name || repo.name || repoName(folder), dot: color, sub: folder, items });
    return;
  }
  if (target.kind === 'space') {
    // empty space on the map, around the cards or tiles, or the Projects list: first the workspace shown (never in
    // Bots: no workspace filters it), then add a repo or one removed, and every removed conversation and every one that
    // left the map (its workspace in the note; those with no workspace are only here)
    const show = local.view === 'chats' ? [] : [workspaceMenuItem(), { sep: true }];
    const rmRepos = removedReposMenuItem({ x, y });
    const rmAll = removedMenuItem(removedFor(), true), lmAll = leftMapMenuItem(leftMapFor(), true);
    // no desktop-notification switch here: the header's bell has it (Henry, 2026-10-10)
    const extra = [];
    const lay = layoutMenuItem();
    if (lay) extra.push({ sep: true }, lay);
    if (accountsMenuItem()) extra.push(...(lay ? [] : [{ sep: true }]), accountsMenuItem());
    if (multi.size) extra.push({ label: `Clear selection (${multi.size})`, icon: 'close', run: () => setMulti([], 'menu') });
    // the map's own: put a bot on it where the menu was opened (map-bots.js draws it)
    const addBot = local.view === 'map' && typeof mapMod?.mapWorldAt === 'function' ? [addBotMenuItem(x, y)] : [];
    openCtxMenu({ x, y, items: [...show, addRepoMenuItem({ x, y }), ...addBot, ...(rmRepos ? [rmRepos] : []), ...(rmAll ? [rmAll] : []), ...(lmAll ? [lmAll] : []), ...extra] });
    return;
  }
  const s = (view?.allSessions || state.sessions || []).find((x) => x.id === target.id);
  if (!s) return;
  const hosted = isHosted(s.id);
  const items = [...extraItems(target.extra)];
  if (previousMenuItem(s)) items.push(previousMenuItem(s));
  items.push(renameMenuItem(s), sessionColorItem(s));
  if (desk && !s.pending && !s.demo) items.push(forkMenuItem(s));
  if (!s.pending && !s.demo) { const mv = moveMenuItem(s); if (mv) items.push(mv); }
  if (desk && !s.pending && !s.demo && !singleAccount()) { const se = sendElsewhereItem(s, hosted); if (se) items.push(se); }
  items.push(...teamItems(s));
  const bw = botWatchItem(s);
  if (bw) items.push(bw);
  if (waitingOrderItem(s)) items.push(waitingOrderItem(s));
  // push sits at the bottom, just above Remove (Henry, 2026-10-10); no "Unpin from the map" here (Henry, 2026-10-13)
  if (!s.pending && !s.demo && pushHook()) items.push({ sep: true }, sessionPushItem(s));
  // Remove: ends the session if it runs here, and takes the conversation off the map, cards and strip (Henry: "to me end
  // is delete"). Its log stays on disk; it comes back by itself if it works again (open in another window, say).
  const st = hosted ? hostStatus(s.id) : null;
  const busy = hosted && (st ? st === 'busy' : s.state === 'WORKING' || s.state === 'AGENTS');
  items.push({ sep: true });
  items.push({ label: 'Remove conversation', icon: 'close', danger: true, confirm: busy ? { text: BUSY_Q, yes: 'Remove anyway' } : null, run: () => removeFromMenu(s.id) });
  const sub = s.pending ? `${s.repo?.name || ''}${singleAccount() ? '' : ` · account ${s.account}`}` : `${s.label || s.state}${s.repo ? ` · ${s.repo.name}` : ''}`;
  openCtxMenu({ x, y, title: s.name, dot: s.pending ? s.hue : statusColor(s), sub, items });
}
const statusColor = (s) => s.stateColor || C.dim;
// "Never continue on another machine…": the sheet for the workspace's stays-on rule (keeps.js). The whole list goes back with POST
// /settings { hostRules }, so it syncs to the other machines; the page takes the server's list on the next poll
function keepsItem(root, name) {
  const save = (list) => post('/settings', { hostRules: list }).then((r) => {
    if (!r && !FIXTURE) throw new Error('Fleet View did not answer: it was not saved');
    if (state && state.settings) { state.settings.hostRules = list; setRules(list); }
  });
  return { label: 'Never continue on another machine…', icon: 'pin', run: () => openKeeps({ root, name, rules: () => state?.settings?.hostRules || [], save, toast: (t) => toast(t, C.dim) }) };
}
// "Push to": where the work goes when it's done. Production is the standing rule (merge to main and ship); Preview
// pushes the branch for a preview and doesn't merge. A repo's choice is the default for its conversations, a
// conversation's own wins; the server keeps both (POST /push-target) and a hook tells the conversation at every
// prompt (scripts/push-target-hook.py). Without that hook nothing would tell it, so the items show only when the
// server saw the hook set up (state.tools.pushHook; a server too old to say keeps them).
const pushHook = () => state?.tools?.pushHook !== false;
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
    pollSoon();
  });
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
    const undo = () => post('/sessions/move', { id: s.id, root: before }).then(() => pollSoon());
    toast(root ? `Moved ${s.name} to ${r.name}` : `${s.name} is back in the workspace it started in`, C.mint, { label: 'Undo', run: undo });
    pollSoon();
    return true;
  });
}
// "Send to Claude A / B / C ...", one for each other account here (under Send elsewhere): it writes a handoff summary and a fresh conversation
// picks it up under that account, in a panel here (term.js sendToAccount). One running here is ended first; one open
// in another window has to be ended there. Only accounts it can work on are offered (state.tools.sendTo, the same
// rule the session host checks): the account has the /handoff and /pickup commands, and its projects folder is the
// conversation's account's own (two logins share one only when one's folder links to the other's).
function canSendTo(s, to) {
  const t = state?.tools?.sendTo;
  if (!t) return true; // a server too old to say
  const x = t[to], own = t[s.account || 'B'];
  return !!(x && x.commands && own && x.folder === own.folder);
}
// an account with nothing left of its weekly or 5-hour limit (until that limit resets): nothing can be sent to it.
// No usage read for it yet counts as not out.
function acctOut(a) {
  const w = state?.week?.[a], now = Date.now();
  if (!w) return false;
  const out = (x) => x && x.left <= 0 && !(x.resets && x.resets < now);
  return out(w) || out(w.five);
}
// switching accounts when one runs low (the server's account-switch.js, on unless turned off in the Usage card): a new
// conversation asked for on an account close to its limit starts on the one /state's accountSwitch.pick names, and a
// toast says so
setAccountPicker({
  pick: (a) => { const p = state?.accountSwitch?.on ? state.accountSwitch.pick?.[a] : null; return p && typeof p.to === 'string' ? { account: p.to, from: a, why: p.why } : null; },
  told: (p) => toast(`Started on Claude ${p.account}: ${p.why || `Claude ${p.from} is close to its limit`}`, C.dim),
});
// "Send elsewhere ▸ Claude A / C ...": one submenu of the accounts that are on (Henry, 2026-10-10), less those out
// of their 5-hour or weekly limit, which aren't shown at all (Henry, 2026-10-10)
function sendElsewhereItem(s, hosted) {
  const label = 'Send elsewhere';
  const to = onAccounts().filter((a) => a !== (s.account || 'B') && canSendTo(s, a) && !acctOut(a));
  if (!to.length) return null;
  if (openElsewhere(s) && !hosted) return { label, icon: 'send', disabled: true, note: 'open in another window; end it there' };
  const st = hosted ? hostStatus(s.id) : null;
  const busy = hosted && (st ? st === 'busy' : s.state === 'WORKING' || s.state === 'AGENTS');
  const children = to.map((a) => ({ label: `Claude ${a}`, tag: a,
    confirm: busy ? { text: `Claude is mid-turn. Stop it and send it to account ${a}?`, yes: 'Send anyway' } : null, run: () => sendToFromMenu(s, a) }));
  return { label, icon: 'send', children };
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
  return { label, icon: 'branch', run: () => forkFromMenu(s) };
}
async function forkFromMenu(s) {
  const r = await createSession({ cwd: s.cwd, account: s.account, forkFrom: s.id, ...newSize() });
  if (!r || !r.ok) { toast((r && r.message) || `could not fork ${s.name}`, C.red); return; }
  toast(`Forked ${s.name}: a new conversation with its history`, C.text);
  ui.setSelected(r.key, 'explicit');
}
// A queued message's Fork / New chat (chat.js, 'fv-chat-fork'): it is out of Claude Code's queue by now; a fork of
// its conversation (or a new one in its folder) starts in the panel and gets it once it is up (orders.js sendWhenUp).
// how 'at' (Fork on a message in the feed): the fork goes back to just before that message (forkat.js), which then
// waits in its chat box; nothing left any queue, so a failure needs no clipboard
window.addEventListener('fv-chat-fork', async (e) => {
  const d = e.detail || {};
  const s = (view?.allSessions || state?.sessions || []).find((x) => x.id === d.id);
  const text = String(d.text || '');
  if (d.how === 'at') { forkFromMessage(s, text, d.nth | 0); return; }
  if (d.how === 'quote') { forkWithQuote(s, text); return; }
  const fork = d.how !== 'new';
  const why = !s ? 'that conversation is no longer listed' : !s.cwd ? 'no folder known for it' : '';
  // New chat: on the main computer when one is picked (startChat), the message as its prompt; a fork starts here
  const r = why ? { ok: false, message: why } : fork ? await createSession({ cwd: s.cwd, account: s.account, forkFrom: s.id, ...newSize() })
    : await startChat({ cwd: s.cwd, account: s.account, prompt: text, ...newSize() });
  if (r && r.ok && r.remote) {
    if (!r.sent) { try { await navigator.clipboard.writeText(text); } catch {} }
    startedThere(r.sent ? r : { ...r, message: `${r.message || 'your message did not go in'}. Your message is on the clipboard` }, 'New conversation');
    return;
  }
  if (!r || !r.ok) {
    // nothing started: the message is out of the queue, so it goes to the clipboard rather than being lost
    try { await navigator.clipboard.writeText(text); } catch {}
    toast(`${fork ? 'Could not fork it' : 'Could not start a new conversation'}: ${(r && r.message) || 'failed'}. Your message is on the clipboard`, C.red, null, 9000);
    return;
  }
  sendWhenUp({ id: r.key, name: fork ? `the fork of ${s.name}` : 'the new conversation' }, text);
  toast((fork ? `Forked ${s.name}: your message goes in once it is up` : `New conversation in ${repoName(s.cwd)}: your message goes in once it is up`)
    + (d.images ? ' (without its images)' : ''), C.text);
  ui.setSelected(r.key, 'explicit');
});
// how 'quote' (Fork beside Reply on text selected in the feed): a fork with the whole history, the selection quoted
// in its chat box (as Reply would) to answer there; nothing is sent
async function forkWithQuote(s, text) {
  const why = !s ? 'that conversation is no longer listed' : !s.cwd ? 'no folder known for it' : '';
  const r = why ? { ok: false, message: why } : await createSession({ cwd: s.cwd, account: s.account, forkFrom: s.id, ...newSize() });
  if (!r || !r.ok) { toast(`Could not fork it: ${(r && r.message) || 'failed'}`, C.red); return; }
  handToChat(r.key, { quote: text });
  toast(`Forked ${s.name}: the selection waits quoted in the fork's chat box`, C.text);
  ui.setSelected(r.key, 'explicit');
}
async function forkFromMessage(s, text, nth) {
  const why = !s ? 'that conversation is no longer listed' : !s.cwd ? 'no folder known for it' : '';
  const r = why ? { ok: false, message: why } : await createSession({ cwd: s.cwd, account: s.account, forkFrom: s.id, ...newSize() });
  if (!r || !r.ok) { toast(`Could not fork it: ${(r && r.message) || 'failed'}`, C.red); return; }
  toast(`Forking ${s.name} from your message: the fork goes back to just before it…`, C.text);
  ui.setSelected(r.key, 'explicit');
  const w = await forkAt(r.key, text, nth);
  if (w.ok) toast('The fork is back to just before your message: it waits in the chat box to edit and send', C.text);
  else toast(`The fork has the whole conversation: it could not go back to your message (${w.message})`, C.red, null, 9000);
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
  if (parseMenu(screenText(id, MENU_ROWS))) return 'Claude is asking something';
  if (parseSpinner(lines)) return 'Claude is busy';
  const box = parsePromptBox(screenMarked(id, 40, { dim: true }));
  if (!box) return 'something covers its prompt';
  if (box.text) return 'its prompt has text in it';
  const w = await sendText(id, `/rename ${name}`, { beforeEnter: () => { const l = screenText(id, MENU_ROWS); return !l.length || !!parseMenu(l); } });
  return w.ok ? null : w.menu ? 'a question came up' : w.message || 'it could not be typed';
}
function removeFromMenu(id) {
  const s = view?.allSessions.find((x) => x.id === id);
  if (!s) return;
  if (isHosted(id)) endSession(id);
  cancelQueued(id);
  continued.delete(id);
  if (s.pending) { if (ui.selectedId === id) ui.selectedId = null; if (ui.detailId === id) ui.detailId = null; render(); return; }
  leaveOnRemove(s);
  hideConversation(s, 'removed');
}
// cols and rows for the new pty, from the room the panel will give it (the terminal fits itself once shown)
function newSize() {
  const w = Math.min(parseFloat(getComputedStyle($('work')).getPropertyValue('--detail-w')) || 504, window.innerWidth), h = window.innerHeight - 140;
  return { cols: Math.max(40, Math.min(400, Math.floor((w - 20) / 7.83))), rows: Math.max(10, Math.min(200, Math.floor(h / 17))) };
}
// ---------- New chats run on the main computer ----------
// Henry, 2026-10-17: with a main computer picked (GET /sync/main: main-machine.js) and this machine not it, a new chat
// starts there (POST /link/start: link-send.js, in that machine's own checkout of the repo), unless the link says it is
// offline; it shows here as that machine's other chats do (sync) and is picked once /state lists it (pickWhenListed).
// Offline, not linked, or no checkout of the repo there: it starts here, and a toast says why. No main computer picked,
// or this machine is it: here, as always. The workspace's New session, an empty chat's pasted copy and a queued
// message's New chat start this way; forks, Fork at a message, a dropped file's scratchpad and a new lead start here
// (they need this machine's copy of the conversation, its files, or its own session).
// o: { cwd, account, cols, rows, prompt? } -> createSession's { ok, key, message } for one started here (note: why not
// on the main computer, already shown), or { ok, remote: { id, name }, sent, message } for one there (id null while
// Claude Code had not named it; sent: the prompt went in)
const HERE_WHY = {
  offline: (n) => `${n} is offline, so this chat runs here`,
  not_linked: (n) => `${n} isn't linked with this machine, so this chat runs here`,
  revoked: (n) => `${n} isn't linked with this machine, so this chat runs here`,
  not_running: () => 'Sync isn\'t running here, so this chat runs here',
  stopped: () => 'Sync isn\'t running here, so this chat runs here',
  no_checkout: (n, repo) => `${n} has no checkout of ${repo}, so this chat runs here`,
  no_repo: (n, repo) => `${n} can't tell which repo ${repo} is, so this chat runs here`,
};
async function startChat(o) {
  const mm = FIXTURE ? null : await mainMachine();
  const main = mm && mm.main && mm.main.id && !mm.isMain ? mm.main : null;
  const here = async (note) => {
    const r = await createSession({ cwd: o.cwd, account: o.account, cols: o.cols, rows: o.rows });
    if (r && r.ok && note) toast(note, C.dim, null, 7000);
    return r && r.ok ? { ...r, note } : r;
  };
  if (!main) return here(null);
  const name = main.name || 'the main computer';
  if (mm.online === false) return here(HERE_WHY.offline(name));
  const r = await post('/link/start', { device: main.id, repo: o.cwd, account: o.account, ...(o.prompt ? { prompt: o.prompt } : {}) });
  // started there (ok, or a prompt held back by a question there: it still runs, with its id)
  if (r && (r.ok || (r.id && r.promptSent === false))) return { ok: true, remote: { id: r.id || null, name }, sent: !!r.promptSent, message: r.ok ? '' : r.message || '' };
  const why = r && HERE_WHY[r.code];
  if (why) return here(why(name, repoName(o.cwd)));
  return { ok: false, message: `Could not start it on ${name}: ${(r && r.message) || 'Fleet View did not answer'}` };
}
// a chat started on the main computer: picked here once /state lists it (sync brings it), unless Henry picked something
// else meanwhile; given up after PICK_WAIT_MS
const PICK_WAIT_MS = 3 * 60e3;
function pickWhenListed(id) {
  if (!id) return;
  const before = ui.selectedId, until = Date.now() + PICK_WAIT_MS;
  const look = () => {
    if (ui.selectedId !== before) return;
    if ((state?.sessions || []).some((x) => x.id === id)) { ui.setSelected(id, 'explicit'); return; }
    if (Date.now() < until) setTimeout(look, 1000);
  };
  look();
}
// the toast for a chat started on the main computer, and its pick once it shows here
function startedThere(r, what = 'New chat') {
  const { id, name } = r.remote;
  toast(r.message ? `${what} on ${name}: ${r.message}` : `${what} on ${name}: it shows here in a moment`, r.message ? C.gold : C.text, null, r.message ? 9000 : 0);
  pickWhenListed(id);
}
async function newSession(folder, account) {
  unhideRepo(repoForFolder(state || {}, folder).root || folder);
  const r = await startChat({ cwd: folder, account, ...newSize() });
  if (!r || !r.ok) { toast((r && r.message) || 'could not start a new session', C.red); return; }
  if (r.remote) { startedThere(r); return; }
  // its stand-in shows at once (map node, panel on Chat with the cursor in the chat box: detail.js)
  ui.setSelected(r.key, 'explicit');
}
onRekey((oldKey, id) => {
  if (ui.selectedId === oldKey) ui.selectedId = id;
  if (ui.detailId === oldKey) ui.detailId = id;
  if (pickIntent?.id === oldKey) pickIntent.id = id;
  if (tabWant?.id === oldKey) tabWant.id = id;
  if (mapRekey) { try { mapRekey(oldKey, id); } catch (e) { console.error(e); } }
  // the multi-selection too: else markMulti drops the new key as gone, and a selection that took the new session
  // along (Ctrl+click after it was picked) falls back to one conversation, whose menu has no "Give orders"
  if (multi.has(oldKey)) { setMulti([...multi].map((x) => (x === oldKey ? id : x)), 'cards'); return; }
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
// ---------- multi-selection: Ctrl+click on cards, tiles and map nodes, Ctrl+drag on the map ----------
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
// the first Ctrl+click takes the picked conversation along, or the one the panel shows (a pinned panel keeps its
// chat after an empty click picks nothing): Ctrl+click on a second card makes two
const shownId = () => ui.selectedId || (document.getElementById('detail')?.classList.contains('open') ? ui.detailId : null);
const withShown = (ids) => (!multi.size && ids?.length === 1 && shownId() && shownId() !== ids[0] ? [shownId(), ids[0]] : ids);
function toggleMulti(id) {
  if (!id) return;
  const next = new Set(multi);
  if (!next.size && shownId() && shownId() !== id) next.add(shownId());
  if (next.has(id)) next.delete(id); else next.add(id);
  setMulti([...next], 'cards');
}
ui.clearMulti = () => setMulti([], 'cards');
// the conversations of list that the views show now (the workspace filter and / filter applied)
const shownOf = (list) => { const ids = new Set((view?.sessions || []).map((s) => s.id)); return list.filter((s) => ids.has(s.id)); };
// Ctrl+A: every conversation the current view shows into the multi-selection (Projects: the rows of its list)
function selectAllShown() {
  let ids = (view?.sessions || []).map((s) => s.id);
  if (local.view === 'projects') {
    const listed = new Set((view?.allSessions || []).map((s) => s.id));
    ids = [...(viewEls.projects?.querySelectorAll('.pj-side [data-pick]') || [])].map((b) => b.dataset.pick).filter((id) => listed.has(id));
  }
  selectAll(ids);
}
function selectAll(ids) {
  if (!ids.length) { toast('no conversation to select here', C.dim); return; }
  setMulti(ids, 'keys');
  toast(`Selected ${ids.length === 1 ? 'one conversation' : `${ids.length} conversations`} · Esc clears`, C.dim);
}
// a double-click on a workspace (map.js, projects.js): its conversations into the multi-selection
ui.selectRepo = (root) => { if (state && root) selectAll(repoSessions(String(root)).filter((s) => !s.pending).map((s) => s.id)); };
// "Select all conversations" on a team's menu: the ones shown into the multi-selection
function selectAllItem(list, none) {
  if (!list.length) return { label: 'Select all conversations', icon: 'check', disabled: true, note: none };
  return { label: 'Select all conversations', icon: 'check', note: `${list.length}`, run: () => selectAll(list.map((s) => s.id)) };
}
// a split chat's ✕ (detail.js): out of the selection; the panel's own conversation hands its place to the next one
// A pinned split's ✕ lets go of its pin as well; the leading chat's ✕ hands its place to a pinned split when no
// other conversation is selected
ui.dropMulti = (id) => {
  if (splitPins.includes(id)) setSplitPins(splitPins.filter((x) => x !== id));
  const rest = [...multi].filter((x) => x !== id);
  const listed = new Set((view?.allSessions || []).map((x) => x.id));
  if (ui.detailId === id) ui.detailId = rest[0] || splitPins.find((x) => listed.has(x)) || null;
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
// o: { team, name(text), prefix, placeholder, value, note: true (sendNote: each gets the others' ids),
//      lead: the session that leads the team, newLead: { folder, account, repo } (a new conversation started there
//      when the order is sent leads it) }
function orderItem(label, list, o = {}) {
  const ic = o.icon || 'send';
  if (!termApi()) return { label, icon: ic, disabled: true, note: noTermNote() };
  if (!list.length) return { label, icon: ic, disabled: true, note: o.none || 'no conversation to reach' };
  // none of them can be typed into from here: say why now, not after the order is written
  const reachable = list.filter((s) => !unreachable(s));
  if (!reachable.length) return { label, icon: ic, disabled: true, note: list.length === 1 ? unreachable(list[0]) : `none can be reached here · ${unreachable(list[0])}` };
  const away = list.length - reachable.length;
  return {
    label, icon: ic, note: [o.subnote, away && list.length > 1 ? `${away} can't be reached here` : ''].filter(Boolean).join(' · ') || null,
    input: {
      multiline: true, images: true, value: o.value || '', placeholder: o.placeholder || 'What should they do?',
      hint: 'Enter sends · Shift+Enter new line · paste or drop images · Esc closes', busy: 'sending…', empty: 'write it first',
      // images are saved on the PC first (as the compose box's), and their paths go after the text: Claude Code
      // turns each into [Image #N]. One that can't be saved keeps the box open with the reason
      submit: async (text, imgs = []) => {
        const reach = list.filter((s) => !unreachable(s));
        if (!reach.length) return `none of them can be reached here: ${unreachable(list[0])}`;
        const paths = [];
        for (const b of imgs) {
          try { paths.push(await saveImage(b)); } catch (e) { return `couldn't save ${b.name || 'an image'}: ${e?.message || e}`; }
        }
        runOrder(list, messageText(text, paths), o);
        return null;
      },
    },
  };
}
async function runOrder(list, text, o) {
  let lead = o.lead || null;
  // a new conversation leads: it starts first (as a workspace's New session), then joins as the lead once it has
  // its id (orders.js waits for it before the team is made)
  if (o.newLead) {
    toast(`Starting a new conversation in ${o.newLead.repo} to lead…`, C.dim);
    const r = await startLead(o.newLead);
    if (!r.ok) { toast(`Nothing sent: the new lead did not start (${r.message})`, C.red, null, 9000); return { ok: false, results: [] }; }
    lead = r.session;
    list = [lead, ...list.filter((s) => s.id !== lead.id)];
  }
  const n = list.filter((s) => !unreachable(s)).length;
  toast(`Sending to ${n === 1 ? list.find((s) => !unreachable(s)).name : `${n} conversations`}${lead ? ` · ★ ${lead.name} leads` : ''}…`, C.dim);
  let res;
  try {
    if (o.note) {
      const results = await sendNote(list, text, state, o.prefix);
      res = { ok: results.some((x) => x.ok), team: null, results };
    } else {
      res = await sendOrder(list, text, { team: !!o.team, lead, state, post, fixture: FIXTURE, prefix: o.prefix || null, name: o.name ? o.name(text) : null });
    }
  } catch (e) { res = { ok: false, results: [], message: String(e?.message || e) }; }
  toast(orderSummary(res), res.ok ? C.mint : C.red, null, res.results?.some((x) => !x.ok || x.queued) ? 9000 : 0);
  if (DEBUG) window.__fvOrders = (window.__fvOrders || []).concat([{ text, team: res.team || null, results: res.results || [] }]);
  render();
  return res;
}
// an order waiting for a conversation's question or trust prompt to be answered (orders.js) goes in by itself:
// a toast says when, or why it didn't; its right-click menu can cancel it
onQueueDone((q, r) => {
  if (q.why === 'start') {
    if (!r.ok) toast(`Your message for ${q.name} was not sent: ${r.message}`, C.red, null, 9000);
    render();
    return;
  }
  toast(r.ok ? `Order sent to ${q.name} after it was answered` : `Order for ${q.name} not sent: ${r.message}`, r.ok ? C.mint : C.red, null, r.ok ? 0 : 9000);
  render();
});
function waitingOrderItem(s) {
  const q = queuedFor(s.id);
  if (!q.length) return null;
  return {
    label: q.length === 1 ? 'Cancel waiting order' : `Cancel ${q.length} waiting orders`, icon: 'close', note: firstWords(q[0].text.replace(/^\[Fleet View[^\]]*\]\s*/, ''), 6, 40),
    run: () => { const n = cancelQueued(s.id); toast(n ? `Cancelled ${n === 1 ? 'the order' : `${n} orders`} waiting for ${s.name}` : 'it was sent already', C.dim); },
  };
}
// a repo's conversations (the repo's root or one of its checkouts), not removed: working ones first, then idle
// ones (DONE: resumed to take the order; not ones that handed off), then new sessions with nothing in them yet (pending stand-ins)
function repoSessions(folder) {
  const st = state || {};
  const k = normRoot(repoForFolder(st, folder).root || folder);
  const inIt = (s) => s.repo && normRoot(s.repo.root) === k && !s.bot && !isHidden(s) && !handedOff(s);
  const listed = (st.sessions || []).filter(inIt);
  return [...listed.filter((s) => s.state !== 'DONE'), ...listed.filter((s) => s.state === 'DONE'), ...pendingSessions(st).filter(inIt)];
}
// "Give orders ▸" (4 conversations): Send to each (the same text to each, no team), Work together (one team of
// peers), Under a lead ▸ (one of them, or a new conversation, leads: the others report to it), then Model ▸,
// Effort ▸ and Fast mode ▸ for all of them, folded into one row to keep the menu short. Making a team is a choice,
// never the default. The count is the conversations it will reach: one open in another window can't be typed into
// from here (it is named in the item's note and left out).
function repoOrderItems(folder, name) {
  const all = repoSessions(folder);
  const off = (msg) => [{ label: 'Give orders', icon: 'send', disabled: true, note: msg }];
  if (!all.length) return off(`no conversation in ${name}`);
  if (!termApi()) return off(noTermNote());
  const list = all.filter((s) => !unreachable(s));
  const away = all.length - list.length;
  const awayNote = away ? `${away} more ${away === 1 ? 'is' : 'are'} open in another window` : '';
  if (!list.length) return off(`${away === 1 ? 'its one conversation is' : `all ${away} are`} open in another window`);
  const n = list.length;
  const count = `${n} conversation${n === 1 ? '' : 's'}`;
  const teamName = (text) => `${name} · ${firstWords(text, 4, 34)}`;
  const kids = [orderItem('Send to each', list, {
    team: false, icon: 'reply', subnote: n === 1 ? null : 'no team: each gets it on its own',
    placeholder: n === 1 ? `The order for ${list[0].name}` : `The same order for each conversation in ${name}, each on its own (no team)`,
  })];
  // a team has at most 12
  if (n >= 2) kids.push(teamItem(list, { name: teamName, placeholder: `The order for every conversation in ${name}. They become one team of peers and sort it out between them.` }));
  kids.push(underLeadItem(list, { name: teamName, folder, repo: name }));
  const set = setItems(list);
  return [{ label: 'Give orders', icon: 'send', note: [count, awayNote].filter(Boolean).join(' · '), children: [...kids, ...(set.length ? [{ sep: true }, ...set] : [])] }];
}
// "Work together": exactly these as one team of peers (they get each other's ids and talk directly)
function teamItem(list, o = {}) {
  if (list.length > TEAM_MAX) return { label: 'Work together', icon: 'merge', disabled: true, note: `a team has at most ${TEAM_MAX}; use Send to each` };
  return orderItem('Work together', list, { team: true, icon: 'merge', name: o.name, subnote: 'one team of peers: they get each other\'s ids and talk',
    placeholder: o.placeholder || 'The order for all of them. They become a team of peers and can message each other.' });
}
// "Under a lead ▸": one team with a lead (★). The lead gets the order and directs the others; they report to it and
// don't coordinate with each other unless it says so. A row per conversation ("<name> leads"), and "A new
// conversation leads" (started in o.folder when the order is sent, on the default account).
// o: { name(text) for the team, folder, repo (its name) }
function underLeadItem(list, o = {}) {
  const n = list.length;
  // the ones it would lead: those this window can type into (one open in another window is left out of the team)
  const others = (s) => list.filter((x) => x.id !== s.id && !unreachable(x));
  const who = (l) => (l.length === 1 ? l[0].name : `the ${l.length} others`);
  const rows = [];
  if (n >= 2) {
    for (const s of list) {
      const why = unreachable(s), k = others(s).length;
      if (why) { rows.push({ label: `${s.name} leads`, icon: 'star', disabled: true, note: why }); continue; }
      rows.push(n > TEAM_MAX ? { label: `${s.name} leads`, icon: 'star', disabled: true, note: `a team has at most ${TEAM_MAX}` }
        : !k ? { label: `${s.name} leads`, icon: 'star', disabled: true, note: 'none of the others can be reached here' }
        : orderItem(`${s.name} leads`, list, { team: true, lead: s, icon: 'star', name: o.name, subnote: `${k} report to it`,
          placeholder: `${s.name} gets the order and directs ${who(others(s))}; they report to it. The order:` }));
    }
    rows.push({ sep: true });
  }
  rows.push(newLeadItem(list, o));
  return { label: 'Under a lead', icon: 'star', note: 'one directs, the rest report to it', children: rows };
}
// the account a new lead starts on: B when it can (fv start's default), else the first one with room
function leadAccount() {
  const ok = onAccounts().filter((a) => !acctOut(a));
  return ok.includes('B') ? 'B' : ok[0] || null;
}
function newLeadItem(list, o) {
  const label = 'A new conversation leads';
  if (!o.folder) return { label, icon: 'plus', disabled: true, note: 'no workspace to start it in' };
  if (!termApi()) return { label, icon: 'plus', disabled: true, note: noTermNote() };
  const acct = leadAccount();
  if (!acct) return { label, icon: 'plus', disabled: true, note: 'no account has room to start one now' };
  const reach = list.filter((s) => !unreachable(s));
  if (reach.length + 1 > TEAM_MAX) return { label, icon: 'plus', disabled: true, note: `a team has at most ${TEAM_MAX}` };
  const who = reach.length === 1 ? reach[0].name : `the ${reach.length} of them`;
  return orderItem(label, list, {
    team: true, icon: 'plus', name: o.name, newLead: { folder: o.folder, account: acct, repo: o.repo || repoName(o.folder) },
    subnote: `new in ${o.repo || repoName(o.folder)}${singleAccount() ? '' : ` · account ${acct}`} · ${reach.length} report to it`,
    placeholder: `A new conversation in ${o.repo || repoName(o.folder)} gets the order and directs ${who}; they report to it. The order:`,
  });
}
// a new conversation to lead: started like a workspace's New session (its panel opens), its stand-in returned
// (keyed new-<n> until its claude names its id; sendOrder waits for that)
async function startLead({ folder, account }) {
  unhideRepo(repoForFolder(state || {}, folder).root || folder);
  const r = await createSession({ cwd: folder, account, ...newSize() });
  if (!r || !r.ok) return { ok: false, message: (r && r.message) || 'could not start a new session' };
  ui.setSelected(r.key, 'explicit');
  const stand = pendingSessions(state || {}).find((s) => s.id === r.key);
  return { ok: true, session: { ...(stand || { id: r.key, pending: true, account, cwd: folder, repo: repoForFolder(state || {}, folder) }), name: 'new session' } };
}
// "Model ▸", "Effort ▸", "Fast mode ▸": one setting for each of them, typed in as /model <id>, /effort <level> or
// /fast on|off. Claude Code runs these at once, even mid-turn. A tick: every one of them has it already; "2 of 5":
// some do (read from each one's latest reply). /model and /effort also become the default for new sessions.
// Dynamic, first in Model ▸ and Effort ▸: that part sized for each message sent from the chat box (compose.js, POST
// /chat/dynamic); a fixed pick turns it off. Bots keep theirs in the Bots tab, so theirs are left out of it.
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
  const dynList = reach.filter((s) => isConvId(s.id) && !s.bot);
  const dynKid = (kind) => {
    if (!dynList.length) return [];
    const k = dynList.filter((s) => s.dynamic && s.dynamic[kind]).length, all = k === dynList.length;
    return [{ label: 'Dynamic', icon: all ? 'check' : null, badge: k && !all ? `${k} of ${dynList.length}` : null, note: 'sized for each message',
      run: () => runDynamic(dynList, kind, !all) }];
  };
  const fixed = (kind, cmd) => (s) => runSet(s, cmd, kind);
  return [
    { label: 'Model', icon: 'model', note: who, children: [...dynKid('model'), ...MODEL_IDS.map((id) => ({ ...kid(modelLabel(id), (s) => modelOf(s) === id && !(s.dynamic && s.dynamic.model), `/model ${id}`), run: () => fixed('model', `/model ${id}`)(reach) }))] },
    { label: 'Effort', icon: 'think', note: who, children: [...dynKid('effort'), ...EFFORTS.map((e) => ({ ...kid(e === 'xhigh' ? 'Extra high' : e[0].toUpperCase() + e.slice(1), (s) => s.effort === e && !(s.dynamic && s.dynamic.effort), `/effort ${e}`), run: () => fixed('effort', `/effort ${e}`)(reach) }))] },
    { label: 'Fast mode', icon: 'fast', note: who, children: [kid('On', (s) => s.fast === true, '/fast on'), kid('Off', (s) => s.fast === false, '/fast off')] },
  ];
}
// Dynamic on or off for that part (kind 'model' or 'effort') of each conversation in list (POST /chat/dynamic)
async function runDynamic(list, kind, on) {
  const res = await Promise.all(list.map((s) => fetch('/chat/dynamic', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: s.id, [kind]: on }) })
    .then((r) => r.ok, () => false)));
  const ok = res.filter(Boolean).length, who = list.length === 1 ? list[0].name : `${list.length} conversations`;
  toast(ok === list.length ? `Dynamic ${kind} ${on ? 'on' : 'off'} · ${who}` : `Dynamic ${kind}: ${ok} of ${list.length} changed`, ok === list.length ? C.mint : C.red);
  pollSoon();
}
// kind: a fixed model or effort, which turns Dynamic off for that part first where it was on
async function runSet(list, cmd, kind = null) {
  const dyn = kind ? list.filter((s) => isConvId(s.id) && !s.bot && s.dynamic && s.dynamic[kind]) : [];
  if (dyn.length) await Promise.all(dyn.map((s) => fetch('/chat/dynamic', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: s.id, [kind]: false }) }).catch(() => null)));
  toast(`${cmd} → ${list.length === 1 ? list[0].name : `${list.length} conversations`}…`, C.dim);
  let res;
  try { res = { results: await sendEach(list, cmd) }; res.ok = res.results.some((x) => x.ok); } catch (e) { res = { ok: false, results: [], message: String(e?.message || e) }; }
  toast(`${cmd} · ${orderSummary(res)}`, res.ok ? C.mint : C.red, null, res.results.some((x) => !x.ok || x.queued) ? 9000 : 0);
  render();
}
// the "N conversations" menu (a multi-selection). "Give orders ▸" as on a workspace: Work together (one team of
// peers), Under a lead ▸ (one of them, or a new conversation in the first one's workspace, leads), Send to each,
// then Model ▸, Effort ▸ and Fast mode ▸ for all of them. Then the single conversation's own actions for each of
// them: Fork, Move to workspace ▸, Send elsewhere ▸, Push to ▸ and Cancel waiting orders (new
// sessions with no id yet are left out of those that need one), each with one toast; a move or push has one Undo
function sessionsMenu(list, x, y) {
  const desk = !!termApi();
  const live = list.filter((s) => isHosted(s.id));
  const set = setItems(list);
  const first = list.find((s) => s.repo && s.repo.root) || null;
  const folder = first ? first.repo.root : null;
  const orders = desk
    ? { label: 'Give orders', icon: 'send', note: `${list.length} conversations`, children: [
      teamItem(list),
      underLeadItem(list, { folder, repo: first ? first.repo.name || repoName(folder) : null }),
      orderItem('Send to each', list, { team: false, icon: 'reply', subnote: 'no team: each gets it on its own', placeholder: 'The same message to each of them, each on its own (no team)' }),
      ...(set.length ? [{ sep: true }, ...set] : []),
    ] }
    : { label: 'Give orders', icon: 'send', disabled: true, note: noTermNote() };
  openCtxMenu({ x, y, title: `${list.length} conversations`, dot: C.cyan, sub: list.map((s) => s.name).join(' · '), items: [
    orders, addManyItem(list), { sep: true },
    ...[forkManyItem(list), moveManyItem(list), desk && !singleAccount() ? sendManyItem(list) : null, pushHook() ? pushManyItem(list) : null,
      cancelManyItem(list)].filter(Boolean),
    { sep: true },
    live.length ?{ label: 'Interrupt all', icon: 'stop', note: `${live.length} running here`, run: () => interruptAll(live) } : { label: 'Interrupt all', icon: 'stop', disabled: true, note: 'none of them runs here' },
    desk ? { label: 'Open all here', icon: 'shell', run: () => openAllHere(list) } : { label: 'Open all here', icon: 'shell', disabled: true, note: noTermNote() },
    { sep: true },
    { label: 'Clear selection', icon: 'close', run: () => setMulti([], 'menu') },
    removeAllItem(list),
  ] });
}
// ---- the single conversation's actions for a whole selection ----
// the ones with an id: new sessions (pending stand-ins) and demo ones can't be forked, moved, sent or pushed
const realOf = (list) => list.filter((s) => !s.pending && !s.demo);
const midTurn = (s) => isHosted(s.id) && (hostStatus(s.id) ? hostStatus(s.id) === 'busy' : s.state === 'WORKING' || s.state === 'AGENTS');
const nOf = (k, n) => (k < n ? `${k} of ${n}` : null);
const whoOf = (l) => (l.length === 1 ? l[0].name : `${l.length} conversations`);
// "1 new one is left out" when the selection has new sessions in it
const newLeft = (list, real) => { const k = list.length - real.length; return k ? `${k} new ${k === 1 ? 'one is' : 'ones are'} left out` : ''; };
const noteOf = (...parts) => parts.filter(Boolean).join(' · ') || null;
// "Fork": a fork of each (as the single Fork), in the panel; the first one is picked
function forkManyItem(list) {
  const label = 'Fork each';
  if (!termApi()) return { label, icon: 'branch', disabled: true, note: noTermNote() };
  const real = realOf(list), go = real.filter((s) => s.cwd);
  if (!go.length) return { label, icon: 'branch', disabled: true, note: real.length ? 'no folder known for them' : 'none of them has an id yet' };
  const off = real.length - go.length;
  return { label, icon: 'branch', note: noteOf(`${go.length} new conversations`, off ? `${off} with no folder known` : '', newLeft(list, real)), run: () => forkMany(go) };
}
async function forkMany(list) {
  toast(`Forking ${whoOf(list)}…`, C.dim);
  const keys = [], bad = [];
  // one at a time: each new session takes its own key and panel size
  for (const s of list) {
    const r = await createSession({ cwd: s.cwd, account: s.account, forkFrom: s.id, ...newSize() });
    if (r && r.ok) keys.push(r.key); else bad.push((r && r.message) || `could not fork ${s.name}`);
  }
  if (!keys.length) { toast(bad[0] || 'could not fork them', C.red); return; }
  toast(bad.length ? `Forked ${keys.length} · ${bad.length} did not start: ${bad[0]}` : `Forked ${whoOf(list)}: ${keys.length === 1 ? 'a new conversation' : `${keys.length} new conversations`} with their history`,
    bad.length ? C.red : C.text, null, bad.length ? 9000 : 0);
  ui.setSelected(keys[0], 'explicit');
}
// "Move to workspace ▸": one submenu of the listed repos (less one all of them are in already: "2 of 3" when some
// are), and "Back to the workspace each started in" when any were moved. One Undo puts each back where it was.
function moveManyItem(list) {
  const label = 'Move to workspace';
  const real = realOf(list);
  if (!real.length) return { label, icon: 'folder', disabled: true, note: 'none of them has an id yet' };
  const n = real.length;
  const away = (r) => real.filter((s) => !s.repo || normRoot(s.repo.root) !== normRoot(r.root));
  const repos = (state?.repos || []).filter((r) => r.root && !repoIsHidden(r.root) && away(r).length)
    .sort((a, b) => isHomeRoot(a.root) - isHomeRoot(b.root) || repoName(a.root).localeCompare(repoName(b.root)));
  const children = repos.map((r) => ({ label: r.name || repoName(r.root), icon: 'folder', badge: nOf(away(r).length, n), run: () => moveMany(away(r), r.root) }));
  const moved = real.filter((s) => s.moved);
  if (moved.length) children.unshift({ label: 'Back to the workspace each started in', icon: 'reply', badge: nOf(moved.length, n), run: () => moveMany(moved, null) }, ...(children.length ? [{ sep: true }] : []));
  if (!children.length) return { label, icon: 'folder', disabled: true, note: 'no other workspace listed' };
  return { label, icon: 'folder', note: noteOf(`${n} conversations`, newLeft(list, real)), children };
}
async function moveMany(list, root) {
  const before = new Map(list.map((s) => [s.id, s.moved && s.repo ? s.repo.root : null]));
  const rs = await Promise.all(list.map((s) => post('/sessions/move', { id: s.id, root })));
  if (FIXTURE) return;
  const done = list.filter((s, i) => rs[i] && rs[i].ok), bad = rs.filter((r) => !r || !r.ok);
  if (!done.length) { toast(bad[0]?.message || 'could not move them', C.red); return; }
  const undo = () => Promise.all(done.map((s) => post('/sessions/move', { id: s.id, root: before.get(s.id) }))).then(() => pollSoon());
  const to = rs.find((r) => r && r.ok)?.name;
  const one = done.length === 1;
  toast((root ? `Moved ${whoOf(done)} to ${to}` : `${whoOf(done)} ${one ? 'is' : 'are'} back in the workspace ${one ? 'it' : 'each'} started in`)
    + (bad.length ? ` · ${bad.length} could not move: ${bad[0]?.message || 'failed'}` : ''), bad.length ? C.red : C.mint, { label: 'Undo', run: undo });
  pollSoon();
}
// "Send elsewhere ▸": the accounts that are on, less those out of their limit, as the single one's; each row sends
// the ones not on that account already ("2 of 3"), less one open in another window (it has to be ended there)
function sendManyItem(list) {
  const label = 'Send elsewhere';
  const real = realOf(list);
  const canGo = (s, a) => a !== (s.account || 'B') && canSendTo(s, a);
  const to = onAccounts().filter((a) => !acctOut(a) && real.some((s) => canGo(s, a)));
  if (!to.length) return null;
  const goes = (a) => real.filter((s) => canGo(s, a) && !(openElsewhere(s) && !isHosted(s.id)));
  if (!to.some((a) => goes(a).length)) return { label, icon: 'send', disabled: true, note: 'open in another window; end them there' };
  const children = to.map((a) => {
    const go = goes(a), busy = go.filter(midTurn).length;
    if (!go.length) return { label: `Claude ${a}`, tag: a, disabled: true, note: 'open in another window' };
    return { label: `Claude ${a}`, tag: a, badge: nOf(go.length, real.length),
      confirm: busy ? { text: `Claude is mid-turn in ${busy === 1 ? 'one of them' : busy}. Stop ${busy === 1 ? 'it' : 'them'} and send ${go.length === 1 ? 'it' : `all ${go.length}`} to account ${a}?`, yes: 'Send anyway' } : null,
      run: () => sendManyTo(go, a) };
  });
  return { label, icon: 'send', note: noteOf(newLeft(list, real)), children };
}
async function sendManyTo(list, to) {
  toast(`Sending ${whoOf(list)} to Claude ${to}: each writes a summary, then a fresh conversation picks it up`, C.text);
  const size = newSize();
  const rs = await Promise.all(list.map((s) => sendToAccount(s, to, size).catch((e) => ({ ok: false, message: String(e?.message || e) }))));
  const bad = rs.filter((r) => !r || !r.ok), ok = list.length - bad.length;
  if (!ok) { toast(bad[0]?.message || `could not send them to Claude ${to}`, C.red); return; }
  toast(bad.length ? `${ok} sent to Claude ${to} · ${bad.length} could not go: ${bad[0]?.message || 'failed'}` : `Sent ${whoOf(list)} to Claude ${to}`, bad.length ? C.red : C.mint, null, bad.length ? 9000 : 0);
}
// "Push to ▸": Workspace default, Production or Preview for each (a tick: all of them have it; "2 of 3": some do).
// One Undo gives each its own choice back.
function pushManyItem(list) {
  const real = realOf(list);
  if (!real.length) return null;
  const n = real.length;
  const own = (s) => s.push?.own || null, eff = (s) => own(s) || s.push?.repo || 'production';
  const kid = (label, t) => { const k = real.filter((s) => own(s) === t).length; return { label, icon: k === n ? 'check' : null, badge: k && k < n ? `${k} of ${n}` : null, run: () => pushMany(real, t) }; };
  const all = new Set(real.map(eff));
  return { label: 'Push to', icon: 'push', badge: all.size === 1 ? [...all][0] : 'mixed', note: noteOf(newLeft(list, real)),
    children: [kid('Workspace default', null), { sep: true }, ...['production', 'preview'].map((t) => kid(PUSH_NAME[t], t))] };
}
async function pushMany(list, target) {
  const before = new Map(list.map((s) => [s.id, s.push?.own || null]));
  const rs = await Promise.all(list.map((s) => post('/push-target', { id: s.id, target })));
  if (FIXTURE) return;
  const done = list.filter((s, i) => rs[i] && rs[i].ok), bad = rs.filter((r) => !r || !r.ok);
  if (!done.length) { toast(bad[0]?.message || 'could not set where they push', C.red); return; }
  const undo = () => Promise.all(done.map((s) => post('/push-target', { id: s.id, target: before.get(s.id) }))).then(() => pollSoon());
  const one = done.length === 1;
  toast((target ? `${whoOf(done)} push${one ? 'es' : ''} to ${PUSH_NAME[target]}` : `${whoOf(done)} follow${one ? 's its' : ' their'} workspace again`)
    + (bad.length ? ` · ${bad.length} could not be set` : ''), bad.length ? C.red : C.mint, { label: 'Undo', run: undo });
  pollSoon();
}
// "Cancel N waiting orders": every order waiting for one of them (new sessions' first messages too)
function cancelManyItem(list) {
  const withQ = list.filter((s) => queuedFor(s.id).length);
  if (!withQ.length) return { label: 'Cancel waiting orders', icon: 'close', disabled: true, note: 'none of them has one waiting' };
  const k = withQ.reduce((a, s) => a + queuedFor(s.id).length, 0);
  return { label: k === 1 ? 'Cancel waiting order' : `Cancel ${k} waiting orders`, icon: 'close', note: withQ.length === 1 ? withQ[0].name : `for ${withQ.length} of them`,
    run: () => {
      const n = withQ.reduce((a, s) => a + cancelQueued(s.id), 0);
      toast(n ? `Cancelled ${n === 1 ? 'the order' : `${n} orders`} waiting for ${whoOf(withQ)}` : 'they were sent already', C.dim);
      render();
    } };
}
// "Remove N conversations": the single Remove for each (ends the ones running here, takes them off every view)
function removeAllItem(list) {
  const busy = list.filter((s) => isHosted(s.id) && (hostStatus(s.id) ? hostStatus(s.id) === 'busy' : s.state === 'WORKING' || s.state === 'AGENTS')).length;
  const text = `Remove ${list.length} conversations?${busy ? ` Claude is mid-turn in ${busy === 1 ? 'one of them' : busy}; ${busy === 1 ? 'it ends' : 'they end'} too.` : ''}`;
  return { label: `Remove ${list.length} conversations`, icon: 'close', danger: true, confirm: { text, yes: 'Remove' }, run: () => removeMany(list.map((s) => s.id)) };
}
function removeMany(ids, text = null) {
  let n = 0, first = null;
  for (const id of ids) {
    const s = view?.allSessions.find((x) => x.id === id);
    if (!s) continue;
    if (isHosted(id)) endSession(id);
    cancelQueued(id);
    continued.delete(id);
    if (!s.pending) { leaveOnRemove(s); hidden.set(id, Date.now()); }
    if (ui.selectedId === id) ui.selectedId = null;
    if (ui.detailId === id) ui.detailId = null;
    n++; first = first || s;
  }
  if (!n) return;
  saveHidden();
  for (const id of ids) multi.delete(id);
  try { mapMod?.setMapSelection?.([...multi]); } catch (e) { console.error(e); }
  const gone = ids.filter((id) => hidden.has(id));
  const undo = () => { const back = gone.filter((id) => hidden.has(id)); if (!back.length) return; for (const id of back) unhide(id); saveHidden(); render(); };
  toast(text || (n === 1 ? `Removed ${first.name}. It comes back if it works again` : `Removed ${n} conversations. Each comes back if it works again`), C.dim, { label: 'Undo', run: undo, ms: 6000 });
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
// ---------- teams ----------
// The server keeps the teams and tells their members what changed (POST /teams/add, /teams/leave, /teams/remove):
// a newcomer gets the order with its teammates, the others a note with its id; one that leaves or is taken out,
// and the rest, get a note; a disband tells everyone. Notes go only to conversations running now (each costs a
// Claude turn), and wait behind a question. The page only asks and says what happened in a toast.
const isConvId = (id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id || ''));
const teamById = (id) => (id && (state?.teams || []).find((t) => t.id === id)) || null;
// "told 2" from a team call's reply: the notes that went in or wait behind a question
const toldN = (list) => `told ${(list || []).filter((x) => x.ok).length}`;
const nameOfId = (id) => sessionsOf([id])[0]?.name || String(id || '').slice(0, 8);
// a team (right-click its link or pill on the map, or a member's 'Team "x" ▸')
function teamMenu(t, x, y, extra) {
  const lead = leadOf(t);
  openCtxMenu({ x, y, title: lead ? `★ ${nameOfId(lead)} · ${t.name}` : t.name, dot: t.color || C.cyan,
    sub: `${t.members.length} conversations${lead ? `, led by ${nameOfId(lead)}` : ', peers'} · ${firstWords(t.order, 10, 70)}`, items: [...extraItems(extra), ...teamMenuItems(t, true)] });
}
// a caller's own items on top of a menu (the Bots list's Pin / Unpin: chats.js), then a line
const extraItems = (extra) => (Array.isArray(extra) && extra.length ? [...extra, { sep: true }] : []);
// "Lead ▸": who leads the team (they report to it), or no lead (peers again). POST /teams/lead
function leadItem(t) {
  const cur = leadOf(t);
  const kids = sessionsOf(t.members).map((s) => (s.id === cur
    ? { label: `${s.name} leads`, icon: 'check', disabled: true, note: 'it leads now' }
    : { label: `${s.name} leads`, icon: 'star', note: cur ? 'takes over the lead' : 'the others report to it', run: () => setLead(t, s) }));
  if (cur) kids.push({ sep: true }, { label: 'No lead (peers)', icon: 'merge', note: 'they work it out between them', run: () => setLead(t, null) });
  return { label: 'Lead', icon: 'star', note: cur ? `★ ${nameOfId(cur)}` : 'none: peers', children: kids };
}
async function setLead(t, s) {
  toast(s ? `Making ${s.name} the lead of "${t.name}"…` : `"${t.name}" goes back to peers…`, C.dim);
  const r = await post('/teams/lead', { id: t.id, member: s ? s.id : null });
  if (FIXTURE && r == null) return;
  if (!r || !r.ok) { toast((r && r.message) || 'could not change the lead', C.red); return; }
  const b = r.brief || null, bad = !!(s && b && !b.ok);
  const got = bad ? `${s.name} did not get its brief (${b.message || 'not sent'})` : s && b && b.queued ? `${s.name} gets its brief once its question is answered` : null;
  toast([s ? `★ ${s.name} leads "${t.name}"` : `"${t.name}" has no lead: peers again`, toldN(r.told), got].filter(Boolean).join(' · '), bad ? C.red : C.mint, null, bad ? 9000 : 0);
}
// "Message the team": every member not removed from the map, each on its own, under the team's name (the menu item
// and the Bots view's group chat box, ui.messageTeam)
const teamMembers = (t) => sessionsOf(t.members).filter((s) => !isHidden(s));
const teamMsgOpts = (t) => ({ team: false, prefix: `[Fleet View · team "${t.name}"]`, placeholder: `A message to every conversation in "${t.name}"` });
// why the team can't be messaged from here (orderItem's checks), or null
function teamReach(t) {
  if (!t) return 'that team is gone';
  if (!termApi()) return noTermMsg('Messaging the team');
  const list = teamMembers(t);
  if (!list.length) return 'no conversation in the team to reach';
  return list.some((s) => !unreachable(s)) ? null : `none of them can be reached here: ${unreachable(list[0])}`;
}
function teamMenuItems(t, full) {
  // members removed from the map are left out of what goes to them
  const all = sessionsOf(t.members), members = teamMembers(t);
  const sel = ui.selectedId && !t.members.includes(ui.selectedId) ? sessionsOf([ui.selectedId])[0] : null;
  const items = [orderItem('Message the team', members, teamMsgOpts(t)), leadItem(t),
    teamRenameItem(t), selectAllItem(shownOf(members), 'none of them is shown now')];
  if (full) {
    const why = !sel ? (ui.selectedId ? 'it is in this team already' : 'pick one first') : joinWhy(sel, t);
    items.push(why ? { label: 'Add picked conversation', icon: 'plus', disabled: true, note: why }
      : { label: `Add ${sel.name}`, icon: 'plus', note: 'the picked conversation', run: () => addToTeam(t, sel) });
    items.push({ label: 'Remove member', icon: 'close', note: `${all.length}`, children: all.map((s) => ({ label: s.name, icon: 'close', run: () => leaveTeam(t, s, 'removed') })) });
    items.push({ sep: true }, ...all.map((s) => ({ label: `Pick ${s.name}`, icon: 'shell', run: () => pickFromAnywhere(s.id) })));
    items.push({ sep: true }, { label: 'Disband team', icon: 'close', danger: true, confirm: { text: `Disband "${t.name}"? Its conversations keep working; they stop being a team, and each is told.`, yes: 'Disband' }, run: () => disbandTeam(t) });
  }
  return items;
}
// "Rename team": a text box in the menu, like a conversation's Rename. POST /teams/rename keeps it with the team;
// the map, the menus and every note, brief and order from then on use it. Nobody is told now (a note costs a turn)
function teamRenameItem(t) {
  return {
    label: 'Rename team', icon: 'edit',
    input: { value: t.name || '', placeholder: 'the team\'s name', hint: 'Enter saves · Esc', busy: 'renaming…', empty: 'give it a name', submit: (text) => renameTeam(t, text) },
  };
}
// -> null when it worked, else a message (the menu's box shows it)
async function renameTeam(t, raw) {
  const name = cleanName(raw);
  if (!name) return 'give it a name';
  if (name === t.name) return null; // nothing changes
  const before = t.name;
  const r = await post('/teams/rename', { id: t.id, name });
  if (!(FIXTURE && r == null)) {
    if (!r || !r.ok) return (r && r.message) || 'could not reach Fleet View to rename it';
  }
  // at once, until the next /state has it
  const cur = teamById(t.id);
  if (cur) cur.name = (r && r.team && r.team.name) || name;
  render();
  const undo = async () => { const why = await renameTeam({ ...t, name }, before); if (why) toast(why, C.red); };
  toast(`Renamed "${before}" to "${name}"`, C.mint, { label: 'Undo', run: undo });
  return null;
}
// why s can't join t, or null
function joinWhy(s, t) {
  if (t.members.length >= TEAM_MAX) return `a team has at most ${TEAM_MAX} conversations`;
  return memberWhy(s);
}
// why s can't be in a team made from this window (an order can't reach it, or it has no id yet), or null
const memberWhy = (s) => unreachable(s) || (isConvId(s.id) ? null : 'it has not started yet: wait until it has');
// the Bots view's New team (ui.makeTeam): o { members: [ids], lead: id | null, name, order, above: team id | null }.
// The same as the team menus' orders (runOrder, POST /teams with send: the server types each brief); with above,
// its lead then joins that team as a plain member (POST /teams/add), so it reports there. -> { ok, team, message? }
// The checks before anything is sent are team-form.js checkTeam's (the phone's New team runs the same ones)
async function makeTeam(o) {
  const chk = checkTeam(o, { teams: state?.teams || [], max: TEAM_MAX, nameOf: nameOfId,
    listed: (id) => sessionsOf([id]).length > 0, whyNot: (id) => { const s = sessionsOf([id])[0]; return s ? memberWhy(s) : null; } });
  if (!chk.ok) return chk;
  const list = sessionsOf(chk.members), above = chk.above;
  const lead = chk.lead ? list.find((s) => s.id === chk.lead) || null : null;
  const res = await runOrder(list, chk.order, { team: true, lead, name: () => chk.name });
  if (!res || !res.team) return { ok: false, message: (res && res.message) || (res ? orderSummary(res) : 'could not make the team') };
  const team = res.team;
  // nested: its lead reports in the team above (a lead in it already stays there; the toast and the reply say what
  // went wrong, the team stays made)
  const step = nestStep(team, chk);
  if (!step) return { ok: true, team };
  if (step.message) { toast(step.message, C.red, null, 9000); return { ok: true, team, message: step.message }; }
  const r = await post('/teams/add', step.body);
  if (FIXTURE && r == null) return { ok: true, team };
  if (!r || !r.ok) { const m = nestFailed(team, above, r, nameOfId); toast(m, C.red, null, 9000); return { ok: true, team, message: m }; }
  toast(`★ ${nameOfId(team.lead)} reports in "${above.name}" for "${team.name}" · ${toldN(r.told)}`, C.mint);
  return { ok: true, team };
}
// a conversation's teams: up, the one it is a plain member of (where it reports), and own, the one it leads. Teams
// nest (fleet-view.js team-tree.js): a lead can report in a team above, so a conversation may be in both
function teamsOfS(s) {
  const own = teamById(s.leads) || (leadOf(teamById(s.team)) === s.id ? teamById(s.team) : null);
  const t = teamById(s.team), up = t && t !== own && leadOf(t) !== s.id ? t : null;
  return { up, own, all: [up, own].filter(Boolean) };
}
// a conversation's menu: one "Team ▸" row (Henry, 2026-10-10: few rows on the right-click, more in sub and
// sub-submenus) holding "Start team ▸" (tick who joins from its workspace), "Add to team ▸" (one row per team it
// isn't in), "Lead team ▸" (make it the lead of its own team, or join another team as its lead) and, for each team it
// is in (the one it reports in, the one it leads), 'Team "x" ▸' (Message the team, Lead ▸, Leave team, Disband team:
// a second step asks first). Joining a team as a member keeps the team it leads; joining one as its lead keeps the
// team it reports in (it leaves the one it led)
function teamItems(s) {
  if (s.pending || s.demo) return [];
  const { up, own, all: mine } = teamsOfS(s), others = (state?.teams || []).filter((t) => !mine.includes(t));
  const why = unreachable(s) || (isConvId(s.id) ? null : 'it has not started yet: wait until it has');
  const out = [startTeamItem(s, why)];
  if (others.length) {
    out.push(why ? { label: 'Add to team', icon: 'plus', disabled: true, note: why }
      : { label: 'Add to team', icon: 'plus', children: others.map((t) => {
        const full = t.members.length >= TEAM_MAX;
        return { label: t.name, icon: 'merge', disabled: full, note: full ? `full (${TEAM_MAX})`
          : `${t.members.length} conversations${up ? ` · it leaves "${up.name}"` : ''}${own ? ` · still leads "${own.name}"` : ''}`, run: () => addToTeam(t, s) };
      }) });
  }
  // it can only join another team when this window can reach it (as Add to team)
  if (!mine.length && others.length && why) out.push({ label: 'Lead team', icon: 'star', disabled: true, note: why });
  else if (mine.length || others.length) {
    const kids = [];
    if (own) kids.push({ label: `It leads "${own.name}"`, icon: 'check', disabled: true, note: 'its team' });
    if (up) {
      kids.push({ label: 'Make it the lead', icon: 'star', note: `of "${up.name}"${leadOf(up) ? `: takes over from ${nameOfId(leadOf(up))}` : ''}${own ? ` · it leaves "${own.name}"` : ''}`, run: () => setLead(up, s) });
    }
    if (mine.length && others.length) kids.push({ sep: true });
    for (const t of others) {
      const full = t.members.length >= TEAM_MAX, cur = leadOf(t);
      kids.push({ label: t.name, icon: 'star', disabled: !!why || full, note: why || (full ? `full (${TEAM_MAX})`
        : `joins it as the lead · ${t.members.length} report to it${cur ? ` · takes over from ${nameOfId(cur)}` : ''}${own ? ` · it leaves "${own.name}"` : ''}`),
      run: () => addToTeam(t, s, true) });
    }
    out.push({ label: 'Lead team', icon: 'star', children: kids });
  }
  for (const t of mine) {
    out.push({ label: `Team "${t.name}"`, icon: 'merge', children: [
      ...teamMenuItems(t, false),
      { label: 'Leave team', icon: 'close', run: () => leaveTeam(t, s, 'left') },
      { label: 'Disband team', icon: 'close', danger: true, children: [{ label: `Disband "${t.name}": each is told`, icon: 'close', danger: true, run: () => disbandTeam(t) }] },
    ] });
  }
  const note = [up ? `in "${up.name}"` : '', own ? `leads "${own.name}"` : ''].filter(Boolean).join(', ');
  return [{ label: 'Team', icon: 'merge', note: note || null, children: out }];
}
// the overseers' conversations now: each bot's of this machine, the one its Bots row opens
// (chats-model.js buildContacts), for a bot's "Start team ▸" and the Bots view's New team
function overseerSessions() {
  let rows = [];
  try { rows = buildContacts(view || state || {}); } catch { rows = []; }
  return sessionsOf(rows.filter((c) => c.kind !== 'team' && c.id && !c.elsewhere).map((c) => c.id));
}
// "Start team ▸": a checklist of the other conversations in its workspace (ticking keeps the menu open), "<it>
// leads" (on: it gets the order and the others report to it; off: one team of peers), then "Start team" opens the
// box for the order. The ticks live as long as the menu. A bot's (tagged bot) are the other
// overseers instead: each bot works in a folder of its own (~/Bots/<name>), so its workspace has no one else in it
function startTeamItem(s, why) {
  const label = 'Start team';
  if (why) return { label, icon: 'plus', disabled: true, note: why };
  if (!termApi()) return { label, icon: 'plus', disabled: true, note: noTermNote() };
  const over = !!s.bot;
  const folder = !over && s.repo && s.repo.root;
  const repo = over ? 'Bots' : s.repo ? s.repo.name || repoName(folder) : null;
  const cands = over ? overseerSessions().filter((c) => c.id !== s.id && c.bot !== s.bot && !c.demo)
    : folder ? repoSessions(folder).filter((c) => c.id !== s.id && !c.demo) : [];
  if (!cands.length) return { label, icon: 'plus', disabled: true, note: over ? 'no other bot has a conversation yet' : repo ? `no other conversation in ${repo}` : 'no workspace known for it' };
  const picked = new Set();
  let lead = true;
  const build = () => {
    const n = picked.size;
    const rows = [{ label: `${s.name} leads`, icon: lead ? 'check' : null, note: lead ? 'the others report to it' : 'off: they work as peers', stay: true, run: () => { lead = !lead; } }, { sep: true }];
    for (const c of cands) {
      const on = picked.has(c.id);
      const off = unreachable(c) || (isConvId(c.id) ? null : 'not started yet') || (!on && n + 1 >= TEAM_MAX ? `a team has at most ${TEAM_MAX}` : null);
      // one that leads a team keeps leading it; its seat in a team it reports in moves here
      const { up, own } = teamsOfS(c);
      rows.push({ label: c.name, icon: on ? 'check' : null, disabled: !!off, note: off || (up ? `in "${up.name}": it leaves it` : own ? `leads "${own.name}": still does` : c.label || c.state || null),
        stay: true, run: () => { if (on) picked.delete(c.id); else picked.add(c.id); } });
    }
    rows.push({ sep: true });
    const list = [s, ...cands.filter((c) => picked.has(c.id))];
    rows.push(!n ? { label, icon: 'send', disabled: true, note: 'tick who joins first' }
      : orderItem(`${label} · ${n + 1}`, list, { team: true, lead: lead ? s : null, icon: 'send', name: (text) => `${repo} · ${firstWords(text, 4, 34)}`,
        subnote: lead ? `★ ${s.name} leads · ${n} report to it` : `${n + 1} peers`,
        placeholder: lead ? `${s.name} gets the order and directs ${n === 1 ? list[1].name : `the ${n} others`}; they report to it. The order:`
          : 'The order for all of them. They become a team of peers and can message each other.' }));
    return { label, icon: 'plus', badge: n ? `${n + 1}` : null, note: repo ? `from ${repo}` : null, refresh: build, children: rows };
  };
  return build();
}
// a multi-selection's "Add to team ▸": every selected one that can join, into the team picked
function addManyItem(list) {
  const teams = state?.teams || [];
  if (!teams.length) return null;
  const can = list.filter((s) => isConvId(s.id) && !unreachable(s));
  if (!can.length) return { label: 'Add to team', icon: 'plus', disabled: true, note: 'none of them can join: not started yet, or not reachable here' };
  return { label: 'Add to team', icon: 'plus', note: can.length < list.length ? `${can.length} of ${list.length} can join` : null, children: teams.map((t) => {
    const go = can.filter((s) => !t.members.includes(s.id));
    const room = TEAM_MAX - t.members.length;
    const why = !go.length ? 'they are in it already' : go.length > room ? `room for ${room} more (at most ${TEAM_MAX})` : null;
    return { label: t.name, icon: 'merge', disabled: !!why, note: why || `${t.members.length} + ${go.length}`, run: () => addManyToTeam(t, go) };
  }) };
}
// lead: it joins as the team's lead (the others are told it leads now)
async function addToTeam(t, s, lead = false) {
  if (t.members.length >= TEAM_MAX) { toast(`a team has at most ${TEAM_MAX} conversations`, C.red); return; }
  toast(`Adding ${s.name} to "${t.name}"${lead ? ' as its lead' : ''}…`, C.dim);
  const r = await post('/teams/add', { id: t.id, member: s.id, ...(lead ? { lead: true } : {}) });
  if (FIXTURE && r == null) return;
  if (!r || !r.ok) { toast((r && r.message) || 'could not add it to the team', C.red); return; }
  const b = r.brief || {};
  const got = b.ok ? (b.queued ? `${s.name} gets the order once its question is answered` : null) : `${s.name} did not get the order (${b.message || 'not sent'})`;
  toast([lead ? `★ ${s.name} joined "${t.name}" as its lead` : `Added ${s.name} to "${t.name}"`, toldN(r.told), got, leftText(r.left)].filter(Boolean).join(' · '), b.ok ? C.mint : C.red, null, b.ok ? 0 : 9000);
}
async function addManyToTeam(t, list) {
  toast(`Adding ${list.length} to "${t.name}"…`, C.dim);
  let added = 0, bad = null;
  // one at a time: each add tells the members so far
  for (const s of list) {
    const r = await post('/teams/add', { id: t.id, member: s.id });
    if (r && r.ok) added++; else if (!bad && !(FIXTURE && r == null)) bad = `${s.name} (${(r && r.message) || 'failed'})`;
  }
  if (FIXTURE) return;
  toast(`Added ${added} to "${t.name}"${bad ? ` · not added: ${bad}` : ''}`, added ? C.mint : C.red);
}
// "· "x" lost a member" / "· "x" is disbanded": teams the new member was taken out of
const leftText = (left) => (left || []).map((x) => (x.disbanded ? `"${x.name}" is disbanded` : `it left "${x.name}"`)).join(' · ');
// why: 'left' (its own menu) or 'removed' (the team's Remove member); offMap: removed from the map (it is ending,
// so only the rest are told), with no toast of its own
async function leaveTeam(t, s, why, offMap = false) {
  const r = await post('/teams/leave', { id: t.id, member: s.id, why, hidden: offMap });
  if (offMap || (FIXTURE && r == null)) return;
  if (!r || !r.ok) { toast((r && r.message) || 'could not take it out of the team', C.red); return; }
  toast(`${s.name} ${why === 'left' ? 'left' : 'is out of'} "${t.name}" · ${toldN(r.told)}${r.disbanded ? ' · the team is disbanded (one was left)' : ''}`, C.dim);
}
async function disbandTeam(t) {
  const r = await post('/teams/remove', { id: t.id });
  if (FIXTURE && r == null) return;
  if (!r || !r.ok) { toast((r && r.message) || 'could not disband it', C.red); return; }
  toast(`Disbanded "${t.name}" · ${toldN(r.told)}`, C.dim);
}
// a conversation removed from the page leaves its teams (the server does the same when the hidden list reaches it)
function leaveOnRemove(s) {
  if (isConvId(s.id)) for (const t of teamsOfS(s).all) leaveTeam(t, s, 'removed', true);
}
// a new session that had no id yet when its team was made joined it once it had one (orders.js)
onTeamJoin((name, teamName, r, lead) => {
  if (r && r.ok) toast(`${lead ? '★ ' : ''}${name} joined "${teamName}"${lead ? ' as its lead' : ''} · ${toldN(r.told)}`, C.mint);
  else if (r) toast(`${name} could not join "${teamName}": ${r.message || 'failed'}`, C.red, null, 9000);
});
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
  if (file) items.push({ label: onPc('Open the file in VS Code'), icon: 'file', run: () => ui.reveal({ kind: 'file', path: file }) });
  items.push({ sep: true });
  for (const s of list) items.push({ label: `Pick ${s.name}`, icon: 'shell', run: () => pickFromAnywhere(s.id) });
  items.push({ sep: true });
  for (const s of list) items.push(isHosted(s.id) ? { label: `Interrupt ${s.name}`, icon: 'stop', run: () => interruptAll([s]) } : { label: `Interrupt ${s.name}`, icon: 'stop', disabled: true, note: 'not running here' });
  openCtxMenu({ x, y, title, dot: kind === 'branch' || kind === 'file' ? C.gold : C.red, sub: list.map((s) => s.name).join(' · '), items });
}
// a file dot or a PR dot on the map (right-click): open it, copy its path or link, or pick its conversation
// target: { kind: 'file', rel, abs?, wrote, sid } or { kind: 'pr', num, url?, sid }
function dotMenu(target, x, y) {
  const s = sessionsOf([target.sid])[0] || null;
  const file = target.kind === 'file';
  const name = file ? String(target.rel || '').split(/[\\/]/).pop() || target.rel : `PR #${target.num}`;
  const items = file
    ? [target.abs ? { label: onPc('Open the file in VS Code'), icon: 'file', run: () => ui.reveal({ kind: 'file', path: target.abs }) } : { label: onPc('Open the file in VS Code'), icon: 'file', disabled: true, note: 'its full path is not known' },
      { label: 'Copy path', icon: 'copy', run: () => copyOut(target.abs || target.rel, name) }]
    : [target.url ? { label: 'Open on GitHub', icon: 'external', run: () => openUrl(target.url) } : { label: 'Open on GitHub', icon: 'external', disabled: true, note: 'no GitHub link for it yet' },
      ...(target.url ? [{ label: 'Copy link', icon: 'copy', run: () => copyOut(target.url, `the link to PR #${target.num}`) }] : [])];
  if (s) items.push({ sep: true }, { label: `Pick ${s.name}`, icon: 'shell', run: () => pickFromAnywhere(s.id) });
  const sub = file ? [target.rel, s ? `${target.wrote ? 'edited' : 'read'} by ${s.name}` : ''].filter(Boolean).join(' · ') : s ? s.name : '';
  openCtxMenu({ x, y, title: name, dot: s?.hue || C.dim, sub, items });
}
async function copyOut(text, what) {
  try { await navigator.clipboard.writeText(text); toast(`Copied ${what}`, C.mint); }
  catch { toast('Could not reach the clipboard', C.red); }
}
// pick a conversation from a menu or a list: a shown one like a click on it, else its panel
function pickFromAnywhere(id) {
  if ((state?.sessions || []).some((s) => s.id === id && s.state !== 'DONE')) return fvSelect(id);
  if ((view?.allSessions || state?.sessions || []).some((s) => s.id === id)) return ui.showDetail(id, 'click');
  toast('that conversation is no longer listed', C.dim);
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
// the replay state with the shell's filters (workspace filter, / filter), shaped like derive()'s output
function replayView(rs) {
  const q = queryRe();
  const all = (rs.sessions || []).filter((s) => s && !s.bot && inRepo(s.repo)); // overseers: never on the map
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
const since = SOLO ? { isOpen: () => false, close() {}, toggle() {} }
  : mountSince({ fetchJson: getJson, onPick: (id) => pickFromAnywhere(id), fallback: (t) => sinceFromState(state, t) });
$('since-btn')?.addEventListener('click', (e) => { e.stopPropagation(); since.toggle(); });

// ---------- plan usage: this PC vs. elsewhere (usage.js; usage-watch.js on the server) ----------
if (!SOLO) usageUi = mountUsage({
  post, notifyOn: () => local.notify !== false, focusWindow: () => window.fleetDesktop?.focus?.(),
  // the Accounts list: read /state again soon after a change, and end this window's sessions on an account it removes
  refreshSoon: () => { pollSoon(400); setTimeout(() => pollSoon(), 2500); }, isHosted,
  endSessions: (ids) => { for (const id of ids) if (isHosted(id)) endSession(id); },
});
if (state) usageUi?.update(state);
// ---------- conversation sync: the header's "sync" button opens the Sync card (sync.js; sync-api.js on the server) ----------
// onHealth: the sync pill's colour changed (sync.js): the header is drawn again with the last view
const syncUi = SOLO ? null : mountSync({ post, isRemote: remotePage, fixture: !!FIXTURE, openSetup: () => setupUi?.open(), onHealth: () => { if (view) drawHeader(view); } });
// repos the other machines' chats work in that this one has no checkout of: asked once, then cloned by themselves (clone.js)
if (!SOLO) mountClone({ post, isRemote: remotePage, fixture: !!FIXTURE });
// ---------- the start screen: work locally or sync with Blackbox, asked before anything else on Henry's machines (setup.js; sync-setup.js) ----------
const setupUi = SOLO ? null : mountSetup({ post, isRemote: remotePage, fixture: !!FIXTURE });
setupUi?.check();
// ---------- the phone relay: the header's "iPhone" button opens the Pair an iPhone card (phone.js; relay.js on the server) ----------
const phoneUi = SOLO ? null : mountPhone({ post, isRemote: remotePage, fixture: !!FIXTURE, openSync: () => syncUi?.open() });
const usagePill = (e) => {
  if (syncUi && e.target.closest('.count.sync')) { syncUi.toggle(); return true; }
  if (phoneUi && e.target.closest('.count.phone')) { phoneUi.toggle(); return true; }
  if (!usageUi) return false;
  if (e.target.closest('.count.week')) { usageUi.toggle(); return true; }
  return false;
};
$('counts')?.addEventListener('click', (e) => { if (usagePill(e)) e.stopPropagation(); });
$('counts')?.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && usagePill(e)) e.preventDefault(); });

// ---------- Housekeeping (housekeeping.js; the header's broom button) ----------
if (!SOLO) mountHousekeeping({ button: $('hk-btn') });

// ---------- "Update available" (update.js; updater.js on the server) ----------
if (!FIXTURE && !SOLO) mountUpdate({ pill: $('update-pill'), verBtn: $('ver-btn'), getJson });

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
  if (!fresh.length || local.notify === false || document.hasFocus() || SOLO) return;
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
// ---------- bots on the map (map-bots.js draws them; Henry, 2026-10-13) ----------
// Empty space on the map: "Add bot ▸" lists the own bots not on it (state.bots map; another machine's never), and the
// one picked goes where the menu was opened (POST /bots/:id/map { at }). A bot's right-click (botMenu): "Watch a
// conversation ▸" (the ones it can watch: needing Henry first, then working, then the rest by last activity) ▸ the
// three jobs, "Watching (N) ▸" (each watch ▸ its job, Stop watching), Open chat (the Bots tab on it), Start while it
// isn't running, and "Remove bot" (off the map: POST map at null: the server stops its watches too). A conversation's own menu
// has "Have a bot watch it ▸" (each own bot ▸ the jobs). POST /bots/:id/watch { id, job } adds or changes one, job null
// stops it; at most 8 a bot. Each change shows at once (botEdits, laid over every /state until its POST answers; for
// good with ?fixture=1, where nothing answers), then the server's state wins: a refusal toasts its message in red.
// An older server has no map or watches: the POSTs fail and say so.
const BOT_WATCH_MAX = 8;
const botEdits = new Map(); // bot id -> { map?, watches? } while its POST is out
function applyBotEdits(st) {
  if (!botEdits.size) return;
  for (const b of st?.bots || []) { const e = b && botEdits.get(b.id); if (e) Object.assign(b, e); }
}
const botById = (id) => ownBots(state).find((b) => b.id === id) || null;
// its mascot in a menu, as its Bots row draws it (the face, shape and colour there)
const botArt = (b, size = 20) => botMascot(b, view || state, size);
// a change to a bot: drawn at once, then POSTed; done: the toast once it's saved
function editBot(b, change, url, body, done) {
  botEdits.set(b.id, { ...(botEdits.get(b.id) || {}), ...change });
  Object.assign(b, change);
  render();
  post(url, body).then((r) => {
    if (FIXTURE) { if (done) toast(done, C.dim); return; } // fixture data: only recorded (window.__fvPosts)
    botEdits.delete(b.id);
    if (r && r.ok) { if (done) toast(done, C.dim); }
    else toast((r && (r.message || r.error)) || 'Fleet View did not answer: it was not saved', C.red);
    pollSoon();
  });
}
// at: world units, or null to take it off the map (its watches go with it)
function placeBot(id, at, done = null) {
  const b = botById(id);
  if (!b) return false;
  const spot = at && Number.isFinite(at.x) && Number.isFinite(at.y) ? { x: Math.round(at.x * 10) / 10, y: Math.round(at.y * 10) / 10 } : null;
  editBot(b, spot ? { map: spot } : { map: null, watches: [] }, `/bots/${encodeURIComponent(id)}/map`, { at: spot }, done);
  return true;
}
// job: 'report' | 'answer' | 'review', or null to stop watching it
function watchBot(id, convId, job) {
  const b = botById(id);
  if (!b || !convId) return false;
  const ws = watchesOf(b), had = ws.find((w) => w.id === convId);
  const conv = watchName(had || { id: convId }, view || state);
  if (!job && !had) return false;
  if (job && had && had.job === job) { toast(`${botName(b)} already watches ${conv}: ${jobLabel(job)}`, C.dim); return false; }
  if (job && !had && ws.length >= BOT_WATCH_MAX) { toast(`${botName(b)} watches ${BOT_WATCH_MAX} conversations already: stop one first`, C.red); return false; }
  const s = sessionsOf([convId])[0];
  const next = !job ? ws.filter((w) => w.id !== convId)
    : had ? ws.map((w) => (w.id === convId ? { ...w, job } : w))
    : [...ws, { id: convId, job, since: Date.now(), name: (s && s.name) || null, last: null }];
  const done = job ? `${botName(b)} watches ${conv}: ${jobLabel(job)}` : `${botName(b)} stopped watching ${conv}`;
  editBot(b, { watches: next }, `/bots/${encodeURIComponent(id)}/watch`, { id: convId, job: job || null }, done);
  return true;
}
// its chat in the Bots tab (one with no conversation yet too)
function openBotChat(id) {
  if (!(state?.bots || []).some((b) => b && b.id === id)) return;
  selectChat(`bot:${id}`);
  if (local.view === 'chats') render(); else setView('chats');
}
// Start, as the Bots tab's (POST /bots/:id/start: its running conversation, else its last one resumed, else a new one)
function startBotFromMenu(b) {
  toast(`Starting ${botName(b)}…`, C.dim);
  post(`/bots/${encodeURIComponent(b.id)}/start`, {}).then((r) => {
    if (FIXTURE) return;
    if (!r || r.ok === false) toast((r && (r.message || r.error)) || `could not start ${botName(b)}`, C.red);
    pollSoon();
  });
}
// a conversation a bot can watch: started, no new one or demo, no overseer, not removed (nor its workspace)
function canWatch(s) {
  if (!s || s.pending || s.demo || s.bot || !isConvId(s.id) || isHidden(s)) return false;
  return !(s.repo && hiddenRepoKeys().has(normRoot(s.repo.root)));
}
// the conversations a bot can watch, from the newest /state: none removed (or in a removed workspace) and none that
// handed off (its pickup is listed in its place, under the name it has now)
function watchableSessions() {
  const seen = new Set(), out = [];
  for (const s of view?.allSessions || state?.sessions || []) {
    if (!canWatch(s) || seen.has(s.id) || (s.state === 'DONE' && s.handoff && s.handoff.next)) continue;
    seen.add(s.id); out.push(s);
  }
  const rank = (s) => (needsYou(s.state) ? 0 : s.state === 'WORKING' || s.state === 'AGENTS' ? 1 : 2);
  return out.sort((a, b) => rank(a) - rank(b) || (b.last || 0) - (a.last || 0));
}
// the three jobs for one conversation, a check on the one it has
const jobItems = (b, convId, cur) => BOT_JOBS.map(([job, label]) => ({ label, icon: cur === job ? 'check' : null, run: () => watchBot(b.id, convId, job) }));
const stopWatchItem = (b, convId) => ({ label: 'Stop watching', icon: 'close', danger: true, run: () => watchBot(b.id, convId, null) });
// empty space's "Add bot ▸": x, y where the menu was opened (client px), where the bot goes. Each bot says its role
// (Henry, 2026-10-14: "can u also show their title in the dropdown"), and under them the teams of bots (the Bots
// tab's groups): one drops the whole team there, the lead in the middle and the rest round it (those on the map already
// come over too) ("maybe even let me drop a team")
const TEAM_RING = 74; // px from the lead to the rest of a dropped team, at the screen factor 1
function addBotMenuItem(x, y) {
  const bots = ownBots(state), off = bots.filter((b) => !onMap(b));
  const teams = botTeams(view || state);
  const quiet = (label) => ({ label: 'Add bot', icon: 'bots', children: [{ label, disabled: true }] });
  if (!bots.length) return quiet('No bots yet: make one in the Bots tab');
  if (!off.length && !teams.length) return quiet('Every bot is on the map');
  const roleOf = (b) => (typeof b.role === 'string' ? b.role.replace(/\s+/g, ' ').trim() : '');
  const rows = off.map((b) => ({ label: botName(b), art: botArt(b), note: [roleOf(b), b.live ? '' : 'not running'].filter(Boolean).join(' · ') || null, run: () => {
    const at = mapMod?.mapWorldAt?.(x, y);
    if (!at) { toast('the map is not showing', C.red); return; }
    placeBot(b.id, at, `${botName(b)} is on the map: right-click it to give it a job`);
  } }));
  if (!off.length) rows.push({ label: 'Every bot is on the map', disabled: true });
  if (teams.length) {
    rows.push({ sep: true });
    for (const t of teams) {
      const n = t.members.length, here = t.members.filter((m) => onMap(botById(m.botId))).length;
      const lead = t.members.find((m) => m.lead);
      rows.push({ label: t.name, art: t.art(18), note: [`${n} bot${n === 1 ? '' : 's'}`, lead ? `★ ${lead.name}` : '', here ? `${here} on the map` : ''].filter(Boolean).join(' · '),
        run: () => dropTeam(t, x, y) });
    }
  }
  return { label: 'Add bot', icon: 'bots', scroll: rows.length > 10, children: rows };
}
// a team dropped at x, y (client px): the lead there (else the first), the rest evenly round it
function dropTeam(t, x, y) {
  if (!mapMod?.mapWorldAt?.(x, y)) { toast('the map is not showing', C.red); return; }
  const ms = t.members.slice().sort((a, b) => Number(b.lead) - Number(a.lead));
  const mid = ms[0].lead ? ms.shift() : null;
  const ring = TEAM_RING * Math.min(1.6, Math.max(1, Math.sqrt(Math.min(innerWidth / 1600, innerHeight / 900))));
  const spots = [];
  if (mid) spots.push([mid, x, y]);
  ms.forEach((m, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / ms.length;
    spots.push([m, mid || ms.length > 1 ? x + Math.cos(a) * ring : x, mid || ms.length > 1 ? y + Math.sin(a) * ring : y]);
  });
  let last = null;
  for (const [m, px, py] of spots) { const at = mapMod.mapWorldAt(px, py); if (at && placeBot(m.botId, at)) last = m; }
  if (last) toast(`${t.name} is on the map: click one for its chat`, C.dim);
}
// a bot's watches as the page has them now: the bot from the newest /state (its watches change while the menu is
// open), less those on a conversation removed here, or in a removed workspace, that the server has not ended yet
function watchesNow(b) {
  const now = (state?.bots || []).find((x) => x && x.id === b.id) || b;
  const hidR = hiddenRepoKeys();
  return watchesOf(now).filter((w) => {
    const s = (view?.allSessions || state?.sessions || []).find((x) => x.id === w.id);
    return !(s && (isHidden(s) || (s.repo && hidR.has(normRoot(s.repo.root)))));
  });
}
// a bot's own menu (its mascot on the map). Its two lists are built each time their submenu opens (kids()), from
// the newest /state, so renamed, removed and handed-off conversations show as they are now
function botMenu(b, x, y) {
  const ws = watchesNow(b), name = botName(b);
  const items = [];
  if (!watchableSessions().length) items.push({ label: 'Watch a conversation', icon: 'read', disabled: true, note: 'no conversation to watch' });
  else {
    items.push({ label: 'Watch a conversation', icon: 'read', scroll: true, kids: () => {
      const had = watchesNow(b);
      return watchableSessions().map((s) => {
        const w = had.find((x) => x.id === s.id);
        return { label: s.name || s.id.slice(0, 8), swatch: statusColor(s), note: `${s.label || s.state}${s.repo ? ` · ${s.repo.name}` : ''}`,
          ...(w ? { badge: 'watching' } : {}), children: jobItems(b, s.id, w ? w.job : null) };
      });
    } });
  }
  if (ws.length) {
    items.push({ label: `Watching (${ws.length})`, icon: 'check', kids: () => watchesNow(b).map((w) => ({
      label: watchName(w, view || state), note: jobLabel(w.job), ...(w.last && w.last.what ? { badge: String(w.last.what) } : {}),
      children: [...jobItems(b, w.id, w.job), { sep: true }, stopWatchItem(b, w.id)],
    })) });
  }
  items.push({ label: 'Open chat', icon: 'bots', run: () => openBotChat(b.id) });
  if (!b.live) items.push({ label: 'Start', icon: 'play', run: () => startBotFromMenu(b) });
  if (onMap(b)) {
    const n = ws.length;
    items.push({ sep: true }, {
      label: 'Remove bot', icon: 'close', danger: true,
      confirm: n ? { text: n === 1 ? 'Its watch stops too.' : `Its ${n} watches stop too.`, yes: 'Remove' } : null,
      run: () => placeBot(b.id, null, `${name} is off the map${n ? ' and watches nothing' : ''}`),
    });
  }
  openCtxMenu({ x, y, title: name, art: botArt(b, 24), sub: `${b.live ? 'running' : 'not running'}${ws.length ? ` · watching ${ws.length}` : ''}`, items });
}
// a conversation's "Have a bot watch it ▸": each own bot ▸ the jobs (and Stop watching when it watches it already)
function botWatchItem(s) {
  const bots = ownBots(state);
  if (!bots.length || !canWatch(s)) return null;
  return {
    label: 'Have a bot watch it', icon: 'bots',
    children: bots.map((b) => {
      const ws = watchesOf(b), w = ws.find((x) => x.id === s.id), full = !w && ws.length >= BOT_WATCH_MAX;
      if (full) return { label: botName(b), art: botArt(b), disabled: true, note: `watches ${BOT_WATCH_MAX} already` };
      return { label: botName(b), art: botArt(b), note: w ? jobLabel(w.job) : b.live ? null : 'not running',
        children: [...jobItems(b, s.id, w ? w.job : null), ...(w ? [{ sep: true }, stopWatchItem(b, s.id)] : [])] };
    }),
  };
}

// ---------- bot notes (botnote.js): a bot finished a turn or needs you ----------
// A card at the top right with its face and the line it ended on, on every view but the Bots tab (Henry,
// 2026-10-12), from the same state.alerts (their own last n, in memory: a reload announces nothing old). A click
// opens its chat in the Bots tab.
const BOT_NOTE_FACE = { done: 'done', question: 'needs', stalled: 'needs', error: 'error' };
let botNoteN = null;
const botNotes = SOLO ? null : mountBotNotes({ open: (sid) => { ui.selectedId = sid; if (local.view === 'chats') render(); else setView('chats'); } });
function noteBots(st) {
  const list = Array.isArray(st?.alerts) ? st.alerts : [];
  const top = list.reduce((m, a) => Math.max(m, Number(a && a.n) || 0), 0);
  if (botNoteN == null || top < botNoteN) { botNoteN = top; return; }
  const fresh = list.filter((a) => a && Number(a.n) > botNoteN && BOT_NOTE_FACE[a.kind]).sort((a, b) => a.n - b.n);
  botNoteN = top;
  if (!botNotes || local.view === 'chats') return;
  for (const a of fresh.slice(-3)) {
    const face = BOT_NOTE_FACE[a.kind];
    const f = botFace(st, a.sid, face);
    if (!f) continue;
    const line = face === 'done' ? f.preview : face === 'error' ? 'hit an API error' : f.preview || a.text;
    botNotes.push({ key: f.key, sid: a.sid, name: f.name, face: f.face, kind: face, text: line || (face === 'done' ? 'Finished' : ''), color: f.color });
  }
  dropSeenNotes();
}
// a note goes once its chat is open (Henry, 2026-10-12): the Bots tab, where none show, clears them all; a
// conversation just picked or opened in the panel on another view takes its bot's notes away, and so does its chat
// opened (or showing) in the pop-out Bots window, which marks it seen in fv.chats.seen (a few seconds' slack: that
// window can mark it just before this one's note comes)
const NOTE_SEEN_SLACK_MS = 5000;
function dropSeenNotes() {
  if (!botNotes || !botNotes.count()) return;
  const seen = seenNow();
  botNotes.drop((n) => (Number(seen[n.key]) || 0) >= n.at - NOTE_SEEN_SLACK_MS);
}
window.addEventListener('storage', (e) => { if (e.key === 'fv.chats.seen') { try { dropSeenNotes(); } catch (err) { console.warn(err); } } });
let notesOpenIds = [];
function dropOpenNotes() {
  const ids = [...new Set([ui.selectedId, ui.detailId].filter(Boolean))];
  const opened = ids.filter((id) => !notesOpenIds.includes(id));
  notesOpenIds = ids;
  if (!botNotes || !botNotes.count()) return;
  if (local.view === 'chats') { botNotes.clear(); return; }
  if (!opened.length) return;
  const keys = opened.map((id) => botFace(state, id, 'done')?.key).filter(Boolean);
  botNotes.drop((n) => opened.includes(n.sid) || keys.includes(n.key));
}
function askNotify() {
  if (SOLO) return;
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
  setAccounts(onAccounts()); // the letter tags go (or come back) with the next draw
  offSentAt = Date.now();
  saveSettings({ offAccounts: next });
  flushSettings();
  toast(on ? `Account ${a} is on: its conversations show again` : `Account ${a} is off: its conversations are hidden and get no new sessions`, C.dim);
  pollSoon(500);
}
function accountsMenuItem() {
  const all = allAccounts();
  if (all.length < 2) return null;
  const off = all.filter((a) => offAccts.includes(a));
  // stay: the menu stays open after a click, so several can be switched in a row; it closes on a click away
  return { label: 'Accounts', icon: 'agent', badge: off.length ? `${off.join(' ')} off` : null, refresh: accountsMenuItem,
    // tagAlways: the letters show here even with one account on, so you can tell which to turn back on
    children: all.map((a) => ({ label: `Claude ${a}`, tag: a, tagAlways: true, icon: offAccts.includes(a) ? null : 'check', stay: true, run: () => setAccountOn(a, offAccts.includes(a)) })) };
}

// "Layout" (the map's empty-space menu): lays every workspace out again in the picked order (map.js mapLayout)
function layoutMenuItem() {
  if (local.view !== 'map' || !mapMod || typeof mapMod.mapLayout !== 'function') return null;
  const pick = (label, mode, note, done) => ({ label, note, run: () => { if (mapMod.mapLayout(mode)) toast(done, C.dim); } });
  return { label: 'Layout', icon: 'repo', children: [
    pick('Tidy up', 'tidy', 'pinned ones stay put (g)', "Tidied up the workspaces that aren't pinned"),
    { sep: true },
    pick('By name, A to Z', 'name', null, 'Workspaces laid out by name'),
    pick('Busiest first', 'busy', 'working conversations, then open ones', 'Busiest workspaces first'),
    pick('Most recent first', 'recent', 'the last conversation to move', 'Most recently active workspaces first'),
    pick('Most conversations first', 'size', null, 'Workspaces with the most conversations first'),
  ] };
}
function notifyMenuItem() {
  const on = local.notify !== false;
  return { label: on ? 'Turn off desktop notifications' : 'Turn on desktop notifications', icon: 'alert',
    note: on ? 'questions, errors, failed checks and deploys, messages' : null,
    run: toggleNotify };
}
function toggleNotify() {
  const on = local.notify !== false;
  saveSettings({ notify: !on });
  if (!on) askNotify();
  toast(on ? 'Desktop notifications are off' : 'Desktop notifications are on', C.dim);
  render();
}
// the header's bell, right of the clock button: the same switch as the menu item
function drawNotifyBtn() {
  const b = $('notify-btn');
  if (!b) return;
  const on = local.notify !== false;
  if (b._on === on) return;
  b._on = on;
  b.classList.toggle('off', !on);
  b.setAttribute('aria-pressed', String(on));
  b.title = on ? 'Turn off desktop notifications' : 'Turn on desktop notifications';
  b.setAttribute('aria-label', b.title);
  const bell = '<path d="M6 8.5a6 6 0 0 1 12 0c0 6.5 2.5 8 2.5 8h-17S6 15 6 8.5"/><path d="M10.3 20a1.9 1.9 0 0 0 3.4 0"/>';
  b.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${bell}${on ? '' : '<path d="M3 3l18 18"/>'}</svg>`;
}
$('notify-btn')?.addEventListener('click', (e) => { e.stopPropagation(); toggleNotify(); });

// ---------- remote access (remote.js on the server): Fleet View in a browser on another device, over Tailscale ----------
// Its switch is no longer in the page (Henry, 2026-10-10: other devices go through Supabase sync, not Tailscale);
// settings.remote.enabled stays off. A browser asking to be let in (state.remote.pending) shows on
// every viewer that can approve, at the top: "<label> wants to use Fleet View — code <code>" with Allow and Deny
// (POST /remote/approve | deny); the code is the one its pairing page shows. Nothing blinks; it stays until answered
// or its 10 minutes run out.
let remoteAskKey = '';
const remoteAsks = document.createElement('div');
remoteAsks.className = 'uw-heads';
remoteAsks.setAttribute('aria-live', 'polite');
// at the top in the middle: the toasts are bottom right and the usage heads-up bottom left
Object.assign(remoteAsks.style, { top: 'calc(var(--top-h) + 10px)', bottom: 'auto', left: '50%', transform: 'translateX(-50%)', alignItems: 'center', zIndex: '47' });
document.body.appendChild(remoteAsks);

async function remoteAct(url, body, done) {
  const r = await post(url, body);
  if (!r) toast('could not reach Fleet View', C.red);
  else if (!r.ok) toast(r.message || 'that did not work', C.red);
  else if (done) toast(done, C.mint);
  pollSoon(150);
}
function drawRemote() {
  const r = state?.remote;
  // the browsers waiting for approval
  const asks = r && Array.isArray(r.pending) ? r.pending : [];
  const askKey = asks.map((p) => p.id).join();
  if (askKey !== remoteAskKey) {
    remoteAskKey = askKey;
    remoteAsks.innerHTML = asks.map((p) => `<div class="uw-card" role="status" data-id="${esc(p.id)}" style="border-color:rgba(63,216,255,0.35)">`
      + `<span class="uw-ic" style="color:var(--cyan)">${icon('shield', 15)}</span><div class="uw-body"><div class="uw-t">${esc(p.label)} wants to use Fleet View — code <span class="mono">${esc(p.code)}</span></div>`
      + `<div class="uw-s">${esc(p.login)} · over Tailscale · allow it only if that device shows the same code</div></div>`
      + `<div class="uw-acts"><button type="button" data-c="allow">Allow</button><button type="button" class="uw-more" data-c="deny">Deny</button></div></div>`).join('');
  }
}
remoteAsks.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-c]'), card = b && b.closest('.uw-card');
  if (!card) return;
  const p = (state?.remote?.pending || []).find((x) => x.id === card.dataset.id);
  card.remove();
  remoteAskKey = '';
  if (b.dataset.c === 'allow') remoteAct('/remote/approve', { id: card.dataset.id }, `${p ? p.label : 'That device'} may use Fleet View now`);
  else remoteAct('/remote/deny', { id: card.dataset.id }, null);
});

if (DEBUG) {
  window.__fv = {
    ui, hosts, hidden, hiddenRepos, continued, addedLocal, multi, since, notified,
    notifyAlerts: (st) => notifyAlerts(st),
    noteBots: (st) => noteBots(st), botNotes,
    get replay() { return replay; },
    setMulti: (ids) => setMulti(ids, 'test'),
    addRepoPath: (p) => addRepoPath(p),
    removeRepo: (root) => removeRepo({ root }),
    openWorkspaceList: () => openWorkspaceList(),
    workspaceItems: () => workspaceItems(),
    get view() { return view; },
    get state() { return state; },
    contextMenu: (target, x = 200, y = 200) => openContextMenu(target, x, y),
  };
}

// the clock keeps going while the server is away
setInterval(() => { drawClock(); }, 1000);
render();
pollSoon();
// conversations that run live in this window (desktop only): the panel, cards and map follow them
watchHosts(() => render());
// tell boot.js the page's code loaded and ran (else it loads the page again)
window.fvBootOk?.();
