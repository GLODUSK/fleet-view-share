// realtime.js: a Phoenix channel client for Supabase Realtime Broadcast, the joining side of the private channels
// relay.js serves. link.js (docs/link.md) uses it to call another machine's relay the way the phone does: it joins
// fleet:<uid>:<dev> with its own presence key and sends and receives broadcasts whose payload is an envelope.
// relay.js speaks the same frames from the serving side and keeps its own copy of them (its socket also decides when
// a device's channel is wanted); what is here is that code without the devices, so the two read alike.
//
// The frames, vsn 1.0.0 (realtime-js 2.112's 1.0.0 encoder: JSON.stringify of { topic, event, payload, ref, join_ref }):
//   socket    wss://<project>.supabase.co/realtime/v1/websocket?apikey=<publishable key>&vsn=1.0.0, opened while at
//             least one channel is wanted and closed when none is
//   join      { topic: 'realtime:<topic>', event: 'phx_join', ref, join_ref: ref, payload: { config: { broadcast:
//             { ack: false, self: false }, presence: { key: <presence key>, enabled: true }, postgres_changes: [],
//             private: true }, access_token } } -> phx_reply { status: 'ok' | 'error', response }
//   track     { event: 'presence', payload: { type: 'presence', event: 'track', payload: <presence payload> } } after
//             each join; presence_state ({ <key>: { metas: [...] } }) and presence_diff ({ joins, leaves }, the same
//             shape) say who else is on the channel: present(key) counts their metas
//   heartbeat { topic: 'phoenix', event: 'heartbeat', payload: {}, ref } every 25 s; one still unanswered at the next
//             means the socket is dead: it is dropped and opened again
//   token     { event: 'access_token', payload: { access_token } } on every joined channel when the access token
//             changed (looked at with every heartbeat, as realtime-js does)
//   send      { event: 'broadcast', payload: { type: 'broadcast', event: 'e', payload: <envelope> } }, and received so
//   A refused or failed join, phx_error or phx_close is joined again 1 s, 2 s, 4 s ... 60 s later (per channel), and a
//   dropped socket opens again the same way.
//
//   createRealtime({ readConfig, accessToken, presenceKey, presence, log, now, timers, WebSocketImpl })
//     -> { channel(topic, { onBroadcast(envelope), onPresence(), onState(state) }) -> ch, stop(), status() }
//   readConfig() -> { url, key } | null (S1's config, read again on every (re)connect, never kept)
//   accessToken() -> Promise of the user's access token (S1's accessToken)
//   presenceKey: the key this side tracks under ('peer' for link.js); presence() -> its payload
//   ch: { topic, state: 'closed' | 'joining' | 'joined' | 'errored', send(envelope) -> bool, present(key) -> true |
//         false | null (null while not joined, or before the first presence_state), leave(), refused }
'use strict';

const HEARTBEAT_MS = 25e3, JOIN_MS = 10e3, BACKOFF_MIN = 1e3, BACKOFF_MAX = 60e3;
const clip = (s, n = 200) => String(s == null ? '' : s).replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, n);

function createRealtime(o = {}) {
  const readConfig = typeof o.readConfig === 'function' ? o.readConfig : () => null;
  const accessToken = typeof o.accessToken === 'function' ? o.accessToken : async () => { throw new Error('no access token'); };
  const presenceKey = typeof o.presenceKey === 'string' && o.presenceKey ? o.presenceKey : 'peer';
  const presence = typeof o.presence === 'function' ? o.presence : () => ({ role: presenceKey, v: 1 });
  const log = typeof o.log === 'function' ? o.log : () => {};
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const T = o.timers || { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h) };
  const later = (fn, ms) => { const h = T.setTimeout(fn, ms); if (h && typeof h.unref === 'function') h.unref(); return h; };
  const cancel = (h) => { if (h) T.clearTimeout(h); };
  const WS = o.WebSocketImpl || globalThis.WebSocket;

  const channels = new Map(); // wire topic ('realtime:<topic>') -> ch
  let ws = null, wsOpen = false, refN = 0, hbTimer = null, hbRef = null, reconnectTimer = null;
  let sockBackoff = BACKOFF_MIN, token = null, stopped = false;
  const mkRef = () => String(++refN);
  const wire = (f) => {
    if (!ws || !wsOpen) return false;
    try { ws.send(JSON.stringify(f)); return true; } catch { return false; }
  };
  const said = new Map();
  const note = (text) => { const t = now(), seen = said.get(text); if (seen && t - seen < 60e3) return; if (said.size > 100) said.clear(); said.set(text, t); log(text); };

  // ---------- the socket ----------
  function connect() {
    if (ws || reconnectTimer || stopped || !channels.size) return;
    if (typeof WS !== 'function') { note('realtime: this node has no WebSocket (node 22 or newer has one): not connecting'); return; }
    let c = null;
    try { c = readConfig(); } catch {}
    if (!c || typeof c.url !== 'string' || typeof c.key !== 'string') { note('realtime: the sync config could not be read: trying again later'); return void reconnectLater(); }
    const url = `${c.url.replace(/^http/, 'ws')}/realtime/v1/websocket?apikey=${encodeURIComponent(c.key)}&vsn=1.0.0`;
    let sock;
    try { sock = new WS(url); } catch (e) { note(`realtime: could not open the socket: ${e && e.message}`); return void reconnectLater(); }
    try { sock.binaryType = 'arraybuffer'; } catch {}
    ws = sock;
    wsOpen = false;
    hbRef = null;
    sock.onopen = () => {
      if (ws !== sock) return;
      wsOpen = true;
      beat();
      for (const ch of channels.values()) join(ch);
    };
    sock.onmessage = (ev) => { if (ws === sock) onFrame(ev && ev.data); };
    sock.onclose = () => { if (ws === sock) dropped(); };
    sock.onerror = () => {}; // a close follows
  }
  function reconnectLater() {
    if (reconnectTimer || stopped) return;
    const ms = sockBackoff;
    sockBackoff = Math.min(BACKOFF_MAX, sockBackoff * 2);
    reconnectTimer = later(() => { reconnectTimer = null; connect(); }, ms);
  }
  function resetChannels() {
    for (const ch of channels.values()) {
      cancel(ch.timer);
      const was = ch.state;
      Object.assign(ch, { state: 'closed', joinRef: null, timer: null, keys: null });
      if (was !== 'closed') ch.changed();
    }
  }
  // the socket went away: every channel with it; it comes back after the backoff
  function dropped() {
    ws = null;
    wsOpen = false;
    cancel(hbTimer); hbTimer = null; hbRef = null;
    resetChannels();
    if (!stopped && channels.size) reconnectLater();
  }
  function disconnect(why) {
    cancel(reconnectTimer); reconnectTimer = null;
    const sock = ws;
    if (sock) {
      for (const ch of channels.values()) leaveWire(ch);
      ws = null;
      wsOpen = false;
      try { sock.close(1000, clip(why, 60) || 'done'); } catch {}
    }
    cancel(hbTimer); hbTimer = null; hbRef = null;
    resetChannels();
  }
  function beat() {
    cancel(hbTimer);
    hbTimer = later(() => {
      hbTimer = null;
      if (!wsOpen) return;
      if (hbRef) {
        note('realtime: no answer to the heartbeat: reconnecting');
        const sock = ws;
        dropped();
        try { sock.close(1000, 'heartbeat timeout'); } catch {}
        return;
      }
      hbRef = mkRef();
      wire({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: hbRef });
      refreshToken();
      beat();
    }, HEARTBEAT_MS);
  }
  async function refreshToken() {
    let tok;
    try { tok = await accessToken(); } catch { return; }
    if (!tok || tok === token) return;
    token = tok;
    for (const ch of channels.values()) {
      if (ch.state === 'joined') wire({ topic: ch.wire, event: 'access_token', payload: { access_token: tok }, ref: mkRef(), join_ref: ch.joinRef });
    }
  }

  // ---------- channels ----------
  async function join(ch) {
    if (!wsOpen || stopped || channels.get(ch.wire) !== ch || ch.state === 'joining' || ch.state === 'joined' || (ch.state === 'errored' && ch.timer)) return;
    cancel(ch.timer); ch.timer = null;
    ch.state = 'joining';
    ch.joinRef = null;
    ch.changed();
    let tok;
    try { tok = await accessToken(); } catch (e) {
      ch.state = 'errored';
      ch.refused = 'no access token';
      note(`realtime: no access token for the channel: ${e && e.message}`);
      ch.changed();
      return void rejoinLater(ch);
    }
    if (!wsOpen || ch.state !== 'joining' || channels.get(ch.wire) !== ch) { if (ch.state === 'joining') { ch.state = 'closed'; ch.changed(); } return; }
    token = tok;
    const r = mkRef();
    ch.joinRef = r;
    wire({ topic: ch.wire, event: 'phx_join', ref: r, join_ref: r, payload: {
      config: { broadcast: { ack: false, self: false }, presence: { key: presenceKey, enabled: true }, postgres_changes: [], private: true },
      access_token: tok,
    } });
    ch.timer = later(() => {
      if (ch.joinRef !== r || ch.state !== 'joining') return;
      ch.state = 'errored';
      ch.refused = 'no answer to the join';
      ch.changed();
      rejoinLater(ch);
    }, JOIN_MS);
  }
  function rejoinLater(ch) {
    cancel(ch.timer);
    const ms = ch.backoff;
    ch.backoff = Math.min(BACKOFF_MAX, ch.backoff * 2);
    ch.timer = later(() => { ch.timer = null; if (ch.state !== 'joined' && ch.state !== 'joining') { ch.state = 'closed'; join(ch); } }, ms);
  }
  function leaveWire(ch) {
    cancel(ch.timer); ch.timer = null;
    if ((ch.state === 'joined' || ch.state === 'joining') && ch.joinRef) wire({ topic: ch.wire, event: 'phx_leave', payload: {}, ref: mkRef(), join_ref: ch.joinRef });
  }
  const reasonOf = (payload) => {
    const r = payload && payload.response;
    return clip((r && (r.reason || r.message)) || (payload && payload.message) || 'refused', 200);
  };
  // presence_state / presence_diff's maps -> how many metas each key has (two sockets under one key are two)
  const metas = (x) => (x && Array.isArray(x.metas) ? Math.max(1, x.metas.length) : 1);
  function onFrame(data) {
    let f = null;
    try { f = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8')); } catch {}
    if (!f || typeof f !== 'object') return;
    const { topic, event, payload, ref } = f;
    if (topic === 'phoenix') {
      if (ref && ref === hbRef) { hbRef = null; if (payload && payload.status === 'ok') sockBackoff = BACKOFF_MIN; }
      return;
    }
    const ch = channels.get(topic);
    if (!ch) return;
    if (event === 'phx_reply') {
      if (ref !== ch.joinRef || ch.state !== 'joining') return; // the answer to a track or a token: nothing to do
      cancel(ch.timer); ch.timer = null;
      if (payload && payload.status === 'ok') {
        ch.state = 'joined';
        ch.backoff = BACKOFF_MIN;
        ch.refused = null;
        sockBackoff = BACKOFF_MIN;
        let pl = {};
        try { pl = presence() || {}; } catch {}
        wire({ topic: ch.wire, event: 'presence', ref: mkRef(), join_ref: ch.joinRef, payload: { type: 'presence', event: 'track', payload: { ...pl, at: now() } } });
        ch.changed();
        return;
      }
      ch.state = 'errored';
      ch.refused = reasonOf(payload);
      note(`realtime: Supabase refused a channel: ${ch.refused}`);
      ch.changed();
      return void rejoinLater(ch);
    }
    if (event === 'phx_error' || event === 'phx_close') {
      if (f.join_ref && f.join_ref !== ch.joinRef) return; // an earlier join's
      if (ch.state !== 'joined' && ch.state !== 'joining') return; // one we left
      cancel(ch.timer); ch.timer = null;
      ch.state = 'errored';
      ch.keys = null;
      if (event === 'phx_error') ch.refused = 'the channel failed';
      ch.changed();
      return void rejoinLater(ch);
    }
    if (event === 'system') {
      if (payload && payload.status === 'error') ch.refused = clip(payload.message || 'error', 200);
      return;
    }
    if (ch.state !== 'joined') return;
    if (event === 'broadcast') {
      if (payload && payload.event === 'e') { try { ch.h.onBroadcast(payload.payload); } catch (e) { note(`realtime: a message failed: ${e && e.message}`); } }
      return;
    }
    if (event === 'presence_state') {
      ch.keys = new Map();
      for (const [k, v] of Object.entries(payload && typeof payload === 'object' ? payload : {})) ch.keys.set(k, metas(v));
      try { ch.h.onPresence(); } catch {}
      return;
    }
    if (event === 'presence_diff') {
      if (!ch.keys) ch.keys = new Map();
      const d = payload && typeof payload === 'object' ? payload : {};
      for (const [k, v] of Object.entries(d.joins && typeof d.joins === 'object' ? d.joins : {})) ch.keys.set(k, (ch.keys.get(k) || 0) + metas(v));
      for (const [k, v] of Object.entries(d.leaves && typeof d.leaves === 'object' ? d.leaves : {})) {
        const left = (ch.keys.get(k) || 0) - metas(v);
        if (left > 0) ch.keys.set(k, left); else ch.keys.delete(k);
      }
      try { ch.h.onPresence(); } catch {}
    }
  }

  function channel(topic, h = {}) {
    if (stopped) throw new Error('realtime is stopped');
    const w = `realtime:${topic}`;
    if (channels.has(w)) throw new Error(`already on ${topic}`);
    const handlers = { onBroadcast: h.onBroadcast || (() => {}), onPresence: h.onPresence || (() => {}), onState: h.onState || (() => {}) };
    const ch = {
      topic, wire: w, state: 'closed', joinRef: null, backoff: BACKOFF_MIN, timer: null, refused: null, keys: null, h: handlers,
      changed() { try { handlers.onState(ch.state); } catch {} },
      send(env) {
        if (ch.state !== 'joined' || channels.get(w) !== ch) return false;
        return wire({ topic: w, event: 'broadcast', payload: { type: 'broadcast', event: 'e', payload: env }, ref: mkRef(), join_ref: ch.joinRef });
      },
      present(key) { return ch.state === 'joined' && ch.keys ? (ch.keys.get(key) || 0) > 0 : null; },
      leave() {
        if (channels.get(w) !== ch) return;
        leaveWire(ch);
        channels.delete(w);
        ch.state = 'closed';
        ch.joinRef = null;
        ch.keys = null;
        if (!channels.size) disconnect('nothing to join');
      },
    };
    channels.set(w, ch);
    if (!ws) connect();
    else if (wsOpen) join(ch);
    return ch;
  }
  function stop() {
    if (stopped) return;
    for (const ch of [...channels.values()]) leaveWire(ch);
    channels.clear();
    disconnect('stopped');
    stopped = true;
  }
  const status = () => ({ connected: wsOpen, channels: [...channels.values()].map((ch) => ({ topic: ch.topic, state: ch.state, ...(ch.refused ? { refused: ch.refused } : {}) })) });

  return { channel, stop, status };
}

module.exports = { createRealtime, HEARTBEAT_MS, JOIN_MS, BACKOFF_MIN, BACKOFF_MAX };
