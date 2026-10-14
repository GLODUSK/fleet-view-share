// Pairing by sign-in: a test of relay-lobby.js with a real relay.js, run with the system node:
//   node scripts/relay-lobby-test.js
// The lobby joins fleet:<uid>:lobby only while sync is set up and signed in (and leaves it on sign-out), lists this
// machine there by its presence (name, sync device id, platform), answers a phone's ask with a real
// pairing link from relay.js sealed to the phone's one-time key (the phone opens it; nothing else can), answers the same
// rid again with the same answer and pairs once, ignores asks for another machine, stale ones and junk, refuses a bad
// key and an ask for the Wi-Fi way (gone: update the app), and passes a relay refusal on in words. The same phone pairing again drops its older pairing on the relay.
// Also: realtime.js's track() sends the presence again. Exit 0 = all pass. Everything in a temp folder. No network.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const R = require(path.join(ROOT, 'relay.js'));
const LB = require(path.join(ROOT, 'relay-lobby.js'));
const RT = require(path.join(ROOT, 'realtime.js'));

let passed = 0, failed = 0;
const ok = (c, msg) => { if (c) passed++; else { failed++; console.log(`FAIL ${msg}`); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}: want ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-lobby-test-'));
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
const UID = '0b5c8a52-3f6e-4d7a-9c1b-2e4f6a8b0c1d', DEVICE = '7f3e2d1c-0b9a-4876-a543-210fedcba987';
const SB_URL = 'https://example-project.supabase.co', SB_KEY = 'sb_publishable_test';

function fakeSync() {
  const listeners = new Set();
  const f = {
    on: true, signedIn: true,
    api: {
      enabled: () => f.on,
      uid: async () => (f.signedIn ? UID : null),
      email: async () => (f.signedIn ? 'henry@example.com' : null),
      accessToken: async () => { if (!f.signedIn) throw new Error('signed out'); return 'tok'; },
      onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    },
    emit: (type) => { for (const fn of [...listeners]) fn({ type, uid: UID }); },
  };
  return f;
}
function memStore() {
  let text = null;
  return { kind: 'memory', read: async () => text, write: async (t) => { text = t; }, clear: async () => { text = null; }, peek: () => text, stamp: () => null };
}
class NeverWS { constructor() { this.readyState = 0; } send() {} close() {} } // relay.js's socket: never opens here

// a stand-in for realtime.js: one channel at a time, what was sent, and a way to deliver a broadcast
function fakeRealtime() {
  const fr = { made: null, chans: [], sent: [] };
  fr.factory = (o) => {
    fr.made = o;
    return {
      channel(topic, h) {
        const ch = { topic, h, state: 'joined', left: false, tracks: 0, send: (m) => { fr.sent.push(m); return true; }, track: () => { ch.tracks++; return true; }, leave: () => { ch.left = true; ch.state = 'closed'; } };
        fr.chans.push(ch);
        return ch;
      },
      stop() { fr.stopped = true; },
    };
  };
  fr.current = () => fr.chans.filter((c) => !c.left).slice(-1)[0] || null;
  return fr;
}

// the phone's side of the box (what phone/src/crypto/lobby.ts does, in node)
function phoneKey() {
  const kp = crypto.generateKeyPairSync('x25519');
  const raw = kp.publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  return { priv: kp.privateKey, epk: raw.toString('base64url') };
}
function openBox(priv, m, topic, rid, id) {
  const shared = crypto.diffieHellman({ privateKey: priv, publicKey: R.xPublic(Buffer.from(m.epk, 'base64url')) });
  const key = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.from(rid, 'utf8'), Buffer.from(LB.LOBBY_INFO, 'utf8'), 32));
  const c = Buffer.from(m.c, 'base64url');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(m.n, 'base64url'), { authTagLength: 16 });
  d.setAAD(Buffer.from(`${LB.LOBBY_INFO}|${topic}|${rid}|${id}`, 'utf8'));
  d.setAuthTag(c.subarray(c.length - 16));
  try { return Buffer.concat([d.update(c.subarray(0, c.length - 16)), d.final()]).toString('utf8'); } catch { return null; }
}
const linkJson = (link) => JSON.parse(Buffer.from(new URL(link).searchParams.get('d'), 'base64url').toString('utf8'));

async function main() {
  const dataDir = path.join(T, 'data');
  const sync = fakeSync();
  const keyStore = memStore();
  const relay = R.createRelay({ dataDir, logDir: dataDir, sync: sync.api, apiToken: () => 'x'.repeat(40), relayKey: () => 'k'.repeat(32), version: '1.0.99', pcName: 'TEST-PC',
    WebSocketImpl: NeverWS, keyStore, readConfig: () => ({ config: { url: SB_URL, key: SB_KEY } }) });
  relay.start();
  const pairs = [];
  const spy = { pair: (...a) => { pairs.push(a); return relay.pair(...a); } };
  const fr = fakeRealtime();
  const logs = [];
  const lobby = LB.createLobby({ relay: spy, sync: sync.api, dataDir, pcName: 'TEST-PC', version: '1.0.99', device: () => DEVICE, log: (t) => logs.push(t), realtime: fr.factory });

  // ---------- sync off: nothing joined ----------
  sync.on = false;
  lobby.start();
  await settle();
  ok(!fr.current(), 'sync not set up: no lobby channel');

  // ---------- signed in: the lobby ----------
  sync.on = true;
  sync.emit('signed-in');
  await settle();
  const ch = fr.current();
  ok(!!ch, 'signed in: the lobby is joined');
  const topic = `fleet:${UID}:lobby`;
  eq(ch && ch.topic, topic, 'the lobby topic is fleet:<uid>:lobby');
  const id = lobby.status().id;
  ok(/^[A-Za-z0-9_-]{16}$/.test(id), 'the lobby id is 16 b64u');
  eq(JSON.parse(fs.readFileSync(path.join(dataDir, 'relay', 'lobby.json'), 'utf8')).id, id, 'the lobby id is kept on disk');
  eq(fr.made.presenceKey, `pc-${id}`, 'presence key pc-<id>');
  const pres = fr.made.presence();
  eq({ role: pres.role, id: pres.id, name: pres.name, device: pres.device, platform: pres.platform }, { role: 'pc', id, name: 'TEST-PC', device: DEVICE, platform: process.platform }, 'the presence lists this machine');
  ok(!('hosts' in pres), 'the presence names no Wi-Fi addresses');
  sync.emit('refreshed');
  await settle();
  eq(fr.chans.length, 1, 'a token refresh does not join again');

  // ---------- an ask ----------
  const ph = phoneKey();
  const rid = crypto.randomBytes(12).toString('base64url');
  const ask = { t: 'pair-ask', v: 1, to: id, rid, epk: ph.epk, mode: 'relay', name: "Henry's iPhone", phone: 'phoneinstall01', at: Date.now() };
  ch.h.onBroadcast({ ...ask, to: 'AAAAAAAAAAAAAAAA' });
  ch.h.onBroadcast({ ...ask, at: Date.now() - 10 * 60e3 });
  ch.h.onBroadcast({ ...ask, t: 'hello' });
  ch.h.onBroadcast('junk');
  await settle();
  eq(fr.sent.length + pairs.length, 0, 'asks for another machine, stale ones and junk get nothing');
  ch.h.onBroadcast(ask);
  await settle(); await settle();
  eq(pairs.length, 1, 'the ask makes one pairing');
  eq(pairs[0] && [pairs[0][0], pairs[0][1], pairs[0][2]], ["Henry's iPhone", 'relay', { phone: 'phoneinstall01', via: 'sign-in' }], 'with the phone\'s name, the way and its install id');
  const ans = fr.sent[0];
  ok(ans && ans.t === 'pair-link' && ans.rid === rid && ans.from === id, 'answered with pair-link');
  ok(ans && !JSON.stringify(ans).includes('fleetview://'), 'the link does not travel in the clear');
  const text = ans ? openBox(ph.priv, ans, topic, rid, id) : null;
  ok(!!text && text.startsWith('fleetview://pair?d='), 'the phone opens the link');
  const j = text ? linkJson(text) : {};
  eq([j.v, j.uid, j.url, j.pcName], [2, UID, SB_URL, 'TEST-PC'], 'a real relay pairing link');
  const st = await relay.status();
  ok(st.devices.some((d) => d.id === j.dev && d.state === 'pending' && d.phone === 'phoneinstall01'), 'the relay has the pending device, with the phone\'s install id');
  // another phone key opens nothing; the wrong rid or id neither
  ok(openBox(phoneKey().priv, ans, topic, rid, id) === null, 'another key opens nothing');
  ok(openBox(ph.priv, ans, topic, 'x'.repeat(16), id) === null, 'another rid opens nothing');

  // the same ask again: the same answer, no second pairing
  ch.h.onBroadcast(ask);
  await settle();
  eq(pairs.length, 1, 'a repeated ask pairs once');
  eq(fr.sent[1], ans, 'and gets the same answer');

  // ---------- the same phone again: its older pairing goes ----------
  const rid2 = crypto.randomBytes(12).toString('base64url');
  ch.h.onBroadcast({ ...ask, rid: rid2, at: Date.now() });
  await settle(); await settle();
  const ans2 = fr.sent[2];
  const text2 = ans2 && ans2.t === 'pair-link' ? openBox(ph.priv, ans2, topic, rid2, id) : null;
  ok(!!text2, `the same phone pairs again by sign-in (${ans2 && ans2.message})`);
  const j2 = text2 ? linkJson(text2) : {};
  eq([j2.uid, j2.url], [UID, SB_URL], 'a relay link again');
  const st2 = await relay.status();
  ok(!st2.devices.some((d) => d.id === j.dev), 'the same phone pairing again dropped its older pairing');
  ok(st2.devices.some((d) => d.id === j2.dev), 'and kept the new one');

  // ---------- refusals ----------
  const rid3 = crypto.randomBytes(12).toString('base64url');
  ch.h.onBroadcast({ ...ask, rid: rid3, epk: 'AAAA', at: Date.now() });
  await settle();
  ok(fr.sent[3] && fr.sent[3].t === 'pair-no' && /key/.test(fr.sent[3].message), 'a bad key is refused');
  const rid4 = crypto.randomBytes(12).toString('base64url');
  ch.h.onBroadcast({ ...ask, rid: rid4, mode: 'carrier-pigeon', at: Date.now() });
  await settle();
  ok(fr.sent[4] && fr.sent[4].t === 'pair-no', 'an unknown way is refused');
  const nPairs = pairs.length;
  ch.h.onBroadcast({ ...ask, rid: crypto.randomBytes(12).toString('base64url'), mode: 'local', at: Date.now() });
  await settle();
  ok(fr.sent[5] && fr.sent[5].t === 'pair-no' && /no longer offered/.test(fr.sent[5].message) && /update/i.test(fr.sent[5].message) && pairs.length === nPairs,
    `the Wi-Fi way (gone) is refused, update the app, and nothing is paired (${fr.sent[5] && fr.sent[5].message})`);
  const refusing = fakeRealtime();
  const lobby2 = LB.createLobby({ relay: { pair: async () => [409, { ok: false, message: 'sign in to sync on this PC first' }] }, sync: sync.api, dataDir: path.join(T, 'd2'), device: () => null, realtime: refusing.factory });
  lobby2.start();
  await settle();
  const id2 = lobby2.status().id;
  refusing.current().h.onBroadcast({ ...ask, to: id2, rid: crypto.randomBytes(12).toString('base64url'), at: Date.now() });
  await settle(); await settle();
  ok(refusing.sent[0] && refusing.sent[0].t === 'pair-no' && /sign in to sync/.test(refusing.sent[0].message), 'a relay refusal goes back in words');
  eq(refusing.made.presence().device, null, 'no sync device id: device null');
  lobby2.stop();

  // ---------- re-track, sign-out, stop ----------
  sync.signedIn = false;
  sync.emit('signed-out');
  await settle();
  ok(ch.left && !fr.current(), 'signed out: the lobby is left');
  sync.signedIn = true;
  sync.emit('signed-in');
  await settle();
  ok(!!fr.current() && fr.current() !== ch, 'signed in again: joined again');
  lobby.stop();
  ok(!fr.current() && fr.stopped, 'stop leaves and stops realtime');
  await relay.stop();

  // realtime.js: track() sends the presence again while joined
  const frames = [];
  let payload = { role: 'pc', n: 1 };
  class WS { constructor() { WS.last = this; setImmediate(() => this.onopen && this.onopen()); } send(t) { frames.push(JSON.parse(t)); } close() {} }
  const rt = RT.createRealtime({ readConfig: () => ({ url: SB_URL, key: SB_KEY }), accessToken: async () => 'tok', presenceKey: 'pc-x', presence: () => payload, WebSocketImpl: WS });
  const rch = rt.channel('fleet:u:lobby', {});
  ok(rch.track() === false, 'track before joining sends nothing');
  await settle();
  const join = frames.find((f) => f.event === 'phx_join');
  WS.last.onmessage({ data: JSON.stringify({ topic: join.topic, event: 'phx_reply', ref: join.ref, payload: { status: 'ok' } }) });
  payload = { role: 'pc', n: 2 };
  ok(rch.track() === true, 'track while joined');
  const tracks = frames.filter((f) => f.event === 'presence').map((f) => f.payload.payload.n);
  eq(tracks, [1, 2], 'the join tracks, and track() sends what presence() says now');
  rt.stop();
}

main().catch((e) => { failed++; console.log(`FAIL threw: ${e && e.stack}`); }).finally(() => {
  try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
