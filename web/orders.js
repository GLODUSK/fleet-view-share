// Fleet View web: orders. One message typed once and sent to several conversations, as a team or one by one.
//
// Everything goes through the live sessions this window hosts (term.js), never a headless claude: each
// conversation is made live first (term.js ensureLive, exactly as the compose box does before it sends), then
// the text is typed into its prompt with term.js sendText (a bracketed paste, 300 ms, then Enter on its own).
// They are sent three at a time, so a conversation that has to start first does not hold up all the others.
//
//   sendOrder(sessions, text, { team, state, post, name, prefix })  -> Promise<{ ok, team, results, skipped }>
//     sessions: the conversations (/state session objects) to reach
//     team:     true makes them one team first (POST /teams { members, order, name? }), so each one also gets
//               the list of its teammates and the command to talk to them (scripts/fleet-msg.js, state.tools.msg).
//               With one reachable conversation left there is no team: it gets a plain message.
//     state:    the last /state (for tools.msg and the teammates' repos and branches)
//     post:     the shell's POST helper (app.js post: with ?fixture=1 it only records the call in window.__fvPosts)
//     name:     the team's name (the server's default is the first words of the order)
//     prefix:   a first line for a plain message, e.g. '[Fleet View · team "x"]'
//   results: [{ id, name, ok, message }] per conversation; skipped: the ones that could not be reached at all
//   (open in another window, or a stand-in that no longer runs here), also listed in results. An idle
//   conversation (DONE: between turns, even with no live claude) is resumed first, and a new session with nothing
//   in it yet (a pending stand-in hosted here) is typed into like any other.
//
//   teamBrief(team, me, members, state, text)  the text one team member gets: the order, its teammates, how to
//                                             talk to them (exported for tests and the "Add to team" path)
//   sendEach(sessions, text)                  the same text to each (no team, no prefix) -> results
//   sendNote(sessions, text, state, prefix)   a note to each, with the others' names, ids and the fleet-msg command
//                                             (a conflict's "Send a note to all") -> results
//   contactLines(me, others, state)           those lines for one recipient
//   unreachable(s)                            why this window can't type into it, or null
//   summary(res)                              one line for a toast: "Sent to 3 · 1 failed: x (why)"
//
// A conversation is skipped when another window has it open (term.js openElsewhere: typing there would start a
// second copy of it here) or when Claude shows a question or a permission prompt (the text would land in it, and
// a digit in it would pick an option). Its screen is read before the paste and again just before the Enter, and
// one that can't be read is not typed into. Those come back as failures with the reason, for the toast.
import { ensureLive, sendText, isHosted, openElsewhere, termApi, screenText, screenReady } from './term.js';
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
const msgTool = (state) => (state && state.tools && typeof state.tools.msg === 'string' && state.tools.msg) || 'scripts/fleet-msg.js (in the Fleet View folder)';

// The text a team member gets. me: that member; members: every member (me included)
export function teamBrief(team, me, members, state, text) {
  const others = members.filter((m) => m.id !== me.id);
  const lines = [`[Fleet View order · team "${team.name}"]`, String(text).trim(), '', 'You are working together with:'];
  for (const o of others) lines.push(`- ${o.name} (id ${o.id}, repo ${repoOf(o)}, branch ${o.branch || 'none'})`);
  lines.push(`Talk to them directly: node "${msgTool(state)}" --from ${me.id} --to <their id> "message". `
    + 'Their messages reach you starting with [Message from teammate]. Agree who changes which files before editing, '
    + 'tell them when you push or merge, and reply to their messages.');
  return lines.join('\n');
}

// Is Claude showing a menu (a permission prompt, a question, the plan approval) that typed text would land in?
// true / false, or null when its screen could not be read. The first look at a session's screen builds its
// off-screen view and replays its output into it, so this waits (up to SCREEN_WAIT_MS) until that view is fed and
// drawn. It fails closed: a screen it can't read is never typed into, since an Enter there could approve a prompt.
const SCREEN_WAIT_MS = 10000, SCREEN_POLL_MS = 250;
const menuOn = (lines) => {
  const m = parseMenu(lines);
  const on = m && m.options.find((o) => o.on);
  return !!m && !(on && /^(type something|other\b|chat about this)/i.test(on.label));
};
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
  const menu = await menuUp(s.id);
  if (menu === null) { out.message = 'could not read its screen, so nothing was typed'; return out; }
  if (menu) { out.message = 'Claude is asking something: answer it first'; return out; }
  const w = await sendText(s.id, text, { beforeEnter: () => menuNow(s.id) });
  out.ok = !!w.ok;
  out.message = w.ok ? (r.started ? 'started and sent' : 'sent') : w.message || 'not sent';
  return out;
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

export async function sendOrder(sessions, text, o = {}) {
  const body = String(text || '').replace(/\r\n?/g, '\n').trim();
  const list = [...new Map((sessions || []).filter((s) => s && s.id).map((s) => [s.id, s])).values()];
  if (!body) return { ok: false, team: null, results: [], skipped: [], message: 'write the order first' };
  if (!list.length) return { ok: false, team: null, results: [], skipped: [], message: 'no conversation to send it to' };
  const skipped = [], live = [];
  for (const s of list) { const why = unreachable(s); if (why) skipped.push({ id: s.id, name: s.name, ok: false, message: why }); else live.push(s); }
  let team = null, results;
  // a session started seconds ago is keyed new-<n> until its claude names its id: no team member yet, so it
  // gets the order as a plain message
  const ids = live.filter((s) => ID_RE.test(s.id)), keyed = live.filter((s) => !ID_RE.test(s.id));
  if (o.team && ids.length >= 2) {
    if (body.length > ORDER_MAX) return { ok: false, team: null, results: [], skipped, message: `an order is at most ${ORDER_MAX} characters` };
    if (ids.length > TEAM_MAX) return { ok: false, team: null, results: [], skipped, message: `a team has at most ${TEAM_MAX} conversations; pick fewer` };
    const want = { members: ids.map((s) => s.id), order: body };
    if (o.name) want.name = String(o.name).slice(0, 80);
    const post = o.post || defaultPost;
    const r = await post('/teams', want);
    // with ?fixture=1 nothing answers: a team as the server would make it
    team = r && r.ok && r.team ? r.team : r == null && o.fixture ? { id: 'fixture-team', name: want.name || firstWords(body), members: want.members, order: body } : null;
    if (!team) return { ok: false, team: null, results: [], skipped, message: (r && r.message) || 'could not make the team' };
    results = [
      ...await eachLimited(ids, SEND_AT_ONCE, (s) => deliver(s, teamBrief(team, s, ids, o.state, body)).catch((e) => failed(s, e))),
      ...await sendEach(keyed, o.prefix ? `${o.prefix}\n${body}` : body),
    ];
  } else {
    results = await sendEach(live, o.prefix ? `${o.prefix}\n${body}` : body);
  }
  const all = [...results, ...skipped];
  return { ok: results.some((x) => x.ok), team, results: all, skipped };
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
    `Talk to them directly: node "${msgTool(state)}" --from ${me.id} --to <their id> "message". Their messages reach you starting with [Message from teammate].`].join('\n');
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
  const ok = rs.filter((x) => x.ok), bad = rs.filter((x) => !x.ok);
  const head = ok.length ? `${what} to ${ok.length === 1 ? ok[0].name : `${ok.length} conversations`}${res.team ? ` · team "${res.team.name}"` : ''}` : (res && res.message) || 'Nothing was sent';
  if (!bad.length) return head;
  return `${head} · not sent: ${bad.slice(0, 3).map((x) => `${x.name} (${x.message})`).join(', ')}${bad.length > 3 ? ` and ${bad.length - 3} more` : ''}`;
}
