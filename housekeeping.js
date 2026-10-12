// Housekeeping: what can be cleaned in each repo Fleet View knows (git worktrees, local branches, GitHub branches),
// and, only when asked, the clean-up itself. Every rule must allow an item before it is removed; each removal is a
// line in a log, and Restore puts it back. Nothing runs by itself unless the nightly switch is on. The rules, the log
// and restore in plain words: docs\housekeeping.md.
//   GET  /housekeeping          the last report at once (one is started when there is none):
//                               { at, busy, auto, lastRun, error, repos: [{ root, name, github, defaultBranch,
//                                 worktrees: [...], branches: [...], remoteBranches: [...] }], totals }
//   POST /housekeeping/refresh  start a fresh report -> { ok, busy }
//   POST /housekeeping/run      { ids } -> { ok, results: [{ id, done, message }] }
//   POST /housekeeping/keep     { id, on } -> { ok }   (a pinned item is always 'keep', "kept by you"; a GitHub
//                               branch's pin is shared with the other devices: remotePins / setRemotePins, ctx.prefsChanged)
//   POST /housekeeping/auto     { on } -> { ok, auto } (the nightly clean-up, off by default)
//   GET  /housekeeping/log      { entries: [...] } newest first
//   POST /housekeeping/restore  { id } -> { ok, message }
// run, restore and auto answer 403 to another device: they work only on the PC's own page.
// Dry run from a terminal, reading only:  node housekeeping.js --report --repo <path> [--repo <path>] [--json]
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const DAY = 24 * 3600e3;
const IDLE_MS = 7 * DAY; // a conversation newer than this keeps its worktree
const STATUS_AT_ONCE = 6; // per-worktree git status calls at the same time
const WALK_MAX = 300000; // entries looked at for links before a worktree is removed; more and it is left alone
const SLUG_MAX = 200; // Claude Code cuts a longer folder slug and adds a hash
const NIGHT_FROM = 2, NIGHT_TO = 5; // the nightly clean-up runs between 02:00 and 05:00
const TICK_MS = 5 * 60e3;
const PUSH_AT_ONCE = 50; // GitHub branches deleted by one git push
const ARGS_MAX = 20000; // characters of branch names and leases on one push's command line
const BODY_MAX = 4 << 20; // a run's list of ids can be long: 2000 items is ~200 KB
const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GCM_INTERACTIVE: 'never' };
const WIN = process.platform === 'win32';

// ---------- small helpers ----------
function exec(cmd, args, { cwd, timeout = 60e3, maxBuffer = 64 << 20 } = {}) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { cwd, timeout, maxBuffer, windowsHide: true, env: ENV }, (err, out, errOut) => {
        resolve({ ok: !err, code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, out: String(out || ''), err: String(errOut || (err && err.message) || '').trim() });
      });
    } catch (e) { resolve({ ok: false, code: -1, out: '', err: e.message }); }
  });
}
const git = (dir, args, timeout) => exec('git', ['-C', dir, ...args], { timeout });
// gh as Fleet View runs it: stdout, or a rejection with what gh said
function defaultGh(args) {
  return exec('gh', args, { timeout: 180e3 }).then((r) => (r.ok ? r.out : Promise.reject(new Error(r.err || `gh exited with ${r.code}`))));
}
// a /z/... path from git under MSYS is Z:\...
const winPath = (p) => (WIN && /^\/[a-zA-Z](\/|$)/.test(p) ? `${p[1].toUpperCase()}:\\${p.slice(3)}` : p);
const norm = (p) => path.resolve(winPath(String(p)));
const keyOf = (p) => (WIN ? norm(p).toLowerCase() : norm(p));
const inside = (child, parent) => { const r = path.relative(parent, child); return r === '' || (!!r && !r.startsWith('..') && !path.isAbsolute(r)); };
// the folder Claude Code keeps a folder's conversations in: every character that is not a letter or digit is '-'
const slugOf = (dir) => norm(dir).replace(/[^a-zA-Z0-9]/g, '-');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// a branch name git would accept and that can never be read as an option
const SAFE_REF = /^(?!-)(?!.*\.\.)(?!.*@\{)[^\s~^:?*[\\\x00-\x1f\x7f]+$/;
const SHA = /^[0-9a-f]{40,64}$/;
function ago(ms, now) {
  const d = Math.max(0, now - ms);
  if (d < 3600e3) return d < 120e3 ? 'just now' : `${Math.round(d / 60e3)} minutes ago`;
  if (d < DAY) { const h = Math.round(d / 3600e3); return `${h} hour${h === 1 ? '' : 's'} ago`; }
  const n = Math.floor(d / DAY);
  return `${n} day${n === 1 ? '' : 's'} ago`;
}
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}
const githubOf = (url) => { const m = /github\.com[:/]+([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(String(url || '').trim()); return m ? `${m[1]}/${m[2]}` : null; };

// ---------- conversations: when did a session last work in a folder ----------
// Every Claude login keeps a folder's conversations in <projects>\<slug>. A conversation started in a subfolder has
// a longer slug, so every slug folder that starts with the worktree's slug counts (a sibling worktree whose name
// starts the same counts too: an ambiguous match keeps). The newest .jsonl in it (subagents' too) is the time.
function activityIndex(dirs) {
  const names = new Map(); // projects dir -> its folder names
  const newest = new Map(); // slug folder -> newest mtime
  const list = async (d) => {
    if (!names.has(d)) names.set(d, fs.promises.readdir(d).catch(() => []));
    return names.get(d);
  };
  const scan = async (dir, depth) => {
    let best = 0, ents = [];
    try { best = (await fs.promises.stat(dir)).mtimeMs; ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return best; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isFile() && e.name.endsWith('.jsonl')) { try { best = Math.max(best, (await fs.promises.stat(p)).mtimeMs); } catch {} }
      else if (e.isDirectory() && depth < 3) best = Math.max(best, await scan(p, depth + 1));
    }
    return best;
  };
  return async (folder) => {
    const pre = slugOf(folder).slice(0, SLUG_MAX).toLowerCase();
    let best = 0;
    for (const d of dirs) {
      for (const n of await list(d)) {
        if (!n.toLowerCase().startsWith(pre)) continue;
        const f = path.join(d, n);
        if (!newest.has(f)) newest.set(f, scan(f, 0));
        best = Math.max(best, await newest.get(f));
      }
    }
    return best || null;
  };
}

// ---------- links and checkouts inside a worktree ----------
// Every symlink or junction inside dir whose target is outside it (a shared node_modules, say), found with lstat and
// never followed, and every .git file or folder below the top (another worktree or a clone inside it: git would
// delete it with the folder, and its work with it). { links, nested }, or null when there were too many entries to
// look at all of them.
async function scanTree(dir) {
  const found = [], nested = [];
  let seen = 0;
  const walk = async (d) => {
    let ents;
    try { ents = await fs.promises.readdir(d, { withFileTypes: true }); } catch { return true; }
    for (const e of ents) {
      if (++seen > WALK_MAX) return false;
      const p = path.join(d, e.name);
      if (e.name.toLowerCase() === '.git') { if (d !== dir) nested.push(p); continue; }
      let st;
      try { st = await fs.promises.lstat(p); } catch { continue; }
      if (st.isSymbolicLink()) {
        let target = null;
        try { target = String(await fs.promises.readlink(p)).replace(/^\\\\\?\\/, ''); } catch {}
        const abs = target ? path.resolve(path.dirname(p), target) : null;
        if (!abs || !inside(abs, dir)) {
          let isDir = false;
          try { isDir = (await fs.promises.stat(p)).isDirectory(); } catch {}
          found.push({ path: p, target: abs, isDir });
        }
      } else if (st.isDirectory()) { if (!(await walk(p))) return false; }
    }
    return true;
  };
  return (await walk(dir)) ? { links: found, nested } : null;
}
// when git last made or changed a worktree: the folder's own times, its admin folder's HEAD and index, and the
// newest entry of its reflog (the admin folder is <common dir>\worktrees\<name>, named by the worktree's .git file)
async function gitUsed(dir) {
  let best = 0;
  const t = async (p) => { try { const s = await fs.promises.stat(p); best = Math.max(best, s.mtimeMs, s.birthtimeMs || 0); } catch {} };
  await t(dir);
  let admin = null;
  try { const m = /^gitdir:\s*(.+)$/m.exec(await fs.promises.readFile(path.join(dir, '.git'), 'utf8')); if (m) admin = path.resolve(dir, winPath(m[1].trim())); } catch {}
  if (admin) for (const n of ['HEAD', 'index', 'ORIG_HEAD']) await t(path.join(admin, n));
  // the reflog's newest entry, by the time written in it: git gc rewrites the whole file, so its mtime says nothing
  if (admin) {
    try {
      const fh = await fs.promises.open(path.join(admin, 'logs', 'HEAD'), 'r');
      try {
        const { size } = await fh.stat();
        const buf = Buffer.alloc(Math.min(size, 8192));
        await fh.read(buf, 0, buf.length, size - buf.length);
        const lines = buf.toString('utf8').split(/\r?\n/).filter((l) => l.trim());
        const m = /> (\d{9,}) [+-]\d{4}/.exec(lines[lines.length - 1] || '');
        if (m) best = Math.max(best, Number(m[1]) * 1000);
      } finally { await fh.close(); }
    } catch {}
  }
  return best || null;
}
// a real folder (not a link) with nothing in it
function emptyDir(dir) {
  try { return fs.lstatSync(dir).isDirectory() && fs.readdirSync(dir).length === 0; } catch { return false; }
}
// deletes dir and what is in it; a link is removed itself, never what it points to
async function removeTree(dir) {
  let st;
  try { st = await fs.promises.lstat(dir); } catch { return; }
  if (st.isSymbolicLink()) { try { await fs.promises.unlink(dir); } catch { await fs.promises.rmdir(dir); } return; }
  if (!st.isDirectory()) {
    try { await fs.promises.unlink(dir); } catch (e) { if (e.code !== 'EPERM' && e.code !== 'EACCES') throw e; await fs.promises.chmod(dir, 0o666); await fs.promises.unlink(dir); }
    return;
  }
  for (const n of await fs.promises.readdir(dir)) await removeTree(path.join(dir, n));
  await fs.promises.rmdir(dir);
}

// ---------- reading a repo ----------
// What every rule needs, from the repo itself: its worktrees, refs, the branches already in origin/<default>, and
// the branches on GitHub (one ls-remote). Reads only: no fetch, nothing written.
async function readLocal(root) {
  const f = { root, worktrees: [], heads: new Map(), remotes: new Map(), times: new Map(), merged: new Set(), busyRefs: new Set(), originUrl: null, originHead: null, error: null };
  const wl = await git(root, ['worktree', 'list', '--porcelain'], 60e3);
  if (!wl.ok) { f.error = `git worktree list failed: ${wl.err.split('\n')[0]}`; return f; }
  let cur = null;
  for (const line of wl.out.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) f.worktrees.push((cur = { path: norm(line.slice(9).trim()), head: null, branch: null, locked: false, prunable: false, bare: false }));
    else if (!cur) continue;
    else if (line.startsWith('HEAD ')) { const h = line.slice(5).trim().toLowerCase(); cur.head = SHA.test(h) && !/^0+$/.test(h) ? h : null; }
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
    else if (line === 'locked' || line.startsWith('locked ')) cur.locked = true;
    else if (line === 'prunable' || line.startsWith('prunable ')) cur.prunable = true;
    else if (line === 'bare') cur.bare = true;
  }
  if (f.worktrees[0]) f.worktrees[0].main = true;
  const refs = await git(root, ['for-each-ref', '--format=%(refname)%09%(objectname)%09%(committerdate:unix)', 'refs/heads', 'refs/remotes/origin'], 60e3);
  if (!refs.ok) { f.error = `git for-each-ref failed: ${refs.err.split('\n')[0]}`; return f; }
  for (const l of refs.out.split(/\r?\n/)) {
    const [ref, sha, t] = l.split('\t');
    if (!ref || !sha) continue;
    if (ref.startsWith('refs/heads/')) f.heads.set(ref.slice(11), sha.toLowerCase());
    else if (ref.startsWith('refs/remotes/origin/') && ref !== 'refs/remotes/origin/HEAD') f.remotes.set(ref.slice(20), sha.toLowerCase());
    if (Number(t)) f.times.set(sha.toLowerCase(), Number(t) * 1000);
  }
  const url = await git(root, ['config', '--get', 'remote.origin.url']);
  f.originUrl = url.ok ? url.out.trim() : null;
  const oh = await git(root, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (oh.ok) f.originHead = oh.out.trim().replace(/^refs\/remotes\/origin\//, '') || null;
  // a branch a rebase or bisect is working on shows as a detached HEAD: it counts as checked out
  const cd = await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (cd.ok) {
    const common = norm(cd.out.trim());
    const gitDirs = [common];
    try { for (const n of fs.readdirSync(path.join(common, 'worktrees'))) gitDirs.push(path.join(common, 'worktrees', n)); } catch {}
    for (const g of gitDirs) for (const x of ['rebase-merge', 'rebase-apply']) {
      try { const h = fs.readFileSync(path.join(g, x, 'head-name'), 'utf8').trim(); if (h.startsWith('refs/heads/')) f.busyRefs.add(h.slice(11)); } catch {}
    }
    for (const g of gitDirs) { try { const h = fs.readFileSync(path.join(g, 'BISECT_START'), 'utf8').trim(); if (h) f.busyRefs.add(h.replace(/^refs\/heads\//, '')); } catch {} }
  }
  return f;
}
// the local branches whose tip is in origin/<default> (one for-each-ref)
async function mergedInto(root, def) {
  const r = await git(root, ['for-each-ref', '--merged', `refs/remotes/origin/${def}`, '--format=%(refname)', 'refs/heads'], 60e3);
  return r.ok ? new Set(r.out.split(/\r?\n/).filter(Boolean).map((x) => x.replace(/^refs\/heads\//, ''))) : null;
}
// the branches on GitHub: name -> head commit (one ls-remote); null when it could not be reached
async function lsRemote(root, ref) {
  const r = await git(root, ['ls-remote', '--heads', 'origin', ...(ref ? [`refs/heads/${ref}`] : [])], 120e3);
  if (!r.ok) return null;
  const m = new Map();
  for (const l of r.out.split(/\r?\n/)) { const [sha, name] = l.split('\t'); if (sha && name && name.startsWith('refs/heads/')) m.set(name.slice(11), sha.trim().toLowerCase()); }
  return m;
}

// What GitHub says: every PR (all pages: detailforge-web has 700+ and counting), the protected branches and the
// default branch. PRs come oldest first, so one opened while the pages are read lands on the last page and nothing
// shifts. Anything incomplete is an error, and an error keeps every item of the repo.
const PR_QUERY = 'query($owner: String!, $name: String!, $endCursor: String) { repository(owner: $owner, name: $name) { pullRequests(first: 100, after: $endCursor, orderBy: { field: CREATED_AT, direction: ASC }) { totalCount nodes { number state headRefName headRefOid baseRefName mergedAt closedAt createdAt url isCrossRepository } pageInfo { hasNextPage endCursor } } } }';
async function readGithub(slug, gh, log) {
  const out = { prs: [], protected: null, defaultBranch: null, error: null, protectedError: null };
  const [owner, name] = slug.split('/');
  try {
    const text = await gh(['api', 'graphql', '--paginate', '-f', `query=${PR_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '--jq', '.data.repository.pullRequests | {totalCount, nodes} | tojson']);
    let total = 0;
    const byNum = new Map();
    for (const l of String(text).split(/\r?\n/)) {
      if (!l.trim()) continue;
      const page = JSON.parse(l);
      if (!total && Number.isFinite(page.totalCount)) total = page.totalCount;
      for (const p of page.nodes || []) if (p && Number.isInteger(p.number)) byNum.set(p.number, p);
    }
    out.prs = [...byNum.values()];
    if (out.prs.length < total) {
      out.error = `read ${out.prs.length} of ${total} pull requests`;
      log(`housekeeping: ${slug}: only ${out.prs.length} of ${total} pull requests came back; nothing in it is removed`);
    }
  } catch (e) { out.error = `could not read pull requests (${String(e.message).split('\n')[0].slice(0, 200)})`; }
  try {
    const text = await gh(['api', '--paginate', `repos/${slug}/branches?protected=true&per_page=100`, '--jq', '.[].name']);
    out.protected = new Set(String(text).split(/\r?\n/).map((x) => x.trim()).filter(Boolean));
  } catch (e) { out.protectedError = String(e.message).split('\n')[0].slice(0, 200); }
  try {
    const d = String(await gh(['api', `repos/${slug}`, '--jq', '.default_branch'])).trim();
    if (d && SAFE_REF.test(d)) out.defaultBranch = d;
  } catch {}
  return out;
}
// PRs by head branch (this repo's own, newest first) and the branches open PRs use
function prIndex(prs) {
  const byHead = new Map(), bySha = new Map(), openHead = new Map(), openBase = new Map();
  const sorted = [...prs].sort((a, b) => b.number - a.number);
  for (const p of sorted) {
    if (p.state === 'OPEN') {
      if (!openBase.has(p.baseRefName)) openBase.set(p.baseRefName, p);
      if (!p.isCrossRepository && !openHead.has(p.headRefName)) openHead.set(p.headRefName, p);
    }
    if (p.isCrossRepository) continue;
    if (!byHead.has(p.headRefName)) byHead.set(p.headRefName, p);
    const s = String(p.headRefOid || '').toLowerCase();
    if (s && !bySha.has(s)) bySha.set(s, p);
  }
  return { byHead, bySha, openHead, openBase };
}
const prJson = (p) => (p ? { number: p.number, state: p.state, headSha: String(p.headRefOid || '').toLowerCase(), url: p.url || null } : null);
const prDone = (p) => !!p && (p.state === 'MERGED' || p.state === 'CLOSED');
function prSays(p, now) {
  if (p.state === 'MERGED') return `PR #${p.number} merged ${p.mergedAt ? ago(Date.parse(p.mergedAt), now) : ''}`.trim();
  return `PR #${p.number} closed without merging ${p.closedAt ? ago(Date.parse(p.closedAt), now) : ''}`.trim();
}

// ---------- the rules ----------
// A worktree: 'remove' only when every rule allows it; 'ask' when its PR merged but it has uncommitted changes or
// commits that are not pushed (and nothing else holds it); otherwise 'keep'.
function judgeWorktree(w, f, st, env) {
  const { now } = env;
  const hold = [], soft = [], ok = [];
  const def = f.defaultBranch;
  const pr = f.idx ? (w.branch ? f.idx.byHead.get(w.branch) : w.head ? f.idx.bySha.get(w.head) : null) || null : null;
  const open = f.idx && w.branch ? f.idx.openHead.get(w.branch) : null;
  if (w.main) hold.push('the main checkout');
  if (w.prunable) hold.push('its folder is gone (git worktree prune clears it)');
  if (w.locked) hold.push('locked (git worktree lock)');
  // git status cannot see a worktree inside this one (.claude/ is ignored), and removing this one deletes it
  const inner = w.main ? null : f.worktrees.find((v) => keyOf(v.path) !== keyOf(w.path) && inside(keyOf(v.path), keyOf(w.path)) && !(v.prunable && !fs.existsSync(v.path)));
  if (inner) hold.push(`another worktree is inside it (${path.basename(inner.path)})`);
  if (f.error) hold.push(f.error);
  if (f.ghError) hold.push(f.ghError);
  if (st.dirty === null) hold.push('could not read its git status');
  else if (st.dirty) soft.push('has uncommitted changes');
  const atPrHead = prDone(pr) && !!w.head && w.head === String(pr.headRefOid || '').toLowerCase();
  if (st.unpushed === null) hold.push('could not count unpushed commits');
  else if (st.unpushed > 0 && !atPrHead) soft.push(`${st.unpushed} commit${st.unpushed === 1 ? '' : 's'} not pushed`);
  if (open) hold.push(`PR #${open.number} is open`);
  else if (prDone(pr)) ok.push(prSays(pr, now));
  else if (st.inDefault) ok.push(`its commits are in origin/${def}`);
  else hold.push(def ? `no pull request, and its commits are not in origin/${def}` : 'no pull request, and no default branch to compare with');
  if (st.lastActivity && now - st.lastActivity < IDLE_MS) hold.push(`a session worked here ${ago(st.lastActivity, now)}`);
  else ok.push(st.lastActivity ? `no conversation since ${ago(st.lastActivity, now)}` : 'no conversation here');
  // a subagent's conversation is filed under the session that started it, not under the worktree: git's own
  // files tell that the worktree was made or used lately (a fresh worktree off main looks finished otherwise)
  if (!w.main && st.gitUsed && now - st.gitUsed < IDLE_MS) hold.push(`made or used by git ${ago(st.gitUsed, now)}`);
  if (env.live(w.path)) hold.push('a Fleet View session is working here');
  if (env.indexing(w.path)) hold.push('CodeGraph is building its index');
  const out = { pr: prJson(pr || open || null), dirty: !!st.dirty, unpushed: atPrHead ? 0 : st.unpushed || 0, lastActivity: st.lastActivity || null };
  if (hold.length) return { ...out, verdict: 'keep', reasons: [...hold, ...soft] };
  if (soft.length) return { ...out, verdict: pr && pr.state === 'MERGED' ? 'ask' : 'keep', reasons: soft };
  return { ...out, verdict: 'remove', reasons: [...ok, 'no uncommitted changes, nothing unpushed'] };
}
// A local branch: 'remove' only when it is not checked out anywhere, not the default branch, and its tip is its
// merged or closed PR's head or is already in origin/<default>.
function judgeBranch(name, tip, f, env) {
  const { now } = env;
  const def = f.defaultBranch;
  const pr = f.idx ? f.idx.byHead.get(name) || null : null;
  const open = f.idx ? f.idx.openHead.get(name) : null;
  const where = f.worktrees.find((w) => w.branch === name);
  const hold = [];
  if (f.error) hold.push(f.error);
  if (f.ghError) hold.push(f.ghError);
  if (!SAFE_REF.test(name)) hold.push('a name Fleet View will not pass to git');
  if (name === def || (!def && /^(main|master)$/.test(name))) hold.push('the default branch');
  if (where) hold.push(where.main ? 'checked out in the main checkout' : `checked out in worktree ${path.basename(where.path)}`);
  if (f.busyRefs.has(name)) hold.push('a rebase or bisect is working on it');
  if (open) hold.push(`PR #${open.number} is open`);
  const out = { pr: prJson(pr || open || null), tip, lastCommit: f.times.get(tip) || null };
  if (hold.length) return { ...out, verdict: 'keep', reasons: hold };
  if (prDone(pr) && tip === String(pr.headRefOid || '').toLowerCase()) return { ...out, verdict: 'remove', reasons: [prSays(pr, now), 'its tip is the PR\'s last commit'], how: 'pr' };
  if (f.merged && f.merged.has(name)) return { ...out, verdict: 'remove', reasons: [`its commits are in origin/${def}`], how: 'merged' };
  if (prDone(pr)) return { ...out, verdict: 'keep', reasons: [`it has commits after ${pr.state === 'MERGED' ? 'merging' : 'closing'} PR #${pr.number}, not in origin/${def}`] };
  return { ...out, verdict: 'keep', reasons: [def ? `no pull request, and its commits are not in origin/${def}` : 'no pull request, and no default branch to compare with'] };
}
// A GitHub branch: 'remove' only when its PR merged, the branch still points at that PR's last commit, it is not the
// default branch or protected, and no open PR uses it. A closed, unmerged PR's branch is 'ask'.
function judgeRemote(name, sha, f, env) {
  const { now } = env;
  const def = f.defaultBranch;
  const pr = f.idx ? f.idx.byHead.get(name) || null : null;
  const open = f.idx ? f.idx.openHead.get(name) : null;
  const base = f.idx ? f.idx.openBase.get(name) : null;
  const hold = [];
  if (f.error) hold.push(f.error);
  if (f.ghError) hold.push(f.ghError);
  if (!SAFE_REF.test(name)) hold.push('a name Fleet View will not pass to git');
  if (!def) hold.push('could not tell the default branch');
  else if (name === def) hold.push('the default branch');
  if (f.protectedError) hold.push('could not read the protected branches');
  else if (f.protected && f.protected.has(name)) hold.push('protected on GitHub');
  if (open) hold.push(`PR #${open.number} is open`);
  if (base && (!open || base.number !== open.number)) hold.push(`open PR #${base.number} merges into it`);
  const out = { pr: prJson(pr || open || null), tip: sha, lastCommit: f.times.get(sha) || null };
  if (hold.length) return { ...out, verdict: 'keep', reasons: hold };
  if (!pr) return { ...out, verdict: 'keep', reasons: ['no pull request'] };
  const head = String(pr.headRefOid || '').toLowerCase();
  if (pr.state === 'CLOSED') return { ...out, verdict: 'ask', reasons: [prSays(pr, now)] };
  if (pr.state !== 'MERGED') return { ...out, verdict: 'keep', reasons: [`PR #${pr.number} is ${String(pr.state).toLowerCase()}`] };
  if (sha !== head) return { ...out, verdict: 'keep', reasons: [`it moved after PR #${pr.number} was merged`] };
  return { ...out, verdict: 'remove', reasons: [prSays(pr, now), 'it still points at the PR\'s last commit'] };
}

// a JSON body of up to BODY_MAX bytes; null when it is bigger or not JSON
function readJson(req, _res, done) {
  let size = 0, called = false;
  const parts = [];
  const call = (j) => { if (!called) { called = true; done(j); } };
  req.on('data', (b) => { size += b.length; if (size > BODY_MAX) { call(null); req.destroy(); return; } parts.push(b); });
  req.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'); } catch {} call(j); });
  req.on('error', () => call(null));
}

// ---------- the module ----------
function createHousekeeping(ctx) {
  const now = () => (ctx.now ? ctx.now() : Date.now());
  const log = (t) => { try { (ctx.log || (() => {}))(t); } catch {} };
  const gh = ctx.gh || defaultGh;
  const wait = ctx.sleep || sleep;
  const DIR = path.join(ctx.dataDir || path.join(os.tmpdir(), 'fleet-view'), 'housekeeping');
  const PREFS = path.join(DIR, 'prefs.json'), LOG = path.join(DIR, 'log.jsonl'), RUNS = path.join(DIR, 'runs.jsonl'), REPORT = path.join(DIR, 'report.json');
  const readOnly = !!ctx.readOnly;

  const readPrefs = () => { try { const p = JSON.parse(fs.readFileSync(PREFS, 'utf8')); return p && typeof p === 'object' ? p : {}; } catch { return {}; } };
  const writePrefs = (p) => { if (readOnly) return; fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(PREFS, JSON.stringify(p, null, 2)); };
  const append = (file, obj) => { if (readOnly) throw new Error('read-only'); fs.mkdirSync(DIR, { recursive: true }); fs.appendFileSync(file, JSON.stringify(obj) + '\n'); };
  const pinKey = (id) => (WIN ? String(id).toLowerCase() : String(id));
  const pinned = () => new Set((readPrefs().pins || []).map(pinKey));

  let report = null; // the last report: { at, error, repos: [...] } with each item's verdict before pins
  try { const r = JSON.parse(fs.readFileSync(REPORT, 'utf8')); if (r && Array.isArray(r.repos)) report = r; } catch {}
  let reporting = null; // the report being made (a promise)
  let working = false; // a run or restore is going on
  let timer = null;

  const liveSet = () => { try { return new Set([...(ctx.liveTops ? ctx.liveTops() : [])].filter(Boolean).map(keyOf)); } catch { return new Set(); } };
  const envOf = () => {
    const tops = liveSet();
    return {
      now: now(),
      // a live session in the worktree, or in a folder inside it
      live: (p) => { const k = keyOf(p); for (const t of tops) if (t === k || t.startsWith(k + path.sep)) return true; return false; },
      indexing: (p) => { try { return !!(ctx.codegraphBusy && ctx.codegraphBusy(p)); } catch { return true; } },
    };
  };
  const projects = () => { try { return (ctx.projectsDirs ? ctx.projectsDirs() : []).filter(Boolean); } catch { return []; } };

  // a repo's facts: the local ones and GitHub's (gh: reuse what an earlier read of this run got)
  async function facts(repo, ghFacts) {
    const root = norm(repo.root);
    const f = await readLocal(root);
    f.github = repo.github || githubOf(f.originUrl);
    const g = ghFacts || (f.github ? await readGithub(f.github, gh, log) : null);
    f.gh = g;
    f.ghError = g && g.error ? g.error : null;
    f.protected = g ? g.protected : new Set();
    f.protectedError = g ? g.protectedError : null;
    f.idx = prIndex(g ? g.prs : []);
    f.defaultBranch = (g && g.defaultBranch) || f.originHead || (f.remotes.has('main') ? 'main' : f.remotes.has('master') ? 'master' : null);
    f.merged = f.defaultBranch && f.remotes.has(f.defaultBranch) ? await mergedInto(root, f.defaultBranch) : null;
    return f;
  }
  // a worktree's own state, read now: uncommitted changes (untracked files count; never takes index.lock), commits
  // on no origin ref, whether its tip is in origin/<default>, and when a conversation last worked there
  async function stateOf(w, f, activity) {
    const st = { dirty: null, unpushed: null, inDefault: false, lastActivity: null, gitUsed: null };
    if (w.prunable || w.bare) return st;
    const s = await git(w.path, ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=normal'], 120e3);
    if (s.ok) st.dirty = s.out.trim().length > 0;
    if (w.head) {
      const u = await git(w.path, ['rev-list', '--count', w.head, '--not', '--remotes=origin'], 60e3);
      if (u.ok && /^\d+$/.test(u.out.trim())) st.unpushed = Number(u.out.trim());
      if (f.defaultBranch && f.remotes.has(f.defaultBranch)) {
        const a = await git(f.root, ['merge-base', '--is-ancestor', w.head, `refs/remotes/origin/${f.defaultBranch}`], 60e3);
        st.inDefault = a.ok;
      }
    }
    st.lastActivity = await activity(w.path);
    st.gitUsed = await gitUsed(w.path);
    return st;
  }

  async function reportRepo(repo, env, activity) {
    const root = norm(repo.root);
    const f = await facts(repo);
    const id = (kind, x) => `${kind}:${root}|${x}`;
    const out = { root, name: path.basename(root), github: f.github || null, defaultBranch: f.defaultBranch || null, worktrees: [], branches: [], remoteBranches: [], error: f.error || f.ghError || null };
    const wts = f.worktrees.filter((w) => !w.bare);
    const states = await pool(wts, STATUS_AT_ONCE, (w) => stateOf(w, f, activity));
    wts.forEach((w, i) => {
      const j = judgeWorktree(w, f, states[i], env);
      out.worktrees.push({ id: id('wt', w.path), path: w.path, branch: w.branch, verdict: j.verdict, reasons: j.reasons, pr: j.pr, lastActivity: j.lastActivity, dirty: j.dirty, unpushed: j.unpushed });
    });
    for (const [name, tip] of f.heads) {
      const j = judgeBranch(name, tip, f, env);
      out.branches.push({ id: id('br', name), name, verdict: j.verdict, reasons: j.reasons, pr: j.pr, tip: j.tip, lastCommit: j.lastCommit });
    }
    if (f.github) {
      const heads = await lsRemote(root);
      if (!heads) out.error = out.error || 'could not reach GitHub (git ls-remote failed)';
      else for (const [name, sha] of heads) {
        const j = judgeRemote(name, sha, f, env);
        out.remoteBranches.push({ id: id('rb', name), name, verdict: j.verdict, reasons: j.reasons, pr: j.pr, tip: j.tip, lastCommit: j.lastCommit });
      }
    }
    return out;
  }

  async function makeReport() {
    const env = envOf();
    const activity = activityIndex(projects());
    const repos = [];
    let list = [];
    try { list = (ctx.repos ? ctx.repos() : []).filter((r) => r && r.root); } catch (e) { log(`housekeeping: repos() failed: ${e.message}`); }
    const seen = new Set();
    for (const r of list) {
      if (seen.has(keyOf(r.root))) continue;
      seen.add(keyOf(r.root));
      if (!fs.existsSync(path.join(norm(r.root), '.git'))) continue;
      try { repos.push(await reportRepo(r, env, activity)); } catch (e) {
        log(`housekeeping: report on ${r.root} failed: ${e.stack || e.message}`);
        repos.push({ root: norm(r.root), name: path.basename(norm(r.root)), github: null, defaultBranch: null, worktrees: [], branches: [], remoteBranches: [], error: `the report failed (${e.message})` });
      }
    }
    const errors = repos.filter((r) => r.error).map((r) => `${r.name}: ${r.error}`);
    const r = { at: now(), error: errors.length ? errors.join('; ') : null, repos };
    if (!readOnly) { try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(REPORT, JSON.stringify(r)); } catch {} }
    return r;
  }
  // report({ fresh }): the last report, or a new one when fresh or there is none
  function makeOne({ fresh = false } = {}) {
    if (reporting) return reporting;
    if (report && !fresh) return Promise.resolve(report);
    reporting = makeReport().then((r) => { report = r; return r; }, (e) => { log(`housekeeping: report failed: ${e.stack || e.message}`); throw e; })
      .finally(() => { reporting = null; });
    return reporting;
  }

  // the report as the page sees it: pins applied, totals counted
  function view() {
    const pins = pinned();
    const prefs = readPrefs();
    const totals = { remove: 0, keep: 0, ask: 0 };
    const pin = (x) => {
      const p = pins.has(pinKey(x.id));
      const v = p ? { ...x, verdict: 'keep', reasons: ['kept by you'], pinned: true } : { ...x, pinned: false };
      totals[v.verdict]++;
      return v;
    };
    const repos = report ? report.repos.map((r) => ({
      root: r.root, name: r.name, github: r.github, defaultBranch: r.defaultBranch,
      worktrees: r.worktrees.map(pin), branches: r.branches.map(pin), remoteBranches: r.remoteBranches.map(pin),
    })) : [];
    return { at: report ? report.at : null, busy: !!reporting || working, auto: prefs.auto === true, lastRun: prefs.lastRun || null, error: report ? report.error : null, repos, totals };
  }

  // id -> what the report says it is; ids are never turned into paths or names any other way
  function lookup(id) {
    if (!report || typeof id !== 'string') return null;
    for (const r of report.repos) {
      for (const [kind, list] of [['worktree', r.worktrees], ['branch', r.branches], ['remote', r.remoteBranches]]) {
        const x = list.find((i) => i.id === id);
        if (x) return { repo: r, kind, item: x };
      }
    }
    return null;
  }

  function writeLog(entry) {
    const e = { id: crypto.randomBytes(8).toString('hex'), ...entry, at: now() };
    append(LOG, e);
    return e;
  }
  // a log line for something already removed: a failure to write it is said, and never stops the run
  function logged(entry) {
    try { writeLog(entry); return ''; } catch (e) {
      log(`housekeeping: could not write the log line for ${entry.kind} ${entry.name || entry.path}: ${e.message}`);
      return `; the log line could not be written (${e.code || e.message}), so Restore will not have it`;
    }
  }

  // a worktree goes: never with another checkout inside it; links to outside folders first (a junction to a shared
  // node_modules must never be deleted through), then `git worktree remove` without --force (git itself refuses a
  // worktree that changed after the check). When git fails part way (CodeGraph holding its index open, a terminal
  // whose folder it is), it has taken the worktree off its list already: there is no going back, so wait 30 s and
  // delete what is left without following links. Either way it is unregistered, and the caller logs it.
  // -> { done, message, links, unregistered, partial }
  async function removeWorktree(root, wtPath) {
    const scan = await scanTree(wtPath);
    if (!scan) return { done: false, message: 'too many files to check for links; left alone' };
    if (scan.nested.length) return { done: false, message: `a git checkout is inside it (${path.relative(wtPath, path.dirname(scan.nested[0])) || '.'}); left alone` };
    const undone = [];
    for (const l of scan.links) { try { await fs.promises.unlink(l.path); undone.push(l); } catch { try { await fs.promises.rmdir(l.path); undone.push(l); } catch (e) { return relink(undone, `could not unlink ${l.path}: ${e.code || e.message}`); } } }
    const links = undone.map((l) => ({ path: l.path, target: l.target, isDir: l.isDir }));
    const r = await git(root, ['worktree', 'remove', wtPath], 10 * 60e3);
    const n = links.length;
    if (r.ok) return { done: true, links, message: `removed${n ? ` (unlinked ${n} link${n === 1 ? '' : 's'} to outside folders first)` : ''}` };
    const after = await readLocal(root);
    if (after.error) return relink(undone, `git failed (${r.err.split('\n')[0]}), and then ${after.error}`);
    const listed = after.worktrees.find((w) => keyOf(w.path) === keyOf(wtPath));
    if (listed && !listed.prunable) return relink(undone, `git refused: ${r.err.split('\n')[0]}`);
    log(`housekeeping: ${wtPath}: ${r.err.split('\n')[0]}; git no longer lists it, deleting what is left in 30 s`);
    let left = null;
    if (fs.existsSync(wtPath)) {
      await wait(30e3);
      try { await removeTree(wtPath); } catch (e) { left = e.code || e.message; }
    }
    if (left) return { done: false, partial: true, unregistered: true, links, message: `git took it off its list and deleted part of it; the rest could not be deleted (${left}). It is in the log, so Restore can bring it back` };
    return { done: true, unregistered: true, links, message: listed ? 'removed; git still lists it as gone (git worktree prune clears that)' : 'removed (after what held its files let go)' };
  }
  async function relink(links, message) {
    for (const l of links) { try { await fs.promises.symlink(l.target, l.path, l.isDir ? (WIN ? 'junction' : 'dir') : 'file'); } catch (e) { message += `; could not put back the link ${l.path} (${e.code || e.message})`; } }
    return { done: false, message };
  }

  // run(ids): each id must be in the report; every rule is checked again for it right now, and only what is
  // 'remove' now is removed ('ask' never). Worktrees first, then local branches, then GitHub branches.
  async function run(ids) {
    if (readOnly) throw Object.assign(new Error('read-only'), { code: 403 });
    if (working) throw Object.assign(new Error('a clean-up is already running'), { code: 409 });
    if (reporting) throw Object.assign(new Error('a report is being made; try again when it is done'), { code: 409 });
    if (!report) throw Object.assign(new Error('there is no report yet'), { code: 409 });
    working = true;
    const results = [];
    let removed = 0, failed = 0;
    try {
      const want = [];
      for (const id of [...new Set((Array.isArray(ids) ? ids : []).filter((x) => typeof x === 'string'))]) {
        const hit = lookup(id);
        if (!hit) results.push({ id, done: false, message: 'not in the report' });
        else want.push({ id, ...hit });
      }
      const byRepo = new Map();
      for (const w of want) { const k = keyOf(w.repo.root); if (!byRepo.has(k)) byRepo.set(k, []); byRepo.get(k).push(w); }
      const pins = pinned();
      for (const items of byRepo.values()) {
        const repo = items[0].repo;
        const env = envOf();
        let f = await facts({ root: repo.root, github: repo.github });
        // tried: the removal itself was attempted (a refusal by the rules is not a failure)
        const done = (x, { tried, ...r }) => { results.push({ id: x.id, ...r }); if (r.done) removed++; else if (tried) failed++; };
        const no = (x, j) => done(x, { done: false, message: `not removed: ${j.reasons.join('; ')}` });
        for (const x of items.filter((i) => i.kind === 'worktree')) {
          const w = f.worktrees.find((v) => keyOf(v.path) === keyOf(x.item.path));
          if (!w) { done(x, { done: false, message: 'no longer a worktree' }); continue; }
          const j = pins.has(pinKey(x.id)) ? { verdict: 'keep', reasons: ['kept by you'] } : judgeWorktree(w, f, await stateOf(w, f, activityIndex(projects())), env);
          if (j.verdict !== 'remove') { no(x, j); continue; }
          if (w.main || keyOf(w.path) === keyOf(f.root)) { no(x, { reasons: ['the main checkout'] }); continue; }
          const { links, unregistered, ...r } = await removeWorktree(f.root, w.path);
          // logged whenever git took it off its list, even when part of its folder is left (partial): Restore needs it
          if (r.done || unregistered) {
            r.message += logged({ repo: f.root, kind: 'worktree', name: w.branch || null, path: w.path, sha: w.head, pr: j.pr ? j.pr.number : null,
              ...(r.partial ? { partial: true } : {}), ...(links && links.length ? { links } : {}) });
          }
          log(`housekeeping: worktree ${w.path}: ${r.message}`);
          done(x, { ...r, tried: true });
        }
        const brs = items.filter((i) => i.kind === 'branch');
        if (brs.length) f = await facts({ root: repo.root, github: repo.github }, f.gh);
        for (const x of brs) {
          const name = x.item.name, tip = f.heads.get(name);
          if (!tip) { done(x, { done: false, message: 'no longer a branch' }); continue; }
          const j = pins.has(pinKey(x.id)) ? { verdict: 'keep', reasons: ['kept by you'] } : judgeBranch(name, tip, f, env);
          if (j.verdict !== 'remove') { no(x, j); continue; }
          const r = await removeBranch(f, name, tip, j);
          if (r.done) r.message += logged({ repo: f.root, kind: 'branch', name, path: null, sha: tip, pr: j.pr ? j.pr.number : null });
          log(`housekeeping: branch ${name} in ${f.root}: ${r.message}`);
          done(x, { ...r, tried: true });
        }
        // GitHub branches, PUSH_AT_ONCE a time: one ls-remote right before each push (the head must still be the
        // merged PR's last commit), then one push for the ones that still pass. Each is a full refspec
        // (:refs/heads/<name>, so a tag of the same name is never hit) with a lease on the commit just checked: a
        // branch pushed to or deleted since is refused on its own, and the rest still go.
        const rem = items.filter((i) => i.kind === 'remote');
        const chunks = [];
        for (const x of rem) {
          const last = chunks[chunks.length - 1];
          // the command line stays well under Windows' 32 K characters
          const size = 2 * x.item.name.length + 80;
          if (last && last.items.length < PUSH_AT_ONCE && last.size + size < ARGS_MAX) { last.items.push(x); last.size += size; } else chunks.push({ items: [x], size });
        }
        for (const { items: chunk } of chunks) {
          if (!f.github) { for (const x of chunk) done(x, { done: false, message: 'not a GitHub repo' }); continue; }
          const heads = await lsRemote(f.root);
          if (!heads) { for (const x of chunk) done(x, { done: false, message: 'could not reach GitHub' }); continue; }
          const go = [];
          for (const x of chunk) {
            const name = x.item.name, sha = heads.get(name);
            if (!sha) { done(x, { done: false, message: 'already gone from GitHub' }); continue; }
            const j = pins.has(pinKey(x.id)) ? { verdict: 'keep', reasons: ['kept by you'] } : judgeRemote(name, sha, f, env);
            if (j.verdict !== 'remove') { no(x, j); continue; }
            go.push({ x, name, sha, j });
          }
          if (!go.length) continue;
          const r = await git(f.root, ['push', '--porcelain', ...go.map((g) => `--force-with-lease=refs/heads/${g.name}:${g.sha}`), 'origin', ...go.map((g) => `:refs/heads/${g.name}`)], 300e3);
          // --porcelain: one line per ref, "-<tab>:refs/heads/<name><tab>[deleted]" when it went,
          // "!<tab>(delete):refs/heads/<name><tab>[rejected] (stale info)" when the lease refused it
          const said = new Map();
          for (const l of r.out.split(/\r?\n/)) { const m = /^([-!=*+ ])\t(?:\(delete\))?:refs\/heads\/(.+?)\t(.*)$/.exec(l); if (m) said.set(m[2], { gone: m[1] === '-', text: m[3] }); }
          // a refused one: gone already (not a failure), or moved since it was checked
          const refused = go.filter((g) => !(said.get(g.name) || {}).gone);
          const after = refused.length ? await lsRemote(f.root) : null;
          for (const g of go) {
            const s = said.get(g.name);
            let res;
            if (s && s.gone) res = { done: true, message: 'deleted on GitHub', tried: true };
            else if (after && !after.has(g.name)) res = { done: false, message: 'already gone from GitHub' };
            else if (after && after.get(g.name) !== g.sha) res = { done: false, message: 'not deleted: it moved on GitHub since it was checked', tried: true };
            else res = { done: false, message: `git push failed: ${s ? s.text : r.err.split('\n').filter(Boolean).pop() || 'no answer'}`, tried: true };
            if (res.done) res.message += logged({ repo: f.root, kind: 'remote', name: g.name, path: null, sha: g.sha, pr: g.j.pr ? g.j.pr.number : null });
            log(`housekeeping: GitHub branch ${g.name} of ${f.github}: ${res.message}`);
            done(g.x, res);
          }
        }
      }
      const last = { at: now(), removed, failed };
      if (!readOnly) { writePrefs({ ...readPrefs(), lastRun: last }); try { append(RUNS, { ...last, asked: want.length }); } catch {} }
    } finally { working = false; }
    makeOne({ fresh: true }).catch(() => {});
    return results;
  }
  // a local branch goes with `git branch -d` when its tip is in origin/<default>. A squash-merged PR's head is not,
  // so it goes with `git branch -D`, right after checking it still points at the tip judged a moment ago (the PR's
  // last commit). Both refuse a branch some worktree has checked out.
  async function removeBranch(f, name, tip, j) {
    if (j.how === 'merged') {
      const r = await git(f.root, ['branch', '-d', '--', name]);
      if (r.ok) return { done: true, message: 'deleted (its commits are in the default branch)' };
      // -d compares with HEAD of the main checkout or the upstream; the rule compared with origin/<default>
      const a = await git(f.root, ['merge-base', '--is-ancestor', tip, `refs/remotes/origin/${f.defaultBranch}`]);
      if (!a.ok) return { done: false, message: `git branch -d refused: ${r.err.split('\n')[0]}` };
    }
    const at = await git(f.root, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
    if (!at.ok || at.out.trim().toLowerCase() !== tip) return { done: false, message: 'not deleted: it moved since it was checked' };
    const d = await git(f.root, ['branch', '-D', '--', name]);
    if (!d.ok) return { done: false, message: `not deleted: ${d.err.split('\n')[0]}` };
    return { done: true, message: j.how === 'pr' ? `deleted (it was PR #${j.pr.number}'s last commit)` : 'deleted (its commits are in the default branch)' };
  }

  // the log, newest first, each entry with restoredAt once it was put back
  function readLog() {
    let text = '';
    try { text = fs.readFileSync(LOG, 'utf8'); } catch {}
    const entries = [], restored = new Map();
    for (const l of text.split(/\r?\n/)) {
      if (!l.trim()) continue;
      let e;
      try { e = JSON.parse(l); } catch { continue; }
      if (e.restoreOf) restored.set(e.restoreOf, e.at);
      else if (e.id && e.kind) entries.push(e);
    }
    return entries.map((e) => (restored.has(e.id) ? { ...e, restoredAt: restored.get(e.id) } : e)).sort((a, b) => b.at - a.at);
  }
  // a commit the repo no longer has comes back from GitHub: its PR's refs/pull/<n>/head first (only FETCH_HEAD is written)
  async function haveCommit(root, sha, pr) {
    const has = async () => (await git(root, ['cat-file', '-e', `${sha}^{commit}`])).ok;
    if (await has()) return true;
    if (Number.isInteger(pr) && pr > 0) await git(root, ['fetch', '--no-tags', 'origin', `refs/pull/${pr}/head`], 300e3);
    if (await has()) return true;
    await git(root, ['fetch', '--no-tags', 'origin', sha], 300e3);
    return has();
  }
  // the links to outside folders the removal unlinked, made again in the restored worktree: only a link inside it
  // to a folder outside it, only where nothing is now, and only when what it pointed at is still there
  async function relinkRestored(e) {
    const back = [], missed = [];
    for (const l of Array.isArray(e.links) ? e.links : []) {
      if (!l || typeof l.path !== 'string') continue;
      if (typeof l.target !== 'string') { missed.push(`${l.path} (where it pointed was not known)`); continue; }
      const p = norm(l.path), t = norm(l.target);
      if (!inside(keyOf(p), keyOf(e.path)) || keyOf(p) === keyOf(e.path) || inside(keyOf(t), keyOf(e.path))) { missed.push(`${p} (not a link from inside the worktree to outside it)`); continue; }
      let taken = true;
      try { fs.lstatSync(p); } catch { taken = false; }
      if (taken) { missed.push(`${p} (something is there now)`); continue; }
      if (!fs.existsSync(t)) { missed.push(`${p} (${t} is gone)`); continue; }
      try {
        await fs.promises.mkdir(path.dirname(p), { recursive: true });
        await fs.promises.symlink(t, p, l.isDir ? (WIN ? 'junction' : 'dir') : 'file');
        back.push(p);
      } catch (x) { missed.push(`${p} (${x.code || x.message})`); }
    }
    let s = '';
    if (back.length) s += `; put back ${back.length} link${back.length === 1 ? '' : 's'} to outside folders`;
    if (missed.length) s += `; could not put back the link${missed.length === 1 ? '' : 's'} ${missed.join(', ')}`;
    return s;
  }
  async function restore(logId) {
    if (readOnly) throw Object.assign(new Error('read-only'), { code: 403 });
    if (working) throw Object.assign(new Error('a clean-up is running'), { code: 409 });
    const e = readLog().find((x) => x.id === logId);
    if (!e) return { ok: false, message: 'no such log entry' };
    if (e.restoredAt) return { ok: false, message: 'already restored' };
    if (!SHA.test(String(e.sha || '')) || (e.name && !SAFE_REF.test(e.name))) return { ok: false, message: 'that log entry cannot be restored' };
    working = true;
    try {
      const root = norm(e.repo);
      if (!(await haveCommit(root, e.sha, e.pr))) return { ok: false, message: `commit ${e.sha.slice(0, 10)} is gone here and on GitHub` };
      let r, aside = null;
      if (e.kind === 'worktree') {
        // an empty folder is fine (git adds into it); what a partial removal left is moved aside first; anything
        // else at that path is never touched
        if (fs.existsSync(e.path)) {
          const wl = await readLocal(root);
          if (wl.error || wl.worktrees.some((w) => keyOf(w.path) === keyOf(e.path))) return { ok: false, message: `${e.path} is there already` };
          if (!emptyDir(e.path)) {
            if (!e.partial) return { ok: false, message: `${e.path} is there already` };
            aside = `${e.path}.leftover-${new Date(now()).toISOString().replace(/[-:]/g, '').replace(/\..*$/, '')}`;
            try { await fs.promises.rename(e.path, aside); } catch (x) { return { ok: false, message: `what the removal left in ${e.path} could not be moved aside (${x.code || x.message}); close what holds it and try again` }; }
          }
        }
        if (!e.name) r = await git(root, ['worktree', 'add', '--detach', e.path, e.sha], 600e3);
        else if ((await git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${e.name}`])).ok) r = await git(root, ['worktree', 'add', e.path, e.name], 600e3);
        else r = await git(root, ['worktree', 'add', '-b', e.name, e.path, e.sha], 600e3);
        if (!r.ok && aside && !fs.existsSync(e.path)) { try { await fs.promises.rename(aside, e.path); aside = null; } catch {} }
      } else if (e.kind === 'branch') r = await git(root, ['branch', e.name, e.sha]);
      else if (e.kind === 'remote') {
        // a branch of that name made on GitHub since is never moved by a restore
        const there = await lsRemote(root, e.name);
        if (!there) return { ok: false, message: 'could not reach GitHub' };
        if (there.has(e.name)) return { ok: false, message: `GitHub has a branch ${e.name} again; left as it is` };
        r = await git(root, ['push', 'origin', `${e.sha}:refs/heads/${e.name}`], 120e3);
      } else return { ok: false, message: 'unknown kind' };
      if (!r.ok) return { ok: false, message: `git refused: ${r.err.split('\n').filter(Boolean).pop() || r.err}` };
      const extra = e.kind === 'worktree' ? await relinkRestored(e) : '';
      append(LOG, { restoreOf: e.id, at: now() });
      log(`housekeeping: restored ${e.kind} ${e.name || e.path} in ${root}${extra}`);
      const what = e.kind === 'worktree' ? `worktree ${e.path}` : e.kind === 'branch' ? `branch ${e.name}` : `GitHub branch ${e.name}`;
      return { ok: true, message: `restored ${what}${extra}${aside ? `; what the removal left is in ${aside}` : ''}` };
    } finally {
      working = false;
      makeOne({ fresh: true }).catch(() => {});
    }
  }

  // prefs.pins: the ids kept by hand; prefs.pinAt: { id: when it was pinned } (pins from before it have none)
  function keep(id, on) {
    if (typeof id !== 'string' || !/^(wt|br|rb):/.test(id)) return false;
    const p = readPrefs();
    const pins = new Set(p.pins || []), pinAt = { ...(p.pinAt && typeof p.pinAt === 'object' ? p.pinAt : {}) };
    for (const x of [...pins]) if (pinKey(x) === pinKey(id)) { pins.delete(x); delete pinAt[x]; }
    if (on) { pins.add(id); pinAt[id] = now(); }
    writePrefs({ ...p, pins: [...pins], pinAt });
    // a GitHub branch's pin is the same on every device (fleet-view.js syncs it: sync-prefs.js keepPins)
    if (id.startsWith('rb:') && ctx.prefsChanged) { try { ctx.prefsChanged(); } catch {} }
    return true;
  }
  // The GitHub branches' keep-pins, for the shared settings: [{ root, branch, at }] (a pin from before pinAt: at 1, the
  // oldest there is). An id is rb:<repo root>|<branch>
  function remotePins() {
    const p = readPrefs(), pinAt = p.pinAt && typeof p.pinAt === 'object' ? p.pinAt : {}, out = [];
    for (const id of Array.isArray(p.pins) ? p.pins : []) {
      if (typeof id !== 'string' || !id.startsWith('rb:')) continue;
      const i = id.indexOf('|');
      if (i < 4 || i === id.length - 1) continue;
      out.push({ root: id.slice(3, i), branch: id.slice(i + 1), at: Number.isFinite(pinAt[id]) && pinAt[id] > 0 ? pinAt[id] : 1 });
    }
    return out;
  }
  // another device's: they replace the GitHub branches' pins here (worktrees' and local branches' stay as they are)
  function setRemotePins(list) {
    const p = readPrefs(), pinAt = { ...(p.pinAt && typeof p.pinAt === 'object' ? p.pinAt : {}) };
    const pins = (Array.isArray(p.pins) ? p.pins : []).filter((id) => typeof id === 'string' && !id.startsWith('rb:'));
    for (const id of Object.keys(pinAt)) if (id.startsWith('rb:')) delete pinAt[id];
    const seen = new Set();
    for (const x of Array.isArray(list) ? list : []) {
      if (!x || typeof x.root !== 'string' || !x.root || typeof x.branch !== 'string' || !x.branch) continue;
      const id = `rb:${norm(x.root)}|${x.branch}`;
      if (seen.has(pinKey(id))) continue;
      seen.add(pinKey(id));
      pins.push(id);
      if (Number.isFinite(x.at) && x.at > 1) pinAt[id] = Math.round(x.at);
    }
    writePrefs({ ...p, pins, pinAt });
  }
  function setAuto(on) { writePrefs({ ...readPrefs(), auto: !!on }); return !!on; }

  // the nightly clean-up: when switched on, once a day between 02:00 and 05:00 while no session is mid-turn
  async function tick() {
    const p = readPrefs();
    if (p.auto !== true || working || reporting) return;
    const d = new Date(now());
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (d.getHours() < NIGHT_FROM || d.getHours() >= NIGHT_TO || p.lastNightly === day) return;
    let quiet = false;
    try { quiet = !!(ctx.isQuiet && ctx.isQuiet()); } catch {}
    if (!quiet) return;
    writePrefs({ ...p, lastNightly: day });
    try {
      await makeOne({ fresh: true });
      const ids = [];
      for (const r of view().repos) for (const l of [r.worktrees, r.branches, r.remoteBranches]) for (const x of l) if (x.verdict === 'remove') ids.push(x.id);
      const res = ids.length ? await run(ids) : [];
      log(`housekeeping: nightly clean-up: ${res.filter((x) => x.done).length} removed, ${res.filter((x) => !x.done).length} not (of ${ids.length})`);
    } catch (e) { log(`housekeeping: nightly clean-up failed: ${e.stack || e.message}`); }
  }
  function startNightly() {
    if (timer || readOnly) return;
    timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
    if (timer.unref) timer.unref();
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  function handle(req, res, pathname, h) {
    const send = (code, o) => h.sendJson(res, code, o);
    const fail = (e) => send(e && Number.isInteger(e.code) && e.code >= 400 ? e.code : 500, { ok: false, message: (e && e.message) || 'failed' });
    const remote = () => { try { return !!h.remote(req); } catch { return true; } };
    if (pathname === '/housekeeping' && req.method === 'GET') {
      if (!report && !reporting) makeOne().catch(() => {});
      return send(200, view());
    }
    if (pathname === '/housekeeping/log' && req.method === 'GET') return send(200, { entries: readLog() });
    if (req.method !== 'POST') return send(405, { ok: false, message: 'POST' });
    if (pathname === '/housekeeping/refresh') { makeOne({ fresh: true }).catch(() => {}); return send(200, { ok: true, busy: true }); }
    if (/^\/housekeeping\/(run|restore|auto)$/.test(pathname) && remote()) return send(403, { ok: false, message: 'only on the PC' });
    // a run's ids can be more than the server's usual 64 KB body: read it here
    const read = pathname === '/housekeeping/run' ? readJson : h.readBody;
    return read(req, res, (b) => {
      if (!b || typeof b !== 'object') return send(400, { ok: false, message: 'bad body' });
      if (pathname === '/housekeeping/run') {
        if (!Array.isArray(b.ids) || !b.ids.length || b.ids.length > 50000 || !b.ids.every((x) => typeof x === 'string')) return send(400, { ok: false, message: 'ids must be a list of item ids' });
        return void run(b.ids).then((results) => send(200, { ok: true, results }), fail);
      }
      if (pathname === '/housekeeping/keep') {
        if (typeof b.on !== 'boolean' || !keep(b.id, b.on)) return send(400, { ok: false, message: 'id and on (true or false) are needed' });
        return send(200, { ok: true });
      }
      if (pathname === '/housekeeping/auto') {
        if (typeof b.on !== 'boolean') return send(400, { ok: false, message: 'on must be true or false' });
        return send(200, { ok: true, auto: setAuto(b.on) });
      }
      if (pathname === '/housekeeping/restore') {
        if (typeof b.id !== 'string') return send(400, { ok: false, message: 'id is needed' });
        return void restore(b.id).then((r) => send(r.ok ? 200 : 409, r), fail);
      }
      return send(404, { ok: false, message: 'no such route' });
    });
  }

  return { handle, report: makeOne, view, run, restore, keep, remotePins, setRemotePins, setAuto, startNightly, stop, tick, log: readLog };
}

module.exports = { createHousekeeping, defaultGh, slugOf };

// ---------- the dry run: node housekeeping.js --report --repo <path> [--repo <path>] [--json] ----------
if (require.main === module) {
  const argv = process.argv.slice(2);
  const repos = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--repo' && argv[i + 1]) repos.push({ root: argv[++i] });
  if (!argv.includes('--report') || !repos.length) {
    console.error('usage: node housekeeping.js --report --repo <path> [--repo <path>] [--json]   (reads only)');
    process.exit(2);
  }
  // every Claude login's projects folder: ~/.claude and ~/.claude-<x>
  const home = os.homedir();
  const dirs = [];
  try { for (const n of fs.readdirSync(home)) if (/^\.claude(-[a-z0-9]+)?$/i.test(n) && fs.existsSync(path.join(home, n, 'projects'))) dirs.push(path.join(home, n, 'projects')); } catch {}
  const hk = createHousekeeping({
    repos: () => repos, liveTops: () => [], codegraphBusy: () => false, isQuiet: () => false, projectsDirs: () => dirs,
    dataDir: path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'fleet-view'), readOnly: true,
    log: (t) => console.error(t), now: () => Date.now(),
  });
  const t0 = Date.now();
  hk.report({ fresh: true }).then(() => {
    const v = hk.view();
    if (argv.includes('--json')) { process.stdout.write(JSON.stringify(v, null, 2) + '\n'); return; }
    const gen = (s) => s.replace(/#\d+/g, '#N').replace(/\d+ (minute|hour|day)s?/g, 'N $1s').replace(/worktree \S+/, 'worktree X').replace(/^\d+ commits? not/, 'N commits not');
    console.log(`report made in ${Math.round((Date.now() - t0) / 1000)} s${v.error ? `; errors: ${v.error}` : ''}`);
    for (const r of v.repos) {
      console.log(`\n${r.name} (${r.root}) github ${r.github || '-'}, default ${r.defaultBranch || '-'}`);
      for (const [label, list] of [['worktrees', r.worktrees], ['local branches', r.branches], ['GitHub branches', r.remoteBranches]]) {
        const by = { remove: 0, keep: 0, ask: 0 };
        const why = new Map();
        for (const x of list) { by[x.verdict]++; for (const s of x.reasons) { const k = `${x.verdict}: ${gen(s)}`; why.set(k, (why.get(k) || 0) + 1); } }
        console.log(`  ${label}: ${list.length} (remove ${by.remove}, keep ${by.keep}, ask ${by.ask})`);
        for (const [k, n] of [...why].sort((a, b) => a[0].localeCompare(b[0]) || b[1] - a[1])) console.log(`    ${String(n).padStart(4)}  ${k}`);
      }
    }
  }, (e) => { console.error(e.stack || e.message); process.exit(1); });
}
