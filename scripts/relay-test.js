// Phone relay: a test of relay.js, run with the system node:   node scripts/relay-test.js   [--live]
// The crypto against docs/phone-vectors.json: the direction keys, the AAD, every vector opened to its exact plaintext,
// both refused ones refused, the relay's seal with the fixed nonces giving the exact z=0 ciphertexts, its own z=1 round
// trip, the pairing link, the v2 handshake's vector (X25519 keys, the shared secret, K', its direction keys, the hello
// and its answer under K, a request under K'), and scripts/phone-vectors.js --check. The allowlist (allowed, refused,
// traversal, id patterns, the Chief's and the bots' routes and their near misses), the marked routes, every route's
// timeout, the start weights, and slices() (never between the halves of a surrogate pair). Off: sync not set up or
// not signed in means no socket, no key read and a 409 to pair. Then a relay against a fake WebSocket (frames
// injected, sends captured) and a fake local HTTP server standing in for Fleet View: the socket URL (apikey,
// vsn=1.0.0), the phx_join's exact payload with the access token, presence track on join, pairing v2 (a req under K
// 403, a hello with no epk or a bad one 400, the handshake: K' kept before the answer, a lost answer and a hello again
// both K' working, the first envelope under one making it the key and forgetting K, then K 403 "already paired" and
// the other K' dropped; one handshake per 5 s and 8 per code, an answered handshake never used swept key and all;
// the same across a restart before the first envelope under K'; a hello past exp dropped, the
// expired pairing dropped key and all), page POSTs with this PC's Origin, /api/* with the Bearer token and no Origin,
// the marker (via phone and X-Fleet-View-Relay on the marked routes only, the bots' among them, after every check,
// the phone's own via dropped everywhere, no header the phone names passed on, a replayed or stale marked request
// never reaching the server; with no relayKey or a bad one no marker, said once), GET /chief/briefing, POST
// /api/chief/start (account, model, effort only), POST /api/sessions with a role 403, settings chief ({ watch }
// alone), the bots' bodies (their keys, no folder), the Claude accounts screen (GET /accounts trimmed to a, email,
// signedIn and A's and B's sign-ins; a sign-in, a code and a stop only for A or B with no login, only their own body;
// a signed-in letter, another letter, a bad body or an unreadable list refused before the server), the settings key filter, the known-root checks (/settings,
// /repos/add, /sessions/move, /push-target, /repo-history), the phone's fence (GET /file, /chat/kind, /chat/files,
// /chat/commands: a C:\ cwd, a ~ cwd, ~/.ssh/id_ed25519, .env.local, secret names, a dot-folder inside a repo,
// .github, a worktree inside .claude, a junction out of the repo, an app data folder, Fleet View's data folder, the
// listings filtered, a conversation's repo that is no git checkout, the folders a home dot-folder and an app data child
// link to from outside both, the newer secret names, a file whose text holds a key), etag -> 304, text as b + ct, binary as b64 + ct, replays (a repeated nonce, an old or future
// at, one from before the start), envelopes that don't open (dropped, never answered, an inflate bomb too), the caps
// up (a ciphertext over C_MAX, an inflate past 2 MB, 4 inflating at once), the id retry cache (a POST runs once, a
// repeat of one still running is ignored), t0 (a POST first sent before the relay started: 409 restarted, kept; one
// first sent 9 minutes ago: 409 expired; a GET runs), timeouts (30 s, 60 s with wait capped at 50, 95 s and 75 s plus
// the wait for the routes that start or resume a Claude), 429 (20 in flight, 30 envelopes a second, repeats too,
// 1,200 a minute, 2 starts at once and 12 in 10 minutes, a team per member, a message weighed by what /state says is
// not running, 64 MB of answers being read, with
// retryAfter), parts both ways (out of order, a surrogate pair at the cut, over 64 parts -> 413, 64 parts, 4
// assemblies, 60 s, 21,000,000 characters), the token re-sent on refresh and at the heartbeat, a heartbeat left
// unanswered (reconnect), presence setting lastSeen, sign-out and sign-in (leave, then join again on a new socket),
// revoke (notice, leave, key deleted, a request still being checked never going on), stop('pc-closing') (notice,
// socket closed), backoff on refused joins and on a socket that keeps dropping (1 s doubling to 60 s, never a spin).
// /relay/* (PC only, Origin on POSTs, no key in the status) and the CLI over loopback (pair.html with the QR code,
// never the link). relay.log holds no body, key, token, marker key or link. Local mode (Work locally, relay-lan.js) on
// a real socket on a spare port: the addresses it would bind (private IPv4 only, the Wi-Fi's first), pairing with sync
// not set up (409 with no private address, 400 for a bad mode, relay mode still 409; the local link's exact JSON, no
// Supabase socket, devices.json's mode), a bare 404 for a plain request, another path, an unknown device, a query,
// another Host, a page's Origin, a bad version or key; on the device's socket nothing before an envelope opens, an
// unmasked frame 1002, an oversized frame 1009 from its header, a bad envelope or one for the Supabase topic 1008, a
// silent socket closed when its time runs out; then the v2 handshake under K and a hello under K' over the socket,
// GET /state through, the allowlist, the fence and the marker as through Supabase, a replay dropped, answers down the
// socket the request came on, the per-device cap (a proven socket never pushed out), sync signed in with only a local
// device (no Supabase socket) and a relay pairing next to it (the socket opens, and closes when it is revoked),
// stop('pc-closing') down the socket, a restart with sync off, revoke (notice, socket closed, key gone, listener off).
// Last, publish-share.js's guard passes relay.js, relay-lan.js, ws-frames.js, this test, the QR library and the
// protocol docs (in a throwaway git repo).
// The home folder and the app data folders are fakes inside the temp folder (USERPROFILE, HOME, APPDATA,
// LOCALAPPDATA, PROGRAMDATA, XDG_* for this process), so the fence's cases never touch the real ones.
// --live (only on a PC where sync S1 is set up and signed in): a throwaway v2 pairing on the real Realtime, the test
// playing the phone on a second socket (the hello under K, K' from the answer, a request under K', then K refused),
// revoked at the end; prints no token, and checks nothing in the sync folder changed. While migration 0376 is not
// applied Supabase refuses the join, and that is what it reports.
// Everything happens in a temp folder (RELAY_TEST_DIR, or the system temp folder), deleted at the end
// (RELAY_TEST_KEEP=1 keeps it). No network, no real Supabase. Exit 0 = all pass.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const R = require(path.join(ROOT, 'relay.js'));
const V = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'phone-vectors.json'), 'utf8'));

const base = process.env.RELAY_TEST_DIR || os.tmpdir();
fs.mkdirSync(base, { recursive: true });
const T = fs.realpathSync(fs.mkdtempSync(path.join(base, 'relay-test-')));
const ENV0 = { ...process.env }; // for the child processes (git, the share guard, phone-vectors.js)

let failures = 0, passes = 0;
const ok = (cond, what) => { if (cond) passes++; else { failures++; console.log(`FAIL ${what}`); } };
const eq = (a, b, what) => ok(JSON.stringify(a) === JSON.stringify(b), `${what}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
async function waitUntil(pred, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = pred();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(2);
  }
}

// fixtures: nothing here looks like a real project, key or token (the share repo's guard)
const SB_URL = 'https://example-project.supabase.co', SB_KEY = 'test-publishable-key';
const API_TOKEN = 'test-api-token-0123456789';
const RELAY_KEY = 'test-relay-key-0123456789'; // api.js relayKey(), the marker's
const UID = '00000000-0000-4000-8000-000000000001';
const SID = '11111111-2222-4333-8444-555555555555';
const BOT = 'a1b2c3d4e5f6'; // bots.js's ids: 12 hex digits
const KNOWN = path.join(T, 'repos', 'known'), HIDDEN = path.join(T, 'repos', 'hidden'), LISTED = path.join(T, 'repos', 'listed');
const CWD = path.join(KNOWN, 'sub'), ELSEWHERE = path.join(T, 'elsewhere');
// the fence's world: a fake home folder and app data folders (main() points the environment at them), a worktree
// inside the repo's .claude folder, and conversations whose repo is the home folder, a drive's top, a home
// dot-folder, a folder in the app data, and one that only ran in ELSEWHERE
// (the app data folders sit outside the fake home, so each rule is tested on its own: on a real Windows PC they are
// inside it, and the home rule and the app data rule both refuse the home folder)
const HOME = path.join(T, 'home');
// the app data folders as each system has them: %APPDATA% and %LOCALAPPDATA% on Windows, their counterparts under
// ~/Library on a Mac (relay.js appDirs and linkedDirs read those there), so the fence's cases mean the same on both
const APPDATA = process.platform === 'darwin' ? path.join(HOME, 'Library', 'Application Support') : path.join(T, 'appdata', 'Roaming');
const LOCALAPPDATA = process.platform === 'darwin' ? path.join(HOME, 'Library', 'Caches') : path.join(T, 'appdata', 'Local');
const DRIVE = path.parse(T).root, WT = path.join(KNOWN, '.claude', 'worktrees', 'wt'), INAPP = path.join(LOCALAPPDATA, 'tool', 'repo');
// another drive's top (one that holds neither the home folder nor the app data), and a folder on it with no dot-named
// step (for a link out of the repo to another drive), where this PC has one
const DRIVE2 = [ROOT, process.execPath].map((x) => path.parse(x).root).find((r) => r.toLowerCase() !== DRIVE.toLowerCase()) || null;
const FAR = [path.dirname(process.execPath), ROOT].find((d) => path.parse(d).root.toLowerCase() !== DRIVE.toLowerCase() && !/[\\/]\./.test(d)) || null;
const DOTREPO = path.join(HOME, '.claude');
// a folder that is no git checkout (/state names it as a conversation's repo all the same), and folders that home
// dot-entries and app data children link to from outside both (~/.claude -> J:\Cache\ClaudeCode on Henry's PC), each
// a git checkout here so that only the link rule refuses them; CACHE holds two of them
const PLAIN = path.join(T, 'plain'), CACHE = path.join(T, 'cache'), DOTLINKED = path.join(CACHE, 'claudecode'), APPLINKED = path.join(CACHE, 'claude');
// the start limits' liveness: a team of three, one of them running (a claude process has it open)
const TID = 'tfeed01', LIVE = '99999999-2222-4333-8444-555555555555', IDLE = 'aaaaaaaa-2222-4333-8444-555555555555';
const sess = (id, cwd, root, folder) => ({ id, cwd, repo: root ? { root } : null, links: { repoFolder: folder || root || null } });
const STATE = {
  repos: [{ root: KNOWN, name: 'known' }],
  settings: { hiddenRepos: [{ root: HIDDEN, at: 1 }], addedRepos: [], repoOrder: [LISTED] },
  sessions: [
    { ...sess(SID, CWD, KNOWN, KNOWN), team: TID },
    { ...sess(LIVE, CWD, KNOWN, KNOWN), team: TID, openElsewhere: true },
    { ...sess(IDLE, CWD, KNOWN, KNOWN), team: TID },
    sess('bbbbbbbb-2222-4333-8444-555555555555', PLAIN, PLAIN),
    sess('cccccccc-2222-4333-8444-555555555555', DOTLINKED, DOTLINKED),
    sess('dddddddd-2222-4333-8444-555555555555', APPLINKED, APPLINKED),
    sess('eeeeeeee-2222-4333-8444-555555555555', CACHE, CACHE),
    sess('22222222-2222-4333-8444-555555555555', path.join(WT, 'src'), KNOWN, WT),
    sess('33333333-2222-4333-8444-555555555555', HOME, HOME),
    sess('44444444-2222-4333-8444-555555555555', DRIVE, DRIVE),
    ...(DRIVE2 ? [sess('88888888-2222-4333-8444-555555555555', DRIVE2, DRIVE2)] : []),
    sess('55555555-2222-4333-8444-555555555555', INAPP, INAPP),
    sess('66666666-2222-4333-8444-555555555555', DOTREPO, DOTREPO),
    sess('77777777-2222-4333-8444-555555555555', ELSEWHERE, null),
  ],
};
// the files the fence's cases name (the fence resolves links, so they are real)
function makeWorld() {
  const files = [
    [KNOWN, 'src', 'a.ts'], [KNOWN, '.env.local'], [KNOWN, '.env.example'], [KNOWN, '.git', 'config'], [KNOWN, '.github', 'workflows', 'ci.yml'],
    [KNOWN, '.claude', 'settings.json'], [WT, 'src', 'b.ts'], [CWD, 'a.txt'], [HOME, '.ssh', 'id_ed25519'], [HOME, 'notes.txt'],
    [INAPP, 'readme.md'], [DOTREPO, 'notes.md'], [ELSEWHERE, 'a.txt'], [HIDDEN, 'x.txt'], [PLAIN, 'a.txt'],
    [DOTLINKED, 'notes.md'], [APPLINKED, 'a.txt'], [CACHE, 'x.txt'],
    // git checkouts (a worktree's .git is a file): the conversations' repos in them are workspaces, so the rules
    // that refuse the home folder, a home dot-folder and an app data folder are what refuse those
    [WT, '.git'], [HOME, '.git', 'HEAD'], [INAPP, '.git', 'HEAD'], [DOTREPO, '.git', 'HEAD'],
    [DOTLINKED, '.git', 'HEAD'], [APPLINKED, '.git', 'HEAD'], [CACHE, '.git', 'HEAD'],
  ];
  for (const f of files) { const p = path.join(...f); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'x'); }
  fs.mkdirSync(APPDATA, { recursive: true });
  // a home dot-folder and an app data child that are junctions to folders outside both
  try { fs.symlinkSync(DOTLINKED, path.join(HOME, '.linked'), 'junction'); } catch {}
  try { fs.symlinkSync(APPLINKED, path.join(APPDATA, 'Claude.junction-test'), 'junction'); } catch {}
  // a link inside the repo to a folder outside it (a junction needs no admin on Windows)
  try { fs.symlinkSync(ELSEWHERE, path.join(KNOWN, 'link'), 'junction'); } catch {}
  if (FAR) { try { fs.symlinkSync(FAR, path.join(KNOWN, 'far'), 'junction'); } catch {} }
  return fs.existsSync(path.join(KNOWN, 'link', 'a.txt')) && fs.existsSync(path.join(HOME, '.linked', 'notes.md')) && fs.existsSync(path.join(APPDATA, 'Claude.junction-test', 'a.txt'));
}
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 254, 255]);

// ---------- a fake clock and timers (each relay its own timers, one clock) ----------
const clock = { t: Date.UTC(2026, 9, 10, 12, 0, 0) };
function makeTimers() {
  let n = 0;
  const q = new Map();
  return {
    setTimeout(fn, ms) { const id = ++n; q.set(id, { at: clock.t + Math.max(0, Number(ms) || 0), fn }); return id; },
    clearTimeout(id) { q.delete(id); },
    // moves the clock by ms, running each timer that comes due on the way, in time order
    async advance(ms) {
      const end = clock.t + ms;
      for (;;) {
        let id = null, x = null;
        for (const [k, v] of q) if (v.at <= end && (!x || v.at < x.at)) { id = k; x = v; }
        if (!x) break;
        q.delete(id);
        clock.t = Math.max(clock.t, x.at);
        x.fn();
        await settle();
      }
      clock.t = end;
      await settle();
    },
  };
}

// ---------- a fake WebSocket: the test plays Supabase Realtime ----------
const sockets = [];
class FakeWS {
  constructor(url) { this.url = url; this.sent = []; this.closed = null; this.at = clock.t; sockets.push(this); }
  send(text) { if (this.closed) throw new Error('closed'); this.sent.push(JSON.parse(text)); }
  close(code, reason) { this.closed = { code, reason }; }
  open() { if (this.onopen) this.onopen({}); }
  frame(o) { if (this.onmessage) this.onmessage({ data: JSON.stringify(o) }); }
  drop() { this.closed = this.closed || { code: 1006 }; if (this.onclose) this.onclose({ code: 1006 }); }
  frames(event, topic) { return this.sent.filter((f) => f.event === event && (!topic || f.topic === topic)); }
}
const lastSocket = () => sockets[sockets.length - 1];
// Supabase's side of a joined channel and a live socket (the frames answered are remembered apart, not marked)
const answered = new WeakSet();
function acceptJoins(ws, status = 'ok', response = {}) {
  for (const f of ws.sent) {
    if (f.event !== 'phx_join' || answered.has(f)) continue;
    answered.add(f);
    ws.frame({ topic: f.topic, event: 'phx_reply', payload: { status, response }, ref: f.ref, join_ref: f.join_ref });
  }
}
function answerBeats(ws) {
  if (!ws || ws.closed) return;
  for (const f of ws.sent) {
    if (f.event !== 'heartbeat' || answered.has(f)) continue;
    answered.add(f);
    ws.frame({ topic: 'phoenix', event: 'phx_reply', payload: { status: 'ok', response: {} }, ref: f.ref });
  }
}
// time passes for one relay in steps of at most 10 s, its socket's heartbeats answered between them
async function tick(timers, ms, ws = null) {
  while (ms > 0) {
    const step = Math.min(ms, 10e3);
    await timers.advance(step);
    ms -= step;
    answerBeats(ws === null ? lastSocket() : ws);
  }
}

// ---------- a fake S1 and key store ----------
function fakeSync() {
  const listeners = new Set();
  const f = {
    on: true, signedIn: true, token: 'test-access-token-1', email: 'henry@example.com',
    api: {
      enabled: () => f.on,
      uid: async () => (f.signedIn ? UID : null),
      email: async () => (f.signedIn ? f.email : null),
      accessToken: async () => { if (!f.signedIn) throw new Error('signed out'); return f.token; },
      onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    },
    emit: (type) => { for (const fn of [...listeners]) fn({ type, uid: UID, email: f.email }); },
    listeners,
  };
  return f;
}
function memStore() {
  let text = null;
  const s = { kind: 'memory', reads: 0, writes: 0, read: async () => { s.reads++; return text; }, write: async (t) => { s.writes++; text = t; }, clear: async () => { s.writes++; text = null; }, peek: () => text, stamp: () => null };
  return s;
}

// ---------- a phone ----------
// ph.up and ph.down: the key it sends under now (the QR's K until use(K')); it opens what comes down under any key
// it has held (downs), as a phone that just switched may still get an answer under K
function makePhone(link) {
  const j = JSON.parse(Buffer.from(new URL(link).searchParams.get('d'), 'base64url').toString('utf8'));
  const K = Buffer.from(j.k, 'base64url'), topic = `fleet:${j.uid}:${j.dev}`;
  const ph = {
    j, K, dev: j.dev, topic, wire: `realtime:${topic}`, up: R.dirKey(K, 'up'), down: R.dirKey(K, 'down'), downs: [R.dirKey(K, 'down')],
    cur: new WeakMap(), msgs: [], parts: new Map(), chunks: new Map(), bad: 0, n: 0, own: null,
    env: (msg, o) => R.seal(ph.up, topic, j.dev, 'up', msg, o),
    // seal under another key (K, or a K' the phone does not use)
    envUnder: (k, msg, o) => R.seal(R.dirKey(k, 'up'), topic, j.dev, 'up', msg, o),
    use(k) { ph.own = k; ph.up = R.dirKey(k, 'up'); ph.down = R.dirKey(k, 'down'); ph.downs.unshift(ph.down); },
    // the v2 hello under K with a fresh X25519 key -> { r (its answer), k (the K' it makes, or null) }
    async handshake(ws, id, o = {}) {
      const mine = R.xPair();
      ph.inject(ws, ph.envUnder(K, { t: 'hello', id, at: clock.t, app: '1.0.0', device: 'Henry\'s iPhone', epk: o.epk !== undefined ? o.epk : mine.pub.toString('base64url') }));
      const r = await ph.answer(ws, id);
      const pc = r && r.s === 200 && r.b && typeof r.b.epk === 'string' ? Buffer.from(r.b.epk, 'base64url') : null;
      return { r, k: pc ? R.pairedKey(K, mine.priv, pc) : null };
    },
    // an envelope up, as Supabase hands it on
    inject(ws, env) { ws.frame({ topic: ph.wire, event: 'broadcast', payload: { type: 'broadcast', event: 'e', payload: env }, ref: null }); return env; },
    send(ws, msg, o) { return ph.inject(ws, ph.env(msg, o)); },
    // every message down on this socket so far, opened, parts joined (each part's chunk kept in chunks)
    read(ws) {
      let i = ph.cur.get(ws) || 0;
      for (; i < ws.sent.length; i++) {
        const f = ws.sent[i];
        if (f.topic !== ph.wire || f.event !== 'broadcast' || !f.payload || f.payload.event !== 'e') continue;
        let text = null;
        for (const k of ph.downs) { text = R.open(k, topic, j.dev, 'down', f.payload.payload); if (text !== null) break; }
        if (text === null) { ph.bad++; continue; }
        const m = JSON.parse(text);
        if (m.t !== 'part') { ph.msgs.push(m); continue; }
        let a = ph.parts.get(m.id);
        if (!a) ph.parts.set(m.id, (a = { n: m.parts, got: new Map() }));
        a.got.set(m.part, m.chunk);
        if (a.got.size === a.n) {
          ph.parts.delete(m.id);
          const list = [...Array(a.n).keys()].map((k) => a.got.get(k));
          ph.chunks.set(m.id, list);
          ph.msgs.push(JSON.parse(list.join('')));
        }
      }
      ph.cur.set(ws, i);
      return ph.msgs;
    },
    answers: (ws, id) => ph.read(ws).filter((m) => m.t === 'res' && m.id === id),
    async answer(ws, id, ms = 5000) { return waitUntil(() => ph.answers(ws, id)[0], ms); },
    // one request; -> its answer, or null
    async ask(ws, m, p, more = {}, ms = 5000) {
      const id = more.id || `r${++ph.n}`;
      const { id: _, ...fields } = more;
      ph.send(ws, { t: 'req', id, at: clock.t, m, p, ...fields });
      return ph.answer(ws, id, ms);
    },
    // a message as parts of at most max characters, in the order given; pace(n) runs after every 20 parts (a phone
    // sends at most 20 a second: every part counts against the relay's 30 envelopes a second)
    async sendParts(ws, msg, order, max = R.PART_MAX, pace = null) {
      const list = R.slices(JSON.stringify(msg), max), at = clock.t;
      let n = 0;
      for (const i of order || list.keys()) {
        ph.send(ws, { t: 'part', id: msg.id, at, part: i, parts: list.length, chunk: list[i] });
        if (++n % 20 === 0 && pace) await pace(n);
      }
      return list.length;
    },
  };
  return ph;
}

// ---------- the fake Fleet View ----------
const seen = [];
let renames = 0;
const held = new Map(); // path -> [res]
const holdPaths = new Set();
const BIG = '\u{1F680}'.repeat(450000); // 900,000 UTF-16 units of surrogate pairs: some cut must land inside one
let hugeCalls = 0;
const fv = http.createServer((req, res) => {
  const parts = [];
  req.on('data', (b) => parts.push(b));
  req.on('end', () => {
    const u = new URL(req.url, 'http://x'), text = Buffer.concat(parts).toString('utf8');
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    seen.push({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: req.headers, body });
    const json = (code, o, h = {}) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...h }); res.end(JSON.stringify(o)); };
    const p = u.pathname;
    if (holdPaths.has(p)) { if (!held.has(p)) held.set(p, []); held.get(p).push(res); return; }
    if (p === '/state') {
      const tag = '"state-1"';
      if (req.headers['if-none-match'] === tag) { res.writeHead(304, { ETag: tag }); return res.end(); }
      return json(200, STATE, { ETag: tag });
    }
    if (p === '/conversation/image') { res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': PNG.length }); return res.end(PNG); }
    if (p === '/since') { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('plain text ☕'); }
    if (p === '/rename') { renames++; return json(200, { ok: true, n: renames }); }
    if (p === '/accounts' && req.method === 'GET') return ACCTS_VIEW.fail ? json(500, { ok: false }) : json(200, ACCTS_VIEW.v);
    if (p === '/api/conversations') return json(200, { ok: true, big: BIG });
    if (p === '/api/teams' && req.method === 'GET') { hugeCalls++; return json(200, { ok: true, huge: 'x'.repeat(64 * R.PART_MAX) }); }
    // a folder as files.js lists it, and the "@" file list, each with names the phone may not see
    if (p === '/file' && u.searchParams.get('path') === KNOWN) return json(200, { ok: true, dir: true, path: KNOWN, entries: LISTING, total: LISTING.length + 5 });
    if (p === '/chat/files') return json(200, { files: AT_FILES });
    const leak = p === '/file' && LEAKS[path.basename(u.searchParams.get('path') || '')];
    if (leak) return json(200, { ok: true, path: u.searchParams.get('path'), size: leak.length, lines: 3, text: leak, lang: 'text' });
    // an answer that sends 1 MB and waits (trickle.done ends it)
    if (p === `/api/sessions/${SID}/transcript` && u.searchParams.get('trickle')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write(`{"ok":true,"pad":"${'p'.repeat(1 << 20)}`);
      trickle.push(res);
      return;
    }
    return json(200, { ok: true, path: p });
  });
});
// GET /accounts as accounts.js view() answers it (ACCTS_VIEW.v; fail: the server says 500)
const ACCTS_VIEW = { fail: false, v: null };
const LISTING = ['.claude/', '.git/', '.github/', 'src/', '.env', '.env.local', 'id_rsa', 'README.md', 'server.pem', 'firebase-adminsdk-1.json', 'aws-credentials'];
// file text that holds a key whatever its name (written in pieces: nothing here looks like a real key to the share
// repo's guard), and one that only talks about one
const LEAKS = {
  'leak-pem.txt': `notes\n-----BEGIN ${'OPENSSH PRIVATE'} KEY-----\nAAAA\n`, 'leak-ec.txt': `-----BEGIN ${'EC PRIVATE'} KEY-----\nAAAA\n`,
  'leak-sa.txt': `{\n  "type" :  "service${'_'}account",\n  "project_id": "x"\n}`, 'leak-pk.txt': `{"private${'_'}key"\t: "x"}`,
  'talk.txt': 'the JSON has a field called "private_key" in it',
};
const AT_FILES = [{ path: 'src/a.ts', dir: false }, { path: '.env', dir: false }, { path: 'config/.env.local', dir: false }, { path: '.github/ci.yml', dir: false },
  { path: 'keys/server.key', dir: false }, { path: 'android/app/google-services.json', dir: false }, { path: 'src', dir: true }];
const trickle = [];
trickle.done = () => { for (const res of trickle.splice(0)) { try { res.end('"}'); } catch {} } };
// a held request answered now: body (an object) as JSON, else { ok, late }
const release = (p, body) => { for (const res of held.get(p) || []) { try { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(body ? JSON.stringify(body) : '{"ok":true,"late":true}'); } catch {} } held.delete(p); };
const seenFor = (p) => seen.filter((r) => r.path === p);

function relayOpts(o) {
  return {
    dataDir: o.dataDir, logDir: o.logDir || o.dataDir, sync: o.sync.api, apiToken: () => API_TOKEN, version: '1.0.99', pcName: 'TEST-PC',
    relayKey: 'relayKey' in o ? o.relayKey : () => RELAY_KEY,
    log: (t) => (o.logs || []).push(t), now: () => clock.t, WebSocketImpl: FakeWS, timers: o.timers, keyStore: o.keyStore,
    readConfig: () => { o.configReads = (o.configReads || 0) + 1; return { config: { url: SB_URL, key: SB_KEY } }; },
    port: o.port, startLimits: o.startLimits, lanHosts: o.lanHosts, lanPort: o.lanPort, lanLimits: o.lanLimits,
  };
}
// ---------- a WebSocket client on a real socket (the phone in local mode), written here so the test can also send
// what a real client never would: unmasked frames, an oversized header, garbage ----------
// a client frame (masked unless o.unmasked; o.len: the length the header claims, whatever the payload)
function clientFrame(op, payload, o = {}) {
  const len = o.len !== undefined ? o.len : payload.length;
  let head;
  if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
  else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[1] = 127; head.writeUInt32BE(Math.floor(len / 2 ** 32), 2); head.writeUInt32BE(len >>> 0, 6); }
  head[0] = 0x80 | op;
  if (o.unmasked) return Buffer.concat([head, payload]);
  head[1] |= 0x80;
  const mask = crypto.randomBytes(4), data = Buffer.from(payload);
  for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
  return Buffer.concat([head, mask, data]);
}
// -> Promise of { status (the HTTP status, or 0: the socket closed with no answer), head (the answer's text), msgs
// (JSON text frames), closeCode, ended, send(obj), raw(buf), close() }
function wsConnect(port, p, headers = {}) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    const c = { status: 0, head: '', msgs: [], closeCode: null, ended: false, pings: 0, sock: s };
    let buf = Buffer.alloc(0), done = false;
    const finish = () => { if (!done) { done = true; resolve(c); } };
    c.send = (o) => { try { s.write(clientFrame(0x1, Buffer.from(JSON.stringify(o)))); } catch {} };
    c.raw = (b) => { try { s.write(b); } catch {} };
    c.close = () => { try { s.destroy(); } catch {} };
    s.on('error', () => {});
    s.on('close', () => { c.ended = true; finish(); });
    s.on('connect', () => {
      const h = { Host: `127.0.0.1:${port}`, Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13', ...headers };
      s.write(`GET ${p} HTTP/1.1\r\n${Object.entries(h).filter(([, v]) => v !== null).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
    });
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!c.status) {
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        c.head = buf.subarray(0, i).toString('latin1');
        c.status = Number((/^HTTP\/1\.1 (\d{3})/.exec(c.head) || [])[1]) || -1;
        buf = buf.subarray(i + 4);
        finish();
      }
      // the server's frames (never masked)
      for (;;) {
        if (buf.length < 2) break;
        let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { if (buf.length < 10) break; len = buf.readUInt32BE(6); off = 10; }
        if (buf.length < off + len) break;
        const op = buf[0] & 0x0f, data = buf.subarray(off, off + len);
        buf = buf.subarray(off + len);
        if (op === 0x1) { try { c.msgs.push(JSON.parse(data.toString('utf8'))); } catch {} } else if (op === 0x8) c.closeCode = data.length >= 2 ? data.readUInt16BE(0) : 1005;
        else if (op === 0x9) { c.pings++; c.raw(clientFrame(0xA, Buffer.from(data))); }
      }
    });
  });
}
// the phone in local mode, on such a socket: the topic is fleet:local:<dev>
function makeLanPhone(link) {
  const j = JSON.parse(Buffer.from(new URL(link).searchParams.get('d'), 'base64url').toString('utf8'));
  const K = Buffer.from(j.k, 'base64url'), topic = `fleet:local:${j.dev}`;
  const ph = {
    j, K, dev: j.dev, topic, key: K, n: 0,
    env: (msg, k = ph.key, t = topic) => R.seal(R.dirKey(k, 'up'), t, j.dev, 'up', msg),
    // every message that came down c and opens under k (parts are not used here)
    read: (c, k = ph.key) => c.msgs.map((e) => R.open(R.dirKey(k, 'down'), topic, j.dev, 'down', e)).filter((x) => x !== null).map((x) => JSON.parse(x)),
    answer: (c, id, k = ph.key, ms = 5000) => waitUntil(() => ph.read(c, k).find((m) => m.t === 'res' && m.id === id), ms),
    connect: (port, headers) => wsConnect(port, `/fleet/${j.dev}`, headers),
    async handshake(c, id) {
      const mine = R.xPair();
      c.send(ph.env({ t: 'hello', id, at: clock.t, app: '1.0.0', device: 'Wi-Fi iPhone', epk: mine.pub.toString('base64url') }, K));
      const r = await ph.answer(c, id, K);
      return { r, k: r && r.s === 200 && r.b.epk ? R.pairedKey(K, mine.priv, Buffer.from(r.b.epk, 'base64url')) : null };
    },
    async ask(c, m, p, more = {}) {
      const id = more.id || `l${++ph.n}`;
      c.send(ph.env({ t: 'req', id, at: clock.t, m, p, ...more, id }));
      return ph.answer(c, id);
    },
  };
  return ph;
}
const freePort = () => new Promise((rs) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => rs(p)); }); });
const httpGet = (port, p, headers = {}) => new Promise((resolve) => {
  const rq = http.request({ host: '127.0.0.1', port, path: p, headers }, (rs) => { const parts = []; rs.on('data', (b) => parts.push(b)); rs.on('end', () => resolve({ status: rs.statusCode, headers: rs.headers, text: Buffer.concat(parts).toString('utf8') })); });
  rq.on('error', (e) => resolve({ status: 0, error: e.code }));
  rq.end();
});

// the fence's environment: the fake home and app data folders, for this process only
function fakeEnv() {
  for (const k of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME']) delete process.env[k];
  Object.assign(process.env, { USERPROFILE: HOME, HOME, APPDATA, LOCALAPPDATA, PROGRAMDATA: path.join(T, 'programdata') });
}

async function main() {
  // ---------- the crypto against docs/phone-vectors.json ----------
  const K = Buffer.from(V.K, 'base64url');
  const key = { up: R.dirKey(K, 'up'), down: R.dirKey(K, 'down') };
  eq(key.up.toString('hex'), V.keys.up, 'K_up');
  eq(key.down.toString('hex'), V.keys.down, 'K_down');
  eq(R.topicOf(V.uid, V.dev), V.topic, 'the topic');
  eq(R.aadText(V.topic, V.dev, 'up', 0), V.aad.up0, 'the AAD up, z=0');
  eq(R.aadText(V.topic, V.dev, 'down', 0), V.aad.down0, 'the AAD down, z=0');
  eq(R.aadText(V.topic, V.dev, 'down', 1), V.aad.down1, 'the AAD down, z=1');
  for (const v of V.open) eq(R.open(key[v.envelope.dir], V.topic, V.dev, v.envelope.dir, v.envelope), v.plaintext, `opens "${v.name}"`);
  for (const v of V.refuse) eq(R.open(key[v.envelope.dir], V.topic, V.dev, v.envelope.dir, v.envelope), null, `refuses "${v.name}"`);
  for (const v of V.open.filter((x) => x.envelope.z === 0)) {
    eq(R.seal(key[v.envelope.dir], V.topic, V.dev, v.envelope.dir, v.plaintext, { nonce: Buffer.from(v.envelope.n, 'base64url') }), v.envelope, `seals "${v.name}" to the exact envelope`);
  }
  const bigText = V.open[2].plaintext;
  const own = R.seal(key.down, V.topic, V.dev, 'down', bigText);
  ok(own.z === 1 && bigText.length > 1024, 'JSON over 1024 bytes goes compressed (z=1)');
  eq(R.open(key.down, V.topic, V.dev, 'down', own), bigText, 'its own z=1 envelope opens to the same text');
  ok(R.seal(key.down, V.topic, V.dev, 'down', '{"t":"res"}').z === 0, 'a short one goes as it is (z=0)');
  ok(R.seal(key.up, V.topic, V.dev, 'up', 'x').n !== R.seal(key.up, V.topic, V.dev, 'up', 'x').n, 'a fresh nonce every time');
  const up0 = V.open[0].envelope;
  eq(R.open(key.up, V.topic, V.dev, 'up', { ...up0, n: `${up0.n}=` }), null, 'padded base64 is refused');
  eq(R.open(key.up, V.topic, V.dev, 'up', { ...up0, d: 'AAAAAAAAAAAAAAAA' }), null, 'another device id is refused');
  eq(R.open(key.up, V.topic, V.dev, 'up', { ...up0, v: 2 }), null, 'another version is refused');
  eq(R.open(key.up, V.topic, V.dev, 'up', { ...up0, z: 1 }), null, 'z changed (it is in the AAD) is refused');
  eq(R.pairLink(V.pairing.json), V.pairing.link, 'the pairing link');
  ok(V.pairing.json.v === 2 && R.LINK_V === 2, 'the pairing link is v 2');
  // the v2 handshake: both sides' X25519 keys from fixed private bytes, the shared secret, K' and its keys
  const PV = V.paired, xs = (hex) => R.xPair(Buffer.from(hex, 'hex'));
  const phX = xs(PV.phone.sk), pcX = xs(PV.pc.sk);
  eq([phX.pub.toString('base64url'), pcX.pub.toString('base64url')], [PV.phone.pk, PV.pc.pk], 'the X25519 public keys');
  const K2a = R.pairedKey(K, phX.priv, pcX.pub), K2b = R.pairedKey(K, pcX.priv, phX.pub);
  eq([K2a && K2a.toString('base64url'), K2b && K2b.toString('base64url')], [PV.K, PV.K], 'K\' from either side');
  eq(PV.info, R.PAIRED_INFO, 'the HKDF info');
  const key2 = { up: R.dirKey(K2a, 'up'), down: R.dirKey(K2a, 'down') };
  eq([key2.up.toString('hex'), key2.down.toString('hex')], [PV.keys.up, PV.keys.down], 'K\'_up and K\'_down');
  for (const v of PV.open) {
    const kk = v.key === 'K' ? key : key2;
    eq(R.open(kk[v.envelope.dir], V.topic, V.dev, v.envelope.dir, v.envelope), v.plaintext, `opens "${v.name}"`);
    eq(R.seal(kk[v.envelope.dir], V.topic, V.dev, v.envelope.dir, v.plaintext, { nonce: Buffer.from(v.envelope.n, 'base64url'), z: 0 }), v.envelope, `seals "${v.name}" to the exact envelope`);
    if (v.key === 'paired') eq(R.open(key[v.envelope.dir], V.topic, V.dev, v.envelope.dir, v.envelope), null, `"${v.name}" does not open under K`);
  }
  eq(R.pairedKey(K, phX.priv, Buffer.alloc(32)), null, 'an all-zero public key (a zero shared secret) makes no K\'');
  eq(R.pairedKey(K, phX.priv, Buffer.alloc(31, 9)), null, 'a 31-byte public key makes no K\'');
  const pv = cp.spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'phone-vectors.js'), '--check'], { encoding: 'utf8', windowsHide: true, env: ENV0 });
  ok(pv.status === 0 && /is current/.test(pv.stdout), `node scripts/phone-vectors.js --check: ${pv.stdout}${pv.stderr}`);

  // ---------- the allowlist and slices ----------
  const allowed = [
    ['GET', '/state'], ['GET', '/conversation'], ['GET', '/conversation/image'], ['GET', '/repo-history'], ['GET', '/chat/commands'],
    ['GET', '/chat/files'], ['GET', '/chat/kind'], ['GET', '/file'], ['GET', '/since'], ['GET', '/api/sessions'], ['GET', `/api/sessions/${SID}`],
    ['GET', '/api/sessions/new-12'], ['GET', `/api/sessions/${SID}/menu`], ['GET', `/api/sessions/${SID}/transcript`], ['GET', '/api/conversations'],
    ['GET', '/api/teams'], ['GET', '/api/status'], ['POST', '/api/sessions'], ...['message', 'answer', 'interrupt', 'open', 'stop', 'remove'].map((v) => ['POST', `/api/sessions/${SID}/${v}`]),
    ['POST', '/api/teams'], ...['add', 'remove', 'lead', 'disband', 'message'].map((v) => ['POST', `/api/teams/t0a1b2c3d/${v}`]), ['POST', '/settings'],
    ['POST', '/rename'], ['POST', '/sessions/move'], ['POST', '/push-target'], ['POST', '/repos/remove'], ['POST', '/repos/add'], ['POST', '/chat/image'],
    ['POST', '/teams'], ['POST', '/teams/add'], ['POST', '/teams/remove'], ['POST', '/teams/leave'], ['POST', '/teams/lead'], ['POST', '/teams/rename'],
    ['GET', '/chief/briefing'], ['POST', '/api/chief/start'], ['POST', '/api/bots'], ['POST', `/api/bots/${BOT}`], ['POST', '/api/bots/0123456789ab'],
    ['POST', `/api/bots/${BOT}/start`], ['POST', `/api/bots/${BOT}/remove`],
    // a dynamic bot's switch, and its tasks' actions (page routes)
    ['POST', `/bots/${BOT}/switch`], ['POST', `/bots/${BOT}/tasks/t-deploys`], ['POST', `/bots/${BOT}/tasks/a.b_c-1`], ['POST', `/bots/${BOT}/tasks/T${'x'.repeat(63)}`],
    // the chat's verbs
    ['GET', `/api/sessions/${SID}/activity`], ['GET', '/api/sessions/new-3/activity'], ...['now', 'unsend', 'model'].map((v) => ['POST', `/api/sessions/${SID}/${v}`]),
    // the Claude accounts screen
    ['GET', '/accounts'], ['POST', '/accounts/add'], ['POST', '/accounts/login'], ['POST', '/accounts/code'], ['POST', '/accounts/cancel'],
    // Continue here asked of a machine that is on, for a chat whose host is off (the phone with several machines)
    ['GET', '/sync/move'], ['POST', '/sync/move'],
  ];
  for (const [m, p] of allowed) ok(R.routeAllowed(m, p), `allowed: ${m} ${p}`);
  const refused = [
    ['GET', '/reveal'], ['POST', '/reveal'], ['POST', '/open'], ['GET', '/update'], ['POST', '/update/apply'], ['GET', '/sync/status'], ['POST', '/sync/signout'],
    ['GET', '/remote/me'], ['POST', '/remote/approve'], ['GET', '/preview/x'], ['POST', '/housekeeping/clean'], ['GET', '/folders'],
    ['POST', '/upload'], ['GET', '/relay/status'], ['POST', '/relay/pair'], ['POST', '/api/ask'], ['GET', '/api/ask/a0123456789'], ['GET', '/api'],
    ['POST', `/api/sessions/${SID}/wait`], ['GET', `/api/sessions/${SID}/message`], ['POST', '/state'], ['GET', '/settings'], ['POST', '/teams/evil'],
    ['POST', '/repos/scratch'], ['GET', '/timeline'], ['POST', '/usage/ack'], ['GET', '/'], ['GET', '/index.html'], ['PUT', '/state'], ['DELETE', '/state'],
    ['GET', '/state/'], ['GET', '/api/sessions/not-an-id'], ['GET', '/api/sessions/NEW-1x'], ['POST', '/api/teams/T0A1B2C3D/message'], ['POST', '/api/teams/t01/add'],
    ['GET', '/../state'], ['GET', '/state/..'], ['GET', '//state'], ['GET', '/api//sessions'], ['GET', '/st%61te'], ['GET', '/state?x=1'], ['GET', '/state#x'],
    ['GET', '/api\\sessions'], ['GET', `/api/sessions/${SID}/../../reveal`], ['GET', 'state'], ['GET', ''], ['GET', '/state\n'], ['GET', null],
    // near misses of the Chief's and the bots' routes
    ['POST', '/chief/briefing'], ['GET', '/chief/briefing/'], ['GET', '/chief'], ['GET', '/chief/briefing.json'], ['GET', '/api/chief/briefing'],
    ['GET', '/api/chief/start'], ['POST', '/api/chief'], ['POST', '/api/chief/start/'], ['POST', '/api/chief/stop'], ['POST', '/chief/start'],
    ['GET', '/api/bots'], ['GET', `/api/bots/${BOT}`], ['POST', '/api/bots/'], ['POST', `/api/bots/${BOT}/`], ['POST', `/api/bots/${BOT}/stop`],
    ['POST', `/api/bots/${BOT}/message`], ['POST', `/api/bots/${BOT}/start/x`], ['POST', '/api/bots/b1'], ['POST', '/api/bots/Bot_one-2'],
    ['POST', '/api/bots/A1B2C3D4E5F6'], ['POST', '/api/bots/a1b2c3d4e5f'], ['POST', '/api/bots/a1b2c3d4e5f67'], ['POST', '/api/bots/a1b2c3d4e5fg'],
    ['POST', '/api/bots//start'], ['POST', '/api/bots/a1b2c3d4e5f%36'], ['POST', '/api/bots/b 1'], ['POST', `/api/bots/${BOT}/../../sessions`], ['POST', `/api/bot/${BOT}`],
    ['GET', `/api/bots/${BOT}/start`], ['POST', `/api/bots/${BOT}/start?x=1`], ['POST', '/api/bots/b1/start'], ['POST', '/api/bots/b1/remove'],
    // near misses of a bot's switch and its tasks: the page's other bot routes stay its own
    ['POST', '/bots'], ['POST', `/bots/${BOT}`], ['POST', `/bots/${BOT}/start`], ['POST', `/bots/${BOT}/remove`], ['GET', `/bots/${BOT}/switch`],
    ['POST', '/bots/b1/switch'], ['POST', `/bots/${BOT}/switch/`], ['GET', `/bots/${BOT}/tasks`], ['POST', `/bots/${BOT}/tasks`], ['POST', `/bots/${BOT}/tasks/`],
    ['GET', `/bots/${BOT}/tasks/t1`], ['POST', `/bots/${BOT}/tasks/-t1`], ['POST', `/bots/${BOT}/tasks/.t1`], ['POST', `/bots/${BOT}/tasks/t..1`],
    ['POST', `/bots/${BOT}/tasks/t1/run`], ['POST', `/bots/${BOT}/tasks/t 1`], ['POST', `/bots/${BOT}/tasks/t%31`], ['POST', `/bots/${BOT}/tasks/T${'x'.repeat(64)}`],
    ['POST', `/api/bots/${BOT}/tasks/t1`], ['POST', `/api/bots/${BOT}/switch`], ['POST', '/api/bots/look'], ['POST', '/bots/look'],
    // near misses of the chat's verbs
    ['POST', `/api/sessions/${SID}/activity`], ['GET', `/api/sessions/${SID}/now`], ['GET', `/api/sessions/${SID}/model`], ['GET', `/api/sessions/${SID}/unsend`],
    ['POST', `/api/sessions/${SID}/now/x`], ['POST', `/api/sessions/${SID}/models`], ['GET', '/api/sessions/activity'], ['POST', '/api/sessions/now'],
    // near misses of the Claude accounts screen: never remove, relabel or anything else under /accounts
    ['POST', '/accounts/remove'], ['POST', '/accounts/relabel'], ['POST', '/accounts/switch'], ['POST', '/accounts'], ['GET', '/accounts/'],
    ['GET', '/accounts/add'], ['GET', '/accounts/code'], ['POST', '/accounts/add/'], ['POST', '/accounts/Add'], ['POST', '/accounts/add/A'],
    ['POST', '/accounts/../accounts/add'], ['POST', '/accounts//add'], ['POST', '/accounts/%61dd'], ['POST', '/accounts/add?letter=A'], ['GET', '/accounts?x=1'],
    ['POST', '/api/accounts/add'], ['GET', '/api/accounts'], ['POST', '/sync/accounts/check'], ['POST', '/accounts/login/remove'],
    // near misses of a move: nothing else under /sync
    ['POST', '/sync/move/'], ['GET', '/sync/moves'], ['POST', '/sync/move/cancel'], ['DELETE', '/sync/move'], ['POST', '/sync/activity'], ['GET', '/sync/activity'],
    ['POST', '/sync/connect'], ['POST', '/sync/Move'],
  ];
  eq(R.SIGNIN_LETTERS, require(path.join(ROOT, 'sync-accounts.js')).SYNC_LETTERS, 'the phone signs in exactly the letters sync knows (A and B)');
  for (const [m, p] of refused) ok(!R.routeAllowed(m, p), `refused: ${m} ${JSON.stringify(p)}`);
  // the marked routes (api.js viaOf reads the marker on exactly these) and the route timeouts
  const marked = ['/api/sessions', `/api/sessions/${SID}/message`, `/api/sessions/${SID}/answer`, `/api/sessions/${SID}/open`, '/api/sessions/new-3/message', '/api/teams/t0a1b2c3d/message',
    '/api/bots', `/api/bots/${BOT}`, `/api/bots/${BOT}/remove`, `/api/sessions/${SID}/model`];
  const unmarked = [`/api/sessions/${SID}/interrupt`, `/api/sessions/${SID}/stop`, `/api/sessions/${SID}/remove`, '/api/teams', '/api/teams/t0a1b2c3d/add',
    '/api/chief/start', `/api/bots/${BOT}/start`, '/api/bots/b1', '/settings', '/rename', '/teams', `/api/sessions/${SID}`, `/api/sessions/${SID}/message/`,
    `/api/sessions/${SID}/now`, `/api/sessions/${SID}/unsend`, `/api/sessions/${SID}/activity`, `/bots/${BOT}/switch`, `/bots/${BOT}/tasks/t1`];
  for (const p of marked) ok(R.MARKED.test(p), `marked: ${p}`);
  for (const p of unmarked) ok(!R.MARKED.test(p), `not marked: ${p}`);
  eq(R.TIMES, { ROUTE_MS: 30e3, WAIT_ROUTE_MS: 60e3, WAIT_CAP_S: 50, START_ROUTE_MS: 95e3, RESUME_ROUTE_MS: 75e3, ACTIVITY_MS: 5e3, NOW_MS: 10e3, MODEL_MS: 20e3 }, 'the timeouts');
  const times = [
    ['POST', '/api/sessions', 0, 95e3], ['POST', '/api/sessions', 50, 145e3], ['POST', '/api/chief/start', 0, 95e3], ['POST', `/api/bots/${BOT}/start`, 0, 95e3],
    ['POST', '/api/bots', 0, 95e3], ['POST', `/api/bots/${BOT}`, 0, 30e3],
    ['GET', `/api/sessions/${SID}/activity`, 0, 5e3], ['POST', `/api/sessions/${SID}/now`, 0, 10e3], ['POST', `/api/sessions/${SID}/model`, 0, 20e3],
    ['POST', `/api/sessions/${SID}/unsend`, 0, 30e3], ['GET', `/api/sessions/${SID}/transcript`, 0, 30e3],
    ['POST', `/api/sessions/${SID}/message`, 0, 75e3], ['POST', `/api/sessions/${SID}/message`, 10, 85e3], ['POST', `/api/sessions/${SID}/open`, 50, 125e3],
    ['POST', '/api/teams', 0, 75e3], ['POST', '/api/teams/t0a1b2c3d/add', 0, 75e3], ['POST', '/api/teams/t0a1b2c3d/lead', 0, 75e3],
    ['POST', '/api/teams/t0a1b2c3d/message', 0, 75e3], ['POST', '/teams', 0, 75e3], ['POST', '/teams/add', 0, 75e3], ['POST', '/teams/lead', 0, 75e3],
    ['POST', `/api/sessions/${SID}/answer`, 0, 30e3], ['POST', `/api/sessions/${SID}/answer`, 50, 60e3], ['POST', `/api/sessions/${SID}/stop`, 0, 30e3],
    ['POST', '/api/teams/t0a1b2c3d/remove', 0, 30e3], ['POST', '/teams/remove', 0, 30e3], ['POST', `/api/bots/${BOT}/remove`, 0, 30e3],
    ['GET', '/api/sessions', 0, 30e3], ['GET', '/chief/briefing', 0, 30e3], ['POST', '/rename', 0, 30e3],
    ['POST', `/bots/${BOT}/switch`, 0, 20e3], ['POST', `/bots/${BOT}/tasks/t1`, 0, 95e3],
  ];
  for (const [m, p, w, want] of times) eq(R.routeTimeout(m, p, w), want, `the timeout of ${m} ${p}${w ? ` with wait ${w}` : ''}`);
  // the start limits' weights: one each, a team one per (distinct) member, a lead only when there is one
  const weights = [
    ['POST', '/api/sessions', {}, 1], ['POST', `/api/sessions/${SID}/open`, {}, 1], ['POST', '/api/chief/start', {}, 1], ['POST', '/api/bots', {}, 1],
    ['POST', `/api/bots/${BOT}/start`, {}, 1], ['POST', '/api/teams/t0a1b2c3d/add', { member: SID }, 1], ['POST', '/teams/add', { member: SID }, 1],
    ['POST', '/api/teams', { members: ['a', 'b', 'c', 'a'] }, 3], ['POST', '/teams', { members: [] }, 1], ['POST', '/api/teams', { members: Array.from({ length: 30 }, (_, i) => `m${i}`) }, 12],
    ['POST', '/api/teams/t0a1b2c3d/lead', { member: SID }, 1], ['POST', '/teams/lead', { member: null }, 0], ['POST', `/api/sessions/${SID}/message`, {}, 0],
    ['POST', '/api/teams/t0a1b2c3d/message', {}, 0], ['POST', `/api/bots/${BOT}`, {}, 0], ['GET', '/api/sessions', {}, 0], ['POST', '/rename', {}, 0],
    ['POST', `/api/sessions/${SID}/now`, {}, 0], ['POST', `/api/sessions/${SID}/model`, {}, 0], ['POST', `/api/sessions/${SID}/unsend`, {}, 0],
    // a task's Run now starts its bot when it is not running; its other actions and a switch start nothing
    ['POST', `/bots/${BOT}/tasks/t1`, { action: 'run' }, 1], ['POST', `/bots/${BOT}/tasks/t1`, { action: 'pause' }, 0], ['POST', `/bots/${BOT}/tasks/t1`, {}, 0],
    ['POST', `/bots/${BOT}/switch`, { id: SID, model: 'sonnet' }, 0],
  ];
  for (const [m, p, b, w] of weights) eq(R.startWeight(m, p, b), w, `the start weight of ${m} ${p} ${JSON.stringify(b)}`);
  // a message weighs what it may resume: what /state says is not running (openElsewhere), when it opens one
  const plW = { live: new Map([[SID, false], [LIVE, true], [IDLE, false]]), teams: new Map([[TID, [SID, LIVE, IDLE]]]) };
  const resumes = [
    [`/api/sessions/${SID}/message`, { open: true }, 1], [`/api/sessions/${LIVE}/message`, { open: true }, 0], [`/api/sessions/${SID}/message`, {}, 0],
    [`/api/sessions/${SID}/message`, { from: LIVE }, 1], [`/api/sessions/${SID}/message`, { from: LIVE, open: false }, 0], ['/api/sessions/new-3/message', { open: true }, 0],
    [`/api/sessions/${SID.toUpperCase()}/message`, { open: true }, 1], ['/api/sessions/12345678-2222-4333-8444-555555555555/message', { open: true }, 1],
    [`/api/teams/${TID}/message`, {}, 2], [`/api/teams/${TID}/message`, { from: SID }, 1], ['/api/teams/tabcdef/message', {}, 1],
    [`/api/sessions/${SID}/open`, {}, 0], ['/api/sessions', {}, 0],
  ];
  for (const [p, b, w] of resumes) eq(R.resumeWeight(plW, 'POST', p, b), w, `the resume weight of POST ${p} ${JSON.stringify(b)}`);
  eq(R.resumeWeight(null, 'POST', `/api/sessions/${LIVE}/message`, { open: true }), 1, 'with no /state, a message that opens one weighs 1');
  const sl = R.slices('a\u{1F680}\u{1F680}b', 2);
  eq(sl, ['a', '\u{1F680}', '\u{1F680}', 'b'], 'slices never cut a surrogate pair');
  eq(R.slices('abcdef', 4), ['abcd', 'ef'], 'slices of at most max');
  const svg = R.qrSvg(V.pairing.link);
  ok(/^<svg [^>]*viewBox="0 0 (\d+) \1"/.test(svg) && svg.includes('<path') && svg.endsWith('</svg>'), 'the QR code is an SVG with a square viewBox');
  ok(!svg.includes('fleetview:'), 'the SVG holds the code, not the link as text');

  // ---------- off: sync not set up, or not signed in ----------
  const offSync = fakeSync();
  offSync.on = false;
  const offKeys = memStore(), offTimers = makeTimers();
  const off = R.createRelay(relayOpts({ dataDir: path.join(T, 'off'), sync: offSync, keyStore: offKeys, timers: offTimers, port: 9 }));
  const socketsBefore = sockets.length;
  off.start();
  await settle();
  let [code, out] = await off.pair('x');
  ok(code === 409 && /set it up/.test(out.message), `pair with sync not set up: 409 (${code} ${out.message})`);
  offSync.on = true; offSync.signedIn = false;
  [code, out] = await off.pair('x');
  ok(code === 409 && /sign in/.test(out.message), `pair while signed out: 409 (${code} ${out.message})`);
  const offStatus = await off.status();
  eq([offStatus.enabled, offStatus.signedIn, offStatus.connected, offStatus.devices.length], [true, false, false, 0], 'status while signed out');
  ok(sockets.length === socketsBefore && offKeys.reads === 0 && offKeys.writes === 0, 'off: no socket opened and no key read or written');
  await off.stop();

  // ---------- the relay ----------
  fakeEnv();
  const linked = makeWorld();
  ok(os.homedir() === HOME, `the home folder is the fake one (${os.homedir()})`);
  await new Promise((r) => fv.listen(0, '127.0.0.1', r));
  const port = fv.address().port, ORIGIN = `http://127.0.0.1:${port}`;
  // the start limits are lifted until their own test below (the tests before it start many)
  const A = { dataDir: path.join(T, 'data'), logDir: path.join(T, 'logs'), sync: fakeSync(), keyStore: memStore(), timers: makeTimers(), logs: [], port, startLimits: { atOnce: 1000, max: 1000 } };
  const optsA = relayOpts(A);
  const relay = R.createRelay(optsA);
  const startedAt = clock.t;
  relay.start();
  await settle();
  ok(sockets.length === socketsBefore && A.keyStore.reads === 0, 'signed in but nothing paired: no socket, no key read');
  ok(A.sync.listeners.size === 1, 'it listens to S1');

  [code, out] = await relay.pair('Test iPhone');
  ok(code === 200 && out.ok && /^[A-Za-z0-9_-]{16}$/.test(out.id) && out.exp === clock.t + 10 * 60e3, `pair: ${code} ${out.message || ''}`);
  ok(out.link.startsWith('fleetview://pair?d=') && out.svg.startsWith('<svg'), 'pair gives the link and its QR code');
  const ph = makePhone(out.link);
  eq({ ...ph.j, dev: '-', k: '-' }, { v: 2, url: SB_URL, key: SB_KEY, uid: UID, email: 'henry@example.com', pcName: 'TEST-PC', dev: '-', k: '-', exp: out.exp }, 'the link\'s JSON');
  ok(ph.dev === out.id && ph.K.length === 32, 'the link carries the device id and 32 key bytes');
  const devicesFile = path.join(A.dataDir, 'relay', 'devices.json');
  let devs = JSON.parse(fs.readFileSync(devicesFile, 'utf8')).devices;
  eq(devs.map((d) => [d.id, d.name, d.state, d.exp]), [[ph.dev, 'Test iPhone', 'pending', out.exp]], 'devices.json: pending');
  ok(!fs.readFileSync(devicesFile, 'utf8').includes(ph.j.k), 'devices.json holds no key');
  eq(JSON.parse(A.keyStore.peek()), { [ph.dev]: { k: ph.j.k, qr: { until: out.exp, next: [] } } }, 'the key store holds the QR\'s K, which opens hellos until exp');

  // the socket and the join
  let ws = lastSocket();
  ok(sockets.length === socketsBefore + 1, 'pairing opened one socket');
  eq(ws.url, `wss://example-project.supabase.co/realtime/v1/websocket?apikey=${SB_KEY}&vsn=1.0.0`, 'the socket URL');
  ok(A.configReads === 2, `the config was read for the link, and again for the connect (${A.configReads})`);
  ws.open();
  await settle();
  let joins = ws.frames('phx_join');
  ok(joins.length === 1, `one phx_join (${joins.length})`);
  const jf = joins[0];
  ok(jf.topic === ph.wire && jf.ref === jf.join_ref && typeof jf.ref === 'string', `phx_join topic and refs: ${jf.topic} ${jf.ref} ${jf.join_ref}`);
  eq(jf.payload, { config: { broadcast: { ack: false, self: false }, presence: { key: 'pc', enabled: true }, postgres_changes: [], private: true }, access_token: 'test-access-token-1' }, 'the phx_join payload');
  acceptJoins(ws);
  await settle();
  const tracks = ws.frames('presence', ph.wire);
  ok(tracks.length === 1 && tracks[0].join_ref === jf.ref, 'presence track after the join');
  eq(tracks[0] && tracks[0].payload, { type: 'presence', event: 'track', payload: { role: 'pc', v: 1, at: clock.t } }, 'the track payload');

  // pairing (protocol v2): under the QR's K only a hello with the phone's X25519 key does anything
  let r = await ph.ask(ws, 'GET', '/state');
  ok(r && r.s === 403 && /hello/.test(r.b.message), `a req under K before the handshake: 403 (${r && r.s})`);
  ok(!seenFor('/state').length, 'and nothing reached the server');
  r = await ph.ask(ws, 'POST', `/api/sessions/${SID}/message`, { b: { text: 'before hello', via: 'phone' } });
  ok(r && r.s === 403 && !seenFor(`/api/sessions/${SID}/message`).length, `a marked route before the handshake: 403, nothing reached the server (${r && r.s})`);
  ph.send(ws, { t: 'hello', id: 'h0', at: clock.t, app: '1.0.0', device: 'Henry\'s iPhone' });
  r = await ph.answer(ws, 'h0');
  ok(r && r.s === 400 && /old way/.test(r.b.message), `a v1 hello (no epk): 400 (${r && r.s} ${r && r.b.message})`);
  for (const [i, bad] of [Buffer.alloc(31, 7).toString('base64url'), Buffer.alloc(32).toString('base64url'), 'not base64!', 12].entries()) {
    const hs = await ph.handshake(ws, `hb${i}`, { epk: bad });
    ok(hs.r && hs.r.s === 400 && !hs.k, `a hello with a bad epk (${JSON.stringify(bad).slice(0, 12)}): 400 (${hs.r && hs.r.s})`);
  }
  devs = JSON.parse(fs.readFileSync(devicesFile, 'utf8')).devices;
  ok(devs[0].state === 'pending' && JSON.parse(A.keyStore.peek())[ph.dev].qr.next.length === 0, 'none of those paired it or made a key');
  const hs1 = await ph.handshake(ws, 'h1');
  eq(hs1.r && { s: hs1.r.s, b: { ...hs1.r.b, epk: '-' } }, { s: 200, b: { paired: true, pcName: 'TEST-PC', version: '1.0.99', device: null, platform: process.platform, epk: '-' } }, 'the handshake\'s hello: 200 with the PC\'s epk (no sync device id here yet: null)');
  ok(hs1.k && hs1.k.length === 32 && !hs1.k.equals(ph.K), 'the phone makes K\' from the answer');
  devs = JSON.parse(fs.readFileSync(devicesFile, 'utf8')).devices;
  ok(devs[0].state === 'paired' && devs[0].pairedAt === clock.t && devs[0].exp === undefined && devs[0].app === '1.0.0', 'devices.json: paired');
  let held1 = JSON.parse(A.keyStore.peek())[ph.dev];
  ok(held1.k === ph.j.k && held1.qr && held1.qr.next.length === 1 && held1.qr.next[0] === hs1.k.toString('base64url'), 'K\' was kept before the answer went, next to K');
  // the answer was lost: the phone says hello under K again (5 s on: one handshake per 5 s), and gets another K';
  // either works
  const hs2soon = await ph.handshake(ws, 'h2soon');
  ok(hs2soon.r && hs2soon.r.s === 429 && hs2soon.r.b.retryAfter === 5000 && !hs2soon.k, `a second handshake within 5 s: 429, retryAfter 5000 (${hs2soon.r && hs2soon.r.s} ${hs2soon.r && hs2soon.r.b.retryAfter})`);
  await tick(A.timers, 5000, ws);
  const hs2 = await ph.handshake(ws, 'h2');
  ok(hs2.r && hs2.r.s === 200 && hs2.k && !hs2.k.equals(hs1.k), 'a hello again under K (its answer lost): another K\'');
  held1 = JSON.parse(A.keyStore.peek())[ph.dev];
  eq(held1.qr.next, [hs1.k.toString('base64url'), hs2.k.toString('base64url')], 'both K\' kept');
  ok((await relay.status()).devices[0].finished === false, 'status: paired, not finished');
  // the first envelope under one K' (the first one: the second answer was the lost one this time) finishes it
  ph.use(hs1.k);
  // this machine's sync device id, once sync made one (device.json), goes with every hello's answer
  const DEVICE_A = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  fs.mkdirSync(path.join(A.dataDir, 'sync'), { recursive: true });
  fs.writeFileSync(path.join(A.dataDir, 'sync', 'device.json'), JSON.stringify({ id: DEVICE_A.toUpperCase() }));
  ph.send(ws, { t: 'hello', id: 'h3', at: clock.t, app: '1.0.0', device: 'Henry\'s iPhone' });
  r = await ph.answer(ws, 'h3');
  eq(r && { s: r.s, b: r.b }, { s: 200, b: { paired: true, pcName: 'TEST-PC', version: '1.0.99', device: DEVICE_A, platform: process.platform } }, 'a hello under K\': 200 with the sync device id (lower case) and the platform, no epk');
  eq(JSON.parse(A.keyStore.peek()), { [ph.dev]: { k: hs1.k.toString('base64url') } }, 'the key store holds K\' alone: K and the other K\' are forgotten');
  ok((await relay.status()).devices[0].finished === true, 'status: finished');
  // the QR's K now: "already paired", and the other K' opens nothing
  ph.inject(ws, ph.envUnder(ph.K, { t: 'hello', id: 'h4', at: clock.t, app: '1', device: 'x', epk: R.xPair().pub.toString('base64url') }));
  r = await ph.answer(ws, 'h4');
  ok(r && r.s === 403 && r.b.paired === false && /already paired/.test(r.b.message), `a hello under K after: 403 already paired (${r && r.s})`);
  ph.inject(ws, ph.envUnder(ph.K, { t: 'req', id: 'h5', at: clock.t, m: 'GET', p: '/state' }));
  r = await ph.answer(ws, 'h5');
  ok(r && r.s === 403 && /already paired/.test(r.b.message) && !seenFor('/state').length, `a req under K after: 403, nothing reached the server (${r && r.s})`);
  const dOther = (await relay.status()).devices[0].dropped;
  ph.inject(ws, ph.envUnder(hs2.k, { t: 'req', id: 'h6', at: clock.t, m: 'GET', p: '/state' }));
  await sleep(60);
  ok(!ph.answers(ws, 'h6').length && (await relay.status()).devices[0].dropped === dOther + 1, 'the other K\': dropped, never answered');
  ok(JSON.parse(A.keyStore.peek())[ph.dev].k === hs1.k.toString('base64url'), 'and the key stays K\'');
  await tick(A.timers, 1001, ws);

  // forwarding: who the server sees
  r = await ph.ask(ws, 'GET', '/state');
  ok(r && r.s === 200 && r.b.repos[0].root === KNOWN && r.etag === '"state-1"', `GET /state: 200, b and etag (${r && r.s})`);
  let last = seenFor('/state').pop();
  ok(last && !last.headers.origin && !last.headers.authorization, 'a page GET goes with no Origin and no token');
  r = await ph.ask(ws, 'GET', '/state', { etag: '"state-1"' });
  ok(r && r.s === 304 && r.b === undefined && r.b64 === undefined && r.etag === '"state-1"', `etag: 304 and no body (${JSON.stringify(r)})`);
  ok(seenFor('/state').pop().headers['if-none-match'] === '"state-1"', 'the etag went as If-None-Match');
  r = await ph.ask(ws, 'POST', '/rename', { b: { id: SID, name: 'x' } });
  last = seenFor('/rename').pop();
  ok(r && r.s === 200 && last.headers.origin === ORIGIN && !last.headers.authorization, `a page POST goes with this PC's Origin (${last && last.headers.origin})`);
  eq(last.body, { id: SID, name: 'x' }, 'the POST body');
  r = await ph.ask(ws, 'GET', '/api/sessions');
  last = seenFor('/api/sessions').pop();
  ok(r && r.s === 200 && last.headers.authorization === `Bearer ${API_TOKEN}` && last.headers.origin === undefined, 'an /api GET goes with the Bearer token and no Origin');
  r = await ph.ask(ws, 'POST', `/api/sessions/${SID}/message`, { b: { text: 'hi' } });
  last = seenFor(`/api/sessions/${SID}/message`).pop();
  ok(r && r.s === 200 && last.headers.authorization === `Bearer ${API_TOKEN}` && last.headers.origin === undefined, 'an /api POST goes with the Bearer token and no Origin');

  // the marker (api.js viaOf): "via": "phone" and X-Fleet-View-Relay on the marked routes, set by the relay alone
  ok(last.headers['x-fleet-view-relay'] === RELAY_KEY && last.body.via === 'phone' && last.body.text === 'hi', `a message goes marked (${last.headers['x-fleet-view-relay'] === RELAY_KEY} ${last.body.via})`);
  const renamed = seenFor('/rename').pop();
  ok(renamed.headers['x-fleet-view-relay'] === undefined && !('via' in renamed.body), 'a page POST goes unmarked');
  ok(seenFor('/api/sessions').every((x) => x.method !== 'GET' || x.headers['x-fleet-view-relay'] === undefined), 'a GET goes unmarked');
  await tick(A.timers, 1001, ws);
  const markCases = [
    // [path, the phone's body, marked?]
    ['/api/sessions', { repo: KNOWN, account: 'B', prompt: 'p', via: 'chief' }, true],
    [`/api/sessions/${SID}/message`, { text: 'm', via: 'server' }, true],
    [`/api/sessions/${SID}/answer`, { option: 1, text: 'free text', via: 'phone' }, true],
    [`/api/sessions/${SID}/open`, { prompt: 'go on' }, true],
    ['/api/sessions/new-7/message', { text: 'to a new one' }, true],
    ['/api/teams/t0a1b2c3d/message', { text: 'team', via: 'phone' }, true],
    [`/api/sessions/${SID}/interrupt`, { via: 'phone' }, false],
    [`/api/sessions/${SID}/stop`, { via: 'phone' }, false],
    ['/api/teams', { members: [SID, SID], order: 'o', via: 'phone' }, false],
    ['/api/teams/t0a1b2c3d/add', { member: SID, via: 'phone' }, false],
    ['/api/chief/start', { via: 'phone' }, false],
    ['/rename', { id: SID, name: 'n', via: 'phone' }, false],
    ['/teams', { members: [SID], order: 'o', via: 'phone' }, false],
  ];
  for (const [p, b, wantMark] of markCases) {
    const sent = JSON.parse(JSON.stringify(b));
    r = await ph.ask(ws, 'POST', p, { b, h: { 'X-Fleet-View-Relay': 'from-the-phone' }, headers: { Origin: 'http://evil.example', Authorization: 'Bearer x' } });
    last = seenFor(p).pop();
    const { via, ...rest } = last ? last.body : {};
    const { via: _v, ...sentRest } = sent;
    ok(r && r.s === 200 && last, `${p}: reached the server (${r && r.s})`);
    if (wantMark) ok(via === 'phone' && last.headers['x-fleet-view-relay'] === RELAY_KEY, `${p}: marked, whatever via the phone sent (${JSON.stringify(sent.via)})`);
    else ok(via === undefined && last.headers['x-fleet-view-relay'] === undefined, `${p}: not marked, and the phone's via dropped (${JSON.stringify(via)})`);
    eq(rest, sentRest, `${p}: the rest of the body as the phone sent it`);
    const names = Object.keys(last.headers).sort();
    ok(names.every((n) => ['accept', 'authorization', 'content-type', 'content-length', 'host', 'connection', 'origin', 'x-fleet-view-relay'].includes(n)), `${p}: only the relay's own headers (${names.join(' ')})`);
    ok(last.headers['x-fleet-view-relay'] !== 'from-the-phone' && last.headers.origin !== 'http://evil.example' && last.headers.authorization !== 'Bearer x', `${p}: no header the phone named`);
  }
  // a marked request's envelope again: dropped by its nonce, never a second run
  const nMsg = seenFor(`/api/sessions/${SID}/message`).length;
  const dropped0 = (await relay.status()).devices.find((d) => d.id === ph.dev).dropped;
  const markedEnv = ph.send(ws, { t: 'req', id: 'mk-replay', at: clock.t, m: 'POST', p: `/api/sessions/${SID}/message`, b: { text: 'once' } });
  await ph.answer(ws, 'mk-replay');
  ph.inject(ws, markedEnv);
  ph.send(ws, { t: 'req', id: 'mk-old', at: clock.t - 5 * 60e3 - 1, m: 'POST', p: `/api/sessions/${SID}/message`, b: { text: 'old' } });
  await sleep(60);
  ok(seenFor(`/api/sessions/${SID}/message`).length === nMsg + 1 && (await relay.status()).devices.find((d) => d.id === ph.dev).dropped === dropped0 + 2, 'a replayed or stale marked request never reaches the server');

  // the Chief: its briefing, its start (account, model, effort only) and its watch mode in /settings
  r = await ph.ask(ws, 'GET', '/chief/briefing');
  last = seenFor('/chief/briefing').pop();
  ok(r && r.s === 200 && last && !last.headers.origin && !last.headers.authorization, `GET /chief/briefing: 200, as a page GET (${r && r.s})`);
  r = await ph.ask(ws, 'POST', '/api/chief/start', { b: { account: 'B', model: 'claude-sonnet-5-5', effort: 'medium', prompt: 'evil', repo: ELSEWHERE, role: 'chief', via: 'phone' } });
  last = seenFor('/api/chief/start').pop();
  ok(r && r.s === 200 && last.headers.authorization === `Bearer ${API_TOKEN}` && last.headers.origin === undefined, 'POST /api/chief/start goes as an /api POST');
  eq(last.body, { account: 'B', model: 'claude-sonnet-5-5', effort: 'medium' }, 'POST /api/chief/start: only account, model and effort go on');
  await tick(A.timers, 1001, ws);
  const chiefSettings = [
    [{ chief: { watch: true } }, 200, { chief: { watch: true } }],
    [{ chief: { id: SID, watch: false, told: [SID], extra: 1 } }, 200, { chief: { watch: false } }],
    [{ chief: { watch: true }, repo: KNOWN, finishedOpen: false }, 200, { chief: { watch: true }, repo: KNOWN, finishedOpen: false }],
    [{ chief: { watch: 'yes' } }, 400], [{ chief: { watch: 1 } }, 400], [{ chief: {} }, 400], [{ chief: { id: SID } }, 400], [{ chief: true }, 400],
    [{ chief: null }, 400], [{ chief: [true] }, 400], [{ chief: { watch: true }, view: 'map' }, 403], [{ chief: { watch: true }, repo: ELSEWHERE }, 403],
  ];
  for (const [b, want, body] of chiefSettings) {
    const n0 = seenFor('/settings').length;
    r = await ph.ask(ws, 'POST', '/settings', { b });
    const reached = seenFor('/settings').length - n0;
    ok(r && r.s === want && reached === (want === 200 ? 1 : 0), `POST /settings ${JSON.stringify(b)}: want ${want}, got ${r && r.s} (${r && r.b && r.b.message || ''}), reached ${reached}`);
    if (body) eq(seenFor('/settings').pop().body, body, `POST /settings ${JSON.stringify(b)}: what went on`);
  }

  // the Chief starts only by its own route
  for (const b of [{ repo: KNOWN, account: 'B', prompt: 'p', role: 'chief' }, { repo: KNOWN, role: null }, { role: 'bot:a1b2c3d4e5f6' }]) {
    const n0 = seenFor('/api/sessions').length;
    r = await ph.ask(ws, 'POST', '/api/sessions', { b });
    ok(r && r.s === 403 && /chief\/start/.test(r.b.message) && seenFor('/api/sessions').length === n0, `POST /api/sessions ${JSON.stringify(b)}: 403, nothing reached the server (${r && r.s})`);
  }

  // the bots, as api.js and bots.js take them: create, update and remove marked (Henry's alone), start not
  await tick(A.timers, 1001, ws);
  const botCases = [
    ['/api/bots', { name: 'Scout', brief: 'watch the PRs', account: 'B', model: 'sonnet', effort: 'low' }, 200, null, true],
    ['/api/bots', { name: 'Scout', via: 'server' }, 200, { name: 'Scout' }, true],
    ['/api/bots', { name: 'Scout', folder: KNOWN }, 403],
    ['/api/bots', { name: 'Scout', folder: null }, 403],
    ['/api/bots', { name: 'Scout', createdAt: 1 }, 403],
    ['/api/bots', { name: 'Scout', role: 'chief' }, 403],
    [`/api/bots/${BOT}`, { name: 'Scout 2', brief: 'b', effort: 'high' }, 200, null, true],
    [`/api/bots/${BOT}`, { id: 'b2' }, 403],
    [`/api/bots/${BOT}`, { convId: SID }, 403],
    [`/api/bots/${BOT}`, { folder: ELSEWHERE }, 403],
    [`/api/bots/${BOT}/start`, {}, 200, {}, false],
    [`/api/bots/${BOT}/start`, { via: 'phone' }, 200, {}, false],
    [`/api/bots/${BOT}/start`, { prompt: 'do this' }, 403],
    [`/api/bots/${BOT}/remove`, {}, 200, {}, true],
    [`/api/bots/${BOT}/remove`, { via: 'phone' }, 200, {}, true],
    [`/api/bots/${BOT}/remove`, { wait: true }, 403],
  ];
  for (const [p, b, want, body, marked] of botCases) {
    const sent = JSON.parse(JSON.stringify(b));
    const n0 = seenFor(p).length;
    r = await ph.ask(ws, 'POST', p, { b });
    const reached = seenFor(p).length - n0;
    ok(r && r.s === want && reached === (want === 200 ? 1 : 0), `POST ${p} ${JSON.stringify(sent)}: want ${want}, got ${r && r.s} (${r && r.b && r.b.message || ''}), reached ${reached}`);
    if (want !== 200) continue;
    last = seenFor(p).pop();
    const { via, ...rest } = last.body;
    eq(rest, body || sent, `POST ${p}: the body that went on`);
    ok(last.headers.authorization === `Bearer ${API_TOKEN}`, `POST ${p}: the token`);
    if (marked) ok(via === 'phone' && last.headers['x-fleet-view-relay'] === RELAY_KEY, `POST ${p}: marked (${via})`);
    else ok(via === undefined && last.headers['x-fleet-view-relay'] === undefined, `POST ${p}: not marked (${via})`);
  }
  // a bot's look goes with create and update (bots.js checks the shape and colour itself)
  await tick(A.timers, 1001, ws);
  for (const [p, b] of [['/api/bots', { name: 'Scout', model: 'dynamic', effort: 'dynamic', shape: 'heart', color: '#ff6b80' }], [`/api/bots/${BOT}`, { shape: null, color: '#58a6ff' }]]) {
    r = await ph.ask(ws, 'POST', p, { b });
    const { via, ...rest } = seenFor(p).pop().body;
    ok(r && r.s === 200 && via === 'phone', `POST ${p} with a look: 200, marked (${r && r.s})`);
    eq(rest, b, `POST ${p} with a look: the body that went on`);
  }
  // a dynamic bot's switch and its tasks' actions: page routes (fleet-view.js lets in only this PC's Origin), never marked
  await tick(A.timers, 1001, ws);
  const TK = `/bots/${BOT}/tasks/t-deploys`, SW = `/bots/${BOT}/switch`;
  const pageBotCases = [
    // [path, the phone's body, want, the body that goes on (default: as sent, less via)]
    [TK, { action: 'pause' }, 200], [TK, { action: 'resume' }, 200], [TK, { action: 'run', via: 'phone' }, 200, { action: 'run' }], [TK, { action: 'delete' }, 200],
    [TK, {}, 400], [TK, { action: 'edit' }, 400], [TK, { action: ['run'] }, 400], [TK, { action: 'run', title: 'x' }, 403], [TK, { action: 'run', schedule: {} }, 403],
    [SW, { id: SID, model: 'claude-opus-5-5', effort: 'high' }, 200], [SW, { id: SID, effort: 'low', via: 'server' }, 200, { id: SID, effort: 'low' }],
    [SW, { id: SID }, 400], [SW, { model: 'sonnet' }, 400], [SW, { id: 'new-3', model: 'sonnet' }, 400], [SW, { id: SID, model: 'bad model!' }, 400],
    [SW, { id: SID, effort: 'ultra' }, 400], [SW, { id: SID, model: 'sonnet', text: 'x' }, 403], [SW, { id: SID, model: 'sonnet', account: 'A' }, 403],
  ];
  for (const [p, b, want, body] of pageBotCases) {
    const sent = JSON.parse(JSON.stringify(b));
    await tick(A.timers, 100, ws);
    const n0 = seenFor(p).length;
    r = await ph.ask(ws, 'POST', p, { b });
    const reached = seenFor(p).length - n0;
    ok(r && r.s === want && reached === (want === 200 ? 1 : 0), `POST ${p} ${JSON.stringify(sent)}: want ${want}, got ${r && r.s} (${r && r.b && r.b.message || ''}), reached ${reached}`);
    if (want !== 200) continue;
    last = seenFor(p).pop();
    const { via: _v, ...sentRest } = sent;
    eq(last.body, body || sentRest, `POST ${p}: the body that went on`);
    ok(last.headers.origin === ORIGIN && !last.headers.authorization && last.headers['x-fleet-view-relay'] === undefined, `POST ${p}: this PC's Origin, no token, not marked`);
  }
  // the Claude accounts screen: what GET /accounts passes on, and a sign-in only for A or B with no login
  await tick(A.timers, 1001, ws);
  ACCTS_VIEW.v = {
    list: [{ a: 'B', email: 'b@example.com', org: 'Org B', signedIn: true, sameAs: null }, { a: 'A', email: null, org: null, signedIn: false, sameAs: null },
      { a: 'C', email: 'c@example.com', org: 'Org C', signedIn: true, sameAs: 'B' }, { a: 'D', email: null, org: null, signedIn: false, sameAs: null }],
    jobs: { A: { status: 'waiting', url: 'https://claude.ai/oauth/authorize?code=true&x=1', message: 'Your browser is opening claude.ai to sign in.', email: 'secret@example.com', fresh: false },
      D: { status: 'waiting', url: 'https://claude.ai/oauth/authorize?d=1', message: 'm', email: null, fresh: true } },
  };
  r = await ph.ask(ws, 'GET', '/accounts');
  last = seenFor('/accounts').pop();
  ok(r && r.s === 200 && last && !last.headers.origin && !last.headers.authorization, `GET /accounts: 200, as a page GET (${r && r.s})`);
  eq(r && r.b, { list: [{ a: 'B', email: 'b@example.com', signedIn: true }, { a: 'A', email: null, signedIn: false }, { a: 'C', email: 'c@example.com', signedIn: true }, { a: 'D', email: null, signedIn: false }],
    jobs: { A: { status: 'waiting', message: 'Your browser is opening claude.ai to sign in.', url: 'https://claude.ai/oauth/authorize?code=true&x=1' } } },
  'GET /accounts: only a, email, signedIn and the sign-ins of A and B (no org, sameAs, job email, nor another letter\'s job)');
  ACCTS_VIEW.v.jobs.A = { status: 'failed', url: 'https://claude.ai/oauth/old', message: 'The sign-in did not finish.' };
  r = await ph.ask(ws, 'GET', '/accounts');
  eq(r && r.b && r.b.jobs, { A: { status: 'failed', message: 'The sign-in did not finish.', url: null } }, 'GET /accounts: the claude.ai link only while a sign-in waits');
  ACCTS_VIEW.v.jobs.A = { status: 'waiting', url: 'javascript:alert(1)', message: 'm' };
  r = await ph.ask(ws, 'GET', '/accounts');
  eq(r && r.b && r.b.jobs.A.url, null, 'GET /accounts: a link that is not https is not passed on');
  ACCTS_VIEW.v.jobs.A = { status: 'waiting', url: 'https://claude.ai/oauth/authorize?code=true', message: 'm' };
  const acctCases = [
    // [path, the phone's body, want, the body that goes on (default: as sent)]
    ['/accounts/login', { account: 'A' }, 200], ['/accounts/login', { account: 'a' }, 200, { account: 'A' }],
    ['/accounts/add', { letter: 'A' }, 200], ['/accounts/code', { account: 'A', code: 'abcDEF123456#state' }, 200], ['/accounts/cancel', { account: 'A' }, 200],
    ['/accounts/login', { account: 'A', via: 'phone' }, 200, { account: 'A' }],
    // a signed-in letter: never signed in again, switched or stopped from the phone
    ['/accounts/login', { account: 'B' }, 403], ['/accounts/add', { letter: 'B' }, 403], ['/accounts/code', { account: 'B', code: 'abcDEF123456' }, 403],
    ['/accounts/cancel', { account: 'b' }, 403],
    // only A or B, even with no login (D), and never a letter the PC has not got by another name
    ['/accounts/add', { letter: 'C' }, 403], ['/accounts/add', { letter: 'D' }, 403], ['/accounts/login', { account: 'D' }, 403], ['/accounts/code', { account: 'D', code: 'abcDEF123456' }, 403],
    ['/accounts/cancel', { account: 'Z' }, 403], ['/accounts/add', { letter: 'AB' }, 403], ['/accounts/add', {}, 403], ['/accounts/login', { account: 1 }, 403],
    ['/accounts/login', { account: ['A'] }, 403], ['/accounts/add', { letter: null }, 403],
    // only the body accounts.js reads for it
    ['/accounts/add', { letter: 'A', email: 'x@example.com' }, 403], ['/accounts/add', { account: 'A' }, 403], ['/accounts/login', { account: 'A', email: 'x@example.com' }, 403],
    ['/accounts/login', { letter: 'A' }, 403], ['/accounts/cancel', { account: 'A', code: 'x' }, 403], ['/accounts/code', { account: 'A', code: 'abcDEF123456', to: 'B' }, 403],
    ['/accounts/code', { account: 'A' }, 400], ['/accounts/code', { account: 'A', code: '   ' }, 400], ['/accounts/code', { account: 'A', code: 5 }, 400],
    ['/accounts/code', { account: 'A', code: 'x'.repeat(601) }, 400],
  ];
  for (const [p, b, want, body] of acctCases) {
    const sent = JSON.parse(JSON.stringify(b));
    await tick(A.timers, 100, ws);
    const n0 = seenFor(p).length;
    r = await ph.ask(ws, 'POST', p, { b });
    const reached = seenFor(p).length - n0;
    ok(r && r.s === want && reached === (want === 200 ? 1 : 0), `POST ${p} ${JSON.stringify(sent)}: want ${want}, got ${r && r.s} (${r && r.b && r.b.message || ''}), reached ${reached}`);
    if (want !== 200) continue;
    last = seenFor(p).pop();
    const { via: _v, ...sentRest } = sent;
    eq(last.body, body || sentRest, `POST ${p}: the body that went on`);
    ok(last.headers.origin === ORIGIN && !last.headers.authorization && last.headers['x-fleet-view-relay'] === undefined, `POST ${p}: this PC's Origin, no token, not marked`);
  }
  // a letter the PC has no folder for yet (A missing from the list): add goes on; the list read fresh each time, so a
  // letter signed in a moment ago is refused at once; a list that can't be read refuses everything
  ACCTS_VIEW.v.list = ACCTS_VIEW.v.list.filter((x) => x.a !== 'A');
  await tick(A.timers, 100, ws);
  r = await ph.ask(ws, 'POST', '/accounts/add', { b: { letter: 'A' } });
  ok(r && r.s === 200, `POST /accounts/add A with no folder for A: 200 (${r && r.s})`);
  ACCTS_VIEW.v.list.push({ a: 'A', email: 'a@example.com', signedIn: true });
  for (const [p, b] of [['/accounts/add', { letter: 'A' }], ['/accounts/login', { account: 'A' }], ['/accounts/code', { account: 'A', code: 'abcDEF123456' }], ['/accounts/cancel', { account: 'A' }]]) {
    await tick(A.timers, 100, ws);
    const n0 = seenFor(p).length;
    r = await ph.ask(ws, 'POST', p, { b });
    ok(r && r.s === 403 && /signed in already/.test(r.b.message) && seenFor(p).length === n0, `POST ${p} once A is signed in: 403, nothing reached the server (${r && r.s})`);
  }
  ACCTS_VIEW.v.list = ACCTS_VIEW.v.list.map((x) => (x.a === 'A' ? { ...x, signedIn: 'yes' } : x));
  await tick(A.timers, 100, ws);
  r = await ph.ask(ws, 'POST', '/accounts/login', { b: { account: 'A' } });
  ok(r && r.s === 403, `POST /accounts/login when signedIn is anything but false: 403 (${r && r.s})`);
  ACCTS_VIEW.v.list = ACCTS_VIEW.v.list.map((x) => (x.a === 'A' ? { ...x, signedIn: false } : x));
  ACCTS_VIEW.fail = true;
  await tick(A.timers, 100, ws);
  const nLogin = seenFor('/accounts/login').length;
  r = await ph.ask(ws, 'POST', '/accounts/login', { b: { account: 'A' } });
  ok(r && r.s === 503 && seenFor('/accounts/login').length === nLogin, `POST /accounts/login when the list can't be read: 503, nothing reached the server (${r && r.s})`);
  r = await ph.ask(ws, 'GET', '/accounts');
  ok(r && r.s === 500, `GET /accounts when the server fails: its own answer (${r && r.s})`);
  ACCTS_VIEW.fail = false;
  // the chat's verbs (api.js): send now, unsend, a model or effort switch (marked: an overseer's is Henry's alone), now
  // on a message, the activity line
  await tick(A.timers, 1001, ws);
  const verbCases = [
    // [verb, the phone's body, want, the body that goes on (default: as sent, less via), marked]
    ['now', {}, 200, null, false], ['now', { via: 'phone' }, 200, {}, false], ['now', { text: 'x' }, 403], ['now', { wait: 5 }, 403],
    ['unsend', { text: 'take this back' }, 200, null, false], ['unsend', { text: 'line one\r\nline two\ttab' }, 200, null, false],
    ['unsend', { text: '' }, 400], ['unsend', { text: '   ' }, 400], ['unsend', { text: 'a\u0001b' }, 400], ['unsend', { text: 5 }, 400], ['unsend', {}, 400],
    ['unsend', { text: 'x', wait: 5 }, 403], ['unsend', { text: 'x', from: SID }, 403],
    ['model', { model: 'sonnet' }, 200, null, true], ['model', { effort: 'high' }, 200, null, true],
    ['model', { model: 'claude-opus-5-5[1m]', effort: 'max', via: 'server' }, 200, { model: 'claude-opus-5-5[1m]', effort: 'max' }, true],
    ['model', {}, 400], ['model', { model: null, effort: null }, 400], ['model', { model: 'bad model!' }, 400], ['model', { model: 5 }, 400],
    ['model', { effort: 'ultra' }, 400], ['model', { model: 'sonnet', account: 'A' }, 403], ['model', { model: 'sonnet', wait: true }, 403],
    ['message', { text: 'go now', now: true }, 200, null, true], ['message', { text: 'later', now: false }, 200, null, true], ['message', { text: 'x', now: 'yes' }, 400],
  ];
  for (const [verb, b, want, body, marked] of verbCases) {
    const p = `/api/sessions/${SID}/${verb}`, sent = JSON.parse(JSON.stringify(b));
    await tick(A.timers, 100, ws);
    const n0 = seenFor(p).length;
    r = await ph.ask(ws, 'POST', p, { b });
    const reached = seenFor(p).length - n0;
    ok(r && r.s === want && reached === (want === 200 ? 1 : 0), `POST ${p} ${JSON.stringify(sent)}: want ${want}, got ${r && r.s} (${r && r.b && r.b.message || ''}), reached ${reached}`);
    if (want !== 200) continue;
    last = seenFor(p).pop();
    const { via, ...rest } = last.body;
    const { via: _v, ...sentRest } = sent;
    eq(rest, body || sentRest, `POST ${p}: the body that went on`);
    ok(last.headers.authorization === `Bearer ${API_TOKEN}` && last.headers.origin === undefined, `POST ${p}: the token, no Origin`);
    if (marked) ok(via === 'phone' && last.headers['x-fleet-view-relay'] === RELAY_KEY, `POST ${p}: marked (${via})`);
    else ok(via === undefined && last.headers['x-fleet-view-relay'] === undefined, `POST ${p}: not marked (${via})`);
  }
  r = await ph.ask(ws, 'GET', `/api/sessions/${SID}/activity`);
  last = seenFor(`/api/sessions/${SID}/activity`).pop();
  ok(r && r.s === 200 && last && last.headers.authorization === `Bearer ${API_TOKEN}` && last.headers['x-fleet-view-relay'] === undefined, `GET /api/sessions/:id/activity goes as an /api GET (${r && r.s})`);
  await tick(A.timers, 1001, ws);
  r = await ph.ask(ws, 'GET', `/api/sessions/${SID}/transcript`, { q: { limit: 5, since: 0, x: true } });
  last = seenFor(`/api/sessions/${SID}/transcript`).pop();
  eq(last && last.query, { limit: '5', since: '0', x: 'true' }, 'q goes as the query');
  r = await ph.ask(ws, 'GET', '/since');
  eq(r && [r.s, r.b, r.ct, r.b64], [200, 'plain text ☕', 'text/plain; charset=utf-8', undefined], 'text/* as b + ct');
  r = await ph.ask(ws, 'GET', '/conversation/image', { q: { id: SID, key: 'k', n: 0 } });
  eq(r && [r.s, r.b64, r.ct, r.b], [200, PNG.toString('base64'), 'image/png', undefined], 'binary as standard base64 b64 + ct');

  // refused before the server (each request moves the clock on a little: the relay allows 30 a second)
  await tick(A.timers, 1001, ws);
  const before = seen.length;
  for (const [m, p] of [['GET', '/reveal'], ['POST', '/open'], ['GET', '/sync/status'], ['POST', '/relay/pair'], ['POST', `/api/sessions/${SID}/wait`], ['GET', '/api/ask'], ['GET', '/../state'], ['GET', '/state/../reveal'], ['GET', '/st%61te'], ['POST', '/teams/evil'], ['GET', '/api/sessions/nope']]) {
    r = await ph.ask(ws, m, p);
    ok(r && r.s === 403, `refused: ${m} ${p} (${r && r.s})`);
  }
  r = await ph.ask(ws, 'PUT', '/state');
  ok(r && r.s === 400, `PUT: 400 (${r && r.s})`);
  r = await ph.ask(ws, 'POST', '/rename', { b: [1, 2] });
  ok(r && r.s === 400, `a body that is not an object: 400 (${r && r.s})`);
  r = await ph.ask(ws, 'GET', '/state', { q: { 'bad key': 1 } });
  ok(r && r.s === 400, `a bad query name: 400 (${r && r.s})`);
  ok(seen.length === before, `none of those reached the server (${seen.length - before})`);

  // the narrower checks
  const narrowCases = [
    ['POST', '/settings', { b: { repo: KNOWN, finishedOpen: true, hidden: [] } }, 200],
    ['POST', '/settings', { b: { repo: 'known' } }, 200],
    ['POST', '/settings', { b: { repo: KNOWN, chatsBounds: { x: 1 } } }, 403],
    ['POST', '/settings', { b: { remote: { enabled: true } } }, 403],
    ['POST', '/settings', { b: { view: 'map' } }, 403],
    ['POST', '/settings', { b: { repo: ELSEWHERE } }, 403],
    ['POST', '/settings', { b: { repos: [KNOWN, HIDDEN] } }, 200],
    ['POST', '/settings', { b: { repos: [KNOWN, ELSEWHERE] } }, 403],
    ['POST', '/settings', { b: { hiddenRepos: [{ root: HIDDEN, at: 1 }, KNOWN] } }, 200],
    ['POST', '/settings', { b: { hiddenRepos: [{ root: ELSEWHERE }] } }, 403],
    ['POST', '/settings', { b: { repoOrder: [KNOWN, LISTED], repoNames: [{ root: KNOWN, name: 'K' }], forgotten: [SID] } }, 200],
    ['POST', '/settings', { b: { repoOrder: [ELSEWHERE] } }, 403],
    ['POST', '/settings', { b: { repoNames: [{ root: ELSEWHERE, name: 'E' }] } }, 403],
    ['POST', '/repos/add', { b: { path: HIDDEN } }, 200],
    ['POST', '/repos/add', { b: { path: KNOWN } }, 200],
    ['POST', '/repos/add', { b: { path: ELSEWHERE } }, 403],
    ['POST', '/repos/add', { b: { path: LISTED } }, 403],
    ['POST', '/repos/remove', { b: { root: ELSEWHERE } }, 200],
    ['POST', '/sessions/move', { b: { id: SID, root: null } }, 200],
    ['POST', '/sessions/move', { b: { id: SID, root: KNOWN } }, 200],
    ['POST', '/sessions/move', { b: { id: SID, root: ELSEWHERE } }, 403],
    ['POST', '/push-target', { b: { id: SID, target: 'preview' } }, 200],
    ['POST', '/push-target', { b: { root: KNOWN, target: 'preview' } }, 200],
    ['POST', '/push-target', { b: { root: ELSEWHERE, target: 'preview' } }, 403],
    ['GET', '/repo-history', { q: { root: KNOWN } }, 200],
    ['POST', '/sync/move', { b: { id: SID, force: true } }, 200], ['POST', '/sync/move', { b: { id: SID } }, 200],
    ['POST', '/sync/move', { b: { id: SID, force: 'yes' } }, 400], ['POST', '/sync/move', { b: { id: 'not-a-conversation' } }, 400],
    ['POST', '/sync/move', { b: {} }, 400], ['POST', '/sync/move', { b: { id: SID, force: true, from: 'x' } }, 403],
    ['GET', '/sync/move', { q: { id: SID } }, 200], ['GET', '/sync/move', { q: {} }, 400], ['GET', '/sync/move', { q: { id: '../state' } }, 400],
    ['GET', '/repo-history', { q: { root: ELSEWHERE } }, 403],
  ];
  // the phone's fence (GET /file, /chat/kind, /chat/files, /chat/commands): only inside a workspace, nothing hidden
  // or secret. ~ is the fake home folder (fakeEnv)
  const f = (...x) => path.join(...x);
  const fenceCases = [
    // inside a workspace
    ['GET', '/file', { q: { path: f(KNOWN, 'src', 'a.ts') } }, 200], ['GET', '/file', { q: { path: 'src/a.ts', cwd: KNOWN } }, 200],
    ['GET', '/file', { q: { path: f(CWD, 'a.txt'), raw: 1 } }, 200], ['GET', '/file', { q: { path: KNOWN } }, 200],
    ['GET', '/file', { q: { path: f(KNOWN, '.github', 'workflows', 'ci.yml') } }, 200], ['GET', '/file', { q: { path: f(HIDDEN, 'x.txt') } }, 200],
    // a worktree in the repo's .claude folder is a workspace of its own (a conversation's repo folder); the rest of .claude is not
    ['GET', '/file', { q: { path: f(WT, 'src', 'b.ts') } }, 200], ['GET', '/file', { q: { path: f(KNOWN, '.claude', 'settings.json') } }, 403],
    // a dot-folder inside the repo, and secret names anywhere
    ['GET', '/file', { q: { path: f(KNOWN, '.git', 'config') } }, 403], ['GET', '/file', { q: { path: '.git/config', cwd: KNOWN } }, 403],
    ['GET', '/file', { q: { path: f(KNOWN, '.env.local') } }, 403], ['GET', '/file', { q: { path: f(KNOWN, '.env.example') } }, 403],
    ['GET', '/file', { q: { path: f(KNOWN, 'config', '.env') } }, 403], ['GET', '/file', { q: { path: f(KNOWN, 'certs', 'server.pem') } }, 403],
    ['GET', '/file', { q: { path: f(KNOWN, 'keys', 'id_ed25519') } }, 403], ['GET', '/file', { q: { path: f(KNOWN, 'aws-credentials.txt') } }, 403],
    ['GET', '/file', { q: { path: f(KNOWN, 'gcp', 'claude-ops-service-account.json') } }, 403], ['GET', '/file', { q: { path: f(KNOWN, 'fcm-firebase-adminsdk-x.json') } }, 403],
    ['GET', '/file', { q: { path: f(KNOWN, 'android', 'app', 'google-services.json') } }, 403], ['GET', '/file', { q: { path: f(KNOWN, 'ios', 'GoogleService-Info.plist') } }, 403],
    ['GET', '/file', { q: { path: f(KNOWN, 'NPMRC', '..', '.npmrc') } }, 403], ['GET', '/file', { q: { path: f(KNOWN, 'infra', 'prod.tfstate') } }, 403],
    ['GET', '/file', { q: { path: f(KNOWN, 'gh', 'hosts.yml') } }, 403], ['GET', '/file', { q: { path: f(KNOWN, 'vault.kdbx') } }, 403],
    ['GET', '/file', { q: { path: f(KNOWN, 'Credentials', 'notes.md') } }, 403], ['GET', '/file', { q: { path: f(KNOWN, 'src', 'a.ts:secret') } }, 403],
    ...['AuthKey_AB12.p8', '_netrc', 'prod.tfvars', 'prod.tfstate.backup', 'notes.gpg', 'key.asc', 'backup.age', 'login.keychain-db', 'secrets.json', 'Secrets.yml',
      'secrets.yaml', 'kubeconfig'].map((n) => ['GET', '/file', { q: { path: f(KNOWN, 'conf', n) } }, 403]),
    // a conversation's repo that is no git checkout (/state names the folder it ran in), and conversations in the
    // folders a home dot-folder and an app data child link to (named by the target), or around them
    ['GET', '/file', { q: { path: f(PLAIN, 'a.txt') } }, 403], ['GET', '/chat/files', { q: { cwd: PLAIN } }, 403],
    ['GET', '/file', { q: { path: f(DOTLINKED, 'notes.md') } }, 403], ['GET', '/file', { q: { path: f(APPLINKED, 'a.txt') } }, 403],
    ['GET', '/file', { q: { path: f(CACHE, 'x.txt') } }, 403], ['GET', '/chat/files', { q: { cwd: DOTLINKED } }, 403],
    // a C:\ cwd, a ~ cwd, a home dot-folder, an app data folder, Fleet View's own data folder: never workspaces
    ['GET', '/file', { q: { path: f(DRIVE, 'x.txt') } }, 403], ['GET', '/file', { q: { path: f(HOME, 'notes.txt') } }, 403],
    ['GET', '/file', { q: { path: f(HOME, '.ssh', 'id_ed25519') } }, 403], ['GET', '/file', { q: { path: '~/.ssh/id_ed25519' } }, 403],
    ['GET', '/file', { q: { path: '.ssh/id_ed25519', cwd: HOME } }, 403], ['GET', '/file', { q: { path: f(DOTREPO, 'notes.md') } }, 403],
    ['GET', '/file', { q: { path: f(INAPP, 'readme.md') } }, 403], ['GET', '/file', { q: { path: f(A.dataDir, 'api-token') } }, 403],
    ['GET', '/file', { q: { path: 'api-token', cwd: A.dataDir } }, 403], ['GET', '/file', { q: { path: f(A.dataDir, 'chat-images', '0123abcd.png') } }, 403],
    // a folder a conversation only ran in, out of the repo by .., by a link
    ['GET', '/file', { q: { path: f(ELSEWHERE, 'a.txt') } }, 403], ['GET', '/file', { q: { path: '../../elsewhere/a.txt', cwd: KNOWN } }, 403],
    ...(linked ? [['GET', '/file', { q: { path: f(KNOWN, 'link', 'a.txt') } }, 403]] : []),
    // another drive's top, and a link from the repo to a folder there
    ...(DRIVE2 ? [['GET', '/file', { q: { path: f(DRIVE2, 'x.txt') } }, 403]] : []),
    ...(FAR && fs.existsSync(path.join(KNOWN, 'far')) ? [['GET', '/file', { q: { path: f(KNOWN, 'far', fs.readdirSync(FAR)[0]) } }, 403],
      ['GET', '/file', { q: { path: f(KNOWN, 'far', 'no-such-file.txt') } }, 403], ['GET', '/chat/files', { q: { cwd: f(KNOWN, 'far') } }, 403]] : []),
    // the server answers what it refuses itself (no absolute path)
    ['GET', '/file', { q: { path: 'a.txt' } }, 200],
    ['GET', '/chat/kind', { q: { path: f(CWD, 'a.txt') } }, 200], ['GET', '/chat/kind', { q: { path: f(KNOWN, '.env.local') } }, 403],
    ['GET', '/chat/kind', { q: { path: f(ELSEWHERE, 'a.txt') } }, 403], ['GET', '/chat/kind', { q: { path: f(HOME, '.ssh') } }, 403],
    ['GET', '/chat/files', { q: { cwd: CWD, q: 'a' } }, 200], ['GET', '/chat/files', { q: { cwd: WT } }, 200],
    ['GET', '/chat/files', { q: { cwd: ELSEWHERE } }, 403], ['GET', '/chat/files', { q: { cwd: HOME } }, 403], ['GET', '/chat/files', { q: { cwd: DRIVE } }, 403],
    ['GET', '/chat/files', { q: { cwd: f(KNOWN, '.git') } }, 403], ['GET', '/chat/files', { q: { cwd: f(KNOWN, '..', 'elsewhere') } }, 403],
  ];
  for (const [m, p, more, want] of [...narrowCases, ...fenceCases]) {
    await tick(A.timers, 100, ws);
    const n0 = seenFor(p).length;
    r = await ph.ask(ws, m, p, more);
    const reached = seenFor(p).length - n0;
    ok(r && r.s === want && reached === (want === 200 ? 1 : 0), `${m} ${p} ${JSON.stringify(more.b || more.q || {})}: want ${want}, got ${r && r.s} (${r && r.b && r.b.message || ''}), reached the server ${reached}`);
  }
  ok(linked, 'the junctions (out of the repo, a home dot-folder, an app data child) were made (else their cases did not run)');
  // a file whose text holds a key, whatever its name: 403, and none of the text goes
  for (const [name, want] of Object.keys(LEAKS).map((n) => [n, n === 'talk.txt' ? 200 : 403])) {
    await tick(A.timers, 100, ws);
    r = await ph.ask(ws, 'GET', '/file', { q: { path: f(KNOWN, 'src', name) } });
    ok(r && r.s === want && (want === 200 ? r.b.text === LEAKS[name] : !('text' in r.b) && /key or a credential/.test(r.b.message)), `GET /file of ${name}: ${want} (${r && r.s} ${r && JSON.stringify(r.b).slice(0, 80)})`);
  }
  if (!DRIVE2 || !FAR || !fs.existsSync(path.join(KNOWN, 'far'))) console.log(`note: no second drive here (${DRIVE2} ${FAR}): its cases did not run`);
  // /chat/commands outside the fence: it goes on without the cwd (the built-in commands and the phone's own)
  for (const [cwd, kept] of [[KNOWN, true], [WT, true], [HOME, false], [ELSEWHERE, false], [DRIVE, false], [f(KNOWN, '.claude'), false]]) {
    await tick(A.timers, 100, ws);
    r = await ph.ask(ws, 'GET', '/chat/commands', { q: { cwd } });
    last = seenFor('/chat/commands').pop();
    ok(r && r.s === 200 && last && ('cwd' in last.query) === kept, `GET /chat/commands in ${cwd}: ${kept ? 'with' : 'without'} its cwd (${r && r.s} ${last && JSON.stringify(last.query)})`);
  }
  // listings leave out what the phone may not open
  r = await ph.ask(ws, 'GET', '/file', { q: { path: KNOWN } });
  eq(r && r.b && [r.b.entries, r.b.total], [['.github/', 'src/', 'README.md'], 3 + 5], 'a folder\'s entries: no dot-named one but .github, no secret name (the total less them)');
  r = await ph.ask(ws, 'GET', '/chat/files', { q: { cwd: KNOWN, q: '' } });
  eq(r && r.b && r.b.files.map((x) => x.path), ['src/a.ts', '.github/ci.yml', 'src'], '/chat/files: the same left out');

  // timeouts and wait
  await tick(A.timers, 1001, ws);
  holdPaths.add(`/api/sessions/${SID}/stop`);
  ph.send(ws, { t: 'req', id: 'slow1', at: clock.t, m: 'POST', p: `/api/sessions/${SID}/stop`, b: {} });
  await waitUntil(() => (held.get(`/api/sessions/${SID}/stop`) || []).length === 1);
  await tick(A.timers, 29e3, ws);
  ok(!ph.answers(ws, 'slow1').length, 'no answer before 30 s');
  await tick(A.timers, 1001, ws);
  r = await ph.answer(ws, 'slow1');
  ok(r && r.s === 408 && r.b.ok === false, `30 s: 408 (${r && r.s})`);
  release(`/api/sessions/${SID}/stop`);
  // a waiting request on a route that starts or resumes nothing: 60 s
  const ANSWER = `/api/sessions/${SID}/answer`;
  holdPaths.add(ANSWER);
  ph.send(ws, { t: 'req', id: 'wait1', at: clock.t, m: 'POST', p: ANSWER, b: { option: 1, wait: true } });
  await waitUntil(() => (held.get(ANSWER) || []).length === 1);
  eq(seenFor(ANSWER).pop().body.wait, 50, 'wait: true goes as 50 s');
  await tick(A.timers, 31e3, ws);
  ok(!ph.answers(ws, 'wait1').length, 'a waiting request has more than 30 s');
  await tick(A.timers, 30e3, ws);
  r = await ph.answer(ws, 'wait1');
  ok(r && r.s === 408, `60 s: 408 (${r && r.s})`);
  release(ANSWER);
  holdPaths.delete(ANSWER);
  // the routes that start a Claude (95 s) or may resume one first (75 s), each plus the wait the body asks
  const slow = [
    ['sl-start', '/api/sessions', { repo: KNOWN, account: 'B', prompt: 'p' }, 95e3],
    ['sl-startw', '/api/sessions', { repo: KNOWN, account: 'B', prompt: 'p', wait: 20 }, 115e3],
    ['sl-chief', '/api/chief/start', {}, 95e3],
    ['sl-bot', `/api/bots/${BOT}/start`, {}, 95e3],
    ['sl-mkbot', '/api/bots', { name: 'Slow' }, 95e3],
    ['sl-now', `/api/sessions/${SID}/now`, {}, 10e3],
    ['sl-model', `/api/sessions/${SID}/model`, { model: 'sonnet' }, 20e3],
    ['sl-unsend', `/api/sessions/${SID}/unsend`, { text: 'x' }, 30e3],
    ['sl-msg', `/api/sessions/${SID}/message`, { text: 'm' }, 75e3],
    ['sl-msgw', `/api/sessions/${SID}/message`, { text: 'm', wait: 10 }, 85e3],
    ['sl-msgt', `/api/sessions/${SID}/message`, { text: 'm', wait: true }, 125e3],
    ['sl-open', `/api/sessions/${SID}/open`, { prompt: 'p', wait: 3600 }, 125e3],
    ['sl-team', '/api/teams/t0a1b2c3d/message', { text: 't' }, 75e3],
    ['sl-pteam', '/teams/add', { id: 't0a1b2c3d', member: SID }, 75e3],
  ];
  await tick(A.timers, 1001, ws);
  const slowPaths = [...new Set(slow.map((x) => x[1]))];
  for (const p of slowPaths) holdPaths.add(p);
  for (const [id, p, b] of slow) ph.send(ws, { t: 'req', id, at: clock.t, m: 'POST', p, b });
  ok(await waitUntil(() => slowPaths.reduce((n, p) => n + (held.get(p) || []).length, 0) === slow.length), 'the slow ones all reached the server');
  const slowAt = clock.t;
  for (const d of [...new Set(slow.map((x) => x[3]))].sort((x, y) => x - y)) {
    await tick(A.timers, slowAt + d - 1000 - clock.t, ws);
    const early = slow.filter((x) => x[3] >= d && ph.answers(ws, x[0]).length);
    ok(!early.length, `nothing that has ${d / 1000} s is answered a second before (${early.map((x) => x[0])})`);
    await tick(A.timers, 1001, ws);
    for (const [id, p, b] of slow.filter((x) => x[3] === d)) {
      r = await ph.answer(ws, id);
      ok(r && r.s === 408 && r.b.message.includes(`${d / 1000} s`), `POST ${p} ${JSON.stringify(b)}: 408 after ${d / 1000} s (${r && r.s} ${r && r.b.message})`);
    }
  }
  for (const p of slowPaths) { release(p); holdPaths.delete(p); }
  await ph.ask(ws, 'POST', `/api/sessions/${SID}/message`, { b: { text: 'hi', wait: 3600 } });
  eq(seenFor(`/api/sessions/${SID}/message`).pop().body.wait, 50, 'wait: 3600 goes as 50 s');
  await ph.ask(ws, 'POST', `/api/sessions/${SID}/message`, { b: { text: 'hi', wait: 10 } });
  eq(seenFor(`/api/sessions/${SID}/message`).pop().body.wait, 10, 'wait: 10 goes as it is');

  // the id retry cache
  const renamesBefore = renames;
  r = await ph.ask(ws, 'POST', '/rename', { id: 'once1', b: { id: SID, name: 'y' } });
  const first = r && r.b.n;
  ph.send(ws, { t: 'req', id: 'once1', at: clock.t, m: 'POST', p: '/rename', b: { id: SID, name: 'y' } });
  await waitUntil(() => ph.answers(ws, 'once1').length === 2);
  const twice = ph.answers(ws, 'once1');
  ok(twice.length === 2 && twice[1].b.n === first && renames === renamesBefore + 1, `a repeated id gets the kept answer and the POST runs once (${renames - renamesBefore} runs)`);
  ph.send(ws, { t: 'req', id: 'slow2', at: clock.t, m: 'POST', p: `/api/sessions/${SID}/stop`, b: {} });
  await waitUntil(() => (held.get(`/api/sessions/${SID}/stop`) || []).length === 1);
  ph.send(ws, { t: 'req', id: 'slow2', at: clock.t, m: 'POST', p: `/api/sessions/${SID}/stop`, b: {} });
  await sleep(60);
  ok((held.get(`/api/sessions/${SID}/stop`) || []).length === 1 && !ph.answers(ws, 'slow2').length, 'a repeat of one still running is ignored');
  release(`/api/sessions/${SID}/stop`);
  await waitUntil(() => ph.answers(ws, 'slow2').length);
  await sleep(30);
  ok(ph.answers(ws, 'slow2').length === 1 && ph.answers(ws, 'slow2')[0].b.late === true, 'its answer comes once');
  holdPaths.delete(`/api/sessions/${SID}/stop`);

  // replays and envelopes that don't open
  const dropped = async () => (await relay.status()).devices.find((d) => d.id === ph.dev).dropped;
  let d0 = await dropped();
  const env = ph.send(ws, { t: 'req', id: 'rp1', at: clock.t, m: 'GET', p: '/api/status' });
  await ph.answer(ws, 'rp1');
  ph.inject(ws, env);
  await sleep(60);
  ok(ph.answers(ws, 'rp1').length === 1 && (await dropped()) === d0 + 1, 'the same envelope again is dropped (its nonce was seen)');
  const quiet = [
    ['an old at', ph.env({ t: 'req', id: 'old1', at: clock.t - 5 * 60e3 - 1, m: 'GET', p: '/api/status' })],
    ['a future at', ph.env({ t: 'req', id: 'fut1', at: clock.t + 5 * 60e3 + 1, m: 'GET', p: '/api/status' })],
    ['an at before the relay started', ph.env({ t: 'req', id: 'pre1', at: startedAt - 1, m: 'GET', p: '/api/status' })],
    ['a flipped bit', (() => { const e = ph.env({ t: 'req', id: 'bit1', at: clock.t, m: 'GET', p: '/api/status' }); const c = Buffer.from(e.c, 'base64url'); c[3] ^= 1; return { ...e, c: c.toString('base64url') }; })()],
    ['dir down', { ...ph.env({ t: 'req', id: 'dir1', at: clock.t, m: 'GET', p: '/api/status' }), dir: 'down' }],
    ['another d', { ...ph.env({ t: 'req', id: 'dd1', at: clock.t, m: 'GET', p: '/api/status' }), d: 'AAAAAAAAAAAAAAAA' }],
    ['bad base64', { ...ph.env({ t: 'req', id: 'b641', at: clock.t, m: 'GET', p: '/api/status' }), c: '!!!!' }],
    ['v 2', { ...ph.env({ t: 'req', id: 'v21', at: clock.t, m: 'GET', p: '/api/status' }), v: 2 }],
    ['not JSON', ph.env('this is not JSON')],
    ['a JSON array', ph.env('[1,2,3]')],
    ['a bad id', ph.env({ t: 'req', id: 'has space', at: clock.t, m: 'GET', p: '/api/status' })],
    ['no at', ph.env({ t: 'req', id: 'noat1', m: 'GET', p: '/api/status' })],
    ['an unknown t', ph.env({ t: 'what', id: 'what1', at: clock.t })],
    ['the key of another direction', R.seal(ph.down, ph.topic, ph.dev, 'up', { t: 'req', id: 'kd1', at: clock.t, m: 'GET', p: '/api/status' })],
    ['an inflate bomb', (() => {
      const plain = zlib.deflateRawSync(Buffer.alloc(65 << 20, 0x20)), nonce = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', ph.up, nonce);
      c.setAAD(Buffer.from(R.aadText(ph.topic, ph.dev, 'up', 1), 'utf8'));
      return { v: 1, d: ph.dev, dir: 'up', n: nonce.toString('base64url'), z: 1, c: Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]).toString('base64url') };
    })()],
  ];
  d0 = await dropped();
  const sentBefore = ws.sent.length;
  for (const [, e] of quiet) ph.inject(ws, e);
  await sleep(400);
  ok((await dropped()) === d0 + quiet.length, `each one is dropped and counted (${(await dropped()) - d0} of ${quiet.length})`);
  ok(ws.sent.length === sentBefore, `and never answered (${ws.sent.length - sentBefore} frames sent)`);
  r = await ph.ask(ws, 'GET', '/api/status');
  ok(r && r.s === 200, 'the channel still works after them');

  // 429: 20 in flight, 30 a second, 1,200 a minute
  await tick(A.timers, 61e3, ws);
  holdPaths.add('/api/status');
  for (let i = 0; i < 20; i++) ph.send(ws, { t: 'req', id: `fl${i}`, at: clock.t, m: 'GET', p: '/api/status' });
  await waitUntil(() => (held.get('/api/status') || []).length === 20);
  r = await ph.ask(ws, 'GET', '/state', { id: 'fl20' });
  ok(r && r.s === 429 && r.b.retryAfter === 1000, `the 21st in flight: 429, retryAfter 1000 (${r && r.s} ${r && r.b.retryAfter})`);
  release('/api/status');
  holdPaths.delete('/api/status');
  await waitUntil(() => [...Array(20).keys()].every((i) => ph.answers(ws, `fl${i}`).length));
  ph.send(ws, { t: 'req', id: 'fl20', at: clock.t, m: 'GET', p: '/state' });
  await waitUntil(() => ph.answers(ws, 'fl20').length === 2);
  r = ph.answers(ws, 'fl20')[1];
  ok(r && r.s === 200, `a 429 is not kept: the same id runs once the limits allow (${r && r.s})`);
  await tick(A.timers, 61e3, ws);
  const batch = async (prefix, n) => {
    for (let i = 0; i < n; i++) ph.send(ws, { t: 'req', id: `${prefix}${i}`, at: clock.t, m: 'GET', p: '/api/status' });
    return waitUntil(() => { for (let i = 0; i < n; i++) if (!ph.answers(ws, `${prefix}${i}`).length) return false; return true; });
  };
  await batch('ps', 15);
  await batch('pt', 15);
  r = await ph.ask(ws, 'GET', '/api/status', { id: 'ps30' });
  ok(r && r.s === 429 && r.b.retryAfter > 0 && r.b.retryAfter <= 1000, `the 31st in a second: 429 (${r && r.s} ${r && r.b.retryAfter})`);
  ok([...Array(15).keys()].every((i) => ph.answers(ws, `ps${i}`)[0].s === 200 && ph.answers(ws, `pt${i}`)[0].s === 200), 'the first 30 all went');
  await tick(A.timers, 1001, ws);
  r = await ph.ask(ws, 'GET', '/api/status', { id: 'ps31' });
  ok(r && r.s === 200, 'a second later it goes again');
  // a minute: 1,200 (31 went already in this one)
  let sent = 31;
  for (let round = 0; sent < 1200; round++) {
    await tick(A.timers, 1001, ws);
    const n = Math.min(30, 1200 - sent);
    await batch(`m${round}a`, Math.min(15, n));
    if (n > 15) await batch(`m${round}b`, n - 15);
    sent += n;
  }
  ok(ph.read(ws).filter((m) => m.t === 'res' && /^m\d+[ab]/.test(m.id) && m.s !== 200).length === 0, 'up to 1,200 in the minute all went');
  await tick(A.timers, 1001, ws);
  r = await ph.ask(ws, 'GET', '/api/status', { id: 'min1' });
  ok(r && r.s === 429 && r.b.retryAfter > 1000 && r.b.retryAfter <= 60e3, `the 1,201st in a minute: 429 (${r && r.s} ${r && r.b.retryAfter})`);
  await tick(A.timers, r ? r.b.retryAfter : 60e3, ws);
  r = await ph.ask(ws, 'GET', '/api/status', { id: 'min2' });
  ok(r && r.s === 200, 'after retryAfter it goes again');
  await tick(A.timers, 61e3, ws);
  // every envelope that opens counts, a repeat of a kept answer too
  r = await ph.ask(ws, 'GET', '/api/status', { id: 'rep0' });
  for (let i = 0; i < 29; i++) ph.send(ws, { t: 'req', id: 'rep0', at: clock.t, m: 'GET', p: '/api/status' });
  await waitUntil(() => ph.answers(ws, 'rep0').length === 30);
  ph.send(ws, { t: 'req', id: 'rep0', at: clock.t, m: 'GET', p: '/api/status' });
  await waitUntil(() => ph.answers(ws, 'rep0').length === 31);
  r = ph.answers(ws, 'rep0')[30];
  ok(r && r.s === 429 && r.b.retryAfter > 0, `the 31st envelope in a second, a repeat: 429 (${r && r.s})`);
  await tick(A.timers, 61e3, ws);

  // t0: a POST sent again whose first attempt the relay may have run before it restarted is not run
  await tick(A.timers, Math.max(0, startedAt + 11 * 60e3 - clock.t), ws);
  const r0 = renames;
  const t0Cases = [
    // [id, t0 (from at), m, want, why]
    ['t0a', 0, 'POST', 200, 'a first attempt (t0 = at)'],
    ['t0b', clock.t - startedAt + 10e3, 'POST', 409, 'first sent before the relay started', 'restarted'],
    ['t0c', clock.t - startedAt - 1000, 'POST', 409, 'first sent within 2 s of the start (it may have been on its way)', 'restarted'],
    ['t0d', 9 * 60e3 + 1, 'POST', 409, 'first sent over 9 minutes ago', 'expired'],
    ['t0e', 60e3, 'POST', 200, 'first sent a minute ago, never arrived'],
    ['t0f', clock.t - startedAt + 10e3, 'GET', 200, 'a GET first sent before the start (a GET may run again)'],
    ['t0g', -1, 'POST', 400, 't0 after at'],
    ['t0h', 'x', 'POST', 400, 't0 not a number'],
  ];
  for (const [id, back, m, want, why, flag] of t0Cases) {
    const n0 = seen.length;
    r = await ph.ask(ws, m, m === 'GET' ? '/api/status' : '/rename', { id, t0: typeof back === 'number' ? clock.t - back : back, ...(m === 'POST' ? { b: { id: SID, name: id } } : {}) });
    ok(r && r.s === want && (flag ? r.b[flag] === true : true) && (seen.length - n0) === (want === 200 ? 1 : 0), `t0, ${why}: ${want}${flag ? ` ${flag}` : ''} (${r && r.s} ${r && JSON.stringify(r.b).slice(0, 120)})`);
  }
  ok(renames === r0 + 2, `only the two POSTs that may run ran (${renames - r0})`);
  ph.send(ws, { t: 'req', id: 't0b', at: clock.t, t0: clock.t - (clock.t - startedAt + 10e3), m: 'POST', p: '/rename', b: { id: SID, name: 'again' } });
  await waitUntil(() => ph.answers(ws, 't0b').length === 2);
  ok(ph.answers(ws, 't0b')[1].s === 409 && ph.answers(ws, 't0b')[1].b.restarted === true && renames === r0 + 2, 'and its 409 is kept: a repeat gets it again, nothing runs');
  await tick(A.timers, 1001, ws);

  // the routes that start or resume a Claude: 2 at once, 12 in 10 minutes (a team one per member), per device
  optsA.startLimits = undefined;
  await tick(A.timers, 10 * 60e3 + 1000, ws);
  holdPaths.add('/api/sessions');
  for (const id of ['st1', 'st2']) ph.send(ws, { t: 'req', id, at: clock.t, m: 'POST', p: '/api/sessions', b: { repo: KNOWN, account: 'B', prompt: id } });
  ok(await waitUntil(() => (held.get('/api/sessions') || []).length === 2), 'two starts at once reach the server');
  const nStart = seenFor('/api/sessions').length;
  const nChief = seenFor('/api/chief/start').length;
  r = await ph.ask(ws, 'POST', '/api/chief/start', { id: 'st3' });
  ok(r && r.s === 429 && r.b.retryAfter === 5000 && /2 are starting/.test(r.b.message) && seenFor('/api/chief/start').length === nChief, `a third start while two run: 429, not reaching the server (${r && r.s} ${r && r.b.message})`);
  r = await ph.ask(ws, 'POST', `/api/sessions/${SID}/message`, { id: 'st4', b: { text: 'a message is no start' } });
  ok(r && r.s === 200, `a message still goes (${r && r.s})`);
  release('/api/sessions');
  holdPaths.delete('/api/sessions');
  await waitUntil(() => ph.answers(ws, 'st1').length && ph.answers(ws, 'st2').length);
  ok(seenFor('/api/sessions').length === nStart, 'the third never reached the server');
  r = await ph.ask(ws, 'POST', '/api/teams', { id: 'st5', b: { members: Array.from({ length: 10 }, (_, i) => `11111111-2222-4333-8444-5555555555${String(i).padStart(2, '0')}`), order: 'o' } });
  ok(r && r.s === 200, `a team of 10 brings it to 12 (${r && r.s} ${r && r.b.message})`);
  r = await ph.ask(ws, 'POST', `/api/sessions/${SID}/open`, { id: 'st6', b: { prompt: 'p' } });
  ok(r && r.s === 429 && /12 were started/.test(r.b.message) && r.b.retryAfter > 9 * 60e3 && r.b.retryAfter <= 10 * 60e3, `a 13th in 10 minutes: 429 until the first of them is 10 minutes old (${r && r.s} ${r && r.b.retryAfter})`);
  r = await ph.ask(ws, 'POST', '/teams/lead', { id: 'st7', b: { id: 't0a1b2c3d', member: null } });
  ok(r && r.s === 200, `no lead (nothing to start) still goes (${r && r.s})`);
  await tick(A.timers, r && ph.answers(ws, 'st6')[0] ? ph.answers(ws, 'st6')[0].b.retryAfter : 10 * 60e3, ws);
  r = await ph.ask(ws, 'POST', `/api/sessions/${SID}/open`, { id: 'st8', b: { prompt: 'p' } });
  ok(r && r.s === 200, `then it goes (${r && r.s})`);
  // a message that may resume one weighs what /state (read again when stale) says is not running: 3 at most here
  await tick(A.timers, 10 * 60e3 + 1000, ws);
  optsA.startLimits = { atOnce: 1000, max: 3 };
  const nState = seenFor('/state').length;
  r = await ph.ask(ws, 'POST', `/api/sessions/${SID}/message`, { id: 'rw1', b: { text: 'w', open: true } });
  ok(r && r.s === 200 && seenFor('/state').length === nState + 1, `a message that opens a conversation not running: 200, /state read first (${r && r.s})`);
  for (const [id, p, b, want, why] of [
    ['rw2', `/api/teams/${TID}/message`, { text: 't' }, 200, 'a team message: its 2 members not running (3 now)'],
    ['rw3', `/api/sessions/${LIVE}/message`, { text: 'w', open: true }, 200, 'a message to one running: nothing'],
    ['rw4', `/api/sessions/${SID}/message`, { text: 'w' }, 200, 'a message that opens nothing: nothing'],
    ['rw5', '/api/sessions/new-3/message', { text: 'w', open: true }, 200, 'a message to a new-<n>: nothing'],
    ['rw6', `/api/sessions/${SID}/message`, { text: 'w', open: true }, 429, 'a 4th: 429'],
    ['rw7', `/api/sessions/${SID}/message`, { text: 'w', from: LIVE }, 429, 'a from opens it too: 429'],
    ['rw8', `/api/teams/${TID}/message`, { text: 't' }, 429, 'a team message: 429'],
  ]) {
    const n0 = seen.length;
    r = await ph.ask(ws, 'POST', p, { id, b });
    ok(r && r.s === want && (want === 429 ? /3 were started/.test(r.b.message) && seen.length === n0 : true), `${why} (${r && r.s} ${r && r.b.message})`);
  }
  optsA.startLimits = { atOnce: 1000, max: 1000 };
  await tick(A.timers, 1001, ws);

  // the caps on what comes up: a ciphertext over C_MAX is dropped before it is decoded, an inflate past 2 MB too
  const imgUnder = { t: 'req', id: 'cap1', at: clock.t, m: 'POST', p: '/chat/image', b: { data: 'E'.repeat(1100000), mime: 'image/png' } };
  ph.send(ws, imgUnder, { z: 0 });
  r = await ph.answer(ws, 'cap1');
  ok(r && r.s === 200, `a 1.1 MB envelope (z 0) under the cap goes (${r && r.s})`);
  d0 = await dropped();
  const overC = ph.send(ws, { ...imgUnder, id: 'cap2', b: { data: 'E'.repeat(1250000), mime: 'image/png' } }, { z: 0 });
  await sleep(100);
  ok(overC.c.length > R.C_MAX && !ph.answers(ws, 'cap2').length && (await dropped()) === d0 + 1, `a ciphertext over C_MAX (${overC.c.length} > ${R.C_MAX}): dropped`);
  ph.send(ws, { ...imgUnder, id: 'cap3', b: { data: 'F'.repeat(1900000), mime: 'image/png' } }, { z: 1 });
  r = await ph.answer(ws, 'cap3');
  ok(r && r.s === 200, `one that inflates to 1.9 MB goes (${r && r.s})`);
  d0 = await dropped();
  ph.send(ws, { ...imgUnder, id: 'cap4', b: { data: 'F'.repeat(2200000), mime: 'image/png' } }, { z: 1 });
  await sleep(200);
  ok(!ph.answers(ws, 'cap4').length && (await dropped()) === d0 + 1, 'one that inflates past 2 MB: dropped');
  await tick(A.timers, 1001, ws);
  // 4 inflating at once and 32 waiting per device: the rest are dropped (40 at once here, z 1; past 30 a second: 429)
  d0 = await dropped();
  for (let i = 0; i < 40; i++) ph.send(ws, { t: 'hello', id: `zz${i}`, at: clock.t, app: '1.0.0', device: 'Henry\'s iPhone' }, { z: 1 });
  await waitUntil(() => [...Array(36).keys()].every((i) => ph.answers(ws, `zz${i}`).length), 3000);
  await sleep(100);
  const zz = [...Array(40).keys()].map((i) => (ph.answers(ws, `zz${i}`)[0] || {}).s || 0);
  eq([zz.filter((s) => s === 200).length, zz.filter((s) => s === 429).length, zz.filter((s) => !s).length, (await dropped()) - d0], [30, 6, 4, 4], '40 inflating at once: 30 answered, 6 told 429, 4 dropped');
  await tick(A.timers, 1001, ws);
  // the bytes of answers being read for one device at once (64 MB; 1.5 MB here)
  optsA.resDeviceMax = 1.5 * (1 << 20);
  ph.send(ws, { t: 'req', id: 'rb1', at: clock.t, m: 'GET', p: `/api/sessions/${SID}/transcript`, q: { trickle: 1 } });
  await waitUntil(() => trickle.length === 1);
  await sleep(100);
  ph.send(ws, { t: 'req', id: 'rb2', at: clock.t, m: 'GET', p: `/api/sessions/${SID}/transcript`, q: { trickle: 1 } });
  r = await ph.answer(ws, 'rb2');
  ok(r && r.s === 429 && r.b.retryAfter > 0, `a second answer past 1.5 MB being read for the device: 429 (${r && r.s})`);
  trickle.done();
  r = await ph.answer(ws, 'rb1');
  ok(r && r.s === 200 && r.b.pad.length === 1 << 20, `the first comes whole (${r && r.s})`);
  ph.send(ws, { t: 'req', id: 'rb3', at: clock.t, m: 'GET', p: `/api/sessions/${SID}/transcript`, q: { trickle: 1 } });
  await waitUntil(() => trickle.length === 1);
  await sleep(100);
  trickle.done();
  r = await ph.answer(ws, 'rb3');
  ok(r && r.s === 200, `and once it is, the budget is free again (${r && r.s})`);
  optsA.resDeviceMax = undefined;
  await tick(A.timers, 61e3, ws);

  // parts up
  const imgB = { data: 'A'.repeat(R.PART_MAX + 5000), mime: 'image/png' };
  const n2 = await ph.sendParts(ws, { t: 'req', id: 'img1', at: clock.t, m: 'POST', p: '/chat/image', b: imgB }, [1, 0]);
  r = await ph.answer(ws, 'img1');
  last = seenFor('/chat/image').pop();
  ok(n2 === 2 && r && r.s === 200 && last && last.body.data === imgB.data && last.headers.origin === ORIGIN, `a request in 2 parts, out of order, is put together (${r && r.s})`);
  d0 = await dropped();
  ph.send(ws, { t: 'part', id: 'p65', at: clock.t, part: 0, parts: 65, chunk: '{' });
  for (let i = 1; i <= 5; i++) ph.send(ws, { t: 'part', id: `as${i}`, at: clock.t, part: 0, parts: 2, chunk: '{"t":"req",' });
  await sleep(60);
  ok((await dropped()) === d0 + 2, `65 parts, and a 5th set at once, are dropped (${(await dropped()) - d0})`);
  ph.send(ws, { t: 'part', id: 'as1', at: clock.t, part: 1, parts: 2, chunk: `"id":"as1","at":${clock.t},"m":"GET","p":"/api/status"}` });
  r = await ph.answer(ws, 'as1');
  ok(r && r.s === 200, 'a set of 2 parts within the 4 is put together');
  await tick(A.timers, 61e3, ws);
  ph.send(ws, { t: 'part', id: 'as2', at: clock.t, part: 1, parts: 2, chunk: `"id":"as2","at":${clock.t},"m":"GET","p":"/api/status"}` });
  await sleep(60);
  ok(!ph.answers(ws, 'as2').length, 'a set not complete within 60 s is dropped');
  // (real time too: the relay inflates in node's thread pool, 4 at once)
  const paceA = async () => { await sleep(150); await tick(A.timers, 1001, ws); };
  // 20 parts a second: all 64 go; all at once, the relay drops those past 30 in the second
  await tick(A.timers, 1001, ws);
  d0 = await dropped();
  await ph.sendParts(ws, { t: 'req', id: 'p64x', at: clock.t, m: 'POST', p: '/chat/image', b: { data: 'X'.repeat(64 * 1000 - 120), mime: 'image/png' } }, null, 1000);
  await sleep(200);
  ok(!ph.answers(ws, 'p64x').length && (await dropped()) === d0 + 34, 'all 64 parts in one second: not put together (parts past 30 a second are dropped)');
  await tick(A.timers, 61e3, ws);
  const many = await ph.sendParts(ws, { t: 'req', id: 'p64', at: clock.t, m: 'POST', p: '/chat/image', b: { data: 'B'.repeat(64 * 1000 - 120), mime: 'image/png' } }, null, 1000, paceA);
  r = await ph.answer(ws, 'p64');
  ok(many <= 64 && many > 60 && r && r.s === 200, `64 parts at most go (${many} parts: ${r && r.s})`);
  d0 = await dropped();
  const tooMuch = { t: 'req', id: 'p21m', at: clock.t, m: 'POST', p: '/chat/image', b: { data: 'C'.repeat(21000000), mime: 'image/png' } };
  await ph.sendParts(ws, tooMuch, null, R.PART_MAX, paceA);
  await sleep(300);
  ok(!ph.answers(ws, 'p21m').length && (await dropped()) === d0 + 1, `over 21,000,000 characters from the phone is dropped (${JSON.stringify(ph.answers(ws, 'p21m'))} ${(await dropped()) - d0})`);

  // parts down
  for (const id of ['big1', 'big22']) {
    r = await ph.ask(ws, 'GET', '/api/conversations', { id });
    const chunks = ph.chunks.get(id) || [];
    ok(r && r.s === 200 && r.b.big === BIG, `${id}: a 1.8 MB answer comes in parts and joins to the same JSON`);
    ok(chunks.length === 3 && chunks.every((c) => c.length <= R.PART_MAX && !/[\uD800-\uDBFF]$/.test(c) && !/^[\uDC00-\uDFFF]/.test(c)), `${id}: ${chunks.length} chunks of at most 400,000, never a split surrogate pair`);
  }
  ok(ph.chunks.get('big1')[0].length !== ph.chunks.get('big22')[0].length, 'one of the two had its cut moved off a surrogate pair');
  r = await ph.ask(ws, 'GET', '/api/teams', { id: 'huge1' }, 20000);
  ok(r && r.s === 413 && hugeCalls === 1, `an answer over 64 parts: 413 (${r && r.s})`);
  ph.send(ws, { t: 'req', id: 'huge1', at: clock.t, m: 'GET', p: '/api/teams' });
  await waitUntil(() => ph.answers(ws, 'huge1').length === 2);
  ok(ph.answers(ws, 'huge1')[1].s === 413 && hugeCalls === 1, 'and the kept answer to its id is that 413');

  // the token, the heartbeat, presence
  A.sync.token = 'test-access-token-2';
  A.sync.emit('refreshed');
  await settle();
  let toks = ws.frames('access_token', ph.wire);
  ok(toks.length === 1 && toks[0].payload.access_token === 'test-access-token-2' && toks[0].join_ref === jf.ref, 'the new token goes on a refresh');
  A.sync.token = 'test-access-token-3';
  const beats0 = ws.frames('heartbeat').length;
  await tick(A.timers, 25e3, ws);
  toks = ws.frames('access_token', ph.wire);
  ok(ws.frames('heartbeat').length > beats0 && toks.length === 2 && toks[1].payload.access_token === 'test-access-token-3', 'a heartbeat every 25 s, and a renewed token goes with it');
  eq(ws.frames('heartbeat').pop(), { topic: 'phoenix', event: 'heartbeat', payload: {}, ref: ws.frames('heartbeat').pop().ref }, 'the heartbeat frame');
  ws.frame({ topic: ph.wire, event: 'presence_diff', payload: { joins: { phone: { metas: [{ role: 'phone', v: 1, phx_ref: 'x' }] } }, leaves: {} } });
  const seenAt = clock.t;
  await settle();
  ok((await relay.status()).devices[0].lastSeen === seenAt, 'the phone\'s presence sets lastSeen');
  await tick(A.timers, 31e3, ws);
  ok(JSON.parse(fs.readFileSync(devicesFile, 'utf8')).devices[0].lastSeen === seenAt, 'lastSeen reaches devices.json with the sweep');

  // a second pairing that runs out
  [code, out] = await relay.pair('Never scanned');
  const ph2 = makePhone(out.link);
  await settle();
  acceptJoins(ws);
  await settle();
  ok(ws.frames('phx_join', ph2.wire).length === 1, 'a pending device\'s channel is joined, for its hello');
  r = await ph2.ask(ws, 'GET', '/state');
  ok(r && r.s === 403, 'a pending device\'s req: 403');
  await tick(A.timers, 10 * 60e3 + 1, ws);
  ph2.send(ws, { t: 'hello', id: 'late', at: clock.t, app: '1', device: 'x' });
  await sleep(60);
  ok(!ph2.answers(ws, 'late').length, 'a hello after exp is not answered');
  await tick(A.timers, 31e3, ws);
  const st = await relay.status();
  ok(!st.devices.some((dv) => dv.id === ph2.dev) && st.devices.some((dv) => dv.id === ph.dev), 'the pairing that ran out is dropped, the paired one stays');
  ok(!(ph2.dev in JSON.parse(A.keyStore.peek())), 'and its key is deleted');
  ok(ws.frames('phx_leave', ph2.wire).length === 1, 'and its channel left');

  // a heartbeat left unanswered
  let nSock = sockets.length;
  await A.timers.advance(25e3);
  await A.timers.advance(25e3);
  ok(ws.closed && ws.closed.reason === 'heartbeat timeout', `no answer to a heartbeat: the socket is closed (${JSON.stringify(ws.closed)})`);
  await A.timers.advance(1000);
  ok(sockets.length === nSock + 1, 'and opened again 1 s later');
  ws = lastSocket();
  ws.open();
  await settle();
  acceptJoins(ws);
  await settle();
  r = await ph.ask(ws, 'GET', '/api/status');
  ok(r && r.s === 200, 'the phone is answered on the new socket');

  // signed out, signed in
  A.sync.signedIn = false;
  A.sync.emit('signed-out');
  await settle();
  ok(ws.closed && ws.frames('phx_leave', ph.wire).length === 1, 'signed out: the channel is left and the socket closed');
  ok(!(await relay.status()).connected, 'status: not connected');
  nSock = sockets.length;
  await tick(A.timers, 5e3, null);
  ok(sockets.length === nSock, 'and nothing reconnects while signed out');
  A.sync.signedIn = true;
  A.sync.token = 'test-access-token-4';
  const reads0 = A.configReads;
  A.sync.emit('signed-in');
  await settle();
  ok(sockets.length === nSock + 1 && A.configReads === reads0 + 1, 'signed in: a new socket, with the config read again');
  ws = lastSocket();
  ws.open();
  await settle();
  ok(ws.frames('phx_join', ph.wire).length === 1 && ws.frames('phx_join', ph.wire)[0].payload.access_token === 'test-access-token-4', 'and the channel joined again with the new token');
  acceptJoins(ws);
  await settle();
  // signed in again as the same account while connected: leave and join again too
  nSock = sockets.length;
  A.sync.emit('signed-in');
  await settle();
  ok(ws.closed && sockets.length === nSock + 1, 'another signed-in leaves and joins again on a new socket');
  ws = lastSocket();
  ws.open();
  await settle();
  acceptJoins(ws);
  await settle();

  // a third device, then revoke the first
  [code, out] = await relay.pair('Second phone');
  const ph3 = makePhone(out.link);
  await settle();
  acceptJoins(ws);
  await settle();
  const hs3 = await ph3.handshake(ws, 'h3');
  ok(hs3.r && hs3.r.s === 200 && hs3.k, 'a third device pairs');
  ph3.use(hs3.k);
  ph3.send(ws, { t: 'hello', id: 'h3b', at: clock.t, app: '1.0.0', device: 'iPad' });
  ok((await ph3.answer(ws, 'h3b')).s === 200, 'and finishes under its K\'');
  // a fourth: at most 8 handshakes with one code, one per 5 s; then, its K' never used, it is dropped once K runs out
  [code, out] = await relay.pair('Flood');
  const ph4 = makePhone(out.link);
  await settle();
  acceptJoins(ws);
  await settle();
  const hs4 = [];
  for (let i = 0; i < 8; i++) { hs4.push(await ph4.handshake(ws, `fl-h${i}`)); await tick(A.timers, 5001, ws); }
  ok(hs4.every((h) => h.r && h.r.s === 200 && h.k), `8 handshakes with one code, 5 s apart: each 200 (${hs4.map((h) => h.r && h.r.s)})`);
  const hs4n = await ph4.handshake(ws, 'fl-h8');
  ok(hs4n.r && hs4n.r.s === 403 && hs4n.r.b.paired === false && /too many/.test(hs4n.r.b.message) && !hs4n.k, `a 9th: 403 paired false (${hs4n.r && hs4n.r.s} ${hs4n.r && hs4n.r.b.message})`);
  let st4 = (await relay.status()).devices.find((d) => d.id === ph4.dev);
  ok(st4 && st4.handshakes === 8 && st4.finished === false && JSON.parse(A.keyStore.peek())[ph4.dev].qr.n === 8, `status: 8 handshakes, not finished, n kept (${st4 && st4.handshakes})`);
  ok(!('handshakes' in (await relay.status()).devices.find((d) => d.id === ph3.dev)), 'a finished device says no handshake count');
  await tick(A.timers, 10 * 60e3 - 5000, ws);
  ph4.use(hs4[7].k);
  ph4.send(ws, { t: 'hello', id: 'fl-late', at: clock.t, app: '1.0.0', device: 'x' });
  await sleep(60);
  ok(!ph4.answers(ws, 'fl-late').length, 'K\' unused when K ran out: dropped, never answered');
  await tick(A.timers, 31e3, ws);
  st4 = (await relay.status()).devices.find((d) => d.id === ph4.dev);
  ok(!st4 && !(ph4.dev in JSON.parse(A.keyStore.peek())) && (ph3.dev in JSON.parse(A.keyStore.peek())), 'the sweep dropped the unfinished pairing, key and all (and kept the finished one)');
  ok(ws.frames('phx_leave', ph4.wire).length === 1, 'and left its channel');
  // revoked while a request is still being checked (its narrower check waits for /state): it never goes on
  await tick(A.timers, 16e3, ws);
  holdPaths.add('/state');
  const nAdd = seenFor('/repos/add').length;
  ph.send(ws, { t: 'req', id: 'race1', at: clock.t, m: 'POST', p: '/repos/add', b: { path: KNOWN } });
  ok(await waitUntil(() => (held.get('/state') || []).length === 1), 'a request waits on its check (/state)');
  [code, out] = await relay.revoke(ph.dev);
  ok(code === 200 && out.id === ph.dev, `revoke: ${code}`);
  release('/state', STATE);
  holdPaths.delete('/state');
  await sleep(100);
  ok(seenFor('/repos/add').length === nAdd && !ph.answers(ws, 'race1').length, 'the request of a device revoked while it was checked never reaches the server, and is not answered');
  const notices = ph.read(ws).filter((m) => m.t === 'notice');
  ok(notices.length === 1 && notices[0].kind === 'revoked' && /^[A-Za-z0-9_-]{1,32}$/.test(notices[0].id), 'revoke sends notice revoked');
  ok(ws.frames('phx_leave', ph.wire).length === 1, 'then leaves the channel');
  ok(!(ph.dev in JSON.parse(A.keyStore.peek())) && (ph3.dev in JSON.parse(A.keyStore.peek())), 'and deletes its key (only its)');
  ok(!JSON.parse(fs.readFileSync(devicesFile, 'utf8')).devices.some((dv) => dv.id === ph.dev), 'devices.json no longer lists it');
  const sentNow = ws.sent.length;
  ph.send(ws, { t: 'req', id: 'gone1', at: clock.t, m: 'GET', p: '/api/status' });
  await sleep(60);
  ok(ws.sent.length === sentNow, 'a revoked device is never answered');
  [code] = await relay.revoke(ph.dev);
  ok(code === 404, 'revoking it again: 404');

  // the log
  const logText = fs.readFileSync(path.join(A.logDir, 'relay.log'), 'utf8');
  const lines = logText.trim().split('\n');
  ok(lines.length > 1200 && lines.every((l) => /^\S+Z [A-Za-z0-9_-]{16} (GET|POST|PUT|HELLO|\?) \S+ \d{3} \d+ms \d+B$/.test(l)), `relay.log: one line a message, time device method path status ms bytes (${lines.find((l) => !/^\S+Z [A-Za-z0-9_-]{16} (GET|POST|PUT|HELLO|\?) \S+ \d{3} \d+ms \d+B$/.test(l))})`);
  const secretBits = [API_TOKEN, RELAY_KEY, 'test-access-token', ph.j.k, ph3.j.k, hs1.k.toString('base64url'), hs3.k.toString('base64url'), 'fleetview://', 'plain text', 'Henry', imgB.data.slice(0, 50), '?'];
  ok(secretBits.every((s) => !logText.includes(s)), `relay.log holds no token, key, link, body or query (${secretBits.filter((s) => logText.includes(s))})`);
  const serverLog = A.logs.join('\n');
  ok(secretBits.slice(0, 8).every((s) => !serverLog.includes(s)), 'nor do its lines for server.log');

  // stop: the paired phones are told
  await relay.stop('pc-closing');
  const closing = ph3.read(ws).filter((m) => m.t === 'notice');
  ok(closing.length === 1 && closing[0].kind === 'pc-closing', 'stop(\'pc-closing\') sends notice pc-closing');
  ok(ws.closed && ws.closed.code === 1000, 'and closes the socket');
  ok(A.sync.listeners.size === 0, 'and stops listening to S1');
  [code] = await relay.pair('after');
  ok(code === 503, 'a stopped relay pairs nothing');

  // ---------- backoff: refused joins, a socket that keeps dropping ----------
  // a phone paired before a restart: devices.json and the key store are read at the start (a device with no key is
  // dropped: it must pair again)
  // (and no relayKey: it sends no marker, and says so once)
  const B = { dataDir: path.join(T, 'b'), sync: fakeSync(), keyStore: memStore(), timers: makeTimers(), port, logs: [], relayKey: undefined };
  const devB = 'QkJCQkJCQkJCQkJC', devNoKey = 'TlROTlROTlROTlRO', devV1 = 'VjFWMVYxVjFWMVYx', KB = crypto.randomBytes(32);
  fs.mkdirSync(path.join(B.dataDir, 'relay'), { recursive: true });
  fs.writeFileSync(path.join(B.dataDir, 'relay', 'devices.json'), JSON.stringify({ v: 1, devices: [
    { id: devB, name: 'Paired before', state: 'paired', createdAt: clock.t - 1000, pairedAt: clock.t - 1000 },
    { id: devNoKey, name: 'No key', state: 'paired', createdAt: clock.t - 1000, pairedAt: clock.t - 1000 },
    { id: devV1, name: 'Paired by protocol v1', state: 'paired', createdAt: clock.t - 1000, pairedAt: clock.t - 1000 },
  ] }));
  // a protocol v1 key (a bare K) is not read: that phone pairs again
  await B.keyStore.write(JSON.stringify({ [devB]: { k: KB.toString('base64url') }, [devV1]: crypto.randomBytes(32).toString('base64url') }));
  const optsB = relayOpts(B);
  const relayB = R.createRelay(optsB);
  nSock = sockets.length;
  relayB.start();
  await settle();
  ok(sockets.length === nSock + 1, 'a device paired before the restart: the relay connects at the start');
  eq((await relayB.status()).devices.map((dv) => [dv.id, dv.state, dv.finished]), [[devB, 'paired', true]], 'devices.json and its key read back; the one with no key, and the v1 one, dropped');
  ok(B.logs.some((l) => l.includes(devNoKey) && /pair it again/.test(l)) && B.logs.some((l) => l.includes(devV1) && /pair it again/.test(l)), 'and that is said in the log');
  let wsB = lastSocket();
  wsB.open();
  await settle();
  const refuse = () => acceptJoins(wsB, 'error', { reason: 'Unauthorized: You do not have permissions to read from this Channel topic: fleet:x' });
  const joinTimes = [];
  const t0 = clock.t;
  for (let s = 0; s < 600; s++) {
    const n0 = wsB.frames('phx_join').length;
    refuse();
    await settle();
    await tick(B.timers, 1000, wsB);
    if (wsB.frames('phx_join').length > n0) joinTimes.push(clock.t - t0);
  }
  refuse();
  await settle();
  const stB = await relayB.status();
  ok(stB.devices[0].channel === 'refused' && /Unauthorized/.test(stB.devices[0].problem || ''), `a refused join shows in the status (${JSON.stringify(stB.devices[0])})`);
  const gaps = joinTimes.map((t, i) => t - (i ? joinTimes[i - 1] : 0));
  ok(wsB.frames('phx_join').length <= 18 && gaps.slice(0, 6).join(',') === '1000,2000,4000,8000,16000,32000' && gaps.slice(6).every((g) => g === 60000), `refused joins back off 1 s doubling to 60 s (${wsB.frames('phx_join').length} joins in 10 minutes; gaps ${gaps.join(',')})`);
  ok(!wsB.closed, 'the socket itself stays up');
  await tick(B.timers, 70e3, wsB);
  const unanswered = (await relayB.status()).devices[0];
  ok(unanswered.channel === 'refused' && unanswered.problem === 'no answer to the join', `a join with no answer in 10 s is tried again later (${JSON.stringify(unanswered)})`);
  for (let s = 0; s < 61 && (await relayB.status()).devices[0].channel !== 'joined'; s++) {
    await tick(B.timers, 1000, wsB);
    acceptJoins(wsB);
    await settle();
  }
  ok((await relayB.status()).devices[0].channel === 'joined', `once a join is let in, it is joined (${JSON.stringify((await relayB.status()).devices[0])})`);
  // no relayKey: nothing marked, the phone's via dropped all the same, and the log says it once
  // (the phone holds KB as its own key: its K' from an earlier handshake)
  const phB = makePhone(R.pairLink({ url: SB_URL, key: SB_KEY, uid: UID, email: '', pcName: 'TEST-PC', dev: devB, k: KB.toString('base64url'), exp: 0 }));
  for (const id of ['nk1', 'nk2']) {
    r = await phB.ask(wsB, 'POST', `/api/sessions/${SID}/message`, { id, b: { text: 'no key', via: 'phone' } });
    last = seenFor(`/api/sessions/${SID}/message`).pop();
    ok(r && r.s === 200 && last.body.text === 'no key' && !('via' in last.body) && last.headers['x-fleet-view-relay'] === undefined, `no relayKey: a message goes unmarked (${id}: ${r && r.s})`);
  }
  const noKeyLines = B.logs.filter((l) => /no relay key/.test(l));
  ok(noKeyLines.length === 1, `no relayKey: said once in the log (${noKeyLines.length})`);
  ok(!A.logs.some((l) => /no relay key/.test(l)), 'with a relayKey: never said');
  // relayKey is asked at each request; a key that could not go in a header, or a throw, means no marker
  const keyCases = [[() => RELAY_KEY, true], [() => 'short', false], [() => `${RELAY_KEY}\r\nX-Evil: 1`, false], [() => { throw new Error('no key'); }, false], [() => 42, false]];
  for (const [i, [fn, want]] of keyCases.entries()) {
    optsB.relayKey = fn;
    await tick(B.timers, 1001, wsB);
    r = await phB.ask(wsB, 'POST', `/api/sessions/${SID}/message`, { id: `kk${i}`, b: { text: 'k' } });
    last = seenFor(`/api/sessions/${SID}/message`).pop();
    const got = last.headers['x-fleet-view-relay'] === RELAY_KEY && last.body.via === 'phone';
    ok(r && r.s === 200 && got === want && (want || (last.headers['x-fleet-view-relay'] === undefined && !('via' in last.body) && !('x-evil' in last.headers))), `relayKey case ${i}: ${want ? 'marked' : 'unmarked'} (${r && r.s} ${got})`);
  }
  ok(B.logs.filter((l) => /no relay key/.test(l)).length === 1, 'and the log still said it once');
  nSock = sockets.length;
  const sockTimes = [];
  const s0 = clock.t;
  wsB.drop();
  for (let s = 0; s < 40; s++) {
    await B.timers.advance(1000);
    if (sockets.length > nSock) { sockTimes.push(clock.t - s0); nSock = sockets.length; lastSocket().drop(); }
  }
  const sGaps = sockTimes.map((t, i) => t - (i ? sockTimes[i - 1] : 0));
  eq(sGaps.slice(0, 5), [1000, 2000, 4000, 8000, 16000], 'a socket that keeps dropping is opened again 1 s, 2 s, 4 s... later');
  await B.timers.advance(70e3);
  wsB = lastSocket();
  wsB.open();
  await settle();
  acceptJoins(wsB);
  await tick(B.timers, 30e3, wsB);
  nSock = sockets.length;
  wsB.drop();
  await B.timers.advance(1000);
  ok(sockets.length === nSock + 1, 'after a healthy socket (heartbeat answered) the backoff starts at 1 s again');
  await relayB.stop();

  // ---------- v2 across a restart: the PC goes down after it answered a handshake, before any envelope under K' ----------
  const PP = { dataDir: path.join(T, 'p'), sync: fakeSync(), keyStore: memStore(), timers: makeTimers(), port, logs: [] };
  // a relay on PP's folder and key store, its socket open and its joins let in (first: pairs a phone, which is
  // what makes it connect) -> [relay, socket, the pairing's answer]
  const upRelay = async (first) => {
    const rl = R.createRelay(relayOpts(PP));
    const n0 = sockets.length;
    rl.start();
    await settle();
    const paired = first ? (await rl.pair('Restart phone'))[1] : null;
    await settle();
    ok(sockets.length === n0 + 1, 'the relay opened a socket');
    const s = lastSocket();
    s.open();
    await settle();
    acceptJoins(s);
    await settle();
    return [rl, s, paired];
  };
  let [relayP, wsP, pairedP] = await upRelay(true);
  const phP = makePhone(pairedP.link);
  const hsP1 = await phP.handshake(wsP, 'p1');
  ok(hsP1.r && hsP1.r.s === 200 && hsP1.k, 'a handshake, answered');
  await relayP.stop();
  await tick(PP.timers, 1001, null);
  [relayP, wsP] = await upRelay();
  eq((await relayP.status()).devices.map((dv) => [dv.state, dv.finished]), [['paired', false]], 'after the restart: paired, not finished');
  // its answer "lost" too: a hello again under K after the restart makes another K', and the first one still works
  const hsP2 = await phP.handshake(wsP, 'p2');
  ok(hsP2.r && hsP2.r.s === 200 && hsP2.k && !hsP2.k.equals(hsP1.k), 'K still opens a hello after the restart (until its time is up)');
  phP.use(hsP1.k);
  r = await phP.ask(wsP, 'GET', '/api/status', { id: 'p3' });
  ok(r && r.s === 200, `the K' from before the restart works (${r && r.s})`);
  eq(JSON.parse(PP.keyStore.peek()), { [phP.dev]: { k: hsP1.k.toString('base64url') } }, 'and is the key now, K forgotten');
  phP.inject(wsP, phP.envUnder(phP.K, { t: 'hello', id: 'p4', at: clock.t, app: '1', device: 'x', epk: R.xPair().pub.toString('base64url') }));
  r = await phP.answer(wsP, 'p4');
  ok(r && r.s === 403 && /already paired/.test(r.b.message), `K: 403 already paired (${r && r.s})`);
  await relayP.stop();
  await tick(PP.timers, 1001, null);
  [relayP, wsP] = await upRelay();
  const dP = (await relayP.status()).devices[0].dropped;
  phP.inject(wsP, phP.envUnder(phP.K, { t: 'hello', id: 'p5', at: clock.t, app: '1', device: 'x', epk: R.xPair().pub.toString('base64url') }));
  phP.inject(wsP, phP.envUnder(hsP2.k, { t: 'req', id: 'p6', at: clock.t, m: 'GET', p: '/api/status' }));
  await sleep(60);
  ok(!phP.answers(wsP, 'p5').length && !phP.answers(wsP, 'p6').length && (await relayP.status()).devices[0].dropped === dP + 2, 'after another restart K and the other K\' open nothing at all');
  r = await phP.ask(wsP, 'GET', '/api/status', { id: 'p7' });
  ok(r && r.s === 200, `and K' does (${r && r.s})`);
  await relayP.stop();

  // ---------- /relay/* and the CLI, over loopback ----------
  // the relay is told the port its server listens on: the Origin it takes is http://127.0.0.1:<that port>
  let relayC = null;
  const pageCtx = {
    sendJson: (res, c, o) => { res.writeHead(c, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(o)); },
    readBody: (req, res, done) => { const parts = []; req.on('data', (b) => parts.push(b)); req.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'); } catch {} done(j); }); },
    remote: (req) => (req.headers['x-test-remote'] ? { name: 'pc.example.ts.net', login: 'someone', device: 'a Mac' } : null),
  };
  const srvC = http.createServer((req, res) => (req.url.startsWith('/relay/') ? relayC.handle(req, res, pageCtx) : pageCtx.sendJson(res, 404, { ok: false })));
  await new Promise((rs) => srvC.listen(0, '127.0.0.1', rs));
  const portC = srvC.address().port;
  const C = { dataDir: path.join(T, 'c'), sync: fakeSync(), keyStore: memStore(), timers: makeTimers(), port: portC };
  relayC = R.createRelay(relayOpts(C));
  relayC.start();
  const call = (method, p, body, headers = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const rq = http.request({ host: '127.0.0.1', port: portC, method, path: p, headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}), ...headers } }, (rs) => {
      const parts = [];
      rs.on('data', (b) => parts.push(b));
      rs.on('end', () => resolve({ status: rs.statusCode, text: Buffer.concat(parts).toString('utf8') }));
    });
    rq.on('error', reject);
    rq.end(data || undefined);
  });
  let h = await call('POST', '/relay/pair', { name: 'x' });
  ok(h.status === 403, `POST /relay/pair with no Origin: 403 (${h.status})`);
  h = await call('POST', '/relay/pair', { name: 'x' }, { Origin: 'http://evil.example' });
  ok(h.status === 403, 'with another Origin: 403');
  h = await call('GET', '/relay/status', undefined, { 'x-test-remote': '1' });
  ok(h.status === 403, 'GET /relay/status from a remote browser: 403');
  h = await call('GET', '/relay/pair');
  ok(h.status === 405, 'GET /relay/pair: 405');
  const outs = [], errs = [];
  const io = { dataDir: C.dataDir, port: portC, out: (t) => outs.push(t), err: (t) => errs.push(t) };
  ok((await R.cli(['pair', '--name', 'CLI phone'], io)) === 0, `node relay.js pair: ${errs.join(' ')}`);
  const pairPage = path.join(C.dataDir, 'relay', 'pair.html');
  const pageText = fs.existsSync(pairPage) ? fs.readFileSync(pairPage, 'utf8') : '';
  const cDev = (await relayC.status()).devices[0];
  const cKey = JSON.parse(C.keyStore.peek())[cDev.id].k;
  ok(pageText.includes('<svg') && pageText.includes('TEST-PC') && pageText.includes('henry@example.com') && !pageText.includes('fleetview:') && !pageText.includes(cKey), 'pair.html: the QR code, the PC and the account, never the link or the key');
  ok(/pairs one phone/.test(pageText) && /opens nothing after that/.test(pageText) && !/works once/.test(pageText), 'pair.html says what the code does: it pairs one phone, and opens nothing once the phone made its own key');
  ok(outs.join('\n').includes(cDev.id) && !outs.join('\n').includes('fleetview:') && !outs.join('\n').includes(cKey), 'the CLI prints the id and the page, never the link');
  h = await call('GET', '/relay/status');
  const sj = JSON.parse(h.text);
  ok(h.status === 200 && sj.enabled === true && sj.signedIn === true && sj.email === 'henry@example.com' && sj.connected === false && sj.devices.length === 1, `GET /relay/status: ${h.text.slice(0, 200)}`);
  ok(!h.text.includes(cKey) && !h.text.includes('fleetview:'), 'the status holds no key and no link');
  outs.length = 0;
  ok((await R.cli(['status'], io)) === 0 && /Signed in to sync as henry@example.com/.test(outs.join('\n')) && outs.join('\n').includes('CLI phone'), `node relay.js status: ${outs.join(' | ')}`);
  outs.length = 0;
  ok((await R.cli(['devices'], io)) === 0 && outs.some((l) => l.startsWith(cDev.id)), 'node relay.js devices');
  outs.length = 0;
  ok((await R.cli(['revoke', cDev.id], io)) === 0 && (await relayC.status()).devices.length === 0, 'node relay.js revoke <id>');
  errs.length = 0;
  ok((await R.cli(['revoke', 'nope'], io)) === 1 && /no such device/.test(errs.join(' ')), 'revoking an unknown id: exit 1');
  await tick(C.timers, 31e3, null);
  ok(!fs.existsSync(pairPage), 'pair.html is deleted once no pairing waits');
  ok((await R.cli(['bogus'], io)) === 2, 'an unknown command: usage, exit 2');
  errs.length = 0;
  const deadPort = await new Promise((rs) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p2 = s.address().port; s.close(() => rs(p2)); }); });
  ok((await R.cli(['status'], { ...io, port: deadPort })) === 1 && /not running/.test(errs.join(' ')), 'with no Fleet View on the port: exit 1, "not running"');
  await relayC.stop();
  srvC.close();

  // ---------- local mode: pairing with no sync, the Wi-Fi listener (relay-lan.js) on a real socket ----------
  // the addresses it would bind in use: the private IPv4 ones only, a real adapter's first, 192.168 before 10 before 172
  const LANM = require(path.join(ROOT, 'relay-lan.js'));
  const nic = (address, family = 'IPv4', internal = false) => ({ address, family, internal });
  eq(LANM.privateIPv4s({ 'vEthernet (WSL)': [nic('172.20.0.1')], 'Wi-Fi': [nic('fe80::1', 'IPv6'), nic('172.16.5.5'), nic('192.168.1.20')], Ethernet: [nic('10.0.0.5', 4)],
    'Loopback Pseudo-Interface 1': [nic('127.0.0.1', 'IPv4', true)], Tailscale: [nic('100.64.1.2')], Public: [nic('8.8.8.8')], Odd: [nic('172.32.0.1'), nic('169.254.3.4')] }),
  ['192.168.1.20', '10.0.0.5', '172.16.5.5'], 'the listener\'s addresses: private IPv4 only (no loopback, CGNAT, public, link-local), the Wi-Fi\'s first, no virtual adapter while a real one has one');
  eq(LANM.privateIPv4s({ 'vEthernet (External)': [nic('192.168.1.30')], 'vEthernet (WSL)': [nic('172.20.0.1')], Tailscale: [nic('100.64.1.2')] }),
    ['192.168.1.30', '172.20.0.1'], 'with only virtual adapters (a Hyper-V external switch), theirs are all there is');
  ok(['10.1.2.3', '172.31.0.1', '192.168.0.1'].every(LANM.isPrivate) && !['172.15.0.1', '192.169.0.1', '0.0.0.0', '256.1.1.1', '127.0.0.1'].some(LANM.isPrivate), 'isPrivate: RFC 1918 only');

  // a friend's install: sync not set up at all. The listener binds only what lanHosts gives (127.0.0.1 here; in use,
  // this PC's private addresses)
  const lanPort = await freePort();
  let lanAddrs = ['127.0.0.1'];
  const L = { dataDir: path.join(T, 'lan'), sync: fakeSync(), keyStore: memStore(), timers: makeTimers(), port, logs: [], lanPort, lanHosts: () => lanAddrs, lanLimits: { perDevice: 2, proveMs: 1500 } };
  L.sync.on = false;
  let relayL = R.createRelay(relayOpts(L));
  nSock = sockets.length;
  relayL.start();
  await settle();
  let stL = await relayL.status();
  ok(stL.lan && stL.lan.port === lanPort && stL.lan.listening.length === 0 && L.keyStore.reads === 0, `local: nothing paired, nothing listening and no key read (${JSON.stringify(stL.lan)})`);
  let lanAns = await httpGet(lanPort, '/');
  ok(lanAns.status === 0, `local: nothing answers on the Wi-Fi port before a local pairing (${lanAns.status} ${lanAns.error})`);
  [code, out] = await relayL.pair('x', 'bogus');
  ok(code === 400, `pair with a bad mode: 400 (${code})`);
  lanAddrs = [];
  [code, out] = await relayL.pair('x', 'local');
  ok(code === 409 && /home network/.test(out.message), `local pairing with no private address: 409 (${code} ${out.message})`);
  lanAddrs = ['127.0.0.1'];
  [code, out] = await relayL.pair('x');
  ok(code === 409 && /set it up/.test(out.message), `relay pairing (the default mode) still needs sync: 409 (${code})`);
  [code, out] = await relayL.pair('Wi-Fi iPhone', 'local');
  ok(code === 200 && out.ok && out.mode === 'local' && out.svg.startsWith('<svg'), `local pairing with sync off: 200 (${code} ${out.message || ''})`);
  const lp = makeLanPhone(out.link);
  eq({ ...lp.j, dev: '-', k: '-' }, { v: 2, mode: 'local', hosts: ['127.0.0.1'], port: lanPort, pcName: 'TEST-PC', dev: '-', k: '-', exp: out.exp }, 'the local link\'s JSON: no Supabase url, key, uid or email');
  ok(!/supabase|henry@example/.test(Buffer.from(new URL(out.link).searchParams.get('d'), 'base64url').toString('utf8')), 'the local link names no Supabase project and no account');
  eq(R.pairLink({ mode: 'local', hosts: ['192.168.1.20'], port: 4779, pcName: 'P', dev: 'd', k: 'k', exp: 1 }), `fleetview://pair?d=${Buffer.from(JSON.stringify({ v: 2, mode: 'local', hosts: ['192.168.1.20'], port: 4779, pcName: 'P', dev: 'd', k: 'k', exp: 1 })).toString('base64url')}`, 'pairLink: the local link\'s keys in the contract\'s order');
  ok(sockets.length === nSock, 'local pairing opened no Supabase socket');
  devs = JSON.parse(fs.readFileSync(path.join(L.dataDir, 'relay', 'devices.json'), 'utf8')).devices;
  eq(devs.map((d) => [d.id, d.mode, d.state]), [[lp.dev, 'local', 'pending']], 'devices.json remembers the mode');
  stL = await relayL.status();
  eq([stL.lan.listening, stL.devices[0].mode, stL.devices[0].channel], [['127.0.0.1'], 'local', 'closed'], 'status: listening on the private addresses, the device local and not connected');

  // what anyone on the network gets: a bare 404 for everything but the upgrade of a known local device
  lanAns = await httpGet(lanPort, '/');
  ok(lanAns.status === 404 && lanAns.text === '' && !lanAns.headers.date && !lanAns.headers.server, `GET /: a bare 404 (${lanAns.status} ${JSON.stringify(lanAns.headers)})`);
  lanAns = await httpGet(lanPort, '/state');
  ok(lanAns.status === 404 && lanAns.text === '', 'GET /state on the Wi-Fi port: 404 (the server\'s routes are not there)');
  lanAns = await httpGet(lanPort, `/fleet/${lp.dev}`);
  ok(lanAns.status === 404, 'the device\'s path without the upgrade: 404');
  for (const [what, p, h] of [['another path', '/live', {}], ['an unknown device', '/fleet/AAAAAAAAAAAAAAAA', {}], ['a query', `/fleet/${lp.dev}?x=1`, {}],
    ['another Host (DNS rebinding)', `/fleet/${lp.dev}`, { Host: `evil.example:${lanPort}` }], ['a page\'s Origin', `/fleet/${lp.dev}`, { Origin: 'http://evil.example' }],
    ['version 8', `/fleet/${lp.dev}`, { 'Sec-WebSocket-Version': '8' }], ['a bad key', `/fleet/${lp.dev}`, { 'Sec-WebSocket-Key': 'nope' }]]) {
    const c = await wsConnect(lanPort, p, h);
    ok(c.status === 404 && !/fleet|TEST-PC|1\.0\.99/i.test(c.head.replace(/^HTTP[^\r]*/, '')), `upgrade with ${what}: 404 and nothing else (${c.status})`);
    c.close();
  }
  let lc = await lp.connect(lanPort, { Origin: `http://127.0.0.1:${lanPort}` });
  ok(lc.status === 101, `the known device's upgrade, with the Origin a phone sends: 101 (${lc.status})`);
  await sleep(50);
  ok(lc.msgs.length === 0, 'nothing comes down before an envelope opened');
  // an unmasked frame, garbage, an oversized frame (refused from its header), another device's envelope: closed
  lc.raw(clientFrame(0x1, Buffer.from('{}'), { unmasked: true }));
  await waitUntil(() => lc.closeCode !== null, 2000);
  ok(lc.closeCode === 1002 && lc.msgs.length === 0, `an unmasked frame: closed 1002 (${lc.closeCode})`);
  lc.close();
  lc = await lp.connect(lanPort);
  lc.raw(clientFrame(0x1, Buffer.alloc(0), { len: R.C_MAX + 4096 }));
  await waitUntil(() => lc.closeCode !== null, 2000);
  ok(lc.closeCode === 1009, `a frame longer than an envelope may be: closed 1009 from its header alone (${lc.closeCode})`);
  lc.close();
  lc = await lp.connect(lanPort);
  lc.send({ v: 1, d: lp.dev, dir: 'up', n: 'AAAAAAAAAAAAAAAA', z: 0, c: 'AAAAAAAAAAAAAAAAAAAAAAAA' });
  await waitUntil(() => lc.closeCode !== null, 2000);
  ok(lc.closeCode === 1008 && lc.msgs.length === 0, `an envelope that does not open, on a socket that never proved itself: closed 1008, unanswered (${lc.closeCode})`);
  lc.close();
  lc = await lp.connect(lanPort);
  // the relay topic's AAD (fleet:<uid>:<dev>) does not open on the Wi-Fi: the topics are apart
  lc.send(lp.env({ t: 'hello', id: 'x1', at: clock.t, app: '1', device: 'x', epk: R.xPair().pub.toString('base64url') }, lp.K, `fleet:${UID}:${lp.dev}`));
  await waitUntil(() => lc.closeCode !== null, 2000);
  ok(lc.closeCode === 1008 && lc.msgs.length === 0, `an envelope sealed for the Supabase topic: closed, unanswered (${lc.closeCode})`);
  lc.close();
  lc = await lp.connect(lanPort);
  await waitUntil(() => lc.ended, 4000);
  ok(lc.ended && lc.closeCode === 1008 && !lc.msgs.length, `a socket that sends nothing is closed when its time to prove itself runs out (${lc.closeCode})`);

  // the whole thing over the socket: the v2 handshake under K, then K', then requests through the same checks
  lc = await lp.connect(lanPort);
  const lhs = await lp.handshake(lc, 'lh1');
  ok(lhs.r && lhs.r.s === 200 && lhs.r.b.paired === true && lhs.k, `local: the handshake's hello under K over the socket: 200 with the PC's epk (${lhs.r && lhs.r.s})`);
  lp.key = lhs.k;
  lc.send(lp.env({ t: 'hello', id: 'lh2', at: clock.t, app: '1.0.0', device: 'Wi-Fi iPhone' }));
  r = await lp.answer(lc, 'lh2');
  eq(r && { s: r.s, b: r.b }, { s: 200, b: { paired: true, pcName: 'TEST-PC', version: '1.0.99', device: null, platform: process.platform } }, 'local: a hello under K\' finishes the pairing');
  eq(JSON.parse(L.keyStore.peek()), { [lp.dev]: { k: lhs.k.toString('base64url') } }, 'local: the key store holds K\' alone');
  stL = await relayL.status();
  ok(stL.devices[0].state === 'paired' && stL.devices[0].finished === true && stL.devices[0].channel === 'joined', `status: paired, finished, connected (${JSON.stringify(stL.devices[0])})`);
  await tick(L.timers, 1001, null);
  const nStateL = seenFor('/state').length;
  r = await lp.ask(lc, 'GET', '/state');
  ok(r && r.s === 200 && r.b.repos[0].root === KNOWN && seenFor('/state').length === nStateL + 1, `local: GET /state over the Wi-Fi reaches the server and comes back (${r && r.s})`);
  last = seenFor('/state').pop();
  ok(last && !last.headers.origin && !last.headers.authorization, 'and goes to the server like a Supabase one (no Origin, no token on a page GET)');
  r = await lp.ask(lc, 'GET', '/relay/status');
  ok(r && r.s === 403, `local: the allowlist holds (/relay/status: ${r && r.s})`);
  r = await lp.ask(lc, 'GET', '/file', { q: { path: path.join(HOME, '.ssh', 'id_ed25519') } });
  ok(r && r.s === 403, `local: the fence holds (~/.ssh: ${r && r.s})`);
  r = await lp.ask(lc, 'POST', `/api/sessions/${SID}/message`, { b: { text: 'from the Wi-Fi', via: 'phone' } });
  last = seenFor(`/api/sessions/${SID}/message`).pop();
  ok(r && r.s === 200 && last.body.via === 'phone' && last.headers['x-fleet-view-relay'] === RELAY_KEY && last.headers.authorization === `Bearer ${API_TOKEN}`, `local: a marked route is marked by the relay, as through Supabase (${r && r.s})`);
  // a replay of an envelope that went: dropped, unanswered
  const replayEnv = lp.env({ t: 'req', id: 'lrep', at: clock.t, m: 'POST', p: '/rename', b: { id: SID, name: 'w' } });
  lc.send(replayEnv);
  r = await lp.answer(lc, 'lrep');
  const nRen = renames;
  lc.send(replayEnv);
  await sleep(80);
  ok(r && r.s === 200 && renames === nRen && lp.read(lc).filter((m) => m.id === 'lrep').length === 1, 'local: a replayed envelope is dropped, never run or answered twice');
  // an old envelope (a capture replayed after a restart, or past the nonce window) opens but is not fresh: it proves
  // nothing, so the socket it came on is closed like a stranger's and can't hold one of the device's places
  const lcOld = await lp.connect(lanPort);
  lcOld.send(lp.env({ t: 'hello', id: 'lold', at: clock.t - 60 * 60e3, app: '1.0.0', device: 'Wi-Fi iPhone' }));
  await waitUntil(() => lcOld.closeCode !== null, 2000);
  ok(lcOld.closeCode === 1008 && !lcOld.msgs.length, `local: a stale envelope proves nothing: its socket closed 1008, unanswered (${lcOld.closeCode})`);
  lcOld.close();
  // a second socket: its answers go down it, not the first
  const lc2 = await lp.connect(lanPort);
  lc2.send(lp.env({ t: 'hello', id: 'lh3', at: clock.t, app: '1.0.0', device: 'Wi-Fi iPhone' }));
  ok(await lp.answer(lc2, 'lh3'), 'a second socket proves itself with a hello');
  const before1 = lc.msgs.length;
  r = await lp.ask(lc2, 'GET', '/api/status');
  await sleep(50);
  ok(r && r.s === 200 && lc.msgs.length === before1, 'its answer goes down the socket the request came on, and no other');
  // a device's sockets are capped (2 in this test): a new one pushes out one not proven yet, never a proven one
  const lc3 = await lp.connect(lanPort);
  ok(lc3.status === 0 || lc3.status === -1 || (await waitUntil(() => lc3.ended, 1000)), `with both places proven, a third socket gets nothing (${lc3.status})`);
  lc2.close();
  for (let i = 0; i < 100 && (await relayL.status()).lan.sockets !== 1; i++) await sleep(10);
  const lc4 = await lp.connect(lanPort);
  const lc5 = await lp.connect(lanPort);
  ok(lc4.status === 101 && lc5.status === 101 && (await waitUntil(() => lc4.ended, 1000)) && !lc.ended, 'a new socket pushed out the one not proven yet, and the proven one stayed');
  lc5.close();

  // the Supabase socket opens only for a relay-mode device, with sync signed in
  L.sync.on = true;
  L.sync.emit('signed-in');
  await settle();
  await tick(L.timers, 10, null);
  ok(sockets.length === nSock, 'sync signed in but only a local device paired: still no Supabase socket');
  ok(!lc.ended && (await relayL.status()).lan.listening.length === 1, 'and the Wi-Fi socket and listener are untouched by the sign-in');
  [code, out] = await relayL.pair('Relay phone');
  ok(code === 200 && out.mode === 'relay' && sockets.length === nSock + 1, `a relay-mode pairing next to it opens the Supabase socket (${code})`);
  ok(JSON.parse(Buffer.from(new URL(out.link).searchParams.get('d'), 'base64url').toString('utf8')).url === SB_URL, 'and its link is the Supabase one');
  [code] = await relayL.revoke(out.id);
  await tick(L.timers, 10, null);
  ok(code === 200 && lastSocket().closed, 'revoking it closes the Supabase socket again (no relay-mode device left)');
  L.sync.on = false;
  L.sync.emit('signed-out');
  await settle();

  // a restart: the listener comes back for the paired local device with sync off; stop says pc-closing first
  await relayL.stop('pc-closing');
  await waitUntil(() => lc.ended, 3000);
  ok(lp.read(lc).some((m) => m.t === 'notice' && m.kind === 'pc-closing') && lc.closeCode === 1001, `stop('pc-closing'): the notice down the Wi-Fi socket, then it closes (${lc.closeCode})`);
  lanAns = await httpGet(lanPort, '/');
  ok(lanAns.status === 0, 'a stopped relay stops listening');
  relayL = R.createRelay(relayOpts(L));
  relayL.start();
  await settle(20);
  for (let i = 0; i < 200 && (await relayL.status()).lan.listening.length !== 1; i++) await sleep(10);
  lc = await lp.connect(lanPort);
  await tick(L.timers, 1001, null);
  r = await lp.ask(lc, 'GET', '/api/status');
  ok(r && r.s === 200, `after a restart, with sync still off, the paired local phone gets through (${r && r.s})`);
  // revoke: the notice, the socket closed, the device unknown to the listener, and the listener off
  [code] = await relayL.revoke(lp.dev);
  await waitUntil(() => lc.ended, 3000);
  ok(code === 200 && lp.read(lc).some((m) => m.t === 'notice' && m.kind === 'revoked') && lc.closeCode === 1000, `revoke a local device: notice revoked, then its socket closed (${lc.closeCode})`);
  ok(!JSON.parse(L.keyStore.peek() || '{}')[lp.dev], 'its key is deleted');
  lanAns = await httpGet(lanPort, '/');
  ok(lanAns.status === 0 && (await relayL.status()).lan.listening.length === 0, 'with no local device left, the listener is off');
  const logL = fs.readFileSync(path.join(L.dataDir, 'relay.log'), 'utf8');
  ok(![lp.j.k, lhs.k.toString('base64url'), 'fleetview://', 'from the Wi-Fi'].some((x) => logL.includes(x)), 'relay.log holds no key, link or body for the local device either');
  await relayL.stop();

  // ---------- publish-share.js's guard, in a throwaway repo ----------
  const G = path.join(T, 'share-guard');
  const copy = (rel) => { fs.mkdirSync(path.dirname(path.join(G, rel)), { recursive: true }); fs.copyFileSync(path.join(ROOT, rel), path.join(G, rel)); };
  const mine = ['relay.js', 'relay-lan.js', 'ws-frames.js', 'scripts/relay-test.js', 'web/vendor/qrcode/qrcode.js', 'web/vendor/qrcode/LICENSE', 'docs/phone.md', 'docs/phone-vectors.json', 'scripts/phone-vectors.js'];
  for (const f of ['scripts/publish-share.js', 'version.js', 'platform.js', ...mine]) copy(f);
  const gEnv = { ...ENV0, GIT_AUTHOR_NAME: 'relay test', GIT_AUTHOR_EMAIL: 'relay@test', GIT_COMMITTER_NAME: 'relay test', GIT_COMMITTER_EMAIL: 'relay@test', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args) => { const x = cp.spawnSync('git', ['-C', G, ...args], { encoding: 'utf8', env: gEnv, windowsHide: true }); if (x.status !== 0) throw new Error(`git ${args.join(' ')}: ${x.stderr}`); return x.stdout.trim(); };
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'relay');
  const p = cp.spawnSync(process.execPath, [path.join(G, 'scripts', 'publish-share.js'), '--test', 'guard-check', '--ref', 'HEAD', '--dry-run'], { encoding: 'utf8', env: gEnv, windowsHide: true });
  ok(p.status === 0 && mine.every((f) => p.stdout.split(/\r?\n/).includes(f)), `the share guard passes relay.js, this test, the QR library and the docs: ${p.status} ${p.stderr.slice(0, 400)}`);
}

// ---------- --live: a throwaway v2 pairing on the real Realtime ----------
// the sync folder's files as name -> size and mtime, to show the test changed nothing there
function folderStamp(dir) {
  const out = {};
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { try { const s = fs.statSync(p); out[path.relative(dir, p)] = `${s.size} ${s.mtimeMs}`; } catch {} }
    }
  };
  walk(dir);
  return out;
}
async function live() {
  const SYNC_API = require(path.join(ROOT, 'sync-api.js'));
  const P = require(path.join(ROOT, 'platform.js'));
  const dataDir = P.dataDir();
  const syncDir = path.join(dataDir, 'sync');
  const before = folderStamp(syncDir);
  const sync = SYNC_API.createSync({ dataDir });
  const st = await sync.status();
  if (!st.configured || !st.signedIn) { console.log('live: skipped (sync S1 is not set up and signed in on this PC)'); return; }
  // S1 renews the token when under a minute is left: this test (40 s at most) must not be the one that does
  const left = st.expiresAt ? Date.parse(st.expiresAt) - Date.now() : 0;
  if (left < 3 * 60e3) { console.log('live: skipped (the access token is due for renewal; the server renews it, not this test)'); return; }
  if (typeof WebSocket !== 'function') { console.log('live: skipped (this node has no WebSocket)'); return; }
  const hideUid = (t) => String(t).replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, '<uid>');
  // a stand-in Fleet View on a spare port: the relay forwards the phone's request here
  const fake = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, live: true, path: req.url })); });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const tmp = path.join(T, 'live');
  const relay = R.createRelay({ port: fake.address().port, dataDir: tmp, sync, apiToken: () => 'live-test-api-token', version: 'live-test', pcName: 'relay-test', keyStore: memStore(), readConfig: () => SYNC_API.readConfig(dataDir), log: (t) => console.log(`live: ${hideUid(t)}`) });
  let phoneWs = null, dv = null;
  try {
    relay.start();
    const [code, out] = await relay.pair('relay-test --live');
    ok(code === 200, `live: a throwaway pairing (${code} ${out.message || ''})`);
    if (code !== 200) return;
    const end = Date.now() + 20e3;
    while (Date.now() < end) {
      dv = (await relay.status()).devices[0];
      if (dv && (dv.channel === 'joined' || dv.channel === 'refused')) break;
      await sleep(200);
    }
    console.log(`live: the PC's channel is ${dv ? dv.channel : 'unknown'}${dv && dv.problem ? `: ${hideUid(dv.problem)}` : ''}`);
    ok(dv && (dv.channel === 'refused' || dv.channel === 'joined'), 'live: Supabase answered the PC\'s phx_join (refused until 0376 is applied, or joined)');
    if (!dv || dv.channel !== 'joined') return;

    // the phone: its own socket on the same account, presence key phone, the v2 handshake, then a request under K'
    const j = JSON.parse(Buffer.from(new URL(out.link).searchParams.get('d'), 'base64url').toString('utf8'));
    const K = Buffer.from(j.k, 'base64url'), topic = `fleet:${j.uid}:${j.dev}`, wire = `realtime:${topic}`;
    const cfg = SYNC_API.readConfig(dataDir).config;
    phoneWs = new WebSocket(`${cfg.url.replace(/^http/, 'ws')}/realtime/v1/websocket?apikey=${encodeURIComponent(cfg.key)}&vsn=1.0.0`);
    const inbox = [];
    let joined = null, ref = 0;
    phoneWs.onmessage = (ev) => {
      let f = null;
      try { f = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')); } catch { return; }
      if (f.topic !== wire) return;
      if (f.event === 'phx_reply' && f.ref === '1') joined = f.payload && f.payload.status;
      if (f.event === 'broadcast' && f.payload && f.payload.event === 'e') inbox.push(f.payload.payload);
    };
    await new Promise((resolve, reject) => { phoneWs.onopen = resolve; phoneWs.onerror = () => reject(new Error('the phone socket did not open')); });
    phoneWs.send(JSON.stringify({ topic: wire, event: 'phx_join', ref: '1', join_ref: '1', payload: {
      config: { broadcast: { ack: false, self: false }, presence: { key: 'phone', enabled: true }, postgres_changes: [], private: true },
      access_token: await sync.accessToken(),
    } }));
    ref = 1;
    await waitUntil(() => joined, 10e3);
    ok(joined === 'ok', `live: the phone's join (${joined})`);
    if (joined !== 'ok') return;
    const send = (key, msg) => phoneWs.send(JSON.stringify({ topic: wire, event: 'broadcast', ref: String(++ref), join_ref: '1',
      payload: { type: 'broadcast', event: 'e', payload: R.seal(R.dirKey(key, 'up'), topic, j.dev, 'up', msg) } }));
    // the answer to id under key, opened
    const answer = async (key, id, ms = 15e3) => waitUntil(() => {
      for (const env of inbox) {
        const text = R.open(R.dirKey(key, 'down'), topic, j.dev, 'down', env);
        if (text === null) continue;
        const m = JSON.parse(text);
        if (m.t === 'res' && m.id === id) return m;
      }
      return null;
    }, ms);
    const mine = R.xPair();
    send(K, { t: 'hello', id: 'live-h1', at: Date.now(), app: 'relay-test', device: 'relay-test --live', epk: mine.pub.toString('base64url') });
    const hs = await answer(K, 'live-h1');
    ok(hs && hs.s === 200 && hs.b.paired === true && typeof hs.b.epk === 'string', `live: the handshake's answer under K (${hs && hs.s})`);
    if (!hs || !hs.b.epk) return;
    const K2 = R.pairedKey(K, mine.priv, Buffer.from(hs.b.epk, 'base64url'));
    const t0 = Date.now();
    send(K2, { t: 'req', id: 'live-r1', at: t0, t0, m: 'GET', p: '/api/status' });
    const r1 = await answer(K2, 'live-r1');
    ok(r1 && r1.s === 200 && r1.b && r1.b.live === true, `live: a request under K' reached the PC and came back (${r1 && r1.s})`);
    ok((await relay.status()).devices[0].finished === true, 'live: the pairing finished');
    send(K, { t: 'hello', id: 'live-h2', at: Date.now(), app: 'relay-test', device: 'x', epk: R.xPair().pub.toString('base64url') });
    const h2 = await answer(K, 'live-h2');
    ok(h2 && h2.s === 403 && h2.b.paired === false, `live: the QR's K after that: 403 already paired (${h2 && h2.s})`);
  } finally {
    if (dv) await relay.revoke(dv.id).catch(() => {});
    await relay.stop();
    try { if (phoneWs) phoneWs.close(1000, 'done'); } catch {}
    fake.close();
    const after = folderStamp(syncDir);
    ok(JSON.stringify(after) === JSON.stringify(before), `live: nothing in the sync folder changed (${Object.keys(after).length} files)`);
  }
}

const run = process.argv.includes('--live') ? live : main;
run().catch((e) => { failures++; console.log(`FAIL the test crashed: ${e && e.stack}`); }).finally(() => {
  try { fv.close(); if (fv.closeAllConnections) fv.closeAllConnections(); } catch {}
  if (process.env.RELAY_TEST_KEEP !== '1') { try { fs.rmSync(T, { recursive: true, force: true }); } catch {} } else console.log(`kept ${T}`);
  console.log(`${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
});
