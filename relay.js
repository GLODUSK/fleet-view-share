// relay.js: the phone relay, the PC side of docs/phone.md (the contract; docs/phone-vectors.json holds its crypto).
// Fleet View for iPhone never calls this server's routes itself. The phone and this PC (Sync with Blackbox) both join
// one private Supabase Realtime Broadcast channel per phone; works anywhere. Nothing goes in the database: Supabase only
// carries envelopes it can't read. Everything below (the keys, the handshake, nonces, skew, the allowlist, the fence,
// every limit, the marker) goes through onEnvelope: the relay answers each encrypted request by calling this server's
// own routes over loopback, and the answer goes back on the channel. A device's AAD topic is fleet:<uid>:<dev>.
//
// Supabase is off unless sync S1 (sync-api.js) is set up and signed in AND a phone is paired (or being paired).
// Before that it opens no socket and reads no key.
// Host-agnostic: the port, the data and log folders, the S1 instance, the API token, the version and the PC's name all
// come in through createRelay's opts, so it can move with the session host to a cloud box later. S1's config (url,
// publishable key) is read again on every (re)connect, never kept.
//
// The channel: Phoenix over one WebSocket, vsn 1.0.0, as realtime-js 2.112 sends it (read in its source:
// RealtimeClient.ts _initializeOptions, whose 1.0.0 encoder is JSON.stringify of { topic, event, payload, ref,
// join_ref }; RealtimeChannel.ts subscribe, track and send; @supabase/phoenix socket.js endPointURL and the heartbeat):
//   wss://<project>.supabase.co/realtime/v1/websocket?apikey=<publishable key>&vsn=1.0.0
//   join      { topic: 'realtime:fleet:<uid>:<dev>', event: 'phx_join', ref, join_ref: ref, payload: { config:
//             { broadcast: { ack: false, self: false }, presence: { key: 'pc', enabled: true }, postgres_changes: [],
//             private: true }, access_token } } -> phx_reply { status: 'ok' | 'error', response }
//   heartbeat { topic: 'phoenix', event: 'heartbeat', payload: {}, ref } every 25 s; no reply by the next one: reconnect
//   token     { event: 'access_token', payload: { access_token } } on every joined channel when S1 renews it (checked at
//             each heartbeat, as realtime-js does, and on S1's 'refreshed')
//   send      { event: 'broadcast', payload: { type: 'broadcast', event: 'e', payload: <envelope> } }, and received so
//   presence  { event: 'presence', payload: { type: 'presence', event: 'track', payload: { role: 'pc', v: 1, at } } }
//             after each join; presence_state / presence_diff naming the key 'phone' set the device's lastSeen
//   A refused or failed join, phx_error or phx_close is joined again 1 s, 2 s, 4 s ... 60 s later (per channel), and a
//   dropped socket reconnects the same way, so refused joins (0376 not applied yet) never spin.
//
// What it does with a message (docs/phone.md has the why):
//   envelope  AES-256-GCM with HKDF-SHA256 direction keys, AAD 'fleet-view relay v1|<topic>|<d>|<dir>|<z>', z=1 raw
//             DEFLATE over 1024 bytes. Up: a ciphertext over C_MAX b64u characters is dropped before it is decoded, an
//             inflate stops at 2 MB, and at most 4 inflate at once per device (32 more wait, the rest are dropped).
//             Anything that doesn't open is dropped and counted, and never answered; so is a nonce seen in the last 10
//             minutes, an `at` more than 5 minutes off, or one from before the relay started.
//   hello     protocol v2 (docs/phone.md "Pairing"): a hello under the QR's K carries the phone's X25519 key (epk); the
//             relay makes its own, keeps K' = HKDF-SHA256(K || X25519 secret, info 'fleet-view relay v2 paired')
//             before it answers 200 { paired: true, pcName, version, device, platform, epk }, and the first envelope
//             under a K' makes it the device's key and forgets K (K then gets 403 "already paired"). A hello under the
//             device's own key: 200 { paired: true, pcName, version, device, platform }. device is this machine's sync
//             device id (<dataDir>/sync/device.json while sync is set up, else null), platform process.platform: a
//             phone paired with several machines sends each chat's requests to the machine that hosts it. One code makes at most 8 handshakes, one per 5 s (429
//             { retryAfter }; past 8, 403 { paired: false }), and a device whose K' never came before K's time ran out
//             is dropped by the sweep, key and all
//   req       the allowlist below, then http.request to 127.0.0.1:<port>: page POSTs with Origin
//             http://127.0.0.1:<port>, /api/* with Authorization: Bearer <API token> and no Origin (api.js refuses
//             one). The relay makes every header itself: no header the phone names is passed on, and its etag
//             (printable text) is the one value that goes in one, as If-None-Match. JSON answers as b, text/* as
//             b + ct, anything else as standard base64 b64 + ct; etag <-> If-None-Match / ETag (304: no body).
//   time      30 s a route, 60 s when the body asks to wait (wait capped at 50 s). Longer where the server starts or
//             resumes a Claude before it answers (api.js START_MS, 60 s, then it settles and types): 95 s for POST
//             /api/sessions, /api/bots (it makes the bot and starts it), /api/bots/:id/start and the page's /bots/:id/watch (a
//             new watch or job starts the bot first, then tells it); 75 s for POST /api/sessions/:id/message and
//             /open and the team routes that send a brief or an order (deliverText resumes one not running): POST
//             /api/teams, /api/teams/:id/add, /lead and /message, the page's /teams, /teams/add and /teams/lead. Those
//             two get the body's wait (at most 50 s) on top: 145 s and 125 s at most. Shorter for the chat's verbs:
//             GET /api/sessions/:id/activity 5 s, POST /api/sessions/:id/now, /enter and /background 10 s, /model and
//             /mode 20 s (/unsend 30 s); /rewind 60 s (it walks up Claude Code's /rewind list a press at a time). POST
//             /api/sessions/:id/fork starts a Claude (a fork) and answers once it started, so it gets the 95 s too.
//   marker    "via": "phone" in the body and X-Fleet-View-Relay: <opts.relayKey()> (api.js viaOf: what Henry sent
//             from his phone, which a bot takes as his, and what makes, changes or removes a bot or switches an
//             overseer's model) on the routes api.js reads it on (MARKED): POST /api/sessions,
//             /api/sessions/:id/message, /answer, /open, /model, /mode, /rewind and /fork, /api/teams/:id/message, /api/bots,
//             /api/bots/:id and /api/bots/:id/remove. Set only once every check
//             above and the allowlist's passed; a via the phone sent is dropped from every body first. No
//             opts.relayKey (or a bad one): no marker, said in the log once.
//   id        the retry key: each id's answer is kept 10 minutes, so a repeat gets it again and a repeat of one still
//             running is ignored. GET answers past a 16 MB budget per device are let go first: a repeat of one of
//             those runs again, which a GET may. A POST sent again (t0, its first attempt's time, before at) whose id
//             has no kept answer and whose first attempt went before the relay started gets 409 { restarted: true },
//             or 9 minutes or more ago 409 { expired: true }, without running: it may have run already.
//   part      a message over 400,000 UTF-16 units goes in slices (never between the halves of a surrogate pair), at
//             most 64; from the phone at most 21,000,000 in all, 4 being put together per device, 60 s each
//   limits    per device: 20 requests in flight; 30 envelopes a second and 1,200 a minute (every one that opens:
//             requests, their repeats, parts, hellos); the routes that start or resume a Claude 2 at once and 12 in
//             10 minutes (a fork from a message one; a team one per member; a message to a conversation that opens one /state says is not
//             running 1, a team message one per member not running); 64 MB of answers being read at once. Over one: 429 with
//             b.retryAfter (ms), not kept
//   revoke    notice 'revoked', leave, delete the key; a request of its still being checked never goes on.
//             stop('pc-closing') sends notice 'pc-closing' on every channel
//
// The allowlist (docs/phone.md's, mirrored in ALLOW) and where the relay is narrower than the route itself, because a
// loopback request looks like this PC's own page to the server: a root the phone names must be one Fleet View already
// lists (/state's repos, its removed workspaces, its added repos), so a phone can't make a new folder "known":
//   POST /settings      only repo, repos, hidden, hiddenRepos, finishedOpen and the list features' repoNames, repoOrder,
//                       forgotten and the Bots list's chatOrder (anything else: 403 for the whole request); repo and each repos entry that
//                       is a path, and each hiddenRepos, repoNames and repoOrder root, must be a known root
//   POST /api/sessions  no role (403: a bot starts by /api/bots/:id/start)
//   POST /api/sessions/:id/now  no fields (403);  /unsend  only text (403), as api.js cleanText takes it (400);
//                       /model  only model, effort and queue (403): model and/or effort as api.js MODEL_RE and
//                       EFFORTS take them, queue true or false (400);  /message  now and shell, when there, true or
//                       false (400);  /enter  only text, as /unsend (403, 400);  /background  no fields (403);
//                       /mode  only mode (403), one of api.js MODES (400);
//                       /rewind  only text, nth and edit (403);  /fork  only text and nth (403), as a /rewind's (400);
//                       a fork counts one start
//   POST /chat/dynamic  (Dynamic for any chat: a part sized per message, on or off) only id, a conversation id, and
//                       model and/or effort, each true or false (403 for any other field, 400 for a bad one)
//   POST /upload        (a file from the phone: files.js upload, which saves it only in its uploads folder and answers
//                       its path) only the query's name, a plain file name (at most 200 characters, no / or \, no
//                       control character, no '..'), and the body's data, the file in standard base64, at most 15 MB
//                       (413; what one message from the phone holds as base64, under files.js's 200 MB), sent on as
//                       the raw body with this PC's Origin, as the page's browser upload (403 for any other field,
//                       400 for a bad one)
//   POST /api/bots, /api/bots/:id   only name, brief, role, account, model, effort, shape and color, as bots.js
//                       reads (anything else: 403);  POST /api/bots/:id/start and /remove  no fields at all (403). A
//                       bot id: 12 hex digits
//   POST /bots/:id/map  (the page's map) only at, null (off the map: its watches stop) or { x, y } finite numbers
//                       (403 for any other field, 400 for a bad at);  POST /bots/:id/watch  only id, a conversation
//                       id, and job, one of report, answer, review or null (stop watching) (403, 400)
//   POST /repos/add     path a known root;  POST /sessions/move  root null or a known root
//   POST /push-target   { id } or root a known root;  GET /repo-history  root a known root
//   POST /sync/move     only id (a conversation id) and force (true or false): Continue here for a chat whose host is
//                       off, asked of a machine that is on (403 for any other field, 400 for a bad one);  GET /sync/move
//                       id a conversation id (400)
//   GET /accounts       (fleet-view.js: accounts.js view(), local only) passes on only each letter's a, email and
//                       signedIn, and the sign-ins of A and B: status, message, and the claude.ai link while one waits
//   POST /accounts/add { letter }, /login { account }, /code { account, code }, /cancel { account }   (the Claude
//                       accounts screen) only that body (403), only for A or B (SIGNIN_LETTERS, the letters a synced
//                       conversation knows: 403 for any other), and only while that letter has no login on the PC as
//                       GET /accounts says it at that moment (403 "signed in already"; 503 when it can't be read): a
//                       signed-in letter is never signed in again, switched, relabeled or removed from the phone, and
//                       /accounts/remove (and anything else under /accounts) is not on the list at all
//   GET /file, /chat/kind (path), /chat/files (cwd), /chat/commands (cwd)   the phone's fence ("the phone's fence"
//                       below): only inside a workspace that is a known root or a conversation's repo root or repo
//                       folder that is a git checkout (not any folder a conversation ran in), never one that is a
//                       drive's top, the home folder or above it, in a dot-folder of the home folder (as named or where
//                       it really is), or in or around an app data folder (Fleet View's own among them) or a linked
//                       child of one; below it no dot-named step but .github, and no secret's name anywhere (403;
//                       /chat/commands goes on without its cwd). Folder listings and /chat/files leave those out, and
//                       a /file whose text holds a private key or a service account's key is 403
//   GET /conversation/image serves only a known conversation's pictures; POST /api/sessions checks its repo and
//   forkFrom, and the page's /teams routes take conversation ids.
//   Paths: the method and the whole path must match; ids match their patterns; '..', '//', '%', '?', '#', '\' refused.
//
// Devices: <dataDir>/relay/devices.json [{ id, name, mode: 'relay', state: 'pending' | 'paired', createdAt,
// exp?, pairedAt?, lastSeen?, app?, device?, kind?, peer? }] (app and device: what the phone's hello said; a file from
// before modes has no mode: relay; one with mode 'local', a phone paired on this PC's Wi-Fi before that way was taken
// out, is dropped at start with its key), no keys; the keys in sync-api.js's protectedStore(<dataDir>/relay,
// 'relay-keys') as one JSON object { <dev>: { k, qr? } } (see loadKeys).
// Computers (docs/link.md): another of Henry's machines, linked through link.js, is a device of kind 'computer' with
// peer: its sync device id. It never pairs with a QR code: link.js's pairing makes its key and adds it here paired
// (addComputer), and removeComputer (link.js unlink) revokes it like any device. It is served exactly like a phone
// (envelopes, replays, parts, limits, the marker, the fence), its presence key is 'peer', and it may also call
// PEER_ALLOW: the /peer/... routes, which go to the server with the marker's key and X-Fleet-View-Peer: <its peer>,
// so only the relay can reach them (fleet-view.js checks both). A phone may never call those.
// Log: <logDir>/relay.log, one line a message: time, device, method, path (no query), status, ms, bytes. Never a body,
// a key, a token or the pairing link.
//
// createRelay(opts) -> { start(), stop(reason) -> Promise, handle(req, res, ctx), status() -> Promise, pair(name,
// mode) -> Promise [code, json], revoke(id) -> Promise [code, json], addComputer({ dev, name, peer, key }) -> Promise
// of the device's view, removeComputer(peer, why) -> Promise of how many went, computers() -> [{ id, peer, name,
// pairedAt, lastSeen, channel }] }
//   opts: { port, dataDir, logDir, sync (createSync()'s instance), apiToken (a function giving it, or the token
//   file's path), relayKey (a function giving api.js's relayKey(), for the marker), version (string or function),
//   pcName, log(text), onComputerGone(peer) (a computer revoked with revoke(),
//   not through link.js: fleet-view.js has the link unlink it on both machines) } and, for tests: now, WebSocketImpl, timers
//   ({ setTimeout, clearTimeout }), keyStore (a store as sync-api.js's), readConfig(dataDir), routeMs, waitRouteMs,
//   startLimits ({ atOnce, max }, read at each request), resDeviceMax, uploadMax
// Routes (fleet-view.js sends /relay/* here; this PC only, never through the relay; POSTs need this page's Origin):
//   GET  /relay/status  { enabled, signedIn, email, connected, devices } (never a key; a device still pairing says how
//                       many handshakes its code made)
//   POST /relay/pair    { name?, mode?: 'relay' (the only one; 'local', the Wi-Fi way that is gone, gets 400) } ->
//                       { ok, id, mode, link, svg, exp }: the link (and its QR code) is shown once
//   POST /relay/revoke  { id }
// CLI (talks to the running server): node relay.js status | devices | pair [--name N] | revoke <id>
//   [--port 4777]. pair writes <dataDir>/relay/pair.html with the QR code (never prints the link); it is deleted once
//   no pairing waits.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const P = require(path.join(__dirname, 'platform.js'));
const SYNC_API = require(path.join(__dirname, 'sync-api.js'));

const LABEL = 'fleet-view relay v1'; // the envelope's (HKDF salt and AAD), the same in protocol v2
const PAIRED_INFO = 'fleet-view relay v2 paired'; // K' = HKDF-SHA256(ikm K || X25519 secret, no salt, this, 32)
const LINK_V = 2; // the pairing link's v: protocol v2 (the hello's handshake)
const PENDING_MS = 10 * 60e3; // a pairing waits this long for the phone's hello; K opens hellos this long after the last
const CANDS_MAX = 4; // the K' a device's handshakes made, kept until the first envelope under one of them
// handshakes per device: one per HS_GAP_MS (each makes a key pair and writes the key store), HS_MAX with one code
const HS_GAP_MS = 5e3, HS_MAX = 8;
const SKEW_MS = 5 * 60e3; // a message's `at` this far from our clock is dropped
const NONCE_MS = 10 * 60e3; // nonces remembered per device
const KEEP_MS = 10 * 60e3; // each id's answer
const KEEP_GET_BYTES = 16 << 20; // GET answers kept per device, at most (oldest let go first)
const KEEP_ONE_GET = 1 << 20; // a bigger GET answer is not kept at all
const KEEP_MAX = 15000; // ids remembered per device
// a POST sent again whose first attempt went before the relay started (give or take the way there), or so long ago
// that its kept answer may be gone, is answered 409 instead of running: it may have run already
const RESTART_SLACK_MS = 2000, EXPIRED_MS = KEEP_MS - 60e3;
const ROUTE_MS = 30e3, WAIT_ROUTE_MS = 60e3, WAIT_CAP_S = 50;
const START_ROUTE_MS = 95e3, RESUME_ROUTE_MS = 75e3; // routes that start or resume a Claude first (START_ROUTES, RESUME_ROUTES)
// the chat's verbs (api.js): the activity line (cheap, polled), send now, a model or effort switch (/model, /effort)
// and a Rewind or Edit (/rewind: "/rewind", then ↑ a press at a time up its list, each read back; api.js bounds the
// walk at 40 s)
const ACTIVITY_MS = 5e3, NOW_MS = 10e3, MODEL_MS = 20e3, REWIND_MS = 60e3;
const ZIP_MIN = 1024; // JSON over this many bytes goes compressed
const PART_MAX = 400000, PARTS_MAX = 64, ASSEMBLIES_MAX = 4, ASSEMBLY_MS = 60e3, UP_TEXT_MAX = 21000000;
// one message (or part) up is at most PART_MAX UTF-16 units of text, 3 bytes each in UTF-8, and its own fields: its
// envelope's ciphertext is at most that plus the tag, so a longer one (in b64u) is dropped before it is decoded, and
// one that inflates past INFLATE_UP_MAX is dropped too. open() (the vectors' reader) still stops at INFLATE_MAX
const PLAIN_MAX = PART_MAX * 3 + 1024;
const C_MAX = Math.ceil((PLAIN_MAX + 16) / 3) * 4;
const INFLATE_UP_MAX = 2 << 20, INFLATE_MAX = 64 << 20;
const UNPACKS_MAX = 4, UNPACK_WAIT_MAX = 32; // per device: envelopes inflating at once, and waiting to (a second's worth)
// per device: requests in flight; envelopes that opened (requests, their repeats, parts, hellos) a second and a minute
const IN_FLIGHT_MAX = 20, PER_S = 30, PER_MIN = 1200;
// per device, the routes that start or resume a Claude (startWeight): 2 at once, and 12 in 10 minutes (a team counts
// one per member, and the largest team has 12)
const STARTS_AT_ONCE = 2, STARTS_MAX = 12, STARTS_MS = 10 * 60e3;
// POST /upload (a file from the phone, files.js upload): at most 15 MB, what one message from the phone holds as base64
// (UP_TEXT_MAX), well under files.js's UPLOAD_MAX (200 MB); its name a plain file name of at most 200 characters
const UPLOAD_MAX = 15 << 20, UPLOAD_NAME_MAX = 200;
const RES_MAX = 32 << 20; // bytes read from the server for one answer
const RES_DEVICE_MAX = 64 << 20; // bytes of answers being read for one device at once (429 past it)
const HEARTBEAT_MS = 25e3, JOIN_MS = 10e3, BACKOFF_MIN = 1e3, BACKOFF_MAX = 60e3;
const SWEEP_MS = 30e3;
const PLACES_MS = 15e3; // what /state lists, for the narrower checks
const DEVICES_MAX = 20, PENDING_MAX = 5;
const LOG_MAX = 2 << 20;
const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const DEV_RE = /^[A-Za-z0-9_-]{16}$/;
const PHONE_RE = /^[A-Za-z0-9_-]{8,40}$/; // a phone's install id (pairing by sign-in, relay-lobby.js)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[A-Za-z0-9._~+/=-]{8,4096}$/;
const MARK_KEY_RE = /^[\x21-\x7e]{16,256}$/; // the marker's key goes in a header: printable ASCII only
const clip = (s, n = 200) => String(s == null ? '' : s).replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, n);
const arr = (x) => (Array.isArray(x) ? x : []);

// ---------- the envelope (docs/phone.md "The envelope") ----------
const b64u = (b) => Buffer.from(b).toString('base64url');
// strict: only the b64u alphabet, and it must encode back the same (no stray bits, no padding)
function fromB64u(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s)) return null;
  const b = Buffer.from(s, 'base64url');
  return b64u(b) === s ? b : null;
}
const dirKey = (k, dir) => Buffer.from(crypto.hkdfSync('sha256', k, Buffer.from(LABEL, 'utf8'), Buffer.from(dir, 'utf8'), 32));
const aadText = (topic, d, dir, z) => `${LABEL}|${topic}|${d}|${dir}|${z}`;
const topicOf = (uid, dev) => `fleet:${uid}:${dev}`;
// what a pairing asked for on this PC's Wi-Fi (mode 'local', which is gone) is told
const LOCAL_GONE = 'pairing on this Wi-Fi is no longer offered: update the Fleet View app and pair through sync (Sync with Blackbox)';
// one message (or its JSON text) -> an envelope, with key the direction's key (dirKey). o.z: 0 or 1 (default: 1 when
// the JSON is over ZIP_MIN bytes); o.nonce: 12 bytes (only the test vectors fix it)
function seal(key, topic, d, dir, msg, o = {}) {
  let plain = Buffer.from(typeof msg === 'string' ? msg : JSON.stringify(msg), 'utf8');
  const z = o.z === undefined ? (plain.length > ZIP_MIN ? 1 : 0) : o.z ? 1 : 0;
  if (z) plain = zlib.deflateRawSync(plain);
  const nonce = o.nonce || crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  c.setAAD(Buffer.from(aadText(topic, d, dir, z), 'utf8'));
  return { v: 1, d, dir, n: b64u(nonce), z, c: b64u(Buffer.concat([c.update(plain), c.final(), c.getAuthTag()])) };
}
// -> { plain (still deflated when z is 1), z } or null: wrong v, d or dir, bad base64, or it does not decrypt
function decrypt(key, topic, d, dir, env) {
  if (!env || typeof env !== 'object' || env.v !== 1 || env.d !== d || env.dir !== dir || (env.z !== 0 && env.z !== 1)) return null;
  const n = fromB64u(env.n);
  if (!n || n.length !== 12 || typeof env.c !== 'string' || env.c.length > C_MAX) return null;
  const c = fromB64u(env.c);
  if (!c || c.length < 16) return null;
  try {
    const dc = crypto.createDecipheriv('aes-256-gcm', key, n, { authTagLength: 16 });
    dc.setAAD(Buffer.from(aadText(topic, d, dir, env.z), 'utf8'));
    dc.setAuthTag(c.subarray(c.length - 16));
    return { plain: Buffer.concat([dc.update(c.subarray(0, c.length - 16)), dc.final()]), z: env.z };
  } catch { return null; }
}
// an envelope -> its plaintext JSON text, or null (the test vectors' reader; the relay itself inflates off the main
// thread, see unpack)
function open(key, topic, d, dir, env) {
  const r = decrypt(key, topic, d, dir, env);
  if (!r) return null;
  try { return (r.z ? zlib.inflateRawSync(r.plain, { maxOutputLength: INFLATE_MAX }) : r.plain).toString('utf8'); } catch { return null; }
}
// decrypt's result -> Promise of the message object, or null (an inflate past max, or not a JSON object)
function unpack(r, max = INFLATE_UP_MAX) {
  return new Promise((resolve) => {
    const parse = (buf) => {
      let j = null;
      try { j = JSON.parse(buf.toString('utf8')); } catch {}
      resolve(j && typeof j === 'object' && !Array.isArray(j) ? j : null);
    };
    if (!r.z) return parse(r.plain);
    zlib.inflateRaw(r.plain, { maxOutputLength: max }, (e, out) => (e ? resolve(null) : parse(out)));
  });
}
// ---------- the handshake (docs/phone.md "Pairing"): K' from the QR's K and an X25519 exchange ----------
// X25519 keys as their 32 raw bytes: node takes a private key as PKCS#8 and a public one as SPKI, each a fixed prefix
const X_PRIV = Buffer.from('302e020100300506032b656e04220420', 'hex'), X_PUB = Buffer.from('302a300506032b656e032100', 'hex');
const xPrivate = (raw) => crypto.createPrivateKey({ key: Buffer.concat([X_PRIV, raw]), format: 'der', type: 'pkcs8' });
const xPublic = (raw) => crypto.createPublicKey({ key: Buffer.concat([X_PUB, raw]), format: 'der', type: 'spki' });
const xRaw = (pub) => pub.export({ format: 'der', type: 'spki' }).subarray(X_PUB.length);
// a fresh key pair: { priv (a KeyObject), pub (32 raw bytes) }; raw: fixed private bytes (only the test vectors)
function xPair(raw) {
  const priv = raw ? xPrivate(raw) : crypto.generateKeyPairSync('x25519').privateKey;
  return { priv, pub: xRaw(crypto.createPublicKey(priv)) };
}
// K' = HKDF-SHA256(ikm = K || X25519(mine, theirs), no salt, info PAIRED_INFO, 32 bytes), or null when theirs is not a
// usable public key (not 32 bytes, or one whose shared secret is all zeros)
function pairedKey(K, priv, theirs) {
  if (!Buffer.isBuffer(theirs) || theirs.length !== 32) return null;
  let shared;
  try { shared = crypto.diffieHellman({ privateKey: priv, publicKey: xPublic(theirs) }); } catch { return null; }
  if (!shared.some((x) => x)) return null;
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.concat([K, shared]), Buffer.alloc(0), Buffer.from(PAIRED_INFO, 'utf8'), 32));
}
// a JSON text in slices of at most max UTF-16 units, never between the two halves of a surrogate pair
function slices(text, max = PART_MAX) {
  const out = [];
  for (let i = 0; i < text.length;) {
    let j = Math.min(text.length, i + max);
    if (j < text.length) { const c = text.charCodeAt(j - 1); if (c >= 0xd800 && c <= 0xdbff) j--; }
    out.push(text.slice(i, j));
    i = j;
  }
  return out;
}
// the pairing link: fleetview://pair?d=<b64u of the UTF-8 JSON>, its keys in the contract's order
function pairLink(o) {
  const j = { v: LINK_V, url: o.url, key: o.key, uid: o.uid, email: o.email, pcName: o.pcName, dev: o.dev, k: o.k, exp: o.exp };
  return `fleetview://pair?d=${b64u(Buffer.from(JSON.stringify(j), 'utf8'))}`;
}
// the link's QR code as SVG (web/vendor/qrcode: qrcode-generator 1.4.4, MIT), drawn here from its module matrix: one
// path, a run of dark modules per piece, with the standard 4-module quiet zone; error correction M
function qrSvg(text) {
  const qrcode = require(path.join(__dirname, 'web', 'vendor', 'qrcode', 'qrcode.js'));
  const qr = qrcode(0, 'M');
  qr.addData(String(text), 'Byte');
  qr.make();
  const n = qr.getModuleCount(), q = 4, size = n + 2 * q;
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n;) {
      if (!qr.isDark(r, c)) { c++; continue; }
      let e = c;
      while (e < n && qr.isDark(r, e)) e++;
      d += `M${c + q} ${r + q}h${e - c}v1h-${e - c}z`;
      c = e;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="Fleet View pairing code">`
    + `<rect width="${size}" height="${size}" fill="#fff"/><path fill="#000" d="${d}"/></svg>`;
}

// ---------- the allowlist (docs/phone.md "What the phone may call") ----------
const KEY = '(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|new-\\d{1,9})'; // a session id or new-<n>
const TEAM = 't[0-9a-f]{6,16}';
// a bot's id, as bots.js makes them (BOT_ID_RE) and api.js takes them; a task's id in its tasks.json, as fleet-view.js's
// route takes it (bot-tasks.js ID_RE)
const BOT = '[0-9a-f]{12}';
const TASK = '[A-Za-z0-9][A-Za-z0-9._-]{0,63}';
const ALLOW = {
  GET: ['/state', '/conversation', '/conversation/image', '/repo-history', '/chat/commands', '/chat/files', '/chat/kind', '/file',
    '/since', '/api/sessions', `/api/sessions/${KEY}`, `/api/sessions/${KEY}/(?:menu|transcript|activity)`, '/api/conversations',
    '/api/teams', '/api/status', '/accounts', '/sync/move'],
  POST: ['/api/sessions', `/api/sessions/${KEY}/(?:message|answer|interrupt|open|stop|remove|now|unsend|model|enter|background|mode|rewind|fork)`, '/api/teams',
    `/api/teams/${TEAM}/(?:add|remove|lead|disband|message)`, '/settings', '/rename', '/sessions/move', '/push-target',
    '/repos/remove', '/repos/add', '/chat/image', '/upload', '/teams', '/teams/(?:add|remove|leave|lead|rename)',
    '/api/bots', `/api/bots/${BOT}`, `/api/bots/${BOT}/(?:start|remove)`, `/bots/${BOT}/(?:switch|map|watch)`, `/bots/${BOT}/tasks/${TASK}`,
    '/accounts/(?:add|login|code|cancel)', '/sync/move', '/chat/dynamic'],
};
const ALLOW_RE = Object.fromEntries(Object.entries(ALLOW).map(([m, list]) => [m, new RegExp(`^(?:${list.join('|')})$`)]));
// what only a linked computer may call besides (docs/link.md): the /peer/... routes, which fleet-view.js serves to the
// relay alone (the marker's key and X-Fleet-View-Peer). GET /peer/status: who answers (its device and name) and its
// version. POST /peer/env and /peer/logins: the env files and sign-ins of a conversation this machine is handing over
// to that computer (fleet-view.js answers them only then: sync-move.js peer)
const PEER_ALLOW = {
  GET: ['/peer/status'],
  POST: ['/peer/env', '/peer/logins'],
};
const PEER_RE = Object.fromEntries(Object.entries(PEER_ALLOW).filter(([, list]) => list.length).map(([m, list]) => [m, new RegExp(`^(?:${list.join('|')})$`)]));
// the path alone: printable ASCII, no '..', '//', '%', '?', '#' or backslash
const pathOk = (p) => typeof p === 'string' && p.length <= 300 && p[0] === '/' && /^[\x21-\x7e]+$/.test(p)
  && !p.includes('..') && !p.includes('//') && !/[%?#\\]/.test(p);
const routeAllowed = (m, p) => !!ALLOW_RE[m] && pathOk(p) && ALLOW_RE[m].test(p);
// a /peer/... route only a computer may call (never a phone)
const peerRouteAllowed = (m, p) => !!PEER_RE[m] && pathOk(p) && PEER_RE[m].test(p);
const isPeerPath = (p) => typeof p === 'string' && p.startsWith('/peer/');
// what POST /settings may set from the phone (the Chats window's chatsBounds, chatsOpen, chatsOnTop are desktop state)
const SETTINGS_KEYS = new Set(['repo', 'repos', 'hidden', 'hiddenRepos', 'finishedOpen', 'repoNames', 'repoOrder', 'forgotten', 'chatOrder']);
// what a bot may be given from the phone (bots.js create and update read no more: role is its profile's role, text
// bots.js checks; shape and color are its avatar's look)
const BOT_KEYS = new Set(['name', 'brief', 'role', 'account', 'model', 'effort', 'shape', 'color']);
const BOT_ONE = new RegExp(`^/api/bots/${BOT}$`), BOT_ACT = new RegExp(`^/api/bots/${BOT}/(?:start|remove)$`);
// a dynamic bot's switch before a message (bots.js switchTo: { id, model?, effort? }), and an action on one of its
// tasks (bots.js taskAction: { action }; run sends it to the bot now, starting the bot first when it is not running)
const BOT_SWITCH = new RegExp(`^/bots/${BOT}/switch$`), BOT_TASK = new RegExp(`^/bots/${BOT}/tasks/${TASK}$`);
const TASK_ACTIONS = ['pause', 'resume', 'run', 'delete'];
// the map and watching (bots.js setMap: { at: { x, y } | null }; setWatch: { id, job }, a job of WATCH_JOBS or null to
// stop): a new watch or job starts the bot first, then tells it
const BOT_MAP = new RegExp(`^/bots/${BOT}/map$`), BOT_WATCH = new RegExp(`^/bots/${BOT}/watch$`);
const WATCH_JOBS = ['report', 'answer', 'review'];
// the Claude accounts screen: only the letters a synced conversation knows (sync-accounts.js SYNC_LETTERS, Blackbox's),
// and on each route only the body accounts.js route() reads for it: add { letter }, the others { account } (code also
// { code }). Every one only for a letter with no login (accountRefused); accountsAnswer: what GET /accounts passes on
const SIGNIN_LETTERS = ['A', 'B'];
const ACCOUNT_KEYS = { '/accounts/add': ['letter'], '/accounts/login': ['account'], '/accounts/code': ['account', 'code'], '/accounts/cancel': ['account'] };
// the chat's verbs: send now and run in background take nothing, unsend and Send it (enter) the message's text, a
// switch a model and/or an effort as api.js takes them (MODEL_RE, EFFORTS), the permission mode one of api.js MODES, a
// rewind the message's text, which of that text it is (nth) and an edit's text, a fork from a message the first two
const VERB_RE = new RegExp(`^/api/sessions/${KEY}/(now|unsend|model|message|enter|background|mode|rewind|fork)$`);
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9.\-\[\]]{0,59}$/, EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODES = ['default', 'acceptEdits', 'plan', 'auto', 'bypass'];
// a message's text as api.js cleanText takes it: line breaks made \n, then something besides spaces, and no control
// character but \n and \t
const textOk = (v) => typeof v === 'string' && !!v.trim() && !/[\x00-\x08\x0b-\x1f\x7f]/.test(v.replace(/\r\n|[\u0085\u2028\u2029]/g, '\n'));
// an upload's name: a plain file name (no folder in it, no control character, no '..'), at most UPLOAD_NAME_MAX
// characters; files.js cleanName makes it safe for Windows after
const uploadNameOk = (n) => typeof n === 'string' && !!n.trim() && n.length <= UPLOAD_NAME_MAX && !/[\\/\x00-\x1f\x7f]/.test(n) && !n.includes('..');
// standard base64 with its padding, and the bytes it holds (-1 when it is not that)
const b64Bytes = (s) => (typeof s === 'string' && s.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(s) ? (s.length / 4) * 3 - (s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0) : -1);
// POST routes api.js reads the relay's marker on (viaOf): text that reaches a Claude as Henry's (a shell command in an
// overseer's session too), and making, changing or removing a bot, switching a conversation's model or permission mode or
// rewinding or forking it (Henry's alone for an overseer)
const MARKED = new RegExp(`^/api/(?:sessions|sessions/${KEY}/(?:message|answer|open|model|mode|rewind|fork)|teams/${TEAM}/message|bots|bots/${BOT}|bots/${BOT}/remove)$`);
// POST routes that start a Claude before they answer (api.js startSession waits up to 60 s for it, settles, types;
// POST /api/bots makes the bot and starts it; a bot's watch starts it before it tells it; a fork from a message answers
// once the fork started, and goes back to the message after), and ones that may resume a stopped conversation first (up to 60 s
// too) before they type into it
const START_ROUTES = new RegExp(`^(?:/api/(?:sessions|sessions/${KEY}/fork|bots|bots/${BOT}/start)|/bots/${BOT}/(?:tasks/${TASK}|watch))$`);
const RESUME_ROUTES = new RegExp(`^(?:/api/sessions/${KEY}/(?:message|open)|/api/teams(?:/${TEAM}/(?:add|lead|message))?|/teams(?:/add|/lead)?)$`);
// the routes that start or resume a Claude, as the per-device start limits count them: one each, a team one per
// member (POST /api/teams and the page's /teams), a lead only when there is one (it gets its brief). A message to a
// conversation or a team weighs what it may resume (resumeWeight), not this
const STARTS_ONE = new RegExp(`^(?:/api/(?:sessions|sessions/${KEY}/(?:open|fork)|bots|bots/${BOT}/start|teams/${TEAM}/add)|/teams/add)$`);
const STARTS_LEAD = new RegExp(`^(?:/api/teams/${TEAM}/lead|/teams/lead)$`);
function startWeight(m, p, b) {
  if (m !== 'POST') return 0;
  const o = b && typeof b === 'object' && !Array.isArray(b) ? b : {};
  if (p === '/api/teams' || p === '/teams') return Math.min(STARTS_MAX, Math.max(1, new Set(arr(o.members).filter((x) => typeof x === 'string')).size));
  if (STARTS_LEAD.test(p)) return o.member == null ? 0 : 1;
  // a task's Run now starts its bot when it is not running
  if (BOT_TASK.test(p)) return o.action === 'run' ? 1 : 0;
  // a new watch or job starts its bot when it is not running; a stop starts nothing
  if (BOT_WATCH.test(p)) return o.job == null ? 0 : 1;
  return STARTS_ONE.test(p) ? 1 : 0;
}
// a message that may resume a stopped conversation first (api.js deliverText): POST /api/sessions/:id/message when
// it opens one (open: true, or a from without open, as api.js sendMessage reads them; a new-<n> is never resumed), and
// every team message (each member not running is resumed). -> 'msg', 'team' or null
const MSG_RE = new RegExp(`^/api/sessions/(${KEY})/message$`), TEAM_MSG_RE = new RegExp(`^/api/teams/(${TEAM})/message$`);
function resumeKind(m, p, b) {
  if (m !== 'POST' || typeof p !== 'string') return null;
  if (TEAM_MSG_RE.test(p)) return 'team';
  const mm = MSG_RE.exec(p), o = b && typeof b === 'object' && !Array.isArray(b) ? b : {};
  if (!mm || !UUID_RE.test(mm[1])) return null;
  return ('open' in o ? o.open === true : o.from != null) ? 'msg' : null;
}
// its weight, from /state (pl: placesFrom's live and teams): the conversation 1 unless a claude process has it open
// (openElsewhere); a team one per member not running (but its from), 1 when /state lists none of its members
function resumeWeight(pl, m, p, b) {
  const kind = resumeKind(m, p, b), live = (pl && pl.live) || new Map();
  if (kind === 'msg') return live.get(MSG_RE.exec(p)[1].toLowerCase()) === true ? 0 : 1;
  if (kind !== 'team') return 0;
  const members = ((pl && pl.teams) || new Map()).get(TEAM_MSG_RE.exec(p)[1]) || [];
  const from = b && typeof b.from === 'string' ? b.from.toLowerCase() : null;
  return members.length ? Math.min(STARTS_MAX, members.filter((id) => id !== from && live.get(id) !== true).length) : 1;
}
// how long a request may take on the server (ms); waitS: the wait the body asks, after the relay's cap (0: none)
function routeTimeout(m, p, waitS = 0, base = ROUTE_MS, waitBase = WAIT_ROUTE_MS) {
  const verb = (VERB_RE.exec(p) || [])[1] || (/\/activity$/.test(p) ? 'activity' : null);
  if (m === 'GET' && verb === 'activity') return ACTIVITY_MS;
  if (m === 'POST' && (verb === 'now' || verb === 'enter' || verb === 'background')) return NOW_MS;
  if (m === 'POST' && (verb === 'model' || verb === 'mode' || BOT_SWITCH.test(p))) return MODEL_MS;
  if (m === 'POST' && verb === 'rewind') return REWIND_MS;
  const long = m !== 'POST' ? 0 : START_ROUTES.test(p) ? START_ROUTE_MS : RESUME_ROUTES.test(p) ? RESUME_ROUTE_MS : 0;
  if (long) return long + waitS * 1000;
  return waitS ? waitBase : base;
}
// GET /file's target the way files.js reads it (an absolute path, ~, Git Bash's /c/... on Windows, or relative to
// cwd), or null (the server then refuses it itself)
function fileTarget(p, cwd) {
  let f = String(p == null ? '' : p).trim().replace(/^"(.*)"$/, '$1');
  if (!f || f.includes('\0')) return null;
  if (P.isWin) { const m = /^\/([a-z])(?:\/(.*))?$/i.exec(f); if (m) f = `${m[1].toUpperCase()}:\\${m[2] || ''}`; }
  if (/^~(?:[\\/]|$)/.test(f)) f = path.join(os.homedir(), f.slice(1));
  if (path.isAbsolute(f)) return path.resolve(f);
  const base = String(cwd == null ? '' : cwd);
  return base && path.isAbsolute(base) ? path.resolve(base, f) : null;
}
// p with links and short names resolved; one that does not exist (yet), its nearest existing folder's
function realOf(p) {
  const abs = path.resolve(p);
  try { return fs.realpathSync.native(abs); } catch {}
  const up = path.dirname(abs);
  return up === abs ? abs : path.join(realOf(up), path.basename(abs));
}
// p inside dir (or dir itself), links and short names resolved first, case folded where paths ignore case
const below = (rel) => rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
const within = (dir, p) => below(path.relative(P.foldCase(realOf(dir)), P.foldCase(realOf(p))));

// ---------- the phone's fence (docs/phone.md "What the phone may read") ----------
// GET /file, /chat/kind, /chat/files and /chat/commands' cwd: only inside a workspace (a root /state lists, or a
// conversation's repo root or repo folder that is a git checkout; not just any folder a conversation ran in), never a workspace that is a
// drive's top, the home folder or one above it, or one inside or around the app data folders; below the workspace no
// step named with a leading '.' (but .github), and no step with a secret's name anywhere. Listings leave out what
// the phone may not open.
const SECRET_RES = [/^\.env(?!\.example$)/i, /\.(?:pem|key|p8|p12|pfx|ppk|jks|keystore|kdbx|tfstate|tfstate\.backup|tfvars|gpg|asc|age|keychain-db)$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)/i, /credential/i, /(?:service[-_]?account|adminsdk).*\.json$/i];
const SECRET_NAMES = new Set(['google-services.json', 'googleservice-info.plist', '.npmrc', '.netrc', '_netrc', '.git-credentials', '.pypirc', 'hosts.yml',
  'secrets.json', 'secrets.yml', 'secrets.yaml', 'kubeconfig']);
// a file's text that holds a key whatever its name: a PEM private key, a service account's JSON
const SECRET_TEXT_RES = [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /"private_key"\s*:/, /"type"\s*:\s*"service_account"/];
const secretName = (n) => SECRET_NAMES.has(n.toLowerCase()) || SECRET_RES.some((re) => re.test(n));
// one step below a workspace the phone may name
const stepOk = (n) => !n || ((n[0] !== '.' || n.toLowerCase() === '.github') && !secretName(n));
// a path relative to a workspace, in either slash: every step one the phone may name
const stepsOk = (rel) => String(rel).split(/[\\/]/).every(stepOk);
// the folders no workspace may be in or hold: the app data folders (Fleet View's own among them: the API token, the
// sync sign-in, these keys), and their POSIX kin
function appDirs(dataDir) {
  const home = os.homedir(), env = process.env;
  const list = P.isWin ? [env.APPDATA, env.LOCALAPPDATA, env.PROGRAMDATA]
    : [path.join(home, 'Library'), env.XDG_CONFIG_HOME || path.join(home, '.config'), env.XDG_DATA_HOME || path.join(home, '.local', 'share'),
      env.XDG_STATE_HOME || path.join(home, '.local', 'state'), env.XDG_CACHE_HOME || path.join(home, '.cache')];
  return [...list, dataDir].filter((d) => typeof d === 'string' && d && path.isAbsolute(d));
}
// where the home folder's dot-entries and the app data folders' linked children really are: a link or junction may
// lead off them (~/.claude -> J:\Cache\ClaudeCode, %APPDATA%\Claude.junction-* -> J:\Cache\Claude), and a workspace
// named by the target escapes the rules that look at names. Read once per /state refresh (fenceOf), not per request
function linkedDirs() {
  const home = os.homedir(), env = process.env, out = [];
  const real = (p) => { try { return fs.realpathSync.native(p); } catch { return null; } };
  let names = [];
  try { names = fs.readdirSync(home); } catch {}
  for (const n of names) if (n[0] === '.') { const x = real(path.join(home, n)); if (x) out.push(x); }
  // a Mac's counterparts of %APPDATA% and %LOCALAPPDATA% too: an app's folder there may be a link (as Claude's is on
  // the PC), and those are a level below ~/Library
  const mac = P.isMac ? [path.join(home, 'Library', 'Application Support'), path.join(home, 'Library', 'Caches')] : [];
  for (const d of P.isWin ? [env.APPDATA, env.LOCALAPPDATA] : [...appDirs(null), ...mac]) {
    if (typeof d !== 'string' || !d || !path.isAbsolute(d)) continue;
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch {}
    for (const e of ents) if (e.isSymbolicLink()) { const x = real(path.join(d, e.name)); if (x) out.push(x); }
  }
  return out;
}
// a workspace the fence never opens: a drive's top (or /), the home folder or one above it, one in a dot-folder of
// the home folder (~/.ssh, ~/.claude, ~/.config...) as it is named or as it really is (linked: linkedDirs), or one in
// or around an app data folder or a linked child of one
function unsafeRoot(r, dataDir, linked = []) {
  const real = realOf(r), home = os.homedir();
  if (path.parse(real).root === real || path.parse(path.resolve(r)).root === path.resolve(r)) return true;
  if (within(r, home)) return true;
  for (const x of [path.resolve(r), real]) {
    const rel = path.relative(P.foldCase(realOf(home)), P.foldCase(x));
    if (below(rel) && rel.split(/[\\/]/)[0].startsWith('.')) return true;
  }
  return [...appDirs(dataDir), ...linked].some((d) => within(d, r) || within(r, d));
}

// a file written whole or not at all, readable by the user alone where that means something
function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch {} throw e; }
}

// ---------- the relay ----------
function createRelay(opts = {}) {
  const port = Number(opts.port) || 4777;
  const dataDir = opts.dataDir || P.dataDir();
  const logDir = opts.logDir || dataDir;
  const sync = opts.sync;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const T = opts.timers || { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h) };
  const later = (fn, ms) => { const h = T.setTimeout(fn, ms); if (h && typeof h.unref === 'function') h.unref(); return h; };
  const cancel = (h) => { if (h) T.clearTimeout(h); };
  const WS = opts.WebSocketImpl || globalThis.WebSocket;
  const readConfig = typeof opts.readConfig === 'function' ? opts.readConfig : SYNC_API.readConfig;
  const routeMs = Number(opts.routeMs) || ROUTE_MS, waitRouteMs = Number(opts.waitRouteMs) || WAIT_ROUTE_MS;
  const resDeviceMax = () => Number(opts.resDeviceMax) || RES_DEVICE_MAX; // read each time (tests change it)
  const uploadMax = () => Math.min(UPLOAD_MAX, Number(opts.uploadMax) || UPLOAD_MAX); // (the same)
  const relayDir = path.join(dataDir, 'relay');
  const devicesFile = path.join(relayDir, 'devices.json');
  const pairPage = path.join(relayDir, 'pair.html');
  const logFile = path.join(logDir, 'relay.log');
  const origin = `http://127.0.0.1:${port}`;
  const pcName = () => clip(opts.pcName || os.hostname(), 80);
  const version = () => { try { return String((typeof opts.version === 'function' ? opts.version() : opts.version) || ''); } catch { return ''; } };
  // this machine's sync device id (opts.device in tests), or null while sync is not set up here: a phone paired with
  // several machines matches a chat's host (/state's workspace.host, syncOwner) to the machine it should ask
  const deviceId = () => {
    try {
      if (typeof opts.device === 'function') { const d = opts.device(); return typeof d === 'string' && UUID_RE.test(d) ? d.toLowerCase() : null; }
      if (!sync.enabled()) return null;
      const j = JSON.parse(fs.readFileSync(path.join(SYNC_API.syncDir(dataDir), 'device.json'), 'utf8'));
      return j && typeof j.id === 'string' && UUID_RE.test(j.id) ? j.id.toLowerCase() : null;
    } catch { return null; }
  };
  // what a hello answers 200 with (the handshake adds its epk)
  const helloBody = () => ({ paired: true, pcName: pcName(), version: version(), device: deviceId(), platform: process.platform });
  if (!sync || typeof sync.enabled !== 'function') throw new Error('createRelay needs the sync instance (opts.sync)');
  let keyStore = opts.keyStore || null; // made on first use: on Windows it is DPAPI through PowerShell

  // ---------- the log ----------
  const onceSeen = new Map();
  // a line for server.log, at most once a minute for the same text
  function note(text) {
    const t = now(), seen = onceSeen.get(text);
    if (seen && t - seen < 60e3) return;
    if (onceSeen.size > 200) onceSeen.clear();
    onceSeen.set(text, t);
    log(`relay: ${text}`);
  }
  function logLine(dev, m, p, s, ms, bytes) {
    try {
      fs.mkdirSync(logDir, { recursive: true });
      try { if (fs.statSync(logFile).size > LOG_MAX) fs.renameSync(logFile, `${logFile}.1`); } catch {}
      fs.appendFileSync(logFile, `${new Date(now()).toISOString()} ${dev} ${m} ${p} ${s} ${Math.max(0, Math.round(ms))}ms ${bytes}B\n`);
    } catch {}
  }

  // ---------- devices ----------
  // id -> { id, name, mode (always 'relay': Supabase), state, createdAt, exp, pairedAt, lastSeen,
  //         app, device, gone,
  //         k (its key: the QR's K while qr, else its own K'), keys: { up, down } of k | null, qr, until (K opens hellos
  //         until then), cands: [{ k, up, down }] (the K' its handshakes made), hsN, hsAt (how many handshakes the
  //         QR's K made, and when the last), old: { up, down, until } (the QR's K
  //         after the pairing finished: only to answer "already paired"),
  //         ch, nonces, kept, keptGet, opened (when envelopes opened), inFlight, startLog: [[at, n]], starting,
  //         unpacking, unpackWait, resBytes, parts, dropped }
  const devices = new Map();
  let devicesDirty = false;
  const usable = (dv) => dv.state === 'paired' || (dv.state === 'pending' && dv.exp > now());
  // the topic in a device's AAD: fleet:<uid>:<dev>
  const topicFor = (dv) => topicOf(uid, dv.id);
  const isComputer = (dv) => dv.kind === 'computer';
  function makeDevice(o) {
    const computer = o.kind === 'computer' && typeof o.peer === 'string' && UUID_RE.test(o.peer);
    return {
      kind: computer ? 'computer' : 'phone', peer: computer ? o.peer.toLowerCase() : undefined,
      id: o.id, name: clip(o.name, 60) || (computer ? 'another computer' : 'iPhone'), mode: 'relay', state: o.state, createdAt: Number(o.createdAt) || now(),
      exp: o.state === 'pending' ? Number(o.exp) || 0 : undefined, pairedAt: Number(o.pairedAt) || undefined, lastSeen: Number(o.lastSeen) || undefined,
      app: o.app ? clip(o.app, 40) : undefined, device: o.device ? clip(o.device, 60) : undefined, gone: false,
      // the phone's install id when it paired by sign-in (relay-lobby.js): its next pairing here replaces this one
      phone: !computer && typeof o.phone === 'string' && PHONE_RE.test(o.phone) ? o.phone : undefined,
      k: null, keys: null, qr: false, until: 0, cands: [], hsN: 0, hsAt: 0, old: null,
      ch: { state: 'closed', topic: null, joinRef: null, backoff: BACKOFF_MIN, timer: null, refused: null },
      nonces: new Map(), kept: new Map(), keptGet: 0, opened: [], inFlight: 0, startLog: [], starting: 0,
      unpacking: 0, unpackWait: [], resBytes: 0, parts: new Map(), dropped: 0,
    };
  }
  // (a phone's has no kind: devices.json from before computers reads the same)
  const deviceView = (dv) => {
    const o = { id: dv.id, name: dv.name, mode: dv.mode, state: dv.state, createdAt: dv.createdAt };
    for (const k of ['exp', 'pairedAt', 'lastSeen', 'app', 'device', 'phone']) if (dv[k] !== undefined) o[k] = dv[k];
    if (isComputer(dv)) { o.kind = 'computer'; o.peer = dv.peer; }
    return o;
  };
  // -> the ids of phones paired on this PC's Wi-Fi (mode 'local', which is gone): left out here, and start() deletes
  // their keys and writes devices.json without them; such a phone pairs again through sync
  function loadDevices() {
    let j = null;
    const gone = [];
    try { j = JSON.parse(fs.readFileSync(devicesFile, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') note(`devices.json could not be read: ${e.message}`); return gone; }
    for (const o of arr(j && j.devices).slice(0, DEVICES_MAX)) {
      if (!o || !DEV_RE.test(String(o.id)) || (o.state !== 'pending' && o.state !== 'paired')) continue;
      if (o.mode === 'local') { gone.push(o.id); continue; }
      // a computer is only ever paired, and always names its peer
      if (o.kind === 'computer' && (o.state !== 'paired' || !(typeof o.peer === 'string' && UUID_RE.test(o.peer)))) continue;
      devices.set(o.id, makeDevice(o));
    }
    return gone;
  }
  function saveDevices() {
    devicesDirty = false;
    try { writeAtomic(devicesFile, `${JSON.stringify({ v: 1, devices: [...devices.values()].map(deviceView) }, null, 2)}\n`); } catch (e) { note(`devices.json could not be saved: ${e.message}`); }
  }
  // the keys: one JSON object in the protected store, read once. Per device { k: <b64u> }: its own key K' (paired);
  // or { k: <b64u K>, qr: { until, next: [<b64u K'>…], n? } }: still the QR's K, which opens hellos until `until`,
  // the K' its handshakes made, of which the first one an envelope comes under becomes its key, and how many
  // handshakes it made (n, when any: HS_MAX at most). (A protocol v1 entry, a
  // bare string, is not read: that phone pairs again.)
  let keys = null, keyWrites = Promise.resolve();
  const store = () => keyStore || (keyStore = SYNC_API.protectedStore(relayDir, 'relay-keys'));
  const key32 = (s) => { const b = fromB64u(s); return b && b.length === 32 ? b : null; };
  async function loadKeys() {
    if (keys) return keys;
    const text = await store().read();
    let j = {};
    try { j = text ? JSON.parse(text) : {}; } catch { note('the device keys could not be read: every phone must be paired again'); j = {}; }
    const m = new Map();
    for (const [dev, e] of Object.entries(j && typeof j === 'object' ? j : {})) {
      const k = e && typeof e === 'object' ? key32(e.k) : null;
      if (!DEV_RE.test(dev) || !k) continue;
      const qr = e.qr && typeof e.qr === 'object' ? { until: Number(e.qr.until) || 0, next: arr(e.qr.next).map(key32).filter(Boolean).slice(-CANDS_MAX), n: Math.max(0, Number(e.qr.n) || 0) } : null;
      m.set(dev, { k, qr });
    }
    keys = keys || m;
    return keys;
  }
  function saveKeys() {
    const text = JSON.stringify(Object.fromEntries([...keys].map(([dev, e]) => [dev, { k: b64u(e.k), ...(e.qr ? { qr: { until: e.qr.until, next: e.qr.next.map(b64u), ...(e.qr.n ? { n: e.qr.n } : {}) } } : {}) }])));
    const empty = !keys.size;
    keyWrites = keyWrites.catch(() => {}).then(() => (empty ? store().clear() : store().write(text)));
    return keyWrites;
  }
  const dirKeys = (k) => ({ up: dirKey(k, 'up'), down: dirKey(k, 'down') });
  // a device's keys from its key store entry
  function withKey(dv, e) {
    dv.k = e.k;
    dv.keys = dirKeys(e.k);
    dv.qr = !!e.qr;
    dv.until = e.qr ? e.qr.until : 0;
    dv.cands = e.qr ? e.qr.next.map((k) => ({ k, ...dirKeys(k) })) : [];
    dv.hsN = e.qr ? e.qr.n || 0 : 0;
  }
  // the device's key store entry from its keys
  const entryOf = (dv) => ({ k: dv.k, qr: dv.qr ? { until: dv.until, next: dv.cands.map((c) => c.k), n: dv.hsN } : null });
  // a device out, key and all (revoked, or a pairing that ran out); a request of its still on the way goes nowhere
  async function forgetDevice(dv, why) {
    dv.gone = true;
    leave(dv);
    devices.delete(dv.id);
    saveDevices();
    if (![...devices.values()].some((x) => x.state === 'pending')) removePairPage();
    try { await loadKeys(); if (keys.delete(dv.id)) await saveKeys(); } catch (e) { note(`the key of ${dv.id} could not be deleted: ${e.message}`); }
    note(`${dv.id} (${dv.name}) ${why}`);
  }

  // ---------- what /state lists, for the narrower checks ----------
  let places = null, placesLoading = null;
  const keyOf = (p) => P.foldCase(path.resolve(p));
  function placesFrom(st) {
    const roots = new Set(), listed = new Set(), ws = new Set(), live = new Map(), teams = new Map();
    const abs = (r) => typeof r === 'string' && r && path.isAbsolute(r);
    const root = (r) => { if (abs(r)) { roots.add(keyOf(r)); ws.add(path.resolve(r)); } };
    // a conversation's repo root or repo folder only when it is a git checkout (a .git folder, or a worktree's .git
    // file) or a root Fleet View lists: for a folder that is no repo, /state names the folder it ran in
    const gits = new Map();
    const isRepo = (d) => { const k = keyOf(d); if (!gits.has(k)) gits.set(k, roots.has(k) || fs.existsSync(path.join(d, '.git'))); return gits.get(k); };
    const work = (d) => { if (abs(d) && isRepo(path.resolve(d))) ws.add(path.resolve(d)); };
    const s = (st && st.settings) || {};
    for (const r of arr(st && st.repos)) root(r && r.root);
    for (const h of arr(s.hiddenRepos)) root(typeof h === 'string' ? h : h && h.root);
    for (const a of arr(s.addedRepos)) root(a && a.root);
    // a conversation's repo and repo folder are workspaces too; the folder it runs in is not (it may be the home folder)
    for (const x of arr(st && st.sessions)) {
      if (!x) continue;
      work(x.repo && x.repo.root);
      work(x.links && x.links.repoFolder);
      // what is running (a claude process has it open), and the teams' members, for the start limits (resumeWeight)
      if (typeof x.id !== 'string') continue;
      const id = x.id.toLowerCase();
      live.set(id, x.openElsewhere === true);
      if (typeof x.team === 'string') teams.set(x.team, [...(teams.get(x.team) || []), id]);
      // a mid-level lead: in the team it leads too (fleet-view.js sessionJson leads)
      if (typeof x.leads === 'string' && x.leads !== x.team) teams.set(x.leads, [...(teams.get(x.leads) || []), id]);
    }
    // the list features' order and names as the page keeps them, which the phone may send back unchanged
    const names = s.repoNames;
    for (const r of [...arr(s.repoOrder), ...arr(names).map((x) => x && x.root), ...(names && !Array.isArray(names) && typeof names === 'object' ? Object.keys(names) : [])]) if (abs(r)) listed.add(keyOf(r));
    return { roots, listed, ws: [...ws], live, teams, fence: null, at: now() };
  }
  async function placesNow(maxAge = PLACES_MS) {
    if (places && now() - places.at < maxAge) return places;
    if (!placesLoading) {
      placesLoading = forward('GET', '/state', null, null, null, routeMs)
        .then((r) => { if (r.s === 200 && r.b && typeof r.b === 'object') places = placesFrom(r.b); })
        .finally(() => { placesLoading = null; });
    }
    await placesLoading;
    return places || { roots: new Set(), listed: new Set(), ws: [], live: new Map(), teams: new Map(), fence: null, at: 0 };
  }
  // every root a known one (a stale list is looked at again once before saying no); orList: also the ones the list
  // features' settings hold
  async function rootsKnown(list, orList) {
    const ok = (pl) => list.every((r) => typeof r === 'string' && path.isAbsolute(r) && (pl.roots.has(keyOf(r)) || (orList && pl.listed.has(keyOf(r)))));
    if (ok(await placesNow())) return true;
    return ok(await placesNow(2000));
  }
  // the phone's fence (see "the phone's fence" above): t, an absolute path, lies in a workspace the fence opens, as
  // it is named and as it really is (links resolved), with every step below that workspace one the phone may name
  const fenceOf = (pl) => {
    if (pl.fence) return pl.fence;
    const linked = linkedDirs();
    return (pl.fence = pl.ws.filter((r) => !unsafeRoot(r, dataDir, linked)));
  };
  async function fenced(t) {
    if (typeof t !== 'string' || !path.isAbsolute(t) || t.includes('\0') || /:/.test(t.slice(2))) return false;
    const ok = (pl) => {
      const real = realOf(t);
      return fenceOf(pl).some((r) => {
        const relReal = path.relative(P.foldCase(realOf(r)), P.foldCase(real));
        if (!below(relReal) || !stepsOk(relReal)) return false;
        const relNamed = path.relative(P.foldCase(path.resolve(r)), P.foldCase(path.resolve(t)));
        return !below(relNamed) || stepsOk(relNamed);
      });
    };
    if (ok(await placesNow())) return true;
    return ok(await placesNow(2000));
  }
  // null when the request may go on, else [status, message]
  async function narrow(m, p, q, b) {
    const no = (message) => [403, message];
    if (m === 'GET') {
      const fence = 'not something the phone may read: only inside a workspace, and nothing hidden or secret';
      // a path the server would refuse anyway (no absolute path) goes on, for its own answer
      if (p === '/file') { const t = fileTarget(q.path, q.cwd); return !t || (await fenced(t)) ? null : no(fence); }
      if (p === '/chat/kind') return typeof q.path !== 'string' || !path.isAbsolute(q.path) || (await fenced(path.resolve(q.path))) ? null : no(fence);
      if (p === '/chat/files') return typeof q.cwd !== 'string' || !path.isAbsolute(q.cwd) || (await fenced(path.resolve(q.cwd))) ? null : no(fence);
      // the commands of a folder outside the fence are not read: the phone gets its own and the built-in ones
      if (p === '/chat/commands' && q.cwd != null && q.cwd !== '' && !(typeof q.cwd === 'string' && path.isAbsolute(q.cwd) && (await fenced(path.resolve(q.cwd))))) delete q.cwd;
      if (p === '/repo-history') return (await rootsKnown([q.root])) ? null : no('not a workspace Fleet View lists');
      if (p === '/sync/move') return typeof q.id === 'string' && UUID_RE.test(q.id) ? null : [400, 'id must be a conversation id'];
      return null;
    }
    if (p === '/sync/move') {
      const bad = Object.keys(b).filter((k) => k !== 'id' && k !== 'force');
      if (bad.length) return no(`a move takes only id and force, not ${bad.slice(0, 3).map((k) => clip(k, 30)).join(', ')}`);
      if (!(typeof b.id === 'string' && UUID_RE.test(b.id))) return [400, 'id must be a conversation id'];
      return b.force === undefined || typeof b.force === 'boolean' ? null : [400, 'force must be true or false'];
    }
    // a linked computer's /peer/env and /peer/logins (PEER_ALLOW): only the conversation's id
    if (p === '/peer/env' || p === '/peer/logins') {
      if (Object.keys(b).some((k) => k !== 'id')) return no('these take only id');
      return typeof b.id === 'string' && UUID_RE.test(b.id) ? null : [400, 'id must be a conversation id'];
    }
    // a role is a bot's alone, given by its own start
    if (p === '/api/sessions' && 'role' in b) return no('a session takes no role: a bot starts with /api/bots/:id/start');
    if (p === '/settings') {
      const bad = Object.keys(b).filter((k) => !SETTINGS_KEYS.has(k));
      if (bad.length) return no(`the phone may not change ${bad.slice(0, 3).map((k) => clip(k, 30)).join(', ')}`);
      // a bare name (no slash) only filters by name; a path must be a root Fleet View lists
      const roots = [];
      const sel = (x) => { if (typeof x === 'string' && /[\\/]/.test(x)) roots.push(x); };
      if ('repo' in b) sel(b.repo);
      if (Array.isArray(b.repos)) b.repos.forEach(sel);
      for (const h of arr(b.hiddenRepos)) { const r = typeof h === 'string' ? h : h && h.root; if (typeof r === 'string') roots.push(r); }
      // the list features' (they merge separately): a name for a root, and the roots' order
      const listedRoots = [...arr(b.repoOrder), ...arr(b.repoNames).map((x) => x && x.root)].filter((r) => typeof r === 'string');
      if (roots.length && !(await rootsKnown(roots))) return no('not a workspace Fleet View lists');
      return listedRoots.length && !(await rootsKnown(listedRoots, true)) ? no('not a workspace Fleet View lists') : null;
    }
    if (p === '/repos/add') return (await rootsKnown([b.path])) ? null : no('only a workspace Fleet View lists or removed can be added from the phone');
    if (p === '/sessions/move') return b.root == null || b.root === '' || (await rootsKnown([b.root])) ? null : no('not a workspace Fleet View lists');
    if (p === '/push-target') return (typeof b.id === 'string' && b.id) || (await rootsKnown([b.root])) ? null : no('not a workspace Fleet View lists');
    if (ACCOUNT_KEYS[p]) return accountRefused(p, b);
    if (p === '/api/bots' || BOT_ONE.test(p)) {
      const bad = Object.keys(b).filter((k) => !BOT_KEYS.has(k));
      return bad.length ? no(`the phone may not set a bot's ${bad.slice(0, 3).map((k) => clip(k, 30)).join(', ')}`) : null;
    }
    if (BOT_ACT.test(p)) return Object.keys(b).length ? no('starting or removing a bot takes nothing else from the phone') : null;
    if (BOT_TASK.test(p)) {
      const bad = Object.keys(b).filter((k) => k !== 'action');
      if (bad.length) return no(`a task's action takes only action, not ${bad.slice(0, 3).map((k) => clip(k, 30)).join(', ')}`);
      return TASK_ACTIONS.includes(b.action) ? null : [400, `action must be one of ${TASK_ACTIONS.join(', ')}`];
    }
    if (BOT_SWITCH.test(p)) {
      const bad = Object.keys(b).filter((k) => !['id', 'model', 'effort'].includes(k));
      if (bad.length) return no(`a bot's switch takes only id, model and effort, not ${bad.slice(0, 3).map((k) => clip(k, 30)).join(', ')}`);
      if (!(typeof b.id === 'string' && UUID_RE.test(b.id))) return [400, "id must be the bot's conversation id"];
      if (b.model == null && b.effort == null) return [400, 'give model, effort or both'];
      if (b.model != null && !(typeof b.model === 'string' && MODEL_RE.test(b.model))) return [400, 'model must be a model name like claude-opus-5-5'];
      return b.effort == null || EFFORTS.includes(b.effort) ? null : [400, `effort must be one of ${EFFORTS.join(', ')}`];
    }
    // the map (a page route, as the switch): the phone only takes a bot off it, but a spot is checked as bots.js checkAt takes one
    if (BOT_MAP.test(p)) {
      const bad = Object.keys(b).filter((k) => k !== 'at');
      if (bad.length) return no(`a bot's map spot takes only at, not ${bad.slice(0, 3).map((k) => clip(k, 30)).join(', ')}`);
      const a = b.at;
      if (a === null) return null;
      const spot = a && typeof a === 'object' && !Array.isArray(a) && Object.keys(a).every((k) => k === 'x' || k === 'y') && Number.isFinite(a.x) && Number.isFinite(a.y);
      return spot ? null : [400, 'at must be { x, y } (numbers), or null: off the map'];
    }
    // a watch: the conversation and its job, or null to stop
    if (BOT_WATCH.test(p)) {
      const bad = Object.keys(b).filter((k) => k !== 'id' && k !== 'job');
      if (bad.length) return no(`a bot's watch takes only id and job, not ${bad.slice(0, 3).map((k) => clip(k, 30)).join(', ')}`);
      if (!(typeof b.id === 'string' && UUID_RE.test(b.id))) return [400, 'id must be a conversation id'];
      return b.job === null || WATCH_JOBS.includes(b.job) ? null : [400, `job must be one of ${WATCH_JOBS.join(', ')}, or null to stop watching`];
    }
    // Dynamic for any chat (fleet-view.js setDynamicChat): a page route, so this PC's Origin, not marked
    if (p === '/chat/dynamic') {
      const bad = Object.keys(b).filter((k) => !['id', 'model', 'effort'].includes(k));
      if (bad.length) return no(`Dynamic takes only id, model and effort, not ${bad.slice(0, 3).map((k) => clip(k, 30)).join(', ')}`);
      if (!(typeof b.id === 'string' && UUID_RE.test(b.id))) return [400, 'id must be a conversation id'];
      if (b.model == null && b.effort == null) return [400, 'give model, effort or both'];
      return [b.model, b.effort].every((v) => v == null || typeof v === 'boolean') ? null : [400, 'model and effort must be true or false'];
    }
    // a file from the phone (files.js upload, which saves it only in its uploads folder): its name in the query and its
    // bytes as standard base64, nothing else (forward sends them on as the raw body)
    if (p === '/upload') {
      const badQ = Object.keys(q).filter((k) => k !== 'name'), bad = Object.keys(b).filter((k) => k !== 'data');
      if (badQ.length || bad.length) return no(`an upload takes only name and data, not ${[...badQ, ...bad].slice(0, 3).map((k) => clip(k, 30)).join(', ')}`);
      if (!uploadNameOk(q.name)) return [400, `name must be a plain file name: no folder, no "..", at most ${UPLOAD_NAME_MAX} characters`];
      const max = uploadMax(), mb = Math.round(max / 1048576);
      if (typeof b.data === 'string' && b.data.length > Math.ceil(max / 3) * 4) return [413, `the file is over ${mb} MB: at most that goes to the PC from the phone`];
      const n = b64Bytes(b.data);
      if (n < 0) return [400, 'data must be the file in standard base64'];
      return n > max ? [413, `the file is over ${mb} MB: at most that goes to the PC from the phone`] : null;
    }
    const verb = (VERB_RE.exec(p) || [])[1];
    if (verb === 'now') return Object.keys(b).length ? no('send now takes nothing else from the phone') : null;
    if (verb === 'background') return Object.keys(b).length ? no('run in background takes nothing else from the phone') : null;
    if (verb === 'unsend' || verb === 'enter') {
      const what = verb === 'enter' ? 'Send it' : 'unsend';
      const bad = Object.keys(b).filter((k) => k !== 'text');
      if (bad.length) return no(`${what} takes only text, not ${bad.slice(0, 3).map((k) => clip(k, 30)).join(', ')}`);
      return textOk(b.text) ? null : [400, 'text must be the message as it was sent'];
    }
    if (verb === 'mode') {
      const bad = Object.keys(b).filter((k) => k !== 'mode');
      if (bad.length) return no(`a mode switch takes only mode, not ${bad.slice(0, 3).map((k) => clip(k, 30)).join(', ')}`);
      return MODES.includes(b.mode) ? null : [400, `mode must be one of ${MODES.join(', ')}`];
    }
    // a rewind: text as api.js cleanText takes it, nth a whole number (api.js takes 0..499), an edit text as well
    if (verb === 'rewind') {
      const bad = Object.keys(b).filter((k) => !['text', 'nth', 'edit'].includes(k));
      if (bad.length) return no(`a rewind takes only text, nth and edit, not ${bad.slice(0, 3).map((k) => clip(k, 30)).join(', ')}`);
      if (!textOk(b.text)) return [400, 'text must be the message as it was sent'];
      if (b.nth !== undefined && !(Number.isInteger(b.nth) && b.nth >= 0)) return [400, 'nth must be a whole number from 0'];
      return b.edit === undefined || textOk(b.edit) ? null : [400, 'edit must be the text to send in its place'];
    }
    // a fork from a message: the message's text and which of that text it is, as a rewind's (no edit: its box gets it)
    if (verb === 'fork') {
      const bad = Object.keys(b).filter((k) => !['text', 'nth'].includes(k));
      if (bad.length) return no(`a fork from a message takes only text and nth, not ${bad.slice(0, 3).map((k) => clip(k, 30)).join(', ')}`);
      if (!textOk(b.text)) return [400, 'text must be the message as it was sent'];
      return b.nth === undefined || (Number.isInteger(b.nth) && b.nth >= 0) ? null : [400, 'nth must be a whole number from 0'];
    }
    if (verb === 'model') {
      // queue: while Claude works, api.js keeps the switch and makes it once it is idle (202 { queued: true })
      const bad = Object.keys(b).filter((k) => k !== 'model' && k !== 'effort' && k !== 'queue');
      if (bad.length) return no(`a switch takes only model, effort and queue, not ${bad.slice(0, 3).map((k) => clip(k, 30)).join(', ')}`);
      if (b.model == null && b.effort == null) return [400, 'give model, effort or both'];
      if (b.queue !== undefined && typeof b.queue !== 'boolean') return [400, 'queue must be true or false'];
      if (b.model != null && !(typeof b.model === 'string' && MODEL_RE.test(b.model))) return [400, 'model must be a model name like opus, sonnet, haiku or claude-opus-5-5[1m]'];
      return b.effort == null || EFFORTS.includes(b.effort) ? null : [400, `effort must be one of ${EFFORTS.join(', ')}`];
    }
    if (verb === 'message') for (const k of ['now', 'shell']) if (k in b && typeof b[k] !== 'boolean') return [400, `${k} must be true or false`];
    return null;
  }
  // a sign-in from the phone (see SIGNIN_LETTERS): its body as accounts.js reads it, its letter A or B (upper case goes
  // on), and that letter with no login on the PC as GET /accounts says it now (read fresh each time, never a cached
  // copy): the loopback route itself would sign in again, switch or stop any letter, since it sees this PC's own page
  async function accountRefused(p, b) {
    const want = ACCOUNT_KEYS[p], name = want[0];
    const bad = Object.keys(b).filter((k) => !want.includes(k));
    if (bad.length) return [403, `the phone may not send ${bad.slice(0, 3).map((k) => clip(k, 30)).join(', ')} here`];
    const a = typeof b[name] === 'string' ? b[name].toUpperCase() : null;
    if (!a || !SIGNIN_LETTERS.includes(a)) return [403, `the phone signs in only Claude ${SIGNIN_LETTERS.join(' or ')}`];
    if (p === '/accounts/code' && !(typeof b.code === 'string' && b.code.trim() && b.code.length <= 600)) return [400, 'code must be the code claude.ai showed'];
    const r = await forward('GET', '/accounts', null, null, null, routeMs);
    if (r.s !== 200 || !r.b || !Array.isArray(r.b.list)) return [503, 'the Claude accounts on the PC could not be read'];
    const row = r.b.list.find((x) => x && x.a === a);
    if (row && row.signedIn !== false) return [403, `Claude ${a} is signed in already: change it on the PC`];
    b[name] = a;
    return null;
  }
  // GET /accounts as the phone gets it: each letter's a, email and signedIn, and the sign-ins of SIGNIN_LETTERS with
  // their status and message (and the claude.ai link only while one waits for its code); nothing else accounts.js
  // view() holds (org, sameAs, a job's email)
  function accountsAnswer(p, r) {
    if (p !== '/accounts' || r.s !== 200 || !r.b || typeof r.b !== 'object') return;
    const str = (x, n) => (typeof x === 'string' ? x.slice(0, n) : null);
    const list = arr(r.b.list).filter((x) => x && typeof x.a === 'string' && /^[A-Z]$/.test(x.a)).map((x) => ({ a: x.a, email: str(x.email, 254), signedIn: x.signedIn === true }));
    const jobs = {};
    const src = r.b.jobs && typeof r.b.jobs === 'object' ? r.b.jobs : {};
    for (const a of SIGNIN_LETTERS) {
      const j = src[a];
      if (!j || typeof j !== 'object' || typeof j.status !== 'string') continue;
      jobs[a] = { status: j.status, message: str(j.message, 400), url: j.status === 'waiting' && typeof j.url === 'string' && /^https:\/\//.test(j.url) ? j.url.slice(0, 4000) : null };
    }
    r.b = { list, jobs };
    delete r.etag;
  }
  // what the phone may not open is not listed either: GET /file's folder entries and /chat/files' paths; and a file
  // whose text holds a key (SECRET_TEXT_RES) is not shown, whatever its name
  function fenceAnswer(p, r) {
    if (r.s !== 200 || !r.b || typeof r.b !== 'object') return;
    if (p === '/file' && typeof r.b.text === 'string' && SECRET_TEXT_RES.some((re) => re.test(r.b.text))) {
      r.s = 403;
      r.b = { ok: false, message: 'not something the phone may read: this file holds a key or a credential' };
      delete r.etag;
      return;
    }
    if (p === '/file' && Array.isArray(r.b.entries)) {
      const keep = r.b.entries.filter((e) => typeof e === 'string' && stepOk(e.replace(/\/$/, '')));
      if (typeof r.b.total === 'number') r.b.total = Math.max(keep.length, r.b.total - (r.b.entries.length - keep.length));
      r.b.entries = keep;
    }
    if (p === '/chat/files' && Array.isArray(r.b.files)) r.b.files = r.b.files.filter((f) => f && typeof f.path === 'string' && stepsOk(f.path));
  }

  // ---------- calling the server ----------
  function apiToken() {
    try {
      const t = String((typeof opts.apiToken === 'function' ? opts.apiToken() : fs.readFileSync(String(opts.apiToken), 'utf8')) || '').trim();
      return TOKEN_RE.test(t) ? t : null;
    } catch { return null; }
  }
  // the marker's key (api.js relayKey), or null: without one, what the phone sends reaches a bot unsigned (said once)
  let noKeySaid = false;
  function markKey() {
    let k = null;
    try { k = typeof opts.relayKey === 'function' ? opts.relayKey() : null; } catch { k = null; }
    if (typeof k === 'string' && MARK_KEY_RE.test(k)) return k;
    if (!noKeySaid) { noKeySaid = true; log('relay: no relay key (opts.relayKey): what the phone sends goes without the marker, so a bot takes it as unsigned'); }
    return null;
  }
  const fail = (s, message, extra) => ({ s, b: { ok: false, message, ...(extra || {}) } });
  // every header is made here, none taken from the phone; mark: the marker's key, on MARKED routes only; dv: the device
  // whose answer it reads, which may have RES_DEVICE_MAX bytes of answers being read at once (429 past that); peer: a
  // computer's sync device id, on its /peer/... routes (which go with the marker's key too)
  // -> Promise of { s, b?, b64?, ct?, etag?, bytes }
  function forward(m, p, q, b, etag, ms, mark = null, dv = null, peer = null) {
    return new Promise((resolve) => {
      const api = p.startsWith('/api/');
      const headers = { Accept: 'application/json, */*' };
      let body = null;
      if (api) {
        const t = apiToken();
        if (!t) return resolve({ ...fail(502, 'the API token could not be read on the PC'), bytes: 0 });
        headers.Authorization = `Bearer ${t}`;
        if (mark) headers['X-Fleet-View-Relay'] = mark;
      } else if (peer && mark && isPeerPath(p)) {
        headers['X-Fleet-View-Relay'] = mark;
        headers['X-Fleet-View-Peer'] = peer;
      }
      if (m === 'POST') {
        // an upload's bytes go as the raw body files.js reads, as the page's browser upload sends them (narrow checked them)
        const raw = p === '/upload' && b && typeof b.data === 'string';
        body = raw ? Buffer.from(b.data, 'base64') : Buffer.from(JSON.stringify(b || {}), 'utf8');
        headers['Content-Type'] = raw ? 'application/octet-stream' : 'application/json';
        headers['Content-Length'] = body.length;
        if (!api) headers.Origin = origin;
      }
      if (etag) headers['If-None-Match'] = etag;
      const qs = q && Object.keys(q).length ? `?${new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)]))}` : '';
      let done = false, timer = null, held = 0;
      const end = (r) => { if (done) return; done = true; cancel(timer); if (dv) dv.resBytes -= held; held = 0; resolve(r); };
      let rq;
      try {
        rq = http.request({ host: '127.0.0.1', port, method: m, path: p + qs, headers }, (rs) => {
          const parts = [];
          let size = 0;
          rs.on('data', (c) => {
            if (done) return;
            size += c.length;
            if (size > RES_MAX) { end({ ...fail(413, 'the answer is too large for the phone'), bytes: size }); rq.destroy(); return; }
            if (dv) {
              if (dv.resBytes + c.length > resDeviceMax()) { end({ ...fail(429, 'the PC is reading too much for this phone at once: try again shortly', { retryAfter: 2000 }), bytes: size }); rq.destroy(); return; }
              dv.resBytes += c.length;
              held += c.length;
            }
            parts.push(c);
          });
          rs.on('error', () => end({ ...fail(502, 'the server broke off its answer'), bytes: size }));
          rs.on('end', () => {
            const buf = Buffer.concat(parts), s = rs.statusCode || 502;
            const ct = String(rs.headers['content-type'] || '');
            const out = { s, bytes: buf.length };
            if (typeof rs.headers.etag === 'string') out.etag = rs.headers.etag;
            if (s !== 304 && buf.length) {
              let json;
              if (/^application\/(?:[\w.+-]*\+)?json\b/i.test(ct)) { try { json = { v: JSON.parse(buf.toString('utf8')) }; } catch {} }
              if (json) out.b = json.v;
              else if (/^(?:text\/|application\/(?:[\w.+-]*\+)?json\b)/i.test(ct)) { out.b = buf.toString('utf8'); out.ct = ct; } else { out.b64 = buf.toString('base64'); out.ct = ct || 'application/octet-stream'; }
            }
            end(out);
          });
        });
      } catch (e) { return end({ ...fail(502, 'the server did not answer'), bytes: 0 }); }
      rq.on('error', () => end({ ...fail(502, 'the server did not answer'), bytes: 0 }));
      timer = later(() => { end({ ...fail(408, `the server took more than ${Math.round(ms / 1000)} s`), bytes: 0 }); rq.destroy(); }, ms);
      rq.end(body || undefined);
    });
  }

  // ---------- one request from the phone ----------
  // -> Promise of the answer { s, b?, b64?, ct?, etag? }, or null when the device was revoked on the way (nothing went)
  async function run(dv, msg) {
    const m = msg.m, p = msg.p;
    if (m !== 'GET' && m !== 'POST') return fail(400, 'm must be GET or POST');
    // a linked computer may also call the /peer/... routes; a phone never
    const peerRoute = isComputer(dv) && peerRouteAllowed(m, p);
    if (!routeAllowed(m, p) && !peerRoute) return fail(403, isComputer(dv) ? 'not something another computer may call' : 'not something the phone may call');
    let q = {};
    if (msg.q !== undefined && msg.q !== null) {
      if (typeof msg.q !== 'object' || Array.isArray(msg.q)) return fail(400, 'q must be an object');
      const ents = Object.entries(msg.q);
      if (ents.length > 20 || ents.some(([k, v]) => !/^[A-Za-z0-9_.-]{1,40}$/.test(k) || !((typeof v === 'string' && v.length <= 8192) || (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean'))) return fail(400, 'q holds names of [A-Za-z0-9_.-] and strings, numbers or booleans');
      q = msg.q;
    }
    let b = null;
    if (m === 'POST') {
      b = msg.b === undefined || msg.b === null ? {} : msg.b;
      if (typeof b !== 'object' || Array.isArray(b)) return fail(400, 'b must be a JSON object');
      // the marker is the relay's alone: a via the phone sent goes before anything reads the body
      delete b.via;
    }
    let etag = null;
    if (msg.etag !== undefined && msg.etag !== null) {
      if (typeof msg.etag !== 'string' || msg.etag.length > 200 || !/^[\x20-\x7e]+$/.test(msg.etag)) return fail(400, 'etag must be text');
      etag = msg.etag;
    }
    const refused = await narrow(m, p, q, b);
    if (refused) return fail(refused[0], refused[1]);
    // asking the server to wait: the wait itself at most WAIT_CAP_S, and the route gets longer (routeTimeout)
    let waitS = 0;
    if (m === 'POST' && p.startsWith('/api/') && 'wait' in b && b.wait !== false && b.wait !== null && b.wait !== 0) {
      if (b.wait === true || (typeof b.wait === 'number' && b.wait > WAIT_CAP_S)) b.wait = WAIT_CAP_S;
      waitS = typeof b.wait === 'number' && b.wait > 0 ? Math.ceil(b.wait) : WAIT_CAP_S; // a bad one: the server says 400
    }
    const ms = routeTimeout(m, p, waitS, routeMs, waitRouteMs);
    // Henry's own words from his phone or another of his computers (api.js viaOf): marked only here, with every check
    // passed. A /peer/... route goes with the marker's key and the computer's peer (fleet-view.js serves it only so)
    const mark = m === 'POST' && MARKED.test(p) ? markKey() : null;
    if (mark) b.via = 'phone';
    const peerMark = peerRoute ? markKey() : null;
    if (peerRoute && !peerMark) return fail(503, 'this PC has no relay key, so it cannot pass on what another computer asks');
    // revoked while the checks above waited (they may read /state): nothing goes
    if (dv.gone || devices.get(dv.id) !== dv) return null;
    const r = await forward(m, p, q, b, etag, ms, mark || peerMark, dv, peerRoute ? dv.peer : null);
    // what the phone's own /state read says: the narrower checks use it too
    if (m === 'GET' && p === '/state' && r.s === 200 && r.b && typeof r.b === 'object') places = placesFrom(r.b);
    if (m === 'GET') { fenceAnswer(p, r); accountsAnswer(p, r); }
    return r;
  }
  // per device: how long before another envelope may open (ms), or 0, which counts this one. Every envelope that opens
  // counts: requests and their repeats, parts and hellos
  function overRate(dv) {
    const t = now(), at = dv.opened;
    while (at.length && t - at[0] >= 60e3) at.shift();
    const n = at.length;
    if (n >= PER_MIN) return Math.max(1, 60e3 - (t - at[0]));
    if (n >= PER_S && t - at[n - PER_S] < 1000) return Math.max(1, 1000 - (t - at[n - PER_S]));
    at.push(t);
    return 0;
  }
  // per device, the routes that start or resume a Claude: how long before one of weight w may go (ms), or 0
  // (opts.startLimits { atOnce, max }, read each time, is for tests)
  const startLimits = () => ({ atOnce: STARTS_AT_ONCE, max: STARTS_MAX, ...(opts.startLimits || {}) });
  function overStarts(dv, w) {
    const t = now(), lim = startLimits();
    dv.startLog = dv.startLog.filter(([at]) => t - at < STARTS_MS);
    if (dv.starting >= lim.atOnce) return 5000;
    let used = dv.startLog.reduce((n, [, x]) => n + x, 0);
    if (used + w <= lim.max) return 0;
    for (const [at, x] of dv.startLog) { used -= x; if (used + w <= lim.max) return Math.max(1, STARTS_MS - (t - at)); }
    return STARTS_MS;
  }
  // keep an id's answer (a GET answer within the budget; every other one); size: its JSON text's length
  function keep(dv, id, entry, res, size) {
    if (dv.kept.get(id) !== entry) return; // let go already
    if (entry.get && size > KEEP_ONE_GET) { dv.kept.delete(id); return; }
    entry.res = res;
    if (!entry.get) return;
    entry.size = size;
    dv.keptGet += size;
    for (const [k, e] of dv.kept) {
      if (dv.keptGet <= KEEP_GET_BYTES) break;
      if (e.get && e.res && k !== id) { dv.kept.delete(k); dv.keptGet -= e.size; }
    }
  }
  function pruneKept(dv) {
    const t = now();
    for (const [k, e] of dv.kept) {
      if (t - e.at < KEEP_MS && dv.kept.size <= KEEP_MAX) break;
      if (!e.res && t - e.at < KEEP_MS) continue; // still running
      dv.kept.delete(k);
      if (e.get) dv.keptGet -= e.size;
    }
  }
  const logPath = (p) => (typeof p === 'string' && pathOk(p) ? p : '(refused)');
  // a POST sent again (its t0, the first attempt's time, before this attempt's at) whose id has no kept answer here:
  // a first attempt that went before the relay started (this PC's clock, from the phone's own time between the two,
  // give or take the way there), or so long ago that its kept answer may be gone, may have run already, so it does not
  // run again: 409 { restarted } or { expired }. -> that answer, or null
  function unsure(msg) {
    if (msg.m !== 'POST' || !(msg.t0 < msg.at)) return null;
    if (now() - (msg.at - msg.t0) < startedAt + RESTART_SLACK_MS) return fail(409, 'The PC restarted while this was being sent. Check before sending again.', { restarted: true });
    if (msg.at - msg.t0 > EXPIRED_MS) return fail(409, 'This was first sent too long ago for the PC to tell whether it went in. Check before sending again.', { expired: true });
    return null;
  }
  function onRequest(dv, msg) {
    const had = dv.kept.get(msg.id);
    if (had) { if (had.res) sendRes(dv, msg.id, had.res); return; } // a repeat: the kept answer, or nothing while it runs
    const m = clip(msg.m, 8) || '?', p = logPath(msg.p);
    const refuse = (res, kept) => {
      logLine(dv.id, m, p, res.s, 0, 0);
      const sent = sendRes(dv, msg.id, res);
      if (kept) { pruneKept(dv); const entry = { at: now(), res: null, size: 0, get: false }; dv.kept.set(msg.id, entry); keep(dv, msg.id, entry, sent.res, sent.size); }
    };
    if (msg.t0 !== undefined && !(typeof msg.t0 === 'number' && Number.isFinite(msg.t0) && msg.t0 <= msg.at)) return refuse(fail(400, 't0 must be the time of the first attempt, at or before at'));
    // kept: a further repeat gets the same answer
    const doubt = unsure(msg);
    if (doubt) return refuse(doubt, true);
    if (dv.inFlight >= IN_FLIGHT_MAX) return refuse(fail(429, 'too many requests at once: try again shortly', { retryAfter: 1000 }));
    // w: its weight against the start limits
    const admit = (w) => {
      if (dv.inFlight >= IN_FLIGHT_MAX) return refuse(fail(429, 'too many requests at once: try again shortly', { retryAfter: 1000 }));
      const wait = w ? overStarts(dv, w) : 0;
      if (wait) {
        const lim = startLimits(), why = dv.starting >= lim.atOnce ? `${lim.atOnce} are starting already` : `${lim.max} were started in 10 minutes`;
        return refuse(fail(429, `too many conversations started from the phone (${why}): try again in ${Math.ceil(wait / 1000)} s`, { retryAfter: wait }));
      }
      dv.inFlight++;
      if (w) { dv.starting++; dv.startLog.push([now(), w]); }
      pruneKept(dv);
      const entry = { at: now(), res: null, size: 0, get: msg.m === 'GET' };
      dv.kept.set(msg.id, entry);
      const t0 = now();
      run(dv, msg).catch((e) => { note(`a request failed: ${e && e.message}`); return fail(502, 'the relay could not pass it on'); }).then((r) => {
        dv.inFlight--;
        if (w) dv.starting--;
        if (!r || dv.gone || devices.get(dv.id) !== dv) return;
        const { bytes, ...res } = r;
        logLine(dv.id, m, p, res.s, now() - t0, bytes || 0);
        const sent = sendRes(dv, msg.id, res);
        keep(dv, msg.id, entry, sent.res, sent.size);
      });
    };
    if (!resumeKind(msg.m, msg.p, msg.b)) return admit(startWeight(msg.m, msg.p, msg.b));
    // a message that may resume conversations weighs the ones /state (at most PLACES_MS old) says are not running;
    // while that is read it counts in flight, and a repeat of it is ignored
    pruneKept(dv);
    const hold = { at: now(), res: null, size: 0, get: false };
    dv.kept.set(msg.id, hold);
    dv.inFlight++;
    placesNow().catch(() => null).then((pl) => {
      dv.inFlight--;
      if (dv.kept.get(msg.id) === hold) dv.kept.delete(msg.id);
      if (dv.gone || devices.get(dv.id) !== dv) return;
      admit(resumeWeight(pl, msg.m, msg.p, msg.b));
    });
  }

  // ---------- messages up ----------
  const drop = (dv) => { dv.dropped++; };
  const msgOk = (j) => j && typeof j.t === 'string' && typeof j.id === 'string' && ID_RE.test(j.id) && typeof j.at === 'number' && Number.isFinite(j.at);
  const fresh = (j) => Math.abs(j.at - now()) <= SKEW_MS && j.at >= startedAt;
  // the key an envelope opens with -> { r (decrypt's), via, down (the key its answer goes under) } or null. via: 'own'
  // (the device's own key, or one of the K' its handshakes made: the first envelope under one finishes the pairing),
  // 'qr' (the QR's K, while it pairs) or 'old' (the QR's K once the pairing finished: only "already paired")
  function openUp(dv, env) {
    const topic = topicFor(dv);
    const r = decrypt(dv.keys.up, topic, dv.id, 'up', env);
    if (r) return { r, via: dv.qr ? 'qr' : 'own', down: dv.keys.down };
    for (const c of dv.qr && dv.until > now() ? dv.cands : []) {
      const rc = decrypt(c.up, topic, dv.id, 'up', env);
      if (rc) { finish(dv, c); return { r: rc, via: 'own', down: c.down }; }
    }
    const ro = dv.old && dv.old.until > now() ? decrypt(dv.old.up, topic, dv.id, 'up', env) : null;
    return ro ? { r: ro, via: 'old', down: dv.old.down } : null;
  }
  // at most UNPACKS_MAX envelopes inflating at once per device, and UNPACK_WAIT_MAX more waiting: the rest are dropped
  // (one with z 0 is only parsed, there and then)
  function unpackSome(dv, r) {
    if (!r.z) return unpack(r);
    return new Promise((resolve) => {
      const go = () => {
        dv.unpacking++;
        unpack(r).then((msg) => { dv.unpacking--; const next = dv.unpackWait.shift(); if (next) next(); resolve(msg); });
      };
      if (dv.unpacking < UNPACKS_MAX) go();
      else if (dv.unpackWait.length < UNPACK_WAIT_MAX) dv.unpackWait.push(go);
      else resolve(null);
    });
  }
  // one envelope up, from the device's channel
  async function onEnvelope(dv, env) {
    const no = () => drop(dv);
    if (!dv.keys || !usable(dv)) return no();
    // a copy of an envelope seen in the last 10 minutes goes before any work
    if (!env || typeof env !== 'object' || typeof env.n !== 'string' || dv.nonces.has(env.n)) return no();
    const o = openUp(dv, env);
    // the QR's K opens hellos only until its time is up
    if (!o || (o.via === 'qr' && !(dv.until > now()))) return no();
    dv.nonces.set(env.n, now());
    const wait = overRate(dv);
    const msg = await unpackSome(dv, o.r);
    if (dv.gone || devices.get(dv.id) !== dv) return;
    if (!msgOk(msg) || !fresh(msg)) return no();
    // the pairing finished while this one was opened: K says no more than "already paired"
    const via = o.via === 'qr' && !dv.qr ? 'old' : o.via;
    const answers = msg.t === 'hello' || msg.t === 'req';
    if (wait) {
      if (!answers) return drop(dv);
      logLine(dv.id, msg.t === 'hello' ? 'HELLO' : clip(msg.m, 8) || '?', msg.t === 'hello' ? '-' : logPath(msg.p), 429, 0, 0);
      return void sendRes(dv, msg.id, fail(429, 'too many messages from the phone: try again shortly', { retryAfter: wait }), o.down);
    }
    if (via === 'old') return answers ? void sendRes(dv, msg.id, fail(403, 'already paired: this pairing code was used. Make a new one on the PC.', { paired: false }), o.down) : drop(dv);
    if (via === 'qr') {
      if (msg.t === 'hello') return handshake(dv, msg, o.down);
      return msg.t === 'req' ? void sendRes(dv, msg.id, fail(403, 'not paired yet: send hello first'), o.down) : drop(dv);
    }
    if (msg.t === 'part') return onPart(dv, msg);
    return onMessage(dv, msg);
  }
  function onPart(dv, msg) {
    const { id, part, parts, chunk } = msg;
    const t = now();
    for (const [k, a] of dv.parts) if (t - a.at > ASSEMBLY_MS) { dv.parts.delete(k); drop(dv); } // ran out of time
    if (!Number.isInteger(parts) || parts < 1 || parts > PARTS_MAX || !Number.isInteger(part) || part < 0 || part >= parts
      || typeof chunk !== 'string' || chunk.length > PART_MAX) return drop(dv);
    let a = dv.parts.get(id);
    if (!a) {
      if (dv.parts.size >= ASSEMBLIES_MAX) return drop(dv);
      a = { parts, chunks: new Array(parts), got: 0, size: 0, at: t };
      dv.parts.set(id, a);
    }
    if (a.parts !== parts) return drop(dv);
    if (a.chunks[part] !== undefined) return; // a copy of one it has
    a.chunks[part] = chunk;
    a.got++;
    a.size += chunk.length;
    if (a.size > UP_TEXT_MAX) { dv.parts.delete(id); return drop(dv); }
    if (a.got < parts) return;
    dv.parts.delete(id);
    let whole = null;
    try { whole = JSON.parse(a.chunks.join('')); } catch {}
    if (!msgOk(whole) || whole.t === 'part' || whole.id !== id || !fresh(whole)) return drop(dv);
    return onMessage(dv, whole);
  }
  // a message under the device's own key
  function onMessage(dv, msg) {
    if (msg.t === 'hello') {
      saw(dv, msg, false);
      logLine(dv.id, 'HELLO', '-', 200, 0, 0);
      return void sendRes(dv, msg.id, { s: 200, b: helloBody() });
    }
    if (msg.t === 'req') return onRequest(dv, msg);
    return drop(dv);
  }
  // a hello's lastSeen, app and device; changed (a pairing) or a new app version is saved now, lastSeen alone with
  // the sweep
  function saw(dv, msg, changed) {
    dv.lastSeen = now();
    const app = typeof msg.app === 'string' ? clip(msg.app, 40) : dv.app, device = typeof msg.device === 'string' ? clip(msg.device, 60) : dv.device;
    if (app !== dv.app || device !== dv.device) { dv.app = app; dv.device = device; changed = true; }
    if (changed) saveDevices(); else devicesDirty = true;
  }
  // a hello under the QR's K (docs/phone.md "Pairing"): the PC's half of an X25519 exchange, made fresh, and K' from
  // K, it and the phone's epk. K' is kept (next to K and any earlier ones, CANDS_MAX at most) before the answer
  // carries the PC's half, so a lost answer or a restart never strands the phone: it may say hello under K again (a
  // new K' each time, K opening hellos until PENDING_MS after the last), and whichever K' its first envelope comes
  // under is its key (finish). down: K's key down
  async function handshake(dv, msg, down) {
    const no = (s, message, extra) => { logLine(dv.id, 'HELLO', '-', s, 0, 0); sendRes(dv, msg.id, fail(s, message, extra), down); };
    const epk = typeof msg.epk === 'string' ? fromB64u(msg.epk) : null;
    if (!epk || epk.length !== 32) return no(400, 'this app pairs the old way (its hello has no epk): update it');
    // each one makes a key pair and writes the key store: HS_MAX with one code, one per HS_GAP_MS
    const t = now();
    if (dv.hsN >= HS_MAX) return no(403, 'this pairing code was tried too many times: make a new one on the PC', { paired: false });
    if (dv.hsAt && t - dv.hsAt < HS_GAP_MS) return no(429, 'pairing again too soon: try again shortly', { retryAfter: Math.max(1, HS_GAP_MS - (t - dv.hsAt)) });
    const mine = xPair(), k2 = pairedKey(dv.k, mine.priv, epk);
    if (!k2) return no(400, 'epk is not a usable X25519 public key');
    dv.hsN++;
    dv.hsAt = t;
    const c = { k: k2, ...dirKeys(k2) };
    dv.cands = [...dv.cands, c].slice(-CANDS_MAX);
    dv.until = Math.max(dv.until, now() + PENDING_MS);
    try {
      await loadKeys();
      if (dv.gone || !dv.qr) return;
      keys.set(dv.id, entryOf(dv));
      await saveKeys();
    } catch (e) {
      dv.cands = dv.cands.filter((x) => x !== c);
      note(`the new key of ${dv.id} could not be kept: ${e.message}`);
      return no(500, 'the PC could not keep the new key safe: try again');
    }
    // revoked, or the pairing finished under another K' meanwhile: this hello is answered no more
    if (dv.gone || devices.get(dv.id) !== dv || !dv.qr) return;
    let changed = false;
    if (dv.state === 'pending') {
      Object.assign(dv, { state: 'paired', pairedAt: now(), exp: undefined });
      changed = true;
      note(`${dv.id} (${dv.name}) is paired: its first message under its own key finishes it`);
      removePairPage();
    }
    saw(dv, msg, changed);
    logLine(dv.id, 'HELLO', '-', 200, 0, 0);
    sendRes(dv, msg.id, { s: 200, b: { ...helloBody(), epk: b64u(mine.pub) } }, down);
  }
  // the first envelope under one of the K' (c) a handshake made: it is the device's key now, the QR's K and the other
  // K' open nothing (K still answers "already paired" until its time is up, from memory only)
  function finish(dv, c) {
    dv.old = { up: dv.keys.up, down: dv.keys.down, until: dv.until };
    Object.assign(dv, { k: c.k, keys: { up: c.up, down: c.down }, qr: false, cands: [], until: 0 });
    if (dv.state === 'pending') { Object.assign(dv, { state: 'paired', pairedAt: now(), exp: undefined }); saveDevices(); removePairPage(); }
    if (keys && !dv.gone) { keys.set(dv.id, entryOf(dv)); saveKeys().catch((e) => note(`the key of ${dv.id} could not be saved: ${e.message}`)); }
    note(`${dv.id} (${dv.name}) finished pairing: the pairing code opens nothing now`);
  }

  // ---------- messages down ----------
  // the answer to id (a repeat's too), with a fresh `at`; one whose JSON text would need more than PARTS_MAX parts goes
  // as a 413 instead. down: the key it goes under (the device's own, unless it answers the QR's K).
  // -> { res: what went, size: its JSON text's length }
  function sendRes(dv, id, res, down) {
    let text = JSON.stringify({ t: 'res', id, at: now(), ...res });
    if (text.length > PARTS_MAX * (PART_MAX - 1)) {
      res = fail(413, 'the answer is too large for the phone');
      text = JSON.stringify({ t: 'res', id, at: now(), ...res });
    }
    sendDown(dv, id, text, down);
    return { res, size: text.length };
  }
  // one message's JSON text down: one envelope, or its parts when it is longer than PART_MAX. Through Supabase on the
  // device's channel
  function sendDown(dv, id, text, down) {
    if (!dv.keys) return false;
    const topic = topicFor(dv), key = down || dv.keys.down;
    const ch = dv.ch;
    if (ch.state !== 'joined' || !wsOpen) return false;
    const one = (t) => wire({ topic: ch.topic, event: 'broadcast', payload: { type: 'broadcast', event: 'e', payload: seal(key, topic, dv.id, 'down', t) }, ref: mkRef(), join_ref: ch.joinRef });
    if (text.length <= PART_MAX) return one(text);
    const list = slices(text);
    if (list.length > PARTS_MAX) return false;
    const at = now();
    return list.every((chunk, i) => one(JSON.stringify({ t: 'part', id, at, part: i, parts: list.length, chunk })));
  }
  // a notice under the device's key, and while it pairs under each K' its handshakes made too (the phone has one of
  // them once it read a handshake's answer; it drops the copies it can't open)
  const notice = (dv, kind) => {
    const id = b64u(crypto.randomBytes(12)), text = JSON.stringify({ t: 'notice', id, at: now(), kind });
    return [dv.keys && dv.keys.down, ...dv.cands.map((c) => c.down)].map((down) => sendDown(dv, id, text, down)).every(Boolean);
  };

  // ---------- the socket ----------
  let ws = null, wsOpen = false, refN = 0, hbTimer = null, hbRef = null, reconnectTimer = null, sweepTimer = null;
  let sockBackoff = BACKOFF_MIN, uid = null, token = null, want = false, started = false, stopped = false, startedAt = Infinity;
  let unsubscribe = null, evalChain = Promise.resolve();
  const mkRef = () => String(++refN);
  function wire(o) {
    if (!ws || !wsOpen) return false;
    try { ws.send(JSON.stringify(o)); return true; } catch { return false; }
  }
  function connect() {
    if (ws || reconnectTimer || stopped || !want) return;
    if (typeof WS !== 'function') { note('this node has no WebSocket (node 22 or newer has one): not connecting'); return; }
    const c = (readConfig(dataDir) || {}).config;
    if (!c) { note('the sync config could not be read: trying again later'); return void reconnectLater(); }
    const url = `${c.url.replace(/^http/, 'ws')}/realtime/v1/websocket?apikey=${encodeURIComponent(c.key)}&vsn=1.0.0`;
    let sock;
    try { sock = new WS(url); } catch (e) { note(`could not open the socket: ${e.message}`); return void reconnectLater(); }
    try { sock.binaryType = 'arraybuffer'; } catch {}
    ws = sock;
    wsOpen = false;
    hbRef = null;
    sock.onopen = () => {
      if (ws !== sock) return;
      wsOpen = true;
      beat();
      for (const dv of devices.values()) join(dv);
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
    for (const dv of devices.values()) { cancel(dv.ch.timer); Object.assign(dv.ch, { state: 'closed', joinRef: null, timer: null }); }
  }
  // the socket went away: every channel with it; it comes back after the backoff
  function dropped() {
    ws = null;
    wsOpen = false;
    cancel(hbTimer); hbTimer = null; hbRef = null;
    resetChannels();
    if (want && !stopped) reconnectLater();
  }
  function disconnect(why) {
    cancel(reconnectTimer); reconnectTimer = null;
    const sock = ws;
    if (sock) {
      for (const dv of devices.values()) leave(dv);
      ws = null;
      wsOpen = false;
      try { sock.close(1000, clip(why, 60) || 'relay off'); } catch {}
    }
    cancel(hbTimer); hbTimer = null; hbRef = null;
    resetChannels();
  }
  // a heartbeat every HEARTBEAT_MS; one still unanswered at the next means the socket is dead. The token is checked
  // at each, as realtime-js does (S1 renews it a minute before it runs out)
  function beat() {
    cancel(hbTimer);
    hbTimer = later(() => {
      hbTimer = null;
      if (!wsOpen) return;
      if (hbRef) {
        note('no answer to the heartbeat: reconnecting');
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
  // join dv's channel, unless it is joined or joining, or a refused one waits out its backoff (rejoinLater)
  async function join(dv) {
    const ch = dv.ch;
    if (!wsOpen || !uid || !dv.keys || !usable(dv) || ch.state === 'joining' || ch.state === 'joined' || (ch.state === 'errored' && ch.timer)) return;
    cancel(ch.timer); ch.timer = null;
    ch.state = 'joining';
    ch.joinRef = null;
    let tok;
    try { tok = await sync.accessToken(); } catch (e) {
      ch.state = 'errored';
      note(`no access token for the channel: ${e.message}`);
      return void rejoinLater(dv);
    }
    if (!wsOpen || !uid || ch.state !== 'joining' || devices.get(dv.id) !== dv) { if (ch.state === 'joining') ch.state = 'closed'; return; }
    token = tok;
    const r = mkRef();
    ch.joinRef = r;
    ch.topic = `realtime:${topicOf(uid, dv.id)}`;
    wire({ topic: ch.topic, event: 'phx_join', ref: r, join_ref: r, payload: {
      config: { broadcast: { ack: false, self: false }, presence: { key: 'pc', enabled: true }, postgres_changes: [], private: true },
      access_token: tok,
    } });
    ch.timer = later(() => {
      if (ch.joinRef !== r || ch.state !== 'joining') return;
      ch.state = 'errored';
      ch.refused = 'no answer to the join';
      rejoinLater(dv);
    }, JOIN_MS);
  }
  function rejoinLater(dv) {
    const ch = dv.ch;
    cancel(ch.timer);
    const ms = ch.backoff;
    ch.backoff = Math.min(BACKOFF_MAX, ch.backoff * 2);
    ch.timer = later(() => { ch.timer = null; if (ch.state !== 'joined' && ch.state !== 'joining') { ch.state = 'closed'; join(dv); } }, ms);
  }
  function leave(dv) {
    const ch = dv.ch;
    cancel(ch.timer); ch.timer = null;
    if ((ch.state === 'joined' || ch.state === 'joining') && ch.joinRef) wire({ topic: ch.topic, event: 'phx_leave', payload: {}, ref: mkRef(), join_ref: ch.joinRef });
    ch.state = 'closed';
    ch.joinRef = null;
  }
  function track(dv) {
    const ch = dv.ch;
    wire({ topic: ch.topic, event: 'presence', ref: mkRef(), join_ref: ch.joinRef, payload: { type: 'presence', event: 'track', payload: { role: 'pc', v: 1, at: now() } } });
  }
  async function refreshToken() {
    let tok;
    try { tok = await sync.accessToken(); } catch { return; }
    if (!tok || tok === token) return;
    token = tok;
    for (const dv of devices.values()) {
      if (dv.ch.state === 'joined') wire({ topic: dv.ch.topic, event: 'access_token', payload: { access_token: tok }, ref: mkRef(), join_ref: dv.ch.joinRef });
    }
  }
  const reasonOf = (payload) => {
    const r = payload && payload.response;
    return clip((r && (r.reason || r.message)) || (payload && payload.message) || 'refused', 200);
  };
  function onFrame(data) {
    let f = null;
    try { f = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8')); } catch {}
    if (!f || typeof f !== 'object') return;
    const { topic, event, payload, ref } = f;
    if (topic === 'phoenix') {
      if (ref && ref === hbRef) { hbRef = null; if (payload && payload.status === 'ok') sockBackoff = BACKOFF_MIN; }
      return;
    }
    let dv = null;
    for (const d of devices.values()) if (d.ch.topic === topic) dv = d;
    if (!dv) return;
    const ch = dv.ch;
    if (event === 'phx_reply') {
      if (ref !== ch.joinRef || ch.state !== 'joining') return; // the answer to a track or a token: nothing to do
      cancel(ch.timer); ch.timer = null;
      if (payload && payload.status === 'ok') {
        ch.state = 'joined';
        ch.backoff = BACKOFF_MIN;
        ch.refused = null;
        sockBackoff = BACKOFF_MIN; // a healthy socket
        note(`joined the channel of ${dv.id}`);
        track(dv);
        return;
      }
      ch.state = 'errored';
      ch.refused = reasonOf(payload);
      note(`Supabase refused the channel of ${dv.id}: ${ch.refused}`);
      return void rejoinLater(dv);
    }
    if (event === 'phx_error' || event === 'phx_close') {
      if (f.join_ref && f.join_ref !== ch.joinRef) return; // an earlier join's
      if (ch.state !== 'joined' && ch.state !== 'joining') return; // one we left
      cancel(ch.timer); ch.timer = null;
      ch.state = 'errored';
      if (event === 'phx_error') ch.refused = 'the channel failed';
      return void rejoinLater(dv);
    }
    if (event === 'system') {
      if (payload && payload.status === 'error') { ch.refused = clip(payload.message || 'error', 200); note(`Supabase said about the channel of ${dv.id}: ${ch.refused}`); }
      return;
    }
    if (event === 'broadcast') {
      if (ch.state === 'joined' && payload && payload.event === 'e') onEnvelope(dv, payload.payload).catch((e) => note(`a message failed: ${e && e.message}`));
      return;
    }
    if (event === 'presence_state' || event === 'presence_diff') {
      const here = event === 'presence_state' ? payload : payload && payload.joins;
      // a phone tracks the key 'phone', a linked computer (link.js) 'peer'
      if (here && typeof here === 'object' && (isComputer(dv) ? here.peer : here.phone)) { dv.lastSeen = now(); devicesDirty = true; }
    }
  }

  // ---------- on, off, and the sweep ----------
  // want a socket while S1 is set up and signed in and some device is paired or waiting; the account's uid is in
  // every topic, so another account means leaving every channel first
  // again: S1 signed in or out, so every channel is left and (when still wanted) joined again on a new socket
  function evaluate(again) {
    const run = () => evaluateNow(!!again);
    evalChain = evalChain.then(run, run);
    return evalChain;
  }
  async function evaluateNow(again) {
    if (stopped) return;
    let id = null;
    try { id = sync.enabled() ? await sync.uid() : null; } catch { id = null; }
    if ((id !== uid && uid) || (again && (ws || reconnectTimer))) {
      disconnect('the sign-in changed');
      sockBackoff = BACKOFF_MIN;
      for (const dv of devices.values()) dv.ch.backoff = BACKOFF_MIN;
    }
    uid = id;
    // the keys are read once a device needs them: while S1 is signed in (the uid is in its topic)
    const need = uid ? [...devices.values()] : [];
    if (need.length) {
      try {
        await loadKeys();
        for (const dv of need) {
          if (devices.get(dv.id) !== dv) continue;
          const e = keys.get(dv.id);
          if (e) { if (!dv.keys) withKey(dv, e); } else { devices.delete(dv.id); devicesDirty = true; note(`${dv.id} (${dv.name}) has no key on this PC: pair it again`); }
        }
        if (devicesDirty) saveDevices();
      } catch (e) { note(`the device keys could not be read: ${e.message}`); }
    }
    // Supabase only while a device is paired or pairing, and only while S1 is signed in
    want = !!uid && [...devices.values()].some((dv) => dv.keys && usable(dv));
    if (want) {
      if (!ws) connect();
      else if (wsOpen) for (const dv of devices.values()) join(dv);
    } else if (ws || reconnectTimer) disconnect('nothing to relay');
    sweepLater();
  }
  function sweepLater() {
    cancel(sweepTimer); sweepTimer = null;
    if (!stopped && devices.size) sweepTimer = later(() => { sweepTimer = null; sweep().catch((e) => note(`the sweep failed: ${e && e.message}`)).finally(sweepLater); }, SWEEP_MS);
  }
  // pairings that ran out or never finished (key and all), old nonces, answers and part sets, and lastSeen to disk
  async function sweep() {
    const t = now();
    for (const dv of [...devices.values()]) {
      if (dv.state === 'pending' && !(dv.exp > t)) { await forgetDevice(dv, 'was not paired within 10 minutes: dropped'); continue; }
      // a handshake answered, but no envelope under its K' before the QR's K ran out: the pairing never finished
      if (dv.qr && !(dv.until > t)) { await forgetDevice(dv, 'did not finish pairing within 10 minutes of its last handshake: dropped'); continue; }
      for (const [n, at] of dv.nonces) { if (t - at <= NONCE_MS) break; dv.nonces.delete(n); }
      if (dv.old && !(dv.old.until > t)) dv.old = null;
      pruneKept(dv);
      for (const [k, a] of dv.parts) if (t - a.at > ASSEMBLY_MS) { dv.parts.delete(k); drop(dv); }
    }
    if (devicesDirty) saveDevices();
    if (![...devices.values()].some((dv) => dv.state === 'pending')) removePairPage();
    if (want && ![...devices.values()].some((dv) => dv.keys && usable(dv))) await evaluate();
  }
  function removePairPage() { try { fs.rmSync(pairPage, { force: true }); } catch {} }

  function start() {
    if (started || stopped) return;
    started = true;
    startedAt = now();
    if (typeof opts.relayKey !== 'function') markKey(); // says so in the log now, once
    const wifi = loadDevices();
    if (wifi.length) {
      saveDevices();
      note(`${wifi.length} phone(s) paired on this PC's Wi-Fi dropped: that way is gone, pair again through sync`);
      loadKeys().then(() => { if (wifi.filter((id) => keys.delete(id)).length) return saveKeys(); })
        .catch((e) => note(`the keys of the Wi-Fi phones could not be deleted: ${e && e.message}`));
    }
    unsubscribe = sync.onChange((ev) => {
      if (ev && ev.type === 'refreshed') refreshToken();
      else evaluate(true);
    });
    evaluate();
  }
  // reason 'pc-closing': every phone is told first (the server is shutting down)
  function stop(reason) {
    if (stopped) return Promise.resolve();
    stopped = true;
    want = false;
    if (unsubscribe) { try { unsubscribe(); } catch {} }
    cancel(sweepTimer); sweepTimer = null;
    if (reason === 'pc-closing') for (const dv of devices.values()) if (dv.state === 'paired') notice(dv, 'pc-closing');
    disconnect(reason === 'pc-closing' ? 'pc closing' : 'relay stopped');
    if (devicesDirty) saveDevices();
    return keyWrites.catch(() => {}).then(() => {});
  }

  // ---------- pairing, revoking, status ----------
  // mode 'relay' only (through Supabase: sync set up and signed in): pairing on this PC's Wi-Fi ('local') is gone.
  // o.phone: the asking phone's install id (pairing by sign-in, relay-lobby.js): that phone's earlier pairings here
  // are dropped first, so pairing again never piles devices up
  async function pair(name, mode = 'relay', o = {}) {
    if (!started || stopped) return [503, { ok: false, message: 'the relay is not running' }];
    if (mode === 'local') return [400, { ok: false, message: LOCAL_GONE }];
    if (mode !== 'relay') return [400, { ok: false, message: 'mode must be relay' }];
    let id = null, email = null;
    if (!sync.enabled()) return [409, { ok: false, message: 'sync is not set up on this PC, and the phone reaches it through sync: set it up first (node sync-api.js setup)' }];
    try { id = await sync.uid(); email = id ? await sync.email() : null; } catch {}
    if (!id) return [409, { ok: false, message: 'sign in to sync on this PC first (node sync-api.js signin)' }];
    const c = (readConfig(dataDir) || {}).config;
    if (!c) return [409, { ok: false, message: 'the sync settings could not be read' }];
    if (name != null && typeof name !== 'string') return [400, { ok: false, message: 'name must be text' }];
    await sweep();
    const phone = o && typeof o.phone === 'string' && PHONE_RE.test(o.phone) ? o.phone : undefined;
    if (phone) {
      const older = [...devices.values()].filter((dv) => !isComputer(dv) && dv.phone === phone);
      for (const dv of older) await forgetDevice(dv, 'was paired again by the same phone: the older pairing is dropped');
    }
    if ([...devices.values()].filter((dv) => dv.state === 'pending').length >= PENDING_MAX) return [429, { ok: false, message: `${PENDING_MAX} pairings are waiting already: use one, or wait 10 minutes` }];
    if (devices.size >= DEVICES_MAX) return [409, { ok: false, message: `${DEVICES_MAX} devices are paired: revoke one first` }];
    const dev = b64u(crypto.randomBytes(12)), K = crypto.randomBytes(32), t = now(), exp = t + PENDING_MS;
    try {
      await loadKeys();
      keys.set(dev, { k: K, qr: { until: exp, next: [] } });
      await saveKeys();
    } catch (e) { if (keys) keys.delete(dev); return [500, { ok: false, message: `the device key could not be kept safe on this PC: ${clip(e.message)}` }]; }
    const dv = makeDevice({ id: dev, name: clip(name, 60) || 'iPhone', state: 'pending', createdAt: t, exp, phone });
    withKey(dv, keys.get(dev));
    devices.set(dev, dv);
    saveDevices();
    note(`pairing ${dev} (${dv.name}): it waits 10 minutes for the phone`);
    await evaluate();
    const link = pairLink({ url: c.url, key: c.key, uid: id, email: email || '', pcName: pcName(), dev, k: b64u(K), exp });
    return [200, { ok: true, id: dev, mode, link, svg: qrSvg(link), exp }];
  }
  async function revoke(id) {
    const dv = typeof id === 'string' ? devices.get(id) : null;
    if (!dv) return [404, { ok: false, message: 'no such device (GET /relay/status lists them)' }];
    notice(dv, 'revoked');
    await forgetDevice(dv, 'was revoked');
    await evaluate();
    if (isComputer(dv) && typeof opts.onComputerGone === 'function') { try { opts.onComputerGone(dv.peer); } catch {} }
    return [200, { ok: true, id: dv.id }];
  }
  // ---------- linked computers (link.js, docs/link.md) ----------
  // another of Henry's machines, its key made by link.js's pairing (which runs by itself): a paired device of kind
  // 'computer' from the start, with no QR code and no handshake. One per peer: a newer link replaces the older one.
  // -> its view; throws when it can't be kept
  async function addComputer(o = {}) {
    if (!started || stopped) throw new Error('the relay is not running');
    const dev = String(o.dev || ''), peer = String(o.peer || '').toLowerCase(), k = Buffer.isBuffer(o.key) ? o.key : null;
    if (!DEV_RE.test(dev)) throw new Error('dev must be 16 characters of base64url');
    if (!UUID_RE.test(peer)) throw new Error('peer must be a sync device id');
    if (!k || k.length !== 32) throw new Error('the key must be 32 bytes');
    for (const dv of [...devices.values()]) if (isComputer(dv) && dv.peer === peer) await forgetDevice(dv, 'was linked again: the older link is dropped');
    const there = devices.get(dev);
    if (there) await forgetDevice(there, 'had the id of a new link: dropped');
    if (devices.size >= DEVICES_MAX) throw new Error(`${DEVICES_MAX} devices are paired: revoke one first`);
    await loadKeys();
    keys.set(dev, { k, qr: null });
    try { await saveKeys(); } catch (e) { keys.delete(dev); throw new Error(`the key could not be kept safe on this PC: ${e.message}`); }
    const t = now();
    const dv = makeDevice({ id: dev, name: clip(o.name, 60) || 'another computer', mode: 'relay', kind: 'computer', peer, state: 'paired', createdAt: t, pairedAt: t });
    withKey(dv, keys.get(dev));
    devices.set(dev, dv);
    saveDevices();
    note(`${dev} (${dv.name}, a linked computer) is paired`);
    await evaluate();
    return deviceView(dv);
  }
  // every device of that peer out (notice 'revoked' first, so its link.js forgets this machine too) -> how many
  async function removeComputer(peer, why = 'was unlinked') {
    const p = String(peer || '').toLowerCase();
    const list = [...devices.values()].filter((dv) => isComputer(dv) && dv.peer === p);
    for (const dv of list) { notice(dv, 'revoked'); await forgetDevice(dv, why); }
    if (list.length) await evaluate();
    return list.length;
  }
  const computers = () => [...devices.values()].filter(isComputer).map((dv) => ({
    id: dv.id, peer: dv.peer, name: dv.name, pairedAt: dv.pairedAt, lastSeen: dv.lastSeen,
    channel: dv.ch.state === 'errored' ? 'refused' : dv.ch.state,
  }));
  async function status() {
    let enabled = false, signedIn = false, email = null;
    try {
      enabled = !!sync.enabled();
      if (enabled) { signedIn = !!(await sync.uid()); email = signedIn ? await sync.email() : null; }
    } catch {}
    const t = now();
    const channelOf = (dv) => (dv.ch.state === 'errored' ? 'refused' : dv.ch.state);
    return {
      enabled, signedIn, email, connected: wsOpen,
      devices: [...devices.values()].filter((dv) => dv.state === 'paired' || dv.exp > t).map((dv) => ({
        ...deviceView(dv), ...(dv.state === 'paired' ? { finished: !dv.qr } : {}), ...(dv.qr ? { handshakes: dv.hsN } : {}), channel: channelOf(dv),
        ...(dv.ch.refused ? { problem: dv.ch.refused } : {}), dropped: dv.dropped,
      })),
    };
  }

  // ---------- routes: /relay/* (this PC only) ----------
  const originOk = (req) => {
    const o = req.headers && req.headers.origin, site = req.headers && req.headers['sec-fetch-site'];
    return (o === `http://127.0.0.1:${port}` || o === `http://localhost:${port}`) && site !== 'cross-site' && site !== 'same-site';
  };
  function handle(req, res, ctx) {
    const send = (code, o) => ctx.sendJson(res, code, o);
    const failed = (e) => { note(`${req.method} ${req.url} failed: ${e && e.message}`); if (!res.headersSent) send(500, { ok: false, message: 'the relay failed' }); };
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { return send(400, { ok: false, message: 'bad url' }); }
    let remote = true;
    try { remote = !!(ctx.remote && ctx.remote(req)); } catch {}
    if (remote) return send(403, { ok: false, message: 'only on the PC' });
    if (pathname === '/relay/status') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, { ok: false, message: 'GET' });
      return status().then((s) => send(200, s), failed);
    }
    if (pathname === '/relay/pair' || pathname === '/relay/revoke') {
      if (req.method !== 'POST') return send(405, { ok: false, message: 'POST' });
      if (!originOk(req)) return send(403, { ok: false, message: 'bad origin' });
      return ctx.readBody(req, res, (b) => {
        if (!b || typeof b !== 'object') return send(400, { ok: false, message: 'bad json' });
        (pathname === '/relay/pair' ? pair(b.name, b.mode == null ? 'relay' : b.mode) : revoke(b.id)).then(([code, out]) => send(code, out), failed);
      });
    }
    return send(404, { ok: false, message: 'no such route' });
  }

  return { start, stop, handle, status, pair, revoke, addComputer, removeComputer, computers };
}

// ---------- CLI ----------
const esc = (t) => String(t).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
function pairHtml(o) {
  const until = new Date(o.exp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Pair an iPhone</title>`
    + `<style>:root{color-scheme:light dark}body{font:15px/1.5 system-ui,sans-serif;max-width:32em;margin:2em auto;padding:0 16px;background:#fff;color:#222}`
    + `@media (prefers-color-scheme:dark){body{background:#1c1c1c;color:#ddd}}h1{font-size:1.3em}.qr{background:#fff;padding:8px;border-radius:8px;max-width:340px}.qr svg{display:block;width:100%;height:auto}</style></head><body>`
    + `<h1>Pair an iPhone with ${esc(o.pcName)}</h1><div class="qr">${o.svg}</div>`
    + `<p>Scan this with the Fleet View app before ${esc(until)}; after that, make a new one (node relay.js pair).</p>`
    + `<p>It pairs one phone. The phone and this PC then make a key of their own that this code does not hold, and the code opens nothing after that. `
    + `Until then, anyone who scans it and can also sign in as ${esc(o.email || 'your Google account')} could pair in your place, so keep it to yourself, `
    + `and close this page once your phone is paired.</p></body></html>`;
}
// cli(argv, { dataDir, port, out, err }) -> exit code
async function cli(argv, io = {}) {
  const out = io.out || ((t) => console.log(t)), err = io.err || ((t) => console.error(t));
  const dataDir = io.dataDir || P.dataDir();
  const [cmd, ...rest] = argv;
  const flag = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  const port = Number(flag('--port') || io.port) || 4777;
  if (!Number.isInteger(port) || port < 1 || port > 65535) { err('--port: not a port'); return 2; }
  const call = (method, p, body) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = { Accept: 'application/json' };
    if (data) Object.assign(headers, { 'Content-Type': 'application/json', 'Content-Length': data.length, Origin: `http://127.0.0.1:${port}` });
    const rq = http.request({ host: '127.0.0.1', port, method, path: p, headers, timeout: 30e3 }, (rs) => {
      const parts = [];
      rs.on('data', (c) => parts.push(c));
      rs.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch {} resolve({ status: rs.statusCode, json: j || {} }); });
    });
    rq.on('timeout', () => rq.destroy(new Error('Fleet View did not answer within 30 s')));
    rq.on('error', (e) => reject(e.code === 'ECONNREFUSED' ? new Error(`Fleet View is not running on port ${port}`) : e));
    rq.end(data || undefined);
  });
  const when = (t) => (t ? new Date(t).toLocaleString() : '-');
  const row = (d) => `${d.id}  ${d.name}  ${d.state}${d.state === 'pending' ? ` until ${when(d.exp)}` : `, paired ${when(d.pairedAt)}, last seen ${when(d.lastSeen)}`}${d.channel ? `  [channel ${d.channel}${d.problem ? `: ${d.problem}` : ''}]` : ''}`;
  try {
    if (cmd === 'status' || cmd === 'devices') {
      const r = await call('GET', '/relay/status');
      if (r.status !== 200) { err(`Fleet View said ${r.status}: ${r.json.message || 'no relay here (an older Fleet View?)'}`); return 1; }
      const s = r.json;
      if (cmd === 'status') {
        out(!s.enabled ? 'Through sync: off, sync is not set up on this PC (node sync-api.js setup).'
          : !s.signedIn ? 'Through sync: off, sync is not signed in (node sync-api.js signin).'
            : `Signed in to sync as ${s.email || '?'}; ${s.connected ? 'connected to Supabase' : 'not connected (it connects while a phone is paired through sync)'}.`);
        out(`${(s.devices || []).length} device(s).`);
      }
      for (const d of s.devices || []) out(row(d));
      if (cmd === 'devices' && !(s.devices || []).length) out('No devices: node relay.js pair');
      return 0;
    }
    if (cmd === 'pair') {
      const name = flag('--name');
      const r = await call('POST', '/relay/pair', name ? { name } : {});
      if (r.status !== 200 || !r.json.link) { err(`Could not pair: ${r.json.message || `HTTP ${r.status}`}`); return 1; }
      // the PC's name and the account as the link says them (never printed: the link is the secret)
      let j = {};
      try { j = JSON.parse(Buffer.from(new URL(r.json.link).searchParams.get('d') || '', 'base64url').toString('utf8')) || {}; } catch {}
      const file = path.join(dataDir, 'relay', 'pair.html');
      writeAtomic(file, pairHtml({ svg: r.json.svg, exp: r.json.exp, pcName: j.pcName || os.hostname(), email: j.email }));
      out(`Pairing ${r.json.id}: scan the QR code in ${file} with the Fleet View app before ${when(r.json.exp)} (open it in Fleet View's viewer).`);
      out('The page is a secret while it works, and is deleted once the phone pairs or the time runs out.');
      return 0;
    }
    if (cmd === 'revoke') {
      const id = rest.find((x) => !x.startsWith('--'));
      if (!id) { err('usage: node relay.js revoke <id>'); return 2; }
      const r = await call('POST', '/relay/revoke', { id });
      if (r.status !== 200) { err(`Could not revoke: ${r.json.message || `HTTP ${r.status}`}`); return 1; }
      out(`Revoked ${id}: the phone was told, and its key is deleted.`);
      return 0;
    }
  } catch (e) { err(e.message); return 1; }
  err([
    'usage:',
    '  node relay.js status           (sync, the connection, the devices)',
    '  node relay.js devices',
    '  node relay.js pair [--name N]  (writes <data folder>/relay/pair.html with the QR code)',
    '  node relay.js revoke <id>',
    '  (each takes --port <n> when Fleet View runs on another port than 4777)',
  ].join('\n'));
  return 2;
}

module.exports = {
  createRelay, cli, seal, open, decrypt, dirKey, aadText, topicOf, slices, pairLink, qrSvg, routeAllowed, peerRouteAllowed, PEER_ALLOW, pathOk,
  routeTimeout, startWeight, resumeKind, resumeWeight, xPair, xPublic, pairedKey, secretName, stepsOk, ALLOW, SIGNIN_LETTERS, SETTINGS_KEYS, MARKED, LABEL, PAIRED_INFO, LINK_V,
  PART_MAX, PARTS_MAX, C_MAX, LOCAL_GONE, uploadNameOk, b64Bytes,
  TIMES: { ROUTE_MS, WAIT_ROUTE_MS, WAIT_CAP_S, START_ROUTE_MS, RESUME_ROUTE_MS, ACTIVITY_MS, NOW_MS, MODEL_MS, REWIND_MS },
  LIMITS: { IN_FLIGHT_MAX, PER_S, PER_MIN, STARTS_AT_ONCE, STARTS_MAX, STARTS_MS, RES_DEVICE_MAX, UNPACKS_MAX, UNPACK_WAIT_MAX, INFLATE_UP_MAX, HS_GAP_MS, HS_MAX, UPLOAD_MAX, UPLOAD_NAME_MAX },
};

if (require.main === module) {
  cli(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.error(e && e.message ? e.message : String(e)); process.exitCode = 1; });
}
