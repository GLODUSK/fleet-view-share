// Sync work: a test of sync-work.js, run with the system node:   node scripts/sync-carry-test.js
// Real git in a temp folder: bare "origin" repos and two clones of each, pc and mac, standing in for the two
// machines. origin is ssh://git@github.com/test/<name>.git (so it normalizes the way sync names repos), reached
// through a fake ssh (GIT_SSH_COMMAND, variant simple) that runs git upload-pack or receive-pack on the bare repo.
// git's own config is a file of the test's (GIT_CONFIG_GLOBAL, no system config).
//   The round trip, twice (the second with core.autocrlf=true on pc, standing in for Windows): a branch on origin with
//   2 more commits that are not; staged (an edit, a rename, a deletion), unstaged (an edit, an executable bit, a
//   binary file, a tracked symlink's target), untracked (a file in a new folder, an executable, a symlink, a binary),
//   .env.local and an ignored file (neither carried); the cwd a subfolder. pack (again while a git command holds
//   index.lock: the pack never takes it), putAway (the checkout clean, .env.local
//   in place, the stash kept), unpack on mac into its own worktree (the main checkout untouched), pack there, back to
//   pc in place: both ends verify and pc ends where it started. Then again with a commit and a change made on mac:
//   pc's branch fast-forwards to it.
//   A source in a linked worktree (its name and rel kept); a detached HEAD with an unpushed commit; a branch origin
//   never had, landing where mac's branch of that name has a commit of its own (a new branch name, mac's kept); mac's
//   main checkout dirty (a worktree used, the checkout untouched, into the dirty checkout gives way); origin offline
//   while unpacking (a note, still laid down); the cap; a submodule change and a git-lfs file refused; a merge under
//   way refused; a tampered blob; verify catching a change; inspect's kinds (portable git and plain, bound for no
//   origin, outside home, the home folder, Library, Perforce); a plain home-row folder carried (no .env, no
//   node_modules) and refused onto a folder whose file differs.
// SYNC_TEST_DIR picks the temp folder's parent; SYNC_TEST_KEEP=1 keeps it. Exit 0 = all pass.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const base = process.env.SYNC_TEST_DIR || os.tmpdir();
fs.mkdirSync(base, { recursive: true });
const T = fs.realpathSync(fs.mkdtempSync(path.join(base, 'sync-carry-test-')));
const HOME = path.join(T, 'home');
const REMOTES = path.join(T, 'remotes');
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(REMOTES, { recursive: true });

// git, isolated from this machine's own config, with origin behind a fake ssh
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete process.env[k];
const GCFG = path.join(T, 'gitconfig');
fs.writeFileSync(GCFG, '[user]\n\tname = Carry Test\n\temail = carry@test.invalid\n[init]\n\tdefaultBranch = main\n'
  + '[commit]\n\tgpgsign = false\n[core]\n\tautocrlf = false\n[advice]\n\tdetachedHead = false\n[safe]\n\tdirectory = *\n');
process.env.GIT_CONFIG_GLOBAL = GCFG;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.FV_TEST_REMOTES = REMOTES;
const SSH = path.join(T, 'fake-ssh.sh');
fs.writeFileSync(SSH, [
  '#!/bin/sh',
  '# $1: the host, $2: what git asks for, as "git-upload-pack \'/test/<name>.git\'"',
  'repo=$(printf \'%s\' "$2" | sed -e "s/^[^\']*\'//" -e "s/\'\\$//")',
  'name=$(basename "$repo")',
  'case "$2" in',
  '  git-upload-pack*) exec git upload-pack "$FV_TEST_REMOTES/$name" ;;',
  '  git-receive-pack*) exec git receive-pack "$FV_TEST_REMOTES/$name" ;;',
  'esac',
  'echo "fake ssh: $2" >&2',
  'exit 1',
  '',
].join('\n'));
fs.chmodSync(SSH, 0o755);
process.env.GIT_SSH_COMMAND = `sh '${SSH.replace(/\\/g, '/')}'`;
process.env.GIT_SSH_VARIANT = 'simple';

const W = require(path.join(ROOT, 'sync-work.js'));
const P = require(path.join(ROOT, 'platform.js'));
// Windows: symlinks only where this user may make them (then git makes them too), and no executable bit
const LINKS = (() => { try { fs.writeFileSync(path.join(T, 'l-target'), ''); fs.symlinkSync('l-target', path.join(T, 'l-test')); return true; } catch { return false; } })();
const EXEC = !P.isWin;
if (LINKS) fs.appendFileSync(GCFG, '[core]\n\tsymlinks = true\n');
const link = (target, at) => { if (LINKS) fs.symlinkSync(target, at); };
const chmodX = (f) => { if (EXEC) fs.chmodSync(f, 0o755); };
const X = EXEC ? '100755' : '100644';

let failures = 0, passes = 0;
const ok = (cond, what) => { if (cond) passes++; else { failures++; console.log(`FAIL ${what}`); } };
const eq = (a, b, what) => ok(JSON.stringify(a) === JSON.stringify(b), `${what}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
async function refusedWith(p, re, what, code = 'refused') {
  try { await p; ok(false, `${what}: it did not throw`); } catch (e) { ok(e instanceof W.WorkError && e.code === code && re.test(e.message), `${what}: ${e && e.code} ${e && e.message}`); }
}
const write = (f, data) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); };
const read = (f) => fs.readFileSync(f);
const exists = (f) => { try { fs.lstatSync(f); return true; } catch { return false; } };
const same = (a, b) => P.foldCase(path.resolve(a)) === P.foldCase(path.resolve(b));
const g = (cwd, ...args) => cp.execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
const porcelain = (dir) => g(dir, 'status', '--porcelain=v1', '--untracked-files=normal');
const url = (name) => `ssh://git@github.com/test/${name}.git`;
const lines = (n, tag, eol = '\n') => Array.from({ length: n }, (_, i) => `${tag} line ${i + 1}`).join(eol) + eol;
const bin = (n, seed) => { const b = crypto.createHash('sha256').update(seed).digest(); return Buffer.from(Array.from({ length: n }, (_, i) => b[i % 32] ^ (i & 0xff))); };
const entries = (m) => m.untracked.map((e) => `${e.path}:${e.mode}:${e.sha256.slice(0, 12)}`).sort();

function remote(name) { g(REMOTES, 'init', '-q', '--bare', `${name}.git`); }
// the first commit on origin's main, through a throwaway clone
function seed(name, extra = (dir) => {}) {
  remote(name);
  const dir = path.join(T, 'seed', name);
  g(T, 'clone', '-q', url(name), dir);
  write(path.join(dir, 'README.md'), 'hello\nworld\n');
  write(path.join(dir, 'src', 'app.js'), lines(20, 'app'));
  write(path.join(dir, 'src', 'lib', 'util.js'), lines(12, 'util'));
  write(path.join(dir, 'bin', 'run.sh'), '#!/bin/sh\necho run\n');
  write(path.join(dir, 'assets', 'logo.bin'), bin(4096, `${name}-logo`));
  write(path.join(dir, 'docs', 'old.md'), lines(8, 'doc'));
  write(path.join(dir, 'del.txt'), 'to be deleted\n');
  write(path.join(dir, '.gitignore'), '*.log\nbuild/\n');
  link('README.md', path.join(dir, 'link.txt'));
  extra(dir);
  g(dir, 'add', '-A');
  g(dir, 'commit', '-qm', 'first');
  g(dir, 'push', '-q', 'origin', 'HEAD:main');
  return dir;
}
function clone(name, who, o = {}) {
  const dir = path.join(HOME, who, name);
  const args = ['clone', '-q'];
  if (o.autocrlf) args.push('-c', 'core.autocrlf=true');
  g(T, ...args, url(name), dir);
  return fs.realpathSync(dir);
}
const commit = (dir, file, text, msg) => { write(path.join(dir, file), text); g(dir, 'add', '--', file); g(dir, 'commit', '-qm', msg); return g(dir, 'rev-parse', 'HEAD'); };

// ---------- the round trip ----------
async function roundTrip(crlf) {
  const tag = crlf ? ' (pc with autocrlf)' : '';
  const R = crlf ? 'carry-crlf' : 'carry';
  seed(R);
  const pc = clone(R, 'pc', { autocrlf: crlf }), mac = clone(R, 'mac');
  const eol = crlf ? '\r\n' : '\n';
  g(pc, 'switch', '-q', '-c', 'feat');
  commit(pc, 'src/app.js', lines(21, 'app feat1', eol), 'feat 1');
  g(pc, 'push', '-q', '-u', 'origin', 'feat');
  const pushed = g(pc, 'rev-parse', 'HEAD');
  commit(pc, 'src/lib/util.js', lines(13, 'util feat2', eol), 'feat 2');
  const head = commit(pc, 'src/new.js', `export const x = 1;${eol}`, 'feat 3');
  // staged: an edit, a rename, a deletion
  write(path.join(pc, 'README.md'), `hello${eol}staged world${eol}`);
  g(pc, 'add', 'README.md');
  g(pc, 'mv', 'docs/old.md', 'docs/new.md');
  g(pc, 'rm', '-q', 'del.txt');
  // unstaged: an edit, the executable bit, a binary file, a symlink's target
  write(path.join(pc, 'src', 'app.js'), lines(22, 'app unstaged', eol));
  chmodX(path.join(pc, 'bin', 'run.sh'));
  write(path.join(pc, 'assets', 'logo.bin'), bin(5000, 'logo changed'));
  if (LINKS) { fs.unlinkSync(path.join(pc, 'link.txt')); link('src/app.js', path.join(pc, 'link.txt')); }
  // untracked: a new folder, an executable, a symlink, a binary; .env.local and an ignored file stay
  write(path.join(pc, 'notes', 'new', 'todo.md'), `- carry this${eol}`);
  write(path.join(pc, 'tools', 'go.sh'), '#!/bin/sh\necho go\n');
  chmodX(path.join(pc, 'tools', 'go.sh'));
  link('README.md', path.join(pc, 'shortcut'));
  write(path.join(pc, 'data.bin'), bin(3000, 'data'));
  write(path.join(pc, '.env.local'), 'SECRET=1\n');
  write(path.join(pc, 'build', 'out.log'), 'ignored\n');
  const readmeBytes = read(path.join(pc, 'README.md'));
  const appBytes = read(path.join(pc, 'src', 'app.js'));

  const cwd = path.join(pc, 'src');
  const insp = await W.inspect(cwd, { home: HOME, p4Roots: [] });
  eq([insp.kind, insp.git, insp.branch, insp.head, insp.rel, insp.worktree, insp.dirty, insp.origin], ['portable', true, 'feat', head, 'src', null, true, 'https://github.com/test/' + R], `inspect${tag}`);
  ok(same(insp.root, pc) && same(insp.mainRoot, pc), `inspect: root and mainRoot${tag}`);
  const { manifest: m1, blobs: b1 } = await W.pack(cwd, { home: HOME, p4Roots: [] });
  eq([m1.kind, m1.branch, m1.head, m1.base, m1.bundleRef, m1.summary.commits, m1.rel, m1.worktree], ['git', 'feat', head, pushed, 'refs/heads/feat', 2, 'src', null], `pack: the manifest${tag}`);
  ok(m1.bundle && m1.staged && m1.unstaged && b1.has(m1.bundle) && b1.has(m1.staged) && b1.has(m1.unstaged), `pack: bundle and both diffs${tag}`);
  eq(entries(m1).map((e) => e.split(':').slice(0, 2).join(':')), ['data.bin:100644', 'notes/new/todo.md:100644', ...(LINKS ? ['shortcut:120000'] : []), `tools/go.sh:${X}`], `pack: the untracked files and their modes${tag}`);
  eq(m1.env, ['.env.local'], `pack: .env.local listed, not carried${tag}`);
  ok(m1.untracked.every((e) => b1.has(e.sha256)), `pack: every untracked blob is there${tag}`);
  eq(m1.summary.files, 8 + (EXEC ? 1 : 0) + (LINKS ? 2 : 0), `pack: files changed (README, the rename, del, app, run.sh, logo, link, and 4 untracked)${tag}`);
  ok((await W.verify(cwd, m1)).ok, `verify: the source against its own manifest${tag}`);
  // a pack while a git command of the chat holds index.lock (a snapshot mid-turn): it never takes the lock itself
  const lock = path.join(pc, '.git', 'index.lock');
  fs.writeFileSync(lock, 'held by the chat\n');
  let mLocked = null, lockErr = null;
  try { mLocked = (await W.pack(cwd, { home: HOME, p4Roots: [] })).manifest; } catch (e) { lockErr = e; }
  ok(mLocked && JSON.stringify(mLocked.trees) === JSON.stringify(m1.trees), `pack: works while index.lock is held, the same trees${tag} (${lockErr && lockErr.message})`);
  ok(read(lock).toString() === 'held by the chat\n', `pack: index.lock left as it was${tag}`);
  fs.rmSync(lock);

  const stash = await W.putAway(pc, `fleet-view: moved to mac${tag}`);
  ok(/^[0-9a-f]{40}$/.test(stash || ''), `putAway: a stash commit${tag}`);
  eq(porcelain(pc), '?? .env.local', `putAway: the checkout is clean but for .env.local${tag}`);
  eq(read(path.join(pc, '.env.local')).toString(), 'SECRET=1\n', `putAway: .env.local in place${tag}`);
  ok(g(pc, 'stash', 'list').includes('fleet-view: moved to mac'), `putAway: the stash is listed${tag}`);

  const macBefore = porcelain(mac);
  const u1 = await W.unpack(m1, b1, { root: mac, home: HOME });
  const macWt = path.join(mac, '.claude', 'worktrees', 'fv-feat');
  ok(same(u1.into, macWt) && same(u1.cwd, path.join(macWt, 'src')), `unpack: into mac's own worktree, cwd its src (${u1.cwd})${tag}`);
  eq(u1.branch, 'feat', `unpack: on feat${tag}`);
  eq(porcelain(mac), macBefore, `unpack: mac's main checkout untouched (the worktree folder excluded)${tag}`);
  ok((await W.verify(u1.cwd, m1)).ok, `verify: mac's worktree${tag}`);
  ok(!exists(path.join(macWt, '.env.local')) && !exists(path.join(macWt, 'build', 'out.log')), `unpack: no .env.local, no ignored file${tag}`);
  if (LINKS) {
    eq(fs.readlinkSync(path.join(macWt, 'shortcut')), 'README.md', `unpack: the untracked symlink${tag}`);
    eq(fs.readlinkSync(path.join(macWt, 'link.txt')), 'src/app.js', `unpack: the tracked symlink's new target${tag}`);
  }
  if (EXEC) ok((fs.statSync(path.join(macWt, 'bin', 'run.sh')).mode & 0o111) !== 0, `unpack: the executable bit${tag}`);
  eq(read(path.join(macWt, 'assets', 'logo.bin')).equals(bin(5000, 'logo changed')), true, `unpack: the binary change${tag}`);
  eq(read(path.join(macWt, 'README.md')).toString(), 'hello\nstaged world\n', `unpack: README in git's own form (LF)${tag}`);
  eq(g(macWt, 'diff', '--cached', '--name-status', '-M').split('\n').sort(), ['D\tdel.txt', 'M\tREADME.md', 'R100\tdocs/old.md\tdocs/new.md'], `unpack: the staged set${tag}`);
  eq(g(macWt, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/feat', `unpack: feat tracks origin/feat${tag}`);

  // and back, unchanged
  const { manifest: m2, blobs: b2 } = await W.pack(u1.cwd, { home: HOME, p4Roots: [] });
  eq([m2.head, m2.trees, m2.rel, m2.worktree, m2.summary.commits], [m1.head, m1.trees, 'src', 'fv-feat', 2], `pack on mac: the same work${tag}`);
  eq(entries(m2), entries(m1), `pack on mac: the same untracked files${tag}`);
  ok(await W.putAway(u1.into, `fleet-view: moved to pc${tag}`), `putAway on mac${tag}`);
  const u2 = await W.unpack(m2, b2, { root: pc, into: pc, home: HOME });
  ok(same(u2.into, pc) && same(u2.cwd, cwd), `unpack on pc: in place${tag}`);
  ok((await W.verify(u2.cwd, m1)).ok, `round trip: pc ends where it started${tag}`);
  ok(read(path.join(pc, 'README.md')).equals(readmeBytes) && read(path.join(pc, 'src', 'app.js')).equals(appBytes), `round trip: the same bytes on pc, line endings too${tag}`);
  eq(read(path.join(pc, '.env.local')).toString(), 'SECRET=1\n', `round trip: .env.local still in place${tag}`);
  ok(g(pc, 'stash', 'list').includes('fleet-view: moved to mac'), `round trip: the first stash is still kept${tag}`);

  // again, with a commit and a change made on mac
  const { manifest: m3, blobs: b3 } = await W.pack(cwd, { home: HOME, p4Roots: [] });
  await W.putAway(pc, `fleet-view: moved to mac again${tag}`);
  const u3 = await W.unpack(m3, b3, { root: mac, into: macWt, home: HOME });
  ok(same(u3.into, macWt), `unpack again: mac's worktree used in place${tag}`);
  g(macWt, 'add', '-A');
  g(macWt, 'commit', '-qm', 'made on mac');
  write(path.join(macWt, 'src', 'mac.txt'), 'from the mac\n');
  write(path.join(macWt, 'README.md'), 'hello\nfrom the mac\n');
  const macHead = g(macWt, 'rev-parse', 'HEAD');
  const { manifest: m4, blobs: b4 } = await W.pack(u3.cwd, { home: HOME, p4Roots: [] });
  eq([m4.head, m4.summary.commits, m4.staged, !!m4.unstaged], [macHead, 3, null, true], `pack on mac: a new commit, an unstaged change${tag}`);
  await W.putAway(macWt, `fleet-view: moved to pc again${tag}`);
  const u4 = await W.unpack(m4, b4, { root: pc, into: pc, home: HOME });
  ok(same(u4.into, pc), `unpack on pc: in place again${tag}`);
  eq(g(pc, 'rev-parse', 'feat'), macHead, `unpack on pc: feat fast-forwarded to mac's commit${tag}`);
  ok((await W.verify(u4.cwd, m4)).ok, `verify on pc after the second trip${tag}`);
  eq(read(path.join(pc, 'src', 'mac.txt')).toString(), 'from the mac\n', `the second trip: mac's untracked file${tag}`);
  eq(read(path.join(pc, 'README.md')).toString(), `hello${eol}from the mac${eol}`, `the second trip: README in pc's line endings${tag}`);
  return { pc, mac, m1, b1 };
}

async function main() {
  const A = await roundTrip(false);
  await roundTrip(true);

  // verify catches a change, and unpack refuses a tampered blob
  {
    const { pc, m1, b1 } = A;
    const bad = new Map(b1);
    const k = m1.untracked[0].sha256;
    bad.set(k, Buffer.concat([b1.get(k), Buffer.from('x')]));
    await refusedWith(W.unpack(m1, bad, { root: A.mac }), /missing or isn't/, 'unpack: a tampered blob', 'missing');
    const m = { ...m1, untracked: m1.untracked.slice(1) };
    const b = new Map(b1);
    await refusedWith(W.unpack(m1, new Map([...b].filter(([h]) => h !== m1.staged)), { root: A.mac }), /missing/, 'unpack: a blob left out', 'missing');
    ok(m.untracked.length === 3, 'a manifest copy');
    const scratch = path.join(T, 'verify-copy');
    g(T, 'clone', '-q', url('carry'), scratch);
    const v = await W.verify(scratch, m1);
    ok(!v.ok && v.diffs.some((d) => /HEAD is/.test(d)) && v.diffs.some((d) => /missing/.test(d)), `verify: a checkout that isn't the work (${v.diffs.slice(0, 3).join('; ')})`);
    void pc;
  }

  // a lay-down that doesn't verify is undone: a new worktree (and the branch it made), or a checkout used in place
  {
    const { mac, m1, b1 } = A;
    const bad = { ...m1, trees: { ...m1.trees, work: '0'.repeat(40) } };
    const branchesBefore = g(mac, 'branch', '--format=%(refname:short)');
    const wtBefore = g(mac, 'worktree', 'list', '--porcelain');
    await refusedWith(W.unpack(bad, b1, { root: mac }), /isn't what was packed/, 'rollback: a new worktree that does not verify', 'verify');
    eq(g(mac, 'branch', '--format=%(refname:short)'), branchesBefore, 'rollback: the branch it made is gone');
    eq(g(mac, 'worktree', 'list', '--porcelain'), wtBefore, 'rollback: the worktree it made is gone');
    seed('rb');
    const pc = clone('rb', 'pc'), mac2 = clone('rb', 'mac');
    write(path.join(pc, 'README.md'), 'changed on pc\n');
    write(path.join(pc, 'fresh.txt'), 'new on pc\n');
    const { manifest: m, blobs: b } = await W.pack(pc, { home: HOME, p4Roots: [] });
    const head = g(mac2, 'rev-parse', 'HEAD');
    write(path.join(mac2, '.env.local'), 'K=1\n');
    await refusedWith(W.unpack({ ...m, trees: { ...m.trees, index: '0'.repeat(40) } }, b, { root: mac2, into: mac2 }), /isn't what was packed/, 'rollback: in place, does not verify', 'verify');
    eq([porcelain(mac2), g(mac2, 'rev-parse', 'HEAD'), read(path.join(mac2, 'README.md')).toString()], ['?? .env.local', head, 'hello\nworld\n'], 'rollback: the checkout used in place is back as it was');
    eq(read(path.join(mac2, '.env.local')).toString(), 'K=1\n', 'rollback: an untracked env file survives the clean-up');
    eq(await W.putAway(mac2, 'nothing but env'), null, 'putAway: nothing to put away but an env file');
    ok(exists(path.join(mac2, '.env.local')), 'putAway: the env file stays');
    const u = await W.unpack(m, b, { root: mac2, into: mac2 });
    ok(same(u.into, mac2) && (await W.verify(u.cwd, m)).ok, 'an untracked env file does not make a checkout dirty: used in place');
  }

  // the chat's own worktree, switched over from another branch, goes back as it was when the work doesn't verify:
  // its branch, its commit, and the branch the switch moved (fast-forwarded) back where it was
  {
    seed('sw');
    const pc = clone('sw', 'pc'), mac = clone('sw', 'mac');
    g(pc, 'switch', '-q', '-c', 'feat');
    const mid = commit(pc, 'src/app.js', lines(22, 'sw one'), 'sw 1');
    g(pc, 'push', '-q', '-u', 'origin', 'feat');
    commit(pc, 'src/app.js', lines(23, 'sw two'), 'sw 2');
    write(path.join(pc, 'README.md'), 'sw edit\n');
    const { manifest: m, blobs: b } = await W.pack(pc, { home: HOME, p4Roots: [] });
    g(mac, 'fetch', '-q', 'origin');
    g(mac, 'branch', 'feat', mid); // behind the work's head: the switch fast-forwards it
    const own = path.join(mac, '.claude', 'worktrees', 'chat');
    g(mac, 'worktree', 'add', '-q', '-b', 'other', own);
    const otherHead = g(own, 'rev-parse', 'HEAD');
    await refusedWith(W.unpack({ ...m, trees: { ...m.trees, work: '0'.repeat(40) } }, b, { root: mac, into: own }), /isn't what was packed/, 'rollback: a switched own worktree, does not verify', 'verify');
    eq([g(own, 'branch', '--show-current'), g(own, 'rev-parse', 'HEAD'), porcelain(own)], ['other', otherHead, ''], 'rollback: the switched worktree is back on its branch, clean');
    eq(g(mac, 'rev-parse', 'feat'), mid, 'rollback: the branch the switch fast-forwarded is back where it was');
    const u = await W.unpack(m, b, { root: mac, into: own });
    ok(same(u.into, own) && u.branch === 'feat' && (await W.verify(u.cwd, m)).ok, 'the own worktree switched over for real afterwards');
  }

  // never a file through a symlink: one in the manifest (files go first, so it clashes) or one already in the target
  {
    seed('ln');
    const pc = clone('ln', 'pc'), mac = clone('ln', 'mac');
    write(path.join(pc, 'note.txt'), 'note\n');
    const { manifest: m, blobs: b } = await W.pack(pc, { home: HOME, p4Roots: [] });
    const outside = path.join(T, 'outside-ln');
    fs.mkdirSync(outside, { recursive: true });
    const tgt = Buffer.from(outside, 'utf8'), evil = Buffer.from('evil\n');
    const h = (x) => crypto.createHash('sha256').update(x).digest('hex');
    const b2 = new Map([...b, [h(tgt), tgt], [h(evil), evil]]);
    const m2 = { ...m, untracked: [...m.untracked, { path: 'out', mode: '120000', size: tgt.length, sha256: h(tgt) }, { path: 'out/evil.txt', mode: '100644', size: evil.length, sha256: h(evil) }] };
    await refusedWith(W.unpack(m2, b2, { root: mac }), /there already and differs|through a symlink/, 'a symlink in the manifest can\'t lead a file out', 'conflict');
    ok(!exists(path.join(outside, 'evil.txt')), 'nothing was written outside the worktree');
    if (LINKS) {
      const into = path.join(T, 'plain-into');
      fs.mkdirSync(into, { recursive: true });
      fs.symlinkSync(outside, path.join(into, 'lnk'));
      const m3 = { v: 1, kind: 'plain', origin: 'home:', branch: null, head: null, base: null, bundle: null, bundleRef: null, staged: null, unstaged: null, trees: null,
        untracked: [{ path: 'lnk/evil.txt', mode: '100644', size: evil.length, sha256: h(evil) }], env: [], rel: 'x', worktree: null, summary: { commits: 0, files: 1, bytes: evil.length }, notes: [] };
      await refusedWith(W.unpack(m3, new Map([[h(evil), evil]]), { into }), /through a symlink/, 'a symlink already in the target can\'t lead a file out', 'conflict');
      ok(!exists(path.join(outside, 'evil.txt')), 'nothing was written through the symlink');
    }
  }

  // a source in a linked worktree, cwd two folders down
  {
    seed('wt');
    const pc = clone('wt', 'pc'), mac = clone('wt', 'mac');
    const w1 = path.join(pc, '.claude', 'worktrees', 'w1');
    g(pc, 'worktree', 'add', '-q', '-b', 'wt-branch', w1);
    write(path.join(w1, 'src', 'lib', 'util.js'), lines(14, 'util in w1'));
    write(path.join(w1, 'src', 'lib', 'extra.js'), 'extra\n');
    const cwd = path.join(w1, 'src', 'lib');
    const insp = await W.inspect(cwd, { home: HOME, p4Roots: [] });
    eq([insp.worktree, insp.rel, insp.branch], ['w1', 'src/lib', 'wt-branch'], 'worktree: inspect');
    ok(same(insp.root, w1) && same(insp.mainRoot, pc), 'worktree: root is the worktree, mainRoot the checkout');
    const { manifest: m, blobs: b } = await W.pack(cwd, { home: HOME, p4Roots: [] });
    eq([m.worktree, m.rel, m.bundle, m.base === g(pc, 'rev-parse', 'origin/main')], ['w1', 'src/lib', null, true], 'worktree: pack (no commits to bundle, base origin/main)');
    const u = await W.unpack(m, b, { root: mac });
    ok(same(u.cwd, path.join(mac, '.claude', 'worktrees', 'w1', 'src', 'lib')), `worktree: unpacked into mac's w1 (${u.cwd})`);
    eq(u.branch, 'wt-branch', 'worktree: the branch made on mac');
    ok((await W.verify(u.cwd, m)).ok, 'worktree: verify');
  }

  // a detached HEAD with an unpushed commit
  {
    seed('det');
    const pc = clone('det', 'pc'), mac = clone('det', 'mac');
    g(pc, 'switch', '-q', '--detach', 'HEAD');
    const head = commit(pc, 'src/app.js', lines(25, 'detached'), 'on a detached head');
    write(path.join(pc, 'README.md'), 'detached edit\n');
    const { manifest: m, blobs: b } = await W.pack(pc, { home: HOME, p4Roots: [] });
    eq([m.branch, m.bundleRef, m.summary.commits, m.head], [null, 'HEAD', 1, head], 'detached: pack');
    const u = await W.unpack(m, b, { root: mac });
    eq(u.branch, null, 'detached: unpacked detached');
    eq(g(u.into, 'rev-parse', 'HEAD'), head, 'detached: at the commit');
    ok(g(mac, 'for-each-ref', '--format=%(refname)', 'refs/fleet-view/incoming').includes(head), 'detached: the commit kept under refs/fleet-view/incoming');
    ok((await W.verify(u.cwd, m)).ok, 'detached: verify');
  }

  // a branch origin never had, where mac's branch of that name has a commit of its own; then origin offline
  {
    seed('topic');
    const pc = clone('topic', 'pc'), mac = clone('topic', 'mac');
    g(pc, 'switch', '-q', '-c', 'topic');
    commit(pc, 'src/a.js', 'a\n', 'topic 1');
    const head = commit(pc, 'src/b.js', 'b\n', 'topic 2');
    write(path.join(pc, 'src', 'a.js'), 'a changed\n');
    g(mac, 'switch', '-q', '-c', 'topic');
    const macOwn = commit(mac, 'mac-only.txt', 'mine\n', 'mac only');
    g(mac, 'switch', '-q', 'main');
    const { manifest: m, blobs: b } = await W.pack(pc, { home: HOME, p4Roots: [] });
    eq([m.summary.commits, m.base === g(pc, 'rev-parse', 'origin/main')], [2, true], 'topic: 2 commits, based on origin/main');
    const saved = process.env.FV_TEST_REMOTES;
    process.env.FV_TEST_REMOTES = path.join(T, 'nowhere');
    let u;
    try { u = await W.unpack(m, b, { root: mac }); } finally { process.env.FV_TEST_REMOTES = saved; }
    ok(/^topic-moved-[0-9a-f]{8}$/.test(u.branch || ''), `topic: a new branch name (${u.branch})`);
    ok(u.notes.some((n) => /topic here has commits/.test(n)), 'topic: the note says why');
    ok(u.notes.some((n) => /couldn't fetch origin/.test(n)), 'offline: a note, and still laid down');
    eq(g(mac, 'rev-parse', 'topic'), macOwn, 'topic: mac\'s own topic kept');
    eq(g(u.into, 'rev-parse', 'HEAD'), head, 'topic: the work at its head');
    ok((await W.verify(u.cwd, m)).ok, 'topic: verify');

    // mac's main checkout dirty: a worktree is used, and into that checkout gives way
    write(path.join(mac, 'README.md'), 'mac is busy\n');
    write(path.join(mac, 'scratch.txt'), 'mac scratch\n');
    const before = porcelain(mac);
    const u2 = await W.unpack(m, b, { root: mac, into: mac });
    ok(!same(u2.into, mac) && u2.into.includes(path.join('.claude', 'worktrees')), `dirty: a worktree used (${u2.into})`);
    ok(u2.notes.some((n) => /has changes of its own/.test(n)), 'dirty: the note says so');
    eq(porcelain(mac), before, 'dirty: mac\'s checkout untouched');
    eq(read(path.join(mac, 'README.md')).toString(), 'mac is busy\n', 'dirty: mac\'s edit untouched');
    ok((await W.verify(u2.cwd, m)).ok, 'dirty: verify');
  }

  // what is refused
  {
    seed('refuse', (dir) => write(path.join(dir, '.gitattributes'), '*.lfs filter=lfs diff=lfs merge=lfs -text\n'));
    const pc = clone('refuse', 'pc');
    write(path.join(pc, 'big.txt'), 'x'.repeat(2000));
    await refusedWith(W.pack(pc, { cap: 1000, home: HOME, p4Roots: [] }), /MB a move carries/, 'the cap');
    fs.unlinkSync(path.join(pc, 'big.txt'));
    write(path.join(pc, 'model.lfs'), 'lfs content\n');
    await refusedWith(W.pack(pc, { home: HOME, p4Roots: [] }), /git-lfs/, 'a git-lfs file');
    fs.unlinkSync(path.join(pc, 'model.lfs'));
    // a merge under way
    g(pc, 'switch', '-q', '-c', 'other');
    commit(pc, 'README.md', 'other side\n', 'other');
    g(pc, 'switch', '-q', 'main');
    commit(pc, 'README.md', 'main side\n', 'main');
    try { g(pc, 'merge', '-q', 'other'); } catch {}
    await refusedWith(W.pack(pc, { home: HOME, p4Roots: [] }), /merge is under way/, 'a merge under way');
    g(pc, 'merge', '--abort');
    // a submodule
    seed('sub');
    seed('super', (dir) => {
      g(dir, 'submodule', 'add', '-q', url('sub'), 'sub');
    });
    const sp = clone('super', 'pc');
    g(sp, 'submodule', 'update', '-q', '--init');
    commit(path.join(sp, 'sub'), 'inner.txt', 'inner\n', 'inside the submodule');
    await refusedWith(W.pack(sp, { home: HOME, p4Roots: [] }), /submodule/, 'a submodule change');
  }

  // inspect's kinds
  {
    const noOrigin = path.join(HOME, 'norigin');
    fs.mkdirSync(noOrigin, { recursive: true });
    g(noOrigin, 'init', '-q');
    const kind = async (dir) => { const r = await W.inspect(dir, { home: HOME, p4Roots: [] }); return [r.kind, r.why]; };
    eq(await kind(noOrigin), ['bound', 'a git checkout with no origin'], 'inspect: no origin');
    const outside = path.join(T, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    eq(await kind(outside), ['bound', 'outside the home folder'], 'inspect: outside the home folder');
    eq(await kind(HOME), ['bound', 'the home folder itself'], 'inspect: the home folder');
    const lib = path.join(HOME, 'Library', 'x');
    fs.mkdirSync(lib, { recursive: true });
    eq(await kind(lib), ['bound', 'an app data or Claude account folder'], 'inspect: Library');
    const p4 = path.join(HOME, 'Perforce', 'ws', 'game');
    fs.mkdirSync(p4, { recursive: true });
    write(path.join(HOME, 'Perforce', 'ws', '.p4config'), 'P4CLIENT=ws\n');
    eq(await kind(p4), ['bound', 'a Perforce workspace'], 'inspect: a .p4config above');
    const p4b = path.join(HOME, 'Depot', 'proj');
    fs.mkdirSync(p4b, { recursive: true });
    eq((await W.inspect(p4b, { home: HOME, p4Roots: [path.join(HOME, 'Depot')] })).why, 'a Perforce workspace', 'inspect: under p4\'s client root');
    eq(await kind(path.join(HOME, 'gone', 'folder')), ['portable', null], 'inspect: a folder not here yet, under home');
    await refusedWith(W.pack(noOrigin, { home: HOME, p4Roots: [] }), /stays on this machine: a git checkout with no origin/, 'pack: a bound folder');
  }

  // a plain home-row folder
  {
    const dir = path.join(HOME, 'Scratchpads', 's1');
    write(path.join(dir, 'a.txt'), 'plain a\n');
    write(path.join(dir, 'sub', 'b.bin'), bin(700, 'plain b'));
    write(path.join(dir, 'run.sh'), '#!/bin/sh\n');
    chmodX(path.join(dir, 'run.sh'));
    write(path.join(dir, '.env'), 'KEY=1\n');
    write(path.join(dir, 'node_modules', 'x', 'index.js'), 'module\n');
    const insp = await W.inspect(dir, { home: HOME, p4Roots: [] });
    eq([insp.kind, insp.git, insp.origin, insp.rel], ['portable', false, 'home:', 'Scratchpads/s1'], 'plain: inspect');
    const { manifest: m, blobs: b } = await W.pack(dir, { home: HOME, p4Roots: [] });
    eq([m.kind, m.untracked.map((e) => `${e.path}:${e.mode}`), m.env], ['plain', ['a.txt:100644', `run.sh:${X}`, 'sub/b.bin:100644'], ['.env']], 'plain: pack');
    const home2 = path.join(T, 'home2');
    const u = await W.unpack(m, b, { home: home2 });
    ok(same(u.cwd, path.join(home2, 'Scratchpads', 's1')), 'plain: unpacked under the other home');
    ok((await W.verify(u.cwd, m)).ok && !exists(path.join(u.cwd, '.env')) && !exists(path.join(u.cwd, 'node_modules')), 'plain: verify, no .env, no node_modules');
    const home3 = path.join(T, 'home3');
    write(path.join(home3, 'Scratchpads', 's1', 'a.txt'), 'something else\n');
    await refusedWith(W.unpack(m, b, { home: home3 }), /differs: nothing was written/, 'plain: a file that differs', 'conflict');
    ok(!exists(path.join(home3, 'Scratchpads', 's1', 'sub')), 'plain: nothing half written');
    await refusedWith(W.pack(HOME, { home: HOME, p4Roots: [] }), /the home folder itself/, 'plain: never the home folder');
  }
}

main().catch((e) => { failures++; console.log(`FAIL threw: ${e && e.stack}`); }).finally(() => {
  if (process.env.SYNC_TEST_KEEP !== '1') { try { fs.rmSync(T, { recursive: true, force: true }); } catch {} } else console.log(`kept ${T}`);
  console.log(`${passes} passed, ${failures} failed`);
  process.exitCode = failures ? 1 : 0;
});
