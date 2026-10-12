// Clone what's missing: a test of sync-clone.js and the materializer's missing() (sync-down.js), run with the system
// node:   node scripts/sync-clone-test.js
// Local bare repos stand in for GitHub (urlOf maps each origin to one), and a fake Supabase (a local HTTP server behind
// the real sync-api.js, as in sync-down-test.js) holds another machine's conversation rows in three repos and the home
// row: the first scan lists the two repos with no checkout here (not the home row), with their chats and newest
// first; the default clone folder is where this machine's checkouts with an origin live (else ~/code on a Mac, else
// home); the card asks while auto is off and a repo was never answered; Clone puts the repo in <folder>/<name>, or
// <name>-2 when a plain folder holds the name (left untouched), sets its origin remote to the synced origin, registers
// it, and the next scan lays its conversations down there while missing() drops it; its package-lock.json runs npm ci
// there, a pnpm-lock.yaml with no pnpm is a note, a yarn install that fails is a note (the clone still done), all in
// clone.log; a folder already holding a checkout of that origin is registered, not cloned, and gets no install; a
// failed clone (nothing at its URL) and a refused sign-in leave no folder and no hidden leftover, the sign-in one saying
// "Sign in to GitHub on this machine: gh auth login", and gh repo clone is tried for GitHub when gh is here; a crash's
// hidden leftover over an hour old is removed; Not now stays quiet until a new repo goes missing; unticked repos are
// put off without auto and declined with it; with auto on, tick() clones each newly missing repo once (one that fails is
// not tried again by itself) and never a declined one; a repo not missing is refused; the policy survives a restart
// (a new cloner over the same settings); a scan cut short keeps the list from before. Everything happens in a temp
// folder (SYNC_TEST_DIR, or the system temp folder), deleted at the end (SYNC_TEST_KEEP=1 keeps it). Exit 0 = all pass.
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
const K = require(path.join(ROOT, 'sync-clone.js'));
const P = require(path.join(ROOT, 'platform.js'));

const base = process.env.SYNC_TEST_DIR || os.tmpdir();
fs.mkdirSync(base, { recursive: true });
const T = fs.realpathSync(fs.mkdtempSync(path.join(base, 'sync-clone-test-')));

let failures = 0, passes = 0;
const ok = (cond, what) => { if (cond) passes++; else { failures++; console.log(`FAIL ${what}`); } };
const eq = (a, b, what) => ok(JSON.stringify(a) === JSON.stringify(b), `${what}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
const write = (f, data) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); };
const read = (f) => { try { return fs.readFileSync(f); } catch { return null; } };
const same = (a, b) => P.foldCase(path.resolve(a)) === P.foldCase(path.resolve(b));
const g = (cwd, ...args) => cp.execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

// values shaped like the real thing are put together here, so this file holds none the share guard would flag
const PUB = 'sb_' + 'publishable_' + 'TestOnlyKey0123456789abcd';
const UID = crypto.randomUUID();
const ACCESS = `at-${crypto.randomBytes(12).toString('hex')}`;
const KEY = crypto.randomBytes(32);
const OTHER = crypto.randomUUID(); // the machine that uploaded
const GH = 'https://github.com/glodusk/';
const O = { proj: `${GH}proj`, tool: `${GH}tool`, yarny: `${GH}yarny`, later: `${GH}later`, later2: `${GH}later2`, gone: `${GH}gone`, fresh3: `${GH}fresh3`, priv: `${GH}priv`, existing: `${GH}existing`, stranger: 'https://github.com/someone-else/stranger' };
const REPO_IDS = Object.fromEntries(Object.keys(O).map((k) => [k, crypto.randomUUID()]));
const HOME_ID = crypto.randomUUID();

// ---------- the fake Supabase (sync-down-test.js's, the parts the materializer uses) ----------
const fake = {
  tables: { devices: [{ id: OTHER, name: 'BlackBox', platform: 'win32' }], repos: [{ id: HOME_ID, origin: C.HOME_ORIGIN }], repo_paths: [], conversations: [], chunks: [] },
  objects: new Map(), down: false,
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
        if (have) { Object.assign(have, r); made.push(have); continue; }
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
    if (fake.down && u.pathname === '/rest/v1/conversations') { req.socket.destroy(); return; }
    if (req.headers.apikey !== PUB || req.headers.authorization !== `Bearer ${ACCESS}`) return json(res, 401, { message: 'JWT expired' });
    if (u.pathname.startsWith('/rest/v1/')) return restCall(req, u, body, res);
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

let tick = 0;
const stamp = () => new Date(Date.UTC(2026, 9, 10, 12, 0, 0) + (tick++) * 1000).toISOString();
const line = (o) => Buffer.from(`${JSON.stringify(o)}\n`);
// a conversation row of the other machine's in repo k (a repos row made for it the first time)
function putConvo(k, n = 3) {
  const repoId = k === 'home' ? HOME_ID : REPO_IDS[k];
  if (k !== 'home' && !fake.tables.repos.some((r) => r.id === repoId)) fake.tables.repos.push({ id: repoId, origin: O[k] });
  const id = crypto.randomUUID();
  const main = Buffer.concat(Array.from({ length: n }, (_, i) => line({ type: i % 2 ? 'assistant' : 'user', sessionId: id, cwd: 'Z:\\Github\\x', uuid: crypto.randomUUID(), text: `${k} line ${i}` })));
  const rel = C.objectPath(id, 'main', 0, 0);
  fake.objects.set(`${UID}/${rel}`, X.sealChunk(main, KEY, rel));
  fake.tables.chunks.push({ conversation_id: id, file: 'main', generation: 0, seq: 0, byte_offset: 0, byte_length: main.length, object_path: rel, sha256: X.sha256(main) });
  fake.tables.conversations.push({
    id, account: 'b', repo_id: repoId, rel_cwd: '', branch: 'main', title_enc: null, state: 'active', owner_device: OTHER,
    lease_until: null, size: main.length, sha256: X.sha256(main), generation: 0, updated_at: stamp(),
  });
  return { id, main };
}

// ---------- "GitHub": a bare repo per origin, made from a small source repo ----------
const GITHUB = path.join(T, 'github');
function bareRepo(k, files) {
  const src = path.join(T, 'src', k);
  fs.mkdirSync(src, { recursive: true });
  g(src, 'init', '-q');
  for (const [f, text] of Object.entries(files)) write(path.join(src, f), text);
  g(src, 'add', '.');
  g(src, 'commit', '-qm', `${k}: first`);
  const bare = path.join(GITHUB, `${k}.git`);
  g(T, 'clone', '-q', '--bare', src, bare);
  return bare;
}

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const dataDir = path.join(T, 'data');
  write(path.join(dataDir, 'sync', 'config.json'), JSON.stringify({ url: `http://127.0.0.1:${port}`, publishableKey: PUB }));
  let text = JSON.stringify({ v: 1, url: `http://127.0.0.1:${port}`, uid: UID, email: 'h@example.com', member: true, refreshToken: 'rt-x', accessToken: ACCESS, expiresAt: Date.now() + 3600e3 });
  const store = { kind: 'memory', stamp: () => (text === null ? null : 'm1'), read: async () => text, write: async (t) => { text = t; }, clear: async () => { text = null; } };
  const api = S.createSync({ dataDir, store, allowLoopbackUrl: true });

  const home = path.join(T, 'home');
  const projB = path.join(home, '.claude', 'projects');
  fs.mkdirSync(projB, { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude-a', 'projects'), { recursive: true });

  bareRepo('proj', { 'README.md': 'proj\n', 'package-lock.json': '{"lockfileVersion":3}\n', 'package.json': '{"name":"proj"}\n' });
  bareRepo('tool', { 'README.md': 'tool\n', 'pnpm-lock.yaml': 'lockfileVersion: 9\n' });
  bareRepo('yarny', { 'README.md': 'yarny\n', 'yarn.lock': '# yarn\n' });
  bareRepo('later', { 'README.md': 'later\n' });
  bareRepo('later2', { 'README.md': 'later2\n' });
  bareRepo('priv', { 'README.md': 'priv\n', 'package-lock.json': '{}\n' });
  bareRepo('existing', { 'README.md': 'existing\n', 'package-lock.json': '{}\n' });
  // (no bare repo for gone and fresh3: their clones fail)
  const urlOf = (origin) => path.join(GITHUB, `${origin.split('/').pop()}.git`);

  // this machine: one checkout with an origin, in <T>/work, so <T>/work is the default clone folder
  const work = path.join(T, 'work');
  const existingSrc = path.join(T, 'work', 'mine');
  g(T, 'clone', '-q', urlOf(O.existing), existingSrc);
  g(existingSrc, 'remote', 'set-url', 'origin', 'git@github.com:GLODUSK/Mine.git');
  const registered = [existingSrc];

  let clock = Date.now();
  const m = D.createMaterializer({ api, dataDir, key: KEY, home, roots: () => registered.slice(), now: () => clock, log: () => {} });

  // ---------- missing(): the repos the scan skipped for want of a checkout ----------
  eq(m.missing(), { at: null, repos: [] }, 'missing: nothing known before the first scan');
  putConvo('proj'); putConvo('proj'); putConvo('tool'); putConvo('home');
  let r = await m.scanOnce();
  let miss = m.missing();
  ok(typeof miss.at === 'string', 'missing: the scan\'s time once it ran');
  eq(miss.repos.map((x) => [x.origin, x.name, x.chats]), [[O.tool, 'tool', 1], [O.proj, 'proj', 2]], 'missing: both repos, newest first, with their chats (never the home row)');
  ok(miss.repos.every((x) => typeof x.newest === 'string'), 'missing: each with its newest updated_at');
  eq(r.reasons[D.NO_CHECKOUT], 3, 'the scan still counts the skipped rows under its reason');
  miss.repos[0].chats = 99;
  eq(m.missing().repos[0].chats, 1, 'missing: a copy (the caller cannot change it)');

  // ---------- the cloner ----------
  let saved = undefined;
  const settings = { read: () => (saved === undefined ? undefined : JSON.parse(JSON.stringify(saved))), write: (v) => { saved = JSON.parse(JSON.stringify(v)); } };
  const runs = [];
  const npm = path.join(T, 'bin', 'npm'), yarn = path.join(T, 'bin', 'yarn');
  const tools = { npm, yarn }; // no pnpm, no bun on this machine
  let failGitFor = new Set(); // origins whose git clone says the sign-in failed
  const git = async (args, o) => {
    const i = args.indexOf('--');
    if (args[0] === 'clone' && i >= 0 && [...failGitFor].some((x) => args[i + 1] === urlOf(x))) return { code: 128, out: '', err: `fatal: Authentication failed for '${args[i + 1]}'` };
    return new Promise((resolve) => cp.execFile('git', args, { cwd: o && o.cwd, windowsHide: true, encoding: 'utf8' }, (e, out, err) => resolve({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, out: String(out || ''), err: String(err || '') })));
  };
  const run = async (file, args, o) => {
    runs.push({ file, args, cwd: o.cwd });
    if (file === 'FAKE_GH' && args[0] === 'repo' && args[1] === 'clone') {
      try { cp.execFileSync('git', ['clone', '-q', urlOf(`https://github.com/${args[2]}`), args[3]], { windowsHide: true, stdio: 'ignore' }); return { code: 0, out: '', err: '' }; } catch { return { code: 1, out: '', err: 'gh: clone failed' }; }
    }
    if (file === yarn) return { code: 1, out: 'resolving...', err: 'error An unexpected error occurred: "network down".' };
    write(path.join(o.cwd, 'node_modules', '.installed'), `${path.basename(file)} ${args.join(' ')}`);
    return { code: 0, out: 'added 0 packages', err: '' };
  };
  const logs = [];
  const make = (extra = {}) => K.createCloner({
    dataDir, home, now: () => clock, log: (t) => logs.push(t), platform: 'darwin',
    missing: () => m.missing(), roots: () => registered.slice(), rescan: () => {}, settings, urlOf, git, run,
    which: (n) => tools[n] || null, gh: null,
    register: (dir) => { if (!registered.some((x) => same(x, dir))) registered.push(dir); return { ok: true }; },
    ...extra,
  });
  let cl = make();

  // the default folder: where this machine's checkouts with an origin live
  let v = await cl.view();
  ok(same(v.folder, work) && same(v.defaultFolder, work) && v.picked === false, `the default clone folder is where the checkouts are (${v.folder})`);
  const cl2 = make({ roots: () => [], home: path.join(T, 'home2') });
  ok(same(await cl2.defaultFolder(), path.join(T, 'home2', 'code')), 'no checkout with an origin: ~/code on a Mac');
  const cl3 = make({ roots: () => [], home: path.join(T, 'home3'), platform: 'win32' });
  ok(same(await cl3.defaultFolder(), path.join(T, 'home3')), 'no checkout with an origin elsewhere: the home folder');

  ok(v.ask === true && v.auto === false, 'the card asks: auto is off and the repos were never answered');
  eq(v.repos.map((x) => [x.name, x.state, x.fresh]), [['tool', 'missing', true], ['proj', 'missing', true]], 'view: both repos, missing and fresh');

  // a repo not missing is refused; nothing given is refused
  for (const bad of [[O.later], ['https://example.com/x'], []]) {
    let e = null;
    try { await cl.clone(bad); } catch (x) { e = x; }
    ok(e && e.code === 'bad_request', `clone refuses ${JSON.stringify(bad)}`);
  }
  let e = null;
  try { await cl.clone([O.proj], { folder: 'relative/folder' }); } catch (x) { e = x; }
  ok(e && e.code === 'bad_request', 'clone refuses a folder that is not a full path');
  e = null;
  try { await cl.clone([O.proj], { folder: path.join(T, 'bad|name') }); } catch (x) { e = x; }
  ok(e && e.code === 'bad_request', 'clone refuses a folder with a character Fleet View will not pass on');

  // ---------- Clone: proj into <work>/proj-2 (a plain folder holds proj), tool left unticked ----------
  write(path.join(work, 'proj', 'notes.txt'), 'mine\n');
  const leftover = path.join(work, '.proj.fv-clone-0123456789ab');
  write(path.join(leftover, 'x'), 'crashed\n');
  const old = new Date(Date.now() - 2 * 3600e3);
  fs.utimesSync(leftover, old, old);
  const fresh = path.join(work, '.tool.fv-clone-aaaaaaaaaaaa');
  write(path.join(fresh, 'x'), 'another clone right now\n');
  let out = await cl.clone([O.proj], { auto: false, skip: [O.tool] });
  ok(out.ok && out.job && out.job.items.length === 1, 'clone answers at once with its job');
  await cl.idle();
  let job = cl.job(out.job.id);
  const projDir = path.join(work, 'proj-2');
  eq(job.items.map((x) => [x.state, x.dir && path.basename(x.dir)]), [['done', 'proj-2']], 'the taken name gets -2');
  eq(fs.readdirSync(path.join(work, 'proj')), ['notes.txt'], 'the folder that held the name is untouched');
  ok(fs.existsSync(path.join(projDir, 'README.md')) && fs.existsSync(path.join(projDir, '.git')), 'the clone is in place');
  eq(C.normalizeOrigin(g(projDir, 'remote', 'get-url', 'origin')), O.proj, 'its origin remote is the synced origin (not the URL it came from)');
  ok(registered.some((x) => same(x, projDir)), 'it is registered (as POST /repos/add)');
  ok(!fs.existsSync(leftover), 'a crash\'s hidden leftover over an hour old is removed');
  ok(fs.existsSync(fresh), 'a recent one (another clone under way) is left');
  eq(job.items[0].install && [job.items[0].install.tool, job.items[0].install.state], ['npm', 'done'], 'package-lock.json: npm ci, done');
  ok(runs.some((x) => x.file === npm && x.args.join(' ') === 'ci' && same(x.cwd, projDir)), 'npm ci ran in the clone');
  ok(String(read(path.join(dataDir, 'clone.log'))).includes('npm ci'), 'clone.log has the install');
  ok(job.done === true, 'the job is done');

  v = await cl.view();
  ok(v.ask === false, 'answered: the card does not ask again (proj tried, tool put off)');
  eq(saved && [saved.auto, saved.notNow, Object.keys(saved.tried)], [false, [O.tool], [O.proj]], 'the policy: auto off, tool put off, proj tried');

  // ---------- the next scan brings proj's chats into the clone; missing() drops it ----------
  r = await m.scanOnce();
  eq(r.done, 2, 'the next scan lays proj\'s two conversations down');
  const slug = path.join(projB, C.slugOf(projDir));
  const convs = fake.tables.conversations.filter((x) => x.repo_id === REPO_IDS.proj);
  ok(convs.every((x) => fs.existsSync(path.join(slug, `${x.id}.jsonl`))), 'in the clone\'s own slug folder');
  eq(m.missing().repos.map((x) => x.name), ['tool'], 'missing: only tool now');

  // ---------- a checkout already there is registered, not cloned, and gets no install ----------
  putConvo('existing');
  // <work>/existing: a checkout of that very origin Fleet View did not know
  g(T, 'clone', '-q', urlOf(O.existing), path.join(work, 'existing'));
  g(path.join(work, 'existing'), 'remote', 'set-url', 'origin', O.existing);
  await m.scanOnce();
  ok(m.missing().repos.some((x) => x.origin === O.existing), 'a repo Fleet View has no root for is missing');
  const before = runs.length;
  out = await cl.clone([O.existing]);
  await cl.idle();
  job = cl.job(out.job.id);
  eq([job.items[0].state, path.basename(job.items[0].dir || '')], ['found', 'existing'], 'found: the checkout there is registered');
  ok(job.items[0].install === null && runs.length === before, 'found: no install in a checkout Henry had');
  ok(!fs.existsSync(path.join(work, 'existing-2')), 'found: nothing cloned');

  // ---------- installs by lockfile: pnpm missing, yarn failing ----------
  putConvo('yarny');
  await m.scanOnce();
  out = await cl.clone([O.tool, O.yarny]);
  await cl.idle();
  job = cl.job(out.job.id);
  const byName = Object.fromEntries(job.items.map((x) => [x.name, x]));
  eq([byName.tool.state, byName.tool.install.state], ['done', 'missing'], 'pnpm-lock.yaml with no pnpm: cloned, the install a note');
  ok(/pnpm is not on this machine/.test(byName.tool.install.message) && byName.tool.install.message.includes('pnpm install --frozen-lockfile'), `the note says which tool and what to run (${byName.tool.install.message})`);
  eq([byName.yarny.state, byName.yarny.install.state], ['done', 'failed'], 'a yarn install that fails: cloned, the install a note');
  ok(runs.some((x) => x.file === yarn && x.args.join(' ') === 'install --frozen-lockfile'), 'yarn.lock: yarn install --frozen-lockfile');
  const clog = String(read(path.join(dataDir, 'clone.log')));
  ok(clog.includes('skipped: pnpm is not on this machine') && clog.includes('network down') && clog.includes('--- exit 1'), 'clone.log has the skip and the failed output');

  // ---------- a failed clone leaves nothing behind ----------
  putConvo('gone');
  await m.scanOnce();
  out = await cl.clone([O.gone]);
  await cl.idle();
  job = cl.job(out.job.id);
  ok(job.items[0].state === 'failed' && /git clone failed/.test(job.items[0].message), `nothing at its URL: failed (${job.items[0].message})`);
  ok(!fs.existsSync(path.join(work, 'gone')) && !fs.readdirSync(work).some((n) => n.startsWith('.gone.')), 'a failed clone leaves no folder and no leftover');
  v = await cl.view();
  eq(v.repos.find((x) => x.origin === O.gone).state, 'failed', 'view: the repo shows failed, with its message');
  ok(v.repos.find((x) => x.origin === O.gone).fresh === false && v.ask === false, 'a failed one is not asked about again (the Sync card offers Clone)');

  // a refused sign-in: the message, no leftover; then gh repo clone when gh is here
  putConvo('priv');
  await m.scanOnce();
  failGitFor = new Set([O.priv]);
  out = await cl.clone([O.priv]);
  await cl.idle();
  job = cl.job(out.job.id);
  eq([job.items[0].state, job.items[0].message], ['failed', K.SIGN_IN], 'a refused sign-in, no gh: "Sign in to GitHub on this machine: gh auth login"');
  ok(!fs.readdirSync(work).some((n) => n === 'priv' || n.startsWith('.priv.')), 'nothing left behind');
  const clGh = make({ gh: 'FAKE_GH' });
  out = await clGh.clone([O.priv]);
  await clGh.idle();
  job = clGh.job(out.job.id);
  eq(job.items[0].state, 'done', 'with gh here: gh repo clone after git could not sign in');
  ok(runs.some((x) => x.file === 'FAKE_GH' && x.args.slice(0, 3).join(' ') === 'repo clone glodusk/priv'), 'gh repo clone <owner>/<repo>');
  eq(C.normalizeOrigin(g(job.items[0].dir, 'remote', 'get-url', 'origin')), O.priv, 'its origin is the synced one');
  failGitFor = new Set();

  // ---------- Not now: quiet until a new repo goes missing ----------
  putConvo('later');
  await m.scanOnce();
  cl = make(); // a restart: the policy comes back from the settings
  v = await cl.view();
  ok(v.ask === true && v.repos.find((x) => x.origin === O.later).fresh, 'a new missing repo: the card asks again');
  ok(!v.repos.find((x) => x.origin === O.tool) || !v.repos.find((x) => x.origin === O.tool).fresh, 'the put-off one is not fresh');
  v = await cl.setPolicy({ notNow: true });
  ok(v.ask === false, 'Not now: quiet');
  await m.scanOnce();
  ok((await cl.view()).ask === false, 'still quiet after another scan with nothing new');
  putConvo('later2');
  await m.scanOnce();
  v = await cl.view();
  ok(v.ask === true && v.repos.filter((x) => x.fresh).map((x) => x.name).join() === 'later2', 'a new repo goes missing: the card asks about it alone');

  // ---------- Clone with auto: unticked ones declined; tick() clones each newly missing repo once ----------
  out = await cl.clone([O.later2], { auto: true, skip: [O.later] });
  await cl.idle();
  ok(saved.auto === true && saved.declined.includes(O.later), 'auto on; the unticked repo is declined');
  eq(cl.job(out.job.id).items[0].state, 'done', 'later2 cloned');
  ok((await cl.view()).ask === false, 'with auto on the card never asks');
  let t = await cl.tick();
  await cl.idle();
  ok(t === null, 'tick: nothing new (later declined, the rest tried)');
  ok(!fs.existsSync(path.join(work, 'later')), 'a declined repo is never cloned by itself');
  putConvo('fresh3'); // no bare repo: its clone fails
  await m.scanOnce();
  t = await cl.tick();
  ok(t && t.items.length === 1 && t.items[0].origin === O.fresh3 && t.auto === true, 'tick: the newly missing repo is cloned by itself');
  await cl.idle();
  eq(cl.job(t.id).items[0].state, 'failed', 'its clone failed');
  ok((await cl.tick()) === null, 'tick again: one that failed is not tried again by itself');
  eq(Object.keys(saved.tried).includes(O.fresh3), true, 'it is remembered as tried');

  // a repo under an account this machine has no checkout from (the list comes from Supabase): never cloned by
  // itself, and the card asks about it even with auto on
  eq(K.ownerOf(O.proj), 'https://github.com/glodusk', 'ownerOf: host and owner');
  eq(K.ownerOf('https://github.com/x'), null, 'ownerOf: no owner segment');
  putConvo('stranger');
  await m.scanOnce();
  t = await cl.tick();
  ok(t === null, 'tick: a repo under another account is never cloned by itself');
  ok(!fs.existsSync(path.join(work, 'stranger')), 'nothing cloned for it');
  v = await cl.view();
  const sv = v.repos.find((x) => x.origin === O.stranger);
  ok(v.ask === true && sv && sv.trusted === false && sv.fresh === true, 'with auto on, the card asks about it');
  ok(v.repos.filter((x) => x.origin !== O.stranger).every((x) => x.trusted === true), 'the others are under the account this machine has');
  ok(!(O.stranger in saved.tried), 'and it is not marked tried');

  // the Sync card's switch and folder
  v = await cl.setPolicy({ auto: false });
  ok(v.auto === false && saved.auto === false, 'the switch turns auto off');
  v = await cl.setPolicy({ folder: path.join(T, 'elsewhere') });
  ok(same(v.folder, path.join(T, 'elsewhere')) && v.picked === true, 'a folder picked');
  e = null;
  try { await cl.setPolicy({ folder: 'not/absolute' }); } catch (x) { e = x; }
  ok(e && e.code === 'bad_request', 'a folder that is not a full path is refused');
  v = await cl.setPolicy({ folder: '' });
  ok(same(v.folder, work) && v.picked === false, 'empty: back to the default');
  v = await cl.setPolicy({ folder: '~/repos' });
  ok(same(v.folder, path.join(home, 'repos')), '~/ is the home folder');

  // ---------- a scan cut short keeps the list from before ----------
  const was = m.missing();
  fake.down = true;
  try { await m.scanOnce(); } catch {}
  fake.down = false;
  eq(m.missing(), was, 'a scan cut short (Supabase out of reach) keeps the list from before');

  // ---------- the real runner: a program by its path, its output, its exit code, its time limit ----------
  let rr = await K.runTool(process.execPath, ['-e', "process.stdout.write('hi'); process.stderr.write('oops'); process.exit(3)"], { cwd: T });
  eq([rr.code, rr.out, rr.err], [3, 'hi', 'oops'], 'runTool: exit code, stdout and stderr');
  const t0 = Date.now();
  rr = await K.runTool(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { cwd: T, timeoutMs: 400 });
  ok(rr.code !== 0 && /stopped after/.test(rr.err) && Date.now() - t0 < 10000, `runTool: past its time it is stopped (${rr.code}, ${Date.now() - t0} ms)`);
  rr = await K.runTool(path.join(T, 'no-such-program'), [], { cwd: T });
  ok(rr.code !== 0, 'runTool: a program that is not there fails, never throws');
  ok(K.findTool('git'), 'findTool finds git');
  ok(K.findTool('no-such-tool-fv') === null && K.findTool('bad name;') === null, 'findTool: none, and a name that is not one');
}

main().then(() => {
  server.close();
  if (!process.env.SYNC_TEST_KEEP) { try { fs.rmSync(T, { recursive: true, force: true }); } catch {} } else console.log(`kept: ${T}`);
  console.log(`${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}, (e) => {
  console.log(`FAIL threw: ${e && e.stack || e}`);
  server.close();
  process.exit(1);
});
