// Tests for web/team-form.js (the New team form's rules: the Bots view's "+" New team on the page, and the phone
// app's New team screen): who can be ticked and why not, the rows when the team is full, the ticks settling after
// /state moved, the Lead and Team above choices, the default name, the checks before Make team sends (the loop
// refusal, the team above left with one member, full), the POST /teams body, the members that lost their order, and
// the step for a team above. Plain asserts, no dependencies:
// node scripts/team-form-test.mjs
import assert from 'node:assert/strict';
import { TEAM_MAX, firstWords, cleanName, leadOf, teamsOfId, newTeamWhy, teamChoices, memberRow, settleTeam, leadChoices, aboveChoices, countNote, orderHint,
  defaultTeamName, aboveLoop, checkTeam, newTeamBody, lostOf, nestStep, nestFailed } from '../web/team-form.js';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok', name); };
const ID = (k) => `${k}${k}${k}${k}${k}${k}${k}${k}-0000-4000-8000-000000000000`;
const A = ID('a'), B = ID('b'), Cc = ID('c'), D = ID('d'), E = ID('e');
const names = { [A]: 'Chief', [B]: 'Watch', [Cc]: 'Inbox', [D]: 'Deploys', [E]: 'Ledger' };
const nameOf = (id) => names[id] || String(id).slice(0, 8);
const chief = { key: 'chief', kind: 'chief', id: A, name: 'Chief' };
const bot = (id, o = {}) => ({ key: `bot:${id.slice(0, 2)}`, kind: 'bot', id, name: names[id], live: true, ...o });
const teamRow = (t, o = {}) => ({ key: `team:${t.id}`, kind: 'team', id: null, teamId: t.id, name: t.name, members: t.members.map((m) => ({ id: m, name: nameOf(m), lead: m === t.lead })), ...o });

test('firstWords, cleanName, the default name', () => {
  assert.equal(firstWords('Ship booking reminders on the website today', 5, 40), 'Ship booking reminders on the');
  assert.equal(firstWords('a'.repeat(50), 1, 10), `${'a'.repeat(9)}…`);
  assert.equal(cleanName('  two\nlines\t here '), 'two lines here');
  assert.equal(cleanName('x'.repeat(100)).length, 80);
  assert.equal(defaultTeamName('Check every deploy tonight and report back'), 'Bots · Check every deploy tonight');
});

test('leadOf and teamsOfId: the team it reports in and the one it leads', () => {
  const up = { id: 't1', name: 'Up', members: [A, B], lead: A };
  const own = { id: 't2', name: 'Own', members: [B, Cc], lead: B };
  assert.equal(leadOf(up), A);
  assert.equal(leadOf({ members: [A], lead: B }), null);
  assert.deepEqual(teamsOfId([up, own], B), { up, own });
  assert.deepEqual(teamsOfId([up, own], D), { up: null, own: null });
});

test('New team in the "+" menu needs two overseers started here', () => {
  assert.equal(newTeamWhy([chief, bot(B)]), null);
  assert.equal(newTeamWhy([chief, bot(B, { elsewhere: true })]), 'needs two bots (or a bot and the Chief) that have started');
  assert.equal(newTeamWhy([{ ...chief, id: null }, bot(B)]), 'needs two bots (or a bot and the Chief) that have started');
  assert.equal(newTeamWhy([bot(B), { kind: 'team', id: Cc }]), 'needs two bots (or a bot and the Chief) that have started');
});

test('eligibility: elsewhere, never started, the caller\'s why, and the notes', () => {
  const t = { id: 't1', name: 'Squad', members: [B, D], lead: D };
  const list = [chief, bot(B, { live: false }), bot(Cc, { elsewhere: true }), { ...bot(D), id: null, key: 'bot:dd' }, bot(E), { kind: 'chat', id: ID('f') }, teamRow(t)];
  const joinWhy = (id) => (id === E ? 'open in another window: end it there or open it here' : null);
  const ch = teamChoices(list, [t], joinWhy);
  assert.deepEqual(ch.map((x) => x.c.key), ['chief', 'bot:bb', 'bot:cc', 'bot:dd', 'bot:ee']);
  assert.deepEqual(ch.map((x) => x.why), [null, null, 'runs on another machine', 'never started: Start it first', 'open in another window: end it there or open it here']);
  assert.equal(ch[0].note, '');
  assert.equal(ch[1].note, 'not running: it starts to take the order · in "Squad": it leaves it');
  assert.equal(ch[4].note, 'open in another window: end it there or open it here');
  assert.equal(teamChoices([{ ...chief, id: null }], [], () => null)[0].why, 'not started yet');
  // a joinWhy that throws greys the row with its words
  assert.equal(teamChoices([bot(B)], [], () => { throw new Error('boom'); })[0].why, 'boom');
  // the one it leads
  assert.equal(teamChoices([bot(D)], [t], () => null)[0].note, 'leads "Squad": still does');
});

test('rows when the team is full, and the count line', () => {
  const x = { id: B, why: null, note: 'n' };
  assert.deepEqual(memberRow(x, [B], 2), { on: true, off: false, note: 'n' });
  assert.deepEqual(memberRow(x, [A, Cc], 2), { on: false, off: true, note: 'a team has at most 2' });
  assert.deepEqual(memberRow({ id: null, why: 'never started: Start it first', note: 'never started: Start it first' }, [], 2), { on: false, off: true, note: 'never started: Start it first' });
  assert.equal(countNote(1), `Tick two or more (at most ${TEAM_MAX}).`);
  assert.equal(countNote(3), '3 in the team.');
  assert.equal(countNote(12), '12 in the team (the most a team has).');
  assert.equal(orderHint(null), 'The order for all of them. They become a team of peers and can message each other.');
  assert.equal(orderHint({ name: 'Watch' }), 'Watch gets the order and directs the others; they report to it. The order:');
});

test('the ticks settle: one that can\'t any more is unticked, the lead and the team above follow', () => {
  const choices = [{ id: A, why: null }, { id: B, why: null }, { id: Cc, why: 'runs on another machine' }];
  const rows = [teamRow({ id: 't1', name: 'Up', members: [D, E], lead: D })];
  assert.deepEqual(settleTeam({ members: [A, B], lead: B, above: 't1' }, choices, rows), { members: [A, B], lead: B, above: 't1' });
  assert.deepEqual(settleTeam({ members: [A, Cc], lead: Cc, above: 't1' }, choices, rows), { members: [A], lead: '', above: '' });
  assert.deepEqual(settleTeam({ members: [A, B], lead: '', above: 't1' }, choices, rows), { members: [A, B], lead: '', above: '' });
  assert.deepEqual(settleTeam({ members: [A, B], lead: A, above: 'gone' }, choices, rows), { members: [A, B], lead: A, above: '' });
  assert.deepEqual(settleTeam({ members: [A, B], lead: '', above: '' }, choices, rows, 1), { members: [A], lead: '', above: '' });
});

test('Lead and Team above choices', () => {
  const t = { id: 't1', name: 'Up', members: [D, E, A], lead: D };
  const own = { id: 't2', name: 'Own', members: [B, Cc], lead: B };
  const lc = leadChoices([chief, bot(B)], [t, own]);
  assert.deepEqual(lc.map((o) => [o.value, o.label, o.note]), [['', 'No lead (peers)', 'they work it out between them'],
    [A, 'Chief leads', 'the others report to it'], [B, 'Watch leads', 'leads "Own" now: it leaves that lead']]);
  assert.equal(lc[1].c, chief);
  const ac = aboveChoices([chief, teamRow(t), teamRow(own)], [t, own], 3);
  assert.deepEqual(ac.map((o) => [o.value, o.label, o.note]), [['', 'None', 'a team of its own'], ['t1', 'Up', '3 members, led by Deploys · full'], ['t2', 'Own', '2 members, led by Watch']]);
  // a team /state no longer has: its row's member count
  assert.equal(aboveChoices([teamRow({ id: 't9', name: 'Peers', members: [A, B], lead: null })], [])[1].note, '2 members, peers');
});

test('aboveLoop: a lead can\'t report to itself, up the levels', () => {
  // t1 led by D, D reports in t0 led by A
  const t0 = { id: 't0', name: 'Top', members: [A, D, E], lead: A };
  const t1 = { id: 't1', name: 'Mid', members: [D, Cc], lead: D };
  assert.equal(aboveLoop([t0, t1], [B, Cc], t1, nameOf), null);
  assert.equal(aboveLoop([t0, t1], [A, B], t1, nameOf), 'Chief is in the new team and above it: a lead can\'t report to itself');
  assert.equal(aboveLoop([t0, t1], [D, B], t1, nameOf), 'Deploys is in the new team and above it: a lead can\'t report to itself');
  // a cycle in the data never hangs
  const x = { id: 'x', name: 'X', members: [A, B], lead: A }, y = { id: 'y', name: 'Y', members: [B, A], lead: B };
  assert.equal(aboveLoop([x, y], [Cc, D], x, nameOf), null);
});

test('checkTeam: the page\'s checks, in its order', () => {
  const t0 = { id: 't0', name: 'Top', members: [A, D, E], lead: A };
  const env = { teams: [t0], nameOf, listed: (id) => id in names, whyNot: (id) => (id === E ? 'open in another window: end it there or open it here' : null) };
  const ok = (o) => checkTeam({ order: 'Do it', ...o }, env);
  assert.deepEqual(ok({ members: [B] }), { ok: false, message: 'a team needs two or more' });
  assert.deepEqual(ok({ members: [B, ID('9')] }), { ok: false, message: 'Fleet View does not list one of them now' });
  assert.deepEqual(checkTeam({ members: [A, B, Cc], order: 'x' }, { ...env, max: 2 }), { ok: false, message: 'a team has at most 2' });
  assert.deepEqual(ok({ members: [B, E] }), { ok: false, message: 'Ledger: open in another window: end it there or open it here' });
  assert.deepEqual(ok({ members: [B, Cc], order: '  \n ' }), { ok: false, message: 'write the order first' });
  assert.deepEqual(ok({ members: [B, Cc], order: 'x'.repeat(4001) }), { ok: false, message: 'an order is at most 4000 characters' });
  assert.deepEqual(ok({ members: [B, Cc], lead: D }), { ok: false, message: 'the lead must be one of the members' });
  assert.deepEqual(ok({ members: [B, Cc], lead: B, above: 'gone' }), { ok: false, message: 'the team above is gone' });
  assert.deepEqual(ok({ members: [B, Cc], above: 't0' }), { ok: false, message: 'only a team with a lead can report to a team above' });
  // the loop: the Chief leads Top, and is in the new team
  assert.deepEqual(ok({ members: [A, B], lead: B, above: 't0' }), { ok: false, message: 'Chief is in the new team and above it: a lead can\'t report to itself' });
  // the team above left with one member: D moves out of Top (A leads it, E stays): Top keeps A and E, fine;
  // with D and E both moving, only A stays
  const t1 = { id: 't1', name: 'Pair', members: [D, Cc, B], lead: D };
  assert.deepEqual(checkTeam({ members: [Cc, B, E], lead: E, order: 'x', above: 't1' }, { ...env, teams: [t1], whyNot: () => null }),
    { ok: false, message: '"Pair" would be left with one member once Inbox and Watch move to the new team, and end: pick another team above, or none' });
  const t2 = { id: 't2', name: 'Duo', members: [D, Cc], lead: D };
  assert.equal(checkTeam({ members: [Cc, B], lead: B, order: 'x', above: 't2' }, { ...env, teams: [t2] }).message,
    '"Duo" would be left with one member once Inbox moves to the new team, and end: pick another team above, or none');
  // full: the team above has no room for the lead
  const big = { id: 'tb', name: 'Big', members: [D, E], lead: D };
  assert.deepEqual(checkTeam({ members: [B, Cc], lead: B, order: 'x', above: 'tb' }, { ...env, teams: [big], max: 2, whyNot: () => null }), { ok: false, message: '"Big" is full (2)' });
  // and when all is well: the members as listed (dupes and non-strings out), the order trimmed, the name cleaned or made
  const good = checkTeam({ members: [B, Cc, B, 7], lead: B, order: ' Ship it\r\nnow ', name: ' Night\nshift ', above: 't0' }, env);
  assert.deepEqual(good, { ok: true, members: [B, Cc], lead: B, above: t0, already: false, order: 'Ship it\nnow', name: 'Night shift' });
  assert.equal(checkTeam({ members: [B, Cc], order: 'Watch every deploy tonight please' }, env).name, 'Bots · Watch every deploy tonight');
  // a lead that is in the team above already
  assert.equal(checkTeam({ members: [D, B], lead: D, order: 'x', above: 't0' }, { ...env, whyNot: () => null }).already, true);
});

test('the request bodies', () => {
  assert.deepEqual(newTeamBody({ members: [B, Cc], order: 'Do it', lead: null, name: 'Bots · Do it' }), { members: [B, Cc], order: 'Do it', send: true, lead: null, name: 'Bots · Do it' });
  assert.deepEqual(newTeamBody({ members: [B, Cc], order: 'Do it', lead: B }), { members: [B, Cc], order: 'Do it', send: true, lead: B });
  assert.equal(newTeamBody({ members: [], order: 'x', name: 'n'.repeat(90) }).name.length, 80);
  assert.deepEqual(lostOf({ ok: true, sent: [{ id: B, ok: true }, { id: Cc, ok: false, queued: true }, { id: D, ok: false, message: 'no' }] }), [D]);
  assert.deepEqual(lostOf({ ok: true }), []);
  assert.deepEqual(lostOf(null), []);
  const t0 = { id: 't0', name: 'Top', members: [A, D, E], lead: A };
  const chk = { above: t0, lead: B, already: false };
  assert.equal(nestStep({ id: 'tn', name: 'New', lead: B }, { above: null }), null);
  assert.deepEqual(nestStep({ id: 'tn', name: 'New', lead: B }, chk), { body: { id: 't0', member: B } });
  assert.equal(nestStep({ id: 'tn', name: 'New', lead: D }, { above: t0, lead: D, already: true }), null);
  assert.deepEqual(nestStep({ id: 'tn', name: 'New', lead: null }, chk), { message: '"New" was made with no lead, so it is not under "Top"' });
  assert.equal(nestFailed({ name: 'New', lead: B }, t0, { message: 'it is in that team already' }, nameOf), '"New" was made, but Watch did not join "Top": it is in that team already');
  assert.equal(nestFailed({ name: 'New', lead: B }, t0, null, nameOf), '"New" was made, but Watch did not join "Top": Fleet View did not answer');
});

console.log(`${n} tests passed`);
