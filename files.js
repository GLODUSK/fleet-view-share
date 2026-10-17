// Fleet View chat: the files the compose box offers after "@" (web/compose.js), served as
// GET /chat/files?cwd=<folder>&q=<text> -> { files: [{ path, dir }] }, paths relative to cwd with forward slashes.
// Also GET /chat/kind?path=<abs> -> { exists, dir }: a pasted or dropped path is a folder or a file.
// And GET /file (serve, at the bottom): one file for the page's file viewer (web/viewer.js).
// For a browser, which has no Windows folder picker and no path for a file it holds (web/pcfiles.js): GET /folders
// (the PC's folders, one level at a time) and POST /upload (a file sent from the browser, saved on this PC).
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
// GET /file?path=<abs, or relative to cwd>&cwd=<folder>[&raw=1]. Any path on this machine's own drives is served, so
// every path a chat shows as a link opens (a scratchpad, B:\Tools, a log), as GET /folders lists any folder already;
// never a secret, for any caller (readable: by the name asked for, then by the real one): no step of the path with a
// secret's name (.env*, *.pem, *.key, id_rsa*, *credential*, a service account's key, .npmrc, hosts.yml, .claude.json:
// secret-files.js, the list the phone's fence in relay.js uses too), nothing in a keys folder (.ssh, .aws, Keychains…),
// and of Fleet View's own data folder only its logs, uploads, pictures and Housekeeping's reports (dataOk: never the
// API token, host.json, the sync sign-in or the relay's and link's keys); no network path (\\server\share makes
// Windows sign in to it) and no alternate data stream. Those get 403, and so does a text file whose text holds a
// private key or a service account's key, whatever its name ({ secret: true }, none of its text); a missing file 404
// { missing: true }.
//   a folder -> { ok, dir: true, path, entries: ["sub/", "name"…], total } (folders first, at most DIR_MAX)
//   a text file -> { ok, path, size, lines, text, lang, mtime } (its first TEXT_MAX bytes, with truncated: true past that)
//   a binary file -> { ok, path, size, mtime, binary: true }; a picture -> { ok, path, size, mtime, image: true }
//   ?raw=1 on a picture (png, jpg, gif, webp, svg): its bytes, with its type (an SVG sandboxed: no script runs)
// A path the way Git Bash writes it (/c/Users/…) is read as C:\Users\…, and ~ is the home folder. A browser's request
// from another site is refused (the Host is checked already; this route runs before fleet-view.js's Origin check).
// The page's own Origin is http://<host> on this PC, and https://<this PC's tailnet name> in an approved browser on
// another device (ctx.remote(req), remote.js).
const TEXT_MAX = 1 << 20;
const RAW_MAX = 40 << 20;
const DIR_MAX = 500;
const IMAGES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
// the secrets' names, the keys folders and the keys in a file's text (one list with the phone's fence)
const SECRETS = require('./secret-files.js');
// what of Fleet View's own data folder is shown (dataOk): its logs at the top (*.log, *.log.1), and these folders
const DATA_OPEN = new Set(['uploads', 'chat-images', 'housekeeping']);
const DATA_LOG = /\.log(?:\.\d+)?$/i;
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
const P = require('./platform');
const WIN = P.isWin;
// lowercased where paths ignore case (Windows, macOS)
const fold = (p) => P.foldCase(p);
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
// Fleet View's own data folder as named and where it really is, case folded
const dataDirs = () => { const dir = P.dataDir(); return [...new Set([fold(path.resolve(dir)), fold(real(dir))])]; };
// p is in Fleet View's own data folder and is not one of the parts shown: the folder itself (a listing: names only),
// a log at its top, or anything in DATA_OPEN -> false
function dataOk(p, dirs = dataDirs()) {
  const f = fold(p);
  for (const d of dirs) {
    const rel = path.relative(d, f);
    if (rel === '') return true;
    const steps = rel.split(/[\\/]/);
    if (steps[0] === '..' || path.isAbsolute(rel)) continue; // outside (a name like "..x" in it is not)
    return DATA_OPEN.has(steps[0]) || (steps.length === 1 && DATA_LOG.test(steps[0]));
  }
  return true;
}
// why GET /file may not show it, or '' when it may: 'path' (on Windows not a drive's own path: a \\server\share or a
// device path, or an alternate data stream "x::$DATA"), 'secret' (a step with a secret's name or a keys folder's:
// secret-files.js) or 'data' (in Fleet View's data folder, not a part dataOk shows). Checked by the name asked for,
// then (only when that passes, so a network path is never touched) by the one it really has (a link or junction,
// another case, an 8.3 name)
function refusal(file) {
  const why = (n) => (WIN && (!/^[a-z]:\\/i.test(n) || n.slice(2).includes(':')) ? 'path'
    : n.split(/[\\/]/).some(SECRETS.secretStep) ? 'secret' : dataOk(n) ? '' : 'data');
  return why(file) || why(real(file));
}
const readable = (file) => !refusal(file);
// what the page shows for each refusal
const REFUSED = {
  path: 'Fleet View never shows network paths (\\\\server\\share) or alternate data streams',
  secret: 'Fleet View never shows secrets: sign-in, key and .env files, or what is in a keys folder',
  data: 'of its own data folder Fleet View shows only the logs, uploads, chat pictures and Housekeeping\'s reports, never its tokens and keys',
};
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
// the page's own Origin (or none), and never a request another site's page made
function originOk(req, ctx) {
  const origin = req.headers.origin, site = req.headers['sec-fetch-site'];
  const r = ctx && typeof ctx.remote === 'function' ? ctx.remote(req) : null;
  const own = r ? `https://${r.name}` : `http://${req.headers.host}`;
  return !(origin && origin !== own) && site !== 'cross-site' && site !== 'same-site';
}

function serve(req, res, ctx) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return ctx.sendJson(res, 405, { ok: false, message: 'GET only' });
  if (!originOk(req, ctx)) return ctx.sendJson(res, 403, { ok: false, message: 'bad origin' });
  const q = new URL(req.url, 'http://x').searchParams;
  const file = target(q.get('path'), q.get('cwd'));
  if (!file) return ctx.sendJson(res, 400, { ok: false, message: 'give an absolute path, or a cwd for a relative one' });
  const no = refusal(file);
  if (no) return ctx.sendJson(res, 403, { ok: false, path: file, message: REFUSED[no] });
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
  if (SECRETS.secretText(text)) return ctx.sendJson(res, 403, { ok: false, path: file, secret: true, message: 'it holds a private key or a service account\'s key, and Fleet View never shows those' });
  const lines = text ? text.replace(/\r?\n$/, '').split(/\r?\n/).length : 0;
  return ctx.sendJson(res, 200, { ok: true, path: file, size: st.size, lines, text, lang: langOf(file), mtime, ...(truncated ? { truncated: true } : {}) });
}
module.exports.serve = serve;
module.exports.readable = readable;
Object.assign(module.exports._test, { target, inside, langOf, readable, refusal, dataOk });

// ---------- GET /folders: the PC's folders, for the page's folder picker outside the desktop window ----------
// The desktop window has the Windows folder dialog (fleetDesktop.pickFolder); a browser (Edge on this PC, or the Mac
// through Tailscale) gets web/pcfiles.js's in-page one, which walks the folders through this route:
//   GET /folders                -> { ok, path: null, parent: null, folders: [the drives], places: [{ name, path }] }
//                                  places: home, Desktop, Documents, Downloads, a Github folder in home or at a drive's
//                                  top, then the repos Fleet View lists (ctx.repos()), the ones that exist
//   GET /folders?path=<folder>  -> { ok, path, parent (null at a drive's top), folders: [{ name, path }], total, more }
// Folders only, sorted by name, at most FOLDERS_MAX. Hidden ones are left out by name (Node can't read the hidden
// attribute): a leading "." or "$", and the folders Windows hides (AppData, the old "My Documents"-style links,
// System Volume Information…). The path is read like GET /file's (Git Bash's /c/…, ~, quotes) and resolved, so
// "C:\a\..\.." is C:\. Only a drive's own paths: no \\server\share (a network path makes Windows sign in to that
// server), no device paths, no alternate data streams. Missing, a file, or unreadable: { ok: false, message } (200, so
// the dialog shows the message; missing: true and file: true say which). The secrets GET /file never shows are
// fenced here too: a folder it would refuse (a keys folder, one with a secret's name, the parts of Fleet View's data
// folder dataOk keeps out) answers { ok: false, secret: true, message }, and a listing leaves such folders out (by
// their names, so a link among them is left in; opening it checks where it really leads).
const FOLDERS_MAX = 2000;
const LINK_STATS_MAX = 400; // links (junctions) in one folder looked through to see whether they are folders
const DRIVE_MS = 1500; // a drive that doesn't answer in this long (a sleeping network drive) is left out
const HIDDEN_DIRS = new Set(['appdata', 'application data', 'cookies', 'local settings', 'my documents', 'my music', 'my pictures', 'my videos',
  'nethood', 'printhood', 'recent', 'sendto', 'start menu', 'templates', 'system volume information', 'recovery', 'config.msi',
  'documents and settings', 'msocache', 'programdata', 'onedrivetemp', 'perflogs']);
const hiddenDir = (name) => /^[.$]/.test(name) || HIDDEN_DIRS.has(name.toLowerCase());
const isDirP = (p) => fs.promises.stat(p).then((s) => s.isDirectory(), () => false);
const within = (ms, p, fallback) => Promise.race([p, new Promise((r) => setTimeout(() => r(fallback), ms))]);

async function drives() {
  if (!WIN) return [{ name: '/', path: '/' }];
  const letters = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
  const up = await Promise.all(letters.map((l) => within(DRIVE_MS, isDirP(`${l}:\\`), false)));
  return letters.filter((l, i) => up[i]).map((l) => ({ name: `${l}:`, path: `${l}:\\` }));
}
async function places(ctx, drv) {
  const home = require('os').homedir();
  const want = [['Home', home], ['Desktop', path.join(home, 'Desktop')], ['Documents', path.join(home, 'Documents')], ['Downloads', path.join(home, 'Downloads')],
    ['Github', path.join(home, 'Github')], ['repos', path.join(home, 'source', 'repos')], ...drv.map((d) => ['Github', path.join(d.path, 'Github')])];
  let repos = [];
  try { repos = (ctx && typeof ctx.repos === 'function' ? ctx.repos() : []) || []; } catch {}
  for (const r of repos.slice(0, 60)) if (typeof r === 'string' && path.isAbsolute(r)) want.push([path.basename(r) || r, r]);
  const seen = new Set(), list = [];
  for (const [name, p] of want) {
    const at = path.resolve(p), k = fold(at);
    if (!seen.has(k)) { seen.add(k); list.push({ name, path: at }); }
  }
  const ok = await Promise.all(list.map((x) => within(DRIVE_MS, isDirP(x.path), false)));
  return list.filter((x, i) => ok[i]);
}
// the folder a request names, or null; "C:" alone is that drive's top
function folderOf(p) {
  let f = String(p == null ? '' : p).trim().replace(/^"(.*)"$/, '$1');
  if (WIN && /^[a-z]:$/i.test(f)) f += '\\';
  const t = target(f, null);
  if (!t || t.length > 1024) return null;
  if (WIN) {
    if (!/^[a-z]:\\/i.test(t) || t.slice(2).includes(':')) return null;
    return t[0].toUpperCase() + t.slice(1);
  }
  return t;
}
async function folders(q, ctx) {
  const raw = q.get('path');
  if (raw == null || raw === '') {
    const drv = await drives();
    return [200, { ok: true, path: null, parent: null, folders: drv, places: await places(ctx, drv) }];
  }
  const dir = folderOf(raw);
  if (!dir) return [400, { ok: false, message: WIN ? 'give the full path of a folder on a drive, like C:\\Users' : 'give the full path of a folder' }];
  const parent = path.dirname(dir) === dir ? null : path.dirname(dir);
  const no = refusal(dir);
  if (no) return [200, { ok: false, path: dir, parent, secret: true, message: no === 'data' ? `${dir}: ${REFUSED.data}` : `${dir} holds keys or sign-ins, and Fleet View never opens those` }];
  let ents;
  try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) {
    const why = e.code === 'ENOENT' ? { missing: true, message: `there is no folder at ${dir}` }
      : e.code === 'ENOTDIR' ? { file: true, message: `${dir} is a file, not a folder` }
      : e.code === 'EPERM' || e.code === 'EACCES' ? { message: `Windows doesn't let Fleet View look inside ${dir}` }
      : { message: `could not read ${dir}: ${e.code || e.message}` };
    return [200, { ok: false, path: dir, parent, ...why }];
  }
  const out = [], links = [];
  const dd = dataDirs(), realDir = real(dir);
  for (const e of ents) {
    if (hiddenDir(e.name)) continue;
    if (SECRETS.secretStep(e.name) || !dataOk(path.join(dir, e.name), dd) || !dataOk(path.join(realDir, e.name), dd)) continue;
    if (e.isDirectory()) out.push(e.name);
    else if (e.isSymbolicLink() && links.length < LINK_STATS_MAX) links.push(e.name);
  }
  const linked = await Promise.all(links.map((n) => within(DRIVE_MS, isDirP(path.join(dir, n)), false)));
  links.forEach((n, i) => { if (linked[i]) out.push(n); });
  out.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
  return [200, { ok: true, path: dir, parent, folders: out.slice(0, FOLDERS_MAX).map((name) => ({ name, path: path.join(dir, name) })), total: out.length, more: out.length > FOLDERS_MAX }];
}
function serveFolders(req, res, ctx) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return ctx.sendJson(res, 405, { ok: false, message: 'GET only' });
  if (!originOk(req, ctx)) return ctx.sendJson(res, 403, { ok: false, message: 'bad origin' });
  return folders(new URL(req.url, 'http://x').searchParams, ctx).then(([code, out]) => ctx.sendJson(res, code, out));
}

// ---------- POST /upload: a file from a browser, saved on this PC ----------
// A dropped, picked or pasted file in the desktop window goes into a message as its own path (fleetDesktop
// .pathForFile); a browser has only the file's bytes, so it sends them here and uses the path it gets back the same
// way: POST /upload?name=<the file's name>, the raw bytes as the body (with the Content-Type the browser gives the
// file; nothing here reads it) -> { ok, path, name, size }. Saved as
// %LOCALAPPDATA%\fleet-view\uploads\<yyyy-mm-dd>\<8 random hex>-<the name made safe> (cleanName), written to a
// ".part" file first and renamed once all of it is there, so nothing half-written is ever at that path. At most
// UPLOAD_MAX bytes: a bigger Content-Length is refused before a byte is read, and a body that runs past it (no length
// given) is cut off and its part deleted. Day folders older than UPLOAD_KEEP_DAYS go at server start (pruneUploads).
// Origin as GET /file.
const UPLOAD_MAX = 200 << 20;
const UPLOAD_KEEP_DAYS = 7;
const NAME_MAX = 120;
const uploadDir = () => path.join(P.dataDir(), 'uploads');
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)$/i;
// a name Windows takes as it is: the last part of what was given, no control characters or <>:"/\|?*, no trailing dots
// or spaces, not a device name (CON, NUL, COM1… with any extension), at most NAME_MAX characters (the extension kept)
function cleanName(name) {
  let n = String(name == null ? '' : name).normalize('NFC');
  n = n.split(/[\\/]/).pop();
  n = n.replace(/[\x00-\x1f\x7f-\x9f]/g, '').replace(/[<>:"|?*]/g, '_').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  if (!n || /^\.+$/.test(n)) n = 'file';
  if (RESERVED.test(n.split('.')[0].trim())) n = `_${n}`;
  if (n.length > NAME_MAX) {
    const ext = path.extname(n);
    n = ext.length > 1 && ext.length <= 20 ? n.slice(0, NAME_MAX - ext.length).replace(/[. ]+$/, '') + ext : n.slice(0, NAME_MAX).replace(/[. ]+$/, '');
  }
  return n;
}
const day = (t = new Date()) => `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
const mb = (n) => `${Math.round(n / 1048576)} MB`;

function upload(req, res, ctx) {
  if (req.method !== 'POST') return ctx.sendJson(res, 405, { ok: false, message: 'POST only' });
  let done = false;
  const reply = (code, obj) => {
    if (done) return;
    done = true;
    // refused before all of it came: close the connection after the answer, so the rest isn't sent for nothing
    if (code !== 200 && !req.complete) res.setHeader('Connection', 'close');
    ctx.sendJson(res, code, obj);
  };
  if (!originOk(req, ctx)) return reply(403, { ok: false, message: 'bad origin' });
  const given = new URL(req.url, 'http://x').searchParams.get('name');
  if (!given) return reply(400, { ok: false, message: 'give the file\'s name (?name=)' });
  const name = cleanName(given);
  const len = Number(req.headers['content-length']);
  if (Number.isFinite(len) && len > UPLOAD_MAX) return reply(413, { ok: false, message: `${name} is over ${mb(UPLOAD_MAX)} (${mb(len)}): at most that goes to the PC at once` });
  const dir = path.join(uploadDir(), day());
  const file = path.join(dir, `${require('crypto').randomBytes(4).toString('hex')}-${name}`), part = `${file}.part`;
  let out, size = 0;
  try {
    fs.mkdirSync(dir, { recursive: true });
    out = fs.createWriteStream(part, { flags: 'wx' });
  } catch (e) {
    if (ctx.log) ctx.log(`upload: could not save in ${dir}: ${e.message}`);
    return reply(500, { ok: false, message: 'could not save the file on the PC' });
  }
  const fail = (code, message) => {
    if (done) return;
    req.unpipe(out);
    out.destroy();
    fs.rm(part, { force: true }, () => {});
    reply(code, { ok: false, message });
  };
  req.on('data', (b) => {
    size += b.length;
    if (size > UPLOAD_MAX && !done) { fail(413, `${name} is over ${mb(UPLOAD_MAX)}: at most that goes to the PC at once`); req.resume(); }
  });
  req.on('close', () => { if (!req.complete) fail(400, 'the upload broke off'); });
  req.on('error', () => fail(400, 'the upload broke off'));
  out.on('error', (e) => {
    if (ctx.log) ctx.log(`upload: could not write ${part}: ${e.message}`);
    fail(500, e.code === 'ENOSPC' ? 'the PC\'s disk is full' : 'could not save the file on the PC');
  });
  out.on('finish', () => {
    if (done) return;
    fs.rename(part, file, (e) => {
      if (e) { fs.rm(part, { force: true }, () => {}); return reply(500, { ok: false, message: 'could not save the file on the PC' }); }
      reply(200, { ok: true, path: file, name, size });
    });
  });
  req.pipe(out);
}
// the name a browser gave a file it sent (the saved name less its "<8 hex>-"), or null for any other path
function uploadedName(p) {
  const f = path.resolve(String(p || '')), rel = path.relative(fold(uploadDir()), fold(f));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const m = /^[0-9a-f]{8}-(.+)$/.exec(path.basename(f));
  return m ? m[1] : null;
}
// the day folders from before the last UPLOAD_KEEP_DAYS days, and anything else stray in there -> how many went
function pruneUploads() {
  const root = uploadDir(), cut = day(new Date(Date.now() - UPLOAD_KEEP_DAYS * 86400e3));
  let names = [];
  try { names = fs.readdirSync(root); } catch { return 0; }
  let n = 0;
  for (const d of names) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d >= cut) continue;
    try { fs.rmSync(path.join(root, d), { recursive: true, force: true }); n++; } catch {}
  }
  return n;
}
Object.assign(module.exports, { folders: serveFolders, upload, pruneUploads, uploadedName });
Object.assign(module.exports._test, { folders, folderOf, cleanName, hiddenDir, UPLOAD_MAX });
