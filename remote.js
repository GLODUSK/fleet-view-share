// remote.js: Fleet View in a browser on Henry's other devices (his Mac), over Tailscale. Reaching the page from
// another device is the same as running commands on this PC (a live session types whatever it is sent), so the
// gate is strict: the owner's Tailscale login, remote access switched on here, and a browser approved on the PC.
//
// How a request gets here. The server only listens on 127.0.0.1. With remote access on, `tailscale serve --bg
// --https=443 http://127.0.0.1:<port>` makes tailscaled answer https://<this PC's tailnet name> (its own
// certificate) and pass each request on to the server over loopback. What it passes on was checked with a header
// echo server behind `tailscale serve --http` (Tailscale 1.104, 2026-10-10):
//   Host                        exactly what the browser sent: "<pc>.<tailnet>.ts.net" (":<port>" only for a port
//                               other than the scheme's), so not 127.0.0.1. A Host it has no serve config for (the
//                               bare 100.x address) gets tailscaled's own 404 and never reaches the server.
//   Tailscale-User-Login        the signed-in Tailscale user of the device the request came from
//   Tailscale-User-Name, Tailscale-User-Profile-Pic, Tailscale-Headers-Info (a link to the docs about them)
//   X-Forwarded-For             the device's 100.x address; X-Forwarded-Host: the Host again
//   (no X-Forwarded-Proto)      Accept-Encoding, Origin, Cookie and Sec-Fetch-* go through as the browser sent them
// The Tailscale-User-* and X-Forwarded-* headers a client sends itself are dropped and written again by tailscaled,
// so a device can't claim to be someone else. A tagged device (no user) or a Funnel request (the public internet)
// gets no Tailscale-User-Login at all. The socket's far end is always loopback (tailscaled itself).
//
// classify(req) sorts every request (and WebSocket upgrade) into:
//   local    Host is 127.0.0.1:<port> or localhost:<port> (the desktop window, Edge, fv, the API), as before, and
//            carries none of the proxy's headers: should a later tailscaled rewrite Host to its target, as many
//            proxies do, a request from another device must not pass for this PC's own page
//   remote   Host is this PC's tailnet name (":443" allowed), from loopback, with a Tailscale-User-Login that is
//            the tailnet owner of this PC (or one listed by hand in settings remote.logins), while remote access is
//            on. who.device is the approved browser its fv_device cookie names (that device's login must match),
//            or null: then only the pairing routes answer (route()).
//   refused  anything else: { code, message }
// Anything that reaches 127.0.0.1 could already do all this as a local process; the gate is about other devices.
//
// Pairing, one approval per browser. A browser without an approved device cookie only gets the pairing page:
// GET / goes to /pair; /pair (web/pair.html), /pair.js, /pair.css, POST /remote/pair, GET /remote/pair/status and
// GET /remote/me answer, nothing else. POST /remote/pair { label } makes a pending request with a 6-digit code
// (at most 5 at once, each for 10 minutes) and sets an HttpOnly fv_pair cookie; the PC's page (or an approved
// device) shows "<label> wants to use Fleet View — code <code>" and POSTs /remote/approve or /remote/deny { id }.
// The waiting page's next GET /remote/pair/status then gets { approved: true } with the fv_device cookie (32
// random bytes, a year's half). Only its sha256 is kept, in %LOCALAPPDATA%\fleet-view\remote-devices.json
// ({ id, label, login, createdAt, lastSeen, hash }), compared in constant time; POST /remote/revoke { id } drops one.
//
// createRemote({ port, file, demo, serve, enabled, logins, log, onChange }) -> {
//   classify(req), route(req, res, pathname, who, ctx) -> true when it answered, common(req, res, pathname, who, ctx)
//   -> true when it answered (GET /remote/me, POST /remote/approve|deny|revoke, for local and approved devices),
//   view() (/state's remote), enabled(), setEnabled(on), start(), refresh(), originOk(who, origin), cookie names,
//   and for preview.js's extra ports (see "extra ports" below): whoAt(req, port), servePort(port, target),
//   unservePort(port), unservePorts([ports]), servedPorts() }
// file null (the demo): devices are kept in memory only. demo: `tailscale serve` is never changed. serve false (a
// test server on another port, unless started with --remote-serve): the switch works but never touches `tailscale
// serve` either, so a test can't take 443 away from the real Fleet View.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const STATUS_EVERY_MS = 60e3;
const PENDING_MS = 10 * 60e3;
const PENDING_MAX = 5;
const DEVICE_AGE_S = 15552000; // 180 days
const SEEN_EVERY_MS = 60e3;
const RUN_MS = 20e3;
// __Host-: only this host's own https answers can set it, for Path=/ only, so a page on a narrower path can't shadow it
const DEVICE_COOKIE = '__Host-fv_device', PAIR_COOKIE = 'fv_pair';
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/; // 32 bytes, base64url
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const HTTPS_OFF = 'HTTPS certificates are not enabled for this tailnet: turn them on at https://login.tailscale.com/admin/dns';
// headers only tailscale serve (or another proxy) adds: a request with any of them is never this PC's own page
const PROXY_HEADERS = ['tailscale-user-login', 'tailscale-user-name', 'tailscale-headers-info', 'x-forwarded-for', 'x-forwarded-host', 'forwarded'];

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();
const newToken = () => crypto.randomBytes(32).toString('base64url');
const lower = (s) => String(s || '').trim().toLowerCase();
// every value a request's cookies give that name: another page on this host name (a shared dev page) can add its own
// on a narrower path, which the browser sends first, so the right one may be any of them
function cookiesOf(req, name) {
  const out = [];
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) out.push(part.slice(i + 1).trim());
  }
  return out.slice(0, 8);
}
// a label a browser gave itself ("Mac · Safari"): one short line of plain text
const cleanLabel = (s) => (typeof s === 'string' ? s.replace(/[\x00-\x1f\x7f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60) : '') || 'A browser';
// tailscale.exe: its usual place on Windows, else whatever PATH finds
function tailscaleExe() {
  if (process.platform === 'win32') {
    const f = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe');
    if (fs.existsSync(f)) return f;
  }
  return 'tailscale';
}

function createRemote({ port, file = null, demo = false, serve = true, enabled = false, logins = [], log = () => {}, onChange = () => {}, exe = null } = {}) {
  const target = `http://127.0.0.1:${port}`;
  const extraLogins = new Set((Array.isArray(logins) ? logins : []).filter((x) => typeof x === 'string').map(lower).filter(Boolean));
  let on = !!enabled;
  // what `tailscale status --json` said last: this PC's tailnet name, its owner's login, whether HTTPS certificates
  // are on (CertDomains), and when it was read
  const ts = { name: null, owner: null, https: false, at: 0, error: null, reading: null };
  // where the switch got to: off | turning on | on | turning off | error
  let status = on ? 'starting' : 'off', error = null, busy = Promise.resolve();
  const pending = new Map(); // id -> { id, code, label, login, at, hash, approved, denied }
  let devices = loadDevices();
  let saveTimer = null;

  function run(args) {
    return new Promise((resolve) => {
      execFile(exe || tailscaleExe(), args, { windowsHide: true, timeout: RUN_MS, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
        resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || ''), code: err ? (err.killed ? 'timeout' : err.code) : 0 });
      });
    });
  }
  // read `tailscale status --json`; never in a request's way (requests use what was read last)
  function refresh() {
    if (ts.reading) return ts.reading;
    ts.reading = run(['status', '--json']).then((r) => {
      ts.reading = null;
      ts.at = Date.now();
      let j = null;
      try { j = JSON.parse(r.out); } catch {}
      const self = j && j.Self;
      if (!self || !self.DNSName || j.BackendState !== 'Running') {
        ts.error = j && j.BackendState && j.BackendState !== 'Running' ? `Tailscale is ${String(j.BackendState).toLowerCase()}` : 'Tailscale is not running here';
        ts.name = null; ts.owner = null; ts.https = false;
        return ts;
      }
      ts.error = null;
      ts.name = lower(self.DNSName).replace(/\.$/, '');
      const user = j.User && j.User[String(self.UserID)];
      ts.owner = user && user.LoginName ? lower(user.LoginName) : null;
      ts.https = Array.isArray(j.CertDomains) && j.CertDomains.some((d) => lower(d).replace(/\.$/, '') === ts.name);
      return ts;
    });
    return ts.reading;
  }
  const allowedLogin = (login) => !!login && ((ts.owner && login === ts.owner) || extraLogins.has(login));
  const refused = (code, message) => ({ kind: 'refused', code, message });

  // ---------- devices ----------
  function loadDevices() {
    if (!file) return [];
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      return (Array.isArray(j && j.devices) ? j.devices : []).filter((d) => d && typeof d.id === 'string' && /^[0-9a-f]{64}$/.test(d.hash))
        .map((d) => ({ id: d.id, label: cleanLabel(d.label), login: lower(d.login), createdAt: Number(d.createdAt) || 0, lastSeen: Number(d.lastSeen) || 0, hash: d.hash }));
    } catch { return []; }
  }
  function saveDevices(now = false) {
    if (!file) return;
    clearTimeout(saveTimer);
    const write = () => {
      saveTimer = null;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ devices }, null, 2), { mode: 0o600 });
        fs.renameSync(tmp, file);
      } catch (e) { log(`could not save ${file}: ${e.message}`); }
    };
    if (now) write(); else saveTimer = setTimeout(write, 2000);
  }
  // the approved device a request's fv_device cookie names, for that Tailscale login; every stored hash is compared
  // (constant time each), so how long it takes says nothing about which one matched
  function deviceFor(req, login) {
    let found = null;
    for (const tok of cookiesOf(req, DEVICE_COOKIE)) {
      if (!TOKEN_RE.test(tok)) continue;
      const h = sha256(tok);
      for (const d of devices) if (crypto.timingSafeEqual(h, Buffer.from(d.hash, 'hex')) && d.login === login) found = d;
    }
    if (found && Date.now() - found.lastSeen >= SEEN_EVERY_MS) { found.lastSeen = Date.now(); saveDevices(); }
    return found;
  }

  // ---------- who is asking ----------
  function classify(req) {
    if (req.fvWho) return req.fvWho;
    const h = req.headers, host = lower(h.host);
    if (!LOOPBACK.has(req.socket && req.socket.remoteAddress)) return (req.fvWho = refused(403, 'not from this PC'));
    const proxied = PROXY_HEADERS.some((k) => k in h);
    if (host === `127.0.0.1:${port}` || host === `localhost:${port}`) return (req.fvWho = proxied ? refused(403, 'bad host') : { kind: 'local' });
    if (!ts.name) { if (Date.now() - ts.at > 5000) refresh(); return (req.fvWho = refused(403, 'bad host')); }
    if (host !== ts.name && host !== ts.name + ':443') return (req.fvWho = refused(403, 'bad host'));
    if (!on) return (req.fvWho = refused(403, 'remote access is off on the PC'));
    const login = lower(h['tailscale-user-login']);
    if (!allowedLogin(login)) return (req.fvWho = refused(403, 'this Tailscale user may not use Fleet View'));
    return (req.fvWho = { kind: 'remote', name: ts.name, login, device: deviceFor(req, login) });
  }
  // a remote request's Origin, when it has one, must be this PC's https address
  const originOk = (who, origin) => !origin || origin === `https://${who.name}`;

  // ---------- pairing ----------
  function sweep() {
    const now = Date.now();
    for (const [id, p] of pending) if (now - p.at > PENDING_MS) pending.delete(id);
  }
  function pendingFor(req) {
    let found = null;
    for (const tok of cookiesOf(req, PAIR_COOKIE)) {
      if (!TOKEN_RE.test(tok)) continue;
      const h = sha256(tok);
      for (const p of pending.values()) if (crypto.timingSafeEqual(h, p.hash)) found = p;
    }
    return found;
  }
  const cookie = (name, value, maxAge, where = '/') => `${name}=${value}; HttpOnly; Secure; SameSite=Strict; Path=${where}; Max-Age=${maxAge}`;
  function startPairing(req, res, who, ctx) {
    ctx.readBody(req, res, (b) => {
      sweep();
      const mine = pendingFor(req);
      if (mine && !mine.denied && mine.login === who.login) return ctx.sendJson(res, 200, { ok: true, code: mine.code, expiresAt: mine.at + PENDING_MS });
      if ([...pending.values()].filter((p) => !p.approved && !p.denied).length >= PENDING_MAX) return ctx.sendJson(res, 429, { ok: false, message: 'too many devices are waiting for approval; try again in a few minutes' });
      const tok = newToken();
      const p = { id: crypto.randomBytes(8).toString('hex'), code: String(crypto.randomInt(0, 1e6)).padStart(6, '0'), label: cleanLabel(b && b.label), login: who.login,
        at: Date.now(), hash: sha256(tok), approved: false, denied: false };
      pending.set(p.id, p);
      log(`pairing asked: "${p.label}" (${p.login}) from ${String(req.headers['x-forwarded-for'] || '?')}`);
      res.setHeader('Set-Cookie', cookie(PAIR_COOKIE, tok, PENDING_MS / 1000, '/remote/pair'));
      ctx.sendJson(res, 200, { ok: true, code: p.code, expiresAt: p.at + PENDING_MS });
    });
  }
  function pairStatus(req, res, who, ctx) {
    sweep();
    const p = pendingFor(req);
    if (!p || p.login !== who.login) return ctx.sendJson(res, 200, { ok: true, approved: false, waiting: false });
    if (p.denied) {
      pending.delete(p.id);
      res.setHeader('Set-Cookie', cookie(PAIR_COOKIE, '', 0, '/remote/pair'));
      return ctx.sendJson(res, 200, { ok: true, approved: false, waiting: false, denied: true });
    }
    if (!p.approved) return ctx.sendJson(res, 200, { ok: true, approved: false, waiting: true, code: p.code, expiresAt: p.at + PENDING_MS });
    // approved: this browser becomes a device now, and the pairing ends
    pending.delete(p.id);
    const tok = newToken(), now = Date.now();
    devices.push({ id: crypto.randomBytes(8).toString('hex'), label: p.label, login: p.login, createdAt: now, lastSeen: now, hash: sha256(tok).toString('hex') });
    saveDevices(true);
    log(`device approved: "${p.label}" (${p.login})`);
    res.setHeader('Set-Cookie', [cookie(DEVICE_COOKIE, tok, DEVICE_AGE_S), cookie(PAIR_COOKIE, '', 0, '/remote/pair')]);
    ctx.sendJson(res, 200, { ok: true, approved: true });
  }
  function decide(id, approve) {
    sweep();
    const p = typeof id === 'string' ? pending.get(id) : null;
    if (!p || p.approved || p.denied) return [404, { ok: false, message: 'that request is gone (it waits 10 minutes)' }];
    if (approve) p.approved = true; else p.denied = true;
    log(`pairing ${approve ? 'allowed' : 'denied'}: "${p.label}" (${p.login})`);
    return [200, { ok: true }];
  }
  function revoke(id) {
    const n = devices.length;
    devices = devices.filter((d) => d.id !== id);
    if (devices.length === n) return [404, { ok: false, message: 'no such device' }];
    saveDevices(true);
    log(`device revoked: ${id}`);
    onChange();
    return [200, { ok: true }];
  }

  // ---------- routes ----------
  // A remote request, before the page's routes: the API never, the Origin checks, the security headers, and for a
  // browser not approved yet only the pairing routes. true: answered here.
  function route(req, res, pathname, who, ctx) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    if (pathname === '/api' || pathname.startsWith('/api/')) return ctx.sendJson(res, 403, { ok: false, message: 'the API is for this PC only' }), true;
    const origin = req.headers.origin, site = req.headers['sec-fetch-site'];
    if (!originOk(who, origin) || site === 'cross-site' || site === 'same-site') return ctx.sendJson(res, 403, { ok: false, message: 'bad origin' }), true;
    const read = req.method === 'GET' || req.method === 'HEAD';
    if (!read && !origin && site !== 'same-origin') return ctx.sendJson(res, 403, { ok: false, message: 'bad origin' }), true;
    if (who.device) {
      if (pathname === '/pair') return redirect(res, '/'), true;
      return false;
    }
    if (read && pathname === '/') return redirect(res, '/pair'), true;
    if (read && (pathname === '/pair' || pathname === '/pair.js' || pathname === '/pair.css')) return false;
    if (read && pathname === '/remote/me') return ctx.sendJson(res, 200, me(who)), true;
    if (req.method === 'POST' && pathname === '/remote/pair') return startPairing(req, res, who, ctx), true;
    if (req.method === 'GET' && pathname === '/remote/pair/status') return pairStatus(req, res, who, ctx), true;
    ctx.sendJson(res, 401, { ok: false, message: 'approve this device on the PC first', pair: '/pair' });
    return true;
  }
  function redirect(res, to) {
    res.writeHead(302, { Location: to, 'Cache-Control': 'no-store', 'Content-Length': 0 });
    res.end();
  }
  const me = (who) => ({ remote: who.kind === 'remote', approved: who.kind === 'local' || !!(who.device), name: ts.name, enabled: on });
  // /remote/* for this PC's page and approved devices (the gate ran already: who is local, or remote with a device)
  function common(req, res, pathname, who, ctx) {
    if (!pathname.startsWith('/remote/')) return false;
    if ((req.method === 'GET' || req.method === 'HEAD') && pathname === '/remote/me') return ctx.sendJson(res, 200, me(who)), true;
    const act = req.method === 'POST' && { '/remote/approve': (b) => decide(b.id, true), '/remote/deny': (b) => decide(b.id, false), '/remote/revoke': (b) => revoke(b.id) }[pathname];
    if (!act) return false;
    if (who.kind !== 'local' && !(who.kind === 'remote' && who.device)) return ctx.sendJson(res, 403, { ok: false, message: 'not allowed' }), true;
    ctx.readBody(req, res, (b) => {
      if (!b || typeof b.id !== 'string') return ctx.sendJson(res, 400, { ok: false, message: 'no id given' });
      const [code, out] = act(b);
      ctx.sendJson(res, code, out);
    });
    return true;
  }

  // ---------- the switch: tailscale serve ----------
  // what 443 on the tailnet serves now: our target, another one, or nothing
  async function serving() {
    const r = await run(['serve', 'status', '--json']);
    let j = null;
    try { j = JSON.parse(r.out || '{}'); } catch {}
    if (!j) return { known: false };
    const web = j.Web && ts.name ? j.Web[`${ts.name}:443`] : null;
    const proxy = web && web.Handlers && web.Handlers['/'] && web.Handlers['/'].Proxy;
    const tcp = j.TCP && j.TCP['443'];
    return { known: true, proxy: proxy || null, used: !!tcp };
  }
  const sameTarget = (p) => !!p && lower(p).replace(/\/$/, '') === target;
  async function turnOn(force) {
    status = 'turning on'; error = null;
    await refresh();
    if (!ts.name) { status = 'error'; error = ts.error || 'Tailscale is not running here'; return; }
    if (!ts.https) { status = 'error'; error = HTTPS_OFF; return; }
    const now = await serving();
    if (now.known && sameTarget(now.proxy)) { status = 'on'; return; }
    // on start, 443 serving something else is left alone; the switch (force) takes it over
    if (!force && now.known && now.used) { status = 'error'; error = `port 443 on Tailscale already serves ${now.proxy || 'something else'}; switch remote access off and on to use it for Fleet View`; return; }
    const r = await run(['serve', '--bg', '--https=443', target]);
    const after = await serving();
    if (after.known && sameTarget(after.proxy)) { status = 'on'; log(`tailscale serve: https://${ts.name} -> ${target}`); return; }
    // it may stop to ask for a step on Tailscale's website (serve not allowed on the tailnet yet): that link is the error
    const text = (r.out + '\n' + r.err).trim(), link = (text.match(/https:\/\/login\.tailscale\.com\/\S+/) || [])[0];
    status = 'error';
    error = link ? `Tailscale asks for a step first: open ${link}`
      : r.code === 'timeout' ? `tailscale serve did not finish within ${RUN_MS / 1000} s`
      : `tailscale serve failed: ${text.split(/\r?\n/).filter(Boolean).slice(-2).join(' ') || 'no output'}`;
    log(error);
  }
  async function turnOff() {
    status = 'turning off'; error = null;
    const now = await serving();
    // 443 serving something other than Fleet View is not ours to stop
    if (now.known && now.used && !sameTarget(now.proxy)) { status = 'off'; return; }
    const r = now.known && !now.used ? { ok: true } : await run(['serve', '--https=443', 'off']);
    status = 'off';
    if (!r.ok) { error = `tailscale serve off failed: ${(r.err || r.out).trim().split(/\r?\n/).pop() || r.code}`; log(error); }
    else log('tailscale serve: https off');
  }
  function setEnabled(want, force = true) {
    on = !!want;
    if (!on) pending.clear(); // nobody can finish pairing while it is off
    onChange();
    if (demo) { status = on ? 'on' : 'off'; error = null; return Promise.resolve(); }
    if (!serve) {
      status = on ? 'error' : 'off';
      error = on ? `only the Fleet View on port 4777 changes tailscale serve (this one is on port ${port}; --remote-serve lets it)` : null;
      return Promise.resolve();
    }
    // switched off: the previews' extra ports go too (whoAt refuses them already)
    busy = busy.then(() => (on ? turnOn(force) : turnOff().then(() => unserveNow()))).catch((e) => { status = 'error'; error = e.message; });
    return busy;
  }

  // ---------- extra ports: dev-server previews (preview.js) ----------
  // preview.js shows a conversation's dev server to an approved remote browser at https://<name>:<the dev server's
  // port>, which `tailscale serve --bg --https=<port>` points at preview.js's gated proxy on loopback. These helpers
  // are the tailscale side; they share the 443 switch's queue (tailscale serve rewrites its whole config on each
  // change, so two at once could lose one). Every port they serve is written down first (servedFile, next to the
  // devices file), and only a port in that record that still points where it was set is ever turned off, so other
  // serve entries (443's, anything set by hand) are never touched. Measured with Tailscale 1.104.1 (2026-10-10):
  // setting a port takes ~140 ms and the first request through it ~190 ms (the name's certificate is the one 443
  // uses); any port from 1024 up works; tailscaled listens on the tailnet addresses only (100.x:<port>), so it sits
  // beside a dev server listening on 0.0.0.0, [::] or loopback with the same port, in either order; WebSockets pass.
  // a port a preview may take: 1024 and up, never 443 (the page's) or this server's own
  const okPort = (p) => Number.isInteger(p) && p >= 1024 && p < 65536 && p !== 443 && p !== port;
  const servedFile = file ? path.join(path.dirname(file), 'preview-serve.json') : null;
  let served = loadServed(); // port -> { port, target, at }
  function loadServed() {
    const m = new Map();
    if (!servedFile) return m;
    try { for (const e of JSON.parse(fs.readFileSync(servedFile, 'utf8')).ports || []) if (e && okPort(e.port) && typeof e.target === 'string') m.set(e.port, { port: e.port, target: e.target, at: Number(e.at) || 0 }); } catch {}
    return m;
  }
  function saveServed() {
    if (!servedFile) return;
    try {
      fs.mkdirSync(path.dirname(servedFile), { recursive: true });
      const tmp = `${servedFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ ports: [...served.values()] }, null, 1));
      fs.renameSync(tmp, servedFile);
    } catch (e) { log(`could not save ${servedFile}: ${e.message}`); }
  }
  const mayServe = () => !demo && serve;
  // what <name>:<p> serves now: { known, proxy, used }
  async function servingAt(p) {
    const r = await run(['serve', 'status', '--json']);
    let j = null;
    try { j = JSON.parse(r.out || '{}'); } catch {}
    if (!j || !ts.name) return { known: false };
    const web = j.Web && j.Web[`${ts.name}:${p}`];
    const proxy = web && web.Handlers && web.Handlers['/'] && web.Handlers['/'].Proxy;
    return { known: true, proxy: proxy || null, used: !!(j.TCP && j.TCP[String(p)]) };
  }
  const sameAs = (a, b) => !!a && lower(a).replace(/\/$/, '') === lower(b).replace(/\/$/, '');
  // servePort(p, target) -> { ok, url } or { ok: false, message }: https://<name>:<p> on the tailnet passed on to target
  // (an http://127.0.0.1:<n> address), unless that port already serves something else
  function servePort(p, target) {
    if (!okPort(p)) return Promise.resolve({ ok: false, message: `port ${p} can't be shared` });
    if (!/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(String(target))) return Promise.resolve({ ok: false, message: 'bad target' });
    if (!on) return Promise.resolve({ ok: false, message: 'remote access is off' });
    if (!mayServe()) return Promise.resolve({ ok: false, message: demo ? 'the demo never changes tailscale serve' : `only the Fleet View on port 4777 changes tailscale serve (this one is on port ${port})` });
    const job = busy.then(async () => {
      if (!ts.name) await refresh();
      if (!ts.name) return { ok: false, message: ts.error || 'Tailscale is not running here' };
      if (!ts.https) return { ok: false, message: HTTPS_OFF };
      const url = `https://${ts.name}:${p}`;
      const now = await servingAt(p);
      if (!now.known) return { ok: false, message: 'could not read tailscale serve status' };
      if (sameAs(now.proxy, target)) { if (!served.has(p)) { served.set(p, { port: p, target, at: Date.now() }); saveServed(); } return { ok: true, url }; }
      // someone else's (or one of ours that now points elsewhere): never taken over
      if (now.used) return { ok: false, message: `port ${p} on Tailscale already serves ${now.proxy || 'something else'}` };
      served.set(p, { port: p, target, at: Date.now() }); // written down before it exists, so a crash can't leave one unrecorded
      saveServed();
      const r = await run(['serve', '--bg', `--https=${p}`, target]);
      const after = await servingAt(p);
      if (after.known && sameAs(after.proxy, target)) { log(`tailscale serve: ${url} -> ${target} (preview)`); return { ok: true, url }; }
      if (!after.known || !after.used) { served.delete(p); saveServed(); }
      const text = (r.out + '\n' + r.err).trim();
      return { ok: false, message: r.code === 'timeout' ? `tailscale serve did not finish within ${RUN_MS / 1000} s` : `tailscale serve failed: ${text.split(/\r?\n/).filter(Boolean).slice(-2).join(' ') || 'no output'}` };
    });
    busy = job.catch(() => {});
    return job.catch((e) => ({ ok: false, message: e.message }));
  }
  // off again: the recorded ports given (all of them when none are), each only while it still points where it was set
  function unservePorts(ports) {
    if (!mayServe() || !(ports ? ports : [...served.keys()]).some((p) => served.has(p))) return Promise.resolve();
    const job = busy.then(() => unserveNow(ports));
    busy = job.catch(() => {});
    return job.catch(() => {});
  }
  // the same, already inside the queue (the switch's off)
  async function unserveNow(ports) {
    const list = (ports ? ports : [...served.keys()]).filter((p) => served.has(p));
    if (!list.length || !mayServe()) return;
    if (!ts.name) await refresh();
    if (!ts.name) return; // Tailscale isn't running: kept in the record for next time
    for (const p of list) {
      const e = served.get(p);
      const now = await servingAt(p);
      if (!now.known) continue;
      if (now.used && sameAs(now.proxy, e.target)) {
        const r = await run(['serve', `--https=${p}`, 'off']);
        if (!r.ok) { log(`tailscale serve --https=${p} off failed: ${(r.err || r.out).trim().split(/\r?\n/).pop() || r.code}`); continue; }
        log(`tailscale serve: https port ${p} off (preview)`);
      }
      served.delete(p);
    }
    saveServed();
  }
  const unservePort = (p) => unservePorts([p]);
  // whoAt(req, p): a request tailscale serve passed on from https://<name>:<p> (a preview's port), checked as classify
  // checks a remote one: from loopback, that Host exactly, remote access on, the owner's Tailscale login, and an
  // approved device's cookie (cookies don't depend on the port, so the browser sends fv_device here too). The
  // device's { name, login, device } or null. Never cached on req: an open socket asks again.
  function whoAt(req, p) {
    const h = req.headers;
    if (!LOOPBACK.has(req.socket && req.socket.remoteAddress) || !on || !ts.name || !okPort(p)) return null;
    if (lower(h.host) !== `${ts.name}:${p}`) return null;
    const login = lower(h['tailscale-user-login']);
    if (!allowedLogin(login)) return null;
    const device = deviceFor(req, login);
    return device ? { name: ts.name, login, device } : null;
  }

  // /state's remote: the switch, the address to open, how it went, who is waiting and the approved devices
  function view() {
    sweep();
    return {
      enabled: on, name: ts.name, url: ts.name ? `https://${ts.name}` : null, status, error,
      https: ts.https, demo: !!demo,
      pending: [...pending.values()].filter((p) => !p.approved && !p.denied).map((p) => ({ id: p.id, code: p.code, label: p.label, login: p.login, at: p.at })),
      devices: devices.map((d) => ({ id: d.id, label: d.label, login: d.login, createdAt: d.createdAt, lastSeen: d.lastSeen })),
    };
  }
  // start: read Tailscale now and every minute; with the switch on, make sure 443 still points here
  function start() {
    // a server that stopped while a preview was shared left its ports pointing at a proxy that is gone: off first
    // (and again every minute until it worked: at sign-in Tailscale may not be up yet)
    const stale = new Set(served.keys());
    const clean = () => { if (stale.size) unservePorts([...stale]).then(() => { for (const p of [...stale]) if (!served.has(p)) stale.delete(p); }); };
    refresh().then(() => { clean(); if (on) setEnabled(true, false); });
    const t = setInterval(() => { refresh().then(clean); sweep(); }, STATUS_EVERY_MS);
    if (t.unref) t.unref();
  }
  // the server is exiting: its previews' ports go now (their proxy goes with it, and whatever listens on that port
  // next must never be on the tailnet), waiting for tailscale here since nothing runs after; each only while it still
  // points where it was set, as unserveNow
  function unserveSync() {
    if (!served.size || !mayServe() || !ts.name) return;
    const tsx = (args) => require('child_process').execFileSync(exe || tailscaleExe(), args, { windowsHide: true, timeout: 5000, encoding: 'utf8' });
    let j = null;
    try { j = JSON.parse(tsx(['serve', 'status', '--json']) || '{}'); } catch { return; }
    for (const [p, e] of [...served]) {
      const web = j.Web && j.Web[`${ts.name}:${p}`];
      const proxy = web && web.Handlers && web.Handlers['/'] && web.Handlers['/'].Proxy;
      if (j.TCP && j.TCP[String(p)] && !sameAs(proxy, e.target)) continue;
      try { tsx(['serve', `--https=${p}`, 'off']); served.delete(p); log(`tailscale serve: https port ${p} off (exiting)`); } catch {}
    }
    saveServed();
  }
  return {
    classify, route, common, view, start, refresh, originOk, setEnabled,
    whoAt, servePort, unservePort, unservePorts, unserveSync, servedPorts: () => [...served.keys()],
    enabled: () => on,
    flush: () => { if (saveTimer) saveDevices(true); },
    DEVICE_COOKIE, PAIR_COOKIE,
    _test: { ts, pending, devices: () => devices, decide, revoke },
  };
}

module.exports = { createRemote, _test: { cookiesOf, cleanLabel, TOKEN_RE, PROXY_HEADERS } };
