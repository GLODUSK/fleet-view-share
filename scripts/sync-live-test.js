// sync-live-test.js: sync-live.js, what runs where. Two devices, a PC and a Mac, each with its own clock (the Mac's a
// day behind: never compared), over ONE in-memory fake of Supabase's settings table (merge-duplicates upserts on
// (user_id, key), like.live:* and in.(...) reads). No timer runs: tick() by hand.
//   nothing before the device id is known; the first write, sealed, sorted, cleaned and picked (DONE over a day old
//   left out, the running ones kept first under the cap); nothing written again while only last / active moved, nor
//   while nothing changed (no heartbeat); a change waits out the 5 s throttle; the other device's snapshot read back,
//   its own row skipped, its value fetched only when its updated_at moved; fresh only while the mover says its device
//   is online; a row sealed with another key, or not JSON, ignored, said once and not fetched again until it changes;
//   a write that fails is said once and tried again; remoteFor's rules (listed, listed but resting, fresh and not
//   listed, offline owner, an owner that never published, not read yet); and sync-run.js's wiring (the mover's device
//   id and online(), the snapshot, live(), started and stopped with the run, none without a snapshot).
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
  api.calls.push({ method, table, query: { ...q } });
  if (api.offline) throw new S.SyncError('Supabase is out of reach', 0, 'network');
  if (table !== 'settings') throw new Error(`unexpected table ${table}`);
  if (method === 'GET') {
    const m = /^like\.(.*)$/.exec(q.key || '');
    const re = m ? new RegExp(`^${m[1].split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`) : null;
    const inList = /^in\.\((.*)\)$/.exec(q.key || '');
    const want = inList ? new Set(inList[1].split(',').map((k) => k.replace(/^"|"$/g, ''))) : null;
    const cols = String(q.select || '').split(',');
    return db.filter((r) => (!re || re.test(r.key)) && (!want || want.has(r.key))).map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])));
  }
  if (method === 'POST') {
    ok(q.on_conflict === 'user_id,key' && /resolution=merge-duplicates/.test(o.prefer || ''), 'a write is an upsert on (user_id, key)');
    const hit = db.find((r) => r.key === o.body.key);
    if (hit) Object.assign(hit, o.body); else db.push({ ...o.body });
    return null;
  }
  throw new Error(`unexpected ${method}`);
}
const writes = (dev) => api.calls.filter((c) => c.method === 'POST').length - (dev || 0);
const fetches = () => api.calls.filter((c) => c.method === 'GET' && /value_enc/.test(c.query.select || '')).length;
const rowOf = (dev) => { const r = db.find((x) => x.key === `live:${dev}`); return r ? JSON.parse(K.openText(r.value_enc, KEY, `setting:live:${dev}`)) : null; };

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
const pcLogs = [], macLogs = [];
const isOn = new Map([[PC, true]]); // what the Mac's mover says of each device
const pc = L.createLive({ api, key: KEY, now: () => pcClock.t, device: () => pcDevice, snapshot: () => pcList, log: (t) => pcLogs.push(t) });
const mac = L.createLive({ api, key: KEY, now: () => macClock.t, device: () => ({ id: MAC.toUpperCase(), name: 'mac' }), online: (d) => (isOn.has(d) ? isOn.get(d) : false), snapshot: () => [], log: (t) => macLogs.push(t) });
const step = (ms) => { pcClock.t += ms; macClock.t += ms; };

(async () => {
  // ---------- publishing ----------
  await pc.tick();
  ok(api.calls.length === 0, 'no device id yet: nothing written or read');
  pcDevice = PC;
  await pc.tick();
  eq(writes(), 1, 'the first round writes the snapshot');
  let v = rowOf(PC);
  ok(v && v.v === 1 && v.device === PC && v.at === pcClock.t, 'the row is sealed under live:<device> with v, device and at');
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

  // ---------- sync-run.js wiring ----------
  {
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
      const runner = createSyncRunner({ sync, dataDir: dir, checkMs: 1e6, makeUploader: loop, makeMaterializer: loop, makeMover: () => mover, makeLive: fakeLive, snapshot: () => snap });
      ok(runner.live() === null, 'live() before start: null');
      await runner.start();
      const l = lives[0];
      ok(lives.length === 1 && l.started === 1, 'the live loop starts with the run');
      ok(l.a.api === sync && l.a.key.length === 32 && l.a.snapshot() === snap, 'it gets the api, the key and the snapshot');
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
