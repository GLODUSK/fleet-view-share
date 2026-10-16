// Fleet View: when it was not running (Henry, 2026-10-16: the PC was off 2:10 to 9:17 and at start the 3-hour rule
// took 24 of the 30 conversations off the map by the wall clock). The age rules count only the time Fleet View ran, so
// a conversation that finished at 0:43 is still there at 9:17 and leaves at about 10:50.
// <data>/uptime.json holds { alive, gaps: [{ from, to }] }: alive is the last heartbeat (written every BEAT_MS while it
// runs, and at a clean exit), a gap a stretch it was off. A start whose file's alive is over GAP_MIN old adds the gap
// alive..now; a tick finding the one before it over GAP_MIN ago (the PC slept or hibernated while it ran) adds that
// stretch. Gaps are kept KEEP_MS after they end, at most KEEP_GAPS, sorted and never overlapping.
// No file (a fresh install), or one that cannot be read: no gaps, the wall clock as before. off (--demo, --tui,
// --snapshot): no file read or written, onTime is the wall clock.
//
//   offBetween(gaps, since, now) -> ms of the gaps inside [since, now]
//   onTime(gaps, since, now) -> now - since less offBetween, never negative
//   tidy(gaps, now) -> the gaps sorted, merged, pruned
//   createUptime({ file, now, on }) -> { start(), tick(t), stop(), onTime(since, t), offBetween(since, t), gaps() }
'use strict';
const fs = require('fs');
const path = require('path');

const BEAT_MS = 60e3, GAP_MIN = 120e3, KEEP_MS = 7 * 24 * 3600e3, KEEP_GAPS = 200;
const ok = (v) => Number.isFinite(v) && v > 0;

// sorted by start, overlapping or touching ones merged, the ones that ended over KEEP_MS ago and past KEEP_GAPS (the
// oldest) dropped. Anything malformed is left out
function tidy(gaps, now) {
  const list = (Array.isArray(gaps) ? gaps : []).filter((g) => g && ok(g.from) && ok(g.to) && g.to > g.from && now - g.to <= KEEP_MS)
    .map((g) => ({ from: Math.round(g.from), to: Math.round(g.to) })).sort((a, b) => a.from - b.from);
  const out = [];
  for (const g of list) {
    const last = out[out.length - 1];
    if (last && g.from <= last.to) last.to = Math.max(last.to, g.to);
    else out.push(g);
  }
  return out.slice(-KEEP_GAPS);
}
// the off time inside [since, now]; gaps sorted and apart (tidy). One that started before every gap has all of them
// (no loop: discover asks this of every old log)
function offBetween(gaps, since, now, total) {
  if (!gaps || !gaps.length || !(now > since)) return 0;
  if (since <= gaps[0].from && gaps[gaps.length - 1].to <= now && total !== undefined) return total;
  let off = 0;
  for (let i = gaps.length - 1; i >= 0; i--) {
    const g = gaps[i];
    if (g.to <= since) break;
    const a = Math.max(g.from, since), b = Math.min(g.to, now);
    if (b > a) off += b - a;
  }
  return off;
}
const onTime = (gaps, since, now, total) => Math.max(0, now - since - offBetween(gaps, since, now, total));

function createUptime({ file, now = Date.now, on = true }) {
  let gaps = [], total = 0, lastTick = 0, lastWrite = 0;
  const sum = () => { total = gaps.reduce((n, g) => n + g.to - g.from, 0); };
  // through a tmp file and a rename, so a crash mid-write leaves the last one
  function write(t) {
    lastWrite = t;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify({ alive: t, gaps }));
      fs.renameSync(file + '.tmp', file);
      return true;
    } catch { return false; }
  }
  const addGap = (from, to) => { gaps = tidy(gaps.concat([{ from, to }]), to); sum(); };
  // at start, before the first read of the logs: the time since the file's last heartbeat was off
  function start() {
    if (!on) return;
    const t = now();
    let j = null;
    try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    gaps = tidy(j && j.gaps, t);
    sum();
    const alive = j && ok(j.alive) ? j.alive : 0;
    if (alive && alive < t && t - alive > GAP_MIN) addGap(alive, t);
    lastTick = t;
    write(t);
  }
  // every poll and discover: cheap unless BEAT_MS passed (one small write) or the last tick is over GAP_MIN back (the
  // process was suspended: that stretch is a gap). Before the age rules run, so a wake never judges by the wall clock
  function tick(t = now()) {
    if (!on || !lastTick) return;
    if (t - lastTick > GAP_MIN) { addGap(lastTick, t); lastTick = t; write(t); return; }
    if (t > lastTick) lastTick = t;
    if (t - lastWrite >= BEAT_MS || t < lastWrite) write(t);
  }
  // a clean exit: the gap that follows starts now, not up to a heartbeat back
  function stop() { if (on && lastTick) write(Math.max(lastTick, now())); }
  return {
    start, tick, stop,
    onTime: (since, t = now()) => (on ? onTime(gaps, since, t, total) : Math.max(0, t - since)),
    offBetween: (since, t = now()) => (on ? offBetween(gaps, since, t, total) : 0),
    gaps: () => gaps.map((g) => ({ ...g })),
    FILE: file,
  };
}

module.exports = { createUptime, onTime, offBetween, tidy, BEAT_MS, GAP_MIN, KEEP_MS, KEEP_GAPS };
