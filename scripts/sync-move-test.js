// sync-move-test.js: sync-move.js, "Continue here". Two movers, A (a PC named pc) and B (a Mac named mac), over ONE
// in-memory fake of Supabase's REST (settings, conversations and devices, with PostgREST-like eq. / neq. / is.null /
// in.() / like. filters, merge-duplicates upserts on on_conflict, and conditional PATCHes that return the rows they
// matched). Each machine has made-up projects and repo folders in a temp folder, a fake uploader and materializer
// over the real log files there (the server's copy of each log is a byte buffer), and a fake session host whose
// sessions go from busy to idle. One shared clock, moved by hand; no timer runs.
//   a clean move A -> B -> A -> B with lines added between (bytes equal after each move, the owner flips, no
//   conflict, uploader.forget on the side that claimed, holds let go, the rows deleted, away.json and owners() at
//   each step (with the row's account), the resume folder and its trust); a bound conversation is in the other
//   machine's away.json like any other, and owners() says it is bound; A busy -> waiting -> idle -> moved (the lines written while busy
//   arrive); force while busy; a terminal outside the host refuses even with force; A offline -> offline -> force
//   takes the last uploaded copy, and A's watcher then ends its hosted session once idle; no answer -> noanswer; B
//   gone quiet after A let go -> A drops the stale ask, unholds and drops moving, and B asking again later still
//   moves it; the claim fails when the row changed; cancel deletes the rows; an ask left behind by a dead B never ends
//   a session on A; the heartbeat and the lease; a claim counts on both sides until a listing that began after it,
//   however late; a force from offline is dropped when A answers after all; offline is judged by last_seen_at
//   changing, with A's clock slow or fast; force waits for A's lease (the listing's, and the row's at the pull), and a
//   forced claim keeps the uploader held 30 s, then forgets it again; the rows are sealed; the helpers.
// Run: node scripts/sync-move-test.js   (exit 0 = all pass; SYNC_TEST_DIR sets the temp folder's parent)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');
const S = require(path.join(ROOT, 'sync-api.js'));
const K = require(path.join(ROOT, 'sync-crypto.js'));
const C = require(path.join(ROOT, 'sync-common.js'));
const M = require(path.join(ROOT, 'sync-move.js'));

let pass = 0, fail = 0;
const ok = (c, name) => { if (c) pass++; else { fail++; console.log(`FAIL ${name}`); } };
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), `${name}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

const base = process.env.SYNC_TEST_DIR || os.tmpdir();
fs.mkdirSync(base, { recursive: true });
const T = fs.realpathSync(fs.mkdtempSync(path.join(base, 'sync-move-test-')));
const KEY = crypto.randomBytes(32);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const lower = (s) => String(s || '').toLowerCase();

// ---------- the clock ----------
const clock = { t: Date.parse('2026-10-10T12:00:00Z') };
const now = () => clock.t;
const iso = (ms) => new Date(ms).toISOString();

// ---------- the fake Supabase REST ----------
const UID = crypto.randomUUID();
const PK = { settings: ['user_id', 'key'], conversations: ['id'], devices: ['id'] };
const db = { settings: [], conversations: [], devices: [] };
const api = { calls: [], rest };
const SKIP = new Set(['select', 'order', 'limit', 'offset', 'on_conflict']);
function inList(raw) {
  const m = /^\((.*)\)$/s.exec(raw);
  if (!m) throw new S.SyncError(`bad in.(): ${raw}`, 400, 'PGRST100');
  return (m[1].match(/"[^"]*"|[^,]+/g) || []).map((v) => lower(v.replace(/^"|"$/g, '')));
}
function match(row, q) {
  for (const [col, v] of Object.entries(q || {})) {
    if (SKIP.has(col)) continue;
    const m = /^(eq|neq|is|in|like)\.(.*)$/s.exec(String(v));
    if (!m) throw new S.SyncError(`the fake does not know ${col}=${v}`, 400, 'PGRST100');
    const [, op, raw] = m, have = row[col] == null ? null : lower(row[col]);
    if (op === 'is') { if (raw !== 'null') throw new Error('is. only takes null here'); if (have !== null) return false; continue; }
    if (op === 'eq' && have !== lower(raw)) return false;
    if (op === 'neq' && (have === null || have === lower(raw))) return false; // SQL: null <> x is not true
    if (op === 'in' && !inList(raw).includes(have)) return false;
    if (op === 'like') {
      const re = new RegExp(`^${raw.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
      if (have === null || !re.test(have)) return false;
    }
  }
  return true;
}
const pick = (row, sel) => (!sel || sel === '*' ? { ...row } : Object.fromEntries(sel.split(',').map((c) => [c, row[c] === undefined ? null : row[c]])));
const keyOf = (row, cols) => JSON.stringify(cols.map((c) => lower(row[c])));
async function rest(method, table, o = {}) {
  const q = o.query || {}, prefer = String(o.prefer || '');
  api.calls.push({ method, table, query: { ...q }, body: o.body, prefer });
  if (api.offline) throw new S.SyncError('Supabase is out of reach', 0, 'network');
  if (!db[table]) throw new S.SyncError(`no table ${table}`, 404, '42P01');
  const rows = db[table];
  const want = /return=representation/.test(prefer);
  if (method === 'GET') return rows.filter((r) => match(r, q)).map((r) => pick(r, q.select));
  if (method === 'POST') {
    const list = Array.isArray(o.body) ? o.body : [o.body];
    const target = q.on_conflict ? String(q.on_conflict).split(',') : PK[table];
    const out = [];
    for (const item of list) {
      if ('user_id' in item) throw new S.SyncError('the client sent user_id', 400, '42501');
      const row = { ...item, user_id: UID };
      const hit = rows.find((r) => keyOf(r, target) === keyOf(row, target));
      if (hit) {
        if (/resolution=merge-duplicates/.test(prefer)) { Object.assign(hit, item); out.push(hit); continue; }
        if (/resolution=ignore-duplicates/.test(prefer)) continue;
        throw new S.SyncError('duplicate key value violates unique constraint', 409, '23505');
      }
      rows.push(row);
      out.push(row);
    }
    return want ? out.map((r) => ({ ...r })) : null;
  }
  if (method === 'PATCH') {
    const hit = rows.filter((r) => match(r, q));
    for (const r of hit) Object.assign(r, o.body);
    return want ? hit.map((r) => ({ ...r })) : null;
  }
  if (method === 'DELETE') {
    const gone = rows.filter((r) => match(r, q));
    db[table] = rows.filter((r) => !gone.includes(r));
    return want ? gone : null;
  }
  throw new S.SyncError('no such method', 405, '');
}
const rowOf = (id) => db.conversations.find((r) => r.id === id);
const moveKeys = (id) => db.settings.filter((r) => r.key.startsWith(id ? `move:${id}:` : 'move:')).map((r) => r.key).sort();
const openRow = (k) => { const r = db.settings.find((x) => x.key === k); return r ? JSON.parse(K.openText(r.value_enc, KEY, `setting:${k}`)) : null; };
const server = new Map(); // conversation id -> the uploaded bytes of its log

// ---------- a machine: its folders, fake uploader, materializer and host ----------
const boundIds = new Set(); // conversations whose repos row is a bound one (sync-common.js "portable or bound")
function machine(name, letter) {
  const dir = path.join(T, letter);
  const home = path.join(dir, 'home');
  const proj = path.join(home, '.claude', 'projects');
  const folder = path.join(dir, 'repo');
  fs.mkdirSync(proj, { recursive: true });
  fs.mkdirSync(folder, { recursive: true });
  const m = {
    name, me: crypto.randomUUID(), home, proj, folder, slugDir: path.join(proj, C.slugOf(folder)), dataDir: path.join(dir, 'data'),
    hosted: new Map(), external: new Set(), held: new Set(), holds: [], forgotten: [], kills: [], owners: new Map(), downOk: false, conflicts: [],
    afterPull: null, logs: [], asleep: false, listedAt: null,
  };
  db.devices.push({ id: m.me, user_id: UID, name, platform: 'win32', last_seen_at: null });
  m.logPath = (id) => path.join(m.slugDir, `${id}.jsonl`);
  m.bytes = (id) => { try { return fs.readFileSync(m.logPath(id)); } catch { return null; } };
  m.isLive = (id) => !!(m.hosted.get(id) && m.hosted.get(id).alive) || m.external.has(id);
  // the uploader: the log up to its last whole line becomes the server's copy (a new generation when it is not an
  // append), only while this machine owns the row
  const upload = (id) => {
    const row = rowOf(id);
    if (!row) throw new S.SyncError('the server has no row for it', 404, 'missing');
    if (lower(row.owner_device) !== m.me) throw new S.SyncError('another device owns it', 0, 'lost');
    const buf = m.bytes(id) || Buffer.alloc(0);
    const data = Buffer.from(buf.subarray(0, buf.lastIndexOf(10) + 1));
    const cur = server.get(id) || Buffer.alloc(0);
    if (!data.equals(cur)) {
      if (!(data.length >= cur.length && data.subarray(0, cur.length).equals(cur))) row.generation++;
      server.set(id, data);
      Object.assign(row, { size: data.length, sha256: sha(data), updated_at: iso(now()) });
    }
    return { size: row.size, sha256: row.sha256, generation: row.generation, owner_device: row.owner_device };
  };
  m.up = {
    flush: async (id) => upload(id),
    forget: (id) => { m.forgotten.push(id); },
    hold: (id) => { m.held.add(id); m.holds.push(id); },
    unhold: (id) => { m.held.delete(id); },
    held: () => [...m.held],
    scan() { // the background loop: every conversation this machine owns, never a held one
      for (const row of db.conversations) if (lower(row.owner_device) === m.me && !m.held.has(row.id) && m.bytes(row.id)) upload(row.id);
    },
  };
  // the materializer: lays the server's copy down when the local one is its prefix, else a conflict
  m.down = {
    async pull(id) {
      const row = rowOf(id);
      if (!row) return { outcome: 'missing' };
      if (lower(row.owner_device) === m.me) return { outcome: 'mine', row: { ...row } };
      const res = { dir: m.slugDir, folder: m.folder, row: { ...row } };
      if (m.isLive(id)) return { outcome: 'skip', reason: 'open on this machine', ...res };
      const srv = (server.get(id) || Buffer.alloc(0)).subarray(0, row.size);
      const local = m.bytes(id);
      let outcome = 'done';
      if (local) {
        if (local.length > srv.length || !srv.subarray(0, local.length).equals(local)) return { outcome: 'conflict', reason: 'the local copy is longer', ...res };
        if (local.equals(srv)) outcome = 'same';
      }
      if (outcome === 'done') { fs.mkdirSync(m.slugDir, { recursive: true }); fs.writeFileSync(`${m.logPath(id)}.part`, srv); fs.renameSync(`${m.logPath(id)}.part`, m.logPath(id)); }
      if (m.afterPull) await m.afterPull(id);
      return { outcome, ...res };
    },
    owners: () => m.owners,
    conflicts: () => m.conflicts.map((id) => ({ id, file: 'main', reason: 'the local copy is longer' })),
    status: () => ({ lastOkAt: m.downOk ? iso(now()) : null, listedAt: m.listedAt === null ? null : iso(m.listedAt) }),
    scan() { // its listing: the rows other devices own
      m.listedAt = now();
      m.owners = new Map(db.conversations.filter((r) => r.state === 'active' && r.owner_device && lower(r.owner_device) !== m.me)
        .map((r) => [r.id, { device: lower(r.owner_device), leaseUntil: r.lease_until ? Date.parse(r.lease_until) : null, account: r.account, bound: boundIds.has(r.id) }]));
      m.downOk = true;
    },
  };
  m.host = {
    list: async () => [...m.hosted.values()].map((s) => ({ ...s })),
    kill: async (id) => { m.kills.push(id); const s = m.hosted.get(id); if (s && s.alive) { s.alive = false; s.status = null; s.waitingFor = null; } },
  };
  m.host0 = (id, status, waitingFor = null) => m.hosted.set(id, { id, alive: true, status, waitingFor, cwd: m.folder, account: 'B' });
  m.mover = M.createMover({
    api, dataDir: m.dataDir, key: KEY, log: (t) => m.logs.push(t), now, up: m.up, down: m.down, host: m.host, me: m.me,
    home: m.home, projects: [{ account: 'b', dir: proj }], isLive: m.isLive,
  });
  m.away = () => C.readState(M.awayPath(m.dataDir), null);
  m.awayOf = (id) => { const a = m.away(); return a && a.ids ? a.ids[id] || null : null; };
  m.out = (id) => m.mover.outgoing().find((x) => x.id === id) || null;
  return m;
}

const A = machine('pc', 'A');
const B = machine('mac', 'B');
// B trusts its own repo folder; A trusts nothing
fs.writeFileSync(path.join(B.home, '.claude.json'), JSON.stringify({ projects: { [B.folder.replace(/\\/g, '/')]: { hasTrustDialogAccepted: true } } }));

let lineNo = 0;
const lines = (m, n) => Array.from({ length: n }, () => `${JSON.stringify({ type: 'user', n: lineNo++, cwd: m.folder, text: `line ${lineNo} ${'pad '.repeat(lineNo % 30)}` })}\n`).join('');
const append = (m, id, n) => { fs.mkdirSync(m.slugDir, { recursive: true }); fs.appendFileSync(m.logPath(id), lines(m, n)); };
// a conversation that m owns, with n lines uploaded
function seed(m, n) {
  const id = crypto.randomUUID();
  db.conversations.push({ id, user_id: UID, account: 'b', repo_id: null, rel_cwd: '', state: 'active', owner_device: m.me, lease_until: null, size: 0, sha256: null, generation: 0, updated_at: iso(now()) });
  append(m, id, n);
  m.up.scan();
  return id;
}

// one machine's turn: its uploader and materializer loops, then a mover tick and everything it started
async function step(m) {
  if (m.asleep) return;
  m.up.scan();
  m.down.scan();
  await m.mover.tick();
  await m.mover.settle();
}
// rounds of both (or the given machines), the clock moving stepMs each, until cond() (or max rounds)
async function until(cond, { who = [A, B], max = 200, stepMs = 1100, each = null } = {}) {
  for (let i = 0; i < max; i++) {
    if (cond()) return true;
    clock.t += stepMs;
    for (const m of who) { await step(m); if (each) each(); }
  }
  return cond();
}
const jobOf = (m, id) => m.mover.status(id);
const phaseOf = (m, id) => (jobOf(m, id) || {}).phase;
const done = (m, id) => ['ready', 'failed', 'cancelled'].includes(phaseOf(m, id));

(async () => {
  try {
    // ---------- the helpers ----------
    {
      const since = new Map();
      ok(M.busyNow({ id: 'x', status: 'busy' }, since, 0, 10e3) && M.busyNow({ id: 'x', status: 'shell' }, since, 0, 10e3), 'busy and shell are busy');
      ok(M.busyNow({ id: 'x', status: 'waiting', waitingFor: 'approve Bash(ls)' }, since, 0, 10e3), 'waiting on a permission is busy');
      ok(!M.busyNow({ id: 'x', status: 'waiting', waitingFor: 'dialog open' }, since, 0, 10e3) && !M.busyNow({ id: 'x', status: 'idle' }, since, 0, 10e3), 'an open dialog and idle are not');
      ok(M.busyNow({ id: 'y', status: null }, since, 1000, 10e3) && M.busyNow({ id: 'y', status: null }, since, 10999, 10e3) && !M.busyNow({ id: 'y', status: null }, since, 11000, 10e3), 'no status counts as busy for 10 s, then idle');
      // the resume folder: the materializer's folder when its slug is the log's folder; else the log's own folder
      const other = path.join(T, 'started-here');
      fs.mkdirSync(other, { recursive: true });
      const id = crypto.randomUUID(), slug = path.join(B.proj, C.slugOf(other));
      fs.mkdirSync(slug, { recursive: true });
      fs.writeFileSync(path.join(slug, `${id}.jsonl`), `${JSON.stringify({ type: 'user', cwd: other })}\n`);
      ok(M.resumeFolder(B.slugDir, B.folder, id) === B.folder, 'resume folder: the folder whose slug the log is in');
      ok(M.resumeFolder(slug, B.folder, id) === other, 'resume folder: the log\'s own folder when it lives in another slug folder');
      ok(M.trustedIn(B.home, B.folder, 'B') && !M.trustedIn(B.home, other, 'B') && !M.trustedIn(B.home, B.folder, 'A'), 'trust: read from that account\'s .claude.json');
      ok(M.findLogIn([{ dir: B.proj }], id) === path.join(slug, `${id}.jsonl`) && M.findLogIn([{ dir: B.proj }], crypto.randomUUID()) === null, 'findLogIn finds a log in any slug folder');
    }

    // both run once: device rows touched, the rows listed
    await step(A); await step(B);
    ok(db.devices.every((d) => d.last_seen_at === iso(now())), 'the heartbeat sets last_seen_at on both');

    // ---------- 1. a clean move A -> B -> A -> B ----------
    {
      const id = seed(A, 5);
      await step(A); await step(B);
      eq(B.awayOf(id), { device: 'pc', why: 'owned' }, 'before: B\'s away.json has it as pc\'s');
      ok(!A.awayOf(id), 'before: A\'s away.json does not have it');
      let threw = null;
      try { A.mover.move(id); } catch (e) { threw = e.code; }
      eq(threw, 'not_elsewhere', 'A can\'t move a conversation it owns');
      try { B.mover.move('not-an-id'); } catch (e) { threw = e.code; }
      eq(threw, 'bad_id', 'a bad id is refused');
      const j0 = B.mover.move(id);
      ok(j0.phase === 'asking' && j0.from.device === A.me && j0.from.name === 'pc' && j0.force === false && j0.canForce === false && j0.ready === null, 'move() gives the job at once, asking pc');
      eq(B.mover.move(id).startedAt, j0.startedAt, 'a second move() gives the same job');
      await step(B);
      eq(moveKeys(id), [`move:${id}:ask`], 'B wrote its ask');
      const askRow = db.settings.find((r) => r.key === `move:${id}:ask`);
      ok(!/nonce|"to"|phase/.test(askRow.value_enc) && openRow(`move:${id}:ask`).to === B.me, 'the ask is sealed with the sync key under setting:<key>');
      await step(A);
      ok(A.out(id) && A.out(id).phase === 'asked', 'A saw the ask and answered asked');
      eq(A.awayOf(id), { device: 'mac', why: 'moving' }, 'A: away.json has it as moving to mac');
      eq(B.mover.owners().get(id).moving, 'here', 'B: owners() says moving here');
      eq(A.mover.owners().get(id), { device: B.me, name: 'mac', live: false, moving: 'away', account: null, bound: false }, 'A: owners() says moving away to mac');
      await step(A);
      eq(A.out(id).phase, 'asked', 'A does nothing more until it sees the ask change (the handshake)');
      ok(await until(() => done(B, id)), 'the move ends');
      const j = jobOf(B, id);
      eq(j.phase, 'ready', 'B: ready');
      ok(j.ready && j.ready.cwd === B.folder && j.ready.account === 'B' && j.ready.trusted === true, 'B: ready names the resume folder, the account and that it is trusted');
      ok(B.bytes(id).equals(A.bytes(id)), 'B\'s copy is A\'s log byte for byte');
      eq(rowOf(id).owner_device, B.me, 'the row is B\'s');
      ok(Date.parse(rowOf(id).lease_until) > now(), 'the claim set a lease');
      ok(B.forgotten.includes(id), 'B\'s uploader forgot it (it adopts from the server again)');
      ok(A.holds.includes(id) && A.held.has(id), 'A holds it until it sees the claim');
      await step(A);
      ok(!A.held.has(id), 'A let go of the hold once it saw the claim');
      eq(moveKeys(id), [], 'both request rows are gone');
      ok(!A.out(id), 'A\'s hand-over is over');
      eq(A.awayOf(id), { device: 'mac', why: 'owned' }, 'after: A\'s away.json has it as mac\'s');
      ok(!B.awayOf(id), 'after: B\'s away.json does not have it');
      ok(!B.mover.owners().has(id) && A.mover.owners().get(id).device === B.me, 'after: owners() on both');

      // B adds lines, then A takes it back
      append(B, id, 4);
      await step(B); await step(A);
      ok(server.get(id).equals(B.bytes(id)), 'B uploaded its new lines');
      A.mover.move(id);
      ok(await until(() => done(A, id)), 'the move back ends');
      eq(phaseOf(A, id), 'ready', 'A: ready');
      ok(A.bytes(id).equals(B.bytes(id)), 'A\'s copy is B\'s log byte for byte');
      eq(rowOf(id).owner_device, A.me, 'the row is A\'s again');
      ok(jobOf(A, id).ready.cwd === A.folder && jobOf(A, id).ready.trusted === false, 'A: ready, and its folder is not trusted there');
      await step(B);
      ok(A.forgotten.includes(id) && B.holds.includes(id) && !B.held.has(id), 'A forgot it; B held it and let go');
      ok(!B.out(id) && !B.mover.move(id).ready && phaseOf(B, id) === 'asking', 'B can ask for it again at once (its earlier claim does not hide that A has it now)');
      B.mover.cancel(id);
      await B.mover.settle();

      // A adds lines, B takes it again
      append(A, id, 3);
      await step(A); await step(B);
      const gen = rowOf(id).generation;
      B.mover.move(id);
      ok(await until(() => done(B, id)), 'the third move ends');
      eq(phaseOf(B, id), 'ready', 'B: ready again');
      ok(B.bytes(id).equals(A.bytes(id)) && B.bytes(id).equals(server.get(id)), 'every copy is the same bytes');
      eq(rowOf(id).owner_device, B.me, 'the row is B\'s again');
      eq(rowOf(id).generation, gen, 'only appends: the generation never moved');
      ok(!A.logs.concat(B.logs).some((t) => /won't merge|conflict/.test(t)), 'no conflict on either side');
    }

    // ---------- 1b. a bound conversation: another device's like any other, and owners() says it is bound ----------
    {
      const id = seed(A, 3);
      boundIds.add(id);
      await step(A); await step(B);
      eq(B.awayOf(id), { device: 'pc', why: 'owned' }, 'bound: B\'s away.json has it as pc\'s, so B\'s session host never opens it');
      const o = B.mover.owners().get(id);
      ok(o && o.bound === true && o.device === A.me && o.name === 'pc', `bound: B's owners() says it is pc's and bound (${JSON.stringify(o)})`);
      ok(!A.awayOf(id) && !A.mover.owners().has(id), 'bound: A, its host, has it as its own');
      const other = B.mover.owners().get([...B.mover.owners().keys()].find((k) => !boundIds.has(k)));
      ok(!other || other.bound === false, 'bound: a portable one is not');
    }

    // ---------- 2. A busy -> waiting -> idle -> moved ----------
    {
      const id = seed(A, 3);
      A.host0(id, 'waiting', 'approve Bash(ls)');
      await step(A); await step(B);
      B.mover.move(id);
      ok(await until(() => phaseOf(B, id) === 'waiting'), 'B: waiting');
      let j = jobOf(B, id);
      ok(j.status === 'waiting' && j.waitingFor === 'approve Bash(ls)' && j.canForce === true && /pc is waiting for an answer/.test(j.note), 'waiting: A\'s status, what it waits for, and it can be forced');
      A.hosted.get(id).status = 'busy';
      append(A, id, 2); // Claude keeps writing while busy
      await until(() => false, { max: 5 });
      j = jobOf(B, id);
      ok(j.phase === 'waiting' && j.status === 'busy' && /working/.test(j.note) && A.kills.length === 0, 'still waiting while busy, nothing ended');
      eq(A.awayOf(id), { device: 'mac', why: 'moving' }, 'A: moving while it waits');
      A.hosted.get(id).status = 'waiting';
      A.hosted.get(id).waitingFor = 'dialog open'; // an open "/" panel is not a turn
      append(A, id, 1);
      ok(await until(() => done(B, id)), 'once idle it moves');
      eq(phaseOf(B, id), 'ready', 'B: ready');
      ok(A.kills.includes(id), 'A ended the hosted session');
      ok(B.bytes(id).equals(A.bytes(id)) && B.bytes(id).toString().split('\n').length === 3 + 2 + 1 + 1, 'every line written while it was busy arrived');
    }

    // ---------- 3. force while busy ----------
    {
      const id = seed(A, 2);
      A.host0(id, 'busy');
      await step(A); await step(B);
      B.mover.move(id);
      ok(await until(() => phaseOf(B, id) === 'waiting'), 'force: B waiting first');
      const j = B.mover.move(id, { force: true });
      ok(j.force === true && j.phase === 'waiting', 'move() with force upgrades the same job');
      ok(await until(() => done(B, id)), 'force: it moves');
      ok(phaseOf(B, id) === 'ready' && A.kills.includes(id) && B.bytes(id).equals(A.bytes(id)), 'force: A ended it mid-turn and B has every byte');
      ok(A.logs.some((t) => /mid-turn: forced/.test(t)), 'A logged the forced end');
    }

    // ---------- 4. a terminal outside the host refuses, even with force ----------
    {
      const id = seed(A, 2);
      A.external.add(id);
      await step(A); await step(B);
      B.mover.move(id);
      ok(await until(() => phaseOf(B, id) === 'waiting'), 'external: B waiting');
      let j = jobOf(B, id);
      ok(j.note === 'open in a terminal on pc: close it there' && j.canForce === false, 'external: the note says to close it there, and it can\'t be forced');
      B.mover.move(id, { force: true });
      await until(() => false, { max: 20 });
      j = jobOf(B, id);
      ok(j.phase === 'waiting' && !A.kills.includes(id) && rowOf(id).owner_device === A.me, 'external: force does not end it');
      A.external.delete(id);
      append(A, id, 1);
      ok(await until(() => done(B, id)), 'external: closed there, it moves');
      ok(phaseOf(B, id) === 'ready' && B.bytes(id).equals(A.bytes(id)), 'external: B has every byte');
    }

    // ---------- 5. A offline: force takes the last uploaded copy; A's watcher ends its session ----------
    {
      const id = seed(A, 4);
      A.host0(id, 'idle');
      await step(A); await step(B);
      append(A, id, 2); // written on A, never uploaded: A sleeps now
      A.asleep = true;
      clock.t += 3 * 60e3;
      await step(B);
      B.mover.move(id);
      await step(B);
      let j = jobOf(B, id);
      ok(j.phase === 'offline' && j.canForce === true && j.note === 'pc is offline', 'offline: B says pc is offline, and it can be forced');
      B.mover.move(id, { force: true });
      ok(await until(() => done(B, id), { who: [B] }), 'offline: forced, it ends');
      j = jobOf(B, id);
      eq(j.phase, 'ready', 'offline: ready');
      ok(B.bytes(id).equals(server.get(id)) && B.bytes(id).length < A.bytes(id).length, 'offline: B has the last uploaded copy (not the lines A never uploaded)');
      eq(rowOf(id).owner_device, B.me, 'offline: the row is B\'s');
      eq(moveKeys(id), [], 'offline: the request rows are gone');
      // A wakes up with the session still open
      A.asleep = false;
      A.hosted.get(id).status = 'busy';
      await until(() => false, { who: [A], max: 20 });
      ok(!A.kills.includes(id), 'the watcher waits while it is busy');
      ok(A.logs.some((t) => /mac has it now; it ends here once Claude is idle/.test(t)), 'the watcher says why it waits');
      A.hosted.get(id).status = 'idle';
      ok(await until(() => A.kills.includes(id), { who: [A], max: 20 }), 'the watcher ends the hosted session once idle');
      eq(A.awayOf(id), { device: 'mac', why: 'owned' }, 'A\'s away.json has it as mac\'s');
    }

    // ---------- 6. no answer ----------
    {
      const id = seed(A, 2);
      await step(A); await step(B);
      A.asleep = true; // online by its last_seen_at, but never answers
      B.mover.move(id);
      ok(await until(() => phaseOf(B, id) === 'noanswer', { who: [B], max: 70 }), 'noanswer: B gives up waiting for an answer');
      const j = jobOf(B, id);
      ok(j.canForce === true && j.note === 'pc has not answered' && now() - j.startedAt >= 60e3 && now() - j.startedAt < 120e3, 'noanswer after 60 s, with force offered');
      ok(B.mover.cancel(id) && phaseOf(B, id) === 'cancelled', 'cancel stops it');
      await B.mover.settle();
      eq(moveKeys(id), [], 'noanswer: cancel deleted the ask');
      A.asleep = false;
    }

    // ---------- 7. B quiet after A let go: A drops the stale ask; B asking again still moves it ----------
    {
      const id = seed(A, 3);
      await step(A); await step(B);
      B.mover.move(id);
      let released = false;
      for (let i = 0; i < 100 && !released; i++) {
        clock.t += 1100;
        await step(A);
        released = !!A.out(id) && A.out(id).phase === 'released';
        if (!released) await step(B);
      }
      ok(released && A.held.has(id), 'stale: A let go and holds it');
      eq(A.awayOf(id), { device: 'mac', why: 'moving' }, 'stale: moving while it holds');
      ok(await until(() => !A.out(id), { who: [A], max: 100 }), 'stale: A drops the ask in the end');
      ok(!A.held.has(id), 'stale: A let go of the hold');
      ok(!A.awayOf(id), 'stale: A dropped moving');
      eq(moveKeys(id), [], 'stale: A deleted both rows');
      eq(rowOf(id).owner_device, A.me, 'stale: still A\'s');
      ok(A.logs.some((t) => t.includes(`${id.slice(0, 8)}: it stays here (mac stopped asking)`)), 'stale: A logged why');
      ok(await until(() => done(B, id)), 'stale: B asks again and it moves');
      ok(phaseOf(B, id) === 'ready' && B.bytes(id).equals(A.bytes(id)) && rowOf(id).owner_device === B.me, 'stale: then it moved cleanly');
    }

    // ---------- 8. the claim fails when the row changed ----------
    {
      const id = seed(A, 3);
      await step(A); await step(B);
      B.afterPull = async (pid) => { if (pid === id) rowOf(id).sha256 = 'f'.repeat(64); }; // as if A uploaded more meanwhile
      B.mover.move(id);
      ok(await until(() => done(B, id)), 'changed: it ends');
      B.afterPull = null;
      const j = jobOf(B, id);
      ok(j.phase === 'failed' && j.error === 'it changed on pc meanwhile; try again' && j.ready === null, 'changed: failed, "it changed on pc meanwhile"');
      eq(rowOf(id).owner_device, A.me, 'changed: the row stays A\'s');
      await until(() => !A.out(id), { who: [A], max: 5 });
      ok(!A.out(id) && !A.held.has(id) && !A.awayOf(id), 'changed: A let go of the hold and of moving');
      eq(moveKeys(id), [], 'changed: the rows are gone');
    }

    // ---------- 9. cancel ----------
    {
      const id = seed(A, 2);
      A.host0(id, 'busy');
      await step(A); await step(B);
      B.mover.move(id);
      ok(await until(() => phaseOf(B, id) === 'waiting'), 'cancel: B waiting');
      eq(moveKeys(id), [`move:${id}:ask`, `move:${id}:reply`], 'cancel: both rows are there');
      ok(B.mover.cancel(id) === true, 'cancel() says it stopped it');
      eq(phaseOf(B, id), 'cancelled', 'cancel: the job says cancelled');
      ok(B.mover.cancel(id) === false, 'a second cancel() says false');
      await B.mover.settle();
      eq(moveKeys(id), [], 'cancel: both rows deleted');
      await step(A);
      ok(!A.out(id) && !A.awayOf(id) && !A.kills.includes(id) && A.hosted.get(id).alive, 'cancel: A dropped it, and its session runs on');
      ok(!B.mover.owners().get(id).moving, 'cancel: B\'s owners() no longer says moving');
    }

    // ---------- 10. an ask left behind by a dead B never ends a session on A ----------
    {
      const id = seed(A, 2);
      A.host0(id, 'idle');
      await step(A);
      const k = `move:${id}:ask`;
      db.settings.push({ user_id: UID, key: k, value_enc: K.sealText(JSON.stringify({ v: 1, id, to: B.me, from: A.me, at: 12345, nonce: 'dead', force: true }), KEY, `setting:${k}`) });
      await step(A);
      ok(A.out(id) && A.out(id).phase === 'asked', 'dead ask: A answered asked');
      eq(A.awayOf(id), { device: 'mac', why: 'moving' }, 'dead ask: moving meanwhile');
      ok(await until(() => !A.out(id), { who: [A], max: 100 }), 'dead ask: dropped in the end');
      ok(!A.kills.includes(id) && A.hosted.get(id).alive, 'dead ask: the idle session was never ended');
      eq(moveKeys(id), [], 'dead ask: both rows deleted');
      ok(!A.awayOf(id), 'dead ask: not away any more');
      // the lease: A owns it and it runs in A's host
      clock.t += 61e3;
      await step(A);
      ok(Date.parse(rowOf(id).lease_until) > now(), 'the heartbeat put a lease on the hosted conversation A owns');
      const leasePatch = api.calls.filter((c) => c.method === 'PATCH' && c.table === 'conversations' && c.body && c.body.lease_until && !c.body.owner_device).pop();
      ok(leasePatch && leasePatch.query.owner_device === `eq.${A.me}` && /^in\.\(/.test(leasePatch.query.id), 'the lease PATCH is one in.() conditional on owner = this device');
      ok(!B.mover.owners().has(id), 'B\'s owners() has only what its materializer listed');
      B.down.scan();
      ok(B.mover.owners().get(id).live === true, 'live once B\'s materializer lists the lease');
      eq(B.mover.owners().get(id).account, 'b', 'owners(): the row\'s account comes along');
      rowOf(id).account = 'a';
      B.down.scan();
      eq(B.mover.owners().get(id).account, 'a', 'owners(): a once the row says a (the account it ran under on pc)');
      rowOf(id).account = 'b';
      B.down.scan();
      clock.t += 4 * 60e3;
      ok(B.mover.owners().get(id).live === false, 'not live once the lease ran out');
    }

    // ---------- 11. a job nobody watches is cancelled before A ends anything ----------
    {
      const id = seed(A, 2);
      A.host0(id, 'busy');
      await step(A); await step(B);
      B.mover.move(id);
      ok(await until(() => phaseOf(B, id) === 'waiting'), 'unwatched: B waiting');
      await until(() => false, { max: 250 }); // 4.6 minutes and nobody asks about the job
      ok(B.mover.outgoing().length === 0 && phaseOf(B, id) === 'waiting', 'unwatched: still waiting after 4.6 minutes (asking about it keeps it going)');
      await until(() => false, { max: 280 }); // over 5 minutes since
      const j = jobOf(B, id);
      ok(j.phase === 'cancelled' && /nobody was watching/.test(j.note), 'unwatched: cancelled');
      await step(A);
      eq(moveKeys(id), [], 'unwatched: the rows are gone');
      ok(!A.out(id) && A.hosted.get(id).alive && !A.kills.includes(id), 'unwatched: A\'s session runs on');
    }

    // ---------- 12. this PC's copy has lines the owner lacks ----------
    {
      const id = seed(A, 3);
      await step(A); await step(B);
      fs.mkdirSync(B.slugDir, { recursive: true });
      fs.writeFileSync(B.logPath(id), Buffer.concat([server.get(id), Buffer.from(lines(B, 1))])); // B wrote one more line once
      B.mover.move(id);
      ok(await until(() => done(B, id)), 'conflict: it ends');
      let j = jobOf(B, id);
      ok(j.phase === 'failed' && j.error === 'This PC has lines in this conversation that pc lacks; Fleet View won\'t merge them', 'conflict: failed with the conflict message');
      eq(rowOf(id).owner_device, A.me, 'conflict: still A\'s');
      await step(A);
      ok(!A.out(id) && !A.held.has(id) && moveKeys(id).length === 0, 'conflict: A let go, the rows are gone');
      // the materializer already lists it as a conflict: refused before A is asked
      B.conflicts.push(id);
      const n0 = A.kills.length;
      B.mover.move(id);
      await step(B);
      j = jobOf(B, id);
      ok(j.phase === 'failed' && /won't merge them/.test(j.error) && moveKeys(id).length === 0 && A.kills.length === n0, 'conflict known up front: failed at once, nothing asked');
      B.conflicts.length = 0;
    }

    // ---------- 13. a claim counts until a listing that began after it, however late that comes ----------
    {
      const id = seed(A, 4);
      await step(A); await step(B);
      const preB = new Map(B.owners), preAt = now(); // both listings from before the claim: B's says pc has it
      B.mover.move(id);
      ok(await until(() => done(B, id)), 'late listing: moved');
      eq(phaseOf(B, id), 'ready', 'late listing: ready');
      // neither materializer lists again for a while (a long scan, the network): A's last listing is from before the
      // claim (A owned it, so it is not in it), B's says pc has it
      const scanA = A.down.scan, scanB = B.down.scan;
      A.down.scan = () => {}; B.down.scan = () => {};
      A.owners = new Map([...A.owners].filter(([k]) => k !== id)); A.listedAt = preAt;
      B.owners = preB; B.listedAt = preAt;
      for (let i = 0; i < 150; i++) { clock.t += 1000; await step(A); await step(B); }
      eq(A.awayOf(id), { device: 'mac', why: 'owned' }, 'late listing: 150 s on, A\'s away.json still has it as mac\'s');
      ok(A.mover.owners().get(id) && A.mover.owners().get(id).device === B.me, 'late listing: and so does A\'s owners()');
      ok(!B.awayOf(id) && !B.mover.owners().has(id), 'late listing: B\'s away.json and owners() still leave out its own');
      A.down.scan = scanA; B.down.scan = scanB;
      clock.t += 1000;
      await step(A); await step(B);
      eq(A.awayOf(id), { device: 'mac', why: 'owned' }, 'late listing: listed again, A has it as mac\'s from the listing');
      ok(!B.awayOf(id) && !B.mover.owners().has(id), 'late listing: and B still leaves it out');
    }

    // ---------- 14. a force from offline is dropped when pc answers after all ----------
    {
      const id = seed(A, 4);
      await step(A); await step(B);
      A.asleep = true;
      append(A, id, 3); // written on A just before it slept, not uploaded yet
      await until(() => false, { who: [B], max: 1, stepMs: 31e3 }); // B reads the devices once more
      clock.t += 3 * 60e3;
      B.mover.move(id);
      await step(B);
      eq(phaseOf(B, id), 'offline', 'answered after all: offline first');
      // pc wakes, and its mover answers before B's page sends the force
      A.asleep = false;
      A.down.scan(); await A.mover.tick(); await A.mover.settle();
      ok(A.out(id) && A.out(id).phase === 'asked', 'answered after all: pc answered');
      B.mover.move(id, { force: true });
      B.down.scan(); await B.mover.tick(); await B.mover.settle();
      ok(rowOf(id).owner_device === A.me && !['downloading', 'claiming', 'ready'].includes(phaseOf(B, id)), `answered after all: B did not take the last uploaded copy (${phaseOf(B, id)})`);
      ok(B.logs.some((t) => t.includes(`${id.slice(0, 8)}: pc answered after all`)), 'answered after all: B logged why');
      ok(await until(() => done(B, id)), 'answered after all: it moves');
      ok(phaseOf(B, id) === 'ready' && B.bytes(id).equals(A.bytes(id)), 'answered after all: pc handed it over itself, with the lines it wrote before it slept');
    }

    // ---------- 15. offline is judged by last_seen_at changing, never against this clock ----------
    {
      const id = seed(A, 2);
      await step(A); await step(B);
      A.asleep = true; // it never answers; its last_seen_at is moved by hand, as a clock 10 minutes slow writes it
      const rowA = db.devices.find((d) => d.id === A.me);
      B.mover.move(id);
      let sawOffline = false;
      for (let i = 0; i < 6; i++) { // 3 minutes of pc's heartbeat, every 30 s
        rowA.last_seen_at = iso(now() - 10 * 60e3);
        await until(() => false, { who: [B], max: 1, stepMs: 30e3 });
        if (phaseOf(B, id) === 'offline') sawOffline = true;
      }
      ok(!sawOffline && phaseOf(B, id) === 'noanswer', `skewed clock: 10 minutes behind this clock but moving is not offline (${phaseOf(B, id)})`);
      ok(B.mover.online(A.me) === true && B.mover.online(crypto.randomUUID()) === false, 'online: a device seen moving is there; one the table lacks is not');
      rowA.last_seen_at = iso(now() + 60 * 60e3); // a clock an hour fast, and then it stops
      const stopAt = now();
      ok(await until(() => phaseOf(B, id) === 'offline', { who: [B], max: 300 }), 'skewed clock: an hour ahead and still is offline in the end');
      ok(now() - stopAt >= 120e3 && now() - stopAt <= 160e3, `skewed clock: offline 2 minutes after it stopped changing (${now() - stopAt} ms)`);
      ok(B.mover.online(A.me) === false, 'online: false once offline');
      ok(B.mover.cancel(id), 'skewed clock: cancelled');
      await B.mover.settle();
      A.asleep = false;
    }

    // ---------- 16. force waits for pc's lease, and a forced claim keeps the uploader held 30 s ----------
    {
      const id = seed(A, 4);
      A.host0(id, 'idle');
      await step(A); await step(B);
      clock.t += 61e3;
      await step(A); // pc's heartbeat: a lease on the conversation it runs
      const leaseAt = Date.parse(rowOf(id).lease_until);
      ok(leaseAt > now(), 'lease: pc leased it');
      A.asleep = true;
      await until(() => false, { who: [B], max: 1, stepMs: 31e3 });
      B.mover.move(id);
      ok(await until(() => phaseOf(B, id) === 'offline', { who: [B], max: 200 }), 'lease: B sees pc offline');
      let j = jobOf(B, id);
      ok(now() < leaseAt && j.canForce === false && /^pc is offline; it was running it there moments ago, so it can be taken over in \d+ s$/.test(j.note), `lease: no force while pc's lease is ahead (${j.note})`);
      B.mover.move(id, { force: true });
      await step(B);
      ok(phaseOf(B, id) === 'offline' && rowOf(id).owner_device === A.me, 'lease: force did nothing');
      ok(await until(() => jobOf(B, id).canForce, { who: [B], max: 200 }), 'lease: force once it lapsed');
      ok(now() >= leaseAt && jobOf(B, id).note === 'pc is offline', 'lease: lapsed, the note says offline');
      // the listing says it lapsed, but the row the pull reads has a lease again: no takeover either
      rowOf(id).lease_until = iso(now() + 60e3);
      B.mover.move(id, { force: true });
      await B.mover.tick(); await B.mover.settle();
      j = jobOf(B, id);
      ok(j.phase === 'offline' && j.canForce === false && rowOf(id).owner_device === A.me, `lease: a lease the row has again stops it too (${j.phase}, ${j.note})`);
      ok(await until(() => jobOf(B, id).canForce, { who: [B], max: 100 }), 'lease: force once that one lapsed too');
      B.mover.move(id, { force: true });
      await step(B);
      eq(phaseOf(B, id), 'ready', 'forced: ready');
      ok(B.logs.some((t) => t.includes(`${id.slice(0, 8)}: moved here from pc (its last uploaded copy)`)), 'forced: B logged that it took the last uploaded copy');
      const forgets = () => B.forgotten.filter((x) => x === id).length;
      ok(B.held.has(id) && forgets() === 1, 'forced: the uploader stays held after the claim');
      append(B, id, 2);
      clock.t += 20e3;
      await step(B);
      ok(server.get(id).length < B.bytes(id).length, 'forced: nothing goes up while held');
      clock.t += 11e3;
      await step(B);
      ok(!B.held.has(id) && forgets() === 2, 'forced: 30 s on, forgotten again and let go');
      await step(B);
      ok(server.get(id).equals(B.bytes(id)), 'forced: then its lines go up');
      A.hosted.delete(id);
      A.asleep = false;
    }

    // ---------- the rows and the device ----------
    ok(db.settings.every((r) => !/"phase"|"nonce"/.test(r.value_enc)), 'no request row holds plain JSON');
    ok(api.calls.filter((c) => c.method === 'POST' && c.table === 'settings').every((c) => c.query.on_conflict === 'user_id,key' && /resolution=merge-duplicates/.test(c.prefer)), 'every request row write is an upsert on (user_id, key)');
    eq(A.mover.device(), { id: A.me, name: 'pc' }, 'device() is this device and its name');
    // an idle tick reads the requests once, nothing else (the one before it caught up on the heartbeat and the names)
    clock.t += 1000;
    await A.mover.tick();
    const n0 = api.calls.length;
    clock.t += 1000;
    await A.mover.tick();
    const idle = api.calls.slice(n0);
    ok(idle.length === 1 && idle[0].table === 'settings' && idle[0].method === 'GET' && idle[0].query.key === 'like.move:*', 'an idle tick is one GET of the request rows');
    // the poll failing (offline) keeps away.json as it is
    const before = fs.readFileSync(M.awayPath(A.dataDir), 'utf8');
    api.offline = true;
    clock.t += 5000;
    await A.mover.tick();
    api.offline = false;
    ok(fs.readFileSync(M.awayPath(A.dataDir), 'utf8') === before, 'offline: away.json stays as it was');
    // a mover whose materializer has not listed anything yet keeps the away.json from before
    {
      const dir = path.join(T, 'C', 'data');
      C.writeState(M.awayPath(dir), { v: 1, at: 'x', ids: { [B.me]: { device: 'mac', why: 'owned' } } });
      const fresh = M.createMover({ api, dataDir: dir, key: KEY, now, me: crypto.randomUUID(), up: {}, down: { owners: () => new Map(), status: () => ({ lastOkAt: null }) } });
      ok(fresh.online(B.me) === null, 'online: not known before the devices table was read');
      await fresh.tick();
      ok(C.readState(M.awayPath(dir), null).ids[B.me], 'before the first listing, away.json from before stays');
      ok(fresh.online(B.me) === null, 'online: a device only seen once is not known yet (it may have slept for days)');
      M.dropAway(dir);
      ok(!fs.existsSync(M.awayPath(dir)), 'dropAway deletes it');
    }
  } finally {
    if (process.env.SYNC_TEST_KEEP !== '1') fs.rmSync(T, { recursive: true, force: true });
  }
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
