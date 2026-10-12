// Sync down: a test of sync-down.js (the materializer), run with the system node:   node scripts/sync-down-test.js
// Against a fake Supabase (a local HTTP server standing in for PostgREST and Storage, reached through the real
// sync-api.js createSync() with a made-up sign-in) holding conversation and chunk rows and objects sealed here with
// sync-crypto.js sealChunk at sync-common.js objectPath()s, and a throwaway git repo with a fake GitHub origin:
// a new conversation is laid down byte-identical with its subagents/, tool-results/ and workflows/ files in the slug
// folder of its repo (found by origin; this device's repo_paths row is written); an unchanged row costs no request;
// a local prefix is extended, fetching only the new chunk; a longer local copy and a diverged one are left alone and
// reported in conflicts(); a missing object, a gap, a short cover, a bad chunk or file sha256, an object row pointing
// at another conversation's object and an object copied to another path all write nothing (and a fixed one is laid
// down after the back-off), but a download cut because the machine slept sets no back-off; a conversation open on this machine is skipped; rows owned by this device or by nobody
// are ignored; a rel_cwd with '..', a drive or an absolute path is refused; a subfolder rel_cwd gets its own slug and
// a missing worktree falls back to the root; account A goes to ~/.claude-a; a repo with no checkout here is skipped;
// a log already on this machine in another slug folder grows there; a whole side file this side wrote is replaced
// by a new generation, a side file mid-upload waits; a local log whose last line was cut off counts by its whole lines
// (the row's bytes replace the cut line, with or without new lines after it; a whole line the row lacks is still a
// conflict); the home row ('home:') lays a conversation down under this machine's home folder + rel_cwd, making a
// folder it lacks (empty, logged once; also on pull), never through a link and never for a rel_cwd with '..' or an
// absolute path, and writes this device's repo_paths row for it with the home folder; no .part file is ever left behind; status() holds no key or token; start/stop.
// S4: pull(id) -> missing (no row, or not active) / mine (this device's) / done with dir and folder / same / conflict
// (left alone, still saying where) / skip when open here; a back-off does not hold a pull up; owners() with leaseUntil
// and the row's account (a copy, empty before the first scan); only(id).
// Several at once: a scan has more than one and at most ROWS_AT_ONCE conversations under way, started in list order,
// each saved in down-state.json; a pull asked while rows wait their turn goes before them; a pull of a row under way
// starts only once it is done; Supabase out of reach on one row starts no more rows, lets the ones under way finish,
// throws, leaves nothing unhandled; a scan starting while a pull is under way reloads its state only after it.
// Many chunks: fetched more than one and at most FETCH_AHEAD at once, answered out of order, laid down byte-identical;
// a fetch that fails or a bad sha256 mid-way writes nothing, starts nothing past the window and leaves no unhandled
// rejection; a partly-here local copy fetches only what it lacks; one that differs mid-chunk is a conflict.
// Everything happens in a temp folder (SYNC_TEST_DIR, or the system temp folder), deleted at the end
// (SYNC_TEST_KEEP=1 keeps it). Nothing here touches the real ~/.claude* folders or the real Supabase. Exit 0 = all pass.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const S = require(path.join(ROOT, 'sync-api.js'));
const X = require(path.join(ROOT, 'sync-crypto.js'));
const C = require(path.join(ROOT, 'sync-common.js'));
const D = require(path.join(ROOT, 'sync-down.js'));

const base = process.env.SYNC_TEST_DIR || os.tmpdir();
fs.mkdirSync(base, { recursive: true });
const T = fs.realpathSync(fs.mkdtempSync(path.join(base, 'sync-down-test-')));

let failures = 0, passes = 0;
const ok = (cond, what) => { if (cond) passes++; else { failures++; console.log(`FAIL ${what}`); } };
const eq = (a, b, what) => ok(JSON.stringify(a) === JSON.stringify(b), `${what}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
const write = (f, data) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); };
const read = (f) => { try { return fs.readFileSync(f); } catch { return null; } };
const same = (f, buf) => { const b = read(f); return !!b && b.equals(buf); };
// every file under a folder, as paths
function walk(dir, out = []) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, out); else out.push(p); }
  return out;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// values shaped like the real thing are put together here, so this file holds none the share guard would flag
const PUB = 'sb_' + 'publishable_' + 'TestOnlyKey0123456789abcd';
const UID = crypto.randomUUID();
const ACCESS = `at-${crypto.randomBytes(12).toString('hex')}`;
const KEY = crypto.randomBytes(32);
const OTHER = crypto.randomUUID(); // the machine that uploaded
const REPO_ID = crypto.randomUUID(), REPO2_ID = crypto.randomUUID(), HOME_ID = crypto.randomUUID();
const ORIGIN = 'https://github.com/glodusk/proj';

// ---------- the fake Supabase ----------
const fake = {
  tables: { devices: [{ id: OTHER, name: 'mac', platform: 'darwin' }], repos: [{ id: REPO_ID, origin: ORIGIN }, { id: REPO2_ID, origin: 'https://github.com/glodusk/elsewhere' }, { id: HOME_ID, origin: C.HOME_ORIGIN }], repo_paths: [], conversations: [], chunks: [] },
  objects: new Map(), calls: [], onGet: null,
};
const json = (res, code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
function restCall(req, u, body, res) {
  const table = u.pathname.slice('/rest/v1/'.length);
  const rows = fake.tables[table];
  if (!rows) return json(res, 404, { code: 'PGRST205', message: 'no such table' });
  let select = null, order = [], limit = Infinity, offset = 0;
  const filters = [];
  for (const [k, v] of u.searchParams) {
    if (k === 'select') select = v.split(',');
    else if (k === 'order') order = v.split(',').map((x) => { const [c, d] = x.split('.'); return [c, d === 'desc' ? -1 : 1]; });
    else if (k === 'limit') limit = Number(v);
    else if (k === 'offset') offset = Number(v);
    else if (k !== 'on_conflict') { const i = v.indexOf('.'); filters.push([k, v.slice(0, i), v.slice(i + 1)]); }
  }
  // SQL's way: a null never equals and never differs
  const match = (r) => filters.every(([k, op, val]) => (r[k] == null ? false : op === 'eq' ? String(r[k]) === val : op === 'neq' ? String(r[k]) !== val : false));
  if (req.method === 'GET') {
    let out = rows.filter(match);
    out.sort((a, b) => { for (const [c, d] of order) { if (a[c] < b[c]) return -d; if (a[c] > b[c]) return d; } return 0; });
    out = out.slice(offset, offset + limit).map((r) => (select ? Object.fromEntries(select.map((c) => [c, r[c] === undefined ? null : r[c]])) : r));
    return json(res, 200, out);
  }
  const b = body.length ? JSON.parse(body.toString()) : null;
  if (req.method === 'POST') {
    const list = Array.isArray(b) ? b : [b];
    const made = [];
    for (const r of list) {
      if (table === 'devices') { const row = { id: crypto.randomUUID(), ...r }; rows.push(row); made.push(row); continue; }
      if (table === 'repo_paths') {
        const have = rows.find((x) => x.device_id === r.device_id && x.repo_id === r.repo_id);
        if (have) { if (!/merge-duplicates/.test(req.headers.prefer || '')) return json(res, 409, { code: '23505', message: 'duplicate key' }); Object.assign(have, r); made.push(have); continue; }
      }
      rows.push({ ...r }); made.push(r);
    }
    return /return=representation/.test(req.headers.prefer || '') ? json(res, 201, made) : (res.writeHead(201), res.end());
  }
  if (req.method === 'PATCH') {
    for (const r of rows.filter(match)) Object.assign(r, b);
    res.writeHead(204);
    return res.end();
  }
  return json(res, 405, { message: 'no' });
}
const server = http.createServer((req, res) => {
  const parts = [];
  req.on('data', (b) => parts.push(b));
  req.on('end', () => {
    const body = Buffer.concat(parts), u = new URL(req.url, 'http://x');
    fake.calls.push({ method: req.method, path: decodeURIComponent(u.pathname), search: u.search });
    if (req.headers.apikey !== PUB || req.headers.authorization !== `Bearer ${ACCESS}`) return json(res, 401, { message: 'JWT expired' });
    if (u.pathname.startsWith('/rest/v1/')) {
      const profile = req.method === 'GET' ? req.headers['accept-profile'] : req.headers['content-profile'];
      if (profile !== 'fleet_sync') return json(res, 406, { message: 'schema' });
      return restCall(req, u, body, res);
    }
    const pre = '/storage/v1/object/fleet-sync/';
    if (u.pathname.startsWith(pre) && req.method === 'GET') {
      const name = u.pathname.slice(pre.length).split('/').map(decodeURIComponent).join('/');
      if (!fake.objects.has(name)) return json(res, 400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
      if (fake.onGet) fake.onGet(name);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      return res.end(fake.objects.get(name));
    }
    return json(res, 404, { message: 'no route' });
  });
});

// ---------- building what the other machine uploaded ----------
let tick = 0;
const stamp = () => new Date(Date.UTC(2026, 9, 10, 12, 0, 0) + (tick++) * 1000).toISOString();
// one file's chunks: pieces of bytes -> chunk rows + sealed objects
function putFile(id, file, gen, pieces, startSeq = 0, startOff = 0) {
  let off = startOff, seq = startSeq;
  for (const piece of pieces) {
    const rel = C.objectPath(id, file, gen, seq);
    fake.objects.set(`${UID}/${rel}`, X.sealChunk(piece, KEY, rel));
    fake.tables.chunks.push({ conversation_id: id, file, generation: gen, seq, byte_offset: off, byte_length: piece.length, object_path: rel, sha256: X.sha256(piece) });
    off += piece.length; seq++;
  }
}
const line = (o) => Buffer.from(`${JSON.stringify(o)}\n`);
function logOf(id, n, tag = 'x') {
  const lines = [];
  for (let i = 0; i < n; i++) lines.push(line({ type: i % 2 ? 'assistant' : 'user', sessionId: id, cwd: 'C:\\Users\\mac\\proj', uuid: crypto.randomUUID(), text: `${tag} line ${i} ${'.'.repeat(i * 7)}` }));
  return lines;
}
// a conversation row with its main file in pieces (several lines per piece) and side files { key: Buffer | [Buffer] }
function putConvo(o) {
  const id = o.id || crypto.randomUUID();
  const pieces = o.pieces || [];
  const main = Buffer.concat(pieces);
  const gen = o.gen || 0;
  putFile(id, 'main', gen, pieces);
  for (const [k, v] of Object.entries(o.side || {})) putFile(id, k, 0, Array.isArray(v) ? v : [v]);
  const row = {
    id, account: o.account || 'b', repo_id: o.repo_id === undefined ? REPO_ID : o.repo_id, rel_cwd: o.rel_cwd || '', branch: 'main', title_enc: null,
    state: o.state || 'active', owner_device: o.owner === undefined ? OTHER : o.owner, lease_until: null, size: main.length,
    sha256: X.sha256(main), generation: gen, updated_at: stamp(),
  };
  fake.tables.conversations.push(row);
  return { id, row, main };
}
const chunkRows = (id, file = 'main') => fake.tables.chunks.filter((c) => c.conversation_id === id && c.file === file);
const storageGets = () => fake.calls.filter((c) => c.method === 'GET' && c.path.startsWith('/storage/')).length;
const restGets = (table) => fake.calls.filter((c) => c.method === 'GET' && c.path === `/rest/v1/${table}`).length;
const parts = () => walk(T).filter((f) => f.endsWith('.part'));

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const dataDir = path.join(T, 'data');
  write(path.join(dataDir, 'sync', 'config.json'), JSON.stringify({ url: `http://127.0.0.1:${port}`, publishableKey: PUB }));
  let text = JSON.stringify({ v: 1, url: `http://127.0.0.1:${port}`, uid: UID, email: 'h@example.com', member: true, refreshToken: 'rt-x', accessToken: ACCESS, expiresAt: Date.now() + 3600e3 });
  const store = { kind: 'memory', stamp: () => (text === null ? null : 'm1'), read: async () => text, write: async (t) => { text = t; }, clear: async () => { text = null; } };
  const api = S.createSync({ dataDir, store, allowLoopbackUrl: true });

  // the machine: a home with B and A projects folders, a git checkout with a GitHub origin
  const home = path.join(T, 'home');
  const projB = path.join(home, '.claude', 'projects'), projA = path.join(home, '.claude-a', 'projects');
  fs.mkdirSync(projB, { recursive: true });
  fs.mkdirSync(projA, { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
  const g = (cwd, ...args) => cp.execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  const repoDir = path.join(T, 'repos', 'proj');
  fs.mkdirSync(path.join(repoDir, 'sub'), { recursive: true });
  g(repoDir, 'init', '-q');
  write(path.join(repoDir, 'sub', 'a.txt'), 'a\n');
  g(repoDir, 'add', '.');
  g(repoDir, 'commit', '-qm', 'one');
  g(repoDir, 'remote', 'add', 'origin', 'git@github.com:GLODUSK/Proj.git');
  const plain = path.join(T, 'repos', 'plain');
  fs.mkdirSync(plain, { recursive: true });
  const repo = await C.repoOf(repoDir);
  ok(repo && repo.origin === ORIGIN, 'setup: the test repo has the fake origin');
  const rootDir = repo.mainRoot;
  const slugDir = (folder, proj = projB) => path.join(proj, C.slugOf(folder));
  const mainOf = (id, folder = rootDir, proj = projB) => path.join(slugDir(folder, proj), `${id}.jsonl`);

  let clock = Date.now();
  const logs = [];
  const m = D.createMaterializer({ api, dataDir, key: KEY, home, roots: [plain, repoDir], now: () => clock, log: (t) => logs.push(t) });
  const later = () => { clock += 3 * 3600e3; }; // past every back-off

  // ---------- refusals of the helpers ----------
  for (const bad of ['..', '../x', 'a/../..', 'C:/Windows', 'C:', '/etc', 'a//b', './a', 'a\\b', 'a/b:c']) eq(D.relParts(bad), null, `relParts refuses ${bad}`);
  eq(D.relParts(''), [], 'relParts: the root');
  eq(D.relParts('.claude/worktrees/w1'), ['.claude', 'worktrees', 'w1'], 'relParts: a worktree path');

  // ---------- a new conversation, with side files ----------
  const sub1 = logOf('s', 6, 'sub');
  const meta1 = Buffer.from('{"agentType":"general-purpose"}');
  const c1 = putConvo({
    pieces: [Buffer.concat(logOf('a', 5)), Buffer.concat(logOf('a', 3, 'b')), Buffer.concat(logOf('a', 2, 'c'))],
    side: {
      'subagents/agent-a1.jsonl': [Buffer.concat(sub1.slice(0, 3)), Buffer.concat(sub1.slice(3))],
      'subagents/agent-a1.meta.json': meta1,
      'tool-results/toolu_1.txt': Buffer.from('a big tool output\n'.repeat(500)),
      'workflows/run-1/journal.jsonl': line({ step: 1 }),
    },
  });
  let r = await m.scanOnce();
  const me = C.readState(C.devicePath(dataDir), {}).id;
  ok(typeof me === 'string' && me !== OTHER, 'this device got its own devices row');
  ok(same(mainOf(c1.id), c1.main), 'new: main laid down byte-identical in the repo root\'s slug folder');
  const side1 = path.join(slugDir(rootDir), c1.id);
  ok(same(path.join(side1, 'subagents', 'agent-a1.jsonl'), Buffer.concat(sub1)), 'new: a subagent log, two chunks');
  ok(same(path.join(side1, 'subagents', 'agent-a1.meta.json'), meta1), 'new: a subagent meta file');
  ok(same(path.join(side1, 'tool-results', 'toolu_1.txt'), Buffer.from('a big tool output\n'.repeat(500))), 'new: a tool result');
  ok(same(path.join(side1, 'workflows', 'run-1', 'journal.jsonl'), line({ step: 1 })), 'new: a workflow file two folders deep');
  eq(r.done, 1, 'new: one laid down');
  const rp = fake.tables.repo_paths.find((x) => x.device_id === me && x.repo_id === REPO_ID);
  ok(rp && P_same(rp.root, rootDir), `new: this device's repo_paths row names the checkout (${rp && rp.root})`);
  ok(C.readState(D.downStatePath(dataDir), {}).convos[c1.id], 'new: down-state.json remembers it');

  // ---------- nothing changed: no request beyond the list ----------
  let sg = storageGets(), cg = restGets('chunks');
  r = await m.scanOnce();
  eq([storageGets() - sg, restGets('chunks') - cg, r.unchanged], [0, 0, 1], 'unchanged: no chunk list, no download');

  // ---------- a local prefix is extended ----------
  const more = Buffer.concat(logOf('a', 4, 'd'));
  putFile(c1.id, 'main', 0, [more], 3, c1.main.length);
  const grown = Buffer.concat([c1.main, more]);
  Object.assign(c1.row, { size: grown.length, sha256: X.sha256(grown), updated_at: stamp() });
  sg = storageGets();
  r = await m.scanOnce();
  ok(same(mainOf(c1.id), grown), 'prefix: the local copy grew to the new bytes');
  eq(storageGets() - sg, 1, 'prefix: only the new chunk was fetched');

  // ---------- a log laid down keeps its last entry's time, not the moment it came down ----------
  const WHEN = '2026-06-01T12:00:00.000Z';
  const dated = line({ type: 'assistant', sessionId: 'a', cwd: 'C:\\Users\\mac\\proj', uuid: crypto.randomUUID(), timestamp: WHEN, text: 'an old reply' });
  putFile(c1.id, 'main', 0, [dated], 4, grown.length);
  const grown2 = Buffer.concat([grown, dated]);
  Object.assign(c1.row, { size: grown2.length, sha256: X.sha256(grown2), updated_at: stamp() });
  r = await m.scanOnce();
  ok(same(mainOf(c1.id), grown2), 'dated: the local copy grew');
  eq(Math.round(fs.statSync(mainOf(c1.id)).mtimeMs / 1000), Date.parse(WHEN) / 1000, 'dated: its modified time is its last entry\'s');

  // ---------- a longer local copy, a diverged one ----------
  const c2 = putConvo({ pieces: [Buffer.concat(logOf('b', 4))] });
  const longer = Buffer.concat([c2.main, line({ type: 'cost-state' })]);
  write(mainOf(c2.id), longer);
  const c3 = putConvo({ pieces: [Buffer.concat(logOf('c', 4)), Buffer.concat(logOf('c', 2, 'z'))], side: { 'subagents/agent-c.jsonl': line({ a: 1 }) } });
  const diverged = Buffer.from(c3.main);
  diverged[10] = diverged[10] === 0x61 ? 0x62 : 0x61;
  write(mainOf(c3.id), diverged.subarray(0, c3.main.length - 5));
  r = await m.scanOnce();
  ok(same(mainOf(c2.id), longer), 'longer: the local copy is left as it was');
  ok(same(mainOf(c3.id), diverged.subarray(0, c3.main.length - 5)), 'diverged: the local copy is left as it was');
  ok(!fs.existsSync(path.join(slugDir(rootDir), c3.id)), 'diverged: no side file written for it');
  const cf = m.conflicts();
  ok(cf.some((x) => x.id === c2.id && x.file === 'main' && /longer/.test(x.reason)), 'longer: listed in conflicts()');
  ok(cf.some((x) => x.id === c3.id && x.file === 'main' && /different/.test(x.reason)), 'diverged: listed in conflicts()');
  eq(r.conflict, 2, 'two conflicts in the scan');
  sg = storageGets();
  r = await m.scanOnce();
  eq([storageGets() - sg, m.conflicts().length], [0, 2], 'conflicts: not fetched again while nothing changed, still listed');
  fs.rmSync(mainOf(c2.id)); // Henry deals with it: the local copy goes
  r = await m.scanOnce();
  ok(same(mainOf(c2.id), c2.main), 'conflict: laid down once the local copy is gone');
  ok(!m.conflicts().some((x) => x.id === c2.id), 'conflict: no longer listed');

  // ---------- a cut last line (its writer ended mid-line; that part never went up) ----------
  const cutTail = Buffer.from('{"type":"assistant","text":"half a li');
  const k1 = putConvo({ pieces: [Buffer.concat(logOf('k', 4))] }); // the row is exactly the whole lines
  write(mainOf(k1.id), Buffer.concat([k1.main, cutTail]));
  const e1 = Buffer.concat(logOf('l', 3)), e2 = Buffer.concat(logOf('l', 2, 'm'));
  const k2 = putConvo({ pieces: [Buffer.concat([e1, e2])] }); // the other machine wrote more after the whole lines
  write(mainOf(k2.id), Buffer.concat([e1, cutTail]));
  const f1 = Buffer.concat(logOf('n', 2)), f2 = Buffer.concat(logOf('n', 2, 'o'));
  const k3 = putConvo({ pieces: [f1, f2] }); // the same, a chunk boundary right at the cut
  write(mainOf(k3.id), Buffer.concat([f1, cutTail]));
  const k4 = putConvo({ pieces: [Buffer.concat(logOf('p', 3))] }); // a whole line the row lacks, then a cut one
  const k4local = Buffer.concat([k4.main, line({ type: 'user', text: 'only here' }), cutTail]);
  write(mainOf(k4.id), k4local);
  sg = storageGets();
  r = await m.scanOnce();
  ok(same(mainOf(k1.id), k1.main), 'cut: the cut line goes; the copy is the row\'s bytes');
  ok(same(mainOf(k2.id), k2.main), 'cut: the other machine\'s new lines replace the cut line');
  ok(same(mainOf(k3.id), k3.main), 'cut: at a chunk boundary too');
  eq(storageGets() - sg, 2, 'cut: the chunk the whole lines hold is not fetched (k2 and k3\'s second one only)');
  ok(!m.conflicts().some((x) => [k1.id, k2.id, k3.id].includes(x.id)), 'cut: no conflict for them');
  ok(logs.some((t) => t.includes(k1.id) && /its cut last line \(\d+ bytes\) was replaced/.test(t)), 'cut: logged');
  ok(same(mainOf(k4.id), k4local) && m.conflicts().some((x) => x.id === k4.id && /longer/.test(x.reason)), 'cut: a whole line the row lacks is still a conflict');
  fs.rmSync(mainOf(k4.id));
  r = await m.scanOnce();
  ok(same(mainOf(k4.id), k4.main) && !m.conflicts().some((x) => x.id === k4.id), 'cut: laid down once that copy is gone');

  // ---------- broken uploads write nothing ----------
  const broken = [];
  const c4 = putConvo({ pieces: [Buffer.concat(logOf('d', 3)), Buffer.concat(logOf('d', 3, 'y'))] }); // an object missing
  const lost = chunkRows(c4.id)[1];
  const lostBlob = fake.objects.get(`${UID}/${lost.object_path}`);
  fake.objects.delete(`${UID}/${lost.object_path}`);
  broken.push([c4, 'a missing object']);
  const c5 = putConvo({ pieces: [Buffer.concat(logOf('e', 2)), Buffer.concat(logOf('e', 2, 'y')), Buffer.concat(logOf('e', 2, 'z'))] }); // a gap
  fake.tables.chunks.splice(fake.tables.chunks.indexOf(chunkRows(c5.id)[1]), 1);
  broken.push([c5, 'a gap']);
  const c5b = putConvo({ pieces: [Buffer.concat(logOf('f', 2)), Buffer.concat(logOf('f', 2, 'y'))] }); // the last chunk row missing
  fake.tables.chunks.splice(fake.tables.chunks.indexOf(chunkRows(c5b.id)[1]), 1);
  broken.push([c5b, 'chunks short of the size']);
  const c6 = putConvo({ pieces: [Buffer.concat(logOf('g', 3))] }); // a chunk's sha256
  chunkRows(c6.id)[0].sha256 = X.sha256(Buffer.from('something else'));
  broken.push([c6, 'a bad chunk sha256']);
  const c6b = putConvo({ pieces: [Buffer.concat(logOf('h', 3))] }); // the file's sha256
  c6b.row.sha256 = X.sha256(Buffer.from('something else'));
  broken.push([c6b, 'a bad file sha256']);
  const c7 = putConvo({ pieces: [Buffer.concat(logOf('i', 3))] }); // a row pointing at another conversation's object
  const other = chunkRows(c2.id)[0];
  Object.assign(chunkRows(c7.id)[0], { object_path: other.object_path, sha256: other.sha256, byte_length: other.byte_length });
  c7.row.size = other.byte_length;
  broken.push([c7, 'an object under another conversation\'s path']);
  const c7b = putConvo({ pieces: [Buffer.concat(logOf('j', 3))] }); // an object copied to another path
  const own = chunkRows(c7b.id)[0];
  const cr = chunkRows(c2.id)[0];
  fake.objects.set(`${UID}/${own.object_path}`, fake.objects.get(`${UID}/${cr.object_path}`));
  Object.assign(own, { sha256: cr.sha256, byte_length: cr.byte_length });
  c7b.row.size = cr.byte_length; c7b.row.sha256 = cr.sha256;
  broken.push([c7b, 'an object sealed for another path']);
  later();
  r = await m.scanOnce();
  for (const [c, what] of broken) {
    ok(!fs.existsSync(mainOf(c.id)) && !fs.existsSync(`${mainOf(c.id)}.part`), `${what}: nothing written`);
  }
  eq(r.failed, broken.length, 'every broken upload counted as failed');
  eq(parts(), [], 'no .part file left after the failures');
  ok(m.status().waiting >= broken.length, 'the failed ones wait out a back-off');
  // fixed: laid down once the back-off has passed, not before
  fake.objects.set(`${UID}/${lost.object_path}`, lostBlob);
  r = await m.scanOnce();
  ok(!fs.existsSync(mainOf(c4.id)), 'back-off: not tried again at once');
  later();
  r = await m.scanOnce();
  ok(same(mainOf(c4.id), c4.main), 'back-off: the fixed one is laid down after it');
  // a download cut because the machine slept stops the scan but sets no back-off: the next scan lays it down
  const cS = putConvo({ pieces: [Buffer.concat(logOf('z', 3))] });
  const realDownload = api.storage.download;
  let cutAt = null;
  api.storage.download = async (p, o) => {
    if (cutAt || !p.includes(cS.id)) return realDownload(p, o);
    cutAt = p;
    throw Object.assign(new S.SyncError('the connection was cut by sleep; trying again', 0, 'network'), { slept: true });
  };
  let cut = null;
  try { await m.scanOnce(); } catch (e) { cut = e; }
  api.storage.download = realDownload;
  ok(cut && cut.slept && cutAt && !fs.existsSync(mainOf(cS.id)), 'sleep cut: the scan stops, nothing written');
  r = await m.scanOnce();
  ok(same(mainOf(cS.id), cS.main), 'sleep cut: no back-off, laid down by the very next scan');

  // ---------- open on this machine ----------
  const c8 = putConvo({ pieces: [Buffer.concat(logOf('k', 3))] });
  const pidFile = path.join(home, '.claude', 'sessions', `${process.pid}.json`);
  write(pidFile, JSON.stringify({ pid: process.pid, sessionId: c8.id, cwd: rootDir }));
  r = await m.scanOnce();
  ok(!fs.existsSync(mainOf(c8.id)), 'live: a conversation open here is not touched');
  ok(r.reasons['open on this machine'] >= 1, 'live: counted as skipped');
  fs.rmSync(pidFile);
  r = await m.scanOnce();
  ok(same(mainOf(c8.id), c8.main), 'live: laid down once it closed');

  // ---------- rows that are not this side's to lay down ----------
  const c9 = putConvo({ pieces: [Buffer.concat(logOf('l', 2))], owner: me });
  const c9b = putConvo({ pieces: [Buffer.concat(logOf('m', 2))], owner: null });
  const c9c = putConvo({ pieces: [Buffer.concat(logOf('n', 2))], state: 'archived' });
  r = await m.scanOnce();
  for (const [c, what] of [[c9, 'owned by this device'], [c9b, 'owned by nobody'], [c9c, 'archived']]) ok(!walk(home).some((f) => f.includes(c.id)), `a row ${what} is ignored`);

  // ---------- rel_cwd ----------
  const refused = ['..', '../outside', 'sub/../..', 'C:/Windows', '/etc', 'C:\\Windows'].map((rel) => putConvo({ pieces: [Buffer.concat(logOf('o', 2))], rel_cwd: rel }));
  const inSub = putConvo({ pieces: [Buffer.concat(logOf('p', 2))], rel_cwd: 'sub' });
  const inWt = putConvo({ pieces: [Buffer.concat(logOf('q', 2))], rel_cwd: '.claude/worktrees/not-here' });
  const inA = putConvo({ pieces: [Buffer.concat(logOf('r', 2))], account: 'a' });
  const noRepo = putConvo({ pieces: [Buffer.concat(logOf('s', 2))], repo_id: REPO2_ID });
  r = await m.scanOnce();
  for (const c of refused) ok(!walk(T).some((f) => path.basename(f).startsWith(c.id)), `rel_cwd ${JSON.stringify(c.row.rel_cwd)}: refused, nothing written anywhere`);
  ok(r.reasons['its rel_cwd is not a plain relative path'] === refused.length, 'rel_cwd: every bad one counted');
  ok(same(mainOf(inSub.id, path.join(rootDir, 'sub')), inSub.main), 'rel_cwd sub: laid down in the subfolder\'s own slug folder');
  ok(same(mainOf(inWt.id), inWt.main), 'rel_cwd: a worktree not on this machine falls back to the root');
  ok(same(mainOf(inA.id, rootDir, projA), inA.main), 'account a: laid down in ~/.claude-a/projects');
  ok(!walk(home).some((f) => f.includes(noRepo.id)), 'a repo with no checkout here: skipped');
  ok(r.reasons['no checkout of its repo here'] >= 1, 'a repo with no checkout here: counted');

  // ---------- side files: a new generation of a whole file, one mid-upload, a bad file key ----------
  const meta2 = Buffer.from('{"agentType":"general-purpose","description":"renamed"}');
  fake.tables.chunks = fake.tables.chunks.filter((c) => !(c.conversation_id === c1.id && c.file === 'subagents/agent-a1.meta.json'));
  putFile(c1.id, 'subagents/agent-a1.meta.json', 1, [meta2]);
  putFile(c1.id, 'tool-results/toolu_2.txt', 0, [Buffer.from('old')]);
  putFile(c1.id, 'tool-results/toolu_2.txt', 1, [Buffer.from('new')]); // two generations up at once: mid-upload
  fake.tables.chunks.push({ conversation_id: c1.id, file: 'subagents/../../../evil', generation: 0, seq: 0, byte_offset: 0, byte_length: 3, object_path: 't/x', sha256: X.sha256(Buffer.from('bad')) });
  c1.row.updated_at = stamp();
  r = await m.scanOnce();
  ok(same(path.join(side1, 'subagents', 'agent-a1.meta.json'), meta2), 'side: a whole file this side wrote is replaced by its new generation');
  ok(!fs.existsSync(path.join(side1, 'tool-results', 'toolu_2.txt')), 'side: a file with two generations up waits');
  eq(r.pending, 1, 'side: counted as pending');
  ok(!walk(T).some((f) => path.basename(f) === 'evil'), 'side: a file key with .. is ignored');
  fake.tables.chunks = fake.tables.chunks.filter((c) => !(c.conversation_id === c1.id && c.file === 'tool-results/toolu_2.txt' && c.generation === 0));
  r = await m.scanOnce();
  ok(same(path.join(side1, 'tool-results', 'toolu_2.txt'), Buffer.from('new')), 'side: laid down once the upload finished');
  // a whole side file changed here since: not replaced, a conflict
  write(path.join(side1, 'subagents', 'agent-a1.meta.json'), '{"edited":"here"}');
  fake.tables.chunks = fake.tables.chunks.filter((c) => !(c.conversation_id === c1.id && c.file === 'subagents/agent-a1.meta.json'));
  putFile(c1.id, 'subagents/agent-a1.meta.json', 2, [Buffer.from('{"v":3}')]);
  c1.row.updated_at = stamp();
  r = await m.scanOnce();
  ok(same(path.join(side1, 'subagents', 'agent-a1.meta.json'), Buffer.from('{"edited":"here"}')), 'side: a whole file changed here is left alone');
  ok(m.conflicts().some((x) => x.id === c1.id && x.file === 'subagents/agent-a1.meta.json'), 'side: and reported');

  // ---------- once laid down, it stays in that slug folder ----------
  fs.mkdirSync(path.join(rootDir, '.claude', 'worktrees', 'not-here'), { recursive: true });
  const wtMore = line({ type: 'user', text: 'more' });
  putFile(inWt.id, 'main', 0, [wtMore], 1, inWt.main.length);
  Object.assign(inWt.row, { size: inWt.main.length + wtMore.length, sha256: X.sha256(Buffer.concat([inWt.main, wtMore])), updated_at: stamp() });
  r = await m.scanOnce();
  ok(same(mainOf(inWt.id), Buffer.concat([inWt.main, wtMore])), 'sticky: the copy where it was laid down grew');
  ok(!fs.existsSync(mainOf(inWt.id, path.join(rootDir, '.claude', 'worktrees', 'not-here'))), 'sticky: no second copy in the worktree\'s slug folder');

  // ---------- a log this machine already has, in another slug folder, stays there ----------
  // (one this machine started in a folder above the repo, that another machine took over and carried on)
  const p1 = Buffer.concat(logOf('t', 3)), p2 = Buffer.concat(logOf('t', 2, 'u'));
  const mine = putConvo({ pieces: [p1, p2] });
  write(mainOf(mine.id, plain), p1);
  r = await m.scanOnce();
  ok(same(mainOf(mine.id, plain), mine.main), 'already here: the local log grew where it is');
  ok(!fs.existsSync(mainOf(mine.id)), 'already here: no second copy in the repo root\'s slug folder');

  // ---------- the home row: under this machine's home folder ----------
  const botDir = path.join(home, 'Bots', 'panchito'), scratch = path.join(home, 'Scratchpads', 'scratch-2026-10-11');
  fs.mkdirSync(scratch, { recursive: true });
  const atHome = putConvo({ pieces: [Buffer.concat(logOf('h0', 2))], repo_id: HOME_ID, rel_cwd: '' });
  const inBot = putConvo({ pieces: [Buffer.concat(logOf('h1', 3))], repo_id: HOME_ID, rel_cwd: 'Bots/panchito' }); // no such folder here yet
  const inScratch = putConvo({ pieces: [Buffer.concat(logOf('h2', 2))], repo_id: HOME_ID, rel_cwd: 'Scratchpads/scratch-2026-10-11' });
  const outsideDir = path.join(T, 'outside'), elsewhere = path.join(T, 'elsewhere');
  fs.mkdirSync(elsewhere, { recursive: true });
  const link = path.join(home, 'linked');
  fs.symlinkSync(elsewhere, link, 'junction'); // a link under home to a folder outside it
  const viaLink = putConvo({ pieces: [Buffer.concat(logOf('h3', 2))], repo_id: HOME_ID, rel_cwd: 'linked/made-here' });
  const homeRefused = ['..', '../outside', 'Bots/../../outside', '/etc', 'C:/Windows'].map((rel) => putConvo({ pieces: [Buffer.concat(logOf('h4', 2))], repo_id: HOME_ID, rel_cwd: rel }));
  // an account's folder is never made (it would show as an account here), nor a folder where a file sits: home itself
  const inAcct = putConvo({ pieces: [Buffer.concat(logOf('h6', 2))], repo_id: HOME_ID, rel_cwd: '.claude-c/x' });
  fs.writeFileSync(path.join(home, 'a-file'), 'x');
  const inFile = putConvo({ pieces: [Buffer.concat(logOf('h7', 2))], repo_id: HOME_ID, rel_cwd: 'a-file' });
  r = await m.scanOnce();
  ok(!fs.existsSync(path.join(home, '.claude-c')) && same(mainOf(inAcct.id, home), inAcct.main), 'home row: ~/.claude-<letter> is never made; laid down in the home folder\'s slug folder');
  ok(fs.statSync(path.join(home, 'a-file')).isFile() && same(mainOf(inFile.id, home), inFile.main), 'home row: a file where its folder would be: laid down in the home folder\'s slug folder');
  ok(same(mainOf(atHome.id, home), atHome.main), 'home row: rel_cwd \'\' is laid down in the home folder\'s slug folder');
  ok(fs.statSync(botDir).isDirectory() && fs.readdirSync(botDir).length === 0, 'home row: a folder this machine lacks is made under home, empty');
  ok(same(mainOf(inBot.id, botDir), inBot.main), 'home row: and the log is laid down in that folder\'s slug folder');
  eq(logs.filter((t) => t.includes(inBot.id) && /made the folder it began in/.test(t)).length, 1, 'home row: making the folder is logged');
  ok(same(mainOf(inScratch.id, scratch), inScratch.main), 'home row: a folder that is here is used as it is');
  const hrp = fake.tables.repo_paths.find((x) => x.device_id === me && x.repo_id === HOME_ID);
  ok(hrp && P_same(hrp.root, home), `home row: this device's repo_paths root for it is its home folder (${hrp && hrp.root})`);
  ok(!fs.existsSync(path.join(elsewhere, 'made-here')) && !walk(T).some((f) => path.basename(f).startsWith(viaLink.id)), 'home row: no folder made through a link, nothing laid down');
  ok(r.reasons['its folder would be made through a link'] === 1, 'home row: the link counted as a skip');
  for (const c of homeRefused) ok(!walk(T).some((f) => path.basename(f).startsWith(c.id)), `home row: rel_cwd ${JSON.stringify(c.row.rel_cwd)} refused, nothing written`);
  ok(!fs.existsSync(outsideDir), 'home row: nothing made outside the home folder');
  eq(r.reasons['its rel_cwd is not a plain relative path'], refused.length + homeRefused.length, 'home row: every bad rel_cwd counted (the repo ones above still are)');
  // more lines: it grows where it is, and the folder is not made (or logged) again
  const botMore = Buffer.concat(logOf('h1', 2, 'more'));
  putFile(inBot.id, 'main', 0, [botMore], 1, inBot.main.length);
  Object.assign(inBot.row, { size: inBot.main.length + botMore.length, sha256: X.sha256(Buffer.concat([inBot.main, botMore])), updated_at: stamp() });
  r = await m.scanOnce();
  ok(same(mainOf(inBot.id, botDir), Buffer.concat([inBot.main, botMore])), 'home row: it grew where it was laid down');
  eq(logs.filter((t) => t.includes(inBot.id) && /made the folder/.test(t)).length, 1, 'home row: the folder is made once');
  // pull: the folder it resumes in, made
  const pHome = putConvo({ pieces: [Buffer.concat(logOf('h5', 2))], repo_id: HOME_ID, rel_cwd: 'Bots/pulled' });
  const pulledDir = path.join(home, 'Bots', 'pulled');
  const ph = await m.pull(pHome.id);
  ok(ph.outcome === 'done' && P_same(ph.folder, pulledDir) && fs.statSync(pulledDir).isDirectory() && same(mainOf(pHome.id, pulledDir), pHome.main), `home row: pull makes the folder and says it (${ph.outcome}, ${ph.folder})`);
  fs.unlinkSync(link); // the link goes before the temp folder does

  // ---------- S4: pull, owners, only ----------
  const lower = (x) => String(x).toLowerCase();
  // missing: no row, or one that is not active
  eq(await m.pull(crypto.randomUUID()), { outcome: 'missing' }, 'pull: no row -> missing');
  eq((await m.pull(c9c.id)).outcome, 'missing', 'pull: an archived row -> missing');
  let threwPull = null;
  try { await m.pull('nope'); } catch (e) { threwPull = e; }
  ok(threwPull && threwPull.code === 'bad_request', 'pull: a bad id throws');
  // mine: this device owns it
  const pm = await m.pull(c9.id.toUpperCase());
  ok(pm.outcome === 'mine' && pm.row && pm.row.id === c9.id && !fs.existsSync(mainOf(c9.id)), 'pull: this device\'s own row -> mine, nothing laid down');
  // done: laid down now, with the slug folder and the resume folder
  const pd = putConvo({ pieces: [Buffer.concat(logOf('pd', 3)), Buffer.concat(logOf('pd', 2, 'y'))], rel_cwd: 'sub' });
  let pr = await m.pull(pd.id);
  const subDir = path.join(rootDir, 'sub');
  ok(pr.outcome === 'done' && same(mainOf(pd.id, subDir), pd.main), `pull: laid down at once (${pr.outcome})`);
  ok(P_same(pr.dir, slugDir(subDir)) && path.isAbsolute(pr.dir), `pull: dir is the slug folder (${pr.dir})`);
  ok(P_same(pr.folder, subDir), `pull: folder is the resume folder root + rel_cwd (${pr.folder})`);
  ok(pr.row && pr.row.id === pd.id && 'lease_until' in pr.row, 'pull: the row comes back (with lease_until)');
  pr = await m.pull(pd.id);
  ok(pr.outcome === 'same' && P_same(pr.dir, slugDir(subDir)), 'pull again: same, and dir still given');
  // a back-off is cleared: a failed one is pulled at once once fixed
  const pb = putConvo({ pieces: [Buffer.concat(logOf('pb', 2)), Buffer.concat(logOf('pb', 2, 'y'))] });
  const pbLost = chunkRows(pb.id)[1];
  const pbBlob = fake.objects.get(`${UID}/${pbLost.object_path}`);
  fake.objects.delete(`${UID}/${pbLost.object_path}`);
  r = await m.scanOnce();
  ok(!fs.existsSync(mainOf(pb.id)) && m.status().waiting >= 1, 'pull: the broken one backs off in the scan');
  let pbErr = null;
  try { await m.pull(pb.id); } catch (e) { pbErr = e; }
  ok(pbErr && !fs.existsSync(mainOf(pb.id)), 'pull: a failure throws and writes nothing');
  fake.objects.set(`${UID}/${pbLost.object_path}`, pbBlob);
  pr = await m.pull(pb.id);
  ok(pr.outcome === 'done' && same(mainOf(pb.id), pb.main), 'pull: the back-off does not hold it up');
  // conflict: a longer local copy
  const pc = putConvo({ pieces: [Buffer.concat(logOf('pc', 3))] });
  const pcLocal = Buffer.concat([pc.main, line({ type: 'cost-state' })]);
  write(mainOf(pc.id), pcLocal);
  pr = await m.pull(pc.id);
  ok(pr.outcome === 'conflict' && /longer/.test(pr.reason) && same(mainOf(pc.id), pcLocal), `pull: a longer local copy -> conflict, left alone (${pr.outcome})`);
  ok(P_same(pr.dir, slugDir(rootDir)) && P_same(pr.folder, rootDir), 'pull: a conflict still says where');
  fs.rmSync(mainOf(pc.id));
  // open here: skip, with where
  const pl = putConvo({ pieces: [Buffer.concat(logOf('pl', 2))] });
  const mOpen = D.createMaterializer({ api, dataDir, key: KEY, home, roots: [plain, repoDir], now: () => clock, isOpen: (id) => id === pl.id });
  pr = await mOpen.pull(pl.id);
  ok(pr.outcome === 'skip' && pr.reason === 'open on this machine' && P_same(pr.dir, slugDir(rootDir)) && !fs.existsSync(mainOf(pl.id)), 'pull: open here (isOpen) -> skip, nothing written');

  // ---------- many chunks: fetched D.FETCH_AHEAD at once, laid down in order ----------
  // the fake download answers each chunk after a scrambled delay; it counts the ones on the way at once
  const N = 24;
  const manyPieces = (tag) => Array.from({ length: N }, (_, i) => Buffer.concat(logOf(tag, 3, `${tag}${i}`)));
  const seqOf = (p) => Number(p.split('/').pop());
  const fetching = { now: 0, most: 0, started: [], fail: null };
  const slowDownload = async (p, o) => {
    if (!fetching.only || !p.includes(fetching.only)) return realDownload(p, o);
    const seq = seqOf(p);
    fetching.started.push(seq);
    fetching.now++;
    fetching.most = Math.max(fetching.most, fetching.now);
    try {
      await sleep(3 + ((seq * 7) % 11) * 3);
      if (fetching.fail && fetching.fail(seq)) throw new S.SyncError(`chunk ${seq} could not be fetched`, 0, 'network');
      return await realDownload(p, o);
    } finally { fetching.now--; }
  };
  const unhandled = [];
  const onUnhandled = (e) => { unhandled.push(e); };
  process.on('unhandledRejection', onUnhandled);
  api.storage.download = slowDownload;
  try {
    const big = putConvo({ pieces: manyPieces('big') });
    Object.assign(fetching, { only: big.id, now: 0, most: 0, started: [] });
    pr = await m.pull(big.id);
    ok(pr.outcome === 'done' && same(mainOf(big.id), big.main), `many chunks: laid down byte-identical (${pr.outcome})`);
    ok(fetching.most > 1 && fetching.most <= D.FETCH_AHEAD, `many chunks: more than one fetch at once, at most ${D.FETCH_AHEAD} (${fetching.most})`);
    eq(fetching.started.slice().sort((a, b) => a - b), Array.from({ length: N }, (_, i) => i), 'many chunks: each chunk fetched once');

    // a chunk mid-way fails (a download that throws, then a bad sha256): nothing written, the local copy untouched, no
    // unhandled rejection from the fetches still on the way, and none started after the failure
    const bad = putConvo({ pieces: manyPieces('bad') });
    const local3 = Buffer.concat(chunkRows(bad.id).slice(0, 3).map((c) => bad.main.subarray(c.byte_offset, c.byte_offset + c.byte_length)));
    write(mainOf(bad.id), local3);
    const localStat = fs.statSync(mainOf(bad.id));
    Object.assign(fetching, { only: bad.id, now: 0, most: 0, started: [], fail: (seq) => seq === 10 || seq === 13 });
    let badErr = null;
    try { await m.pull(bad.id); } catch (e) { badErr = e; }
    await sleep(150); // the fetches still on the way settle
    ok(badErr && /chunk 10 could not be fetched/.test(badErr.message), `a failed fetch mid-way: the pull throws it (${badErr && badErr.message})`);
    ok(same(mainOf(bad.id), local3) && fs.statSync(mainOf(bad.id)).mtimeMs === localStat.mtimeMs && !fs.existsSync(`${mainOf(bad.id)}.part`), 'a failed fetch mid-way: the local copy untouched, no .part');
    ok(!fetching.started.some((s) => s < 3) && Math.max(...fetching.started) < 10 + D.FETCH_AHEAD, `a failed fetch mid-way: local chunks not fetched, none started past the window (${Math.max(...fetching.started)})`);
    eq(fetching.now, 0, 'a failed fetch mid-way: no fetch left running');
    // a bad sha256 on chunk 10
    const row10 = chunkRows(bad.id)[10];
    const sha10 = row10.sha256;
    row10.sha256 = X.sha256(Buffer.from('something else'));
    Object.assign(fetching, { now: 0, most: 0, started: [], fail: (seq) => seq === 13 });
    badErr = null;
    try { await m.pull(bad.id); } catch (e) { badErr = e; }
    await sleep(150);
    ok(badErr && badErr.code === 'bad_sha' && /chunk 10/.test(badErr.message), `a bad chunk sha256 mid-way: the pull throws it (${badErr && badErr.code})`);
    ok(same(mainOf(bad.id), local3) && fs.statSync(mainOf(bad.id)).mtimeMs === localStat.mtimeMs && !fs.existsSync(`${mainOf(bad.id)}.part`), 'a bad chunk sha256 mid-way: the local copy untouched, no .part');
    ok(Math.max(...fetching.started) < 10 + D.FETCH_AHEAD, 'a bad chunk sha256 mid-way: none started past the window');
    eq(unhandled.length, 0, 'failures mid-way: no unhandled rejection');
    row10.sha256 = sha10;

    // a local copy holding some chunks and a part of the next: those are copied, the rest fetched, all in order
    const mix = putConvo({ pieces: manyPieces('mix') });
    Object.assign(fetching, { only: mix.id, now: 0, most: 0, started: [], fail: null });
    const mixRows = chunkRows(mix.id);
    // chunks 0 to 5 and the first line of chunk 6 (a whole line, so it is not cut off)
    const chunk6 = mix.main.subarray(mixRows[6].byte_offset, mixRows[6].byte_offset + mixRows[6].byte_length);
    const lineEnd6 = chunk6.indexOf(0x0a) + 1;
    const mixLocal = mix.main.subarray(0, mixRows[6].byte_offset + lineEnd6);
    write(mainOf(mix.id), mixLocal);
    pr = await m.pull(mix.id);
    ok(pr.outcome === 'done' && same(mainOf(mix.id), mix.main), `a partly-here copy: laid down byte-identical (${pr.outcome})`);
    eq(fetching.started.slice().sort((a, b) => a - b), Array.from({ length: N - 6 }, (_, i) => i + 6), 'a partly-here copy: only the chunks it lacks fetched (the cut one too)');
    // a part of a chunk here that differs: a conflict, the copy left alone, nothing left on the way
    const mixBad = putConvo({ pieces: manyPieces('mb') });
    const mbRows = chunkRows(mixBad.id);
    const mbLocal = Buffer.from(mixBad.main.subarray(0, mbRows[4].byte_offset + 10));
    mbLocal[mbLocal.length - 3] ^= 1;
    write(mainOf(mixBad.id), Buffer.concat([mbLocal, Buffer.from('\n')]));
    Object.assign(fetching, { only: mixBad.id, now: 0, started: [] });
    pr = await m.pull(mixBad.id);
    await sleep(150);
    ok(pr.outcome === 'conflict' && /different/.test(pr.reason) && same(mainOf(mixBad.id), Buffer.concat([mbLocal, Buffer.from('\n')])), `a partly-here copy that differs mid-chunk: conflict, left alone (${pr.outcome})`);
    ok(fetching.started.length > 1, `a partly-here copy that differs: other fetches were on the way when it stopped (${fetching.started.length})`);
    ok(!fs.existsSync(`${mainOf(mixBad.id)}.part`) && fetching.now === 0 && unhandled.length === 0, 'a partly-here copy that differs: no .part, nothing left running, no unhandled rejection');
    fs.rmSync(mainOf(mixBad.id));
  } finally {
    api.storage.download = realDownload;
    process.removeListener('unhandledRejection', onUnhandled);
    fetching.only = null;
  }

  // ---------- several conversations at once (D.ROWS_AT_ONCE), pulls first, one id never twice ----------
  // A second materializer (its own dataDir: its own device and down-state.json) whose scans look only at scanIds. The
  // fake api is slowed down for the ids in watch: each chunk list, row read and download waits, and each is logged in
  // ev ('chunks' a row's chunk list: where a scan row or a pull lays it down; 'row' a pull reading its row; 'get' and
  // 'got' a download's start and end). net.most: the most conversations with a request on the way at once.
  const dataDir2 = path.join(T, 'data2');
  const watch = new Set();
  let scanIds = new Set();
  const m3 = D.createMaterializer({ api, dataDir: dataDir2, key: KEY, home, roots: [repoDir], now: () => clock, only: (id) => scanIds.has(id), log: (t) => logs.push(t) });
  const realRest = api.rest;
  const ev = [];
  const net = { open: new Map(), most: 0, failOn: null, onGet: null };
  const opened = (id) => { net.open.set(id, (net.open.get(id) || 0) + 1); net.most = Math.max(net.most, net.open.size); };
  const closed = (id) => { const n = net.open.get(id) - 1; if (n) net.open.set(id, n); else net.open.delete(id); };
  const watched = (s) => [...watch].find((x) => String(s).includes(x)) || null;
  const fresh3 = () => { ev.length = 0; net.most = 0; };
  const at = (k, id) => ev.findIndex((e) => e.k === k && e.id === id);
  const lastAt = (k, id) => ev.map((e, i) => (e.k === k && e.id === id ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
  const three = (tag) => putConvo({ pieces: [Buffer.concat(logOf(tag, 2)), Buffer.concat(logOf(tag, 2, 'y')), Buffer.concat(logOf(tag, 2, 'z'))] });
  const newestFirst = (list) => list.slice().sort((a, b) => (a.row.updated_at < b.row.updated_at ? 1 : -1));
  const several = (n, tag) => { const l = Array.from({ length: n }, (_, i) => three(`${tag}${i}`)); for (const c of l) watch.add(c.id); scanIds = new Set(l.map((c) => c.id)); return newestFirst(l); };
  const saved2 = () => C.readState(D.downStatePath(dataDir2), {}).convos || {};
  const unhandled3 = [];
  const onUnhandled3 = (e) => { unhandled3.push(e); };
  process.on('unhandledRejection', onUnhandled3);
  api.rest = async (method, table, o = {}) => {
    const q = o.query || {};
    const id = method === 'GET' && (table === 'chunks' || table === 'conversations') ? watched(q.conversation_id || q.id || '') : null;
    if (!id) return realRest(method, table, o);
    const k = table === 'chunks' ? 'chunks' : 'row';
    ev.push({ k, id }); opened(id);
    try { await sleep(15); return await realRest(method, table, o); } finally { closed(id); }
  };
  api.storage.download = async (p, o) => {
    const id = watched(p);
    if (!id) return realDownload(p, o);
    ev.push({ k: 'get', id }); opened(id);
    try {
      if (net.onGet) net.onGet(id);
      if (net.failOn === id) throw new S.SyncError(`${id} could not be fetched`, 0, 'network');
      await sleep(40);
      return await realDownload(p, o);
    } finally { closed(id); ev.push({ k: 'got', id }); }
  };
  try {
    // (a) ten changed rows: more than one under way at once, never more than ROWS_AT_ONCE, started in list order
    fresh3();
    const wa = several(10, 'ra');
    r = await m3.scanOnce();
    ok(net.most > 1 && net.most <= D.ROWS_AT_ONCE, `rows at once: more than one, at most ${D.ROWS_AT_ONCE} (${net.most})`);
    eq(r.done, wa.length, 'rows at once: every row laid down');
    const ds = saved2();
    ok(wa.every((c) => same(mainOf(c.id), c.main) && ds[c.id] && ds[c.id].sig === `${c.row.updated_at}|0|${c.row.size}|${c.row.sha256}`), 'rows at once: byte-identical, each one saved in down-state.json');
    eq(ev.filter((e) => e.k === 'chunks').map((e) => e.id), wa.map((c) => c.id), 'rows at once: started in list order');

    // (b) a pull of a conversation the scan is not on, asked while rows wait their turn: it goes before them
    fresh3();
    const wb = several(8, 'rb');
    const pb = three('pb');
    watch.add(pb.id); // not in scanIds: only the pull lays it down
    let pullB = null;
    net.onGet = (id) => { if (!pullB && id === wb[0].id) pullB = m3.pull(pb.id); };
    r = await m3.scanOnce();
    net.onGet = null;
    const pbr = pullB ? await pullB : null;
    ok(pbr && pbr.outcome === 'done' && same(mainOf(pb.id), pb.main) && r.done === wb.length, `pull beside a scan: it and the rows laid down (${pbr && pbr.outcome})`);
    const pbAt = at('row', pb.id);
    ok(wb.slice(0, D.ROWS_AT_ONCE).every((c) => at('chunks', c.id) < pbAt), 'pull beside a scan: the rows already under way started first');
    ok(pbAt >= 0 && wb.slice(D.ROWS_AT_ONCE).every((c) => pbAt < at('chunks', c.id)), 'pull beside a scan: it starts before the rows waiting their turn');
    ok(net.most <= D.ROWS_AT_ONCE, `pull beside a scan: it counts against ROWS_AT_ONCE (${net.most})`);

    // (c) a pull of a conversation the scan has under way: it starts only once that row is done
    fresh3();
    const wc = several(6, 'rc');
    const target = wc[1];
    let pullC = null;
    net.onGet = (id) => { if (!pullC && id === target.id) pullC = m3.pull(target.id); };
    r = await m3.scanOnce();
    net.onGet = null;
    const pcr = pullC ? await pullC : null;
    ok(pcr && pcr.outcome === 'same' && same(mainOf(target.id), target.main), `pull of a row under way: the scan laid it down, the pull found it the same (${pcr && pcr.outcome})`);
    ok(at('row', target.id) > lastAt('got', target.id) && lastAt('got', target.id) > 0, 'pull of a row under way: it starts after that row\'s last download, never beside it');
    eq(ev.filter((e) => e.k === 'chunks' && e.id === target.id).length, 2, 'pull of a row under way: one chunk list for the row, one for the pull');

    // (d) Supabase out of reach on one row: no row starts after it, the ones under way finish and are saved, the scan
    // throws that error, nothing unhandled; the next scans lay down the rest
    fresh3();
    const wd = several(8, 'rd');
    net.failOn = wd[2].id;
    let dErr = null;
    try { await m3.scanOnce(); } catch (e) { dErr = e; }
    net.failOn = null;
    await sleep(100);
    ok(dErr && dErr.code === 'network' && dErr.message.includes(wd[2].id), `out of reach mid-scan: the scan throws it (${dErr && dErr.message})`);
    eq([...new Set(ev.filter((e) => e.k === 'chunks').map((e) => e.id))], wd.slice(0, D.ROWS_AT_ONCE).map((c) => c.id), 'out of reach mid-scan: no row starts after it');
    const dsd = saved2();
    ok([0, 1, 3].every((i) => same(mainOf(wd[i].id), wd[i].main) && dsd[wd[i].id]), 'out of reach mid-scan: the rows under way finished and were saved');
    ok(!fs.existsSync(mainOf(wd[2].id)) && !dsd[wd[2].id] && !wd.slice(D.ROWS_AT_ONCE).some((c) => fs.existsSync(mainOf(c.id))), 'out of reach mid-scan: nothing for the failed row or the ones not started');
    ok(net.open.size === 0 && unhandled3.length === 0 && m3.status().lastError === dErr.message, 'out of reach mid-scan: nothing left on the way, no unhandled rejection, status says it');
    r = await m3.scanOnce();
    ok(wd.slice(D.ROWS_AT_ONCE).every((c) => same(mainOf(c.id), c.main)) && !fs.existsSync(mainOf(wd[2].id)) && r.waiting === 1, 'out of reach mid-scan: the next scan lays down the rest, the failed row backs off');
    later();
    r = await m3.scanOnce();
    ok(same(mainOf(wd[2].id), wd[2].main), 'out of reach mid-scan: the failed row after its back-off');

    // (e) a scan starting while a pull is under way reloads down-state.json only once the pull is done
    fresh3();
    scanIds = new Set();
    const pe = three('pe');
    watch.add(pe.id);
    const statePath2 = path.resolve(D.downStatePath(dataDir2));
    const realRead = fs.readFileSync;
    fs.readFileSync = function (f, ...a) { if (typeof f === 'string' && P_same(f, statePath2)) ev.push({ k: 'state', id: null }); return realRead.call(this, f, ...a); };
    let scanE = null;
    try {
      net.onGet = (id) => { if (!scanE && id === pe.id) scanE = m3.scanOnce(); };
      const per = await m3.pull(pe.id);
      net.onGet = null;
      if (scanE) await scanE;
      ok(per.outcome === 'done' && same(mainOf(pe.id), pe.main), `reload: the pull laid it down (${per.outcome})`);
    } finally { fs.readFileSync = realRead; net.onGet = null; }
    const reloadAt = ev.findIndex((e) => e.k === 'state');
    ok(scanE && reloadAt > lastAt('got', pe.id) && lastAt('got', pe.id) >= 0, `reload: the scan's state reload waited for the pull (${reloadAt} after ${lastAt('got', pe.id)})`);
    ok(saved2()[pe.id], 'reload: the pull\'s conversation is still in down-state.json after the scan');
    eq(unhandled3.length, 0, 'several at once: no unhandled rejection');
  } finally {
    api.rest = realRest;
    api.storage.download = realDownload;
    process.removeListener('unhandledRejection', onUnhandled3);
    net.onGet = null; net.failOn = null;
  }

  // owners(): the rows other devices own, with their lease
  const fresh = D.createMaterializer({ api, dataDir, key: KEY, home, roots: [repoDir] });
  eq([fresh.owners().size, fresh.status().listedAt], [0, null], 'owners: empty before the first scan, listedAt null');
  const leaseAt = new Date(Date.now() + 120e3).toISOString();
  c1.row.lease_until = leaseAt;
  clock += 1000;
  const listStart = clock;
  r = await m.scanOnce();
  eq(m.status().listedAt, new Date(listStart).toISOString(), 'owners: status().listedAt is when the listing began');
  const ow = m.owners();
  ok(ow instanceof Map && ow.size > 5, `owners: a Map of the rows another device owns (${ow.size})`);
  eq(ow.get(c1.id), { device: lower(OTHER), leaseUntil: Date.parse(leaseAt), account: 'b' }, 'owners: device, leaseUntil and the row\'s account');
  eq(ow.get(c2.id), { device: lower(OTHER), leaseUntil: null, account: 'b' }, 'owners: no lease -> null');
  eq(ow.get(inA.id) && ow.get(inA.id).account, 'a', 'owners: account a (the account it ran under there)');
  ok(!ow.has(c9.id) && !ow.has(c9b.id) && !ow.has(c9c.id), 'owners: not this device\'s, not nobody\'s, not archived');
  ow.delete(c1.id);
  ok(m.owners().has(c1.id), 'owners: a copy, the caller cannot change it');

  // only(): a scan looks only at the conversations it names
  const o1 = putConvo({ pieces: [Buffer.concat(logOf('o1', 2))] });
  const o2 = putConvo({ pieces: [Buffer.concat(logOf('o2', 2))] });
  const mOnly = D.createMaterializer({ api, dataDir, key: KEY, home, roots: [repoDir], only: (id) => id === o1.id });
  r = await mOnly.scanOnce();
  ok(same(mainOf(o1.id), o1.main) && !fs.existsSync(mainOf(o2.id)), 'only: just the one it names is laid down');
  eq([r.rows, [...mOnly.owners().keys()]], [1, [o1.id]], 'only: one row looked at, one in owners()');
  r = await m.scanOnce();
  ok(same(mainOf(o2.id), o2.main), 'only: the other is laid down by a scan without only');

  eq(parts(), [], 'no .part file anywhere at the end');
  ok(!walk(T).some((f) => !inside(T, f)), 'nothing outside the temp folder');

  // ---------- status: nothing secret; start and stop ----------
  const s = JSON.stringify(m.status());
  ok(!s.includes(KEY.toString('hex')) && !s.includes(KEY.toString('base64')) && !s.includes(ACCESS) && !s.includes('rt-x'), 'status: no key and no token');
  const lg = logs.join('\n');
  ok(!lg.includes(KEY.toString('hex')) && !lg.includes(KEY.toString('base64')) && !lg.includes(ACCESS), 'log: no key and no token');
  const before = m.status().scans;
  m.start(20);
  for (let i = 0; i < 100 && m.status().scans < before + 2; i++) await sleep(20);
  ok(m.status().scans >= before + 2 && m.status().running, 'start: scans keep coming');
  await m.stop();
  const atStop = m.status().scans;
  await sleep(120);
  ok(!m.status().running && !m.status().scanning && m.status().scans === atStop, 'stop: no scan after it');

  // no key: nothing happens
  const m2 = D.createMaterializer({ api, dataDir, key: async () => null, home, roots: [repoDir] });
  sg = storageGets();
  r = await m2.scanOnce();
  ok(r.skipped === 'no key' && storageGets() === sg, 'no key: no scan');
}

const P = require(path.join(ROOT, 'platform.js'));
function P_same(a, b) { return P.foldCase(path.resolve(a)) === P.foldCase(path.resolve(b)); }
function inside(baseDir, p) { const rel = path.relative(baseDir, p); return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel); }

main().catch((e) => { failures++; console.log(`FAIL the test crashed: ${e && e.stack}`); }).finally(() => {
  server.close();
  if (!process.env.SYNC_TEST_KEEP) { try { fs.rmSync(T, { recursive: true, force: true }); } catch {} } else console.log(`kept ${T}`);
  console.log(`${passes} pass, ${failures} fail`);
  process.exitCode = failures ? 1 : 0;
});
