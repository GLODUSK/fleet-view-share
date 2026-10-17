// phone-push.js: push notifications to the paired phones (docs/phone.md, "Notifications"), started by relay.js. A
// phone sends its Expo push token over the relay (POST /push/token, relay.js keeps it on that device's record); here
// this server's own alerts (GET /state's alerts, numbered: n only grows, across restarts too) are read every 5 s and
// the new ones go to Expo's push service (https://exp.host/--/api/v2/push/send, plain fetch, no SDK), which hands
// them to Apple.
//
// The relay is end-to-end encrypted and a push is not: Expo and Apple see what it says. A phone with "Show what chats
// say" on (names on its token; the phone's default) gets one push per chat: its name as the title, what happened as
// the subtitle ("Finished · <repo>", "Asks you", "Merged PR #482"...) and a line of the chat's own words as the body
// (the start of its last reply; the question it asks). With it off a push names only what happened ("A chat needs
// you", "A chat finished", "A PR merged"). Either way data { sid, kind, machine } (team: the group chat it is a
// member of), which the phone opens.
//
//   kinds     needs     an alert of kind question, error or stalled, or a plan that did not finish (failed or
//                       cancelled); a finished plan pushes nothing (its chat goes on, and says done when it ends)
//             finished  done
//             merged    merged
//   coalesce  per chat (a team's members as the team: one group chat) and kind: needs once in 3 minutes, finished
//             once in 2, merged once per PR; a chat with two kinds in one read gets the more urgent one (needs,
//             merged, finished). Several chats of a kind in one read: one push each up to 3 (names on), else one push
//             for them all ("4 chats need you")
//   hosts     a chat another machine runs (/state's workspace.host) is left to that machine when the phone said it
//             is registered there too (peers: those machines' sync device ids), so a phone paired with both hears once
//   cursor    the newest n seen, kept in <dataDir>/relay/push.json with the coalescing times, so a restart never sends
//             again. The first read with no cursor, and the first read after no phone had a token, take the cursor
//             and send nothing (no burst of old alerts); an alert over 10 minutes old is never sent
//   bots      a bot a session asks for (/state's botRequests, bots.js requestBot) pushes once, as it arrives: names on,
//             "<the session's name, or A session> asks to make a bot: <name>" with its role (else its why) as the body;
//             names off, "A session asks to make a bot". data { kind: 'bot-request', request: <its id>, machine }: the
//             phone opens its Bots tab. The newest one seen (its at) is kept in push.json as reqAt, so a restart never
//             sends again; the first read without one takes it and sends nothing
//             a bot a session made itself (/state's bots with bySession, bots.js create) pushes once, after the fact:
//             names on, "<madeByName, or A session> made a bot: <name>" with its role as the body; names off, "A
//             session made a bot". data { kind: 'bot-made', bot: <its id>, machine }: the phone opens its Bots tab.
//             The newest one seen (its createdAt) is kept in push.json as madeAt, the same way as reqAt
//             a bot a session removed (/state's botRemovals, bots.js remove) pushes once, after the fact: names on,
//             "<removedByName, or A session> removed a bot: <name>"; names off, "A session removed a bot". data
//             { kind: 'bot-removed', bot: <its id>, machine }. The newest one seen (its removedAt) is kept in push.json
//             as removedAt, the same way as madeAt
//   tokens    one Expo answers DeviceNotRegistered for (the app was deleted, or its notifications turned off) is
//             dropped (opts.drop); a revoked device's goes with it (relay.js)
//
// The log (opts.log) says what failed, never a token, a chat's name or its words.
//
// createPush({ port, dataDir, targets() -> [{ dev, token, names, peers }], drop(dev, token, why), log, now, timers,
//   fetch, sendUrl, pollMs }) -> { start(), stop(), tick() -> Promise }
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');

const SEND_URL = 'https://exp.host/--/api/v2/push/send';
const POLL_MS = 5e3;
const WINDOW_MS = { needs: 3 * 60e3, finished: 2 * 60e3, merged: 10 * 60e3 }; // per chat and kind (merged: per PR)
const COALESCE_MS = Math.max(...Object.values(WINDOW_MS)); // the longest: how long push.json keeps a time
const MAX_AGE_MS = 10 * 60e3; // an alert older than this is never sent
const STATE_MS = 10e3, SEND_MS = 15e3;
const TTL_S = 6 * 3600; // Apple stops trying after this: a "needs you" from yesterday is no news
const BATCH_MAX = 100; // Expo takes at most 100 messages a request
const ONE_EACH_MAX = 3; // names on: up to this many chats of a kind in one read get a push each
const BODY_MAX = 240; // about four lines on the lock screen
const RANK = { needs: 3, merged: 2, finished: 1 };
const TITLE = {
  needs: (n) => (n > 1 ? `${n} chats need you` : 'A chat needs you'),
  finished: (n) => (n > 1 ? `${n} chats finished` : 'A chat finished'),
  merged: (n) => (n > 1 ? `${n} PRs merged` : 'A PR merged'),
};
const REQ_TITLE = 'A session asks to make a bot';
const MADE_TITLE = 'A session made a bot';
const REMOVED_TITLE = 'A session removed a bot';
const clip = (s, n = 200) => String(s == null ? '' : s).replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, n);
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

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

// ---------- a line of what a chat said ----------
// at most n characters, cut between words so a number or a name is never cut in half
function clipWords(text, n) {
  const t = String(text == null ? '' : text).replace(/[\x00-\x1f\x7f\s]+/g, ' ').trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n - 1), sp = cut.lastIndexOf(' ');
  return (sp > n * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s,;:.\-–—(]+$/, '') + '…';
}
// a reply's lines that say something, as plain text: no code, rules, table borders, list or markdown marks
function proseLines(text) {
  const out = [];
  let fence = false;
  for (const raw of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(raw)) { fence = !fence; continue; }
    if (fence) continue;
    const l = raw.replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, '')
      .replace(/^\|\s*|\s*\|$/g, '').replace(/\s*\|\s*/g, ' · ')
      .replace(/\*\*|__|`/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim();
    if (l.length < 2 || /^[-=_*·:…\s]+$/.test(l)) continue;
    out.push(l);
  }
  return out;
}
// the start of a reply, its first lines run together, at most n characters
function gist(text, n = BODY_MAX) {
  let t = '';
  for (const l of proseLines(text)) { t = t ? `${t}${/[.!?:;]$/.test(t) ? '' : '.'} ${l}` : l; if (t.length >= n) break; }
  return clipWords(t, n);
}
// the question a reply ends on: its last line with a "?" (and the line before, when both are short), else its end
function askOf(text, n = BODY_MAX) {
  const lines = proseLines(text);
  let i = lines.length - 1;
  while (i >= 0 && !lines[i].includes('?')) i--;
  if (i < 0) return gist(lines.slice(-2).join('\n'), n);
  const q = i > 0 && lines[i].length < 80 && lines[i - 1].length < 120 ? `${lines[i - 1]} ${lines[i]}` : lines[i];
  return clipWords(q, n);
}

// what happened and a line of the chat's words, for one alert and its chat's /state row (s, or null)
// -> { what, body }
function detailOf(a, s) {
  const text = String(a.text || '');
  // a bot's chat leaves some replies out: then the one it shows (doneReply, null before any)
  const reply = s ? (Object.prototype.hasOwnProperty.call(s, 'doneReply') ? s.doneReply : s.lastReply) : '';
  const repo = s && s.repo && typeof s.repo.name === 'string' ? clip(s.repo.name, 40) : '';
  const inRepo = (w) => (repo ? `${w} · ${repo}` : w);
  if (a.kind === 'question') {
    const wait = /^waits on you: ([\s\S]+)$/.exec(text);
    if (wait) return { what: 'Waits on you', body: clipWords(wait[1], BODY_MAX) };
    if (/panel open/.test(text)) return { what: 'Has a panel open', body: 'A panel in its terminal holds back its updates (Esc closes it).' };
    // asking with its question tool: the question and its choices; asked in its reply: the question it ends on
    return { what: inRepo('Asks you'), body: /is asking/.test(text) ? gist(s && s.lastReply) : askOf(s && s.lastReply) };
  }
  if (a.kind === 'error') return { what: 'Hit an API error', body: 'Open it to retry.' };
  if (a.kind === 'stalled') return { what: 'Stuck mid-turn', body: cap(clipWords(text, BODY_MAX)) };
  if (a.kind === 'plan') return { what: /cancelled$/.test(text) ? 'Plan cancelled' : 'Plan failed', body: cap(clipWords(text, BODY_MAX)) };
  if (a.kind === 'merged') {
    const pr = (/PR #(\d+)/.exec(text) || [])[1];
    return { what: pr ? `Merged PR #${pr}` : 'Merged its PR', body: repo ? `Into ${repo}.` : '' };
  }
  if (a.kind === 'done') return { what: inRepo('Finished'), body: gist(reply) || gist(s && s.lastReply) };
  return { what: cap(clip(text, 80)), body: '' };
}

// the messages for one phone (its items: [{ key, kind, sid, team, teamName, name, pr, what, body }]); names: its
// toggle. Names on: a push per chat (title its name, subtitle what happened, body its words), up to ONE_EACH_MAX of a
// kind; names off, or more than that: one per kind saying only what happened (names on: and which chats)
function messagesFor(target, items, machine) {
  const out = [];
  for (const kind of ['needs', 'merged', 'finished']) {
    const list = items.filter((x) => x.kind === kind);
    if (!list.length) continue;
    if (target.names && list.length <= ONE_EACH_MAX) {
      for (const x of list) {
        const data = { kind, machine };
        if (x.sid) data.sid = x.sid;
        if (x.team) data.team = x.team;
        const name = clip(x.name, 80);
        const m = { to: target.token, title: clip(x.teamName, 80) || name || TITLE[kind](1), data, sound: 'default', priority: 'high', ttl: TTL_S };
        const what = x.teamName && name ? `${name} · ${x.what || ''}` : x.what;
        if (what) m.subtitle = clip(what, 120);
        if (x.body) m.body = x.body;
        out.push(m);
      }
      continue;
    }
    const one = list.length === 1 ? list[0] : null;
    const data = { kind, machine };
    if (one) { if (one.sid) data.sid = one.sid; if (one.team) data.team = one.team; }
    const m = { to: target.token, title: TITLE[kind](list.length), data, sound: 'default', priority: 'high', ttl: TTL_S };
    if (target.names) { const body = namesText(list.map((x) => x.teamName || x.name)); if (body) m.body = body; }
    out.push(m);
  }
  return out;
}

// the push for a bot a session asks for (/state botRequests: { id, name, role, why, from, fromName, at }), for one phone
function requestMessage(target, r, machine) {
  const data = { kind: 'bot-request', request: r.id, machine };
  const m = { to: target.token, title: REQ_TITLE, data, sound: 'default', priority: 'high', ttl: TTL_S };
  if (!target.names) return m;
  m.title = clip(`${clip(r.fromName, 60) || 'A session'} asks to make a bot: ${clip(r.name, 40)}`, 120);
  const body = clip(r.role, 80) || clipWords(r.why, BODY_MAX);
  if (body) m.body = body;
  return m;
}

// the push for a bot a session made (/state bots: { id, name, role, bySession, madeByName, createdAt }), for one phone
function madeMessage(target, b, machine) {
  const data = { kind: 'bot-made', bot: b.id, machine };
  const m = { to: target.token, title: MADE_TITLE, data, sound: 'default', priority: 'high', ttl: TTL_S };
  if (!target.names) return m;
  m.title = clip(`${clip(b.madeByName, 60) || 'A session'} made a bot: ${clip(b.name, 40)}`, 120);
  const body = clip(b.role, 80);
  if (body) m.body = body;
  return m;
}

// the push for a bot a session removed (/state botRemovals: { id, name, removedByName, removedAt }), for one phone
function removedMessage(target, b, machine) {
  const data = { kind: 'bot-removed', bot: b.id, machine };
  const m = { to: target.token, title: REMOVED_TITLE, data, sound: 'default', priority: 'high', ttl: TTL_S };
  if (target.names) m.title = clip(`${clip(b.removedByName, 60) || 'A session'} removed a bot: ${clip(b.name, 40)}`, 120);
  return m;
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
  let reqAt = null; // the newest bot request seen (its at), or null: the next read takes it and sends nothing
  let madeAt = null; // the newest bot a session made seen (its createdAt), or null: as reqAt
  let removedAt = null; // the newest bot a session removed seen (its removedAt), or null: as reqAt
  function load() {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (j && Number.isFinite(j.n)) cursor = j.n;
      if (j && Number.isFinite(j.reqAt)) reqAt = j.reqAt;
      if (j && Number.isFinite(j.madeAt)) madeAt = j.madeAt;
      if (j && Number.isFinite(j.removedAt)) removedAt = j.removedAt;
      const t = now();
      for (const [k, at] of Object.entries(j && typeof j.sent === 'object' && j.sent ? j.sent : {})) if (Number.isFinite(at) && t - at < COALESCE_MS) sent.set(k, at);
    } catch (e) { if (e.code !== 'ENOENT') note(`push.json could not be read: ${e.message}`); }
  }
  function save() {
    const t = now();
    for (const [k, at] of sent) if (t - at >= COALESCE_MS) sent.delete(k);
    try { writeAtomic(file, `${JSON.stringify({ v: 1, n: cursor, sent: Object.fromEntries(sent), ...(reqAt != null ? { reqAt } : {}), ...(madeAt != null ? { madeAt } : {}), ...(removedAt != null ? { removedAt } : {}) })}\n`); } catch (e) { note(`push.json could not be saved: ${e.message}`); }
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
    const t = now();
    // the bots sessions ask for (bots.js requestBot): the ones newer than reqAt
    const reqs = (Array.isArray(st.botRequests) ? st.botRequests : []).filter((r) => r && typeof r.id === 'string' && typeof r.name === 'string' && Number.isFinite(r.at));
    const reqTop = reqs.reduce((m, r) => Math.max(m, r.at), t);
    // the bots sessions made (bots.js create, bySession): the ones newer than madeAt
    const made = (Array.isArray(st.bots) ? st.bots : []).filter((b) => b && b.bySession === true && typeof b.id === 'string' && typeof b.name === 'string' && Number.isFinite(b.createdAt));
    const madeTop = made.reduce((m, b) => Math.max(m, b.createdAt), t);
    // the bots sessions removed (bots.js remove): the ones newer than removedAt
    const gone = (Array.isArray(st.botRemovals) ? st.botRemovals : []).filter((b) => b && typeof b.id === 'string' && typeof b.name === 'string' && Number.isFinite(b.removedAt));
    const goneTop = gone.reduce((m, b) => Math.max(m, b.removedAt), t);
    if (cursor == null || idle) {
      // catching up: everything there now is old news
      idle = false;
      cursor = Number.isFinite(top) ? top : 0;
      reqAt = reqTop;
      madeAt = madeTop;
      removedAt = goneTop;
      save();
      return;
    }
    // a push.json from before bot requests: the ones there now are old news too
    const reqFresh = reqAt == null ? [] : reqs.filter((r) => r.at > reqAt && t - r.at <= MAX_AGE_MS).sort((a, b) => a.at - b.at);
    const reqMoved = reqAt == null || reqs.some((r) => r.at > reqAt);
    if (reqMoved) reqAt = reqAt == null ? reqTop : Math.max(reqAt, ...reqs.map((r) => r.at));
    // (likewise a push.json from before bots sessions made)
    const madeFresh = madeAt == null ? [] : made.filter((b) => b.createdAt > madeAt && t - b.createdAt <= MAX_AGE_MS).sort((a, b) => a.createdAt - b.createdAt);
    const madeMoved = madeAt == null || made.some((b) => b.createdAt > madeAt);
    if (madeMoved) madeAt = madeAt == null ? madeTop : Math.max(madeAt, ...made.map((b) => b.createdAt));
    // (and one from before bots sessions removed)
    const goneFresh = removedAt == null ? [] : gone.filter((b) => b.removedAt > removedAt && t - b.removedAt <= MAX_AGE_MS).sort((a, b) => a.removedAt - b.removedAt);
    const goneMoved = removedAt == null || gone.some((b) => b.removedAt > removedAt);
    if (goneMoved) removedAt = removedAt == null ? goneTop : Math.max(removedAt, ...gone.map((b) => b.removedAt));
    const fresh = alerts.filter((a) => a.n > cursor && t - (Number(a.t) || 0) <= MAX_AGE_MS);
    const moved = top > cursor;
    if (moved) cursor = top;
    // per chat (a team's members as the team), its most urgent kind
    const sessions = new Map((Array.isArray(st.sessions) ? st.sessions : []).filter((s) => s && typeof s.id === 'string').map((s) => [s.id, s]));
    const teamOf = new Map(), teamName = new Map();
    for (const tm of Array.isArray(st.teams) ? st.teams : []) {
      if (tm && typeof tm.id === 'string' && typeof tm.name === 'string') teamName.set(tm.id, tm.name);
      for (const id of Array.isArray(tm && tm.members) ? tm.members : []) if (typeof id === 'string' && !teamOf.has(id)) teamOf.set(id, tm.id);
    }
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
      const { what, body } = detailOf(a, s || null);
      best.set(key, { key, kind, sid: a.sid, team, teamName: team ? clip(teamName.get(team), 80) : '', name: clip(a.name || (s && s.name), 80), pr, host, what, body });
    }
    // (a merge per PR: two PRs merged by one chat are two pieces of news)
    const sentKey = (x) => `${x.key}|${x.kind}${x.pr ? `#${x.pr}` : ''}`;
    const items = [...best.values()].filter((x) => !(sent.get(sentKey(x)) > t - WINDOW_MS[x.kind]));
    if (!items.length && !reqFresh.length && !madeFresh.length && !goneFresh.length) { if (moved || reqMoved || madeMoved || goneMoved) save(); return; }
    for (const x of items) sent.set(sentKey(x), t);
    save();
    const messages = [], owners = [];
    for (const target of list) {
      const peers = new Set((Array.isArray(target.peers) ? target.peers : []).map((p) => String(p).toLowerCase()));
      // a chat another machine runs, which this phone hears from there too
      const mine = items.filter((x) => !(x.host && peers.has(x.host)));
      for (const m of [...reqFresh.map((r) => requestMessage(target, r, target.dev)), ...madeFresh.map((b) => madeMessage(target, b, target.dev)), ...goneFresh.map((b) => removedMessage(target, b, target.dev)), ...messagesFor(target, mine, target.dev)]) { messages.push(m); owners.push(target); }
    }
    // (the log names no bot: it says what happened only)
    if (madeFresh.length) log(`push: ${madeFresh.length} bot(s) a session made, to ${list.length} phone(s)`);
    if (goneFresh.length) log(`push: ${goneFresh.length} bot(s) a session removed, to ${list.length} phone(s)`);
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

module.exports = { createPush, kindOf, messagesFor, requestMessage, madeMessage, removedMessage, namesText, detailOf, gist, askOf, SEND_URL, POLL_MS, WINDOW_MS, COALESCE_MS, MAX_AGE_MS };
