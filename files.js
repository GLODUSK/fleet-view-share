// Fleet View chat: the files the compose box offers after "@" (web/compose.js), served as
// GET /chat/files?cwd=<folder>&q=<text> -> { files: [{ path, dir }] }, paths relative to cwd with forward slashes.
// Also GET /chat/kind?path=<abs> -> { exists, dir }: a pasted or dropped path is a folder or a file.
// And GET /file (serve, at the bottom): one file for the page's file viewer (web/viewer.js).
//
// In a git checkout the list is git's (tracked, plus untracked files that aren't ignored), with every folder
// on the way; elsewhere a walk of the folder that skips the usual heavy ones. A list is kept per cwd for CACHE_MS.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const CACHE_MS = 30000;
const MAX_WALK = 20000; // entries a walk outside git reads at most
const MAX_OUT = 40;
const SKIP = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.expo', '.turbo', '.cache', 'coverage', '__pycache__', '.venv', 'venv']);

const lists = new Map(); // cwd -> { at, p: Promise<[{ path, dir }]> }

function git(cwd) {
  return new Promise((res) => execFile('git', ['-C', cwd, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { timeout: 10000, windowsHide: true, maxBuffer: 64 << 20 }, (err, out) => res(err ? null : String(out).split('\0').filter(Boolean))));
}
function walk(cwd) {
  const out = [];
  const stack = [''];
  while (stack.length && out.length < MAX_WALK) {
    const rel = stack.pop();
    let ents;
    try { ents = fs.readdirSync(path.join(cwd, rel), { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SKIP.has(e.name)) stack.push(p); } else out.push(p);
      if (out.length >= MAX_WALK) break;
    }
  }
  return out;
}
// the files, then each folder on their way (once)
function withDirs(files) {
  const dirs = new Set();
  for (const f of files) {
    let i = f.lastIndexOf('/');
    while (i > 0) { const d = f.slice(0, i); if (dirs.has(d)) break; dirs.add(d); i = d.lastIndexOf('/'); }
  }
  return [...dirs].map((p) => ({ path: p, dir: true })).concat(files.map((p) => ({ path: p, dir: false })));
}
function listFor(cwd) {
  const c = lists.get(cwd);
  if (c && Date.now() - c.at < CACHE_MS) return c.p;
  const p = git(cwd).then((g) => withDirs(g || walk(cwd))).catch(() => []);
  lists.set(cwd, { at: Date.now(), p });
  return p;
}

// what "@<q>" matches, best first: the name starts with it, then a later part of the path does, then the path
// contains it (a "/" in q matches the path from its start). Shorter paths win a tie; empty q: the top folders.
function match(list, q, max = MAX_OUT) {
  const k = String(q || '').replace(/\\/g, '/').toLowerCase();
  if (!k) return list.filter((x) => !x.path.includes('/')).sort((a, b) => (b.dir - a.dir) || a.path.localeCompare(b.path)).slice(0, max);
  const scored = [];
  for (const x of list) {
    const p = x.path.toLowerCase(), name = p.slice(p.lastIndexOf('/') + 1);
    const s = k.includes('/') ? (p.startsWith(k) ? 0 : p.includes(k) ? 2 : -1)
      : name.startsWith(k) ? 0 : p.split(/[/._-]/).some((w) => w.startsWith(k)) ? 1 : p.includes(k) ? 2 : -1;
    if (s >= 0) scored.push([s, x]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].path.length - b[1].path.length || a[1].path.localeCompare(b[1].path));
  return scored.slice(0, max).map((s) => s[1]);
}

async function files(cwd, q) {
  const dir = String(cwd || '');
  if (!dir || !path.isAbsolute(dir)) return { files: [] };
  try { if (!fs.statSync(dir).isDirectory()) return { files: [] }; } catch { return { files: [] }; }
  return { files: match(await listFor(path.resolve(dir)), q) };
}
function kind(p) {
  const f = String(p || '');
  if (!f || !path.isAbsolute(f)) return { exists: false, dir: false };
  try { return { exists: true, dir: fs.statSync(f).isDirectory() }; } catch { return { exists: false, dir: false }; }
}

module.exports = { files, kind, _test: { match, withDirs } };

// ---------- GET /file: a file for the page's viewer (web/viewer.js) ----------
// GET /file?path=<abs, or relative to cwd>&cwd=<folder>[&raw=1]. Only what lies inside a folder the page may read
// (ctx.folders(): every conversation's folder and repo, remembered and added repos; case-insensitive on Windows,
// links resolved first) is served; anything else gets 403, and a missing file 404 { missing: true }.
//   a folder -> { ok, dir: true, path, entries: ["sub/", "name"…], total } (folders first, at most DIR_MAX)
//   a text file -> { ok, path, size, lines, text, lang, mtime } (its first TEXT_MAX bytes, with truncated: true past that)
//   a binary file -> { ok, path, size, mtime, binary: true }; a picture -> { ok, path, size, mtime, image: true }
//   ?raw=1 on a picture (png, jpg, gif, webp, svg): its bytes, with its type (an SVG sandboxed: no script runs)
// A path the way Git Bash writes it (/c/Users/…) is read as C:\Users\…, and ~ is the home folder. A browser's request
// from another site is refused (the Host is checked already; this route runs before fleet-view.js's Origin check).
const TEXT_MAX = 1 << 20;
const RAW_MAX = 40 << 20;
const DIR_MAX = 500;
const IMAGES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const NEVER = new Set(['.credentials.json']); // sign-in tokens, even inside a known folder
// highlight.js's name for the extension (the page loads a few grammars; the others show as plain text)
const LANGS = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  json: 'json', jsonc: 'json', json5: 'json', jsonl: 'json', map: 'json', md: 'markdown', mdx: 'markdown', markdown: 'markdown',
  css: 'css', scss: 'css', less: 'css', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml', svelte: 'xml', plist: 'xml', csproj: 'xml',
  py: 'python', pyw: 'python', ps1: 'powershell', psm1: 'powershell', psd1: 'powershell', sh: 'bash', bash: 'bash', zsh: 'bash',
  yml: 'yaml', yaml: 'yaml', sql: 'sql', diff: 'diff', patch: 'diff',
};
function langOf(f) {
  const b = path.basename(f).toLowerCase(), ext = path.extname(b).slice(1);
  return LANGS[ext] || (b === 'dockerfile' || b.startsWith('.env') ? 'bash' : ext);
}
const WIN = process.platform === 'win32';
const fold = (p) => (WIN ? p.toLowerCase() : p);
// the real path (links and short names resolved), or the plain one when it can't be resolved (a missing file)
const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
function inside(file, folders) {
  const f = fold(real(file));
  return folders.some((d) => {
    if (!d || !path.isAbsolute(d)) return false;
    const rel = path.relative(fold(real(d)), f);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
}
// the absolute path the request names, or null
function target(p, cwd) {
  let f = String(p || '').trim().replace(/^"(.*)"$/, '$1');
  if (!f || f.includes('\0')) return null;
  if (WIN) { const m = /^\/([a-z])(?:\/(.*))?$/i.exec(f); if (m) f = `${m[1].toUpperCase()}:\\${m[2] || ''}`; }
  if (/^~(?:[\\/]|$)/.test(f)) f = path.join(require('os').homedir(), f.slice(1));
  if (path.isAbsolute(f)) return path.resolve(f);
  const base = String(cwd || '');
  return base && path.isAbsolute(base) ? path.resolve(base, f) : null;
}
const looksBinary = (buf) => buf.subarray(0, 8000).includes(0);

function serve(req, res, ctx) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return ctx.sendJson(res, 405, { ok: false, message: 'GET only' });
  const origin = req.headers.origin, site = req.headers['sec-fetch-site'];
  if ((origin && origin !== `http://${req.headers.host}`) || site === 'cross-site' || site === 'same-site') return ctx.sendJson(res, 403, { ok: false, message: 'bad origin' });
  const q = new URL(req.url, 'http://x').searchParams;
  const file = target(q.get('path'), q.get('cwd'));
  if (!file) return ctx.sendJson(res, 400, { ok: false, message: 'give an absolute path, or a cwd for a relative one' });
  // the name it really has (a link, another case, an 8.3 name), and no alternate data streams ("x::$DATA")
  const realName = real(file);
  if (/:/.test(file.slice(2)) || /:/.test(realName.slice(2)) || NEVER.has(path.basename(realName).toLowerCase()) || !inside(file, ctx.folders() || [])) return ctx.sendJson(res, 403, { ok: false, path: file, message: 'outside the folders Fleet View knows' });
  let st;
  try { st = fs.statSync(file); } catch { return ctx.sendJson(res, 404, { ok: false, missing: true, path: file, message: 'no such file' }); }
  const mtime = st.mtimeMs;
  if (st.isDirectory()) {
    let ents;
    try { ents = fs.readdirSync(file, { withFileTypes: true }); } catch (e) { return ctx.sendJson(res, 500, { ok: false, path: file, message: `could not read the folder: ${e.code || e.message}` }); }
    ents.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
    const entries = ents.slice(0, DIR_MAX).map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    return ctx.sendJson(res, 200, { ok: true, dir: true, path: file, entries, total: ents.length, mtime });
  }
  if (!st.isFile()) return ctx.sendJson(res, 400, { ok: false, path: file, message: 'not a file' });
  const type = IMAGES[path.extname(file).toLowerCase()];
  if (q.get('raw') === '1') {
    if (!type) return ctx.sendJson(res, 400, { ok: false, path: file, message: 'raw is for pictures only' });
    if (st.size > RAW_MAX) return ctx.sendJson(res, 413, { ok: false, path: file, message: 'too big to show' });
    res.writeHead(200, {
      'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    });
    if (req.method === 'HEAD') return res.end();
    const rs = fs.createReadStream(file);
    rs.on('error', () => res.destroy());
    return rs.pipe(res);
  }
  if (type) return ctx.sendJson(res, 200, { ok: true, path: file, size: st.size, mtime, image: true, lang: langOf(file) });
  let buf;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      buf = Buffer.alloc(Math.min(st.size, TEXT_MAX));
      buf = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0));
    } finally { fs.closeSync(fd); }
  } catch (e) { return ctx.sendJson(res, 500, { ok: false, path: file, message: `could not read it: ${e.code || e.message}` }); }
  if (looksBinary(buf)) return ctx.sendJson(res, 200, { ok: true, path: file, size: st.size, mtime, binary: true });
  const truncated = st.size > buf.length;
  let text = buf.toString('utf8').replace(/^\uFEFF/, '');
  if (truncated) text = text.replace(/\uFFFD$/, ''); // a character the cut split in two
  const lines = text ? text.replace(/\r?\n$/, '').split(/\r?\n/).length : 0;
  return ctx.sendJson(res, 200, { ok: true, path: file, size: st.size, lines, text, lang: langOf(file), mtime, ...(truncated ? { truncated: true } : {}) });
}
module.exports.serve = serve;
Object.assign(module.exports._test, { target, inside, langOf });
