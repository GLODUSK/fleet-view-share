// Sync up: a test of sync-up.js, the uploader, run with the system node:   node scripts/sync-up-test.js
// Against a fake Supabase (a local HTTP server standing in for PostgREST and Storage that keeps rows and objects in
// memory, enforces the primary keys, the repos (user_id, origin) key and the foreign keys, and refuses an object
// written twice without upsert), through the real sync-api.js. Made-up projects folders for accounts B and A, a
// throwaway git repo with a GitHub origin, one with no origin and a plain folder:
//   a first upload of several conversations with subagents/, tool-results/ and workflows/ (custom-title.json stays
//   home); rows for the device, the repo, this device's path to it and each conversation (owner, rel_cwd, branch,
//   size, sha256, generation; the title sealed; rel_cwd is the folder the log lives in, so a session that moved into a
//   worktree is the root's, and one started outside any repo is its last cwd's); every object opens with openChunk(blob, key, object_path) and the
//   chunks put every file back together byte for byte; appends become new chunks of the same generation; a
//   half-written last line is held back until it ends; a rewrite (and a whole file that changed) becomes generation+1
//   and the old generation's rows and objects are gone; a conversation another device owns is left alone, one with
//   no repo or no whole line is not sent; a failed upload leaves up-state.json where the server is and a later scan
//   finishes it (an upload cut because the machine slept: the very next scan, no back-off); a lost up-state.json sends nothing twice; no transcript text or title ever reaches the server in
//   plain; the pace stays under rateBytesPerSec; start/stop never run two scans at once; status() holds nothing secret.
// S4: flush(id) gives the row's final size and sha256 and catches up a log that grew while it went up; a flush asked
//   for while a scan is mid-way runs right after that conversation, never at the same time as it; hold/unhold/held(),
//   and a hold that comes mid-pass stops it before its next write; forget(id) makes the next pass take over what the
//   server has (and stops a pass under way); only(id); a row whose owner changes mid-upload ends the pass ('lost')
//   with no chunk written after.
// accountOf(id): a new row says the account it gives (a or b, any case) and not the folder's; one learnt for a settled
//   conversation is a PATCH of the meta alone (no updated_at, size or sha256, no chunk sent again); null, another
//   letter or a throw leave the folder's.
// The home row: in a made-up home folder, a chat in the home folder itself, one in a bot's folder with no git, one in
//   a git repo with no origin and one in a folder that is gone all go up under the 'home:' repos row with rel_cwd
//   relative to home (and this device's repo_paths root for it is the home folder); a checkout with an origin under
//   home, and a chat that began under home and went into it, keep the repo's row; a chat outside home is bound.
// Bound (sync-common.js "portable or bound"): the chats never synced before, a git repo with no origin and a plain
//   folder outside home and an app data folder under home, and a placeholder under home, go up under this device's one
//   'bound:<device id>' repos row, rel_cwd their full path, no repo_paths row; the ones that synced before stay as they
//   were (P4V's Perforce folder and a folder under a P4CONFIG file, under home: the home row); one in the temp folder,
//   a Claude account's folder or Fleet View's data folder is not synced; boundFor.
// A crash: up-state.json is written compact, once a scan; with chunk rows past the seq it says comes next (two appends
//   up, the row never caught up, the file from before them), the next process drops them before it appends, so the
//   subagent log and main come back with no gap and no object is left without its row. The fake answers 1000 rows at
//   most, as PostgREST does.
// ownerOf(id) (the materializer's owner()): another device's conversation, listed fresh, is 'foreign' with no request
//   (nor when its log grows); a stale list, one not listing it, none yet or one that throws: the row is asked for;
//   after forget(id) only a list that began later counts; a flush always asks. busy(id): a chat mid-turn goes up at
//   most every 45 s ('throttled'), at once when its turn ends and on a flush; nothing new is never counted waiting.
// Everything happens in a temp folder (SYNC_TEST_DIR, or the system temp folder), deleted at the end
// (SYNC_TEST_KEEP=1 keeps it). Nothing here touches the real ~/.claude* folders, the real Supabase or claude.
// Exit 0 = all pass.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const S = require(path.join(ROOT, 'sync-api.js'));
const K = require(path.join(ROOT, 'sync-crypto.js'));
const C = require(path.join(ROOT, 'sync-common.js'));
const P = require(path.join(ROOT, 'platform.js'));
const U = require(path.join(ROOT, 'sync-up.js'));

const base = process.env.SYNC_TEST_DIR || os.tmpdir();
fs.mkdirSync(base, { recursive: true });
const T = fs.realpathSync(fs.mkdtempSync(path.join(base, 'sync-up-test-')));

let failures = 0, passes = 0;
const ok = (cond, what) => { if (cond) passes++; else { failures++; console.log(`FAIL ${what}`); } };
const eq = (a, b, what) => ok(JSON.stringify(a) === JSON.stringify(b), `${what}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
const same = (a, b) => P.foldCase(path.resolve(a)) === P.foldCase(path.resolve(b));
const write = (f, data) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); };
const append = (f, data) => fs.appendFileSync(f, data);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// values shaped like the real thing are put together here, so this file holds none the share guard would flag
const KEY = 'sb_' + 'publishable_' + 'TestOnlyKey0123456789abcd';
const SYNC_KEY = crypto.randomBytes(32);
const MARK = `PLAIN-${crypto.randomBytes(6).toString('hex')}`; // in every transcript line: must never reach the server

// ---------- the fake Supabase ----------
const UID = crypto.randomUUID();
const AT = `at-${crypto.randomBytes(12).toString('hex')}`;
const PK = { devices: ['id'], repos: ['id'], repo_paths: ['device_id', 'repo_id'], conversations: ['id'], chunks: ['conversation_id', 'file', 'generation', 'seq'] };
const UNIQUE = { repos: [['user_id', 'origin']] };
const FK = {
  repo_paths: [['device_id', 'devices'], ['repo_id', 'repos']],
  conversations: [['repo_id', 'repos'], ['owner_device', 'devices']],
  chunks: [['conversation_id', 'conversations']],
};
const DEFAULTS = {
  devices: () => ({ id: crypto.randomUUID(), created_at: new Date().toISOString(), last_seen_at: null }),
  repos: () => ({ id: crypto.randomUUID() }),
  repo_paths: () => ({}),
  conversations: () => ({ rel_cwd: '', branch: null, title_enc: null, state: 'active', owner_device: null, lease_until: null, size: 0, sha256: null, generation: 0, updated_at: new Date().toISOString(), deleted_at: null }),
  chunks: () => ({ created_at: new Date().toISOString() }),
};
const db = Object.fromEntries(Object.keys(PK).map((t) => [t, []]));
// failObject(name) -> true: that upload fails with failStatus (500 when not set), with failHeaders (Retry-After)
const fake = { calls: [], objects: new Map(), uploads: 0, failObject: null, failStatus: 0, failHeaders: null, onObject: null, order: [] };
const keyOf = (row, cols) => JSON.stringify(cols.map((c) => (row[c] == null ? null : String(row[c]).toLowerCase())));
function match(row, params) {
  for (const [col, v] of params) {
    if (['select', 'order', 'limit', 'offset', 'on_conflict'].includes(col)) continue;
    const m = /^(eq|neq|lt|lte|gt|gte|is)\.(.*)$/s.exec(v);
    if (!m) throw new Error(`the fake does not know the filter ${col}=${v}`);
    const [, op, raw] = m, have = row[col];
    if (op === 'is') { if (raw !== 'null' || have != null) return false; continue; }
    const num = typeof have === 'number';
    const a = num ? have : String(have == null ? '' : have).toLowerCase(), b = num ? Number(raw) : raw.toLowerCase();
    if (op === 'eq' && !(a === b)) return false;
    if (op === 'neq' && !(a !== b)) return false;
    if (op === 'lt' && !(a < b)) return false;
    if (op === 'lte' && !(a <= b)) return false;
    if (op === 'gt' && !(a > b)) return false;
    if (op === 'gte' && !(a >= b)) return false;
  }
  return true;
}
function order(rows, spec) {
  if (!spec) return rows;
  const keys = spec.split(',').map((s) => s.split('.'));
  return rows.slice().sort((x, y) => {
    for (const [col, dir] of keys) {
      const a = x[col], b = y[col];
      if (a === b) continue;
      const r = a < b ? -1 : 1;
      return dir === 'desc' ? -r : r;
    }
    return 0;
  });
}
function restCall(table, req, u, body) {
  const rows = db[table];
  const params = [...u.searchParams.entries()];
  const prefer = String(req.headers.prefer || '');
  const wantRows = /return=representation/.test(prefer);
  if (req.method === 'GET') {
    let out = order(rows.filter((r) => match(r, params)), u.searchParams.get('order'));
    // PostgREST's max-rows: never more than 1000 rows in one answer, whatever limit asks
    const off = Number(u.searchParams.get('offset') || 0), lim = u.searchParams.get('limit');
    out = out.slice(off, off + Math.min(lim == null ? Infinity : Number(lim), 1000));
    return [200, out.map((r) => ({ ...r }))];
  }
  if (req.method === 'POST') {
    const input = JSON.parse(body.toString() || 'null');
    const list = Array.isArray(input) ? input : [input];
    const target = u.searchParams.get('on_conflict') ? u.searchParams.get('on_conflict').split(',') : PK[table];
    const merge = /resolution=merge-duplicates/.test(prefer), ignore = /resolution=ignore-duplicates/.test(prefer);
    const next = rows.map((r) => ({ ...r })), back = [];
    for (const item of list) {
      if ('user_id' in item) return [400, { message: 'the client sent user_id' }];
      const row = { ...DEFAULTS[table](), ...item, user_id: UID };
      for (const [col, other] of FK[table] || []) {
        if (row[col] != null && !db[other].some((r) => String(r.id).toLowerCase() === String(row[col]).toLowerCase())) return [409, { code: '23503', message: `insert on ${table} violates foreign key ${col}` }];
      }
      const keys = [PK[table], ...(UNIQUE[table] || [])];
      const hit = next.findIndex((r) => keyOf(r, target) === keyOf(row, target));
      if (hit >= 0 && (merge || ignore)) {
        if (merge) { Object.assign(next[hit], item); back.push(next[hit]); }
        continue;
      }
      if (keys.some((k) => next.some((r) => keyOf(r, k) === keyOf(row, k)))) return [409, { code: '23505', message: `duplicate key value violates unique constraint on ${table}` }];
      next.push(row);
      back.push(row);
    }
    db[table] = next;
    return [201, wantRows ? back.map((r) => ({ ...r })) : null];
  }
  if (req.method === 'PATCH') {
    const patch = JSON.parse(body.toString());
    const hit = rows.filter((r) => match(r, params));
    for (const r of hit) Object.assign(r, patch);
    return [200, wantRows ? hit.map((r) => ({ ...r })) : null];
  }
  if (req.method === 'DELETE') {
    const gone = rows.filter((r) => match(r, params));
    db[table] = rows.filter((r) => !gone.includes(r));
    return [wantRows ? 200 : 204, wantRows ? gone : null];
  }
  return [405, { message: 'no' }];
}
const server = http.createServer((req, res) => {
  const parts = [];
  req.on('data', (b) => parts.push(b));
  req.on('end', () => {
    const body = Buffer.concat(parts), u = new URL(req.url, 'http://x');
    fake.calls.push({ method: req.method, path: u.pathname, search: u.search, body });
    const json = (code, o, h = null) => {
      if (o === null) { res.writeHead(code); return res.end(); }
      res.writeHead(code, { 'Content-Type': 'application/json', ...(h || {}) });
      res.end(JSON.stringify(o));
    };
    if (req.headers.apikey !== KEY) return json(401, { message: 'No API key found in request' });
    if (String(req.headers.authorization || '') !== `Bearer ${AT}`) return json(401, { code: 'PGRST303', message: 'JWT expired' });
    if (u.pathname.startsWith('/storage/')) {
      const pre = '/storage/v1/object/fleet-sync';
      if (u.pathname === pre && req.method === 'DELETE') {
        const { prefixes } = JSON.parse(body.toString());
        return json(200, prefixes.filter((p) => fake.objects.delete(p)).map((name) => ({ name })));
      }
      const name = u.pathname.slice(pre.length + 1).split('/').map(decodeURIComponent).join('/');
      if (!name.startsWith(`${UID}/`)) return json(400, { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' });
      if (req.method === 'POST') {
        if (fake.failObject && fake.failObject(name)) {
          const st = fake.failStatus || 500;
          return json(st, { statusCode: String(st), error: st >= 500 ? 'internal' : 'InvalidRequest', message: 'the fake storage broke on purpose' }, fake.failHeaders);
        }
        if (fake.objects.has(name) && req.headers['x-upsert'] !== 'true') return json(400, { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' });
        fake.objects.set(name, body);
        fake.uploads++;
        fake.order.push(name.split('/')[2]);
        if (fake.onObject) fake.onObject(name);
        return json(200, { Key: `fleet-sync/${name}` });
      }
      if (req.method === 'GET') {
        if (!fake.objects.has(name)) return json(400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        return res.end(fake.objects.get(name));
      }
      return json(405, { message: 'no' });
    }
    const profile = req.method === 'GET' || req.method === 'HEAD' ? req.headers['accept-profile'] : req.headers['content-profile'];
    if (profile !== 'fleet_sync') return json(406, { code: 'PGRST106', message: 'The schema must be one of the following: public' });
    const m = /^\/rest\/v1\/([a-z_]+)$/.exec(u.pathname);
    if (!m || !db[m[1]]) return json(404, { message: 'no such table' });
    try { const [code, o] = restCall(m[1], req, u, body); json(code, o); } catch (e) { json(400, { message: e.message }); }
  });
});

// ---------- made-up conversations ----------
const g = (cwd, ...args) => cp.execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const ids = {};
const newId = (name) => { ids[name] = crypto.randomUUID(); return ids[name]; };
let lineNo = 0;
const line = (cwd, extra = {}) => `${JSON.stringify({ type: 'user', uuid: crypto.randomUUID(), cwd, gitBranch: 'feat/x', n: lineNo++, text: `${MARK} line ${lineNo} ${'pad '.repeat(lineNo % 40)}`, ...extra })}\n`;
const lines = (cwd, n) => Array.from({ length: n }, () => line(cwd)).join('');
const titleLine = (id, t) => `${JSON.stringify({ type: 'custom-title', customTitle: t, sessionId: id })}\n`;

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const fakeUrl = `http://127.0.0.1:${server.address().port}`;
  const dataDir = path.join(T, 'data');
  fs.mkdirSync(S.syncDir(dataDir), { recursive: true });
  fs.writeFileSync(S.configPath(dataDir), JSON.stringify({ url: fakeUrl, publishableKey: KEY }));
  const session = JSON.stringify({ v: 1, url: fakeUrl, uid: UID, email: 'member@example.com', member: true, refreshToken: 'rt-test', accessToken: AT, expiresAt: Date.now() + 3600e3 });
  const memStore = () => { let text = session; return { kind: 'memory', stamp: () => (text === null ? null : 'm1'), read: async () => text, write: async (t) => { text = t; }, clear: async () => { text = null; } }; };
  const api = S.createSync({ dataDir, fetch: globalThis.fetch, store: memStore(), allowLoopbackUrl: true });
  ok(api.enabled(), 'the fake Supabase is set up');

  // repos and folders
  const repo1 = path.join(T, 'repo1');
  fs.mkdirSync(path.join(repo1, 'sub'), { recursive: true });
  fs.mkdirSync(path.join(repo1, '.claude'), { recursive: true });
  g(repo1, 'init', '-q');
  g(repo1, 'remote', 'add', 'origin', 'git@github.com:Test/Repo1.git');
  const repo2 = path.join(T, 'repo2');
  fs.mkdirSync(repo2, { recursive: true });
  g(repo2, 'init', '-q');
  const plain = path.join(T, 'plain');
  fs.mkdirSync(plain, { recursive: true });
  const gone = path.join(repo1, '.claude', 'worktrees', 'gone'); // a removed worktree: not on disk

  const home = path.join(T, 'home');
  const projB = path.join(home, '.claude', 'projects'), projA = path.join(home, '.claude-a', 'projects');
  fs.mkdirSync(projB, { recursive: true });
  fs.mkdirSync(projA, { recursive: true });
  const slugDir = (proj, cwd) => path.join(proj, C.slugOf(cwd));
  const mainOf = (proj, cwd, id) => path.join(slugDir(proj, cwd), `${id}.jsonl`);

  // A: repo root, account B, with side files and a title; it ends in a worktree, and still resumes from the root
  const A = newId('A');
  const aMain = mainOf(projB, repo1, A), aSide = path.join(slugDir(projB, repo1), A);
  write(aMain, lines(repo1, 20) + titleLine(A, 'Title A secret') + lines(path.join(repo1, '.claude', 'worktrees', 'wt'), 5));
  write(path.join(aSide, 'subagents', 'agent-a1.jsonl'), lines(repo1, 12));
  write(path.join(aSide, 'subagents', 'agent-a1.meta.json'), JSON.stringify({ agentType: 'general', note: MARK }));
  write(path.join(aSide, 'tool-results', 'tr1.txt'), `${MARK} a big tool output\n`.repeat(300));
  write(path.join(aSide, 'workflows', 'run1', 'journal.jsonl'), lines(repo1, 4));
  write(path.join(aSide, 'workflows', 'run1', 'empty.json'), '');
  write(path.join(aSide, 'custom-title.json'), JSON.stringify({ customTitle: 'Title A secret' }));
  // B: a subfolder of the repo, several chunks
  const B = newId('B');
  const bMain = mainOf(projB, path.join(repo1, 'sub'), B);
  write(bMain, lines(path.join(repo1, 'sub'), 120) + titleLine(B, 'Title B secret'));
  // Ac: account A, in a worktree that is gone
  const Ac = newId('Ac');
  const acMain = mainOf(projA, gone, Ac);
  write(acMain, lines(gone, 8));
  // Gm: started in a folder that is no repo, then moved into the repo's subfolder: the subfolder
  const Gm = newId('Gm');
  const gmMain = mainOf(projB, plain, Gm);
  write(gmMain, lines(plain, 2) + lines(path.join(repo1, 'sub'), 3));
  // not synced: no origin, not a repo, no whole line yet
  const D = newId('D'), E = newId('E'), Em = newId('Em');
  write(mainOf(projB, repo2, D), lines(repo2, 3));
  write(mainOf(projB, plain, E), lines(plain, 3));
  write(mainOf(projB, repo1, Em), line(repo1).trimEnd()); // a whole JSON object with no newline after it yet
  // F: owned by another device
  const F = newId('F');
  const fMain = mainOf(projB, repo1, F);
  write(fMain, lines(repo1, 6));
  const otherDev = crypto.randomUUID();
  db.devices.push({ id: otherDev, user_id: UID, name: 'mac', platform: 'darwin', created_at: '', last_seen_at: null });
  db.conversations.push({ ...DEFAULTS.conversations(), id: F, user_id: UID, account: 'b', owner_device: otherDev, size: 5, generation: 0 });
  // make the mtimes tell the order: newest first is B, A, Ac, Gm
  const tNow = Date.now() / 1000;
  fs.utimesSync(gmMain, tNow - 40, tNow - 40);
  fs.utimesSync(acMain, tNow - 30, tNow - 30);
  fs.utimesSync(aMain, tNow - 20, tNow - 20);
  fs.utimesSync(bMain, tNow - 10, tNow - 10);

  let clock = Date.now();
  const logs = [];
  const make = (o = {}) => U.createUploader({
    api, dataDir, key: SYNC_KEY, log: (t) => logs.push(t), now: () => clock, home, // the repos and plain folders are outside it
    projects: [{ account: 'b', dir: projB }, { account: 'a', dir: projA }], chunkBytes: 4096, rateBytesPerSec: 50 * 1024 * 1024, ...o,
  });
  let threw = null;
  try { U.createUploader({ api, dataDir, key: Buffer.alloc(8) }); } catch (e) { threw = e; }
  ok(threw && threw.code === 'bad_key', 'a key that is not 32 bytes is refused');

  // what the server holds, put back together
  const objectsOf = (id) => [...fake.objects.keys()].filter((k) => k.startsWith(`${UID}/t/${id.toLowerCase()}/`));
  const conv = (id) => db.conversations.find((r) => r.id === id.toLowerCase());
  function rebuild(id, file, gen) {
    const rows = db.chunks.filter((r) => r.conversation_id === id.toLowerCase() && r.file === file);
    if (!rows.length) return null;
    const g0 = gen !== undefined ? gen : Math.max(...rows.map((r) => r.generation));
    const mine = rows.filter((r) => r.generation === g0).sort((a, b) => a.seq - b.seq);
    let off = 0;
    const bufs = [];
    for (let i = 0; i < mine.length; i++) {
      const r = mine[i];
      if (r.seq !== i || r.byte_offset !== off) return { error: `gap at seq ${i}` };
      if (r.object_path !== C.objectPath(id, file, g0, i)) return { error: `object_path ${r.object_path}` };
      const blob = fake.objects.get(`${UID}/${r.object_path}`);
      if (!blob) return { error: `no object for ${r.object_path}` };
      let plainBuf;
      try { plainBuf = K.openChunk(blob, SYNC_KEY, r.object_path); } catch (e) { return { error: `did not open: ${e.message}` }; }
      if (plainBuf.length !== r.byte_length || K.sha256(plainBuf) !== r.sha256) return { error: `chunk ${i} length or sha256` };
      bufs.push(plainBuf);
      off += r.byte_length;
    }
    return { buf: Buffer.concat(bufs), gen: g0, chunks: mine.length };
  }
  const wholeLines = (file) => { const b = fs.readFileSync(file); const i = b.lastIndexOf(10); return b.subarray(0, i + 1); };
  function sameAsLocal(id, file, local, appendOnly, what) {
    const r = rebuild(id, file);
    const want = appendOnly ? wholeLines(local) : fs.readFileSync(local);
    ok(r && !r.error && r.buf.equals(want), `${what}: ${file} comes back byte for byte${r && r.error ? ` (${r.error})` : ''}`);
    return r;
  }
  function rowMatchesMain(id, local, what) {
    const c = conv(id), want = wholeLines(local);
    ok(c && Number(c.size) === want.length && c.sha256 === K.sha256(want), `${what}: the row's size and sha256 are the log's whole lines (${c && c.size} vs ${want.length})`);
    ok(c && c.generation === rebuild(id, 'main').gen, `${what}: the row points at the newest generation`);
  }
  const upState = () => C.readState(path.join(S.syncDir(dataDir), 'up-state.json'), null);

  // ---------- the first upload ----------
  let up = make();
  await up.scanOnce();
  let st = up.status();
  eq(st.lastError, null, 'first scan: no error');
  eq(db.devices.length, 2, 'first scan: this device made its row');
  const dev = C.readState(C.devicePath(dataDir), {}).id;
  ok(db.devices.some((d) => d.id === dev && d.platform === process.platform), 'the device row is this machine');
  eq(db.repos.map((r) => r.origin).sort(), ['https://github.com/test/repo1', C.boundOrigin(dev)].sort(), 'two repos rows: the origin normalized, and this device\'s bound row (the no-origin repo and the plain folder outside home)');
  ok(db.repo_paths.length === 1 && db.repo_paths[0].device_id === dev && same(db.repo_paths[0].root, repo1), 'repo_paths: this device has the repo at its main checkout');
  eq(db.conversations.map((r) => r.id).sort(), [A, Ac, B, D, E, F, Gm].map((x) => x.toLowerCase()).sort(), 'conversations rows: A, B, Ac, Gm, the bound D and E (and F, already there); none with no whole line');
  const boundRow = db.repos.find((r) => r.origin === C.boundOrigin(dev));
  for (const [id, folder, what] of [[D, repo2, 'a git repo with no origin outside home'], [E, plain, 'a plain folder outside home']]) {
    const c = conv(id);
    ok(c && boundRow && c.repo_id === boundRow.id && c.rel_cwd === C.boundRel(folder) && c.owner_device === dev, `bound: ${what}: this device's bound row, rel_cwd its full path (${c && c.rel_cwd})`);
  }
  ok(!db.repo_paths.some((r) => boundRow && r.repo_id === boundRow.id), 'bound: no repo_paths row for the bound row');
  for (const [id, rel, acct] of [[A, '', 'b'], [B, 'sub', 'b'], [Ac, '.claude/worktrees/gone', 'a'], [Gm, 'sub', 'b']]) {
    const c = conv(id);
    ok(c && c.owner_device === dev && c.rel_cwd === rel && c.account === acct && c.branch === 'feat/x' && c.state === 'active', `row ${short(id)}: owner, rel_cwd '${rel}', account ${acct}, branch (${JSON.stringify(c && { o: c.owner_device === dev, rel: c.rel_cwd, a: c.account, b: c.branch })})`);
  }
  eq(K.openText(conv(A).title_enc, SYNC_KEY, `title:${A.toLowerCase()}`), 'Title A secret', 'A\'s title is sealed and opens with title:<id>');
  eq(K.openText(conv(B).title_enc, SYNC_KEY, `title:${B.toLowerCase()}`), 'Title B secret', 'B\'s title too');
  let threwTitle = false;
  try { K.openText(conv(A).title_enc, SYNC_KEY, `title:${B.toLowerCase()}`); } catch { threwTitle = true; }
  ok(threwTitle, 'a title does not open under another conversation\'s label');
  eq(conv(Ac).title_enc, null, 'no title: title_enc is null');
  sameAsLocal(A, 'main', aMain, true, 'A');
  sameAsLocal(A, 'subagents/agent-a1.jsonl', path.join(aSide, 'subagents', 'agent-a1.jsonl'), true, 'A');
  sameAsLocal(A, 'subagents/agent-a1.meta.json', path.join(aSide, 'subagents', 'agent-a1.meta.json'), false, 'A');
  sameAsLocal(A, 'tool-results/tr1.txt', path.join(aSide, 'tool-results', 'tr1.txt'), false, 'A');
  sameAsLocal(A, 'workflows/run1/journal.jsonl', path.join(aSide, 'workflows', 'run1', 'journal.jsonl'), true, 'A');
  const emptyBack = rebuild(A, 'workflows/run1/empty.json');
  ok(emptyBack && emptyBack.buf && emptyBack.buf.length === 0 && emptyBack.chunks === 1, 'an empty whole file is one empty chunk');
  ok(!db.chunks.some((r) => r.file.includes('custom-title')), 'custom-title.json is not synced');
  const bBack = sameAsLocal(B, 'main', bMain, true, 'B');
  ok(bBack && bBack.chunks > 3 && db.chunks.filter((r) => r.conversation_id === B.toLowerCase()).every((r) => r.byte_length <= 4096), `B went up as several chunks of at most chunkBytes (${bBack && bBack.chunks})`);
  sameAsLocal(Ac, 'main', acMain, true, 'Ac');
  for (const id of [A, B, Ac]) rowMatchesMain(id, { [A]: aMain, [B]: bMain, [Ac]: acMain }[id], short(id));
  eq(db.chunks.filter((r) => r.conversation_id === F.toLowerCase()).length, 0, 'F (another device\'s) got no chunks');
  ok(conv(F).owner_device === otherDev && conv(F).size === 5, 'F\'s row is untouched');
  ok([...fake.objects.values()].every((b) => b.subarray(0, 4).toString() === 'FVS1'), 'every object is a sealed FVS1 blob');
  for (const k of fake.objects.keys()) {
    const rel = k.slice(UID.length + 1);
    ok(db.chunks.some((r) => r.object_path === rel), `every object has its chunk row (${rel})`);
  }
  eq(st.conversations, 8, 'status: eight conversations found');
  eq([st.synced, st.skipped.foreign, st.skipped.noRepo, st.skipped.empty], [6, 1, 0, 1], 'status: 6 synced (two of them bound), 1 another device\'s, none with no repo, 1 with no whole line');
  let s = upState();
  ok(s && s.v === 1 && s.device === dev && s.conversations[A.toLowerCase()] && s.conversations[A.toLowerCase()].files.main.offset === wholeLines(aMain).length, 'up-state.json remembers each file\'s uploaded end');

  // ---------- nothing changed: nothing sent ----------
  let calls0 = fake.calls.length, up0 = fake.uploads;
  await up.scanOnce();
  eq(fake.uploads - up0, 0, 'an unchanged scan uploads nothing');
  ok(fake.calls.slice(calls0).every((c) => c.method === 'GET'), `an unchanged scan writes no row (${fake.calls.slice(calls0).map((c) => `${c.method} ${c.path}`).join(', ')})`);

  // ---------- appends ----------
  const aChunks0 = db.chunks.filter((r) => r.conversation_id === A.toLowerCase() && r.file === 'main').length;
  const aObjs0 = objectsOf(A).length;
  append(aMain, lines(repo1, 3));
  append(path.join(aSide, 'subagents', 'agent-a1.jsonl'), lines(repo1, 2));
  await up.scanOnce();
  const aMainRows = db.chunks.filter((r) => r.conversation_id === A.toLowerCase() && r.file === 'main');
  ok(aMainRows.length > aChunks0 && aMainRows.every((r) => r.generation === 0), `an append is new chunks of the same generation (${aChunks0} -> ${aMainRows.length})`);
  ok(objectsOf(A).length > aObjs0, 'and new objects; the old ones stay');
  sameAsLocal(A, 'main', aMain, true, 'A after an append');
  sameAsLocal(A, 'subagents/agent-a1.jsonl', path.join(aSide, 'subagents', 'agent-a1.jsonl'), true, 'A after an append');
  rowMatchesMain(A, aMain, 'A after an append');

  // ---------- a half-written last line ----------
  const sizeBefore = conv(A).size, rowsBefore = db.chunks.length;
  const half = line(repo1);
  append(aMain, half.slice(0, 25));
  await up.scanOnce();
  eq(conv(A).size, sizeBefore, 'a half-written line is held back (the row is unchanged)');
  eq(db.chunks.length, rowsBefore, 'and no chunk carries it');
  append(aMain, half.slice(25));
  await up.scanOnce();
  ok(conv(A).size === sizeBefore + Buffer.byteLength(half), 'once the line ends it goes up');
  sameAsLocal(A, 'main', aMain, true, 'A after the half line ended');
  rowMatchesMain(A, aMain, 'A after the half line ended');
  // a new subagent appears in a known conversation
  write(path.join(aSide, 'subagents', 'agent-a2.jsonl'), lines(repo1, 3));
  await up.scanOnce();
  sameAsLocal(A, 'subagents/agent-a2.jsonl', path.join(aSide, 'subagents', 'agent-a2.jsonl'), true, 'A\'s new subagent');

  // ---------- a rewrite: generation + 1, the old one gone ----------
  const bOld = db.chunks.filter((r) => r.conversation_id === B.toLowerCase()).map((r) => r.object_path);
  write(bMain, lines(path.join(repo1, 'sub'), 10));
  const metaPath = path.join(aSide, 'subagents', 'agent-a1.meta.json');
  const metaOld = db.chunks.filter((r) => r.conversation_id === A.toLowerCase() && r.file === 'subagents/agent-a1.meta.json').map((r) => r.object_path);
  write(metaPath, JSON.stringify({ agentType: 'general', note: MARK, changed: true }));
  await up.scanOnce();
  const bRows = db.chunks.filter((r) => r.conversation_id === B.toLowerCase());
  ok(bRows.length > 0 && bRows.every((r) => r.generation === 1), `a shorter, different log is generation 1 and only it is left (${[...new Set(bRows.map((r) => r.generation))]})`);
  ok(bOld.every((p) => !fake.objects.has(`${UID}/${p}`)), 'the old generation\'s objects are deleted');
  eq(conv(B).generation, 1, 'B\'s row points at generation 1');
  sameAsLocal(B, 'main', bMain, true, 'B after a rewrite');
  rowMatchesMain(B, bMain, 'B after a rewrite');
  const mRows = db.chunks.filter((r) => r.conversation_id === A.toLowerCase() && r.file === 'subagents/agent-a1.meta.json');
  ok(mRows.length === 1 && mRows[0].generation === 1 && metaOld.every((p) => !fake.objects.has(`${UID}/${p}`)), 'a whole file that changed is generation 1, the old one gone');
  sameAsLocal(A, 'subagents/agent-a1.meta.json', metaPath, false, 'A\'s changed meta.json');
  // a log whose middle changed but grew (the tail does not match): a new generation too
  const acText = fs.readFileSync(acMain, 'utf8');
  write(acMain, acText.replace(MARK, `${MARK}-edited`) + lines(gone, 2));
  await up.scanOnce();
  eq([...new Set(db.chunks.filter((r) => r.conversation_id === Ac.toLowerCase()).map((r) => r.generation))], [1], 'a changed tail that grew is generation 1 too');
  sameAsLocal(Ac, 'main', acMain, true, 'Ac after its tail changed');
  rowMatchesMain(Ac, acMain, 'Ac after its tail changed');

  // ---------- a failed upload (a 4xx: the row's own fault): state stays with the server, a later scan finishes it ----------
  const G = newId('G');
  const gMain = mainOf(projB, repo1, G);
  write(gMain, lines(repo1, 80));
  let failed = 0;
  fake.failStatus = 422;
  fake.failObject = (name) => name.startsWith(`${UID}/t/${G.toLowerCase()}/`) && name.endsWith('/0/3') && ++failed > 0;
  logs.length = 0;
  const cleanBefore = up.status().health.lastCleanAt;
  clock += 1000; // the times below tell this scan from the last one
  await up.scanOnce();
  st = up.status();
  ok(st.lastError && /422|broke/.test(st.lastError.message), `the failure is in status().lastError (${st.lastError && st.lastError.message})`);
  ok(st.health && st.health.lastError && st.health.failStreak === 0 && !st.health.backingOff && st.health.lastCleanAt === cleanBefore
    && Date.parse(st.health.lastSuccessAt) > Date.parse(cleanBefore),
    `a row's own failure: in health.lastError, no scan-level back-off (${JSON.stringify(st.health)})`);
  ok(logs.some((l) => l.includes(short(G)) && /failed/.test(l)), 'and logged');
  s = upState();
  const gs = s.conversations[G.toLowerCase()];
  const gRows = db.chunks.filter((r) => r.conversation_id === G.toLowerCase());
  ok(gs && gs.files.main && gs.files.main.seq === 3 && gs.files.main.offset === gRows.reduce((n, r) => n + r.byte_length, 0), `up-state.json stopped at what the server has (seq ${gs && gs.files.main && gs.files.main.seq}, ${gRows.length} rows)`);
  eq(conv(G).size, 0, 'G\'s row claims nothing yet');
  ok(st.backingOff === 0 && st.pending >= 1 && st.pendingBytes > 0, `status counts it pending (${st.pending}, ${st.pendingBytes} bytes)`);
  fake.failObject = null;
  fake.failStatus = 0;
  up0 = fake.uploads;
  clock += 1000;
  await up.scanOnce();
  eq(fake.uploads - up0, 0, 'while it backs off, it is not tried');
  st = up.status();
  ok(st.lastError === null && st.health.lastError === null && Date.parse(st.health.lastCleanAt) > Date.parse(cleanBefore), 'a clean scan clears lastError (and health.lastError)');
  ok(up.status().backingOff === 1, 'status says one is backing off');
  clock += 31e3;
  await up.scanOnce();
  sameAsLocal(G, 'main', gMain, true, 'G after the retry');
  rowMatchesMain(G, gMain, 'G after the retry');
  eq(new Set(db.chunks.filter((r) => r.conversation_id === G.toLowerCase()).map((r) => r.seq)).size, db.chunks.filter((r) => r.conversation_id === G.toLowerCase()).length, 'no chunk was written twice');

  // ---------- an upload cut because the machine slept: no back-off, the next scan sends it ----------
  const Hs = newId('H');
  const hsMain = mainOf(projB, repo1, Hs);
  write(hsMain, lines(repo1, 20));
  const realUpload = api.storage.upload;
  let sleptAt = null;
  api.storage.upload = async (p, b, o) => {
    if (sleptAt || !p.includes(Hs.toLowerCase())) return realUpload(p, b, o);
    sleptAt = p;
    throw Object.assign(new S.SyncError('the connection was cut by sleep; trying again', 0, 'network'), { slept: true });
  };
  logs.length = 0;
  await up.scanOnce();
  api.storage.upload = realUpload;
  ok(sleptAt && logs.some((l) => l.includes(short(Hs)) && /cut by sleep/.test(l)), 'a sleep cut is logged');
  await up.scanOnce();
  sameAsLocal(Hs, 'main', hsMain, true, 'a sleep cut: sent by the very next scan, no back-off');
  await scanBackoff(up, { projB, repo1, mainOf, now: () => clock, later: (ms) => { clock += ms; }, logs, sameAsLocal });

  // ---------- F changes hands: no upload while another device owns it ----------
  append(fMain, lines(repo1, 2));
  up0 = fake.uploads;
  await up.scanOnce();
  eq(fake.uploads - up0, 0, 'another device\'s conversation stays alone even when it grows here');

  // ---------- a lost up-state.json sends nothing twice ----------
  fs.rmSync(path.join(S.syncDir(dataDir), 'up-state.json'));
  const before = JSON.stringify(db.chunks.map((r) => [r.conversation_id, r.file, r.generation, r.seq, r.sha256]).sort());
  up0 = fake.uploads;
  logs.length = 0;
  const up2 = make();
  await up2.scanOnce();
  eq(fake.uploads - up0, 0, 'with up-state.json gone, what the server has is taken over, not sent again');
  eq(JSON.stringify(db.chunks.map((r) => [r.conversation_id, r.file, r.generation, r.seq, r.sha256]).sort()), before, 'the chunk rows are the same');
  ok(logs.some((l) => /took over/.test(l)), 'it says it took them over');
  append(aMain, lines(repo1, 2));
  await up2.scanOnce();
  sameAsLocal(A, 'main', aMain, true, 'A appended after a take-over');
  rowMatchesMain(A, aMain, 'A appended after a take-over');

  Object.assign(ctx, { projB, repo1, mainOf, conv, sameAsLocal, rowMatchesMain, wholeLines, upState, dev, otherDev, F, logs, make, tick: (ms) => { clock += ms; } });
  await s4(up2);

  // ---------- no plain text ever reached the server ----------
  const titles = ['Title A secret', 'Title B secret'];
  const leaks = fake.calls.filter((c) => {
    const text = `${c.search} ${c.body.toString('latin1')}`;
    return text.includes(MARK) || titles.some((t) => text.includes(t)) || text.includes('a big tool output');
  });
  eq(leaks.map((c) => `${c.method} ${c.path}`), [], 'no request carried transcript text or a title');
  const stText = JSON.stringify(up2.status());
  ok(!stText.includes(MARK) && !titles.some((t) => stText.includes(t)) && !stText.includes(SYNC_KEY.toString('base64')) && !stText.includes(SYNC_KEY.toString('hex')) && !stText.includes(AT), 'status() holds no text, title, key or token');

  // ---------- one scan at a time; start and stop ----------
  const p1 = up2.scanOnce(), p2 = up2.scanOnce();
  ok(p1 === p2, 'scanOnce while a scan runs gives the running one');
  await p1;
  const n0 = up2.status().scans;
  up2.start(20);
  ok(up2.status().running, 'start: running');
  for (let i = 0; i < 100 && up2.status().scans < n0 + 2; i++) await wait(20);
  ok(up2.status().scans >= n0 + 2, 'start runs scans on its timer');
  await up2.stop();
  const n1 = up2.status().scans;
  await wait(120);
  ok(!up2.status().running && !up2.status().scanning && up2.status().scans === n1, 'stop: no scan after it');
  up.stop();

  // ---------- the pace ----------
  const projP = path.join(T, 'paced');
  const H = newId('H');
  const hMain = mainOf(projP, repo1, H);
  write(hMain, Array.from({ length: 40 }, () => `${JSON.stringify({ cwd: repo1, r: crypto.randomBytes(1500).toString('base64') })}\n`).join(''));
  const rate = 200 * 1024;
  const upP = U.createUploader({ api, dataDir: path.join(T, 'data-paced'), key: SYNC_KEY, projects: [{ account: 'b', dir: projP }], chunkBytes: 32 * 1024, rateBytesPerSec: rate });
  const upB0 = fake.uploads, sentBefore = [...fake.objects.values()].reduce((n, b) => n + b.length, 0);
  const t0 = Date.now();
  await upP.scanOnce();
  const took = Date.now() - t0;
  const hObjs = objectsOf(H).map((k) => fake.objects.get(k).length);
  const total = hObjs.reduce((n, x) => n + x, 0), first = Math.max(...hObjs);
  ok(fake.uploads - upB0 === hObjs.length && hObjs.length >= 3, `the paced conversation went up in ${hObjs.length} chunks`);
  ok(took >= ((total - first) / rate) * 1000 - 30, `it kept to rateBytesPerSec (${took} ms for ${total} sealed bytes at ${rate}/s)`);
  sameAsLocal(H, 'main', hMain, true, 'H');
  void sentBefore;

  // ---------- the home row: under the home folder, in no repo with an origin ----------
  const uh = path.join(T, 'uhome'); // a made-up home folder, with its own projects folder
  const projH = path.join(uh, '.claude', 'projects');
  fs.mkdirSync(projH, { recursive: true });
  const bots = path.join(uh, 'Bots', 'panchito'); // a bot's folder: no git at all
  fs.mkdirSync(bots, { recursive: true });
  const local = path.join(uh, 'code', 'local'); // a git repo with no origin
  fs.mkdirSync(local, { recursive: true });
  g(local, 'init', '-q');
  const hRepo = path.join(uh, 'code', 'home-repo'); // a checkout with an origin, under home: keeps its repo row
  fs.mkdirSync(hRepo, { recursive: true });
  g(hRepo, 'init', '-q');
  g(hRepo, 'remote', 'add', 'origin', 'https://github.com/Test/Home-Repo.git');
  const scratchGone = path.join(uh, 'Scratchpads', 'scratch-gone'); // not on disk any more
  const outside = path.join(T, 'outside'); // not under home, no repo: stays unsynced
  const broken = path.join(uh, 'code', 'broken', 'sub'); // under a .git that git cannot read: a repo's, it waits for git
  fs.mkdirSync(broken, { recursive: true });
  fs.writeFileSync(path.join(uh, 'code', 'broken', '.git'), 'gitdir: ' + path.join(T, 'no-such-gitdir'));
  fs.mkdirSync(outside, { recursive: true });
  const hHome = newId('hHome'), hBot = newId('hBot'), hLocal = newId('hLocal'), hGone = newId('hGone'), hRep = newId('hRep'), hOut = newId('hOut'), hMoved = newId('hMoved'), hBroken = newId('hBroken');
  write(mainOf(projH, broken, hBroken), lines(broken, 3));
  write(mainOf(projH, uh, hHome), lines(uh, 3));
  write(mainOf(projH, bots, hBot), lines(bots, 4));
  write(mainOf(projH, local, hLocal), lines(local, 3));
  write(mainOf(projH, scratchGone, hGone), lines(scratchGone, 3));
  write(mainOf(projH, hRepo, hRep), lines(hRepo, 3));
  write(mainOf(projH, outside, hOut), lines(outside, 3));
  write(mainOf(projH, bots, hMoved), lines(bots, 2) + lines(hRepo, 2)); // began in the bot's folder, went into the repo
  eq(U.homeFor(uh, uh), { origin: C.HOME_ORIGIN, mainRoot: path.resolve(uh), relCwd: '' }, 'homeFor: the home folder itself is rel_cwd \'\'');
  eq(U.homeFor(path.join(uh, '..x', 'y'), uh) && U.homeFor(path.join(uh, '..x', 'y'), uh).relCwd, '..x/y', 'homeFor: a folder named ..x is still under home');
  eq([U.homeFor(outside, uh), U.homeFor(T, uh), U.homeFor(P.isWin ? '/Users/henry/x' : 'C:\\Users\\henry\\x', uh)], [null, null, null], 'homeFor: outside home, above it, or another platform\'s path: none');
  eq([U.homeFor(path.join(uh, 'AppData', 'Local', 'Temp', 'x'), uh), U.homeFor(path.join(uh, 'Library', 'Caches'), uh)], [null, null], 'homeFor: not under AppData or Library');
  eq(U.homeFor(path.join(uh, 'AppDataX'), uh) && U.homeFor(path.join(uh, 'AppDataX'), uh).relCwd, 'AppDataX', 'homeFor: a folder merely starting with AppData is synced');
  eq([U.homeFor(path.join(uh, '.claude-a'), uh), U.homeFor(path.join(uh, '.claude-c', 'projects'), uh)], [null, null], 'homeFor: not in a Claude account\'s folder');
  ok(U.homeFor(path.join(uh, '.claude-handoffs'), uh) && U.homeFor(path.join(uh, '.claude'), uh), 'homeFor: .claude and .claude-handoffs are synced');
  const upH = U.createUploader({ api, dataDir, key: SYNC_KEY, home: uh, projects: [{ account: 'b', dir: projH }], chunkBytes: 4096, rateBytesPerSec: 50 * 1024 * 1024 });
  await upH.scanOnce();
  const hst = upH.status();
  eq(hst.lastError, null, 'home: no error');
  eq([hst.synced, hst.skipped.noRepo], [7, 1], 'home: seven synced (the one outside home bound); the one under a .git git could not read skipped as noRepo');
  const homeRow = db.repos.find((r) => r.origin === C.HOME_ORIGIN);
  const hRepoRow = db.repos.find((r) => r.origin === 'https://github.com/test/home-repo');
  ok(!!homeRow && db.repos.filter((r) => r.origin === C.HOME_ORIGIN).length === 1, 'home: one repos row with the home origin');
  ok(!!hRepoRow, 'home: the checkout under home got its own repos row');
  const hp = homeRow && db.repo_paths.find((r) => r.device_id === dev && r.repo_id === homeRow.id);
  ok(hp && same(hp.root, uh), `home: this device's repo_paths root for the home row is its home folder (${hp && hp.root})`);
  for (const [id, rid, rel, what] of [[hHome, homeRow, '', 'the home folder itself'], [hBot, homeRow, 'Bots/panchito', 'a bot\'s folder with no git'],
    [hLocal, homeRow, 'code/local', 'a git repo with no origin'], [hGone, homeRow, 'Scratchpads/scratch-gone', 'a folder that is gone'],
    [hRep, hRepoRow, '', 'a repo with an origin under home'], [hMoved, hRepoRow, '', 'one that began under home and went into a repo']]) {
    const c = conv(id);
    ok(c && rid && c.repo_id === rid.id && c.rel_cwd === rel && c.owner_device === dev, `home: ${what}: ${rid === homeRow ? 'the home row' : 'its repo row'}, rel_cwd '${rel}' (${JSON.stringify(c && { home: c.repo_id === (homeRow && homeRow.id), rel: c.rel_cwd })})`);
  }
  const hOutRow = conv(hOut), hBound = db.repos.find((r) => r.origin === C.boundOrigin(dev));
  ok(hOutRow && hBound && hOutRow.repo_id === hBound.id && hOutRow.rel_cwd === C.boundRel(outside), `home: a chat outside home in no repo is bound: the bound row, its full path (${hOutRow && hOutRow.rel_cwd})`);
  ok(!conv(hBroken), 'home: a chat under a .git git could not read has no row (never the home row)');
  sameAsLocal(hBot, 'main', mainOf(projH, bots, hBot), true, 'home: the bot\'s chat');
  rowMatchesMain(hBot, mainOf(projH, bots, hBot), 'home: the bot\'s chat');
  await upH.stop();

  // ---------- bound: a workspace only this machine has ----------
  const bh = path.join(T, 'bhome'); // another made-up home folder, with a made-up temp folder beside it
  const projBd = path.join(bh, '.claude', 'projects');
  const fakeTemp = path.join(T, 'faketemp');
  const bP4 = path.join(bh, 'Perforce', 'ws', 'game'); // P4V's default home for workspaces: bound, never the home row
  const bCfgRoot = path.join(bh, 'depot', 'proj'), bCfg = path.join(bCfgRoot, 'src'); // a P4CONFIG file above the folder
  const bLib = path.join(bh, 'Library', 'Application Support', 'Claude', 'scratch'); // an app data folder
  const bPh = C.boundPlaceholder(bh, 'BlackBox', 'C:/Perforce/ws'); // another machine's bound chat, resumed here
  const bTmp = path.join(fakeTemp, 'x'); // the temp folder: never synced
  const bOut = path.join(T, 'elsewhere', 'proj'); // outside home, no repo
  const bAcct = path.join(bh, '.claude-a'), bData = path.join(dataDir, 'tool'); // a Claude account's folder, Fleet View's own
  for (const d of [projBd, bP4, bCfg, bLib, bPh, bTmp, bOut, bAcct, bData]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(bCfgRoot, '.p4config'), 'P4CLIENT=henry-ws\n');
  const bIds = { p4: newId('bP4'), cfg: newId('bCfg'), lib: newId('bLib'), ph: newId('bPh'), tmp: newId('bTmp'), out: newId('bOut'), acct: newId('bAcct'), data: newId('bData') };
  const bFolders = { p4: bP4, cfg: bCfg, lib: bLib, ph: bPh, tmp: bTmp, out: bOut, acct: bAcct, data: bData };
  for (const k of Object.keys(bIds)) write(mainOf(projBd, bFolders[k], bIds[k]), lines(bFolders[k], 3));
  const upB = U.createUploader({ api, dataDir, key: SYNC_KEY, home: bh, temp: [fakeTemp], projects: [{ account: 'b', dir: projBd }], chunkBytes: 4096, rateBytesPerSec: 50 * 1024 * 1024 });
  await upB.scanOnce();
  const bst = upB.status();
  eq(bst.lastError, null, 'bound: no error');
  eq([bst.synced, bst.skipped.noRepo], [5, 3], 'bound: five synced; the ones in the temp folder, a Claude account\'s folder and Fleet View\'s data folder skipped');
  ok(!conv(bIds.acct) && !conv(bIds.data), 'bound: a Claude account\'s folder and Fleet View\'s data folder have no row (a tool\'s chats)');
  const bRow = db.repos.find((r) => r.origin === C.boundOrigin(dev));
  ok(bRow && db.repos.filter((r) => r.origin === C.boundOrigin(dev)).length === 1, 'bound: one bound repos row for this device, whatever the folder');
  for (const [k, what] of [['lib', 'an app data folder under home'], ['ph', 'a placeholder under home'], ['out', 'a folder outside home']]) {
    const c = conv(bIds[k]);
    ok(c && bRow && c.repo_id === bRow.id && c.rel_cwd === C.boundRel(bFolders[k]) && c.owner_device === dev, `bound: ${what}: the bound row, rel_cwd its full path (${c && c.rel_cwd})`);
  }
  // a Perforce workspace under home is bound (/state says so), but it synced under the home row before and still does
  for (const [k, rel, what] of [['p4', 'Perforce/ws/game', 'P4V\'s Perforce folder under home'], ['cfg', 'depot/proj/src', 'a folder under a P4CONFIG file']]) {
    const c = conv(bIds[k]);
    ok(c && homeRow && c.repo_id === homeRow.id && c.rel_cwd === rel, `bound: ${what}: still the home row, rel_cwd '${rel}' (${c && c.rel_cwd})`);
  }
  ok(!conv(bIds.tmp), 'bound: a chat in the temp folder has no row');
  sameAsLocal(bIds.p4, 'main', mainOf(projBd, bP4, bIds.p4), true, 'bound: the Perforce chat');
  rowMatchesMain(bIds.p4, mainOf(projBd, bP4, bIds.p4), 'bound: the Perforce chat');
  eq(U.boundFor(bOut, dev), { origin: C.boundOrigin(dev), mainRoot: null, relCwd: C.boundRel(bOut), bound: true }, 'boundFor: this device\'s bound row and the full path');
  eq(U.boundFor(P.isWin ? '/Users/henry/x' : 'C:\\x', dev), null, 'boundFor: another platform\'s path: none');
  await upB.stop();

  // ---------- a crash between chunk rows and up-state.json: the rows past the saved seq go, no gap ----------
  // Two appends went up in two scans (seq 1 and 2 of main and of a subagent log) but the conversation row never caught
  // up (its PATCH failed), and up-state.json is the one from before them (the crash). The next process sends seq 1
  // again, now covering both appends and one more: the old seq 2 must not stay behind it.
  const projX = path.join(T, 'crash'), dataX = path.join(T, 'data-crash');
  const X1 = newId('X1'), X2 = newId('X2');
  const xMain = mainOf(projX, repo1, X1), xSub = path.join(slugDir(projX, repo1), X1, 'subagents', 'agent-x.jsonl');
  write(xMain, lines(repo1, 4));
  write(xSub, lines(repo1, 4));
  write(mainOf(projX, repo1, X2), lines(repo1, 3));
  const xLogs = [];
  const mkX = () => U.createUploader({ api, dataDir: dataX, key: SYNC_KEY, log: (t) => xLogs.push(t), now: () => clock, home, projects: [{ account: 'b', dir: projX }], chunkBytes: 4096, rateBytesPerSec: 50 * 1024 * 1024 });
  const xState = path.join(S.syncDir(dataX), 'up-state.json');
  const realRename = fs.renameSync;
  let xSaves = 0;
  fs.renameSync = function (from, to, ...a) { if (typeof to === 'string' && same(to, xState)) xSaves++; return realRename.call(this, from, to, ...a); };
  const upX1 = mkX();
  try { await upX1.scanOnce(); } finally { fs.renameSync = realRename; }
  eq(xSaves, 1, 'up-state.json: written once for a scan of two conversations');
  ok(!fs.readFileSync(xState, 'utf8').includes('\n '), 'up-state.json: written compact, no indentation');
  sameAsLocal(X1, 'subagents/agent-x.jsonl', xSub, true, 'crash: before');
  const savedX = fs.readFileSync(xState);
  const xSize0 = Number(conv(X1).size);
  const realRest = api.rest;
  api.rest = async (m, t, o) => {
    if (m === 'PATCH' && t === 'conversations' && o && o.query && o.query.id === `eq.${X1.toLowerCase()}`) throw new S.SyncError('the fake PATCH broke on purpose', 0, 'network');
    return realRest(m, t, o);
  };
  try {
    for (let i = 0; i < 2; i++) {
      append(xMain, lines(repo1, 2));
      append(xSub, lines(repo1, 2));
      clock += 3600e3; // past the back-off
      await upX1.scanOnce();
    }
  } finally { api.rest = realRest; }
  const xSubRows = () => db.chunks.filter((r) => r.conversation_id === X1.toLowerCase() && r.file === 'subagents/agent-x.jsonl');
  eq(xSubRows().map((r) => r.seq).sort(), [0, 1, 2], 'crash: two appends went up as seq 1 and 2');
  eq(Number(conv(X1).size), xSize0, 'crash: the row never caught up');
  await upX1.stop();
  fs.writeFileSync(xState, savedX); // the crash: up-state.json from before the two appends
  append(xMain, lines(repo1, 1));
  append(xSub, lines(repo1, 1));
  clock += 3600e3;
  const upX2 = mkX();
  await upX2.scanOnce();
  eq(upX2.status().lastError, null, 'crash: no error after it');
  sameAsLocal(X1, 'subagents/agent-x.jsonl', xSub, true, 'crash: the subagent log after it (no gap)');
  sameAsLocal(X1, 'main', xMain, true, 'crash: main after it');
  rowMatchesMain(X1, xMain, 'crash: main after it');
  eq(xSubRows().map((r) => r.seq).sort(), [0, 1], 'crash: the old seq 2 is gone, seq 1 covers all three appends');
  const xRows = new Set(db.chunks.filter((r) => r.conversation_id === X1.toLowerCase()).map((r) => `${UID}/${r.object_path}`));
  eq(objectsOf(X1).filter((k) => !xRows.has(k)), [], 'crash: no object left without its row');
  ok(xLogs.some((t) => /dropped 2 chunk row\(s\) from seq 1 on/.test(t)), `crash: logged (${xLogs.filter((t) => /dropped/.test(t)).join(' | ')})`);
  const callsX = fake.calls.length;
  append(xSub, lines(repo1, 1));
  await upX2.scanOnce();
  ok(!fake.calls.slice(callsX).some((c) => c.method === 'DELETE' || (c.method === 'GET' && /seq=gte/.test(decodeURIComponent(c.search)))), 'crash: the next append in the same process asks nothing more');
  sameAsLocal(X1, 'subagents/agent-x.jsonl', xSub, true, 'crash: a later append');
  await upX2.stop();

  // ---------- ownerOf: another device's conversation costs no request while the materializer's rows say so ----------
  {
    const lc = (id) => id.toLowerCase();
    const Z = newId('Z');
    const zMain = mainOf(projB, repo1, Z);
    write(zMain, lines(repo1, 4));
    db.conversations.push({ ...DEFAULTS.conversations(), id: lc(Z), user_id: UID, account: 'b', owner_device: otherDev, size: 5, generation: 0 });
    let answer = null; // what the materializer's owner(id) says
    const asked = [];
    const upO = make({ only: (id) => id === lc(Z), ownerOf: (id) => { asked.push(id); return typeof answer === 'function' ? answer(id) : answer; } });
    const rowGets = (from) => fake.calls.slice(from).filter((c) => c.method === 'GET' && c.path === '/rest/v1/conversations' && c.search.includes(lc(Z))).length;
    // the rows say another device has it, fresh: no request at all
    answer = { device: otherDev.toUpperCase(), at: clock - 1000, checkedAt: clock - 1000 };
    let c0 = fake.calls.length;
    await upO.scanOnce();
    ok(asked.includes(lc(Z)) && rowGets(c0) === 0 && upO.status().skipped.foreign === 1, `ownerOf: another device's, listed fresh: 'foreign' with no request (${rowGets(c0)})`);
    ok(!fake.calls.slice(c0).some((c) => /conversations|chunks|storage/.test(c.path)), 'ownerOf: nothing else asked or sent for it either');
    // its log changes (the materializer laid more down): still no request
    append(zMain, lines(repo1, 1));
    c0 = fake.calls.length;
    await upO.scanOnce();
    eq(rowGets(c0), 0, 'ownerOf: its log grew, still listed: no request');
    // the rows are stale (no list for over a minute): the row is asked for, as before
    answer = { device: otherDev, at: clock - 120e3, checkedAt: clock - 120e3 };
    append(zMain, lines(repo1, 1));
    c0 = fake.calls.length;
    await upO.scanOnce();
    ok(rowGets(c0) === 1 && upO.status().skipped.foreign === 1, 'ownerOf: a stale list: the row is asked for (still another device\'s)');
    // not listed (or no list yet): asked for
    for (const [a, what] of [[{ device: null, at: clock, checkedAt: clock }, 'not listed as another\'s'], [null, 'no list yet']]) {
      answer = a;
      append(zMain, lines(repo1, 1));
      c0 = fake.calls.length;
      await upO.scanOnce();
      eq(rowGets(c0), 1, `ownerOf: ${what}: the row is asked for`);
    }
    // this device forgot it (a move here): only a whole list that began after the forget says it is another's
    upO.forget(Z);
    answer = { device: otherDev, at: clock - 1, checkedAt: clock };
    c0 = fake.calls.length;
    await upO.scanOnce();
    eq(rowGets(c0), 1, 'ownerOf: after forget(id), a list from before it does not count: the row is asked for');
    clock += 1000;
    answer = { device: otherDev, at: clock, checkedAt: clock };
    append(zMain, lines(repo1, 1));
    c0 = fake.calls.length;
    await upO.scanOnce();
    eq(rowGets(c0), 0, 'ownerOf: a whole list after the forget counts again');
    // a flush always asks
    let fz = null;
    c0 = fake.calls.length;
    try { await upO.flush(Z); } catch (e) { fz = e; }
    ok(fz && fz.code === 'foreign' && rowGets(c0) >= 1, 'ownerOf: a flush asks the server whatever the rows say (foreign)');
    // ownerOf throwing: not known, asked for
    answer = () => { throw new Error('owner() broke'); };
    append(zMain, lines(repo1, 1));
    c0 = fake.calls.length;
    await upO.scanOnce();
    ok(rowGets(c0) === 1 && upO.status().lastError === null, 'ownerOf: one that throws counts as not known');
    eq(db.chunks.filter((r) => r.conversation_id === lc(Z)).length, 0, 'ownerOf: another device\'s conversation never got a chunk');
    await upO.stop();
  }

  // ---------- busy: a chat mid-turn goes up at most every 45 s, at once when its turn ends or a flush asks ----------
  {
    const lc = (id) => id.toLowerCase();
    const V = newId('V');
    const vMain = mainOf(projB, repo1, V);
    write(vMain, lines(repo1, 4));
    let busy = true;
    const upV = make({ only: (id) => id === lc(V), busy: (id) => id === lc(V) && busy });
    await upV.scanOnce();
    rowMatchesMain(V, vMain, 'busy: the first pass goes at once');
    let u0 = fake.uploads;
    append(vMain, lines(repo1, 2));
    clock += 10e3;
    await upV.scanOnce();
    ok(fake.uploads === u0 && upV.status().throttled === 1, `busy: 10 s later, mid-turn: it waits (${upV.status().throttled})`);
    clock += 30e3;
    await upV.scanOnce();
    eq(fake.uploads, u0, 'busy: 40 s after the last: still waits');
    clock += 6e3;
    await upV.scanOnce();
    ok(fake.uploads > u0 && upV.status().throttled === 0, 'busy: 46 s after the last: it goes');
    rowMatchesMain(V, vMain, 'busy: after 45 s');
    // the turn ends: at once
    u0 = fake.uploads;
    append(vMain, lines(repo1, 2));
    clock += 5e3;
    await upV.scanOnce();
    eq(fake.uploads, u0, 'busy: 5 s later it waits');
    busy = false;
    await upV.scanOnce();
    ok(fake.uploads > u0, 'busy: its turn ended: the next scan sends it at once');
    rowMatchesMain(V, vMain, 'busy: at the turn\'s end');
    // mid-turn again, a flush (a move's) never waits
    busy = true;
    append(vMain, lines(repo1, 3));
    clock += 1e3;
    const fin = await upV.flush(V);
    const want = wholeLines(vMain);
    ok(fin && fin.size === want.length && fin.sha256 === K.sha256(want), 'busy: a flush mid-turn goes at once, all of it');
    // an unchanged conversation is never counted as waiting
    clock += 1e3;
    await upV.scanOnce();
    eq(upV.status().throttled, 0, 'busy: nothing new: not counted as waiting');
    // busy() throwing: not busy
    const upW = make({ only: (id) => id === lc(V), busy: () => { throw new Error('busy broke'); } });
    append(vMain, lines(repo1, 1));
    await upW.scanOnce();
    rowMatchesMain(V, vMain, 'busy: one that throws counts as not busy');
    await upV.stop();
    await upW.stop();
  }
}

function short(id) { return String(id).slice(0, 8); }

// ---------- a 5xx, a 429 or the network: the whole scan backs off, no conversation does ----------
async function scanBackoff(up, { projB, repo1, mainOf, now, later, logs, sameAsLocal }) {
  // six: each one that ends STUCK_ENDS (3) scans backs off alone and the next takes its place, so every scan below
  // still ends on a transient error
  const Js = [1, 2, 3, 4, 5, 6].map((i) => newId(`J${i}`));
  const js = Js.map((J) => mainOf(projB, repo1, J));
  const J1 = Js[0];
  const tNew = Date.now() / 1000 + 5; // the newest logs: the scan reaches them first, J1 first
  js.forEach((f, i) => { write(f, lines(repo1, 10)); fs.utimesSync(f, tNew - i, tNew - i); });
  const isJ = (name) => Js.some((J) => name.includes(J.toLowerCase()));
  const tries = () => fake.calls.filter((c) => c.method === 'POST' && c.path.startsWith('/storage/') && isJ(decodeURIComponent(c.path))).length;
  fake.failStatus = 500;
  fake.failObject = isJ;
  logs.length = 0;
  let n0 = tries();
  await up.scanOnce();
  let st = up.status();
  eq(tries() - n0, 1, 'a 5xx: the scan stops at the first failure (the next conversation is not tried)');
  ok(st.backingOff === 0, `a 5xx: no conversation backs off (${st.backingOff})`);
  ok(st.health.failStreak === 1 && st.health.backingOff && Date.parse(st.health.backoffUntil) === now() + 5e3,
    `a 5xx: the scan backs off 5 s (${JSON.stringify(st.health)})`);
  ok(st.health.lastError && st.health.lastError.status === 500 && st.health.lastError.at, 'a 5xx: health.lastError has the status and the time');
  ok(logs.some((l) => /next one in 5 s/.test(l)), 'a 5xx: the back-off is logged');
  n0 = tries();
  await up.scanOnce(); // scanOnce goes at once; only the loop waits
  eq(tries() - n0, 1, 'a 5xx: the same conversation is tried again by the next scan (no per-row back-off)');
  st = up.status();
  ok(st.health.failStreak === 2 && Date.parse(st.health.backoffUntil) === now() + 10e3, `a second 5xx: 10 s (${st.health.backoffUntil})`);
  // a third: J1 ended 3 scans in a row, so it is stuck on its own (its upload always fails): it backs off alone, and
  // the scan goes on to J2, which ends it
  n0 = tries();
  logs.length = 0;
  await up.scanOnce();
  st = up.status();
  eq(tries() - n0, 2, 'a third 5xx on the same one: it backs off alone and the scan goes on to the next');
  ok(logs.some((l) => l.includes(short(J1)) && /trying again in 30 s/.test(l)), 'J1 backs off alone (30 s, logged)');
  ok(st.health.failStreak === 3 && Date.parse(st.health.backoffUntil) === now() + 20e3, `J2 ended that scan: still the scan-level back-off, 20 s (${st.health.backoffUntil})`);
  for (let i = 0; i < 3; i++) await up.scanOnce();
  st = up.status();
  ok(Date.parse(st.health.backoffUntil) === now() + 60e3, `the back-off stops at 60 s (${st.health.backoffUntil})`);
  // 429 with Retry-After: seconds, an HTTP date, capped at 5 min
  fake.failStatus = 429;
  fake.failHeaders = { 'Retry-After': '120' };
  await up.scanOnce();
  st = up.status();
  ok(Date.parse(st.health.backoffUntil) === now() + 120e3, `a 429 with Retry-After: 120 waits 120 s (${st.health.backoffUntil})`);
  fake.failHeaders = { 'Retry-After': '86400' };
  await up.scanOnce();
  ok(Date.parse(up.status().health.backoffUntil) === now() + 300e3, `Retry-After is capped at 5 min (${up.status().health.backoffUntil})`);
  fake.failStatus = 503;
  fake.failHeaders = { 'Retry-After': new Date(Date.now() + 200e3).toUTCString() };
  await up.scanOnce();
  const ra = Date.parse(up.status().health.backoffUntil) - now();
  ok(ra > 190e3 && ra <= 200e3, `a 503 with Retry-After as an HTTP date (${ra} ms)`);
  fake.failHeaders = null;
  // the loop honours the back-off: one scan, then it waits (5 s and more), where it used to go every interval
  fake.failStatus = 500;
  const scans0 = up.status().scans;
  up.start(20);
  await wait(400);
  await up.stop();
  eq(up.status().scans - scans0, 1, 'the loop backs off: one failed scan, then it waits (not one every 20 ms)');
  fake.failObject = null;
  fake.failStatus = 0;
  // the next clean scan resets the back-off and clears the error (past the stuck ones' own 30 s)
  later(31e3);
  await up.scanOnce();
  st = up.status();
  ok(st.health.failStreak === 0 && !st.health.backingOff && st.health.lastError === null && st.lastError === null, `a clean scan resets the back-off and clears lastError (${JSON.stringify(st.health)})`);
  Js.forEach((J, i) => sameAsLocal(J, 'main', js[i], true, `after the back-off: J${i + 1} is up`));
}

// ---------- S4: flush, hold, forget, only, lost ----------
const ctx = {};
async function s4(up) {
  const { projB, repo1, mainOf, conv, sameAsLocal, rowMatchesMain, wholeLines, upState, dev, otherDev, F, logs, make, tick } = ctx;
  const lc = (id) => id.toLowerCase();
  const chunksOf = (id) => db.chunks.filter((r) => r.conversation_id === lc(id));
  const objsOf = (id) => [...fake.objects.keys()].filter((k) => k.startsWith(`${UID}/t/${lc(id)}/`));
  const runs = (list) => list.filter((x, i) => i === 0 || list[i - 1] !== x); // [a,a,b,a] -> [a,b,a]
  const threw = async (p) => { try { await p; return {}; } catch (e) { return e; } };

  // flush: the row's final size and sha256, caught up with a log that grew while it went up
  const J = newId('J');
  const jMain = mainOf(projB, repo1, J);
  write(jMain, lines(repo1, 40));
  let grew = false;
  fake.onObject = (name) => { if (!grew && name.includes(`/t/${lc(J)}/`)) { grew = true; append(jMain, lines(repo1, 30)); } };
  const r1 = await up.flush(J);
  fake.onObject = null;
  ok(grew, 'flush: the log grew while it went up');
  const jWant = wholeLines(jMain);
  eq(r1, { size: jWant.length, sha256: K.sha256(jWant), generation: 0, owner_device: dev }, 'flush: gives the row as it ends, the growth included');
  rowMatchesMain(J, jMain, 'flush');
  sameAsLocal(J, 'main', jMain, true, 'flush');
  eq((await threw(up.flush(F))).code, 'foreign', 'flush of another device\'s conversation throws foreign');
  eq((await threw(up.flush(crypto.randomUUID()))).code, 'missing', 'flush of a conversation not on this machine throws missing');
  eq((await threw(up.flush('nope'))).code, 'bad_request', 'flush of a bad id throws');
  const half = line(repo1);
  append(jMain, half.slice(0, 30)); // a cut last line is left out of what flush reports
  const r1b = await up.flush(J.toUpperCase());
  eq(r1b.size, jWant.length, 'flush: a cut last line is not counted (and an upper-case id works)');
  append(jMain, half.slice(30));

  // a flush asked for while a scan is mid-way runs next, not at the same time
  const Kc = newId('Kc'), Lc = newId('Lc'), J2 = newId('J2');
  const kMain = mainOf(projB, repo1, Kc), lMain = mainOf(projB, repo1, Lc), j2Main = mainOf(projB, repo1, J2);
  write(kMain, lines(repo1, 60)); write(lMain, lines(repo1, 60)); write(j2Main, lines(repo1, 60));
  const tn = Date.now() / 1000;
  fs.utimesSync(kMain, tn + 5, tn + 5); fs.utimesSync(lMain, tn + 4, tn + 4); fs.utimesSync(j2Main, tn - 500, tn - 500);
  fake.order.length = 0;
  let flushP = null;
  fake.onObject = (name) => { if (!flushP && name.includes(`/t/${lc(Kc)}/`)) flushP = up.flush(J2); };
  await up.scanOnce();
  fake.onObject = null;
  const r2 = await flushP;
  const seq = runs(fake.order.filter((x) => [Kc, Lc, J2].map(lc).includes(x)));
  eq(seq, [Kc, J2, Lc].map(lc), 'flush mid-scan: the scan finishes the conversation it is on, the flush goes next, then the scan goes on');
  ok(fake.order.filter((x) => x === lc(Kc)).length > 2, 'flush mid-scan: the scan\'s conversation had several chunks');
  ok(r2 && r2.size === wholeLines(j2Main).length, 'flush mid-scan: it gives its row');
  for (const [id, m] of [[Kc, kMain], [Lc, lMain], [J2, j2Main]]) rowMatchesMain(id, m, `mid-scan ${short(id)}`);

  // hold, unhold, held()
  const H2 = newId('H2');
  const h2Main = mainOf(projB, repo1, H2);
  write(h2Main, lines(repo1, 6));
  ok(up.hold(H2.toUpperCase()), 'hold: takes an id');
  eq(up.held(), [lc(H2)], 'held(): the held ids, lower-case');
  await up.scanOnce();
  ok(!conv(H2) && !objsOf(H2).length, 'hold: a scan uploads nothing of it');
  eq(up.status().skipped.held, 1, 'hold: counted as held');
  const r3 = await up.flush(H2);
  ok(r3.size === wholeLines(h2Main).length && !!conv(H2), 'hold: flush still uploads it');
  append(h2Main, lines(repo1, 2));
  const n0 = chunksOf(H2).length;
  await up.scanOnce();
  eq(chunksOf(H2).length, n0, 'hold: what it gained after the flush stays here');
  ok(up.unhold(H2) && up.held().length === 0, 'unhold');
  await up.scanOnce();
  rowMatchesMain(H2, h2Main, 'after unhold');
  // a hold that comes while a scan is sending it: nothing written after
  const M = newId('M');
  const mMain = mainOf(projB, repo1, M);
  write(mMain, lines(repo1, 60));
  fake.onObject = (name) => { if (name.includes(`/t/${lc(M)}/`)) up.hold(M); };
  await up.scanOnce();
  fake.onObject = null;
  ok(objsOf(M).length === 1 && chunksOf(M).length === 0 && conv(M) && conv(M).size === 0, `hold mid-pass: no write after the hold (${objsOf(M).length} object, ${chunksOf(M).length} rows)`);
  up.unhold(M);
  await up.scanOnce();
  sameAsLocal(M, 'main', mMain, true, 'M after unhold');
  rowMatchesMain(M, mMain, 'M after unhold');

  // forget: the next pass takes over what the server has
  ok(upState().conversations[lc(J)], 'forget: J is in up-state.json before');
  ok(up.forget(J), 'forget');
  ok(!upState().conversations[lc(J)], 'forget: gone from up-state.json');
  logs.length = 0;
  let u0 = fake.uploads;
  await up.scanOnce();
  ok(logs.some((l) => l.includes(short(J)) && /took over/.test(l)), 'forget: the next pass took over the server\'s chunks');
  eq(fake.uploads - u0, 0, 'forget: nothing sent again');
  rowMatchesMain(J, jMain, 'after forget');
  // forget while a pass is sending: it stops before its next write and keeps nothing
  const N = newId('N');
  const nMain = mainOf(projB, repo1, N);
  write(nMain, lines(repo1, 60));
  fake.onObject = (name) => { if (name.includes(`/t/${lc(N)}/`)) up.forget(N); };
  await up.scanOnce();
  fake.onObject = null;
  ok(chunksOf(N).length === 0 && !upState().conversations[lc(N)], `forget mid-pass: no row written after it, nothing kept (${chunksOf(N).length})`);
  await up.scanOnce();
  sameAsLocal(N, 'main', nMain, true, 'N after a forget mid-pass');
  rowMatchesMain(N, nMain, 'N after a forget mid-pass');

  // only()
  const O1 = newId('O1'), O2 = newId('O2');
  write(mainOf(projB, repo1, O1), lines(repo1, 3));
  write(mainOf(projB, repo1, O2), lines(repo1, 3));
  const upO = make({ only: (id) => id === lc(O1) });
  await upO.scanOnce();
  ok(!!conv(O1) && !conv(O2), 'only: just the one it names');
  eq(upO.status().conversations, 1, 'only: the scan saw one conversation');
  await upO.stop();

  // lost: the row's owner changes mid-upload, so no chunk goes in after
  const Q = newId('Q');
  const qMain = mainOf(projB, repo1, Q);
  write(qMain, lines(repo1, 80));
  let flipped = false;
  fake.onObject = (name) => {
    if (!flipped && name.includes(`/t/${lc(Q)}/`) && name.endsWith(`/0/1`)) { flipped = true; conv(Q).owner_device = otherDev; tick(21e3); }
  };
  logs.length = 0;
  await up.scanOnce();
  fake.onObject = null;
  const qRows = chunksOf(Q);
  ok(flipped, 'lost: the owner changed mid-upload');
  ok(qRows.length === 1 && qRows[0].seq === 0, `lost: no chunk row after the change was seen (${qRows.map((r) => r.seq)})`);
  ok(objsOf(Q).length === 2 && objsOf(Q).every((k) => /\/0\/[01]$/.test(k)), `lost: no object after it (${objsOf(Q).map((k) => k.split('/').pop())})`);
  ok(conv(Q).owner_device === otherDev && conv(Q).size === 0, 'lost: the row is left as the new owner has it');
  ok(logs.some((l) => l.includes(short(Q)) && /another device owns it now/.test(l)), 'lost: logged');
  ok(up.status().skipped.foreign >= 2 && !logs.some((l) => l.includes(short(Q)) && /failed/.test(l)), `lost: counted as another device's, not as a failure (${up.status().skipped.foreign})`);
  u0 = fake.uploads;
  append(qMain, lines(repo1, 2));
  await up.scanOnce();
  eq(fake.uploads - u0, 0, 'lost: left alone afterwards');

  // ---------- accountOf: the account it ran under, not its folder's ----------
  // X and Y sit in B's folder (A's shares it on a real machine); accountOf says which account ran them
  await up.stop();
  const X = newId('X'), Y = newId('Y');
  const xMain = mainOf(projB, repo1, X), yMain = mainOf(projB, repo1, Y);
  write(xMain, lines(repo1, 6));
  write(yMain, lines(repo1, 6));
  const ran = new Map([[lc(X), 'A']]); // any case
  let threwOnce = false;
  const upA = make({ only: (id) => id === lc(X) || id === lc(Y), accountOf: (id) => {
    if (id === lc(Y) && ran.get(id) === 'throw') { threwOnce = true; throw new Error('accountOf broke'); }
    return ran.has(id) ? ran.get(id) : null;
  } });
  await upA.scanOnce();
  eq([conv(X) && conv(X).account, conv(Y) && conv(Y).account], ['a', 'b'], 'accountOf: a new row says the account it gives (A -> a); null leaves the folder\'s');
  sameAsLocal(Y, 'main', yMain, true, 'Y');
  const patchesOf = (id, from) => fake.calls.slice(from).filter((c) => c.method === 'PATCH' && c.path === '/rest/v1/conversations' && c.search.includes(`id=eq.${lc(id)}`));
  const yRow0 = { ...conv(Y) };
  // Y turns out to have run on A: its row is patched, its bytes are not sent again
  ran.set(lc(Y), 'a');
  let c0 = fake.calls.length;
  u0 = fake.uploads;
  await upA.scanOnce();
  let yp = patchesOf(Y, c0);
  eq(conv(Y).account, 'a', 'accountOf: a settled row\'s account is re-patched');
  eq(fake.uploads - u0, 0, 'accountOf: no chunk uploaded again for it');
  ok(!fake.calls.slice(c0).some((c) => c.method === 'POST' && c.path === '/rest/v1/chunks'), 'accountOf: no chunk row written for it');
  eq(yp.length, 1, 'accountOf: one PATCH for it');
  const yBody = yp.length ? JSON.parse(yp[0].body.toString()) : {};
  eq(Object.keys(yBody).sort(), ['account', 'branch', 'rel_cwd', 'repo_id'], 'accountOf: the PATCH is the meta alone (no updated_at, size or sha256)');
  eq([conv(Y).updated_at, conv(Y).size, conv(Y).sha256, conv(Y).generation], [yRow0.updated_at, yRow0.size, yRow0.sha256, yRow0.generation], 'accountOf: updated_at, size, sha256 and generation stay as they were');
  c0 = fake.calls.length;
  await upA.scanOnce();
  eq(patchesOf(Y, c0).length + patchesOf(X, c0).length, 0, 'accountOf: settled again, nothing more written');
  // a letter the row doesn't know, or accountOf failing: the folder's again
  ran.set(lc(Y), 'C');
  await upA.scanOnce();
  eq(conv(Y).account, 'b', 'accountOf: a letter other than a or b falls back to the folder\'s (b)');
  ran.set(lc(Y), 'a');
  await upA.scanOnce();
  eq(conv(Y).account, 'a', 'accountOf: and back to a');
  ran.set(lc(Y), 'throw');
  await upA.scanOnce();
  ok(threwOnce && conv(Y).account === 'b' && upA.status().lastError === null, `accountOf: one that throws counts as null: the folder's (${conv(Y).account})`);
  // a log that grew while the account changed: the full row, with size and sha256
  ran.set(lc(X), 'b');
  append(xMain, lines(repo1, 2));
  c0 = fake.calls.length;
  await upA.scanOnce();
  const xp = patchesOf(X, c0);
  const xBody = xp.length ? JSON.parse(xp[xp.length - 1].body.toString()) : {};
  ok(conv(X).account === 'b' && 'updated_at' in xBody && 'sha256' in xBody, 'accountOf: with new bytes too, the whole row goes (updated_at, sha256)');
  rowMatchesMain(X, xMain, 'X after it grew');
  await upA.stop();
}


main().catch((e) => { failures++; console.log(`FAIL the test threw: ${e && e.stack ? e.stack : e}`); }).finally(() => {
  server.close();
  if (!process.env.SYNC_TEST_KEEP) { try { fs.rmSync(T, { recursive: true, force: true }); } catch {} }
  console.log(`${passes} passed, ${failures} failed`);
  process.exitCode = failures ? 1 : 0;
});
