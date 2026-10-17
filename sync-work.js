// sync-work.js: a chat's unfinished work, carried with it when it moves to another machine (docs/sync-follow.md item 3,
// "What a move carries" 2). A move (sync-move.js) carries the conversation; this file carries the code the chat was
// changing: the branch and its commits that origin lacks, the staged and unstaged changes, and the files git does not
// track yet. It is a library: no loop, no timer, no network but `git fetch origin`, nothing sealed or uploaded (the
// mover seals what pack() gives and lays down what it got). Not wired into moves yet (a later part of the plan).
//
//   inspect(cwd, o)   -> { kind, why, git, exists, root, mainRoot, origin, branch, head, rel, worktree, dirty }
//   pack(cwd, o)      -> { manifest, blobs }               (throws a WorkError when it won't carry the folder)
//   unpack(manifest, blobs, { root, into, fetch, home }) -> { cwd, into, branch, notes, made, undo }
//   undo(unpack's result)  -> what it laid down goes again (a move that failed after it)
//   verify(cwd, manifest, o) -> { ok, diffs }
//   putAway(cwd, note) -> the stash commit's sha, or null when there was nothing to put away
//
// inspect: what a chat's folder is, by sync-common.js's rule (workspaceKind, the uploader's and /state's too, with the
//   same why texts). kind 'portable': a git checkout whose origin normalizes (normalizeOrigin, the same remote sync's
//   repos rows name), or a folder under the home folder in no git checkout (sync's home row: a scratchpad, a bot's
//   folder). 'bound', with why: everything else: a placeholder for another machine's folder, a git checkout with no
//   origin, a folder outside the home folder, an app data or Claude account folder, the home folder itself, or a
//   Perforce workspace (sync-common.js perforceAt; the client root `p4 info` gives, p4ClientRoots). root: the git
//   top level (a linked worktree's own folder), or the home folder for a plain folder; mainRoot: the main checkout's
//   top level; rel: cwd from root, with '/'; worktree: the linked worktree's folder name, else null; branch: null when
//   HEAD is detached; head: null before the first commit; dirty: `git status` lists anything. o.home: the home folder
//   (os.homedir()); o.p4Roots: the Perforce client roots (tests; otherwise sync-common.js p4ClientRoots).
//
// pack: the manifest (plain JSON) and the blobs it names (a Map from each blob's sha256, in hex, to its bytes).
//   { v: 1, kind: 'git', origin, branch, head, base, bundle, bundleRef, staged, unstaged, trees: { index, work },
//     untracked: [{ path, mode, size, sha256 }], env: [path], rel, worktree, summary: { commits, files, bytes }, notes }
//   base: the merge-base of HEAD and the origin's branch (its upstream on origin, else origin/<branch>, else
//   origin/HEAD), or null. bundle: a git bundle of the commits no refs/remotes/origin/* has (bundleRef: refs/heads/<branch>,
//   or HEAD when detached), or null when there are none. staged: `git diff --cached`, unstaged: `git diff`, both
//   --binary --full-index with renames, a/ b/ prefixes and no external diff or textconv whatever the machine's config
//   says, or null when empty. trees: the tree ids of the index (`git write-tree` on a copy of it, so a pack never
//   takes index.lock from a git command the chat runs meanwhile) and of the working tree's tracked files (the same
//   through a copy of the index after `git add -u`): git's own view of the files, after its clean
//   filters, so CRLF on one machine and LF on the other compare equal. untracked: `git ls-files --others
//   --exclude-standard` (what this machine ignores stays), as mode 100644, 100755 or 120000 (a symlink: its target
//   is the blob), never a file or folder named .env or .env.* (any case): those are listed by path in env and travel
//   as secrets (item 4), and a folder that is a git repository of its own (named in notes). Refused (WorkError code
//   'refused') for: a folder that is bound; a checkout with no commit; a merge, rebase, cherry-pick or revert under
//   way; a changed submodule (a gitlink in either diff); a changed or new file git-lfs tracks (check-attr filter=lfs);
//   and over the cap (o.cap, 200 MB in all). o.stay: [globs] (host-rules.js) of files that stay on this machine,
//   tracked or not, staged or not: left out of the diffs, the trees and the untracked files (the other side has them
//   as HEAD does), named in a note, and the first 100 in the result's stayed.
//   kind 'plain' (a home-row folder): every file under it (no node_modules, no .git, no env files) as untracked, the
//   rest of the git fields null; at most 20,000 files.
//
// unpack: root is this machine's checkout of the same origin (refused when its origin is another). Every blob's
//   sha256 is checked first. Then `git fetch origin` (o.fetch false skips it; a failure, say offline, is only a note,
//   as long as what the work needs is here), the bundle (`git bundle verify`, then fetched into
//   refs/fleet-view/incoming/<head>, which keeps its commits whatever happens to the branch), and head must be here.
//   Where it goes: into (default <mainRoot>/.claude/worktrees/<manifest.worktree, else fv-<branch>>), which is
//   - a worktree of root already (the main checkout too) that is clean, on the same branch (or detached) at head or
//     behind it: used in place, fast-forwarded (`git merge --ff-only`); the chat's own worktree under .claude/worktrees
//     on another branch is switched over (it is clean);
//   - else a new worktree (`git worktree add`): the branch made at head when this machine has none, moved to head
//     when it is behind (no commit is lost), and when it has commits head lacks, a new branch <branch>-moved-<short>
//     instead (the old one untouched, said in notes); a branch another worktree has checked out is never moved: the
//     new worktree is detached at head, with a note.
//   A dirty checkout is never touched: a used or dirty into gives way to a new worktree beside it (<name>-2, ...).
//   Then the staged diff (`git apply --index`), the unstaged one (`git apply`), and the untracked files with their
//   modes, symlinks last and never a file through a symlink (a symlink Windows refuses is written as a file holding
//   its target, with a note). A new worktree under
//   .claude/worktrees gets that folder in .git/info/exclude when nothing ignores it yet. Last, verify(): any
//   difference undoes what unpack made (the new worktree and a branch it made; a worktree used in place goes back
//   to its commit, clean) and throws. -> { cwd (into + rel), into, branch (null when detached), notes }.
//   kind 'plain': into is the folder to fill (default <o.home>/<rel>); a file there already must be the same bytes,
//   else nothing is written and it throws.
//
// verify: head, both tree ids, and each untracked file (its bytes, and on macOS and Linux its mode) as the manifest
//   says; a file untracked here and not in the manifest is a difference too (ignored ones are not looked at).
//   -> { ok, diffs: [text] }.
// putAway: `git stash push --include-untracked -m <note>` over the whole checkout, never env files, o.keep's paths or
//   o.stay's globs (they stay where they are); nothing is deleted. -> the stash commit's sha, or null.
//
// Every git call runs with no shell, no window, a time limit, core.hooksPath pointed at nothing (a worktree add or a
// fast-forward must not run the repo's hooks: the PC's main checkout publishes on post-merge), GIT_TERMINAL_PROMPT=0
// and GIT_OPTIONAL_LOCKS=0. Errors are WorkError { code: 'refused' | 'git' | 'missing' | 'conflict' | 'verify' }.
// Tests: node scripts/sync-carry-test.js.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const P = require(path.join(__dirname, 'platform.js'));
const C = require(path.join(__dirname, 'sync-common.js'));
const HR = require(path.join(__dirname, 'host-rules.js'));

const CAP = 200 * 1024 * 1024; // the most one pack carries in all
const PLAIN_FILES = 20000; // files in a plain (home-row) folder
const GIT_MS = 60e3, FETCH_MS = 120e3, BUNDLE_MS = 300e3;
// core.hooksPath for every call: a folder that holds no hooks (under /dev/null nothing can exist; on Windows a
// random folder nobody made)
const NULL_HOOKS = P.isWin ? path.join(os.tmpdir(), `fleet-view-no-hooks-${crypto.randomBytes(8).toString('hex')}`) : '/dev/null';
const ENV_RE = /^\.env(?:\..*)?$/i; // .env, .env.local, .env.production: never in a pack
const PLAIN_SKIP = new Set(['node_modules', '.git']);
const HEX40 = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/; // a SHA-1 or SHA-256 object id
const HEX64 = /^[0-9a-f]{64}$/;
const MODES = new Set(['100644', '100755', '120000']);
// git diff's output, the same on every machine whatever its config (applied with git apply, so a/ b/ prefixes)
const DIFF = ['-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false', '-c', 'diff.relative=false', 'diff',
  '--binary', '--full-index', '--no-color', '--no-ext-diff', '--no-textconv', '-M', '--src-prefix=a/', '--dst-prefix=b/'];

class WorkError extends Error {
  constructor(message, code, extra) { super(message); this.name = 'WorkError'; this.code = code; if (extra) Object.assign(this, extra); }
}
const refused = (m) => new WorkError(m, 'refused');
const clip = (s, n = 300) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const short = (h) => String(h || '').slice(0, 8);
const realOr = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const lst = (p) => { try { return fs.lstatSync(p); } catch { return null; } };
// a symlink's target in git's form: Windows stores 'src/app.js' as 'src\app.js', so read it back with '/' (as git does),
// else a link carried from the PC would point nowhere on the Mac
const linkTarget = (p) => { const t = fs.readlinkSync(p); return P.isWin ? t.replace(/\\/g, '/') : t; };
const sameDir = (a, b) => !!a && !!b && P.foldCase(path.resolve(realOr(a))) === P.foldCase(path.resolve(realOr(b)));
const isEnvName = (seg) => ENV_RE.test(seg);
const envPath = (rel) => rel.split('/').some(isEnvName);
// p relative to base with '/', '' for base itself; null when p is not under base
function inside(base, p) {
  const rel = path.relative(base, p);
  if (rel === '') return '';
  if (rel.split(path.sep)[0] === '..' || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}
const fromRel = (base, rel) => (rel ? path.join(base, ...rel.split('/')) : base);
function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'fv-work-')); }
const rmTmp = (d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} };

// ---------- git ----------
// -> { ok, code, out (Buffer), err (text), over (stdout passed o.maxBuffer) }; never throws
function runGit(cwd, args, o = {}) {
  return new Promise((resolve) => {
    const ms = o.timeout || GIT_MS, max = o.maxBuffer || 64 * 1024 * 1024;
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...(o.env || {}) };
    let child, done = false, over = false, len = 0, errs = '';
    const outs = [];
    const finish = (code, msg) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: code === 0 && !over, code, over, out: Buffer.concat(outs), err: clip(msg || errs, 2000) });
    };
    const timer = setTimeout(() => { errs += ` (git ${args.find((a) => !a.startsWith('-') && !a.includes('=')) || ''} timed out after ${Math.round(ms / 1000)} s)`; try { child && child.kill(); } catch {} }, ms);
    try {
      child = spawn('git', ['-c', `core.hooksPath=${NULL_HOOKS}`, ...args], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { finish(-1, String((e && e.message) || e)); return; }
    child.stdout.on('data', (d) => { len += d.length; if (len > max) { if (!over) { over = true; try { child.kill(); } catch {} } } else outs.push(d); });
    child.stderr.on('data', (d) => { if (errs.length < 8000) errs += d.toString('utf8'); });
    child.on('error', (e) => finish(-1, String((e && e.message) || e)));
    child.on('close', (code) => finish(code === null ? -1 : code));
    child.stdin.on('error', () => {});
    child.stdin.end(o.input == null ? undefined : o.input);
  });
}
async function git(cwd, args, o = {}) {
  const r = await runGit(cwd, args, o);
  if (r.over) throw refused(o.overMessage || 'more than the cap to carry');
  if (!r.ok) throw new WorkError(`git ${args.filter((a) => !a.startsWith('-')).slice(0, 2).join(' ')} failed: ${clip(r.err) || `exit ${r.code}`}`, 'git');
  return r.out;
}
const text = (b) => b.toString('utf8').trim();
async function gitText(cwd, args, o) { return text(await git(cwd, args, o)); }
async function maybe(cwd, args, o) { const r = await runGit(cwd, args, o); return r.ok ? text(r.out) || null : null; }
const zList = (b) => b.toString('utf8').split('\0').filter(Boolean);
// what `git status` lists in a checkout, but an untracked env file (never carried, never in the way): [entry], or
// null when git could not say
async function changesIn(dir) {
  const r = await runGit(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']);
  if (!r.ok) return null;
  const t = zList(r.out), out = [];
  for (let i = 0; i < t.length; i++) {
    const e = t[i];
    if (/^[RC]/.test(e)) i++; // a rename's or copy's old path follows
    if (e.startsWith('?? ') && envPath(e.slice(3).replace(/\/$/, ''))) continue;
    out.push(e);
  }
  return out;
}

// ---------- inspect ----------
// The kind and its why are sync-common.js's (workspaceKind: the one rule the uploader and /state use too); this adds
// the git facts a pack needs.
async function inspect(cwd, o = {}) {
  const home = path.resolve(realOr(o.home || os.homedir()));
  const want = path.resolve(realOr(path.resolve(cwd)));
  const out = { kind: 'bound', why: null, git: false, exists: isDir(want), root: null, mainRoot: null, origin: null,
    branch: null, head: null, rel: null, worktree: null, dirty: false };
  const top = out.exists ? await maybe(want, ['rev-parse', '--show-toplevel']) : null;
  if (top) {
    out.git = true;
    out.root = path.resolve(realOr(top));
    const common = await maybe(want, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    out.mainRoot = common ? path.resolve(realOr(path.dirname(path.resolve(common)))) : out.root;
    if (!sameDir(out.mainRoot, out.root)) out.worktree = path.basename(out.root);
    out.origin = C.normalizeOrigin(await maybe(want, ['remote', 'get-url', 'origin']));
    out.branch = await maybe(want, ['symbolic-ref', '-q', '--short', 'HEAD']);
    out.head = await maybe(want, ['rev-parse', '-q', '--verify', 'HEAD^{commit}']);
    out.rel = inside(out.root, want) || '';
    const ch = await changesIn(out.root);
    out.dirty = !!ch && ch.length > 0;
  }
  const roots = Array.isArray(o.p4Roots) ? o.p4Roots : await C.p4ClientRoots();
  const perforce = !out.git && !!C.perforceAt(want, { home, roots });
  const k = C.workspaceKind({ cwd: want, git: out.git, origin: out.origin, perforce, home });
  if (!k) { out.why = 'not a folder of this machine'; return out; }
  out.kind = k.kind;
  out.why = k.why;
  // a plain folder under home (the home row): its root is the home folder
  if (!out.git && k.kind === 'portable') Object.assign(out, { root: home, mainRoot: home, origin: C.HOME_ORIGIN, rel: inside(home, want) });
  return out;
}

// ---------- pack ----------
// the blobs and their running total, against the cap
function blobBag(cap) {
  const blobs = new Map();
  let bytes = 0;
  return {
    blobs,
    get bytes() { return bytes; },
    room(n, what) { if (bytes + n > cap) throw refused(`${what} would take this past the ${Math.round(cap / 1048576) || cap} MB a move carries`); },
    add(buf, what) { this.room(buf.length, what); bytes += buf.length; const h = sha(buf); blobs.set(h, buf); return h; },
  };
}
// a file or symlink as an untracked entry (the blob added), or null when it is neither
function fileEntry(bag, abs, rel) {
  const st = lst(abs);
  if (!st) return null;
  let buf, mode;
  if (st.isSymbolicLink()) { buf = Buffer.from(linkTarget(abs), 'utf8'); mode = '120000'; } else if (st.isFile()) {
    bag.room(st.size, rel);
    buf = fs.readFileSync(abs);
    mode = !P.isWin && (st.mode & 0o111) ? '100755' : '100644';
  } else return null;
  return { path: rel, mode, size: buf.length, sha256: bag.add(buf, rel) };
}
// the paths a raw diff (-z, no renames) names, and whether any is a gitlink (a submodule)
function rawPaths(b) {
  const t = zList(b), paths = [];
  let gitlink = false;
  for (let i = 0; i < t.length; i++) {
    if (t[i][0] !== ':') continue;
    const f = t[i].slice(1).split(' ');
    if (f[0] === '160000' || f[1] === '160000') gitlink = true;
    if (i + 1 < t.length) paths.push(t[++i]);
  }
  return { paths, gitlink };
}
async function underway(root) {
  for (const [name, what] of [['MERGE_HEAD', 'a merge'], ['rebase-merge', 'a rebase'], ['rebase-apply', 'a rebase or git am'], ['CHERRY_PICK_HEAD', 'a cherry-pick'], ['REVERT_HEAD', 'a revert']]) {
    const p = await maybe(root, ['rev-parse', '--path-format=absolute', '--git-path', name]);
    if (p && lst(p)) return what;
  }
  return null;
}
// the tree id of the working tree's tracked files, as git sees them (a copy of the index, git add -u, write-tree).
// stay: { pick, skip } pathspecs of the files that stay on this machine (stayOf): those are as HEAD has them, never
// carried, in the index's tree (index: true, no add) and the working tree's alike
async function workTree(root, stay = null, index = false) {
  const idx = await gitText(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
  const d = tmpDir(), copy = path.join(d, 'index');
  try {
    // no index yet (nothing ever added): an empty one; one that is there but did not copy fails the pack, never an
    // empty tree that looks like every file was deleted
    try { fs.copyFileSync(idx, copy); } catch (e) { if (fs.existsSync(idx)) throw new WorkError(`the index could not be read (${clip(e && e.message)})`, 'git'); }
    // the copy keeps the index's mtime (to the ms, never later): git trusts a file's stat only when the file is older
    // than the index file (racy git), and a copy stamped now took a file edited in the index's own second, the same
    // size, for unchanged where git's diff saw the edit (git without nanosecond times, as on macOS)
    try { const st = fs.statSync(idx); fs.utimesSync(copy, st.atime, st.mtime); } catch {}
    const env = { GIT_INDEX_FILE: copy };
    if (stay) await git(root, ['reset', '-q', 'HEAD', '--', ...stay.pick], { env });
    if (!index) await git(root, ['add', '-u', '--', ':/', ...(stay ? stay.skip : [])], { env });
    return await gitText(root, ['write-tree'], { env });
  } finally { rmTmp(d); }
}
async function upstreamOf(root, branch) {
  if (branch) {
    const u = await maybe(root, ['rev-parse', '--symbolic-full-name', `${branch}@{upstream}`]);
    if (u && u.startsWith('refs/remotes/origin/')) return u;
    if (await maybe(root, ['rev-parse', '-q', '--verify', `refs/remotes/origin/${branch}`])) return `refs/remotes/origin/${branch}`;
  }
  return (await maybe(root, ['rev-parse', '-q', '--verify', 'refs/remotes/origin/HEAD'])) ? 'refs/remotes/origin/HEAD' : null;
}
// untracked, unignored files: (entries, env paths, notes) into the bag; stay (stayOf): the files that stay on this
// machine are left out, never in the bag, so they count nothing against the cap
async function untrackedOf(root, bag, notes, env, stay) {
  const list = [];
  for (const rel of zList(await git(root, ['ls-files', '--others', '--exclude-standard', '-z', ...(stay ? ['--', ':/', ...stay.skip] : [])]))) {
    if (rel.endsWith('/')) { notes.push(`not carried: ${rel} (a git repository of its own)`); continue; }
    if (envPath(rel)) { env.push(rel); continue; }
    const e = fileEntry(bag, fromRel(root, rel), rel);
    if (e) list.push(e);
  }
  return list;
}

async function pack(cwd, o = {}) {
  const cap = Number(o.cap) > 0 ? Number(o.cap) : CAP;
  const info = await inspect(cwd, o);
  if (info.kind !== 'portable') throw refused(`this folder stays on this machine: ${info.why}`);
  if (!info.git) return packPlain(info, cap);
  if (!info.head) throw refused('this checkout has no commit yet');
  const root = info.root, notes = [], env = [];
  const busy = await underway(root);
  if (busy) throw refused(`${busy} is under way here: finish it or abort it first`);
  const bag = blobBag(cap);

  // o.stay: [globs] of the files that stay on this machine (fleet-view.js stays-on rules, host-rules.js), tracked or
  // not, staged or not: left out of everything below as git pathspecs (git's own matching, so the put-away after a
  // move leaves exactly these), and named in a note
  const stay = stayOf(o.stay);
  const only = stay ? ['--', ':/', ...stay.skip] : [];
  const stayed = stay ? await stayedIn(root, stay) : [];
  // a submodule or a git-lfs file among the changes: refused
  const staged = rawPaths(await git(root, ['diff', '--cached', '--raw', '-z', '--no-renames', '--ignore-submodules=none', ...only]));
  const unstaged = rawPaths(await git(root, ['diff', '--raw', '-z', '--no-renames', '--ignore-submodules=none', ...only]));
  if (staged.gitlink || unstaged.gitlink) throw refused('a submodule changed: commit and push it in the submodule first');
  const untracked = await untrackedOf(root, bag, notes, env, stay);
  if (stayed.length) notes.push(`not carried (it stays on this machine): ${stayed.length === 1 ? stayed[0] : `${stayed.length} files, ${stayed[0]} and more`}`);
  const changed = [...new Set([...staged.paths, ...unstaged.paths, ...untracked.map((e) => e.path)])];
  if (changed.length) {
    const attrs = zList(await git(root, ['check-attr', '--stdin', '-z', 'filter'], { input: changed.join('\0') + '\0' }));
    for (let i = 0; i + 2 < attrs.length; i += 3) if (attrs[i + 2] === 'lfs') throw refused(`${attrs[i]} is a git-lfs file: commit and push it first`);
  }

  // the commits origin lacks, as a bundle
  const head = info.head;
  const commits = Number(await gitText(root, ['rev-list', '--count', 'HEAD', '--not', '--remotes=origin']));
  let bundle = null, bundleRef = null;
  if (commits > 0) {
    bundleRef = info.branch ? `refs/heads/${info.branch}` : 'HEAD';
    const d = tmpDir(), f = path.join(d, 'work.bundle');
    try {
      await git(root, ['bundle', 'create', f, bundleRef, '--not', '--remotes=origin'], { timeout: BUNDLE_MS });
      const st = lst(f);
      bag.room(st ? st.size : 0, 'the commits origin lacks');
      bundle = bag.add(fs.readFileSync(f), 'the commits origin lacks');
    } finally { rmTmp(d); }
  }
  const up = await upstreamOf(root, info.branch);
  const base = up ? await maybe(root, ['merge-base', 'HEAD', up]) : null;

  // the changes
  const diffOpts = { maxBuffer: cap + 1, overMessage: `the changes are more than the ${Math.round(cap / 1048576) || cap} MB a move carries` };
  const stagedDiff = await git(root, [...DIFF, '--cached', ...only], diffOpts);
  const unstagedDiff = await git(root, [...DIFF, ...only], diffOpts);
  const stagedSha = stagedDiff.length ? bag.add(stagedDiff, 'the staged changes') : null;
  const unstagedSha = unstagedDiff.length ? bag.add(unstagedDiff, 'the unstaged changes') : null;
  // both through a copy of the index: write-tree on the index itself takes index.lock, and a snapshot mid-turn must
  // never make a git command of the chat's fail ("index.lock exists")
  const trees = { index: await workTree(root, stay, true), work: await workTree(root, stay) };

  // files changed, as a person counts them: HEAD to the working tree with renames, plus the untracked ones
  const files = zList(await git(root, ['diff', 'HEAD', '-M', '--name-only', '-z', '--no-ext-diff', ...only])).length + untracked.length;
  const manifest = {
    v: 1, kind: 'git', origin: info.origin, branch: info.branch, head, base, bundle, bundleRef,
    staged: stagedSha, unstaged: unstagedSha, trees, untracked, env, rel: info.rel, worktree: info.worktree,
    summary: { commits, files, bytes: bag.bytes }, notes,
  };
  // stayed: the first 100 files o.stay left here (not in the manifest: the other machine never needs them)
  return { manifest, blobs: bag.blobs, ...(stayed.length ? { stayed: stayed.slice(0, 100) } : {}) };
}
// o.stay's globs as pathspecs: { skip (all but them), pick (only them) }, or null when there are none
function stayOf(globs) {
  const skip = HR.excludeSpecs(globs);
  return skip.length ? { skip, pick: HR.pickSpecs(globs) } : null;
}
// the changed files that stay (from HEAD, staged or not, and the untracked ones): [rel]
async function stayedIn(root, stay) {
  const tracked = zList(await git(root, ['diff', 'HEAD', '--name-only', '-z', '--no-renames', '--no-ext-diff', '--', ...stay.pick]));
  const loose = zList(await git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...stay.pick])).filter((r) => !r.endsWith('/') && !envPath(r));
  return [...new Set([...tracked, ...loose])];
}

// a home-row folder: every file in it
function packPlain(info, cap) {
  const dir = fromRel(info.root, info.rel), bag = blobBag(cap), notes = [], env = [], untracked = [];
  const walk = (abs, rel) => {
    let ents;
    try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name, p = path.join(abs, e.name);
      if (isEnvName(e.name)) { env.push(r); continue; }
      if (PLAIN_SKIP.has(e.name) && e.isDirectory()) { notes.push(`not carried: ${r}/`); continue; }
      if (e.isDirectory()) { walk(p, r); continue; }
      if (untracked.length >= PLAIN_FILES) throw refused(`more than ${PLAIN_FILES} files in this folder`);
      const f = fileEntry(bag, p, r);
      if (f) untracked.push(f);
    }
  };
  if (isDir(dir)) walk(dir, '');
  const manifest = {
    v: 1, kind: 'plain', origin: C.HOME_ORIGIN, branch: null, head: null, base: null, bundle: null, bundleRef: null,
    staged: null, unstaged: null, trees: null, untracked, env, rel: info.rel, worktree: null,
    summary: { commits: 0, files: untracked.length, bytes: bag.bytes }, notes,
  };
  return { manifest, blobs: bag.blobs };
}

// ---------- the manifest, checked ----------
const safeRel = (p) => typeof p === 'string' && !!p && !p.startsWith('/') && !/^[A-Za-z]:/.test(p) && !p.includes('\0')
  && (!P.isWin || !/[\\:*?"<>|]/.test(p))
  && p.split('/').every((s) => s && s !== '.' && s !== '..' && s.toLowerCase() !== '.git');
function checkManifest(m) {
  const bad = (what) => { throw new WorkError(`not a work manifest: ${what}`, 'missing'); };
  if (!m || typeof m !== 'object' || m.v !== 1) bad('v');
  if (m.kind !== 'git' && m.kind !== 'plain') bad('kind');
  if (typeof m.rel !== 'string' || (m.rel && !safeRel(m.rel))) bad('rel');
  if (!Array.isArray(m.untracked)) bad('untracked');
  const seen = new Set();
  for (const e of m.untracked) {
    if (!e || !safeRel(e.path) || envPath(e.path) || !MODES.has(e.mode) || !HEX64.test(e.sha256) || !Number.isSafeInteger(e.size)) bad(`untracked ${clip(e && e.path, 80)}`);
    const k = P.foldCase(e.path);
    if (seen.has(k)) bad(`untracked ${clip(e.path, 80)} twice`);
    seen.add(k);
  }
  if (m.kind === 'plain') return;
  if (typeof m.origin !== 'string' || !m.origin) bad('origin');
  if (!HEX40.test(m.head || '')) bad('head');
  if (m.branch !== null && (typeof m.branch !== 'string' || !m.branch || m.branch.startsWith('-'))) bad('branch');
  for (const k of ['bundle', 'staged', 'unstaged']) if (m[k] !== null && !HEX64.test(m[k] || '')) bad(k);
  if (m.bundle && m.bundleRef !== 'HEAD' && !(typeof m.bundleRef === 'string' && m.bundleRef.startsWith('refs/heads/'))) bad('bundleRef');
  if (!m.trees || !HEX40.test(m.trees.index || '') || !HEX40.test(m.trees.work || '')) bad('trees');
  if (m.worktree !== null && (typeof m.worktree !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(m.worktree))) bad('worktree');
}
function blobOf(blobs, h) {
  const b = blobs instanceof Map ? blobs.get(h) : null;
  if (!Buffer.isBuffer(b) || sha(b) !== h) throw new WorkError(`blob ${short(h)} is missing or isn't what the manifest says`, 'missing');
  return b;
}
function checkBlobs(m, blobs) {
  for (const k of ['bundle', 'staged', 'unstaged']) if (m[k]) blobOf(blobs, m[k]);
  for (const e of m.untracked) { const b = blobOf(blobs, e.sha256); if (b.length !== e.size) throw new WorkError(`${e.path}: the size isn't the manifest's`, 'missing'); }
}

// ---------- unpack ----------
// the worktrees of a repo: [{ path, head, branch (short) | null }]
async function worktrees(root) {
  const out = [];
  let cur = null;
  for (const line of (await gitText(root, ['worktree', 'list', '--porcelain'])).split('\n')) {
    if (line.startsWith('worktree ')) { cur = { path: line.slice(9), head: null, branch: null }; out.push(cur); } else if (cur && line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (cur && line.startsWith('branch refs/heads/')) cur.branch = line.slice(18);
  }
  return out;
}
const clean = async (dir) => { const c = await changesIn(dir); return c !== null && c.length === 0; };
const ancestor = async (root, a, b) => (await runGit(root, ['merge-base', '--is-ancestor', a, b])).ok;
const branchHead = (root, b) => maybe(root, ['rev-parse', '-q', '--verify', `refs/heads/${b}^{commit}`]);
const nameFor = (m) => m.worktree || `fv-${String(m.branch || `detached-${short(m.head)}`).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '').slice(0, 60) || 'work'}`;
async function freeBranch(root, b) {
  for (let i = 0; i < 100; i++) {
    const name = i ? `${b}-${i + 1}` : b;
    if (!(await branchHead(root, name))) return name;
  }
  throw new WorkError(`no free branch name like ${b}`, 'conflict');
}
// how the work's branch lands here, never losing a commit or moving a branch another worktree has checked out
// (selfPath: the worktree being switched, which may hold it): { mode: 'detached' } | { mode: 'create', name } |
// { mode: 'use', name, move (fast-forward it to head first) }
async function placeBranch(root, list, branch, head, notes, selfPath) {
  if (!branch) return { mode: 'detached', name: null };
  const bh = await branchHead(root, branch);
  if (!bh) return { mode: 'create', name: branch };
  if (bh !== head && !(await ancestor(root, bh, head))) {
    const nb = await freeBranch(root, `${branch}-moved-${short(head)}`);
    notes.push(`${branch} here has commits the moved work lacks: it stays as it was, and the work is on ${nb}`);
    return { mode: 'create', name: nb };
  }
  const there = list.find((x) => x.branch === branch && !(selfPath && sameDir(x.path, selfPath)));
  if (there) {
    notes.push(`${branch} is checked out in ${there.path}, so the work is on a detached head at ${short(head)}: switch to a branch before committing`);
    return { mode: 'detached', name: null };
  }
  return { mode: 'use', name: branch, move: bh !== head };
}
// a folder that is empty, or not there
const vacant = (p) => { const st = lst(p); if (!st) return true; if (!st.isDirectory()) return false; try { return fs.readdirSync(p).length === 0; } catch { return false; } };
async function excludeWorktrees(mainRoot, into) {
  const rel = inside(mainRoot, into);
  if (rel === null || !rel.startsWith('.claude/worktrees/')) return;
  if ((await runGit(mainRoot, ['check-ignore', '-q', '--no-index', rel])).ok) return;
  const f = await maybe(mainRoot, ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude']);
  if (!f) return;
  try {
    const had = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
    if (!/^\/\.claude\/worktrees\/\s*$/m.test(had)) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.appendFileSync(f, `${had && !had.endsWith('\n') ? '\n' : ''}/.claude/worktrees/\n`);
    }
  } catch {}
}
// whether a folder between into and dest is a symlink (one there already, a tracked one, or one written before): a
// file is never written through one, which could lead out of into
function throughLink(into, dest) {
  const rel = path.relative(into, path.dirname(dest));
  if (!rel) return false;
  let d = into;
  for (const seg of rel.split(path.sep)) {
    d = path.join(d, seg);
    const st = lst(d);
    if (!st) return false;
    if (st.isSymbolicLink()) return true;
  }
  return false;
}
// the files first and the symlinks last, so no entry can lead a later one out of into
// -> the files it wrote (not the ones that were there already, the same)
function writeUntracked(into, m, blobs, notes) {
  const order = [...m.untracked.filter((e) => e.mode !== '120000'), ...m.untracked.filter((e) => e.mode === '120000')];
  const wrote = [];
  for (const e of order) {
    const dest = fromRel(into, e.path), b = blobOf(blobs, e.sha256);
    if (throughLink(into, dest)) throw new WorkError(`${e.path} would be written through a symlink: refused`, 'conflict');
    const st = lst(dest);
    if (st) {
      const same = st.isSymbolicLink() ? e.mode === '120000' && linkTarget(dest) === b.toString('utf8') : st.isFile() && sha(fs.readFileSync(dest)) === e.sha256;
      if (same) continue;
      throw new WorkError(`${e.path} is there already and differs`, 'conflict');
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    wrote.push(dest);
    if (e.mode === '120000') {
      try { fs.symlinkSync(b.toString('utf8'), dest); continue; } catch { notes.push(`${e.path}: a symlink this machine would not make, written as a file holding its target`); }
      fs.writeFileSync(dest, b);
      continue;
    }
    fs.writeFileSync(dest, b);
    if (!P.isWin) fs.chmodSync(dest, e.mode === '100755' ? 0o755 : 0o644);
  }
  return wrote;
}

async function unpack(manifest, blobs, o = {}) {
  checkManifest(manifest);
  checkBlobs(manifest, blobs);
  if (manifest.kind === 'plain') return unpackPlain(manifest, blobs, o);
  if (typeof o.root !== 'string' || !o.root) throw new WorkError('unpack needs this machine\'s checkout (root)', 'conflict');
  const info = await inspect(o.root, o);
  if (!info.git) throw new WorkError(`${o.root} is not a git checkout`, 'conflict');
  if (info.origin !== manifest.origin) throw new WorkError(`${o.root} is a checkout of ${info.origin || 'no origin'}, not ${manifest.origin}`, 'conflict');
  const root = info.mainRoot, m = manifest, head = m.head, notes = [];
  const d = tmpDir();
  try {
    // the commits
    if (o.fetch !== false) {
      const f = await runGit(root, ['fetch', '--quiet', 'origin'], { timeout: FETCH_MS });
      if (!f.ok) notes.push(`couldn't fetch origin (${clip(f.err, 160) || 'offline?'}): went on with what is here`);
    }
    if (m.bundle) {
      const bf = path.join(d, 'work.bundle');
      fs.writeFileSync(bf, blobOf(blobs, m.bundle));
      const v = await runGit(root, ['bundle', 'verify', bf]);
      if (!v.ok) throw new WorkError(`this checkout lacks commits the moved work is built on (fetch origin, then try again): ${clip(v.err, 200)}`, 'missing');
      await git(root, ['fetch', '--quiet', '--no-tags', bf, `+${m.bundleRef}:refs/fleet-view/incoming/${head}`], { timeout: BUNDLE_MS });
    }
    if (!(await runGit(root, ['cat-file', '-e', `${head}^{commit}`])).ok) throw new WorkError(`commit ${short(head)} isn't here, and origin didn't have it`, 'missing');

    // where it goes
    const wtDir = path.join(root, '.claude', 'worktrees');
    let into = path.resolve(o.into || path.join(wtDir, nameFor(m)));
    const list = await worktrees(root);
    const at = (p) => list.find((w) => sameDir(w.path, p));
    const ownWt = (p) => { const r = inside(realOr(wtDir), realOr(p)); return r !== null && r !== '' && !r.includes('/'); };
    let made = null; // what a failure undoes: { worktree, branch } | { inPlace, was }
    let branch = m.branch;
    const prepareInPlace = async (w) => {
      if (!(await clean(w.path))) { notes.push(`${w.path} has changes of its own: left as it is`); return false; }
      if (branch ? w.branch === branch : !w.branch) {
        if (w.head === head) return { inPlace: w.path, was: w.head };
        if (await ancestor(root, w.head, head)) { await git(w.path, ['merge', '--ff-only', '--quiet', head]); return { inPlace: w.path, was: w.head }; }
        notes.push(`${w.path} is on ${branch || 'a detached head'} with commits the moved work lacks: left as it is`);
        return false;
      }
      if (!ownWt(w.path)) { notes.push(`${w.path} is on ${w.branch || 'a detached head'}: left as it is`); return false; }
      // the chat's own worktree, clean, on something else: switch it over (back: how a failure puts it as it was)
      const back = { inPlace: w.path, was: w.head, switched: { branch: w.branch, made: null, moved: null } };
      const pb = await placeBranch(root, list, branch, head, notes, w.path);
      if (pb.mode === 'detached') { await git(w.path, ['switch', '--quiet', '--detach', head]); branch = null; } else if (pb.mode === 'create') {
        await git(w.path, ['switch', '--quiet', '-c', pb.name, head]);
        branch = back.switched.made = pb.name;
      } else {
        if (pb.move) { back.switched.moved = { name: pb.name, from: await branchHead(root, pb.name) }; await git(root, ['branch', '-f', pb.name, head]); }
        await git(w.path, ['switch', '--quiet', pb.name]);
      }
      return back;
    };
    const existing = at(into);
    if (existing) made = await prepareInPlace(existing);
    if (!made) {
      if (existing || !vacant(into)) {
        const baseName = ownWt(into) ? path.basename(into) : nameFor(m);
        let n = 2, alt;
        do alt = path.join(wtDir, `${baseName}-${n++}`); while (!vacant(alt) || at(alt));
        if (!existing) notes.push(`${into} is not empty: the work went to ${alt}`);
        into = alt;
      }
      await runGit(root, ['worktree', 'prune']);
      fs.mkdirSync(path.dirname(into), { recursive: true });
      let madeBranch = null;
      const pb = await placeBranch(root, list, branch, head, notes, null);
      if (pb.mode === 'detached') { await git(root, ['worktree', 'add', '--quiet', '--detach', into, head]); branch = null; } else if (pb.mode === 'create') {
        await git(root, ['worktree', 'add', '--quiet', '-b', pb.name, into, head]);
        branch = madeBranch = pb.name;
        if (pb.name === m.branch && await maybe(root, ['rev-parse', '-q', '--verify', `refs/remotes/origin/${pb.name}`])) await runGit(root, ['branch', `--set-upstream-to=origin/${pb.name}`, pb.name]);
      } else {
        if (pb.move) await git(root, ['branch', '-f', pb.name, head]);
        await git(root, ['worktree', 'add', '--quiet', into, pb.name]);
      }
      made = { worktree: into, branch: madeBranch };
      await excludeWorktrees(root, into);
    }

    // the changes, then the check; a failure undoes what this made
    try {
      if (m.staged) { const f = path.join(d, 'staged.patch'); fs.writeFileSync(f, blobOf(blobs, m.staged)); await git(into, ['apply', '--index', '--whitespace=nowarn', f]); }
      if (m.unstaged) { const f = path.join(d, 'unstaged.patch'); fs.writeFileSync(f, blobOf(blobs, m.unstaged)); await git(into, ['apply', '--whitespace=nowarn', f]); }
      writeUntracked(into, m, blobs, notes);
      const cwd = fromRel(into, m.rel);
      fs.mkdirSync(cwd, { recursive: true });
      const v = await verify(cwd, m);
      if (!v.ok) throw new WorkError(`the work laid down here isn't what was packed: ${v.diffs.slice(0, 4).join('; ')}`, 'verify', { diffs: v.diffs });
      return { cwd, into, branch, notes, made: made.inPlace ? 'inplace' : 'worktree', undo: { root, made } };
    } catch (e) {
      await undoMade(root, made);
      throw e;
    }
  } finally { rmTmp(d); }
}
// what unpack made, undone: a worktree it added (and the branch it made) removed; a checkout used in place back to its
// commit and clean (untracked env files stay: clean gets -e for them, never -x), back onto its own branch when it was
// switched over, a branch the switch made deleted and one it fast-forwarded put back
async function undoMade(root, made) {
  if (made.inPlace) {
    const sw = made.switched;
    await runGit(made.inPlace, ['reset', '--quiet', '--hard', ...(sw ? [] : [made.was])]);
    await runGit(made.inPlace, ['clean', '-fdq', '-e', '.env', '-e', '.env.*', '-e', '.ENV', '-e', '.ENV.*']);
    if (sw) {
      await runGit(made.inPlace, sw.branch ? ['switch', '--quiet', sw.branch] : ['switch', '--quiet', '--detach', made.was]);
      if (sw.made) await runGit(root, ['branch', '-D', sw.made]);
      if (sw.moved && sw.moved.from) await runGit(root, ['branch', '-f', sw.moved.name, sw.moved.from]);
    }
  } else {
    await runGit(root, ['worktree', 'remove', '--force', made.worktree]);
    if (made.branch) await runGit(root, ['branch', '-D', made.branch]);
  }
}
// undo(unpack's result): what it laid down goes again (a move that failed after the unpack: the env files, the log's
// move, the claim). A plain lay-down removes the files it wrote (none that were there already). -> true when undone
async function undo(res) {
  const u = res && res.undo;
  if (!u) return false;
  if (u.plain) {
    for (const f of u.plain) { try { fs.rmSync(f, { force: true }); } catch {} }
    return true;
  }
  await undoMade(u.root, u.made);
  return true;
}

function unpackPlain(m, blobs, o) {
  const into = path.resolve(o.into || fromRel(path.resolve(o.home || os.homedir()), m.rel));
  const notes = [];
  // every clash first, so nothing is half written
  for (const e of m.untracked) {
    if (throughLink(into, fromRel(into, e.path))) throw new WorkError(`${e.path} would be written through a symlink in ${into}: nothing was written`, 'conflict');
    const st = lst(fromRel(into, e.path));
    if (!st) continue;
    const same = st.isSymbolicLink() ? e.mode === '120000' && linkTarget(fromRel(into, e.path)) === blobOf(blobs, e.sha256).toString('utf8')
      : st.isFile() && sha(fs.readFileSync(fromRel(into, e.path))) === e.sha256;
    if (!same) throw new WorkError(`${e.path} is in ${into} already and differs: nothing was written`, 'conflict');
  }
  fs.mkdirSync(into, { recursive: true });
  const wrote = writeUntracked(into, m, blobs, notes);
  return { cwd: into, into, branch: null, notes, made: 'plain', undo: { plain: wrote } };
}

// ---------- verify ----------
function checkFile(abs, e, diffs) {
  const st = lst(abs);
  if (!st) { diffs.push(`${e.path}: missing`); return; }
  if (e.mode === '120000') {
    const got = st.isSymbolicLink() ? Buffer.from(linkTarget(abs), 'utf8') : st.isFile() && P.isWin ? fs.readFileSync(abs) : null;
    if (!got || sha(got) !== e.sha256) diffs.push(`${e.path}: not the symlink packed`);
    return;
  }
  if (!st.isFile()) { diffs.push(`${e.path}: not a file`); return; }
  if (st.size !== e.size || sha(fs.readFileSync(abs)) !== e.sha256) { diffs.push(`${e.path}: other bytes`); return; }
  if (!P.isWin && ((st.mode & 0o111) ? '100755' : '100644') !== e.mode) diffs.push(`${e.path}: mode ${e.mode} wanted`);
}
async function verify(cwd, manifest, o = {}) {
  checkManifest(manifest);
  const m = manifest, diffs = [];
  if (m.kind === 'plain') {
    const dir = path.resolve(cwd);
    for (const e of m.untracked) checkFile(fromRel(dir, e.path), e, diffs);
    return { ok: !diffs.length, diffs };
  }
  const top = await maybe(cwd, ['rev-parse', '--show-toplevel']);
  if (!top) return { ok: false, diffs: [`${cwd} is not a git checkout`] };
  const root = path.resolve(realOr(top));
  const h = await maybe(root, ['rev-parse', '-q', '--verify', 'HEAD^{commit}']);
  if (h !== m.head) diffs.push(`HEAD is ${short(h)}, not ${short(m.head)}`);
  const index = await maybe(root, ['write-tree']);
  if (index !== m.trees.index) diffs.push('the staged changes differ');
  let work = null;
  try { work = await workTree(root); } catch {}
  if (work !== m.trees.work) diffs.push('the unstaged changes differ');
  const want = new Map(m.untracked.map((e) => [P.foldCase(e.path), e]));
  for (const e of m.untracked) checkFile(fromRel(root, e.path), e, diffs);
  const r = await runGit(root, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (r.ok) for (const rel of zList(r.out)) if (!rel.endsWith('/') && !envPath(rel) && !want.has(P.foldCase(rel))) diffs.push(`${rel}: untracked here, not packed`);
  return { ok: !diffs.length, diffs };
}

// ---------- putAway ----------
const ENV_SPECS = ['**/.env', '**/.env.*', '**/.env/**', '**/.env.*/**'].map((g) => `:(exclude,top,glob,icase)${g}`);
// o.keep: more paths (from the top, with /) that stay where they are: the untracked files a pack left out as secrets;
// o.stay: [globs] of the files that stay on this machine (pack's o.stay): every one of them, tracked or not
async function putAway(cwd, note, o = {}) {
  const top = await maybe(cwd, ['rev-parse', '--show-toplevel']);
  if (!top) return null;
  const msg = clip(note || 'fleet-view: moved', 200);
  const keep = (Array.isArray(o.keep) ? o.keep : []).filter((p) => safeRel(p)).slice(0, 100).map((p) => `:(exclude,top,literal)${p}`);
  const before = await maybe(top, ['rev-parse', '-q', '--verify', 'refs/stash']);
  await git(top, ['stash', 'push', '--quiet', '--include-untracked', '-m', msg, '--', ':/', ...ENV_SPECS, ...keep, ...HR.excludeSpecs(o.stay)]);
  const after = await maybe(top, ['rev-parse', '-q', '--verify', 'refs/stash']);
  if (!after || after === before) return null;
  // the stash is shared by every worktree: find ours by its message
  for (const line of (await gitText(top, ['stash', 'list', '--format=%H%x00%gs'])).split('\n')) {
    const [h, s] = line.split('\0');
    if (s && s.endsWith(`: ${msg}`)) return h;
  }
  return after;
}

module.exports = { inspect, pack, unpack, undo, verify, putAway, WorkError, CAP, isEnvName, envPath, checkManifest, safeRel };
