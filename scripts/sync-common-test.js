// Sync common: a test of sync-common.js, run with the system node:   node scripts/sync-common-test.js
// The slug rule (the recipe's own example). projectsDirs in a made-up home: B and A, A's projects a link to B's
// (returned once, as B's), a missing folder left out, other letters left out. normalizeOrigin: ssh, ssh://, https
// with a user, .git and a trailing slash all give one GitHub string; another host keeps its path; local paths,
// file:// and Windows drives give null; rowOrigin takes the home row's 'home:' exactly. repoOf against a throwaway git repo with a fake origin and a worktree under
// .claude/worktrees (root is the worktree, mainRoot the main checkout), a repo with no origin, and a plain folder.
// File keys and object paths round-trip, and anything checkRel would refuse throws. conversationFiles lays out a
// conversation's files per docs/sync-format.md and skips what it must. lastMeta finds the cwd, branch and title at
// the end of a log, grows past a long tail, and falls back to custom-title.json. homeCwd picks the first or last cwd
// whose slug is the log's folder (a session that moved into a worktree resumes from where it started). ensureDevice and touchDevice
// against a fake api object. isLive with a live pid, a dead one and a shared sessions folder. readState/writeState.
// Portable or bound: boundOrigin/boundDeviceOf/rowOrigin (no remote normalizes to 'bound:'), workspaceKind in its
// order with sync-work.js's why texts (placeholder, checkout with or without an origin, outside home, home itself, app
// folder, Perforce), inTemp, the placeholder's path and names, boundRel/boundRelOk/boundNative both ways and what they
// refuse, perforceAt (a P4CONFIG file above, a .p4ignore, P4V's Perforce folder under home, a client root),
// classifyFolder against throwaway git repos (a .git git could not read: null), gitUnreadAt, and checkoutAt (a
// worktree's .git file and commondir).
// Everything happens in a temp folder (SYNC_TEST_DIR, or the system temp folder), deleted at the end
// (SYNC_TEST_KEEP=1 keeps it). Nothing here touches the real ~/.claude* folders or the network. Exit 0 = all pass.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const C = require(path.join(ROOT, 'sync-common.js'));
const S = require(path.join(ROOT, 'sync-api.js'));
const P = require(path.join(ROOT, 'platform.js'));

const base = process.env.SYNC_TEST_DIR || os.tmpdir();
fs.mkdirSync(base, { recursive: true });
const T = fs.realpathSync(fs.mkdtempSync(path.join(base, 'sync-common-test-')));

let failures = 0, passes = 0;
const ok = (cond, what) => { if (cond) passes++; else { failures++; console.log(`FAIL ${what}`); } };
const eq = (a, b, what) => ok(JSON.stringify(a) === JSON.stringify(b), `${what}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
const throws = (fn, what) => { try { fn(); ok(false, `${what}: it did not throw`); } catch (e) { ok(e instanceof S.SyncError, `${what}: ${e && e.message}`); } };
async function rejects(p, what) { try { await p; ok(false, `${what}: it did not fail`); } catch { ok(true, what); } }
const same = (a, b) => P.foldCase(path.resolve(a)) === P.foldCase(path.resolve(b));
const write = (f, data) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); };
const ID = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';

async function main() {
  // ---------- slugOf ----------
  eq(C.slugOf('C:\\Users\\henry\\Scratchpads\\scratch-2026-10-10-8'), 'C--Users-henry-Scratchpads-scratch-2026-10-10-8', 'slug: the recipe example');
  eq(C.slugOf('/Users/h/my repo.x_y'), '-Users-h-my-repo-x-y', 'slug: a POSIX path, space, dot and underscore');
  throws(() => C.slugOf(''), 'slug: an empty folder');

  // ---------- projectsDirs ----------
  const home = path.join(T, 'home');
  fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude-a'), { recursive: true });
  fs.symlinkSync(path.join(home, '.claude', 'projects'), path.join(home, '.claude-a', 'projects'), 'junction');
  fs.mkdirSync(path.join(home, '.claude-c', 'projects'), { recursive: true });
  let pd = C.projectsDirs({ home });
  eq(pd.map((r) => r.account), ['b'], 'projectsDirs: a shared folder once, as B');
  ok(pd.length === 1 && same(pd[0].dir, path.join(home, '.claude', 'projects')), 'projectsDirs: B\'s own path');
  const home2 = path.join(T, 'home2');
  fs.mkdirSync(path.join(home2, '.claude', 'projects'), { recursive: true });
  fs.mkdirSync(path.join(home2, '.claude-a', 'projects'), { recursive: true });
  eq(C.projectsDirs({ home: home2 }).map((r) => r.account), ['b', 'a'], 'projectsDirs: two real folders, B first');
  const home3 = path.join(T, 'home3');
  fs.mkdirSync(path.join(home3, '.claude-a', 'projects'), { recursive: true });
  eq(C.projectsDirs({ home: home3 }).map((r) => r.account), ['a'], 'projectsDirs: no B folder');
  eq(C.projectsDirs({ dirs: [{ account: 'a', dir: path.join(home2, '.claude-a', 'projects') }, { account: 'x', dir: home2 }] }).map((r) => r.account), ['a'], 'projectsDirs: an explicit list');

  // ---------- normalizeOrigin ----------
  const GH = 'https://github.com/glodusk/fleet-view';
  for (const u of ['git@github.com:GLODUSK/fleet-view.git', 'https://github.com/GLODUSK/fleet-view', 'https://github.com/GLODUSK/fleet-view.git',
    'https://henry@github.com/GLODUSK/fleet-view.git', 'https://x:tok@github.com/glodusk/fleet-view/', 'ssh://git@github.com/GLODUSK/fleet-view.git',
    'ssh://git@github.com:22/GLODUSK/fleet-view', 'github.com:GLODUSK/fleet-view', '  git@github.com:GLODUSK/fleet-view.git\n']) eq(C.normalizeOrigin(u), GH, `origin: ${u.trim()}`);
  eq(C.normalizeOrigin('git@gitlab.com:Group/Sub/Proj.git'), 'https://gitlab.com/group/sub/proj', 'origin: another host keeps its path');
  eq(C.normalizeOrigin('https://user@git.example.org:8443/a/b.git/'), 'https://git.example.org/a/b', 'origin: another host, user and port gone');
  for (const u of ['C:\\Github\\x', 'C:/Github/x', '/home/h/repo', '../repo', 'file:///C:/x', 'file:///home/x', '', null, 'https://github.com/', 'https://github.com/onlyowner', 'git@github.com:../x', 'ftp://h/x'])
    eq(C.normalizeOrigin(u), null, `origin: not a remote: ${u}`);
  // the home row's pseudo origin: rowOrigin takes exactly it, and no git remote normalizes to it
  eq(C.HOME_ORIGIN, 'home:', 'home origin: the marker');
  eq(C.rowOrigin('home:'), 'home:', 'rowOrigin: the home marker as it is');
  eq(C.normalizeOrigin('home:'), null, 'normalizeOrigin: the home marker is no remote');
  eq(C.rowOrigin('git@github.com:GLODUSK/fleet-view.git'), GH, 'rowOrigin: a remote normalized');
  for (const u of ['HOME:', ' home:', 'home', null]) eq(C.rowOrigin(u), null, `rowOrigin: not the marker: ${u}`);
  ok(C.rowOrigin('home:/x') !== C.HOME_ORIGIN, 'rowOrigin: only the marker exactly is the home row');

  // ---------- repoOf ----------
  const g = (cwd, ...args) => cp.execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  const repo = path.join(T, 'repo');
  fs.mkdirSync(path.join(repo, 'sub', 'deeper'), { recursive: true });
  g(repo, 'init', '-q');
  write(path.join(repo, 'a.txt'), 'a\n');
  g(repo, 'add', '.');
  g(repo, 'commit', '-qm', 'one');
  g(repo, 'remote', 'add', 'origin', 'git@github.com:GLODUSK/Fleet-View.git');
  const wt = path.join(repo, '.claude', 'worktrees', 'w1');
  g(repo, 'worktree', 'add', '-q', '-b', 'w1', wt);
  let r = await C.repoOf(path.join(repo, 'sub', 'deeper'));
  ok(r && same(r.root, repo) && same(r.mainRoot, repo) && r.origin === GH, `repoOf: a subfolder of the main checkout: ${JSON.stringify(r)}`);
  r = await C.repoOf(wt);
  ok(r && same(r.root, wt) && same(r.mainRoot, repo) && r.origin === GH, `repoOf: a worktree: ${JSON.stringify(r)}`);
  ok((await C.repoOf(wt)) === r, 'repoOf: cached');
  const bare = path.join(T, 'noorigin');
  fs.mkdirSync(bare);
  g(bare, 'init', '-q');
  r = await C.repoOf(bare);
  ok(r && same(r.root, bare) && r.origin === null, `repoOf: no origin: ${JSON.stringify(r)}`);
  const local = path.join(T, 'localorigin');
  fs.mkdirSync(local);
  g(local, 'init', '-q');
  g(local, 'remote', 'add', 'origin', repo);
  r = await C.repoOf(local);
  ok(r && r.origin === null, 'repoOf: a local origin is not synced');
  eq(await C.repoOf(home), null, 'repoOf: not a checkout');
  eq(await C.repoOf(path.join(T, 'nope')), null, 'repoOf: no such folder');

  // ---------- file keys and object paths ----------
  for (const k of ['main', 'subagents/agent-a1.jsonl', 'tool-results/x.txt', 'workflows/run-1/journal.jsonl']) {
    ok(C.checkFileKey(k), `fileKey ok: ${k}`);
    eq(C.fileKeyFromB64(C.fileKeyB64(k)), k, `fileKey round trip: ${k}`);
    ok(/^[A-Za-z0-9_-]+$/.test(C.fileKeyB64(k)), `fileKey b64url, no padding: ${k}`);
  }
  for (const k of ['', '.', '..', 'a/../b', 'a//b', '/a', 'a/', 'a b', 'ä', 'a\\b', 'x'.repeat(151), null]) ok(!C.checkFileKey(k), `fileKey refused: ${String(k).slice(0, 20)}`);
  ok(C.checkFileKey('x'.repeat(150)), 'fileKey: 150 bytes fits');
  throws(() => C.fileKeyB64('a/../b'), 'fileKeyB64: a bad key');
  throws(() => C.fileKeyFromB64('Li4'), 'fileKeyFromB64: ".." refused');
  throws(() => C.fileKeyFromB64('bWFpbg=='), 'fileKeyFromB64: padding refused');
  const op = C.objectPath(ID.toUpperCase(), 'subagents/agent-a1.jsonl', 3, 0);
  eq(op, `t/${ID}/${Buffer.from('subagents/agent-a1.jsonl').toString('base64url')}/3/0`, 'objectPath: shape, id in lower case');
  eq(S.checkRel(op), op, 'objectPath: passes checkRel');
  eq(S.objectPath('11111111-2222-3333-4444-555555555555', op).endsWith(op), true, 'objectPath: sync-api puts it under the user');
  eq(C.fileKeyFromB64(op.split('/')[2]), 'subagents/agent-a1.jsonl', 'objectPath: the key comes back from the path');
  ok(C.objectPath(ID, 'x'.repeat(150), 0, 0), 'objectPath: the longest key');
  throws(() => C.objectPath('not-an-id', 'main', 0, 0), 'objectPath: a bad id');
  throws(() => C.objectPath(ID, 'main', -1, 0), 'objectPath: a negative generation');
  throws(() => C.objectPath(ID, 'main', 0, 1.5), 'objectPath: a fractional seq');
  throws(() => C.objectPath(ID, '../x', 0, 0), 'objectPath: a bad key');

  // ---------- conversationFiles ----------
  const slug = path.join(T, 'projects', 'C--x');
  write(path.join(slug, `${ID}.jsonl`), '{"a":1}\n');
  write(path.join(slug, ID, 'subagents', 'agent-a1.jsonl'), '{}\n');
  write(path.join(slug, ID, 'subagents', 'agent-a1.meta.json'), '{}');
  write(path.join(slug, ID, 'tool-results', 'big.txt'), 'x');
  write(path.join(slug, ID, 'workflows', 'run-1', 'deep', 'j.jsonl'), '{}\n');
  write(path.join(slug, ID, 'workflows', 'bad name.txt'), 'x');
  write(path.join(slug, ID, 'custom-title.json'), '{"customTitle":"t"}');
  write(path.join(slug, ID, 'todos', 'x.json'), '{}');
  write(path.join(slug, 'other-id.jsonl'), '{}\n');
  const skipped = [];
  const files = C.conversationFiles(slug, ID, { onSkip: (p, why) => skipped.push(path.basename(p) + ': ' + why) });
  eq(files.map((f) => [f.fileKey, f.appendOnly]), [['main', true], ['subagents/agent-a1.jsonl', true], ['subagents/agent-a1.meta.json', false],
    ['tool-results/big.txt', false], ['workflows/run-1/deep/j.jsonl', true]], 'conversationFiles: keys, kinds, order');
  ok(same(files[0].path, path.join(slug, `${ID}.jsonl`)) && files[0].size === 8, 'conversationFiles: main path and size');
  eq(skipped.map((s) => s.split(':')[0]), ['bad name.txt'], 'conversationFiles: a bad name is skipped and reported');
  eq(C.conversationFiles(slug, '11111111-2222-3333-4444-555555555555'), [], 'conversationFiles: nothing there');
  throws(() => C.conversationFiles(slug, '../x'), 'conversationFiles: a bad id');
  // the async walk sync-up.js scans with: the same files, fields, order and skips
  const skippedA = [];
  const filesA = await C.conversationFilesAsync(slug, ID, { onSkip: (p, why) => skippedA.push(path.basename(p) + ': ' + why) });
  eq(filesA, files, 'conversationFilesAsync: the same result as conversationFiles');
  eq(skippedA, skipped, 'conversationFilesAsync: the same skips and reasons');
  eq(await C.conversationFilesAsync(slug, '11111111-2222-3333-4444-555555555555'), [], 'conversationFilesAsync: nothing there');
  let badA = null;
  try { await C.conversationFilesAsync(slug, '../x'); } catch (e) { badA = e; }
  ok(badA instanceof S.SyncError, 'conversationFilesAsync: a bad id rejects');

  // ---------- lastMeta ----------
  const L = (o) => JSON.stringify(o) + '\n';
  const log = path.join(slug, `${ID}.jsonl`);
  fs.writeFileSync(log, L({ type: 'custom-title', customTitle: 'Old name' }) + L({ type: 'user', cwd: 'C:\\a', gitBranch: 'one' })
    + L({ type: 'custom-title', customTitle: 'New name' }) + L({ type: 'ai-title', aiTitle: 'AI' }) + L({ type: 'assistant', cwd: 'C:\\b', gitBranch: 'two' })
    + L({ type: 'system', cwd: 'C:\\c', gitBranch: 'HEAD' }) + '{"type":"user","cwd":"C:\\\\half');
  eq(C.lastMeta(log), { cwd: 'C:\\c', branch: null, title: 'New name' }, 'lastMeta: the last of each; HEAD is no branch; a cut last line ignored');
  const pad = L({ type: 'assistant', message: { content: 'x'.repeat(1000) } }).repeat(300); // ~300 KB with no cwd
  fs.writeFileSync(log, L({ type: 'summary', summary: 'Sum' }) + L({ type: 'user', cwd: '/far/back', gitBranch: 'main' }) + pad);
  eq(C.lastMeta(log), { cwd: '/far/back', branch: 'main', title: 'Sum' }, 'lastMeta: grows past a long tail; summary as the title');
  eq(C.lastMeta(log, { cap: 128 * 1024 }), { cwd: null, branch: null, title: 't' }, 'lastMeta: stops at the cap (the title from custom-title.json)');
  fs.writeFileSync(log, L({ type: 'user', cwd: '/x' }));
  eq(C.lastMeta(log), { cwd: '/x', branch: null, title: 't' }, 'lastMeta: title from custom-title.json');
  eq(C.lastMeta(path.join(T, 'missing.jsonl')), { cwd: null, branch: null, title: null }, 'lastMeta: no file');

  // ---------- homeCwd ----------
  const hlog = (cwd) => path.join(T, 'hc', C.slugOf(cwd), `${ID}.jsonl`);
  const hwt = 'C:\\r\\.claude\\worktrees\\x';
  write(hlog('C:\\r'), L({ type: 'summary', summary: 's' }) + L({ type: 'user', cwd: 'C:\\r' }) + L({ type: 'user', cwd: hwt }));
  eq(C.homeCwd(hlog('C:\\r'), hwt), 'C:\\r', 'homeCwd: started in the root, moved into a worktree: the root (the first cwd)');
  eq(C.homeCwd(hlog('C:\\r'), 'C:\\r'), 'C:\\r', 'homeCwd: the last cwd when it fits');
  if (P.isWin) eq(C.homeCwd(hlog('C:\\r'), 'c:\\R'), 'c:\\R', 'homeCwd: case does not matter on Windows');
  write(hlog('C:\\other'), L({ type: 'user', cwd: 'C:\\r' }) + L({ type: 'user', cwd: hwt }));
  eq(C.homeCwd(hlog('C:\\other'), hwt), null, 'homeCwd: neither the first nor the last cwd fits: null');
  write(hlog('/far'), pad + L({ type: 'user', cwd: '/far' }) + L({ type: 'user', cwd: '/far/x' }));
  eq(C.homeCwd(hlog('/far'), '/far/x'), '/far', 'homeCwd: grows past a long head');
  eq(C.homeCwd(hlog('/far'), '/far/x', { cap: 128 * 1024 }), null, 'homeCwd: stops at the cap');
  const longCwd = `C:\\${'d'.repeat(250)}`;
  const cutLog = path.join(T, 'hc', `${C.slugOf(longCwd).slice(0, 200)}-1a2b3c`, `${ID}.jsonl`); // Claude Code's cut + hash
  write(cutLog, L({ type: 'user', cwd: longCwd }));
  eq(C.homeCwd(cutLog, longCwd), longCwd, 'homeCwd: a long slug by its first 200 characters');
  eq(C.homeCwd(path.join(T, 'hc', 'none', `${ID}.jsonl`), 'C:\\none'), null, 'homeCwd: no file, and the last cwd does not fit');

  // ---------- readState / writeState ----------
  const sf = path.join(T, 'data', 'sync', 'x-state.json');
  eq(C.readState(sf, { none: 1 }), { none: 1 }, 'readState: missing gives the fallback');
  C.writeState(sf, { a: [1, 2], b: 'c' });
  eq(C.readState(sf), { a: [1, 2], b: 'c' }, 'writeState then readState');
  C.writeState(sf, { a: 2 });
  eq(C.readState(sf), { a: 2 }, 'writeState: replaces');
  eq(fs.readdirSync(path.dirname(sf)), ['x-state.json'], 'writeState: no temp file left');
  if (!P.isWin) eq(fs.statSync(sf).mode & 0o777, 0o600, 'writeState: mode 0600');
  fs.writeFileSync(sf, '{not json');
  eq(C.readState(sf, 7), 7, 'readState: bad JSON gives the fallback');

  // ---------- ensureDevice / touchDevice ----------
  const rows = new Map();
  const calls = [];
  let down = false, n = 0;
  const api = {
    async rest(method, table, o = {}) {
      calls.push({ method, table, ...o });
      if (down) throw new S.SyncError('Supabase could not be reached', 0, 'network');
      if (table !== 'devices') throw new Error('wrong table');
      if (method === 'GET' && o.query.name) {
        const val = (v) => String(v).replace(/^eq\./, '').replace(/^"(.*)"$/s, '$1');
        return [...rows.values()].filter((r) => r.name === val(o.query.name) && r.platform === val(o.query.platform)).map((r) => ({ ...r }));
      }
      if (method === 'GET') { const id = String(o.query.id).replace(/^eq\./, ''); return rows.has(id) ? [{ id }] : []; }
      if (method === 'POST') {
        const id = `aaaaaaaa-0000-4000-8000-${String(++n).padStart(12, '0')}`;
        rows.set(id, { id, ...o.body });
        return o.prefer === 'return=representation' ? [rows.get(id)] : null;
      }
      if (method === 'PATCH') { const id = String(o.query.id).replace(/^eq\./, ''); if (rows.has(id)) Object.assign(rows.get(id), o.body); return null; }
      throw new Error('wrong method');
    },
  };
  const dataDir = path.join(T, 'data');
  const d1 = await C.ensureDevice(api, dataDir);
  ok(rows.has(d1) && rows.get(d1).name === os.hostname() && rows.get(d1).platform === process.platform, 'ensureDevice: a new row, hostname and platform');
  eq(C.readState(path.join(dataDir, 'sync', 'device.json')), { id: d1 }, 'ensureDevice: saved in sync/device.json');
  ok(same(C.devicePath(dataDir), path.join(dataDir, 'sync', 'device.json')), 'devicePath');
  calls.length = 0;
  eq(await C.ensureDevice(api, dataDir), d1, 'ensureDevice: the same id again');
  eq(calls.length, 0, 'ensureDevice: checked once per process');
  // a second "process" (another data dir pointing at the same row) checks it still exists
  const dataDir2 = path.join(T, 'data2');
  C.writeState(path.join(dataDir2, 'sync', 'device.json'), { id: d1 });
  eq(await C.ensureDevice(api, dataDir2), d1, 'ensureDevice: a saved id whose row is there');
  eq(calls.map((c) => c.method), ['GET'], 'ensureDevice: one GET, no insert');
  const dataDir3 = path.join(T, 'data3');
  C.writeState(path.join(dataDir3, 'sync', 'device.json'), { id: 'bbbbbbbb-0000-4000-8000-000000000000' });
  down = true;
  await rejects(C.ensureDevice(api, dataDir3), 'ensureDevice: Supabase down throws');
  eq(C.readState(path.join(dataDir3, 'sync', 'device.json')).id, 'bbbbbbbb-0000-4000-8000-000000000000', 'ensureDevice: nothing changed on a failure');
  down = false;
  const rename = () => { for (const r of rows.values()) r.name = 'another-pc'; }; // no row has this machine's name
  rename();
  const d3 = await C.ensureDevice(api, dataDir3);
  ok(d3 !== 'bbbbbbbb-0000-4000-8000-000000000000' && rows.has(d3), 'ensureDevice: a row that is gone gets a new one');
  eq(C.readState(path.join(dataDir3, 'sync', 'device.json')), { id: d3 }, 'ensureDevice: the new id saved');
  // the uploader, the materializer and the mover ask at once on a first start: one row, one id for all three
  calls.length = 0;
  rename();
  const dataDir4 = path.join(T, 'data4');
  const at4 = await Promise.all([C.ensureDevice(api, dataDir4), C.ensureDevice(api, dataDir4), C.ensureDevice(api, dataDir4)]);
  ok(at4.every((d) => d === at4[0]) && rows.has(at4[0]), 'ensureDevice: three at once share one id');
  eq(calls.filter((c) => c.method === 'POST').length, 1, 'ensureDevice: three at once make one row');
  eq(C.readState(path.join(dataDir4, 'sync', 'device.json')), { id: at4[0] }, 'ensureDevice: that id saved');
  // once known, the id stays in memory: a device.json gone or unreadable later changes nothing
  calls.length = 0;
  fs.rmSync(path.join(dataDir, 'sync', 'device.json'));
  eq(await C.ensureDevice(api, dataDir), d1, 'ensureDevice: kept in memory once known (device.json gone since)');
  eq(calls.length, 0, 'ensureDevice: kept in memory, nothing asked');
  C.writeState(path.join(dataDir, 'sync', 'device.json'), { id: d1 });
  // a device.json that could not be read (here a folder in its place: EISDIR) throws and makes no row
  const dataDir5 = path.join(T, 'data5');
  fs.mkdirSync(path.join(dataDir5, 'sync', 'device.json'), { recursive: true });
  let e5 = null;
  try { await C.ensureDevice(api, dataDir5); } catch (e) { e5 = e; }
  ok(e5 && e5.code === 'device_unreadable' && !calls.length, `ensureDevice: an unreadable device.json throws, nothing asked or made (${e5 && e5.message})`);
  // gone: this machine's row by name and platform is adopted, the newest seen; saved
  rename();
  const old = 'aaaaaaaa-0000-4000-8000-0000000000a1', newer = 'aaaaaaaa-0000-4000-8000-0000000000a2', mac = 'aaaaaaaa-0000-4000-8000-0000000000a3';
  rows.set(old, { id: old, name: os.hostname(), platform: process.platform, last_seen_at: '2026-10-01T00:00:00Z', created_at: '2026-09-01T00:00:00Z' });
  rows.set(newer, { id: newer, name: os.hostname(), platform: process.platform, last_seen_at: '2026-10-12T00:00:00Z', created_at: '2026-09-02T00:00:00Z' });
  rows.set(mac, { id: mac, name: os.hostname(), platform: process.platform === 'darwin' ? 'win32' : 'darwin', last_seen_at: '2026-10-13T00:00:00Z' });
  const dataDir6 = path.join(T, 'data6');
  eq(await C.ensureDevice(api, dataDir6), newer, 'ensureDevice: no device.json: this machine\'s row by name and platform (the newest seen) is adopted');
  ok(!calls.some((c) => c.method === 'POST'), 'ensureDevice: adopted, no row made');
  eq(C.readState(path.join(dataDir6, 'sync', 'device.json')), { id: newer }, 'ensureDevice: the adopted id saved');
  // damaged (cut short by a crash): adopted the same way, never a new row
  calls.length = 0;
  const dataDir7 = path.join(T, 'data7');
  write(path.join(dataDir7, 'sync', 'device.json'), '{"id": "aaaa');
  eq(await C.ensureDevice(api, dataDir7), newer, 'ensureDevice: a damaged device.json adopts this machine\'s row');
  ok(!calls.some((c) => c.method === 'POST'), 'ensureDevice: damaged, no row made');
  // damaged and no row with this machine's name: throws, makes nothing, leaves the file
  rename();
  calls.length = 0;
  const dataDir8 = path.join(T, 'data8');
  write(path.join(dataDir8, 'sync', 'device.json'), '');
  let e8 = null;
  try { await C.ensureDevice(api, dataDir8); } catch (e) { e8 = e; }
  ok(e8 && e8.code === 'device_unreadable' && !calls.some((c) => c.method === 'POST'), `ensureDevice: damaged with nothing to adopt throws, no row made (${e8 && e8.message})`);
  eq(fs.readFileSync(path.join(dataDir8, 'sync', 'device.json'), 'utf8'), '', 'ensureDevice: the damaged file is left as it was');
  calls.length = 0;
  const t0 = Date.parse('2026-10-10T12:00:00Z');
  eq(await C.touchDevice(api, d1, { now: t0 }), true, 'touchDevice: first time sent');
  eq(rows.get(d1).last_seen_at, '2026-10-10T12:00:00.000Z', 'touchDevice: last_seen_at set');
  eq(await C.touchDevice(api, d1, { now: t0 + 60e3 }), false, 'touchDevice: a minute later, too soon');
  eq(await C.touchDevice(api, d1, { now: t0 + 60e3, force: true }), true, 'touchDevice: force');
  down = true;
  await rejects(C.touchDevice(api, d1, { now: t0 + 7 * 60e3 }), 'touchDevice: a failure throws');
  down = false;
  eq(await C.touchDevice(api, d1, { now: t0 + 7 * 60e3 + 1 }), true, 'touchDevice: tried again after a failure');
  eq(calls.filter((c) => c.method === 'PATCH').length, 4, 'touchDevice: PATCH count');
  await rejects(C.touchDevice(api, 'nope'), 'touchDevice: a bad id');

  // ---------- isLive ----------
  const sess = path.join(home, '.claude', 'sessions');
  fs.mkdirSync(sess, { recursive: true });
  fs.symlinkSync(sess, path.join(home, '.claude-a', 'sessions'), 'junction');
  const dead = cp.spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid;
  const liveId = '22222222-3333-4444-5555-666666666666', deadId = '33333333-4444-5555-6666-777777777777', otherId = '44444444-5555-6666-7777-888888888888';
  write(path.join(sess, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: liveId.toUpperCase() }));
  write(path.join(sess, `${dead}.json`), JSON.stringify({ pid: dead, sessionId: deadId }));
  write(path.join(sess, 'notes.json'), JSON.stringify({ pid: process.pid, sessionId: deadId }));
  ok(C.isLive(liveId, { home, fresh: true }), 'isLive: a live pid');
  ok(!C.isLive(deadId, { home }), 'isLive: a dead pid, and a file not named <pid>.json, do not count');
  ok(!C.isLive(otherId, { home }), 'isLive: an id with no file');
  write(path.join(home, '.claude-c', 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: otherId }));
  ok(!C.isLive(otherId, { home }), 'isLive: cached for a moment');
  ok(C.isLive(otherId, { home, fresh: true }), 'isLive: any account folder counts');
  ok(!C.isLive('', { home }) && !C.isLive(null, { home }), 'isLive: no id');
  ok(C.pidAlive(process.pid) && !C.pidAlive(0) && !C.pidAlive(-1) && !C.pidAlive('1'), 'pidAlive');

  // ---------- portable or bound ----------
  const DEV = '6a7b8c9d-0e1f-4a2b-9c3d-4e5f6a7b8c9d';
  eq(C.boundOrigin(DEV.toUpperCase()), `bound:${DEV}`, 'boundOrigin: bound:<device id>, lower case');
  throws(() => C.boundOrigin('nope'), 'boundOrigin: not a device id');
  eq([C.boundDeviceOf(`bound:${DEV}`), C.boundDeviceOf(`BOUND:${DEV.toUpperCase()}`), C.boundDeviceOf('bound:x'), C.boundDeviceOf('home:'), C.boundDeviceOf(GH)], [DEV, DEV, null, null, null], 'boundDeviceOf');
  eq(C.rowOrigin(`bound:${DEV.toUpperCase()}`), `bound:${DEV}`, 'rowOrigin: a bound origin, lower case');
  for (const u of [`bound:${DEV}`, `git@bound:${DEV}`, `ssh://x@bound/${DEV}`, `bound:${DEV}.git`]) ok(!String(C.normalizeOrigin(u) || '').startsWith('bound:'), `no remote normalizes to a bound origin: ${u}`);
  // the facts -> the kind and why, in order (sync-work.js inspect()'s rule and texts)
  const wh = path.join(T, 'wk-home'), wkTemp = path.join(T, 'wk-temp');
  const kind = (cwd, f = {}) => { const k = C.workspaceKind({ cwd, git: false, origin: null, perforce: false, home: wh, ...f }); return k && `${k.kind}/${k.why}`; };
  const W = C.BOUND_WHY;
  eq(Object.values(W), ['a placeholder for another machine\'s folder', 'a git checkout with no origin', 'outside the home folder', 'the home folder itself', 'an app data or Claude account folder', 'a Perforce workspace'], 'workspaceKind: the bound why texts');
  eq(kind(path.join(wh, 'code', 'x'), { git: true, origin: GH }), 'portable/null', 'workspaceKind: a checkout with an origin');
  eq(kind(path.join(T, 'far', 'x'), { git: true, origin: GH }), 'portable/null', 'workspaceKind: one outside home too');
  eq(kind(path.join(wh, 'code', 'x'), { git: true, origin: GH, perforce: true }), 'portable/null', 'workspaceKind: a Perforce marker inside a checkout with an origin is git\'s');
  eq(kind(path.join(wh, 'code', 'x'), { git: true }), `bound/${W.noOrigin}`, 'workspaceKind: a checkout with no origin under home is bound (its commits can\'t travel)');
  eq(kind(path.join(T, 'far', 'x'), { git: true }), `bound/${W.noOrigin}`, 'workspaceKind: and outside home');
  eq(kind(path.join(wh, 'code', 'x'), { git: true, origin: C.HOME_ORIGIN }), `bound/${W.noOrigin}`, 'workspaceKind: a pseudo origin is no origin');
  eq(kind(path.join(wh, 'Bots', 'b')), 'portable/null', 'workspaceKind: a folder under home in no checkout');
  eq(kind(wh), `bound/${W.home}`, 'workspaceKind: the home folder itself');
  eq(kind(path.join(wh, 'p4', 'ws'), { perforce: true }), `bound/${W.perforce}`, 'workspaceKind: a Perforce workspace under home');
  eq(kind(path.join(wh, 'Library', 'Caches', 'x')), `bound/${W.app}`, 'workspaceKind: an app data folder under home');
  eq(kind(path.join(wh, 'AppData', 'Local', 'x')), `bound/${W.app}`, 'workspaceKind: AppData under home');
  eq(kind(path.join(wh, '.claude-a')), `bound/${W.app}`, 'workspaceKind: a Claude account\'s folder');
  eq(kind(path.join(T, 'far', 'x')), `bound/${W.outside}`, 'workspaceKind: outside home, no checkout');
  const ph = C.boundPlaceholder(wh, 'BlackBox', 'C:/Perforce/ws');
  eq(kind(ph, { git: true, origin: GH }), `bound/${W.placeholder}`, 'workspaceKind: a placeholder is bound whatever holds it');
  eq(kind(path.join(ph, 'sub')), `bound/${W.placeholder}`, 'workspaceKind: a folder inside a placeholder too');
  eq(kind(P.isWin ? '/Users/henry/x' : 'C:\\x'), null, 'workspaceKind: another platform\'s path: not ours to say');
  eq(kind(''), null, 'workspaceKind: no folder');
  // inTemp: the uploader's throwaway folders
  ok(C.inTemp(path.join(wkTemp, 'x'), { home: wh, temp: [wkTemp] }) && !C.inTemp(path.join(T, 'far'), { home: wh, temp: [wkTemp] }), 'inTemp: a folder in the temp folder, and one outside it');
  ok(!C.inTemp(path.join(wh, 'x'), { home: wh, temp: [T] }), 'inTemp: a temp folder that holds the home folder does not count');
  // a home outside the temp folder: wh is in it (T is made there), and a temp folder holding the home does not count
  const farHome = path.join(path.parse(os.tmpdir()).root, 'sync-common-test-home');
  ok(C.inTemp(path.join(os.tmpdir(), 'x'), { home: farHome }) && C.inTemp(path.join(fs.realpathSync.native(os.tmpdir()), 'x'), { home: farHome }), 'inTemp: the system\'s temp folder by default, as given and its real path');
  // the placeholder: <home>/.fleet-view/bound/<host>/<hash>/<name>
  ok(same(path.dirname(path.dirname(path.dirname(ph))), C.boundBase(wh)) && path.basename(ph) === 'ws' && path.basename(path.dirname(path.dirname(ph))) === 'BlackBox', `boundPlaceholder: under .fleet-view/bound, the host, a hash, the folder's name (${ph})`);
  ok(C.boundPlaceholder(wh, 'BlackBox', 'D:/Perforce/ws') !== ph && path.basename(C.boundPlaceholder(wh, 'BlackBox', 'D:/Perforce/ws')) === 'ws', 'boundPlaceholder: another folder of the same name gets another hash');
  eq(path.basename(C.boundPlaceholder(wh, 'BlackBox', 'C:/')), 'C', 'boundPlaceholder: a drive\'s root is named by its letter');
  eq([path.basename(C.boundPlaceholder(wh, 'x', '/srv/con')), path.basename(path.dirname(path.dirname(C.boundPlaceholder(wh, 'a/b:c..', '/x'))))], ['_con', 'a-b-c'], 'boundPlaceholder: names made safe for a folder');
  eq(path.basename(path.dirname(path.dirname(C.boundPlaceholder(wh, '', '/x')))), 'other-machine', 'boundPlaceholder: no host name');
  ok(C.isBoundPlaceholder(ph, wh) && !C.isBoundPlaceholder(path.dirname(ph), wh) && !C.isBoundPlaceholder(C.boundBase(wh), wh) && !C.isBoundPlaceholder(path.join(wh, 'x'), wh), 'isBoundPlaceholder: the folder and below it only');
  // a bound rel_cwd: this platform's full path with '/', and back
  if (P.isWin) {
    eq(C.boundRel('c:\\Perforce\\ws'), 'C:/Perforce/ws', 'boundRel: a drive, upper case, with /');
    eq(C.boundRel('\\\\srv\\share\\x'), '//srv/share/x', 'boundRel: a share');
    eq([C.boundNative('C:/Perforce/ws'), C.boundNative('//srv/share/x'), C.boundNative('C:/')], ['C:\\Perforce\\ws', '\\\\srv\\share\\x', 'C:\\'], 'boundNative: back to Windows paths');
    eq(C.boundNative('/Users/henry/ws'), null, 'boundNative: a Mac path is not one here');
  } else {
    eq(C.boundRel('/Users/henry/ws'), '/Users/henry/ws', 'boundRel: a full path as it is');
    eq([C.boundNative('/Users/henry/ws'), C.boundNative('/Users/henry/ws/')], ['/Users/henry/ws', '/Users/henry/ws'], 'boundNative: back to a path here');
    eq([C.boundNative('C:/Perforce/ws'), C.boundNative('//srv/share/x')], [null, null], 'boundNative: a Windows path is not one here');
  }
  for (const r of ['', 'x/y', '/a/../b', '/a/./b', '/a//b', '/a\u0001b', `/${'x'.repeat(1100)}`, null]) eq(C.boundNative(r), null, `boundNative: refused: ${JSON.stringify(r).slice(0, 40)}`);
  eq(C.boundRel('relative/x'), null, 'boundRel: not a full path');
  eq(['C:/Perforce/ws', '//srv/share/x', '/Users/henry/ws', 'C:/', 'x/y', '/a/../b', 'C:', 'C:/a<b', ''].map(C.boundRelOk), [true, true, true, true, false, false, false, false, false], 'boundRelOk: a full path on either platform, nothing else');
  // perforceAt: a P4CONFIG file above, P4V's Perforce folder under home, nothing
  const p4root = path.join(T, 'p4ws'), p4sub = path.join(p4root, 'a', 'b');
  fs.mkdirSync(p4sub, { recursive: true });
  ok(!C.perforceAt(p4sub, { home: wh }), 'perforceAt: no marker');
  write(path.join(p4root, 'p4config.txt'), 'P4CLIENT=x\n');
  const p4b = path.join(T, 'p4ws2', 'a');
  fs.mkdirSync(p4b, { recursive: true });
  write(path.join(T, 'p4ws2', '.p4config'), 'P4CLIENT=x\n');
  ok(same(C.perforceAt(p4b, { home: wh }), path.join(T, 'p4ws2')), 'perforceAt: a .p4config above the folder');
  ok(same(C.perforceAt(path.join(T, 'p4ws2', 'a', 'gone', 'deeper'), { home: wh }), path.join(T, 'p4ws2')), 'perforceAt: a folder that is gone counts by the one above it');
  ok(same(C.perforceAt(path.join(wh, 'Perforce', 'henry-ws', 'game'), { home: wh }), path.join(wh, 'Perforce')), 'perforceAt: P4V\'s Perforce folder under home');
  ok(!C.perforceAt(path.join(wh, 'Perforce'), { home: wh }), 'perforceAt: the Perforce folder itself is no workspace');
  const p4c = path.join(T, 'p4client', 'proj');
  fs.mkdirSync(p4c, { recursive: true });
  ok(same(C.perforceAt(p4c, { home: wh, roots: [path.join(T, 'p4client')] }), path.join(T, 'p4client')) && !C.perforceAt(path.join(T, 'p4other'), { home: wh, roots: [path.join(T, 'p4client')] }), 'perforceAt: inside the client root p4 gives, and not outside it');
  write(path.join(T, 'p4ignore-ws', '.p4ignore'), 'node_modules\n');
  ok(same(C.perforceAt(path.join(T, 'p4ignore-ws'), { home: wh }), path.join(T, 'p4ignore-ws')), 'perforceAt: a .p4ignore file');
  ok(Array.isArray(await C.p4ClientRoots()) && Array.isArray(C.p4RootsNow()), 'p4ClientRoots: a list (none without p4)');
  // classifyFolder: the facts from git
  const cRepo = path.join(T, 'cl-repo'), cHome = path.join(T, 'cl-home'), cLocal = path.join(cHome, 'local'), cBot = path.join(cHome, 'Bots', 'b');
  const cP4 = path.join(cHome, 'depot', 'ws', 'src');
  fs.mkdirSync(cRepo, { recursive: true });
  fs.mkdirSync(cLocal, { recursive: true });
  fs.mkdirSync(cBot, { recursive: true });
  fs.mkdirSync(cP4, { recursive: true });
  write(path.join(cHome, 'depot', 'ws', '.p4config'), 'P4CLIENT=x\n');
  cp.execFileSync('git', ['init', '-q'], { cwd: cRepo });
  cp.execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/Test/Cl.git'], { cwd: cRepo });
  cp.execFileSync('git', ['init', '-q'], { cwd: cLocal });
  const cl = async (p) => { const k = await C.classifyFolder(p, { home: cHome, p4Roots: [] }); return k && { kind: k.kind, why: k.why, git: k.git, origin: k.origin }; };
  eq(await cl(cRepo), { kind: 'portable', why: null, git: true, origin: 'https://github.com/test/cl' }, 'classifyFolder: a checkout with an origin');
  eq(await cl(path.join(cRepo, 'gone', 'x')), { kind: 'portable', why: null, git: true, origin: 'https://github.com/test/cl' }, 'classifyFolder: a gone folder inside it');
  eq(await cl(cLocal), { kind: 'bound', why: W.noOrigin, git: true, origin: null }, 'classifyFolder: a repo with no origin under home is bound');
  eq(await cl(cBot), { kind: 'portable', why: null, git: false, origin: null }, 'classifyFolder: a folder under home in no checkout');
  eq(await cl(path.join(cHome, 'Bots', 'gone')), { kind: 'portable', why: null, git: false, origin: null }, 'classifyFolder: one that is gone too');
  eq(await cl(cP4), { kind: 'bound', why: W.perforce, git: false, origin: null }, 'classifyFolder: under a P4CONFIG file');
  eq(await cl(cHome), { kind: 'bound', why: W.home, git: false, origin: null }, 'classifyFolder: the home folder itself');
  eq(await cl(path.join(T, 'nowhere')), { kind: 'bound', why: W.outside, git: false, origin: null }, 'classifyFolder: outside home');
  const cBroken = path.join(cHome, 'broken', 'sub');
  fs.mkdirSync(cBroken, { recursive: true });
  fs.writeFileSync(path.join(cHome, 'broken', '.git'), `gitdir: ${path.join(T, 'no-such-gitdir')}`);
  eq(await C.classifyFolder(cBroken, { home: cHome, p4Roots: [] }), null, 'classifyFolder: under a .git git could not read: null (wait)');
  ok(await C.gitUnreadAt(path.join(cBroken, 'gone')) && !(await C.gitUnreadAt(cBot)) && !(await C.gitUnreadAt(cBroken, path.join(cHome, 'broken', 'sub'))), 'gitUnreadAt: from the folder still there, up to stop');
  eq(await C.classifyFolder(P.isWin ? '/Users/x' : 'C:\\x', { home: cHome }), null, 'classifyFolder: another platform\'s path: null');
  // checkoutAt: the same facts from disk, no git process
  const co = (p) => { const r = C.checkoutAt(p); return r && { top: path.basename(r.top), origin: r.origin }; };
  eq(co(path.join(cRepo, 'gone', 'x')), { top: 'cl-repo', origin: 'https://github.com/test/cl' }, 'checkoutAt: a checkout with an origin, from a folder that is gone inside it');
  eq(co(cLocal), { top: 'local', origin: null }, 'checkoutAt: a checkout with no origin');
  eq(co(cBot), null, 'checkoutAt: no checkout');
  // a linked worktree's .git file, and its commondir back to the main checkout's config
  const wtDir = path.join(T, 'cl-wt'), wtGit = path.join(cRepo, '.git', 'worktrees', 'cl-wt');
  write(path.join(wtGit, 'commondir'), '../..\n');
  write(path.join(wtDir, '.git'), `gitdir: ${wtGit}\n`);
  eq(co(wtDir), { top: 'cl-wt', origin: 'https://github.com/test/cl' }, 'checkoutAt: a worktree reads its main checkout\'s origin');
  eq(C.checkoutAt(P.isWin ? '/Users/x' : 'C:\\x'), null, 'checkoutAt: another platform\'s path');
}

main().catch((e) => { failures++; console.log(`FAIL threw: ${e && e.stack}`); }).finally(() => {
  if (process.env.SYNC_TEST_KEEP !== '1') { try { fs.rmSync(T, { recursive: true, force: true }); } catch {} } else console.log(`kept ${T}`);
  console.log(`${passes} passed, ${failures} failed`);
  process.exitCode = failures ? 1 : 0;
});
