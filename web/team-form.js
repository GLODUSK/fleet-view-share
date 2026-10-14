// Fleet View web: the New team form's rules, for the Bots view's "+" New team (web/chats.js drawTeamForm, and
// ui.makeTeam in app.js) and the phone app's New team screen (phone/src/app/team/new.tsx), which imports this file as
// it is. Pure: no DOM, no fetch, no storage. What depends on the window (can this window type into it: orders.js
// unreachable) comes in as a function; on the phone it is "the PC is online and the conversation is on this PC".
//
//   TEAM_MAX                               a team's most members (the server's TEAM_MEMBERS_MAX)
//   firstWords(text, n, max)               the first words of a text, for a team's name (orders.js re-exports it)
//   cleanName(v)                           a name on one line, no control characters, at most 80 characters
//   leadOf(t)                              a team's lead (its conversation id), or null (peers)
//   teamsOfId(teams, id)                   { up: the team it is a plain member of, own: the one it leads }
//   newTeamWhy(contacts)                   why "+" ▸ New team is off (fewer than two overseers started), or null
//   teamChoices(contacts, teams, joinWhy)  who can be ticked: the bots, each { c, id, why, note }
//   memberRow(x, picked, max)              one row as drawn: { on, off, note } (off: greyed, with why or "full")
//   settleTeam(v, choices, contacts, max)  the ticks, lead and team above that still hold after /state moved
//   leadChoices(ticked, teams)             Lead ▸: No lead (peers), then "<name> leads" per ticked one
//   aboveChoices(contacts, teams, max)     Team above ▸: None, then each team of overseers
//   countNote(n, max), orderHint(lead)     the form's small lines
//   defaultTeamName(order)                 "Bots · <the order's first words>"
//   aboveLoop(teams, members, above, nameOf)  why its lead reporting in above would loop, or null
//   checkTeam(o, env)                      every check Make team runs before anything is sent -> { ok: false,
//                                          message } or { ok: true, members, lead, above, already, order, name }
//   newTeamBody(o)                         POST /teams { members, order, send: true, lead, name? } (orders.js sends it)
//   lostOf(reply)                          the members POST /teams could not give the order (not queued either)
//   nestStep(team, chk), nestFailed(...)   what follows for a team above: POST /teams/add { id, member }, or why not
//   joinPlan(teams, id, toId, max, nameOf)  putting conversation id in team toId (the Bots list's drag in, Move to team,
//                                          Put in team: POST /teams/add): { why } when it can't, else { why: null,
//                                          leaves (the team it is a plain member of, which it leaves), ends (that team,
//                                          left with one: the server ends it), nests (the team it leads: it goes under) }
//   leavePlan(teams, id, fromId)           taking it out (POST /teams/leave): { why, ends (left with one: it ends),
//                                          lead (it leads it: the rest go on as peers) }

export const TEAM_MAX = 12;
export const ORDER_MAX = 4000; // the server's limit for a team's order

// the first words of a text, for a team's name ("Ship booking reminders on the website…" -> "Ship booking reminders on the")
export function firstWords(text, n = 5, max = 40) {
  const w = String(text || '').replace(/\s+/g, ' ').trim().split(' ').slice(0, n).join(' ');
  return w.length > max ? `${w.slice(0, max - 1).trimEnd()}…` : w;
}
export const cleanName = (v) => String(v ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80).trim();

const arr = (v) => (Array.isArray(v) ? v : []);
export const leadOf = (t) => (t && t.lead && arr(t.members).includes(t.lead) ? t.lead : null);
// a conversation's teams: the one it is a plain member of (up: it leaves it for the new one) and the one it leads (own)
export function teamsOfId(teams, id) {
  const ts = arr(teams);
  return { up: ts.find((t) => arr(t.members).includes(id) && t.lead !== id) || null, own: ts.find((t) => t.lead === id && arr(t.members).includes(id)) || null };
}

// the bots' rows (chats-model.js buildContacts)
const overseer = (c) => !!c && c.kind === 'bot';
export function newTeamWhy(contacts) {
  const n = arr(contacts).filter((c) => overseer(c) && c.id && !c.elsewhere).length;
  return n >= 2 ? null : 'needs two bots that have started';
}

// who can be in it: every bot, each with why not (greyed) or a note: not running (it is resumed to take
// the order), the team it leaves, the one it still leads. joinWhy(id): why that conversation can't be in a team made
// from here (the page: the orders' checks, ui.teamJoinWhy; the phone: the PC's list), or null
export function teamChoices(contacts, teams, joinWhy) {
  return arr(contacts).filter(overseer).map((c) => {
    let why = c.elsewhere ? 'runs on another machine' : !c.id ? 'never started: Start it first' : null;
    if (!why) { try { why = joinWhy(c.id) || null; } catch (e) { why = String((e && e.message) || e); } }
    const { up, own } = c.id ? teamsOfId(teams, c.id) : {};
    const note = why || [c.kind === 'bot' && c.live === false ? 'not running: it starts to take the order' : '',
      up ? `in "${up.name}": it leaves it` : '', own ? `leads "${own.name}": still does` : ''].filter(Boolean).join(' · ');
    return { c, id: c.id, why, note };
  });
}
// one choice's row: ticked, greyed (it can't, or the team is full) and the line under its name
export function memberRow(x, picked, max = TEAM_MAX) {
  const ms = arr(picked);
  const on = !!x.id && ms.includes(x.id), full = !on && !x.why && ms.length >= max;
  return { on, off: !!x.why || full, note: full ? `a team has at most ${max}` : x.note };
}
// v { members, lead, above } as still holds: a member that can't be in it any more (gone, ended elsewhere) is unticked,
// the lead and the team above follow (the team above only with a lead, and only while that team is listed)
export function settleTeam(v, choices, contacts, max = TEAM_MAX) {
  const can = new Set(arr(choices).filter((x) => !x.why).map((x) => x.id));
  const members = arr(v && v.members).filter((id) => can.has(id)).slice(0, max);
  const lead = v && v.lead && members.includes(v.lead) ? v.lead : '';
  const above = lead && arr(contacts).some((c) => c && c.kind === 'team' && c.teamId === v.above) ? v.above : '';
  return { members, lead, above };
}
// Lead ▸: No lead (peers), then each one ticked (c: its row, for its face)
export function leadChoices(ticked, teams) {
  return [{ value: '', label: 'No lead (peers)', note: 'they work it out between them' },
    ...arr(ticked).map((c) => {
      const own = teamsOfId(teams, c.id).own;
      return { value: c.id, label: `${c.name} leads`, c, note: own ? `leads "${own.name}" now: it leaves that lead` : 'the others report to it' };
    })];
}
// Team above ▸: None, then each team of overseers (a group chat in Bots); its lead reports there (teams nest)
export function aboveChoices(contacts, teams, max = TEAM_MAX) {
  return [{ value: '', label: 'None', note: 'a team of its own' },
    ...arr(contacts).filter((c) => c && c.kind === 'team').map((c) => {
      const t = arr(teams).find((x) => x.id === c.teamId), lead = arr(c.members).find((m) => m.lead);
      const n = t ? arr(t.members).length : arr(c.members).length;
      return { value: c.teamId, label: c.name, note: `${n} members${lead ? `, led by ${lead.name}` : ', peers'}${n >= max ? ' · full' : ''}` };
    })];
}
export const countNote = (n, max = TEAM_MAX) => (n < 2 ? `Tick two or more (at most ${max}).` : `${n} in the team${n >= max ? ' (the most a team has)' : ''}.`);
// the order box's placeholder: lead, the row of the one that leads, or null
export const orderHint = (lead) => (lead ? `${lead.name} gets the order and directs the others; they report to it. The order:`
  : 'The order for all of them. They become a team of peers and can message each other.');
export const defaultTeamName = (order) => `Bots · ${firstWords(order, 4, 34)}`;

// would lead reporting in team above make a loop? Up from above's lead, lead by lead (each one's plain seat), until
// one of the new team's members: it would report to itself. The server checks the same (409); this says so before
// the team is made, so a refused nesting never leaves a team half set up
export function aboveLoop(teams, members, above, nameOf = (id) => String(id || '').slice(0, 8)) {
  const seen = new Set();
  for (let cur = leadOf(above); cur && !seen.has(cur); ) {
    if (members.includes(cur)) return `${nameOf(cur)} is in the new team and above it: a lead can't report to itself`;
    seen.add(cur);
    const up = arr(teams).find((t) => arr(t.members).includes(cur) && t.lead !== cur);
    cur = leadOf(up);
  }
  return null;
}

// Make team's checks, in the order the page has always run them, before anything is sent.
// o { members: [ids], lead: id | null, above: team id | null, order, name }
// env { teams: state.teams, listed(id): /state lists that conversation, whyNot(id): why it can't be in a team made
//       from here or null, nameOf(id), max }
// -> { ok: false, message } or { ok: true, members, lead (id or null), above (the team or null), already (the lead is
//    in the team above already), order (trimmed), name (the name to send: o.name cleaned, else defaultTeamName) }
export function checkTeam(o, env = {}) {
  const fail = (message) => ({ ok: false, message });
  const teams = arr(env.teams), max = env.max || TEAM_MAX;
  const listed = env.listed || (() => true), whyNot = env.whyNot || (() => null), nameOf = env.nameOf || ((id) => String(id || '').slice(0, 8));
  const ids = [...new Set(arr(o && o.members).filter((x) => typeof x === 'string'))];
  const list = ids.filter((id) => listed(id));
  if (list.length < 2) return fail(list.length < ids.length ? 'Fleet View does not list one of them now' : 'a team needs two or more');
  if (list.length > max) return fail(`a team has at most ${max}`);
  const bad = list.find((id) => whyNot(id));
  if (bad) return fail(`${nameOf(bad)}: ${whyNot(bad)}`);
  const order = String((o && o.order) || '').replace(/\r\n?/g, '\n').trim();
  if (!order) return fail('write the order first');
  if (order.length > ORDER_MAX) return fail(`an order is at most ${ORDER_MAX} characters`);
  const lead = o.lead ? (list.includes(o.lead) ? o.lead : null) : null;
  if (o.lead && !lead) return fail('the lead must be one of the members');
  const above = o.above ? teams.find((t) => t.id === o.above) || null : null;
  if (o.above && !above) return fail('the team above is gone');
  if (above && !lead) return fail('only a team with a lead can report to a team above');
  const loop = above ? aboveLoop(teams, list, above, nameOf) : null;
  if (loop) return fail(loop);
  // the members that are plain members of the team above leave it for the new team (POST /teams), so it must keep
  // two of its own, or the server disbands it before the lead can join; and it needs room for the lead
  const already = !!(above && arr(above.members).includes(lead));
  if (above) {
    const am = arr(above.members);
    const leave = am.filter((m) => m !== lead && m !== above.lead && list.includes(m));
    const stay = am.length - leave.length;
    if (stay < 2) return fail(`"${above.name}" would be left with one member once ${leave.map(nameOf).join(' and ')} ${leave.length === 1 ? 'moves' : 'move'} to the new team, and end: pick another team above, or none`);
    if (!already && stay + 1 > max) return fail(`"${above.name}" is full (${max})`);
  }
  return { ok: true, members: list, lead, above, already, order, name: cleanName(o.name) || defaultTeamName(order) };
}

// POST /teams with send: the server types each member its brief (the lead's, a led member's or the peers'), and the
// reply's sent says how each went. lead null: a team of peers (a set that is a led team already becomes peers)
export function newTeamBody(o) {
  const b = { members: [...arr(o.members)], order: String(o.order || ''), send: true, lead: o.lead || null };
  if (o.name) b.name = String(o.name).slice(0, 80);
  return b;
}
// POST /teams' reply: the members whose order could not be sent and is not waiting either (they leave quietly:
// POST /teams/leave { id, member, quiet: true }, as orders.js does)
export const lostOf = (reply) => arr(reply && reply.sent).filter((x) => x && !x.ok && !x.queued && typeof x.id === 'string').map((x) => x.id);
// after the team is made, with a team above (chk: checkTeam's): null (nothing to do: no team above, or its lead is in
// it already and still leads the new team), { body } for POST /teams/add (its lead joins as a plain member, so it
// reports there), or { message } (made with no lead, so nothing can report up)
export function nestStep(team, chk) {
  const above = chk && chk.above;
  if (!above || !team || (chk.already && team.lead === chk.lead)) return null;
  if (!team.lead) return { message: `"${team.name}" was made with no lead, so it is not under "${above.name}"` };
  return { body: { id: above.id, member: team.lead } };
}
export const nestFailed = (team, above, reply, nameOf = (id) => String(id || '').slice(0, 8)) =>
  `"${team.name}" was made, but ${nameOf(team.lead)} did not join "${above.name}": ${(reply && reply.message) || 'Fleet View did not answer'}`;

// The Bots list's team groups (web/chats.js, the phone's Bots tab): a member in or out, said before anything is sent.
// The server moves a plain member out of its old team when it joins another (a lead keeps the team it leads, which
// then goes under the new one), and ends a team left with one member
export function joinPlan(teams, id, toId, max = TEAM_MAX, nameOf = (x) => String(x || '').slice(0, 8)) {
  const ts = arr(teams), to = ts.find((t) => t && t.id === toId) || null;
  const no = (why) => ({ why, leaves: null, ends: null, nests: null });
  if (!to) return no('that team is gone');
  if (!id) return no('it has not started yet');
  if (arr(to.members).includes(id)) return no(`it is in "${to.name}" already`);
  if (arr(to.members).length >= max) return no(`"${to.name}" is full (${max})`);
  // it leads a team "to" reports up to: in "to", it would report to itself
  if (aboveLoop(ts, [id], to, nameOf)) return no(`"${to.name}" reports up to ${nameOf(id)}`);
  const { up, own } = teamsOfId(ts, id);
  const leaves = up && up.id !== to.id ? up : null;
  return { why: null, leaves, ends: leaves && arr(leaves.members).length - 1 < 2 ? leaves : null, nests: own };
}
export function leavePlan(teams, id, fromId) {
  const t = arr(teams).find((x) => x && x.id === fromId) || null;
  if (!t || !id || !arr(t.members).includes(id)) return { why: t ? 'it is not in that team now' : 'that team is gone', ends: false, lead: false };
  return { why: null, ends: arr(t.members).length - 1 < 2, lead: leadOf(t) === id };
}
