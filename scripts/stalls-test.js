// stalls-test.js: stalls.js, what held the server's event loop up (2 to 8 s stalls with nothing in server.log to say
// why, 2026-10-17). On a made-up clock and CPU counter: timed() keeps a slow run with its label and CPU time and counts
// every run, passes results and throws through; explain() names the slow runs inside a stall, the requests open across
// it (not a long poll), the collector's share, and says "it waited" when there was little CPU and nothing timed;
// slowSince() and view() give /health the rest; request labels fold ids. Then the real clock and the real collector.
// Run: node scripts/stalls-test.js (exit 0 = all pass)
'use strict';
const assert = require('assert');
const path = require('path');
const S = require(path.join(__dirname, '..', 'stalls.js'));

let n = 0;
const ok = (what) => { n++; console.log(`ok ${n} - ${what}`); };

// ---------- labels ----------
assert.strictEqual(S.label('GET', '/api/sessions/1b2c3d4e-0000-4000-8000-00000000abcd/wait?x=1'), 'GET /api/sessions/:id/wait');
assert.strictEqual(S.label('GET', '/bots/0123456789ab/tasks'), 'GET /bots/:n/tasks');
assert.strictEqual(S.label('POST', '/teams/12/add'), 'POST /teams/:n/add');
assert.strictEqual(S.label('GET', '/state'), 'GET /state');
assert.strictEqual(S.label(undefined, ''), 'GET /');
assert.ok(S.label('GET', '/' + 'x'.repeat(300)).length <= 84);
ok('label: ids and numbers folded, the query left out, kept short');

// ---------- a made-up clock ----------
let t = 1000, cpu = 0;
const st = S.createStalls({ now: () => t, cpuMs: () => cpu, gc: false });
// a run that takes `ms` of which `c` is CPU
const run = (label, ms, c = ms, fn = () => label) => st.timed(label, () => { t += ms; cpu += c; return fn(); });

assert.strictEqual(run('poll:read', 50), 'poll:read');
assert.strictEqual(run('poll:read', 260, 250), 'poll:read');
assert.throws(() => run('discover:rules', 300, 10, () => { throw new Error('boom'); }), /boom/);
let v = st.view();
const poll = v.labels.find((x) => x.label === 'poll:read'), disc = v.labels.find((x) => x.label === 'discover:rules');
assert.deepStrictEqual([poll.runs, poll.slow, poll.maxMs, poll.lastMs, poll.avgMs], [2, 1, 260, 260, 155]);
assert.deepStrictEqual([disc.runs, disc.slow], [1, 1]);
assert.deepStrictEqual(v.runs.map((r) => [r.label, r.ms, r.cpuMs]), [['discover:rules', 300, 10], ['poll:read', 260, 250]]);
assert.strictEqual(v.labels[0].slow >= v.labels[v.labels.length - 1].slow, true);
ok('timed: every run counted; a run of 200 ms or more kept with its CPU time, newest first; results and throws pass through');

// ---------- explain ----------
// a stall from a to b with a 6.7 s poll inside it, nearly all CPU
t = 10e3; cpu = 0;
const a1 = t;
run('poll:read', 6702, 6650);
const b1 = t + 20;
let text = st.explain(a1, b1, 6700);
assert.match(text, /^poll:read 6,702 ms \(cpu 6,650 ms\); cpu 6,7\d\d ms(?: \(whole process\))? of it, gc 0 ms$/);
ok(`explain: names the slow run inside the stall and its CPU (${text})`);

// nothing timed, little CPU, a request open across it: it waited
t = 30e3;
const endChanges = st.request('GET /changes');
t += 400;
const a2 = t;
t += 4000;
const b2 = t;
text = st.explain(a2, b2, 120);
assert.match(text, /^nothing Fleet View times was running; requests open: GET \/changes; cpu 120 ms.* of it, gc 0 ms: it waited/);
endChanges();
ok(`explain: nothing timed and little CPU says it waited, with the requests open (${text})`);

// a request that ended before the stall is no clue; one that ended inside it is; a long poll is none either
t = 50e3;
const endOld = st.request('GET /old');
t += 10;
endOld();
const endWait = st.request('POST /api/sessions/:id/wait');
t += 61e3;
const endIn = st.request('GET /state');
const a3 = t;
t += 100;
endIn();
t += 2900;
text = st.explain(a3, t, 2900);
assert.ok(text.includes('requests open: GET /state') && !text.includes('/old') && !text.includes('/wait'), text);
assert.ok(!text.includes('it waited'), 'a busy CPU is no wait: ' + text);
endWait();
ok('explain: only the requests open across the stall, not a long poll, and busy CPU is not a wait');

// the collector's share: two pauses, one half inside the stall
st.noteGc(t + 100, t + 600);
st.noteGc(t + 2800, t + 3400);
text = st.explain(t, t + 3000, 900);
assert.match(text, /gc 700 ms/);
ok(`explain: the collection time inside the stall (${text})`);

// ---------- slowSince, noteStall ----------
const since = st.slowSince(0, 1000);
assert.deepStrictEqual(since.map((r) => r.label), ['poll:read']);
assert.ok(st.slowSince(Date.now() + 60e3).length === 0);
st.noteStall({ at: 123, ms: 6773.4, text: 'x' });
v = st.view();
assert.deepStrictEqual(v.stalls, [{ at: 123, ms: 6773, text: 'x' }]);
assert.ok(v.slowMs === S.SLOW_MS && (v.cpu === 'thread' || v.cpu === 'process'));
ok('slowSince: the runs over a size since a time, longest first; noteStall and view for /health');

// ---------- many labels: the rest fold into one ----------
const many = S.createStalls({ now: () => t, cpuMs: () => 0, gc: false });
for (let i = 0; i < 400; i++) many.timed(`GET /r${i}`, () => {});
const lv = many.view();
assert.ok(lv.labels.length <= 60);
assert.ok(lv.labels.some((x) => x.label === '(other)' && x.runs === 100));
ok('labels: past 300, the rest count as (other); /health shows 60 at most');

// ---------- the real clock, CPU and collector ----------
(async () => {
  const real = S.createStalls();
  const c0 = real.cpuMs();
  // busy for 250 ms and until 250 ms of CPU went by (5 s at most, on a machine too busy to give it that)
  real.timed('busy', () => { const t0 = Date.now(); while ((real.cpuMs() - c0 < 250 || Date.now() < t0 + 250) && Date.now() < t0 + 5000); });
  const r = real.view().runs[0];
  // (the whole process's CPU, where Node cannot tell one thread's, can run ahead of the wall clock)
  assert.ok(r && r.label === 'busy' && r.ms >= 200 && r.cpuMs >= 200, JSON.stringify(r));
  // garbage: the observer sees the collector's pauses (delivered after the fact)
  let junk = [];
  for (let i = 0; i < 2e5; i++) junk.push({ i, s: 'x'.repeat(20) });
  junk = null;
  if (global.gc) global.gc();
  await new Promise((res) => setTimeout(res, 50));
  real.stop();
  ok(`the real clock and CPU (a 250 ms busy run: ${r.ms} ms, cpu ${r.cpuMs} ms)`);
  console.log(`stalls-test: ${n} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
