// node scripts/account-switch-test.js: the cases account-switch.js must get right. Exit code 0 when all pass.
'use strict';
const S = require('../account-switch.js');

let failed = 0, passed = 0;
const ok = (cond, name) => { if (cond) passed++; else { failed++; console.log(`FAIL ${name}`); } };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const MIN = 60e3;
const NOW = Date.parse('2026-10-13T12:00:00Z');
// usage as /state has it: five and week percentages (null: no figure)
const u = (five, week) => ({ five: five == null ? null : { pct: five, resets: NOW + 3600e3 }, week: week == null ? null : { pct: week, resets: NOW + 3 * 86400e3 } });
const acct = (a, more = {}) => ({ a, signedIn: true, sameAs: null, ...more });
const AB = [acct('A'), acct('B')], ABC = [...AB, acct('C')];
const conv = (id, account, more = {}) => ({ id, account, status: 'idle', away: false, moving: false, limit: null, ...more });
const run = (o) => S.plan({ now: NOW, on: true, accounts: AB, last: new Map(), ...o });

// ---------- how full an account is ----------
ok(eq(S.lowOn(u(92, 40)), { limit: 'five', pct: 92 }), 'lowOn: the 5-hour limit at 92%');
ok(eq(S.lowOn(u(50, 95)), { limit: 'week', pct: 95 }), 'lowOn: the weekly limit at 95%');
ok(eq(S.lowOn(u(90, 10)), { limit: 'five', pct: 90 }), 'lowOn: exactly SWITCH_PCT counts');
ok(S.lowOn(u(89, 89)) === null, 'lowOn: under 90% on both is not low');
ok(S.lowOn(null) === null && S.lowOn(u(null, null)) === null, 'lowOn: no read is not low');
ok(eq(S.lowOn(u(null, 93)), { limit: 'week', pct: 93 }), 'lowOn: a weekly figure alone');
ok(S.nearLimit({ A: u(80, 10), B: u(5, 5) }) && !S.nearLimit({ A: u(79, 79) }) && !S.nearLimit({}), 'nearLimit: any account at 80% or more');

// ---------- roomiest (bots.js uses it for a Dynamic account too) ----------
ok(S.roomiest(['A', 'B'], { A: u(80, 20), B: u(10, 50) }, 'B') === 'B', 'roomiest: the fuller limit decides');
ok(S.roomiest(['A', 'B'], { A: u(10, 30), B: u(30, 10) }, 'B') === 'B', 'roomiest: a tie on the fuller limit goes to the lower week');
ok(S.roomiest(['A', 'B'], { A: u(5, 5) }, 'B') === 'A', 'roomiest: an account with no read comes after one with a read');
ok(S.roomiest(['A', 'B'], {}, 'B') === 'B' && S.roomiest(['A', 'C'], {}, 'B') === 'A', 'roomiest: none read: the default, else the first');
ok(S.roomiest([], {}, 'B') === 'B', 'roomiest: no accounts: the default');

// ---------- prevent: moves at the next pause ----------
{
  const r = run({ usage: { A: u(92, 40), B: u(30, 20) }, sessions: [conv('c1', 'A')] });
  ok(eq(r.moves, [{ id: 'c1', from: 'A', to: 'B', rescue: false, why: { limit: 'five', pct: 92 } }]) && !r.stuck.length, 'prevent: an idle conversation on A at 92% moves to B');
  ok(S.whyText('A', r.moves[0].why) === 'A at 92% of its 5-hour limit', 'whyText: "A at 92% of its 5-hour limit"');
}
ok(S.whyText('B', { limit: 'week', pct: 95 }) === 'B at 95% of its weekly limit' && S.whyText('A', { limit: 'five', hit: true }) === 'A hit its 5-hour limit', 'whyText: weekly, and a limit hit');
ok(!run({ usage: { A: u(89, 40), B: u(30, 20) }, sessions: [conv('c1', 'A')] }).moves.length, 'prevent: under 90% nothing moves');
for (const st of ['busy', 'waiting', null]) {
  ok(!run({ usage: { A: u(95, 40), B: u(10, 10) }, sessions: [conv('c1', 'A', { status: st })] }).moves.length, `prevent: never while ${st || 'its status is unknown'}`);
}
ok(!run({ usage: { A: u(95, 40), B: u(10, 10) }, sessions: [conv('c1', 'A', { away: true })] }).moves.length, 'guard: never one another device has');
ok(!run({ usage: { A: u(95, 40), B: u(10, 10) }, sessions: [conv('c1', 'A', { moving: true })] }).moves.length, 'guard: never one moving already');
ok(!run({ on: false, usage: { A: u(99, 99), B: u(1, 1) }, sessions: [conv('c1', 'A', { limit: { limit: 'five', at: NOW } })] }).moves.length, 'setting off: nothing moves, not even a rescue');
ok(!run({ usage: { B: u(10, 10) }, sessions: [conv('c1', 'A')] }).moves.length, 'prevent: a conversation on an account with no read stays');
{
  const r = run({ accounts: ABC, usage: { A: u(91, 50), B: u(40, 30), C: u(20, 60) }, sessions: [conv('c1', 'A')] });
  ok(r.moves.length === 1 && r.moves[0].to === 'B', 'prevent: to the roomiest with room by the fuller limit (B 40 beats C 60)');
}
{
  const r = run({ accounts: ABC, usage: { A: u(91, 50), B: u(10, 30), C: u(30, 10) }, sessions: [conv('c1', 'A'), conv('c2', 'A'), conv('c3', 'B')] });
  ok(r.moves.map((m) => `${m.id}>${m.to}`).join() === 'c1>C,c2>C', 'prevent: every idle one on the low account moves; one on an account with room stays (a tie on 30 goes to the lower week)');
}

// ---------- where it may go ----------
const stuck = (o) => { const r = run({ sessions: [conv('c1', 'A')], ...o }); return !r.moves.length && eq(r.stuck, ['c1']); };
ok(stuck({ usage: { A: u(92, 40), B: u(85, 20) } }), 'room: an account at 80% or more has no room (stuck)');
ok(stuck({ usage: { A: u(92, 40), B: u(10, 80) } }), 'room: its weekly limit counts too');
ok(stuck({ usage: { A: u(92, 40) } }), 'room: an account with no read is never picked');
ok(stuck({ accounts: [acct('A'), acct('B', { signedIn: false })], usage: { A: u(92, 40), B: u(10, 10) } }), 'room: never an account not signed in');
ok(stuck({ accounts: [acct('A'), acct('B', { sameAs: 'A' })], usage: { A: u(92, 40), B: u(10, 10) } }), 'room: never a second letter of the same login');
ok(stuck({ accounts: [acct('A')], usage: { A: u(92, 40) } }), 'room: one account only: stuck');
ok(S.target('A', AB, { A: u(92, 40), B: u(10, 10) }) === 'B' && S.target('B', AB, { A: u(92, 40), B: u(10, 10) }) === null, 'target: never the account it is on, never one fuller');
ok(S.target('A', AB, { A: u(70, 10), B: u(75, 10) }) === null, 'target: never one fuller than the current one');

// ---------- the cooldown: no ping-pong ----------
{
  const usage = { A: u(30, 10), B: u(93, 40) };
  const last = new Map([['c1', { at: NOW - 10 * MIN, from: 'A', to: 'B' }]]);
  ok(!run({ usage, last, sessions: [conv('c1', 'B')] }).moves.length, 'cooldown: moved 10 minutes ago: it stays, though B is low now');
  const later = new Map([['c1', { at: NOW - 31 * MIN, from: 'A', to: 'B' }]]);
  const r = run({ usage, last: later, sessions: [conv('c1', 'B')] });
  ok(r.moves.length === 1 && r.moves[0].to === 'A', 'cooldown: after 30 minutes it may move again (A has room again)');
  ok(stuck({ usage: { A: u(92, 40), B: u(91, 10) } }), 'no ping-pong: never back to an account still over 90%');
}

// ---------- rescue: it hit its limit anyway ----------
{
  const hit = { limit: 'five', at: NOW - 2 * MIN };
  const r = run({ usage: { A: u(70, 40), B: u(20, 20) }, sessions: [conv('c1', 'A', { limit: hit })] });
  ok(eq(r.moves, [{ id: 'c1', from: 'A', to: 'B', rescue: true, why: { limit: 'five', hit: true } }]), 'rescue: a limit hit moves it (the read may lag behind), told to continue');
  const last = new Map([['c1', { at: NOW - 5 * MIN, from: 'B', to: 'A' }]]);
  ok(run({ usage: { A: u(100, 40), B: u(20, 20) }, last, sessions: [conv('c1', 'A', { limit: hit })] }).moves.length === 1, 'rescue: does not wait out the cooldown');
  { const r2 = run({ usage: { A: u(100, 40), B: u(20, 20) }, sessions: [conv('c1', 'A', { limit: { limit: 'five', at: NOW - 31 * MIN } })] });
    ok(r2.moves.length === 1 && !r2.moves[0].rescue, 'rescue: an old hit on a low account still moves it, as prevent does (no "continue")'); }
  ok(!run({ usage: { A: u(50, 40), B: u(20, 20) }, sessions: [conv('c1', 'A', { limit: { limit: 'five', at: NOW - 31 * MIN } })] }).moves.length, 'rescue: a hit older than 30 minutes is not rescued');
  ok(!run({ usage: { A: u(100, 40), B: u(20, 20) }, sessions: [conv('c1', 'A', { limit: hit, status: 'waiting' })] }).moves.length, 'rescue: not while a menu waits');
  ok(stuck({ usage: { A: u(100, 40), B: u(95, 20) }, sessions: [conv('c1', 'A', { limit: hit })] }), 'rescue: nowhere with room: stuck');
  const r3 = run({ usage: { A: u(60, 40), B: u(75, 20) }, sessions: [conv('c1', 'A', { limit: hit })] });
  ok(r3.moves.length === 1 && r3.moves[0].to === 'B', 'rescue: an account with room is taken though the last read of the one it hit says less');
}

// ---------- new conversations ----------
ok(eq(S.pickNew('A', { on: true, accounts: AB, usage: { A: u(93, 10), B: u(5, 5) } }), { account: 'B', from: 'A', why: { limit: 'five', pct: 93 } }), 'pickNew: a new one asked for on A at 93% starts on B');
ok(S.pickNew('A', { on: true, accounts: AB, usage: { A: u(60, 10), B: u(5, 5) } }) === null, 'pickNew: A with room keeps it');
ok(S.pickNew('A', { on: false, accounts: AB, usage: { A: u(99, 10), B: u(5, 5) } }) === null, 'pickNew: the setting off: as asked');
ok(S.pickNew('A', { on: true, accounts: AB, usage: { A: u(99, 10), B: u(85, 5) } }) === null, 'pickNew: no account with room: as asked');
ok(S.pickNew('A', { on: true, accounts: [acct('A'), acct('B', { signedIn: false })], usage: { A: u(99, 10), B: u(5, 5) } }) === null, 'pickNew: never an account not signed in');

// ---------- Claude Code's usage-limit message (the shapes in real transcripts) ----------
const errLine = (text, more = {}) => ({ type: 'assistant', isApiErrorMessage: true, error: 'rate_limit', apiErrorStatus: 429,
  message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text }] }, ...more });
ok(eq(S.limitHit(errLine("You've hit your session limit · resets 7:20pm (America/Los_Angeles)",
  { quotaLimits: { status: 'rejected', rateLimitType: 'five_hour' } })), { limit: 'five' }), 'limitHit: the session limit, with quotaLimits');
ok(eq(S.limitHit(errLine("You've hit your weekly limit · resets Sep 25, 9am (America/Los_Angeles)")), { limit: 'week' }), 'limitHit: the weekly limit, by its text alone');
ok(eq(S.limitHit(errLine('Claude AI usage limit reached|1760000000')), { limit: 'five' }), 'limitHit: the older "usage limit reached" text');
ok(eq(S.limitHit(errLine('x', { quotaLimits: { status: 'rejected', rateLimitType: 'seven_day' } })), { limit: 'week' }), 'limitHit: quotaLimits rejected on seven_day');
ok(S.limitHit(errLine('API Error: 500 {"type":"error","error":{"type":"api_error"}}', { error: 'server_error' })) === null, 'limitHit: another API error is not a limit');
ok(S.limitHit({ type: 'assistant', message: { content: [{ type: 'text', text: "You've hit your session limit" }] } }) === null, 'limitHit: Claude quoting the words in a reply is not one');
ok(S.limitHit({ type: 'user', isApiErrorMessage: true, message: { content: "You've hit your session limit" } }) === null, 'limitHit: only an assistant entry');
ok(S.limitHit(null) === null && S.limitHit({}) === null, 'limitHit: nothing');

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
