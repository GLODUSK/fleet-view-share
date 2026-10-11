// Sync down: a test of sync-down.js (the materializer), run with the system node:   node scripts/sync-down-test.js
// Against a fake Supabase (a local HTTP server standing in for PostgREST and Storage, reached through the real
// sync-api.js createSync() with a made-up sign-in) holding conversation and chunk rows and objects sealed here with
// sync-crypto.js sealChunk at sync-common.js objectPath()s, and a throwaway git repo with a fake GitHub origin:
// a new conversation is laid down byte-identical with its subagents/, tool-results/ and workflows/ files in the slug
// folder of its repo (found by origin; this device's repo_paths row is written); an unchanged row costs no request;
// a local prefix is extended, fetching only the new chunk; a longer local copy and a diverged one are left alone and
// reported in conflicts(); a missing object, a gap, a short cover, a bad chunk or file sha256, an object row pointing
// at another conversation's object and an object copied to another path all write nothing (and a fixed one is laid
// down after the back-off); a conversation open on this machine is skipped; rows owned by this device or by nobody
// are ignored; a rel_cwd with '..', a drive or an absolute path is refused; a subfolder rel_cwd gets its own slug and
// a missing worktree falls back to the root; account A goes to ~/.claude-a; a repo with no checkout here is skipped;
// a whole side file this side wrote is replaced by a new generation, a side file mid-upload waits; no .part file is
// ever left behind; status() holds no key or token; start/stop.
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
const REPO_ID = crypto.randomUUID(), REPO2_ID = crypto.randomUUID();
const ORIGIN = 'https://github.com/glodusk/proj';

// ---------- the fake Supabase ----------
const fake = {
  tables: { devices: [{ id: OTHER, name: 'mac', platform: 'darwin' }], repos: [{ id: REPO_ID, origin: ORIGIN }, { id: REPO2_ID, origin: 'https://github.com/glodusk/elsewhere' }], repo_paths: [], conversations: [], chunks: [] },
  objects: new Map(), calls: [],
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
