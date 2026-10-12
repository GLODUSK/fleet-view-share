// link.js: the link between Henry's machines (docs/link.md, the contract). One machine calls another's routes the way
// the phone does: through the other machine's relay.js, on a private Supabase Realtime channel, in envelopes only the
// two machines can open. This is the phone's side of docs/phone.md in Node (no npm package), with the machine in the
// phone's place; relay.js serves the other side, where this machine is a device of kind 'computer'.
//
// Pairing (once per pair of machines) runs over fleet_sync.settings rows, sealed with the sync key like the mover's
// (sync-crypto.js sealText(json, key, 'setting:<key>'), upserted on (user_id, key)). The sync key alone must never be
// enough to link a machine (anyone who can read the settings table as Henry has it), so the keys come from an X25519
// exchange whose 6-digit code Henry compares on both screens, and the requester commits to its key before it sees the
// other's (as ZRTP and Bluetooth's numeric comparison do): whoever carries the rows can't steer the two codes to match.
//   link:<pid>:ask      the requester R: { v: 1, pid, from: R, fromName, to: A, commit, at }, commit = b64u(sha256(
//                       'fleet-view link v1 commit' || epkR || nR)), nR 16 random bytes
//   link:<pid>:answer   the answerer A: { v: 1, pid, from: A, fromName, to: R, epk: b64u(epkA), at }
//   link:<pid>:reveal   R, only after it read the answer: { v: 1, pid, epk: b64u(epkR), n: b64u(nR), at }. A checks it
//                       against the commit (a mismatch: "no", nothing is linked)
//   link:<pid>:ok-r / ok-a     Henry confirmed the code on that side: { v: 1, pid, at }
//   link:<pid>:done-r / done-a that side keeps the link now: { v: 1, pid, at }
//   link:<pid>:no       { v: 1, pid, by: 'r' | 'a', why: 'declined' | 'mismatch' | 'expired' | 'restarted', at }
// pid: 16 hex digits. Both sides derive, from the shared secret and the whole transcript T (the length-prefixed
// 'fleet-view link v1', pid, R, A, commit, epkA, epkR, nR): salt = sha256(T), then HKDF-SHA256(shared, salt, info
// 'fleet-view link v1 <x>') for x in 'key r-a' and 'key a-r' (32 bytes each: R's calls to A, and A's calls to R),
// 'dev r-a' and 'dev a-r' (12 bytes each, b64u: the two relay device ids), and 'code' (4 bytes, mod 1,000,000, six
// digits). The code shows on both pages once each side has what it needs (R after the answer, A after the reveal).
// Nothing is kept until Henry confirmed on BOTH machines (each will run what the other sends): a side keeps the link
// when it has its own confirm and sees the other's ok row, then writes done. The requester deletes the rows once it
// sees the answerer's done. A "no" from the other side ends it (and takes back a link already kept). A pairing runs out
// 10 minutes after it began on that side's clock (never compared with the other machine's); R then says no, and A
// drops what it has. An ask whose answer row is there but which this machine has no memory of (it restarted mid-way)
// is answered no ('restarted'). Rows are polled every 5 s, every second while a pairing is under way.
//
// Keeping a link: relay.addComputer({ dev: the incoming id, name, peer, key: the incoming key }), so the other machine
// may call this one; and here the outgoing id and key, so this one may call it: <dataDir>/link/peers.json { v: 1,
// peers: [{ peer, name, dev, pairedAt }] } (no key), the keys in sync-api.js protectedStore(<dataDir>/link,
// 'link-keys') as { <peer>: { dev, k } } (read only while a peer is listed). Unlink takes both away (relay
// removeComputer sends the other machine's link the notice 'revoked', and it unlinks too) and writes
// link-gone:<to>:<from> { v: 1, from, to, devs, at } for a machine that is off: it unlinks when it reads it (only a link
// whose ids are in devs), and deletes the row. Keeping a new link deletes the gone rows between the two.
//
// Calls: one channel per linked machine, fleet:<uid>:<its outgoing dev>, joined with presence key 'peer' (the relay
// tracks 'pc' there: online). Envelopes, keys (dirKey up/down of the outgoing key), the AAD, compression, parts (at
// most 64, 20 a second up), the 5-minute skew and the 10-minute nonce window are docs/phone.md's. On every join it
// says hello (no epk) and reads the other's name and version. call() sends a req and waits for its res: the same id
// again (a new nonce and at, the same t0) every 8 s and after every rejoin, which the relay answers from what it kept
// (a POST never runs twice; one it can't tell about gets 409 restarted or expired), for the route's time on the relay
// plus 5 s. The notice 'pc-closing' fails what is in flight (code 'pc-restarted': a POST may have gone in); 'revoked'
// unlinks.
//
//   createLink({ api, key, dataDir, log, relay, device, now, timing, name, version, WebSocketImpl, timers, keyStore,
//                readConfig })
//     -> { start(), stop(), tick(), status(), peers(), online(deviceId), call(deviceId, m, p, { q, b, etag, timeoutMs }),
//          request(deviceId), confirm(pid), decline(pid), unlink(deviceId) }
//   api: sync-api.js createSync()'s object (rest, uid, accessToken); key: the 32-byte sync key (the rows); relay:
//   relay.js createRelay()'s object (addComputer, removeComputer); device() -> this machine's sync device id (or
//   { id }), null until the mover made it; name: this machine's (os.hostname()); version (string or function)
//   online(id) -> true (its relay is on the channel), false (it is not), null (not linked, or not known yet)
//   call(...) -> Promise of { s, b?, b64?, ct?, etag? }, never rejected: the other server's answer, or s 0 and
//     b: { ok: false, code, message } when none came: code 'not_linked', 'offline', 'timeout', 'pc-restarted',
//     'revoked', 'stopped', 'too_large'
//   request / confirm / decline / unlink -> Promise of [http status, json] (the routes' answers)
//   status() -> { running, me: { id, name }, machines: [{ id, name, platform, lastSeenAt, linked, online, pairedAt,
//     version }], pairings: [{ pid, role: 'request' | 'answer', peer: { id, name }, state, code?, confirmedHere,
//     message?, at }] }; state: asking | waiting | confirm | confirmed | linked | declined | failed | expired | cancelled
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const S = require(path.join(__dirname, 'sync-api.js'));
const K = require(path.join(__dirname, 'sync-crypto.js'));
const R = require(path.join(__dirname, 'relay.js'));
const RT = require(path.join(__dirname, 'realtime.js'));

const TIMING = {
  pollMs: 5e3, // the rows, while no pairing is under way
  pairPollMs: 1e3, // and while one is
  pairMs: 10 * 60e3, // a pairing runs out this long after it began (on each side's own clock)
  keepFinalMs: 60e3, // a finished pairing stays in status() this long
  devicesMs: 30e3, // the devices table (names) at most this often
  resendMs: 8e3, // a request still waiting goes again this often
  callExtraMs: 5e3, // on top of the relay's time for the route
  partsPerS: 20, // parts up, at most this many a second (the relay takes 30 envelopes a second)
};
const PREFIX = 'fleet-view link v1';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PID_RE = /^[0-9a-f]{16}$/;
const DEV_RE = /^[A-Za-z0-9_-]{16}$/;
const ROW_RE = /^link:([0-9a-f]{16}):(ask|answer|reveal|ok-r|ok-a|done-r|done-a|no)$/;
const GONE_RE = /^link-gone:([0-9a-f-]{36}):([0-9a-f-]{36})$/;
const SKEW_MS = 5 * 60e3, NONCE_MS = 10 * 60e3, ASSEMBLY_MS = 60e3, ASSEMBLIES_MAX = 4, INFLATE_MAX = 64 << 20;
const WAIT_CAP_S = 50;
const FINAL = new Set(['linked', 'declined', 'failed', 'expired', 'cancelled']);
const INCOMING_MAX = 3; // pairings another machine asked for, at once

const lower = (s) => (typeof s === 'string' ? s.toLowerCase() : '');
const short = (id) => String(id || '').slice(0, 8);
const clip = (s, n = 100) => String(s == null ? '' : s).replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, n);
const b64u = (b) => Buffer.from(b).toString('base64url');
const fromB64u = (s, len) => {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]+$/.test(s)) return null;
  const b = Buffer.from(s, 'base64url');
  return b64u(b) === s && (!len || b.length === len) ? b : null;
};
const errText = (e) => clip((e && e.message) || e, 200);

// ---------- the exchange ----------
const X_PUB = Buffer.from('302a300506032b656e032100', 'hex');
// the X25519 shared secret of mine (a private KeyObject) and theirs (32 raw bytes), or null (not a usable key: not 32
// bytes, or one whose secret is all zeros)
function sharedSecret(priv, theirs) {
  if (!Buffer.isBuffer(theirs) || theirs.length !== 32) return null;
  let s;
  try { s = crypto.diffieHellman({ privateKey: priv, publicKey: crypto.createPublicKey({ key: Buffer.concat([X_PUB, theirs]), format: 'der', type: 'spki' }) }); } catch { return null; }
  return s.some((x) => x) ? s : null;
}
const commitOf = (epk, n) => b64u(crypto.createHash('sha256').update(Buffer.concat([Buffer.from(`${PREFIX} commit`, 'utf8'), epk, n])).digest());
// the transcript, every field length-prefixed so no two transcripts read alike
function transcript(f) {
  const parts = [PREFIX, f.pid, f.r, f.a, f.commit, f.epkA, f.epkR, f.nR].map((x) => (Buffer.isBuffer(x) ? x : Buffer.from(String(x), 'utf8')));
  return Buffer.concat(parts.flatMap((b) => { const l = Buffer.alloc(4); l.writeUInt32BE(b.length); return [l, b]; }));
}
// -> { kRA, kAR, devRA, devAR, code }
function derive(shared, f) {
  const salt = crypto.createHash('sha256').update(transcript(f)).digest();
  const hk = (info, n) => Buffer.from(crypto.hkdfSync('sha256', shared, salt, Buffer.from(`${PREFIX} ${info}`, 'utf8'), n));
  return {
    kRA: hk('key r-a', 32), kAR: hk('key a-r', 32), devRA: b64u(hk('dev r-a', 12)), devAR: b64u(hk('dev a-r', 12)),
    code: String(hk('code', 4).readUInt32BE(0) % 1e6).padStart(6, '0'),
  };
}

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try { fs.writeFileSync(tmp, data, { mode: 0o600 }); fs.renameSync(tmp, file); } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch {} throw e; }
}

function createLink(o = {}) {
  const api = o.api;
  if (!api || typeof api.rest !== 'function') throw new Error('createLink needs the sync api');
  const key = o.key;
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('createLink needs the 32-byte sync key');
  const dataDir = o.dataDir;
  if (typeof dataDir !== 'string' || !dataDir) throw new Error('createLink needs the data folder');
  const relay = o.relay;
  if (!relay || typeof relay.addComputer !== 'function' || typeof relay.removeComputer !== 'function') throw new Error('createLink needs the relay (addComputer, removeComputer)');
  const log = typeof o.log === 'function' ? (t) => { try { o.log(`link: ${t}`); } catch {} } : () => {};
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const tm = { ...TIMING, ...(o.timing && typeof o.timing === 'object' ? o.timing : {}) };
  const T = o.timers || { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h) };
  const later = (fn, ms) => { const h = T.setTimeout(fn, ms); if (h && typeof h.unref === 'function') h.unref(); return h; };
  const cancel = (h) => { if (h) T.clearTimeout(h); };
  const deviceOf = typeof o.device === 'function' ? o.device : () => o.device;
  const myName = () => clip(typeof o.name === 'function' ? o.name() : o.name || os.hostname(), 100) || 'this machine';
  const version = () => { try { return String((typeof o.version === 'function' ? o.version() : o.version) || ''); } catch { return ''; } };
  const readConfig = typeof o.readConfig === 'function' ? o.readConfig : () => (S.readConfig(dataDir) || {}).config || null;
  const linkDir = path.join(dataDir, 'link');
  const peersFile = path.join(linkDir, 'peers.json');
  let keyStore = o.keyStore || null;
  const store = () => keyStore || (keyStore = S.protectedStore(linkDir, 'link-keys'));
  const said = new Map();
  const logOnce = (k, t) => { if (said.get(k) === t) return; said.set(k, t); log(t); };
  const seal = (k, v) => K.sealText(JSON.stringify(v), key, `setting:${k}`);

  let me = null, uid = null, running = false, timer = null, ticking = null, again = false;
  // ---------- the machines (the devices table) ----------
  const devices = { at: -Infinity, byId: new Map() }; // id -> { name, platform, lastSeenAt }
  async function loadDevices(force) {
    if (!force && now() - devices.at < tm.devicesMs) return;
    const rows = await api.rest('GET', 'devices', { query: { select: 'id,name,platform,last_seen_at' } });
    const byId = new Map();
    for (const d of Array.isArray(rows) ? rows : []) {
      if (!d || !UUID_RE.test(lower(d.id))) continue;
      byId.set(lower(d.id), { name: clip(d.name, 100) || null, platform: clip(d.platform, 20) || null, lastSeenAt: typeof d.last_seen_at === 'string' ? d.last_seen_at : null });
    }
    devices.byId = byId;
    devices.at = now();
  }
  const nameOf = (id, fallback) => (devices.byId.get(lower(id)) || {}).name || fallback || 'another computer';

  // ---------- the linked machines ----------
  const peers = new Map(); // peer id -> { peer, name, dev, k, pairedAt }
  let keysRead = false;
  async function loadPeers() {
    let j = null;
    try { j = JSON.parse(fs.readFileSync(peersFile, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') logOnce('peers', `peers.json could not be read: ${errText(e)}`); return; }
    const list = (Array.isArray(j && j.peers) ? j.peers : []).filter((p) => p && UUID_RE.test(lower(p.peer)) && DEV_RE.test(String(p.dev)));
    if (!list.length) return;
    let ks = {};
    try { const text = await store().read(); ks = text ? JSON.parse(text) : {}; keysRead = true; } catch (e) { logOnce('keys', `the link keys could not be read: ${errText(e)}`); return; }
    for (const p of list) {
      const id = lower(p.peer), e = ks && ks[id];
      const k = e && e.dev === p.dev ? fromB64u(e.k, 32) : null;
      if (!k) { logOnce(`nokey|${id}`, `${short(id)} has no key here: link it again`); continue; }
      peers.set(id, { peer: id, name: clip(p.name, 100) || 'another computer', dev: p.dev, k, pairedAt: Number(p.pairedAt) || null });
    }
  }
  let keyWrites = Promise.resolve();
  function savePeers() {
    try { writeAtomic(peersFile, `${JSON.stringify({ v: 1, peers: [...peers.values()].map((p) => ({ peer: p.peer, name: p.name, dev: p.dev, pairedAt: p.pairedAt })) }, null, 2)}\n`); } catch (e) { log(`peers.json could not be saved: ${errText(e)}`); }
    const text = JSON.stringify(Object.fromEntries([...peers.values()].map((p) => [p.peer, { dev: p.dev, k: b64u(p.k) }])));
    const empty = !peers.size;
    keyWrites = keyWrites.catch(() => {}).then(() => (empty ? (keysRead || fs.existsSync(peersFile) ? store().clear() : null) : store().write(text)));
    return keyWrites;
  }

  // ---------- the channels: one per linked machine ----------
  let rt = null;
  const conns = new Map(); // peer -> conn
  function realtime() {
    if (!rt) {
      rt = RT.createRealtime({
        readConfig, accessToken: () => api.accessToken(), presenceKey: 'peer', presence: () => ({ role: 'peer', v: 1 }),
        log: (t) => logOnce(`rt|${t}`, t), now, timers: o.timers, WebSocketImpl: o.WebSocketImpl,
      });
    }
    return rt;
  }
  function openConn(p) {
    if (!uid || conns.has(p.peer)) return;
    const topic = R.topicOf(uid, p.dev);
    const conn = {
      peer: p.peer, dev: p.dev, topic, up: R.dirKey(p.k, 'up'), down: R.dirKey(p.k, 'down'), ch: null,
      pending: new Map(), nonces: new Map(), parts: new Map(), pcName: null, version: null, helloId: null, dropped: 0,
    };
    conns.set(p.peer, conn);
    conn.ch = realtime().channel(topic, {
      onBroadcast: (env) => onDown(conn, env),
      onState: (st) => { if (st === 'joined') joined(conn); },
      onPresence: () => { if (conn.ch && conn.ch.present('pc')) for (const r of conn.pending.values()) resend(conn, r); },
    });
  }
  function closeConn(peer, why) {
    const conn = conns.get(peer);
    if (!conn) return;
    conns.delete(peer);
    try { conn.ch.leave(); } catch {}
    for (const r of [...conn.pending.values()]) finishCall(conn, r, null, why || 'stopped');
  }
  function syncConns() {
    for (const peer of [...conns.keys()]) {
      const p = peers.get(peer), c = conns.get(peer);
      if (!p || !uid || c.topic !== R.topicOf(uid, p.dev)) closeConn(peer, p ? 'stopped' : 'not_linked');
    }
    for (const p of peers.values()) openConn(p);
  }
  // a fresh join: hello (its answer says the other machine's name and version), and every request still waiting again
  function joined(conn) {
    const id = b64u(crypto.randomBytes(12));
    conn.helloId = id;
    sendText(conn, id, JSON.stringify({ t: 'hello', id, at: now(), app: version(), device: myName() }));
    for (const r of conn.pending.values()) resend(conn, r);
  }
  // one message's JSON text up: one envelope, or its parts (20 a second)
  function sendText(conn, id, text) {
    const ch = conn.ch;
    if (!ch || ch.state !== 'joined') return false;
    if (text.length <= R.PART_MAX) return ch.send(R.seal(conn.up, conn.topic, conn.dev, 'up', text));
    const list = R.slices(text);
    if (list.length > R.PARTS_MAX) return false;
    const at = now(), per = Math.max(1, tm.partsPerS);
    const batch = (from) => {
      if (conns.get(conn.peer) !== conn || ch.state !== 'joined') return;
      for (let i = from; i < Math.min(list.length, from + per); i++) ch.send(R.seal(conn.up, conn.topic, conn.dev, 'up', JSON.stringify({ t: 'part', id, at, part: i, parts: list.length, chunk: list[i] })));
      if (from + per < list.length) later(() => batch(from + per), 1000);
    };
    batch(0);
    return true;
  }
  // ---------- what comes down ----------
  function onDown(conn, env) {
    if (conns.get(conn.peer) !== conn || !env || typeof env !== 'object' || typeof env.n !== 'string') return;
    const t = now();
    for (const [n, at] of conn.nonces) { if (t - at <= NONCE_MS) break; conn.nonces.delete(n); }
    if (conn.nonces.has(env.n)) return void conn.dropped++;
    const r = R.decrypt(conn.down, conn.topic, conn.dev, 'down', env);
    if (!r) return void conn.dropped++;
    conn.nonces.set(env.n, t);
    let msg = null;
    try { msg = JSON.parse((r.z ? zlib.inflateRawSync(r.plain, { maxOutputLength: INFLATE_MAX }) : r.plain).toString('utf8')); } catch {}
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string' || typeof msg.id !== 'string' || !Number.isFinite(msg.at) || Math.abs(msg.at - t) > SKEW_MS) return void conn.dropped++;
    if (msg.t === 'part') return onPart(conn, msg);
    onMessage(conn, msg);
  }
  function onPart(conn, msg) {
    const { id, part, parts, chunk } = msg;
    const t = now();
    for (const [k, a] of conn.parts) if (t - a.at > ASSEMBLY_MS) conn.parts.delete(k);
    if (!Number.isInteger(parts) || parts < 1 || parts > R.PARTS_MAX || !Number.isInteger(part) || part < 0 || part >= parts || typeof chunk !== 'string' || chunk.length > R.PART_MAX) return;
    let a = conn.parts.get(id);
    if (!a) {
      if (conn.parts.size >= ASSEMBLIES_MAX) return;
      a = { parts, chunks: new Array(parts), got: 0, at: t };
      conn.parts.set(id, a);
    }
    if (a.parts !== parts || a.chunks[part] !== undefined) return;
    a.chunks[part] = chunk;
    if (++a.got < parts) return;
    conn.parts.delete(id);
    let whole = null;
    try { whole = JSON.parse(a.chunks.join('')); } catch {}
    if (whole && typeof whole === 'object' && whole.t !== 'part' && whole.id === id) onMessage(conn, whole);
  }
  function onMessage(conn, msg) {
    if (msg.t === 'res') {
      if (msg.id === conn.helloId) {
        conn.helloId = null;
        if (msg.s === 200 && msg.b && typeof msg.b === 'object') { conn.pcName = clip(msg.b.pcName, 100) || null; conn.version = clip(msg.b.version, 40) || null; }
        else logOnce(`hello|${conn.peer}`, `${nameOf(conn.peer)} answered hello with ${msg.s}`);
        return;
      }
      const r = conn.pending.get(msg.id);
      if (!r) return; // late, or doubled
      const { t: _t, id: _id, at: _at, ...res } = msg;
      return finishCall(conn, r, res);
    }
    if (msg.t === 'notice') {
      if (msg.kind === 'pc-closing') for (const r of [...conn.pending.values()]) finishCall(conn, r, null, 'pc-restarted');
      else if (msg.kind === 'revoked') { log(`${nameOf(conn.peer)} unlinked this machine`); unlinkHere(conn.peer, 'unlinked on the other machine').catch(() => {}); }
    }
  }

  // ---------- calls ----------
  const CODES = {
    not_linked: (n) => `${n} is not linked with this machine`,
    offline: (n) => `${n} is offline`,
    timeout: (n) => `${n} did not answer`,
    'pc-restarted': (n) => `Fleet View on ${n} restarted while this was on its way: check before sending again`,
    revoked: (n) => `${n} unlinked this machine`,
    stopped: () => 'the link stopped on this machine',
    too_large: () => 'too large to send',
  };
  const linkFail = (code, peer) => ({ s: 0, b: { ok: false, code, message: CODES[code](nameOf(peer)) } });
  function finishCall(conn, r, res, code) {
    if (conn.pending.get(r.id) !== r) return;
    conn.pending.delete(r.id);
    cancel(r.timer); cancel(r.again);
    r.resolve(res || linkFail(code, conn.peer));
  }
  // (not joined: nothing goes now; the next resend, the join or the other machine's presence sends it)
  function resend(conn, r) {
    if (conn.pending.get(r.id) !== r) return;
    cancel(r.again);
    r.msg.at = now();
    sendText(conn, r.id, JSON.stringify(r.msg));
    r.again = later(() => resend(conn, r), tm.resendMs);
  }
  function call(deviceId, m, p, opt = {}) {
    const peer = lower(deviceId);
    const conn = conns.get(peer);
    if (!running || !peers.has(peer)) return Promise.resolve(linkFail(running ? 'not_linked' : 'stopped', peer));
    if (!conn) return Promise.resolve(linkFail('offline', peer));
    if (conn.ch && conn.ch.present('pc') === false) return Promise.resolve(linkFail('offline', peer));
    const id = b64u(crypto.randomBytes(16)), t0 = now();
    const msg = { t: 'req', id, at: t0, m, p, t0 };
    if (opt.q && typeof opt.q === 'object') msg.q = opt.q;
    if (m === 'POST') msg.b = opt.b && typeof opt.b === 'object' ? opt.b : {};
    if (typeof opt.etag === 'string') msg.etag = opt.etag;
    let waitS = 0;
    const b = msg.b;
    if (b && typeof p === 'string' && p.startsWith('/api/') && 'wait' in b && b.wait !== false && b.wait !== null && b.wait !== 0) waitS = typeof b.wait === 'number' && b.wait > 0 ? Math.min(WAIT_CAP_S, Math.ceil(b.wait)) : WAIT_CAP_S;
    const ms = Number(opt.timeoutMs) > 0 ? Number(opt.timeoutMs) : R.routeTimeout(m, p, waitS) + tm.callExtraMs;
    return new Promise((resolve) => {
      const r = { id, msg, resolve, timer: null, again: null };
      const text = JSON.stringify(msg);
      if (text.length > R.PART_MAX && R.slices(text).length > R.PARTS_MAX) return resolve(linkFail('too_large', peer));
      conn.pending.set(id, r);
      r.timer = later(() => finishCall(conn, r, null, conn.ch && conn.ch.present('pc') === false ? 'offline' : 'timeout'), ms);
      resend(conn, r);
    });
  }
  function online(deviceId) {
    const conn = conns.get(lower(deviceId));
    if (!conn || !conn.ch) return null;
    return conn.ch.present('pc');
  }

  // ---------- the rows ----------
  function putRow(k, v) {
    return api.rest('POST', 'settings', { query: { on_conflict: 'user_id,key' }, prefer: 'resolution=merge-duplicates,return=minimal', body: { key: k, value_enc: seal(k, v) } });
  }
  const putStep = (x, step, v) => putRow(`link:${x.pid}:${step}`, { v: 1, pid: x.pid, at: now(), ...v });
  const dropRows = (pid) => api.rest('DELETE', 'settings', { query: { key: `like.link:${pid}:*` }, prefer: 'return=minimal' }).catch((e) => log(`${pid}: the rows could not be deleted (${errText(e)})`));
  // -> { pids: Map pid -> { <step>: value }, gone: [{ key, v }] }
  async function readRows() {
    const rows = await api.rest('GET', 'settings', { query: { select: 'key,value_enc', key: 'like.link*' } });
    const pids = new Map(), gone = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      const k = row && typeof row.key === 'string' ? row.key : '';
      const m = ROW_RE.exec(k), g = GONE_RE.exec(k);
      if (!m && !g) continue;
      let v = null;
      try { v = JSON.parse(K.openText(row.value_enc, key, `setting:${k}`)); } catch {}
      if (!v || v.v !== 1) { logOnce(`bad|${k}`, `a row that does not open with this key (${k.slice(0, 30)}): ignored`); continue; }
      if (g) { gone.push({ key: k, to: g[1], from: g[2], v }); continue; }
      if (v.pid !== m[1]) continue;
      if (!pids.has(m[1])) pids.set(m[1], {});
      pids.get(m[1])[m[2]] = v;
    }
    return { pids, gone };
  }

  // ---------- pairings ----------
  const pairings = new Map(); // pid -> x
  const seenPids = new Map(); // pid -> when this machine was done with it (so leftovers are not taken up again)
  const active = () => [...pairings.values()].some((x) => !FINAL.has(x.state));
  function setState(x, state, message) {
    x.state = state;
    if (message !== undefined) x.message = message;
    if (FINAL.has(state)) { x.endedAt = now(); seenPids.set(x.pid, now()); x.priv = null; }
  }
  async function request(deviceId) {
    if (!running) return [503, { ok: false, message: 'the link is not running' }];
    if (!me) return [503, { ok: false, message: 'this machine has no sync device id yet: try again in a moment' }];
    const peer = lower(deviceId);
    if (!UUID_RE.test(peer) || peer === me) return [400, { ok: false, message: 'device must be another machine\'s sync device id' }];
    try { await loadDevices(true); } catch {}
    if (devices.at > -Infinity && !devices.byId.has(peer)) return [404, { ok: false, message: 'no such machine in sync' }];
    for (const x of pairings.values()) if (x.peer === peer && !FINAL.has(x.state)) return [409, { ok: false, message: `a link with ${nameOf(peer)} is being made already`, pid: x.pid }];
    const pid = crypto.randomBytes(8).toString('hex'), pair = R.xPair(), n = crypto.randomBytes(16);
    const x = { pid, role: 'r', peer, peerName: nameOf(peer), state: 'asking', startedAt: now(), priv: pair.priv, pub: pair.pub, n, commit: commitOf(pair.pub, n), code: null, derived: null, okMine: false, message: null };
    try { await putStep(x, 'ask', { from: me, fromName: myName(), to: peer, commit: x.commit }); } catch (e) { return [502, { ok: false, message: `the request could not be written: ${errText(e)}` }]; }
    pairings.set(pid, x);
    log(`${pid}: asked ${x.peerName} to link`);
    kick();
    return [200, { ok: true, pid }];
  }
  async function confirm(pid) {
    const x = pairings.get(String(pid || ''));
    if (!x) return [404, { ok: false, message: 'no such link request' }];
    if (x.state !== 'confirm') return [409, { ok: false, message: x.state === 'confirmed' ? 'confirmed already' : `it can't be confirmed now (${x.state})` }];
    try { await putStep(x, x.role === 'r' ? 'ok-r' : 'ok-a', {}); } catch (e) { return [502, { ok: false, message: `the confirmation could not be written: ${errText(e)}` }]; }
    x.okMine = true;
    setState(x, 'confirmed');
    kick();
    return [200, { ok: true }];
  }
  async function decline(pid) {
    const x = pairings.get(String(pid || ''));
    if (!x) return [404, { ok: false, message: 'no such link request' }];
    if (FINAL.has(x.state)) return [200, { ok: true }];
    // the rows stay: the other machine reads the "no" (and takes back a link it may have kept), then deletes them
    await say(x, 'declined');
    setState(x, 'declined', 'Declined here.');
    return [200, { ok: true }];
  }
  const say = (x, why) => putStep(x, 'no', { by: x.role, why }).catch((e) => log(`${x.pid}: "no" could not be written (${errText(e)})`));
  // both sides' keys and ids, from the shared secret and the transcript
  function deriveFor(x, epkA, epkR, nR) {
    const shared = sharedSecret(x.priv, x.role === 'r' ? epkA : epkR);
    if (!shared) return null;
    const r = x.role === 'r' ? me : x.peer, a = x.role === 'r' ? x.peer : me;
    return derive(shared, { pid: x.pid, r, a, commit: x.commit, epkA, epkR, nR });
  }
  // the link kept on this side: the relay serves the other machine, and this one may call it
  async function keep(x) {
    const d = x.derived, isR = x.role === 'r';
    const name = clip(x.peerName, 60) || nameOf(x.peer);
    await relay.addComputer({ dev: isR ? d.devAR : d.devRA, name, peer: x.peer, key: isR ? d.kAR : d.kRA });
    const old = peers.get(x.peer);
    if (old) closeConn(x.peer, 'not_linked');
    peers.set(x.peer, { peer: x.peer, name, dev: isR ? d.devRA : d.devAR, k: isR ? d.kRA : d.kAR, pairedAt: now() });
    await savePeers();
    // gone rows from an older link between the two would take this one away
    await api.rest('DELETE', 'settings', { query: { key: `in.("link-gone:${x.peer}:${me}","link-gone:${me}:${x.peer}")` }, prefer: 'return=minimal' }).catch(() => {});
    syncConns();
    log(`${x.pid}: linked with ${name}`);
  }
  // take back a link kept here by this pairing (the other machine said no after all)
  async function unkeep(x) {
    const p = peers.get(x.peer), d = x.derived;
    if (!p || !d || (p.dev !== d.devRA && p.dev !== d.devAR)) return;
    await unlinkHere(x.peer, 'the other machine did not finish linking');
  }
  // Who deletes the rows: the side that reads the other's "no" (after it took back a link it kept), the requester once
  // it read the answerer's done, and the answerer when its own pairing ran out. A side that says "no" leaves them for
  // the other to read (they go anyway pairMs after its pairing ended). So a link kept on one side is never left there
  // alone: the other side either keeps it too or says no, and rows vanish under a kept link only after both kept it.
  async function stepPairing(x, rows, t) {
    const r = rows || {};
    const other = x.role === 'r' ? 'a' : 'r';
    const no = r.no && r.no.by === other ? r.no : null;
    if (x.state === 'linked') {
      if (no) { await unkeep(x); setState(x, 'failed', `${x.peerName} did not finish linking: nothing was kept.`); await dropRows(x.pid); x.cleaned = true; return; }
      if (x.role === 'r' && r['done-a'] && rows) { await dropRows(x.pid); x.cleaned = true; }
      if (!rows) x.cleaned = true;
      return;
    }
    if (FINAL.has(x.state)) return;
    if (no) {
      const why = no.why === 'mismatch' ? `${x.peerName} refused it: the keys did not match what was promised, so someone may be in the middle. Nothing was linked.`
        : no.why === 'expired' ? 'The request ran out: try again.' : no.why === 'restarted' ? `Fleet View on ${x.peerName} restarted mid-way: try again.` : `Declined on ${x.peerName}.`;
      setState(x, no.why === 'mismatch' ? 'failed' : no.why === 'expired' ? 'expired' : 'declined', why);
      await dropRows(x.pid);
      x.cleaned = true;
      return;
    }
    if (!rows || (x.role === 'r' && !r.ask)) { setState(x, 'cancelled', 'The request went away.'); x.cleaned = true; return; }
    if (t - x.startedAt > tm.pairMs) {
      setState(x, 'expired', 'The request ran out: try again.');
      if (x.role === 'r') await say(x, 'expired'); else { await dropRows(x.pid); x.cleaned = true; }
      return;
    }
    if (x.role === 'r') {
      if (x.state === 'asking' && r.answer) {
        const v = r.answer, epkA = fromB64u(v.epk, 32);
        if (lower(v.from) !== x.peer || lower(v.to) !== me || !epkA) { setState(x, 'failed', 'The answer did not fit the request.'); await say(x, 'mismatch'); return; }
        const d = deriveFor(x, epkA, x.pub, x.n);
        if (!d) { setState(x, 'failed', 'The other machine\'s key is not usable.'); await say(x, 'mismatch'); return; }
        if (typeof v.fromName === 'string' && v.fromName) x.peerName = clip(v.fromName, 100);
        await putStep(x, 'reveal', { epk: b64u(x.pub), n: b64u(x.n) });
        x.derived = d;
        x.code = d.code;
        setState(x, 'confirm');
      }
    } else if (x.state === 'waiting' && r.reveal) {
      const epkR = fromB64u(r.reveal.epk, 32), nR = fromB64u(r.reveal.n, 16);
      if (!epkR || !nR || commitOf(epkR, nR) !== x.commit) {
        setState(x, 'failed', `What ${x.peerName} sent did not match what it promised, so someone may be in the middle. Nothing was linked.`);
        await say(x, 'mismatch');
        return;
      }
      const d = deriveFor(x, x.pub, epkR, nR);
      if (!d) { setState(x, 'failed', 'The other machine\'s key is not usable.'); await say(x, 'mismatch'); return; }
      x.derived = d;
      x.code = d.code;
      setState(x, 'confirm');
    }
    if (x.state === 'confirmed' && x.okMine && r[other === 'a' ? 'ok-a' : 'ok-r']) {
      if (x.role === 'r') x.sawOkA = true;
      try { await keep(x); } catch (e) { setState(x, 'failed', `It could not be kept on this machine: ${errText(e)}`); await say(x, 'declined'); return; }
      await putStep(x, x.role === 'r' ? 'done-r' : 'done-a', {}).catch((e) => log(`${x.pid}: done could not be written (${errText(e)})`));
      setState(x, 'linked', `Linked with ${x.peerName}.`);
      x.endedAt = now();
    }
  }
  // asks addressed to this machine that it has not taken up yet
  async function takeAsks(pids) {
    for (const [pid, r] of pids) {
      if (pairings.has(pid) || !r.ask) continue;
      const mine = lower(r.ask.from) === me || lower(r.ask.to) === me;
      // rows of a pairing this machine was done with that nobody deleted (the other machine went away): gone after pairMs
      if (seenPids.has(pid)) { if (mine && now() - seenPids.get(pid) > tm.pairMs) { await dropRows(pid); seenPids.delete(pid); } continue; }
      // this machine's own ask from before it restarted: its key is gone, so it says no (the other side deletes)
      if (lower(r.ask.from) === me) {
        seenPids.set(pid, now());
        if (!r.no) await putRow(`link:${pid}:no`, { v: 1, pid, by: 'r', why: 'restarted', at: now() }).catch(() => {});
        continue;
      }
      if (lower(r.ask.to) !== me) continue;
      const from = lower(r.ask.from);
      if (!UUID_RE.test(from) || from === me || typeof r.ask.commit !== 'string' || !fromB64u(r.ask.commit, 32)) continue;
      if (r.no) continue;
      // only a machine sync lists (once the table was read)
      if (devices.at > -Infinity && !devices.byId.has(from)) continue;
      if (r.answer) {
        // answered before this machine restarted: the key that answer named is gone
        seenPids.set(pid, now());
        await putRow(`link:${pid}:no`, { v: 1, pid, by: 'a', why: 'restarted', at: now() }).catch(() => {});
        continue;
      }
      if ([...pairings.values()].filter((x) => x.role === 'a' && !FINAL.has(x.state)).length >= INCOMING_MAX) continue;
      const pair = R.xPair();
      const x = { pid, role: 'a', peer: from, peerName: clip(r.ask.fromName, 100) || nameOf(from), state: 'waiting', startedAt: now(), priv: pair.priv, pub: pair.pub, commit: r.ask.commit, code: null, derived: null, okMine: false, message: null };
      try { await putStep(x, 'answer', { from: me, fromName: myName(), to: from, epk: b64u(pair.pub) }); } catch (e) { log(`${pid}: the answer could not be written (${errText(e)})`); continue; }
      pairings.set(pid, x);
      log(`${pid}: ${x.peerName} asks to link`);
    }
  }
  // gone rows addressed to this machine: the other one unlinked while this one was away
  async function takeGone(gone) {
    for (const g of gone) {
      if (lower(g.to) !== me) continue;
      const p = peers.get(lower(g.from));
      const devs = Array.isArray(g.v.devs) ? g.v.devs : [];
      if (p && devs.includes(p.dev)) await unlinkHere(p.peer, 'unlinked on the other machine');
      await api.rest('DELETE', 'settings', { query: { key: `eq.${g.key}` }, prefer: 'return=minimal' }).catch(() => {});
    }
  }

  // ---------- unlinking ----------
  // this side only: the relay forgets the other machine (it gets the notice 'revoked'), and this one its key
  async function unlinkHere(peer, why) {
    const id = lower(peer);
    closeConn(id, 'revoked');
    const had = peers.delete(id);
    if (had) await savePeers();
    let n = 0;
    try { n = await relay.removeComputer(id, why || 'was unlinked'); } catch (e) { log(`the relay could not forget ${short(id)}: ${errText(e)}`); }
    if (had || n) log(`unlinked ${nameOf(id)} (${why || 'here'})`);
    return had || n > 0;
  }
  async function unlink(deviceId) {
    const peer = lower(deviceId);
    if (!UUID_RE.test(peer)) return [400, { ok: false, message: 'device must be a sync device id' }];
    const p = peers.get(peer);
    const devs = [p && p.dev, ...((typeof relay.computers === 'function' ? relay.computers() : []).filter((c) => c.peer === peer).map((c) => c.id))].filter(Boolean);
    const had = await unlinkHere(peer, 'was unlinked here');
    // for a machine that is off now: it unlinks when it reads this
    if (me && devs.length) await putRow(`link-gone:${peer}:${me}`, { v: 1, from: me, to: peer, devs, at: now() }).catch((e) => log(`the unlink row could not be written: ${errText(e)}`));
    return had ? [200, { ok: true }] : [404, { ok: false, message: 'that machine is not linked' }];
  }

  // ---------- the loop ----------
  async function tickOnce() {
    if (!me) {
      let d = null;
      try { d = deviceOf(); } catch {}
      d = lower(d && typeof d === 'object' ? d.id : d);
      if (!UUID_RE.test(d)) return;
      me = d;
    }
    let u = null;
    try { u = await api.uid(); } catch {}
    if (u !== uid) { uid = u ? lower(u) : null; syncConns(); }
    try { await loadDevices(); said.delete('devices'); } catch (e) { logOnce('devices', `the machines could not be read (${errText(e)})`); }
    let rows;
    try { rows = await readRows(); said.delete('rows'); } catch (e) { logOnce('rows', `the link rows could not be read (${errText(e)})`); return; }
    await takeGone(rows.gone);
    await takeAsks(rows.pids);
    const t = now();
    for (const x of [...pairings.values()]) {
      try { await stepPairing(x, rows.pids.get(x.pid) || null, t); } catch (e) { log(`${x.pid}: ${errText(e)}`); }
    }
    // a finished pairing leaves status() after keepFinalMs; its rows, when the other side never deleted them, after pairMs
    for (const [pid, x] of [...pairings]) {
      if (!FINAL.has(x.state) || t - x.endedAt <= tm.keepFinalMs) continue;
      if (x.cleaned || !rows.pids.has(pid)) pairings.delete(pid);
      else if (t - x.endedAt > tm.pairMs) { await dropRows(pid); pairings.delete(pid); }
    }
    for (const [pid, at] of seenPids) if (t - at > 3 * tm.pairMs) seenPids.delete(pid);
    syncConns();
  }
  function tick() {
    if (ticking) { again = true; return ticking; }
    ticking = tickOnce().catch((e) => log(`a round failed: ${errText(e)}`)).finally(() => { ticking = null; });
    return ticking;
  }
  function schedule(ms) {
    if (!running) return;
    cancel(timer);
    timer = later(loop, ms);
  }
  async function loop() {
    timer = null;
    if (!running) return;
    await tick();
    const soon = again;
    again = false;
    schedule(soon ? 0 : active() ? tm.pairPollMs : tm.pollMs);
  }
  function kick() { if (!running) return; if (ticking) again = true; else schedule(0); }
  async function start() {
    if (running) return;
    running = true;
    await loadPeers();
    schedule(0);
  }
  async function stop() {
    running = false;
    cancel(timer); timer = null;
    try { if (ticking) await ticking; } catch {}
    for (const peer of [...conns.keys()]) closeConn(peer, 'stopped');
    if (rt) { rt.stop(); rt = null; }
    await keyWrites.catch(() => {});
  }

  function status() {
    const t = now();
    const machines = [];
    for (const [id, d] of devices.byId) {
      if (id === me) continue;
      const p = peers.get(id), conn = conns.get(id);
      machines.push({ id, name: d.name || 'another computer', platform: d.platform, lastSeenAt: d.lastSeenAt, linked: !!p, online: p ? online(id) : null, pairedAt: p ? p.pairedAt : null, version: conn ? conn.version : null });
    }
    // a linked machine the table no longer lists still shows (so it can be unlinked)
    for (const p of peers.values()) if (!devices.byId.has(p.peer)) machines.push({ id: p.peer, name: p.name, platform: null, lastSeenAt: null, linked: true, online: online(p.peer), pairedAt: p.pairedAt, version: null });
    const list = [...pairings.values()].filter((x) => !FINAL.has(x.state) || t - x.endedAt <= tm.keepFinalMs).map((x) => ({
      pid: x.pid, role: x.role === 'r' ? 'request' : 'answer', peer: { id: x.peer, name: x.peerName }, state: x.state,
      ...(x.state === 'confirm' || x.state === 'confirmed' ? { code: x.code } : {}), confirmedHere: !!x.okMine, ...(x.message ? { message: x.message } : {}), at: x.startedAt,
    }));
    return { running, me: me ? { id: me, name: myName() } : null, machines, pairings: list };
  }
  const peerList = () => [...peers.values()].map((p) => ({ id: p.peer, name: p.name, pairedAt: p.pairedAt, online: online(p.peer) }));

  return { start, stop, tick, status, peers: peerList, online, call, request, confirm, decline, unlink };
}

module.exports = { createLink, derive, commitOf, transcript, sharedSecret, TIMING };
