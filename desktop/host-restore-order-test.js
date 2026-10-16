// Fleet View desktop: a test of the session host restore's order and pace (host.js restoreOrder, startPool,
// warmHandoffs), with no host, no pty and no claude: a fake clock and fake starts. Run with the system node:
//   node desktop/host-restore-order-test.js
// It checks: tier 0 (the restart asker, the shown one) first; then the most recently active few of the rest; then the
// rest by tier, the most recent first within one. startPool: at most `limit` loading at once, a slot freed when the
// start has loaded or slotMs after it began; starts at least `gap` apart and never two in one turn; ones a check adds
// meanwhile are started; ones opened or closed meanwhile leave the queue with no wait; a skipped start takes no gap or
// slot; stopped() ends it with the rest left in the queue. And what 7 sessions take at the default pace. Exit code 0
// when every case passes.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-restore-order-test-'));
process.env.FV_HANDOFF_DIR = path.join(ROOT, 'handoffs');
const H = require(path.join(__dirname, 'host.js'));
const HO = require(path.join(__dirname, '..', 'handoff.js'));

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass });
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'} ${name}${!pass && detail !== undefined ? ` :: ${JSON.stringify(detail).slice(0, 600)}` : ''}\n`);
}
const keys = (a) => a.map((x) => x.key).join(',');

// ---------- restoreOrder ----------
function orderCases() {
  // the list's order; at: last activity (bigger is more recent)
  const items = [
    { key: 'idleTasks', tier: 3, at: 900 },
    { key: 'bot', tier: 2, at: 100 },
    { key: 'shown', tier: 0, at: 10 },
    { key: 'busyOld', tier: 1, at: 50 },
    { key: 'busyNew', tier: 1, at: 800 },
    { key: 'asker', tier: 0, at: 5 },
    { key: 'pickup', tier: 2, at: 700 },
    { key: 'busyMid', tier: 1, at: 300 },
  ];
  const before = JSON.stringify(items);
  check('restoreOrder: tier 0 in the list\'s order, then the 3 most recent, then by tier and recency',
    keys(H.restoreOrder(items, 3)) === 'shown,asker,idleTasks,busyNew,pickup,busyMid,busyOld,bot', keys(H.restoreOrder(items, 3)));
  check('restoreOrder: leaves its input as it was', JSON.stringify(items) === before);
  check('restoreOrder: first 0 is the tiers alone (most recent first within one)', keys(H.restoreOrder(items, 0)) === 'shown,asker,busyNew,busyMid,busyOld,pickup,bot,idleTasks', keys(H.restoreOrder(items, 0)));
  check('restoreOrder: first past the count is recency alone after tier 0', keys(H.restoreOrder(items, 99)) === 'shown,asker,idleTasks,busyNew,pickup,busyMid,bot,busyOld', keys(H.restoreOrder(items, 99)));
  const same = [{ key: 'a', tier: 1, at: 0 }, { key: 'b', tier: 1, at: 0 }, { key: 'c', tier: 2 }, { key: 'd', tier: 1, at: 0 }];
  check('restoreOrder: equal (or missing) activity keeps the list\'s order', keys(H.restoreOrder(same, 2)) === 'a,b,d,c', keys(H.restoreOrder(same, 2)));
  check('restoreOrder: the default first is RESTORE_FIRST', H.RESTORE_FIRST >= 2 && H.RESTORE_FIRST <= 3 && keys(H.restoreOrder(items)) === keys(H.restoreOrder(items, H.RESTORE_FIRST)));
  check('restoreOrder: an empty queue', H.restoreOrder([], 3).length === 0);
}

// ---------- startPool on a fake clock ----------
// items: [{ key, tier, at, load (ms until its claude says idle; Infinity: never) }]; o: startPool's own options
function sim(items, o = {}) {
  let clock = 0, pid = 100, turns = 0;
  const starts = [], loads = new Map(), sleeps = [];
  const pending = items.map((x) => ({ ...x }));
  const opts = {
    pending, limit: 3, gap: 250, slotMs: 10000, first: 3,
    now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); turns++; clock += Math.max(ms, 1); await null; },
    held: () => true, loaded: (p) => clock >= loads.get(p), more: () => false, stopped: () => false,
    ...o,
  };
  const real = (q) => {
    const p = ++pid;
    starts.push({ key: q.key, at: clock, turn: turns, pid: p });
    loads.set(p, clock + (q.load ?? 4000));
    clock += o.openMs ?? 0; // the synchronous part of an open()
    return { r: 'ok', pid: p };
  };
  // o.hook(q, real, starts): a start of the test's own, else the usual one
  opts.start = (q) => (o.hook ? o.hook(q, real, starts) : real(q));
  const done = H.startPool(opts);
  return { done, starts, sleeps, pending, loads, opts, clock: () => clock };
}
// how many were loading at each start (the new one included)
const loadingAt = (s) => s.starts.map((x) => s.starts.filter((y) => y.at <= x.at && s.loads.get(y.pid) > x.at).length);

async function poolCases() {
  // seven, as on 2026-10-16: none loads for 5 s
  const seven = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((k, i) => ({ key: k, tier: 1, at: 100 - i, load: 5000 }));
  let s = sim(seven);
  let r = await s.done;
  check('startPool: all seven start, in restoreOrder', r.n === 7 && !r.stopped && keys(s.starts) === 'a,b,c,d,e,f,g', { r, starts: s.starts });
  const most = Math.max(...loadingAt(s));
  check('startPool: never more than 3 loading at once', most === 3, loadingAt(s));
  const gaps = s.starts.slice(1).map((x, i) => x.at - s.starts[i].at);
  check('startPool: starts at least the gap apart', gaps.every((g) => g >= 250), gaps);
  check('startPool: never two starts in one turn of the event loop', s.starts.slice(1).every((x, i) => x.turn > s.starts[i].turn), s.starts.map((x) => x.turn));
  check('startPool: the 4th waits for a slot (the 1st has loaded)', s.starts[3].at >= s.starts[0].at + 5000 && s.starts[3].at < s.starts[0].at + 5000 + 250, s.starts.map((x) => x.at));

  // a slot is freed slotMs after its start even when it never says idle
  s = sim(seven.slice(0, 4).map((x) => ({ ...x, load: Infinity })), { slotMs: 2000 });
  r = await s.done;
  check('startPool: a start that never loads frees its slot after slotMs', r.n === 4 && s.starts[3].at >= 2000 && s.starts[3].at < 2400, s.starts.map((x) => x.at));

  // one a check adds while more() is true is started; the pool waits for more() to say no more
  let more = true;
  const L = { t: 0 };
  const latePending = [{ key: 'old', tier: 1, at: 1, load: 100 }];
  const late = sim([], {
    pending: latePending, more: () => more, now: () => L.t,
    sleep: async (ms) => {
      L.t += Math.max(ms, 1);
      if (L.t >= 1000 && more) { latePending.push({ key: 'found', tier: 3, at: 5, load: 100 }); more = false; }
      await null;
    },
  });
  r = await late.done;
  check('startPool: one added while more() is true is started too, and the pool waits for it', r.n === 2 && keys(late.starts) === 'old,found' && L.t >= 1000, late.starts);

  // opened or closed meanwhile: it leaves the queue (gone), with no gap spent on it; a skipped one takes no gap or slot
  const gone = [];
  s = sim([{ key: 'x', tier: 1, at: 3 }, { key: 'opened', tier: 1, at: 2 }, { key: 'skip', tier: 1, at: 1 }, { key: 'y', tier: 2, at: 0 }], {
    held: (q) => q.key !== 'opened', gone: (q) => gone.push(q.key), hook: (q, real) => (q.key === 'skip' ? { r: 'skipped' } : real(q)),
  });
  r = await s.done;
  check('startPool: one opened meanwhile leaves the queue (gone), never started', gone.join() === 'opened' && !s.starts.some((x) => x.key === 'opened'), { gone, starts: s.starts });
  check('startPool: a skipped one takes no gap: the next starts one gap after the last tried', r.n === 2 && keys(s.starts) === 'x,y' && s.starts[1].at - s.starts[0].at < 400, s.starts);

  // stopped(): it ends at once, the rest left in the queue
  let stop = false;
  s = sim(seven, { stopped: () => stop, hook: (q, real, starts) => { const v = real(q); if (starts.length === 2) stop = true; return v; } });
  r = await s.done;
  check('startPool: stopped() ends it, the ones not started left in the queue', r.stopped && r.n === 2 && s.pending.length === 5, { r, left: s.pending.length });

  // `first` counts down only for the ones past tier 0: tier 0, then the most recent, then by tier
  s = sim([{ key: 'busy', tier: 1, at: 1 }, { key: 'recent', tier: 3, at: 9 }, { key: 'shown', tier: 0, at: 0 }, { key: 'bot', tier: 2, at: 5 }], { first: 1 });
  r = await s.done;
  check('startPool: tier 0, then `first` most recent, then by tier', keys(s.starts) === 'shown,recent,busy,bot', keys(s.starts));

  // what 7 sessions take at the defaults: each open() about 0.4 s of synchronous work, each claude 5 s to load
  s = sim(seven, { limit: H.RESTORE_CONCURRENT, gap: H.RESTORE_GAP_MS, slotMs: H.RESTORE_SLOT_MS, openMs: 400 });
  r = await s.done;
  const lastAt = s.starts[6].at;
  process.stdout.write(`  (7 sessions at the defaults, 5 s to load each: the last starts at ${(lastAt / 1000).toFixed(1)} s, all loaded by ${((lastAt + 5000) / 1000).toFixed(1)} s)\n`);
  check('startPool: at the defaults 7 sessions all start within 13 s (it was ~28 s: 14 s of checks first, then one per 2.2 s)', r.n === 7 && lastAt < 13000, lastAt);
}

// ---------- warmHandoffs ----------
async function warmCases() {
  const d = HO.dir();
  fs.mkdirSync(path.join(d, '.state'), { recursive: true });
  const id = '11111111-2222-3333-4444-555555555555';
  fs.writeFileSync(path.join(d, '2026-10-16_091700_11111111.md'), `---\nsession: ${id}\ncwd: C:\\x\ncreated: 2026-10-16T16:17:00Z\n---\n# Handoff\n`);
  fs.writeFileSync(path.join(d, 'notes.txt'), 'not a handoff');
  fs.writeFileSync(path.join(d, 'broken.md'), 'no front matter');
  fs.writeFileSync(path.join(d, '.state', `${id}.json`), JSON.stringify({ next: null }));
  const n = await H.warmHandoffs(2);
  check('warmHandoffs: reads every .md file (and resolves their count), whatever is in them', n === 2, n);
  check('warmHandoffs: HO.readAll() then reads the same files as ever', HO.readAll().bySession.has(id));
  const saved = process.env.FV_HANDOFF_DIR;
  process.env.FV_HANDOFF_DIR = path.join(ROOT, 'none');
  check('warmHandoffs: no handoff folder: 0, no error', (await H.warmHandoffs()) === 0);
  process.env.FV_HANDOFF_DIR = saved;
}

(async () => {
  try {
    orderCases();
    await poolCases();
    await warmCases();
  } catch (e) { check('the test ran to its end', false, e && e.stack ? e.stack : String(e)); }
  const failed = results.filter((x) => !x.pass).length;
  process.stdout.write(`${results.length - failed} passed, ${failed} failed\n`);
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
  process.exit(failed ? 1 : 0);
})();
