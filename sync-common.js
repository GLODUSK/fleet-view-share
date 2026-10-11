// sync-common.js: the small pieces both sides of conversation sync share: the uploader (sync-up.js, S2) and the
// materializer (sync-down.js, S3). docs/sync-format.md is the contract they meet on; this file only knows how to
// name things the same way on both sides and how to read this machine. It syncs nothing by itself, runs no loop,
// sets no timer and reaches the network only through the api object a caller hands it (sync-api.js createSync()).
//
//   slugOf(folder)                     Claude Code's slug folder name for a folder (docs/sync-move-recipe.md)
//   projectsDirs(o)                    [{ account: 'a' | 'b', dir }]: the Claude projects folders on this machine
//   normalizeOrigin(url)               a git remote as the repos row keeps it, or null
//   HOME_ORIGIN, rowOrigin(s)          the home folder's pseudo origin; a repos row's origin as both sides read it
//   homeSkipped(relCwd)                a home-row rel_cwd that is never synced (AppData, Library, ~/.claude-<letter>)
//   repoOf(folder)                     -> Promise<{ root, mainRoot, origin } | null>, from git, cached per folder
//   checkFileKey(k), fileKeyB64(k), fileKeyFromB64(s), objectPath(id, fileKey, generation, seq)
//                                      file keys and the 't/<id>/<b64>/<gen>/<seq>' object paths
//   conversationFiles(slugDir, id, o)  [{ fileKey, path, appendOnly, size, mtimeMs }]: what of a conversation syncs
//   lastMeta(mainPath, o)              { cwd, branch, title } from the end of a log
//   homeCwd(mainPath, lastCwd, o)      the cwd of the folder a log lives in (where it resumes), or null
//   ensureDevice(api, dataDir), touchDevice(api, id, o)   this machine's devices row
//   isLive(id, o)                      true while a Claude Code process on this machine has that conversation open
//   readState(file, fallback), writeState(file, obj)      the JSON state files under <dataDir>/sync
//
// Every function that looks at this machine's Claude folders takes { home } (the folder holding .claude and
// .claude-a; os.homedir() by default), so a test points it at a temp folder and never at the real ones.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const P = require(path.join(__dirname, 'platform.js'));
const S = require(path.join(__dirname, 'sync-api.js'));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_SEG_RE = /^[A-Za-z0-9._-]+$/;
const MAX_B64 = 200; // sync-api.js's storage segments are at most 200 characters, so a file key is at most 150 bytes
const SIDE_DIRS = ['subagents', 'tool-results', 'workflows']; // docs/sync-format.md's table; nothing else under <id>/
const SIDE_DEPTH = 8; // folders deep under a side folder (workflows/<run>/<...>)
const GIT_TIMEOUT_MS = 10e3;
const REPO_CACHE_MS = 10 * 60e3; // a folder's repo is asked again after this (a clone can appear, an origin change)
const TAIL_START = 64 * 1024; // lastMeta reads this much of a log's end first, then four times as much, up to TAIL_CAP
const TAIL_CAP = 4 * 1024 * 1024;
const SLUG_MAX = 200; // Claude Code cuts a longer slug to this and adds a hash
const TOUCH_MS = 5 * 60e3; // devices.last_seen_at at most this often
const LIVE_CACHE_MS = 2e3; // isLive reads the pid files at most this often (the uploader asks per conversation)

const homeOf = (o) => (o && o.home) || os.homedir();
const realOr = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

// ---------- names ----------
// Claude Code's slug: the exact folder with every character that is not a letter or a digit made '-'
// (C:\Users\henry\x-1 -> C--Users-henry-x-1). It must be the folder the conversation resumes in, not its repo root.
function slugOf(folder) {
  if (typeof folder !== 'string' || !folder) throw new S.SyncError('no folder to make a slug of', 400, 'bad_request');
  return folder.replace(/[^A-Za-z0-9]/g, '-');
}

// ---------- the Claude accounts on this machine ----------
// Account B is ~/.claude, account A is ~/.claude-a (accounts.js, fleet-view.js roots()); the conversations row only
// knows those two, so other letters are left out. accounts.js makes A's projects folder a junction to B's
// (SHARE_DIRS), so on most machines both names are one real folder. Then it is returned once, as B's: fleet-view.js
// roots() reads B's folder first and counts a shared folder as B's, and so does sync. (Which account a conversation
// in a shared folder ran under is only known while it runs; on the other machine it is laid down in B's folder,
// which on a machine that shares is A's too.) Folders that do not exist are left out.
// o.home: the folder holding .claude and .claude-a (tests); o.dirs: [{ account, dir }] used as they are.
function projectsDirs(o = {}) {
  const list = Array.isArray(o.dirs) ? o.dirs : [
    { account: 'b', dir: path.join(homeOf(o), '.claude', 'projects') },
    { account: 'a', dir: path.join(homeOf(o), '.claude-a', 'projects') },
  ];
  const seen = new Set(), out = [];
  for (const r of list) {
    if (!r || (r.account !== 'a' && r.account !== 'b') || typeof r.dir !== 'string' || !isDir(r.dir)) continue;
    const real = P.foldCase(path.resolve(realOr(r.dir)));
    if (seen.has(real)) continue;
    seen.add(real);
    out.push({ account: r.account, dir: r.dir });
  }
  return out;
}

// ---------- repos ----------
// A git remote as the repos row keeps it: GitHub as https://github.com/<owner>/<repo> in lower case (ssh
// git@github.com:o/r.git, ssh://, https://user@github.com/o/r.git and .../o/r/ are all the same string); any other
// host as https://<host>/<path>, lower case too, with no user, port, .git or trailing slash. null for anything that
// is not a remote on a host: a local path, file://, a Windows drive (C:\x or C:/x), or nonsense.
function normalizeOrigin(url) {
  if (typeof url !== 'string') return null;
  const u = url.trim();
  if (!u || /\s/.test(u) || u.includes('\\')) return null;
  let host, rest;
  const m = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(u);
  if (m) {
    const scheme = m[1].toLowerCase();
    if (!['https', 'http', 'ssh', 'git', 'git+ssh', 'ssh+git'].includes(scheme)) return null; // file:// and the like
    const slash = m[2].indexOf('/');
    if (slash < 0) return null;
    host = m[2].slice(0, slash).replace(/^.*@/, '').replace(/:\d*$/, '');
    rest = m[2].slice(slash + 1);
  } else {
    // scp-like user@host:path, as git reads it: a colon before any slash; a one-letter "host" is a Windows drive
    const s = /^(?:[^@/:]+@)?([^@/:]+):(.+)$/.exec(u);
    if (!s || s[1].length < 2) return null;
    host = s[1];
    rest = s[2];
  }
  host = host.toLowerCase();
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host)) return null;
  const parts = rest.split(/[?#]/)[0].split('/').filter(Boolean).map((p) => p.toLowerCase());
  if (parts.length) parts[parts.length - 1] = parts[parts.length - 1].replace(/\.git$/, '');
  if (!parts.length || parts.some((p) => !p || p === '.' || p === '..')) return null;
  if (host === 'github.com' || host === 'www.github.com') {
    if (parts.length < 2) return null;
    return `https://github.com/${parts[0]}/${parts[1]}`;
  }
  return `https://${host}/${parts.join('/')}`;
}

// The repos row that stands for the user's home folder: a conversation under the home folder that is in no repo with
// an origin (a bot, a scratchpad, the home folder itself) syncs under it, and each device's repo_paths root for it is
// its own home (docs/sync-format.md). It is not a URL, so no git remote ever normalizes to it.
const HOME_ORIGIN = 'home:';
// A repos row's origin as both sides read it: the home marker exactly, else normalizeOrigin's string, else null
const rowOrigin = (s) => (s === HOME_ORIGIN ? HOME_ORIGIN : normalizeOrigin(s));
// A rel_cwd under the home row that is never synced, nor made on another machine: the app data folders (Windows'
// AppData, the Mac's Library), and a Claude account's own folder (~/.claude-<letter>: one made on the other machine
// would show there as an account)
const homeSkipped = (relCwd) => /^(?:appdata|library|\.claude-[a-z])$/i.test(String(relCwd || '').split(/[\\/]/)[0]);

// git in a folder (no shell, no window, a time limit) -> its trimmed stdout, or null when it fails
function git(cwd, args) {
  return new Promise((resolve) => {
    try {
      execFile('git', args, { cwd, windowsHide: true, timeout: GIT_TIMEOUT_MS, encoding: 'utf8', maxBuffer: 1024 * 1024 },
        (err, out) => resolve(err ? null : String(out).trim() || null));
    } catch { resolve(null); }
  });
}
const repoCache = new Map(); // folder (folded) -> { at, value: Promise }
// The git checkout a folder is in -> { root, mainRoot, origin } | null (not a git checkout, or no such folder).
//   root      its top-level folder (git rev-parse --show-toplevel), in the platform's own separators. For a worktree
//             (<repo>/.claude/worktrees/<name>) that is the worktree's own folder.
//   mainRoot  the main checkout's top level: the folder holding the shared .git (--git-common-dir's parent); the same
//             as root outside a worktree
//   origin    normalizeOrigin(git remote get-url origin), or null (no origin, or a local one: not synced)
// Cached per folder for 10 minutes (o.fresh asks git again, forgetRepos() empties it); a folder that is not there
// is not cached.
function repoOf(folder, o = {}) {
  if (typeof folder !== 'string' || !folder) return Promise.resolve(null);
  const key = P.foldCase(path.resolve(folder));
  const now = Date.now(), hit = repoCache.get(key);
  if (hit && !o.fresh && now - hit.at < REPO_CACHE_MS) return hit.value;
  const value = (async () => {
    if (!isDir(folder)) return null;
    const top = await git(folder, ['rev-parse', '--show-toplevel']);
    if (!top) return null;
    const root = path.resolve(top);
    const common = await git(folder, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    const mainRoot = common ? path.dirname(path.resolve(common)) : root;
    const origin = normalizeOrigin(await git(folder, ['remote', 'get-url', 'origin']));
    return { root, mainRoot, origin };
  })();
  repoCache.set(key, { at: now, value });
  value.then((v) => { if (v === null && repoCache.get(key)?.value === value && !isDir(folder)) repoCache.delete(key); }, () => repoCache.delete(key));
  return value;
}
const forgetRepos = () => repoCache.clear();

// ---------- file keys and object paths ----------
// A file key ('main', 'subagents/agent-x.jsonl', ...): segments of [A-Za-z0-9._-], never '.' or '..', no empty
// one, and short enough that its base64url fits one storage segment. -> true / false (never throws)
function checkFileKey(k) {
  if (typeof k !== 'string' || !k) return false;
  if (Buffer.byteLength(k, 'utf8') > (MAX_B64 / 4) * 3) return false;
  return k.split('/').every((seg) => KEY_SEG_RE.test(seg) && seg !== '.' && seg !== '..');
}
function fileKeyB64(k) {
  if (!checkFileKey(k)) throw new S.SyncError(`not a file key: ${String(k).slice(0, 120)}`, 400, 'bad_path');
  return Buffer.from(k, 'utf8').toString('base64url');
}
function fileKeyFromB64(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(s)) throw new S.SyncError('not a file key in base64url', 400, 'bad_path');
  const k = Buffer.from(s, 'base64url').toString('utf8');
  if (!checkFileKey(k) || Buffer.from(k, 'utf8').toString('base64url') !== s) throw new S.SyncError('not a file key in base64url', 400, 'bad_path');
  return k;
}
const isCount = (n) => Number.isSafeInteger(n) && n >= 0;
// 't/<conversation id>/<file key in base64url>/<generation>/<seq>' (docs/sync-format.md "Objects"); the id in lower
// case. Every segment passes sync-api.js checkRel, which this calls last, so a bad path throws here and not later.
function objectPath(conversationId, fileKey, generation, seq) {
  if (typeof conversationId !== 'string' || !UUID_RE.test(conversationId)) throw new S.SyncError('not a conversation id', 400, 'bad_path');
  if (!isCount(generation) || !isCount(seq)) throw new S.SyncError('generation and seq are whole numbers from 0', 400, 'bad_path');
  return S.checkRel(`t/${conversationId.toLowerCase()}/${fileKeyB64(fileKey)}/${generation}/${seq}`);
}

// ---------- what of a conversation syncs ----------
// The files of conversation <id> in the slug folder slugDir, per docs/sync-format.md's table:
//   main                      <slugDir>/<id>.jsonl                    append-only
//   subagents/<...>           <slugDir>/<id>/subagents/...            .jsonl append-only, other files whole
//   tool-results/<...>, workflows/<...>   the same, recursively
// Only plain files (no links, no folders), only names that make a good file key; one that does not is skipped and
// handed to o.onSkip(path, why). custom-title.json and anything else under <id>/ is not synced.
// -> [{ fileKey, path, appendOnly, size, mtimeMs }], 'main' first (when it exists), the rest sorted by key.
function conversationFiles(slugDir, id, o = {}) {
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw new S.SyncError('not a conversation id', 400, 'bad_request');
  const skip = typeof o.onSkip === 'function' ? o.onSkip : () => {};
  const out = [];
  const main = path.join(slugDir, `${id}.jsonl`);
  try {
    const st = fs.lstatSync(main);
    if (st.isFile()) out.push({ fileKey: 'main', path: main, appendOnly: true, size: st.size, mtimeMs: st.mtimeMs });
  } catch {}
  const side = [];
  const walk = (dir, key, depth) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name), k = `${key}/${e.name}`;
      if (e.isDirectory()) {
        if (depth >= SIDE_DEPTH) { skip(p, 'too deep'); continue; }
        if (!KEY_SEG_RE.test(e.name) || e.name === '.' || e.name === '..') { skip(p, 'a folder name a file key cannot hold'); continue; }
        walk(p, k, depth + 1);
      } else if (e.isFile()) {
        if (!checkFileKey(k)) { skip(p, 'a name a file key cannot hold'); continue; }
        let st;
        try { st = fs.lstatSync(p); } catch { continue; }
        side.push({ fileKey: k, path: p, appendOnly: e.name.endsWith('.jsonl'), size: st.size, mtimeMs: st.mtimeMs });
      } else skip(p, 'not a plain file');
    }
  };
  for (const d of SIDE_DIRS) {
    const p = path.join(slugDir, id, d);
    try { if (fs.lstatSync(p).isDirectory()) walk(p, d, 1); } catch {}
  }
  side.sort((x, y) => (x.fileKey < y.fileKey ? -1 : x.fileKey > y.fileKey ? 1 : 0));
  return out.concat(side);
}

// ---------- a log's last cwd, branch and title ----------
// From the end of a conversation log, cheaply: the last line with a cwd, the last gitBranch ('HEAD' counts as none,
// as fleet-view.js), and the title: the last custom-title line's (a rename), else the last ai-title's, else the last
// summary's, in what was read. It reads the last 64 KiB, and four times as much again while the cwd or a title is missing, up
// to o.cap (4 MiB) or the whole file. A title found nowhere in what was read comes from <id>/custom-title.json when
// there is one. -> { cwd, branch, title } (each a string or null); all null when the file can't be read.
function lastMeta(mainPath, o = {}) {
  const cap = Number.isSafeInteger(o.cap) && o.cap > 0 ? o.cap : TAIL_CAP;
  const res = { cwd: null, branch: null, title: null };
  let fd;
  try { fd = fs.openSync(mainPath, 'r'); } catch { return res; }
  try {
    const size = fs.fstatSync(fd).size;
    let want = Math.min(o.start || TAIL_START, cap);
    for (;;) {
      const len = Math.min(want, size), buf = Buffer.alloc(len);
      let got = 0;
      while (got < len) { const n = fs.readSync(fd, buf, got, len - got, size - len + got); if (!n) break; got += n; }
      const lines = buf.subarray(0, got).toString('utf8').split('\n');
      if (len < size) lines.shift(); // the first line is probably cut
      const t = { cwd: null, branch: null, custom: null, ai: null, summary: null };
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line || line.charCodeAt(0) !== 123) continue; // '{'
        const has = (s) => line.includes(s);
        if (!(has('"cwd"') || has('"gitBranch"') || has('"custom-title"') || has('"ai-title"') || has('"summary"'))) continue;
        let d;
        try { d = JSON.parse(line); } catch { continue; }
        if (!d || typeof d !== 'object') continue;
        if (t.cwd === null && typeof d.cwd === 'string' && d.cwd) t.cwd = d.cwd;
        if (t.branch === null && typeof d.gitBranch === 'string' && d.gitBranch) t.branch = d.gitBranch;
        if (t.custom === null && d.type === 'custom-title' && typeof d.customTitle === 'string' && d.customTitle) t.custom = d.customTitle;
        if (t.ai === null && d.type === 'ai-title' && typeof d.aiTitle === 'string' && d.aiTitle) t.ai = d.aiTitle;
        if (t.summary === null && d.type === 'summary' && typeof d.summary === 'string' && d.summary) t.summary = d.summary;
        if (t.cwd !== null && t.branch !== null && t.custom !== null) break;
      }
      res.cwd = t.cwd;
      res.branch = t.branch && t.branch !== 'HEAD' ? t.branch : null;
      res.title = t.custom || t.ai || t.summary || null;
      if ((res.cwd && res.title) || len >= size || len >= cap) break;
      want = Math.min(want * 4, cap);
    }
  } catch {} finally { try { fs.closeSync(fd); } catch {} }
  if (!res.title) {
    const id = path.basename(mainPath).replace(/\.jsonl$/, '');
    try {
      const j = JSON.parse(fs.readFileSync(path.join(path.dirname(mainPath), id, 'custom-title.json'), 'utf8'));
      if (j && typeof j.customTitle === 'string' && j.customTitle) res.title = j.customTitle;
    } catch {}
  }
  return res;
}

// ---------- the folder a log lives in ----------
// Claude Code keeps a conversation in the slug folder of the folder it started in. A later cd or worktree switch
// changes the cwd its lines carry, not where the log is: a session started in a repo root that moved into
// .claude/worktrees/x stays in the root's slug folder, and resumes from the root. -> of the log's last cwd (lastCwd,
// lastMeta's) and its first one, the one whose slug is the name of the folder the log is in (ignoring case where
// paths do; a slug past SLUG_MAX by its first SLUG_MAX characters), else null.
function homeCwd(mainPath, lastCwd, o = {}) {
  const want = P.foldCase(path.basename(path.dirname(path.resolve(mainPath))));
  const fits = (cwd) => {
    if (typeof cwd !== 'string' || !cwd) return false;
    const s = P.foldCase(slugOf(cwd));
    return s === want || (s.length > SLUG_MAX && want.startsWith(s.slice(0, SLUG_MAX)));
  };
  if (fits(lastCwd)) return lastCwd;
  const first = firstCwd(mainPath, o);
  return fits(first) ? first : null;
}
// The first line's cwd in a log: from its first 64 KiB, four times as much again while there is none, up to o.cap
// (4 MiB) or the whole file. null when none was found or the file can't be read.
function firstCwd(mainPath, o = {}) {
  const cap = Number.isSafeInteger(o.cap) && o.cap > 0 ? o.cap : TAIL_CAP;
  let fd;
  try { fd = fs.openSync(mainPath, 'r'); } catch { return null; }
  try {
    const size = fs.fstatSync(fd).size;
    let want = Math.min(o.start || TAIL_START, cap);
    for (;;) {
      const len = Math.min(want, size), buf = Buffer.alloc(len);
      let got = 0;
      while (got < len) { const n = fs.readSync(fd, buf, got, len - got, got); if (!n) break; got += n; }
      const lines = buf.subarray(0, got).toString('utf8').split('\n');
      if (got < size) lines.pop(); // the last line is probably cut
      for (const line of lines) {
        if (!line || line.charCodeAt(0) !== 123 || !line.includes('"cwd"')) continue; // '{'
        let d;
        try { d = JSON.parse(line); } catch { continue; }
        if (d && typeof d.cwd === 'string' && d.cwd) return d.cwd;
      }
      if (len >= size || len >= cap) return null;
      want = Math.min(want * 4, cap);
    }
  } catch { return null; } finally { try { fs.closeSync(fd); } catch {} }
}

// ---------- state files ----------
// A JSON state file -> its value, or fallback when it is missing or not valid JSON (never throws)
function readState(file, fallback = null) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return v === undefined ? fallback : v;
  } catch { return fallback; }
}
// Written whole or not at all: a temp file beside it (mode 0600), then a rename over it. On Windows a rename can
// fail for a moment while something else has the file open (an antivirus scan, a reader); it is tried again a few
// times before giving up.
function writeState(file, obj) {
  const data = `${JSON.stringify(obj, null, 2)}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    for (let i = 0; ; i++) {
      try { fs.renameSync(tmp, file); break; } catch (e) {
        if (i >= 5 || !e || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;
        const until = Date.now() + 20 * (i + 1);
        while (Date.now() < until) { /* a short wait, synchronous like the write */ }
      }
    }
  } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch {} throw e; }
  try { fs.chmodSync(file, 0o600); } catch {}
}

// ---------- this machine's devices row ----------
const devicePath = (dataDir) => path.join(S.syncDir(dataDir), 'device.json');
const deviceChecked = new Map(); // device.json path -> id already checked against Supabase by this process
// This machine's device id. <dataDir>/sync/device.json { id } when its row is still there (asked once per process);
// else a new fleet_sync.devices row { name: hostname, platform: process.platform } (the server fills in the user and
// the id) whose id is saved. api: sync-api.js createSync()'s object (only api.rest is used). A failure to reach
// Supabase throws (a SyncError) and changes nothing on disk; the caller tries again later. Calls for one device.json
// at the same time share one answer: the uploader, the materializer and the mover all start at once, and each making
// its own row would leave them with different ids for this machine.
const deviceFlight = new Map(); // device.json path -> the ensureDevice under way for it
function ensureDevice(api, dataDir) {
  const file = devicePath(dataDir);
  const going = deviceFlight.get(file);
  if (going) return going;
  const p = ensureDeviceOnce(api, dataDir).finally(() => { if (deviceFlight.get(file) === p) deviceFlight.delete(file); });
  deviceFlight.set(file, p);
  return p;
}
async function ensureDeviceOnce(api, dataDir) {
  const file = devicePath(dataDir);
  const saved = readState(file, null);
  const id = saved && typeof saved.id === 'string' && UUID_RE.test(saved.id) ? saved.id.toLowerCase() : null;
  if (id && deviceChecked.get(file) === id) return id;
  if (id) {
    const rows = await api.rest('GET', 'devices', { query: { select: 'id', id: `eq.${id}` } });
    if (Array.isArray(rows) && rows.some((r) => r && String(r.id).toLowerCase() === id)) { deviceChecked.set(file, id); return id; }
  }
  const made = await api.rest('POST', 'devices', { body: { name: os.hostname().slice(0, 200), platform: process.platform }, prefer: 'return=representation' });
  const row = Array.isArray(made) ? made[0] : made;
  const nid = row && typeof row.id === 'string' && UUID_RE.test(row.id) ? row.id.toLowerCase() : null;
  if (!nid) throw new S.SyncError('Supabase made no device row', 0, 'bad_reply');
  writeState(file, { id: nid });
  deviceChecked.set(file, nid);
  return nid;
}
const touchedAt = new Map(); // device id -> when its last_seen_at was last set by this process
// devices.last_seen_at = now, at most every 5 minutes per device (o.force: now anyway). -> true when it was sent,
// false when it was too soon. A failure throws and is not counted, so the next call tries again.
async function touchDevice(api, id, o = {}) {
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw new S.SyncError('not a device id', 400, 'bad_request');
  const now = o.now || Date.now(), last = touchedAt.get(id.toLowerCase());
  if (!o.force && last !== undefined && now - last < TOUCH_MS) return false;
  await api.rest('PATCH', 'devices', { query: { id: `eq.${id.toLowerCase()}` }, body: { last_seen_at: new Date(now).toISOString() }, prefer: 'return=minimal' });
  touchedAt.set(id.toLowerCase(), now);
  return true;
}

// ---------- is it running here ----------
// Claude Code writes <config>/sessions/<pid>.json { pid, sessionId, ... } for every process it runs and removes it
// when it ends; a file whose pid is gone (a claude that was killed) does not count. This is how fleet-view.js
// scanLiveProcs tells, and the session host's panels write these files too. Every account folder is read (any
// ~/.claude-<x>, not only A: a conversation open under any login is open), each real folder once.
const pidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return !!e && e.code === 'EPERM'; }
};
function sessionDirs(home) {
  const dirs = [path.join(home, '.claude', 'sessions')];
  try {
    for (const e of fs.readdirSync(home, { withFileTypes: true })) if (/^\.claude-[a-z]$/i.test(e.name)) dirs.push(path.join(home, e.name, 'sessions'));
  } catch {}
  const seen = new Set();
  return dirs.filter((d) => { if (!isDir(d)) return false; const r = P.foldCase(realOr(d)); if (seen.has(r)) return false; seen.add(r); return true; });
}
const liveCache = new Map(); // home -> { at, ids: Set of lower-case session ids }
function liveIds(o = {}) {
  const home = homeOf(o), now = Date.now(), hit = liveCache.get(home);
  if (hit && !o.fresh && now - hit.at < LIVE_CACHE_MS) return hit.ids;
  const ids = new Set();
  for (const dir of sessionDirs(home)) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch {}
    for (const f of names) {
      if (!/^\d+\.json$/.test(f)) continue;
      const j = readState(path.join(dir, f), null);
      if (j && typeof j.sessionId === 'string' && pidAlive(j.pid)) ids.add(j.sessionId.toLowerCase());
    }
  }
  liveCache.set(home, { at: now, ids });
  return ids;
}
// o.home (tests), o.fresh (skip the 2 s cache)
const isLive = (id, o = {}) => typeof id === 'string' && !!id && liveIds(o).has(id.toLowerCase());

module.exports = {
  slugOf, projectsDirs, normalizeOrigin, HOME_ORIGIN, rowOrigin, homeSkipped, repoOf, forgetRepos, checkFileKey, fileKeyB64, fileKeyFromB64, objectPath,
  conversationFiles, lastMeta, homeCwd, ensureDevice, touchDevice, devicePath, isLive, pidAlive, readState, writeState,
  SIDE_DIRS, TOUCH_MS,
};
