// phone-push.js: push notifications to the paired phones (docs/phone.md, "Notifications"), started by relay.js. A
// phone sends its Expo push token over the relay (POST /push/token, relay.js keeps it on that device's record); here
// this server's own alerts (GET /state's alerts, numbered: n only grows, across restarts too) are read every 5 s and
// the new ones go to Expo's push service (https://exp.host/--/api/v2/push/send, plain fetch, no SDK), which hands
// them to Apple.
//
// Content-free by default: the relay is end-to-end encrypted, so a push never carries what a chat says. It names only
// what happened ("A chat needs you", "A chat finished", "A PR merged") and data { sid, kind, machine } (team: the
// group chat it is a member of), which the phone opens. A phone that turned on "Show chat names in notifications"
// (names on its token) also gets the chat's name as the body (and the PR's number): Expo and Apple then carry that name.
//
//   kinds     needs     an alert of kind question, error or stalled, or a plan that did not finish (failed or
//                       cancelled); a finished plan pushes nothing (its chat goes on, and says done when it ends)
//             finished  done
//             merged    merged
//   coalesce  per chat (a team's members as the team: one group chat) and kind, one push in 10 minutes; a chat
//             with two kinds in one read gets the more urgent one (needs, merged, finished); several chats in one
//             read go as one push per kind ("3 chats need you")
//   hosts     a chat another machine runs (/state's workspace.host) is left to that machine when the phone said it
//             is registered there too (peers: those machines' sync device ids), so a phone paired with both hears once
//   cursor    the newest n seen, kept in <dataDir>/relay/push.json with the coalescing times, so a restart never sends
//             again. The first read with no cursor, and the first read after no phone had a token, take the cursor
//             and send nothing (no burst of old alerts); an alert over 10 minutes old is never sent
//   tokens    one Expo answers DeviceNotRegistered for (the app was deleted, or its notifications turned off) is
//             dropped (opts.drop); a revoked device's goes with it (relay.js)
//
// The log (opts.log) says what failed, never a token or a chat's name.
//
// createPush({ port, dataDir, targets() -> [{ dev, token, names, peers }], drop(dev, token, why), log, now, timers,
//   fetch, sendUrl, pollMs }) -> { start(), stop(), tick() -> Promise }
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');

const SEND_URL = 'https://exp.host/--/api/v2/push/send';
const POLL_MS = 5e3;
const COALESCE_MS = 10 * 60e3; // per chat and kind
const MAX_AGE_MS = 10 * 60e3; // an alert older than this is never sent
const STATE_MS = 10e3, SEND_MS = 15e3;
const TTL_S = 6 * 3600; // Apple stops trying after this: a "needs you" from yesterday is no news
const BATCH_MAX = 100; // Expo takes at most 100 messages a request
const RANK = { needs: 3, merged: 2, finished: 1 };
const TITLE = {
  needs: (n) => (n > 1 ? `${n} chats need you` : 'A chat needs you'),
  finished: (n) => (n > 1 ? `${n} chats finished` : 'A chat finished'),
  merged: (n) => (n > 1 ? `${n} PRs merged` : 'A PR merged'),
};
const clip = (s, n = 200) => String(s == null ? '' : s).replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, n);

// an alert's kind of push, or null for none (/state alerts: { n, t, sid, name, text, kind })
function kindOf(a) {
  if (a.kind === 'question' || a.kind === 'error' || a.kind === 'stalled') return 'needs';
  if (a.kind === 'plan') return /\bfinished$/.test(String(a.text || '')) ? null : 'needs';
  if (a.kind === 'done') return 'finished';
  if (a.kind === 'merged') return 'merged';
  return null;
}

// "Alpha", "Alpha and Beta", "Alpha, Beta and 2 more"
function namesText(list) {
  const n = list.map((x) => clip(x, 60)).filter(Boolean);
  if (n.length <= 2) return n.join(' and ');
  return `${n.slice(0, 2).join(', ')} and ${n.length - 2} more`;
}

// the messages for one phone: one per kind (its items: [{ key, kind, sid, team, name, pr }]); names: its toggle
function messagesFor(target, items, machine) {
  const out = [];
  for (const kind of ['needs', 'merged', 'finished']) {
    const list = items.filter((x) => x.kind === kind);
    if (!list.length) continue;
    const one = list.length === 1 ? list[0] : null;
    const data = { kind, machine };
    if (one) { if (one.sid) data.sid = one.sid; if (one.team) data.team = one.team; }
    const m = { to: target.token, title: TITLE[kind](list.length), data, sound: 'default', priority: 'high', ttl: TTL_S };
    if (target.names) {
      const body = one && kind === 'merged' && one.pr ? `${clip(one.name, 60)} · PR #${one.pr}` : namesText(list.map((x) => x.name));
      if (body) m.body = body;
    }
    out.push(m);
  }
  return out;
}

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function createPush(o = {}) {
  const port = Number(o.port) || 4777;
  const file = path.join(o.dataDir || '.', 'relay', 'push.json');
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const log = typeof o.log === 'function' ? o.log : () => {};
  const T = o.timers || { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h) };
  const later = (fn, ms) => { const h = T.setTimeout(fn, ms); if (h && typeof h.unref === 'function') h.unref(); return h; };
  const targets = typeof o.targets === 'function' ? o.targets : () => [];
  const drop = typeof o.drop === 'function' ? o.drop : () => {};
  const doFetch = typeof o.fetch === 'function' ? o.fetch : globalThis.fetch;
  const sendUrl = o.sendUrl || SEND_URL;
  const pollMs = Number(o.pollMs) || POLL_MS;
  const said = new Map();
  // a line for the log, at most once a minute for the same text
  const note = (text) => { const t = now(), at = said.get(text); if (at && t - at < 60e3) return; if (said.size > 100) said.clear(); said.set(text, t); log(`push: ${text}`); };

  // ---------- the cursor and the coalescing times ----------
  let cursor = null; // the newest alert n seen, or null: the next read takes it and sends nothing
  let sent = new Map(); // '<key>|<kind>' -> when it was pushed
  let idle = false; // no phone had a token at the last tick: the next read with one takes the cursor anew
  function load() {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (j && Number.isFinite(j.n)) cursor = j.n;
      const t = now();
      for (const [k, at] of Object.entries(j && typeof j.sent === 'object' && j.sent ? j.sent : {})) if (Number.isFinite(at) && t - at < COALESCE_MS) sent.set(k, at);
    } catch (e) { if (e.code !== 'ENOENT') note(`push.json could not be read: ${e.message}`); }
  }
  function save() {
    const t = now();
    for (const [k, at] of sent) if (t - at >= COALESCE_MS) sent.delete(k);
    try { writeAtomic(file, `${JSON.stringify({ v: 1, n: cursor, sent: Object.fromEntries(sent) })}\n`); } catch (e) { note(`push.json could not be saved: ${e.message}`); }
  }

  // ---------- reading /state ----------
  let etag = null;
  function getState() {
    return new Promise((resolve) => {
      const headers = { Accept: 'application/json' };
      if (etag) headers['If-None-Match'] = etag;
      let done = false;
      const end = (v) => { if (!done) { done = true; resolve(v); } };
      const rq = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/state', headers, timeout: STATE_MS }, (rs) => {
        const parts = [];
        rs.on('data', (c) => parts.push(c));
        rs.on('error', () => end(null));
        rs.on('end', () => {
          if (rs.statusCode === 304) return end('same');
          if (rs.statusCode !== 200) return end(null);
          try { const j = JSON.parse(Buffer.concat(parts).toString('utf8')); etag = typeof rs.headers.etag === 'string' ? rs.headers.etag : null; end(j); } catch { end(null); }
        });
      });
      rq.on('timeout', () => { rq.destroy(); end(null); });
      rq.on('error', () => end(null));
      rq.end();
    });
  }

  // ---------- sending ----------
  // -> the tickets ([{ status, details? }] in the messages' order), or null when Expo could not be reached
  async function send(messages) {
    if (typeof doFetch !== 'function') { note('this node has no fetch: no push can go'); return null; }
    const ac = new AbortController();
    const h = later(() => ac.abort(), SEND_MS);
    try {
      const r = await doFetch(sendUrl, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(messages), signal: ac.signal });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || !Array.isArray(j.data)) {
        const why = j && Array.isArray(j.errors) && j.errors[0] ? `${clip(j.errors[0].code, 60)} ${clip(j.errors[0].message, 120)}` : `answered ${r.status}`;
        note(`Expo's push service refused ${messages.length}: ${why}`);
        return null;
      }
      return j.data;
    } catch (e) {
      note(`Expo's push service could not be reached: ${e && e.name === 'AbortError' ? 'it took too long' : clip(e && e.message, 120)}`);
      return null;
    } finally { if (h) T.clearTimeout(h); }
  }

  // ---------- one look ----------
  let busy = false;
  async function tick() {
    if (busy) return;
    busy = true;
    try { await look(); } catch (e) { note(`a look failed: ${e && e.message}`); } finally { busy = false; }
  }
  async function look() {
    const list = targets().filter((x) => x && typeof x.token === 'string' && x.token && typeof x.dev === 'string');
    if (!list.length) { idle = true; return; }
    const st = await getState();
    if (st === 'same' || !st) return;
    const alerts = (Array.isArray(st.alerts) ? st.alerts : []).filter((a) => a && Number.isFinite(a.n));
    const top = alerts.reduce((m, a) => Math.max(m, a.n), cursor == null ? -Infinity : cursor);
    if (cursor == null || idle) {
      // catching up: everything there now is old news
      idle = false;
      cursor = Number.isFinite(top) ? top : 0;
      save();
      return;
    }
    const t = now();
    const fresh = alerts.filter((a) => a.n > cursor && t - (Number(a.t) || 0) <= MAX_AGE_MS);
    const moved = top > cursor;
    if (moved) cursor = top;
    // per chat (a team's members as the team), its most urgent kind
    const sessions = new Map((Array.isArray(st.sessions) ? st.sessions : []).filter((s) => s && typeof s.id === 'string').map((s) => [s.id, s]));
    const teamOf = new Map();
    for (const tm of Array.isArray(st.teams) ? st.teams : []) for (const id of Array.isArray(tm && tm.members) ? tm.members : []) if (typeof id === 'string' && !teamOf.has(id)) teamOf.set(id, tm.id);
    const best = new Map();
    for (const a of fresh) {
      const kind = kindOf(a);
      if (!kind || typeof a.sid !== 'string') continue;
      const team = typeof teamOf.get(a.sid) === 'string' ? teamOf.get(a.sid) : null;
      const key = team ? `team:${team}` : `chat:${a.sid}`;
      const had = best.get(key);
      if (had && RANK[had.kind] >= RANK[kind]) continue;
      const s = sessions.get(a.sid);
      const host = s && s.workspace && s.workspace.host && typeof s.workspace.host.device === 'string' ? s.workspace.host.device.toLowerCase() : null;
      const pr = kind === 'merged' ? (/PR #(\d+)/.exec(String(a.text || '')) || [])[1] || null : null;
      best.set(key, { key, kind, sid: a.sid, team, name: clip(a.name || (s && s.name), 80), pr, host });
    }
    const items = [...best.values()].filter((x) => !(sent.get(`${x.key}|${x.kind}`) > t - COALESCE_MS));
    if (!items.length) { if (moved) save(); return; }
    for (const x of items) sent.set(`${x.key}|${x.kind}`, t);
    save();
    const messages = [], owners = [];
    for (const target of list) {
      const peers = new Set((Array.isArray(target.peers) ? target.peers : []).map((p) => String(p).toLowerCase()));
      // a chat another machine runs, which this phone hears from there too
      const mine = items.filter((x) => !(x.host && peers.has(x.host)));
      for (const m of messagesFor(target, mine, target.dev)) { messages.push(m); owners.push(target); }
    }
    for (let i = 0; i < messages.length; i += BATCH_MAX) {
      const part = messages.slice(i, i + BATCH_MAX);
      const tickets = await send(part);
      if (!tickets) continue;
      tickets.forEach((tk, j) => {
        if (!tk || tk.status !== 'error') return;
        const err = tk.details && typeof tk.details.error === 'string' ? tk.details.error : '';
        const who = owners[i + j];
        if (err === 'DeviceNotRegistered' && who) drop(who.dev, who.token, 'Expo says the app is not registered for notifications any more');
        else note(`Expo refused a push: ${clip(err || tk.message, 120)}`);
      });
    }
  }

  // ---------- the timer ----------
  let timer = null, running = false;
  const loop = () => { timer = later(() => { timer = null; tick().finally(() => { if (running) loop(); }); }, pollMs); };
  function start() {
    if (running) return;
    running = true;
    load();
    loop();
  }
  function stop() {
    running = false;
    if (timer) { T.clearTimeout(timer); timer = null; }
  }
  return { start, stop, tick };
}

module.exports = { createPush, kindOf, messagesFor, namesText, SEND_URL, POLL_MS, COALESCE_MS, MAX_AGE_MS };
