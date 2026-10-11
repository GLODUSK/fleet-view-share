// relay-lan.js: the phone relay's Wi-Fi carrier (docs/phone.md "Work locally"). A phone paired in local mode reaches
// this PC with no Supabase at all: it opens a WebSocket to ws://<one of this PC's private addresses>:<port>/fleet/<dev>
// and sends the very envelopes it would send through Realtime. This file only carries them: relay.js opens, checks and
// answers each one exactly as it does a Supabase one (createRelay's onEnvelope: the device key, nonces, skew, the
// allowlist, the fence, every limit, the marker), and its answers come back down the socket the request came on.
//
// Who can reach it: anyone on the same network. So it says nothing to anyone who does not hold a device key:
//   - It listens only while relay.js wants it (a local-mode device paired or being paired), on its own port (4779 by
//     default), bound to each of this PC's private IPv4 addresses (10/8, 172.16/12, 192.168/16) one by one: never
//     0.0.0.0, never a public, link-local, CGNAT (Tailscale's 100.64/10) or loopback address. The addresses are read
//     again on every sync() (relay.js's sweep, every 30 s), so a new Wi-Fi address is picked up and a gone one let go.
//     The page's server (127.0.0.1:4777) is a different server on loopback: nothing here reaches it but relay.js's own
//     forward() calls, made after an envelope opened and passed every check.
//   - It serves one thing: the WebSocket upgrade GET /fleet/<dev> (exactly that path, no query) for a device relay.js
//     says is a known local one, with a Host header naming the address and port it was reached on (no DNS
//     rebinding) and no Origin or the matching http://<that host> (a page in a browser on the network is refused).
//     Everything else, a plain request included, gets a bare 404 with no body, no date and no server name, and the
//     socket is closed; a malformed request is closed without a word. Nothing (no PC name, no version) goes down a
//     socket until an envelope came up that opened under the device's key, and only those "proven" sockets ever get
//     an answer or a notice.
//   - Limits: 16 sockets in all, 8 from one address, 4 per device (the oldest one not proven yet makes room; a proven
//     one never does, so a stranger can't push the phone off); 64 TCP connections per listening address before any
//     upgrade, 8 from one address, 5 s to send the request headers (4 KB at most, checked every second); one message at
//     most opts.msgMax bytes (relay.js: its C_MAX ciphertext and the envelope's fields), checked from the frame header
//     before it is read, 64 messages and 256 frames of any kind a second per socket. A socket not proven yet may have
//     64 KB waiting to go out (its pongs), a proven one outMax. A socket must prove itself within 15 s (an envelope that opens), and one not proven yet is closed at
//     the first envelope that does not open or is not for its device; a proven one after 8. A ping every 25 s, two
//     missed and the socket goes; a proven socket that sent no envelope for 10 minutes is closed (the phone opens a
//     new one when it needs it). 128 MB waiting to go out to a phone that stopped reading drops its socket. Proven means
//     an envelope that opened and is fresh (relay.js checks its at against the skew window first), so an old envelope
//     replayed proves nothing.
// The frames are ws-frames.js's (RFC 6455, shared with live.js); messages are JSON text, one envelope each, as the
// Supabase carrier's broadcast payloads.
//
// createLan(o) -> { sync(want) -> Promise of status(), send(conn, envelope) -> bool, targets(dev, conn?) -> [conn],
//                   proven(conn), bad(conn), connected(dev) -> bool, closeDevice(dev), status(), stop() -> Promise }
//   o: { port, hosts() -> [ip] (default: this PC's private IPv4 addresses; tests pass 127.0.0.1), known(dev) -> bool,
//        onEnvelope(dev, envelope, conn), msgMax, log(text), limits (tests: { proveMs, idleMs, pingMs, ... }) }
'use strict';
const os = require('os');
const http = require('http');
const path = require('path');
const WF = require(path.join(__dirname, 'ws-frames.js'));

const LAN_PORT = 4779;
const PATH_RE = /^\/fleet\/([A-Za-z0-9_-]{16})$/;
const LIMITS = {
  socks: 16, perAddr: 8, perDevice: 4, connMax: 64, connPerAddr: 8, headMs: 5e3, headMax: 4096, framesPerS: 64,
  allFramesPerS: 256, badMax: 8, proveMs: 15e3, idleMs: 10 * 60e3, pingMs: 25e3, outMax: 128 << 20, outMaxUnproven: 64 << 10,
};

// a private IPv4 address (RFC 1918): 10/8, 172.16/12, 192.168/16
function isPrivate(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip));
  if (!m || m.slice(1).some((x) => Number(x) > 255)) return false;
  const a = Number(m[1]), b = Number(m[2]);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
// a virtual adapter's name (WSL, Hyper-V, Docker, VirtualBox, VMware...): a phone on the Wi-Fi never reaches it, so it
// is left out whenever a real adapter has a private address (else it is all there is: a PC whose LAN is on a Hyper-V
// external switch, say)
const VIRTUAL_RE = /vethernet|wsl|hyper-v|docker|virtualbox|vmware|vmnet|vbox|loopback|tailscale|zerotier|utun|bridge|veth/i;
// this PC's private IPv4 addresses, as os.networkInterfaces() lists them (not loopback, not internal): a real adapter's
// before a virtual one's, and 192.168/16, then 10/8, then 172.16/12 (the range virtual switches like) within each
function privateIPv4s(ifaces) {
  let list = ifaces;
  if (!list) { try { list = os.networkInterfaces(); } catch { list = {}; } }
  const out = [];
  for (const [name, addrs] of Object.entries(list || {})) {
    for (const a of addrs || []) {
      if (!a || a.internal || !(a.family === 'IPv4' || a.family === 4) || !isPrivate(a.address)) continue;
      const range = a.address.startsWith('192.168.') ? 0 : a.address.startsWith('10.') ? 1 : 2;
      out.push({ ip: a.address, rank: (VIRTUAL_RE.test(name) ? 10 : 0) + range, n: out.length });
    }
  }
  out.sort((x, y) => x.rank - y.rank || x.n - y.n);
  const real = out.filter((x) => x.rank < 10);
  return [...new Set((real.length ? real : out).map((x) => x.ip))];
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
const NOT_FOUND = 'HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n';

function createLan(o = {}) {
  const port = Number(o.port) || LAN_PORT;
  const lim = { ...LIMITS, ...(o.limits || {}) };
  const msgMax = Number(o.msgMax) || (2 << 20);
  const log = typeof o.log === 'function' ? o.log : () => {};
  const hosts = () => { try { return (typeof o.hosts === 'function' ? o.hosts() : privateIPv4s()).filter((x) => typeof x === 'string' && x); } catch { return []; } };
  const known = (dev) => { try { return o.known(dev) === true; } catch { return false; } };
  const servers = new Map(); // address -> { server, addr, listening }
  const conns = new Set(); // in the order they came: the last is the newest
  const pending = new Map(); // remote address -> its TCP connections open now (upgraded ones too, until they close)
  let pinger = null, lastError = null, stopped = false;

  // ---------- a socket ----------
  function refuse(socket) {
    try { socket.end(NOT_FOUND); } catch {}
    setTimeout(() => { try { socket.destroy(); } catch {} }, 1000).unref();
  }
  function gone(c) {
    if (c.gone) return;
    c.gone = true;
    clearTimeout(c.proveTimer);
    clearTimeout(c.closeTimer);
    try { c.socket.destroy(); } catch {}
    conns.delete(c);
    if (!conns.size && pinger) { clearInterval(pinger); pinger = null; }
  }
  function write(c, buf) {
    if (c.gone || c.socket.destroyed) return false;
    // a phone that stopped reading must not grow this process: drop it, it opens a new socket and asks again
    if (c.socket.writableLength > (c.proven ? lim.outMax : lim.outMaxUnproven)) { gone(c); return false; }
    try { c.socket.write(buf); return true; } catch { gone(c); return false; }
  }
  // the close handshake: the frame goes after whatever was written before it (a notice), the socket 2 s later at most.
  // No reason text: a stranger learns nothing from it
  function close(c, code) {
    if (c.gone || c.closing) return;
    c.closing = true;
    write(c, WF.frame(0x8, WF.closePayload(code)));
    c.closeTimer = setTimeout(() => gone(c), 2000);
    c.closeTimer.unref();
  }
  // one whole message: JSON text holding one envelope for the device this socket was opened for
  function message(c, buf) {
    if (c.closing) return true;
    const t = Date.now();
    if (t - c.winAt >= 1000) { c.winAt = t; c.winN = 0; }
    if (++c.winN > lim.framesPerS) { close(c, 1008); return false; }
    let env = null;
    try { env = JSON.parse(utf8.decode(buf)); } catch { close(c, 1007); return false; }
    if (!env || typeof env !== 'object' || Array.isArray(env) || env.d !== c.dev) { bad(c); return !c.closing; }
    try { o.onEnvelope(c.dev, env, c); } catch (e) { log(`a Wi-Fi message failed: ${e && e.message}`); }
    return !c.closing;
  }
  // every frame, control and continuation ones too, against the socket's budget (a flood of empty ones costs too)
  function frameOk(c) {
    const t = Date.now();
    if (t - c.fAt >= 1000) { c.fAt = t; c.fN = 0; }
    if (++c.fN > lim.allFramesPerS) { close(c, 1008); return false; }
    return true;
  }
  function upgrade(req, socket, head, entry) {
    socket.on('error', () => {});
    // full: not a word, to anyone
    const from = socket.remoteAddress || '?';
    if (conns.size >= lim.socks || [...conns].filter((x) => x.from === from).length >= lim.perAddr) return socket.destroy();
    const m = PATH_RE.exec(String(req.url || ''));
    const host = String(req.headers.host || '').toLowerCase(), local = socket.localAddress;
    const hostOk = host === `${local}:${port}` || host === local;
    const origin = req.headers.origin;
    const ok = m && req.method === 'GET' && /\bwebsocket\b/i.test(String(req.headers.upgrade || ''))
      && String(req.headers['sec-websocket-version'] || '').trim() === '13' && hostOk
      && (origin === undefined || String(origin).toLowerCase() === `http://${host}`) && known(m[1]);
    const accept = ok ? WF.acceptKey(req.headers['sec-websocket-key']) : null;
    if (!accept) return refuse(socket);
    const dev = m[1];
    // a device's sockets: the oldest one not proven yet makes room; when every one is proven, the new one waits
    const mine = [...conns].filter((x) => x.dev === dev);
    if (mine.length >= lim.perDevice) {
      const old = mine.find((x) => !x.proven);
      if (!old) return socket.destroy();
      gone(old);
    }
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.setNoDelay(true);
    socket.setTimeout(0);
    const c = { dev, socket, from, local: entry.addr, ...WF.state(), proven: false, bad: 0, lastAt: Date.now(), winAt: 0, winN: 0, fAt: 0, fN: 0 };
    c.h = { max: msgMax, frame: () => frameOk(c), close: (code) => close(c, code), message: (b) => message(c, b), pong: (d) => write(c, WF.frame(0xA, d)), gone: () => gone(c) };
    conns.add(c);
    c.proveTimer = setTimeout(() => { if (!c.proven) close(c, 1008); }, lim.proveMs);
    c.proveTimer.unref();
    socket.on('data', (d) => WF.feed(c, d, c.h));
    socket.on('close', () => gone(c));
    socket.on('end', () => gone(c));
    if (!pinger) { pinger = setInterval(ping, lim.pingMs); pinger.unref(); }
    if (head && head.length) WF.feed(c, head, c.h);
  }
  // keep-alive: a ping every pingMs; one that missed two goes, and a proven one that sent nothing for idleMs closes
  function ping() {
    const t = Date.now();
    for (const c of [...conns]) {
      if (c.closing) continue;
      if (c.missed >= 2) { gone(c); continue; }
      if (c.proven && t - c.lastAt > lim.idleMs) { close(c, 1000); continue; }
      c.missed++;
      write(c, WF.frame(0x9, Buffer.alloc(0)));
    }
  }

  // ---------- the servers: one per private address ----------
  function onRequest(req, res) {
    res.sendDate = false;
    res.writeHead(404, { 'Content-Length': '0', Connection: 'close' });
    res.end();
  }
  function listenOn(addr) {
    return new Promise((resolve) => {
      // connectionsCheckingInterval: the header and request timeouts are checked every second, not every 30
      const server = http.createServer({ maxHeaderSize: lim.headMax, connectionsCheckingInterval: 1000 }, onRequest);
      server.headersTimeout = lim.headMs;
      server.requestTimeout = lim.headMs;
      server.keepAliveTimeout = 1000;
      server.maxConnections = lim.connMax;
      const entry = { server, addr, listening: false };
      servers.set(addr, entry);
      server.on('upgrade', (req, socket, head) => {
        try { upgrade(req, socket, head, entry); } catch (e) { log(`a Wi-Fi socket failed: ${e && e.message}`); try { socket.destroy(); } catch {} }
      });
      server.on('clientError', (e, socket) => { try { socket.destroy(); } catch {} });
      // before any upgrade: connPerAddr from one address at most, and headMs for the request (the upgrade lifts it)
      server.on('connection', (s) => {
        s.on('error', () => {});
        const from = s.remoteAddress || '?';
        const n = (pending.get(from) || 0) + 1;
        if (n > lim.connPerAddr) return s.destroy();
        pending.set(from, n);
        s.once('close', () => { const k = (pending.get(from) || 1) - 1; if (k > 0) pending.set(from, k); else pending.delete(from); });
        s.setTimeout(lim.headMs, () => s.destroy());
      });
      server.once('error', (e) => {
        if (entry.listening) return;
        lastError = `${addr}:${port}: ${e.code || e.message}`;
        if (servers.get(addr) === entry) servers.delete(addr);
        log(`could not listen on ${lastError}`);
        resolve(false);
      });
      server.on('error', () => {});
      server.listen({ port, host: addr, exclusive: true }, () => {
        entry.listening = true;
        lastError = null;
        log(`listening for phones on this Wi-Fi at ${addr}:${port}`);
        resolve(true);
      });
    });
  }
  function closeServer(entry) {
    servers.delete(entry.addr);
    for (const c of [...conns]) if (c.local === entry.addr) close(c, 1001);
    try { entry.server.close(); } catch {}
    try { entry.server.closeIdleConnections(); } catch {}
    if (entry.listening) log(`stopped listening at ${entry.addr}:${port}`);
  }
  // listen on every private address now (want), or on none; -> Promise of status()
  async function sync(want) {
    const target = new Set(want && !stopped ? hosts() : []);
    for (const entry of [...servers.values()]) if (!target.has(entry.addr)) closeServer(entry);
    await Promise.all([...target].filter((a) => !servers.has(a)).map(listenOn));
    if (!want) for (const c of [...conns]) close(c, 1001);
    return status();
  }

  // ---------- for relay.js ----------
  const live = (c) => !c.gone && !c.closing;
  // where an answer goes: the socket its request came on; when that one is gone, the device's newest proven one;
  // with no socket (a notice), every proven one of the device
  function targets(dev, rt) {
    if (rt && rt.dev === dev && rt.proven && live(rt)) return [rt];
    const list = [...conns].filter((c) => c.dev === dev && c.proven && live(c));
    return rt ? list.slice(-1) : list;
  }
  function send(c, env) {
    if (!c || !live(c)) return false;
    return write(c, WF.frame(0x1, Buffer.from(JSON.stringify(env), 'utf8')));
  }
  // an envelope from c opened under its device's key: c may get answers now
  function proven(c) {
    if (!c || c.gone) return;
    c.proven = true;
    c.lastAt = Date.now();
    clearTimeout(c.proveTimer);
  }
  // one that did not open (or was not for its device): a socket not proven yet is closed at once, a proven one after
  // badMax
  function bad(c) {
    if (!c || c.gone) return;
    if (!c.proven || ++c.bad >= lim.badMax) close(c, 1008);
  }
  function closeDevice(dev) { for (const c of [...conns]) if (c.dev === dev) close(c, 1000); }
  function status() {
    return {
      port, listening: [...servers.values()].filter((e) => e.listening).map((e) => e.addr), sockets: conns.size,
      ...(lastError ? { error: lastError } : {}),
    };
  }
  async function stop() {
    stopped = true;
    await sync(false);
    if (pinger) { clearInterval(pinger); pinger = null; }
  }
  return { sync, send, targets, proven, bad, connected: (dev) => targets(dev).length > 0, closeDevice, status, stop };
}

module.exports = { createLan, privateIPv4s, isPrivate, LAN_PORT, LIMITS };
