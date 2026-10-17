// The link between machines: a test of link.js and realtime.js with two real relay.js instances, run with the system
// node:   node scripts/link-test.js
// Two machines, a Mac (R, the lower device id, so the one that asks) and a PC (A), each with its relay and its link,
// meet in fakes the test plays: Supabase's settings and devices tables (an in-memory REST with like./in./eq. filters,
// each machine's reads passing a hook a man in the middle can use; every machine marked alive gets its last_seen_at
// moved every 30 s, as the mover does), Supabase Realtime (a hub that joins channels, answers heartbeats, carries
// broadcasts to the others on a topic and keeps presence), and each machine's Fleet View (an HTTP server on a spare
// port that checks the API token, the marker and the peer header). One fake clock and one timer queue for all.
// It checks: nothing opens (no socket, no key read) with nothing linked; the lower id asks by itself, and the other
// machine, started later, links within a minute with no click and no code, one pairing only, both relays then serving
// each other as a computer and the keys agreeing across the two machines, the rows gone after; calls both ways (GET
// /peer/status through the relay with the peer header and the marker, a message with the marker, a big answer in parts
// down, a big body in parts up, a 429 passed on, a lost answer asked again with the same id getting the kept answer and
// the server hit once); a phone still refused the /peer/ routes; presence (offline at once when the other relay's
// socket drops, online again when it rejoins); unlink taking effect on both at once (the notice) and sticking (the mark:
// neither links by itself for ten minutes); Link after it (the higher id pressing it) linking again; unlink while the
// other machine is off (the mark, read when it comes back, and it sticks there too); a restart keeping the link (no new
// pairing); an older version's gone row still unlinking, and the link coming back by itself with no mark; a reveal
// that does not match its commitment refused with nothing linked, then the retry linking by itself; both pressing Link
// at once (one pairing goes on, the higher id drops its own); and, with a third machine and two that never answer:
// the higher id waits graceMs before it asks, the lower asks at once, a pairing runs out, a machine that went away is
// not asked again, and is asked at once when its last_seen_at moves again; and the pace (the flows above poll every
// 5 s by a timing option): by default the rows are read every 60 s while nothing pairs, every second while one does.
// Since 2026-10-13 nothing is compared on screen: whoever has the sync key and Henry's sign-in can link a machine (a man
// in the middle who swaps both keys links each side with himself), the trust docs/link.md "The locks" states.
// Exit 0 = all pass. Everything in a temp folder, deleted at the end. No network.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const RL = require(path.join(ROOT, 'relay.js'));
const L = require(path.join(ROOT, 'link.js'));
const K = require(path.join(ROOT, 'sync-crypto.js'));

let passed = 0, failed = 0;
const ok = (c, msg) => { if (c) passed++; else { failed++; console.log(`FAIL ${msg}`); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}: want ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'link-test-'));
const realWait = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };

// ---------- one clock, one timer queue ----------
const clock = { t: Date.UTC(2026, 9, 11, 12, 0, 0) };
const now = () => clock.t;
const queue = new Map();
let tn = 0;
const timers = {
  setTimeout(fn, ms) { const id = ++tn; queue.set(id, { at: clock.t + Math.max(0, Number(ms) || 0), fn }); return id; },
  clearTimeout(id) { queue.delete(id); },
};
async function advance(ms) {
  const end = clock.t + ms;
  for (;;) {
    let id = null, x = null;
    for (const [k, v] of queue) if (v.at <= end && (!x || v.at < x.at)) { id = k; x = v; }
    if (!x) break;
    queue.delete(id);
    clock.t = Math.max(clock.t, x.at);
    try { x.fn(); } catch (e) { console.log(`a timer threw: ${e && e.stack}`); }
    await settle();
  }
  clock.t = end;
  await settle();
}
// time passes in steps (real time between them for the loopback HTTP), until cond() or max ms of fake time
async function until(cond, max = 30e3, step = 250) {
  for (let t = 0; t <= max; t += step) {
    if (await cond()) return true;
    await advance(step);
    await realWait(3);
  }
  return !!(await cond());
}
// a promise, with fake time passing until it settles (max ms of fake time)
async function pass(p, max = 120e3, step = 250) {
  let done = false, val;
  p.then((v) => { done = true; val = v; }, (e) => { done = true; val = { error: e }; });
  await until(() => done, max, step);
  return done ? val : { error: 'did not settle' };
}

// ---------- Supabase: the settings and devices tables ----------
const UID = crypto.randomUUID();
const SYNC_KEY = crypto.randomBytes(32);
const db = { settings: [], devices: [] };
const lower = (s) => (s == null ? null : String(s).toLowerCase());
function inList(raw) { const m = /^\((.*)\)$/s.exec(raw); return (m[1].match(/"[^"]*"|[^,]+/g) || []).map((v) => lower(v.replace(/^"|"$/g, ''))); }
function match(row, q) {
  for (const [col, v] of Object.entries(q || {})) {
    if (['select', 'on_conflict', 'order', 'limit'].includes(col)) continue;
    const m = /^(eq|in|like)\.(.*)$/s.exec(String(v));
    if (!m) throw new Error(`the fake does not know ${col}=${v}`);
    const [, op, raw] = m, have = lower(row[col]);
    if (op === 'eq' && have !== lower(raw)) return false;
    if (op === 'in' && !inList(raw).includes(have)) return false;
    if (op === 'like' && !(have !== null && new RegExp(`^${raw.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i').test(have))) return false;
  }
  return true;
}
const pick = (row, sel) => (!sel || sel === '*' ? { ...row } : Object.fromEntries(sel.split(',').map((c) => [c, row[c] === undefined ? null : row[c]])));
const calls = [];
async function rest(who, method, table, o = {}) {
  const q = o.query || {};
  const one = o.body && !Array.isArray(o.body) && typeof o.body.key === 'string' ? o.body : null;
  calls.push({ who, method, table, query: { ...q }, key: one ? one.key : null, v: one && /^link/.test(one.key) ? openRow(one) : null });
  if (!db[table]) throw new Error(`no table ${table}`);
  if (method === 'GET') {
    const rows = db[table].filter((r) => match(r, q)).map((r) => pick(r, q.select));
    return who.tamper ? who.tamper(table, rows) : rows;
  }
  if (method === 'POST') {
    for (const item of Array.isArray(o.body) ? o.body : [o.body]) {
      const hit = db[table].find((r) => r.key === item.key);
      if (hit) Object.assign(hit, item, { updated_at: new Date(clock.t).toISOString() });
      else db[table].push({ ...item, user_id: UID, updated_at: new Date(clock.t).toISOString() });
    }
    return null;
  }
  if (method === 'DELETE') { db[table] = db[table].filter((r) => !match(r, q)); return null; }
  throw new Error(`no method ${method}`);
}
const linkRows = () => db.settings.filter((r) => /^link/.test(r.key)).map((r) => r.key).sort();
const openRow = (r) => JSON.parse(K.openText(r.value_enc, SYNC_KEY, `setting:${r.key}`));
const sealRow = (k, v) => K.sealText(JSON.stringify(v), SYNC_KEY, `setting:${k}`);
// the asks written so far, by whom (and to whom)
const asks = (who, to) => calls.filter((c) => c.method === 'POST' && /^link:[0-9a-f]{16}:ask$/.test(c.key || '') && (!who || c.who === who) && (!to || c.v.to === to));
// the mover's heartbeat: every machine marked alive gets its last_seen_at moved every 30 s
function beat() {
  for (const d of db.devices) if (d.alive) d.last_seen_at = new Date(clock.t).toISOString();
  timers.setTimeout(beat, 30e3);
}

// ---------- Supabase Realtime: a hub ----------
const hub = { topics: new Map(), socks: [], drop: null };
function deliver(sock, f) { setImmediate(() => { if (!sock.closed && sock.onmessage) sock.onmessage({ data: JSON.stringify(f) }); }); }
function hubLeave(sock, topic) {
  const members = hub.topics.get(topic);
  const me = members && members.get(sock);
  if (!me) return;
  members.delete(sock);
  if (me.tracked) for (const [s] of members) deliver(s, { topic, event: 'presence_diff', payload: { joins: {}, leaves: { [me.key]: { metas: [me.tracked] } } }, ref: null });
}
function hubGone(sock) { for (const topic of hub.topics.keys()) hubLeave(sock, topic); }
function hubSend(sock, f) {
  if (f.topic === 'phoenix') { if (f.event === 'heartbeat') deliver(sock, { topic: 'phoenix', event: 'phx_reply', payload: { status: 'ok', response: {} }, ref: f.ref }); return; }
  if (!hub.topics.has(f.topic)) hub.topics.set(f.topic, new Map());
  const members = hub.topics.get(f.topic);
  if (f.event === 'phx_join') {
    const key = f.payload && f.payload.config && f.payload.config.presence && f.payload.config.presence.key;
    members.set(sock, { key, tracked: null });
    deliver(sock, { topic: f.topic, event: 'phx_reply', payload: { status: 'ok', response: {} }, ref: f.ref, join_ref: f.ref });
    const state = {};
    for (const [s, m] of members) if (s !== sock && m.tracked) state[m.key] = { metas: [m.tracked] };
    deliver(sock, { topic: f.topic, event: 'presence_state', payload: state, ref: null });
    return;
  }
  const me = members.get(sock);
  if (!me) return;
  if (f.event === 'presence') {
    me.tracked = f.payload.payload;
    deliver(sock, { topic: f.topic, event: 'phx_reply', payload: { status: 'ok', response: {} }, ref: f.ref });
    for (const [s] of members) if (s !== sock) deliver(s, { topic: f.topic, event: 'presence_diff', payload: { joins: { [me.key]: { metas: [me.tracked] } }, leaves: {} }, ref: null });
    return;
  }
  if (f.event === 'broadcast') {
    if (hub.drop && hub.drop(f, sock)) return;
    for (const [s] of members) if (s !== sock) deliver(s, { topic: f.topic, event: 'broadcast', payload: f.payload, ref: null });
    return;
  }
  if (f.event === 'phx_leave') hubLeave(sock, f.topic);
}
function wsClass(kind) {
  return class FakeWS {
    constructor(url) {
      this.url = url; this.kind = kind; this.closed = false; this.sent = 0;
      hub.socks.push(this);
      setImmediate(() => { if (!this.closed && this.onopen) this.onopen({}); });
    }
    send(text) { if (this.closed) throw new Error('closed'); this.sent++; hubSend(this, JSON.parse(text)); }
    close() { if (this.closed) return; hubGone(this); this.closed = true; setImmediate(() => { if (this.onclose) this.onclose({ code: 1000 }); }); }
  };
}
// the network drops a socket: the others see its presence leave, and it hears a close
function kill(sock) { hubGone(sock); sock.closed = true; setImmediate(() => { if (sock.onclose) sock.onclose({ code: 1006 }); }); }
const openSocks = (kind) => hub.socks.filter((s) => !s.closed && s.kind === kind);

// ---------- each machine's Fleet View ----------
const SID = '11111111-2222-4333-8444-555555555555';
const BIG = '\u{1F680}'.repeat(450000); // 900,000 UTF-16 units: an answer in parts, cut between surrogate pairs never
function fleetView(m) {
  const srv = http.createServer((req, res) => {
    const parts = [];
    req.on('data', (b) => parts.push(b));
    req.on('end', () => {
      const u = new URL(req.url, 'http://x'), text = Buffer.concat(parts).toString('utf8');
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch {}
      m.seen.push({ method: req.method, path: u.pathname, headers: req.headers, body });
      const json = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      const p = u.pathname;
      if (p.startsWith('/api/') && req.headers.authorization !== `Bearer ${m.apiToken}`) return json(401, { ok: false });
      if (p === '/state') return json(200, { sessions: [], repos: [] });
      if (p === '/peer/status') {
        if (req.headers['x-fleet-view-relay'] !== m.relayKey) return json(403, { ok: false, message: 'only through the relay' });
        return json(200, { ok: true, device: { id: m.id, name: m.name }, peer: req.headers['x-fleet-view-peer'] });
      }
      if (p === '/peer/env' || p === '/peer/logins') {
        if (req.headers['x-fleet-view-relay'] !== m.relayKey || !req.headers['x-fleet-view-peer']) return json(403, { ok: false, message: 'only through the relay' });
        return json(200, { ok: true, route: p, id: body && body.id, peer: req.headers['x-fleet-view-peer'] });
      }
      if (p === `/api/sessions/${SID}/message`) return json(200, { ok: true, text: body && body.text, via: body && body.via, marked: req.headers['x-fleet-view-relay'] === m.relayKey });
      if (p === '/api/conversations') return json(200, { ok: true, big: BIG });
      if (p === '/chat/image') return json(200, { ok: true, got: body && typeof body.data === 'string' ? body.data.length : -1 });
      if (p === '/api/status') return json(429, { ok: false, message: 'slow down', retryAfter: 1234 });
      return json(200, { ok: true, path: p });
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

// ---------- a machine: its relay, its link ----------
const CONFIG = { url: 'https://example-project.supabase.co', key: 'test-publishable-key' };
function memStore() {
  let text = null;
  const s = { kind: 'memory', reads: 0, writes: 0, read: async () => { s.reads++; return text; }, write: async (t) => { s.writes++; text = t; }, clear: async () => { s.writes++; text = null; }, peek: () => text, stamp: () => null };
  return s;
}
async function machine(name, platform, id) {
  const m = { name, id, dataDir: path.join(T, name), seen: [], logs: [], apiToken: crypto.randomBytes(32).toString('hex'), relayKey: crypto.randomBytes(32).toString('hex'), tamper: null };
  fs.mkdirSync(m.dataDir, { recursive: true });
  db.devices.push({ id: m.id, user_id: UID, name, platform, last_seen_at: new Date(clock.t).toISOString(), alive: true });
  m.srv = await fleetView(m);
  m.relayKeys = memStore();
  m.linkKeys = memStore();
  m.sync = {
    enabled: () => true, uid: async () => UID, email: async () => 'henry@example.com', accessToken: async () => 'test-token',
    onChange: () => () => {}, rest: (method, table, o) => rest(m, method, table, o),
  };
  m.relay = RL.createRelay({
    port: m.srv.address().port, dataDir: m.dataDir, sync: m.sync, apiToken: () => m.apiToken, relayKey: () => m.relayKey, version: `1.0.${name.length}`,
    pcName: name, log: (t) => m.logs.push(t), now, timers, WebSocketImpl: wsClass(`relay:${name}`), keyStore: m.relayKeys, readConfig: () => ({ config: CONFIG }),
  });
  m.relay.start();
  m.makeLink = () => L.createLink({
    api: m.sync, key: SYNC_KEY, dataDir: m.dataDir, log: (t) => m.logs.push(t), relay: m.relay, device: () => m.id, name, version: `1.0.${name.length}`,
    now, timers, WebSocketImpl: wsClass(`link:${name}`), keyStore: m.linkKeys, readConfig: () => CONFIG,
    // the flows below at the old 5 s pace while nothing pairs (the default 60 s is checked on its own at the end)
    timing: { pollMs: 5e3 },
  });
  m.link = m.makeLink();
  return m;
}
const pairOf = (m, pid) => (m.link.status().pairings || []).find((p) => p.pid === pid) || null;
const pairWith = (m, other) => (m.link.status().pairings || []).find((p) => p.peer.id === other.id) || null;
const linked = (m, other) => !!(m.link.status().machines || []).find((x) => x.id === other.id && x.linked);
const machineOf = (m, other) => (m.link.status().machines || []).find((x) => x.id === other.id) || {};
const comps = (m) => m.relay.computers();

async function main() {
  // ---------- seenOnline: the card's online/offline for a machine ----------
  {
    const so = (o) => L.seenOnline({ present: null, linked: true, readAt: 1000, seen: { at: 1000, changed: true }, t: 1000, awayMs: 180e3, staleMs: 180e3, ...o });
    eq([so({ present: true }), so({ present: false })], [true, false], 'seenOnline: linked, the link\'s presence when it says');
    eq(so({ t: 1000 + 181e3, readAt: 1000 + 181e3 }), false, 'seenOnline: linked, channel not joined, last_seen_at still for awayMs: offline (never a bare unknown)');
    eq(so({}), null, 'seenOnline: linked, channel not joined, seen moving lately: not known yet (checking)');
    eq(so({ t: 1000 + 200e3 }), null, 'seenOnline: the table not read lately here: not known');
    eq(so({ linked: false, present: true }), true, 'seenOnline: not linked, seen moving lately: online (presence ignored)');
    eq(so({ linked: false, seen: { at: 1000, changed: false } }), null, 'seenOnline: seen only once so far: not known');
    eq(so({ linked: false, seen: undefined }), false, 'seenOnline: never seen: offline');
  }
  beat();
  const [lo, hi] = [crypto.randomUUID(), crypto.randomUUID()].sort();
  const R = await machine('MAC', 'darwin', lo);
  const A = await machine('PC', 'win32', hi);
  const offRow = L.offKey(R.id, A.id);

  // ---------- one machine alone: nothing linked, nothing opens, and it asks by itself ----------
  await R.link.start();
  await advance(2e3);
  eq(hub.socks.length, 0, 'nothing linked: no socket at all (relay or link)');
  eq([R.linkKeys.reads, A.linkKeys.reads, R.relayKeys.reads, A.relayKeys.reads], [0, 0, 0, 0], 'nothing linked: no key read');
  const st0 = R.link.status();
  ok(st0.running && st0.me && st0.me.id === R.id, 'status says running, and this machine');
  eq(st0.machines.map((x) => [x.id, x.name, x.linked, x.unlinked, x.linking]), [[A.id, 'PC', false, false, true]], 'the other machine listed: not linked, linking');
  const notYet = await R.link.call(A.id, 'GET', '/peer/status');
  eq([notYet.s, notYet.b.code], [0, 'not_linked'], 'a call to a machine not linked: s 0, not_linked');
  eq((await R.link.request(R.id))[0], 400, 'linking with itself: 400');
  eq((await R.link.request(crypto.randomUUID()))[0], 404, 'linking with a machine sync does not list: 404');
  eq(asks(R, A.id).length, 1, 'the Mac (the lower id) asked the PC by itself, with no click');
  const pid = asks(R, A.id)[0].key.split(':')[1];
  eq(pairOf(R, pid) && pairOf(R, pid).state, 'asking', 'and waits for its answer');
  eq((await R.link.request(A.id))[0], 409, 'Link while it is being made: 409');
  // the rows as Supabase holds them: sealed, and the ask carries only a commitment
  const askRow = db.settings.find((r) => r.key === `link:${pid}:ask`);
  ok(askRow && !/epk/.test(askRow.value_enc) && typeof openRow(askRow).commit === 'string' && !('epk' in openRow(askRow)), 'the ask is sealed and holds a commitment, no key');

  // ---------- the other machine starts: linked within a minute, no click, no code ----------
  await advance(30e3);
  const t0 = clock.t;
  await A.link.start();
  ok(await until(() => linked(R, A) && linked(A, R), 60e3), 'the PC starts: both linked, with nothing pressed');
  ok(clock.t - t0 <= 60e3, `within a minute (${Math.round((clock.t - t0) / 1000)} s)`);
  eq([pairOf(R, pid) && pairOf(R, pid).state, pairOf(A, pid) && pairOf(A, pid).state], ['linked', 'linked'], 'both pairings say linked');
  eq(pairOf(A, pid).role, 'answer', 'the PC answered');
  eq(pairOf(A, pid).peer.name, 'MAC', 'the PC knows who asked');
  eq([asks().length, asks(A).length], [1, 0], 'one pairing only: the PC (the higher id) never asked');
  ok(!('code' in pairOf(R, pid)), 'no code anywhere');
  eq(comps(A).map((c) => [c.peer, c.name]), [[R.id, 'MAC']], 'the PC\'s relay serves the Mac as a computer');
  eq(comps(R).map((c) => [c.peer, c.name]), [[A.id, 'PC']], 'the Mac\'s relay serves the PC as a computer');
  // the keys agree across the machines: what one calls with is what the other's relay opens with
  const lk = (m) => JSON.parse(m.linkKeys.peek() || '{}'), rk = (m) => JSON.parse(m.relayKeys.peek() || '{}');
  const rToA = lk(R)[A.id], aToR = lk(A)[R.id];
  ok(rToA && rk(A)[rToA.dev] && rk(A)[rToA.dev].k === rToA.k, 'the Mac\'s key for the PC is the PC relay\'s key for the Mac');
  ok(aToR && rk(R)[aToR.dev] && rk(R)[aToR.dev].k === aToR.k, 'the PC\'s key for the Mac is the Mac relay\'s key for the PC');
  ok(rToA && aToR && rToA.k !== aToR.k && rToA.dev !== aToR.dev, 'one key and id each way');
  const devs = JSON.parse(fs.readFileSync(path.join(A.dataDir, 'relay', 'devices.json'), 'utf8')).devices;
  ok(devs.length === 1 && devs[0].kind === 'computer' && devs[0].peer === R.id && devs[0].state === 'paired' && !('k' in devs[0]), 'devices.json: a paired computer with its peer, no key');
  const peersJson = JSON.parse(fs.readFileSync(path.join(R.dataDir, 'link', 'peers.json'), 'utf8'));
  ok(peersJson.peers.length === 1 && peersJson.peers[0].peer === A.id && !JSON.stringify(peersJson).includes(rToA.k), 'peers.json: the PC, no key');
  ok(await until(() => linkRows().length === 0, 20e3), 'the rows are deleted once both kept it');
  ok(!R.logs.concat(A.logs).some((t) => t.includes(rToA.k) || t.includes(aToR.k)), 'no key in the logs');

  // ---------- calls ----------
  ok(await until(() => R.link.online(A.id) === true && A.link.online(R.id) === true, 20e3), 'each sees the other online');
  let r = await pass(R.link.call(A.id, 'GET', '/peer/status'));
  ok(r.s === 200 && r.b && r.b.peer === R.id && r.b.device.id === A.id, `GET /peer/status through the PC's relay: 200, peer = the Mac (${JSON.stringify(r).slice(0, 120)})`);
  const ps = A.seen.filter((x) => x.path === '/peer/status').pop();
  ok(ps && ps.headers['x-fleet-view-relay'] === A.relayKey && ps.headers['x-fleet-view-peer'] === R.id && !ps.headers.authorization, 'the PC\'s server got the marker and the peer header, no API token');
  r = await pass(A.link.call(R.id, 'GET', '/peer/status'));
  ok(r.s === 200 && r.b.peer === A.id && r.b.device.id === R.id, 'and the other way: the PC calls the Mac');
  // the routes a move's env files and sign-ins come by (sync-move.js peer answers them): only { id }, with the marker
  r = await pass(R.link.call(A.id, 'POST', '/peer/env', { b: { id: SID } }));
  ok(r.s === 200 && r.b.route === '/peer/env' && r.b.id === SID && r.b.peer === R.id, `POST /peer/env through the relay: 200, with the peer (${JSON.stringify(r.b).slice(0, 120)})`);
  r = await pass(R.link.call(A.id, 'POST', '/peer/logins', { b: { id: SID } }));
  ok(r.s === 200 && r.b.route === '/peer/logins', 'POST /peer/logins through the relay: 200');
  r = await pass(R.link.call(A.id, 'POST', '/peer/env', { b: { id: SID, path: '/etc/passwd' } }));
  eq(r.s, 403, 'POST /peer/env with anything but id: 403 before the server');
  r = await pass(R.link.call(A.id, 'POST', '/peer/logins', { b: { id: 'not-an-id' } }));
  eq(r.s, 400, 'POST /peer/logins with a bad id: 400');
  r = await pass(R.link.call(A.id, 'POST', `/api/sessions/${SID}/message`, { b: { text: 'hello from the Mac' } }));
  ok(r.s === 200 && r.b.text === 'hello from the Mac' && r.b.via === 'phone' && r.b.marked === true, `a message: 200, with the marker (${JSON.stringify(r.b)})`);
  r = await pass(R.link.call(A.id, 'GET', '/api/conversations'));
  ok(r.s === 200 && r.b && r.b.big === BIG, 'a big answer comes down in parts and is put together');
  r = await pass(R.link.call(A.id, 'POST', '/chat/image', { b: { name: 'x.png', data: 'x'.repeat(1000000) } }));
  ok(r.s === 200 && r.b.got === 1000000, `a big body goes up in parts (${JSON.stringify(r.b)})`);
  r = await pass(R.link.call(A.id, 'GET', '/api/status'));
  ok(r.s === 429 && r.b.retryAfter === 1234, `a 429 is passed on (${r.s})`);
  r = await pass(R.link.call(A.id, 'POST', '/settings', { b: { secret: 1 } }));
  eq(r.s, 403, 'the relay\'s narrower checks hold for a computer too');
  // a lost answer: asked again with the same id, it gets the kept answer, and the server ran it once
  let dropped = 0;
  hub.drop = (f, sock) => { if (sock.kind === 'relay:PC' && dropped === 0) { dropped++; return true; } return false; };
  const before = A.seen.filter((x) => x.path === `/api/sessions/${SID}/message`).length;
  r = await pass(R.link.call(A.id, 'POST', `/api/sessions/${SID}/message`, { b: { text: 'once' } }));
  hub.drop = null;
  ok(dropped === 1 && r.s === 200 && r.b.text === 'once', `the answer lost once: asked again, it came (${r.s})`);
  eq(A.seen.filter((x) => x.path === `/api/sessions/${SID}/message`).length - before, 1, 'the server got that message once');
  // every answer lost until the call gives up (timeout, not offline: it went), then a second call under the caller's
  // own id and first try's time (the page's Send again, link-send.js cid and t0): the kept answer, the server ran it once
  hub.drop = (f, sock) => sock.kind === 'relay:PC';
  const before2 = A.seen.filter((x) => x.path === `/api/sessions/${SID}/message`).length;
  const mine2 = { id: 'pageSend-0123456789ab', t0: clock.t };
  r = await pass(R.link.call(A.id, 'POST', `/api/sessions/${SID}/message`, { b: { text: 'twice?' }, timeoutMs: 20e3, ...mine2 }));
  hub.drop = null;
  ok(r.s === 0 && r.b.code === 'timeout', `no answer at all: timeout (${r.s} ${r.b && r.b.code})`);
  r = await pass(R.link.call(A.id, 'POST', `/api/sessions/${SID}/message`, { b: { text: 'twice?' }, ...mine2 }));
  ok(r.s === 200 && r.b.text === 'twice?', `the same id again: the first run's answer (${r.s})`);
  eq(A.seen.filter((x) => x.path === `/api/sessions/${SID}/message`).length - before2, 1, 'the server got it once across the two calls');

  // ---------- a phone on the PC's relay: never the /peer/ routes ----------
  const [pc, po] = await A.relay.pair('Test iPhone');
  ok(pc === 200 && po.link, 'a phone pairs on the PC (relay mode)');
  const pj = JSON.parse(Buffer.from(new URL(po.link).searchParams.get('d'), 'base64url').toString('utf8'));
  const Kq = Buffer.from(pj.k, 'base64url'), ptopic = `fleet:${pj.uid}:${pj.dev}`, pwire = `realtime:${ptopic}`;
  const Phone = wsClass('phone'), ph = new Phone('wss://x');
  const pmsgs = [];
  let pdown = [RL.dirKey(Kq, 'down')];
  ph.onmessage = (ev) => {
    const f = JSON.parse(ev.data);
    if (f.event !== 'broadcast' || !f.payload || f.payload.event !== 'e') return;
    for (const k of pdown) { const t = RL.open(k, ptopic, pj.dev, 'down', f.payload.payload); if (t) { pmsgs.push(JSON.parse(t)); break; } }
  };
  await settle();
  ph.send(JSON.stringify({ topic: pwire, event: 'phx_join', ref: '1', join_ref: '1', payload: { config: { presence: { key: 'phone' } }, access_token: 'test-token' } }));
  await until(() => A.relay.computers && true, 1000);
  ok(await until(() => [...(hub.topics.get(pwire) || new Map()).values()].some((x) => x.key === 'pc'), 10e3), 'the PC\'s relay is on the phone\'s channel');
  const mine = RL.xPair();
  const pup = (k, msg) => ph.send(JSON.stringify({ topic: pwire, event: 'broadcast', payload: { type: 'broadcast', event: 'e', payload: RL.seal(RL.dirKey(k, 'up'), ptopic, pj.dev, 'up', msg) } }));
  pup(Kq, { t: 'hello', id: 'h1', at: clock.t, app: '1.0.0', device: 'Test iPhone', epk: mine.pub.toString('base64url') });
  ok(await until(() => pmsgs.some((x) => x.id === 'h1'), 10e3), 'the phone\'s handshake is answered');
  const hres = pmsgs.find((x) => x.id === 'h1');
  const K2 = RL.pairedKey(Kq, mine.priv, Buffer.from(hres.b.epk, 'base64url'));
  pdown = [RL.dirKey(K2, 'down'), ...pdown];
  pup(K2, { t: 'req', id: 'q1', at: clock.t, m: 'GET', p: '/peer/status', t0: clock.t });
  pup(K2, { t: 'req', id: 'q2', at: clock.t, m: 'GET', p: '/state', t0: clock.t });
  pup(K2, { t: 'req', id: 'q3', at: clock.t, m: 'POST', p: '/peer/env', b: { id: SID }, t0: clock.t });
  pup(K2, { t: 'req', id: 'q4', at: clock.t, m: 'POST', p: '/peer/logins', b: { id: SID }, t0: clock.t });
  ok(await until(() => ['q1', 'q2', 'q3', 'q4'].every((q) => pmsgs.some((x) => x.id === q)), 10e3), 'the phone\'s requests are answered');
  eq(pmsgs.find((x) => x.id === 'q1').s, 403, 'a phone calling /peer/status: 403');
  ok(pmsgs.find((x) => x.id === 'q3').s === 403 && pmsgs.find((x) => x.id === 'q4').s === 403, 'a phone calling /peer/env or /peer/logins: 403');
  ok(!A.seen.some((x) => (x.path === '/peer/env' || x.path === '/peer/logins') && x.headers['x-fleet-view-peer'] === undefined), 'nothing of the phone\'s reached /peer/env or /peer/logins');
  eq(pmsgs.find((x) => x.id === 'q2').s, 200, 'the phone\'s own routes still work');
  ok(RL.peerRouteAllowed('GET', '/peer/status') && !RL.routeAllowed('GET', '/peer/status') && !RL.peerRouteAllowed('GET', '/peer/../state'), 'the allowlists: /peer/status is a peer route only');
  ok(['/peer/env', '/peer/logins'].every((x) => RL.peerRouteAllowed('POST', x) && !RL.routeAllowed('POST', x) && !RL.peerRouteAllowed('GET', x)), 'the allowlists: POST /peer/env and /peer/logins are peer routes only');
  ok((await A.relay.status()).devices.some((d) => d.kind === 'computer') && (await A.relay.status()).devices.some((d) => !d.kind && d.name === 'Test iPhone'), '/relay/status names the computer\'s kind, the phone has none');
  await A.relay.revoke(pj.dev);
  ph.close();

  // ---------- presence ----------
  const pcRelaySock = openSocks('relay:PC')[0];
  ok(!!pcRelaySock, 'the PC\'s relay has a socket');
  kill(pcRelaySock);
  ok(await until(() => R.link.online(A.id) === false, 5e3, 50), 'the PC\'s relay drops: the Mac sees it offline at once');
  eq(machineOf(R, A).online, false, 'status(): the card reads it offline too');
  r = await pass(R.link.call(A.id, 'GET', '/peer/status'));
  eq([r.s, r.b.code], [0, 'offline'], 'a call while it is offline: s 0, offline');
  ok(await until(() => R.link.online(A.id) === true, 30e3), 'the PC\'s relay comes back: online again');
  eq(machineOf(R, A).online, true, 'status(): and online');
  r = await pass(R.link.call(A.id, 'GET', '/peer/status'));
  eq(r.s, 200, 'and calls go through again');

  // ---------- unlink: both at once, and it sticks ----------
  const [uc] = await R.link.unlink(A.id);
  eq(uc, 200, 'unlink on the Mac: 200');
  eq([comps(R).length, linked(R, A)], [0, false], 'the Mac forgot the PC at once');
  ok(await until(() => !linked(A, R) && comps(A).length === 0, 10e3), 'the PC unlinked too (the notice)');
  r = await pass(A.link.call(R.id, 'GET', '/peer/status'));
  eq(r.b.code, 'not_linked', 'the PC can no longer call the Mac');
  eq(JSON.parse(R.linkKeys.peek() || 'null'), null, 'the Mac\'s link keys are cleared');
  ok(linkRows().includes(offRow), 'the unlink mark is written');
  eq(openRow(db.settings.find((x) => x.key === offRow)).by, R.id, 'naming who unlinked');
  const asked0 = asks().length;
  await advance(10 * 60e3);
  eq([linked(R, A), linked(A, R), asks().length - asked0], [false, false, 0], 'ten minutes on: still unlinked, and neither asked');
  eq([machineOf(R, A).unlinked, machineOf(A, R).unlinked, machineOf(R, A).linking], [true, true, false], 'both say unlinked');
  eq(linkRows(), [offRow], 'the mark stays');

  // ---------- Link after it: from either machine ----------
  const [lc, lo1] = await A.link.request(R.id);
  ok(lc === 200 && lo1.pid, `Link on the PC (the higher id): 200 (${lc})`);
  ok(!linkRows().includes(offRow), 'Link takes the mark away');
  ok(await until(() => linked(R, A) && linked(A, R), 30e3), 'linked again, no code');
  eq(pairOf(R, lo1.pid) && pairOf(R, lo1.pid).role, 'answer', 'the Mac answered the PC this time');
  ok(await until(() => R.link.online(A.id) === true, 20e3), 'online again');
  r = await pass(R.link.call(A.id, 'GET', '/peer/status'));
  eq(r.s, 200, 'calls work on the new link');
  ok(await until(() => linkRows().length === 0, 20e3), 'its rows go');

  // ---------- unlink while the other machine is off: the mark ----------
  await A.link.stop();
  await R.link.unlink(A.id);
  ok(linkRows().includes(offRow), 'the mark waits for the PC');
  eq(comps(A).length, 1, 'the PC (its link off) still has the Mac');
  A.link = A.makeLink();
  await A.link.start();
  eq(A.link.peers().map((p) => p.id), [R.id], 'the PC\'s link starts with the Mac from peers.json');
  ok(await until(() => A.link.peers().length === 0 && comps(A).length === 0, 20e3), 'it reads the mark and unlinks');
  await advance(5 * 60e3);
  eq([linked(R, A), linked(A, R), linkRows()], [false, false, [offRow]], 'and stays unlinked: the mark holds there too');
  const [lc2] = await R.link.request(A.id);
  eq(lc2, 200, 'Link on the Mac');
  ok(await until(() => linked(R, A) && linked(A, R), 30e3), 'and they link again');
  ok(await until(() => linkRows().length === 0, 20e3), 'the mark and the pairing\'s rows go');

  // ---------- a restart keeps the link ----------
  const lk2 = (m) => JSON.parse(m.linkKeys.peek() || '{}');
  const devBefore = lk2(R)[A.id] && lk2(R)[A.id].dev;
  await R.link.stop();
  await A.link.stop();
  R.link = R.makeLink();
  A.link = A.makeLink();
  const asked1 = asks().length;
  await A.link.start();
  await R.link.start();
  ok(await until(() => R.link.online(A.id) === true && A.link.online(R.id) === true, 30e3), 'both restarted: online on the same link');
  await advance(5 * 60e3);
  eq([linked(R, A), linked(A, R), lk2(R)[A.id] && lk2(R)[A.id].dev, asks().length - asked1], [true, true, devBefore, 0], 'the link from before is kept: no new pairing');
  r = await pass(R.link.call(A.id, 'GET', '/peer/status'));
  eq(r.s, 200, 'and calls go through');

  // ---------- an older version's gone row: it unlinks, and with no mark the two link again by themselves ----------
  const goneKey = `link-gone:${A.id}:${R.id}`;
  db.settings.push({ key: goneKey, value_enc: sealRow(goneKey, { v: 1, from: R.id, to: A.id, devs: [lk2(A)[R.id].dev], at: clock.t }), user_id: UID });
  ok(await until(() => !linked(A, R), 20e3), 'the PC reads the gone row and unlinks');
  ok(!linkRows().includes(goneKey), 'and deletes it');
  ok(await until(() => linked(R, A) && linked(A, R) && lk2(R)[A.id].dev !== devBefore, 60e3), 'no mark: they link again by themselves, with new keys');

  // ---------- a reveal that does not match its commitment, then the retry ----------
  await R.link.unlink(A.id);
  await until(() => !linked(A, R), 10e3);
  const m1 = RL.xPair();
  const swap = (rows, step, fn) => rows.map((row) => {
    if (!row.key || !row.key.endsWith(`:${step}`) || !row.value_enc) return row;
    return { ...row, value_enc: sealRow(row.key, fn(openRow(row))) };
  });
  A.tamper = (table, rows) => (table !== 'settings' ? rows : swap(rows, 'reveal', (v) => ({ ...v, epk: m1.pub.toString('base64url') })));
  const [, wo] = await R.link.request(A.id);
  ok(await until(() => pairOf(A, wo.pid) && pairOf(A, wo.pid).state === 'failed', 20e3), 'a reveal that does not match the commitment: the PC refuses');
  ok(/someone may be in the middle/.test(pairOf(A, wo.pid).message || ''), 'and says why');
  ok(await until(() => pairOf(R, wo.pid) && pairOf(R, wo.pid).state === 'failed', 20e3), 'the Mac hears no and fails too');
  eq([comps(R).length, comps(A).length, linked(R, A), linked(A, R)], [0, 0, false, false], 'nothing linked');
  A.tamper = null;
  ok(await until(() => linked(R, A) && linked(A, R), L.TIMING.retryMs + 30e3), 'a minute later it tries again by itself, and links');

  // ---------- both press Link at once: one pairing goes on ----------
  await R.link.unlink(A.id);
  await until(() => !linked(A, R), 10e3);
  const [[bc1, bo1], [bc2, bo2]] = await Promise.all([R.link.request(A.id), A.link.request(R.id)]);
  eq([bc1, bc2], [200, 200], 'Link on both: 200 each');
  ok(await until(() => linked(R, A) && linked(A, R), 30e3), 'linked');
  eq([pairOf(R, bo1.pid) && pairOf(R, bo1.pid).state, pairOf(A, bo2.pid) && pairOf(A, bo2.pid).state], ['linked', 'cancelled'], 'the Mac\'s ask (the lower id) went on; the PC dropped its own');
  eq([comps(R).length, comps(A).length], [1, 1], 'one link each way');
  ok(await until(() => linkRows().length === 0, 20e3), 'and every row goes');

  // ---------- off ----------
  await R.link.stop();
  await A.link.stop();
  ok(openSocks('link:MAC').length === 0 && openSocks('link:PC').length === 0, 'stopped: the links\' sockets are closed');
  eq((await pass(R.link.call(A.id, 'GET', '/peer/status'))).b.code, 'stopped', 'a call after stop: stopped');

  // ---------- who asks, machines that go away, and the pace (a third machine, and two that never answer) ----------
  {
    const LOW = '00000000-0000-4000-8000-000000000000', HIGH = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
    const Z = { name: 'ZED', id: `8${crypto.randomUUID().slice(1)}`, tamper: null };
    db.devices = [LOW, HIGH, Z.id].map((id) => ({ id, user_id: UID, name: id === Z.id ? 'ZED' : id === LOW ? 'LOW' : 'HIGH', platform: 'linux', last_seen_at: new Date(clock.t).toISOString(), alive: true }));
    db.settings = db.settings.filter((x) => !/^link/.test(x.key));
    const zSync = { enabled: () => true, uid: async () => UID, email: async () => 'henry@example.com', accessToken: async () => 'test-token', onChange: () => () => {}, rest: (method, table, o) => rest(Z, method, table, o) };
    const zl = L.createLink({ api: zSync, key: SYNC_KEY, dataDir: path.join(T, 'ZED'), log: () => {}, relay: { addComputer: async () => {}, removeComputer: async () => 0, computers: () => [] }, device: () => Z.id, name: 'ZED', now, timers, WebSocketImpl: wsClass('link:ZED'), keyStore: memStore(), readConfig: () => CONFIG });
    const reads = () => calls.filter((c) => c.who === Z && c.method === 'GET' && c.table === 'settings').length;
    const zm = (id) => zl.status().machines.find((x) => x.id === id) || {};
    eq([L.TIMING.pollMs, L.TIMING.pairPollMs], [60e3, 1e3], 'pace: the rows every 60 s while nothing pairs, every second while one does');
    await zl.start();
    await advance(1e3);
    eq([asks(Z, HIGH).length, asks(Z, LOW).length], [1, 0], 'who asks: a higher id is asked at once, a lower one is left to ask');
    await advance(L.TIMING.graceMs - 10e3);
    eq(asks(Z, LOW).length, 0, 'not before graceMs');
    await advance(15e3);
    eq(asks(Z, LOW).length, 1, 'after graceMs with no ask from it, the higher id asks itself');
    // both go away (their last_seen_at stops), and their pairings run out
    for (const d of db.devices) if (d.id !== Z.id) d.alive = false;
    await advance(L.TIMING.pairMs + 5e3);
    ok(zl.status().pairings.every((p) => p.state === 'expired'), `a pairing nobody answers runs out (${zl.status().pairings.map((p) => p.state)})`);
    eq([zm(HIGH).linking, zm(LOW).linking, zm(HIGH).unlinked], [false, false, false], 'machines gone away: offline, not linking');
    const n0 = asks(Z).length, r0 = reads();
    await advance(300e3);
    eq(asks(Z).length - n0, 0, 'they are not asked again while away');
    ok(reads() - r0 === 5, `pace: idle, 5 reads in 5 minutes (${reads() - r0})`);
    // HIGH comes back (its last_seen_at moves): asked at once, whatever the backoff
    db.devices.find((d) => d.id === HIGH).alive = true;
    ok(await until(() => asks(Z, HIGH).length === 2, 120e3), 'a machine back after being away is asked again at once');
    const r1 = reads();
    await advance(10e3);
    ok(reads() - r1 >= 9, `pace: while it pairs, a read every second (${reads() - r1} in 10 s)`);
    await zl.stop();
  }

  await R.relay.stop();
  await A.relay.stop();
  R.srv.close();
  A.srv.close();
}

main().catch((e) => { failed++; console.log(`FAIL threw: ${e && e.stack}`); }).finally(() => {
  if (!process.env.LINK_TEST_KEEP) fs.rmSync(T, { recursive: true, force: true });
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
