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
// Run: node scripts/sync-prefs-test.js   (exit 0 = all pass)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
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
  return { hidden: [], names: [], moved: [], hiddenRepos: [], repoNames: [], repoOrder: [], mapSpots: [], teams: [], hostRules: [], pinOverrides: [] };
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
macSet.pinOverrides = [{ id: id(8), mode: 'stay', host: 'BlackBox', at: T0 - 86400e3 }];
macSet.hidden = [{ id: id(9), at: T0 - 86400e3, forgot: false }];
macSet.hiddenRepos = [{ root: MACR.notes, at: T0 - 86400e3 }];
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

  // ---------- the Mac's first join ----------
  await mac.tick();
  ok(applied.mac.includes('hidden') && applied.mac.includes('mapSpots'), 'the Mac takes the rows');
  eq(macSet.hidden.map((h) => h.id).sort(), [id(1), id(2), id(9)], 'first join: the rows joined with the Mac\'s own');
  ok(macSet.hidden.find((h) => h.id === id(2)).forgot === true, 'forgot comes along');
  eq(macSet.moved.find((m) => m.id === id(4)).root, MACR.fv, 'a move lands on the Mac\'s folder for that repo');
  eq(macSet.pinOverrides.slice().sort((a, b) => (a.id < b.id ? -1 : 1)), [
    { id: id(6), mode: 'free', host: 'BlackBox', hostDevice: PC, at: T0 - 1e3 }, { id: id(7), mode: 'stay', host: 'Mac', at: T0 - 1e3 },
    { id: id(8), mode: 'stay', host: 'BlackBox', at: T0 - 86400e3 },
  ], 'pinOverrides: the PC\'s choices joined with the Mac\'s own (device ids in lower case)');
  eq(macSet.repoNames, [{ root: MACR.df, name: 'DF web' }], 'a workspace name lands on the Mac\'s folder');
  eq(macSet.repoOrder, [MACR.df, MACR.fv], 'the order, on the Mac\'s folders');
  eq(macSet.hiddenRepos.map((h) => h.root), [MACR.notes], 'a repo the Mac does not have (pc-only) is not put in');
  ok(macSet.mapSpots.some((s) => s.id === 'r:\\users\\henry\\documents\\github\\detailforge-web' && s.x === 100 && s.pin) && macSet.mapSpots.some((s) => s.id === 'r:\\users\\henry\\notes'), 'the PC\'s spot lands under the Mac\'s root id, the Mac\'s own kept');
  v = rowOf('hiddenRepos');
  ok(v.device === MAC && v.items.some((h) => h.root.name === 'pc-only') && v.items.some((h) => h.root.name === 'notes'), 'the Mac writes the join back, the pc-only repo riding along');
  ok(v.at > rowOf('names').at - 1, 'its at is past the row it took (never this machine\'s clock alone)');

  // ---------- the PC takes the Mac's join ----------
  step(10e3);
  applied.pc.length = 0;
  await pc.tick();
  eq(pcSet.hidden.map((h) => h.id).sort(), [id(1), id(2), id(9)], 'the PC takes the Mac\'s hidden');
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
  ok(P.union('repoOrder', [{ origin: null, name: 'b' }], [{ origin: null, name: 'a' }]).map((r) => r.name).join() === 'a,b', 'union of an order: this machine\'s, then the row\'s others');

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
  ok(applied.pc.length === P.GROUP_NAMES.length, 'a saved state of another device: every group joined again');

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

  await pc.stop();
  await mac.stop();
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
