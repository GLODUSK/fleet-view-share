// relay-lobby.js: pairing a phone by Google sign-in alone, no QR code (docs/phone.md, "Pairing by sign-in"). Every
// machine signed in to sync joins its account's lobby, the private Realtime channel fleet:<uid>:lobby (0376's
// policies already confine fleet:<uid>:* to that account while it is a sync member), and is listed there by its
// presence. The phone signs in with the same Google account, joins the same lobby, lists the machines from their
// presence, and asks the one Henry taps for a pairing; the machine makes one with relay.js pair() (the same pending
// device, K and handshake as a QR code's) and hands the link back sealed to the phone's one-time X25519 key, so what
// Supabase carries never holds K. From then on it is the ordinary relay (or Wi-Fi) pairing: the first hello turns K
// into the device's own K'.
//
// The trust is the account: anyone who can sign in as Henry's sync account can pair a phone here, exactly as anyone
// who could sign in and scan the code could before. The machine pairs without a click on its screen (Henry asked for
// that: "my Google sign-in should be all I need").
//
//   presence  key pc-<id> (id: 16 b64u, <dataDir>/relay/lobby.json, this machine's for good), payload
//             { role: 'pc', v: 1, id, name, device, platform, version, hosts, at }: device is the sync device id (or
//             null), hosts the private IPv4 addresses a Wi-Fi pairing would name (the phone keeps a Wi-Fi pairing's
//             addresses up to date from them)
//   ask       phone -> { t: 'pair-ask', v: 1, to: <id>, rid, epk, mode: 'relay' | 'local', name, phone, at }
//             rid: 16-32 b64u, new for each pairing (the phone sends the same ask again until it has an answer: the
//             machine answers the same rid with the same answer, for 10 minutes); epk: b64u of a fresh X25519 public
//             key; phone: the phone's install id (8-40 b64u): its older pairings with this machine are dropped
//   answer    machine -> { t: 'pair-link', v: 1, rid, from: <id>, epk, n, c } or { t: 'pair-no', v: 1, rid, from,
//             message }. c = AES-256-GCM(key, n, the link's text) with its 16-byte tag after it, b64u;
//             key = HKDF-SHA256(ikm = X25519(the machine's one-time secret, the ask's epk), salt = the UTF-8 rid,
//             info = 'fleet-view lobby v1', 32); AAD = the UTF-8 of 'fleet-view lobby v1|<topic>|<rid>|<id>'
//             (topic: fleet:<uid>:lobby)
//
//   createLobby({ relay, sync, dataDir, readConfig, pcName, version, device, lanHosts, log, now, timers,
//                 WebSocketImpl, realtime }) -> { start(), stop(), status() }
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const SYNC_API = require(path.join(__dirname, 'sync-api.js'));
const RT = require(path.join(__dirname, 'realtime.js'));
const R = require(path.join(__dirname, 'relay.js'));

const LOBBY_INFO = 'fleet-view lobby v1';
const ANSWER_KEEP_MS = 10 * 60e3; // a rid's answer, sent again for a repeated ask
const SKEW_MS = 5 * 60e3; // an ask's `at` this far from our clock is ignored
const ASKS_PER_MIN = 12; // asks taken up per minute (each makes a pending device and writes the key store)
const RETRACK_MS = 5 * 60e3; // the presence again (a new Wi-Fi address shows up on the phone)
const ID_RE = /^[A-Za-z0-9_-]{16}$/, RID_RE = /^[A-Za-z0-9_-]{16,32}$/, PHONE_RE = /^[A-Za-z0-9_-]{8,40}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clip = (s, n = 200) => String(s == null ? '' : s).replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, n);
const b64u = (b) => Buffer.from(b).toString('base64url');
const fromB64u = (s) => {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s)) return null;
  const b = Buffer.from(s, 'base64url');
  return b64u(b) === s ? b : null;
};
const lobbyTopic = (uid) => `fleet:${uid}:lobby`;
const aadOf = (topic, rid, id) => Buffer.from(`${LOBBY_INFO}|${topic}|${rid}|${id}`, 'utf8');

// the link sealed to the phone's epk -> { epk, n, c }, or null when epk is not a usable X25519 public key.
// o.raw (fixed secret bytes) and o.nonce only for the tests' vectors
function sealLink(text, theirEpk, topic, rid, id, o = {}) {
  const theirs = fromB64u(theirEpk);
  if (!theirs || theirs.length !== 32) return null;
  const mine = R.xPair(o.raw);
  let shared;
  try { shared = crypto.diffieHellman({ privateKey: mine.priv, publicKey: R.xPublic(theirs) }); } catch { return null; }
  if (!shared.some((x) => x)) return null;
  const key = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.from(rid, 'utf8'), Buffer.from(LOBBY_INFO, 'utf8'), 32));
  const n = o.nonce || crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, n, { authTagLength: 16 });
  c.setAAD(aadOf(topic, rid, id));
  return { epk: b64u(mine.pub), n: b64u(n), c: b64u(Buffer.concat([c.update(Buffer.from(text, 'utf8')), c.final(), c.getAuthTag()])) };
}

function createLobby(o = {}) {
  const relay = o.relay, sync = o.sync;
  if (!relay || typeof relay.pair !== 'function') throw new Error('createLobby needs the relay (opts.relay)');
  if (!sync || typeof sync.enabled !== 'function') throw new Error('createLobby needs the sync instance (opts.sync)');
  const dataDir = o.dataDir;
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const log = typeof o.log === 'function' ? o.log : () => {};
  const T = o.timers || { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h) };
  const later = (fn, ms) => { const h = T.setTimeout(fn, ms); if (h && typeof h.unref === 'function') h.unref(); return h; };
  const cancel = (h) => { if (h) T.clearTimeout(h); };
  const readConfig = typeof o.readConfig === 'function' ? o.readConfig : SYNC_API.readConfig;
  const pcName = () => clip(o.pcName || os.hostname(), 80);
  const version = () => { try { return String((typeof o.version === 'function' ? o.version() : o.version) || ''); } catch { return ''; } };
  const lanHosts = () => { try { return (typeof o.lanHosts === 'function' ? o.lanHosts() : require(path.join(__dirname, 'relay-lan.js')).privateIPv4s()).slice(0, 8); } catch { return []; } };
  const device = () => {
    try {
      if (typeof o.device === 'function') { const d = o.device(); return typeof d === 'string' && UUID_RE.test(d) ? d.toLowerCase() : null; }
      const j = JSON.parse(fs.readFileSync(path.join(SYNC_API.syncDir(dataDir), 'device.json'), 'utf8'));
      return j && typeof j.id === 'string' && UUID_RE.test(j.id) ? j.id.toLowerCase() : null;
    } catch { return null; }
  };

  // this machine's lobby id: made once, kept in <dataDir>/relay/lobby.json
  let myId = null;
  function idOf() {
    if (myId) return myId;
    const file = path.join(dataDir, 'relay', 'lobby.json');
    try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j && ID_RE.test(j.id)) return (myId = j.id); } catch {}
    const id = b64u(crypto.randomBytes(12));
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify({ v: 1, id })}\n`); } catch {}
    return (myId = id);
  }

  let rt = null, ch = null, uid = null, stopped = false, started = false, unsubscribe = null, retrackTimer = null;
  let evalChain = Promise.resolve();
  const answers = new Map(); // rid -> { at, msg } (the answer, sent again for a repeated ask) | { at, busy: true }
  let asks = []; // when asks were taken up (the last minute)
  const said = new Map();
  const note = (text) => { const t = now(), seen = said.get(text); if (seen && t - seen < 60e3) return; if (said.size > 100) said.clear(); said.set(text, t); log(`lobby: ${text}`); };

  const presence = () => ({ role: 'pc', v: 1, id: idOf(), name: pcName(), device: device(), platform: process.platform, version: version(), hosts: lanHosts() });

  function realtime() {
    if (!rt) {
      // o.realtime: a stand-in for realtime.js (the tests)
      rt = typeof o.realtime === 'function' ? o.realtime({ presenceKey: `pc-${idOf()}`, presence }) : RT.createRealtime({
        readConfig: () => { const c = (readConfig(dataDir) || {}).config; return c ? { url: c.url, key: c.key } : null; },
        accessToken: () => sync.accessToken(), presenceKey: `pc-${idOf()}`, presence, log: note, now, timers: o.timers, WebSocketImpl: o.WebSocketImpl,
      });
    }
    return rt;
  }
  function leave() {
    if (ch) { try { ch.leave(); } catch {} }
    ch = null;
    cancel(retrackTimer); retrackTimer = null;
  }
  function retrackLater() {
    cancel(retrackTimer);
    retrackTimer = later(() => { retrackTimer = null; if (ch && ch.state === 'joined' && typeof ch.track === 'function') ch.track(); retrackLater(); }, RETRACK_MS);
  }
  function evaluate() {
    const run = async () => {
      if (stopped) return;
      let id = null;
      try { id = sync.enabled() ? await sync.uid() : null; } catch { id = null; }
      if (stopped) return;
      if (id && UUID_RE.test(id) && id === uid && ch) return;
      leave();
      uid = id && UUID_RE.test(id) ? id.toLowerCase() : null;
      if (!uid) return;
      const topic = lobbyTopic(uid);
      ch = realtime().channel(topic, {
        onBroadcast: (msg) => { onAsk(topic, msg).catch((e) => note(`a pairing ask failed: ${e && e.message}`)); },
        onState: (s) => { if (s === 'joined') note(`listed for the phone (${topic})`); },
      });
      retrackLater();
    };
    evalChain = evalChain.then(run, run);
    return evalChain;
  }

  function prune() {
    const t = now();
    for (const [rid, a] of answers) if (t - a.at > ANSWER_KEEP_MS) answers.delete(rid);
    asks = asks.filter((at) => t - at < 60e3);
  }
  const send = (msg) => !!(ch && ch.state === 'joined' && ch.send(msg));

  async function onAsk(topic, m) {
    if (!m || typeof m !== 'object' || m.t !== 'pair-ask' || m.v !== 1 || m.to !== idOf()) return;
    if (typeof m.rid !== 'string' || !RID_RE.test(m.rid) || typeof m.at !== 'number' || Math.abs(m.at - now()) > SKEW_MS) return;
    prune();
    const was = answers.get(m.rid);
    if (was) { if (was.msg) send(was.msg); return; }
    const id = idOf();
    const no = (message) => ({ t: 'pair-no', v: 1, rid: m.rid, from: id, message });
    const answer = (msg) => { answers.set(m.rid, { at: now(), msg }); send(msg); };
    const epk = fromB64u(m.epk);
    if (!epk || epk.length !== 32) return answer(no('The phone sent no usable key: update the app.'));
    if (m.mode !== 'relay' && m.mode !== 'local') return answer(no('Update the app: it asked for a way this machine does not know.'));
    if (asks.length >= ASKS_PER_MIN) return send(no('Too many pairings at once: try again in a minute.'));
    asks.push(now());
    answers.set(m.rid, { at: now(), busy: true });
    const phone = typeof m.phone === 'string' && PHONE_RE.test(m.phone) ? m.phone : undefined;
    let code, out;
    try { [code, out] = await relay.pair(typeof m.name === 'string' ? clip(m.name, 60) : undefined, m.mode, { phone, via: 'sign-in' }); } catch (e) { code = 500; out = { message: e && e.message }; }
    if (code !== 200 || !out || typeof out.link !== 'string') {
      note(`a phone's pairing was refused: ${clip(out && out.message, 160)}`);
      return answer(no(clip((out && out.message) || 'This machine could not make a pairing.', 300)));
    }
    const box = sealLink(out.link, m.epk, topic, m.rid, id);
    if (!box) return answer(no('The phone sent no usable key: update the app.'));
    note(`paired ${out.id} (${clip(m.name, 60) || 'iPhone'}${m.mode === 'local' ? ', on this Wi-Fi' : ''}) by sign-in`);
    answer({ t: 'pair-link', v: 1, rid: m.rid, from: id, ...box });
  }

  function start() {
    if (started || stopped) return;
    started = true;
    unsubscribe = sync.onChange((ev) => { if (!ev || ev.type !== 'refreshed') evaluate(); });
    evaluate();
  }
  function stop() {
    if (stopped) return;
    stopped = true;
    if (unsubscribe) { try { unsubscribe(); } catch {} }
    leave();
    if (rt) { try { rt.stop(); } catch {} }
  }
  const status = () => ({ id: idOf(), uid, channel: ch ? ch.state : 'closed', ...(ch && ch.refused ? { refused: ch.refused } : {}) });
  return { start, stop, status, _evaluate: evaluate };
}

module.exports = { createLobby, sealLink, lobbyTopic, LOBBY_INFO };
