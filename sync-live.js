// sync-live.js: what runs where, right now, across devices. Each device reads a conversation's state from its own copy
// of the log, and a conversation running on another device is laid down here late; on its own this machine would show
// one that ended there as still working, under an older name and this machine's account letter. So every device
// publishes a snapshot of the conversations IT owns, and shows the ones another device owns from that device's
// snapshot (fleet-view.js, through sync-run.js live() and remoteFor below).
//
//   createLive({ api, key, log, now, device, online, snapshot, timing })
//     -> { start(), stop(), tick(), live(), status() }
//
//   api       sync-api.js createSync()'s object (rest() only)
//   key       the 32-byte sync key: the rows are sealed with it
//   device()  this device's id (sync-move.js's device().id; nothing is written or read until it is known)
//   online(d) -> whether device d is there: true, false, or null while that is not known (sync-move.js online(): its
//             last_seen_at heartbeat). A snapshot counts only while its device is there; while it is not known, the
//             conversations of that device keep this machine's own reading. Not given: every snapshot read counts
//   snapshot() -> [{ id, state, label, stateColor, name, renamed, account, last, active, turnStart, waitingOn,
//             agents }]: the conversations this device owns, as its /state shows them
//   now()     the clock (Date.now); timing: { ...TIMING } overrides (tests)
//
// The row: fleet_sync.settings key live:<device id>, one per device and written by that device only, sealed with
// sync-crypto.js sealText(json, key, 'setting:live:<device id>'), upserted on (user_id, key) with updated_at = its at
// (no migration: the settings table takes any key):
//   { v: 1, device, at, sessions: [ ...snapshot(), cleaned, picked, by id ] }
// picked: every one not DONE, and the DONE ones whose last is in the last day (for their names and account letters;
// one not listed shows DONE anyway), at most MAX_SESSIONS, the running ones first. A write goes out only when that
// list, or any field of it but last and active (those move all the time), changed, at most every 5 s; at (and so
// updated_at) differs on every write and is never compared with another machine's clock. The row is never deleted.
// Every device lists the live:* rows' keys and updated_at every 5 s, and fetches a row's sealed value only when its
// updated_at moved: the rows stay small on the wire while nothing changes. This device's own row is skipped, and a
// row that does not open with the key is ignored (said once in the log) until it changes.
//
//   live() -> { ready, known: Set<device>, unsure: Set<device>, fresh: Set<device>, sessions: Map id -> { ...entry,
//             device }, byDevice: Map device -> Map id -> entry }: known, the devices with a snapshot that opened;
//             unsure, those of them not known to be there or not yet; fresh, those there; sessions and byDevice, the
//             fresh ones' (ready: the rows were read once)
//   remoteFor(view, device, id) -> what a conversation that device owns shows here:
//     { device, entry, live }: entry from its fresh snapshot (live: its state is not DONE or IDLE), or entry null when
//     the owner's snapshot is fresh and does not list it, or the owner is offline: it runs nowhere we can see, so it is
//     DONE; null before the rows were read once, when the owner never published one (an older Fleet View there), or
//     while it is not known whether the owner is there: this machine's own reading stands
'use strict';
const path = require('path');
const K = require(path.join(__dirname, 'sync-crypto.js'));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY_RE = /^live:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const TIMING = {
  tickMs: 5e3, // the loop's round
  minGapMs: 5e3, // at most one write this often
  readMs: 5e3, // the other devices' rows are listed this often
  doneMs: 24 * 3600e3, // a DONE conversation is listed while its last is this recent
};
const MAX_SESSIONS = 300; // a snapshot carries at most this many
const RESTING = new Set(['DONE', 'IDLE']); // states that are not running

const lower = (s) => (typeof s === 'string' ? s.toLowerCase() : '');
const short = (id) => String(id).slice(0, 8);
const text = (s, n) => (typeof s === 'string' && s ? (s.length > n ? s.slice(0, n) : s) : null);
const msOf = (v) => (Number.isFinite(v) && v > 0 ? Math.round(v) : null);
const errText = (e) => String((e && e.message) || e || '').replace(/\s+/g, ' ').slice(0, 200);
// ms have gone by since last on this clock, or the clock went back past it (never wait out a jump back)
const waited = (t, last, ms) => t - last >= ms || t < last;
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// one conversation of a snapshot, as written and as read: null when it is not one
function cleanEntry(x) {
  if (!x || typeof x !== 'object') return null;
  const id = lower(x.id);
  if (!UUID_RE.test(id) || typeof x.state !== 'string' || !/^[A-Z]{2,16}$/.test(x.state)) return null;
  return {
    id, state: x.state,
    label: text(x.label, 40),
    stateColor: typeof x.stateColor === 'string' && /^#[0-9a-f]{6}$/i.test(x.stateColor) ? x.stateColor : null,
    name: text(x.name, 200),
    renamed: x.renamed === true,
    account: typeof x.account === 'string' && /^[A-Z]$/.test(x.account) ? x.account : null,
    last: msOf(x.last), active: msOf(x.active), turnStart: msOf(x.turnStart),
    waitingOn: text(x.waitingOn, 300),
    agents: Number.isInteger(x.agents) && x.agents > 0 ? Math.min(x.agents, 999) : 0,
  };
}
// a snapshot's list: clean, one per id, in id order (so a list that only moved around writes nothing)
function cleanList(list) {
  const seen = new Map();
  for (const x of Array.isArray(list) ? list.slice(0, 5000) : []) {
    const e = cleanEntry(x);
    if (e && !seen.has(e.id)) seen.set(e.id, e);
  }
  return [...seen.values()].sort(byId);
}
// what this device publishes of its clean list at t: not DONE, or DONE within doneMs; the running ones first, then
// the newest, at most MAX_SESSIONS; in id order
function pickList(list, t, doneMs = TIMING.doneMs) {
  const keep = list.filter((e) => e.state !== 'DONE' || (e.last && t - e.last < doneMs));
  keep.sort((a, b) => (RESTING.has(a.state) - RESTING.has(b.state)) || ((b.last || 0) - (a.last || 0)));
  return keep.slice(0, MAX_SESSIONS).sort(byId);
}
// what decides a write: everything but last and active
const sigOf = (list) => JSON.stringify(list.map((e) => [e.id, e.state, e.label, e.stateColor, e.name, e.renamed, e.account, e.turnStart, e.waitingOn, e.agents]));

function remoteFor(view, device, id) {
  if (!view || !view.ready) return null;
  const d = lower(device);
  if (!d) return null;
  if (view.known instanceof Set && !view.known.has(d)) return null; // it never published one: its copy here stands
  if (view.unsure instanceof Set && view.unsure.has(d)) return null; // not known whether it is there: the same
  const list = view.byDevice instanceof Map ? view.byDevice.get(d) : null;
  const entry = (list && list.get(lower(id))) || null;
  return { device: d, entry, live: !!entry && !RESTING.has(entry.state) };
}

function createLive(o = {}) {
  const api = o.api;
  if (!api || typeof api.rest !== 'function') throw new Error('createLive needs the sync api');
  const key = o.key;
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('createLive needs the 32-byte sync key');
  const log = typeof o.log === 'function' ? o.log : () => {};
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const tm = { ...TIMING, ...(o.timing || {}) };
  const deviceOf = typeof o.device === 'function' ? o.device : () => o.device;
  const online = typeof o.online === 'function' ? o.online : null;
  const snapshot = typeof o.snapshot === 'function' ? o.snapshot : () => [];
  const said = new Map();
  const logOnce = (k, t) => { if (said.get(k) === t) return; said.set(k, t); log(t); };

  let me = null;
  let lastSig = null, lastTry = -Infinity, at = 0, writes = 0, fetched = 0;
  let lastRead = -Infinity, ready = false;
  // device -> { stamp (its updated_at), changedAt (this clock), sessions: Map id -> entry, or null when it did not open }
  const seen = new Map();

  async function publish(t) {
    let list;
    try { list = pickList(cleanList(snapshot()), t, tm.doneMs); } catch (e) { logOnce('snapshot', `live: this device's conversations could not be listed (${errText(e)})`); return; }
    const sig = sigOf(list);
    if (sig === lastSig || !waited(t, lastTry, tm.minGapMs)) return;
    lastTry = t;
    at = Math.max(t, at + 1); // differs from the last one even when the clock did not move
    const k = `live:${me}`;
    try {
      await api.rest('POST', 'settings', {
        query: { on_conflict: 'user_id,key' }, prefer: 'resolution=merge-duplicates,return=minimal',
        body: { key: k, value_enc: K.sealText(JSON.stringify({ v: 1, device: me, at, sessions: list }), key, `setting:${k}`), updated_at: new Date(at).toISOString() },
      });
      lastSig = sig; writes++;
      said.delete('write');
    } catch (e) { logOnce('write', `live: this device's snapshot could not be written (${errText(e)})`); }
  }
  // one row's sealed value -> its sessions Map, or null (said once) when it does not open as this device's snapshot
  function openRow(row, d) {
    let v = null;
    try { v = JSON.parse(K.openText(row.value_enc, key, `setting:${row.key}`)); } catch {}
    if (!v || v.v !== 1 || lower(v.device) !== d || !Number.isFinite(v.at) || !Array.isArray(v.sessions)) {
      logOnce(`bad|${row.key}`, `live: the snapshot of ${short(d)} does not open with this key; ignored`);
      return null;
    }
    return new Map(cleanList(v.sessions.slice(0, MAX_SESSIONS)).map((e) => [e.id, { ...e, device: d }]));
  }
  async function read(t) {
    if (!waited(t, lastRead, tm.readMs)) return;
    lastRead = t;
    let rows;
    try { rows = await api.rest('GET', 'settings', { query: { select: 'key,updated_at', key: 'like.live:*' } }); said.delete('read'); } catch (e) { logOnce('read', `live: the other devices' snapshots could not be read (${errText(e)})`); return; }
    const here = new Map(); // device -> its updated_at, for the rows that moved
    const listed = new Set();
    for (const row of Array.isArray(rows) ? rows : []) {
      const m = row && typeof row.key === 'string' ? KEY_RE.exec(row.key) : null;
      if (!m || m[1] === me) continue;
      listed.add(m[1]);
      const stamp = String(row.updated_at || '');
      const prev = seen.get(m[1]);
      if (!prev || prev.stamp !== stamp) here.set(m[1], stamp);
    }
    for (const d of [...seen.keys()]) if (!listed.has(d)) seen.delete(d);
    if (here.size) {
      let full;
      try {
        full = await api.rest('GET', 'settings', { query: { select: 'key,value_enc,updated_at', key: `in.(${[...here.keys()].map((d) => `"live:${d}"`).join(',')})` } });
        said.delete('fetch');
      } catch (e) { logOnce('fetch', `live: the other devices' snapshots could not be read (${errText(e)})`); return; }
      const t2 = now();
      for (const row of Array.isArray(full) ? full : []) {
        const m = row && typeof row.key === 'string' ? KEY_RE.exec(row.key) : null;
        if (!m || !here.has(m[1])) continue;
        fetched++;
        seen.set(m[1], { stamp: String(row.updated_at || ''), changedAt: t2, sessions: openRow(row, m[1]) });
      }
    }
    ready = true;
  }
  async function tickOnce() {
    if (!me) {
      let d = null;
      try { d = deviceOf(); } catch {}
      d = lower(d && typeof d === 'object' ? d.id : d);
      if (!UUID_RE.test(d)) return; // the mover has not asked for its device row yet
      me = d;
    }
    await publish(now());
    await read(now());
  }

  // ---------- the loop ----------
  let running = false, timer = null, ticking = null;
  function tick() {
    if (ticking) return ticking;
    ticking = tickOnce().catch((e) => logOnce('tick', `live: a round failed (${errText(e)})`)).finally(() => { ticking = null; });
    return ticking;
  }
  function schedule(ms) {
    if (!running) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(loop, ms);
    if (timer.unref) timer.unref();
  }
  async function loop() {
    timer = null;
    if (!running) return;
    await tick();
    schedule(tm.tickMs);
  }
  function start() { if (running) return; running = true; schedule(0); }
  async function stop() {
    running = false;
    if (timer) { clearTimeout(timer); timer = null; }
    try { if (ticking) await ticking; } catch {}
  }

  // true, false, or null (not known)
  const isOnline = (d) => { if (!online) return true; try { const v = online(d); return v === true ? true : v === false ? false : null; } catch { return null; } };
  function live() {
    const known = new Set(), unsure = new Set(), fresh = new Set(), sessions = new Map(), byDevice = new Map(), when = new Map();
    for (const [d, r] of seen) {
      if (!r.sessions) continue;
      known.add(d);
      const on = isOnline(d);
      if (on === null) unsure.add(d);
      if (on !== true) continue;
      fresh.add(d);
      byDevice.set(d, r.sessions);
      // two fresh snapshots with one id (a move under way): the one seen changing last
      for (const [id, e] of r.sessions) if (!sessions.has(id) || when.get(id) < r.changedAt) { sessions.set(id, e); when.set(id, r.changedAt); }
    }
    return { ready, known, unsure, fresh, sessions, byDevice };
  }
  const status = () => { const v = live(); return { device: me, writes, fetched, ready, devices: v.known.size, fresh: v.fresh.size }; };

  return { start, stop, tick, live, status };
}

module.exports = { createLive, remoteFor, cleanEntry, cleanList, pickList, TIMING, MAX_SESSIONS };
