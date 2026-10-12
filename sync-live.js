// sync-live.js: what runs where, right now, across devices. Each device reads a conversation's state from its own copy
// of the log, and a conversation running on another device is laid down here late; on its own this machine would show
// one that ended there as still working, under an older name and this machine's account letter. So every device
// publishes a snapshot of the conversations IT owns, and shows the ones another device owns from that device's
// snapshot (fleet-view.js, through sync-run.js live() and remoteFor below).
//
//   createLive({ api, key, log, now, device, online, seenAt, snapshot, timing })
//     -> { start(), stop(), tick(), live(), status() }
//   status().health (sync-api.js createScanHealth): when a round last ran with no error, the last error and its time,
//   the failure streak, and whether it is backing off: a round whose request hit a network error, a timeout, a 429 or
//   a 5xx makes the next one wait (5 s doubling to 60 s, or Supabase's Retry-After), and a clean round resets it
//
//   api       sync-api.js createSync()'s object (rest() only)
//   key       the 32-byte sync key: the rows are sealed with it
//   device()  this device's id (sync-move.js's device().id; nothing is written or read until it is known)
//   online(d) -> whether device d is there: true, false, or null while that is not known (sync-move.js online(): its
//             last_seen_at heartbeat). A snapshot counts only while its device is there; while it is not known, the
//             conversations of that device keep this machine's own reading. Not given: every snapshot read counts
//   seenAt(d) -> device d's last_seen_at (ms, its own clock) or null (sync-move.js lastSeen()): a sign of life for
//             bound's 7-day rule (live()), as its rows' at are (they change only when what they hold does)
//   snapshot() -> [{ id, state, label, stateColor, name, renamed, account, last, active, turnStart, waitingOn,
//             agents, repo }]: the conversations this device owns, as its /state shows them. repo: { origin, name }, the
//             repo it shows it under, portable (sync-prefs.js makeTranslate out()), or null; the other devices show it
//             under their own checkout of that repo (its tool calls name this machine's paths, which they lack). pin:
//             { rule, host } | null, the stays-on rule that keeps it on a device by this device's reading (fleet-view.js
//             pinOf), which the other devices take over their own for the chats this one runs
//   bound()   -> [ids]: every conversation this device owns whose workspace is only here (sync-common.js "portable or
//             bound"), old ones too. Only this device can tell for some: a git checkout with no origin under home syncs
//             under the home row, as a portable folder does. Not given: none
//   now()     the clock (Date.now); timing: { ...TIMING } overrides (tests)
//
// The rows: fleet_sync.settings keys live:<device id> and bound:<device id>, one of each per device and written by that
// device only, sealed with sync-crypto.js sealText(json, key, 'setting:<key>'), upserted on (user_id, key) with
// updated_at = its at (no migration: the settings table takes any key):
//   live:<device>   { v: 1, device, at, sessions: [ ...snapshot(), cleaned, picked, by id ], bound: [ the same ids ] }
//   bound:<device>  { v: 1, device, at, bound: [ ...bound() ids, sorted ] }
// picked: every one not DONE, and the DONE ones whose last is in the last day (for their names and account letters;
// one not listed shows DONE anyway), at most MAX_SESSIONS, the running ones first. bound: at most MAX_BOUND, whatever
// their state. Each row is written only when what it holds changed (the live row: that list, any field of it but last
// and active, which move all the time, or bound; the bound row: the list), each at most every 5 s; at (and so
// updated_at) differs on every write and is compared with another machine's clock only for the 7-day staleness of
// bound (live() below). The rows are never deleted.
// An older Fleet View reads bound only from the live row (and writes no bound row), so the live row carries it too, for
// a release or two; then it goes from there (and from the live row's sig). A device's bound list is its bound row's
// when it has one that opens, else its live row's bound (none: nothing bound).
// Every device lists the live:* and bound:* rows' keys and updated_at every 5 s (one request), and fetches a row's
// sealed value only when its updated_at moved: the rows stay small on the wire while nothing changes. This device's
// own rows are skipped, and a row that does not open with the key is ignored (said once in the log) until it changes.
//
//   live() -> { ready, known: Set<device>, unsure: Set<device>, fresh: Set<device>, sessions: Map id -> { ...entry,
//             device }, byDevice: Map device -> Map id -> entry }: known, the devices with a snapshot that opened;
//             unsure, those of them not known to be there or not yet; fresh, those there; sessions and byDevice, the
//             fresh ones' (ready: the rows were read once); bound: Map device -> Set of ids, from every known device's
//             last bound row (or its live row's bound, an older device), online or not (what is bound does not change
//             while a device sleeps), except a device known to be offline (online() false; not one not known yet)
//             whose newest sign of life (its rows' own at, its last_seen_at) is more than TIMING.boundStaleMs (7 days)
//             behind this clock: one away that long is left out of bound (the bound row and the live row's copy
//             alike), so its old list no longer holds conversations back here. The one place another machine's clock
//             is compared with this one's: 7 days is far past any clock skew
//   remoteFor(view, device, id) -> what a conversation that device owns shows here:
//     { device, entry, live }: entry from its fresh snapshot (live: its state is not DONE or IDLE), or entry null when
//     the owner's snapshot is fresh and does not list it, or the owner is offline: it runs nowhere we can see, so it is
//     DONE; null before the rows were read once, when the owner never published one (an older Fleet View there), or
//     while it is not known whether the owner is there: this machine's own reading stands
'use strict';
const path = require('path');
const K = require(path.join(__dirname, 'sync-crypto.js'));
const S = require(path.join(__dirname, 'sync-api.js'));
const { cleanRoot } = require(path.join(__dirname, 'sync-prefs.js'));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY_RE = /^(live|bound):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const TIMING = {
  tickMs: 5e3, // the loop's round
  minGapMs: 5e3, // at most one write this often
  readMs: 5e3, // the other devices' rows are listed this often
  doneMs: 24 * 3600e3, // a DONE conversation is listed while its last is this recent
  boundStaleMs: 7 * 24 * 3600e3, // BOUND_STALE: a device away this long (see live()) has its bound list ignored
};
const MAX_SESSIONS = 300; // a snapshot carries at most this many
const MAX_BOUND = 5000; // and at most this many bound ids (37 bytes each in the row)
const RESTING = new Set(['DONE', 'IDLE']); // states that are not running

const lower = (s) => (typeof s === 'string' ? s.toLowerCase() : '');
const short = (id) => String(id).slice(0, 8);
const text = (s, n) => (typeof s === 'string' && s ? (s.length > n ? s.slice(0, n) : s) : null);
const msOf = (v) => (Number.isFinite(v) && v > 0 ? Math.round(v) : null);
const errText = (e) => String((e && e.message) || e || '').replace(/\s+/g, ' ').slice(0, 200);
// ms have gone by since last on this clock, or the clock went back past it (never wait out a jump back)
const waited = (t, last, ms) => t - last >= ms || t < last;
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
// the repo the owner shows it under, portable as sync-prefs.js has roots: { origin, name } | null (an older row has none)
function cleanRepo(r) {
  const c = cleanRoot(r);
  if (c && c.name && c.name.length > 200) c.name = null;
  return c && (c.origin || c.name) ? c : null;
}

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
    repo: cleanRepo(x.repo),
    // the owner's stays-on verdict (fleet-view.js pinOf): { rule, host } or null; left out by an older owner (no
    // verdict: the other devices judge by their own rules)
    ...('pin' in x ? { pin: cleanPin(x.pin) } : {}),
  };
}
// a stays-on pin: { rule: a rule's id, host: a device's name } | null
function cleanPin(p) {
  if (!p || typeof p !== 'object' || typeof p.rule !== 'string' || !/^[a-z0-9-]{1,40}$/.test(p.rule)) return null;
  const host = typeof p.host === 'string' ? p.host.trim().slice(0, 100) : '';
  return host ? { rule: p.rule, host } : null;
}
// a row's bound list: conversation ids, lower case, one each, sorted, at most MAX_BOUND
function cleanIds(list) {
  const out = new Set();
  for (const x of Array.isArray(list) ? list.slice(0, MAX_BOUND * 2) : []) { const id = lower(x); if (UUID_RE.test(id)) out.add(id); }
  return [...out].sort().slice(0, MAX_BOUND);
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
const sigOf = (list) => JSON.stringify(list.map((e) => [e.id, e.state, e.label, e.stateColor, e.name, e.renamed, e.account, e.turnStart, e.waitingOn, e.agents,
  e.repo ? [e.repo.origin, e.repo.name] : null, e.pin ? [e.pin.rule, e.pin.host] : e.pin === null ? null : 0]));

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
  const seenAt = typeof o.seenAt === 'function' ? o.seenAt : () => null;
  const snapshot = typeof o.snapshot === 'function' ? o.snapshot : () => [];
  const boundOf = typeof o.bound === 'function' ? o.bound : () => [];
  const said = new Map();
  const logOnce = (k, t) => { if (said.get(k) === t) return; said.set(k, t); log(t); };
  const health = S.createScanHealth({ now });
  let roundErr = null; // the first request of this round that failed (a round with one is not clean)
  let roundDirty = false; // this round could not list this device's conversations (not a request: no back-off)
  const failedReq = (e) => { if (!roundErr) roundErr = e || new Error('failed'); };

  let me = null;
  let lastSig = null, lastTry = -Infinity, at = 0, writes = 0, fetched = 0;
  let boundSig = null, boundTry = -Infinity, boundAt = 0, boundWrites = 0;
  let lastRead = -Infinity, ready = false, orOk = true;
  // device -> { stamp (its updated_at), changedAt (this clock), sessions: Map id -> entry, or null when it did not open,
  // bound: Set of ids from the live row (what an older device has; empty for a row that did not open) }
  const seen = new Map();
  // device -> { stamp, ids: Set of ids, or null when its bound row did not open }
  const boundSeen = new Map();

  // one row, sealed under its key, its updated_at its at
  const putRow = (k, value, when) => api.rest('POST', 'settings', {
    query: { on_conflict: 'user_id,key' }, prefer: 'resolution=merge-duplicates,return=minimal',
    body: { key: k, value_enc: K.sealText(JSON.stringify(value), key, `setting:${k}`), updated_at: new Date(when).toISOString() },
  });
  async function publish(t) {
    let list, bound;
    try { list = pickList(cleanList(snapshot()), t, tm.doneMs); bound = cleanIds(boundOf()); } catch (e) { logOnce('snapshot', `live: this device's conversations could not be listed (${errText(e)})`); health.rowError(e); roundDirty = true; return; }
    // bound in the live row too: an older Fleet View reads it only there (it goes in a later release)
    const sig = `${sigOf(list)}|${bound.join(',')}`;
    if (sig !== lastSig && waited(t, lastTry, tm.minGapMs)) {
      lastTry = t;
      at = Math.max(t, at + 1); // differs from the last one even when the clock did not move
      try {
        await putRow(`live:${me}`, { v: 1, device: me, at, sessions: list, bound }, at);
        lastSig = sig; writes++;
        said.delete('write');
      } catch (e) { logOnce('write', `live: this device's snapshot could not be written (${errText(e)})`); failedReq(e); }
    }
    const bsig = bound.join(',');
    if (bsig !== boundSig && waited(t, boundTry, tm.minGapMs)) {
      boundTry = t;
      boundAt = Math.max(t, boundAt + 1);
      try {
        await putRow(`bound:${me}`, { v: 1, device: me, at: boundAt, bound }, boundAt);
        boundSig = bsig; boundWrites++;
        said.delete('bound');
      } catch (e) { logOnce('bound', `live: this device's bound conversations could not be written (${errText(e)})`); failedReq(e); }
    }
  }
  // one live row's sealed value -> { sessions: Map, bound: Set (used for an older device, which has no bound row) }, or
  // null (said once) when it does not open as this device's snapshot
  function openRow(row, d) {
    let v = null;
    try { v = JSON.parse(K.openText(row.value_enc, key, `setting:${row.key}`)); } catch {}
    if (!v || v.v !== 1 || lower(v.device) !== d || !Number.isFinite(v.at) || !Array.isArray(v.sessions)) {
      logOnce(`bad|${row.key}`, `live: the snapshot of ${short(d)} does not open with this key; ignored`);
      return null;
    }
    return {
      sessions: new Map(cleanList(v.sessions.slice(0, MAX_SESSIONS)).map((e) => [e.id, { ...e, device: d }])),
      bound: new Set(cleanIds(v.bound)), at: v.at,
    };
  }
  // one bound row's sealed value -> { ids: a Set of ids, at }, or null (said once) when it does not open as that
  // device's
  function openBound(row, d) {
    let v = null;
    try { v = JSON.parse(K.openText(row.value_enc, key, `setting:${row.key}`)); } catch {}
    if (!v || v.v !== 1 || lower(v.device) !== d || !Number.isFinite(v.at) || !Array.isArray(v.bound)) {
      logOnce(`bad|${row.key}`, `live: the bound list of ${short(d)} does not open with this key; ignored`);
      return null;
    }
    return { ids: new Set(cleanIds(v.bound)), at: v.at };
  }
  // the live:* and bound:* keys with their updated_at: one request (two when Supabase refuses the or filter)
  async function listKeys() {
    const select = 'key,updated_at';
    if (orOk) {
      try { return await api.rest('GET', 'settings', { query: { select, or: '(key.like.live:*,key.like.bound:*)' } }); } catch (e) {
        if (!e || e.status !== 400) throw e;
        orOk = false;
        log(`live: the rows could not be listed in one request (${errText(e)}); two from now on`);
      }
    }
    const a = await api.rest('GET', 'settings', { query: { select, key: 'like.live:*' } });
    const b = await api.rest('GET', 'settings', { query: { select, key: 'like.bound:*' } });
    return [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])];
  }
  async function read(t) {
    if (!waited(t, lastRead, tm.readMs)) return;
    lastRead = t;
    let rows;
    try { rows = await listKeys(); said.delete('read'); } catch (e) { logOnce('read', `live: the other devices' snapshots could not be read (${errText(e)})`); failedReq(e); return; }
    const here = new Map(); // key -> its updated_at, for the rows that moved
    const listed = new Set(); // keys
    for (const row of Array.isArray(rows) ? rows : []) {
      const m = row && typeof row.key === 'string' ? KEY_RE.exec(row.key) : null;
      if (!m || m[2] === me) continue;
      listed.add(row.key);
      const stamp = String(row.updated_at || '');
      const prev = (m[1] === 'live' ? seen : boundSeen).get(m[2]);
      if (!prev || prev.stamp !== stamp) here.set(row.key, stamp);
    }
    for (const d of [...seen.keys()]) if (!listed.has(`live:${d}`)) seen.delete(d);
    for (const d of [...boundSeen.keys()]) if (!listed.has(`bound:${d}`)) boundSeen.delete(d);
    if (here.size) {
      let full;
      try {
        full = await api.rest('GET', 'settings', { query: { select: 'key,value_enc,updated_at', key: `in.(${[...here.keys()].map((k) => `"${k}"`).join(',')})` } });
        said.delete('fetch');
      } catch (e) { logOnce('fetch', `live: the other devices' snapshots could not be read (${errText(e)})`); failedReq(e); return; }
      const t2 = now();
      for (const row of Array.isArray(full) ? full : []) {
        const m = row && typeof row.key === 'string' ? KEY_RE.exec(row.key) : null;
        if (!m || !here.has(row.key)) continue;
        fetched++;
        if (m[1] === 'bound') { const b = openBound(row, m[2]); boundSeen.set(m[2], { stamp: String(row.updated_at || ''), ids: b ? b.ids : null, at: b ? b.at : null }); continue; }
        const opened = openRow(row, m[2]);
        seen.set(m[2], { stamp: String(row.updated_at || ''), changedAt: t2, sessions: opened ? opened.sessions : null, bound: opened ? opened.bound : new Set(), at: opened ? opened.at : null });
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
    roundErr = null; roundDirty = false;
    await publish(now());
    if (!roundErr || !S.isTransient(roundErr)) await read(now()); // Supabase out of reach: the round ends here
    if (roundErr) health.failed(roundErr); else health.done(!roundDirty);
  }

  // ---------- the loop ----------
  let running = false, timer = null, ticking = null;
  function tick() {
    if (ticking) return ticking;
    ticking = tickOnce().catch((e) => { logOnce('tick', `live: a round failed (${errText(e)})`); health.failed(e); }).finally(() => { ticking = null; });
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
    schedule(Math.max(tm.tickMs, health.wait())); // backing off: the round-level wait
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
    const known = new Set(), unsure = new Set(), fresh = new Set(), sessions = new Map(), byDevice = new Map(), when = new Map(), bound = new Map();
    const t = now();
    for (const [d, r] of seen) {
      if (!r.sessions) continue;
      known.add(d);
      // its bound row when it has one that opens, else its live row's (an older device's); none from a device known
      // to be offline whose newest sign of life (its rows' at, which move only when what they hold does, and its
      // last_seen_at heartbeat) is over boundStaleMs old: a machine away that long no longer holds anything back here
      const b = boundSeen.get(d);
      const on = isOnline(d);
      let seen = null;
      try { seen = seenAt(d); } catch {}
      const newest = Math.max(Number.isFinite(r.at) ? r.at : 0, b && Number.isFinite(b.at) ? b.at : 0, Number.isFinite(seen) ? seen : 0);
      if (on !== false || !newest || t - newest <= tm.boundStaleMs) bound.set(d, b && b.ids ? b.ids : r.bound || new Set());
      if (on === null) unsure.add(d);
      if (on !== true) continue;
      fresh.add(d);
      byDevice.set(d, r.sessions);
      // two fresh snapshots with one id (a move under way): the one seen changing last
      for (const [id, e] of r.sessions) if (!sessions.has(id) || when.get(id) < r.changedAt) { sessions.set(id, e); when.set(id, r.changedAt); }
    }
    return { ready, known, unsure, fresh, sessions, byDevice, bound };
  }
  const status = () => { const v = live(); return { device: me, writes, boundWrites, fetched, ready, devices: v.known.size, fresh: v.fresh.size, health: health.status() }; };

  return { start, stop, tick, live, status };
}

module.exports = { createLive, remoteFor, cleanEntry, cleanList, cleanIds, pickList, sigOf, TIMING, MAX_SESSIONS, MAX_BOUND };
