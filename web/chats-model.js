// Chats model: turns the page's state into the Bots tab's contact list (chats.js draws it). Pure functions plus a
// small localStorage store; no DOM.
//
// The tab lists overseers only: the Chief and Henry's bots (bots.js), each one row however many conversations it
// went through. GET /state tags each overseer conversation with bot: 'chief' or its bot's id, and lists the bots in
// state.bots; every other conversation is the map's and never shows here (app.js derive() leaves the overseers out
// of the map's lists in turn).
//
// CONTRACT (chats.js builds on it; keep these names and shapes):
//   buildContacts(state, opts) -> Contact[] (unsorted)
//       state: the derived state the shell hands every view (allSessions, finishedSessions, pending, teams, bots,
//              settings, ...), or raw GET /state (no allSessions: rawToContactsState turns it into those lists; the
//              phone app passes it). The overseers' conversations are read from all of those lists by their tag;
//              settings.hidden leaves one out unless it worked again after (app.js isHidden)
//       opts:  { chiefId?: string|null, chains?: ChainStore, now?: number, chiefPlaceholder?: boolean }
//              chiefId: the Chief's conversation (settings.chief.id), for a state without tags: it and the
//              conversations in its chain of handoffs count as the Chief's
//              chiefPlaceholder: with no Chief conversation, add a pinned Chief row { key: 'chief', kind: 'chief', id: null,
//              ids: [], state: 'NEW', preview: 'Not started yet' } so the tab can start one
//   sortContacts(list, order?) -> Contact[]   order: settings.chatOrder { pinned: [keys], keys: [keys] }, Henry's own
//       (rows never move by themselves): the pinned rows in their order, then new rows (in neither list; a Chief in
//       neither is pinned, on top), then the rest in theirs; each row's pinned set to match. With no order: Chief
//       first, then needs-you (longest waiting first), then newest activity (the phone's Projects list)
//   fullChatOrder(order, list), moveInChatOrder(order, list, key, { pin, before }), pinInChatOrder(order, list, key,
//       pin), stepInChatOrder(order, list, key, 'up' | 'down' | 'top', shown?) -> a new order (step: null when it
//       can't go that way); sameChatOrder(a, b) -> boolean. Keys of rows not in list keep their places
//   contactTree(list, folded?) -> [{ c, depth, parent, path, open?, kids?, under? }]   the Bots list as drawn (Henry,
//       2026-10-13: a team's members show under it, and it folds): list sorted (sortContacts), folded the team keys
//       folded (a Set, an array or { [key]: true }; none: every team open). Top to bottom: each top row (no
//       parentTeam), a team's rows right under it when it is open, one level deeper (its members in member order, the
//       lead first; a member that leads a team under it shows as that team, which nests the same way). parent: the team
//       key it shows under (null at the top); path: every team key above it, outermost first; team rows: open, kids (rows
//       directly under it) and under (every row below it, folded or not). A team's place is its row's in the order
//   teamFlags(node, seen) -> { asks, unread }   any row under a team (contactTree's node) asks you / has something
//       new: a folded team shows it on its own row
//   teamThread(team, state) -> [{ t, from, fromName, to, toName, text }]   a team's messages, oldest first
//   createChainStore(storage = localStorage) -> ChainStore
//       ChainStore: { keyFor(id) -> string, link(fromId, toId), save() }. A conversation that picked up another's
//       handoff (s.pickedUpFrom.id) gets the same chain key. Only the chiefId fallback uses it: the tags keep a bot's
//       conversations together by themselves
//   unread(contact, seen) -> boolean  seen: { [contact.key]: ms the user last opened it }; something new since
//       (contact.newAt when it has one, else at)
//   asksYou(contact, seen) -> boolean   its row shows needs-you (gold, "!"): it waits on you and you haven't opened it
//       since (Henry, 2026-10-12: opening the chat clears it; a newer question brings it back)
//   rawToContactsState(st) -> { ...st, sessions, allSessions, finishedSessions, pending, teams }   raw GET /state to
//       the lists above (buildContacts calls it by itself when state has no allSessions); the tags and state.bots stay
//   previewOf(session) -> string   a conversation's one-line preview: the question it asks, what it is doing now, or
//       its last reply (the map's rows)
//   botPreview(session, older = []) -> string   a bot's or the Chief's row (Contact.preview): the question it asks,
//       else the last finished reply its chat shows (s.doneReply when /state sends it, else s.lastReply), else that of
//       its older conversations (newest first), else its goal unless that is a "[Fleet View]" note; never a step
//       mid-turn or a reply botFeed leaves out
//   replyLine(text) -> string   the first line of a reply that says something: no heading, code fence, table or
//       rule, list and quote marks and * _ ` stripped; '' for none. A bot's reaction at its start (reactionOf) is
//       left out, and a reply that is only a reaction reads as its emoji
//   botFeed(items) -> items   a bot's or the Chief's chat items (chat.js, GET /conversation; its earlier
//       conversations' items first, as one chat) as the Bots tab shows them, kept simple (Henry, 2026-10-12: "super
//       normie friendly", no noise). A message of Fleet View's own (its text starts "[Fleet View]") becomes
//       { ...it, kind: 'setup', text: without that header }, drawn as a small grey note, not your bubble; the ones
//       that are only plumbing (quietNote: the start prompt, an id note, "your instructions changed", "you were cut
//       off") are left out, and so is the bot's answer to one (the bare "ok"; the one short line to "instructions
//       changed", with the steps before it). Left out too (noiseNote; Henry, 2026-10-13: "i also dont want to see any
//       'changing to sonnet' or anything like that"): every model or effort switch note ("/model x", "Set model
//       to …", "/effort y", …: switchNote), any other of Claude Code's own commands typed in ("/fast", "/config",
//       "/context", …) and the output note right after one, "Conversation compacted", "[Request interrupted by
//       user]", a background task's "finished" note (bg), and
//       a handoff from one conversation to the next: from the /handoff skill (or command) to the end of that turn,
//       the "/pickup <file>" note and the "Picked up: …" reply (with the steps before it). A reply that starts with a
//       reaction ("[react:👍]", reactionOf) puts reaction: '👍' on your last message before it (chat.js draws it on
//       the bubble's corner) and shows the rest, or nothing when that is all
//       A scheduled task's note shows as one line, "Scheduled task: <title>" ("Ran now: …" when Henry ran it), and
//       when the bot answers it with "[quiet]" (or "Nothing new.") the note, that run's steps and answer are all left
//       out (Henry, 2026-10-12: a row of "Scheduled task: …" notes is noise)
//   taskNote(text) -> { now, title } | null   a task's note (bot-tasks.js runText) and its title, tidied
//   quietNote(text) -> 'ack' | 'one' | 'skip' | null   a setup note's text (setupNote) that botFeed leaves out, and
//       what it leaves out after it: 'ack' the bare "ok", 'one' the one reply, 'skip' nothing; null: it shows
//   reactionOf(text) -> { emoji, text } | null   a reply's leading "[react:<emoji>]" (bot/BRIEF.md says when a bot
//       uses one) and the text after it; null when it does not start with one, or the tag holds no emoji
//   setupNote(text) -> string|null   that text without "[Fleet View] ", or null for any other message
//   switchNote(text) -> { model } | { effort } | {} | null   a note a model or effort switch left: its command, or
//       Claude Code's answer to one ({}); null for any other note
//   noiseNote(text) -> 'command' | 'said' | 'noise' | null   a note botFeed leaves out of a bot's chat: 'command' one
//       of Claude Code's own commands ("/model x", "/effort y", "/fast", "/config", "/context", "/clear", ...; the note
//       right after it is its output, left out too), 'said' what a switch printed ("Set model to …", "Set effort level
//       to …"), 'noise' a compaction or an interrupt; null: it shows (a skill's or a custom command, /pickup, an API
//       error, anything else)
//   sizeTask(text) -> { size, model?, effort?, label }   Dynamic's guess at how big a message is, from its words only:
//       size 'keep' (a go-ahead: "ok", "yes do it", "2 and 3": nothing switches), 'quick' (haiku, low), 'normal'
//       (a question or a task: sonnet, medium), 'big' (a plan, build, bug hunt or several parts: opus,
//       high) or 'huge' (a big plan, a hard bug or a long brief: opus, xhigh); label says which
//   dynamicSwitch(dyn, size, cur, modelIds, long) -> { model?, effort? }   what to switch before that message: only
//       what is dynamic (dyn { model, effort } booleans) and differs from cur { model, effort } (a model of the same
//       family stays); model is the family's 1M-context one in modelIds when long (a bot keeps its whole chat: bots.js
//       longModel), else its 200k one; failing that its first
//   DYNAMIC   'dynamic', a bot's model or effort sized per message
//   doingOf(contact, face) -> string   what a bot or the Chief is doing now, in a few words, for its avatar's hover:
//       face is mascot.js mascotState(contact) ('thinking': "Thinking about your message"; working: the tool running
//       or its last action; needs: its question; done / idle: its last reply), "Not running" for a bot that is not
//   botChoices({ accounts, models, efforts, modelLabel, current? }) -> { account, model, effort }: the New bot and Edit
//       bot pickers' choices, each [{ value, label }]; current { account?, model? } (the bot being edited) keeps a value
//       no longer offered (an account gone, an older model) as the first choice. The model and effort lists start
//       with Dynamic ({ value: 'dynamic', label: 'Dynamic', note }: sized for each message, sizeTask); the account
//       list ends with it (each new conversation starts on the account with the most usage left: bots.js)
//   botEdits(bot, values) -> body for POST /bots/:id: only the fields that changed (name, role and brief trimmed; role
//       '' clears it; shape and color '' or null: back to the automatic pick, sent as null); {} when nothing did
//   ROLE_MAX   60, a bot's role's most characters (bots.js); roleOf(bot) -> its role on one line, '' for none
//   taskSchedule(task) -> string   a task's schedule (state.bots[].tasks, bots.js): "Daily 9:00", "Weekdays 9:00",
//       "Weekly Mon 9:00", "Monthly 1st 9:00", "Hourly :15", "Once Oct 12 15:00", "To do", "No valid schedule"
//   taskWhen(ms, now) -> string   a run's time, short: "in 5 min", "in 3 h", "Mon 9:00", "Oct 12", "5 min ago", "Yesterday 9:00"
//   taskLine(task, now) -> string   the task's meta line: next run, last run and its result, or why it does not run
//   tasksHead(tasks, now) -> { count, open, text }   the collapsed Tasks strip: how many are open, and the next due
//   Nothing here touches the DOM or window at import time, and it imports nothing, so the phone app (phone/) imports it as it is.
//
//   Contact = {
//     key,            stable row key: 'chief', 'bot:<bot id>' or 'team:<team id>'
//     kind,           'chief' | 'bot' | 'team'
//     id,             the conversation the row opens now: the bot's running one (state.bots convId), else its newest
//                     live one, else its newest; null for a team, a Chief not started yet and a bot with none known
//     ids,            every conversation id it went through, oldest first (a team: its members)
//     botId,          bot rows: the bot's id (state.bots)
//     live,           bot rows: whether it runs now (state.bots), null when there is no state.bots to say or the bot
//                     is another machine's (elsewhere: true, a row only while its chats are listed)
//     name,           a Fleet View rename of one of its conversations (the newest), else the bot's name, else 'Chief'
//     account, repo ({ name, root, color } | null), state, label, statusColor,
//     preview,        one line: the question it asks, or its last finished reply (botPreview); a bot with no
//                     conversation listed: its brief's first line, else "Not started yet"
//     at,             ms of its latest activity (for sorting and the time on the row); a bot with no conversation
//                     listed: when it was made
//     newAt,          bot and Chief rows with a conversation: ms its chat last showed something new, for the unread
//                     dot (newOf: its last reply shown, or the question it waits on; at with an older server)
//     needsYou, busy, pinned (the Chief; sortContacts with an order sets each row's), teamId (team rows),
//     members         team rows: [{ id, name, lead, key, role, memberId }], the lead first, then the team's order: id the
//                     member's row opens, key its row's, role its bot's ('' for none), memberId the conversation as the
//                     team lists it (what /teams/leave and /teams/lead take)
//     parentTeam      the key of the team row it shows under in the Bots list, when there is one (contactTree): a bot or
//                     the Chief under the team it leads, else the one it is a plain member of; a team under the team its
//                     lead is a plain member of (teams nest). Absent at the top
//     role,           bot rows: what it is for in its teams ("Reviewer"), from state.bots; '' for none
//     turnStart, lastAction, running, waitingOn   bot and Chief rows: its conversation's, as /state has them (null
//                     when unknown), so mascot.js mascotState can tell thinking from working and doingOf can say what
//     shape, color,   bot rows: the bot's own pick (state.bots, bots.js), or null: the page picks one
//   }
//   A team is a row only when every member the state knows is an overseer's conversation.
const NEEDS = new Set(['ASKING', 'QUESTION', 'ERROR', 'STALLED']);
const BUSY = new Set(['WORKING', 'AGENTS']);
const KEY = 'fv.chats.chains';
const CAP = 2000;
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const lastOf = (s) => s.last || s.endedAt || s.lastActive || 0;
const activeAt = (s) => (Number.isFinite(s.active) ? s.active : s.last || 0);
const oneLine = (t, n = 140) => {
  const x = String(t || '').replace(/\s+/g, ' ').trim();
  return x.length > n ? x.slice(0, n - 1).trimEnd() + '…' : x;
};
const short = (id) => String(id == null ? '' : id).slice(0, 8);
// an overseer conversation's tag from /state: 'chief' or its bot's id
const tagOf = (s) => (s && typeof s.bot === 'string' && s.bot ? s.bot : null);

// { conversation id: chain key }, kept in storage; the newest links sit last, so the cap drops the oldest
export function createChainStore(storage) {
  let st = storage;
  if (st === undefined) { try { st = globalThis.localStorage; } catch { st = null; } }
  const map = {};
  try {
    const j = JSON.parse(st.getItem(KEY));
    if (j && typeof j === 'object' && !Array.isArray(j)) for (const k of Object.keys(j)) if (typeof j[k] === 'string') map[k] = j[k];
  } catch {}
  let dirty = false;
  const set = (id, key) => {
    if (has(map, id) && map[id] === key) return;
    delete map[id]; // re-insert so it counts as the newest
    map[id] = key;
    dirty = true;
  };
  return {
    keyFor: (id) => (has(map, id) ? map[id] : id),
    link(fromId, toId) {
      if (!fromId || !toId || fromId === toId) return;
      const key = has(map, fromId) ? map[fromId] : fromId;
      set(fromId, key);
      set(toId, key);
    },
    save() {
      if (!dirty) return;
      const ks = Object.keys(map);
      if (ks.length > CAP) for (const k of ks.slice(0, ks.length - CAP)) delete map[k];
      try { st.setItem(KEY, JSON.stringify(map)); dirty = false; } catch {}
    },
  };
}

// the first line that says something: not a heading, a code fence, a table border or a rule
export function replyLine(text) {
  const r = reactionOf(text); // a bot's reaction is left out; a reaction alone reads as its emoji
  for (const raw of String(r ? r.text.trim() || r.emoji : text || '').split('\n')) {
    const l = raw.trim();
    if (!l || /^#{1,6}(\s|$)/.test(l) || /^```/.test(l) || /^\|/.test(l) || /^[\s:|-]+$/.test(l) || /^[-*_=]{3,}$/.test(l)) continue;
    const t = l.replace(/^(?:[-*+>]|\d+[.)])\s+/, '').replace(/[*_`]+/g, '').trim();
    if (t) return t;
  }
  return '';
}

// "edit FlameCanvas.tsx", or "build:phone-skia edit FlameCanvas.tsx" for a subagent
const actionText = (a) => (a ? [a.who && a.who !== 'main' ? a.who + ':' : '', a.verb, a.what].filter(Boolean).join(' ') : '');

export function previewOf(s) {
  if (NEEDS.has(s.state)) {
    const q = s.waitingOn || replyLine(s.lastReply);
    if (q) return oneLine(q);
  }
  if (BUSY.has(s.state)) {
    const a = actionText(s.lastAction);
    if (a) return oneLine(a);
  }
  return oneLine(replyLine(s.lastReply) || s.goal || '');
}

// a bot's or the Chief's row, as a chat app's: the question it asks, else the last reply its chat shows, finished;
// never what it is doing along the way (a tool, a step mid-turn) or a reply the chat leaves out (Henry, 2026-10-12).
// doneReply is there only when it differs from lastReply (fleet-view.js); its earlier conversations (older, newest
// first) are looked in when this one has none, then its goal unless that is one of Fleet View's own notes
export function botPreview(s, older = []) {
  if (NEEDS.has(s.state)) {
    const q = s.waitingOn || replyLine(s.lastReply);
    if (q) return oneLine(q);
  }
  for (const x of [s, ...older]) {
    const r = replyLine(has(x, 'doneReply') ? x.doneReply : x.lastReply);
    if (r) return oneLine(r);
  }
  return setupNote(s.goal) == null ? oneLine(s.goal || '') : '';
}

// settings.hidden -> (conversation) -> whether it is left out: on the list, unless it worked again after it was
// hidden (a state that isn't DONE or QUESTION, active after then: app.js isHidden)
function hiddenTest(settings) {
  const hid = new Map();
  for (const h of (settings && Array.isArray(settings.hidden) ? settings.hidden : [])) if (h && typeof h.id === 'string') hid.set(h.id, Number(h.at) || 0);
  return (x) => hid.has(x.id) && !(x.state !== 'DONE' && x.state !== 'QUESTION' && activeAt(x) > hid.get(x.id));
}

// a conversation's name, following its handoffs to the one that carries on
function nameIn(id, known) {
  let s = known.get(id);
  if (!s) return null;
  for (let n = 0; n < 50 && s.handoff && s.handoff.next && known.has(s.handoff.next); n++) s = known.get(s.handoff.next);
  return s.name || null;
}

// raw GET /state (the phone app; anything without the page's derived lists) -> the lists buildContacts reads, the way
// app.js derive() makes them: sessions = live ones, finishedSessions = DONE ones /state lists in finished (not one
// that handed off to a next), both without the overseers (they are the Bots tab's, never the map's), allSessions =
// all of them, no pending. Hidden ones (settings.hidden) are left out unless they worked again after being hidden
// (app.js isHidden). Pure: no DOM, no storage.
export function rawToContactsState(st) {
  const s = st || {};
  const all = (Array.isArray(s.sessions) ? s.sessions : []).filter((x) => x && x.id != null);
  const hidden = hiddenTest(s.settings);
  const fin = new Set((Array.isArray(s.finished) ? s.finished : []).filter((f) => f && f.id).map((f) => f.id));
  const shown = all.filter((x) => !hidden(x) && !tagOf(x));
  return {
    ...s,
    sessions: shown.filter((x) => x.state !== 'DONE'),
    allSessions: all,
    finishedSessions: shown.filter((x) => x.state === 'DONE' && fin.has(x.id) && !(x.handoff && x.handoff.next)),
    pending: Array.isArray(s.pending) ? s.pending : [],
    teams: Array.isArray(s.teams) ? s.teams : [],
  };
}

// what a row carries of its conversation's moment (mascotState, doingOf)
const nowOf = (s) => ({
  turnStart: (s && Number.isFinite(s.turnStart) && s.turnStart) || null, lastAction: (s && s.lastAction) || null,
  running: (s && Array.isArray(s.running) && s.running.length && s.running) || null, waitingOn: (s && s.waitingOn) || null,
});
// when a bot's or the Chief's chat last showed something new (Contact.newAt): the last reply its chat shows
// (s.shownAt: a "[react:👍]" too, not a quiet task run, a hushed reply, its tool steps or a title Claude Code writes
// after the turn), or the question it waits on now. Its log's time (at) moves with all of those, so a dot cleared by
// opening the chat came back with nothing new in it. An older server sends no shownAt: its latest activity then
function newOf(members, s, at) {
  if (!members.some((x) => has(x, 'shownAt'))) return at;
  return Math.max(0, ...members.map((x) => Number(x.shownAt) || 0), NEEDS.has(s.state) ? activeAt(s) : 0);
}
// a bot's own shape and colour (bots.js checks them; a colour here is #rrggbb only), and its role
const lookOf = (b) => ({
  shape: (b && typeof b.shape === 'string' && b.shape) || null,
  color: (b && typeof b.color === 'string' && /^#[0-9a-f]{6}$/i.test(b.color) && b.color) || null,
  role: roleOf(b),
});
export const ROLE_MAX = 60;
// a bot's role (state.bots role: bots.js keeps it short), on one line; '' for none
export const roleOf = (b) => (b && typeof b.role === 'string' ? b.role.replace(/\s+/g, ' ').trim().slice(0, ROLE_MAX).trim() : '');

export function buildContacts(input, opts = {}) {
  // the page's derived state has allSessions; anything else is taken as raw GET /state
  const state = input && Array.isArray(input.allSessions) ? input : rawToContactsState(input);
  // every conversation the state knows; a stand-in (pending, sessions) wins over the raw copy of the same id
  const known = new Map();
  for (const s of (state.allSessions || []).concat(state.finishedSessions || [], state.pending || [], state.sessions || [])) if (s && s.id != null) known.set(s.id, s);
  const pairs = [];
  const prev = new Map();
  for (const s of known.values()) {
    if (s.pickedUpFrom && s.pickedUpFrom.id) { pairs.push([s.pickedUpFrom.id, s.id]); prev.set(s.id, s.pickedUpFrom.id); }
    if (s.handoff && s.handoff.next) { pairs.push([s.id, s.handoff.next]); if (!prev.has(s.handoff.next)) prev.set(s.handoff.next, s.id); }
  }
  const depth = (id) => { let d = 0; for (let c = prev.get(id), n = 0; c && n < 500; c = prev.get(c), n++) d++; return d; };
  // the Chief by its id alone (a state without tags): it and its chain of handoffs, remembered across them
  let chiefOf = () => false;
  if (opts.chiefId) {
    const chains = opts.chains || createChainStore(null);
    pairs.sort((a, b) => depth(a[0]) - depth(b[0])); // oldest links first, so a key spreads down a chain in one pass
    for (const [f, t] of pairs) chains.link(f, t);
    chains.save();
    const ck = chains.keyFor(opts.chiefId);
    chiefOf = (id) => id === opts.chiefId || chains.keyFor(id) === ck;
  }
  const tagFor = (s) => tagOf(s) || (chiefOf(s.id) ? 'chief' : null);
  // the bots not removed; a removed bot's conversations keep their tag (off the map) but get no row. Without the
  // list (an older server) every bot tag gets one
  const bots = Array.isArray(state.bots) ? state.bots.filter((b) => b && typeof b.id === 'string' && b.id) : null;
  const botOf = new Map((bots || []).map((b) => [b.id, b]));
  const hidden = hiddenTest(state.settings);
  const groups = new Map(); // tag -> its conversations
  for (const s of known.values()) {
    const tag = tagFor(s);
    if (!tag || hidden(s) || (tag !== 'chief' && bots && !botOf.has(tag))) continue;
    if (!groups.has(tag)) groups.set(tag, []);
    groups.get(tag).push(s);
  }

  const out = [];
  const rowOf = new Map(); // tag -> its row
  for (const [tag, members] of groups) {
    const isChief = tag === 'chief';
    const b = isChief ? null : botOf.get(tag) || null;
    // oldest first: its resumes have no handoff link between them, so by time, a handoff's order for a tie
    members.sort((x, y) => (lastOf(x) - lastOf(y)) || (depth(x.id) - depth(y.id)));
    const live = members.filter((m) => m.state !== 'DONE');
    const pool = live.length ? live : members;
    // the server knows which one runs; else the newest live one, else the newest
    const s = (b && b.convId && members.find((m) => m.id === b.convId)) || pool.reduce((best, m) => (lastOf(m) >= lastOf(best) ? m : best), pool[0]);
    const ren = members.filter((m) => m.renamed && m.name).sort((x, y) => lastOf(y) - lastOf(x))[0];
    const row = {
      key: isChief ? 'chief' : `bot:${tag}`, kind: isChief ? 'chief' : 'bot', id: s.id, ids: members.map((m) => m.id),
      name: ren ? ren.name : isChief ? 'Chief' : (b && b.name) || s.name || short(s.id),
      account: s.account, repo: s.repo || null, state: s.state, label: s.label, statusColor: s.stateColor,
      preview: botPreview(s, members.filter((m) => m !== s).reverse()), at: Math.max(...members.map(lastOf)), needsYou: NEEDS.has(s.state), busy: BUSY.has(s.state), pinned: isChief,
      ...nowOf(s),
    };
    row.newAt = newOf(members, s, row.at);
    // another machine's bot (state.bots elsewhere: bots.js): its chat as any synced one's, nothing to start here
    if (!isChief) Object.assign(row, { botId: tag, live: b && !b.elsewhere ? !!b.live : null, ...(b && b.elsewhere ? { elsewhere: true } : {}), ...lookOf(b) });
    out.push(row);
    rowOf.set(tag, row);
  }
  // a bot with no conversation listed (new, or its last one is out of /state): a quiet row, so it can be started
  for (const b of bots || []) {
    if (rowOf.has(b.id) || b.elsewhere) continue;
    const s = b.convId && known.has(b.convId) ? known.get(b.convId) : null;
    const st = b.convId ? 'IDLE' : 'NEW';
    const row = {
      key: `bot:${b.id}`, kind: 'bot', id: s ? s.id : null, ids: s ? [s.id] : [], botId: b.id, live: !!b.live,
      name: (typeof b.name === 'string' && b.name) || short(b.id), account: b.account || null, repo: null, state: st, label: st, statusColor: null,
      preview: oneLine(replyLine(b.brief)) || (b.live ? 'Starting...' : b.convId ? 'Not running' : 'Not started yet'),
      at: Number(b.createdAt) || 0, needsYou: false, busy: false, pinned: false,
      ...nowOf(null), ...lookOf(b),
    };
    out.push(row);
    rowOf.set(b.id, row);
  }
  if (!rowOf.has('chief') && opts.chiefPlaceholder) {
    out.push({
      key: 'chief', kind: 'chief', id: null, ids: [], name: 'Chief', account: null, repo: null, state: 'NEW', label: 'NEW',
      statusColor: null, preview: 'Not started yet', at: 0, needsYou: false, busy: false, pinned: true,
    });
  }
  // a member's row: undefined when the state doesn't know it (or its overseer has no row), null when it is the map's
  const rowFor = (id) => {
    const s = known.get(id);
    if (!s) return undefined;
    const tag = tagFor(s);
    return tag ? rowOf.get(tag) : null;
  };
  const teamRows = [];
  const ownOf = new Map(), upOf = new Map(); // a member's row -> the team row it leads / it is a plain member of
  for (const t of state.teams || []) {
    const rows = [];
    const members = [];
    const leadRow = t.lead && (t.members || []).includes(t.lead) ? rowFor(t.lead) : null;
    let mapped = false;
    for (const id of t.members || []) {
      const r = rowFor(id);
      if (r === null) { mapped = true; break; }
      if (!r || rows.includes(r)) continue;
      rows.push(r);
      members.push({ id: r.id || id, name: r.name, lead: r === leadRow, key: r.key, role: r.role || '', memberId: id });
    }
    if (mapped || !rows.length) continue;
    // the lead first (★ on top of its group), the rest as the team lists them
    members.sort((x, y) => Number(y.lead) - Number(x.lead));
    const m = t.messages && t.messages.length ? t.messages[t.messages.length - 1] : null;
    const row = {
      key: 'team:' + t.id, kind: 'team', id: null, ids: members.map((x) => x.id), name: t.name, account: null, repo: null,
      state: 'TEAM', label: 'GROUP', statusColor: t.color,
      preview: oneLine(m ? `${nameIn(m.from, known) || short(m.from)}: ${m.text}` : t.order),
      at: m ? m.t : t.at || 0, needsYou: rows.some((r) => r.needsYou), busy: rows.some((r) => r.busy), pinned: false, teamId: t.id, members,
    };
    out.push(row);
    teamRows.push(row);
    for (const r of rows) { const into = r === leadRow ? ownOf : upOf; if (!into.has(r)) into.set(r, row); }
  }
  // where each row shows in the Bots list (contactTree): a member under the team it leads, else the one it is a plain
  // member of; a team under the team its lead is a plain member of (teams nest: team-tree.js)
  for (const [r, t] of upOf) if (!ownOf.has(r)) r.parentTeam = t.key;
  for (const [r, t] of ownOf) {
    r.parentTeam = t.key;
    const up = upOf.get(r);
    if (up && up !== t) t.parentTeam = up.key;
  }
  // a loop (the server refuses one) would leave its rows nowhere: cut it at the first team that comes round again
  const teamAt = new Map(teamRows.map((t) => [t.key, t]));
  for (const t of teamRows) {
    const seen = new Set([t.key]);
    for (let p = t.parentTeam; p; p = teamAt.get(p) && teamAt.get(p).parentTeam) {
      if (seen.has(p)) { delete t.parentTeam; break; }
      seen.add(p);
    }
  }
  return out;
}

const byActivity = (a, b) => {
  const ac = a.kind === 'chief' || !!a.pinned, bc = b.kind === 'chief' || !!b.pinned;
  if (ac !== bc) return ac ? -1 : 1;
  if (!!a.needsYou !== !!b.needsYou) return a.needsYou ? -1 : 1;
  if (a.needsYou) return (a.at || 0) - (b.at || 0);
  return (b.at || 0) - (a.at || 0);
};
// settings.chatOrder as given ({ pinned, keys } of strings), or null when there is none
function orderIn(order) {
  if (!order || typeof order !== 'object') return null;
  const strs = (v) => (Array.isArray(v) ? v.filter((k) => typeof k === 'string' && k) : []);
  const pinned = strs(order.pinned), p = new Set(pinned);
  return { pinned, keys: strs(order.keys).filter((k) => !p.has(k)) };
}
const CHAT_ORDER_MAX = 300; // each list (fleet-view.js keeps no more)

// order: settings.chatOrder { pinned: [keys], keys: [keys] } (Henry's, set by hand: rows never move by themselves).
// The pinned rows first in that order, then the rest in theirs; a row in neither is new: at the top of the rest (the
// newest activity first among new ones), but a Chief in neither is pinned, on top. Each row's pinned says where it
// went. With no order (the phone's Projects list): the Chief first, then needs-you (longest waiting), then newest
export function sortContacts(list, order) {
  const o = orderIn(order);
  if (!o) return list.slice().sort(byActivity);
  const pinAt = new Map(o.pinned.map((k, i) => [k, i])), keyAt = new Map(o.keys.map((k, i) => [k, i]));
  const top = [], fresh = [], rest = [];
  for (const c of list) {
    if (pinAt.has(c.key) || (c.key === 'chief' && !keyAt.has(c.key))) top.push({ ...c, pinned: true });
    else if (keyAt.has(c.key)) rest.push({ ...c, pinned: false });
    else fresh.push({ ...c, pinned: false });
  }
  top.sort((a, b) => (pinAt.has(a.key) ? pinAt.get(a.key) : -1) - (pinAt.has(b.key) ? pinAt.get(b.key) : -1));
  rest.sort((a, b) => keyAt.get(a.key) - keyAt.get(b.key));
  return [...top, ...fresh.sort(byActivity), ...rest];
}
// the whole order with the rows list shows that it lacks put where sortContacts shows them (new ones on top of the
// rest, a Chief in neither on top of the pinned): what the page saves (chatOrderAdd) so they stay where they are
export function fullChatOrder(order, list) {
  const o = orderIn(order) || { pinned: [], keys: [] };
  const have = new Set([...o.pinned, ...o.keys]);
  const sorted = sortContacts(list, o).filter((c) => !have.has(c.key));
  return { pinned: [...sorted.filter((c) => c.pinned).map((c) => c.key), ...o.pinned].slice(0, CHAT_ORDER_MAX),
    keys: [...sorted.filter((c) => !c.pinned).map((c) => c.key), ...o.keys].slice(0, CHAT_ORDER_MAX) };
}
// a row moved by hand: into the pinned ones (pin) or the rest, in front of the row keyed before (null, or one not
// there: last). The keys of rows not shown now (another machine's bot, a search) keep their places -> the new order
export function moveInChatOrder(order, list, key, { pin = false, before = null } = {}) {
  const o = fullChatOrder(order, list);
  // in front of itself: in front of the one after it, where it is
  if (before === key) { const from = o.pinned.includes(key) ? o.pinned : o.keys; before = from[from.indexOf(key) + 1] ?? null; }
  const pinned = o.pinned.filter((k) => k !== key), keys = o.keys.filter((k) => k !== key);
  const into = pin ? pinned : keys;
  const i = before != null ? into.indexOf(before) : -1;
  into.splice(i >= 0 ? i : into.length, 0, key);
  return { pinned: pinned.slice(0, CHAT_ORDER_MAX), keys: keys.slice(0, CHAT_ORDER_MAX) };
}
// Pin (last of the pinned ones, just above where it was) or Unpin (first of the rest, just below them) -> the new order
export function pinInChatOrder(order, list, key, pin) {
  const o = fullChatOrder(order, list);
  if (!pin) return moveInChatOrder(o, list, key, { pin: false, before: o.keys.find((k) => k !== key) || null });
  return moveInChatOrder(o, list, key, { pin: true });
}
// the phone's Move up / Move down / Move to top: among the rows shown in its own section (pinned or not) -> the new
// order, or null when it can't go that way
export function stepInChatOrder(order, list, key, to, shown = null) {
  const sorted = sortContacts(list, orderIn(order) || { pinned: [], keys: [] });
  const me = sorted.find((c) => c.key === key);
  if (!me) return null;
  const vis = shown ? new Set(shown.map((c) => c.key)) : null;
  const sec = sorted.filter((c) => c.pinned === me.pinned && (!vis || vis.has(c.key) || c.key === key));
  const i = sec.findIndex((c) => c.key === key);
  const j = to === 'top' ? 0 : to === 'up' ? i - 1 : to === 'down' ? i + 1 : -1;
  if (j < 0 || j >= sec.length || j === i) return null;
  let before = sec[j].key;
  if (to === 'down') { // right after the one below it
    const o = fullChatOrder(order, list), from = me.pinned ? o.pinned : o.keys;
    before = from[from.indexOf(sec[j].key) + 1] ?? null;
  }
  return moveInChatOrder(order, list, key, { pin: me.pinned, before });
}
// two orders the same (the page's held one against /state's)
export function sameChatOrder(a, b) {
  const x = orderIn(a), y = orderIn(b);
  return !!x && !!y && x.pinned.join('\n') === y.pinned.join('\n') && x.keys.join('\n') === y.keys.join('\n');
}

// ---------- the list as a tree: teams and their members ----------
const foldedSet = (f) => (f instanceof Set ? f : new Set(Array.isArray(f) ? f : f && typeof f === 'object' ? Object.keys(f).filter((k) => f[k]) : []));
export function contactTree(list, folded) {
  const shut = foldedSet(folded);
  const rows = Array.isArray(list) ? list : [];
  const byKey = new Map(rows.map((c) => [c.key, c]));
  const kidsOf = new Map(); // team key -> the rows that show under it
  for (const c of rows) {
    if (!c.parentTeam || !byKey.has(c.parentTeam)) continue;
    if (!kidsOf.has(c.parentTeam)) kidsOf.set(c.parentTeam, []);
    kidsOf.get(c.parentTeam).push(c);
  }
  const leadKey = (t) => ((t.members || []).find((m) => m.lead) || {}).key;
  // under a team: its members in its order (the lead first); a member that leads a team under it shows as that team
  const ordered = (t) => {
    const kids = kidsOf.get(t.key) || [], out = [];
    for (const m of t.members || []) {
      const k = kids.find((x) => !out.includes(x) && (x.kind === 'team' ? leadKey(x) === m.key : x.key === m.key));
      if (k) out.push(k);
    }
    return out.concat(kids.filter((x) => !out.includes(x)));
  };
  const out = [];
  const walk = (c, depth, path) => {
    const node = { c, depth, parent: path.length ? path[path.length - 1] : null, path };
    out.push(node);
    if (c.kind !== 'team') return [c];
    const kids = ordered(c).filter((k) => !path.includes(k.key) && k.key !== c.key);
    const at = out.length, under = [];
    for (const k of kids) under.push(...walk(k, depth + 1, [...path, c.key]));
    Object.assign(node, { open: !shut.has(c.key), kids: kids.length, under });
    if (!node.open) out.length = at; // folded: its rows are not drawn
    return [c, ...under];
  };
  for (const c of rows) if (!c.parentTeam || !byKey.has(c.parentTeam)) walk(c, 0, []);
  return out;
}
export function teamFlags(node, seen) {
  const under = (node && node.under) || [];
  return { asks: under.some((c) => asksYou(c, seen)), unread: under.some((c) => unread(c, seen)) };
}

export function teamThread(team, state) {
  const known = new Map();
  const st = state || {};
  for (const s of (st.allSessions || []).concat(st.sessions || [], st.finishedSessions || [])) if (s && s.id != null) known.set(s.id, s);
  const nm = (id) => nameIn(id, known) || short(id);
  return (team.messages || []).slice().sort((a, b) => (a.t || 0) - (b.t || 0))
    .map((m) => ({ t: m.t, from: m.from, fromName: nm(m.from), to: m.to, toName: nm(m.to), text: m.text }));
}

// ---------- what it is doing (the avatar's hover) ----------
const FACE_WORDS = { thinking: 'Thinking about your message', working: 'Working', needs: 'Needs you', error: 'Stopped on an error', done: 'Done', idle: 'Idle', new: 'New' };
export function doingOf(c, face) {
  if (!c) return '';
  if (c.kind === 'bot' && c.live === false) return c.id ? 'Not running: Start it, or send it a message' : 'Not started yet';
  if (c.kind === 'chief' && !c.id) return 'Not started yet';
  const head = FACE_WORDS[face] || FACE_WORDS.idle;
  const more = (t) => (t ? `${head}: ${oneLine(t, 120)}` : head);
  if (face === 'thinking') return head;
  if (face === 'working') {
    // a tool of the main loop still running says most; else the last thing it did; a subagent's as "who: verb what"
    const r = (c.running || []).find((x) => x && !x.agent) || (c.running || [])[0];
    if (r && r.tool) return more([r.agent ? `${r.agent}:` : '', r.tool, r.what].filter(Boolean).join(' '));
    return more(actionText(c.lastAction));
  }
  if (face === 'needs' || face === 'error') return more(c.waitingOn || c.preview);
  if (face === 'done' || face === 'idle') return more(c.preview);
  return head;
}

export const unread = (c, seen) => {
  const at = c.newAt != null ? c.newAt : c.at;
  return !!(at && (!seen || !seen[c.key] || seen[c.key] < at));
};
export const asksYou = (c, seen) => !!c.needsYou && unread(c, seen);
// a bot's or the Chief's own colour, before the page's fallbacks (the Chief's gold, its repo's, its account's); null
// when it has none. A bot has one colour: its look's (state.bots color: Colour on its right-click, Edit bot, fv look),
// kept with the bot, so every conversation it goes on in wears it. The Chief's is the one picked on its conversation's
// right-click (settings.sessHues; picked(id) -> CSS colour or null): its running one's, else the newest of its others,
// so a new Chief conversation keeps it. A team's is never its own: its members wear theirs
export function ownColorOf(c, picked) {
  if (!c || c.kind === 'team') return null;
  if (c.kind === 'chief') {
    if (typeof picked !== 'function') return null;
    const ids = [c.id, ...(Array.isArray(c.ids) ? [...c.ids].reverse() : [])].filter(Boolean);
    for (const id of ids) { const p = picked(id); if (typeof p === 'string' && p) return p; }
    return null;
  }
  return typeof c.color === 'string' && /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : null;
}

// ---------- a bot's chat as the Bots tab shows it (botFeed) ----------
// Only Fleet View starts a message with "[Fleet View]": anyone else's is framed ("[Fleet View · unsigned…") or
// marked "(quoted)" by chief.js frame, so this header alone says it is a setup note
const SETUP = /^\[Fleet View\][ \t]*/;
export const setupNote = (text) => { const t = String(text == null ? '' : text); return SETUP.test(t) ? t.replace(SETUP, '') : null; };
// what a bot answers a setup note with when it asks for "ok" (bots.js startPrompt, idNote)
const ACK = /^\s*(?:ok(?:ay)?|ready|got it)[.!]?\s*$/i;
// a reaction a bot puts at the very start of a reply (bot/BRIEF.md): "[react:👍]", then the reply or nothing
const REACT = /^\s*\[react:\s*([^\]\s]{1,16})\s*\]\s*/i;
const EMOJI = /\p{Extended_Pictographic}/u;
// text -> { emoji, text: the rest } when it starts with a reaction, else null
export function reactionOf(text) {
  const m = REACT.exec(String(text == null ? '' : text));
  return m && EMOJI.test(m[1]) ? { emoji: m[1], text: String(text).slice(m[0].length) } : null;
}
// Fleet View's notes that are only plumbing (bots.js startPrompt, idNote, CHANGED_NOTE; chief.js idNote; the host's
// cut-off note), and what botFeed leaves out after each
export function quietNote(text) {
  const t = String(text == null ? '' : text);
  if (/^You are (?:the Chief\b|.{1,80}?, one of Henry's bots\b)/.test(t)) return /Greet Henry/.test(t) ? 'skip' : 'ack';
  if (/^Your instructions changed\b/.test(t)) return 'one';
  if (/^You were cut off mid-turn\b/.test(t)) return 'skip';
  return null;
}
// a handoff: the skill (or the command typed) that writes the summary, and the command that picks it up
const isHandoff = (it) => (it.kind === 'tool' && it.name === 'Skill' && /(?:^|:)handoff$/.test(String((it.input && it.input.skill) || '')))
  || (it.kind === 'note' && /^\/handoff(?:\s|$)/.test(String(it.text || '')));
const PICKUP = /^\/pickup(?:\s|$)/;
const PICKED = /^\s*Picked up\b/i;
// notes that are noise in a chat with a bot: a compaction (Claude Code goes on in the same conversation), Stop's
// "[Request interrupted by user]" and Claude Code's own commands typed in (conversation.js commandOf: "/model x"),
// whose output is the note right after (conversation.js: a command's stdout). A skill's or a custom command
// ("/app-catchup") is Henry asking for work: it shows
const NOISE = /^(?:Conversation compacted\b|\[Request interrupted by user\b)/;
const OWN_CMD = new RegExp(`^/(?:${['model', 'effort', 'fast', 'config', 'settings', 'status', 'cost', 'usage', 'extra-usage', 'stats',
  'context', 'color', 'rename', 'clear', 'compact', 'resume', 'rewind', 'mcp', 'memory', 'permissions', 'allowed-tools', 'hooks',
  'agents', 'doctor', 'help', 'login', 'logout', 'statusline', 'theme', 'vim', 'terminal-setup', 'output-style', 'add-dir',
  'export', 'copy', 'release-notes', 'ide', 'privacy-settings', 'upgrade', 'plugins?', 'skills', 'sandbox', 'keybindings',
  'bashes', 'tasks', 'todos', 'remote-control', 'mobile', 'exit', 'quit'].join('|')})(?:\\s|$)`, 'i');
// what one of those prints when its own note is gone (a log read from its middle)
const OWN_SAID = /^(?:Compacted\b|Fast mode (?:on|off)\b|Kept effort level\b)/i;
export function noiseNote(text) {
  const t = String(text == null ? '' : text).trim();
  const sw = switchNote(t);
  if (sw) return Object.keys(sw).length ? 'command' : 'said';
  if (OWN_CMD.test(t)) return 'command';
  if (OWN_SAID.test(t)) return 'said';
  return NOISE.test(t) ? 'noise' : null;
}
// a scheduled task coming due (bot-tasks.js runText): its head line, the title and Fleet View's "(schedule, task id)"
const TASK = /^(Scheduled task|Henry ran this task now): (.*?) \([^()]*\btask [^()]*\)\s*$/;
// taskNote(text) -> { now, title } | null   the title without a schedule the bot wrote into it ("Watch X (:50)")
export function taskNote(text) {
  const m = TASK.exec(String(text == null ? '' : text).split('\n')[0]);
  if (!m) return null;
  const title = m[2].replace(/\s*\((?:(?:hourly|daily|weekly|monthly|every)\b[^()]*|(?:at )?\d{0,2}:\d{2}(?:\s*[ap]m)?)\)\s*$/i, '').trim() || m[2];
  return { now: m[1] !== 'Scheduled task', title };
}
// what a bot answers a task with when there is nothing to report (bot-tasks.js runText asks for "[quiet]"): the
// whole run is left out of the chat, its note too (fleet-view.js QUIET_REPLY: no preview, no bot note for it)
const QUIET = /^\s*(?:\[quiet\]|nothing new(?: to report)?|no(?:thing| new \w+)(?: new)?(?: to report)?(?: this (?:hour|time|run))?)[.!]?\s*$/i;
export function botFeed(items) {
  const out = [];
  // what is being left out: 'ack' the bare "ok" to a setup note (thinking and tool steps since then don't count),
  // 'one' the next reply and the steps before it, 'pickup' a pickup's steps and its "Picked up" reply, 'handoff'
  // everything until the next message
  let skip = null;
  let mine = -1; // where your last message is in out: a reaction goes on it
  let task = -1; // where a task's note is in out: a quiet answer to it takes the note and its run out
  let said = false; // the item before was one of Claude Code's own commands: a note now is what it printed
  // _j is chat.js's cached JSON of the item as it came: a changed copy must not reuse it
  const copy = (it, more) => { const { _j, ...rest } = it; return { ...rest, ...more }; };
  for (const it of items || []) {
    if (!it) continue;
    const afterCmd = said;
    said = false;
    if (it.kind !== 'user' && skip === 'handoff') continue;
    if (isHandoff(it)) { skip = 'handoff'; continue; }
    if (it.kind === 'note') {
      const t = String(it.text || '');
      if (PICKUP.test(t)) { skip = 'pickup'; continue; }
      // model and effort switches (Dynamic's, or the model menu's), the other commands and what they print are left
      // out: the chat stays clean (an API error, or another command, after one still shows)
      const nz = noiseNote(t);
      if (nz || it.bg || (afterCmd && !it.apiRetry && !/^(?:API error\b|\/)/.test(t))) { said = nz === 'command'; continue; }
    }
    if ((it.kind === 'thinking' || it.kind === 'tool') && (skip === 'one' || skip === 'pickup')) continue;
    if (it.kind === 'user') {
      const note = it.images && it.images.length ? null : setupNote(it.text);
      if (note != null) {
        const q = quietNote(note);
        mine = -1;
        task = -1;
        if (q) { skip = q === 'skip' ? null : q; continue; }
        const tn = taskNote(note);
        out.push(copy(it, { kind: 'setup', text: tn ? `${tn.now ? 'Ran now' : 'Scheduled task'}: ${tn.title}` : note }));
        if (tn) task = out.length - 1;
        skip = 'ack';
        continue;
      }
      skip = null;
      task = -1;
      mine = out.length;
    } else if (it.kind === 'assistant') {
      const was = skip;
      skip = null;
      if (was === 'one' || (was === 'ack' && ACK.test(String(it.text || ''))) || (was === 'pickup' && PICKED.test(String(it.text || '')))) continue;
      if (task >= 0 && QUIET.test(String(it.text || ''))) { out.length = task; task = -1; continue; }
      const r = reactionOf(it.text);
      if (r) {
        if (mine >= 0 && !out[mine].reaction) out[mine] = copy(out[mine], { reaction: r.emoji });
        if (r.text.trim()) out.push(copy(it, { text: r.text }));
        continue;
      }
    } else if (it.kind === 'note' && skip === 'ack') skip = null;
    out.push(it);
  }
  return out;
}

// ---------- the New bot and Edit bot forms ----------
const EFFORT_LABEL = { xhigh: 'Extra high' };
export const DYNAMIC = 'dynamic'; // a bot's model or effort that is sized per message (sizeTask), not fixed
const DYNAMIC_CHOICE = { value: DYNAMIC, label: 'Dynamic', note: 'sized for each message' };
const DYNAMIC_ACCOUNT = { value: DYNAMIC, label: 'Dynamic', note: 'the one with the most usage left' };
export function botChoices({ accounts = [], models = [], efforts = [], modelLabel = (m) => m, current = {} } = {}) {
  const keep = (list, v) => (v && v !== DYNAMIC && !list.includes(v) ? [v, ...list] : list);
  return {
    account: [...keep(accounts, current.account).map((a) => ({ value: a, label: `Account ${a}` })), DYNAMIC_ACCOUNT],
    model: [DYNAMIC_CHOICE, ...keep(models, current.model).map((m) => ({ value: m, label: modelLabel(m) }))],
    effort: [DYNAMIC_CHOICE, ...efforts.map((e) => ({ value: e, label: EFFORT_LABEL[e] || e.charAt(0).toUpperCase() + e.slice(1) }))],
  };
}
export function botEdits(bot, v) {
  const b = bot || {}, out = {};
  const str = (x) => (x == null ? '' : String(x));
  if ('name' in v && str(v.name).trim() !== str(b.name)) out.name = str(v.name).trim();
  // its role: '' clears it (bots.js keeps none then)
  const role = (x) => str(x).replace(/\s+/g, ' ').trim().slice(0, ROLE_MAX).trim();
  if ('role' in v && role(v.role) !== role(b.role)) out.role = role(v.role);
  if ('brief' in v && str(v.brief).trim() !== str(b.brief).trim()) out.brief = str(v.brief).trim();
  for (const k of ['account', 'model', 'effort']) if (k in v && v[k] && v[k] !== b[k]) out[k] = v[k];
  // the look: '' or null is the automatic pick; colours compare in lower case (bots.js keeps them so)
  const look = (x, k) => (x ? (k === 'color' ? String(x).toLowerCase() : String(x)) : null);
  for (const k of ['shape', 'color']) if (k in v && look(v[k], k) !== look(b[k], k)) out[k] = look(v[k], k);
  return out;
}

// ---------- Dynamic: the model and effort sized for each message ----------
// A fast local guess from the words alone (no model is asked). Opus 5.5 only for hard thinking, else Haiku or Sonnet,
// never Fable (Henry, 2026-10-12): quick questions and lookups run on Haiku at low effort, so they come back fast (on
// Sonnet in a bot's long chat, which needs a 1M-context model); a task or a longer question on Sonnet at medium; a
// plan, design, build or bug hunt on Opus at high, and a big plan or a hard bug at xhigh. A short go-ahead ("ok", "yes do it", "2 and 3") keeps what the bot runs now:
// it carries on the work before it (a plan's "go ahead" is no quick question), and nothing is switched for it.
const ACK_WORDS = new Set(('ok okay k kk yes yep yeah yup ya sure go ahead on do it proceed continue carry sounds good '
  + 'fine perfect great nice awesome thanks thank you thx ty cool lgtm ship approve approved agreed agree right correct '
  + 'exactly no nope not now stop wait hold please pls both all them those these that this one ones first second third '
  + 'last option options and or with the').split(' '));
const GREET = /^(?:hi|hey|hello|yo|hiya|morning|evening|good (?:morning|afternoon|evening|night)|gm|gn)\b/i;
const QUESTION = /^(?:what|what's|whats|who|who's|when|where|which|why|how|is|are|was|were|do|does|did|can|could|should|would|will|any|anything|have|has)\b/i;
// looking something up, reading or telling: quick, when the message is short
const LOOKUP = /\b(?:check|find|look up|lookup|look at|show|list|tell me|remind|read|open|search|status|how many|summari[sz]e)\b/i;
// a change to make: a task, not a question
const ACTION = /\b(?:fix|change|add|update|write|make|create|remove|delete|rename|move|edit|draft|reply|send|review|test|run|install|deploy|merge|ship|clean ?up|organi[sz]e|research|compare|figure out|look into|set ?up|configure|schedule|automate)\b/i;
const PLAN = /\b(?:plan|planning|plans|design|designs|architect\w*|build|implement\w*|refactor\w*|debug\w*|investigat\w*|diagnos\w*|migrat\w*|rewrite|overhaul|redesign|spec|roadmap|strategy|integrat\w*|prototype)\b/i;
const HARD = /\b(?:root cause|race condition|deadlock|memory leak|leaks?|intermittent\w*|flaky|hard bug|tricky bug|corrupt\w*|crash\w*|segfault|regression|hangs?|freez\w*|security)\b/i;
const BIG = /\b(?:whole|entire|full|end[- ]to[- ]end|from scratch|across|every|system|architecture|large|big|major|complete|all (?:the )?(?:repos?|files|bots|sessions|screens|pages))\b/i;
const LIST_ITEM = /^\s*(?:[-*•]|\d+[.)])\s+\S/;
const SIZES = {
  keep: { size: 'keep', label: 'Follow-up' },
  quick: { size: 'quick', model: 'haiku', effort: 'low', label: 'Quick question' },
  hello: { size: 'quick', model: 'haiku', effort: 'low', label: 'Hello' },
  question: { size: 'normal', model: 'sonnet', effort: 'medium', label: 'Question' },
  task: { size: 'normal', model: 'sonnet', effort: 'medium', label: 'Task' },
  plan: { size: 'big', model: 'opus', effort: 'high', label: 'Plan or build' },
  bug: { size: 'big', model: 'opus', effort: 'high', label: 'Bug hunt' },
  parts: { size: 'big', model: 'opus', effort: 'high', label: 'Several parts' },
  bigPlan: { size: 'huge', model: 'opus', effort: 'xhigh', label: 'Big plan' },
  hardBug: { size: 'huge', model: 'opus', effort: 'xhigh', label: 'Hard bug' },
  long: { size: 'huge', model: 'opus', effort: 'xhigh', label: 'Long brief' },
};
export function sizeTask(text) {
  // the quote it replies to ("> " lines) says what it is about, not how big the ask is
  const own = String(text == null ? '' : text).split('\n').filter((l) => !/^>( |$)/.test(l)).join('\n').trim();
  const words = own.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').split(/\s+/).filter(Boolean);
  const w = words.length;
  const pick = (k) => ({ ...SIZES[k] });
  if (!w) return pick('keep');
  if (w <= 6 && words.every((x) => ACK_WORDS.has(x) || /^\d+$/.test(x))) return pick('keep');
  const items = own.split('\n').filter((l) => LIST_ITEM.test(l)).length;
  const plan = PLAN.test(own), hard = HARD.test(own), big = BIG.test(own), action = ACTION.test(own);
  if (plan && (big || items >= 4 || w > 250)) return pick('bigPlan');
  if (hard && (plan || w > 60)) return pick('hardBug');
  if (w > 400) return pick('long');
  if (plan) return pick('plan');
  if (hard) return pick('bug');
  if (items >= 3 || w > 150) return pick('parts');
  if (w <= 25) {
    // a short question is quick even when it names a change ("is the deploy green?"); "can you fix…" asks for one
    const request = /^(?:(?:can|could|would|will)\s+you|please|pls)\b/i.test(own);
    const asks = !request && (QUESTION.test(own) || /\?\s*$/.test(own));
    if (GREET.test(own) && w <= 8 && !action) return pick('hello');
    if (asks || (!action && (LOOKUP.test(own) || w <= 8))) return pick('quick');
  }
  return pick(action ? 'task' : 'question');
}
// what to type before a message to a dynamic bot: dyn { model, effort } (which of the two are dynamic), size from
// sizeTask, cur { model, effort } the session runs now (compose.js current(): a model id like 'claude-opus-5-5[1m]',
// an effort or null when unknown), ids the model ids on offer (compose.js MODEL_IDS), long true for a bot (the
// family's 1M-context one is taken, so its long chat still fits; any other chat takes the 200k one, else the first).
// -> { model?, effort? }: only what differs; a model of the same family (Opus 1M for Opus) is not switched, and
// nothing is for a follow-up. Haiku has no 1M-context model, so a long chat (or no Haiku on offer) takes Sonnet
export function dynamicSwitch(dyn, size, cur, ids = [], long = false) {
  const out = {};
  if (!dyn || !size || size.size === 'keep') return out;
  const fam = (m) => (/^claude-([a-z]+)-/.exec(String(m || '')) || /^([a-z]+)$/.exec(String(m || '')) || [])[1] || null;
  const want = size.model === 'haiku' && (long || !ids.some((k) => fam(k) === 'haiku')) ? 'sonnet' : size.model;
  if (dyn.model && want && fam(cur && cur.model) !== want) {
    const id = ids.find((k) => fam(k) === want && /\[1m\]$/i.test(k) === !!long) || ids.find((k) => fam(k) === want);
    if (id) out.model = id;
  }
  if (dyn.effort && size.effort && (cur && cur.effort) !== size.effort) out.effort = size.effort;
  return out;
}

// the notes a switch leaves in the transcript (api.js switchModel types "/model <id>" and "/effort <level>", and
// Claude Code answers each): -> { model } or { effort } for a command, {} for its answer, null for any other note
const SWITCH_SAID = /^(?:Set model to |Kept model as |Set effort level to |Effort level set to )/;
export function switchNote(text) {
  const t = String(text == null ? '' : text).trim();
  const m = /^\/(model|effort)\s+(\S+)$/.exec(t);
  if (m) return { [m[1]]: m[2] };
  return SWITCH_SAID.test(t) ? {} : null;
}

// ---------- a bot's tasks (state.bots[].tasks: bots.js, bot-tasks.js viewTask) ----------
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const hm = (h, m) => `${h}:${String(m).padStart(2, '0')}`;
const nth = (d) => `${d}${d % 10 === 1 && d !== 11 ? 'st' : d % 10 === 2 && d !== 12 ? 'nd' : d % 10 === 3 && d !== 13 ? 'rd' : 'th'}`;
export function taskSchedule(t) {
  const sc = t && t.schedule;
  if (!t || (t.kind === 'recurring' && !sc) || t.valid === false) return 'No valid schedule';
  if (!sc) return 'To do';
  if (t.kind === 'once') { const d = new Date(sc.at); return `Once ${MONTHS[d.getMonth()]} ${d.getDate()} ${hm(d.getHours(), d.getMinutes())}`; }
  const at = hm(sc.h, sc.m);
  if (sc.every === 'hourly') return `Hourly :${String(sc.m).padStart(2, '0')}`;
  if (sc.every === 'weekly') return `Weekly ${DAY_NAMES[sc.day] || '?'} ${at}`;
  if (sc.every === 'monthly') return `Monthly ${nth(sc.day)} ${at}`;
  if (sc.every === 'weekdays') return `Weekdays ${at}`;
  return `Daily ${at}`;
}
export function taskWhen(ms, now = Date.now()) {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms), n = new Date(now);
  const mins = Math.round((ms - now) / 60e3);
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  const clock = hm(d.getHours(), d.getMinutes());
  if (Math.abs(ms - now) < 60e3) return ms >= now ? 'now' : 'just now';
  if (mins > 0 && mins < 60) return `in ${mins} min`;
  if (mins < 0 && mins > -60) return `${-mins} min ago`;
  if (mins > 0 && mins < 12 * 60) return `in ${Math.round(mins / 60)} h`;
  if (sameDay(d, n)) return `today ${clock}`;
  const y = new Date(now - 864e5), tm = new Date(now + 864e5);
  if (sameDay(d, y)) return `yesterday ${clock}`;
  if (sameDay(d, tm)) return `tomorrow ${clock}`;
  if (Math.abs(ms - now) < 6 * 864e5) return `${DAY_NAMES[d.getDay()]} ${clock}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}
export function taskLine(t, now = Date.now()) {
  if (!t) return '';
  const last = (t.runs || []).length ? t.runs[t.runs.length - 1] : null;
  const lastText = t.lastRun ? `last ${taskWhen(t.lastRun, now)}${last && last.result ? `: ${last.result}` : ''}` : '';
  if (t.status === 'done') return ['done', lastText].filter(Boolean).join(' · ');
  if (t.status === 'paused') return ['paused', lastText].filter(Boolean).join(' · ');
  if (t.valid === false) return 'its schedule makes no sense: ask the bot to fix it';
  const next = t.nextRun ? `next ${taskWhen(t.nextRun, now)}` : '';
  return [next, lastText].filter(Boolean).join(' · ');
}
export function tasksHead(tasks, now = Date.now()) {
  const list = Array.isArray(tasks) ? tasks : [];
  const open = list.filter((t) => t && t.status === 'open');
  const next = open.filter((t) => Number.isFinite(t.nextRun)).sort((a, b) => a.nextRun - b.nextRun)[0];
  const text = next ? `next: ${oneLine(next.title, 60)}, ${taskWhen(next.nextRun, now)}` : open.length ? `${open.length} open` : list.length ? 'all done' : 'none yet';
  return { count: list.length, open: open.length, text };
}
