// Clone workspace to this machine: a test of clone-workspace.js, run with the system node:
//   node scripts/clone-workspace-test.js
// A temp folder stands in for everything: a git checkout of https://github.com/glodusk/proj (its origin set by hand,
// nothing fetched), a projects folder holding this machine's synced copies of 25 of another computer's conversations
// (cwd the other computer's paths, a side folder with a subagent and a tool result, one laid down for a worktree), and
// stubs for the carry (snapshots of the work), the unpack and sync-clone.js's cloner. Checked: the newest 20 are copied
// (the cap, said in a note) as new conversations: new ids, every record's sessionId and session_id the new id, every cwd
// the folder it resumes in, the slug folder of that folder, the side folder copied (subagent lines rewritten, the rest
// byte for byte), the original's modified time, the title kept; the originals and their side folders untouched; a
// worktree's chat resumes in that worktree; one piece of work in two chats' snapshots is laid down once and both
// copies resume there; an empty snapshot is skipped; chats with no snapshot and env files are notes; no carry is a
// note; a second clone copies nothing new; an existing checkout is reused (never cloned, its uncommitted change left
// as it is), by folder or by origin; with no checkout the cloner clones it and the job waits for the chats to come
// down; a second start while one runs gives the same job; bad input is refused; a cut last line is left out. Exit 0 =
// all pass. SYNC_TEST_KEEP=1 keeps the temp folder.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const W = require(path.join(ROOT, 'clone-workspace.js'));
const C = require(path.join(ROOT, 'sync-common.js'));
const P = require(path.join(ROOT, 'platform.js'));

const T = fs.realpathSync(fs.mkdtempSync(path.join(process.env.SYNC_TEST_DIR || os.tmpdir(), 'clone-workspace-test-')));
let failures = 0, passes = 0;
const ok = (cond, what) => { if (cond) passes++; else { failures++; console.log(`FAIL ${what}`); } };
const eq = (a, b, what) => ok(JSON.stringify(a) === JSON.stringify(b), `${what}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
const write = (f, data) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); };
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const same = (a, b) => P.foldCase(path.resolve(a)) === P.foldCase(path.resolve(b));
const g = (cwd, ...args) => cp.execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const lines = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
// every file under a folder -> { rel: sha256 }
function tree(dir) {
  const out = {};
  const walk = (d, rel) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) walk(path.join(d, e.name), r); else out[r] = sha(path.join(d, e.name)); } };
  if (fs.existsSync(dir)) walk(dir, '');
  return out;
}

const ORIGIN = 'https://github.com/glodusk/proj';
const OTHER = crypto.randomUUID(); // the other computer's sync device id
function checkout(dir) {
  fs.mkdirSync(dir, { recursive: true });
  g(dir, 'init', '-q');
  write(path.join(dir, 'README.md'), 'hello\n');
  g(dir, 'add', '-A');
  g(dir, 'commit', '-q', '-m', 'first');
  g(dir, 'remote', 'add', 'origin', `${ORIGIN}.git`);
  return dir;
}
// one synced copy of the other computer's conversation, in slug folder of `folder` (this machine's), its records' cwd
// the other computer's
function syncedChat(projects, folder, remoteCwd, i, o = {}) {
  const id = crypto.randomUUID();
  const dir = path.join(projects, C.slugOf(folder));
  const t0 = Date.parse('2026-10-01T00:00:00Z') + i * 60e3;
  const recs = [
    { type: 'custom-title', customTitle: `chat ${i}`, sessionId: id },
    { parentUuid: null, type: 'user', uuid: crypto.randomUUID(), timestamp: new Date(t0).toISOString(), cwd: remoteCwd, sessionId: id, session_id: id, message: { role: 'user', content: `do thing ${i} (see ${id})` } },
    { parentUuid: 'x', type: 'assistant', uuid: crypto.randomUUID(), timestamp: new Date(t0 + 1000).toISOString(), cwd: remoteCwd, sessionId: id, message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
  ];
  const file = path.join(dir, `${id}.jsonl`);
  write(file, recs.map((r) => JSON.stringify(r)).join('\n') + '\n' + (o.cut ? '{"type":"user","cwd":"/x","sessio' : ''));
  if (o.side) {
    write(path.join(dir, id, 'subagents', 'agent-a1.jsonl'), JSON.stringify({ isSidechain: true, agentId: 'a1', sessionId: id, cwd: remoteCwd, type: 'user' }) + '\n');
    write(path.join(dir, id, 'subagents', 'agent-a1.meta.json'), '{"agentType":"general-purpose","description":"x"}');
    write(path.join(dir, id, 'tool-results', 'r1.txt'), `big output of ${id}\n`);
  }
  const when = new Date(t0 + 5000);
  fs.utimesSync(file, when, when);
  return { id, file, account: 'B', name: `chat ${i}`, renamed: i === 24, last: t0, device: OTHER, deviceName: 'BlackBox' };
}

async function main() {
  // ---------- rewriteLog on its own ----------
  const A = crypto.randomUUID(), B = crypto.randomUUID();
  const txt = `${JSON.stringify({ type: 'x', sessionId: A, cwd: '/a' })}\r\n${JSON.stringify({ type: 'y', session_id: A.toUpperCase(), other: 'z' })}\nnot json ${A}\n{"cut":`;
  const rw = W.rewriteLog(txt, A, B, 'C:\\here');
  const rl = rw.split('\n');
  eq(JSON.parse(rl[0].replace(/\r$/, '')), { type: 'x', sessionId: B, cwd: 'C:\\here' }, 'rewriteLog: sessionId and cwd');
  ok(rl[0].endsWith('\r'), 'rewriteLog: a CRLF line keeps its CR');
  eq(JSON.parse(rl[1]).session_id, B, 'rewriteLog: session_id (any case)');
  eq(rl[2], `not json ${A}`, 'rewriteLog: a line that is no record stays as it is');
  ok(!rw.includes('{"cut":'), 'rewriteLog: a cut last line is left out');

  // ---------- the workspace ----------
  const root = checkout(path.join(T, 'code', 'proj'));
  write(path.join(root, 'wip.txt'), 'uncommitted\n'); // a change of Henry's here: never touched
  g(root, 'add', 'wip.txt');
  const wt1 = path.join(root, '.claude', 'worktrees', 'wt1');
  fs.mkdirSync(wt1, { recursive: true });
  const projects = path.join(T, 'home', '.claude', 'projects');
  const chats = [];
  for (let i = 0; i < 25; i++) {
    const inWt = i === 23;
    chats.push(syncedChat(projects, inWt ? wt1 : root, inWt ? '/Users/henry/code/proj/.claude/worktrees/wt1' : '/Users/henry/code/proj', i, { side: i === 24 || i === 22, cut: i === 21 }));
  }
  const before = tree(projects);

  // the carry: chats 24 and 22 left the same work; 20 an empty snapshot; the rest none
  const workDir = path.join(root, '.claude', 'worktrees', 'feat-wt');
  const manifest = { v: 1, kind: 'git', origin: ORIGIN, branch: 'feat', head: 'a'.repeat(40), base: null, bundle: 'b'.repeat(64), bundleRef: 'refs/heads/feat', staged: null, unstaged: 'c'.repeat(64), untracked: [], env: ['.env.local'], rel: '', worktree: 'feat-wt', summary: { commits: 2, files: 1, bytes: 10 }, notes: [] };
  const snapOf = { [chats[24].id]: { pack: '1'.repeat(16), record: 'd'.repeat(64), at: new Date().toISOString(), summary: manifest.summary, kind: 'snapshot', by: OTHER },
    [chats[22].id]: { pack: '2'.repeat(16), record: 'e'.repeat(64), at: new Date(Date.now() - 60e3).toISOString(), summary: manifest.summary, kind: 'snapshot', by: OTHER },
    [chats[20].id]: { pack: '3'.repeat(16), record: 'f'.repeat(64), at: new Date().toISOString(), summary: { commits: 0, files: 0, bytes: 0 }, kind: 'snapshot', by: OTHER } };
  const fetched = [], unpacked = [], trusted = [], renamed = [], asked = [];
  const carry = {
    async newestSnapshot(id, by) { asked.push([id, by]); await new Promise((r) => setTimeout(r, 5)); return snapOf[id] || null; },
    async fetchPack(id, ref) { fetched.push(id); return { manifest: { ...manifest }, blobs: new Map([['x', Buffer.from(ref.pack)]]) }; },
  };
  const unpack = async (m, blobs, o) => { unpacked.push(o.root); fs.mkdirSync(workDir, { recursive: true }); return { cwd: workDir, into: workDir, branch: m.branch, notes: ['made a worktree'] }; };
  const clonerCalls = [];
  const noCloner = { clone: async (x) => { clonerCalls.push(x); throw new Error('must not clone'); }, job: () => null };
  const dataDir = path.join(T, 'data');
  const make = (o = {}) => W.createWorkspaceCloner({
    dataDir, cloner: noCloner, roots: () => [root], chats: (r) => (same(r, root) ? chats : []), carry: () => carry, unpack,
    online: () => false, trust: (cwd, account) => trusted.push([cwd, account]), rename: (id, name) => renamed.push([id, name]), pollMs: 20, ...o,
  });
  const wc = make();

  let threw = null;
  try { await wc.start('nonsense'); } catch (e) { threw = e; }
  ok(threw && threw.code === 'bad_request', 'start: a repo that is neither a folder nor an origin is refused');
  threw = null;
  fs.mkdirSync(path.join(T, 'plain'), { recursive: true });
  try { await wc.start(path.join(T, 'plain')); } catch (e) { threw = e; }
  ok(threw && threw.code === 'bad_request' && /not a git checkout/.test(threw.message), 'start: a folder that is no checkout is refused');

  const j0 = await wc.start(root);
  const j0b = await wc.start(ORIGIN);
  eq(j0b.id, j0.id, 'a second start while one runs gives the same job (by origin too)');
  await wc.idle();
  const j = wc.job(j0.id);
  eq([j.done, j.phase, j.checkout.state], [true, 'done', 'here'], 'the job: done, with the checkout here');
  ok(same(j.repo.root, root) && j.repo.origin === ORIGIN, 'the job names the checkout and its origin');
  eq([j.chats.total, j.chats.picked, j.chats.copied.length, j.chats.already, j.chats.failed.length], [25, 20, 20, 0, 0], 'the newest 20 of 25 are copied');
  ok(j.notes.some((t) => /newest 20 of its 25/.test(t)), 'a note says how many were copied of how many');
  const pickedIds = new Set(chats.slice(5).map((c) => c.id));
  ok(j.chats.copied.every((x) => pickedIds.has(x.from)), 'the ones copied are the newest');
  eq(clonerCalls.length, 0, 'an existing checkout is reused: nothing cloned');
  eq(g(root, 'status', '--porcelain'), 'A  wip.txt', 'the checkout is left as it was (its uncommitted change too)');
  const after = tree(projects);
  eq(Object.fromEntries(Object.keys(before).map((k) => [k, after[k]])), before, 'the originals and their side folders are untouched');

  // the work
  eq(unpacked.length, 1, 'one piece of work in two snapshots is laid down once');
  ok(same(unpacked[0], root), 'it goes into this machine\'s checkout of the repo');
  ok(!fetched.includes(chats[20].id), 'an empty snapshot is not downloaded');
  ok(asked.every(([, by]) => by === OTHER.toLowerCase()), 'snapshots are asked for by the device that owns the chat');
  eq(j.work.filter((w) => w.state === 'done').length, 1, 'one work line');
  ok(/2 commits, 1 file on feat/.test(j.work[0].message), `the work line says what came: ${j.work[0].message}`);
  ok(j.notes.some((t) => /17 chats left no snapshot of its work: anything unpushed in them stays on BlackBox/.test(t)), 'chats with no snapshot are a note');
  ok(j.notes.some((t) => /env files not copied.*\.env\.local/.test(t)), 'env files are a note');
  ok(j.notes.some((t) => /BlackBox is offline/.test(t)), 'the other computer offline is a note');

  // the copies
  const reg = C.readState(path.join(dataDir, 'sync', 'workspace-clones.json'), null);
  eq(Object.keys(reg.copies).length, 20, 'every copy is remembered');
  for (const x of j.chats.copied) {
    const src = chats.find((c) => c.id === x.from);
    const want = x.from === chats[24].id || x.from === chats[22].id ? workDir : x.from === chats[23].id ? wt1 : root;
    ok(same(x.cwd, want), `${src.name}: resumes in ${x.cwd}, want ${want}`);
    const file = path.join(projects, C.slugOf(x.cwd), `${x.id}.jsonl`);
    ok(fs.existsSync(file), `${src.name}: the copy is in the slug folder of the folder it resumes in`);
    ok(x.id !== x.from && /^[0-9a-f-]{36}$/.test(x.id), `${src.name}: a new id`);
    const recs = lines(file);
    ok(recs.every((r) => r.sessionId === undefined || r.sessionId === x.id), `${src.name}: every sessionId is the new id`);
    ok(recs.every((r) => r.session_id === undefined || r.session_id === x.id), `${src.name}: every session_id is the new id`);
    ok(recs.filter((r) => 'cwd' in r).every((r) => same(r.cwd, x.cwd)), `${src.name}: every cwd is the folder it resumes in`);
    eq(recs[0].customTitle, src.name, `${src.name}: its title is kept`);
    ok(recs[1].message.content.includes(src.id), `${src.name}: message text is never rewritten`);
    ok(Math.abs(fs.statSync(file).mtimeMs - fs.statSync(src.file).mtimeMs) < 2000, `${src.name}: the original's modified time`);
    ok(!fs.existsSync(`${file}.part`), `${src.name}: no .part left`);
    if (x.from === chats[21].id) eq(recs.length, 3, 'a cut last line is left out of the copy');
    if (x.from === chats[24].id) {
      const side = path.join(path.dirname(file), x.id);
      const sub = lines(path.join(side, 'subagents', 'agent-a1.jsonl'));
      ok(sub[0].sessionId === x.id && same(sub[0].cwd, x.cwd), 'side folder: the subagent\'s lines are rewritten');
      eq(fs.readFileSync(path.join(side, 'subagents', 'agent-a1.meta.json'), 'utf8'), '{"agentType":"general-purpose","description":"x"}', 'side folder: the meta file byte for byte');
      eq(fs.readFileSync(path.join(side, 'tool-results', 'r1.txt'), 'utf8'), `big output of ${src.id}\n`, 'side folder: a tool result byte for byte');
    }
  }
  eq(trusted.length, 20, 'each copy\'s folder is trusted');
  eq(renamed.map(([id, name]) => [j.chats.copied.find((x) => x.id === id).from, name]), [[chats[24].id, 'chat 24']], 'a Fleet View name of the original goes to its copy');

  // again: nothing new to copy
  const j2 = await wc.start(root);
  await wc.idle();
  const k2 = wc.job(j2.id);
  eq([k2.chats.copied.length, k2.chats.already], [0, 20], 'a second clone copies nothing new');
  eq(wc.forRepo(root).id, k2.id, 'forRepo: the newest job of the workspace');
  eq(wc.forRepo(ORIGIN).id, k2.id, 'forRepo: by origin too');

  // by origin, with a checkout listed: reused
  const wc3 = make({ dataDir: path.join(T, 'data3') });
  const k3 = await wc3.start(ORIGIN);
  await wc3.idle();
  eq([k3.checkout.state, same(k3.repo.root, root)], ['here', true], 'by origin: the listed checkout is reused');

  // no carry: a note, the chats still copied
  const nc = make({ dataDir: path.join(T, 'data4'), carry: () => null });
  const k4 = await nc.start(root);
  await nc.idle();
  const k4j = nc.job(k4.id);
  ok(k4j.notes.some((t) => /unpushed work on BlackBox not copied: sync is not running here/.test(t)) && k4j.chats.copied.length === 20, 'no carry: a note, and the chats are copied');

  // no checkout here: the cloner clones it, the job waits for the chats to come down
  const root2 = checkout(path.join(T, 'code2', 'proj'));
  const later = [];
  let rescans = 0;
  const cloner = {
    calls: [],
    async clone(origins) { this.calls.push(origins); return { ok: true, job: { id: 'j1' } }; },
    job(id) { return id === 'j1' ? { id, done: true, items: [{ origin: ORIGIN, state: 'done', dir: root2, message: `cloned to ${root2}` }] } : null; },
  };
  const projects2 = path.join(T, 'home2', '.claude', 'projects');
  const wc5 = make({
    dataDir: path.join(T, 'data5'), cloner, roots: () => [], waitMs: 3000,
    chats: (r) => (same(r, root2) ? later : []),
    rescan: () => { rescans++; setTimeout(() => later.push(syncedChat(projects2, root2, '/Users/henry/code/proj', 1)), 100); },
  });
  const k5 = await wc5.start(ORIGIN);
  eq(k5.checkout.state, 'cloning', 'no checkout: the job starts by cloning');
  await wc5.idle();
  const k5j = wc5.job(k5.id);
  eq([cloner.calls, k5j.checkout.state, same(k5j.repo.root, root2), rescans, k5j.chats.copied.length], [[[ORIGIN]], 'cloned', true, 1, 1], 'cloned, rescanned, its chat waited for and copied');

  // a clone that fails: the job fails with its message
  const wc6 = make({ dataDir: path.join(T, 'data6'), roots: () => [], cloner: { async clone() { return { ok: true, job: { id: 'j2' } }; }, job: (id) => ({ id, done: true, items: [{ origin: ORIGIN, state: 'failed', message: 'Sign in to GitHub on this machine: gh auth login' }] }) } });
  const k6 = await wc6.start(ORIGIN);
  await wc6.idle();
  const k6j = wc6.job(k6.id);
  eq([k6j.phase, k6j.checkout.state, k6j.message], ['failed', 'failed', 'Sign in to GitHub on this machine: gh auth login'], 'a failed clone fails the job with its message');

  // folderFor: a slug folder of neither the top nor a worktree here -> the checkout's top
  ok(same(W.folderFor({ file: path.join(projects, 'Some-other-slug', 'x.jsonl') }, root), root), 'folderFor: anything else resumes at the checkout\'s top');
  // copyConversation never writes over a conversation that is there
  threw = null;
  try { W.copyConversation({ src: chats[0].file, from: chats[0].id, to: chats[1].id, cwd: root }); } catch (e) { threw = e; }
  ok(threw && /there already/.test(threw.message), 'copyConversation: never over a conversation that is there');
}

main().then(() => {
  if (!process.env.SYNC_TEST_KEEP) { try { fs.rmSync(T, { recursive: true, force: true }); } catch {} } else console.log(`kept: ${T}`);
  console.log(`${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}, (e) => {
  console.log(`FAIL threw: ${(e && e.stack) || e}`);
  process.exit(1);
});
