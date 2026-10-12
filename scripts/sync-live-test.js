// sync-live-test.js: sync-live.js, what runs where. Two devices, a PC and a Mac, each with its own clock (the Mac's a
// day behind: never compared), over ONE in-memory fake of Supabase's settings table (merge-duplicates upserts on
// (user_id, key), like.live:* and in.(...) reads). No timer runs: tick() by hand.
//   nothing before the device id is known; the first write, sealed, sorted, cleaned and picked (DONE over a day old
//   left out, the running ones kept first under the cap); nothing written again while only last / active moved, nor
//   while nothing changed (no heartbeat); a change waits out the 5 s throttle; the other device's snapshot read back,
//   its own row skipped, its value fetched only when its updated_at moved; fresh only while the mover says its device
//   is online; a row sealed with another key, or not JSON, ignored, said once and not fetched again until it changes;
//   a write that fails is said once and tried again; each conversation's repo ({ origin, name }) published, read back,
//   cleaned, and a change of it alone written, an older entry with none still valid; remoteFor's rules (listed, listed but resting, fresh and not
//   listed, offline owner, an owner that never published, not read yet); the bound list in its own bound:<device> row
//   (and in the live row too, for older readers; cleaned and sorted, written when it changed and only then, listed
//   with the live rows in one request, fetched when it moved, read back, kept while its device is offline, emptied; an older device's
//   live row's bound read while it has no bound row, a bound row winning over it, one that does not open falling back;
//   the or filter refused: two lists); and sync-run.js's wiring (the mover's
//   device id and online(), the snapshot, live(), started and stopped with the run, none without a snapshot), which on
//   a Mac runs only with SYNC_TEST_KEYCHAIN=1: it writes the sync key into the real login Keychain.
// Run: node scripts/sync-live-test.js   (exit 0 = all pass)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');
const S = require(path.join(ROOT, 'sync-api.js'));
const K = require(path.join(ROOT, 'sync-crypto.js'));
const L = require(path.join(ROOT, 'sync-live.js'));
const PF = require(path.join(__dirname, 'pgrest-filter.js'));
const { createSyncRunner } = require(path.join(ROOT, 'sync-run.js'));

let pass = 0, fail = 0;
const ok = (c, name) => { if (c) pass++; else { fail++; console.log(`FAIL ${name}`); } };
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), `${name}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

const KEY = crypto.randomBytes(32);
const PC = '11111111-1111-4111-8111-111111111111';
const MAC = '22222222-2222-4222-8222-222222222222';
const C1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const C2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const C3 = 'aaaaaaaa-0000-4000-8000-000000000003';

// ---------- the fake settings table ----------
const db = [];
const api = { calls: [], offline: false, rest };
async function rest(method, table, o = {}) {
  const q = o.query || {};
  api.calls.push({ method, table, query: { ...q }, key: o.body && o.body.key });
  if (api.offline) throw new S.SyncError('Supabase is out of reach', 0, 'network');
  if (table !== 'settings') throw new Error(`unexpected table ${table}`);
  if (method === 'GET') {
    if (api.noOr && q.or) throw new S.SyncError('PGRST100: failed to parse logic tree', 400, 'bad_request');
    const match = PF.matcher(new URLSearchParams(q)); // like, in and or=(...) as PostgREST reads them
    const cols = String(q.select || '').split(',');
    return db.filter(match).map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])));
  }
  if (method === 'POST') {
    ok(q.on_conflict === 'user_id,key' && /resolution=merge-duplicates/.test(o.prefer || ''), 'a write is an upsert on (user_id, key)');
    const hit = db.find((r) => r.key === o.body.key);
    if (hit) Object.assign(hit, o.body); else db.push({ ...o.body });
    return null;
  }
  throw new Error(`unexpected ${method}`);
}
// the live rows' writes (the bound rows' are boundWrites())
const writes = (dev) => api.calls.filter((c) => c.method === 'POST' && /^live:/.test(c.key || '')).length - (dev || 0);
const boundWrites = () => api.calls.filter((c) => c.method === 'POST' && /^bound:/.test(c.key || '')).length;
const fetches = () => api.calls.filter((c) => c.method === 'GET' && /value_enc/.test(c.query.select || '')).length;
const rowOf = (dev, kind = 'live') => { const r = db.find((x) => x.key === `${kind}:${dev}`); return r ? JSON.parse(K.openText(r.value_enc, KEY, `setting:${kind}:${dev}`)) : null; };

// ---------- the two devices ----------
const pcClock = { t: Date.parse('2026-10-11T12:00:00Z') };
const macClock = { t: pcClock.t - 24 * 3600e3 }; // a day behind
const pcList = [
  { id: C2.toUpperCase(), state: 'WORKING', label: 'WORKING', stateColor: '#22d3ee', name: 'fix-mac-sync-parity', renamed: true, account: 'A', last: pcClock.t, active: pcClock.t, turnStart: pcClock.t - 60e3, waitingOn: null, agents: 0 },
  { id: C1, state: 'AGENTS', label: 'AGENTS', stateColor: '#8b5cf6', name: 'parity agents', renamed: false, account: 'B', last: pcClock.t, active: pcClock.t, turnStart: pcClock.t - 120e3, agents: 2 },
  { id: 'not-an-id', state: 'WORKING' }, // dropped
  { id: C1, state: 'DONE' }, // a second C1: the first one stays
];
let pcDevice = null;
let pcBound = []; // the PC's bound conversations (bound())
const pcLogs = [], macLogs = [];
const isOn = new Map([[PC, true]]); // what the Mac's mover says of each device
const pc = L.createLive({ api, key: KEY, now: () => pcClock.t, device: () => pcDevice, snapshot: () => pcList, bound: () => pcBound, log: (t) => pcLogs.push(t) });
const mac = L.createLive({ api, key: KEY, now: () => macClock.t, device: () => ({ id: MAC.toUpperCase(), name: 'mac' }), online: (d) => (isOn.has(d) ? isOn.get(d) : false), snapshot: () => [], log: (t) => macLogs.push(t) });
const step = (ms) => { pcClock.t += ms; macClock.t += ms; };

(async () => {
  // ---------- publishing ----------
  await pc.tick();
  ok(api.calls.length === 0, 'no device id yet: nothing written or read');
  pcDevice = PC;
  await pc.tick();
  eq(writes(), 1, 'the first round writes the snapshot');
  eq(boundWrites(), 1, 'and the bound row, once');
  let v = rowOf(PC);
  ok(v && v.v === 1 && v.device === PC && v.at === pcClock.t, 'the row is sealed under live:<device> with v, device and at');
  eq(v.bound, [], 'the live row carries the bound list too (an older Fleet View reads it only there)');
  eq(v.sessions.map((e) => [e.id, e.state, e.agents]), [[C1, 'AGENTS', 2], [C2, 'WORKING', 0]], 'its sessions: cleaned, one per id, in id order');
  ok(v.sessions[1].name === 'fix-mac-sync-parity' && v.sessions[1].renamed === true && v.sessions[1].account === 'A' && v.sessions[1].waitingOn === null, 'with name, renamed, account and waitingOn');
  ok(!JSON.stringify(db).includes('fix-mac-sync-parity'), 'the name never reaches the table in the clear');
  const at1 = v.at;

  step(5e3);
  for (const e of pcList) { e.last = pcClock.t; e.active = pcClock.t; }
  await pc.tick();
  eq(writes(), 1, 'only last and active moved: nothing written');

  pcList[0].state = 'DONE'; pcList[0].label = 'DONE';
  step(1e3);
  await pc.tick();
  eq(writes(), 2, 'a change 6 s after the last write goes out');
  pcList[1].state = 'WORKING'; pcList[1].label = 'WORKING';
  step(2e3);
  await pc.tick();
  eq(writes(), 2, 'another change 2 s later waits (at most one write every 5 s)');
  step(3e3);
  await pc.tick();
  eq(writes(), 3, '...and goes out 5 s after the last one');
  eq(rowOf(PC).sessions.map((e) => e.state), ['WORKING', 'DONE'], 'with the newest states');
  pcList.push({ id: C3, state: 'ASKING', label: 'NEEDS YOU', waitingOn: 'approve Bash(git push)', account: 'A' });
  step(5e3);
  await pc.tick();
  eq(writes(), 4, 'a conversation added to the list goes out');
  pcList.pop();
  step(5e3);
  await pc.tick();
  eq(writes(), 5, 'one gone from the list goes out');
  const at2 = rowOf(PC).at;
  ok(at2 > at1, 'at differs on every write');
  ok(db.find((r) => r.key === `live:${PC}`).updated_at === new Date(at2).toISOString(), 'updated_at is the row\'s at');
  for (let i = 0; i < 24; i++) { step(5e3); await pc.tick(); }
  eq(writes(), 5, 'nothing changed for 2 minutes: nothing written (no heartbeat)');

  // picked: DONE over a day old left out, the running ones first under the cap
  {
    const t = pcClock.t, D = 24 * 3600e3;
    const id = (n) => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const few = [{ id: id(0), state: 'DONE', last: t - D - 1 }, { id: id(1), state: 'DONE', last: t - D + 1e3 }, { id: id(2), state: 'IDLE', last: t - 3 * D }];
    eq(L.pickList(L.cleanList(few), t).map((e) => e.id), [id(1), id(2)], 'pickList: DONE over a day old left out, IDLE kept');
    const big = [];
    for (let i = 0; i < L.MAX_SESSIONS + 50; i++) big.push({ id: id(1000 + i), state: 'DONE', last: t - i * 1e3 });
    big.push({ id: id(9999), state: 'WORKING', last: t - D * 2 });
    const picked = L.pickList(L.cleanList(big), t);
    ok(picked.length === L.MAX_SESSIONS && picked.some((e) => e.id === id(9999)) && picked.some((e) => e.id === id(1000)) && !picked.some((e) => e.id === id(1000 + L.MAX_SESSIONS + 10)), 'pickList: at most MAX_SESSIONS, the running one kept, then the newest');
    ok(picked.every((e, i) => !i || picked[i - 1].id < e.id), 'pickList: in id order');
  }

  // ---------- reading ----------
  await mac.tick();
  let view = mac.live();
  ok(view.ready && view.fresh.has(PC) && !view.fresh.has(MAC) && view.fresh.size === 1, 'the Mac sees the PC fresh, never its own row');
  ok(rowOf(MAC) && rowOf(MAC).device === MAC && rowOf(MAC).sessions.length === 0, 'the Mac wrote its own (empty) snapshot under its lower-case id');
  ok(view.sessions.get(C1).state === 'WORKING' && view.sessions.get(C1).device === PC && view.byDevice.get(PC).get(C2).state === 'DONE', 'the PC\'s conversations, each with its device');

  // its value fetched once; listed again with nothing moved: not fetched again
  const f1 = fetches();
  for (let i = 0; i < 30; i++) { step(5e3); await mac.tick(); }
  eq(fetches(), f1, 'nothing moved for 150 s: the value is not fetched again');
  ok(mac.live().fresh.has(PC), 'still fresh while its device is online, however long nothing changed');
  pcList[0].waitingOn = 'a question';
  await pc.tick(); // (the PC reads the Mac's row here, its first time)
  const f1b = fetches();
  step(5e3); await mac.tick();
  eq(fetches(), f1b + 1, 'its updated_at moved: fetched once more');
  eq(mac.live().sessions.get(C2).waitingOn, 'a question', 'with the new value');
  // offline by the mover: not fresh, but still known
  isOn.set(PC, false);
  view = mac.live();
  ok(!view.fresh.has(PC) && view.known.has(PC) && !view.byDevice.has(PC) && !view.sessions.has(C2), 'its device offline: known, not fresh');
  isOn.set(PC, true);
  ok(mac.live().fresh.has(PC), 'fresh again once it is online');

  // a bad row: sealed with another key, and one that is not JSON
  const BAD = '33333333-3333-4333-8333-333333333333', BAD2 = '44444444-4444-4444-8444-444444444444';
  db.push({ key: `live:${BAD}`, value_enc: K.sealText(JSON.stringify({ v: 1, device: BAD, at: 1, sessions: [] }), crypto.randomBytes(32), `setting:live:${BAD}`) });
  db.push({ key: `live:${BAD2}`, value_enc: K.sealText('not json', KEY, `setting:live:${BAD2}`) });
  db.push({ key: 'live:not-a-device', value_enc: 'x' });
  isOn.set(BAD, true); isOn.set(BAD2, true);
  const f2 = fetches();
  step(5e3); await mac.tick();
  step(5e3); await mac.tick();
  view = mac.live();
  ok(!view.fresh.has(BAD) && !view.fresh.has(BAD2) && !view.known.has(BAD) && view.fresh.has(PC), 'rows that do not open are ignored, the good one kept');
  eq(fetches(), f2 + 1, 'and fetched once, not again until they change');
  eq(macLogs.filter((t) => /33333333/.test(t)).length, 1, 'a bad row is said once');
  eq(macLogs.filter((t) => /44444444/.test(t)).length, 1, 'a row that is not JSON is said once');

  // a write that fails: said once, tried again
  api.offline = true;
  pcList[0].name = 'renamed again';
  const before = pcLogs.length;
  step(5e3); await pc.tick();
  step(5e3); await pc.tick();
  eq(pcLogs.slice(before).filter((t) => /written/.test(t)).length, 1, 'a write that fails is said once');
  api.offline = false;
  step(5e3); await pc.tick();
  ok(rowOf(PC).sessions.some((e) => e.name === 'renamed again'), 'and goes out once Supabase is back');

  // the repo the owner shows it under: published, and a change of it alone goes out
  const wRepo = writes();
  pcList[0].repo = { origin: 'GLODUSK/fleet-view', name: 'fleet-view', known: true };
  step(5e3); await pc.tick();
  eq(writes(), wRepo + 1, 'a conversation\'s repo set: written');
  eq(rowOf(PC).sessions.find((e) => e.id === C2).repo, { origin: 'GLODUSK/fleet-view', name: 'fleet-view' }, 'its repo goes out as { origin, name } only');
  pcList[0].repo = { origin: null, name: 'scratch-2026-10-11' };
  step(5e3); await pc.tick();
  eq(writes(), wRepo + 2, 'only its repo changed: written');
  eq(rowOf(PC).sessions.find((e) => e.id === C2).repo, { origin: null, name: 'scratch-2026-10-11' }, 'a folder with no origin goes by its name');
  pcList[0].repo = { origin: 'GLODUSK/fleet-view', name: 'fleet-view' };
  step(5e3); await pc.tick();

  // ---------- remoteFor ----------
  step(5e3); await mac.tick();
  view = mac.live();
  eq(L.remoteFor({ ready: false, byDevice: new Map() }, PC, C2), null, 'not read yet: null (this machine\'s own reading stands)');
  let r = L.remoteFor(view, PC.toUpperCase(), C1.toUpperCase());
  ok(r && r.device === PC && r.entry && r.entry.state === 'WORKING' && r.live === true, 'listed and running: the snapshot\'s entry, live');
  r = L.remoteFor(view, PC, C2);
  ok(r && r.entry && r.entry.state === 'DONE' && r.live === false, 'listed and resting: the entry, not live');
  r = L.remoteFor(view, PC, C3);
  ok(r && r.entry === null && r.live === false, 'the owner is fresh and does not list it: no entry (DONE)');
  ok(L.remoteFor(view, BAD, C2) === null && L.remoteFor(view, '55555555-5555-4555-8555-555555555555', C2) === null, 'an owner that never published one (no row, or a bad one): null (an older Fleet View there; its copy here stands)');
  isOn.set(PC, false);
  r = L.remoteFor(mac.live(), PC, C1);
  ok(r && r.entry === null && r.live === false, 'an offline owner: DONE, never its old WORKING');
  // not known whether it is there (since this machine started, or its own reads stopped): its copy here stands
  isOn.set(PC, null);
  view = mac.live();
  ok(view.unsure.has(PC) && view.known.has(PC) && !view.fresh.has(PC) && L.remoteFor(view, PC, C1) === null, 'an owner not known to be there: unsure, null (this machine\'s own reading stands)');
  isOn.set(PC, true);
  ok(L.remoteFor(view, '', C2) === null, 'no owner device: null');
  ok(L.cleanEntry({ id: C1, state: 'WORKING', account: 'AB', stateColor: 'red', name: 'x'.repeat(500) }).account === null, 'cleanEntry drops a bad account');
  ok(L.cleanEntry({ id: C1, state: 'working' }) === null && L.cleanEntry({ id: C1, state: 'WORKING' }).name === null, 'cleanEntry wants an upper-case state');
  r = L.remoteFor(mac.live(), PC, C2);
  eq(r && r.entry && r.entry.repo, { origin: 'GLODUSK/fleet-view', name: 'fleet-view' }, 'the other device reads the owner\'s repo');
  // repo: kept when it is a portable root, null when not; a row from before it (none) is still an entry
  const ce = (repo) => L.cleanEntry({ id: C1, state: 'WORKING', repo });
  eq(ce({ origin: 'GLODUSK/fleet-view', name: 'fleet-view', extra: 'x' }).repo, { origin: 'GLODUSK/fleet-view', name: 'fleet-view' }, 'cleanEntry keeps a repo, its two fields only');
  eq(ce({ name: 'fleet-view' }).repo, { origin: null, name: 'fleet-view' }, 'cleanEntry keeps a repo with a name only');
  eq(ce({ origin: 'GLODUSK/fleet-view', name: '/Users/henry/code/fleet-view' }).repo, { origin: 'GLODUSK/fleet-view', name: null }, 'cleanEntry drops a name that is a path');
  eq(ce({ origin: 'GLODUSK/fleet-view', name: 'x'.repeat(201) }).repo, { origin: 'GLODUSK/fleet-view', name: null }, 'cleanEntry drops a name over 200');
  ok(ce({ origin: 'has space', name: 'a\\b' }).repo === null && ce('fleet-view').repo === null && ce({ origin: 'x'.repeat(301) }).repo === null, 'cleanEntry rejects a bad repo (whitespace origin, path name, not an object, too long)');
  const old = L.cleanEntry({ id: C1, state: 'WORKING', name: 'old row' });
  ok(old && old.name === 'old row' && old.repo === null, 'an entry from before repo: still an entry, repo null');
  const base = [{ ...old, repo: { origin: 'GLODUSK/fleet-view', name: 'fleet-view' } }];
  ok(L.sigOf(base) !== L.sigOf([{ ...base[0], repo: { origin: 'GLODUSK/other', name: 'fleet-view' } }])
    && L.sigOf(base) !== L.sigOf([{ ...base[0], repo: { origin: 'GLODUSK/fleet-view', name: 'other' } }])
    && L.sigOf(base) !== L.sigOf([old]), 'sigOf changes when the repo changes, or goes');
  // pin: the owner's stays-on verdict, { rule, host } | null; left out by an older owner (no verdict)
  const cp = (pin) => L.cleanEntry({ id: C1, state: 'WORKING', pin });
  eq(cp({ rule: 'blender', host: 'BlackBox', extra: 1 }).pin, { rule: 'blender', host: 'BlackBox' }, 'cleanEntry keeps a pin, its two fields only');
  ok(cp(null).pin === null && cp({ rule: 'Bad Rule', host: 'x' }).pin === null && cp({ rule: 'blender', host: ' ' }).pin === null, 'cleanEntry: no pin, a bad rule id or no host is null');
  ok(!('pin' in old), 'an entry from an older owner has no pin at all (the other devices judge by their own rules)');
  ok(L.sigOf([cp(null)]) !== L.sigOf([cp({ rule: 'blender', host: 'BlackBox' })]) && L.sigOf([cp(null)]) !== L.sigOf([old]), 'sigOf changes when the pin changes');

  // ---------- bound: the conversations whose workspace is only on their device ----------
  {
    eq(rowOf(PC, 'bound').bound, [], 'bound: none yet, an empty list in the bound row');
    ok(mac.live().bound.get(PC) instanceof Set && mac.live().bound.get(PC).size === 0, 'bound: the other device reads none');
    const w0 = writes(), b0 = boundWrites();
    pcBound = [C3.toUpperCase(), 'not-an-id', C1, C1];
    step(5e3); await pc.tick();
    eq([writes(), boundWrites()], [w0 + 1, b0 + 1], 'bound: a change of the list writes the bound row, and the live row (older readers)');
    const br = rowOf(PC, 'bound');
    eq(br.bound, [C1, C3].sort(), 'bound: lower case, one each, sorted, bad ids dropped');
    eq(rowOf(PC).bound, br.bound, 'bound: the live row holds the same list');
    ok(br.v === 1 && br.device === PC && db.find((r) => r.key === `bound:${PC}`).updated_at === new Date(br.at).toISOString(), 'bound: its row has v, device and at, updated_at its at');
    step(5e3); await pc.tick();
    eq([writes(), boundWrites()], [w0 + 1, b0 + 1], 'bound: the same list again writes nothing');
    const fb = fetches();
    step(5e3); await mac.tick();
    ok([C1, C3].every((id) => mac.live().bound.get(PC).has(id)), 'bound: the other device reads them');
    eq(fetches(), fb + 1, 'bound: its row fetched once, as it moved');
    step(5e3); await mac.tick();
    eq(fetches(), fb + 1, 'bound: and not again while it does not move');
    const lists = api.calls.filter((c) => c.method === 'GET' && c.query.select === 'key,updated_at').slice(-2);
    ok(lists.length === 2 && lists.every((c) => c.query.or === '(key.like.live:*,key.like.bound:*)' && !c.query.key), 'bound: the live and bound keys are listed in one request');
    // a live-row change alone does not touch the bound row
    pcList[0].name = 'only the name moved';
    step(5e3); await pc.tick();
    eq(boundWrites(), b0 + 1, 'bound: a change of the snapshot alone does not write the bound row');
    isOn.set(PC, false);
    ok(mac.live().bound.get(PC).has(C3) && !mac.live().fresh.has(PC), 'bound: kept while the device is offline (what is bound does not change while it sleeps)');
    isOn.set(PC, true);
    pcBound = [];
    step(5e3); await pc.tick();
    step(5e3); await mac.tick();
    ok(mac.live().bound.get(PC).size === 0, 'bound: an emptied list empties it on the other device');
    // an older device: its live row carries bound, and it has no bound row; a newer device's bound row wins over its
    // live row's (stale) field
    const OLD = '66666666-6666-4666-8666-666666666666';
    isOn.set(OLD, true);
    db.push({ key: `live:${OLD}`, updated_at: 'o1', value_enc: K.sealText(JSON.stringify({ v: 1, device: OLD, at: 1, sessions: [{ id: C2, state: 'WORKING' }], bound: [C2] }), KEY, `setting:live:${OLD}`) });
    step(5e3); await mac.tick();
    ok(mac.live().bound.get(OLD) && mac.live().bound.get(OLD).has(C2), 'bound: an older device\'s list comes from its live row');
    db.push({ key: `bound:${OLD}`, updated_at: 'b1', value_enc: K.sealText(JSON.stringify({ v: 1, device: OLD, at: 2, bound: [C3] }), KEY, `setting:bound:${OLD}`) });
    step(5e3); await mac.tick();
    ok(mac.live().bound.get(OLD).has(C3) && !mac.live().bound.get(OLD).has(C2), 'bound: once it has a bound row, that row\'s list (not the live row\'s)');
    db.find((r) => r.key === `bound:${OLD}`).value_enc = K.sealText('not json', KEY, `setting:bound:${OLD}`);
    db.find((r) => r.key === `bound:${OLD}`).updated_at = 'b2';
    step(5e3); await mac.tick();
    ok(mac.live().bound.get(OLD).has(C2), 'bound: a bound row that does not open: the live row\'s list again');
    eq(macLogs.filter((t) => /bound list of 66666666/.test(t)).length, 1, 'bound: a bad bound row is said once');
    db.splice(db.findIndex((r) => r.key === `bound:${OLD}`), 1);
    db.splice(db.findIndex((r) => r.key === `live:${OLD}`), 1);
    step(5e3); await mac.tick();
    ok(!mac.live().known.has(OLD) && !mac.live().bound.has(OLD), 'bound: a device whose rows are gone is forgotten');
    // Supabase refuses the or filter: the two lists, one each
    api.noOr = true;
    const n0 = api.calls.length;
    step(5e3); await mac.tick();
    const two = api.calls.slice(n0).filter((c) => c.method === 'GET' && c.query.select === 'key,updated_at');
    ok(two.length === 3 && two[1].query.key === 'like.live:*' && two[2].query.key === 'like.bound:*' && mac.live().known.has(PC), 'bound: the or filter refused: live:* and bound:* listed apart, still read');
    api.noOr = false;
    eq(L.cleanIds(Array.from({ length: L.MAX_BOUND + 10 }, () => crypto.randomUUID())).length, L.MAX_BOUND, 'cleanIds: at most MAX_BOUND');
    eq(L.cleanIds('nope'), [], 'cleanIds: not a list');
  }

  // ---------- sync-run.js wiring ----------
  // (On a Mac the sync key goes in the real login Keychain whatever the folder, sync-api.js protectedStore: this part
  // would overwrite the live sync key there, so it runs on a Mac only with SYNC_TEST_KEYCHAIN=1)
  if (process.platform === 'darwin' && process.env.SYNC_TEST_KEYCHAIN !== '1') console.log('skipped on this Mac: sync-run.js wiring (it writes the login Keychain; SYNC_TEST_KEYCHAIN=1 runs it)');
  else {
    const C = require(path.join(ROOT, 'sync-crypto.js'));
    const dir = fs.mkdtempSync(path.join(process.env.SYNC_TEST_DIR || os.tmpdir(), 'fv-sync-live-'));
    try {
      await C.saveKey(S.syncDir(dir), crypto.randomBytes(32));
      const sync = { enabled: () => true, status: async () => ({ configured: true, signedIn: true, member: true, email: 'a@b.c' }), uid: async () => 'u1', onChange: () => () => {} };
      const loop = () => ({ start() {}, async stop() {}, status: () => ({}), conflicts: () => [], owners: () => new Map() });
      let moverDevice = null;
      const mover = { start() {}, async stop() {}, owners: () => new Map(), device: () => moverDevice, online: (d) => d === MAC };
      const lives = [];
      const fakeLive = (a) => {
        const l = { a, started: 0, stopped: 0, start() { l.started++; }, async stop() { l.stopped++; }, live: () => ({ ready: true, fresh: new Set([MAC]), sessions: new Map(), byDevice: new Map() }) };
        lives.push(l);
        return l;
      };
      const snap = [{ id: C1, state: 'WORKING' }];
      const runner = createSyncRunner({ sync, dataDir: dir, checkMs: 1e6, makeUploader: loop, makeMaterializer: loop, makeMover: () => mover, makeLive: fakeLive, snapshot: () => snap, bound: () => [C1] });
      ok(runner.live() === null, 'live() before start: null');
      await runner.start();
      const l = lives[0];
      ok(lives.length === 1 && l.started === 1, 'the live loop starts with the run');
      ok(l.a.api === sync && l.a.key.length === 32 && l.a.snapshot() === snap && JSON.stringify(l.a.bound()) === JSON.stringify([C1]), 'it gets the api, the key, the snapshot and the bound list');
      ok(l.a.device() === null, 'no device id until the mover has one');
      moverDevice = { id: PC, name: 'pc' };
      ok(l.a.device() === PC, 'then the mover\'s device id');
      ok(l.a.online(MAC) === true && l.a.online(PC) === false, 'online() is the mover\'s');
      ok(runner.live().fresh.has(MAC), 'live() gives the live loop\'s view');
      await runner.stop();
      ok(l.stopped === 1 && runner.live() === null, 'stop() stops it; live() null again');
      const r2 = createSyncRunner({ sync, dataDir: dir, checkMs: 1e6, makeUploader: loop, makeMaterializer: loop, makeMover: () => mover, makeLive: fakeLive });
      await r2.start();
      ok(lives.length === 1 && r2.live() === null, 'no snapshot given: no live loop');
      await r2.stop();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }

  await pc.stop();
  await mac.stop();
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
