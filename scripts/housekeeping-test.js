// Housekeeping: a test of every rule (housekeeping.js), run with the system node:   node scripts/housekeeping-test.js
// It builds a throwaway setup in a temp folder (HK_TEST_DIR, or the system temp folder): a bare "origin", a clone
// of it with worktrees and branches made for each case, a fake gh with made-up PRs, and a fake projects folder.
// It checks the report's verdict for every case, runs the clean-up on everything the report would remove (plus a
// few it must refuse), checks what went and what stayed, the log, and that Restore brings each one back.
// Two cases matter most: a worktree holding a junction to a shared folder outside it (the shared folder must survive
// its removal) and a worktree that turns dirty between the report and the run (it must stay). Also: a worktree or a
// clone inside another worktree, a removal git leaves half done (it must be logged and restorable), and a GitHub
// branch that moves or is deleted between the run's ls-remote and its push (origin's upload-pack makes that happen).
// Nothing outside the temp folder is touched; it is deleted at the end (HK_TEST_KEEP=1 keeps it). Exit 0 = all pass.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const { Readable } = require('stream');

// commits made by the test (and by the module's git calls) get a fixed identity
Object.assign(process.env, { GIT_AUTHOR_NAME: 'hk test', GIT_AUTHOR_EMAIL: 'hk@test', GIT_COMMITTER_NAME: 'hk test', GIT_COMMITTER_EMAIL: 'hk@test', GIT_CONFIG_NOSYSTEM: '1' });
const { createHousekeeping } = require(path.join(__dirname, '..', 'housekeeping.js'));

const DAY = 24 * 3600e3;
const NOW = Date.now() + 30 * DAY; // the test's "now": everything git made today is a month old
const iso = (ms) => new Date(ms).toISOString();
const base = process.env.HK_TEST_DIR || os.tmpdir();
fs.mkdirSync(base, { recursive: true });
const T = fs.realpathSync(fs.mkdtempSync(path.join(base, 'hk-test-')));
const ORIGIN = path.join(T, 'origin.git'), REPO = path.join(T, 'repo'), WTS = path.join(REPO, '.claude', 'worktrees');
const SHARED = path.join(T, 'shared'), PROJECTS = path.join(T, 'projects'), DATA = path.join(T, 'data');

let failures = 0, passes = 0;
const ok = (cond, what) => { if (cond) passes++; else { failures++; console.log(`FAIL ${what}`); } };
function git(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${dir}: ${r.stderr}`);
  return r.stdout.trim();
}
const tryGit = (dir, ...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true });
const write = (f, text) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const slug = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
const prs = [];
const pr = (number, head, sha, state, extra = {}) => prs.push({ number, state, headRefName: head, headRefOid: sha, baseRefName: 'main', createdAt: iso(NOW - 20 * DAY),
  mergedAt: state === 'MERGED' ? iso(NOW - 9 * DAY) : null, closedAt: state !== 'OPEN' ? iso(NOW - 9 * DAY) : null, url: `https://github.com/test/repo/pull/${number}`, isCrossRepository: false, ...extra });

let holder = null;
const stuck = []; // every holding process, killed at the end
const stop = (p) => new Promise((res) => { if (!p || p.exitCode !== null || p.signalCode) return res(); p.once('exit', () => res()); setTimeout(res, 5000); try { p.kill(); } catch { res(); } });
async function main() {
  // ---------- the setup ----------
  git(T, 'init', '-q', '--bare', '-b', 'main', ORIGIN);
  git(T, 'clone', '-q', ORIGIN, REPO);
  write(path.join(REPO, '.gitignore'), 'node_modules\n');
  write(path.join(REPO, 'a.txt'), 'a\n');
  git(REPO, 'add', '.');
  git(REPO, 'commit', '-q', '-m', 'first');
  git(REPO, 'push', '-q', '-u', 'origin', 'main');
  fs.appendFileSync(path.join(REPO, '.git', 'info', 'exclude'), '/.claude/\n.codegraph\n');
  write(path.join(SHARED, 'keep.txt'), 'shared install\n');

  // a worktree on its own branch with one commit, pushed unless push is false
  const wt = (name, { push = true } = {}) => {
    const p = path.join(WTS, name);
    git(REPO, 'worktree', 'add', '-q', '-b', name, p, 'origin/main');
    write(path.join(p, `${name}.txt`), name + '\n');
    git(p, 'add', '.');
    git(p, 'commit', '-q', '-m', name);
    if (push) git(p, 'push', '-q', '-u', 'origin', name);
    return { path: p, sha: git(p, 'rev-parse', 'HEAD') };
  };
  // a commit on top of origin/main that no branch holds: its sha
  const commit = (label, parent = 'origin/main') => {
    const blob = spawnSync('git', ['-C', REPO, 'hash-object', '-w', '--stdin'], { input: label + '\n', encoding: 'utf8' }).stdout.trim();
    const baseTree = git(REPO, 'rev-parse', `${parent}^{tree}`);
    const entries = git(REPO, 'ls-tree', baseTree) + `\n100644 blob ${blob}\t${label}.txt\n`;
    const t2 = spawnSync('git', ['-C', REPO, 'mktree'], { input: entries, encoding: 'utf8' }).stdout.trim();
    return git(REPO, 'commit-tree', t2, '-p', git(REPO, 'rev-parse', parent), '-m', label);
  };

  const W = {};
  W.merged = wt('wt-merged'); pr(1, 'wt-merged', W.merged.sha, 'MERGED');
  W.prhead = wt('wt-prhead', { push: false }); git(W.prhead.path, 'push', '-q', 'origin', 'HEAD:refs/pull/2/head'); pr(2, 'wt-prhead', W.prhead.sha, 'MERGED');
  W.dirty = wt('wt-dirty'); pr(3, 'wt-dirty', W.dirty.sha, 'MERGED'); fs.appendFileSync(path.join(W.dirty.path, 'a.txt'), 'changed\n');
  W.untracked = wt('wt-untracked'); pr(4, 'wt-untracked', W.untracked.sha, 'MERGED'); write(path.join(W.untracked.path, 'new.txt'), 'x');
  W.unpushed = wt('wt-unpushed'); pr(5, 'wt-unpushed', W.unpushed.sha, 'MERGED');
  write(path.join(W.unpushed.path, 'more.txt'), 'more'); git(W.unpushed.path, 'add', '.'); git(W.unpushed.path, 'commit', '-q', '-m', 'more');
  W.locked = wt('wt-locked'); pr(6, 'wt-locked', W.locked.sha, 'MERGED'); git(REPO, 'worktree', 'lock', W.locked.path);
  W.live = wt('wt-live'); pr(7, 'wt-live', W.live.sha, 'MERGED');
  W.cg = wt('wt-codegraph'); pr(8, 'wt-codegraph', W.cg.sha, 'MERGED');
  W.convo = wt('wt-convo'); pr(9, 'wt-convo', W.convo.sha, 'MERGED');
  W.sub = wt('wt-sub'); pr(10, 'wt-sub', W.sub.sha, 'MERGED');
  W.open = wt('wt-open'); pr(11, 'wt-open', W.open.sha, 'OPEN');
  W.nopr = wt('wt-nopr');
  W.closed = wt('wt-closed'); pr(12, 'wt-closed', W.closed.sha, 'CLOSED');
  W.pinned = wt('wt-pinned'); pr(13, 'wt-pinned', W.pinned.sha, 'MERGED');
  W.junction = wt('wt-junction'); pr(14, 'wt-junction', W.junction.sha, 'MERGED');
  const mk = spawnSync('cmd', ['/c', 'mklink', '/J', path.join(W.junction.path, 'node_modules'), SHARED], { encoding: 'utf8', windowsHide: true });
  ok(mk.status === 0, `mklink /J worked (${mk.stderr || mk.stdout})`);
  W.race = wt('wt-race'); pr(15, 'wt-race', W.race.sha, 'MERGED');
  W.gitused = wt('wt-gitused'); pr(16, 'wt-gitused', W.gitused.sha, 'MERGED');
  W.held = wt('wt-held'); pr(17, 'wt-held', W.held.sha, 'MERGED'); write(path.join(W.held.path, '.codegraph', 'codegraph.db'), 'index');
  // in origin/main, no PR: its commit is pushed to main
  W.inmain = wt('wt-inmain'); git(W.inmain.path, 'push', '-q', 'origin', 'HEAD:main'); git(REPO, 'fetch', '-q', 'origin');
  // a worktree inside another one (.claude/ is ignored, so the outer one looks clean): the inner one has work
  W.outer = wt('wt-outer'); pr(48, 'wt-outer', W.outer.sha, 'MERGED');
  W.inner = { path: path.join(W.outer.path, '.claude', 'worktrees', 'inner') };
  git(REPO, 'worktree', 'add', '-q', '-b', 'wt-inner', W.inner.path, 'origin/main'); write(path.join(W.inner.path, 'wip.txt'), 'work in progress\n');
  // a clone inside a worktree: the report cannot see it, the removal must
  W.clone = wt('wt-clone'); pr(45, 'wt-clone', W.clone.sha, 'MERGED');
  git(T, 'clone', '-q', ORIGIN, path.join(W.clone.path, '.claude', 'sub')); write(path.join(W.clone.path, '.claude', 'sub', 'wip.txt'), 'clone work\n');
  // git's delete fails part way and stays failed: a process's working folder, a file held for the whole run
  W.scwd = wt('wt-stuck-cwd'); pr(46, 'wt-stuck-cwd', W.scwd.sha, 'MERGED');
  W.sfile = wt('wt-stuck-file'); pr(47, 'wt-stuck-file', W.sfile.sha, 'MERGED'); write(path.join(W.sfile.path, '.codegraph', 'codegraph.db'), 'index');
  // a worktree whose folder is gone (prunable): no run may prune it
  W.gone = wt('wt-gone'); fs.rmSync(W.gone.path, { recursive: true, force: true });

  // the git-used case: its admin folder's index was written an hour ago (test time)
  const admin = git(W.gitused.path, 'rev-parse', '--absolute-git-dir');
  fs.utimesSync(path.join(admin, 'index'), new Date(NOW - 3600e3), new Date(NOW - 3600e3));
  // conversations: an old one where wt-merged is (does not hold it), a recent one in wt-convo, one in a subfolder of wt-sub
  const convo = (folder, ms) => { const f = path.join(PROJECTS, slug(folder), 'c.jsonl'); write(f, '{}\n'); fs.utimesSync(f, new Date(ms), new Date(ms)); fs.utimesSync(path.dirname(f), new Date(ms), new Date(ms)); };
  convo(W.merged.path, NOW - 20 * DAY);
  convo(W.convo.path, NOW - 2 * DAY);
  convo(path.join(W.sub.path, 'src', 'deep'), NOW - DAY);

  // local branches, none checked out
  const B = {};
  B.inmain = git(REPO, 'rev-parse', 'origin/main'); git(REPO, 'branch', 'br-inmain', B.inmain);
  B.squash = commit('br-squash'); git(REPO, 'branch', 'br-squash', B.squash); git(REPO, 'push', '-q', 'origin', `${B.squash}:refs/pull/20/head`); pr(20, 'br-squash', B.squash, 'MERGED');
  B.moved0 = commit('br-moved'); B.moved = commit('br-moved-2', B.moved0); git(REPO, 'branch', 'br-moved', B.moved); pr(21, 'br-moved', B.moved0, 'MERGED');
  git(REPO, 'branch', 'br-open', B.inmain); pr(22, 'br-open', B.inmain, 'OPEN');
  git(REPO, 'branch', 'br-pinned', B.inmain);
  // GitHub keeps every PR's last commit, closed ones too, under refs/pull/<n>/head
  B.closed = commit('br-closed'); git(REPO, 'branch', 'br-closed', B.closed); git(REPO, 'push', '-q', 'origin', `${B.closed}:refs/pull/23/head`); pr(23, 'br-closed', B.closed, 'CLOSED');
  B.nopr = commit('br-nopr'); git(REPO, 'branch', 'br-nopr', B.nopr);

  // branches only on GitHub (the bare origin)
  const R = {};
  const remote = (name, sha) => { git(REPO, 'push', '-q', 'origin', `${sha}:refs/heads/${name}`); return sha; };
  R.merged = remote('rb-merged', commit('rb-merged')); pr(30, 'rb-merged', R.merged, 'MERGED');
  R.moved0 = commit('rb-moved'); R.moved = remote('rb-moved', commit('rb-moved-2', R.moved0)); pr(31, 'rb-moved', R.moved0, 'MERGED');
  R.open = remote('rb-open', commit('rb-open')); pr(32, 'rb-open', R.open, 'OPEN');
  R.base = remote('rb-base', commit('rb-base')); pr(33, 'rb-base', R.base, 'MERGED'); pr(34, 'rb-child', commit('rb-child'), 'OPEN', { baseRefName: 'rb-base' });
  R.prot = remote('rb-protected', commit('rb-protected')); pr(35, 'rb-protected', R.prot, 'MERGED');
  R.closed = remote('rb-closed', commit('rb-closed')); pr(36, 'rb-closed', R.closed, 'CLOSED');
  R.pinned = remote('rb-pinned', commit('rb-pinned')); pr(37, 'rb-pinned', R.pinned, 'MERGED');
  // a fork's merged PR from a branch of the same name does not count
  R.nopr = remote('rb-nopr', commit('rb-nopr')); pr(38, 'rb-nopr', R.nopr, 'MERGED', { isCrossRepository: true });
  // merged, but someone pushes to it between the report and the run
  R.race = remote('rb-race', commit('rb-race')); pr(41, 'rb-race', R.race, 'MERGED');
  R.merged2 = remote('rb-merged-2', commit('rb-merged-2')); pr(42, 'rb-merged-2', R.merged2, 'MERGED');
  // pushed to between the run's ls-remote and its push (the lease must refuse it)
  R.lease = remote('rb-lease', commit('rb-lease')); pr(43, 'rb-lease', R.lease, 'MERGED');
  R.lease2 = commit('rb-lease-2', R.lease); git(REPO, 'push', '-q', 'origin', `${R.lease2}:refs/test/lease-2`);
  // deleted on GitHub in that window, and a tag has the same name (the tag must survive)
  R.tagged = remote('rb-tagged', commit('rb-tagged')); pr(44, 'rb-tagged', R.tagged, 'MERGED'); git(REPO, 'push', '-q', 'origin', `${R.tagged}:refs/tags/rb-tagged`);
  // the newest PR of a reused branch name wins: an older merged one, a newer open one
  W.reused = wt('wt-reused'); pr(39, 'wt-reused', W.reused.sha, 'MERGED'); pr(40, 'wt-reused', W.reused.sha, 'OPEN');
  git(REPO, 'fetch', '-q', 'origin');
  // "GitHub" changes right after an ls-remote: origin's upload-pack runs the commands in RACE once, after it answers
  const RACE = path.join(T, 'race.sh'), fwd = (p) => p.replace(/\\/g, '/');
  write(path.join(T, 'upload-pack.sh'), 'git upload-pack "$@"\ns=$?\nif [ -f "$HK_RACE" ]; then c=$(cat "$HK_RACE"); rm -f "$HK_RACE"; eval "$c"; fi\nexit $s\n');
  git(REPO, 'config', 'remote.origin.uploadpack', `HK_RACE='${fwd(RACE)}' sh '${fwd(path.join(T, 'upload-pack.sh'))}'`);

  // ---------- the fake gh: every PR over several pages, like gh api graphql --paginate --jq ----------
  let capped = false;
  const ghCalls = [];
  const gh = async (args) => {
    ghCalls.push(args.join(' '));
    if (args.includes('graphql')) {
      const sorted = [...prs].sort((a, b) => a.number - b.number);
      const lines = [];
      for (let i = 0; i < sorted.length; i += 7) lines.push(JSON.stringify({ totalCount: sorted.length + (capped ? 5 : 0), nodes: sorted.slice(i, i + 7) }));
      return lines.join('\n') + '\n';
    }
    const a = args.find((x) => x.startsWith('repos/')) || '';
    if (a.startsWith('repos/test/repo/branches?protected=true')) return 'main\nrb-protected\n';
    if (a === 'repos/test/repo') return 'main\n';
    throw new Error('fake gh: no answer for ' + args.join(' '));
  };

  const live = new Set([W.live.path]);
  const logs = [];
  let sleeps = 0;
  const hk = createHousekeeping({
    repos: () => [{ root: REPO, github: 'test/repo' }],
    liveTops: () => live,
    codegraphBusy: (p) => path.resolve(p).toLowerCase() === W.cg.path.toLowerCase(),
    isQuiet: () => true,
    projectsDirs: () => [PROJECTS],
    dataDir: DATA, gh, log: (t) => logs.push(t), now: () => NOW,
    // the 30 s wait after "Invalid argument": the held file is let go instead
    sleep: async () => { sleeps++; if (holder) { holder.kill(); holder = null; } await new Promise((r) => setTimeout(r, 1500)); },
  });

  // ---------- the report ----------
  await hk.report({ fresh: true });
  const ids = {};
  const verdicts = () => {
    const v = hk.view();
    const r = v.repos[0];
    const by = {};
    for (const w of r.worktrees) by['wt:' + path.basename(w.path)] = w;
    for (const b of r.branches) by['br:' + b.name] = b;
    for (const b of r.remoteBranches) by['rb:' + b.name] = b;
    return { v, r, by };
  };
  let { v, r, by } = verdicts();
  for (const [k, x] of Object.entries(by)) ids[k] = x.id;
  hk.keep(ids['wt:wt-pinned'], true); hk.keep(ids['br:br-pinned'], true); hk.keep(ids['rb:rb-pinned'], true);
  ({ v, r, by } = verdicts());
  ok(v.at === NOW && v.busy === false && v.auto === false && v.error === null, `report header: ${JSON.stringify({ at: v.at, busy: v.busy, auto: v.auto, error: v.error })}`);
  ok(r.github === 'test/repo' && r.defaultBranch === 'main', 'repo github and default branch');
  const expect = {
    // worktrees
    'wt:repo': ['keep', /the main checkout/],
    'wt:wt-merged': ['remove', /PR #1 merged 9 days ago/],
    'wt:wt-prhead': ['remove', /PR #2 merged/],
    'wt:wt-dirty': ['ask', /uncommitted changes/],
    'wt:wt-untracked': ['ask', /uncommitted changes/],
    'wt:wt-unpushed': ['ask', /1 commit not pushed/],
    'wt:wt-locked': ['keep', /locked/],
    'wt:wt-live': ['keep', /Fleet View session is working here/],
    'wt:wt-codegraph': ['keep', /CodeGraph/],
    'wt:wt-convo': ['keep', /a session worked here 2 days ago/],
    'wt:wt-sub': ['keep', /a session worked here 1 day ago/],
    'wt:wt-open': ['keep', /PR #11 is open/],
    'wt:wt-nopr': ['keep', /no pull request/],
    'wt:wt-closed': ['remove', /PR #12 closed without merging/],
    'wt:wt-pinned': ['keep', /^kept by you$/],
    'wt:wt-junction': ['remove', /PR #14 merged/],
    'wt:wt-race': ['remove', /PR #15 merged/],
    'wt:wt-gitused': ['keep', /made or used by git 1 hour ago/],
    'wt:wt-held': ['remove', /PR #17 merged/],
    'wt:wt-inmain': ['remove', /its commits are in origin\/main/],
    'wt:wt-reused': ['keep', /PR #40 is open/],
    'wt:wt-outer': ['keep', /^another worktree is inside it \(inner\)$/],
    'wt:inner': ['keep', /has uncommitted changes/],
    'wt:wt-clone': ['remove', /PR #45 merged/],
    'wt:wt-stuck-cwd': ['remove', /PR #46 merged/],
    'wt:wt-stuck-file': ['remove', /PR #47 merged/],
    'wt:wt-gone': ['keep', /its folder is gone/],
    // local branches
    'br:main': ['keep', /the default branch/],
    'br:wt-dirty': ['keep', /checked out in worktree wt-dirty/],
    'br:br-inmain': ['remove', /its commits are in origin\/main/],
    'br:br-squash': ['remove', /PR #20 merged/],
    'br:br-moved': ['keep', /commits after merging PR #21/],
    'br:br-open': ['keep', /PR #22 is open/],
    'br:br-pinned': ['keep', /^kept by you$/],
    'br:br-closed': ['remove', /PR #23 closed without merging/],
    'br:br-nopr': ['keep', /no pull request/],
    // GitHub branches
    'rb:main': ['keep', /the default branch/],
    'rb:rb-merged': ['remove', /PR #30 merged/],
    'rb:rb-moved': ['keep', /moved after PR #31 was merged/],
    'rb:rb-open': ['keep', /PR #32 is open/],
    'rb:rb-base': ['keep', /open PR #34 merges into it/],
    'rb:rb-protected': ['keep', /protected on GitHub/],
    'rb:rb-closed': ['ask', /PR #36 closed without merging/],
    'rb:rb-pinned': ['keep', /^kept by you$/],
    'rb:rb-nopr': ['keep', /no pull request/],
    'rb:wt-merged': ['remove', /PR #1 merged/],
    'rb:rb-race': ['remove', /PR #41 merged/],
    'rb:rb-merged-2': ['remove', /PR #42 merged/],
    'rb:rb-lease': ['remove', /PR #43 merged/],
    'rb:rb-tagged': ['remove', /PR #44 merged/],
    'rb:wt-open': ['keep', /PR #11 is open/],
  };
  for (const [k, [verdict, re]] of Object.entries(expect)) {
    const x = by[k];
    ok(x && x.verdict === verdict && x.reasons.some((s) => re.test(s)), `${k}: want ${verdict} ${re}, got ${x ? `${x.verdict} ${JSON.stringify(x.reasons)}` : 'nothing'}`);
  }
  ok(by['wt:wt-prhead'].unpushed === 0 && by['wt:wt-unpushed'].unpushed === 1 && by['wt:wt-dirty'].dirty === true, 'dirty and unpushed fields');
  ok(by['wt:wt-pinned'].pinned === true && by['wt:wt-merged'].pinned === false, 'pinned field');
  ok(by['wt:wt-merged'].pr && by['wt:wt-merged'].pr.number === 1 && by['wt:wt-merged'].pr.state === 'MERGED' && by['wt:wt-merged'].pr.headSha === W.merged.sha, 'pr field');
  ok(by['wt:wt-convo'].lastActivity === Math.round(NOW - 2 * DAY) || Math.abs(by['wt:wt-convo'].lastActivity - (NOW - 2 * DAY)) < 2000, 'lastActivity of a recent conversation');
  ok(ids['wt:wt-merged'] === `wt:${REPO}|${W.merged.path}` && ids['br:br-squash'] === `br:${REPO}|br-squash` && ids['rb:rb-merged'] === `rb:${REPO}|rb-merged`, `id format: ${ids['wt:wt-merged']}`);
  const t = v.totals;
  const count = (vv) => r.worktrees.concat(r.branches, r.remoteBranches).filter((x) => x.verdict === vv).length;
  ok(t.remove === count('remove') && t.keep === count('keep') && t.ask === count('ask'), `totals ${JSON.stringify(t)}`);

  // ---------- the run ----------
  // the race: wt-race turns dirty after the report
  write(path.join(W.race.path, 'late.txt'), 'a session wrote this after the report');
  // and rb-race gets a new commit on GitHub
  R.race2 = commit('rb-race-2', R.race); git(REPO, 'push', '-q', 'origin', `${R.race2}:refs/heads/rb-race`);
  // the held index: CodeGraph's database is open, so git fails with "Invalid argument"; the test's sleep lets it go
  // a powershell that holds something until it is killed; resolves once it does
  const holdWith = async (name, script, cwd) => {
    const ready = path.join(T, `${name}.ready`);
    const p = spawn('powershell', ['-NoProfile', '-Command', `${script}; Set-Content -Path '${ready}' -Value 1; Start-Sleep 300`], { cwd, windowsHide: true, stdio: 'ignore' });
    stuck.push(p);
    for (let i = 0; i < 100 && !fs.existsSync(ready); i++) await new Promise((res) => setTimeout(res, 200));
    ok(fs.existsSync(ready), `${name} holds what it should`);
    return p;
  };
  const openFile = (f) => `$f=[System.IO.File]::Open('${f}','Open','ReadWrite','None')`;
  holder = await holdWith('held', openFile(path.join(W.held.path, '.codegraph', 'codegraph.db')));
  // these two are not let go by the wait: the removal stays partial
  const stuckCwd = await holdWith('stuck-cwd', '$null=1', W.scwd.path);
  const stuckFile = await holdWith('stuck-file', openFile(path.join(W.sfile.path, '.codegraph', 'codegraph.db')));
  // right after the run's ls-remote: rb-lease gets a new commit, rb-tagged is deleted (its tag stays)
  write(RACE, `git --git-dir="$1" update-ref refs/heads/rb-lease ${R.lease2} && git --git-dir="$1" update-ref -d refs/heads/rb-tagged\n`);

  const removeIds = [];
  for (const l of [r.worktrees, r.branches, r.remoteBranches]) for (const x of l) if (x.verdict === 'remove') removeIds.push(x.id);
  const refused = ['wt:wt-dirty', 'wt:wt-locked', 'rb:rb-closed', 'br:br-open', 'wt:wt-pinned', 'wt:repo', 'br:main', 'wt:wt-outer', 'wt:wt-gone'].map((k) => ids[k]);
  const results = await hk.run([...removeIds, ...refused, 'wt:Z:\\nowhere|Z:\\nowhere']);
  const res = new Map(results.map((x) => [x.id, x]));
  if (holder) { holder.kill(); holder = null; }
  ok(!fs.existsSync(RACE), 'the race ran right after the run\'s ls-remote');
  ok(sleeps === 3, `the 30 s wait happened for wt-held, wt-stuck-cwd and wt-stuck-file (${sleeps})`);
  // the nested worktree: the outer one is refused, the inner one and its work are untouched
  ok(res.get(ids['wt:wt-outer']).done === false && /another worktree is inside it/.test(res.get(ids['wt:wt-outer']).message), `outer: ${JSON.stringify(res.get(ids['wt:wt-outer']))}`);
  ok(fs.readFileSync(path.join(W.inner.path, 'wip.txt'), 'utf8') === 'work in progress\n' && /inner/.test(git(REPO, 'worktree', 'list')), 'inner: its folder, its work and its worktree are still there');
  // the clone inside: refused by the removal itself, nothing unlinked or deleted
  ok(res.get(ids['wt:wt-clone']).done === false && /a git checkout is inside it \(\.claude[\\/]sub\)/.test(res.get(ids['wt:wt-clone']).message), `clone: ${JSON.stringify(res.get(ids['wt:wt-clone']))}`);
  ok(fs.existsSync(path.join(W.clone.path, '.claude', 'sub', 'wip.txt')) && fs.existsSync(path.join(W.clone.path, 'wt-clone.txt')), 'clone: the worktree and the clone in it are untouched');
  // the partial ones: not removed, off git's list, logged as partial
  for (const k of ['scwd', 'sfile']) {
    const x = res.get(ids[`wt:${path.basename(W[k].path)}`]);
    ok(x.done === false && x.partial === true && /could not be deleted/.test(x.message), `${path.basename(W[k].path)} partial: ${JSON.stringify(x)}`);
    ok(fs.existsSync(W[k].path) && !git(REPO, 'worktree', 'list', '--porcelain').includes(path.basename(W[k].path)), `${path.basename(W[k].path)}: folder left, git no longer lists it`);
  }
  ok(fs.readdirSync(W.scwd.path).length === 0 && fs.existsSync(path.join(W.sfile.path, '.codegraph', 'codegraph.db')), 'stuck-cwd is empty, stuck-file still has the held file');
  // no repo-wide prune: the prunable worktree the report kept is still listed
  ok(/wt-gone[\s\S]*prunable/.test(git(REPO, 'worktree', 'list', '--porcelain')), 'wt-gone: still in git\'s list (nothing pruned it)');
  // the lease: the moved branch is refused, the deleted one is "already gone", and its tag survives
  ok(res.get(ids['rb:rb-lease']).done === false && /moved on GitHub since it was checked/.test(res.get(ids['rb:rb-lease']).message), `lease: ${JSON.stringify(res.get(ids['rb:rb-lease']))}`);
  ok(git(ORIGIN, 'rev-parse', 'refs/heads/rb-lease') === R.lease2, 'lease: GitHub keeps the commit pushed after the check');
  ok(res.get(ids['rb:rb-tagged']).done === false && res.get(ids['rb:rb-tagged']).message === 'already gone from GitHub', `tagged: ${JSON.stringify(res.get(ids['rb:rb-tagged']))}`);
  ok(git(ORIGIN, 'rev-parse', 'refs/tags/rb-tagged') === R.tagged, 'tagged: the tag of the same name is still on GitHub');
  for (const k of refused) ok(res.get(k) && res.get(k).done === false, `${k} refused by run: ${JSON.stringify(res.get(k))}`);
  ok(res.get('wt:Z:\\nowhere|Z:\\nowhere').message === 'not in the report', 'an id not in the report is refused');
  ok(res.get(ids['wt:wt-race']).done === false && /uncommitted/.test(res.get(ids['wt:wt-race']).message), `race: ${JSON.stringify(res.get(ids['wt:wt-race']))}`);
  ok(fs.existsSync(path.join(W.race.path, 'late.txt')) && git(REPO, 'worktree', 'list').includes('wt-race'), 'race: the worktree is still there');
  ok(res.get(ids['rb:rb-race']).done === false && /moved after PR #41/.test(res.get(ids['rb:rb-race']).message), `remote race: ${JSON.stringify(res.get(ids['rb:rb-race']))}`);
  ok(git(ORIGIN, 'rev-parse', 'refs/heads/rb-race') === R.race2, 'remote race: GitHub still has the new commit');
  const gone = ['wt:wt-merged', 'wt:wt-prhead', 'wt:wt-closed', 'wt:wt-junction', 'wt:wt-held', 'wt:wt-inmain', 'br:br-inmain', 'br:br-squash', 'br:br-closed', 'rb:rb-merged', 'rb:wt-merged', 'rb:rb-merged-2'];
  for (const k of gone) ok(res.get(ids[k]) && res.get(ids[k]).done === true, `${k} removed: ${JSON.stringify(res.get(ids[k]))}`);
  const wtList = git(REPO, 'worktree', 'list', '--porcelain');
  for (const k of ['merged', 'prhead', 'closed', 'junction', 'held', 'inmain']) ok(!fs.existsSync(W[k].path) && !wtList.includes(`wt-${k}\n`), `wt-${k}: folder and worktree gone`);
  for (const k of ['dirty', 'untracked', 'unpushed', 'locked', 'live', 'cg', 'convo', 'sub', 'open', 'nopr', 'pinned', 'gitused', 'reused', 'outer', 'inner', 'clone']) ok(fs.existsSync(W[k].path), `${W[k].path} kept`);
  // the junction: the shared folder and its file are still there
  ok(fs.existsSync(path.join(SHARED, 'keep.txt')) && fs.readFileSync(path.join(SHARED, 'keep.txt'), 'utf8') === 'shared install\n', 'junction: the shared folder survived');
  const heads = git(REPO, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split(/\r?\n/);
  for (const b of ['br-inmain', 'br-squash', 'br-closed']) ok(!heads.includes(b), `${b} deleted`);
  for (const b of ['main', 'br-moved', 'br-open', 'br-pinned', 'br-nopr', 'wt-dirty', 'wt-merged']) ok(heads.includes(b), `${b} kept`);
  const remoteHeads = git(ORIGIN, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split(/\r?\n/);
  for (const b of ['rb-merged', 'wt-merged', 'rb-merged-2']) ok(!remoteHeads.includes(b), `GitHub ${b} deleted`);
  for (const b of ['main', 'rb-moved', 'rb-open', 'rb-base', 'rb-protected', 'rb-closed', 'rb-pinned', 'rb-nopr', 'wt-open', 'rb-race']) ok(remoteHeads.includes(b), `GitHub ${b} kept`);
  ok(!git(REPO, 'config', '--list').includes('branch.br-squash.'), 'br-squash: its config section went with it');

  // ---------- the log ----------
  const entries = hk.log();
  const done = results.filter((x) => x.done);
  ok(entries.length === done.length + 2, `one log line per removal, partial ones too (${entries.length} vs ${done.length} + 2)`);
  const entry = (kind, name) => entries.find((e) => e.kind === kind && e.name === name);
  const ej = entries.find((e) => e.kind === 'worktree' && e.path === W.junction.path);
  ok(ej && ej.name === 'wt-junction' && ej.sha === W.junction.sha && ej.pr === 14 && ej.repo === REPO && ej.at === NOW && /^[0-9a-f]{16}$/.test(ej.id), `worktree log entry ${JSON.stringify(ej)}`);
  ok(ej && Array.isArray(ej.links) && ej.links.length === 1 && ej.links[0].path === path.join(W.junction.path, 'node_modules') && path.resolve(ej.links[0].target) === SHARED && ej.links[0].isDir === true, `the junction is in the log entry: ${JSON.stringify(ej && ej.links)}`);
  ok(!('partial' in ej), 'a full removal is not marked partial');
  for (const k of ['scwd', 'sfile']) { const e = entry('worktree', path.basename(W[k].path)); ok(e && e.partial === true && e.sha === W[k].sha, `${path.basename(W[k].path)}: logged as partial ${JSON.stringify(e)}`); }
  const es = entry('branch', 'br-squash');
  ok(es && es.sha === B.squash && es.pr === 20 && es.path === null, `branch log entry ${JSON.stringify(es)}`);
  const er = entry('remote', 'rb-merged');
  ok(er && er.sha === R.merged && er.pr === 30, `remote log entry ${JSON.stringify(er)}`);
  ok(fs.readFileSync(path.join(DATA, 'housekeeping', 'log.jsonl'), 'utf8').trim().split('\n').length === entries.length, 'log.jsonl has one JSON line each');
  const prefs = JSON.parse(fs.readFileSync(path.join(DATA, 'housekeeping', 'prefs.json'), 'utf8'));
  // failed: wt-clone, the two partial ones and rb-lease ("already gone" is not a failure)
  ok(prefs.lastRun && prefs.lastRun.removed === done.length && prefs.lastRun.failed === 4 && prefs.pins.length === 3, `prefs: ${JSON.stringify(prefs)}`);

  // ---------- restore ----------
  // br-squash's commit was only on its branch and GitHub's refs/pull/20/head: after a gc it is gone here
  git(REPO, 'reflog', 'expire', '--expire-unreachable=now', '--all');
  git(REPO, 'gc', '-q', '--prune=now');
  ok(tryGit(REPO, 'cat-file', '-e', `${B.squash}^{commit}`).status !== 0, 'br-squash commit gone after gc');
  await hk.report(); // let the report the run started finish
  // the held file is let go now; the working folder stays in use (git adds into the empty folder anyway)
  await stop(stuckFile);
  const said = {};
  for (const e of entries) {
    const rr = await hk.restore(e.id);
    said[e.path || e.name] = rr.message;
    ok(rr.ok, `restore ${e.kind} ${e.name || e.path}: ${rr.message}`);
  }
  const wtList2 = git(REPO, 'worktree', 'list', '--porcelain');
  for (const k of ['merged', 'prhead', 'closed', 'junction', 'held', 'inmain', 'scwd', 'sfile']) {
    ok(fs.existsSync(W[k].path) && git(W[k].path, 'rev-parse', 'HEAD') === W[k].sha && wtList2.includes(path.basename(W[k].path)), `${path.basename(W[k].path)} restored at its commit`);
  }
  // the junction is made again, to the same shared folder
  const nm = path.join(W.junction.path, 'node_modules');
  ok(fs.lstatSync(nm).isSymbolicLink() && fs.readFileSync(path.join(nm, 'keep.txt'), 'utf8') === 'shared install\n' && /put back 1 link to outside folders/.test(said[W.junction.path]), `junction put back: ${said[W.junction.path]}`);
  // what the partial removal left was moved aside, not deleted
  const aside = fs.readdirSync(WTS).find((n) => n.startsWith('wt-stuck-file.leftover-'));
  ok(aside && fs.existsSync(path.join(WTS, aside, '.codegraph', 'codegraph.db')) && said[W.sfile.path].includes(path.join(WTS, aside)), `stuck-file leftovers moved aside: ${said[W.sfile.path]}`);
  await stop(stuckCwd);
  ok(git(REPO, 'rev-parse', 'refs/heads/br-squash') === B.squash, 'br-squash restored (its commit fetched from refs/pull/20/head)');
  ok(git(REPO, 'rev-parse', 'refs/heads/br-inmain') === B.inmain && git(REPO, 'rev-parse', 'refs/heads/br-closed') === B.closed, 'br-inmain and br-closed restored');
  ok(git(ORIGIN, 'rev-parse', 'refs/heads/rb-merged') === R.merged && git(ORIGIN, 'rev-parse', 'refs/heads/wt-merged') === W.merged.sha && git(ORIGIN, 'rev-parse', 'refs/heads/rb-merged-2') === R.merged2, 'GitHub branches restored');
  ok(hk.log().every((e) => e.restoredAt === NOW), 'every log entry marked restored');
  ok((await hk.restore(entries[0].id)).message === 'already restored', 'a second restore is refused');
  ok(fs.existsSync(path.join(SHARED, 'keep.txt')), 'the shared folder is still there at the end');

  // ---------- the routes ----------
  await hk.report();
  const call = (method, pathname, body, remote = false) => new Promise((resolve) => {
    const res = {};
    const h = { sendJson: (_r, code, o) => resolve({ code, o }), readBody: (_q, _r, cb) => cb(body === undefined ? {} : body), remote: () => (remote ? { name: 'mac' } : null) };
    // the request as a stream: the run route reads its own body
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method = method;
    hk.handle(req, res, pathname, h);
  });
  for (const [p, b] of [['/housekeeping/run', { ids: [ids['wt:wt-merged']] }], ['/housekeeping/restore', { id: entries[0].id }], ['/housekeeping/auto', { on: true }]]) {
    const x = await call('POST', p, b, true);
    ok(x.code === 403 && x.o.ok === false && x.o.message === 'only on the PC', `${p} from another device: ${JSON.stringify(x)}`);
  }
  const g = await call('GET', '/housekeeping');
  ok(g.code === 200 && ['at', 'busy', 'auto', 'lastRun', 'error', 'repos', 'totals'].every((k) => k in g.o), `GET /housekeeping keys: ${Object.keys(g.o)}`);
  const rk = g.o.repos[0];
  ok(['root', 'name', 'github', 'defaultBranch', 'worktrees', 'branches', 'remoteBranches'].every((k) => k in rk) && Object.keys(rk).length === 7, `repo keys: ${Object.keys(rk)}`);
  ok(Object.keys(rk.worktrees[0]).sort().join() === 'branch,dirty,id,lastActivity,path,pinned,pr,reasons,unpushed,verdict', `worktree keys: ${Object.keys(rk.worktrees[0])}`);
  ok(Object.keys(rk.branches[0]).sort().join() === 'id,lastCommit,name,pinned,pr,reasons,tip,verdict', `branch keys: ${Object.keys(rk.branches[0])}`);
  ok(Object.keys(rk.remoteBranches[0]).sort().join() === 'id,lastCommit,name,pinned,pr,reasons,tip,verdict', `remote keys: ${Object.keys(rk.remoteBranches[0])}`);
  const k1 = await call('POST', '/housekeeping/keep', { id: ids['br:br-nopr'], on: true });
  ok(k1.code === 200 && k1.o.ok === true, 'keep route');
  ok(verdicts().by['br:br-nopr'].reasons[0] === 'kept by you', 'a pin shows at once');
  await call('POST', '/housekeeping/keep', { id: ids['br:br-nopr'], on: false });
  const a1 = await call('POST', '/housekeeping/auto', { on: true });
  ok(a1.code === 200 && a1.o.auto === true && hk.view().auto === true, 'auto on');
  await call('POST', '/housekeeping/auto', { on: false });
  const lg = await call('GET', '/housekeeping/log');
  ok(lg.code === 200 && Array.isArray(lg.o.entries) && lg.o.entries.length === entries.length, 'GET /housekeeping/log');
  const bad = await call('POST', '/housekeeping/run', { ids: 'x' });
  ok(bad.code === 400 && bad.o.ok === false, 'run with bad ids is a 400');
  // a long list of ids (well over the server's usual 64 KB body) is read whole; none of these is in the report
  const many = Array.from({ length: 3000 }, (_, i) => `br:${REPO}|nothing-${i}-${'x'.repeat(40)}`);
  const big = await call('POST', '/housekeeping/run', { ids: many });
  ok(big.code === 200 && big.o.results.length === 3000 && big.o.results.every((x) => !x.done && x.message === 'not in the report'), `a run with 3000 ids: ${big.code} ${big.o.results ? big.o.results.length : JSON.stringify(big.o)}`);
  await hk.report();
  const rf = await call('POST', '/housekeeping/refresh');
  ok(rf.code === 200 && rf.o.ok === true && rf.o.busy === true, 'refresh route');
  await hk.report();

  // ---------- PRs that did not all come back: nothing in the repo is removed ----------
  capped = true;
  await hk.report({ fresh: true });
  const cv = hk.view();
  ok(cv.totals.remove === 0 && /of \d+ pull requests/.test(cv.error || '') && logs.some((l) => /only \d+ of \d+ pull requests/.test(l)), `capped PR list keeps everything: ${JSON.stringify(cv.totals)} ${cv.error}`);
  capped = false;
  ok(ghCalls.some((c) => c.includes('--paginate') && c.includes('graphql')), 'PRs read with --paginate');

  // ---------- a log that cannot be written: the run says so for each item and goes on ----------
  git(REPO, 'branch', 'br-nolog', B.inmain);
  const DATA3 = path.join(T, 'data3');
  fs.mkdirSync(path.join(DATA3, 'housekeeping', 'log.jsonl'), { recursive: true }); // a folder: every append fails
  const hk3 = createHousekeeping({ repos: () => [{ root: REPO, github: 'test/repo' }], liveTops: () => [], codegraphBusy: () => false, isQuiet: () => true,
    projectsDirs: () => [PROJECTS], dataDir: DATA3, gh, log: () => {}, now: () => NOW, sleep: async () => {} });
  await hk3.report({ fresh: true });
  const nl = await hk3.run([`br:${REPO}|br-nolog`, `br:${REPO}|br-inmain`]);
  ok(nl.length === 2 && nl.every((x) => x.done === true && /the log line could not be written/.test(x.message)), `a failed log write never stops the run: ${JSON.stringify(nl)}`);
  await hk3.report();

  // ---------- the nightly clean-up: only between 02:00 and 05:00, when switched on and quiet ----------
  const night = createHousekeeping({ repos: () => [], dataDir: path.join(T, 'data2'), gh, isQuiet: () => true, now: () => new Date(2026, 9, 10, 3, 0).getTime(), log: () => {} });
  await night.tick();
  ok(!fs.existsSync(path.join(T, 'data2', 'housekeeping', 'prefs.json')) || !JSON.parse(fs.readFileSync(path.join(T, 'data2', 'housekeeping', 'prefs.json'), 'utf8')).lastNightly, 'nightly does nothing while off');
  night.setAuto(true);
  await night.tick();
  ok(JSON.parse(fs.readFileSync(path.join(T, 'data2', 'housekeeping', 'prefs.json'), 'utf8')).lastNightly === '2026-10-10', 'nightly ran at 03:00 when on');
}

main().catch((e) => { failures++; console.log(`FAIL ${e.stack || e.message}`); }).finally(async () => {
  await Promise.all(stuck.map(stop));
  console.log(`${passes} passed, ${failures} failed${process.env.HK_TEST_KEEP ? ` (kept ${T})` : ''}`);
  if (!process.env.HK_TEST_KEEP) {
    // unlock first: a locked worktree's folder is ordinary files, but be tidy
    try { fs.rmSync(T, { recursive: true, force: true, maxRetries: 5 }); } catch (e) { console.log(`could not delete ${T}: ${e.message}`); }
  }
  process.exit(failures ? 1 : 0);
});
