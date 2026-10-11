// sync-up.js: the uploader (the plan's part S2). It keeps this machine's Claude Code conversations in Henry's
// Supabase, sealed, so the materializer (sync-down.js, S3) on another machine can lay them down again byte for byte.
// docs/sync-format.md is the contract, and "The uploader's rules" there are what this file does:
//
//   createUploader({ api, dataDir, key, log, now, projects, chunkBytes, rateBytesPerSec })
//     -> { scanOnce(), start(intervalMs = 5000), stop(), status() }
//
//   api              sync-api.js createSync()'s object (rest() and storage are all it uses)
//   key              the 32-byte sync key (sync-crypto.js loadKey); every byte that leaves goes through it
//   dataDir          Fleet View's data folder; this keeps <dataDir>/sync/up-state.json and device.json there
//   projects         [{ account, dir }] (or a function giving them) to look in; sync-common.js projectsDirs() by
//                    default, which reads ~/.claude and ~/.claude-a. Tests hand it a temp folder.
//   log(text)        one line per thing worth knowing (no title, no transcript text, no token)
//   now()            the clock for back-offs and row times (Date.now by default; tests move it)
//   chunkBytes       plain bytes per chunk, at most 8 MiB (the default)
//   rateBytesPerSec  sealed bytes per second sent to Storage, 4 MB/s by default
//
// One scan (scanOnce): this machine's devices row (sync-common.js ensureDevice); every conversation in every projects
// folder, newest log first, one at a time. For each one whose files changed since the last scan:
//   1. Its last cwd (from the log's end) must be inside a git checkout with an origin on a host. A cwd that is gone
//      (a removed worktree) counts by the nearest folder above it that is still there, as long as the checkout found
//      holds the cwd. No origin, no checkout: not synced.
//   2. The repos row for that origin and this device's repo_paths row (the main checkout's folder) are made when
//      missing.
//   3. The conversations row: made with owner_device = this device when there is none; one with no owner is claimed;
//      one another device owns is left alone (S4 moves owners), and so is one that is not 'active'.
//   4. Each file (sync-common.js conversationFiles: main, subagents/, tool-results/, workflows/):
//        append-only (main, *.jsonl) that grew and whose last 4 KiB before the uploaded end are unchanged: the new
//          bytes up to the last '\n' go up as the next chunk(s) of the same generation, a row after each object;
//        one that shrank or whose tail changed, or a whole file whose bytes changed: generation + 1 from byte 0,
//          every object first, then all its chunk rows in one insert (so a reader sees all of it or none of it);
//        a first upload is generation 0, chunk by chunk.
//   5. The conversations row (size, sha256 and generation of 'main', updated_at, and the cwd, branch and sealed title)
//      only after the chunk rows, and only while this device still owns it.
//   6. Old generations: their chunk rows, then their objects, once the row points at the new one.
// Order, always: object, then its chunk row, then the conversation row. Objects are written with upsert and chunk
// rows with merge-duplicates, so a pass cut short (a crash between an object and up-state.json) is simply done again.
//
// up-state.json: { v: 1, device, conversations: { <id>: { files: { <file key>: { generation, seq, offset, tailSha,
// size, mtimeMs, sha? } }, titleSha, meta, rowStale, deletes } } }. offset is the uploaded end, tailSha the sha256 of
// the up to 4096 bytes before it; size and mtimeMs are what the file was when last looked at (unchanged: no read at
// all); sha is a whole file's sha256. It moves only after the server has what it says. When it is missing or does
// not match the server (another install, a lost file), the server's chunk rows are checked against the local bytes
// and taken over when they match, so nothing is sent twice; when they don't, the file starts a new generation.
//
// A failure on one conversation is logged and that conversation waits (30 s, doubling, at most 30 min) while the
// scan goes on; a signed-out account ends the scan. Nothing here starts a process; the only timer is start()'s.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const P = require(path.join(__dirname, 'platform.js'));
const S = require(path.join(__dirname, 'sync-api.js'));
const K = require(path.join(__dirname, 'sync-crypto.js'));
const C = require(path.join(__dirname, 'sync-common.js'));

const MAX_CHUNK = 8 * 1024 * 1024; // docs/sync-format.md: a chunk carries at most 8 MiB of plain bytes
const RATE = 4 * 1024 * 1024; // sealed bytes per second to Storage
const TAIL_BYTES = 4096; // tailSha covers this much before the uploaded end
const INTERVAL_MS = 5e3;
const BACKOFF_MS = 30e3, BACKOFF_MAX_MS = 30 * 60e3;
const FOREIGN_RECHECK_MS = 5 * 60e3; // another device's conversation is asked about again after this (or a change)
const SKIP_RECHECK_MS = 10 * 60e3; // one with no repo, the same
const IDLE_MS = 60 * 60e3; // a conversation whose log is older than this has its side files listed at most...
const IDLE_LIST_MS = 60e3; // ...this often (a background subagent can still write while the log sleeps)
const PAGE = 1000; // chunk rows per GET
const REMOVE_MAX = 1000; // storage.remove takes at most this many paths
const HASHES_KEPT = 200; // running sha256s of 'main' kept in memory, so an append does not read the log again
const SAVE_EVERY_MS = 5e3; // up-state.json at most this often while one conversation is going up
const READ_BLOCK = 64 * 1024;
const LOG_ID = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const FATAL = new Set(['signed_out', 'off', 'bad_key']); // these end a scan: every other conversation would fail too

const clip = (s, n = 200) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const short = (id) => String(id).slice(0, 8);

// ---------- reading a file in pieces ----------
// exactly len bytes from pos, or a throw (the file shrank under us: the next scan sees why)
function readExact(fd, pos, len) {
  const buf = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const n = fs.readSync(fd, buf, got, len - got, pos + got);
    if (!n) throw new S.SyncError('the file got shorter while it was read', 0, 'changed');
    got += n;
  }
  return buf;
}
// the end of the last whole line in [from, size): the byte after its '\n', or from when there is none
function lastLineEnd(fd, from, size) {
  let hi = size;
  while (hi > from) {
    const lo = Math.max(from, hi - READ_BLOCK);
    const buf = readExact(fd, lo, hi - lo);
    const i = buf.lastIndexOf(10);
    if (i >= 0) return lo + i + 1;
    hi = lo;
  }
  return from;
}
// does a log hold at least one whole line yet?
function hasWholeLine(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    return lastLineEnd(fd, 0, fs.fstatSync(fd).size) > 0;
  } catch { return false; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}
const tailShaAt = (fd, end) => K.sha256(end > 0 ? readExact(fd, Math.max(0, end - TAIL_BYTES), Math.min(end, TAIL_BYTES)) : Buffer.alloc(0));
// sha256 of [0, end), and fn(buf, pos) for each block on the way when given
function hashRange(fd, end, fn) {
  const h = crypto.createHash('sha256');
  for (let pos = 0; pos < end; pos += MAX_CHUNK) {
    const buf = readExact(fd, pos, Math.min(MAX_CHUNK, end - pos));
    h.update(buf);
    if (fn) fn(buf, pos);
  }
  return h;
}

// ---------- where a conversation belongs ----------
// A log's last cwd -> { origin, mainRoot, relCwd } | null. rel_cwd is relative to the main checkout (a worktree under
// <root>/.claude/worktrees keeps that path), or to the worktree's own top when it lives outside the main checkout.
function inside(base, p) {
  const rel = path.relative(base, p);
  if (rel === '') return '';
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}
async function repoFor(cwd) {
  if (typeof cwd !== 'string' || !cwd) return null;
  // a path from another platform (a Mac log on Windows, or the other way) is not a folder here
  if (P.isWin ? !/^(?:[A-Za-z]:[\\/]|\\\\)/.test(cwd) : !cwd.startsWith('/')) return null;
  const want = path.resolve(cwd);
  let dir = want;
  while (!isDir(dir)) {
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  const r = await C.repoOf(dir);
  if (!r || !r.origin) return null;
  let relCwd = inside(r.mainRoot, want);
  if (relCwd === null) relCwd = inside(r.root, want);
  if (relCwd === null) return null;
  return { origin: r.origin, mainRoot: r.mainRoot, relCwd };
}

function createUploader(opts = {}) {
  const api = opts.api;
  if (!api || typeof api.rest !== 'function' || !api.storage) throw new S.SyncError('the uploader needs sync-api.js\'s api', 0, 'bad_request');
  const key = opts.key;
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new S.SyncError('the sync key must be 32 bytes', 0, 'bad_key');
  const dataDir = opts.dataDir;
  if (typeof dataDir !== 'string' || !dataDir) throw new S.SyncError('the uploader needs the data folder', 0, 'bad_request');
  const log = typeof opts.log === 'function' ? (t) => { try { opts.log(`sync-up: ${t}`); } catch {} } : () => {};
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const chunkBytes = Number.isSafeInteger(opts.chunkBytes) && opts.chunkBytes > 0 ? Math.min(opts.chunkBytes, MAX_CHUNK) : MAX_CHUNK;
  const rate = Number(opts.rateBytesPerSec) > 0 ? Number(opts.rateBytesPerSec) : RATE;
  const statePath = path.join(S.syncDir(dataDir), 'up-state.json');
  const projectsList = () => {
    const p = opts.projects;
    if (typeof p === 'function') return C.projectsDirs({ dirs: p() });
    if (Array.isArray(p)) return C.projectsDirs({ dirs: p });
    return C.projectsDirs(p && typeof p === 'object' ? p : {});
  };

  // ---------- memory ----------
  let state = null; // up-state.json as loaded
  let dirty = false, savedAt = 0;
  const memo = new Map(); // id -> { fails, backoffUntil, skip: { sig, until, why }, listedAt }
  const pendingOf = new Map(); // id -> bytes still to go up
  const hashes = new Map(); // id -> { generation, offset, hash }: the running sha256 of 'main' (oldest first)
  const repoIds = new Map(); // origin -> repos.id
  const repoPathsDone = new Set(); // `${device}|${repoId}|${root}` written in this process
  const skipLogged = new Set();
  const counts = { conversations: 0, synced: 0, pending: 0, noRepo: 0, foreign: 0, inactive: 0, empty: 0, backingOff: 0 };
  const totals = { scans: 0, uploadedBytes: 0, uploadedChunks: 0, lastScanAt: null, lastScanMs: null, lastError: null };

  function loadState(device) {
    if (state && state.device === device) return;
    const s = C.readState(statePath, null);
    if (s && s.v === 1 && s.device === device && s.conversations && typeof s.conversations === 'object') state = s;
    else {
      if (s) log('up-state.json is from another device or damaged: starting again from what the server has');
      state = { v: 1, device, conversations: {} };
      dirty = true;
    }
  }
  function saveState(force) {
    if (!dirty || !state) return;
    if (!force && Date.now() - savedAt < SAVE_EVERY_MS) return;
    try { C.writeState(statePath, state); dirty = false; savedAt = Date.now(); } catch (e) { log(`up-state.json could not be saved: ${clip(e.message)}`); }
  }
  const setError = (e) => { totals.lastError = { at: new Date(now()).toISOString(), message: clip(e && e.message ? e.message : e) }; };

  // ---------- stopping and pacing ----------
  let stopping = false;
  const sleepers = new Set();
  function sleep(ms) {
    return new Promise((resolve) => {
      const s = { resolve, t: setTimeout(() => { sleepers.delete(s); resolve(); }, ms) };
      sleepers.add(s);
    });
  }
  const wake = () => { for (const s of sleepers) { clearTimeout(s.t); s.resolve(); } sleepers.clear(); };
  let nextSendAt = 0;
  async function pace(bytes) {
    const t = Date.now();
    if (nextSendAt < t) nextSendAt = t;
    const wait = nextSendAt - t;
    nextSendAt += (bytes / rate) * 1000;
    if (wait > 0) await sleep(wait);
    if (stopping) throw new S.SyncError('stopped', 0, 'stopped');
  }

  // ---------- rows ----------
  async function repoId(origin) {
    if (repoIds.has(origin)) return repoIds.get(origin);
    const get = async () => {
      const rows = await api.rest('GET', 'repos', { query: { select: 'id', origin: `eq.${origin}` } });
      return Array.isArray(rows) && rows[0] && rows[0].id ? String(rows[0].id).toLowerCase() : null;
    };
    let id = await get();
    if (!id) {
      await api.rest('POST', 'repos', { query: { on_conflict: 'user_id,origin' }, body: { origin }, prefer: 'resolution=ignore-duplicates,return=minimal' });
      id = await get();
      if (!id) throw new S.SyncError('Supabase made no repos row', 0, 'bad_reply');
    }
    repoIds.set(origin, id);
    return id;
  }
  async function repoPath(device, rid, root) {
    const k = `${device}|${rid}|${root}`;
    if (repoPathsDone.has(k)) return;
    await api.rest('POST', 'repo_paths', { query: { on_conflict: 'device_id,repo_id' }, body: { device_id: device, repo_id: rid, root }, prefer: 'resolution=merge-duplicates,return=minimal' });
    repoPathsDone.add(k);
  }
  const ROW_COLS = 'id,owner_device,generation,size,state';
  async function getRow(id) {
    const rows = await api.rest('GET', 'conversations', { query: { select: ROW_COLS, id: `eq.${id}` } });
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  }
  // every chunk row of a conversation (or of one file of it), in pages
  async function chunkRows(id, filter = {}) {
    const out = [];
    for (let offset = 0; ; offset += PAGE) {
      const rows = await api.rest('GET', 'chunks', { query: {
        select: 'file,generation,seq,byte_offset,byte_length,object_path,sha256', conversation_id: `eq.${id}`, ...filter,
        order: 'file.asc,generation.asc,seq.asc', limit: String(PAGE), offset: String(offset),
      } });
      if (!Array.isArray(rows)) break;
      out.push(...rows);
      if (rows.length < PAGE) break;
    }
    return out;
  }
  async function maxGeneration(id, file) {
    const rows = await api.rest('GET', 'chunks', { query: { select: 'generation', conversation_id: `eq.${id}`, file: `eq.${file}`, order: 'generation.desc', limit: '1' } });
    return Array.isArray(rows) && rows[0] ? Number(rows[0].generation) : -1;
  }
  const postChunks = (rows) => api.rest('POST', 'chunks', {
    query: { on_conflict: 'conversation_id,file,generation,seq' }, body: rows, prefer: 'resolution=merge-duplicates,return=minimal',
  });

  // ---------- the running sha256 of 'main' ----------
  function mainHash(id, fd, generation, offset) {
    const h = hashes.get(id);
    if (h && h.generation === generation && h.offset === offset) { hashes.delete(id); hashes.set(id, h); return h; }
    const nh = { generation, offset, hash: hashRange(fd, offset) };
    keepHash(id, nh);
    return nh;
  }
  function keepHash(id, h) {
    hashes.delete(id);
    hashes.set(id, h);
    while (hashes.size > HASHES_KEPT) hashes.delete(hashes.keys().next().value);
  }

  // ---------- sending bytes ----------
  // [from, end) of a file as chunks gen/seq.., each sealed with its own path. batch: objects only, the rows are
  // given back for one insert; else each row goes in after its object and done(row, buf) runs once the server has it.
  async function send(w, f, fd, { generation, seq, from, end, batch, done }) {
    const rows = [];
    let pos = from;
    do {
      if (stopping) throw new S.SyncError('stopped', 0, 'stopped');
      const len = Math.min(chunkBytes, end - pos);
      const buf = readExact(fd, pos, len);
      const objectPath = C.objectPath(w.id, f.fileKey, generation, seq);
      const sealed = K.sealChunk(buf, key, objectPath);
      await pace(sealed.length);
      await api.storage.upload(objectPath, sealed, { upsert: true });
      totals.uploadedBytes += sealed.length;
      totals.uploadedChunks++;
      const row = { conversation_id: w.id, file: f.fileKey, generation, seq, byte_offset: pos, byte_length: len, object_path: objectPath, sha256: K.sha256(buf) };
      if (batch) rows.push({ row, buf });
      else { await postChunks([row]); done(row, buf); }
      pos += len;
      seq++;
    } while (pos < end);
    return rows;
  }

  // The server's rows for a file with no state here: taken over when its newest generation runs from byte 0 with no
  // gap and every chunk's sha256 matches the local bytes. -> a file state, or null (then maxGen says where to go on)
  function adopt(w, f, fd, size) {
    const mine = w.listing.filter((r) => r.file === f.fileKey);
    if (!mine.length) return null;
    const gen = Math.max(...mine.map((r) => Number(r.generation)));
    w.maxGen[f.fileKey] = gen;
    const rows = mine.filter((r) => Number(r.generation) === gen).sort((a, b) => a.seq - b.seq);
    let off = 0;
    const h = crypto.createHash('sha256');
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i], o = Number(r.byte_offset), l = Number(r.byte_length);
      if (Number(r.seq) !== i || o !== off || o + l > size) return null;
      const buf = readExact(fd, o, l);
      if (K.sha256(buf) !== r.sha256) return null;
      h.update(buf);
      off += l;
    }
    if (!f.appendOnly && off !== size) return null;
    if (f.appendOnly && off > 0 && readExact(fd, off - 1, 1)[0] !== 10) return null;
    if (mine.some((r) => Number(r.generation) !== gen)) w.st.deletes.push({ file: f.fileKey, below: gen });
    const fst = { generation: gen, seq: rows.length, offset: off, tailSha: tailShaAt(fd, off), size: -1, mtimeMs: -1 };
    if (!f.appendOnly) fst.sha = h.copy().digest('hex');
    if (f.fileKey === 'main') keepHash(w.id, { generation: gen, offset: off, hash: h });
    log(`${short(w.id)} ${f.fileKey}: took over ${rows.length} chunk(s) already on the server`);
    return fst;
  }

  // One file of a conversation: what changed goes up, and w.st.files[key] moves with the server.
  async function syncFile(w, f) {
    const files = w.st.files;
    let fst = files[f.fileKey] || null;
    if (fst && fst.size === f.size && fst.mtimeMs === f.mtimeMs) return;
    let fd;
    try { fd = fs.openSync(f.path, 'r'); } catch { return; } // gone since it was listed
    try {
      const st = fs.fstatSync(fd);
      const size = st.size, mtimeMs = st.mtimeMs;
      if (!fst && w.listing) fst = adopt(w, f, fd, size);
      const commit = (o) => { files[f.fileKey] = { ...o, size, mtimeMs }; w.changed = true; dirty = true; };
      if (f.appendOnly && fst && size >= fst.offset && tailShaAt(fd, fst.offset) === fst.tailSha) {
        // rule 2: it grew (or not), the bytes we have are still there: append whole lines
        const end = lastLineEnd(fd, fst.offset, size);
        if (end > fst.offset) {
          pendingOf.set(w.id, (pendingOf.get(w.id) || 0) + end - fst.offset);
          const isMain = f.fileKey === 'main';
          const h = isMain ? mainHash(w.id, fd, fst.generation, fst.offset) : null;
          let cur = { ...fst };
          await send(w, f, fd, { generation: fst.generation, seq: fst.seq, from: fst.offset, end, done: (row, buf) => {
            cur = { generation: cur.generation, seq: row.seq + 1, offset: row.byte_offset + row.byte_length, tailSha: null };
            if (h) { h.hash.update(buf); h.offset = cur.offset; }
            files[f.fileKey] = { ...cur, tailSha: tailShaAt(fd, cur.offset), size: -1, mtimeMs: -1 }; // -1: look again next time
            w.st.rowStale = true; w.changed = true; dirty = true;
            saveState(false);
          } });
          cur.tailSha = tailShaAt(fd, cur.offset);
          commit(cur);
        } else commit(fst);
        return;
      }
      // a whole file: unchanged bytes (only the time moved) need nothing
      let sha = null;
      if (!f.appendOnly) {
        sha = hashRange(fd, size).digest('hex');
        if (fst && fst.sha === sha) { commit(fst); return; }
      }
      const end = f.appendOnly ? lastLineEnd(fd, 0, size) : size;
      if (f.appendOnly && !fst && end === 0) return; // not one whole line yet
      // rule 3 (or a first upload): a generation from byte 0
      let gen = 0;
      if (fst || w.rowExisted) {
        const seen = w.maxGen[f.fileKey] !== undefined ? w.maxGen[f.fileKey] : w.rowExisted ? await maxGeneration(w.id, f.fileKey) : -1;
        gen = Math.max(fst ? fst.generation : -1, seen) + 1;
      }
      const isMain = f.fileKey === 'main';
      pendingOf.set(w.id, (pendingOf.get(w.id) || 0) + end);
      if (gen === 0 && f.appendOnly) {
        // the first upload of a log: chunk by chunk, each row as its object lands (a prefix is a good log)
        const h = isMain ? { generation: 0, offset: 0, hash: crypto.createHash('sha256') } : null;
        if (h) keepHash(w.id, h);
        let cur = null;
        if (end > 0) await send(w, f, fd, { generation: 0, seq: 0, from: 0, end, done: (row, buf) => {
          cur = { generation: 0, seq: row.seq + 1, offset: row.byte_offset + row.byte_length };
          if (h) { h.hash.update(buf); h.offset = cur.offset; }
          files[f.fileKey] = { ...cur, tailSha: tailShaAt(fd, cur.offset), size: -1, mtimeMs: -1 };
          w.st.rowStale = true; w.changed = true; dirty = true;
          saveState(false);
        } });
        commit({ ...(cur || { generation: 0, seq: 0, offset: 0 }), tailSha: tailShaAt(fd, end) });
        return;
      }
      // a new generation (or a whole file's first): every object, then every row in one insert
      const h = crypto.createHash('sha256');
      let rows = [];
      if (end > 0 || !f.appendOnly) {
        rows = await send(w, f, fd, { generation: gen, seq: 0, from: 0, end, batch: true });
        for (const r of rows) h.update(r.buf);
        await postChunks(rows.map((r) => r.row));
      }
      const fstNew = { generation: gen, seq: rows.length, offset: end, tailSha: tailShaAt(fd, end) };
      if (!f.appendOnly) fstNew.sha = sha;
      if (isMain) keepHash(w.id, { generation: gen, offset: end, hash: h });
      commit(fstNew);
      w.st.rowStale = true;
      if (gen > 0) w.st.deletes.push({ file: f.fileKey, below: gen });
      if (fst || gen > 0) log(`${short(w.id)} ${f.fileKey}: generation ${gen} (${fst ? 'the file was rewritten' : 'what the server had did not match'})`);
    } finally { try { fs.closeSync(fd); } catch {} }
  }

  // rule 6: old generations go once the conversation row points at the new ones: rows first, then objects
  async function dropOld(w) {
    const list = w.st.deletes;
    while (list.length) {
      const d = list[0];
      if (!d.paths) {
        const old = await chunkRows(w.id, { file: `eq.${d.file}`, generation: `lt.${d.below}` });
        d.paths = old.map((r) => r.object_path).filter((p) => typeof p === 'string' && p);
        if (old.length) await api.rest('DELETE', 'chunks', { query: { conversation_id: `eq.${w.id}`, file: `eq.${d.file}`, generation: `lt.${d.below}` }, prefer: 'return=minimal' });
        dirty = true;
      }
      while (d.paths.length) {
        const batch = d.paths.slice(0, REMOVE_MAX);
        await api.storage.remove(batch);
        d.paths.splice(0, batch.length);
        dirty = true;
      }
      list.shift();
      dirty = true;
    }
  }

  function skip(c, mem, why, ms) {
    mem.skip = { sig: `${c.size}:${c.mtimeMs}`, until: now() + ms, why };
    counts[why]++;
  }

  // ---------- one conversation ----------
  async function syncConversation(c, device) {
    const id = c.id, t = now();
    let mem = memo.get(id);
    if (!mem) { mem = { fails: 0, backoffUntil: 0, skip: null, listedAt: 0 }; memo.set(id, mem); }
    if (mem.backoffUntil > t) { counts.backingOff++; return; }
    if (mem.skip && mem.skip.sig === `${c.size}:${c.mtimeMs}` && mem.skip.until > t) { counts[mem.skip.why]++; return; }
    mem.skip = null;
    let st = state.conversations[id] || null;
    if (st && (!st.files || typeof st.files !== 'object')) st = null;
    const settled = st && !st.rowStale && !(st.deletes && st.deletes.length);
    // cheap: an idle conversation whose log is as it was is listed again only now and then
    const main0 = st && st.files && st.files.main;
    if (settled && main0 && main0.size === c.size && main0.mtimeMs === c.mtimeMs && Date.now() - c.mtimeMs > IDLE_MS && t - mem.listedAt < IDLE_LIST_MS) {
      counts.synced++; return;
    }
    const files = C.conversationFiles(c.slugDir, c.name, { onSkip: (p, why) => {
      if (skipLogged.has(p)) return;
      skipLogged.add(p);
      log(`${short(id)}: not synced: ${path.basename(p)} (${why})`);
    } });
    mem.listedAt = t;
    if (settled && files.every((f) => { const s = st.files[f.fileKey]; return s && s.size === f.size && s.mtimeMs === f.mtimeMs; })) {
      pendingOf.set(id, 0);
      counts.synced++;
      return;
    }

    // where it belongs
    const meta = C.lastMeta(c.mainPath);
    const repo = meta.cwd ? await repoFor(meta.cwd) : null;
    if (!repo) { pendingOf.delete(id); return skip(c, mem, 'noRepo', SKIP_RECHECK_MS); }
    const rid = await repoId(repo.origin);
    await repoPath(device, rid, repo.mainRoot);

    // its row
    let row = await getRow(id);
    const lose = () => { pendingOf.delete(id); skip(c, mem, 'foreign', FOREIGN_RECHECK_MS); };
    if (row && row.owner_device && String(row.owner_device).toLowerCase() !== device) return lose();
    if (row && row.state && row.state !== 'active') { pendingOf.delete(id); return skip(c, mem, 'inactive', SKIP_RECHECK_MS); }
    if (st && !row) { log(`${short(id)}: the server has no row for it any more: uploading it again`); st = null; }
    if (st && row && !st.rowStale && st.files.main && (Number(row.generation) !== st.files.main.generation || Number(row.size) !== st.files.main.offset)) {
      log(`${short(id)}: the server's row and up-state.json disagree: checking the server's chunks`);
      st = null;
    }
    if (!row && !hasWholeLine(c.mainPath) && files.length <= 1) { pendingOf.delete(id); return skip(c, mem, 'empty', SKIP_RECHECK_MS); }
    const freshState = !st;
    if (!st) { st = { files: {}, titleSha: null, meta: null, rowStale: true, deletes: [] }; state.conversations[id] = st; dirty = true; }
    if (!Array.isArray(st.deletes)) st.deletes = [];
    const titleSha = meta.title ? K.sha256(Buffer.from(meta.title, 'utf8')) : null;
    const sealTitle = () => (meta.title ? K.sealText(meta.title, key, `title:${id}`) : null);
    const metaNow = { account: c.account, repo_id: rid, rel_cwd: repo.relCwd, branch: meta.branch || null };
    const rowExisted = !!row;
    if (!row) {
      const made = await api.rest('POST', 'conversations', {
        query: { on_conflict: 'id' }, prefer: 'resolution=ignore-duplicates,return=representation',
        body: { id, ...metaNow, title_enc: sealTitle(), owner_device: device, size: 0, generation: 0 },
      });
      row = Array.isArray(made) && made[0] ? made[0] : await getRow(id);
      if (!row) throw new S.SyncError('Supabase made no conversations row', 0, 'bad_reply');
      if (row.owner_device && String(row.owner_device).toLowerCase() !== device) return lose();
      if (Array.isArray(made) && made[0]) { st.titleSha = titleSha; st.meta = metaNow; }
    } else if (!row.owner_device) {
      const got = await api.rest('PATCH', 'conversations', { query: { id: `eq.${id}`, owner_device: 'is.null' }, body: { owner_device: device }, prefer: 'return=representation' });
      if (!Array.isArray(got) || !got.length) { row = await getRow(id); if (!row || String(row.owner_device || '').toLowerCase() !== device) return lose(); }
      log(`${short(id)}: claimed (it had no owner)`);
    }

    const w = { id, st, rowExisted, listing: null, maxGen: {}, changed: false };
    // a row on the server but no state here (a lost up-state.json, or one that disagreed): one look at the server's
    // chunk rows, so what is already there is taken over and not sent again
    if (rowExisted && freshState) w.listing = await chunkRows(id);
    pendingOf.set(id, 0);
    try {
      for (const f of files) {
        if (stopping) throw new S.SyncError('stopped', 0, 'stopped');
        await syncFile(w, f);
      }
      // rule 4: the row last, and only while it is still ours
      const metaChanged = JSON.stringify(st.meta) !== JSON.stringify(metaNow) || st.titleSha !== titleSha;
      if (st.rowStale || metaChanged) {
        const body = { ...metaNow, updated_at: new Date(now()).toISOString() };
        if (st.titleSha !== titleSha) body.title_enc = sealTitle();
        const m = st.files.main;
        if (m) {
          let fd;
          try {
            fd = fs.openSync(c.mainPath, 'r');
            Object.assign(body, { size: m.offset, sha256: mainHash(id, fd, m.generation, m.offset).hash.copy().digest('hex'), generation: m.generation });
          } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
        }
        const got = await api.rest('PATCH', 'conversations', { query: { id: `eq.${id}`, owner_device: `eq.${device}` }, body, prefer: 'return=representation' });
        if (!Array.isArray(got) || !got.length) { log(`${short(id)}: another device owns it now: stopped uploading it`); return lose(); }
        st.rowStale = false; st.meta = metaNow; st.titleSha = titleSha; dirty = true;
      }
      if (st.deletes.length) await dropOld(w);
    } finally { saveState(true); }
    mem.fails = 0;
    pendingOf.set(id, 0);
    counts.synced++;
  }

  // ---------- the scan ----------
  function listConversations() {
    const byId = new Map();
    for (const { account, dir } of projectsList()) {
      let slugs;
      try { slugs = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const s of slugs) {
        if (!s.isDirectory()) continue;
        const slugDir = path.join(dir, s.name);
        let names;
        try { names = fs.readdirSync(slugDir); } catch { continue; }
        for (const n of names) {
          const m = LOG_ID.exec(n);
          if (!m) continue;
          let fst;
          try { fst = fs.lstatSync(path.join(slugDir, n)); } catch { continue; }
          if (!fst.isFile()) continue;
          const c = { id: m[1].toLowerCase(), name: m[1], account, slugDir, mainPath: path.join(slugDir, n), size: fst.size, mtimeMs: fst.mtimeMs };
          const had = byId.get(c.id);
          if (!had || c.mtimeMs > had.mtimeMs) byId.set(c.id, c); // the same conversation in two folders: the newer copy
        }
      }
    }
    return [...byId.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  async function scan() {
    const t0 = Date.now();
    totals.scans++;
    for (const k of Object.keys(counts)) counts[k] = 0;
    let device;
    try {
      device = await C.ensureDevice(api, dataDir);
      loadState(device);
      try { await C.touchDevice(api, device, { now: now() }); } catch (e) { log(`last_seen_at not set: ${clip(e.message)}`); }
    } catch (e) {
      setError(e);
      log(`no device row: ${clip(e.message)}`);
      return;
    }
    const list = listConversations();
    counts.conversations = list.length;
    const ids = new Set(list.map((c) => c.id));
    for (const id of [...pendingOf.keys()]) if (!ids.has(id)) pendingOf.delete(id);
    for (const c of list) {
      if (stopping) break;
      try { await syncConversation(c, device); } catch (e) {
        if (e && e.code === 'stopped') break;
        setError(e);
        if (e && FATAL.has(e.code)) { log(`scan stopped: ${clip(e.message)}`); break; }
        const mem = memo.get(c.id);
        if (mem) {
          mem.fails++;
          const wait = Math.min(BACKOFF_MS * 2 ** (mem.fails - 1), BACKOFF_MAX_MS);
          mem.backoffUntil = now() + wait;
          log(`${short(c.id)}: failed (${clip(e && e.message)}); trying again in ${Math.round(wait / 1000)} s`);
        }
      }
    }
    counts.pending = [...pendingOf.values()].filter((n) => n > 0).length;
    saveState(true);
    totals.lastScanAt = new Date(now()).toISOString();
    totals.lastScanMs = Date.now() - t0;
  }

  // ---------- the loop ----------
  let running = null, timer = null, started = false;
  function scanOnce() {
    if (running) return running;
    running = scan().catch((e) => { setError(e); log(`scan failed: ${clip(e && e.message)}`); }).finally(() => { running = null; });
    return running;
  }
  function start(intervalMs = INTERVAL_MS) {
    if (started) return;
    started = true;
    stopping = false;
    const every = Number(intervalMs) > 0 ? Number(intervalMs) : INTERVAL_MS;
    const tick = async () => {
      timer = null;
      if (!started) return;
      await scanOnce();
      if (!started) return;
      timer = setTimeout(tick, every);
      if (timer.unref) timer.unref();
    };
    timer = setTimeout(tick, 0);
    if (timer.unref) timer.unref();
  }
  async function stop() {
    started = false;
    if (timer) { clearTimeout(timer); timer = null; }
    stopping = true;
    wake();
    try { if (running) await running; } finally { stopping = false; }
  }
  function status() {
    let pendingBytes = 0;
    for (const n of pendingOf.values()) pendingBytes += n;
    return {
      running: started, scanning: !!running, scans: totals.scans, lastScanAt: totals.lastScanAt, lastScanMs: totals.lastScanMs,
      conversations: counts.conversations, synced: counts.synced, pending: counts.pending, pendingBytes,
      skipped: { noRepo: counts.noRepo, foreign: counts.foreign, inactive: counts.inactive, empty: counts.empty }, backingOff: counts.backingOff,
      uploadedBytes: totals.uploadedBytes, uploadedChunks: totals.uploadedChunks,
      lastError: totals.lastError ? { ...totals.lastError } : null,
    };
  }
  return { scanOnce, start, stop, status };
}

module.exports = { createUploader, repoFor, lastLineEnd, MAX_CHUNK, TAIL_BYTES };
