// Fleet View: the Changes tab's server side (web/changes.js is the page). One route:
//
//   GET /changes?cwd=<folder>&base=work|branch[&since=<sig>][&fresh=1]
//     -> { ok, root, branch, base, baseRef, files: [...], truncated, sig, note? }
//
// cwd must be a folder the page may read (ctx.folders(): every conversation's folder and repo, the remembered and
// added repos) or inside one; anything else is refused with 403. The repo is the one git finds from cwd.
//
// base=work (the default) is what a commit would take now: the working tree against HEAD, staged and unstaged
// together, plus every untracked file git doesn't ignore, shown as added in full. base=branch is the whole branch:
// the working tree against the merge-base with origin/HEAD (or origin/main, main, master, the first that exists),
// so the branch's commits, what is uncommitted and the untracked files all show as one diff. baseRef names the
// branch it compared with; with none of those, it falls back to the uncommitted view and says so in `note`.
//
// Each file: { path, old (the name it was renamed from, or null), status: 'M'|'A'|'D'|'R'|'?' (untracked),
// added, removed, binary, truncated, hunks: [{ header, lines: [{ t: ' '|'+'|'-', a, b, text }] }] }; a and b are
// the line's number on the old and the new side (null where it has none). Paths are relative to the repo root,
// with forward slashes. The diff is git's own unified diff (no colour, no external diff or textconv drivers),
// parsed here. Binary files come with no lines. A file keeps at most FILE_LINES lines and the whole answer
// TOTAL_LINES (later files keep their counts but no lines); either sets `truncated`. Big untracked files are not
// read past UNTRACKED_BYTES.
//
// The page asks every few seconds, so an answer is kept per (repo, base) for CACHE_MS, and `sig` (a hash of the
// answer) lets it ask with ?since=<sig>: the same answer then comes back as { ok, same: true, sig }. fresh=1
// skips the cache (the Refresh button). Not a git repo: { ok: true, files: [], note: 'not a git repo' }.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const CACHE_MS = 2000;
const ROOT_MS = 30000; // cwd -> repo root, kept this long
const FILE_LINES = 2000;
const TOTAL_LINES = 20000;
const MAX_FILES = 1500; // files listed at most
const UNTRACKED_FILES = 300; // untracked files read at most (the rest are listed without lines)
const UNTRACKED_BYTES = 512 * 1024;
const GIT_TIMEOUT = 20000;
const MAX_BUFFER = 48 << 20;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'; // a repo with no commit yet diffs against this

const answers = new Map(); // `${root}|${base}` -> { at, p: Promise<answer> }
const roots = new Map(); // cwd -> { at, p: Promise<{ root } | null> }

// ---------- git ----------
// -c core.quotepath=false keeps non-ASCII names as they are; the rest of a name git still quotes is unquoted below
function git(cwd, args, opts = {}) {
  return new Promise((res) => {
    execFile('git', ['-C', cwd, '-c', 'core.quotepath=false', ...args],
      { windowsHide: true, timeout: opts.timeout || GIT_TIMEOUT, maxBuffer: opts.maxBuffer || (4 << 20) },
      (err, out) => {
        const text = String(out || '');
        if (!err) return res({ ok: true, out: text });
        // a diff bigger than the buffer: what came in so far, marked cut
        if (opts.partial && /maxBuffer/i.test(String(err.message || err.code || ''))) return res({ ok: true, out: text, cut: true });
        res({ ok: false, out: text, err });
      });
  });
}
const line1 = (r) => (r && r.ok ? r.out.split(/\r?\n/)[0].trim() : '');

// ---------- folders the page may read ----------
const norm = (p) => {
  let r = path.resolve(String(p)).replace(/[\\/]+$/, '');
  if (/^[a-z]:$/i.test(r)) r += path.sep; // "C:" alone means C:'s current folder; keep the root
  return process.platform === 'win32' ? r.replace(/\//g, '\\').toLowerCase() : r;
};
// links resolved first (a junction inside a known folder may point anywhere)
const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(String(p)); } };
function allowed(cwd, folders) {
  const want = norm(real(cwd));
  for (const f of folders || []) {
    if (!f) continue;
    const base = norm(real(f));
    if (want === base) return true;
    const pre = base.endsWith(path.sep) ? base : base + path.sep;
    if (want.startsWith(pre)) return true;
  }
  return false;
}

function repoRoot(cwd) {
  const key = norm(cwd);
  const hit = roots.get(key);
  if (hit && Date.now() - hit.at < ROOT_MS) return hit.p;
  const p = git(cwd, ['rev-parse', '--show-toplevel']).then((r) => {
    const top = line1(r);
    return top ? { root: path.resolve(top) } : null;
  });
  if (roots.size > 200) roots.clear();
  roots.set(key, { at: Date.now(), p });
  return p;
}

// the branch to compare a whole branch with: origin/HEAD, then origin/main, main, master
async function baseRefOf(root) {
  const head = line1(await git(root, ['rev-parse', '--abbrev-ref', 'origin/HEAD']));
  const tries = [head && head !== 'origin/HEAD' ? head : null, 'origin/main', 'origin/master', 'main', 'master'].filter(Boolean);
  for (const ref of tries) {
    const r = await git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (r.ok && line1(r)) return ref;
  }
  return null;
}

// ---------- the unified diff, parsed ----------
// "a/some \"name\"" as git quotes a path holding a quote, backslash or control character (C-style, octal bytes)
function unquote(s) {
  if (!s.startsWith('"')) return s;
  const bytes = [];
  for (let i = 1; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') break;
    if (ch !== '\\') { for (const b of Buffer.from(ch, 'utf8')) bytes.push(b); continue; }
    const n = s[++i];
    if (/[0-7]/.test(n)) { bytes.push(parseInt(s.substr(i, 3), 8)); i += 2; continue; }
    bytes.push(({ n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11 })[n] ?? n.charCodeAt(0));
  }
  return Buffer.from(bytes).toString('utf8');
}
// a path on a ---/+++/rename line: quoted or not, without the a/ b/ prefix and the tab git adds after names with spaces
function pathOf(s, prefix) {
  let p = s.replace(/\t$/, '');
  p = unquote(p);
  if (prefix && p.startsWith(prefix)) p = p.slice(prefix.length);
  return p;
}
// "diff --git a/x b/x" with the same name on both sides (no ---/+++ lines: a binary file, a mode change)
function pathsFromGitLine(rest) {
  if (rest.startsWith('"')) {
    const m = /^("(?:[^"\\]|\\.)*")\s+(.*)$/.exec(rest);
    if (m) return [pathOf(m[1], 'a/'), pathOf(m[2], 'b/')];
  }
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest.slice(0, half).startsWith('a/') && rest.slice(half + 1).startsWith('b/')) {
    return [rest.slice(2, half), rest.slice(half + 3)];
  }
  const m = /^a\/(.*?) b\/(.*)$/.exec(rest);
  return m ? [m[1], m[2]] : [rest, rest];
}

// parse `git diff` output into files; budget = { left } total lines still allowed (shared with untracked files)
function parseDiff(text, budget) {
  const files = [];
  let f = null, h = null, a = 0, b = 0;
  const done = () => { if (f) { if (!f.path) f.path = f.old || ''; if (f.status === 'R' && f.old === f.path) f.status = 'M'; if (f.status !== 'R') f.old = null; files.push(f); } f = null; h = null; };
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    let ln = lines[i];
    if (ln.startsWith('diff --git ')) {
      done();
      const [pa, pb] = pathsFromGitLine(ln.slice(11));
      f = { path: pb, old: pa, status: 'M', added: 0, removed: 0, binary: false, truncated: false, hunks: [] };
      continue;
    }
    if (!f) continue;
    if (h && (ln[0] === ' ' || ln[0] === '+' || ln[0] === '-' || ln === '' || ln[0] === '\\')) {
      // inside a hunk: '' is the last split piece or an empty context line some tools strip the space from
      if (ln === '' && i === lines.length - 1) continue;
      if (ln[0] === '\\') continue; // "\ No newline at end of file"
      const t = ln === '' ? ' ' : ln[0];
      const textPart = (ln === '' ? '' : ln.slice(1)).replace(/\r$/, '');
      if (t === '+') f.added++; else if (t === '-') f.removed++;
      const row = { t, a: t === '+' ? null : a, b: t === '-' ? null : b, text: textPart };
      if (t !== '+') a++;
      if (t !== '-') b++;
      if ((f.lines || 0) >= FILE_LINES || budget.left <= 0) { f.truncated = true; continue; }
      h.lines.push(row);
      f.lines = (f.lines || 0) + 1;
      budget.left--;
      continue;
    }
    if (ln.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(ln);
      if (!m) { h = null; continue; }
      a = +m[1]; b = +m[2];
      // a hunk past either cap is counted but not kept
      h = { header: ln.replace(/\r$/, ''), lines: [] };
      if ((f.lines || 0) < FILE_LINES && budget.left > 0) f.hunks.push(h);
      else f.truncated = true;
      continue;
    }
    h = null;
    if (ln.startsWith('new file mode')) f.status = 'A';
    else if (ln.startsWith('deleted file mode')) f.status = 'D';
    else if (ln.startsWith('rename from ')) { f.old = pathOf(ln.slice(12)); f.status = 'R'; }
    else if (ln.startsWith('rename to ')) { f.path = pathOf(ln.slice(10)); f.status = 'R'; }
    else if (ln.startsWith('--- ')) { const p = ln.slice(4); if (p !== '/dev/null') f.old = pathOf(p, 'a/'); }
    else if (ln.startsWith('+++ ')) { const p = ln.slice(4); if (p !== '/dev/null') f.path = pathOf(p, 'b/'); }
    else if (ln.startsWith('Binary files ') || ln.startsWith('GIT binary patch')) f.binary = true;
  }
  done();
  for (const x of files) delete x.lines;
  return files;
}

// an untracked file, whole, as added (binary: a NUL in its first 8 KB; big: only the first UNTRACKED_BYTES)
function untrackedFile(root, rel, budget, read) {
  const f = { path: rel, old: null, status: '?', added: 0, removed: 0, binary: false, truncated: false, hunks: [] };
  if (!read) { f.truncated = true; return f; }
  let buf;
  try {
    const abs = path.join(root, rel);
    const st = fs.lstatSync(abs); // a link is not followed: it could point anywhere
    if (!st.isFile()) return f; // a link, a nested repo or a socket: listed, nothing to show
    const fd = fs.openSync(abs, 'r');
    try {
      const n = Math.min(st.size, UNTRACKED_BYTES);
      buf = Buffer.alloc(n);
      fs.readSync(fd, buf, 0, n, 0);
    } finally { fs.closeSync(fd); }
    if (st.size > UNTRACKED_BYTES) f.truncated = true;
  } catch { return f; }
  if (buf.subarray(0, 8192).includes(0)) { f.binary = true; return f; }
  const text = buf.toString('utf8');
  const rows = text.split('\n');
  if (rows.length && rows[rows.length - 1] === '') rows.pop();
  f.added = rows.length;
  if (!rows.length) return f;
  const keep = Math.min(rows.length, FILE_LINES, Math.max(0, budget.left));
  if (keep < rows.length) f.truncated = true;
  if (!keep) return f;
  const lines = [];
  for (let i = 0; i < keep; i++) lines.push({ t: '+', a: null, b: i + 1, text: rows[i].replace(/\r$/, '') });
  budget.left -= keep;
  f.hunks.push({ header: `@@ -0,0 +1,${rows.length} @@`, lines });
  return f;
}

// ---------- one answer ----------
async function compute(root, base) {
  const branch = line1(await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])) || null;
  const headOk = !!line1(await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']));
  let from = headOk ? 'HEAD' : EMPTY_TREE, baseRef = null, note;
  if (base === 'branch') {
    baseRef = headOk ? await baseRefOf(root) : null;
    const mb = baseRef ? line1(await git(root, ['merge-base', baseRef, 'HEAD'])) : '';
    if (mb) from = mb;
    else { note = baseRef ? `no common history with ${baseRef}; showing uncommitted changes` : 'no main branch to compare with; showing uncommitted changes'; baseRef = null; }
  }
  const budget = { left: TOTAL_LINES };
  let truncated = false;
  const d = await git(root, ['diff', from, '--no-color', '--no-ext-diff', '--no-textconv', '-M', '--src-prefix=a/', '--dst-prefix=b/', '--submodule=short', '--'],
    { maxBuffer: MAX_BUFFER, partial: true, timeout: 30000 });
  if (!d.ok) return { ok: false, root, branch, base, baseRef, files: [], message: `git diff failed: ${String(d.err && d.err.message || d.err).split('\n')[0]}` };
  if (d.cut) truncated = true;
  const files = parseDiff(d.out, budget);
  const u = await git(root, ['ls-files', '-z', '--others', '--exclude-standard'], { maxBuffer: 16 << 20, partial: true });
  const untracked = u.ok ? u.out.split('\0').filter(Boolean) : [];
  untracked.forEach((rel, i) => files.push(untrackedFile(root, rel, budget, i < UNTRACKED_FILES)));
  if (files.length > MAX_FILES) { files.length = MAX_FILES; truncated = true; }
  if (files.some((f) => f.truncated)) truncated = true;
  files.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  const out = { ok: true, root, branch, base, baseRef, files, truncated };
  if (note) out.note = note;
  return out;
}

function answer(root, base, fresh) {
  const key = `${norm(root)}|${base}`;
  const hit = answers.get(key);
  // one git run at a time per repo and base; a finished answer is reused for CACHE_MS unless asked fresh
  if (hit && (hit.pending || (!fresh && Date.now() - hit.at < CACHE_MS))) return hit.p;
  const entry = { at: Date.now(), pending: true, p: null };
  entry.p = compute(root, base).then((a) => {
    a.sig = crypto.createHash('sha1').update(JSON.stringify(a)).digest('hex').slice(0, 16);
    return a;
  }).finally(() => { entry.pending = false; entry.at = Date.now(); });
  if (answers.size > 100) answers.clear();
  answers.set(key, entry);
  return entry.p;
}

async function handle(req, res, pathname, ctx) {
  if (pathname !== '/changes') return ctx.sendJson(res, 404, { ok: false, message: 'not found' });
  if (req.method !== 'GET') return ctx.sendJson(res, 405, { ok: false, message: 'GET only' });
  const q = new URL(req.url, 'http://x').searchParams;
  const cwd = q.get('cwd') || '';
  const base = q.get('base') === 'branch' ? 'branch' : 'work';
  if (!cwd || !path.isAbsolute(cwd)) return ctx.sendJson(res, 400, { ok: false, message: 'cwd must be a full path' });
  let folders = [];
  try { folders = ctx.folders() || []; } catch {}
  if (!allowed(cwd, folders)) return ctx.sendJson(res, 403, { ok: false, message: 'not a folder Fleet View knows' });
  try { if (!fs.statSync(cwd).isDirectory()) throw new Error('not a folder'); } catch { return ctx.sendJson(res, 404, { ok: false, message: 'folder not found' }); }
  const r = await repoRoot(cwd);
  if (!r) return ctx.sendJson(res, 200, { ok: true, root: null, branch: null, base, baseRef: null, files: [], truncated: false, note: 'not a git repo', sig: 'none' });
  const a = await answer(r.root, base, q.get('fresh') === '1');
  if (!a.ok) { ctx.log(`changes: ${a.message}`); return ctx.sendJson(res, 200, a); }
  if (q.get('since') && q.get('since') === a.sig) return ctx.sendJson(res, 200, { ok: true, same: true, sig: a.sig });
  return ctx.sendJson(res, 200, a);
}

module.exports = { handle, _test: { parseDiff, unquote, pathsFromGitLine, allowed, compute } };
