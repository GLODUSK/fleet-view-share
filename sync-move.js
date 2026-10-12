// sync-move.js: "Continue here" (the sync plan's part S4). It moves one Claude Code conversation from the device that
// owns it (A) to this one (B) through Supabase, with no lost line and no fork. sync-run.js makes one mover per run,
// beside the uploader (sync-up.js) and the materializer (sync-down.js); every device runs both halves:
//   B, the requester: move(id) starts a job. It asks A, waits while A ends the session and uploads its last lines,
//     lays the log down here (materializer.pull), checks it byte for byte, and claims the row; the page then resumes
//     it in the resume folder with the host's open { id, cwd, account }.
//   A, the owner: it answers the asks for conversations it owns. It ends the session (the host's kill, Ctrl+C twice)
//     once Claude is idle (or at once when asked with force), uploads what is left (uploader.flush), checks that the
//     cloud copy is its log, and lets go: the uploader holds the id until B's claim moves the row.
// Ownership moves only by B's claim, a PATCH conditional on owner_device = A and sha256 = the final sha256 A sent, so
// a line A writes after it let go makes the claim fail ("it changed on <A> meanwhile; try again"), never a fork.
//
//   createMover({ api, dataDir, key, log, now, up, down, host, isOpen, me, home, projects, isLive, findLog, trusted,
//                 timing })
//     -> { start(), stop(), tick(), settle(), move(id, { force }), status(id), cancel(id), owners(), device(),
//          online(deviceId), outgoing() }
//
//   api       sync-api.js createSync()'s object (rest() only)
//   key       the 32-byte sync key: the ask and reply rows are sealed with it
//   up        the uploader: flush(id), forget(id), hold(id), unhold(id), held()
//   down      the materializer: pull(id), owners(), conflicts(), status() (its listedAt: when the listing behind
//             owners() began)
//   host      { list() -> Promise<hostSession[]|null>, kill(id) -> Promise } (desktop/host.js through api.js); none:
//             nothing is hosted here
//   isOpen    (id) -> bool: open in a Claude Code process here (fleet-view.js's pid file scan); with isLive (by
//             default sync-common.js isLive(id, { fresh })) it tells a session that is still running
//   me        this device's id (by default sync-common.js ensureDevice, asked on the first tick)
//   home      the folder holding .claude, .claude-a and .claude.json (tests); projects: [{ account, dir }] (or a
//             function) where A looks for the log (sync-common.js projectsDirs by default); findLog(id) -> path and
//             trusted(cwd, account) -> bool replace those lookups (tests)
//   now()     the clock (Date.now); timing: { ...TIMING } overrides (tests)
//
// The request channel is two rows of fleet_sync.settings per move, each written by one side only, sealed with
// sync-crypto.js sealText(json, key, 'setting:<key>'), upserted on (user_id, key):
//   move:<id>:ask    B's: { v: 1, id, to: B, from: A, at, nonce, force }; B writes at again every 20 s while it waits
//   move:<id>:reply  A's: { v: 1, id, nonce, from: A, at, phase, note, status?, waitingFor?, external?, final? }
//                    phase asked | waiting | ending | uploading | released | failed; final { size, sha256, generation }
//                    with released. A writes at again every 10 s once the ask is confirmed.
// Freshness is judged by seeing at change, on the observer's own clock (never a clock compare across machines):
//   - A acts on an ask only after it saw its at change once (B writes it again as soon as it sees A's first reply),
//     so an ask left behind by a B that died never ends a session; it drops an ask whose at has not changed for 90 s
//     (deletes both rows, lets go of the hold, and takes the id out of away.json).
//   - B claims only while its own last ask write is under 60 s old and it saw A's released reply (same nonce) change
//     under 60 s ago, which leaves A 30 s of margin before it would drop the ask.
//   B deletes both rows when its job ends (ready, failed or cancelled). A deletes its reply when the ask goes away.
//
// A's order: ask seen (the row is A's) -> reply asked and the id in away.json as moving (the host refuses to open it)
//   -> confirmed -> live in the host and busy (status busy or shell, or waiting on anything but an open dialog; no
//   status for 10 s counts as idle) and no force: reply waiting -> idle (or force): host kill, reply ending -> not
//   live (pid files and the host's list) and the log's size stable for 1 s -> reply uploading, uploader.flush(id) ->
//   the row's size must be the log's last line end (a cut last line is left out, with a note) and its sha256 the
//   log's -> uploader.hold(id), reply released with final -> the owner turns into B: unhold, done (the uploader's
//   foreign-owner rule takes over); the ask goes away or stale first: unhold, drop moving. While released, the log
//   changing or the conversation opening here again ends it as failed ("it was opened again on <A>").
//   Open in a terminal outside the host: reply waiting, "open in a terminal on <A>: close it there"; force never
//   ends that one.
// B's job phases: asking -> waiting -> ending -> uploading -> downloading -> claiming -> ready, or failed, offline
//   (A's devices.last_seen_at seen unchanged for 2 minutes on this clock), noanswer (no reply 60 s after asking, or a
//   reply that stopped changing for 60 s), cancelled. waiting (A busy; not for a terminal outside the host), offline
//   and noanswer can be forced: in waiting the ask goes out again with force (A ends the session mid-turn); offline or
//   noanswer, B takes the last copy A uploaded: pull, then the same conditional claim on owner A and the sha256 B laid
//   down. Not while A's lease_until on it is ahead (A ran it in the last 3 minutes), and not when A's reply changed
//   after the force (A is there after all: the ask, now with force, has A hand it over itself). After a forced claim
//   the uploader stays held 30 s more, then forget() again: a chunk A still had on its way (its uploader looks at the
//   owner every 20 s) lands before this device writes one of the same number, and the uploader takes over what the
//   server has by then. A pull that finds this PC's copy longer or different fails the job ("This PC has lines in this
//   conversation that <A> lacks; Fleet View won't merge them"), and so does a conflict the materializer already lists,
//   before A is asked.
//   A job nobody asks about (move() or status(): the page polls every second) for 5 minutes is cancelled while it is
//   still asking, waiting, offline or noanswer, so a closed page never ends a session on A later. After a claim:
//   uploader.forget(id) (it adopts
//   the row from the server again), the id out of away.json, ready = { cwd, account, trusted }: cwd is the resume
//   folder (the materializer's folder when its slug is the log's folder, else the log's own folder when it is here),
//   account 'A' | 'B', trusted whether that account's .claude.json has projects[cwd].hasTrustDialogAccepted (never
//   written here).
//
// Also, on every device:
//   away.json   <dataDir>/sync/away.json = { v: 1, at, ids: { <id>: { device: <name>, why: 'owned' | 'moving' } } }:
//               the rows the materializer listed as another device's, the ids A is handing over (moving), the ones
//               this device saw another device claim, less the ones this device claimed. A claim seen here counts
//               until a materializer listing that began after it (its status().listedAt), however long that takes.
//               Written (temp + rename) when it changes; until the materializer has listed the rows once, the file
//               from before is kept. desktop/host.js refuses to open the ids in it. sync-run.js deletes it when sync
//               is turned off here (dropAway: not set up, or Work locally), never for a lost sign-in.
//   watcher     every 15 s: a hosted, running session whose row the materializer lists as another device's (and that
//               is not held or just claimed here) is checked again, and ended once idle (a forced takeover, a device
//               that woke up later).
//   heartbeat   devices.last_seen_at every 30 s (others judge offline by it); every 60 s one PATCH puts lease_until
//               3 minutes ahead on the hosted, running conversations this device owns.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const P = require(path.join(__dirname, 'platform.js'));
const S = require(path.join(__dirname, 'sync-api.js'));
const K = require(path.join(__dirname, 'sync-crypto.js'));
const C = require(path.join(__dirname, 'sync-common.js'));
const { lastLineEnd } = require(path.join(__dirname, 'sync-up.js'));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const KEY_RE = /^move:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(ask|reply)$/;
const READ_PIECE = 1024 * 1024;
const TIMING = {
  tickMs: 1e3, // a tick while a move is under way here (either side)
  pollMs: 5e3, // and while none is: the asks are looked for this often
  askRefreshMs: 20e3, // B writes its ask's at again this often while it waits
  replyRefreshMs: 10e3, // A writes its reply's at again this often (once the ask is confirmed)
  askStaleMs: 90e3, // A drops an ask whose at has not changed for this long
  claimFreshMs: 60e3, // B claims only within this of its own last ask write and of seeing A's reply change
  noAnswerMs: 60e3, // B: no reply this long after asking, or a reply that stopped changing: noanswer
  offlineMs: 2 * 60e3, // a device whose last_seen_at is older than this is offline
  devicesMs: 30e3, // the devices table (names, last_seen_at) is read at most this often
  watchMs: 15e3, // the watcher's round
  touchMs: 30e3, // this device's last_seen_at
  leaseEveryMs: 60e3, // one lease PATCH this often
  leaseForMs: 3 * 60e3, // lease_until = now + this (also on a claim)
  stableMs: 1e3, // A: the log's size must hold this long after the session closed
  nullIdleMs: 10e3, // a hosted session with no status this long counts as idle
  endingMaxMs: 60e3, // A gives up when the session is still open this long after it was ended
  forcedHoldMs: 30e3, // after a forced claim the uploader stays held this long (a chunk A still had on its way)
  jobKeepMs: 10 * 60e3, // a finished job is kept for the page this long
  pendingTries: 3, // a pull that finds a side file mid-upload is tried this many times...
  pendingWaitMs: 2e3, // ...this far apart
  unwatchedMs: 5 * 60e3, // a job nobody asked about (move() or status()) this long is cancelled while A has not started
};
// B's job phases that are still under way (the rest: ready, failed, cancelled)
const ACTIVE = new Set(['asking', 'waiting', 'ending', 'uploading', 'downloading', 'claiming', 'offline', 'noanswer']);
const FORCEABLE = new Set(['waiting', 'offline', 'noanswer']);
// ...and the ones before A ends anything: a job left alone there is cancelled (unwatchedMs)
const UNSTARTED = new Set(['asking', 'waiting', 'offline', 'noanswer']);
// A's phases while it is handing a conversation over (in away.json as moving)
const MOVING = new Set(['asked', 'waiting', 'ending', 'uploading', 'released']);

const lower = (s) => (typeof s === 'string' ? s.toLowerCase() : '');
const short = (id) => String(id).slice(0, 8);
const clip = (s, n = 200) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const iso = (ms) => new Date(ms).toISOString();
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const sizeOf = (p) => { try { return fs.statSync(p).size; } catch { return -1; } };
const askKey = (id) => `move:${id}:ask`;
const replyKey = (id) => `move:${id}:reply`;
const awayPath = (dataDir) => path.join(S.syncDir(dataDir), 'away.json');
// sync-run.js: sync stopped for a gate (signed out, no key, not set up, not a member), so nothing is away any more
function dropAway(dataDir) { try { fs.rmSync(awayPath(dataDir), { force: true }); } catch {} }
const codeError = (code, message) => Object.assign(new Error(message), { code });

// sha256 of a file's [0, end)
function shaRange(fd, end) {
  const h = crypto.createHash('sha256');
  for (let pos = 0; pos < end; pos += READ_PIECE) {
    const len = Math.min(READ_PIECE, end - pos), buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) { const n = fs.readSync(fd, buf, got, len - got, pos + got); if (!n) throw new Error('the file got shorter while it was read'); got += n; }
    h.update(buf);
  }
  return h.digest('hex');
}
// is file exactly size bytes whose sha256 is sha?
function sameBytes(file, size, sha) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    return fs.fstatSync(fd).size === size && shaRange(fd, size) === sha;
  } catch { return false; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}
// the newest <slug>/<id>.jsonl in the projects folders, or null
function findLogIn(dirs, id) {
  let best = null;
  for (const { dir } of dirs) {
    let slugs;
    try { slugs = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const s of slugs) {
      if (!s.isDirectory()) continue;
      const p = path.join(dir, s.name, `${id}.jsonl`);
      let st;
      try { st = fs.lstatSync(p); } catch { continue; }
      if (st.isFile() && (!best || st.mtimeMs > best.mtimeMs)) best = { p, mtimeMs: st.mtimeMs };
    }
  }
  return best ? best.p : null;
}
// does account ('A' | 'B') trust folder cwd? Its .claude.json's projects[<cwd with />].hasTrustDialogAccepted, read
// only (Fleet View never answers the trust question for a moved conversation)
function trustedIn(home, cwd, account) {
  if (typeof cwd !== 'string' || !cwd) return false;
  const f = account === 'A' ? path.join(home, '.claude-a', '.claude.json') : path.join(home, '.claude.json');
  let j;
  try { j = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { return false; }
  const projects = j && j.projects && typeof j.projects === 'object' ? j.projects : {};
  const want = P.foldCase(path.resolve(cwd).replace(/\\/g, '/'));
  for (const [k, v] of Object.entries(projects)) {
    if (P.foldCase(k.replace(/\\/g, '/').replace(/\/+$/, '')) === want && v && v.hasTrustDialogAccepted === true) return true;
  }
  return false;
}
// The folder a conversation laid down in slug folder dir resumes in (the design's X): the materializer's folder when
// its slug is dir's name; else the log's own folder (sync-common.js homeCwd) when it is on this machine; else folder.
function resumeFolder(dir, folder, id) {
  if (typeof folder === 'string' && folder && P.foldCase(C.slugOf(folder)) === P.foldCase(path.basename(dir))) return folder;
  const main = path.join(dir, `${id}.jsonl`);
  const h = C.homeCwd(main, C.lastMeta(main).cwd);
  if (h && isDir(h)) return h;
  return typeof folder === 'string' && folder ? folder : h;
}
// mid-turn, as desktop/host.js isBusy has it; a status that is unknown counts as busy for nullIdleMs (since: a Map
// id -> when it was first seen with no status)
function busyNow(p, since, t, nullIdleMs) {
  const id = lower(p.id);
  if (p.status == null) {
    if (!since.has(id)) since.set(id, t);
    return t - since.get(id) < nullIdleMs;
  }
  since.delete(id);
  return p.status === 'busy' || p.status === 'shell' || (p.status === 'waiting' && p.waitingFor !== 'dialog open');
}

function createMover(o = {}) {
  const api = o.api;
  if (!api || typeof api.rest !== 'function') throw new S.SyncError('the mover needs sync-api.js\'s api', 0, 'bad_request');
  const key = o.key;
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new S.SyncError('the sync key must be 32 bytes', 0, 'bad_key');
  const dataDir = o.dataDir;
  if (typeof dataDir !== 'string' || !dataDir) throw new S.SyncError('the mover needs the data folder', 0, 'bad_request');
  const log = typeof o.log === 'function' ? (t) => { try { o.log(`sync-move: ${t}`); } catch {} } : () => {};
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const tm = { ...TIMING, ...(o.timing && typeof o.timing === 'object' ? o.timing : {}) };
  const up = o.up || {}, down = o.down || {};
  const host = o.host && typeof o.host.list === 'function' ? o.host : null;
  const home = o.home || os.homedir();
  const isOpen = typeof o.isOpen === 'function' ? o.isOpen : () => false;
  const isLive = typeof o.isLive === 'function' ? o.isLive : (id) => C.isLive(id, { home, fresh: true });
  const live = (id) => { try { if (isLive(id)) return true; } catch {} try { return !!isOpen(id); } catch { return false; } };
  const projects = () => {
    const p = typeof o.projects === 'function' ? o.projects() : o.projects;
    return Array.isArray(p) ? C.projectsDirs({ dirs: p }) : C.projectsDirs({ home });
  };
  const findLog = typeof o.findLog === 'function' ? o.findLog : (id) => findLogIn(projects(), id);
  const trusted = typeof o.trusted === 'function' ? o.trusted : (cwd, account) => trustedIn(home, cwd, account);
  let me = typeof o.me === 'string' && UUID_RE.test(o.me.toLowerCase()) ? o.me.toLowerCase() : null;

  // ---------- memory ----------
  const jobs = new Map(); // id -> B's job (this device asked for it)
  const outs = new Map(); // id -> A's hand-over (another device asked this one)
  const claimed = new Map(); // id -> when this device claimed it (until the materializer lists the rows after that)
  const gone = new Map(); // id -> { device, at }: seen claimed by another device (the same)
  const afterForce = new Map(); // id -> until when the uploader stays held after a forced claim here
  const staleAsks = new Map(); // id -> 'nonce|at' of an ask this device dropped as stale (its delete may not have gone)
  const nullSince = new Map(); // id -> since when a hosted session has had no status
  const devices = { at: -Infinity, byId: new Map() }; // id -> { name, lastSeen (ms, as written), changedAt (this clock) }
  let asks = new Map(), replies = new Map(); // id -> opened row, from the last poll
  let lastTouch = -Infinity, lastLease = -Infinity, lastWatch = -Infinity;
  let awaySig = null;
  const said = new Map();
  const logOnce = (k, t) => { if (said.get(k) === t) return; said.set(k, t); log(t); };

  const nameOf = (id, fallback) => (devices.byId.get(lower(id)) || {}).name || fallback || 'another device';
  const myName = () => nameOf(me, os.hostname() || 'this PC');
  // offline: its last_seen_at has not changed for offlineMs on this clock (never compared with this clock: the other
  // machine's may be off); since: a device the table did not list is offline only when it was read after then (one
  // made since is not)
  const isOffline = (id, since = -Infinity) => {
    const d = devices.byId.get(lower(id));
    if (!d) return devices.at > -Infinity && devices.at >= since; // read, and not there: no such device
    return !d.lastSeen || now() - d.changedAt > tm.offlineMs;
  };
  const ownersRaw = () => {
    try { const m = typeof down.owners === 'function' ? down.owners() : null; return m instanceof Map ? m : new Map(); } catch { return new Map(); }
  };
  // when the listing behind owners() began (ms), or null; a claim before then is in it
  const listedAt = () => {
    try {
      const s = typeof down.status === 'function' ? down.status() : null;
      const t = s && s.listedAt != null ? (typeof s.listedAt === 'number' ? s.listedAt : Date.parse(s.listedAt)) : NaN;
      return Number.isFinite(t) ? t : null;
    } catch { return null; }
  };
  const listedSince = (at) => { const l = listedAt(); return l !== null && l > at; };
  const recentlyClaimed = (id) => claimed.has(id) && !listedSince(claimed.get(id));
  // the whole seconds until ms on this clock, or 0 (for A's lease_until: compared with this clock, which only ever
  // makes force wait longer or less long)
  const secsTo = (ms) => { const left = Number.isFinite(ms) ? ms - now() : 0; return left > 0 ? Math.ceil(left / 1000) : 0; };
  const hostedIn = (list, id) => (Array.isArray(list) ? list : []).find((p) => p && p.alive && lower(p.id) === id) || null;
  const heldNow = () => { try { return new Set((typeof up.held === 'function' ? up.held() : []).map(lower)); } catch { return new Set(); } };

  // ---------- background work (a flush, a pull, a claim) and the writes, one at a time per row ----------
  const tasks = new Set();
  const track = (p) => { tasks.add(p); p.then(() => tasks.delete(p), () => tasks.delete(p)); return p; };
  function startTask(x, fn) {
    x.task = track((async () => { try { await fn(); } catch (e) { log(`${short(x.id)}: ${clip(e && e.message)}`); } })().finally(() => { x.task = null; kick(); }));
  }
  const chains = new Map(); // settings key -> the tail of its writes
  function serial(keys, fn) {
    const prev = Promise.all(keys.map((k) => chains.get(k) || Promise.resolve()));
    const p = prev.then(fn);
    const tail = track(p.catch(() => {}));
    for (const k of keys) chains.set(k, tail);
    tail.then(() => { for (const k of keys) if (chains.get(k) === tail) chains.delete(k); });
    return p;
  }
  // an at that differs from the last one written even when the clock did not move
  const nextAt = (prev) => Math.max(now(), (Number(prev) || 0) + 1);
  // build() runs when the write's turn comes, so it always carries the newest state
  function putSetting(k, build) {
    return serial([k], () => api.rest('POST', 'settings', {
      query: { on_conflict: 'user_id,key' }, prefer: 'resolution=merge-duplicates,return=minimal',
      body: { key: k, value_enc: K.sealText(JSON.stringify(build()), key, `setting:${k}`) },
    }));
  }
  // both rows (or the ones named) of a move, after any write to them still on its way; never rejects
  function dropRows(id, kinds = ['ask', 'reply']) {
    const keys = kinds.map((k) => `move:${id}:${k}`);
    return serial(keys, () => api.rest('DELETE', 'settings', { query: { key: `in.(${keys.map((k) => `"${k}"`).join(',')})` }, prefer: 'return=minimal' }))
      .catch((e) => log(`${short(id)}: the request rows could not be deleted (${clip(e && e.message)})`));
  }
  async function poll() {
    const rows = await api.rest('GET', 'settings', { query: { select: 'key,value_enc', key: 'like.move:*' } });
    const a = new Map(), r = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      const m = row && typeof row.key === 'string' ? KEY_RE.exec(row.key) : null;
      if (!m) continue;
      let v = null;
      try { v = JSON.parse(K.openText(row.value_enc, key, `setting:${row.key}`)); } catch {}
      if (!v || v.v !== 1 || lower(v.id) !== m[1] || typeof v.nonce !== 'string' || !v.nonce) { logOnce(`bad|${row.key}`, `${short(m[1])}: a ${m[2]} row that does not open with this key; ignored`); continue; }
      (m[2] === 'ask' ? a : r).set(m[1], v);
    }
    asks = a;
    replies = r;
  }
  async function loadDevices() {
    if (now() - devices.at < tm.devicesMs) return;
    const rows = await api.rest('GET', 'devices', { query: { select: 'id,name,last_seen_at' } });
    const byId = new Map(), t = now();
    for (const d of Array.isArray(rows) ? rows : []) {
      if (!d || typeof d.id !== 'string') continue;
      const id = d.id.toLowerCase(), prev = devices.byId.get(id), seen = Date.parse(d.last_seen_at);
      const lastSeen = Number.isFinite(seen) ? seen : null;
      // changedAt: when this device saw it change (or first saw it): the other device was there then; moved: it was
      // seen changing at least once (a first sight says nothing of whether it is there now)
      const same = !!prev && prev.lastSeen === lastSeen;
      byId.set(id, { name: typeof d.name === 'string' && d.name ? d.name.slice(0, 100) : null, lastSeen, changedAt: same ? prev.changedAt : t, moved: !!prev && (prev.moved || !same) });
    }
    devices.byId = byId;
    devices.at = t;
  }
  async function getRow(id) {
    const rows = await api.rest('GET', 'conversations', { query: { select: 'id,account,owner_device,state,size,sha256,generation', id: `eq.${id}` } });
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  }
  async function hostList() {
    if (!host) return null;
    try { const l = await host.list(); return Array.isArray(l) ? l : null; } catch { return null; }
  }

  // ---------- away.json ----------
  function awayReady() {
    if (listedAt() !== null) return true;
    try { const s = typeof down.status === 'function' ? down.status() : null; return !!(s && s.lastOkAt); } catch { return false; }
  }
  function writeAway() {
    if (stopping) return;
    const t = now();
    // a claim (here or seen here) counts until the materializer lists the rows again after it
    for (const [id, at] of claimed) if (listedSince(at)) claimed.delete(id);
    for (const [id, g] of gone) if (listedSince(g.at)) gone.delete(id);
    const ready = awayReady();
    const ids = {};
    if (ready) {
      for (const [id, v] of ownersRaw()) { const d = lower(v && v.device); if (d && d !== me) ids[lower(id)] = { device: nameOf(d), why: 'owned' }; }
    } else {
      // the rows were not listed yet: what the file said before stays
      const j = C.readState(awayPath(dataDir), null);
      for (const [id, v] of Object.entries(j && j.ids && typeof j.ids === 'object' ? j.ids : {})) if (v && v.why === 'owned' && UUID_RE.test(id)) ids[id] = { device: String(v.device || 'another device'), why: 'owned' };
    }
    for (const [id, g] of gone) if (!ids[id]) ids[id] = { device: nameOf(g.device), why: 'owned' };
    for (const x of outs.values()) if (MOVING.has(x.phase)) ids[x.id] = { device: nameOf(x.to), why: 'moving' };
    for (const id of claimed.keys()) delete ids[id];
    const sig = JSON.stringify(Object.keys(ids).sort().map((k) => [k, ids[k].device, ids[k].why]));
    if (sig === awaySig) return;
    if (!ready && awaySig === null && !outs.size && !claimed.size && !gone.size) return; // nothing new before the first listing
    try { C.writeState(awayPath(dataDir), { v: 1, at: iso(t), ids }); awaySig = sig; } catch (e) { logOnce('away', `away.json could not be written (${clip(e.message)})`); }
  }

  // ---------- A: handing a conversation over ----------
  function sendReply(x) {
    return putSetting(replyKey(x.id), () => {
      x.replyAt = nextAt(x.replyAt);
      const r = { v: 1, id: x.id, nonce: x.nonce, from: me, at: x.replyAt, phase: x.phase, note: x.note || '' };
      if (x.phase === 'waiting') { r.status = x.status || null; r.waitingFor = x.waitingFor || null; if (x.external) r.external = true; }
      if (x.phase === 'released' && x.final) r.final = { ...x.final };
      return r;
    }).then(() => { x.repliedAt = now(); }, (e) => { logOnce(`reply|${x.id}`, `${short(x.id)}: the answer could not be sent (${clip(e && e.message)})`); });
  }
  // a new phase (or new details) for a hand-over, sent at once when anything changed
  function setOut(x, phase, f = {}) {
    const next = { phase, note: f.note || '', status: f.status || null, waitingFor: f.waitingFor || null, external: !!f.external };
    if (Object.keys(next).every((k) => x[k] === next[k])) return Promise.resolve();
    Object.assign(x, next);
    if (!MOVING.has(phase)) writeAway();
    return sendReply(x);
  }
  function failOut(x, why) {
    if (x.held) { try { up.unhold(x.id); } catch {} x.held = false; }
    log(`${short(x.id)}: not handed over: ${why}`);
    return setOut(x, 'failed', { note: why });
  }
  async function newOut(id, ask) {
    let row;
    try { row = await getRow(id); } catch (e) { logOnce(`row|${id}`, `${short(id)}: its row could not be read (${clip(e.message)})`); return; }
    const t = now();
    const x = {
      id, nonce: ask.nonce, to: lower(ask.to), force: ask.force === true, askAt: ask.at, askSeenAt: t, confirmed: false,
      phase: 'asked', note: '', status: null, waitingFor: null, external: false, final: null, held: false, task: null,
      file: null, stable: null, killAt: 0, replyAt: 0, repliedAt: -Infinity, finishing: null, startedAt: t,
    };
    outs.set(id, x);
    if (!row || lower(row.owner_device) !== me) { await failOut(x, `${myName()} does not have it any more`); return; }
    x.note = `${myName()} got the request`;
    writeAway(); // moving: the host refuses to open it from now on
    log(`${short(id)}: ${nameOf(x.to)} asked to continue it there${x.force ? ' (now)' : ''}`);
    await sendReply(x);
  }
  async function stepOut(x, ask, list) {
    const t = now();
    if (ask.at !== x.askAt) { x.askAt = ask.at; x.askSeenAt = t; x.confirmed = true; }
    if (ask.force === true) x.force = true;
    if (t - x.askSeenAt >= tm.askStaleMs) return finishOut(x, 'stale');
    if (x.phase === 'failed' || !x.confirmed) return;
    if (!x.task) {
      if (x.phase === 'asked' || x.phase === 'waiting') await judge(x, list);
      else if (x.phase === 'ending') await ending(x, list);
      else if (x.phase === 'released') await checkReleased(x, list);
    }
    if (outs.get(x.id) === x && x.phase !== 'failed' && now() - x.repliedAt >= tm.replyRefreshMs) await sendReply(x);
  }
  // asked or waiting: can the session end now?
  async function judge(x, list) {
    const name = myName();
    const p = hostedIn(list, x.id);
    if (!p && live(x.id)) return setOut(x, 'waiting', { external: true, note: `open in a terminal on ${name}: close it there` });
    if (p) {
      const busy = busyNow(p, nullSince, now(), tm.nullIdleMs);
      if (busy && !x.force) {
        const note = p.status == null ? `${name} is still starting it`
          : p.status === 'waiting' ? `${name} is waiting for an answer${p.waitingFor ? ` (${clip(p.waitingFor, 120)})` : ''}`
            : `${name} is working on it`;
        return setOut(x, 'waiting', { status: p.status || null, waitingFor: p.waitingFor || null, note });
      }
      try { await host.kill(p.id); } catch (e) { logOnce(`kill|${x.id}`, `${short(x.id)}: the session could not be ended (${clip(e && e.message)})`); return; }
      log(`${short(x.id)}: ended it here so ${nameOf(x.to)} can continue it${busy ? ' (mid-turn: forced)' : ''}`);
    }
    x.killAt = now();
    x.stable = null;
    return setOut(x, 'ending', { note: `${name} is closing it` });
  }
  // ending: closed (not live anywhere here) and the log's size stable for stableMs -> upload and let go
  async function ending(x, list) {
    const t = now();
    if (hostedIn(list, x.id) || live(x.id)) {
      x.stable = null;
      if (t - x.killAt >= tm.endingMaxMs) await failOut(x, `it did not close on ${myName()}`);
      return;
    }
    if (!x.file) x.file = findLog(x.id);
    const size = sizeOf(x.file);
    if (!x.stable || x.stable.size !== size) { x.stable = { size, since: t }; return; }
    if (t - x.stable.since < tm.stableMs) return;
    if (afterForce.has(x.id)) return; // just taken over here by force: no upload until that hold ends (see claim)
    startTask(x, () => release(x));
  }
  // the log is the cloud copy up to its last whole line? -> { ok, cut } | { ok: false, why }
  function checkLocal(file, fin) {
    const name = myName();
    if (!file) return { ok: false, why: `its log is not on ${name}` };
    if (!fin || !Number.isSafeInteger(Number(fin.size)) || !HEX64_RE.test(String(fin.sha256 || ''))) return { ok: false, why: 'the upload said no size or sha256' };
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const size = fs.fstatSync(fd).size;
      const end = lastLineEnd(fd, 0, size);
      if (Number(fin.size) !== end) return { ok: false, why: `the cloud copy has ${fin.size} of the ${end} bytes on ${name}` };
      if (shaRange(fd, end) !== fin.sha256) return { ok: false, why: `the cloud copy is not the log on ${name}` };
      return { ok: true, cut: size > end };
    } catch (e) { return { ok: false, why: `its log could not be read on ${name} (${e.code || clip(e.message)})` }; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
  }
  async function release(x) {
    const name = myName();
    await setOut(x, 'uploading', { note: `${name} is uploading the last lines` });
    if (typeof up.flush !== 'function' || typeof up.hold !== 'function') return failOut(x, `${name} can't hand conversations over yet`);
    if (!x.file) x.file = findLog(x.id);
    let fin = null, chk = null;
    for (let i = 0; i < 2; i++) { // a second flush when the first one missed something
      try { fin = await up.flush(x.id); } catch (e) { if (x.finishing || stopping) return; return failOut(x, `the upload on ${name} failed: ${clip(e && e.message)}`); }
      if (x.finishing || stopping) return;
      if (lower(fin && fin.owner_device) !== me) return failOut(x, `${name} does not have it any more`);
      chk = checkLocal(x.file, fin);
      if (chk.ok) break;
    }
    if (!chk.ok) return failOut(x, chk.why);
    try { up.hold(x.id); x.held = true; } catch (e) { return failOut(x, `the upload could not be held (${clip(e && e.message)})`); }
    x.final = { size: Number(fin.size), sha256: fin.sha256, generation: Number(fin.generation) };
    x.stable = { size: sizeOf(x.file), since: now() };
    log(`${short(x.id)}: let go (${x.final.size} bytes up)${chk.cut ? '; a cut last line stays here' : ''}`);
    await setOut(x, 'released', { note: chk.cut ? `${name} let it go; its last line was cut off and is left out` : `${name} let it go` });
  }
  // released: it must stay closed and unchanged here until the other device claims it
  async function checkReleased(x, list) {
    if (!hostedIn(list, x.id) && !live(x.id) && x.stable && sizeOf(x.file) === x.stable.size) return;
    await failOut(x, `it was opened again on ${myName()}; try again`);
  }
  // the ask went away (claimed, cancelled, failed) or stale: let go of the hold, and of moving
  async function finishOut(x, why) {
    if (x.task) { x.finishing = why; return; } // after the upload under way
    let owner = null;
    try { const row = await getRow(x.id); owner = row ? lower(row.owner_device) : null; } catch (e) { logOnce(`row|${x.id}`, `${short(x.id)}: its row could not be read (${clip(e.message)})`); return; }
    if (x.held) { try { up.unhold(x.id); } catch {} x.held = false; }
    if (outs.get(x.id) === x) outs.delete(x.id);
    const name = nameOf(x.to);
    if (owner && owner === x.to) {
      gone.set(x.id, { device: x.to, at: now() });
      claimed.delete(x.id); // claimed here once, and gone again since
      log(`${short(x.id)}: it continues on ${name} now`);
    } else if (x.phase !== 'failed') log(`${short(x.id)}: it stays here (${why === 'stale' ? `${name} stopped asking` : `${name} withdrew the request`})`);
    writeAway();
    if (why === 'stale') { staleAsks.set(x.id, `${x.nonce}|${x.askAt}`); await dropRows(x.id); } else await dropRows(x.id, ['reply']);
  }
  async function stepOwner(list) {
    for (const id of [...staleAsks.keys()]) if (!asks.has(id)) staleAsks.delete(id);
    for (const x of [...outs.values()]) {
      const ask = asks.get(x.id);
      if (!ask || ask.nonce !== x.nonce) await finishOut(x, 'gone');
    }
    for (const [id, ask] of asks) {
      if (stopping) return;
      if (lower(ask.from) !== me || lower(ask.to) === me || !UUID_RE.test(lower(ask.to))) continue;
      const x = outs.get(id);
      if (x) { if (x.nonce === ask.nonce) await stepOut(x, ask, list); continue; }
      if (staleAsks.get(id) === `${ask.nonce}|${ask.at}`) continue; // dropped already; its delete did not go through
      await newOut(id, ask);
    }
  }

  // ---------- B: taking one over ----------
  function setJob(j, phase, f = {}) {
    const next = { phase, note: f.note || '', status: f.status || null, waitingFor: f.waitingFor || null, canForce: !!f.canForce };
    if (Object.keys(next).every((k) => j[k] === next[k])) return;
    Object.assign(j, next);
    j.at = now();
  }
  function failJob(j, why, o2 = {}) {
    if (!ACTIVE.has(j.phase)) return;
    j.error = why;
    j.endedAt = now();
    setJob(j, 'failed', { note: why });
    log(`${short(j.id)}: not moved here: ${why}`);
    if (!o2.keepRows) dropRows(j.id);
  }
  async function maybeAsk(j) {
    if (!ACTIVE.has(j.phase)) return;
    if (!j.askDue && now() - j.askWrittenAt < tm.askRefreshMs) return;
    j.askDue = false;
    try {
      await putSetting(askKey(j.id), () => {
        j.askAt = nextAt(j.askAt);
        return { v: 1, id: j.id, to: me, from: j.from.device, at: j.askAt, nonce: j.nonce, force: j.force };
      });
      j.askWrittenAt = now();
      if (!j.askFirstAt) j.askFirstAt = j.askWrittenAt;
    } catch (e) { j.askDue = true; logOnce(`ask|${j.id}`, `${short(j.id)}: the request could not be sent (${clip(e && e.message)})`); }
  }
  // the materializer lays it down here -> its answer, or null when the job ended (or will try again)
  async function pullFor(j, kind) {
    const name = j.from.name;
    if (typeof down.pull !== 'function') { failJob(j, 'this PC can\'t take conversations over yet'); return null; }
    let r;
    try { r = await down.pull(j.id); } catch (e) { failJob(j, `the download failed: ${clip(e && e.message)}`); return null; }
    if (j.phase !== 'downloading') return null; // cancelled meanwhile
    const out = r && r.outcome;
    if ((out === 'done' || out === 'same') && typeof r.dir === 'string' && r.dir) return r;
    if (out === 'pending' && ++j.tries < tm.pendingTries) {
      j.redo = kind;
      j.retryAt = now() + tm.pendingWaitMs;
      setJob(j, 'downloading', { note: 'a side file is still uploading; trying again' });
      return null;
    }
    failJob(j, out === 'conflict' ? `This PC has lines in this conversation that ${name} lacks; Fleet View won't merge them`
      : out === 'missing' ? 'it is not in sync any more'
        : out === 'mine' ? 'it is on this PC already'
          : out === 'skip' ? `it can't be laid down here: ${clip(r.reason || 'skipped')}`
            : out === 'pending' ? `a side file is still uploading from ${name}; try again`
              : 'the download said nothing about where it went');
    return null;
  }
  // after A let go: lay it down, check it is A's final bytes -> claiming (the next tick claims while things are fresh)
  async function download(j) {
    const name = j.from.name;
    setJob(j, 'downloading', { note: 'downloading it' });
    const r = await pullFor(j, 'download');
    if (!r) return;
    if (!sameBytes(path.join(r.dir, `${j.id}.jsonl`), j.final.size, j.final.sha256)) return failJob(j, `it changed on ${name} meanwhile; try again`);
    j.laid = { dir: r.dir, folder: r.folder, row: r.row || {} };
    setJob(j, 'claiming', { note: `taking it over from ${name}` });
  }
  // offline or noanswer: force takes the last copy A uploaded, though not while A's lease on it is ahead (A's
  // heartbeat: A runs it in its host), as the last listing has it or the row the last forced pull read
  function stuck(j, phase, note) {
    const left = Math.max(secsTo((ownersRaw().get(j.id) || {}).leaseUntil), secsTo(j.leaseUntil));
    return setJob(j, phase, { note: left ? `${note}; it was running it there moments ago, so it can be taken over in ${left} s` : note, canForce: !left });
  }
  // forced, with A offline or not answering: the last copy A uploaded
  async function takeLast(j) {
    const name = j.from.name;
    setJob(j, 'downloading', { note: `downloading the last copy ${name} uploaded` });
    const r = await pullFor(j, 'take');
    if (!r) return;
    const row = r.row || {};
    if (lower(row.owner_device) !== j.from.device) return failJob(j, `it changed on ${name} meanwhile; try again`);
    if (!HEX64_RE.test(String(row.sha256 || ''))) return failJob(j, `${name} never uploaded any of it`);
    const lease = Date.parse(row.lease_until);
    if (secsTo(lease)) { j.leaseUntil = lease; return stuck(j, j.forceFrom || 'noanswer', j.forceFrom === 'offline' ? `${name} is offline` : `${name} stopped answering`); }
    if (!sameBytes(path.join(r.dir, `${j.id}.jsonl`), Number(row.size), row.sha256)) return failJob(j, `it changed on ${name} meanwhile; try again`);
    j.final = { size: Number(row.size), sha256: row.sha256, generation: Number(row.generation) };
    j.laid = { dir: r.dir, folder: r.folder, row };
    j.forced = true;
    log(`${short(j.id)}: taking the last copy ${name} uploaded`);
    await claim(j);
  }
  // the one write that moves ownership: only from A, only while the row is the bytes laid down here
  // the uploader is held across it, so no pass with an old up-state entry writes between the claim and forget(); after
  // a forced claim the hold stays forcedHoldMs more (see the top), then letGo() forgets it again and unholds it
  async function claim(j) {
    if (!ACTIVE.has(j.phase)) return;
    try { if (typeof up.hold === 'function') up.hold(j.id); } catch {}
    try { await claimHeld(j); } finally {
      if (j.forced && j.phase === 'ready') afterForce.set(j.id, now() + tm.forcedHoldMs);
      else try { if (typeof up.unhold === 'function') up.unhold(j.id); } catch {}
    }
  }
  // the holds after forced claims that are over (all: every one, when the mover stops)
  function letGo(all = false) {
    const t = now();
    for (const [id, until] of afterForce) {
      if (!all && t < until) continue;
      afterForce.delete(id);
      try { if (typeof up.forget === 'function') up.forget(id); } catch (e) { log(`${short(id)}: the uploader could not forget it (${clip(e && e.message)})`); }
      try { if (typeof up.unhold === 'function') up.unhold(id); } catch {}
    }
  }
  async function claimHeld(j) {
    const name = j.from.name;
    setJob(j, 'claiming', { note: `taking it over from ${name}` });
    const t = now();
    let got = null, err = null;
    try {
      got = await api.rest('PATCH', 'conversations', {
        query: { id: `eq.${j.id}`, owner_device: `eq.${j.from.device}`, sha256: `eq.${j.final.sha256}` },
        body: { owner_device: me, lease_until: iso(t + tm.leaseForMs), updated_at: iso(t) }, prefer: 'return=representation',
      });
    } catch (e) { err = e; }
    let ok = Array.isArray(got) && got.length === 1;
    if (err) {
      // the answer was lost, not necessarily the write
      try { const row = await getRow(j.id); ok = !!row && lower(row.owner_device) === me && row.sha256 === j.final.sha256; } catch {}
      if (!ok) return failJob(j, `the takeover did not go through: ${clip(err.message)}`);
    }
    if (!ok) return failJob(j, `it changed on ${name} meanwhile; try again`);
    // it is this device's now: the uploader adopts it from the server again (an old up-state entry must not write)
    claimed.set(j.id, now());
    gone.delete(j.id);
    try { if (typeof up.forget === 'function') up.forget(j.id); } catch (e) { log(`${short(j.id)}: the uploader could not forget it (${clip(e && e.message)})`); }
    writeAway();
    dropRows(j.id);
    const account = j.laid.row && j.laid.row.account === 'a' ? 'A' : 'B';
    const cwd = resumeFolder(j.laid.dir, j.laid.folder, j.id);
    let ok2 = false;
    try { ok2 = !!trusted(cwd, account); } catch {}
    j.ready = { cwd, account, trusted: ok2 };
    j.endedAt = now();
    setJob(j, 'ready', { note: ok2 ? 'ready: it continues here' : `ready; Claude will ask whether you trust ${cwd}` });
    log(`${short(j.id)}: moved here from ${name}${j.forced ? ' (its last uploaded copy)' : ''}`);
  }
  async function stepJob(j) {
    if (!ACTIVE.has(j.phase) || !me) return;
    const t = now();
    // the page stopped asking about it (closed) before A ended anything: A must not end a session for nobody
    if (UNSTARTED.has(j.phase) && !j.task && !j.laid && !j.forceClaim && t - j.seenAt >= tm.unwatchedMs) {
      j.endedAt = t;
      setJob(j, 'cancelled', { note: 'cancelled: nobody was watching it any more' });
      log(`${short(j.id)}: cancelled: nobody asked about it for ${Math.round(tm.unwatchedMs / 1000)} s`);
      dropRows(j.id);
      return;
    }
    if (!j.verified) {
      let row;
      try { row = await getRow(j.id); } catch (e) { logOnce(`row|${j.id}`, `${short(j.id)}: its row could not be read (${clip(e.message)})`); return; }
      const owner = row ? lower(row.owner_device) : '';
      if (!row || row.state !== 'active' || !owner) return failJob(j, 'it is not in sync any more');
      if (owner === me) return failJob(j, 'it is on this PC already');
      if (owner !== j.from.device) j.from = { device: owner, name: nameOf(owner) };
      // a conflict the materializer already knows: the pull would refuse it after A ended the session for nothing
      let conflict = false;
      try { conflict = (typeof down.conflicts === 'function' ? down.conflicts() : []).some((c) => c && lower(c.id) === j.id); } catch {}
      if (conflict) return failJob(j, `This PC has lines in this conversation that ${nameOf(owner)} lacks; Fleet View won't merge them`);
      j.verified = true;
    }
    const name = j.from.name = nameOf(j.from.device, j.from.name);
    const r0 = replies.get(j.id);
    const r = r0 && r0.nonce === j.nonce && lower(r0.from) === j.from.device ? r0 : null;
    if (r) {
      if (!j.reply || r.at !== j.reply.at) { j.replySeenAt = t; if (r.phase === 'asked') j.askDue = true; } // the handshake: A acts once it sees the ask change
      j.reply = r;
    } else if (j.reply) { j.reply = null; j.replySeenAt = 0; j.askFirstAt = 0; j.askDue = true; } // A dropped it: ask again
    // a download or a claim under way decides how the job ends; meanwhile only the ask is kept fresh
    if (j.task) { await maybeAsk(j); return; }
    // one ask row per conversation: a third device's ask in it means two devices want it at once
    const other = asks.get(j.id);
    if (other && lower(other.to) !== me) return failJob(j, 'another device asked for it at the same time; try again', { keepRows: true });
    if (j.forceClaim) {
      j.forceClaim = false;
      if ((r ? r.at : null) === j.forceReply) { startTask(j, () => takeLast(j)); return; }
      // A's reply changed since the force: A is there after all, and the ask (with force now) has it hand it over
      log(`${short(j.id)}: ${name} answered after all; it hands it over itself`);
    }
    if (r && r.phase === 'failed') return failJob(j, r.note || `${name} could not let it go`);
    await maybeAsk(j);
    if (j.redo) {
      if (t < j.retryAt) return;
      const k = j.redo;
      j.redo = null;
      startTask(j, () => (k === 'take' ? takeLast(j) : download(j)));
      return;
    }
    if (j.laid) {
      if (!r || r.phase !== 'released' || !r.final || r.final.sha256 !== j.final.sha256) { // A took it back
        j.laid = null; j.final = null;
        return setJob(j, 'asking', { note: `asking ${name} again` });
      }
      if (t - j.askWrittenAt < tm.claimFreshMs && t - j.replySeenAt < tm.claimFreshMs) { startTask(j, () => claim(j)); return; }
      if (t - j.replySeenAt >= tm.noAnswerMs) stuck(j, 'noanswer', `${name} stopped answering`);
      return;
    }
    if (r) {
      if (t - j.replySeenAt >= tm.noAnswerMs) return stuck(j, 'noanswer', `${name} stopped answering`);
      switch (r.phase) {
        case 'asked': return setJob(j, 'asking', { note: r.note || `${name} got the request` });
        case 'waiting': return setJob(j, 'waiting', { note: r.note || `${name} is busy with it`, status: r.status, waitingFor: r.waitingFor, canForce: !r.external });
        case 'ending': return setJob(j, 'ending', { note: r.note || `${name} is closing it` });
        case 'uploading': return setJob(j, 'uploading', { note: r.note || `${name} is uploading the last lines` });
        case 'released': {
          const f = r.final;
          if (!f || !Number.isSafeInteger(f.size) || f.size < 0 || !HEX64_RE.test(String(f.sha256 || ''))) return failJob(j, `${name} let it go without saying what it uploaded`);
          j.final = { size: f.size, sha256: f.sha256, generation: f.generation };
          j.tries = 0;
          startTask(j, () => download(j));
          return;
        }
        default: return;
      }
    }
    if (isOffline(j.from.device, j.startedAt)) return stuck(j, 'offline', `${name} is offline`);
    if (j.askFirstAt && t - j.askFirstAt >= tm.noAnswerMs) return stuck(j, 'noanswer', `${name} has not answered`);
    setJob(j, 'asking', { note: `asking ${name} for it` });
  }
  const jobJson = (j) => ({
    id: j.id, phase: j.phase, from: { device: j.from.device, name: nameOf(j.from.device, j.from.name) }, force: j.force,
    canForce: !!j.canForce && FORCEABLE.has(j.phase), note: j.note, status: j.status, waitingFor: j.waitingFor,
    ready: j.phase === 'ready' && j.ready ? { ...j.ready } : null, error: j.phase === 'failed' ? j.error : null,
    startedAt: j.startedAt, at: j.at,
  });
  // the row is another device's (the materializer's last listing, or a claim seen here since), and not just claimed here
  function ownedElsewhere(id) {
    const g = gone.get(id);
    if (g && !listedSince(g.at)) return { device: g.device, leaseUntil: null };
    if (recentlyClaimed(id)) return null;
    const v = ownersRaw().get(id);
    const d = lower(v && v.device);
    return d && d !== me ? { device: d, leaseUntil: v.leaseUntil || null } : null;
  }
  function move(id, opts = {}) {
    const k = lower(id);
    if (!UUID_RE.test(k)) throw codeError('bad_id', 'not a conversation id');
    const force = !!(opts && opts.force === true);
    let j = jobs.get(k);
    if (j && ACTIVE.has(j.phase)) {
      j.seenAt = now();
      if (force) {
        if (!j.force) { j.force = true; j.askDue = true; } // waiting: A ends it mid-turn
        // offline or noanswer: the last uploaded copy, unless A's reply changes before the next tick (canForce: no
        // lease of A's on it is ahead)
        if ((j.phase === 'offline' || j.phase === 'noanswer') && j.canForce && !j.task) {
          j.forceClaim = true;
          j.forceFrom = j.phase;
          j.forceReply = j.reply ? j.reply.at : null;
        }
        log(`${short(k)}: forced`);
      }
      kick();
      return jobJson(j);
    }
    const own = ownedElsewhere(k);
    if (!own) {
      if (j && j.phase === 'ready') return jobJson(j);
      throw codeError('not_elsewhere', 'no other device has this conversation');
    }
    const t = now();
    j = {
      id: k, phase: 'asking', from: { device: own.device, name: nameOf(own.device) }, force, canForce: false,
      note: `asking ${nameOf(own.device)} for it`, status: null, waitingFor: null, ready: null, error: null, startedAt: t, at: t,
      nonce: crypto.randomBytes(12).toString('hex'), askAt: 0, askWrittenAt: -Infinity, askFirstAt: 0, askDue: true,
      verified: false, reply: null, replySeenAt: 0, final: null, laid: null, task: null, forceClaim: false, forceFrom: null,
      forceReply: null, leaseUntil: null, forced: false, redo: null, retryAt: 0, tries: 0, endedAt: 0, seenAt: t,
    };
    jobs.set(k, j);
    if (!devices.byId.has(own.device)) devices.at = -Infinity; // a device made since the last read: read it again
    log(`${short(k)}: asking ${j.from.name} to hand it over${force ? ' (now)' : ''}`);
    kick();
    return jobJson(j);
  }
  function cancel(id) {
    const j = jobs.get(lower(id));
    if (!j || !ACTIVE.has(j.phase)) return false;
    if (j.phase === 'claiming' && j.task) return false; // the claim is on its way: too late
    j.endedAt = now();
    setJob(j, 'cancelled', { note: 'cancelled' });
    log(`${short(j.id)}: cancelled`);
    dropRows(j.id);
    kick();
    return true;
  }

  // ---------- every device: the watcher and the heartbeat ----------
  async function watch(list) {
    lastWatch = now();
    if (!Array.isArray(list) || !host) return;
    const own = ownersRaw(), held = heldNow();
    for (const p of list) {
      if (stopping) return;
      if (!p || !p.alive || typeof p.id !== 'string') continue;
      const id = p.id.toLowerCase();
      if (!UUID_RE.test(id) || !own.has(id) || held.has(id) || outs.has(id) || recentlyClaimed(id)) continue;
      let row;
      try { row = await getRow(id); } catch { continue; }
      const owner = row ? lower(row.owner_device) : '';
      if (!owner || owner === me) continue;
      if (busyNow(p, nullSince, now(), tm.nullIdleMs)) { logOnce(`watch|${id}`, `${short(id)}: ${nameOf(owner)} has it now; it ends here once Claude is idle`); continue; }
      try { await host.kill(p.id); log(`${short(id)}: ended here: ${nameOf(owner)} has it now`); } catch (e) { logOnce(`kill|${id}`, `${short(id)}: the session could not be ended (${clip(e && e.message)})`); }
    }
  }
  async function heartbeat(list) {
    const t = now();
    if (t - lastTouch >= tm.touchMs) {
      try { await C.touchDevice(api, me, { force: true, now: t }); lastTouch = t; } catch (e) { logOnce('touch', `last_seen_at not set (${clip(e && e.message)})`); }
    }
    if (t - lastLease < tm.leaseEveryMs) return;
    lastLease = t;
    const ids = [...new Set((Array.isArray(list) ? list : []).filter((p) => p && p.alive).map((p) => lower(p.id)).filter((id) => UUID_RE.test(id)))];
    if (!ids.length) return;
    try {
      await api.rest('PATCH', 'conversations', { query: { id: `in.(${ids.join(',')})`, owner_device: `eq.${me}` }, body: { lease_until: iso(t + tm.leaseForMs) }, prefer: 'return=minimal' });
    } catch (e) { logOnce('lease', `the leases were not renewed (${clip(e && e.message)})`); }
  }

  // ---------- the loop ----------
  let running = false, stopping = false, timer = null, ticking = null, again = false;
  const active = () => outs.size > 0 || [...jobs.values()].some((j) => ACTIVE.has(j.phase));
  async function tickOnce() {
    if (!me) {
      try { me = (await C.ensureDevice(api, dataDir)).toLowerCase(); } catch (e) { logOnce('device', `no device row (${clip(e && e.message)})`); return; }
    }
    try { await loadDevices(); } catch (e) { logOnce('devices', `the device names could not be read (${clip(e && e.message)})`); }
    letGo();
    try { await poll(); said.delete('poll'); } catch (e) { logOnce('poll', `the move requests could not be read (${clip(e && e.message)})`); writeAway(); return; }
    const list = await hostList();
    const guard = async (what, fn) => { try { await fn(); } catch (e) { log(`${what} failed: ${clip(e && e.message)}`); } };
    await guard('answering the requests', () => stepOwner(list));
    for (const j of [...jobs.values()]) { if (stopping) break; await guard(`${short(j.id)}`, () => stepJob(j)); }
    if (!stopping && now() - lastWatch >= tm.watchMs) await guard('the watcher', () => watch(list));
    if (!stopping) await guard('the heartbeat', () => heartbeat(list));
    writeAway();
    const t = now();
    for (const [id, j] of jobs) if (!ACTIVE.has(j.phase) && t - j.endedAt >= tm.jobKeepMs) jobs.delete(id);
  }
  // one tick at a time; a call while one runs waits for it and asks for one more after it
  function tick() {
    if (ticking) { again = true; return ticking; }
    ticking = tickOnce().catch((e) => log(`a tick failed: ${clip(e && e.message)}`)).finally(() => { ticking = null; });
    return ticking;
  }
  function schedule(ms) {
    if (!running) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(loop, ms);
    if (timer.unref) timer.unref();
  }
  async function loop() {
    timer = null;
    if (!running) return;
    await tick();
    const soon = again;
    again = false;
    schedule(soon ? 0 : active() ? tm.tickMs : tm.pollMs);
  }
  // something changed (a new job, a finished task): a tick soon instead of at the next poll
  function kick() { if (!running) return; if (ticking) again = true; else schedule(0); }
  function start() {
    if (running) return;
    running = true;
    stopping = false;
    schedule(0);
  }
  async function stop() {
    running = false;
    stopping = true;
    if (timer) { clearTimeout(timer); timer = null; }
    try { if (ticking) await ticking; } catch {}
    letGo(true);
  }
  // tests: every flush, pull, claim and row write under way, done
  async function settle() { while (tasks.size) await Promise.allSettled([...tasks]); }

  // conversations another device owns (live: its lease is ahead; account: its row's 'a' | 'b', the account it ran
  // under there, else null), with this device's own moves: moving 'here' (a job here, from the owner) or 'away'
  // (handing over to the requester)
  function owners() {
    const out = new Map(), t = now();
    for (const [id0, v] of ownersRaw()) {
      const id = lower(id0), d = lower(v && v.device);
      if (!d || d === me) continue;
      out.set(id, { device: d, name: nameOf(d), live: !!(v.leaseUntil && v.leaseUntil > t), moving: null, account: v.account === 'a' || v.account === 'b' ? v.account : null, bound: !!v.bound });
    }
    for (const [id, g] of gone) if (!listedSince(g.at) && !out.has(id)) out.set(id, { device: g.device, name: nameOf(g.device), live: false, moving: null, account: null, bound: false });
    for (const [id, j] of jobs) {
      if (!ACTIVE.has(j.phase)) continue;
      const e = out.get(id) || { device: j.from.device, name: nameOf(j.from.device, j.from.name), live: false, account: null, bound: false };
      out.set(id, { ...e, moving: 'here' });
    }
    for (const x of outs.values()) if (MOVING.has(x.phase)) out.set(x.id, { device: x.to, name: nameOf(x.to), live: false, moving: 'away', account: null, bound: false });
    for (const [id, at] of claimed) if (!listedSince(at)) out.delete(id);
    return out;
  }
  const device = () => (me ? { id: me, name: myName() } : null);
  // whether a device is there, for sync-live.js (it trusts a snapshot only while its device is): true once its
  // last_seen_at was seen changing and did within offlineMs on this clock; false once it sat unchanged that long (or the
  // table, read, has no such device); null while that is not known yet: since this device started, before it was seen
  // moving, or while this device's own reads of the table have stopped (no network here says nothing of the other)
  const online = (id) => {
    if (!(devices.at > -Infinity) || now() - devices.at > 3 * tm.devicesMs) return null;
    const d = devices.byId.get(lower(id));
    if (!d) return false;
    if (isOffline(id)) return false;
    return d.moved ? true : null;
  };
  // the page asks every second while it shows the job; that keeps it going (unwatchedMs)
  const status = (id) => { const j = jobs.get(lower(id)); if (!j) return null; j.seenAt = now(); return jobJson(j); };
  const outgoing = () => [...outs.values()].map((x) => ({ id: x.id, to: x.to, phase: x.phase, force: x.force, held: x.held, note: x.note }));

  return { start, stop, tick, settle, move, status, cancel, owners, device, online, outgoing };
}

module.exports = { createMover, awayPath, dropAway, resumeFolder, trustedIn, findLogIn, busyNow, TIMING };
