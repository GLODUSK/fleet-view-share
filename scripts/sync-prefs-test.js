// sync-prefs-test.js: sync-prefs.js, the settings every device holds the same. Two devices, a PC and a Mac, each with
// its own clock (the Mac's a day behind: never compared) and its own folders for the same repos, over ONE in-memory fake
// of Supabase's settings table (merge-duplicates upserts on (user_id, key), like.prefs:* and in.(...) reads). No timer
// runs: tick() by hand.
//   makeTranslate: a root to { origin, name } and back, by origin, then by folder name (never a root with another
//   origin), the PC's stale Mac-path spot named by the repo the PC has; nothing before the device id; first join with
//   no rows: each group sealed under prefs:<group>, roots portable, the stale spot mended here and left out of the row,
//   updated_at its at; the Mac's first join: the rows joined with its own, roots put on the Mac's folders, a repo the Mac
//   lacks not put in but kept in the row; the PC takes the Mac's join; a delete, a rename, a move and a workspace hidden
//   on one device reach the other; this device's own rows never taken; a row written with an older at (another clock)
//   still taken; both changed at once: merged item by item, what was dropped stays dropped; at most one write of a group
//   every 3 s; an item that does not translate keeps this machine's own; teams without seenAt; repoOrder taken whole;
//   a row sealed with another key said once and ignored; a write that fails said once and tried again; a restart with
//   the saved state takes nothing again and writes nothing, and a change made while it was off goes up instead of
//   coming back; a saved state of another device or key is a first join; values fetched only when updated_at moved;
//   and sync-run.js's wiring (the mover's device id, read / apply / translate / load / save, started and stopped with
//   the run, prefsChanged() nudges it, none without prefs).
//   The parity review's fixes, each on a fresh pair: D1 an unpin sticks (the Mac keeps the spot unpinned, its page
//   never pins it back; a drag before the unpin loses to it, a pin after it wins), D2 a device's first join takes the
//   row on a key both have and keeps its own other items, less those the row's tombstones say were taken out after
//   them (a fresh join loses nothing; an old copy puts nothing back), D4 teams merged field by field (both messages and successors, in time order,
//   capped), D6 the page's single-item ops (sync-prefs.js applyOps, and web/app.js's own save code run in a vm: a
//   stale page never undoes the Mac's change), D7 web/app.js repoIsHidden goes by turnStart as the server goes by
//   promptAt, D8 repoOrder keeps a repo only the other machine has in place, and the new groups addedRepos, keepPins
//   and parity. "Start clean": a device with every group emptied but its local-only items and no saved state takes
//   the rows exactly, keeps its local-only items, writes nothing, and never writes over a row that does not open.
// Run: node scripts/sync-prefs-test.js   (exit 0 = all pass)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const S = require(path.join(ROOT, 'sync-api.js'));
const K = require(path.join(ROOT, 'sync-crypto.js'));
const P = require(path.join(ROOT, 'sync-prefs.js'));
const { createSyncRunner } = require(path.join(ROOT, 'sync-run.js'));

let pass = 0, fail = 0;
const ok = (c, name) => { if (c) pass++; else { fail++; console.log(`FAIL ${name}`); } };
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), `${name}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

const KEY = crypto.randomBytes(32);
const PC = '11111111-1111-4111-8111-111111111111';
const MAC = '22222222-2222-4222-8222-222222222222';
const THIRD = '33333333-3333-4333-8333-333333333333';
const id = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;

// ---------- the fake settings table ----------
const db = [];
const api = { calls: [], offline: false, rest };
async function rest(method, table, o = {}) {
  const q = o.query || {};
  api.calls.push({ method, table, query: { ...q }, body: o.body });
  if (api.offline) throw new S.SyncError('Supabase is out of reach', 0, 'network');
  if (table !== 'settings') throw new Error(`unexpected table ${table}`);
  if (method === 'GET') {
    const m = /^like\.(.*)$/.exec(q.key || '');
    const re = m ? new RegExp(`^${m[1].split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`) : null;
    const inList = /^in\.\((.*)\)$/.exec(q.key || '');
    const want = inList ? new Set(inList[1].split(',').map((k) => k.replace(/^"|"$/g, ''))) : null;
    const cols = String(q.select || '').split(',');
    // PostgREST answers a timestamptz as +00:00, where the writer sent Z
    const res = db.filter((r) => (!re || re.test(r.key)) && (!want || want.has(r.key))).map((r) => Object.fromEntries(cols.map((c) => [c, c === 'updated_at' && /Z$/.test(r[c]) ? r[c].replace(/Z$/, '+00:00') : r[c]])));
    // onList: run once between a device's list and what it does next (another device writing just then)
    if (api.onList && q.select === 'key,updated_at') { const f = api.onList; api.onList = null; await f(); }
    return res;
  }
  if (method === 'POST') {
    ok(q.on_conflict === 'user_id,key' && /resolution=merge-duplicates/.test(o.prefer || ''), 'a write is an upsert on (user_id, key)');
    const hit = db.find((r) => r.key === o.body.key);
    if (hit) Object.assign(hit, o.body); else db.push({ ...o.body });
    return null;
  }
  throw new Error(`unexpected ${method}`);
}
const posts = () => api.calls.filter((c) => c.method === 'POST');
const fetches = () => api.calls.filter((c) => c.method === 'GET' && /value_enc/.test(c.query.select || '')).length;
const rowOf = (g) => { const r = db.find((x) => x.key === `prefs:${g}`); return r ? JSON.parse(K.openText(r.value_enc, KEY, `setting:prefs:${g}`)) : null; };

// ---------- the two machines ----------
const ORIGIN_FV = 'GLODUSK/fleet-view', ORIGIN_DF = 'GLODUSK/detailforge-web';
const PCR = { fv: 'Z:\\Github\\fleet-view', df: 'Z:\\Github\\detailforge-web', only: 'Z:\\scratch\\pc-only' };
const MACR = { fv: '/Users/henry/Documents/github/fleet-view', df: '/Users/henry/Documents/github/detailforge-web', notes: '/Users/henry/notes' };
const originsOf = { [PCR.fv]: ORIGIN_FV, [PCR.df]: ORIGIN_DF, [MACR.fv]: ORIGIN_FV, [MACR.df]: ORIGIN_DF };
const trPc = P.makeTranslate({ roots: () => Object.values(PCR), originOf: (r) => originsOf[r] || null, exists: (r) => Object.values(PCR).includes(r) });
const trMac = P.makeTranslate({ roots: () => Object.values(MACR), originOf: (r) => originsOf[r] || null, exists: (r) => Object.values(MACR).includes(r) });

// a machine's settings, as fleet-view.js's prefsGroups gives them
function machine() {
  return { hidden: [], names: [], moved: [], hiddenRepos: [], addedRepos: [], repoNames: [], repoHues: [], sessHues: [], repoOrder: [], mapSpots: [], teams: [], hostRules: [], pinOverrides: [], dynamicChats: [], keepPins: [], parity: [] };
}
const pcSet = machine(), macSet = machine();
const T0 = Date.parse('2026-10-11T12:00:00Z');
pcSet.hidden = [{ id: id(1), at: T0 - 5e3, forgot: false }, { id: id(2), at: T0 - 4e3, forgot: true }];
pcSet.names = [{ id: id(1), name: 'parity work' }, { id: id(3), name: null }];
pcSet.moved = [{ id: id(4), root: PCR.fv, at: T0 - 3e3 }, { id: id(5), root: null, at: T0 - 3e3 }];
pcSet.hiddenRepos = [{ root: PCR.only, at: T0 - 2e3 }];
pcSet.repoNames = [{ root: PCR.df, name: 'DF web' }];
pcSet.repoOrder = [PCR.df, PCR.fv];
pcSet.mapSpots = [
  { id: 'r:z:\\github\\detailforge-web', x: 100, y: 200, pin: true },
  { id: 'r:\\users\\henry\\documents\\github\\detailforge-web', x: -5, y: -5, pin: true }, // stale data: a Mac path
  { id: 'r:z:\\scratch\\pc-only', x: 7, y: 8, pin: false },
  { id: `s:${id(1)}`, x: 30, y: 40, pin: true },
];
pcSet.teams = [{ id: 't00000001', name: 'parity', color: '#ff9f43', members: [id(1), id(4)], lead: id(1), order: 'ship it', at: T0, messages: [], successors: [], seenAt: T0 }];
pcSet.pinOverrides = [{ id: id(6), mode: 'free', host: 'BlackBox', hostDevice: PC.toUpperCase(), at: T0 - 1e3 }, { id: id(7), mode: 'stay', host: 'Mac', at: T0 - 1e3 }];
// the Mac's own: its first join keeps them (D2), whether made after the PC's first rows (T0) or long before (id(13)),
// except id(10) and the name of id(40), which the PC had too and took out before the Mac joined (the rows' tombstones)
macSet.pinOverrides = [{ id: id(8), mode: 'stay', host: 'BlackBox', at: T0 + 60e3 }];
macSet.hidden = [{ id: id(9), at: T0 + 60e3, forgot: false }, { id: id(10), at: T0 - 86400e3, forgot: false }, { id: id(13), at: T0 - 86400e3, forgot: false }];
macSet.hiddenRepos = [{ root: MACR.notes, at: T0 + 60e3 }];
macSet.names = [{ id: id(1), name: 'mac name' }, { id: id(40), name: 'mac only' }];
macSet.mapSpots = [{ id: 'r:\\users\\henry\\notes', x: 1, y: 2, pin: false }];

const applied = { pc: [], mac: [] };
const applier = (set, who) => (g, items) => { applied[who].push(g); set[g] = JSON.parse(JSON.stringify(items)); };
const pcClock = { t: T0 }, macClock = { t: T0 - 24 * 3600e3 };
const step = (ms) => { pcClock.t += ms; macClock.t += ms; };
const pcLogs = [], macLogs = [];
const store = { pc: null, mac: null };
let pcDevice = null;
const mkPc = (o = {}) => P.createPrefs({ api, key: KEY, now: () => pcClock.t, device: () => pcDevice, read: () => pcSet, apply: applier(pcSet, 'pc'), translate: trPc, load: () => store.pc, save: (s) => { store.pc = JSON.parse(JSON.stringify(s)); }, log: (t) => pcLogs.push(t), ...o });
let pc = mkPc();
const mac = P.createPrefs({ api, key: KEY, now: () => macClock.t, device: () => ({ id: MAC.toUpperCase(), name: 'mac' }), read: () => macSet, apply: applier(macSet, 'mac'), translate: trMac, load: () => store.mac, save: (s) => { store.mac = JSON.parse(JSON.stringify(s)); }, log: (t) => macLogs.push(t) });

(async () => {
  // ---------- makeTranslate ----------
  eq(trPc.out(PCR.fv), { origin: ORIGIN_FV, name: 'fleet-view', known: true }, 'out: a root this machine lists, with its origin');
  eq(trPc.out('z:/github/FLEET-VIEW/'), { origin: ORIGIN_FV, name: 'fleet-view', known: true }, 'out: root keys compare in lower case, / and \\ alike');
  eq(trPc.out('\\users\\henry\\documents\\github\\detailforge-web'), { origin: ORIGIN_DF, name: 'detailforge-web', known: false }, 'out: another machine\'s path names the repo this machine has by folder name, not known');
  eq(trPc.out('D:\\elsewhere\\mystery'), { origin: null, name: 'mystery', known: false }, 'out: a folder nothing here names: no origin');
  eq(trMac.in({ origin: ORIGIN_FV, name: 'whatever' }), MACR.fv, 'in: by origin first');
  eq(trMac.in({ origin: null, name: 'Notes' }), MACR.notes, 'in: else by folder name');
  eq(trMac.in({ origin: 'someone/notes', name: 'notes' }), MACR.notes, 'in: a folder of that name with no origin here');
  eq(trPc.in({ origin: 'someone/fleet-view', name: 'fleet-view' }), null, 'in: never a root with another origin');
  eq(trPc.in({ origin: null, name: 'notes' }), null, 'in: nothing of that origin or name: null');
  eq(P.spotId('/Users/henry/Notes/'), 'r:\\users\\henry\\notes', 'spotId: as web/map.js repoId');

  // ---------- the PC's first join, no rows yet ----------
  await pc.tick();
  ok(api.calls.length === 0, 'no device id yet: nothing written or read');
  pcDevice = PC;
  await pc.tick();
  eq(posts().map((c) => c.body.key).sort(), P.GROUP_NAMES.map((g) => `prefs:${g}`).sort(), 'first join with no rows: one row per group');
  let v = rowOf('hidden');
  ok(v && v.v === 1 && v.device === PC && v.at === pcClock.t, 'a row: sealed under prefs:<group> with v, device and at');
  ok(db.find((r) => r.key === 'prefs:hidden').updated_at === new Date(v.at).toISOString(), 'updated_at is the row\'s at');
  eq(v.items, [{ id: id(1), at: T0 - 5e3 }, { id: id(2), at: T0 - 4e3, forgot: true }], 'hidden: { id, at, forgot }');
  eq(rowOf('names').items, [{ id: id(1), name: 'parity work' }, { id: id(3), name: null }], 'names: { id, name }, null kept');
  eq(rowOf('moved').items, [{ id: id(4), root: { origin: ORIGIN_FV, name: 'fleet-view' }, at: T0 - 3e3 }, { id: id(5), root: null, at: T0 - 3e3 }], 'moved: roots made { origin, name }');
  eq(rowOf('hiddenRepos').items, [{ root: { origin: null, name: 'pc-only' }, at: T0 - 2e3 }], 'hiddenRepos: a root with no origin goes by its name');
  eq(rowOf('repoOrder').items, [{ origin: ORIGIN_DF, name: 'detailforge-web' }, { origin: ORIGIN_FV, name: 'fleet-view' }], 'repoOrder: in order');
  eq(rowOf('mapSpots').items, [
    { repo: { origin: ORIGIN_DF, name: 'detailforge-web' }, x: 100, y: 200, pin: true },
    { id: `s:${id(1)}`, x: 30, y: 40, pin: true },
  ], 'mapSpots: pinned ones only, a repo\'s spot by repo, the stale Mac-path one left out (the repo this machine has wins), a conversation\'s as it is');
  ok(pcSet.mapSpots.some((s) => s.id === 'r:z:\\scratch\\pc-only' && !s.pin), 'an unpinned spot stays here (never goes up)');
  ok(!pcSet.mapSpots.some((s) => s.id.startsWith('r:\\users')) && pcSet.mapSpots.some((s) => s.id === 'r:z:\\github\\detailforge-web' && s.x === 100), 'the stale spot is mended here too (first join puts the items through the translation)');
  ok(!('seenAt' in rowOf('teams').items[0]) && rowOf('teams').items[0].members.length === 2, 'teams: as kept, less seenAt');
  ok(!JSON.stringify(db).includes('parity work') && !JSON.stringify(db).includes('fleet-view'), 'nothing reaches the table in the clear');
  ok(store.pc && store.pc.device === PC && Object.keys(store.pc.groups).length === P.GROUP_NAMES.length, 'what it agreed on is saved');
  const pcWrites0 = posts().length;
  step(5e3);
  await pc.tick();
  eq(posts().length, pcWrites0, 'nothing changed: nothing written');
  // the PC hides id(10) and names id(40), then takes both out: the rows keep their tombstones
  pcSet.hidden = pcSet.hidden.concat([{ id: id(10), at: T0 + 1e3, forgot: false }]);
  pcSet.names = pcSet.names.concat([{ id: id(40), name: 'old' }]);
  step(5e3); await pc.tick();
  pcSet.hidden = pcSet.hidden.filter((h) => h.id !== id(10));
  pcSet.names = pcSet.names.filter((n) => n.id !== id(40));
  step(5e3); await pc.tick();
  ok((rowOf('hidden').gone || []).some(([k]) => k === id(10)) && (rowOf('names').gone || []).some(([k]) => k === id(40)), 'a removal leaves a tombstone in the row');

  // ---------- the Mac's first join ----------
  const hrTaken = rowOf('hiddenRepos').at;
  await mac.tick();
  ok(applied.mac.includes('hidden') && applied.mac.includes('mapSpots'), 'the Mac takes the rows');
  eq(macSet.hidden.map((h) => h.id).sort(), [id(1), id(2), id(9), id(13)], 'first join: the rows joined with the Mac\'s own');
  ok(macSet.hidden.some((h) => h.id === id(13)), 'D2 first join: a local-only item older than the row, that no tombstone names, is kept (a fresh join loses nothing)');
  ok(!macSet.hidden.some((h) => h.id === id(10)), 'D2 first join: a local-only item the row\'s tombstone took out after its time is not put back');
  eq(macSet.names, [{ id: id(1), name: 'parity work' }, { id: id(3), name: null }], 'D2 first join: the row wins on the same key, and a local item with no time that a tombstone names is the row\'s to say');
  ok(macLogs.some((t) => /first join/.test(t)), 'D2: said as this device\'s first join');
  ok(macSet.hidden.find((h) => h.id === id(2)).forgot === true, 'forgot comes along');
  eq(macSet.moved.find((m) => m.id === id(4)).root, MACR.fv, 'a move lands on the Mac\'s folder for that repo');
  eq(macSet.pinOverrides.slice().sort((a, b) => (a.id < b.id ? -1 : 1)), [
    { id: id(6), mode: 'free', host: 'BlackBox', hostDevice: PC, at: T0 - 1e3 }, { id: id(7), mode: 'stay', host: 'Mac', at: T0 - 1e3 },
    { id: id(8), mode: 'stay', host: 'BlackBox', at: T0 + 60e3 },
  ], 'pinOverrides: the PC\'s choices joined with the Mac\'s own (device ids in lower case)');
  eq(macSet.repoNames, [{ root: MACR.df, name: 'DF web' }], 'a workspace name lands on the Mac\'s folder');
  eq(macSet.repoOrder, [MACR.df, MACR.fv], 'the order, on the Mac\'s folders');
  eq(macSet.hiddenRepos.map((h) => h.root), [MACR.notes], 'a repo the Mac does not have (pc-only) is not put in');
  ok(macSet.mapSpots.some((s) => s.id === 'r:\\users\\henry\\documents\\github\\detailforge-web' && s.x === 100 && s.pin) && macSet.mapSpots.some((s) => s.id === 'r:\\users\\henry\\notes'), 'the PC\'s spot lands under the Mac\'s root id, the Mac\'s own kept');
  v = rowOf('hiddenRepos');
  ok(v.device === MAC && v.items.some((h) => h.root.name === 'pc-only') && v.items.some((h) => h.root.name === 'notes'), 'the Mac writes the join back, the pc-only repo riding along');
  ok(v.at > hrTaken, 'its at is past the row it took (never this machine\'s clock alone)');

  // ---------- the PC takes the Mac's join ----------
  step(10e3);
  applied.pc.length = 0;
  await pc.tick();
  eq(pcSet.hidden.map((h) => h.id).sort(), [id(1), id(2), id(9), id(13)], 'the PC takes the Mac\'s hidden');
  eq(pcSet.hiddenRepos.map((h) => h.root), [PCR.only], 'the PC keeps its pc-only repo, and the Mac\'s notes (no folder here) is not put in');
  ok(rowOf('hiddenRepos').items.some((h) => h.root.name === 'notes'), 'but the row still has notes');
  const pcWrites1 = posts().length;
  step(5e3); await pc.tick();
  step(5e3); await mac.tick();
  step(5e3); await pc.tick();
  eq(posts().length, pcWrites1, 'both agree: nothing more is written');

  // ---------- one side's change reaches the other ----------
  pcSet.hidden = pcSet.hidden.filter((h) => h.id !== id(9)); // shown again on the PC
  pcSet.names = pcSet.names.filter((n) => n.id !== id(1)).concat([{ id: id(1), name: 'parity, done' }]);
  step(5e3); await pc.tick();
  ok(!rowOf('hidden').items.some((h) => h.id === id(9)) && rowOf('hidden').device === PC, 'a delete on the PC goes up');
  step(10e3); await mac.tick();
  ok(!macSet.hidden.some((h) => h.id === id(9)), '...and the Mac drops it');
  eq(macSet.names.find((n) => n.id === id(1)).name, 'parity, done', 'a rename on the PC reaches the Mac');
  macSet.moved = macSet.moved.map((m) => (m.id === id(5) ? { id: id(5), root: MACR.df, at: macClock.t } : m));
  macSet.hiddenRepos = macSet.hiddenRepos.concat([{ root: MACR.fv, at: macClock.t }]);
  step(5e3); await mac.tick();
  step(10e3); await pc.tick();
  eq(pcSet.moved.find((m) => m.id === id(5)).root, PCR.df, 'a move on the Mac reaches the PC, on its folder');
  eq(pcSet.hiddenRepos.map((h) => h.root).sort(), [PCR.fv, PCR.only].sort(), 'a workspace hidden on the Mac is hidden on the PC (its pc-only one kept)');

  // ---------- own rows, other clocks ----------
  const takenMac = mac.status().taken;
  step(10e3); await mac.tick();
  eq(mac.status().taken, takenMac, 'the Mac never takes its own row');
  // a third device whose clock is far behind writes hidden: an older at, still taken
  const old = rowOf('hidden');
  db.find((r) => r.key === 'prefs:hidden').value_enc = K.sealText(JSON.stringify({ v: 1, device: THIRD, at: 5, items: [...old.items, { id: id(7), at: 4 }] }), KEY, 'setting:prefs:hidden');
  db.find((r) => r.key === 'prefs:hidden').updated_at = new Date(5).toISOString();
  step(10e3); await pc.tick();
  ok(pcSet.hidden.some((h) => h.id === id(7)), 'a row written with an older at (another clock) is still taken');

  // ---------- both changed at once ----------
  step(10e3); await mac.tick(); // the Mac has id(7) too
  pcSet.hidden = pcSet.hidden.filter((h) => h.id !== id(1)).concat([{ id: id(11), at: T0 + 1, forgot: false }]); // PC: drops 1, adds 11
  macSet.hidden = macSet.hidden.concat([{ id: id(12), at: T0 + 2, forgot: false }]); // Mac: adds 12
  step(5e3); await mac.tick(); // the Mac writes first
  ok(rowOf('hidden').items.some((h) => h.id === id(12)), 'the Mac\'s add is up');
  step(1e3); await pc.tick(); // the PC lists before it writes, and merges
  let ids = pcSet.hidden.map((h) => h.id);
  ok(ids.includes(id(11)) && ids.includes(id(12)) && !ids.includes(id(1)), 'both changed: merged item by item (the PC\'s add, the Mac\'s add, the PC\'s drop)');
  ids = rowOf('hidden').items.map((h) => h.id);
  ok(rowOf('hidden').device === PC && ids.includes(id(11)) && ids.includes(id(12)) && !ids.includes(id(1)), '...and the merge goes up');
  step(10e3); await mac.tick();
  ids = macSet.hidden.map((h) => h.id);
  ok(ids.includes(id(11)) && ids.includes(id(12)) && !ids.includes(id(1)), '...and the Mac takes it');

  // ---------- throttle ----------
  const w0 = posts().length;
  pcSet.names = pcSet.names.concat([{ id: id(20), name: 'one' }]);
  step(5e3); await pc.tick();
  eq(posts().length, w0 + 1, 'a change goes out');
  pcSet.names = pcSet.names.concat([{ id: id(21), name: 'two' }]);
  step(1e3); await pc.tick();
  eq(posts().length, w0 + 1, 'another 1 s later waits (at most one write of a group every 3 s)');
  step(2e3); await pc.tick();
  eq(posts().length, w0 + 2, '...and goes out 3 s after the last one');

  // ---------- an item that does not translate keeps this machine's own ----------
  // the Mac moves id(4) to notes (the PC has no notes folder): the PC keeps its own move of id(4)
  step(10e3); await mac.tick();
  macSet.moved = macSet.moved.map((m) => (m.id === id(4) ? { id: id(4), root: MACR.notes, at: macClock.t } : m));
  step(5e3); await mac.tick();
  const w1 = posts().length;
  step(10e3); await pc.tick();
  eq(pcSet.moved.find((m) => m.id === id(4)).root, PCR.fv, 'a move to a folder this machine lacks: this machine\'s own move of it stays');
  step(5e3); await pc.tick();
  step(10e3); await mac.tick();
  eq(posts().length, w1, '...and nothing goes back and forth over it');

  // ---------- teams, repoOrder ----------
  step(10e3); await mac.tick();
  ok(macSet.teams.length === 1 && !('seenAt' in macSet.teams[0]), 'a team reaches the Mac (fleet-view.js keeps its own seenAt)');
  pcSet.teams = pcSet.teams.map((t) => ({ ...t, seenAt: pcClock.t + 99 }));
  const w2 = posts().length;
  step(5e3); await pc.tick();
  eq(posts().length, w2, 'seenAt moving writes nothing');
  pcSet.repoOrder = [PCR.fv, PCR.df];
  macSet.repoOrder = [MACR.df, MACR.fv, MACR.notes];
  step(5e3); await mac.tick();
  step(1e3); await pc.tick();
  eq(pcSet.repoOrder, [PCR.fv, PCR.df], 'repoOrder changed on both: this machine\'s whole order wins');
  eq(P.union('repoOrder', [{ origin: null, name: 'a' }, { origin: null, name: 'b' }], [{ origin: null, name: 'c' }, { origin: null, name: 'a' }]).map((r) => r.name), ['c', 'a', 'b'], 'union of an order (a group new to a device that syncs): this machine\'s, the row\'s others woven in where they stand');
  const ord = (n) => ({ origin: null, name: n }), okey = (n) => String(P.GROUPS.repoOrder.key(ord(n)));
  eq(P.join('repoOrder', [ord('b'), ord('d')], [ord('a'), ord('b'), ord('c'), ord('e')], new Map([[okey('e'), 3]])).map((r) => r.name), ['a', 'b', 'c', 'd'],
    'D2 join of an order: the row\'s, this machine\'s others woven in where they stand, one a tombstone names (no time) left out');
  eq(P.join('hidden', [{ id: id(1), at: 10 }], [{ id: id(1), at: 99 }, { id: id(2), at: 4 }, { id: id(3), at: 11 }, { id: id(4), at: 2 }], new Map([[id(2), 5], [id(3), 6]])),
    [{ id: id(1), at: 10 }, { id: id(3), at: 11 }, { id: id(4), at: 2 }], 'D2 join: the row\'s item on its key; a local one kept unless a tombstone newer than its time names it');
  eq(P.join('hidden', [], [{ id: id(4), at: 2 }]), [{ id: id(4), at: 2 }], 'D2 join with no tombstones (a fresh sync, a new key): nothing local is lost');

  // ---------- sets, unpinned spots ----------
  step(10e3); await pc.tick();
  step(10e3); await mac.tick();
  const w4 = posts().length;
  pcSet.hidden = [...pcSet.hidden].reverse();
  pcSet.mapSpots = [...pcSet.mapSpots].reverse().map((s) => (s.pin ? s : { ...s, x: s.x + 9 })); // the spacing rule nudged the unpinned ones
  step(5e3); await pc.tick();
  eq(posts().length, w4, 'a set saved in another order, or unpinned spots moved: nothing written');
  pcSet.mapSpots = pcSet.mapSpots.map((s) => (s.id === 'r:z:\\github\\detailforge-web' ? { ...s, x: 111 } : s));
  step(5e3); await pc.tick();
  step(10e3); await mac.tick();
  ok(macSet.mapSpots.some((s) => s.id === 'r:\\users\\henry\\documents\\github\\detailforge-web' && s.x === 111 && s.pin), 'a pinned spot dragged on the PC reaches the Mac');
  ok(macSet.mapSpots.some((s) => s.id === 'r:\\users\\henry\\notes' && !s.pin), '...and the Mac\'s unpinned spot stays');

  // ---------- a repo that turns up later ----------
  const ORIGIN_LATER = 'GLODUSK/later';
  MACR.later = '/Users/henry/Documents/github/later';
  originsOf[MACR.later] = ORIGIN_LATER;
  macSet.hiddenRepos = macSet.hiddenRepos.concat([{ root: MACR.later, at: macClock.t }]);
  macSet.repoNames = macSet.repoNames.concat([{ root: MACR.later, name: 'Later' }]);
  step(5e3); await mac.tick();
  step(10e3); await pc.tick();
  ok(!pcSet.hiddenRepos.some((h) => /later/.test(h.root)), 'a workspace the PC lacks is not put in there');
  ok(store.pc.groups.hiddenRepos.ride.includes(`o:${ORIGIN_LATER.toLowerCase()}`), '...it rides along');
  const w5 = posts().length;
  PCR.later = 'Z:\\Github\\later';
  originsOf[PCR.later] = ORIGIN_LATER;
  step(5e3); await pc.tick();
  ok(pcSet.hiddenRepos.some((h) => h.root === PCR.later) && pcSet.repoNames.some((n) => n.root === PCR.later && n.name === 'Later'), 'once the repo turns up on the PC, its hide and name are put in there');
  eq(posts().length, w5, '...and nothing is written (nothing else changed here)');
  ok(rowOf('hiddenRepos').items.some((h) => h.root.origin === ORIGIN_LATER) && rowOf('repoNames').items.some((n) => n.root.origin === ORIGIN_LATER), '...the rows still have them');
  step(10e3); await mac.tick();
  ok(macSet.hiddenRepos.some((h) => h.root === MACR.later) && macSet.repoNames.some((n) => n.root === MACR.later), '...and the Mac keeps them (never taken for a delete)');
  pcSet.repoNames = pcSet.repoNames.filter((n) => n.root !== PCR.later);
  step(5e3); await pc.tick();
  step(10e3); await mac.tick();
  ok(!macSet.repoNames.some((n) => n.root === MACR.later), 'a name the PC then clears is cleared on the Mac');

  // ---------- both write at once ----------
  step(10e3); await pc.tick();
  step(10e3); await mac.tick();
  pcSet.names = pcSet.names.concat([{ id: id(30), name: 'pc at once' }]);
  macSet.names = macSet.names.concat([{ id: id(31), name: 'mac at once' }]);
  step(5e3);
  api.onList = () => pc.tick(); // the PC writes between the Mac's list and the Mac's write
  await mac.tick();
  ok(rowOf('names').device === MAC && !rowOf('names').items.some((n) => n.id === id(30)), 'the Mac wrote over the PC\'s write (it had not seen it)');
  step(10e3); await pc.tick();
  ok(pcSet.names.some((n) => n.id === id(30)) && pcSet.names.some((n) => n.id === id(31)), 'the PC keeps its write and takes the Mac\'s');
  ok(rowOf('names').device === PC && rowOf('names').items.some((n) => n.id === id(30)) && rowOf('names').items.some((n) => n.id === id(31)), '...and writes both back');
  const f1 = fetches();
  step(10e3); await pc.tick();
  eq(fetches(), f1, 'its own write is not fetched back (+00:00 and Z are one time)');
  step(10e3); await mac.tick();
  ok(macSet.names.some((n) => n.id === id(30)) && macSet.names.some((n) => n.id === id(31)), '...and the Mac has both');
  const w6 = posts().length;
  step(10e3); await pc.tick();
  step(10e3); await mac.tick();
  eq(posts().length, w6, '...and nothing more goes back and forth');

  // ---------- a bad row ----------
  const BADKEY = crypto.randomBytes(32);
  db.find((r) => r.key === 'prefs:mapSpots').value_enc = K.sealText(JSON.stringify({ v: 1, device: THIRD, at: 9, items: [] }), BADKEY, 'setting:prefs:mapSpots');
  db.find((r) => r.key === 'prefs:mapSpots').updated_at = 'x1';
  const spots = JSON.stringify(macSet.mapSpots);
  step(10e3); await mac.tick();
  step(10e3); await mac.tick();
  eq(JSON.stringify(macSet.mapSpots), spots, 'a row sealed with another key is ignored');
  eq(macLogs.filter((t) => /mapSpots row does not open/.test(t)).length, 1, '...said once');

  // ---------- a write that fails ----------
  api.offline = true;
  pcSet.names = pcSet.names.concat([{ id: id(22), name: 'offline' }]);
  const before = pcLogs.length;
  step(5e3); await pc.tick();
  step(5e3); await pc.tick();
  eq(pcLogs.slice(before).filter((t) => /could not be (listed|written)/.test(t)).length, 1, 'Supabase out of reach: said once');
  api.offline = false;
  step(5e3); await pc.tick();
  ok(rowOf('names').items.some((n) => n.id === id(22)), '...and it goes out once Supabase is back');

  // ---------- a restart ----------
  await pc.stop();
  step(10e3); await mac.tick();
  const w3 = posts().length, takenBefore = applied.pc.length;
  pc = mkPc();
  step(1e3); await pc.tick();
  eq(posts().length, w3, 'restarted with its saved state: nothing written');
  eq(applied.pc.length, takenBefore, '...and nothing taken again');
  // a change made while it was off (in the saved settings): goes up, never comes back from the row
  await pc.stop();
  pcSet.names = pcSet.names.filter((n) => n.id !== id(20));
  pc = mkPc();
  step(5e3); await pc.tick();
  ok(!rowOf('names').items.some((n) => n.id === id(20)) && !pcSet.names.some((n) => n.id === id(20)), 'a delete made while it was off goes up, not back');
  // a saved state of another device: a first join (a join, so nothing here is lost and nothing deleted comes back blindly)
  await pc.stop();
  store.pc = { ...store.pc, device: THIRD };
  applied.pc.length = 0;
  pc = mkPc();
  step(5e3); await pc.tick();
  ok(applied.pc.length === P.GROUP_NAMES.length - 1 && !applied.pc.includes('mapSpots'), 'a saved state of another device: every group joined again, but the row that does not open');
  ok(K.openText(db.find((r) => r.key === 'prefs:mapSpots').value_enc, BADKEY, 'setting:prefs:mapSpots'), '...which a first join never writes over');
  // that row gone: the group goes up again
  db.splice(db.findIndex((r) => r.key === 'prefs:mapSpots'), 1);
  step(10e3); await pc.tick();
  ok(rowOf('mapSpots') && rowOf('mapSpots').device === pcDevice, 'the row that did not open gone: this machine\'s go up');

  // ---------- fetched only when updated_at moved ----------
  const f0 = fetches();
  for (let i = 0; i < 10; i++) { step(10e3); await mac.tick(); await pc.tick(); }
  ok(fetches() - f0 <= 2, `nothing moved: values not fetched again (${fetches() - f0} fetches)`);

  // ---------- sync-run.js wiring ----------
  {
    const dir = fs.mkdtempSync(path.join(process.env.SYNC_TEST_DIR || os.tmpdir(), 'fv-sync-prefs-'));
    try {
      await K.saveKey(S.syncDir(dir), crypto.randomBytes(32));
      const sync = { enabled: () => true, status: async () => ({ configured: true, signedIn: true, member: true, email: 'a@b.c' }), uid: async () => 'u1', onChange: () => () => {} };
      const loop = () => ({ start() {}, async stop() {}, status: () => ({}), conflicts: () => [], owners: () => new Map() });
      let moverDevice = null;
      const mover = { start() {}, async stop() {}, owners: () => new Map(), device: () => moverDevice };
      const made = [];
      const fakePrefs = (a) => {
        const x = { a, started: 0, stopped: 0, nudged: 0, start() { x.started++; }, async stop() { x.stopped++; }, nudge() { x.nudged++; }, status: () => ({ ready: true }) };
        made.push(x);
        return x;
      };
      const groups = { hidden: [] }, got = [];
      const prefs = { read: () => groups, apply: (g, items) => got.push([g, items]), translate: trPc, load: () => 'L', save: () => 'S' };
      const runner = createSyncRunner({ sync, dataDir: dir, checkMs: 1e6, makeUploader: loop, makeMaterializer: loop, makeMover: () => mover, makePrefs: fakePrefs, prefs });
      runner.prefsChanged(); // not running: nothing
      await runner.start();
      const x = made[0];
      ok(made.length === 1 && x.started === 1, 'the prefs loop starts with the run');
      ok(x.a.api === sync && x.a.key.length === 32 && x.a.read() === groups && x.a.translate === trPc && x.a.load() === 'L' && x.a.save() === 'S', 'it gets the api, the key, read, translate, load and save');
      x.a.apply('hidden', [1]);
      eq(got, [['hidden', [1]]], 'apply goes to fleet-view.js\'s');
      ok(x.a.device() === null, 'no device id until the mover has one');
      moverDevice = { id: PC, name: 'pc' };
      ok(x.a.device() === PC, 'then the mover\'s device id');
      runner.prefsChanged();
      ok(x.nudged === 1, 'prefsChanged() nudges it');
      ok(runner.status().prefs && runner.status().prefs.ready === true, 'status() has its status');
      await runner.stop();
      ok(x.stopped === 1, 'stop() stops it');
      const r2 = createSyncRunner({ sync, dataDir: dir, checkMs: 1e6, makeUploader: loop, makeMaterializer: loop, makeMover: () => mover, makePrefs: fakePrefs });
      await r2.start();
      ok(made.length === 1, 'no prefs given: no prefs loop');
      r2.prefsChanged();
      await r2.stop();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }

  // ---------- hostRules: where a kind of work stays ----------
  const rule = { id: 'configurator-3d', repo: { origin: 'GLODUSK/detailforge-web', name: 'detailforge-web' }, paths: ['assets/vehicles/**', '**/*.blend'], tools: ['mcp__blender*'], host: 'BlackBox', note: 'meshes on BlackBox' };
  eq(P.cleanHostRule(rule), rule, 'hostRules: a whole rule is kept as it is');
  eq(P.cleanHostRule({ ...rule, repo: null, tools: [] }), { ...rule, repo: null, tools: [] }, 'hostRules: no repo (any repo) and paths only');
  ok([{ ...rule, host: '' }, { ...rule, paths: [], tools: [] }, { ...rule, id: 'Bad Id' }, { ...rule, repo: { origin: 'has space' } }, null, 'x'].every((x) => P.cleanHostRule(x) === null),
    'hostRules: no host, nothing to match, a bad id or a bad repo is no rule');
  eq(P.cleanHostRule({ ...rule, tools: ['ok_tool', 'bad tool', 'x;rm'], paths: ['a\nb', 'c/**'] }).tools, ['ok_tool'], 'hostRules: only plain tool names');
  ok(P.GROUP_NAMES.includes('hostRules') && P.GROUPS.hostRules.in(P.GROUPS.hostRules.out(rule).p) && P.GROUPS.hostRules.out(rule).known === true, 'hostRules: a shared group, portable as it is');
  eq(P.cleanHostRule({ ...rule, hostDevice: PC.toUpperCase(), pinOn: 'edits' }), { id: rule.id, repo: rule.repo, paths: rule.paths, tools: rule.tools, host: rule.host, hostDevice: PC, pinOn: 'edits', note: rule.note }, 'hostRules: hostDevice (lower case) and pinOn are kept');
  eq(P.cleanHostRule({ ...rule, hostDevice: 'BlackBox', pinOn: 'any' }), rule, 'hostRules: a hostDevice that is no device id, and the default pinOn, are left out');
  eq(P.cleanHostRule({ ...rule, pinOn: 'sometimes' }), rule, 'hostRules: an unknown pinOn is the default');
  eq(['edits', 'tools', 'none'].map((x) => P.cleanHostRule({ ...rule, pinOn: x }).pinOn), ['edits', 'tools', 'none'], 'hostRules: every pinOn');

  // ---------- pinOverrides: a chat's own choice ----------
  eq(P.cleanPinOverride({ id: id(1).toUpperCase(), mode: 'free', at: 5 }), { id: id(1), mode: 'free', at: 5 }, 'pinOverrides: free with no host');
  eq(P.cleanPinOverride({ id: id(1), mode: 'stay', host: ' BlackBox ', hostDevice: MAC, at: 5, extra: 1 }), { id: id(1), mode: 'stay', host: 'BlackBox', hostDevice: MAC, at: 5 }, 'pinOverrides: stay with its host');
  ok([{ id: id(1), mode: 'stay', at: 5 }, { id: 'x', mode: 'free', at: 5 }, { id: id(1), mode: 'clear', at: 5 }, { id: id(1), mode: 'free' }, null].every((x) => P.cleanPinOverride(x) === null),
    'pinOverrides: stay with no host, a bad id, an unknown mode or no time is no choice');
  eq(P.cleanPinOverride({ id: id(1), mode: 'free', hostDevice: MAC, at: 5 }), { id: id(1), mode: 'free', at: 5 }, 'pinOverrides: no hostDevice without a host');
  ok(P.GROUP_NAMES.includes('pinOverrides') && P.GROUPS.pinOverrides.key({ id: id(1) }) === id(1), 'pinOverrides: a shared group, one per chat');
  // ---------- dynamicChats: a chat's Dynamic parts ----------
  eq(P.cleanDynamicChat({ id: id(2).toUpperCase(), model: true, effort: false, at: 5, x: 1 }), { id: id(2), model: true, effort: false, at: 5 }, 'dynamicChats: an id in lower case and the two parts');
  ok(P.cleanDynamicChat({ id: id(2), model: false, effort: false, at: 5 }) === null && P.cleanDynamicChat({ id: 'x', model: true, at: 5 }) === null && P.cleanDynamicChat({ id: id(2), model: 'yes', effort: true }) === null,
    'dynamicChats: neither part, a bad id or no time is nothing');
  ok(P.GROUP_NAMES.includes('dynamicChats') && P.GROUPS.dynamicChats.key({ id: id(2) }) === id(2), 'dynamicChats: a shared group, one per chat');

  // ---------- colours: a workspace's and a conversation's (repoHues, sessHues) ----------
  const FV = { origin: ORIGIN_FV, name: 'fleet-view' };
  eq(P.GROUPS.repoHues.clean({ root: FV, hue: 572.4, at: 9, x: 1 }), { root: FV, hue: 212, at: 9 }, 'repoHues: a tone round the wheel, a whole number');
  eq(P.GROUPS.repoHues.clean({ root: FV, hue: -8 }), { root: FV, hue: 352 }, 'repoHues: a tone below 0 comes round, at left out when none');
  ok([{ root: FV, hue: 'red' }, { root: { name: 'a/b' }, hue: 3 }, { root: FV }, null].every((x) => P.GROUPS.repoHues.clean(x) === null), 'repoHues: no tone or a bad root is nothing');
  eq(P.GROUPS.sessHues.clean({ id: id(50).toUpperCase(), hue: 8, at: 4 }), { id: id(50), hue: 8, at: 4 }, 'sessHues: an id in lower case');
  ok([{ id: 'x', hue: 3 }, { id: id(50), hue: null }, { id: id(50) }].every((x) => P.GROUPS.sessHues.clean(x) === null), 'sessHues: a bad id or no tone is nothing');
  {
    // the PC colours fleet-view blue and a conversation red: the Mac shows both, the workspace on its own folder
    const t1 = pcClock.t;
    pcSet.repoHues = [{ root: PCR.fv, hue: 212, at: t1 }];
    pcSet.sessHues = [{ id: id(50), hue: 8, at: t1 }];
    step(5e3); await pc.tick();
    eq(rowOf('repoHues').items, [{ root: FV, hue: 212, at: t1 }], 'repoHues: goes up with its root made { origin, name }');
    eq(rowOf('sessHues').items, [{ id: id(50), hue: 8, at: t1 }], 'sessHues: goes up as it is');
    step(10e3); await mac.tick();
    eq(macSet.repoHues, [{ root: MACR.fv, hue: 212, at: t1 }], 'a workspace coloured on the PC is that colour on the Mac, on its folder');
    eq(macSet.sessHues, [{ id: id(50), hue: 8, at: t1 }], 'a conversation coloured on the PC is that colour on the Mac');
    // back to Default on the Mac: the PC follows
    macSet.sessHues = [];
    step(5e3); await mac.tick();
    step(10e3); await pc.tick();
    eq(pcSet.sessHues, [], 'Default on the Mac: the conversation follows its workspace again on the PC');
    // both at once: the Mac takes the workspace back to Default while the PC, later, picks green: the later pick stays
    macSet.repoHues = [];
    step(5e3); await mac.tick();
    pcSet.repoHues = [{ root: PCR.fv, hue: 120, at: pcClock.t }];
    step(5e3); await pc.tick();
    eq(pcSet.repoHues.map((x) => x.hue), [120], 'a pick made after a Default elsewhere stays');
    step(10e3); await mac.tick();
    eq(macSet.repoHues.map((x) => [x.root, x.hue]), [[MACR.fv, 120]], '...and reaches the Mac');
    // a workspace the Mac has no checkout of rides along, and comes back to the PC untouched
    pcSet.repoHues = pcSet.repoHues.concat([{ root: PCR.only, hue: 44, at: pcClock.t }]);
    step(5e3); await pc.tick();
    step(10e3); await mac.tick();
    ok(!macSet.repoHues.some((x) => /pc-only/.test(x.root)) && rowOf('repoHues').items.some((x) => x.root.name === 'pc-only'), 'a colour for a workspace the Mac lacks is not put in there, but stays in the row');
  }

  // ---------- "Start clean" (fleet-view.js freshBeforeStart): every group emptied but its local-only items, no saved
  // state: the first join takes the rows' items as they are, keeps the local-only ones and writes nothing back ----------
  {
    const FRESH = '44444444-4444-4444-8444-444444444444';
    const freshSet = machine();
    const unpinned = { id: 'r:z:\\scratch\\fresh-only', x: 3, y: 4, pin: false };
    freshSet.mapSpots = [unpinned];
    let freshStore = null;
    // Blackbox's order has a repo this machine lacks (notes) in the middle: it stays there, nothing is written back
    const seal = (g, items, k = KEY) => ({ key: `prefs:${g}`, value_enc: K.sealText(JSON.stringify({ v: 1, device: MAC, at: pcClock.t, after: null, items }), k, `setting:prefs:${g}`), updated_at: new Date(pcClock.t).toISOString() });
    const order = [{ origin: ORIGIN_DF, name: 'detailforge-web' }, { origin: null, name: 'notes' }, { origin: ORIGIN_FV, name: 'fleet-view' }];
    const setRow = (r) => { const i = db.findIndex((x) => x.key === r.key); if (i >= 0) db[i] = r; else db.push(r); };
    setRow(seal('repoOrder', order));
    // a row this key can't open (a newer version's): never written over by the first join
    const badMoved = seal('moved', [], crypto.randomBytes(32));
    setRow(badMoved);
    const fr = P.createPrefs({ api, key: KEY, now: () => pcClock.t, device: () => FRESH, read: () => freshSet, apply: applier(freshSet, 'pc'), translate: trPc,
      load: () => freshStore, save: (s) => { freshStore = JSON.parse(JSON.stringify(s)); }, log: () => {} });
    const before = posts().length;
    step(20e3);
    await fr.tick();
    const rowKeys = (g) => rowOf(g).items.map((x) => P.GROUPS[g].key(x)).map(String).sort();
    const mineKeys = (g) => P.portable(g, freshSet[g], trPc).map((x) => P.GROUPS[g].key(x)).map(String).sort();
    for (const g of ['hidden', 'names', 'pinOverrides', 'teams', 'hostRules']) eq(mineKeys(g), rowKeys(g), `start clean: ${g} is the row's, exactly`);
    eq(freshSet.hidden.map((h) => h.id).sort(), rowOf('hidden').items.map((h) => h.id).sort(), 'start clean: the hidden list is Blackbox\'s');
    ok(freshSet.mapSpots.some((s) => s.id === unpinned.id && !s.pin), 'start clean: a local-only item (an unpinned spot) stays');
    eq(mineKeys('mapSpots'), rowOf('mapSpots').items.filter((p) => P.GROUPS.mapSpots.in(p, trPc)).map((p) => String(P.GROUPS.mapSpots.key(p))).sort(), 'start clean: the pinned spots are the row\'s that land here');
    eq(posts().slice(before).length, 0, 'start clean: nothing written back (the rows are taken as they are)');
    eq(freshSet.repoOrder, [PCR.df, PCR.fv], 'start clean: the order here is the row\'s, less a repo not here');
    eq(rowOf('repoOrder').items, order, 'start clean: a repo this machine lacks keeps its place in the order');
    eq(db.find((x) => x.key === 'prefs:moved').value_enc, badMoved.value_enc, 'a row that does not open is not written over by a first join');
    step(20e3);
    await fr.tick();
    eq(posts().slice(before).length, 0, 'start clean: the next round writes nothing either');
    ok(freshStore && Object.keys(freshStore.groups).length === P.GROUP_NAMES.length - 1 && !freshStore.groups.moved, 'start clean: every group agreed on with its row, but the one that does not open');
    await fr.stop();
  }

  await pc.stop();
  await mac.stop();

  // ---------- the parity review's fixes: each on a fresh pair (a fresh table, the Mac's clock 2 s behind) ----------
  const T1 = T0 + 30 * 86400e3;
  function pair() {
    db.length = 0;
    const A = machine(), B = machine(), ca = { t: T1 }, cb = { t: T1 - 2e3 }, sa = { s: null }, sb = { s: null };
    const mk = (set, clock, dev, tr, st) => P.createPrefs({ api, key: KEY, now: () => clock.t, device: () => dev, read: () => set, apply: (g, items) => { set[g] = JSON.parse(JSON.stringify(items)); },
      translate: tr, load: () => st.s, save: (s) => { st.s = JSON.parse(JSON.stringify(s)); }, log: () => {} });
    const step = (ms) => { ca.t += ms; cb.t += ms; };
    return { A, B, ca, cb, a: mk(A, ca, PC, trPc, sa), b: mk(B, cb, MAC, trMac, sb), step };
  }
  const DFP = 'r:z:\\github\\detailforge-web', DFM = 'r:\\users\\henry\\documents\\github\\detailforge-web';

  // D1: an unpin sticks
  {
    const X = pair();
    X.A.mapSpots = [{ id: DFP, x: 10, y: 20, pin: true, at: X.ca.t - 1e3 }];
    await X.a.tick(); X.step(10e3); await X.b.tick();
    ok(X.B.mapSpots.some((s) => s.id === DFM && s.pin && s.at === T1 - 1e3), 'D1: a pinned spot reaches the Mac with its at');
    // the Mac's page as the old web/map.js had it: a repo spot gone from the server's list is put back as the page
    // had it, and sent again
    const page = new Map();
    const pageRound = () => {
      for (const s of X.B.mapSpots) page.set(s.id, { ...s });
      for (const [sid, s] of page) if (!X.B.mapSpots.some((x) => x.id === sid)) X.B.mapSpots.push({ ...s });
    };
    pageRound();
    X.A.mapSpots = [{ id: DFP, x: 10, y: 20, pin: false, at: X.ca.t }];
    X.step(5e3); await X.a.tick();
    ok(rowOf('mapSpots').gone && rowOf('mapSpots').gone.some(([k]) => k === 'r:o:glodusk/detailforge-web'), 'D1: the unpin goes up as a tombstone in the row\'s gone');
    X.step(10e3); await X.b.tick();
    const m = X.B.mapSpots.find((s) => s.id === DFM);
    ok(m && m.pin === false && m.x === 10 && m.y === 20, 'D1: an unpin on the PC reaches the Mac as the same spot, unpinned (not a spot gone)');
    for (let i = 0; i < 3; i++) { pageRound(); X.step(5e3); await X.b.tick(); X.step(5e3); await X.a.tick(); }
    ok(X.A.mapSpots.every((s) => !s.pin) && X.B.mapSpots.every((s) => !s.pin), 'D1: ...and it sticks: no later round pins it again on either machine');
    // both at once: the Mac drags the pin (not sent yet), then the PC unpins it: the later unpin wins
    X.A.mapSpots = [{ id: DFP, x: 30, y: 40, pin: true, at: X.ca.t }];
    X.step(5e3); await X.a.tick(); X.step(10e3); await X.b.tick();
    ok(X.B.mapSpots.some((s) => s.id === DFM && s.pin && s.x === 30), 'D1: pinned again on the PC: the Mac has it');
    X.B.mapSpots = X.B.mapSpots.map((s) => (s.id === DFM ? { ...s, x: 99, at: X.cb.t } : s));
    X.step(2e3);
    X.A.mapSpots = [{ id: DFP, x: 30, y: 40, pin: false, at: X.ca.t }];
    await X.a.tick();
    X.step(1e3); await X.b.tick();
    X.step(10e3); await X.a.tick(); X.step(10e3); await X.b.tick();
    ok(X.B.mapSpots.every((s) => !s.pin) && X.A.mapSpots.every((s) => !s.pin), `D1: a drag on the Mac before the PC's unpin loses to it (${JSON.stringify(X.B.mapSpots)})`);
    // and the other way: a drag after the unpin wins (the pin was set again later)
    X.B.mapSpots = X.B.mapSpots.map((s) => (s.id === DFM ? { ...s, pin: true, x: 77, at: X.cb.t + 60e3 } : s));
    X.step(5e3); await X.b.tick(); X.step(10e3); await X.a.tick();
    ok(X.A.mapSpots.some((s) => s.id === DFP && s.pin && s.x === 77), 'D1: pinned again later on the Mac: the PC takes the new pin');
  }

  // D8: repoOrder keeps the other machine's repos in place
  {
    const X = pair();
    X.A.repoOrder = [PCR.df, PCR.fv];
    await X.a.tick(); X.step(10e3); await X.b.tick();
    X.B.repoOrder = [MACR.notes, MACR.df, MACR.fv];
    X.step(5e3); await X.b.tick(); X.step(10e3); await X.a.tick();
    eq(X.A.repoOrder, [PCR.df, PCR.fv], 'D8: the Mac-only repo is not put in on the PC');
    X.A.repoOrder = [PCR.fv, PCR.df];
    X.step(5e3); await X.a.tick();
    eq(rowOf('repoOrder').items.map((r) => r.name), ['notes', 'fleet-view', 'detailforge-web'], 'D8: a reorder on the PC keeps the Mac-only repo where it stood (not pushed to the end)');
    X.step(10e3); await X.b.tick();
    eq(X.B.repoOrder, [MACR.notes, MACR.fv, MACR.df], 'D8: ...and the Mac has it so');
    MACR.solo = '/Users/henry/solo';
    X.B.repoOrder = [MACR.solo, MACR.notes, MACR.fv, MACR.df];
    X.step(5e3); await X.b.tick();
    X.A.repoOrder = [PCR.df, PCR.fv];
    X.step(1e3); await X.a.tick();
    const names = rowOf('repoOrder').items.map((r) => r.name);
    eq(names, ['solo', 'notes', 'detailforge-web', 'fleet-view'], 'D8: reordered on both: the PC\'s order for its repos, the Mac\'s new repo kept in its place (not dropped)');
    X.step(10e3); await X.b.tick();
    eq(X.B.repoOrder, [MACR.solo, MACR.notes, MACR.df, MACR.fv], 'D8: ...and the Mac keeps both of its own');
    eq(P.mergeOrder('repoOrder', [{ name: 'a' }, { name: 'b' }, { name: 'c' }].map((r) => ({ origin: null, ...r })), [{ name: 'c' }, { name: 'b' }, { name: 'a' }].map((r) => ({ origin: null, ...r })),
      [{ name: 'a' }, { name: 'x' }, { name: 'c' }].map((r) => ({ origin: null, ...r }))).map((r) => r.name), ['c', 'a', 'x'], 'D8 mergeOrder: this order, less what the other took out (b), plus what it put in (x) after its neighbour');
  }

  // D4: team messages and successors merged field by field
  {
    const X = pair();
    const team = (msgs, succ = []) => ({ id: 't00000002', name: 'merge', color: '#ff9f43', members: [id(1), id(4)], lead: null, order: 'go', at: T1, messages: msgs, successors: succ });
    const base = Array.from({ length: 49 }, (_, i) => ({ t: T1 + i, from: id(1), to: id(4), text: `m${i}` }));
    X.A.teams = [team(base)];
    await X.a.tick(); X.step(10e3); await X.b.tick();
    const m1 = { t: T1 + 100, from: id(1), to: id(4), text: 'from the pc' }, m2 = { t: T1 + 101, from: id(4), to: id(1), text: 'from the mac' };
    const s1 = { from: id(1), to: id(5), at: T1 + 90 }, s2 = { from: id(4), to: id(6), at: T1 + 80 };
    X.B.teams = [{ ...team([...base, m2], [s2]), order: 'mac order' }];
    X.A.teams = [{ ...team([...base, m1], [s1]), name: 'pc name' }];
    X.step(5e3); await X.b.tick(); // the Mac writes first
    X.step(1e3); await X.a.tick(); // the PC lists, merges, writes
    X.step(10e3); await X.b.tick();
    for (const [who, set] of [['PC', X.A], ['Mac', X.B]]) {
      const t = set.teams[0], texts = t.messages.map((m) => m.text);
      ok(t.messages.length === 50 && texts.includes('from the pc') && texts.includes('from the mac') && !texts.includes('m0'), `D4: ${who} has both new messages, capped at 50 (the oldest out)`);
      ok(t.messages.every((m, i) => !i || t.messages[i - 1].t <= m.t) && new Set(texts).size === texts.length, `D4: ${who}'s messages in time order, one each`);
      eq(t.successors, [s2, s1], `D4: ${who} has both successors, in time order`);
      ok(t.name === 'pc name' && t.order === 'mac order', `D4: ${who}: each field from the side that changed it`);
    }
  }

  // the new shared groups: addedRepos, keepPins, parity
  {
    const X = pair();
    X.A.addedRepos = [{ root: PCR.fv, at: X.ca.t - 5e3 }, { root: PCR.only, at: X.ca.t - 5e3 }];
    X.A.keepPins = [{ root: PCR.df, branch: 'feat/keep', at: X.ca.t - 5e3 }];
    X.A.parity = [{ name: 'detailforge-web', web: ['app/'], app: ['mobile/'], core: ['packages/core/'] }];
    await X.a.tick(); X.step(10e3); await X.b.tick();
    eq(X.B.addedRepos, [{ root: MACR.fv, at: T1 - 5e3 }], 'addedRepos: an added repo the Mac has is added there (its folder); one it lacks rides along');
    ok(rowOf('addedRepos').items.some((r) => r.root.name === 'pc-only'), 'addedRepos: ...and stays in the row');
    eq(X.B.keepPins, [{ root: MACR.df, branch: 'feat/keep', at: T1 - 5e3 }], 'keepPins: a GitHub branch kept on the PC is kept on the Mac (its folder for that repo)');
    eq(X.B.parity, X.A.parity, 'parity: the rules reach the Mac');
    X.A.addedRepos = X.A.addedRepos.filter((r) => r.root !== PCR.fv);
    X.A.keepPins = [];
    X.step(5e3); await X.a.tick(); X.step(10e3); await X.b.tick();
    ok(!X.B.addedRepos.length && !X.B.keepPins.length, 'addedRepos, keepPins: a removal on the PC goes on the Mac');
  }

  // D6: the page sends single-item ops; the server applies them per item
  {
    eq(P.applyOps('hiddenRepos', [{ root: 'Z:\\a', at: 1 }, { root: 'Z:\\b', at: 2 }], [{ op: 'add', root: 'z:/C/', at: 3 }, { op: 'remove', root: 'z:\\A' }, { op: 'bogus', root: 'Z:\\b' }, null]),
      [{ root: 'Z:\\b', at: 2 }, { root: 'z:/C/', at: 3 }], 'D6 applyOps hiddenRepos: add and remove per item (roots in any case and slash), a bad op skipped');
    eq(P.applyOps('repoNames', [{ root: 'Z:\\a', name: 'A' }], [{ op: 'add', root: 'z:\\a', name: 'A2' }, { op: 'add', root: 'Z:\\b', name: '' }]), [{ root: 'z:\\a', name: 'A2' }], 'D6 applyOps repoNames: add replaces the same root, an empty name is no op');
    eq(P.applyOps('mapSpots', [{ id: 'r:x', x: 1, y: 2, pin: true, at: 5 }], [{ op: 'add', id: 's:1', x: 3, y: 4, pin: true }, { op: 'remove', id: 'r:x' }]), [{ id: 's:1', x: 3, y: 4, pin: true }], 'D6 applyOps mapSpots');
    eq(P.applyOps('repoOrder', ['Z:\\a', 'Z:\\b', 'Z:\\c'], [{ op: 'move', root: 'z:\\c', before: 'Z:\\a' }, { op: 'move', root: 'Z:\\a', before: null }, { op: 'add', root: 'Z:\\b' }, { op: 'add', root: 'Z:\\d', before: 'Z:\\b' }]),
      ['z:\\c', 'Z:\\d', 'Z:\\b', 'Z:\\a'], 'D6 applyOps repoOrder: move, add (once), add before');
    ok(P.applyOps('hiddenRepos', [], 'x') === null, 'D6 applyOps: not a list is null (the old whole-list key still works on its own)');
    const roots = Array.from({ length: 300 }, (_, i) => `Z:\\r${i}`);
    const capped = P.applyOps('repoOrder', roots, [{ op: 'add', root: 'Z:\\new' }, { op: 'move', root: 'Z:\\r299', before: 'Z:\\r0' }], 300);
    ok(capped.length === 300 && capped[capped.length - 1] === 'Z:\\new' && capped[0] === 'Z:\\r299' && !capped.includes('Z:\\r298'), 'applyOps with a cap: an add at the end of a full order is kept, the last root no op named goes');
    eq(P.applyOps('repoOrder', roots, [{ op: 'add', root: 'Z:\\new' }]).length, 301, 'applyOps without a cap: as before');
    const hid = Array.from({ length: 200 }, (_, i) => ({ root: `Z:\\h${i}`, at: 1000 + i }));
    const kept = P.newest(P.applyOps('hiddenRepos', hid, [{ op: 'add', root: 'Z:\\new', at: 5000 }]), 200);
    ok(kept.length === 200 && kept[kept.length - 1].root === 'Z:\\new' && !kept.some((h) => h.root === 'Z:\\h0') && kept[0].root === 'Z:\\h1', 'newest: a hidden repo added to a full list is kept, the oldest goes, in their order');
    eq(P.newest([{ at: 2 }, { at: 1 }], 5), [{ at: 2 }, { at: 1 }], 'newest: under the cap, as it is');
    // the page's own code (web/app.js), run here: a page that has not seen the Mac's newest change saves one of its own
    const appSrc = fs.readFileSync(path.join(ROOT, 'web', 'app.js'), 'utf8');
    const fnSrc = (src, name) => { const i = src.indexOf(`function ${name}(`); if (i < 0) return ''; const m = /\r?\n\}/.exec(src.slice(i)); return src.slice(i, i + m.index + m[0].length) + '\n'; };
    const norm = (r) => String(r).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
    const ctx = { hiddenRepos: new Map(), hiddenReposSeen: new Map(), hiddenReposSentAt: 0, repoNames: new Map(), repoNamesSeen: new Map(), repoNamesSentAt: 0, repoOrder: [], repoHues: new Map(), sessHues: new Map(), pendingSave: {}, sent: [], normRoot: norm };
    ctx.saveSettings = (o) => { ctx.sent.push(JSON.parse(JSON.stringify(o))); };
    vm.createContext(ctx);
    vm.runInContext(['saveHiddenRepos', 'syncHiddenRepos', 'saveRepoNames', 'syncHues', 'syncRepoPrefs'].map((n) => fnSrc(appSrc, n)).join(''), ctx);
    const serve = (list, body, kind) => (`${kind}Ops` in body ? P.applyOps(kind, list, body[`${kind}Ops`]) : body[kind]);
    let server = [{ root: 'Z:\\a', at: 1 }];
    vm.runInContext('syncHiddenRepos(' + JSON.stringify(server) + ')', ctx);
    server = [...server, { root: 'Z:\\mac-hid', at: 2 }]; // the Mac's hide reaches the server; the page has not polled since
    vm.runInContext('hiddenRepos.set(normRoot("Z:\\\\c"), { root: "Z:\\\\c", at: 3 }); saveHiddenRepos();', ctx);
    let body = ctx.sent[ctx.sent.length - 1];
    server = serve(server, body, 'hiddenRepos');
    eq((server || []).map((h) => h.root).sort(), ['Z:\\a', 'Z:\\c', 'Z:\\mac-hid'], 'D6: a page that missed the Mac\'s hide adds its own without undoing the Mac\'s (single-item ops, not the whole list)');
    vm.runInContext('hiddenRepos.delete(normRoot("Z:\\\\a")); saveHiddenRepos();', ctx);
    server = serve(server, ctx.sent[ctx.sent.length - 1], 'hiddenRepos');
    eq((server || []).map((h) => h.root).sort(), ['Z:\\c', 'Z:\\mac-hid'], 'D6: ...and a removal goes as one op');
    const n0 = ctx.sent.length;
    vm.runInContext('saveHiddenRepos();', ctx);
    eq(ctx.sent.length, n0, 'D6: nothing changed: nothing sent');
    let names = [{ root: 'Z:\\a', name: 'A' }];
    vm.runInContext('syncRepoPrefs({ repoNames: ' + JSON.stringify(names) + ' })', ctx);
    names = [...names, { root: 'Z:\\m', name: 'from the mac' }];
    vm.runInContext('repoNames.set(normRoot("Z:\\\\a"), { root: "Z:\\\\a", name: "A, renamed" }); saveRepoNames();', ctx);
    names = serve(names, ctx.sent[ctx.sent.length - 1], 'repoNames');
    eq(names, [{ root: 'Z:\\a', name: 'A, renamed' }, { root: 'Z:\\m', name: 'from the mac' }], 'D6: a rename from a stale page leaves the Mac\'s new name alone');
    // a colour that came from the other machine (repoHues / sessHues in /state's settings) is the page's on its next poll
    vm.runInContext('syncRepoPrefs({ repoHues: [{ root: "Z:\\\\a", hue: 212, at: 5 }], sessHues: [{ id: "aaaaaaaa-0000-4000-8000-000000000050", hue: 8, at: 5 }] })', ctx);
    ok(ctx.repoHues.get(norm('Z:\\a')) === 212 && ctx.sessHues.get('aaaaaaaa-0000-4000-8000-000000000050') === 8, 'colours from /state reach the page (syncHues)');
  }

  // D7: the page's "worked again" for a removed workspace is the server's: a prompt after it was removed (turnStart)
  {
    const appSrc = fs.readFileSync(path.join(ROOT, 'web', 'app.js'), 'utf8');
    const i = appSrc.indexOf('function repoIsHidden('), m = /\r?\n\}/.exec(appSrc.slice(i));
    const norm = (r) => String(r).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
    const ctx = { hiddenRepos: new Map([[norm('Z:\\w'), { root: 'Z:\\w', at: 1000 }]]), normRoot: norm, activeAt: (s) => (Number.isFinite(s.active) ? s.active : s.last || 0), state: { sessions: [] } };
    vm.createContext(ctx);
    vm.runInContext(appSrc.slice(i, i + m.index + m[0].length), ctx);
    ctx.state.sessions = [{ repo: { root: 'Z:\\w' }, active: 2000, last: 2000, turnStart: 500 }];
    ok(vm.runInContext('repoIsHidden("Z:\\\\w")', ctx) === true, 'D7: a conversation still replying from before the removal (active later, its turn began before) keeps it removed, as the server does');
    ctx.state.sessions = [{ repo: { root: 'Z:\\w' }, active: 2000, last: 2000, turnStart: 1500 }];
    ok(vm.runInContext('repoIsHidden("Z:\\\\w")', ctx) === false, 'D7: a prompt after the removal brings it back');
  }

  // D2: the first join is the first full read only. A group this device could not write then (no row yet), whose row
  // another device writes later, is joined as a device that already syncs the others joins one: its own wins on a key
  {
    const db2 = [];
    let failKey = 'prefs:names';
    const rest2 = async (method, table, o = {}) => {
      const q = o.query || {};
      if (method === 'GET') {
        const inList = /^in\.\((.*)\)$/.exec(q.key || '');
        const want = inList ? new Set(inList[1].split(',').map((k) => k.replace(/^"|"$/g, ''))) : null;
        const cols = String(q.select || '').split(',');
        return db2.filter((r) => !want || want.has(r.key)).map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])));
      }
      if (o.body.key === failKey) throw new S.SyncError('Supabase is out of reach', 0, 'network');
      const hit = db2.find((r) => r.key === o.body.key);
      if (hit) Object.assign(hit, o.body); else db2.push({ ...o.body });
      return null;
    };
    const seal = (g, row) => ({ key: `prefs:${g}`, value_enc: K.sealText(JSON.stringify(row), KEY, `setting:prefs:${g}`), updated_at: new Date(row.at).toISOString() });
    const T1 = T0 + 30 * 86400e3, clock = { t: T1 };
    db2.push(seal('hidden', { v: 1, device: MAC, at: T1 - 60e3, after: null, items: [{ id: id(51), at: T1 - 60e3 }] }));
    const third = machine();
    third.hidden = [{ id: id(52), at: T0, forgot: false }];
    third.names = [{ id: id(1), name: 'third\'s own' }];
    let st3 = null;
    const p3 = P.createPrefs({ api: { rest: rest2 }, key: KEY, now: () => clock.t, device: () => THIRD, read: () => third, apply: (g, items) => { third[g] = JSON.parse(JSON.stringify(items)); },
      translate: trPc, load: () => st3, save: (s) => { st3 = JSON.parse(JSON.stringify(s)); }, log: () => {} });
    await p3.tick();
    eq(third.hidden.map((h) => h.id).sort(), [id(51), id(52)], 'D2 first join: the row\'s and its own (no tombstone)');
    ok(!db2.some((r) => r.key === 'prefs:names'), 'its names could not be written');
    failKey = null;
    db2.push(seal('names', { v: 1, device: MAC, at: T1 + 1e3, after: null, items: [{ id: id(1), name: 'the mac\'s' }] }));
    clock.t += 60e3;
    await p3.tick();
    eq(third.names, [{ id: id(1), name: 'third\'s own' }], 'D2: a group joined after the first read goes by union(): its own wins on a key (firstEver ends with that read)');
  }

  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
