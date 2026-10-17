// Fleet View: what held the server's event loop up. The page, the phone and the API all wait on that one loop, and a
// stall of a few seconds shows as "reconnecting…" (2 to 8 s about every half hour on 2026-10-17, and server.log could
// only say how long). fleet-view.js runs its timers, its poll, discover and its request handlers through
// timed(label, fn): a run of SLOW_MS or more is kept with its label, how long it took and how much of that was this
// thread's CPU, and every label's runs are counted. The loop watchers ask explain(a, b) about a stall they measured:
// the slow runs inside it, the requests open across it, and the CPU and garbage-collection time in it. So the line
// says whether it was Fleet View's own work (a label), a wait (little CPU: a synchronous disk read or spawn, or the
// machine itself) or the garbage collector.
//
//   createStalls({ slowMs, keep, now, cpuMs, gc }) -> {
//     timed(label, fn)       fn's result (a throw passes through); the run is timed
//     request(label) -> end  a request open until end() is called (its synchronous part goes through timed too)
//     explain(a, b, cpu)     the text for a stall from a to b (now() ms), cpu: this thread's CPU ms over it
//     slowSince(at, minMs)   the slow runs that ended since `at` (Date.now() ms) and took minMs or more
//     noteStall(rec)         keeps a stall the watchers logged, { at, ms, text }, for /health
//     view()                 /health's part: { slowMs, cpu, labels: [...], runs: [...], stalls: [...] }
//     cpuMs()                this thread's CPU ms so far (the process's where Node cannot tell one thread's)
//     noteGc(start, end)     one collection's pause (the observer's; gc: false leaves them to the caller, as tests do)
//     stop()                 lets go of the garbage-collection observer
//   }
//   label(method, path)      a request's label: ids and numbers in the path folded, so one route is one label
'use strict';
const { performance, PerformanceObserver } = require('perf_hooks');

const SLOW_MS = 200; // a run this long is kept, with its label
const KEEP_RUNS = 100, KEEP_REQS = 100, KEEP_GC = 400, KEEP_STALLS = 20, MAX_LABELS = 300, OTHER = '(other)';
const LONG_OPEN_MS = 60e3; // a request open this long (a long poll) is no clue to a stall

// this thread's CPU time: process.threadCpuUsage (Node 23.9 and later), else the whole process's (its other threads,
// libuv's pool and the collector's helpers, count too)
const THREAD = typeof process.threadCpuUsage === 'function';
function defaultCpuMs() {
  try { const u = THREAD ? process.threadCpuUsage() : process.cpuUsage(); return (u.user + u.system) / 1000; } catch { return 0; }
}

// GET /api/sessions/1b2c…/wait -> GET /api/sessions/:id/wait
function label(method, p) {
  const route = String(p || '').split('?')[0]
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
    .replace(/\/(?:[0-9a-f]{12,}|\d+)(?=\/|$)/gi, '/:n')
    .slice(0, 80);
  return `${method || 'GET'} ${route || '/'}`;
}

const r0 = (ms) => Math.round(ms);
const fmt = (ms) => `${r0(ms).toLocaleString('en-US')} ms`;

function createStalls({ slowMs = SLOW_MS, keep = KEEP_RUNS, now = () => performance.now(), cpuMs = defaultCpuMs, gc = true } = {}) {
  const labels = new Map(); // label -> { runs, ms, slow, max, last, slowAt }
  const runs = []; // the last `keep` slow runs: { label, start, end, ms, cpu }
  const open = new Map(); // request -> { label, start }
  const ended = []; // the last KEEP_REQS requests that ended: { label, start, end }
  const gcs = []; // the last KEEP_GC collections: { start, end }
  const stalls = []; // the last KEEP_STALLS stalls the watchers logged
  let reqN = 0;
  let obs = null;
  // one collection's pause, from start to end (now() ms)
  function noteGc(start, end) {
    gcs.push({ start, end });
    if (gcs.length > KEEP_GC) gcs.shift();
  }
  if (gc) {
    try {
      obs = new PerformanceObserver((list) => { for (const e of list.getEntries()) noteGc(e.startTime, e.startTime + e.duration); });
      obs.observe({ entryTypes: ['gc'] });
    } catch { obs = null; }
  }

  function count(name, ms) {
    let L = labels.get(name);
    if (!L) {
      if (labels.size >= MAX_LABELS && name !== OTHER) return count(OTHER, ms);
      labels.set(name, (L = { runs: 0, ms: 0, slow: 0, max: 0, last: 0, slowAt: 0 }));
    }
    L.runs++;
    L.ms += ms;
    L.last = ms;
    if (ms > L.max) L.max = ms;
    if (ms >= slowMs) { L.slow++; L.slowAt = Date.now(); }
  }
  function timed(name, fn) {
    const t = now(), c = cpuMs();
    try { return fn(); } finally {
      const end = now(), ms = end - t;
      count(name, ms);
      if (ms >= slowMs) {
        runs.push({ label: name, start: t, end, ms, cpu: Math.max(0, cpuMs() - c), at: Date.now() });
        if (runs.length > keep) runs.shift();
      }
    }
  }
  function request(name) {
    const key = ++reqN, start = now();
    open.set(key, { label: name, start });
    return () => {
      const r = open.get(key);
      if (!r) return;
      open.delete(key);
      ended.push({ label: r.label, start: r.start, end: now() });
      if (ended.length > KEEP_REQS) ended.shift();
    };
  }
  // what was going on between a and b
  function during(a, b) {
    const inside = runs.filter((r) => r.end > a && r.start < b).sort((x, y) => y.ms - x.ms);
    const t = now();
    const reqs = [...open.values()].map((r) => ({ ...r, end: t })).concat(ended)
      .filter((r) => r.start < b && r.end > a && b - r.start < LONG_OPEN_MS).sort((x, y) => y.start - x.start);
    let gcMs = 0;
    for (const g of gcs) { const x = Math.max(a, g.start), y = Math.min(b, g.end); if (y > x) gcMs += y - x; }
    return { runs: inside, reqs, gcMs };
  }
  // "poll 6,702 ms (cpu 6,650 ms); cpu 6,700 ms of it, gc 30 ms" or, when nothing timed was running,
  // "nothing Fleet View times was running (requests open: GET /changes); cpu 120 ms of it, gc 0 ms: a wait (…)"
  function explain(a, b, cpu) {
    const d = during(a, b), ms = b - a;
    const what = d.runs.length
      ? d.runs.slice(0, 3).map((r) => `${r.label} ${fmt(r.ms)} (cpu ${fmt(r.cpu)})`).join(', ')
      : 'nothing Fleet View times was running';
    const reqs = d.reqs.length ? `; requests open: ${[...new Set(d.reqs.map((r) => r.label))].slice(0, 3).join(', ')}` : '';
    const parts = [];
    if (Number.isFinite(cpu)) parts.push(`cpu ${fmt(Math.min(cpu, ms))}${THREAD ? '' : ' (whole process)'} of it`);
    parts.push(`gc ${fmt(d.gcMs)}`);
    // little CPU and no collection: the thread sat in a call that waits (a synchronous read, stat or spawn), or the
    // machine did not run it (sleep, another process hogging the CPU or the disk)
    const waited = !d.runs.length && Number.isFinite(cpu) && cpu < ms / 4 && d.gcMs < ms / 4 ? ': it waited (a synchronous disk or process call outside these labels, or the machine)' : '';
    return `${what}${reqs}; ${parts.join(', ')}${waited}`;
  }
  // the slow runs that ended since `at` (Date.now() ms) and took minMs or more, longest first
  function slowSince(at, minMs = slowMs) {
    return runs.filter((r) => r.at >= at && r.ms >= minMs).sort((x, y) => y.ms - x.ms)
      .map((r) => ({ label: r.label, ms: r0(r.ms), cpuMs: r0(r.cpu), at: r.at }));
  }
  function noteStall(rec) {
    stalls.push({ at: rec.at, ms: r0(rec.ms), text: String(rec.text || '') });
    if (stalls.length > KEEP_STALLS) stalls.shift();
  }
  function view() {
    const list = [...labels].map(([name, L]) => ({ label: name, runs: L.runs, avgMs: L.runs ? Math.round((L.ms / L.runs) * 10) / 10 : 0, maxMs: r0(L.max), lastMs: r0(L.last), slow: L.slow, lastSlowAt: L.slowAt || null }))
      .sort((x, y) => y.slow - x.slow || y.maxMs - x.maxMs || y.runs - x.runs);
    return {
      slowMs, cpu: THREAD ? 'thread' : 'process',
      labels: list.slice(0, 60),
      runs: runs.slice(-30).reverse().map((r) => ({ label: r.label, ms: r0(r.ms), cpuMs: r0(r.cpu), at: r.at })),
      stalls: stalls.slice().reverse(),
    };
  }
  function stop() { try { if (obs) obs.disconnect(); } catch {} obs = null; }
  return { timed, request, during, explain, slowSince, noteStall, noteGc, view, cpuMs, stop };
}

module.exports = { createStalls, label, SLOW_MS };
