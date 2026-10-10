// Fleet View live sessions over a WebSocket: what lets a browser (Edge on this PC, or Henry's Mac through Tailscale)
// run the Session tab and the Chat tab the way the desktop window does through window.fleetDesktop.term. The page's
// side is web/remote-term.js; fleet-view.js hands every HTTP upgrade here:
//   server.on('upgrade', (req, socket, head) => LIVE.upgrade(req, socket, head, ctx))
// ctx = { authorize(req) -> boolean, state() -> what GET /state returns (or a Promise of it), log(text) }.
//
// Who may connect: only GET /live, with an Origin header, and only when ctx.authorize(req) says yes (this PC's own
// page, or a remote device Henry approved, with the right Origin). Anything else gets 403 (404 for another path)
// and the socket is destroyed. A connected browser is asked again (at most once a second, and on every keep-alive
// tick), so turning remote access off or taking a device's approval back closes its socket; recheck() asks every
// socket at once.
//
// The WebSocket itself (RFC 6455, no npm package): version 13 only, no extensions or subprotocols; client frames
// must be masked, server frames are not; text and binary messages (both read as UTF-8 JSON; the page sends text),
// continuation frames, ping/pong, the close handshake, 16- and 64-bit lengths, at most 4 MB a message. The server
// pings every 25 s and drops a browser that missed two. A browser that stops reading (8 MB waiting to go out to
// it) is dropped too: the page reconnects and takes a fresh snapshot.
//
// Messages are JSON text frames.
//   browser -> server: { n?, op, args: [...] }, op one of open, create, sendTo, list, snapshot, write, resize, kill,
//                      with the arguments desktop/preload.js passes (open({ id, cwd, account, cols, rows }), write(id,
//                      data), ...). Without n nothing is answered.
//   server -> browser: { n, ok: true, v } or { n, ok: false, message }, and the events
//                      { t: 'data', id, d } { t: 'exit', id, code } { t: 'rekey', from, id } { t: 'sessions', list }
//                      { t: 'host', up } (whether the session host is reachable; sent first on every connect)
// Replies and events go out on a socket in the order the host produced them, so a snapshot holds exactly the output
// sent before its reply (web/term.js drops a view's live chunks while its snapshot is on the way).
//
// The checks are desktop/main.js's IPC handlers', made here before anything reaches the host: conversation ids and
// session keys by the host's own ID_RE / KEY_RE, a new session (create) only in a folder /state lists (its repos'
// roots and checkouts; a fork also in its conversation's own folder) that is a folder on disk, the account one
// letter, sizes whole numbers pulled into the host's ranges, typed data a string of at most 1 MB. Other ops are refused:
// nothing here can reach the host's setUi, quitAll, endAll, killAll or restart.
//
// The session host (desktop/host.js): one connection from this server, shared by every browser, the way api.js
// and desktop/terms.js reach it (its pipe, hello with the token in host.json). It is made when the first browser
// connects and closed 30 s after the last one leaves, so the host can still exit when nothing uses it (it exits
// only after 10 minutes with no session and no client). The server never starts the host: when it is not running,
// open, create and sendTo answer { ok: false, message }, list answers [] and snapshot '', and browsers get
// { t: 'host', up: false }; this keeps trying (0.5 s, then up to every 5 s) and says up: true once it is back. When
// the host goes away, every session it ran is reported ended (exit with code null), as terms.js does for the window.
// To the host this connection is one more client: it gets every event (the host sends them to every client), and
// it keeps the host from exiting while it is open; nothing else in host.js treats clients differently.
'use strict';
const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
// requiring it only defines functions (runHost runs only when host.js is the main module): the same pipe name,
// host.json, ID_RE and KEY_RE the window uses
const H = require(path.join(__dirname, 'desktop', 'host.js'));

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MSG_MAX = 4 << 20; // one message, all its frames together
const OUT_MAX = 8 << 20; // waiting to go out to one browser
const WRITE_MAX = 1 << 20; // one write's data, in characters
const PING_MS = 25000;
const CLIENTS_MAX = 32;
const INFLIGHT_MAX = 256; // requests of one browser waiting on the host
const AUTH_EVERY_MS = 1000;
const CALL_MS = 15000, SEND_TO_MS = 20000; // as desktop/terms.js waits for the host
const IDLE_CLOSE_MS = 30000;
const RETRY_FIRST_MS = 500, RETRY_MAX_MS = 5000;
const HOST_DOWN = 'the session host is not running: it runs with the Fleet View desktop app on the PC';
const OPS = new Set(['open', 'create', 'sendTo', 'list', 'snapshot', 'write', 'resize', 'kill']);

const validId = (id) => typeof id === 'string' && H.ID_RE.test(id);
const validKey = (id) => typeof id === 'string' && H.KEY_RE.test(id);
const acctId = (a) => (typeof a === 'string' && /^[a-z]$/i.test(a) ? a.toUpperCase() : 'B');
// a size as the host takes it: a whole number pulled into its range; none (the host's default) when it is not a number
const intIn = (v, lo, hi) => { const n = Math.floor(Number(v)); return v == null || v === '' || !Number.isFinite(n) ? undefined : Math.min(hi, Math.max(lo, n)); };
const cwdOf = (v) => (typeof v === 'string' && v && v.length <= 1000 ? v : null);

let log = () => {};
const clients = new Set();

// ---------- the WebSocket handshake ----------
function refuse(socket, code, text, extra = '') {
  const body = `${text}\n`;
  try {
    socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n${extra}\r\n${body}`);
  } catch {}
  setTimeout(() => { try { socket.destroy(); } catch {} }, 1000).unref();
}

function upgrade(req, socket, head, ctx) {
  socket.on('error', () => {});
  if (ctx && typeof ctx.log === 'function') log = ctx.log;
  let pathname = '';
  try { pathname = new URL(req.url, 'http://x').pathname; } catch {}
  if (pathname !== '/live') return refuse(socket, 404, 'Not Found');
  let ok = false;
  try { ok = !!req.headers.origin && !!ctx && ctx.authorize(req) === true; } catch {}
  if (!ok) return refuse(socket, 403, 'Forbidden');
  if (req.method !== 'GET' || !/\bwebsocket\b/i.test(String(req.headers.upgrade || ''))) return refuse(socket, 400, 'Bad Request');
  if (String(req.headers['sec-websocket-version'] || '').trim() !== '13') return refuse(socket, 426, 'Upgrade Required', 'Sec-WebSocket-Version: 13\r\n');
  const key = String(req.headers['sec-websocket-key'] || '').trim();
  if (!/^[A-Za-z0-9+/]{22}==$/.test(key) || Buffer.from(key, 'base64').length !== 16) return refuse(socket, 400, 'Bad Request');
  if (clients.size >= CLIENTS_MAX) return refuse(socket, 503, 'Service Unavailable');
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  socket.setTimeout(0);
  const c = {
    req, socket, ctx, origin: String(req.headers.origin).slice(0, 200),
    chunks: [], have: 0, need: 2, frag: null, missed: 0, closing: false, gone: false,
    authAt: Date.now(), inflight: 0, ready: false, queue: [],
  };
  clients.add(c);
  log(`live: a browser connected (${c.origin}), ${clients.size} now`);
  socket.on('data', (chunk) => onData(c, chunk));
  socket.on('close', () => gone(c));
  socket.on('end', () => gone(c));
  if (head && head.length) onData(c, head);
  // the host's state first: wait for a connect that is on its way, so a page does not see "down" for a moment
  link.join().then(() => {
    if (c.gone) return;
    c.ready = true;
    send(c, { t: 'host', up: link.up });
    if (link.up) send(c, { t: 'sessions', list: link.cache });
    // what arrived before that went on hold, to keep the order
    const q = c.queue; c.queue = [];
    for (const m of q) handle(c, m);
  });
}

function gone(c) {
  if (c.gone) return;
  c.gone = true;
  clearTimeout(c.closeTimer);
  try { c.socket.destroy(); } catch {}
  if (clients.delete(c)) log(`live: a browser disconnected (${c.origin}), ${clients.size} left`);
  link.leave();
}

// ---------- frames ----------
function frame(op, payload) {
  const len = payload.length;
  let head;
  if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
  else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[1] = 127; head.writeUInt32BE(Math.floor(len / 2 ** 32), 2); head.writeUInt32BE(len >>> 0, 6); }
  head[0] = 0x80 | op;
  return Buffer.concat([head, payload]);
}

function write(c, buf) {
  if (c.gone || c.socket.destroyed) return;
  // a browser that stopped reading must not grow this process: drop it, it reconnects and takes a fresh snapshot
  if (c.socket.writableLength > OUT_MAX) { log(`live: a browser stopped reading (${c.origin}); dropping it`); gone(c); return; }
  try { c.socket.write(buf); } catch { gone(c); }
}
const send = (c, msg) => write(c, frame(0x1, Buffer.from(JSON.stringify(msg))));
// one event to every browser that has had its host state: made once, written to each
function broadcast(msg) {
  let buf = null;
  for (const c of clients) {
    if (!c.ready || c.closing) continue;
    if (!buf) buf = frame(0x1, Buffer.from(JSON.stringify(msg)));
    write(c, buf);
  }
}

// start the close handshake (code, reason); the socket goes after the browser answers, or 2 s
function close(c, code, reason = '') {
  if (c.gone || c.closing) return;
  c.closing = true;
  const r = Buffer.from(String(reason).slice(0, 120));
  const p = Buffer.alloc(2 + r.length);
  p.writeUInt16BE(code, 0);
  r.copy(p, 2);
  write(c, frame(0x8, p));
  c.closeTimer = setTimeout(() => gone(c), 2000);
  c.closeTimer.unref();
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

function onData(c, chunk) {
  if (c.gone) return;
  c.chunks.push(chunk);
  c.have += chunk.length;
  if (c.have > MSG_MAX + 64) return close(c, 1009, 'message too big');
  while (!c.gone && c.have >= c.need) {
    const b = c.chunks.length === 1 ? c.chunks[0] : Buffer.concat(c.chunks, c.have);
    c.chunks = [b];
    const used = parseFrame(c, b);
    if (used < 0) return; // closed
    if (used === 0) return; // c.need was raised: wait for more
    const rest = b.subarray(used);
    c.chunks = rest.length ? [rest] : [];
    c.have = rest.length;
    c.need = 2;
  }
}

// one frame from the front of b: the bytes it took, 0 when more are needed (c.need says how many), -1 when closed
function parseFrame(c, b) {
  if (b.length < 2) { c.need = 2; return 0; }
  const fin = (b[0] & 0x80) !== 0, op = b[0] & 0x0f;
  if (b[0] & 0x70) { close(c, 1002, 'no extensions'); return -1; }
  if (!(b[1] & 0x80)) { close(c, 1002, 'client frames must be masked'); return -1; }
  let len = b[1] & 0x7f, off = 2;
  if (len === 126) {
    if (b.length < 4) { c.need = 4; return 0; }
    len = b.readUInt16BE(2); off = 4;
  } else if (len === 127) {
    if (b.length < 10) { c.need = 10; return 0; }
    if (b.readUInt32BE(2) !== 0) { close(c, 1009, 'message too big'); return -1; }
    len = b.readUInt32BE(6); off = 10;
  }
  if (op >= 0x8 && (!fin || len > 125)) { close(c, 1002, 'bad control frame'); return -1; }
  if (len > MSG_MAX) { close(c, 1009, 'message too big'); return -1; }
  const total = off + 4 + len;
  if (b.length < total) { c.need = total; return 0; }
  const mask = b.subarray(off, off + 4);
  const data = Buffer.from(b.subarray(off + 4, total));
  for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
  c.missed = 0; // anything from it means it is there
  switch (op) {
    case 0x0: // continuation
      if (!c.frag) { close(c, 1002, 'nothing to continue'); return -1; }
      c.frag.size += data.length;
      if (c.frag.size > MSG_MAX) { close(c, 1009, 'message too big'); return -1; }
      c.frag.parts.push(data);
      if (fin) { const m = Buffer.concat(c.frag.parts, c.frag.size); c.frag = null; if (!message(c, m)) return -1; }
      return total;
    case 0x1: case 0x2: // text, binary
      if (c.frag) { close(c, 1002, 'a message is still open'); return -1; }
      if (!fin) { c.frag = { parts: [data], size: data.length }; return total; }
      return message(c, data) ? total : -1;
    case 0x8: { // close: answer it (with its code, or 1000) and let the socket go
      if (data.length === 1) { close(c, 1002, 'bad close frame'); return -1; }
      if (!c.closing) {
        const code = data.length >= 2 ? data.readUInt16BE(0) : 1000;
        const ok = (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1011) || (code >= 3000 && code <= 4999);
        close(c, ok ? code : 1002);
      }
      setImmediate(() => gone(c));
      return -1;
    }
    case 0x9: write(c, frame(0xA, data)); return total; // ping: pong with its payload
    case 0xA: return total; // pong
    default: close(c, 1002, 'unknown opcode'); return -1;
  }
}

// a whole message: JSON, one request. false when the socket was closed for it
function message(c, buf) {
  if (c.closing) return true;
  let msg;
  try { msg = JSON.parse(utf8.decode(buf)); } catch { close(c, 1007, 'not JSON text'); return false; }
  if (!authorized(c)) return false;
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return true;
  if (!c.ready) { if (c.queue.length < INFLIGHT_MAX) c.queue.push(msg); return true; }
  handle(c, msg);
  return true;
}

// still allowed? (remote access turned off, a device's approval taken back): else the socket closes
function authorized(c, now = Date.now(), force = false) {
  if (!force && now - c.authAt < AUTH_EVERY_MS) return true;
  c.authAt = now;
  let ok = false;
  try { ok = c.ctx.authorize(c.req) === true; } catch {}
  if (!ok) { log(`live: a browser is no longer allowed (${c.origin}); closing it`); close(c, 1008, 'not allowed'); }
  return ok;
}
function recheck() { for (const c of [...clients]) if (!c.closing) authorized(c, Date.now(), true); }

// keep-alive: a ping every 25 s; one that missed two goes
const pinger = setInterval(() => {
  const now = Date.now();
  for (const c of [...clients]) {
    if (c.closing) continue;
    if (c.missed >= 2) { log(`live: a browser stopped answering (${c.origin}); dropping it`); gone(c); continue; }
    if (!authorized(c, now, true)) continue;
    c.missed++;
    write(c, frame(0x9, Buffer.alloc(0)));
  }
}, PING_MS);
pinger.unref();

// ---------- requests ----------
function handle(c, msg) {
  const n = msg.n;
  const hasN = Number.isSafeInteger(n);
  if (n !== undefined && !hasN) return; // nothing to answer it with
  const reply = (v) => { if (hasN) send(c, { n, ok: true, v }); };
  const fail = (message) => { if (hasN) send(c, { n, ok: false, message: String(message) }); };
  const op = msg.op;
  if (typeof op !== 'string' || !OPS.has(op)) return fail('unknown op');
  const a = Array.isArray(msg.args) ? msg.args : [];
  if (c.inflight >= INFLIGHT_MAX) return fail('too many requests at once');
  // what goes to the host: its reply (or the failure) comes back to this browser, in order with the events
  const host = (args, ms, onFail) => {
    c.inflight++;
    link.call(op, args, (err, v) => {
      c.inflight--;
      if (c.gone) return;
      if (err) return onFail ? onFail(err) : fail(err.message);
      reply(v);
    }, ms, hasN);
  };
  switch (op) {
    case 'open': {
      const o = a[0];
      if (!o || typeof o !== 'object' || !validId(o.id)) return fail('bad conversation id');
      return host([{ id: o.id, cwd: cwdOf(o.cwd), account: acctId(o.account), cols: intIn(o.cols, 20, 1000), rows: intIn(o.rows, 5, 500) }], CALL_MS,
        (e) => reply({ ok: false, message: e.message }));
    }
    case 'sendTo': {
      const o = a[0];
      if (!o || typeof o !== 'object' || !validId(o.id)) return fail('bad conversation id');
      return host([{ id: o.id, cwd: cwdOf(o.cwd), account: acctId(o.account), cols: intIn(o.cols, 20, 1000), rows: intIn(o.rows, 5, 500) }], SEND_TO_MS,
        (e) => reply({ ok: false, message: e.message }));
    }
    case 'create': {
      c.inflight++;
      return createChecked(c.ctx, a[0]).then((r) => {
        c.inflight--;
        if (c.gone) return;
        if (!r.args) return reply(r);
        c.inflight++;
        link.call('create', r.args, (err, v) => { c.inflight--; if (!c.gone) reply(err ? { ok: false, message: err.message } : v); }, CALL_MS, true);
      }, (e) => { c.inflight--; if (!c.gone) reply({ ok: false, message: String((e && e.message) || e) }); });
    }
    case 'list': return host([], CALL_MS, () => reply([]));
    case 'snapshot': {
      if (!validKey(a[0])) return reply('');
      return host([a[0]], CALL_MS, () => reply(''));
    }
    case 'write': {
      if (!validKey(a[0]) || typeof a[1] !== 'string' || !a[1] || a[1].length > WRITE_MAX) return fail('bad write');
      return host([a[0], a[1]], CALL_MS);
    }
    case 'resize': {
      const cols = intIn(a[1], 2, 1000), rows = intIn(a[2], 2, 500);
      if (!validKey(a[0]) || !cols || !rows) return fail('bad size');
      return host([a[0], cols, rows], CALL_MS);
    }
    case 'kill': {
      if (!validKey(a[0])) return fail('bad session key');
      return host([a[0]], CALL_MS);
    }
  }
  return fail('unknown op');
}

// the folders a new session may start in: the repos and checkouts the server lists in /state (desktop/main.js)
function allowedFolders(st) {
  const out = new Set();
  const add = (p) => { if (typeof p === 'string' && p) out.add(H.normDir(p)); };
  for (const r of (st && st.repos) || []) add(r && r.root);
  for (const s of (st && st.sessions) || []) { add(s && s.repo && s.repo.root); add(s && s.links && s.links.repoFolder); }
  return out;
}
// create's checks (desktop/main.js fv:term-create): -> { args } for the host, or the { ok: false, message } answer
async function createChecked(ctx, o) {
  if (!o || typeof o !== 'object' || typeof o.cwd !== 'string' || !o.cwd || o.cwd.length > 1000) return { ok: false, message: 'no folder given' };
  let st = null;
  try { st = await ctx.state(); } catch {}
  if (!st) return { ok: false, message: "Fleet View's server did not answer; try again" };
  const want = H.normDir(o.cwd);
  const allowed = allowedFolders(st);
  // a fork (forkFrom): a conversation /state lists, started in that conversation's own folder
  let forkFrom;
  if (o.forkFrom !== undefined) {
    if (!validId(o.forkFrom)) return { ok: false, message: 'bad conversation id' };
    const src = ((st && st.sessions) || []).find((x) => x && x.id === o.forkFrom);
    if (!src) return { ok: false, message: 'that conversation is not in the list' };
    if (typeof src.cwd === 'string' && src.cwd) allowed.add(H.normDir(src.cwd));
    forkFrom = o.forkFrom;
  }
  if (!allowed.has(want)) return { ok: false, message: 'that folder is not a repo Fleet View lists' };
  let isDir = false;
  try { isDir = fs.statSync(o.cwd).isDirectory(); } catch {}
  if (!isDir) return { ok: false, message: `the folder is gone: ${o.cwd}` };
  return { args: [{ cwd: o.cwd, account: acctId(o.account), cols: intIn(o.cols, 20, 1000), rows: intIn(o.rows, 5, 500), ...(forkFrom ? { forkFrom } : {}) }] };
}

// ---------- the session host: one connection for every browser ----------
const link = (() => {
  const PIPE = H.pipeName();
  let sock = null, ready = false, buf = '', seq = 0;
  let connecting = null, retryTimer = null, idleTimer = null, backoff = RETRY_FIRST_MS, downSaid = false;
  const waits = new Map(); // n -> { cb, timer }
  const self = { up: false, cache: [] };

  // one attempt: the pipe, hello with host.json's token; resolves true once the host answered
  function attempt() {
    return new Promise((resolve) => {
      const hf = H.readJson(H.hostFile());
      if (!hf || hf.pipe !== PIPE || typeof hf.token !== 'string') return resolve(false);
      const s = net.connect(PIPE);
      let done = false, b = '';
      const finish = (v) => { if (done) return; done = true; clearTimeout(timer); if (v !== true) s.destroy(); resolve(v === true); };
      const timer = setTimeout(() => finish(false), 3000);
      s.setEncoding('utf8');
      s.on('error', () => finish(false));
      s.on('close', () => finish(false));
      s.on('connect', () => s.write(`${JSON.stringify({ t: 'hello', token: hf.token, pid: process.pid })}\n`));
      const first = (chunk) => {
        b += chunk;
        const i = b.indexOf('\n');
        if (i < 0) return;
        let msg = null;
        try { msg = JSON.parse(b.slice(0, i)); } catch {}
        if (!msg || msg.t !== 'hello' || !msg.ok) return finish(false);
        s.removeListener('data', first);
        s.removeAllListeners('close');
        s.removeAllListeners('error');
        adopt(s, b.slice(i + 1), msg);
        finish(true);
      };
      s.on('data', first);
    });
  }

  function connect() {
    if (ready) return Promise.resolve(true);
    if (connecting) return connecting;
    clearTimeout(retryTimer); retryTimer = null;
    connecting = attempt().then((ok) => {
      connecting = null;
      if (ok) return true;
      if (!downSaid) { downSaid = true; log('live: the session host is not running; trying again while browsers are connected'); }
      if (clients.size) { retryTimer = setTimeout(connect, backoff); backoff = Math.min(RETRY_MAX_MS, backoff * 2); }
      return false;
    });
    return connecting;
  }

  function adopt(s, rest, hello) {
    sock = s; ready = true; buf = ''; backoff = RETRY_FIRST_MS; downSaid = false;
    self.up = true;
    log(`live: connected to the session host (pid ${hello.pid})`);
    s.on('data', (chunk) => { buf += chunk; drain(); });
    s.on('close', lost);
    s.on('error', () => {});
    broadcast({ t: 'host', up: true });
    if (rest) { buf = rest; drain(); }
  }

  // the host's lines, handed on as they come: events to every browser, replies to the one that asked
  function drain() {
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (!m || typeof m !== 'object') continue;
      if (m.t === 'ev') {
        if (m.e === 'data') broadcast({ t: 'data', id: m.id, d: m.d });
        else if (m.e === 'exit') broadcast({ t: 'exit', id: m.id, code: m.code ?? null });
        else if (m.e === 'rekey') broadcast({ t: 'rekey', from: m.from, id: m.id });
        else if (m.e === 'sessions' && Array.isArray(m.list)) { self.cache = m.list; broadcast({ t: 'sessions', list: m.list }); }
      } else if (m.t === 'res') {
        const w = waits.get(m.n);
        if (!w) continue;
        waits.delete(m.n);
        clearTimeout(w.timer);
        try { w.cb(m.err ? new Error(m.err) : null, m.v); } catch (e) { log(`live: ${e && e.stack ? e.stack : e}`); }
      }
    }
  }

  // the host went away (it exited, restarted, or this closed it): every session it had ended with it
  function lost() {
    if (!ready) return;
    ready = false; sock = null; buf = '';
    self.up = false;
    for (const [n, w] of waits) { waits.delete(n); clearTimeout(w.timer); try { w.cb(new Error('the session host went away')); } catch {} }
    const had = self.cache.filter((x) => x && x.alive && typeof x.id === 'string');
    self.cache = [];
    for (const x of had) broadcast({ t: 'exit', id: x.id, code: null });
    broadcast({ t: 'host', up: false });
    if (!clients.size) return;
    log('live: lost the session host; connecting again');
    backoff = RETRY_FIRST_MS;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, RETRY_FIRST_MS);
  }

  // a request; cb(err, value) runs in order with the events that came before the reply. Without wantReply the
  // host is not asked to answer and cb(null, true) runs once it is sent.
  function call(op, args, cb, ms = CALL_MS, wantReply = true) {
    if (!ready) {
      if (connecting) { connecting.then(() => (ready ? call(op, args, cb, ms, wantReply) : cb(new Error(HOST_DOWN)))); return; }
      cb(new Error(HOST_DOWN));
      return;
    }
    const msg = { t: 'req', op, a: args };
    if (wantReply) {
      const n = ++seq;
      msg.n = n;
      waits.set(n, { cb, timer: setTimeout(() => { if (waits.delete(n)) cb(new Error('the session host did not answer')); }, ms) });
    }
    try { sock.write(`${JSON.stringify(msg)}\n`); } catch (e) { if (msg.n && waits.delete(msg.n)) cb(e); return; }
    if (!wantReply) cb(null, true);
  }

  // a browser connected: the connection is wanted (resolves once a connect on its way has settled)
  self.join = () => {
    clearTimeout(idleTimer); idleTimer = null;
    return connect().catch(() => false);
  };
  // the last browser left: close the connection after a while, so the host can exit when nothing uses it
  self.leave = () => {
    if (clients.size || idleTimer) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (clients.size) return;
      clearTimeout(retryTimer); retryTimer = null;
      if (sock) {
        const s = sock;
        s.removeListener('close', lost);
        ready = false; sock = null; buf = ''; self.up = false; self.cache = [];
        for (const [n, w] of waits) { waits.delete(n); clearTimeout(w.timer); try { w.cb(new Error('closed')); } catch {} }
        try { s.end(); } catch {}
        log('live: no browser for 30 s; closed the session host connection');
      }
    }, IDLE_CLOSE_MS);
    idleTimer.unref();
  };
  self.call = call;
  return self;
})();

module.exports = { upgrade, recheck, clientCount: () => clients.size };
