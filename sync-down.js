// sync-down.js: the materializer (the sync plan's part S3). It brings conversations another machine uploaded
// (sync-up.js, S2) down into this machine's Claude projects folders, so they can be resumed here. docs/sync-format.md
// "The materializer's rules" is what it does; docs/sync-move-recipe.md is how a conversation must be laid down so
// `claude --resume` picks it up in the right folder. It reaches Supabase only through the api object it is handed
// (sync-api.js createSync()), opens what it fetches with sync-crypto.js, and names things with sync-common.js.
//
//   createMaterializer({ api, dataDir, key, log, now, projects, roots, home, isOpen, only, fullListMs })
//     (projects: [{ account, dir }], or a function giving it; ~/.claude for B and ~/.claude-a for A when not given;
//     isOpen(id): true when this machine has it open in a way sessions/<pid>.json does not show yet, such as a panel
//     the session host is starting; only(id): a scan looks only at the conversations this says true for, live tests;
//     fullListMs: how often every row is listed, FULL_LIST_MS by default, tests)
//     -> { scanOnce(), start(intervalMs = 5000), stop(), status(), conflicts(), pull(id), owners(), owner(id),
//          missing() }
//
// For S4's moves (sync-move.js), with ids lower-case:
//   pull(id) -> Promise<{ outcome, reason?, dir?, folder?, row? }>: lay that conversation down now. It is urgent: it
//     takes the next free slot of a running scan ahead of the scan's next row; with a slot free it runs at once. Scan
//     rows and pulls share the slots, so a conversation is never laid down twice at once (a pull of one the scan has
//     under way waits for that row). Its row is read whoever owns it: none (or not active) ->
//     { outcome: 'missing' }; this device's -> { outcome: 'mine', row }; else its back-off is cleared and it is laid
//     down as a scan would (steps 3 to 8) -> that outcome ('done' | 'same' | 'conflict' | 'skip' | 'pending'), the
//     reason, dir (the slug folder its log is in, absolute), folder (the resume folder X from root + rel_cwd) and the
//     row. A failure throws, as in a scan (no back-off is set for it).
//   owners() -> Map<id, { device, leaseUntil, account, bound }>: the active rows other devices own, from the last scan's
//     list (device lower-case, leaseUntil = Date.parse(lease_until) or null, account the row's 'a' | 'b' or null: the
//     account it ran under there; bound: its repos row is a bound one, sync-common.js "portable or bound"). Empty before
//     the first scan. status().listedAt is when the last whole list began (ISO), so a change of owner made before then
//     is in it (the changed rows' lists between see a row going to another device, not one coming to this one: "The
//     rows" below); status().checkedAt is when the last list of either kind began.
//   owner(id) -> null before the first list; else { device, at, checkedAt }: the other device that owns that active row
//     as the lists (or a pull since) left it, or null; at and checkedAt are listedAt and checkedAt in ms. For the
//     uploader (sync-up.js ownerOf), one id at a time with no copy of the map.
//   moved(id, dir): a move put the log it laid down into slug folder dir (where it resumes): it stays there
//
// For "Clone what's missing" (sync-clone.js):
//   missing() -> { at, repos: [{ origin, name, chats, newest }] }: the repos whose conversations the last whole scan
//     skipped as "no checkout of its repo here" (origin as the repos row has it, sync-common.js rowOrigin; name its
//     last path segment; chats how many rows; newest the latest updated_at), newest first. at is when that scan began
//     (ISO), null before the first whole scan; a scan cut short (Supabase out of reach) or narrowed by only() leaves
//     the list from before.
//
// One scan:
//   1. This machine's device row (ensureDevice; last_seen_at at most every 5 minutes).
//   2. Every active conversation row owned by another device, newest first: the rows held from the lists, every row
//      (light columns) every FULL_LIST_MS and the changed ones in the scans between ("The rows" in the code). A row
//      whose updated_at, generation, size and sha256 are what down-state.json says was laid down costs nothing more.
//      The others start in that order, up to ROWS_AT_ONCE conversations under way at once (steps 3 to 8 for each).
//   3. Its repo: this device's repo_paths row for the repo when that folder still has the repo's origin, else the
//      repos Fleet View knows (the roots option; ~/.fleet-view.json's added and remembered repos when it is not
//      given) matched by origin, and then this device's repo_paths row is written. No checkout here: skipped. The home
//      row (sync-common.js HOME_ORIGIN) is this machine's home folder (the home option), always there. A bound row
//      ('bound:<host's device id>', sync-common.js "portable or bound": a folder only its host has) needs no checkout:
//      its folder here is a placeholder, <home>/.fleet-view/bound/<host's name>/<hash>/<folder name>
//      (sync-common.js boundPlaceholder), made (empty, never through a link) right before its log is laid down; the
//      device that hosted it (this one, after the row went to another) keeps the folder rel_cwd names when it is here.
//      It is another device's like any other row here: in away.json, never opened as this machine's own.
//   4. Folder X = that main checkout + rel_cwd ('..', an absolute path or a drive is refused). A rel_cwd whose folder
//      is not on this machine (a worktree the other machine made) falls back to the root. Under the home row a missing
//      folder is made instead (empty, logged once), so the conversation shows and resumes where it began; never
//      through a link, never outside home. A conversation already on
//      this machine (laid down before, or its log in any slug folder of the account's projects folder: one this
//      machine started) stays in that slug folder while its file is there, so it never ends up in two.
//   5. Skipped while a Claude Code process on this machine has it open (sessions/<pid>.json), or isOpen(id) says so.
//   6. The conversation's chunk rows, read in pages of 1000 (chunkRows). When main's generation is the one laid down
//      here and the files laid down are still as they were (size and modified time, down-state.json's stamp), only the
//      rows past them are read (each known file's first seq chunks are left out: chunkRowsSince), and the new chunks
//      are added behind the bytes here, which layDown checks against their sha256 first; a new generation of a known
//      side file, a gap, local bytes that are not the ones laid down ('redo'), or a sha256 that does not match the
//      bytes put together read all the rows again, as does a filter too long for a proxy on the way (414, 431).
//      main: the rows of the row's generation, ordered by seq, must cover [0, size) with no gap; each object's
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
//   8. What was laid down goes in <dataDir>/sync/down-state.json (compact, once at the end of each scan, and after a
//      pull, a move and a stop). An unchanged row whose log is gone from here (Claude Code deletes old logs) is laid
//      down again. A conversation that fails (a missing object, a gap, a bad sha256, the network) writes nothing,
//      leaves no .part, and is tried again after a back-off (30 s, doubling up to 30 minutes).
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
// chunks fetched at once for one file: each request waits a round trip (Mac -> Supabase, 70-200 ms), not for bytes,
// so one at a time made a backlog of thousands of chunks take an hour
const FETCH_AHEAD = 8;
// conversations a scan lays down at once, for the same reason: each waits round trips, not bytes. Each may have
// FETCH_AHEAD chunk requests out, so up to ROWS_AT_ONCE x FETCH_AHEAD (32) at once: modest, for Supabase's sake
const ROWS_AT_ONCE = 4;
const BACKOFF_MIN_MS = 30e3;
const BACKOFF_MAX_MS = 30 * 60e3;
const ORIGINS_MS = 60e3; // the repos rows' origins are read again this often (and when a row names one not read yet)
const FULL_LIST_MS = 4 * 60e3; // every active row is listed (light) this often; the scans between list the changed ones
const OVERLAP_MS = 2 * 60e3; // the changed ones: from the newest updated_at seen less this (clock skew, writes on the way)
const LEASE_AHEAD_MS = 3 * 60e3; // a lease runs this far ahead (sync-move.js leaseForMs): the newest one seen counts up to here
const BY_ID = 100; // rows fetched by id in one request (the URL stays short)
// characters of a chunk fetch's "past what is laid down" filter, at most: percent-encoded ("(),: each 3) it grows to
// about 4 KB, well under the 8 KB request line a proxy on the way may allow
const SINCE_MAX = 3000;
const BAD_SEG_RE = /[<>:"|?*\\\x00-\x1f]/; // what a rel_cwd segment may not hold (Windows names, drives, streams)
const NO_CHECKOUT = 'no checkout of its repo here';

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
// from: { seq, offset } where the rows begin when they are the ones past what is laid down here (that many chunks,
// that many bytes); the chunks then make [offset, size) and size counts from 0 as before
function planChunks(id, file, generation, rows, size, from = null) {
  const out = [];
  const seq0 = from ? from.seq : 0;
  let off = from ? from.offset : 0;
  for (let i = 0; i < rows.length; i++) {
    const c = rows[i];
    if (size !== null && off >= size) break;
    const seq = Number(c.seq), start = Number(c.byte_offset), len = Number(c.byte_length);
    if (seq !== seq0 + i || start !== off) fail(`${file}: the chunks have a gap at byte ${off} (seq ${seq0 + i})`, 'gap');
    // an empty file is one empty chunk; otherwise every chunk holds bytes
    if (!Number.isSafeInteger(len) || len < 0 || (len === 0 && (rows.length > 1 || from))) fail(`${file}: chunk ${seq} has no length`, 'bad_chunk');
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
  // { v: 1, convos: { <id>: { sig, dir, files: { <file key>: { generation, size, sha256, seq, stamp } }, conflict,
  //   localStamp, at } }, (seq: how many chunks; stamp: '<size>:<mtimeMs>' right after it was laid down; an entry from
  //   before them has neither, and its next change reads all its rows)
  //   conflicts: { '<id>|<file key>': { id, file, path, reason, localSize, remoteSize, at } } }
  function loadState() {
    const s = C.readState(statePath, null);
    return {
      v: 1,
      convos: s && s.convos && typeof s.convos === 'object' ? s.convos : {},
      conflicts: s && s.conflicts && typeof s.conflicts === 'object' ? s.conflicts : {},
    };
  }
  let state = loadState(), dirty = false;
  // compact, and only when something changed: at the end of each scan, after a pull, a move and a stop (it is MBs).
  // A crash loses at most that scan's: those rows are looked at again, and what is here already is not fetched again
  const changed = () => { dirty = true; };
  const saveState = () => {
    if (!dirty) return;
    try { C.writeState(statePath, state, { compact: true }); dirty = false; } catch (e) { log(`sync-down: down-state.json could not be saved: ${e.message}`); }
  };
  const sigOf = (row) => `${row.updated_at}|${row.generation}|${row.size}|${row.sha256 || ''}`;
  const stampOf = (p) => { const st = lstatOr(p); return st ? `${st.size}:${st.mtimeMs}` : 'none'; };

  const backoff = new Map(); // id -> { n, until }
  let ownersMap = new Map(); // id -> { device, leaseUntil, account }: the last scan's rows other devices own
  let missingNow = { at: null, repos: [] }; // missing(): the last whole scan's repos with no checkout here
  const onlyOf = () => (typeof opts.only === 'function' ? opts.only : null);

  // ---------- several conversations at once, never one twice ----------
  // A scan takes a slot for each row, pull() for its whole run: at most ROWS_AT_ONCE at once, and never two for one
  // id. A pull counts against the limit (Supabase sees no more than a scan alone makes) but is urgent: it takes the
  // next free slot ahead of the scan's next row, behind earlier pulls, waiting only for a row of its own id under way.
  // The scan's state reload takes the whole thing (id null): no conversation under way, none starting meanwhile.
  let inUse = 0, sole = false;
  const busy = new Set(); // ids being laid down
  const slotQ = []; // { urgent, id, go }
  function pump() {
    for (let i = 0; i < slotQ.length && !sole; i++) {
      const w = slotQ[i];
      if (w.id === null ? inUse > 0 : (inUse >= ROWS_AT_ONCE || busy.has(w.id))) continue; // a later waiter may go first
      slotQ.splice(i--, 1);
      if (w.id === null) sole = true; else { inUse++; busy.add(w.id); }
      w.go();
    }
  }
  function slot(id, urgent) {
    return new Promise((go) => {
      const w = { urgent, id, go };
      let i = slotQ.length;
      if (urgent) { i = 0; while (i < slotQ.length && slotQ[i].urgent) i++; }
      slotQ.splice(i, 0, w);
      pump();
    });
  }
  function unslot(id) {
    if (id === null) sole = false; else { inUse--; busy.delete(id); }
    pump();
  }
  const st = { running: false, scanning: false, scans: 0, lastScanAt: null, lastOkAt: null, listedAt: null, checkedAt: null, lastError: null, last: null, laidDown: 0 };

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
  // every repos row's origin (id lower-case -> sync-common.js rowOrigin, or null), kept across scans: read again when
  // a minute has passed, or when a row names a repo it lacks (ids). owners() says which rows are bound from it.
  let originsAt = -Infinity, originsMap = new Map();
  async function origins(ids) {
    const t = now();
    const lacks = Array.isArray(ids) && ids.some((id) => typeof id === 'string' && UUID_RE.test(id) && !originsMap.has(id.toLowerCase()));
    if (!lacks && t >= originsAt && t - originsAt < ORIGINS_MS) return originsMap;
    const rows = await api.rest('GET', 'repos', { query: { select: 'id,origin' } });
    originsMap = new Map((Array.isArray(rows) ? rows : []).filter((r) => r && typeof r.id === 'string').map((r) => [r.id.toLowerCase(), C.rowOrigin(r.origin) || null]));
    originsAt = t;
    return originsMap;
  }
  async function candidateRoots() {
    let list = opts.roots;
    if (typeof list === 'function') list = await list();
    if (!Array.isArray(list)) list = settingsRoots(home);
    return list.filter((r) => typeof r === 'string' && r && path.isAbsolute(r));
  }
  // A scan's ctx is used by several rows at once, so a lookup that waits keeps its promise in ctx[k] and they share
  // one; a failed one is let go, so the next row asks again (as before)
  const once = (ctx, k, fn) => {
    if (!ctx[k]) { const p = fn(); ctx[k] = p; p.catch(() => { if (ctx[k] === p) ctx[k] = null; }); }
    return ctx[k];
  };
  function newCtx(me) {
    const ctx = { me, repos: null, repoPaths: null, roots: new Map(), logs: new Map() };
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
    // ctx.repos and ctx.repoPaths are set together, both or neither; the repos' origins come from origins(), kept
    // across scans (read again after a minute, or when a row names a repo it lacks: want)
    ctx.loadRepos = (want) => once(ctx, 'reposP', async () => {
      const repos = await origins(want ? [want] : null);
      const paths = await api.rest('GET', 'repo_paths', { query: { select: 'repo_id,root', device_id: `eq.${me}` } });
      ctx.repos = repos;
      ctx.repoPaths = new Map((Array.isArray(paths) ? paths : []).filter((r) => r && typeof r.repo_id === 'string' && typeof r.root === 'string').map((r) => [r.repo_id.toLowerCase(), r.root]));
    });
    ctx.localOrigins = () => once(ctx, 'localP', async () => {
      const local = new Map();
      for (const root of await candidateRoots()) {
        const r = await C.repoOf(root);
        if (r && r.origin && !local.has(r.origin)) local.set(r.origin, r.mainRoot);
      }
      return local;
    });
    return ctx;
  }
  // a bound row's host: the device id in its repos row's origin ('bound:<id>', sync-common.js boundOrigin), else null
  async function boundHost(repoId, ctx) {
    if (typeof repoId !== 'string' || !UUID_RE.test(repoId)) return null;
    await ctx.loadRepos(repoId);
    return C.boundDeviceOf(ctx.repos.get(repoId.toLowerCase()));
  }
  // a device's name (its hostname, from the devices table: read once a scan, shared by the rows under way, when a bound
  // row needs it), or null
  async function deviceName(id, ctx) {
    await once(ctx, 'namesP', async () => {
      const names = new Map();
      const rows = await api.rest('GET', 'devices', { query: { select: 'id,name' } });
      for (const r of Array.isArray(rows) ? rows : []) if (r && typeof r.id === 'string' && typeof r.name === 'string') names.set(r.id.toLowerCase(), r.name);
      ctx.names = names;
    });
    return ctx.names.get(String(id).toLowerCase()) || null;
  }
  // Where a bound row is laid down here (sync-common.js "portable or bound"): a placeholder, <home>/.fleet-view/bound/
  // <host's name>/<hash>/<folder name> (boundPlaceholder), made here when missing, never through a link. The device
  // that hosted it and still has its folder (this one, once its row went to another device) keeps that folder: it was
  // always here. -> { folder, base, parts } (parts: below base, for the link check and the make) | { skip }
  async function boundPlace(row, host, ctx) {
    if (!C.boundRelOk(row.rel_cwd)) return { skip: 'its rel_cwd is not a folder\'s full path' };
    const native = C.boundNative(row.rel_cwd);
    if (host === ctx.me && native && isDir(native)) return { folder: path.resolve(native), base: null, parts: null };
    const folder = C.boundPlaceholder(home, (await deviceName(host, ctx)) || host.slice(0, 8), row.rel_cwd);
    const parts = path.relative(path.resolve(home), folder).split(path.sep);
    return { folder, base: path.resolve(home), parts };
  }
  // repo id -> this device's main checkout of it (this machine's home folder for the home row), or null. ctx.roots
  // holds the lookup's promise, so rows of one repo under way at once share one (dropped when it fails)
  function rootFor(repoId, ctx) {
    if (typeof repoId !== 'string' || !UUID_RE.test(repoId)) return Promise.resolve(null);
    const id = repoId.toLowerCase();
    if (!ctx.roots.has(id)) {
      const p = findRoot(id, ctx);
      ctx.roots.set(id, p);
      p.catch(() => { if (ctx.roots.get(id) === p) ctx.roots.delete(id); });
    }
    return ctx.roots.get(id);
  }
  async function findRoot(id, ctx) {
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
    return found;
  }
  const isHomeRow = (repoId, ctx) => typeof repoId === 'string' && !!ctx.repos && ctx.repos.get(repoId.toLowerCase()) === C.HOME_ORIGIN;

  // ---------- laying one file down ----------
  // job: { id, file, target, chunks, size, sha256 (whole file, or null), whole, known ({ size, sha256 } this side laid
  // down last, or null) } -> { result: 'same' | 'written', sha256 (the whole file's) } | { result: 'conflict', reason,
  // localSize }. A chunk with laid: true (and no object) stands for the bytes laid down here before, when only the rows
  // past them were fetched: the local copy must hold them (its sha256), else it throws 'redo' (all rows are read again).
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
          if (hashRange(fd, c.start, c.len, whole) !== c.sha256) {
            if (c.laid) fail(`${job.file}: the local copy is not what was laid down`, 'redo');
            return { result: 'conflict', reason: 'the local copy is different', localSize };
          }
          have.add(c.seq);
        }
        if (localSize === job.size && have.size === job.chunks.length && !cut) {
          const sha = whole.digest('hex');
          if (job.sha256 && sha !== job.sha256) fail(`${job.file}: the file's sha256 is not the row's`, 'bad_sha');
          return { result: 'same', sha256: sha };
        }
      }
      // the bytes laid down before (a fetch of only the rows past them) must all be here as they were
      if (job.chunks.some((c) => c.laid && !have.has(c.seq))) fail(`${job.file}: the local copy is not what was laid down`, 'redo');
      // the rest: <target>.part, the local bytes it holds copied, the others fetched and opened
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const total = crypto.createHash('sha256');
      pfd = fs.openSync(part, 'w');
      wrote = true;
      // the chunks to fetch, FETCH_AHEAD at once: a new one starts as each is written, so at most FETCH_AHEAD are on
      // the way or waiting their turn; they are still opened, checked and written in seq order. One still on the way
      // when this returns (a failure, a conflict) is let go: its result or error is never used
      const want = job.chunks.filter((c) => !have.has(c.seq));
      const ahead = new Map(); // seq -> the download's promise
      let next = 0;
      const fetchMore = () => {
        while (next < want.length && ahead.size < FETCH_AHEAD) {
          const c = want[next++];
          const p = api.storage.download(c.objectPath);
          p.catch(() => {}); // its error is thrown below when its turn comes, or never: not an unhandled rejection
          ahead.set(c.seq, p);
        }
      };
      let at = 0;
      for (const c of job.chunks) {
        fetchMore();
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
        const blob = await ahead.get(c.seq);
        buf = X.openChunk(Buffer.from(blob), key, c.objectPath);
        if (buf.length !== c.len || X.sha256(buf) !== c.sha256) fail(`${job.file}: chunk ${c.seq} is not what its row says (length or sha256)`, 'bad_sha');
        if (fd !== null && c.start < localSize) {
          const mine = readRange(fd, c.start, localSize - c.start);
          if (!mine.equals(buf.subarray(0, mine.length))) return { result: 'conflict', reason: 'the local copy is different', localSize };
        }
        total.update(buf);
        fs.writeSync(pfd, buf, 0, buf.length, at);
        at += buf.length;
        ahead.delete(c.seq);
      }
      if (at !== job.size) fail(`${job.file}: ${at} bytes put together, ${job.size} expected`, 'gap');
      const sha = total.digest('hex');
      if (job.sha256 && sha !== job.sha256) fail(`${job.file}: the file's sha256 is not the row's`, 'bad_sha');
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
      return { result: 'written', sha256: sha };
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

  // ---------- chunk rows ----------
  // Every chunk row of a conversation, in pages of PAGE (PostgREST answers at most 1000 rows, and cuts the rest off
  // silently), ordered by file, generation and seq: one key, so the order is total. Each page after the first starts
  // on the last row of the one before; a different row there means rows came or went before it meanwhile (an upload,
  // an old generation dropped), so the listing starts again (a third time throws 'changed': the next scan tries again).
  const CHUNK_COLS = 'file,generation,seq,byte_offset,byte_length,object_path,sha256';
  const rowKey = (r) => (r ? `${r.file}|${r.generation}|${r.seq}` : '');
  // filter: more of the query (chunkRowsSince's)
  async function chunkRows(id, filter = {}) {
    for (let tries = 0; tries < 3; tries++) {
      const out = [];
      let shifted = false;
      for (;;) {
        const from = out.length ? out.length - 1 : 0;
        const rows = await api.rest('GET', 'chunks', {
          query: { select: CHUNK_COLS, conversation_id: `eq.${id}`, ...filter, order: 'file.asc,generation.asc,seq.asc', limit: String(PAGE), offset: String(from) },
        });
        if (!Array.isArray(rows)) break;
        if (out.length) {
          if (rowKey(rows[0]) !== rowKey(out[out.length - 1])) { shifted = true; break; }
          out.push(...rows.slice(1));
        } else out.push(...rows);
        if (rows.length < PAGE) break;
      }
      if (!shifted) return out;
    }
    return fail('the chunk rows kept changing while they were read', 'changed');
  }
  // What was laid down for a conversation that is still here exactly as it was: file key -> { generation, size,
  // sha256, seq (its chunks), stamp } for each file whose size and modified time are the ones it had when it was laid
  // down (and so its bytes: layDown checks the sha256 again before it adds to one). null (fetch all of it) when 'main'
  // is not among them, or its generation is not the row's (a new generation goes up from byte 0), or down-state.json
  // does not have it from this folder or has it in conflict.
  const knownOk = (k) => !!k && typeof k === 'object' && Number.isSafeInteger(Number(k.generation)) && Number(k.generation) >= 0
    && Number.isSafeInteger(k.seq) && k.seq > 0 && Number.isSafeInteger(k.size) && k.size >= 0 && typeof k.sha256 === 'string' && HEX64_RE.test(k.sha256) && typeof k.stamp === 'string';
  function knownLaid(id, prev, slugDir, row) {
    if (!sinceOk || !prev || prev.conflict || !prev.files || typeof prev.dir !== 'string' || fold(prev.dir) !== fold(slugDir)) return null;
    const m = prev.files.main;
    if (!knownOk(m) || Number(m.generation) !== Number(row.generation) || Number(row.size) < m.size) return null;
    const out = new Map();
    for (const [file, k] of Object.entries(prev.files)) {
      if (!knownOk(k)) continue;
      const segs = file.split('/');
      if (file !== 'main' && (!C.checkFileKey(file) || !C.SIDE_DIRS.includes(segs[0]) || segs.length < 2)) continue;
      const target = file === 'main' ? path.join(slugDir, `${id}.jsonl`) : path.join(slugDir, id, ...segs);
      if (stampOf(target) !== k.stamp || k.stamp === 'none') continue;
      out.set(file, { generation: Number(k.generation), size: k.size, sha256: k.sha256, seq: k.seq, stamp: k.stamp });
    }
    return out.has('main') ? out : null;
  }
  // The chunk rows of a conversation but those already laid down (known, as knownLaid gives it): every row but the
  // first seq chunks of each known file's generation. 'main' first, then the files with the most chunks, while the
  // filter stays under SINCE_MAX characters; a known file left out of it is fetched whole (and taken out of known).
  // -> the rows, or null when Supabase refused the filter (400: then it is never used again, every fetch is whole) or a
  // proxy on the way found the URL or the request too long (414, 431: this conversation's rows are read whole, this
  // time)
  async function chunkRowsSince(id, known) {
    const list = [...known].sort(([a, x], [b, y]) => (a === 'main' ? -1 : b === 'main' ? 1 : y.seq - x.seq));
    const parts = [];
    let len = 0;
    for (const [file, k] of list) {
      const p = `not.and(file.eq."${file}",generation.eq.${k.generation},seq.lt.${k.seq})`;
      if (parts.length && len + p.length + 1 > SINCE_MAX) { known.delete(file); continue; }
      parts.push(p); len += p.length + 1;
    }
    try { return await chunkRows(id, { and: `(${parts.join(',')})` }); } catch (e) {
      if (e && (e.status === 414 || e.status === 431)) { log(`sync-down: ${id}: its new chunks' filter made too long a request (${e.message}); all its rows are read`); return null; }
      if (!e || e.status !== 400) throw e;
      sinceOk = false;
      log(`sync-down: only a conversation's new chunks could not be fetched (${e.message}); every fetch is whole from now on`);
      return null;
    }
  }

  // ---------- one conversation ----------
  // -> { outcome: 'done' | 'same' | 'conflict' | 'skip' | 'pending', reason, folder, dir }; throws when it failed
  // (tried again later). folder (the resume folder X) and dir (its slug folder) come once they are known.
  async function syncOne(row, ctx, key) {
    const id = row.id.toLowerCase();
    const prev = state.convos[id] || null;
    // where it goes: a bound row (only its host has its folder) gets a placeholder here (boundPlace); any other, this
    // device's checkout of its repo (the home folder for the home row) and rel_cwd
    const host = await boundHost(row.repo_id, ctx);
    let root = null, parts = null, folder, makeFolder = false, makeFirst = false;
    if (host) {
      const b = await boundPlace(row, host, ctx);
      if (b.skip) return { outcome: 'skip', reason: b.skip };
      folder = b.folder;
      if (b.base && !isDir(folder)) {
        // made right before its log comes (not after, as under home): its log's slug folder then names a folder here at
        // once (fleet-view.js folderOfSlug), and the folder is Fleet View's own
        if (lstatOr(folder)) return { outcome: 'skip', reason: 'something that is not a folder is where its placeholder goes', folder };
        if (!noLinks(b.base, b.parts)) return { outcome: 'skip', reason: 'its placeholder folder would be made through a link', folder };
        root = b.base; parts = b.parts; makeFolder = true; makeFirst = true;
      }
    } else {
      root = await rootFor(row.repo_id, ctx);
      if (!root) return { outcome: 'skip', reason: NO_CHECKOUT, origin: (ctx.repos && typeof row.repo_id === 'string' && ctx.repos.get(row.repo_id.toLowerCase())) || null };
      parts = relParts(row.rel_cwd);
      if (!parts) return { outcome: 'skip', reason: 'its rel_cwd is not a plain relative path' };
      folder = parts.length ? path.resolve(root, ...parts) : path.resolve(root);
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
    }
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
    // a log that stays where it already is (this machine hosted it once) needs no placeholder
    if (makeFirst && P.foldCase(path.basename(dir)) !== P.foldCase(C.slugOf(folder))) makeFirst = makeFolder = false;
    if (live(id)) return { outcome: 'skip', reason: 'open on this machine', folder, dir };

    // the chunk rows: only those past what is laid down here when that is still here as it was (knownLaid), else all;
    // a doubt found on the way ('redo': a file's new generation, a gap, the local bytes not the ones laid down; and a
    // bad sha256 or a gap in the bytes put together, which a read of every row may not have) reads them all again,
    // before anything is written when it can be told then
    const known = knownLaid(id, prev, slugDir, row);
    const since = known ? await chunkRowsSince(id, known) : null;
    if (since) {
      try { return await layAll(since, known); } catch (e) {
        if (!e || !['redo', 'bad_sha', 'gap'].includes(e.code)) throw e;
        log(`sync-down: ${id}: ${e.message}: all of its chunks are read again`);
      }
    }
    return layAll(await chunkRows(id), null);

    async function layAll(rows, laid) {
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
      const redo = (why) => fail(why, 'redo');
      // the rows past what is laid down: planned from there, and the bytes laid down stand in front (a laid chunk)
      const after = (file, g, list, size, k) => {
        let plan;
        try { plan = planChunks(id, file, g, list, size, { seq: k.seq, offset: k.size }); } catch (e) { redo(`${file}: ${e.message}`); }
        return { chunks: [{ seq: -1, start: 0, len: k.size, end: k.size, sha256: k.sha256, objectPath: null, laid: true }, ...plan.chunks], size: plan.size, seq: k.seq + plan.chunks.length, added: plan.chunks.length };
      };

      // main
      const size = Number(row.size), gen = Number(row.generation);
      const files = {};
      let pending = 0, wroteAny = false;
      const conflict = (file, target, r) => {
        state.conflicts[`${id}|${file}`] = { id, file, path: target, reason: r.reason, localSize: r.localSize, remoteSize: file === 'main' ? size : null, at: new Date(now()).toISOString() };
        state.convos[id] = { sig: sigOf(row), dir: slugDir, files: prev ? prev.files || {} : {}, conflict: true, localStamp: stampOf(path.join(slugDir, `${id}.jsonl`)), at: now() };
        changed();
        log(`sync-down: ${id} ${file}: ${r.reason}; left alone`);
        return { outcome: 'conflict', reason: r.reason, folder, dir };
      };
      const mainTarget = path.join(slugDir, `${id}.jsonl`);
      let mainPlan = null;
      if (size > 0) {
        const list = sortSeq((byFile.get('main') || new Map()).get(gen) || []);
        const km = laid ? laid.get('main') : null;
        if (km) mainPlan = after('main', gen, list, size, km);
        else { const p = planChunks(id, 'main', gen, list, size); mainPlan = { chunks: p.chunks, size, seq: p.chunks.length }; }
        if (!row.sha256 || !HEX64_RE.test(row.sha256)) fail('main: the row has no sha256', 'bad_sha');
      }
      // side files, from their newest generation; one known here takes only the rows past it, of its own generation
      const sides = [];
      for (const [file, gens] of byFile) {
        if (file === 'main') continue;
        if (!C.checkFileKey(file) || !C.SIDE_DIRS.includes(file.split('/')[0]) || file.split('/').length < 2) { log(`sync-down: ${id}: a chunk row for a file that is not synced; ignored`); continue; }
        const k = laid ? laid.get(file) : null;
        if (k) {
          // a whole file changes only by a new generation, and a new generation may still have the old one's rows up
          if (!file.endsWith('.jsonl') || gens.size !== 1 || !gens.has(k.generation)) redo(`${file}: a new generation of it is up`);
          sides.push({ file, g: k.generation, ...after(file, k.generation, sortSeq(gens.get(k.generation)), null, k), k });
          continue;
        }
        if (gens.size > 1) { pending++; continue; } // a new generation is going up: next scan
        const [g, list] = [...gens][0];
        const p = planChunks(id, file, g, sortSeq(list), null);
        sides.push({ file, g, chunks: p.chunks, size: p.size, seq: p.chunks.length, added: p.chunks.length, k: null });
      }
      // known side files with no new rows: as they were
      if (laid) for (const [file, k] of laid) if (file !== 'main' && !byFile.has(file)) files[file] = { ...k };

      if (mainPlan) {
        if (makeFirst && !isDir(folder)) {
          if (!noLinks(root, parts)) fail('its placeholder folder would be made through a link', 'bad_path');
          fs.mkdirSync(folder, { recursive: true });
          log(`sync-down: ${id}: made its placeholder folder (${folder}): its workspace is only on its host`);
        }
        const r = await layDown({ id, file: 'main', target: mainTarget, chunks: mainPlan.chunks, size, sha256: row.sha256, whole: false, known: null }, key);
        if (r.result === 'conflict') return conflict('main', mainTarget, r);
        if (r.result === 'written') { wroteAny = true; stampLastEntry(mainTarget); }
        files.main = { generation: gen, size, sha256: row.sha256, seq: mainPlan.seq, stamp: stampOf(mainTarget) };
        // its log is here now: the folder it resumes in too (the links looked at again right before)
        if (makeFolder && !isDir(folder)) {
          if (!noLinks(root, parts)) fail('its folder would be made through a link', 'bad_path');
          fs.mkdirSync(folder, { recursive: true });
          log(`sync-down: ${id}: made the folder it began in (${folder}), which this machine did not have`);
        }
      }
      for (const s of sides) {
        const segs = s.file.split('/');
        const target = path.join(slugDir, id, ...segs);
        if (!inside(slugDir, target) || !noLinks(slugDir, [id, ...segs])) fail(`${s.file}: its path would leave the conversation's folder`, 'bad_path');
        if (s.k && !s.added) { files[s.file] = { ...s.k }; continue; } // nothing past what is laid down
        const before = prev && prev.files && prev.files[s.file] ? prev.files[s.file] : null;
        const sha = !s.k && s.chunks.length === 1 ? s.chunks[0].sha256 : null;
        const r = await layDownFile({ id, file: s.file, target, chunks: s.chunks, size: s.size, sha256: sha, whole: !s.file.endsWith('.jsonl'), known: before }, key);
        if (r.result === 'conflict') return conflict(s.file, target, r);
        if (r.result === 'written') wroteAny = true;
        files[s.file] = { generation: s.g, size: s.size, sha256: r.sha256 || sha, seq: s.seq, stamp: stampOf(target) };
      }
      for (const k of Object.keys(state.conflicts)) if (k.startsWith(`${id}|`)) delete state.conflicts[k];
      state.convos[id] = { sig: pending ? null : sigOf(row), dir: slugDir, files, conflict: false, at: now() };
      changed();
      if (pending) return { outcome: 'pending', reason: 'a side file is mid-upload', folder, dir };
      return { outcome: wroteAny ? 'done' : 'same', folder, dir };
    }
  }

  // ---------- the rows: listed whole now and then, only the changed ones in between ----------
  // rowsById holds every active row another device owns, as the lists left it; a scan goes through all of it (so a row
  // that waits, a back-off or one open here, is looked at again without being listed again). Lists:
  //   whole: the first one (every column) and one every fullMs after it: the light columns (LIGHT_COLS) of every active
  //     row another device owns, and every column only of the rows whose updated_at is not the one held (and the new
  //     ones), by id. A row it lacks goes (deleted, not active, this device's now); owner, lease and account are taken
  //     from it as they are (a change of account alone, or a lease, moves no updated_at). status().listedAt is when it
  //     began: a change of owner made before then is in it.
  //   changed (every other scan): the rows whose updated_at is at or past the watermark, or whose lease_until is past
  //     the newest one seen less the same overlap (sinceQuery), in any state (one gone inactive goes) and with any owner
  //     but this device. This device's own are never listed (its uploader's writes would come back every scan), so a
  //     row this device took over (the mover's claim) goes at the next whole list, and listedAt moves only then; a pull
  //     puts the row it read in rowsById (or takes it out: 'mine', 'missing'), so the scans between see the row it
  //     laid down and never lay an older one down over it. A list under way while a pull read its row leaves that row
  //     as the pull did (its own read of it may be the older one; a newer one comes with the next list).
  //   The watermark is the newest updated_at seen on another device's row (that writer's clock, not this machine's;
  //   never past this machine's clock, so a writer whose clock runs ahead hides nobody's writes) less OVERLAP_MS: a
  //   writer whose clock is behind, a write still on its way when the list ran. The lease watermark is the newest
  //   lease_until seen, never past LEASE_AHEAD_MS on this clock, less the same. A change that moves no updated_at
  //   (an account alone; a delete; a state set by hand) shows at the next whole list, fullMs at most.
  const ROW_COLS = 'id,account,repo_id,rel_cwd,size,sha256,generation,updated_at,owner_device,lease_until';
  const LIGHT_COLS = 'id,account,updated_at,owner_device,lease_until';
  const fullMs = Number.isFinite(opts.fullListMs) && opts.fullListMs >= 0 ? opts.fullListMs : FULL_LIST_MS;
  let rowsById = new Map(); // id lower-case -> row (ROW_COLS)
  let pulled = new Set(); // the ids a pull read since the list under way (or the last one) began
  let fullAt = null; // when the last whole list began (this clock), null before the first
  let newestAt = null, newestLease = null; // ms: the newest updated_at and lease_until seen on another device's row
  let changedOk = true, sinceOk = true; // false once Supabase refused a filter (then lists and fetches are whole)
  // a row this side can lay down: a conversation id, account a or b, whole numbers for size and generation
  const usable = (row) => !!row && typeof row.id === 'string' && UUID_RE.test(row.id) && (row.account === 'a' || row.account === 'b')
    && Number.isSafeInteger(Number(row.size)) && Number(row.size) >= 0 && Number.isSafeInteger(Number(row.generation)) && Number(row.generation) >= 0;
  const ownerOfRow = (row) => (row && typeof row.owner_device === 'string' ? row.owner_device.toLowerCase() : null);
  const others = (row, me) => !!row && typeof row.id === 'string' && UUID_RE.test(row.id) && !!ownerOfRow(row) && ownerOfRow(row) !== me;
  const pick = (row) => Object.fromEntries(ROW_COLS.split(',').map((c) => [c, row[c] === undefined ? null : row[c]]));
  function noteTimes(row) {
    const u = Date.parse(row.updated_at), l = Date.parse(row.lease_until);
    if (Number.isFinite(u) && (newestAt === null || u > newestAt)) newestAt = u;
    if (Number.isFinite(l) && (newestLease === null || l > newestLease)) newestLease = l;
  }
  // every row a query names, in pages of PAGE by id (a key that never shifts while rows come, go or change)
  async function pages(query) {
    const out = [];
    let after = null;
    for (;;) {
      const q = { ...query, order: 'id.asc', limit: String(PAGE) };
      if (after) q.id = `gt.${after}`;
      const rows = await api.rest('GET', 'conversations', { query: q });
      if (!Array.isArray(rows) || !rows.length) break;
      out.push(...rows);
      const last = rows[rows.length - 1];
      if (rows.length < PAGE || !last || typeof last.id !== 'string') break;
      after = last.id;
    }
    return out;
  }
  async function wholeList(me) {
    const base = { state: 'eq.active', owner_device: `neq.${me}` };
    const next = new Map();
    if (fullAt === null || !rowsById.size) {
      for (const row of await pages({ select: ROW_COLS, ...base })) if (others(row, me)) next.set(row.id.toLowerCase(), pick(row));
    } else {
      const want = [];
      for (const r of await pages({ select: LIGHT_COLS, ...base })) {
        if (!others(r, me)) continue;
        const id = r.id.toLowerCase(), had = rowsById.get(id);
        if (had && had.updated_at === r.updated_at) next.set(id, { ...had, owner_device: r.owner_device, lease_until: r.lease_until, account: r.account });
        else want.push(id);
      }
      for (let i = 0; i < want.length; i += BY_ID) {
        const got = await api.rest('GET', 'conversations', { query: { select: ROW_COLS, ...base, id: `in.(${want.slice(i, i + BY_ID).join(',')})` } });
        for (const row of Array.isArray(got) ? got : []) if (others(row, me)) next.set(row.id.toLowerCase(), pick(row));
      }
    }
    // a row a pull read meanwhile stays as the pull left it (rowsById is still the map it wrote to)
    for (const id of pulled) { const row = rowsById.get(id); if (row) next.set(id, row); else next.delete(id); }
    rowsById = next;
    for (const row of next.values()) noteTimes(row);
  }
  // the changed rows' filter: updated_at at or past the watermark, or lease_until past the newest lease seen (less the
  // same overlap; never past LEASE_AHEAD_MS on this clock, so a writer whose clock runs ahead hides nobody's renewed
  // leases): quoted, as PostgREST wants a value holding '.' or ':' in a logic tree
  function sinceQuery(t) {
    const w = (newestAt === null ? t : Math.min(newestAt, t)) - OVERLAP_MS;
    const lw = (newestLease === null ? w + OVERLAP_MS : Math.min(newestLease, t + LEASE_AHEAD_MS)) - OVERLAP_MS;
    return `(updated_at.gte."${new Date(w).toISOString()}",lease_until.gte."${new Date(lw).toISOString()}")`;
  }
  async function changedList(me, t) {
    const rows = await pages({ select: `${ROW_COLS},state`, owner_device: `neq.${me}`, or: sinceQuery(t) });
    for (const row of rows) {
      if (!row || typeof row.id !== 'string' || !UUID_RE.test(row.id)) continue;
      const id = row.id.toLowerCase();
      if (pulled.has(id)) continue; // a pull read it meanwhile: its row stands
      if (row.state === 'active' && others(row, me)) { rowsById.set(id, pick(row)); noteTimes(row); } else rowsById.delete(id);
    }
  }
  // -> true when this was a whole list
  async function listRows(me, t) {
    pulled = new Set();
    if (fullAt === null || !changedOk || t - fullAt >= fullMs || t < fullAt) { await wholeList(me); fullAt = t; return true; }
    try { await changedList(me, t); return false; } catch (e) {
      if (!e || e.status !== 400) throw e;
      changedOk = false; // Supabase does not take the filter: whole lists from now on
      log(`sync-down: the changed rows could not be listed (${e.message}); every scan lists them all`);
      await wholeList(me); fullAt = t;
      return true;
    }
  }
  const byNewest = (a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0);
  async function scan() {
    const key = await getKey();
    if (!key) { st.lastError = 'no sync key on this machine'; return { skipped: 'no key' }; }
    const me = await C.ensureDevice(api, dataDir);
    try { await C.touchDevice(api, me, { now: now() }); } catch (e) { log(`sync-down: last_seen_at not sent: ${e.message}`); }
    await slot(null, false);
    try { saveState(); state = loadState(); } finally { unslot(null); } // not under a pull's feet
    const ctx = newCtx(me);
    const tally = { rows: 0, unchanged: 0, done: 0, same: 0, conflict: 0, skip: 0, pending: 0, failed: 0, waiting: 0 };
    const reasons = {};
    const lacking = new Map(); // origin -> { origin, name, chats, newest }: repos skipped as having no checkout here
    const only = onlyOf();
    const listStart = now();
    const whole = await listRows(me, listStart);
    const rows = [...rowsById.values()].filter((row) => !only || only(row.id.toLowerCase())).sort(byNewest);
    // who owns what, for owners(): every active row another device owns, and whether it is bound (its repos row's)
    const repoOrigins = await origins(rows.map((row) => row.repo_id));
    const seen = new Map();
    for (const row of rows) {
      const owner = typeof row.owner_device === 'string' ? row.owner_device.toLowerCase() : null;
      if (!owner || owner === me) continue;
      const lease = row.lease_until ? Date.parse(row.lease_until) : NaN;
      const bound = typeof row.repo_id === 'string' && !!C.boundDeviceOf(repoOrigins.get(row.repo_id.toLowerCase()));
      seen.set(row.id.toLowerCase(), { device: owner, leaseUntil: Number.isFinite(lease) ? lease : null, account: row.account === 'a' || row.account === 'b' ? row.account : null, bound });
    }
    ownersMap = seen;
    if (whole) st.listedAt = new Date(listStart).toISOString();
    st.checkedAt = new Date(listStart).toISOString();
    // rows start in list order, up to ROWS_AT_ONCE under way at once; Supabase out of reach (fatal) starts no more,
    // and the ones under way finish (or fail) and count before it is thrown
    const going = new Set();
    let fatal = null;
    try {
      for (const listed of rows) {
        if (fatal) break;
        // the row as it is now: a pull since the list may have read a newer one (or found it this device's)
        const row = rowsById.get(listed.id.toLowerCase());
        if (!row) continue;
        const owner = typeof row.owner_device === 'string' ? row.owner_device.toLowerCase() : null;
        if (!owner || owner === me) continue; // this device's own (or nobody's): the uploader's
        if (!usable(row)) continue;
        tally.rows++;
        const id = row.id.toLowerCase(), prev = state.convos[id];
        // unchanged, and its log still where it was laid down (Claude Code deletes old logs: one gone comes again)
        if (prev && prev.sig === sigOf(row) && (!prev.conflict || prev.localStamp === stampOf(path.join(prev.dir || '', `${id}.jsonl`)))
          && (prev.conflict || Number(row.size) === 0 || (typeof prev.dir === 'string' && !!lstatOr(path.join(prev.dir, `${id}.jsonl`))))) { tally.unchanged++; continue; }
        const b = backoff.get(id);
        if (b && now() < b.until) { tally.waiting++; continue; }
        await slot(id, false); // a pull() waiting goes first
        if (fatal) { unslot(id); break; }
        // a pull of it ran while this waited: the row it read, and what it laid down, stand
        const cur = rowsById.get(id), p0 = state.convos[id];
        if (!cur || (cur !== row && p0 && p0.sig === sigOf(cur))) { unslot(id); tally.unchanged++; continue; }
        const p = (async () => {
          try {
            const r = await syncOne(cur, ctx, key);
            tally[r.outcome]++;
            if (r.reason) reasons[r.reason] = (reasons[r.reason] || 0) + 1;
            if (r.reason === NO_CHECKOUT && typeof r.origin === 'string' && r.origin) {
              const was = lacking.get(r.origin) || { origin: r.origin, name: r.origin.split('/').pop() || r.origin, chats: 0, newest: null };
              was.chats++;
              if (typeof row.updated_at === 'string' && (!was.newest || row.updated_at > was.newest)) was.newest = row.updated_at;
              lacking.set(r.origin, was);
            }
            if (r.outcome === 'done') st.laidDown++;
            backoff.delete(id);
          } catch (e) {
            if (e && ['network', 'timeout', 'signed_out', 'off'].includes(e.code) && !fatal) fatal = e; // Supabase is out of reach: stop this scan
            tally.failed++;
            // a request cut because the machine slept is not this conversation's fault: the next scan tries it again
            if (!(e && e.slept)) {
              const n = b ? b.n + 1 : 1;
              backoff.set(id, { n, until: now() + Math.min(BACKOFF_MIN_MS * 2 ** (n - 1), BACKOFF_MAX_MS) });
            }
            const why = (e && e.message) || String(e);
            reasons[why] = (reasons[why] || 0) + 1;
            log(`sync-down: ${id}: ${why}`);
          } finally { unslot(id); }
        })();
        going.add(p);
        const done = () => { going.delete(p); };
        p.then(done, (e) => { done(); if (!fatal) fatal = e; }); // only a throwing log() lands here
      }
    } catch (e) { if (!fatal) fatal = e; } // anything else thrown between rows: the ones under way still settle first
    await Promise.allSettled([...going]);
    saveState();
    if (fatal) throw fatal;
    if (!only) {
      const newest = (r) => r.newest || '';
      missingNow = { at: new Date(listStart).toISOString(), repos: [...lacking.values()].sort((a, b) => (newest(a) < newest(b) ? 1 : newest(a) > newest(b) ? -1 : 0)) };
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
    await slot(id, true);
    try {
      const got = await api.rest('GET', 'conversations', { query: { select: ROW_COLS, id: `eq.${id}`, state: 'eq.active' } });
      const row = Array.isArray(got) && got[0] ? got[0] : null;
      // the scans' rows take what this read: the newest there is (none, or this device's: not another's any more), and
      // a list under way leaves it so
      if (row && others(row, me)) rowsById.set(id, pick(row)); else rowsById.delete(id);
      pulled.add(id);
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
    } finally { saveState(); unslot(id); }
  }
  // a copy: the caller cannot change this side's map
  const owners = () => new Map([...ownersMap].map(([id, o]) => [id, { ...o }]));
  // one id's owner, cheap (no copy of the map): null before the first list
  function owner(raw) {
    if (fullAt === null) return null;
    const row = rowsById.get(String(raw == null ? '' : raw).toLowerCase());
    const ms = (iso) => (iso ? Date.parse(iso) : null);
    return { device: row ? ownerOfRow(row) : null, at: ms(st.listedAt), checkedAt: ms(st.checkedAt) };
  }
  const missing = () => ({ at: missingNow.at, repos: missingNow.repos.map((r) => ({ ...r })) });

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
    saveState();
  }
  function status() {
    return {
      running: st.running, scanning: st.scanning, scans: st.scans, lastScanAt: st.lastScanAt, lastOkAt: st.lastOkAt, listedAt: st.listedAt, checkedAt: st.checkedAt,
      lastError: st.lastError, laidDown: st.laidDown, last: st.last ? { ...st.last, reasons: { ...st.last.reasons } } : null,
      conflicts: Object.keys(state.conflicts).length, waiting: backoff.size,
    };
  }
  const conflicts = () => Object.values(state.conflicts).map((c) => ({ ...c }));
  // a move (sync-move.js, sync-carry.js relocateLog) put the log it laid down into another slug folder of the same
  // projects folder, where it resumes: it stays there from now on (the next scan finds it there anyway)
  function moved(id, dir) {
    const k = typeof id === 'string' ? id.toLowerCase() : '';
    const e = state.convos[k];
    if (!e || typeof dir !== 'string' || !dir) return false;
    e.dir = path.resolve(dir);
    changed();
    saveState();
    return true;
  }

  return { scanOnce, start, stop, status, conflicts, pull, owners, owner, missing, moved };
}

module.exports = { createMaterializer, relParts, planChunks, downStatePath, FETCH_AHEAD, ROWS_AT_ONCE, NO_CHECKOUT };
