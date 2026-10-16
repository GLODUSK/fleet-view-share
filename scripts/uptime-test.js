// Tests for uptime.js (when Fleet View was not running, so the 3-hour rule counts only running time): node scripts/uptime-test.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createUptime, onTime, offBetween, tidy, BEAT_MS, GAP_MIN, KEEP_MS, KEEP_GAPS } = require(path.join(__dirname, '..', 'uptime.js'));

const MIN = 60e3, H = 3600e3, K = 3 * H;
const at = (h, m = 0) => Date.UTC(2026, 9, 16, h, m, 0);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-uptime-test-'));
let n = 0;
const fresh = () => path.join(dir, `u${++n}`, 'uptime.json');
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
// a clock the test moves
const clock = (t) => { const c = { t, now: () => c.t }; return c; };

try {
  // ---------- offBetween / onTime ----------
  const gaps = [{ from: at(2), to: at(3) }, { from: at(5), to: at(6) }];
  const total = 2 * H;
  assert.strictEqual(offBetween(gaps, at(0), at(1)), 0); // all of it before the gaps
  assert.strictEqual(offBetween(gaps, at(7), at(8)), 0); // all of it after them
  assert.strictEqual(offBetween(gaps, at(1), at(4)), H); // one gap inside
  assert.strictEqual(offBetween(gaps, at(0), at(8)), 2 * H); // both inside
  assert.strictEqual(offBetween(gaps, at(0), at(8), total), 2 * H); // the same through the shortcut
  assert.strictEqual(offBetween(gaps, at(2, 30), at(4)), 30 * MIN); // starts inside a gap
  assert.strictEqual(offBetween(gaps, at(4), at(5, 15)), 15 * MIN); // ends inside a gap
  assert.strictEqual(offBetween(gaps, at(2, 15), at(2, 45)), 30 * MIN); // all of it inside one gap
  assert.strictEqual(offBetween(gaps, at(2, 30), at(5, 30)), 60 * MIN); // overlaps both
  assert.strictEqual(offBetween(gaps, at(4), at(4)), 0);
  assert.strictEqual(offBetween(gaps, at(5), at(4)), 0); // backwards: nothing
  assert.strictEqual(offBetween([], at(0), at(8)), 0);
  assert.strictEqual(onTime(gaps, at(0), at(8)), 6 * H);
  assert.strictEqual(onTime(gaps, at(2, 15), at(2, 45)), 0); // never negative, all of it off
  assert.strictEqual(onTime(gaps, at(5), at(4)), 0);
  assert.strictEqual(onTime([], at(1), at(4)), 3 * H);

  // ---------- tidy ----------
  const t0 = at(12);
  assert.deepStrictEqual(tidy([{ from: at(5), to: at(6) }, { from: at(2), to: at(3) }, { from: at(2, 30), to: at(4) }, { from: at(6), to: at(7) }], t0),
    [{ from: at(2), to: at(4) }, { from: at(5), to: at(7) }]); // sorted, overlapping and touching ones merged
  assert.deepStrictEqual(tidy([null, { from: 'x', to: 5 }, { from: at(3), to: at(2) }, { from: at(1), to: at(2) }], t0), [{ from: at(1), to: at(2) }]); // malformed ones dropped
  assert.deepStrictEqual(tidy({ not: 'a list' }, t0), []);
  assert.deepStrictEqual(tidy([{ from: t0 - KEEP_MS - 2 * H, to: t0 - KEEP_MS - H }, { from: t0 - KEEP_MS - H, to: t0 - KEEP_MS + H }], t0),
    [{ from: t0 - KEEP_MS - H, to: t0 - KEEP_MS + H }]); // ended over a week ago: gone; one that ends inside the week stays
  const many = Array.from({ length: KEEP_GAPS + 50 }, (_, i) => ({ from: t0 - (i + 1) * 10 * MIN, to: t0 - (i + 1) * 10 * MIN + 5 * MIN }));
  const kept = tidy(many, t0);
  assert.strictEqual(kept.length, KEEP_GAPS);
  assert.strictEqual(kept[kept.length - 1].to, t0 - 5 * MIN); // the newest kept

  // ---------- a fresh install: no gaps, the wall clock ----------
  {
    const file = fresh(), c = clock(at(9)), u = createUptime({ file, now: c.now });
    u.start();
    assert.deepStrictEqual(u.gaps(), []);
    assert.strictEqual(u.onTime(at(5), at(9)), 4 * H);
    assert.deepStrictEqual(read(file), { alive: at(9), gaps: [] });
  }

  // ---------- a corrupt file: no gaps, written again whole ----------
  {
    const file = fresh();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"alive": 17, "gaps": [');
    const c = clock(at(9)), u = createUptime({ file, now: c.now });
    u.start();
    assert.deepStrictEqual(u.gaps(), []);
    assert.deepStrictEqual(read(file), { alive: at(9), gaps: [] });
    // a file with nonsense in its fields: no gap either
    fs.writeFileSync(file, JSON.stringify({ alive: 'yesterday', gaps: 'none' }));
    const u2 = createUptime({ file, now: c.now });
    u2.start();
    assert.deepStrictEqual(u2.gaps(), []);
  }

  // ---------- a start: the time since the last heartbeat is a gap, past GAP_MIN only ----------
  {
    const file = fresh(), c = clock(at(2, 10));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const u0 = createUptime({ file, now: c.now });
    u0.start();
    u0.stop(); // a clean exit at 2:10
    c.t = at(9, 17);
    const u = createUptime({ file, now: c.now });
    u.start();
    assert.deepStrictEqual(u.gaps(), [{ from: at(2, 10), to: at(9, 17) }]);
    assert.deepStrictEqual(read(file).gaps, [{ from: at(2, 10), to: at(9, 17) }]);
    assert.strictEqual(read(file).alive, at(9, 17));
    // a quick restart (an update, exit 75): under GAP_MIN, no gap
    c.t += GAP_MIN - 10e3;
    const u2 = createUptime({ file, now: c.now });
    u2.start();
    assert.strictEqual(u2.gaps().length, 1);
    // the overnight example: finished 0:43, off 2:10 to 9:17; still on the map at 9:17, gone by 10:51
    const ended = at(0, 43);
    assert.ok(u2.onTime(ended, at(9, 17)) < K, 'on the map at 9:17');
    assert.strictEqual(u2.onTime(ended, at(9, 17)), 87 * MIN); // 0:43 to 2:10
    assert.ok(u2.onTime(ended, at(10, 49)) < K, 'still on at 10:49');
    assert.ok(u2.onTime(ended, at(10, 51)) >= K, 'gone at 10:51');
    // by the wall clock it would have gone at 3:43, while the PC was off
    assert.ok(at(9, 17) - ended >= K);
  }

  // ---------- the heartbeat, and a sleep while it ran ----------
  {
    const file = fresh(), c = clock(at(8)), u = createUptime({ file, now: c.now });
    u.tick(); // before start: nothing
    assert.ok(!fs.existsSync(file));
    u.start();
    // ticks every 1.5 s: one write a minute
    const writes = () => read(file).alive;
    c.t += 30e3; u.tick();
    assert.strictEqual(writes(), at(8));
    c.t += 30e3; u.tick();
    assert.strictEqual(writes(), at(8) + BEAT_MS);
    // asleep for an hour: the first tick after the wake records it, before any age rule asks
    const slept = c.t;
    c.t += H; u.tick();
    assert.deepStrictEqual(u.gaps(), [{ from: slept, to: slept + H }]);
    assert.deepStrictEqual(read(file).gaps, [{ from: slept, to: slept + H }]);
    assert.strictEqual(u.onTime(at(8), c.t), BEAT_MS); // the minute it ran
    // a tick just under GAP_MIN late is no gap
    c.t += GAP_MIN - 1; u.tick();
    assert.strictEqual(u.gaps().length, 1);
    // a clean stop writes the last heartbeat; the next start counts from there
    c.t += 10e3; u.stop();
    const stopped = c.t;
    assert.strictEqual(read(file).alive, stopped);
    c.t += 5 * H;
    const u2 = createUptime({ file, now: c.now });
    u2.start();
    assert.deepStrictEqual(u2.gaps(), [{ from: slept, to: slept + H }, { from: stopped, to: stopped + 5 * H }]);
    // gaps a week old are dropped at the next start
    c.t += H; u2.stop();
    c.t += KEEP_MS - 4 * H;
    const u3 = createUptime({ file, now: c.now });
    u3.start();
    assert.deepStrictEqual(u3.gaps().slice(0, 1), [{ from: stopped, to: stopped + 5 * H }]); // the sleep went, the 5 h stayed
    assert.strictEqual(u3.gaps().length, 2); // and the week since the last heartbeat
  }

  // ---------- off (--demo, --tui, --snapshot): no file, the wall clock ----------
  {
    const file = fresh(), c = clock(at(9));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ alive: at(1), gaps: [{ from: at(2), to: at(8) }] }));
    const before = fs.readFileSync(file, 'utf8');
    const u = createUptime({ file, now: c.now, on: false });
    u.start(); c.t += H; u.tick(); u.stop();
    assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
    assert.strictEqual(u.onTime(at(0), at(9)), 9 * H);
    assert.strictEqual(u.offBetween(at(0), at(9)), 0);
  }

  // ---------- a file that cannot be written: start and tick still work in memory ----------
  {
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'a file where the folder should be');
    const c = clock(at(9)), u = createUptime({ file: path.join(blocker, 'uptime.json'), now: c.now });
    u.start();
    c.t += H; u.tick();
    assert.deepStrictEqual(u.gaps(), [{ from: at(9), to: at(10) }]);
  }

  console.log('uptime: all tests passed');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
