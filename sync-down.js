// sync-down.js: the materializer (the sync plan's part S3). It brings conversations another machine uploaded
// (sync-up.js, S2) down into this machine's Claude projects folders, so they can be resumed here. docs/sync-format.md
// "The materializer's rules" is what it does; docs/sync-move-recipe.md is how a conversation must be laid down so
// `claude --resume` picks it up in the right folder. It reaches Supabase only through the api object it is handed
// (sync-api.js createSync()), opens what it fetches with sync-crypto.js, and names things with sync-common.js.
//
//   createMaterializer({ api, dataDir, key, log, now, projects, roots, home, isOpen, only })
//     (projects: [{ account, dir }], or a function giving it; ~/.claude for B and ~/.claude-a for A when not given;
//     isOpen(id): true when this machine has it open in a way sessions/<pid>.json does not show yet, such as a panel
//     the session host is starting; only(id): a scan looks only at the conversations this says true for, live tests)
//     -> { scanOnce(), start(intervalMs = 5000), stop(), status(), conflicts(), pull(id), owners() }
//
// For S4's moves (sync-move.js), with ids lower-case:
//   pull(id) -> Promise<{ outcome, reason?, dir?, folder?, row? }>: lay that conversation down now. It is urgent: a
//     running scan lets it go next, between two conversations; with no scan it runs at once (one lock for both, so a
//     conversation is never laid down twice at once). Its row is read whoever owns it: none (or not active) ->
//     { outcome: 'missing' }; this device's -> { outcome: 'mine', row }; else its back-off is cleared and it is laid
//     down as a scan would (steps 3 to 8) -> that outcome ('done' | 'same' | 'conflict' | 'skip' | 'pending'), the
//     reason, dir (the slug folder its log is in, absolute), folder (the resume folder X from root + rel_cwd) and the
//     row. A failure throws, as in a scan (no back-off is set for it).
//   owners() -> Map<id, { device, leaseUntil }>: the active rows other devices own, from the last scan's list (device
//     lower-case, leaseUntil = Date.parse(lease_until) or null). Empty before the first scan. status().listedAt is
//     when that list began (ISO), so a change of owner made before then is in it.
//
// One scan:
//   1. This machine's device row (ensureDevice; last_seen_at at most every 5 minutes).
//   2. Every active conversation row owned by another device, newest first. A row whose updated_at, generation, size
//      and sha256 are what down-state.json says was laid down costs nothing more.
//   3. Its repo: this device's repo_paths row for the repo when that folder still has the repo's origin, else the
//      repos Fleet View knows (the roots option; ~/.fleet-view.json's added and remembered repos when it is not
//      given) matched by origin, and then this device's repo_paths row is written. No checkout here: skipped. The home
//      row (sync-common.js HOME_ORIGIN) is this machine's home folder (the home option), always there.
//   4. Folder X = that main checkout + rel_cwd ('..', an absolute path or a drive is refused). A rel_cwd whose folder
//      is not on this machine (a worktree the other machine made) falls back to the root. Under the home row a missing
//      folder is made instead (empty, logged once), so the conversation shows and resumes where it began; never
//      through a link, never outside home. A conversation already on
//      this machine (laid down before, or its log in any slug folder of the account's projects folder: one this
//      machine started) stays in that slug folder while its file is there, so it never ends up in two.
//   5. Skipped while a Claude Code process on this machine has it open (sessions/<pid>.json), or isOpen(id) says so.
//   6. main: the chunk rows of the row's generation, ordered by seq, must cover [0, size) with no gap; each object's
//      path must be the one objectPath() names for its row, it is opened with that path as the label (so an object
//      copied to another path does not open), and its sha256 and then the whole file's are checked. Side files
//      (subagents/, tool-results/, workflows/) the same way under <slug>/<id>/, from their newest generation; a side
//      file with two generations up at once is mid-upload and waits for the next scan.
//   7. Laid down per the recipe: <file>.part, then a rename over the local copy (a main log then gets its last
//      entry's time as its modified time, so it does not look like it just worked). A local copy is replaced only when it
//      is a byte prefix of the new bytes (chunks it already holds are compared by sha256 and not downloaded). A longer
//      or different local copy is left alone, nothing is written for that conversation, and it is listed in
//      conflicts() until its row or the local file changes. Two exceptions: a whole side file (not .jsonl) this side
//      laid down itself and that nobody changed since may be replaced by the other machine's new version; and a .jsonl
//      whose last line was cut off (its writer ended mid-line, so that part never went up) counts by its whole lines,
//      and the new bytes replace the cut line.
//      Every path is checked to stay inside the projects folder, with no link on the way, before anything is written.
//   8. What was laid down goes in <dataDir>/sync/down-state.json after each conversation. A conversation that fails
//      (a missing object, a gap, a bad sha256, the network) writes nothing, leaves no .part, and is tried again after
//      a back-off (30 s, doubling up to 30 minutes).
//
// status() holds counts, times and the last error's message: never the key, a token or a title.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const P = require(path.join(__dirname, 'platform.js'));
const S = require(path.join(__dirname, 'sync-api.js'));
const X = require(path.join(__dirname, 'sync-crypto.js'));
const C = require(path.join(__dirname, 'sync-common.js'));
const { lastLineEnd } = require(path.join(__dirname, 'sync-up.js'));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX64_RE = /^[0-9a-f]{64}$/;
const PAGE = 1000; // conversation rows per request (Supabase's default max-rows)
const READ_PIECE = 1024 * 1024; // local files are hashed and copied this much at a time
const BACKOFF_MIN_MS = 30e3;
const BACKOFF_MAX_MS = 30 * 60e3;
const BAD_SEG_RE = /[<>:"|?*\\\x00-\x1f]/; // what a rel_cwd segment may not hold (Windows names, drives, streams)

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const lstatOr = (p) => { try { return fs.lstatSync(p); } catch { return null; } };
const fold = (p) => P.foldCase(path.resolve(p));
const fail = (message, code) => { throw new S.SyncError(message, 0, code); };
const downStatePath = (dataDir) => path.join(S.syncDir(dataDir), 'down-state.json');

// ---------- paths ----------
// rel_cwd -> its segments ([] for the root), or null when it is not a plain relative path made of '/'-separated
// folder names: '..', '.', an empty segment, a leading '/', a backslash, a drive ('C:') or any ':' are refused
function relParts(rel) {
  if (rel === null || rel === undefined || rel === '') return [];
  if (typeof rel !== 'string' || rel.length > 1024) return null;
  const segs = rel.split('/');
  if (segs.some((s) => !s || s === '.' || s === '..' || BAD_SEG_RE.test(s) || s.length > 255)) return null;
  return segs;
}
// p is inside base (not base itself)
function inside(base, p) {
  const r = path.relative(path.resolve(base), path.resolve(p));
  return !!r && !path.isAbsolute(r) && r.split(path.sep)[0] !== '..';
}
// no link (or junction) from base down to base/parts...: a folder that is not there yet is fine
function noLinks(base, parts) {
  let cur = base;
  for (const part of parts) {
    cur = path.join(cur, part);
    const st = lstatOr(cur);
    if (!st) return true;
    if (st.isSymbolicLink()) return false;
  }
  return true;
}

// ---------- chunk rows ----------
// The rows of one file's generation, sorted by seq -> the ones that make [0, size) (size null: all of them), checked:
// seq 0, 1, 2..., each starting where the one before ended, each object at the path objectPath() names for it, a hex
// sha256. Rows past size (the uploader writes a chunk row before the conversation row) are left out. Throws a
// SyncError: 'gap' (a hole, or not enough to reach size), 'bad_chunk', 'bad_path'.
function planChunks(id, file, generation, rows, size) {
  const out = [];
  let off = 0;
  for (let i = 0; i < rows.length; i++) {
    const c = rows[i];
    if (size !== null && off >= size) break;
    const seq = Number(c.seq), start = Number(c.byte_offset), len = Number(c.byte_length);
    if (seq !== i || start !== off) fail(`${file}: the chunks have a gap at byte ${off} (seq ${i})`, 'gap');
    // an empty file is one empty chunk; otherwise every chunk holds bytes
    if (!Number.isSafeInteger(len) || len < 0 || (len === 0 && rows.length > 1)) fail(`${file}: chunk ${seq} has no length`, 'bad_chunk');
    if (size !== null && off + len > size) fail(`${file}: chunk ${seq} runs past the file's size`, 'bad_chunk');
    if (typeof c.sha256 !== 'string' || !HEX64_RE.test(c.sha256)) fail(`${file}: chunk ${seq} has no sha256`, 'bad_chunk');
    if (c.object_path !== C.objectPath(id, file, generation, seq)) fail(`${file}: chunk ${seq}'s object is not where it belongs`, 'bad_path');
    out.push({ seq, start, len, end: off + len, sha256: c.sha256, objectPath: c.object_path });
    off += len;
  }
  if (size !== null && off !== size) fail(`${file}: the chunks cover ${off} of ${size} bytes`, 'gap');
  return { chunks: out, size: off };
}

// ---------- local files ----------
function readRange(fd, start, len) {
  const buf = Buffer.alloc(len);
  let got = 0;
  while (got < len) { const n = fs.readSync(fd, buf, got, len - got, start + got); if (!n) break; got += n; }
  return got === len ? buf : buf.subarray(0, got);
}
function hashRange(fd, start, len, also) {
  const h = crypto.createHash('sha256');
  for (let at = start; at < start + len; at += READ_PIECE) {
    const b = readRange(fd, at, Math.min(READ_PIECE, start + len - at));
    h.update(b);
    if (also) also.update(b);
    if (!b.length) break;
  }
  return h.digest('hex');
}
function renameOver(from, to) {
  for (let i = 0; ; i++) {
    try { fs.renameSync(from, to); return; } catch (e) {
      if (i >= 5 || !e || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;
      const until = Date.now() + 20 * (i + 1);
      while (Date.now() < until) { /* a short wait: something (an antivirus scan) had the file open */ }
    }
  }
}
// A log just laid down gets the time of its last entry as its modified time, not the moment it came down: Fleet View
// and `claude --resume` take a log's modified time as when it last worked, so a months-old conversation that came
// down now would show as just finished. -> that time (ms), or null when the end of the log names none (left as is).
const TAIL_BYTES = 256 << 10;
function stampLastEntry(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size, len = Math.min(size, TAIL_BYTES);
    const text = readRange(fd, size - len, len).toString('utf8');
    let last = null;
    for (const m of text.matchAll(/"timestamp":"([^"]{10,40})"/g)) { const t = Date.parse(m[1]); if (Number.isFinite(t) && (last === null || t > last)) last = t; }
    fs.closeSync(fd); fd = null;
    if (last === null || last > Date.now()) return null;
    fs.utimesSync(file, new Date(), new Date(last));
    return last;
  } catch { return null; } finally { if (fd !== null) { try { fs.closeSync(fd); } catch {} } }
}

// The folders Fleet View knows as repos when no roots option is given: ~/.fleet-view.json's addedRepos and
// remembered.repos (what fleet-view.js pageRepos() lists)
function settingsRoots(home) {
  const j = C.readState(path.join(home, '.fleet-view.json'), null);
  const out = [];
  if (j && Array.isArray(j.addedRepos)) for (const r of j.addedRepos) if (r && typeof r.root === 'string') out.push(r.root);
  if (j && j.remembered && Array.isArray(j.remembered.repos)) for (const r of j.remembered.repos) if (r && typeof r.root === 'string') out.push(r.root);
  return out;
}

// ---------- the materializer ----------
function createMaterializer(opts = {}) {
  const api = opts.api;
  if (!api || typeof api.rest !== 'function' || !api.storage) throw new S.SyncError('createMaterializer needs the sync api', 400, 'bad_request');
  const dataDir = opts.dataDir || P.dataDir();
  const home = opts.home || os.homedir();
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const statePath = downStatePath(dataDir);

  let keyBuf = Buffer.isBuffer(opts.key) ? opts.key : null;
  async function getKey() {
    if (keyBuf) return keyBuf;
    if (typeof opts.key === 'function') {
      const k = await opts.key();
      if (Buffer.isBuffer(k) && k.length === 32) keyBuf = k; // loadKey() asks DPAPI: once is enough
    }
    return keyBuf;
  }

  // ---------- state ----------
  // { v: 1, convos: { <id>: { sig, dir, files: { <file key>: { generation, size, sha256 } }, conflict, localStamp, at } },
  //   conflicts: { '<id>|<file key>': { id, file, path, reason, localSize, remoteSize, at } } }
  function loadState() {
    const s = C.readState(statePath, null);
    return {
      v: 1,
      convos: s && s.convos && typeof s.convos === 'object' ? s.convos : {},
      conflicts: s && s.conflicts && typeof s.conflicts === 'object' ? s.conflicts : {},
    };
  }
  let state = loadState();
  const saveState = () => { try { C.writeState(statePath, state); } catch (e) { log(`sync-down: down-state.json could not be saved: ${e.message}`); } };
  const sigOf = (row) => `${row.updated_at}|${row.generation}|${row.size}|${row.sha256 || ''}`;
  const stampOf = (p) => { const st = lstatOr(p); return st ? `${st.size}:${st.mtimeMs}` : 'none'; };

  const backoff = new Map(); // id -> { n, until }
  let ownersMap = new Map(); // id -> { device, leaseUntil }: the last scan's rows other devices own
  const onlyOf = () => (typeof opts.only === 'function' ? opts.only : null);

  // ---------- one conversation at a time ----------
  // A scan takes this lock for each row and pull() for its whole run. An urgent waiter (pull) goes ahead of the scan's
  // next row, behind any earlier urgent one.
  let lockHeld = false;
  const lockQ = []; // { urgent, go }
  function lock(urgent) {
    if (!lockHeld) { lockHeld = true; return Promise.resolve(); }
    return new Promise((go) => {
      const e = { urgent, go };
      if (!urgent) { lockQ.push(e); return; }
      let i = 0;
      while (i < lockQ.length && lockQ[i].urgent) i++;
      lockQ.splice(i, 0, e);
    });
  }
  function unlock() { const n = lockQ.shift(); if (n) n.go(); else lockHeld = false; }
  const st = { running: false, scanning: false, scans: 0, lastScanAt: null, lastOkAt: null, listedAt: null, lastError: null, last: null, laidDown: 0 };

  const live = (id) => C.isLive(id, { home, fresh: true }) || (typeof opts.isOpen === 'function' && !!opts.isOpen(id));

  // ---------- projects folders ----------
  function projectsFor(account) {
    const given = typeof opts.projects === 'function' ? opts.projects() : opts.projects;
    const raw = Array.isArray(given) ? given : [
      { account: 'b', dir: path.join(home, '.claude', 'projects') },
      { account: 'a', dir: path.join(home, '.claude-a', 'projects') },
    ];
    const list = C.projectsDirs({ dirs: raw });
    const hit = list.find((r) => r.account === account);
    if (hit) return path.resolve(hit.dir);
    // A's folder shared with B's (a junction): projectsDirs gives it once, as B's
    const mine = raw.find((r) => r && r.account === account && typeof r.dir === 'string' && isDir(r.dir));
    const b = list.find((r) => r.account === 'b');
    try { if (mine && b && fold(fs.realpathSync(mine.dir)) === fold(fs.realpathSync(b.dir))) return path.resolve(b.dir); } catch {}
    return null;
  }

  // ---------- repos ----------
  async function candidateRoots() {
    let list = opts.roots;
    if (typeof list === 'function') list = await list();
    if (!Array.isArray(list)) list = settingsRoots(home);
    return list.filter((r) => typeof r === 'string' && r && path.isAbsolute(r));
  }
  function newCtx(me) {
    const ctx = { me, repos: null, repoPaths: null, local: null, roots: new Map(), logs: new Map() };
    // projects folder + id -> the slug folder already holding <id>.jsonl, or null (each folder listed once a scan)
    ctx.localDir = (projects, id) => {
      const k = fold(projects);
      if (!ctx.logs.has(k)) {
        const ids = new Map();
        let slugs = [];
        try { slugs = fs.readdirSync(projects, { withFileTypes: true }); } catch {}
        for (const s of slugs) {
          if (!s.isDirectory()) continue;
          let names = [];
          try { names = fs.readdirSync(path.join(projects, s.name)); } catch { continue; }
          for (const n of names) {
            const m = /^([0-9a-f-]{36})\.jsonl$/i.exec(n);
            if (m && !ids.has(m[1].toLowerCase())) ids.set(m[1].toLowerCase(), path.join(projects, s.name));
          }
        }
        ctx.logs.set(k, ids);
      }
      return ctx.logs.get(k).get(id) || null;
    };
    ctx.loadRepos = async () => {
      if (ctx.repos) return;
      const rows = await api.rest('GET', 'repos', { query: { select: 'id,origin' } });
      ctx.repos = new Map((Array.isArray(rows) ? rows : []).filter((r) => r && typeof r.id === 'string').map((r) => [r.id.toLowerCase(), C.rowOrigin(r.origin) || null]));
      const paths = await api.rest('GET', 'repo_paths', { query: { select: 'repo_id,root', device_id: `eq.${me}` } });
      ctx.repoPaths = new Map((Array.isArray(paths) ? paths : []).filter((r) => r && typeof r.repo_id === 'string' && typeof r.root === 'string').map((r) => [r.repo_id.toLowerCase(), r.root]));
    };
    ctx.localOrigins = async () => {
      if (ctx.local) return ctx.local;
      ctx.local = new Map();
      for (const root of await candidateRoots()) {
        const r = await C.repoOf(root);
        if (r && r.origin && !ctx.local.has(r.origin)) ctx.local.set(r.origin, r.mainRoot);
      }
      return ctx.local;
    };
    return ctx;
  }
  // repo id -> this device's main checkout of it (this machine's home folder for the home row), or null
  async function rootFor(repoId, ctx) {
    if (typeof repoId !== 'string' || !UUID_RE.test(repoId)) return null;
    const id = repoId.toLowerCase();
    if (ctx.roots.has(id)) return ctx.roots.get(id);
    await ctx.loadRepos();
    const origin = ctx.repos.get(id);
    let found = null;
    const saved = ctx.repoPaths.get(id);
    const remember = async () => {
      if (!found || (saved && fold(saved) === fold(found))) return;
      try {
        await api.rest('POST', 'repo_paths', { body: { device_id: ctx.me, repo_id: id, root: found }, prefer: 'resolution=merge-duplicates,return=minimal' });
        ctx.repoPaths.set(id, found);
      } catch (e) { log(`sync-down: this device's repo_paths row could not be written: ${e.message}`); }
    };
    if (origin === C.HOME_ORIGIN) {
      found = isDir(home) ? path.resolve(home) : null;
      await remember();
    } else if (origin) {
      if (saved && path.isAbsolute(saved) && isDir(saved)) {
        const r = await C.repoOf(saved);
        if (r && r.origin === origin) found = r.mainRoot;
      }
      if (!found) {
        found = (await ctx.localOrigins()).get(origin) || null;
        await remember();
      }
    }
    ctx.roots.set(id, found);
    return found;
  }
  const isHomeRow = (repoId, ctx) => typeof repoId === 'string' && !!ctx.repos && ctx.repos.get(repoId.toLowerCase()) === C.HOME_ORIGIN;

  // ---------- laying one file down ----------
  // job: { id, file, target, chunks, size, sha256 (whole file, or null), whole, known ({ size, sha256 } this side laid
  // down last, or null) } -> { result: 'same' | 'written' } | { result: 'conflict', reason, localSize }
  // Throws on a missing object, a bad sha256, a live conversation or a local file that changed meanwhile; then the
  // .part is gone and the local copy untouched.
  // ignoreLocal: replace the local copy whatever it holds (only for unchanged(), below)
  async function layDown(job, key, ignoreLocal = false) {
    const { target } = job;
    const before = lstatOr(target);
    if (before && !before.isFile()) return { result: 'conflict', reason: 'not a plain file', localSize: null };
    const part = `${target}.part`;
    let fd = null, pfd = null, wrote = false;
    try {
      let localSize = before && !ignoreLocal ? before.size : 0;
      if (before && !ignoreLocal) fd = fs.openSync(target, 'r');
      // a .jsonl whose last line was cut off (its writer ended mid-line; the uploader never sends that part, and
      // sync-move.js hands a conversation over without it): only its whole lines count, the new bytes replace the rest
      let cut = 0;
      if (fd !== null && !job.whole && localSize > 0) {
        const end = lastLineEnd(fd, 0, localSize);
        if (end < localSize) { cut = localSize - end; localSize = end; }
      }
      if (fd !== null && localSize > job.size) return { result: 'conflict', reason: 'the local copy is longer', localSize };
      // the chunks the local copy holds already: compared by sha256, not downloaded; any that differs is a conflict
      const whole = crypto.createHash('sha256');
      const have = new Set();
      if (fd !== null) {
        for (const c of job.chunks) {
          if (c.end > localSize) break;
          if (hashRange(fd, c.start, c.len, whole) !== c.sha256) return { result: 'conflict', reason: 'the local copy is different', localSize };
          have.add(c.seq);
        }
        if (localSize === job.size && have.size === job.chunks.length && !cut) {
          if (job.sha256 && whole.digest('hex') !== job.sha256) fail(`${job.file}: the file's sha256 is not the row's`, 'bad_sha');
          return { result: 'same' };
        }
      }
      // the rest: <target>.part, the local bytes it holds copied, the others fetched and opened
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const total = crypto.createHash('sha256');
      pfd = fs.openSync(part, 'w');
      wrote = true;
      let at = 0;
      for (const c of job.chunks) {
        let buf;
        if (have.has(c.seq)) {
          for (let o = c.start; o < c.end; o += READ_PIECE) {
            const b = readRange(fd, o, Math.min(READ_PIECE, c.end - o));
            total.update(b);
            fs.writeSync(pfd, b, 0, b.length, at);
            at += b.length;
          }
          continue;
        }
        const blob = await api.storage.download(c.objectPath);
        buf = X.openChunk(Buffer.from(blob), key, c.objectPath);
        if (buf.length !== c.len || X.sha256(buf) !== c.sha256) fail(`${job.file}: chunk ${c.seq} is not what its row says (length or sha256)`, 'bad_sha');
        if (fd !== null && c.start < localSize) {
          const mine = readRange(fd, c.start, localSize - c.start);
          if (!mine.equals(buf.subarray(0, mine.length))) return { result: 'conflict', reason: 'the local copy is different', localSize };
        }
        total.update(buf);
        fs.writeSync(pfd, buf, 0, buf.length, at);
        at += buf.length;
      }
      if (at !== job.size) fail(`${job.file}: ${at} bytes put together, ${job.size} expected`, 'gap');
      if (job.sha256 && total.digest('hex') !== job.sha256) fail(`${job.file}: the file's sha256 is not the row's`, 'bad_sha');
      fs.fsyncSync(pfd);
      fs.closeSync(pfd); pfd = null;
      if (fd !== null) { fs.closeSync(fd); fd = null; }
      // last checks, right before the rename: not opened here meanwhile, the local copy as it was, still inside
      if (live(job.id)) fail('the conversation was opened on this machine meanwhile', 'live');
      const now2 = lstatOr(target);
      if (!!now2 !== !!before || (before && (now2.size !== before.size || now2.mtimeMs !== before.mtimeMs))) fail(`${job.file}: the local copy changed meanwhile`, 'changed');
      renameOver(part, target);
      wrote = false;
      if (cut) log(`sync-down: ${job.id} ${job.file}: its cut last line (${cut} bytes) was replaced`);
      return { result: 'written' };
    } finally {
      if (pfd !== null) { try { fs.closeSync(pfd); } catch {} }
      if (fd !== null) { try { fs.closeSync(fd); } catch {} }
      if (wrote) { try { fs.rmSync(part, { force: true }); } catch {} }
    }
  }

  // a whole side file that is still exactly what this side laid down last (nobody changed it here since)
  function unchanged(target, known) {
    const st0 = lstatOr(target);
    if (!known || !st0 || !st0.isFile() || st0.size !== known.size || typeof known.sha256 !== 'string') return false;
    let fd = null;
    try { fd = fs.openSync(target, 'r'); return hashRange(fd, 0, st0.size) === known.sha256; } catch { return false; } finally { if (fd !== null) { try { fs.closeSync(fd); } catch {} } }
  }
  // layDown, and for a whole side file the one exception: a new version from the other machine replaces a local copy
  // that is not its prefix when that copy is the one this side wrote and nobody changed since
  async function layDownFile(job, key) {
    const r = await layDown(job, key);
    if (r.result === 'conflict' && job.whole && unchanged(job.target, job.known)) return layDown(job, key, true);
    return r;
  }

  // ---------- one conversation ----------
  // -> { outcome: 'done' | 'same' | 'conflict' | 'skip' | 'pending', reason, folder, dir }; throws when it failed
  // (tried again later). folder (the resume folder X) and dir (its slug folder) come once they are known.
  async function syncOne(row, ctx, key) {
    const id = row.id.toLowerCase();
    const prev = state.convos[id] || null;
    const root = await rootFor(row.repo_id, ctx);
    if (!root) return { outcome: 'skip', reason: 'no checkout of its repo here' };
    const parts = relParts(row.rel_cwd);
    if (!parts) return { outcome: 'skip', reason: 'its rel_cwd is not a plain relative path' };
    let folder = parts.length ? path.resolve(root, ...parts) : path.resolve(root);
    let makeFolder = false;
    if (isHomeRow(row.repo_id, ctx)) {
      // under home: the folder it began in, made when this machine has none (never through a link, never outside home)
      if (parts.length && !inside(root, folder)) return { outcome: 'skip', reason: 'its rel_cwd is not a plain relative path' };
      // a folder never made here (an app data or Claude account folder, sync-common.js homeSkipped), or something not
      // a folder in its place: the home folder itself, as a repo row falls back to its root
      const inWay = () => { try { fs.lstatSync(folder); return true; } catch { return false; } };
      if (!isDir(folder) && (C.homeSkipped(row.rel_cwd) || inWay())) folder = path.resolve(root);
      else if (!isDir(folder)) {
        if (!noLinks(root, parts)) return { outcome: 'skip', reason: 'its folder would be made through a link', folder };
        makeFolder = true;
      }
    } else if (parts.length && (!inside(root, folder) || !isDir(folder))) folder = path.resolve(root);
    const projects = projectsFor(row.account);
    if (!projects) return { outcome: 'skip', reason: `no projects folder for account ${row.account}`, folder };
    let slugDir = path.join(projects, C.slugOf(folder));
    // once on this machine, it stays where it is while its file is there (never two copies on one machine): where it
    // was laid down, else wherever its log already is (one this machine started, that another one took over)
    if (prev && typeof prev.dir === 'string' && inside(projects, prev.dir) && fold(path.dirname(prev.dir)) === fold(projects)
      && lstatOr(path.join(prev.dir, `${id}.jsonl`))) slugDir = path.resolve(prev.dir);
    else if (!lstatOr(path.join(slugDir, `${id}.jsonl`))) slugDir = ctx.localDir(projects, id) || slugDir;
    if (!inside(projects, slugDir) || fold(path.dirname(slugDir)) !== fold(projects) || !noLinks(projects, [path.basename(slugDir), id])) {
      return { outcome: 'skip', reason: 'its folder would be outside the projects folder', folder };
    }
    const dir = path.resolve(slugDir);
    if (live(id)) return { outcome: 'skip', reason: 'open on this machine', folder, dir };

    // every chunk row of the conversation, at once
    const rows = await api.rest('GET', 'chunks', {
      query: { select: 'file,generation,seq,byte_offset,byte_length,object_path,sha256', conversation_id: `eq.${id}`, order: 'file.asc,generation.asc,seq.asc' },
    });
    const byFile = new Map();
    for (const c of Array.isArray(rows) ? rows : []) {
      if (!c || typeof c.file !== 'string') continue;
      if (!byFile.has(c.file)) byFile.set(c.file, new Map());
      const g = Number(c.generation);
      if (!Number.isSafeInteger(g) || g < 0) continue;
      const gens = byFile.get(c.file);
      if (!gens.has(g)) gens.set(g, []);
      gens.get(g).push(c);
    }
    const sortSeq = (list) => list.slice().sort((a, b) => Number(a.seq) - Number(b.seq));

    // main
    const size = Number(row.size), gen = Number(row.generation);
    const files = {};
    let pending = 0, wroteAny = false;
    const conflict = (file, target, r) => {
      state.conflicts[`${id}|${file}`] = { id, file, path: target, reason: r.reason, localSize: r.localSize, remoteSize: file === 'main' ? size : null, at: new Date(now()).toISOString() };
      state.convos[id] = { sig: sigOf(row), dir: slugDir, files: prev ? prev.files || {} : {}, conflict: true, localStamp: stampOf(path.join(slugDir, `${id}.jsonl`)), at: now() };
      saveState();
      log(`sync-down: ${id} ${file}: ${r.reason}; left alone`);
      return { outcome: 'conflict', reason: r.reason, folder, dir };
    };
    const mainTarget = path.join(slugDir, `${id}.jsonl`);
    if (size > 0) {
      const plan = planChunks(id, 'main', gen, sortSeq((byFile.get('main') || new Map()).get(gen) || []), size);
      if (!row.sha256 || !HEX64_RE.test(row.sha256)) fail('main: the row has no sha256', 'bad_sha');
      const r = await layDown({ id, file: 'main', target: mainTarget, chunks: plan.chunks, size, sha256: row.sha256, whole: false, known: null }, key);
      if (r.result === 'conflict') return conflict('main', mainTarget, r);
      if (r.result === 'written') { wroteAny = true; stampLastEntry(mainTarget); }
      files.main = { generation: gen, size, sha256: row.sha256 };
      // its log is here now: the folder it resumes in too (the links looked at again right before)
      if (makeFolder && !isDir(folder)) {
        if (!noLinks(root, parts)) fail('its folder would be made through a link', 'bad_path');
        fs.mkdirSync(folder, { recursive: true });
        log(`sync-down: ${id}: made the folder it began in (${folder}), which this machine did not have`);
      }
    }
    // side files, from their newest generation
    for (const [file, gens] of byFile) {
      if (file === 'main') continue;
      if (!C.checkFileKey(file) || !C.SIDE_DIRS.includes(file.split('/')[0]) || file.split('/').length < 2) { log(`sync-down: ${id}: a chunk row for a file that is not synced; ignored`); continue; }
      if (gens.size > 1) { pending++; continue; } // a new generation is going up: next scan
      const [g, list] = [...gens][0];
      const plan = planChunks(id, file, g, sortSeq(list), null);
      const segs = file.split('/');
      const target = path.join(slugDir, id, ...segs);
      if (!inside(slugDir, target) || !noLinks(slugDir, [id, ...segs])) fail(`${file}: its path would leave the conversation's folder`, 'bad_path');
      const known = prev && prev.files && prev.files[file] ? prev.files[file] : null;
      const sha = plan.chunks.length === 1 ? plan.chunks[0].sha256 : null;
      const r = await layDownFile({ id, file, target, chunks: plan.chunks, size: plan.size, sha256: sha, whole: !file.endsWith('.jsonl'), known }, key);
      if (r.result === 'conflict') return conflict(file, target, r);
      if (r.result === 'written') wroteAny = true;
      files[file] = { generation: g, size: plan.size, sha256: sha || (known && known.size === plan.size ? known.sha256 : null) };
    }
    for (const k of Object.keys(state.conflicts)) if (k.startsWith(`${id}|`)) delete state.conflicts[k];
    state.convos[id] = { sig: pending ? null : sigOf(row), dir: slugDir, files, conflict: false, at: now() };
    saveState();
    if (pending) return { outcome: 'pending', reason: 'a side file is mid-upload', folder, dir };
    return { outcome: wroteAny ? 'done' : 'same', folder, dir };
  }

  // ---------- a scan ----------
  const ROW_COLS = 'id,account,repo_id,rel_cwd,size,sha256,generation,updated_at,owner_device,lease_until';
  // a row this side can lay down: a conversation id, account a or b, whole numbers for size and generation
  const usable = (row) => !!row && typeof row.id === 'string' && UUID_RE.test(row.id) && (row.account === 'a' || row.account === 'b')
    && Number.isSafeInteger(Number(row.size)) && Number(row.size) >= 0 && Number.isSafeInteger(Number(row.generation)) && Number(row.generation) >= 0;
  async function listRows(me) {
    const out = [];
    for (let offset = 0; ; offset += PAGE) {
      const rows = await api.rest('GET', 'conversations', {
        query: { select: ROW_COLS, state: 'eq.active', owner_device: `neq.${me}`, order: 'updated_at.desc', limit: String(PAGE), offset: String(offset) },
      });
      if (!Array.isArray(rows)) break;
      out.push(...rows);
      if (rows.length < PAGE) break;
    }
    return out;
  }
  async function scan() {
    const key = await getKey();
    if (!key) { st.lastError = 'no sync key on this machine'; return { skipped: 'no key' }; }
    const me = await C.ensureDevice(api, dataDir);
    try { await C.touchDevice(api, me, { now: now() }); } catch (e) { log(`sync-down: last_seen_at not sent: ${e.message}`); }
    await lock(false);
    try { state = loadState(); } finally { unlock(); } // not under a pull's feet
    const ctx = newCtx(me);
    const tally = { rows: 0, unchanged: 0, done: 0, same: 0, conflict: 0, skip: 0, pending: 0, failed: 0, waiting: 0 };
    const reasons = {};
    const only = onlyOf();
    const listStart = now();
    const rows = (await listRows(me)).filter((row) => row && typeof row.id === 'string' && UUID_RE.test(row.id) && (!only || only(row.id.toLowerCase())));
    // who owns what, for owners(): every active row another device owns
    const seen = new Map();
    for (const row of rows) {
      const owner = typeof row.owner_device === 'string' ? row.owner_device.toLowerCase() : null;
      if (!owner || owner === me) continue;
      const lease = row.lease_until ? Date.parse(row.lease_until) : NaN;
      seen.set(row.id.toLowerCase(), { device: owner, leaseUntil: Number.isFinite(lease) ? lease : null });
    }
    ownersMap = seen;
    st.listedAt = new Date(listStart).toISOString();
    for (const row of rows) {
      const owner = typeof row.owner_device === 'string' ? row.owner_device.toLowerCase() : null;
      if (!owner || owner === me) continue; // this device's own (or nobody's): the uploader's
      if (!usable(row)) continue;
      tally.rows++;
      const id = row.id.toLowerCase(), prev = state.convos[id];
      if (prev && prev.sig === sigOf(row) && (!prev.conflict || prev.localStamp === stampOf(path.join(prev.dir || '', `${id}.jsonl`)))) { tally.unchanged++; continue; }
      const b = backoff.get(id);
      if (b && now() < b.until) { tally.waiting++; continue; }
      await lock(false); // a pull() waiting goes first
      try {
        const r = await syncOne(row, ctx, key);
        tally[r.outcome]++;
        if (r.reason) reasons[r.reason] = (reasons[r.reason] || 0) + 1;
        if (r.outcome === 'done') st.laidDown++;
        backoff.delete(id);
      } catch (e) {
        tally.failed++;
        // a request cut because the machine slept is not this conversation's fault: the next scan tries it again
        if (!(e && e.slept)) {
          const n = b ? b.n + 1 : 1;
          backoff.set(id, { n, until: now() + Math.min(BACKOFF_MIN_MS * 2 ** (n - 1), BACKOFF_MAX_MS) });
        }
        const why = (e && e.message) || String(e);
        reasons[why] = (reasons[why] || 0) + 1;
        log(`sync-down: ${id}: ${why}`);
        if (e && ['network', 'timeout', 'signed_out', 'off'].includes(e.code)) throw e; // Supabase is out of reach: stop this scan
      } finally { unlock(); }
    }
    return { ...tally, reasons };
  }

  // ---------- S4: pull and owners ----------
  const flights = new Set(); // pull() calls under way (stop() waits for them)
  function pull(raw) {
    const p = pullNow(String(raw == null ? '' : raw).toLowerCase());
    flights.add(p);
    const done = () => { flights.delete(p); };
    p.then(done, done);
    return p;
  }
  async function pullNow(id) {
    if (!UUID_RE.test(id)) throw new S.SyncError('not a conversation id', 400, 'bad_request');
    const key = await getKey();
    if (!key) throw new S.SyncError('no sync key on this machine', 0, 'bad_key');
    const me = await C.ensureDevice(api, dataDir);
    await lock(true);
    try {
      const got = await api.rest('GET', 'conversations', { query: { select: ROW_COLS, id: `eq.${id}`, state: 'eq.active' } });
      const row = Array.isArray(got) && got[0] ? got[0] : null;
      if (!row) return { outcome: 'missing' };
      const owner = typeof row.owner_device === 'string' ? row.owner_device.toLowerCase() : null;
      if (owner === me) return { outcome: 'mine', row };
      if (!usable(row)) return { outcome: 'skip', reason: 'the row cannot be laid down here', row };
      backoff.delete(id);
      const r = await syncOne(row, newCtx(me), key);
      if (r.outcome === 'done') st.laidDown++;
      return { ...r, row };
    } catch (e) {
      log(`sync-down: ${id}: pull: ${(e && e.message) || e}`);
      throw e;
    } finally { unlock(); }
  }
  // a copy: the caller cannot change this side's map
  const owners = () => new Map([...ownersMap].map(([id, o]) => [id, { ...o }]));

  let current = null, timer = null, interval = 5000;
  function scanOnce() {
    if (current) return current;
    st.scanning = true;
    current = (async () => {
      try {
        const r = await scan();
        st.lastOkAt = new Date(now()).toISOString();
        if (!r.skipped) st.lastError = null;
        st.last = r;
        return r;
      } catch (e) {
        st.lastError = (e && e.message) || String(e);
        throw e;
      } finally {
        st.scans++;
        st.lastScanAt = new Date(now()).toISOString();
        st.scanning = false;
        current = null;
      }
    })();
    return current;
  }
  function tick() {
    timer = null;
    if (!st.running) return;
    scanOnce().catch(() => {}).then(() => { if (st.running && !timer) timer = setTimeout(tick, interval); });
  }
  function start(intervalMs = 5000) {
    interval = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 5000;
    if (st.running) return;
    st.running = true;
    tick();
  }
  async function stop() {
    st.running = false;
    if (timer) { clearTimeout(timer); timer = null; }
    if (current) { try { await current; } catch {} }
    await Promise.allSettled([...flights]);
  }
  function status() {
    return {
      running: st.running, scanning: st.scanning, scans: st.scans, lastScanAt: st.lastScanAt, lastOkAt: st.lastOkAt, listedAt: st.listedAt,
      lastError: st.lastError, laidDown: st.laidDown, last: st.last ? { ...st.last, reasons: { ...st.last.reasons } } : null,
      conflicts: Object.keys(state.conflicts).length, waiting: backoff.size,
    };
  }
  const conflicts = () => Object.values(state.conflicts).map((c) => ({ ...c }));

  return { scanOnce, start, stop, status, conflicts, pull, owners };
}

module.exports = { createMaterializer, relParts, planChunks, downStatePath };
