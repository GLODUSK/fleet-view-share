// sync-up.js: the uploader (the plan's part S2). It keeps this machine's Claude Code conversations in Henry's
// Supabase, sealed, so the materializer (sync-down.js, S3) on another machine can lay them down again byte for byte.
// docs/sync-format.md is the contract, and "The uploader's rules" there are what this file does:
//
//   createUploader({ api, dataDir, key, log, now, projects, home, chunkBytes, rateBytesPerSec, only, accountOf, busy,
//                    ownerOf })
//     -> { scanOnce(), start(intervalMs = 5000), stop(), status(), flush(id), forget(id), hold(id), unhold(id), held(),
//          rescan() }
//
//   status().notSynced lists, per chat, why one did not go up ({ id, cause, why, fix, byDesign, folder, since }: noRepo
//   split into gitUnread, otherPlatform, temp, toolFolder, unnamed, noFolder; and foreign, inactive, empty, held,
//   backingOff), till it does (NOT_SYNCED_CAUSES); notSyncedCount is how many. rescan() asks placement again for all of
//   them now (git afresh, skips and back-offs dropped) and starts a scan.
//
//   api              sync-api.js createSync()'s object (rest() and storage are all it uses)
//   key              the 32-byte sync key (sync-crypto.js loadKey); every byte that leaves goes through it
//   dataDir          Fleet View's data folder; this keeps <dataDir>/sync/up-state.json and device.json there
//   projects         [{ account, dir }] (or a function giving them) to look in; sync-common.js projectsDirs() by
//                    default, which reads ~/.claude and ~/.claude-a. Tests hand it a temp folder.
//   accountOf(id)    optional: the account a conversation ran under ('a', 'b', any case; else null), as fleet-view.js
//                    learnt it from its claude process. The row's account is that when it gives a or b, else the
//                    account of the projects folder its log is in: a folder A shares with B (a junction) is listed
//                    once, as B's, so without it every conversation there would say b.
//   home             the user's home folder (os.homedir() by default): what the home row stands for (step 1 below)
//   temp             the temp folders, whose chats are not synced (tests; the system's by default, sync-common.js)
//   log(text)        one line per thing worth knowing (no title, no transcript text, no token)
//   now()            the clock for back-offs and row times (Date.now by default; tests move it)
//   chunkBytes       plain bytes per chunk, at most 8 MiB (the default)
//   rateBytesPerSec  sealed bytes per second sent to Storage, 4 MB/s by default
//   only(id)         optional: a scan looks only at the conversations this says true for (live tests)
//   busy(id)         optional: true while a turn of it runs here (fleet-view.js: its claude is alive and the turn is
//                    open). Such a one goes up at most every LIVE_GAP_MS (counted 'throttled'); once its turn ends (busy
//                    no more) the next scan sends what is left, and a flush (a move's) never waits.
//   ownerOf(id)      optional: the materializer's owner(id) (sync-down.js): { device, at, checkedAt } | null. A
//                    conversation its rows say another device owns, while its last list is under OWNERS_FRESH_MS old,
//                    is 'foreign' with no request; after forget(id) only a whole list that began later says so. Not
//                    listed, no list, a stale one, or a flush: the row is asked for, as without it.
//
// For S4's moves (sync-move.js), with ids lower-case:
//   flush(id) -> Promise<{ size, sha256, generation, owner_device }>: upload that conversation now. It is urgent: a
//     running scan lets it go next, between two conversations; with no scan it runs at once. Both take the same lock,
//     so one conversation is never sent twice at once. Its back-off and skip are cleared, it is synced, the row is read
//     again (size, sha256 and generation of 'main' as the row now says; owner_device lower-case), and while the log
//     grew meanwhile it goes again (at most 3 more passes). Throws a SyncError when there is no log here ('missing'),
//     no row, another device owns it ('foreign'), it is not synced (step 1: 'noRepo'), or the upload failed.
//   forget(id): its up-state.json entry, back-off, running sha256 and pending count go, so the next pass takes over
//     what the server has (adopt); a pass of it under way stops before its next write ('forgotten'). ownerOf's rows
//     say nothing of it until a whole list that began after (the row is asked for meanwhile).
//   hold(id) / unhold(id) / held() -> ids: a held conversation is never uploaded by a scan (counted 'held'); a scan
//     that reached it before hold() stops before its next write. flush(id) still runs for a held id.
//   Every chunk write checks ownership again when 20 s have passed since the last look: another owner ends the pass
//     with 'lost' (no chunk written after), and the conversation is left alone like any other device's.
//
// One scan (scanOnce): this machine's devices row (sync-common.js ensureDevice); every conversation in every projects
// folder, newest log first, one at a time. For each one whose files changed since the last scan:
//   1. Where it belongs, by the folder its log lives in (else its last cwd): a git checkout with an origin on a host
//      holding it gives that repo's row. A cwd that is gone (a removed worktree) counts by the nearest folder above it
//      that is still there, as long as the checkout found holds the cwd; a removed worktree whose folder stayed (a
//      .git file naming a gitdir that is gone, sync-common.js staleGitFile) counts by the checkout around it. When no checkout with an origin holds it but
//      the folder is under the home folder, it goes under the home row (sync-common.js HOME_ORIGIN) with rel_cwd
//      relative to home, as it always has (a checkout with no origin, a Perforce workspace and home itself too, which
//      /state calls bound: sync-common.js "portable or bound"). Outside home, or in an app data or Claude account
//      folder (homeSkipped), which were never synced before, it goes under this device's bound row ('bound:<device
//      id>', sync-common.js boundOrigin) with rel_cwd the folder's full path here (boundRel). A placeholder (another
//      machine's bound chat laid down here, then resumed here) is bound to this device whatever holds it. In the temp
//      folder, a Claude account's own folder or Fleet View's data folder (a tool's chats), under a .git git could not
//      read (it waits for git), or a path of the other platform (a copy laid down here and not resumed here): not
//      synced.
//   2. The repos row for that origin and this device's repo_paths row (the main checkout's folder, or the home
//      folder for the home row; none for a bound row) are made when missing.
//   3. The conversations row: made with owner_device = this device when there is none; one with no owner is claimed;
//      one another device owns is left alone (S4 moves owners), and so is one that is not 'active'.
//   4. Each file (sync-common.js conversationFiles: main, subagents/, tool-results/, workflows/):
//        append-only (main, *.jsonl) that grew and whose last 4 KiB before the uploaded end are unchanged: the new
//          bytes up to the last '\n' go up as the next chunk(s) of the same generation, a row after each object;
//        one that shrank or whose tail changed, or a whole file whose bytes changed: generation + 1 from byte 0,
//          every object first, then all its chunk rows in one insert (so a reader sees all of it or none of it);
//        a first upload is generation 0, chunk by chunk.
//   5. The conversations row (size, sha256 and generation of 'main', updated_at, and the account, cwd, branch and
//      sealed title) only after the chunk rows, and only while this device still owns it. A settled conversation whose
//      account changed (accountOf learnt it) gets just that: a PATCH of the meta with no updated_at, size or sha256,
//      so its log is not read again and the other devices do not lay it down again.
//   6. Old generations: their chunk rows, then their objects, once the row points at the new one.
// Order, always: object, then its chunk row, then the conversation row. Objects are written with upsert and chunk
// rows with merge-duplicates, so a pass cut short (a crash between an object and up-state.json) is simply done again.
//
// up-state.json: { v: 1, device, conversations: { <id>: { files: { <file key>: { generation, seq, offset, tailSha,
// size, mtimeMs, sha? } }, titleSha, meta, rowStale, deletes } } }. offset is the uploaded end, tailSha the sha256 of
// the up to 4096 bytes before it; size and mtimeMs are what the file was when last looked at (unchanged: no read at
// all); sha is a whole file's sha256. It moves only after the server has what it says. When it is missing or does
// not match the server (another install, a lost file), the server's chunk rows are checked against the local bytes
// and taken over when they match, so nothing is sent twice; when they don't, the file starts a new generation. It is
// written compact, once at the end of each scan (and after flush, forget and stop), so a crash loses at most that
// scan's progress: the server is then ahead of it, which the take-over above and trimTail (rows past the next seq
// go before an append) make safe.
//
// A failure on one conversation (a 4xx: bad data, a row the server refuses) is logged and that conversation waits
// (30 s, doubling, at most 30 min) while the scan goes on. A network error, a timeout, a 429 or a 5xx is not the
// conversation's fault: it ends the scan, and the next one waits (the scan-level back-off, sync-api.js
// createScanHealth: 5 s doubling to 60 s, or Supabase's Retry-After up to 5 min), reset by a scan that runs to its end.
// A signed-out account ends the scan too. status().lastError is cleared by a clean scan (no error on any row), and
// status().health says when the last scan ran to its end, the last error and its time, the failure streak and whether
// it is backing off (sync-run.js health() colours the pill from it). Nothing here starts a process; the only timer is
// start()'s.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const util = require('util');
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
const OWNERS_FRESH_MS = 60e3; // the materializer's rows (ownerOf) answer "whose is it" while its last list is this recent
const LIVE_GAP_MS = 45e3; // a conversation mid-turn (busy) goes up at most this often; its turn's end sends it at once
const SKIP_RECHECK_MS = 10 * 60e3; // one with no repo, the same
const IDLE_MS = 60 * 60e3; // a conversation whose log is older than this has its side files listed at most...
const IDLE_LIST_MS = 60e3; // ...this often (a background subagent can still write while the log sleeps)
const OLD_MS = 24 * 60 * 60e3, OLD_LIST_MS = 15 * 60e3; // and one older than a day this often (there are thousands)
// the scan gives the event loop back at least this often, so the server answers between its reads (Henry, 2026-10-16:
// a take-over of every conversation held it up to 17 s at a time, "fleet view server isnt working")
const BREATH_MS = 20;
const PAGE = 1000; // chunk rows per GET
const REMOVE_MAX = 1000; // storage.remove takes at most this many paths
const HASHES_KEPT = 200; // running sha256s of 'main' kept in memory, so an append does not read the log again
const READ_BLOCK = 64 * 1024;
const LOG_ID = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const FATAL = new Set(['signed_out', 'off', 'bad_key']); // these end a scan: every other conversation would fail too
const STUCK_ENDS = 3; // a conversation whose transient error ended this many scans in a row backs off alone
const OWNER_RECHECK_MS = 20e3; // a write asks whose the conversation is again when this long passed since the last look
const FLUSH_REPEATS = 3; // flush goes again at most this often while the log keeps growing
const FLUSH_COLS = 'id,owner_device,generation,size,sha256,state';
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// what a pass that sent nothing ends with -> the SyncError flush throws
const NOT_SYNCED = {
  foreign: 'another device owns this conversation',
  noRepo: 'this conversation is not synced: its folder is another machine\'s path here, the temp folder, a Claude account\'s or Fleet View\'s own folder, or in a checkout git could not read yet',
  inactive: 'this conversation is not active on the server',
  empty: 'this conversation has no whole line yet',
  held: 'this conversation is held',
  forgotten: 'this conversation was forgotten while it went up',
  backingOff: 'this conversation is backing off',
};
// Why one conversation is not synced, per chat (status().notSynced: /sync/activity and the Sync card's "Not synced"
// list): noRepo split into its causes, and the other skips. why says what it means, fix what to do (null: nothing),
// byDesign the ones that are meant not to go up from here (the card counts them in one line).
const NOT_SYNCED_CAUSES = {
  gitUnread: { why: 'its folder is in a git checkout git could not read', fix: 'check that git works in that folder (git status there); it goes up by itself once git reads it', byDesign: false },
  otherPlatform: { why: 'its folder is the other machine\'s path (a copy laid down here, not resumed here)', fix: 'resume it here once, or keep using it on the machine it came from', byDesign: false },
  noFolder: { why: 'its log names no folder yet', fix: null, byDesign: false },
  unnamed: { why: 'its folder\'s path can\'t be synced (too long)', fix: 'start the chat in a folder with a shorter path', byDesign: false },
  backingOff: { why: 'its last upload failed', fix: 'it tries again by itself; the uploads\' last error says why', byDesign: false },
  temp: { why: 'it runs in the temp folder, where only throwaway chats run', fix: null, byDesign: true },
  toolFolder: { why: 'it runs in a Claude account\'s or Fleet View\'s own folder (a tool\'s chat)', fix: null, byDesign: true },
  foreign: { why: 'another machine owns it', fix: null, byDesign: true },
  inactive: { why: 'the server has it as not active', fix: null, byDesign: true },
  empty: { why: 'it has no whole line yet', fix: null, byDesign: true },
  held: { why: 'it is held here (set aside, or mid-move)', fix: null, byDesign: true },
};
const NOT_SYNCED_MAX = 200; // status().notSynced: the newest causes first, at most this many (notSyncedCount: all)

const clip = (s, n = 200) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
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
// The big reads (whole files, chunks) and the opens (thousands of small side files, slow under an antivirus) go to the
// thread pool, not the event loop; breathe() hands the loop back between pieces of work once BREATH_MS has gone by
const openAsync = util.promisify(fs.open), closeAsync = util.promisify(fs.close), readAsync = util.promisify(fs.read);
let breathAt = 0;
async function breathe() {
  if (Date.now() - breathAt < BREATH_MS) return;
  await new Promise((r) => setImmediate(r));
  breathAt = Date.now();
}
async function readExactAsync(fd, pos, len) {
  const buf = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const { bytesRead } = await readAsync(fd, buf, got, len - got, pos + got);
    if (!bytesRead) throw new S.SyncError('the file got shorter while it was read', 0, 'changed');
    got += bytesRead;
  }
  return buf;
}
// sha256 of [0, end)
async function hashRange(fd, end) {
  const h = crypto.createHash('sha256');
  for (let pos = 0; pos < end; pos += MAX_CHUNK) {
    h.update(await readExactAsync(fd, pos, Math.min(MAX_CHUNK, end - pos)));
    await breathe();
  }
  return h;
}

// ---------- where a conversation belongs ----------
// A log's cwd -> { origin, mainRoot, relCwd } | null. rel_cwd is relative to the main checkout (a worktree under
// <root>/.claude/worktrees keeps that path), or to the worktree's own top when it lives outside the main checkout.
function inside(base, p) {
  const rel = path.relative(base, p);
  if (rel === '') return '';
  if (rel.split(path.sep)[0] === '..' || path.isAbsolute(rel)) return null; // a folder named '..x' is still inside
  return rel.split(path.sep).join('/');
}
// a path from another platform (a Mac log on Windows, or the other way) is not a folder here
const ownPath = (cwd) => typeof cwd === 'string' && !!cwd && (P.isWin ? /^(?:[A-Za-z]:[\\/]|\\\\)/.test(cwd) : cwd.startsWith('/'));
async function repoFor(cwd) {
  if (!ownPath(cwd)) return null;
  const want = path.resolve(cwd);
  // the nearest folder still there; a removed worktree whose folder stayed (its .git names a gitdir that is gone)
  // counts by the checkout around it, as one whose folder is gone does (sync-common.js staleGitFile)
  const dir = C.pastStaleGit(want);
  if (!dir) return null;
  const r = await C.repoOf(dir);
  if (!r || !r.origin) return null;
  let relCwd = inside(r.mainRoot, want);
  if (relCwd === null) relCwd = inside(r.root, want);
  if (relCwd === null) return null;
  return { origin: r.origin, mainRoot: r.mainRoot, relCwd };
}
// The fallback when no repo with an origin holds a cwd: under the home folder -> the home row's { origin, mainRoot:
// home, relCwd } (relative to home, '' for home itself); outside it -> null. The folder need not still be there: the
// other machine makes it when it lays the conversation down. Not under the app data folders or a Claude account's
// folder (sync-common.js homeSkipped): a chat a tool started there would only make that folder on the other machine.
function homeFor(cwd, home) {
  if (!ownPath(cwd) || typeof home !== 'string' || !home) return null;
  const root = path.resolve(home);
  const relCwd = inside(root, path.resolve(cwd));
  if (relCwd === null || C.homeSkipped(relCwd)) return null;
  return { origin: C.HOME_ORIGIN, mainRoot: root, relCwd };
}
// A bound conversation (sync-common.js workspaceKind): this device's bound row, 'bound:<device id>', with rel_cwd the
// folder's full path here ('/' between folders, sync-common.js boundRel). No repo_paths row: no other device has it.
function boundFor(cwd, device) {
  const relCwd = C.boundRel(cwd);
  return relCwd ? { origin: C.boundOrigin(device), mainRoot: null, relCwd, bound: true } : null;
}
// (A git checkout git could not read, a .git with repoOf giving nothing for it, holds a conversation that waits for git
// rather than go under the home row or a bound one: sync-common.js gitUnreadAt.)

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
  const userHome = typeof opts.home === 'string' && opts.home ? opts.home : os.homedir();
  const tempOpt = Array.isArray(opts.temp) ? opts.temp : undefined; // the temp folders (tests); the system's otherwise
  // never a bound row either, as never synced before: a Claude account's own folder (~/.claude-<letter>: a sign-in's
  // or a tool's chat) and Fleet View's data folder (its own); other app data folders' chats (the Claude app's
  // scratchpads) are a person's, and go up bound
  const ownData = [dataDir, P.dataDir()].filter(Boolean).map((d) => path.resolve(d));
  const toolFolder = (cwd) => {
    const rel = inside(path.resolve(userHome), path.resolve(cwd));
    if (rel !== null && /^\.claude-[a-z]$/i.test(rel.split('/')[0])) return true;
    return ownData.some((d) => inside(d, path.resolve(cwd)) !== null);
  };
  const projectsList = () => {
    const p = opts.projects;
    if (typeof p === 'function') return C.projectsDirs({ dirs: p() });
    if (Array.isArray(p)) return C.projectsDirs({ dirs: p });
    return C.projectsDirs(p && typeof p === 'object' ? p : { home: userHome });
  };
  // the account its row names: accountOf's when that is a or b, else its projects folder's
  const accountOfRow = (c) => {
    let a = null;
    try { a = typeof opts.accountOf === 'function' ? opts.accountOf(c.id) : null; } catch {}
    a = typeof a === 'string' ? a.toLowerCase() : null;
    return a === 'a' || a === 'b' ? a : c.account;
  };
  // mid-turn here (opts.busy): it goes up at most every LIVE_GAP_MS
  const isBusy = (id) => { try { return typeof opts.busy === 'function' && opts.busy(id) === true; } catch { return false; } };
  // Another device owns it, as the materializer's rows say (opts.ownerOf, sync-down.js owner()): only while its last list
  // is under OWNERS_FRESH_MS old, and, for one forget() let go of (this device took it over: a list of the changed rows
  // never shows a row coming to this device), only by a whole list that began after the forget. Else (no list, not
  // listed, stale): not known, and the row is asked for as before.
  const forgotAt = new Map(); // id -> when forget() ran (this clock)
  function listedForeign(id, device) {
    if (typeof opts.ownerOf !== 'function') return false;
    let o = null;
    try { o = opts.ownerOf(id); } catch {}
    const d = o && typeof o.device === 'string' ? o.device.toLowerCase() : null;
    if (!d || d === String(device).toLowerCase()) return false;
    const t = now();
    if (!Number.isFinite(o.checkedAt) || t - o.checkedAt > OWNERS_FRESH_MS || t < o.checkedAt) return false;
    const f = forgotAt.get(id);
    return f === undefined || (Number.isFinite(o.at) && o.at > f);
  }

  // ---------- memory ----------
  let state = null; // up-state.json as loaded
  let dirty = false;
  const memo = new Map(); // id -> { fails, backoffUntil, skip: { sig, until, why }, listedAt }
  const pendingOf = new Map(); // id -> bytes still to go up
  const hashes = new Map(); // id -> { generation, offset, hash }: the running sha256 of 'main' (oldest first)
  const repoIds = new Map(); // origin -> repos.id
  const repoPathsDone = new Set(); // `${device}|${repoId}|${root}` written in this process
  const skipLogged = new Set();
  const notSynced = new Map(); // id -> { cause (NOT_SYNCED_CAUSES), folder, since }: why it did not go up, till it does
  const noteWhy = (id, cause, folder) => {
    const was = notSynced.get(id);
    if (was && was.cause === cause) { if (folder) was.folder = folder; return; }
    const k = NOT_SYNCED_CAUSES[cause];
    if (k && !k.byDesign && cause !== 'backingOff') log(`${short(id)}: not synced: ${k.why}${folder ? ` (${folder})` : ''}`); // (a failure logs itself)
    notSynced.set(id, { cause, folder: folder || (was && was.folder) || null, since: now() });
  };
  const holds = new Set(); // ids no scan uploads (hold/unhold)
  const epochs = new Map(); // id -> how often it was forgotten: a pass that began before a forget() writes nothing more
  const counts = { conversations: 0, synced: 0, pending: 0, noRepo: 0, foreign: 0, inactive: 0, empty: 0, held: 0, backingOff: 0, throttled: 0 };
  const totals = { scans: 0, uploadedBytes: 0, uploadedChunks: 0, lastScanAt: null, lastScanMs: null, lastError: null };

  function loadState(device) {
    if (state && state.device === device) return;
    const s = C.readState(statePath, null);
    if (s && s.v === 1 && s.device === device && s.conversations && typeof s.conversations === 'object') state = s;
    else {
      // (a file there that can't be read is damaged too: a crash can leave it empty or full of NULs)
      if (s || fs.existsSync(statePath)) log('up-state.json is from another device or damaged: starting again from what the server has');
      state = { v: 1, device, conversations: {} };
      trimmed.clear();
      dirty = true;
    }
  }
  // once a scan (at its end), and after a flush, a forget and a stop: never per conversation or chunk (it is MBs).
  // A crash loses at most one scan's progress, which is safe: the server is then ahead of the file, a pass takes over
  // what the row and the chunk rows say (adopt), and an append first drops the rows past where the file says (trimTail).
  // Flushed to the disk before its rename (sync): a power cut right after once left it unreadable, and every
  // conversation was taken over again from the server (thousands of files read and hashed: 2026-10-16)
  function saveState() {
    if (!dirty || !state) return;
    try { C.writeState(statePath, state, { compact: true, sync: true }); dirty = false; } catch (e) { log(`up-state.json could not be saved: ${clip(e.message)}`); }
  }
  const setError = (e) => { totals.lastError = { at: new Date(now()).toISOString(), message: clip(e && e.message ? e.message : e) }; };
  const health = S.createScanHealth({ now }); // the scan-level back-off and what /sync/activity says of this loop
  const scanFailed = (e) => {
    const wait = health.failed(e);
    if (wait) log(`scan stopped (${clip(e && e.message)}): the next one in ${Math.round(wait / 1000)} s`);
  };

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

  // ---------- one conversation at a time ----------
  // The scan takes this lock for each conversation and flush() for its whole run, so no two passes ever upload at once.
  // An urgent waiter (flush) goes ahead of the scan's next conversation, behind any earlier urgent one.
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
  async function getRow(id, cols = ROW_COLS) {
    const rows = await api.rest('GET', 'conversations', { query: { select: cols, id: `eq.${id}` } });
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  }
  const ownerOf = (row) => (row && row.owner_device ? String(row.owner_device).toLowerCase() : null);
  // Before every write of a pass: not stopping, not forgotten since the pass began, not held (unless flush runs it),
  // and (owner: true, at most every 20 s) still this device's on the server. Throws a SyncError: 'stopped',
  // 'forgotten', 'held' or 'lost'.
  async function guard(w, owner = true) {
    const check = () => {
      if (stopping) throw new S.SyncError('stopped', 0, 'stopped');
      if ((epochs.get(w.id) || 0) !== w.epoch) throw new S.SyncError(NOT_SYNCED.forgotten, 0, 'forgotten');
      if (!w.urgent && holds.has(w.id)) throw new S.SyncError(NOT_SYNCED.held, 0, 'held');
    };
    check();
    if (!owner || now() - w.mem.ownerAt < OWNER_RECHECK_MS) return;
    const row = await getRow(w.id);
    w.mem.ownerAt = now();
    if (ownerOf(row) !== w.device) throw new S.SyncError(row ? 'another device owns it now' : 'its row is gone', 0, 'lost');
    check();
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
  // A crash after chunk rows went up but before up-state.json was saved leaves rows past the seq the file says comes
  // next: that seq sent again covers a longer range, and the old next one would stay behind it (a gap for a reader of
  // a side .jsonl, for ever). So before the first append to a file's generation in this process, the rows from that
  // seq on go, then their objects. Once a file moved in this process its state is the server's: never asked again.
  const trimmed = new Set(); // `${id}|${file}|${generation}` with no rows past what the state says
  async function trimTail(w, file, generation, seq) {
    const k = `${w.id}|${file}|${generation}`;
    if (trimmed.has(k)) return;
    const filter = { file: `eq.${file}`, generation: `eq.${generation}`, seq: `gte.${seq}` };
    const extra = await chunkRows(w.id, filter);
    if (extra.length) {
      await guard(w);
      await api.rest('DELETE', 'chunks', { query: { conversation_id: `eq.${w.id}`, ...filter }, prefer: 'return=minimal' });
      const paths = extra.map((r) => r.object_path).filter((p) => typeof p === 'string' && p);
      for (let i = 0; i < paths.length; i += REMOVE_MAX) await api.storage.remove(paths.slice(i, i + REMOVE_MAX));
      log(`${short(w.id)} ${file}: dropped ${extra.length} chunk row(s) from seq ${seq} on, left by a pass cut short`);
    }
    trimmed.add(k);
  }
  const untrim = (id) => { for (const k of trimmed) if (k.startsWith(`${id}|`)) trimmed.delete(k); };

  // ---------- the running sha256 of 'main' ----------
  async function mainHash(id, fd, generation, offset) {
    const h = hashes.get(id);
    if (h && h.generation === generation && h.offset === offset) { hashes.delete(id); hashes.set(id, h); return h; }
    const nh = { generation, offset, hash: await hashRange(fd, offset) };
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
  // guard() runs before every object and every row: a pass that lost the conversation, was held or forgotten stops.
  async function send(w, f, fd, { generation, seq, from, end, batch, done }) {
    const rows = [];
    let pos = from;
    do {
      await guard(w);
      const len = Math.min(chunkBytes, end - pos);
      const buf = await readExactAsync(fd, pos, len);
      const objectPath = C.objectPath(w.id, f.fileKey, generation, seq);
      const sealed = K.sealChunk(buf, key, objectPath);
      await pace(sealed.length);
      await guard(w);
      await api.storage.upload(objectPath, sealed, { upsert: true });
      totals.uploadedBytes += sealed.length;
      totals.uploadedChunks++;
      const row = { conversation_id: w.id, file: f.fileKey, generation, seq, byte_offset: pos, byte_length: len, object_path: objectPath, sha256: K.sha256(buf) };
      if (batch) rows.push({ row, buf });
      else { await guard(w); await postChunks([row]); done(row, buf); }
      pos += len;
      seq++;
    } while (pos < end);
    return rows;
  }

  // The server's rows for a file with no state here: taken over when its newest generation runs from byte 0 with no
  // gap and every chunk's sha256 matches the local bytes. -> a file state, or null (then maxGen says where to go on).
  // What it took over is counted in w.took, said once for the conversation (a line a file was thousands of lines)
  async function adopt(w, f, fd, size) {
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
      const buf = await readExactAsync(fd, o, l);
      if (K.sha256(buf) !== r.sha256) return null;
      h.update(buf);
      off += l;
      await breathe();
    }
    if (!f.appendOnly && off !== size) return null;
    if (f.appendOnly && off > 0 && readExact(fd, off - 1, 1)[0] !== 10) return null;
    if (mine.some((r) => Number(r.generation) !== gen)) w.st.deletes.push({ file: f.fileKey, below: gen });
    const fst = { generation: gen, seq: rows.length, offset: off, tailSha: tailShaAt(fd, off), size: -1, mtimeMs: -1 };
    if (!f.appendOnly) fst.sha = h.copy().digest('hex');
    trimmed.add(`${w.id}|${f.fileKey}|${gen}`); // every row of its newest generation, taken over
    if (f.fileKey === 'main') keepHash(w.id, { generation: gen, offset: off, hash: h });
    w.took.files++;
    w.took.chunks += rows.length;
    return fst;
  }

  // One file of a conversation: what changed goes up, and w.st.files[key] moves with the server.
  async function syncFile(w, f) {
    const files = w.st.files;
    let fst = files[f.fileKey] || null;
    if (fst && fst.size === f.size && fst.mtimeMs === f.mtimeMs) return;
    let fd;
    try { fd = await openAsync(f.path, 'r'); } catch { return; } // gone since it was listed
    try {
      const st = fs.fstatSync(fd);
      const size = st.size, mtimeMs = st.mtimeMs;
      if (!fst && w.listing) fst = await adopt(w, f, fd, size);
      const commit = (o) => { files[f.fileKey] = { ...o, size, mtimeMs }; trimmed.add(`${w.id}|${f.fileKey}|${o.generation}`); w.changed = true; dirty = true; };
      if (f.appendOnly && fst && size >= fst.offset && tailShaAt(fd, fst.offset) === fst.tailSha) {
        // rule 2: it grew (or not), the bytes we have are still there: append whole lines
        const end = lastLineEnd(fd, fst.offset, size);
        if (end > fst.offset) {
          await trimTail(w, f.fileKey, fst.generation, fst.seq);
          pendingOf.set(w.id, (pendingOf.get(w.id) || 0) + end - fst.offset);
          const isMain = f.fileKey === 'main';
          const h = isMain ? await mainHash(w.id, fd, fst.generation, fst.offset) : null;
          let cur = { ...fst };
          await send(w, f, fd, { generation: fst.generation, seq: fst.seq, from: fst.offset, end, done: (row, buf) => {
            cur = { generation: cur.generation, seq: row.seq + 1, offset: row.byte_offset + row.byte_length, tailSha: null };
            if (h) { h.hash.update(buf); h.offset = cur.offset; }
            files[f.fileKey] = { ...cur, tailSha: tailShaAt(fd, cur.offset), size: -1, mtimeMs: -1 }; // -1: look again next time
            w.st.rowStale = true; w.changed = true; dirty = true;
          } });
          cur.tailSha = tailShaAt(fd, cur.offset);
          commit(cur);
        } else commit(fst);
        return;
      }
      // a whole file: unchanged bytes (only the time moved) need nothing
      let sha = null;
      if (!f.appendOnly) {
        sha = (await hashRange(fd, size)).digest('hex');
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
        await guard(w);
        await postChunks(rows.map((r) => r.row));
      }
      const fstNew = { generation: gen, seq: rows.length, offset: end, tailSha: tailShaAt(fd, end) };
      if (!f.appendOnly) fstNew.sha = sha;
      if (isMain) keepHash(w.id, { generation: gen, offset: end, hash: h });
      commit(fstNew);
      w.st.rowStale = true;
      if (gen > 0) w.st.deletes.push({ file: f.fileKey, below: gen });
      if (fst || gen > 0) log(`${short(w.id)} ${f.fileKey}: generation ${gen} (${fst ? 'the file was rewritten' : 'what the server had did not match'})`);
    } finally { try { await closeAsync(fd); } catch {} }
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

  // (cause: noRepo's, NOT_SYNCED_CAUSES; folder: where it runs, for status().notSynced)
  function skip(c, mem, why, ms, tally, cause = why, folder = null) {
    mem.skip = { sig: `${c.size}:${c.mtimeMs}`, until: now() + ms, why };
    tally[why]++;
    noteWhy(c.id, cause, folder);
    return why;
  }

  // ---------- one conversation ----------
  // -> 'synced' | 'backingOff' | 'noRepo' | 'foreign' | 'inactive' | 'empty' | 'held' | 'forgotten' | 'throttled';
  // throws when an upload failed. how: { urgent (flush: a hold or the busy wait does not stop it), tally (the counts) }
  async function syncConversation(c, device, how = {}) {
    const id = c.id, t = now();
    const tally = how.tally || counts;
    const epoch = epochs.get(id) || 0;
    let mem = memo.get(id);
    if (!mem) { mem = { fails: 0, backoffUntil: 0, skip: null, listedAt: 0, ownerAt: 0 }; memo.set(id, mem); }
    if (mem.backoffUntil > t) { tally.backingOff++; return 'backingOff'; }
    if (mem.skip && mem.skip.sig === `${c.size}:${c.mtimeMs}` && mem.skip.until > t) { tally[mem.skip.why]++; return mem.skip.why; }
    mem.skip = null;
    // another device's, as the materializer's rows say: nothing asked (a flush always asks)
    if (!how.urgent && listedForeign(id, device)) { pendingOf.delete(id); return skip(c, mem, 'foreign', FOREIGN_RECHECK_MS, tally); }
    let st = state.conversations[id] || null;
    if (st && (!st.files || typeof st.files !== 'object')) st = null;
    const account = accountOfRow(c);
    // settled: the row has it all, the account too (one accountOf learnt since goes up even while the log sleeps)
    const settled = st && !st.rowStale && !(st.deletes && st.deletes.length) && !!st.meta && st.meta.account === account;
    // cheap: an idle conversation whose log is as it was is listed again only now and then, one asleep a day rarer still
    const main0 = st && st.files && st.files.main;
    const idle = Date.now() - c.mtimeMs;
    if (settled && main0 && main0.size === c.size && main0.mtimeMs === c.mtimeMs && idle > IDLE_MS && t - mem.listedAt < (idle > OLD_MS ? OLD_LIST_MS : IDLE_LIST_MS)) {
      tally.synced++; return 'synced';
    }
    const files = await C.conversationFilesAsync(c.slugDir, c.name, { onSkip: (p, why) => {
      if (skipLogged.has(p)) return;
      skipLogged.add(p);
      log(`${short(id)}: not synced: ${path.basename(p)} (${why})`);
    } });
    mem.listedAt = t;
    if (settled && files.every((f) => { const s = st.files[f.fileKey]; return s && s.size === f.size && s.mtimeMs === f.mtimeMs; })) {
      pendingOf.set(id, 0);
      tally.synced++;
      return 'synced';
    }
    // mid-turn and sent less than LIVE_GAP_MS ago: it waits (a flush, a move's, never does; the turn's end sends it)
    if (!how.urgent && mem.sentAt && t - mem.sentAt < LIVE_GAP_MS && t >= mem.sentAt && isBusy(id)) { tally.throttled++; return 'throttled'; }

    // where it belongs: the folder its log lives in (it resumes there), else its last cwd when that folder is in no repo
    const meta = C.lastMeta(c.mainPath);
    const startCwd = C.homeCwd(c.mainPath, meta.cwd);
    const where = startCwd || meta.cwd;
    // another machine's bound chat laid down here, and resumed here: bound, to this device now (whatever holds it)
    let repo = ownPath(where) && C.isBoundPlaceholder(where, userHome) ? boundFor(where, device) : null;
    if (!repo && startCwd) repo = await repoFor(startCwd);
    if (!repo && meta.cwd && meta.cwd !== startCwd) repo = await repoFor(meta.cwd);
    // no repo with an origin holds either: by the folder it started in, the home row under home, as always (a repo
    // checkout under home has its own row and was found above; one with no origin, a Perforce workspace and home
    // itself are the home row's too, though /state calls them bound); else (outside home, or an app data or Claude
    // account folder, which were never synced before) this device's bound row. Never one in the temp folder, nor one
    // under a .git git could not read (it waits for git).
    let cause = null; // why none (NOT_SYNCED_CAUSES), for status().notSynced
    if (!repo && ownPath(where)) {
      const h = homeFor(where, userHome);
      if (h) { if (!(await C.gitUnreadAt(where, h.mainRoot))) repo = h; else cause = 'gitUnread'; }
      else if (C.inTemp(where, { home: userHome, temp: tempOpt })) cause = 'temp';
      else if (toolFolder(where)) cause = 'toolFolder';
      else if (await C.gitUnreadAt(where)) cause = 'gitUnread';
      else repo = boundFor(where, device);
    }
    if (repo && repo.bound && (!repo.relCwd || repo.relCwd.length > 1024)) { repo = null; cause = 'unnamed'; }
    // none, and its last cwd is another machine's path (a log laid down here by a move and not prompted here yet: its
    // lines still name that machine's folders), or a flush asks: a row this device owns goes up under its own repo_id
    // and rel_cwd, so a chat moved here can always be handed back
    let row = null;
    if (!repo && (!ownPath(where) || how.urgent)) {
      row = await getRow(id, `${ROW_COLS},repo_id,rel_cwd`);
      mem.ownerAt = now();
      if (row && ownerOf(row) && ownerOf(row) !== device) { pendingOf.delete(id); return skip(c, mem, 'foreign', FOREIGN_RECHECK_MS, tally); }
      if (row && ownerOf(row) === device && row.repo_id && typeof row.rel_cwd === 'string') repo = { rid: String(row.repo_id).toLowerCase(), mainRoot: null, relCwd: row.rel_cwd, fromRow: true };
      else row = null;
    }
    if (!repo) {
      pendingOf.delete(id);
      return skip(c, mem, 'noRepo', SKIP_RECHECK_MS, tally, cause || (!where ? 'noFolder' : !ownPath(where) ? 'otherPlatform' : 'unnamed'), where || null);
    }
    const rid = repo.fromRow ? repo.rid : await repoId(repo.origin);

    // its row
    if (!row) row = await getRow(id);
    mem.ownerAt = now();
    const lose = () => { pendingOf.delete(id); return skip(c, mem, 'foreign', FOREIGN_RECHECK_MS, tally); };
    // forgotten or held while the row was fetched: nothing written yet, nothing will be
    if ((epochs.get(id) || 0) !== epoch) { tally.held++; return 'forgotten'; }
    if (!how.urgent && holds.has(id)) { tally.held++; noteWhy(id, 'held', where); return 'held'; }
    if (row && row.owner_device && String(row.owner_device).toLowerCase() !== device) return lose();
    if (row && row.state && row.state !== 'active') { pendingOf.delete(id); return skip(c, mem, 'inactive', SKIP_RECHECK_MS, tally); }
    if (st && !row) { log(`${short(id)}: the server has no row for it any more: uploading it again`); st = null; }
    // up-state.json must not be behind the server: a settled entry must match the row exactly, and one mid-upload
    // (rowStale) may be ahead of the row but never behind it (then another device wrote: what the server has is
    // checked and taken over, so no seq number is written twice with other bytes)
    const m0 = st && st.files.main;
    if (st && row && m0 && (st.rowStale
      ? Number(row.generation) > m0.generation || (Number(row.generation) === m0.generation && Number(row.size) > m0.offset)
      : Number(row.generation) !== m0.generation || Number(row.size) !== m0.offset)) {
      log(`${short(id)}: the server's row and up-state.json disagree: checking the server's chunks`);
      st = null;
    }
    if (!row && !hasWholeLine(c.mainPath) && files.length <= 1) { pendingOf.delete(id); return skip(c, mem, 'empty', SKIP_RECHECK_MS, tally); }
    const freshState = !st;
    if (!st) { st = { files: {}, titleSha: null, meta: null, rowStale: true, deletes: [] }; state.conversations[id] = st; dirty = true; }
    if (!Array.isArray(st.deletes)) st.deletes = [];
    const titleSha = meta.title ? K.sha256(Buffer.from(meta.title, 'utf8')) : null;
    const sealTitle = () => (meta.title ? K.sealText(meta.title, key, `title:${id}`) : null);
    const metaNow = { account, repo_id: rid, rel_cwd: repo.relCwd, branch: meta.branch || null };
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

    // this device's checkout of the repo, only once the conversation is this device's: a copy laid down here from
    // another device names that device's folders, which must not become this device's repo_paths row
    if (!repo.bound && !repo.fromRow) await repoPath(device, rid, repo.mainRoot);
    const w = { id, st, rowExisted, listing: null, maxGen: {}, changed: false, device, mem, epoch, urgent: !!how.urgent, took: { files: 0, chunks: 0 } };
    // a row on the server but no state here (a lost up-state.json, or one that disagreed): one look at the server's
    // chunk rows, so what is already there is taken over and not sent again
    if (rowExisted && freshState) w.listing = await chunkRows(id);
    pendingOf.set(id, 0);
    try {
      for (const f of files) {
        if (stopping) throw new S.SyncError('stopped', 0, 'stopped');
        await breathe();
        await syncFile(w, f);
      }
      if (w.took.files) log(`${short(id)}: took over ${w.took.files} file(s), ${w.took.chunks} chunk(s), already on the server`);
      await guard(w, false);
      // rule 4: the row last, and only while it is still ours
      const metaChanged = JSON.stringify(st.meta) !== JSON.stringify(metaNow) || st.titleSha !== titleSha;
      // only the account moved: the meta alone (no updated_at: the other devices have its bytes already)
      const onlyAccount = !st.rowStale && st.titleSha === titleSha && !!st.meta && JSON.stringify({ ...st.meta, account }) === JSON.stringify(metaNow);
      if (st.rowStale || metaChanged) {
        const body = onlyAccount ? { ...metaNow } : { ...metaNow, updated_at: new Date(now()).toISOString() };
        if (st.titleSha !== titleSha) body.title_enc = sealTitle();
        const m = onlyAccount ? null : st.files.main;
        if (m) {
          let fd;
          try {
            fd = await openAsync(c.mainPath, 'r');
            Object.assign(body, { size: m.offset, sha256: (await mainHash(id, fd, m.generation, m.offset)).hash.copy().digest('hex'), generation: m.generation });
          } finally { if (fd !== undefined) try { await closeAsync(fd); } catch {} }
        }
        const got = await api.rest('PATCH', 'conversations', { query: { id: `eq.${id}`, owner_device: `eq.${device}` }, body, prefer: 'return=representation' });
        if (!Array.isArray(got) || !got.length) { log(`${short(id)}: another device owns it now: stopped uploading it`); return lose(); }
        st.rowStale = false; st.meta = metaNow; st.titleSha = titleSha; dirty = true;
      }
      if (st.deletes.length) await dropOld(w);
    } catch (e) {
      const code = e && e.code;
      if (code === 'lost') { log(`${short(id)}: another device owns it now: stopped uploading it`); return lose(); }
      if (code === 'held') { pendingOf.delete(id); tally.held++; return 'held'; }
      if (code === 'forgotten') {
        if (state.conversations[id] === st) delete state.conversations[id]; // what this pass learnt is not kept
        pendingOf.delete(id);
        tally.held++;
        return 'forgotten';
      }
      throw e;
    }
    mem.fails = 0; mem.ends = 0;
    if (w.changed) mem.sentAt = now();
    pendingOf.set(id, 0);
    tally.synced++;
    return 'synced';
  }

  // ---------- the scan ----------
  // every conversation in the projects folders (want: only that id, whatever only() says), newest first.
  // -> Promise: from fs.promises, a slug folder's logs lstat'ed together and the loop handed back between folders
  // (~1,600 sync lstats ran as one block, 12-25 ms each on a slow disk, 2026-10-17)
  async function listConversations(want) {
    const only = !want && typeof opts.only === 'function' ? opts.only : null;
    const byId = new Map();
    for (const { account, dir } of projectsList()) {
      let slugs;
      try { slugs = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const s of slugs) {
        if (!s.isDirectory()) continue;
        await breathe();
        const slugDir = path.join(dir, s.name);
        let names;
        try { names = await fs.promises.readdir(slugDir); } catch { continue; }
        const logs = [];
        for (const n of names) {
          const m = LOG_ID.exec(n);
          if (!m) continue;
          const lid = m[1].toLowerCase();
          if (want ? lid !== want : only && !only(lid)) continue;
          logs.push({ n, m, lid });
        }
        const stats = await Promise.all(logs.map(({ n }) => fs.promises.lstat(path.join(slugDir, n)).catch(() => null)));
        for (let i = 0; i < logs.length; i++) {
          const { n, m, lid } = logs[i], fst = stats[i];
          if (!fst || !fst.isFile()) continue;
          const c = { id: lid, name: m[1], account, slugDir, mainPath: path.join(slugDir, n), size: fst.size, mtimeMs: fst.mtimeMs };
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
      scanFailed(e);
      return;
    }
    const list = await listConversations();
    counts.conversations = list.length;
    const ids = new Set(list.map((c) => c.id));
    for (const id of [...pendingOf.keys()]) if (!ids.has(id)) pendingOf.delete(id);
    for (const id of [...notSynced.keys()]) if (!ids.has(id)) notSynced.delete(id);
    let rowFailed = false, ended = null; // ended: the error that ended the scan (Supabase out of reach, signed out)
    for (const c of list) {
      if (stopping) break;
      await breathe(); // (the lock is a resolved promise when free: without this, thousands of settled ones ran as one block)
      await lock(false); // a flush() waiting goes first
      try {
        if (stopping) break;
        if (holds.has(c.id)) { counts.held++; noteWhy(c.id, 'held'); continue; } // held after the scan began: looked at at its turn
        const out = await syncConversation(c, device);
        if (out === 'synced' || out === 'throttled') notSynced.delete(c.id);
      } catch (e) {
        if (e && e.code === 'stopped') break;
        setError(e);
        if (e && FATAL.has(e.code)) { log(`scan stopped: ${clip(e.message)}`); ended = e; break; }
        // Supabase out of reach, busy or failing (a request cut by sleep too): not this conversation's fault, and every
        // other one would fail the same way: the scan ends and backs off as a whole
        // ... unless this one ended STUCK_ENDS scans in a row (its upload always times out, say): then it is its own,
        // and backs off alone so the conversations after it are not starved
        const mem = memo.get(c.id);
        if (S.isTransient(e)) {
          const ends = mem ? (mem.ends = (mem.ends || 0) + 1) : 1;
          if (ends < STUCK_ENDS) { log(`${short(c.id)}: ${clip(e && e.message)}`); ended = e; break; }
          if (mem) mem.ends = 0;
        }
        rowFailed = true;
        health.rowError(e);
        if (mem) {
          mem.fails++;
          const wait = Math.min(BACKOFF_MS * 2 ** (mem.fails - 1), BACKOFF_MAX_MS);
          mem.backoffUntil = now() + wait;
          log(`${short(c.id)}: failed (${clip(e && e.message)}); trying again in ${Math.round(wait / 1000)} s`);
        }
        noteWhy(c.id, 'backingOff');
      } finally { unlock(); }
    }
    counts.pending = [...pendingOf.values()].filter((n) => n > 0).length;
    saveState();
    if (ended) scanFailed(ended);
    else if (!stopping) {
      health.done(!rowFailed);
      if (!rowFailed) totals.lastError = null; // a clean scan: the last error is over
    }
    totals.lastScanAt = new Date(now()).toISOString();
    totals.lastScanMs = Date.now() - t0;
  }

  // ---------- the loop ----------
  let running = null, timer = null, started = false;
  function scanOnce() {
    if (running) return running;
    running = scan().catch((e) => { setError(e); log(`scan failed: ${clip(e && e.message)}`); scanFailed(e); }).finally(() => { running = null; });
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
      timer = setTimeout(tick, Math.max(every, health.wait())); // backing off: the scan-level wait
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
    try {
      if (running) await running;
      await Promise.allSettled([...flights]);
    } finally { stopping = false; saveState(); }
  }

  // ---------- S4: flush, forget, hold ----------
  const flights = new Set(); // flush() calls under way (stop() waits for them)
  const idOf = (raw) => String(raw == null ? '' : raw).toLowerCase();
  function flush(raw) {
    const p = flushNow(idOf(raw));
    flights.add(p);
    const done = () => { flights.delete(p); };
    p.then(done, done);
    return p;
  }
  async function flushNow(id) {
    if (!ID_RE.test(id)) throw new S.SyncError('not a conversation id', 0, 'bad_request');
    if (stopping) throw new S.SyncError('stopped', 0, 'stopped');
    await lock(true);
    try {
      if (stopping) throw new S.SyncError('stopped', 0, 'stopped');
      const device = await C.ensureDevice(api, dataDir);
      loadState(device);
      const tally = Object.fromEntries(Object.keys(counts).map((k) => [k, 0])); // a flush is not a scan's count
      for (let pass = 0; ; pass++) {
        const c = (await listConversations(id))[0];
        if (!c) throw new S.SyncError('this machine has no log for that conversation', 0, 'missing');
        const mem = memo.get(id);
        if (mem) { mem.backoffUntil = 0; mem.skip = null; mem.listedAt = 0; }
        const out = await syncConversation(c, device, { urgent: true, tally });
        if (out === 'synced') notSynced.delete(id);
        if (out !== 'synced') throw new S.SyncError(NOT_SYNCED[out] || out, 0, out);
        const row = await getRow(id, FLUSH_COLS);
        if (!row) throw new S.SyncError('the server has no row for that conversation', 0, 'missing');
        const owner = ownerOf(row);
        if (owner !== device) throw new S.SyncError(NOT_SYNCED.foreign, 0, 'foreign');
        // the log grew (or changed) while it went up: again, so the row catches up with it
        let fst = null;
        try { fst = fs.statSync(c.mainPath); } catch {}
        if (pass < FLUSH_REPEATS && fst && (fst.size !== c.size || fst.mtimeMs !== c.mtimeMs)) continue;
        return { size: Number(row.size), sha256: row.sha256 || null, generation: Number(row.generation), owner_device: owner };
      }
    } catch (e) {
      log(`${short(id)}: flush: ${clip(e && e.message)}`);
      throw e;
    } finally { saveState(); unlock(); }
  }
  // the next pass takes over what the server has: nothing of what this side remembers about it is trusted
  function forget(raw) {
    const id = idOf(raw);
    if (!ID_RE.test(id)) return false;
    epochs.set(id, (epochs.get(id) || 0) + 1);
    memo.delete(id); hashes.delete(id); pendingOf.delete(id); notSynced.delete(id); untrim(id);
    forgotAt.set(id, now());
    if (state) {
      if (state.conversations[id]) { delete state.conversations[id]; dirty = true; saveState(); }
    } else {
      const s = C.readState(statePath, null); // not loaded yet: the file on disk
      if (s && s.conversations && s.conversations[id]) {
        delete s.conversations[id];
        try { C.writeState(statePath, s); } catch (e) { log(`up-state.json could not be saved: ${clip(e.message)}`); }
      }
    }
    return true;
  }
  function hold(raw) { const id = idOf(raw); if (!ID_RE.test(id)) return false; holds.add(id); return true; }
  function unhold(raw) { return holds.delete(idOf(raw)); }
  const held = () => [...holds];
  function status() {
    let pendingBytes = 0;
    for (const n of pendingOf.values()) pendingBytes += n;
    return {
      running: started, scanning: !!running, scans: totals.scans, lastScanAt: totals.lastScanAt, lastScanMs: totals.lastScanMs,
      conversations: counts.conversations, synced: counts.synced, pending: counts.pending, pendingBytes,
      skipped: { noRepo: counts.noRepo, foreign: counts.foreign, inactive: counts.inactive, empty: counts.empty, held: counts.held }, backingOff: counts.backingOff, throttled: counts.throttled,
      uploadedBytes: totals.uploadedBytes, uploadedChunks: totals.uploadedChunks,
      lastError: totals.lastError ? { ...totals.lastError } : null,
      health: health.status(),
      notSynced: notSyncedList(), notSyncedCount: notSynced.size,
    };
  }
  // why each chat that did not go up did not (newest first, at most NOT_SYNCED_MAX): { id, cause, why, fix, byDesign,
  // folder, since (ISO) }
  function notSyncedList() {
    return [...notSynced].sort((a, b) => b[1].since - a[1].since).slice(0, NOT_SYNCED_MAX).map(([id, n]) => {
      const k = NOT_SYNCED_CAUSES[n.cause] || { why: n.cause, fix: null, byDesign: false };
      return { id, cause: n.cause, why: k.why, fix: k.fix, byDesign: k.byDesign, folder: n.folder, since: new Date(n.since).toISOString() };
    });
  }
  // the Sync card's Rescan: placement asked again for every chat that was skipped (git asked afresh, the 10-minute
  // skips and back-offs dropped), and a scan now (or the one under way, then the next round)
  function rescan() {
    C.forgetRepos();
    for (const mem of memo.values()) { mem.skip = null; mem.backoffUntil = 0; }
    if (started) scanOnce();
    return { ok: true, scanning: started };
  }
  return { scanOnce, start, stop, status, flush, forget, hold, unhold, held, rescan };
}

module.exports = { createUploader, repoFor, homeFor, boundFor, lastLineEnd, MAX_CHUNK, TAIL_BYTES };
