// Fleet View web: orders. One message typed once and sent to several conversations, as a team or one by one.
//
// Everything goes through the live sessions this window hosts (term.js), never a headless claude: each
// conversation is made live first (term.js ensureLive, exactly as the compose box does before it sends), then
// the text is typed into its prompt with term.js sendText (a bracketed paste, 300 ms, then Enter on its own).
// They are sent three at a time, so a conversation that has to start first does not hold up all the others.
//
//   sendOrder(sessions, text, { team, state, post, name, prefix })  -> Promise<{ ok, team, results, skipped }>
//     sessions: the conversations (/state session objects) to reach
//     team:     true makes exactly them one team (POST /teams { members, order, name?, send: true }), and the server
//               types each one its brief: the order, the list of its teammates and the command to talk to them
//               (fv send … --from <its id>). A new session still keyed new-<n> is waited on (up to
//               ID_WAIT_MS) until it has its id; one that still has none joins the team once it has (POST
//               /teams/add, which sends it the brief). With fewer than two ids there is no team: each gets a plain
//               message. A member whose order could not be sent (not queued either) is taken out of the team again,
//               quietly (POST /teams/leave { quiet }).
//     state:    the last /state (for the teammates' repos and branches, when the server gave no briefs)
//     post:     the shell's POST helper (app.js post: with ?fixture=1 it only records the call in window.__fvPosts)
//     name:     the team's name (the server's default is the first words of the order)
//     prefix:   a first line for a plain message, e.g. '[Fleet View · team "x"]'
//   results: [{ id, name, ok, message }] per conversation; skipped: the ones that could not be reached at all
//   (open in another window, or a stand-in that no longer runs here), also listed in results. An idle
//   conversation (DONE: between turns, even with no live claude) is resumed first, and a new session with nothing
//   in it yet (a pending stand-in hosted here) is typed into like any other. joins: names that join once they have
//   their id; dropped: names taken out of the team because their order failed; noTeam: why there is no team.
//
//   teamBrief(team, me, members, state, text)  the text one team member gets: the order, its teammates, how to
//                                             talk to them (the server's teamBrief gives the same; this one is the
//                                             fallback for ?fixture=1)
//   sendEach(sessions, text)                  the same text to each (no team, no prefix) -> results
//   sendNote(sessions, text, state, prefix)   a note to each, with the others' names, ids and the fv send command
//                                             (a conflict's "Send a note to all") -> results
//   contactLines(me, others, state)           those lines for one recipient
//   unreachable(s)                            why this window can't type into it, or null
//   onTeamJoin(cb)                            cb(name, team name, reply of POST /teams/add) when a late one joins
//   summary(res)                              one line for a toast: "Sent to 3 · 1 failed: x (why)"
//
// A conversation is skipped when another window has it open (term.js openElsewhere: typing there would start a
// second copy of it here). Its screen is read before the paste and again just before the Enter, and one that
// can't be read is not typed into; those come back as failures with the reason, for the toast. One that shows a
// question, a permission prompt or the trust dialog (the text would land in it, and a digit would pick an
// option) gets its text later: it waits in the queue below and comes back as { ok: true, queued: true }.
import { ensureLive, sendText, isHosted, openElsewhere, termApi, screenText, screenReady, onRekey } from './term.js';
import { parseMenu } from './compose.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ORDER_MAX = 4000; // the server's limit for a team's order
const TEAM_MAX = 12; // members of one team
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i; // a conversation's id (the server's teams take only these)

// a conversation that handed off (/state's handoff: { next, nextName, at }) and is done
export const handedOff = (s) => !!(s && s.handoff && (s.handoff.next || s.state === 'DONE'));
// can this window type into it at all? null when yes, else why not
export function unreachable(s) {
  if (!s || !s.id) return 'not a conversation';
  if (!termApi()) return 'sending needs the desktop window';
  if (s.pending && !isHosted(s.id)) return 'it has not started yet';
  // handed off: its pickup carries on, and resuming the old one would run the long conversation it left
  if (handedOff(s)) return `it handed off${s.handoff.nextName ? ` to ${s.handoff.nextName}` : ''}: give it to that one`;
  if (openElsewhere(s) && !isHosted(s.id)) return 'open in another window: end it there or open it here';
  return null;
}

// the first words of a text, for a team's name ("Ship booking reminders on the website…" -> "Ship booking reminders on the")
export function firstWords(text, n = 5, max = 40) {
  const w = String(text || '').replace(/\s+/g, ' ').trim().split(' ').slice(0, n).join(' ');
  return w.length > max ? `${w.slice(0, max - 1).trimEnd()}…` : w;
}

const repoOf = (s) => (s && s.repo ? s.repo.name || String(s.repo.root || '').split(/[\\/]/).filter(Boolean).pop() : null) || 'no workspace';
// how members talk to each other: fv is on the PATH of the sessions Fleet View starts
const talkLine = (me) => `Talk to them directly: fv send <their id> "message" --from ${me.id}.`;

// The text a team member gets. me: that member; members: every member (me included). Kept in step with the
// server's teamBrief (fleet-view.js), whose text the page sends when POST /teams gives it.
export function teamBrief(team, me, members, state, text) {
  const others = members.filter((m) => m.id !== me.id);
  const lines = [`[Fleet View order · team "${team.name}"]`, String(text).trim(), '', 'You are working together with:'];
  for (const o of others) lines.push(`- ${o.name} (id ${o.id}, repo ${repoOf(o)}, branch ${o.branch || 'none'})`);
  lines.push(`${talkLine(me)} Their messages reach you starting with [Message from teammate]. Agree who changes which files before `
    + 'editing, tell them when you push or merge, and reply to their messages.');
  return lines.join('\n');
}

// Is Claude showing a menu (a permission prompt, a question, the plan approval) that typed text would land in?
// true / false, or null when its screen could not be read. The first look at a session's screen builds its
// off-screen view and replays its output into it, so this waits (up to SCREEN_WAIT_MS) until that view is fed and
// drawn. It fails closed: a screen it can't read is never typed into, since an Enter there could approve a prompt.
// Any menu counts, even a question with "Type something" picked: the order would become its answer.
const SCREEN_WAIT_MS = 10000, SCREEN_POLL_MS = 250;
const menuOn = (lines) => !!parseMenu(lines);
async function menuUp(id) {
  for (const until = Date.now() + SCREEN_WAIT_MS; ;) {
    const lines = screenText(id, 40, { rows: true }); // the first call starts building the view
    if (screenReady(id) && lines.length) return menuOn(lines);
    if (Date.now() >= until) return null;
    await sleep(SCREEN_POLL_MS);
  }
}
// just before the Enter: the view is built by now, so one look (a screen that went unreadable counts as a menu)
function menuNow(id) {
  if (!screenReady(id)) return true;
  const lines = screenText(id, 40, { rows: true });
  return !lines.length || menuOn(lines);
}

// one conversation: live, no menu up, then the text. -> { id, name, ok, message }
async function deliver(s, text) {
  const out = { id: s.id, name: s.name, ok: false, message: '' };
  const why = unreachable(s);
  if (why) { out.message = why; return out; }
  const r = await ensureLive(s);
  if (!r || !r.ok) { out.message = (r && r.message) || 'could not start the session'; return out; }
  // the server has text waiting for it: this goes in after that (see setServerQueued)
  if (serverQueued.has(s.id)) {
    enqueue(s, text);
    out.ok = true; out.queued = true;
    out.message = 'waits behind a message for it: it goes in after that';
    return out;
  }
  const menu = await menuUp(s.id);
  if (menu === null) { out.message = 'could not read its screen, so nothing was typed'; return out; }
  // a question, a permission prompt or the trust dialog: the text waits until it's answered (see below)
  if (menu) {
    const trust = trustAsked(s.id);
    enqueue(s, text);
    out.ok = true; out.queued = true;
    out.message = trust ? 'waits for you to trust its folder: it goes in once you do' : 'waits on its question: it goes in once you answer';
    return out;
  }
  const w = await sendText(s.id, text, { beforeEnter: () => menuNow(s.id) });
  out.ok = !!w.ok;
  out.message = w.ok ? (r.started ? 'started and sent' : 'sent') : w.message || 'not sent';
  return out;
}

// ---------- orders that wait for an answer ----------
// A conversation showing a question, a permission prompt or the trust dialog (a new session in a folder Claude
// hasn't been told to trust) can't be typed into: a digit would pick an option and Enter would accept it. Its
// order waits here instead and goes in once no menu has been on its screen for WAIT_CLEAR_MS (any menu, even one
// on "Type something", so the order never lands in a question's answer). Waiting orders are kept in
// localStorage (fv.orderQueue), so a reload (every update restarts the page) carries on with them, and they follow
// a new session's re-key to its id. One still waiting after WAIT_MAX_MS, or whose session stopped running here
// for WAIT_GONE_MS, is dropped. Several for one conversation go in oldest first, one per tick.
//   onQueueDone(cb)   cb({ id, name, text, at }, { ok, message }) once each one is sent, fails or is dropped
//   queuedFor(id)     its waiting orders [{ id, name, text, at }]
//   cancelQueued(id)  drops them -> how many
//   setServerQueued(ids)  /state's queuedText: conversations the server has text waiting for; their orders here wait
//                         until it went in, so the two never type into one prompt at once
const QUEUE_KEY = 'fv.orderQueue', WAIT_TICK_MS = 2000, WAIT_CLEAR_MS = 1500, WAIT_MAX_MS = 2 * 3600e3, WAIT_GONE_MS = 5 * 60e3;
let queue = loadQueue(), queueTimer = 0, ticking = false, serverQueued = new Set();
export function setServerQueued(ids) { serverQueued = new Set(Array.isArray(ids) ? ids : []); }
const doneL = new Set();
export function onQueueDone(cb) { doneL.add(cb); return () => doneL.delete(cb); }
function loadQueue() {
  try {
    const list = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
    return Array.isArray(list) ? list.filter((q) => q && typeof q.id === 'string' && typeof q.text === 'string' && Number.isFinite(q.at)) : [];
  } catch { return []; }
}
function saveQueue() {
  try {
    if (queue.length) localStorage.setItem(QUEUE_KEY, JSON.stringify(queue.map(({ id, name, text, at, why }) => ({ id, name, text, at, why }))));
    else localStorage.removeItem(QUEUE_KEY);
  } catch { /* storage blocked: it still waits while the page is open */ }
}
// why: what it is for, handed back to onQueueDone ('start': a new conversation's first message, sendWhenUp)
function enqueue(s, text, why = null) {
  if (!queue.some((q) => q.id === s.id && q.text === text)) queue.push({ id: s.id, name: s.name || 'conversation', text, at: Date.now(), ...(why ? { why } : {}) });
  saveQueue();
  wake();
}
// a conversation just started here (a fork, a new chat): text goes in once its screen is up with no menu on it,
// and follows it from new-<n> to its id (onRekey below). onQueueDone tells how it went (why 'start')
export function sendWhenUp(s, text) { if (s && s.id && String(text || '').trim()) enqueue(s, String(text), 'start'); }
function wake() { if (!queueTimer && queue.length) queueTimer = setInterval(tick, WAIT_TICK_MS); }
export const queuedFor = (id) => queue.filter((q) => q.id === id).map(({ name, text, at }) => ({ id, name, text, at }));
export function cancelQueued(id) {
  const n = queue.length;
  queue = queue.filter((q) => q.id !== id);
  saveQueue();
  return n - queue.length;
}
function settle(q, ok, message) {
  if (!queue.includes(q)) return; // cancelled meanwhile
  queue = queue.filter((x) => x !== q);
  saveQueue();
  for (const f of doneL) { try { f({ id: q.id, name: q.name, text: q.text, at: q.at, why: q.why || null }, { ok, message }); } catch (e) { console.error(e); } }
}
// any menu on its screen (true), none (false), or null while its screen can't be read yet (the first look starts
// building its view)
function anyMenu(id) {
  const lines = screenText(id, 40, { rows: true });
  if (!screenReady(id) || !lines.length) return null;
  return !!parseMenu(lines);
}
async function tick() {
  if (ticking) return;
  if (!queue.length) { clearInterval(queueTimer); queueTimer = 0; return; }
  ticking = true;
  try {
    const now = Date.now(), seen = new Set();
    for (const q of [...queue]) {
      if (seen.has(q.id)) continue;
      seen.add(q.id);
      if (now - q.at > WAIT_MAX_MS) { settle(q, false, 'still waiting after 2 hours, so it was dropped'); continue; }
      if (!termApi() || !isHosted(q.id)) {
        q.clearAt = 0;
        if (!q.goneAt) q.goneAt = now;
        else if (now - q.goneAt > WAIT_GONE_MS) settle(q, false, 'it stopped running here before it could take it');
        continue;
      }
      q.goneAt = 0;
      // the server has text waiting for it too (a teammate's message, a team note): that goes in first
      if (serverQueued.has(q.id)) { q.clearAt = 0; continue; }
      if (anyMenu(q.id) !== false) { q.clearAt = 0; continue; }
      if (!q.clearAt) { q.clearAt = now; continue; }
      if (now - q.clearAt < WAIT_CLEAR_MS) continue;
      const w = await sendText(q.id, q.text, { beforeEnter: () => anyMenu(q.id) !== false });
      settle(q, !!w.ok, w.ok ? 'sent' : w.message || 'not sent');
    }
  } catch (e) { console.error(e); } finally { ticking = false; }
}
// a new session's order follows it from new-<n> to its id; so does a team it is to join, and sendOrder waiting on it
onRekey((oldKey, id) => {
  let hit = false;
  for (const q of queue) if (q.id === oldKey) { q.id = id; hit = true; }
  if (hit) saveQueue();
  rekeyed.set(oldKey, id);
  if (rekeyed.size > 50) rekeyed.delete(rekeyed.keys().next().value);
  for (const f of idWaits.get(oldKey) || []) f(id);
  idWaits.delete(oldKey);
  joinLater(oldKey, id);
});
wake();
// the trust dialog (a new session in a folder Claude hasn't been told to trust), not another question
function trustAsked(id) {
  return screenText(id, 40, { rows: true }).some((l) => /\btrust\b.*\b(folder|files|project)\b|\b(folder|files|project)\b.*\btrust\b/i.test(l));
}

// at most `n` at a time: each one's first look at a screen replays its whole output, and a dozen of those at
// once can starve the page
const SEND_AT_ONCE = 3;
async function eachLimited(list, n, fn) {
  const out = new Array(list.length);
  let next = 0;
  const worker = async () => { while (next < list.length) { const i = next++; out[i] = await fn(list[i], i); } };
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, worker));
  return out;
}
const failed = (s, e) => ({ id: s.id, name: s.name, ok: false, message: String(e?.message || e) });

// the same text to each, a few at a time
export async function sendEach(sessions, text) {
  return eachLimited((sessions || []).filter(Boolean), SEND_AT_ONCE, (s) => deliver(s, text).catch((e) => failed(s, e)));
}

// ---------- new sessions in a team ----------
// A team takes only conversation ids, and a session started seconds ago is keyed new-<n> until its claude names
// its id (term.js onRekey; a new session waiting on the trust dialog can stay keyed for minutes). sendOrder waits
// up to ID_WAIT_MS for it (idOf); one still keyed after that joins the team once it has its id: POST /teams/add,
// which sends it the brief (the server types it, queued behind the trust dialog) and tells the others its id.
// Those waiting joins are kept in localStorage (fv.teamJoins) for a reload, and dropped after JOIN_MAX_MS.
const ID_WAIT_MS = 30000, JOINS_KEY = 'fv.teamJoins', JOIN_MAX_MS = 2 * 3600e3;
const rekeyed = new Map(); // new-<n> -> its id (the last 50)
const idWaits = new Map(); // new-<n> -> [resolve]
// its id once it has one, within ms, else null
function idOf(key, ms) {
  if (rekeyed.has(key)) return Promise.resolve(rekeyed.get(key));
  return new Promise((resolve) => {
    let done = false;
    const once = (v) => { if (!done) { done = true; resolve(v); } };
    idWaits.set(key, [...(idWaits.get(key) || []), once]);
    setTimeout(() => once(null), ms);
  });
}
let joins = loadJoins(), joinPost = defaultPost;
const joinL = new Set();
export function onTeamJoin(cb) { joinL.add(cb); return () => joinL.delete(cb); }
function loadJoins() {
  try {
    const list = JSON.parse(localStorage.getItem(JOINS_KEY) || '[]');
    return Array.isArray(list) ? list.filter((j) => j && typeof j.key === 'string' && typeof j.team === 'string' && Date.now() - j.at < JOIN_MAX_MS) : [];
  } catch { return []; }
}
function saveJoins() {
  try { if (joins.length) localStorage.setItem(JOINS_KEY, JSON.stringify(joins)); else localStorage.removeItem(JOINS_KEY); } catch { /* storage blocked */ }
}
async function joinLater(key, id) {
  const mine = joins.filter((j) => j.key === key);
  if (!mine.length) return;
  joins = joins.filter((j) => j.key !== key);
  saveJoins();
  for (const j of mine) {
    if (Date.now() - j.at > JOIN_MAX_MS) continue;
    const r = await joinPost('/teams/add', { id: j.team, member: id });
    for (const f of joinL) { try { f(j.name, j.teamName, r); } catch (e) { console.error(e); } }
  }
}

export async function sendOrder(sessions, text, o = {}) {
  const body = String(text || '').replace(/\r\n?/g, '\n').trim();
  const list = [...new Map((sessions || []).filter((s) => s && s.id).map((s) => [s.id, s])).values()];
  if (!body) return { ok: false, team: null, results: [], skipped: [], message: 'write the order first' };
  if (!list.length) return { ok: false, team: null, results: [], skipped: [], message: 'no conversation to send it to' };
  const skipped = [], live = [];
  for (const s of list) { const why = unreachable(s); if (why) skipped.push({ id: s.id, name: s.name, ok: false, message: why }); else live.push(s); }
  let team = null, results, noTeam = null;
  const post = o.post || defaultPost;
  let ids = live.filter((s) => ID_RE.test(s.id)), keyed = live.filter((s) => !ID_RE.test(s.id));
  if (o.team && body.length > ORDER_MAX) return { ok: false, team: null, results: [], skipped, message: `an order is at most ${ORDER_MAX} characters` };
  if (o.team && live.length > TEAM_MAX) return { ok: false, team: null, results: [], skipped, message: `a team has at most ${TEAM_MAX} conversations; pick fewer` };
  // new sessions still keyed new-<n>: wait a while for their ids (see idOf)
  if (o.team && keyed.length && live.length >= 2) {
    const got = await Promise.all(keyed.map((s) => idOf(s.id, ID_WAIT_MS)));
    ids = [...ids, ...keyed.flatMap((s, i) => (got[i] ? [{ ...s, id: got[i], pending: false }] : []))];
    keyed = keyed.filter((s, i) => !got[i]);
  }
  if (o.team && ids.length >= 2) {
    // send: the server types each brief itself (it types the team's notes and the teammates' messages too, one at a
    // time per conversation, so they never mix in one prompt), following one that handed off to its successor
    const want = { members: ids.map((s) => s.id), order: body, send: true };
    if (o.name) want.name = String(o.name).slice(0, 80);
    const r = await post('/teams', want);
    // with ?fixture=1 nothing answers: a team as the server would make it
    team = r && r.ok && r.team ? r.team : r == null && o.fixture ? { id: 'fixture-team', name: want.name || firstWords(body), members: want.members, order: body } : null;
    if (!team) return { ok: false, team: null, results: [], skipped, message: (r && r.message) || 'could not make the team' };
    if (r && Array.isArray(r.sent)) {
      results = r.sent.map((x) => ({ id: x.id, name: x.name, ok: !!x.ok, ...(x.queued ? { queued: true } : {}),
        message: x.queued ? 'waits on its question: it goes in once you answer' : x.ok ? 'sent' : x.message || 'not sent' }));
    } else {
      // ?fixture=1: the page types its own briefs
      const briefOf = (s) => (r && r.briefs && typeof r.briefs[s.id] === 'string' ? r.briefs[s.id] : teamBrief(team, s, ids, o.state, body));
      results = await eachLimited(ids, SEND_AT_ONCE, (s) => deliver(s, briefOf(s)).catch((e) => failed(s, e)));
    }
    // still keyed: it joins once it has its id (joinLater), and gets the brief then
    if (keyed.length) {
      joinPost = post;
      joins.push(...keyed.map((s) => ({ key: s.id, name: s.name || 'new session', team: team.id, teamName: team.name, at: Date.now() })));
      saveJoins();
      for (const s of keyed) { const id = rekeyed.get(s.id); if (id) joinLater(s.id, id); }
    }
    // an order that never got there (not queued either): out of the team again, quietly
    const lost = results.filter((x) => !x.ok && !x.queued);
    for (const x of lost) await post('/teams/leave', { id: team.id, member: x.id, quiet: true });
    team = { ...team, members: team.members.filter((m) => !lost.some((x) => x.id === m)) };
    results = [...results, ...keyed.map((s) => ({ id: s.id, name: s.name, ok: true, queued: true, joins: true, message: 'joins the team once it has started' }))];
    return { ok: results.some((x) => x.ok), team, results: [...results, ...skipped], skipped, dropped: lost.map((x) => x.name) };
  }
  if (o.team && live.length >= 2) noTeam = `no team: ${keyed.map((s) => s.name).join(', ')} had not started yet`;
  results = await sendEach(live, o.prefix ? `${o.prefix}\n${body}` : body);
  return { ok: results.some((x) => x.ok), team, results: [...results, ...skipped], skipped, noTeam };
}

async function defaultPost(url, b) {
  try { return await (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json(); } catch { return null; }
}

// The lines that tell one recipient who the others are and how to reach them (a note about a conflict, a
// message about another conversation): "- name (id, repo, branch)" each, then the fleet-msg command with its id.
export function contactLines(me, others, state) {
  const list = (others || []).filter((o) => o && o.id !== me.id);
  if (!list.length) return '';
  return [list.length === 1 ? 'The other conversation:' : 'The others:',
    ...list.map((o) => `- ${o.name} (id ${o.id}, repo ${repoOf(o)}, branch ${o.branch || 'none'})`),
    `${talkLine(me)} Their messages reach you starting with [Message from teammate].`].join('\n');
}
// A note to each of them, each with the others' names, ids and the command to reach them. -> results
export async function sendNote(sessions, text, state, prefix = '[Fleet View · note]') {
  const list = (sessions || []).filter(Boolean);
  const body = String(text || '').trim();
  return eachLimited(list, SEND_AT_ONCE, (s) => deliver(s, [prefix, body, '', contactLines(s, list, state)].join('\n').trim())
    .catch((e) => failed(s, e)));
}

// "Sent to 3 · not sent: parity-wave-4 (open in another window…)"
export function summary(res, what = 'Sent') {
  const rs = (res && res.results) || [];
  const sent = rs.filter((x) => x.ok && !x.queued), wait = rs.filter((x) => x.queued && !x.joins), late = rs.filter((x) => x.joins), bad = rs.filter((x) => !x.ok);
  const team = res && res.team ? `team "${res.team.name}"` : '';
  const parts = [];
  if (sent.length) parts.push(`${what} to ${sent.length === 1 ? sent[0].name : `${sent.length} conversations`}${team ? ` · ${team}` : ''}`);
  else if (team && (wait.length || late.length)) parts.push(`Made ${team}`);
  // "x waits on its question: it goes in once you answer"
  if (wait.length === 1) parts.push(`${wait[0].name} ${wait[0].message}`);
  else if (wait.length) parts.push(`${wait.length} wait on a question or their folder's trust prompt: each gets it once answered`);
  // "new session joins the team once it has started"
  if (late.length) parts.push(`${late.map((x) => x.name).join(', ')} ${late.length === 1 ? 'joins' : 'join'} the team once ${late.length === 1 ? 'it has' : 'they have'} started`);
  if (res && res.noTeam) parts.push(res.noTeam);
  if (!parts.length) parts.push((res && res.message) || 'Nothing was sent');
  if (bad.length) parts.push(`not sent: ${bad.slice(0, 3).map((x) => `${x.name} (${x.message})`).join(', ')}${bad.length > 3 ? ` and ${bad.length - 3} more` : ''}`);
  if (res && res.dropped && res.dropped.length) parts.push(`${res.dropped.join(', ')} ${res.dropped.length === 1 ? 'is' : 'are'} not in the team`);
  return parts.join(' · ');
}
