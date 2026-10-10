// node scripts/usage-watch-test.js: the cases usage-watch.js must get right. Exit code 0 when all pass.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createWatch, fromEndpoint } = require('../usage-watch.js');

const MIN = 60e3;
let failed = 0, passed = 0;
const ok = (cond, name) => { if (cond) passed++; else { failed++; console.log(`FAIL ${name}`); } };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-watch-test-'));
let fileN = 0;

// a watch on a fake clock; tick(min, five, usdHere) advances, spends here, then reads
function rig(o = {}) {
  let t = Date.parse('2026-10-10T12:00:00Z');
  const file = path.join(dir, `w${++fileN}.json`);
  const make = () => createWatch({ file, now: () => t, alertPct: () => o.pct || 10 });
  let w = make();
  const resets = t + 4 * 3600e3;
  const api = {
    get t() { return t; },
    get w() { return w; },
    restart() { w = make(); },
    tick(min, five, usd = 0, more = {}) {
      if (usd) w.addLocal('B', t + (min * MIN) / 2, usd);
      t += min * MIN;
      w.read('B', { t, five, fiveResets: more.fiveResets || resets, week: 50, weekResets: resets + 3 * 86400e3, credits: more.credits || null, breakdown: [] }, { pending: !!more.pending });
      return w.view(t).B;
    },
  };
  return api;
}

// 1. idle here, the meter climbs 12 points in 15 minutes: an episode
{
  const r = rig();
  r.tick(0, 20);
  r.tick(5, 24);
  let v = r.tick(5, 28);
  ok(!v.episode, '1a: 8 points (7 after rounding) is under the 10-point line');
  v = r.tick(5, 32);
  ok(v.episode && v.episode.total === 11 && !v.episode.acked, `1b: episode with 11 points from elsewhere (${JSON.stringify(v.episode)})`);
  ok(r.w.suspicious(), '1c: suspicious while it lasts');
}

// 2. the same climb while this PC spends, no rate known: all explained, no episode
{
  const r = rig();
  r.tick(0, 20);
  r.tick(5, 24, 6);
  r.tick(5, 28, 6);
  const v = r.tick(5, 32, 6);
  ok(!v.episode && v.away5 === 0, '2: busy here with no rate known: nothing from elsewhere');
}

// 3. a rate learned from busy stretches, then a climb far beyond what this PC spent
{
  const r = rig();
  r.tick(0, 10);
  for (let i = 0; i < 4; i++) r.tick(5, 12 + i * 2, 4); // $4 per 2 points: $2 per point
  r.tick(15, 18); // fix the earlier stretches (10 minutes old)
  ok(Math.abs(r.w.view(r.t).B.ratio - 2) < 0.01, `3a: learns $2 per point (${r.w.view(r.t).B.ratio})`);
  let v = r.tick(5, 26, 2); // 8 points, $2 here (with the 5 minutes before: $2) -> ceil(1 * 1.5) = 2 explained
  v = r.tick(5, 34, 0.1);
  ok(v.episode && v.episode.total >= 10, `3b: busy a little here, much more on the meter: episode (${JSON.stringify(v.episode)})`);
}

// 4. acknowledging hides that episode only; quiet ends it; the next burst is a new one
{
  const r = rig();
  r.tick(0, 20);
  r.tick(5, 26);
  let v = r.tick(5, 33);
  const id = v.episode && v.episode.id;
  ok(id, '4a: episode');
  ok(r.w.ack('B', id), '4b: ack');
  v = r.tick(5, 38);
  ok(v.episode.id === id && v.episode.acked, '4c: the same episode stays acknowledged while it goes on');
  for (let i = 0; i < 10; i++) v = r.tick(5, 38);
  ok(!v.episode && v.past.length === 1 && v.past[0].id === id, '4d: 45 quiet minutes end it, into past');
  r.tick(5, 44);
  v = r.tick(5, 51);
  ok(v.episode && v.episode.id !== id && !v.episode.acked, '4e: a new burst is a new episode, not acknowledged');
}

// 5. a new 5-hour window: the drop is not negative usage, and the new window's points count from 0
{
  const r = rig();
  r.tick(0, 90);
  const later = r.t + 5 * 3600e3;
  let v = r.tick(5, 3, 0, { fiveResets: later });
  ok(v.bars[v.bars.length - 1].away === 3, '5a: new window counts from 0');
  v = r.tick(5, 4, 0, { fiveResets: later });
  ok(!v.episode, '5b: no episode from a reset');
}

// 6. reads more than 20 minutes apart are not compared
{
  const r = rig();
  r.tick(0, 10);
  const v = r.tick(60, 60);
  ok(!v.episode && v.bars.length === 0, '6: a gap is not judged');
}

// 7. logs still being read (pending): stretches stay open and no episode starts; the late local spend then explains them
{
  const r = rig();
  r.tick(0, 20);
  r.tick(5, 26, 0, { pending: true });
  let v = r.tick(5, 33, 0, { pending: true });
  ok(!v.episode, '7a: no episode while logs are pending');
  r.w.addLocal('B', r.t - 7 * MIN, 30); // the backlog's cost arrives, at its own time
  v = r.tick(1, 33);
  ok(!v.episode && v.away5 === 0, `7b: late local spend explains it (${v.away5})`);
}

// 8. a restart keeps history, the episode and the acknowledgement
{
  const r = rig();
  r.tick(0, 20);
  r.tick(5, 26);
  let v = r.tick(5, 33);
  r.w.ack('B', v.episode.id);
  r.restart();
  v = r.tick(5, 34);
  ok(v.episode && v.episode.acked && v.bars.length >= 3, '8: restart keeps the episode, its ack and the bars');
}

// 9. extra-usage credits spent while nothing runs here
{
  const r = rig();
  r.tick(0, 50, 0, { credits: { used: 10, limit: 40, enabled: true } });
  r.tick(5, 50, 0, { credits: { used: 13, limit: 40, enabled: true } });
  const v = r.tick(5, 50, 0, { credits: { used: 16.5, limit: 40, enabled: true } });
  ok(v.episode && v.episode.credits === 6.5, `9: $6.50 of credits from elsewhere is an episode (${JSON.stringify(v.episode)})`);
}

// 10. a different alert line
{
  const r = rig({ pct: 25 });
  r.tick(0, 20);
  r.tick(5, 30);
  const v = r.tick(5, 40);
  ok(!v.episode, '10: 19 points is under a 25-point line');
}

// 11. the endpoint's reply
{
  const j = { five_hour: { utilization: 17, resets_at: '2026-10-10T22:10:00.894450+00:00' }, seven_day: { utilization: 99, resets_at: '2026-10-15T02:00:00+00:00' },
    extra_usage: { is_enabled: false, monthly_limit: 4000, used_credits: 3012, decimal_places: 2, credits_ever_enabled: true },
    seven_day_breakdown: { rows: [{ key: 'claude_code', display_name: 'Claude Code', percent: 79 }, { key: 'chat', display_name: 'Chats', percent: 0 }] } };
  const r = fromEndpoint(j, 5);
  ok(r.five === 17 && r.week === 99 && r.fiveResets === Date.parse('2026-10-10T22:10:00.894Z'), '11a: limits');
  ok(r.credits && r.credits.used === 30.12 && r.credits.limit === 40 && r.credits.enabled === false, '11b: credits in dollars');
  ok(r.breakdown.length === 2 && r.breakdown[0].name === 'Claude Code' && r.breakdown[0].pct === 79, '11c: breakdown');
  ok(fromEndpoint({ extra_usage: {} }, 1) === null, '11d: nothing to read');
  const noCred = fromEndpoint({ five_hour: { utilization: 1 }, extra_usage: { credits_ever_enabled: false, is_enabled: false, used_credits: null } }, 1);
  ok(noCred.credits === null, '11e: never had credits: none shown');
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
