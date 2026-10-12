// sync-api.js: Fleet View's connection to Henry's Supabase for conversation sync (docs/sync.md; the plan's part S1).
// Only the connection: the per-machine config, the Google sign-in, the tokens, and small REST and Storage helpers
// that the uploader (S2) and the materializer (S3) build on. It syncs nothing by itself and runs no loop.
//
// Off unless this machine has <dataDir>/sync/config.json ({ url, publishableKey }), which only
// `node sync-api.js setup` writes. Without it (every install from the share repo) enabled() is false, every /sync
// route but GET /sync/status answers 404, and nothing here reaches the network, starts a process or sets a timer.
//
// Routes (fleet-view.js sends /sync and /sync/* here):
//   GET  /sync/status    { configured, signedIn, email, member, expiresAt }: nothing secret; remote browsers may read it
//                        with onlyEmail set also { onlyEmail, refused? } (refused: the account just turned away)
//   GET  /sync/signin    this PC only: a 302 to Supabase's Google sign-in (PKCE)
//   GET  /sync/callback  this PC only: where Supabase sends the browser back (?state=&code=); a small page says how it went
//   POST /sync/signout   this PC only
//   POST /sync/open-signin  this PC only: opens http://127.0.0.1:<port>/sync/signin in the default browser (the page's
//                        Sync card; the page itself may be inside the Electron window, which Google refuses)
//   "This PC only": not a remote browser (h.remote), and no Sec-Fetch-Site of cross-site or same-site.
// The sign-in should open in a real browser (Google refuses embedded ones): http://127.0.0.1:<port>/sync/signin.
//
// Sign-in, as Supabase Auth (GoTrue) does PKCE; checked in its source, github.com/supabase/auth:
//   internal/api/external.go GetExternalProviderRedirectURL, internal/api/pkce.go, internal/api/token.go PKCE,
//   internal/api/verify.go prepPKCERedirectURL / prepErrorRedirectURL, internal/utilities/request.go IsRedirectURLValid
//   1. GET <url>/auth/v1/authorize?provider=google&redirect_to=<http://127.0.0.1:<port>/sync/callback?state=<s>>
//      &code_challenge=<base64url(sha256(verifier))>&code_challenge_method=s256 (prompt=select_account goes on to
//      Google, which then asks which Google account). GoTrue keeps its own state for Google; ours rides in redirect_to.
//   2. Back at redirect_to with ?code=<auth code> added (its other query parameters kept), or ?error=&error_code=
//      &error_description= on a failure. A redirect_to on a loopback IP (127.0.0.1) is accepted without being in
//      the project's redirect allow list (RFC 8252); any other is replaced with the Site URL.
//   3. POST <url>/auth/v1/token?grant_type=pkce { auth_code, code_verifier } -> { access_token, refresh_token,
//      expires_in, expires_at, user }. The code works once, for 5 minutes.
//   4. POST <url>/auth/v1/token?grant_type=refresh_token { refresh_token } before the access token runs out (each
//      refresh token works once: the new one is saved at once). Refused: signed out. Unreachable: still signed in.
//   POST <url>/auth/v1/logout?scope=local ends this sign-in on the server too.
// Who may sync is decided by the server: fleet_sync.members, checked by every table policy, fleet_sync.is_member()
// and the fleet-sync bucket's policies. The client only asks is_member() once after a sign-in, to say so on the page.
//
// The sign-in is never kept as plain text where the OS can protect it:
//   Windows  <dataDir>/sync/session.bin: DPAPI (CurrentUser), through Windows PowerShell; the data goes in on stdin
//   macOS    the login Keychain (service fleet-view-sync), written with `security -i` so the secret is never in a
//            process's arguments; only the refresh token is kept there; <dataDir>/sync/session.keychain says it is
//   Linux    <dataDir>/sync/session.json, mode 0600: NOT encrypted, kept safe only by the file's permissions
// Other secrets (the phone relay's keys) are kept the same way under their own name: protectedStore(dir, name) ->
// <dir>/<name>.bin | <name>.keychain (Keychain account <name>) | <name>.json. 'session' is the sign-in's own name.
//
// The helpers (each throws a SyncError { message, status, code }; none ever puts a token or the key in a message):
//   rest(method, table, { query, body, prefer, range, full, timeoutMs })   PostgREST on the fleet_sync schema
//   rpc(name, args)                                                       a fleet_sync function
//   storage.upload(path, buffer, { contentType, upsert }) / download(path) / remove([paths])   the fleet-sync
//     bucket; every path is put under '<user id>/' and may hold only [A-Za-z0-9._-] segments, never '.' or '..'
//   accessToken() (renewed first when under a minute is left), uid(), email()   the signed-in account
//   onChange(fn) -> unsubscribe   fn({ type: 'signed-in' | 'refreshed' | 'signed-out', uid, email }),
//     never a token or the key; a sign-in or sign-out by another process (the CLI) is heard the next time anything
//     reads the sign-in
//
// CLI:  node sync-api.js setup --url https://<project>.supabase.co --key <the publishable key>
//       node sync-api.js signin [--port 4777]   opens the sign-in in the default browser (Fleet View must be running)
//       node sync-api.js status | signout | off  (off: signs out and deletes the config: sync is off again)
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const P = require(path.join(__dirname, 'platform.js'));

const SCHEMA = 'fleet_sync';
const BUCKET = 'fleet-sync';
const STATE_MS = 10 * 60e3; // a sign-in has 10 minutes to come back
const STATE_KEEP_MS = 2 * STATE_MS; // after that it is "expired" for as long again, then unknown
const STATE_MAX = 20; // sign-ins remembered at once
const EARLY_MS = 60e3; // an access token with less than this left is refreshed first
// Timeouts. Node's timers run on a monotonic clock, which on macOS (and Linux) stops while the machine sleeps, and a
// connection open across a sleep is usually dead with no reset ever coming. So a flat timer alone could wait hours of
// wall-clock time on a Mac that keeps napping (Maintenance Sleep, DarkWake). Every request therefore also has a
// wall-clock deadline (Date.now()), and a watchdog (every WATCH_MS while requests are in flight) cuts any request the
// machine slept through: its wall-clock age ran ahead of its monotonic age by more than SLEPT_MS. A cut request fails
// as a 'network' SyncError with slept: true, and the caller's next round tries again on a new connection.
const AUTH_TIMEOUT_MS = 20e3;
const REST_TIMEOUT_MS = 30e3; // a REST call, answer and body, start to end
const STORAGE_TIMEOUT_MS = 5 * 60e3; // a storage call's overall cap
const STALL_MS = 30e3; // a download must start answering within REST_TIMEOUT_MS, then is cut when no byte comes for this long
const WATCH_MS = 5e3;
const SLEPT_MS = 15e3;
const MAX_OBJECT = 50 * 1024 * 1024; // the bucket's file_size_limit
const MAX_ANSWER = MAX_OBJECT + 1024 * 1024; // more than this read from one answer: refused, never all in memory
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME_RE = /^[a-z_][a-z0-9_]{0,62}$/;
const SEGMENT_RE = /^[A-Za-z0-9._-]{1,200}$/;
const KEYCHAIN_SERVICE = 'fleet-view-sync';
const KEYCHAIN_TEST_SERVICE = 'fleet-view-sync-test';
const SESSION_NAME = 'session'; // the sign-in's store name (and its Keychain account)
const STORE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

const syncDir = (dataDir) => path.join(dataDir || P.dataDir(), 'sync');
const configPath = (dataDir) => path.join(syncDir(dataDir), 'config.json');

class SyncError extends Error {
  constructor(message, status = 0, code = '') { super(message); this.name = 'SyncError'; this.status = status; this.code = code; }
}
const fail = (message, status = 0, code = '') => { throw new SyncError(message, status, code); };
const clip = (s, n = 300) => String(s == null ? '' : s).replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, n);

// ---------- what a failed request means for a scan (sync-up.js, sync-down.js, sync-live.js) ----------
// A network error, a timeout, 408, 429 or a 5xx is Supabase (or the way to it) having a bad moment, not the row's
// fault: the whole scan ends and the next one waits (the scan-level back-off: 5 s, doubling to 60 s, or longer when
// Supabase sent Retry-After on a 429 / 503, at most 5 min), and a scan that runs to its end resets it. Any other error
// is the row's own (a 4xx for bad data): that row backs off (the caller's per-row back-off) and the scan goes on.
const SCAN_BACKOFF_MIN_MS = 5e3, SCAN_BACKOFF_MAX_MS = 60e3, RETRY_AFTER_MAX_MS = 5 * 60e3;
const isTransient = (e) => !!e && (e.code === 'network' || e.code === 'timeout' || e.status === 408 || e.status === 429 || (e.status >= 500 && e.status < 600));
// a Retry-After header (seconds, or an HTTP date) -> ms to wait, 0 to RETRY_AFTER_MAX_MS, or null when there is none
function parseRetryAfter(v, nowMs = Date.now()) {
  const t = v == null ? '' : String(v).trim();
  if (!t) return null;
  let ms;
  if (/^\d+(?:\.\d+)?$/.test(t)) ms = Number(t) * 1000;
  else {
    if (!/[a-z]/i.test(t)) return null; // an HTTP date names its day and month ("-5" would parse as a year)
    const at = Date.parse(t);
    if (!Number.isFinite(at)) return null;
    ms = at - nowMs;
  }
  return Math.min(Math.max(0, Math.round(ms)), RETRY_AFTER_MAX_MS);
}
// One loop's health (each of sync-up.js, sync-down.js and sync-live.js has one), for /sync/activity and the pill:
//   done(clean)  a scan ran to its end: the back-off and the failure streak reset; clean (no error on any row) also
//                clears lastError
//   rowError(e)  one row failed and the scan goes on: lastError, nothing else
//   failed(e)    the scan failed as a whole: lastError, the streak + 1, and a transient error backs off -> the ms
//   wait()       ms the next scan still waits for (0: none)
//   status()     { lastSuccessAt, lastCleanAt, lastError: { at, message, code, status? } | null, failStreak, backingOff,
//                backoffUntil } (ISO times; never a token or the key: messages are SyncError's, which hold neither)
function createScanHealth(o = {}) {
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const minMs = Number(o.minMs) > 0 ? Number(o.minMs) : SCAN_BACKOFF_MIN_MS;
  const maxMs = Number(o.maxMs) > 0 ? Number(o.maxMs) : SCAN_BACKOFF_MAX_MS;
  const iso = (t) => (t ? new Date(t).toISOString() : null);
  let lastSuccessAt = 0, lastCleanAt = 0, lastError = null, failStreak = 0, backoffs = 0, backoffUntil = 0;
  const errOf = (e) => ({
    at: iso(now()), message: clip((e && e.message) || e || 'failed', 200),
    code: e && typeof e.code === 'string' && e.code ? e.code : null, ...(e && Number(e.status) > 0 ? { status: Number(e.status) } : {}),
  });
  return {
    done(clean = true) {
      const t = now();
      lastSuccessAt = t; failStreak = 0; backoffs = 0; backoffUntil = 0;
      if (clean) { lastCleanAt = t; lastError = null; }
    },
    rowError(e) { lastError = errOf(e); },
    failed(e) {
      lastError = errOf(e);
      failStreak++;
      if (!isTransient(e)) return 0;
      backoffs++;
      let wait = Math.min(minMs * 2 ** (backoffs - 1), maxMs);
      const ra = Number(e && e.retryAfterMs);
      if (Number.isFinite(ra) && ra > wait) wait = Math.min(ra, RETRY_AFTER_MAX_MS);
      backoffUntil = now() + wait;
      return wait;
    },
    wait() { return Math.max(0, backoffUntil - now()); },
    status() {
      const t = now();
      return {
        lastSuccessAt: iso(lastSuccessAt), lastCleanAt: iso(lastCleanAt), lastError: lastError ? { ...lastError } : null,
        failStreak, backingOff: backoffUntil > t, backoffUntil: backoffUntil > t ? iso(backoffUntil) : null,
      };
    },
  };
}

// ---------- the config ----------
// checkUrl(u) -> { ok, url } with url as https://<project>.supabase.co (nothing after it), or { ok: false, message }.
// o.allowLoopback (tests only, never from the config file): http://127.0.0.1:<port> too.
function checkUrl(u, o = {}) {
  const bad = (message) => ({ ok: false, message });
  if (typeof u !== 'string' || !u.trim()) return bad('the project URL is missing (https://<project>.supabase.co)');
  let x;
  try { x = new URL(u.trim()); } catch { return bad('not a URL'); }
  const bare = !x.username && !x.password && !x.search && !x.hash && (x.pathname === '/' || x.pathname === '');
  if (o.allowLoopback && x.protocol === 'http:' && x.hostname === '127.0.0.1' && x.port && bare) return { ok: true, url: `http://127.0.0.1:${x.port}` };
  if (x.protocol !== 'https:') return bad('it must start with https://');
  if (!bare || x.port) return bad('only the project address, nothing after it: https://<project>.supabase.co');
  if (!/^[a-z0-9][a-z0-9-]{0,62}\.supabase\.co$/.test(x.hostname)) return bad('it must be a Supabase project address: https://<project>.supabase.co');
  return { ok: true, url: `https://${x.hostname}` };
}
// checkKey(k) -> { ok, key } for a publishable key (sb_publishable_..., or an older anon JWT), else { ok: false, message }.
// A secret or service_role key is refused by name: it must never be kept on a PC.
function checkKey(k) {
  const bad = (message) => ({ ok: false, message });
  if (typeof k !== 'string' || !k.trim()) return bad('the publishable key is missing');
  const key = k.trim();
  if (/^sb_secret_/.test(key)) return bad('that is a secret key, which must never be on a PC: use the publishable key');
  if (/^sb_publishable_[A-Za-z0-9_-]{16,200}$/.test(key)) return { ok: true, key };
  const parts = key.split('.');
  if (parts.length === 3 && parts.every((p) => /^[A-Za-z0-9_-]{2,}$/.test(p))) {
    let role = '';
    try { role = String(JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')).role || ''); } catch {}
    if (role === 'anon') return { ok: true, key };
    if (role) return bad(`that key's role is "${clip(role, 40)}": only the publishable (anon) key may be kept on a PC`);
  }
  return bad('not a Supabase publishable key (it starts with sb_publishable_)');
}
// -> { config: { url, key } } | { problem } | {} (no file)
function readConfig(dataDir, o = {}) {
  let text;
  try { text = fs.readFileSync(configPath(dataDir), 'utf8'); } catch (e) { return e && e.code === 'ENOENT' ? {} : { problem: 'config.json could not be read' }; }
  let j;
  try { j = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { return { problem: 'config.json is not valid JSON' }; }
  const u = checkUrl(j && j.url, o), k = checkKey(j && j.publishableKey);
  if (!u.ok) return { problem: `config.json: url: ${u.message}` };
  if (!k.ok) return { problem: `config.json: publishableKey: ${k.message}` };
  return { config: { url: u.url, key: k.key } };
}
function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch {} throw e; }
  try { fs.chmodSync(file, 0o600); } catch {}
}
function writeConfig(dataDir, url, key) {
  writeAtomic(configPath(dataDir), `${JSON.stringify({ url, publishableKey: key }, null, 2)}\n`);
}

// ---------- PKCE (RFC 7636) ----------
const pkceVerifier = () => crypto.randomBytes(32).toString('base64url'); // 43 characters
const pkceChallenge = (verifier) => crypto.createHash('sha256').update(String(verifier), 'ascii').digest('base64url');

// ---------- where the sign-in is kept ----------
// A store: { kind, read() -> Promise<string|null>, write(text) -> Promise, clear() -> Promise, stamp() -> string|null }.
// stamp() changes whenever another process (the CLI) signs in or out, so the server reads the store again.
// name: which secret, the file name and Keychain account ('session', the sign-in, by default)
const storeName = (name) => {
  const n = name === undefined ? SESSION_NAME : name;
  if (typeof n !== 'string' || !STORE_NAME_RE.test(n)) fail('a store name is 1 to 41 of [a-z0-9-]', 400, 'bad_request');
  return n;
};
const fileStamp = (f) => { try { const st = fs.statSync(f); return `${st.mtimeMs}:${st.size}`; } catch { return null; } };

const PS_HEAD = "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';Add-Type -AssemblyName System.Security;"
  + "$e=[Text.Encoding]::UTF8.GetBytes('fleet-view-sync');$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());";
const PS_PROTECT = `${PS_HEAD}[Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$e,'CurrentUser')))`;
const PS_UNPROTECT = `${PS_HEAD}[Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($b,$e,'CurrentUser')))`;
// Windows PowerShell 5.1 (always there) runs a fixed script; the data goes in on stdin as base64 and comes out the same
// way, so nothing secret is ever in a command line
function dpapi(script, inputB64) {
  return new Promise((resolve, reject) => {
    const exe = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    let c;
    try {
      c = spawn(exe, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { return reject(new SyncError(`could not start PowerShell for DPAPI: ${e.message}`)); }
    let out = '', err = '', done = false;
    const end = (e, v) => { if (done) return; done = true; clearTimeout(t); if (e) reject(e); else resolve(v); };
    const t = setTimeout(() => { try { c.kill(); } catch {} end(new SyncError('DPAPI took too long (30 s)')); }, 30e3);
    c.stdout.on('data', (b) => { out += b; });
    c.stderr.on('data', (b) => { if (err.length < 4000) err += b; });
    c.on('error', (e) => end(new SyncError(`could not start PowerShell for DPAPI: ${e.message}`)));
    c.on('close', (code) => {
      const v = out.trim();
      if (code !== 0) return end(new SyncError(`DPAPI failed (PowerShell exit ${code}): ${clip(err.split(/\r?\n/).find((l) => l.trim() && !/^#< CLIXML/.test(l)) || '', 200)}`));
      if (!/^[A-Za-z0-9+/=]*$/.test(v)) return end(new SyncError('DPAPI gave back something unexpected'));
      end(null, v);
    });
    c.stdin.on('error', () => {});
    c.stdin.end(inputB64);
  });
}
function dpapiStore(dir, name) {
  const file = path.join(dir, `${storeName(name)}.bin`);
  return {
    kind: 'dpapi',
    file,
    stamp: () => fileStamp(file),
    async read() {
      let blob;
      try { blob = fs.readFileSync(file); } catch (e) { if (e && e.code === 'ENOENT') return null; throw e; }
      return Buffer.from(await dpapi(PS_UNPROTECT, blob.toString('base64')), 'base64').toString('utf8');
    },
    async write(text) { writeAtomic(file, Buffer.from(await dpapi(PS_PROTECT, Buffer.from(text, 'utf8').toString('base64')), 'base64')); },
    async clear() { fs.rmSync(file, { force: true }); },
  };
}
// The login Keychain's items are the user's, whatever folder a store is for, so the live service is only for stores
// in Fleet View's own data folder (P.dataDir()). A store anywhere else (a test's temporary folder, a test server's
// FV data folder) gets the service fleet-view-sync-test, so a test never reads, replaces or deletes the live sign-in
// or sync key. FV_KEYCHAIN_SERVICE overrides both (a test that wants a service of its own).
function keychainService(dir) {
  if (process.env.FV_KEYCHAIN_SERVICE) return process.env.FV_KEYCHAIN_SERVICE;
  const live = P.foldCase(path.resolve(P.dataDir())), d = P.foldCase(path.resolve(String(dir || '')));
  return d === live || d.startsWith(live + path.sep) ? KEYCHAIN_SERVICE : KEYCHAIN_TEST_SERVICE;
}
// the login Keychain through /usr/bin/security; `security -i` reads its command from stdin, so the secret is never in
// the arguments of a process (which any other process could list)
function keychainStore(dir, name) {
  const account = storeName(name);
  const KEYCHAIN_SERVICE = keychainService(dir);
  const marker = path.join(dir, `${account}.keychain`);
  const SECURITY = '/usr/bin/security';
  const find = () => new Promise((resolve, reject) => {
    execFile(SECURITY, ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w'], { encoding: 'utf8', timeout: 15e3 }, (err, out) => {
      if (err) return err.code === 44 ? resolve(null) : reject(new SyncError(`the Keychain could not be read (security exit ${err.code})`));
      resolve(String(out).trim());
    });
  });
  return {
    kind: 'keychain',
    file: marker,
    slim: true, // the sign-in keeps only the refresh token here: an access token is got again after a restart
    stamp: () => fileStamp(marker),
    async read() {
      if (!fs.existsSync(marker)) return null;
      const v = await find();
      return v ? Buffer.from(v, 'base64').toString('utf8') : null;
    },
    async write(text) {
      const b64 = Buffer.from(text, 'utf8').toString('base64'); // [A-Za-z0-9+/=]: nothing `security` would parse
      const err = await new Promise((resolve, reject) => {
        const c = spawn(SECURITY, ['-i'], { stdio: ['pipe', 'ignore', 'pipe'] });
        let e2 = '';
        const t = setTimeout(() => { try { c.kill(); } catch {} reject(new SyncError('the Keychain took too long (15 s)')); }, 15e3);
        c.stderr.on('data', (b) => { if (e2.length < 4000) e2 = (e2 + b).split(b64).join('<the sign-in>'); }); // never the secret in a message
        c.on('error', (e) => { clearTimeout(t); reject(new SyncError(`could not start security: ${e.message}`)); });
        c.on('close', (code) => { clearTimeout(t); if (code === 0) resolve(e2); else reject(new SyncError(`the Keychain refused it (security exit ${code}): ${clip(e2, 200)}`)); });
        c.stdin.on('error', () => {});
        c.stdin.end(`add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${account} -w "${b64}"\n`);
      });
      // read it back: `security -i` exits 0 even after a command that failed
      if ((await find()) !== b64) throw new SyncError(`the Keychain did not keep it${err.trim() ? `: ${clip(err, 200)}` : ''}`);
      writeAtomic(marker, `This Fleet View secret is in the login Keychain (service ${KEYCHAIN_SERVICE}, account ${account}).\n`);
    },
    async clear() {
      await new Promise((resolve) => execFile(SECURITY, ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account], { timeout: 15e3 }, () => resolve()));
      fs.rmSync(marker, { force: true });
    },
  };
}
// { note, text }: the text comes back exactly as written (a file from before, the sign-in's JSON itself, still reads)
function fileStore(dir, name) {
  const file = path.join(dir, `${storeName(name)}.json`);
  return {
    kind: 'file',
    file,
    stamp: () => fileStamp(file),
    async read() {
      let raw;
      try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { if (e && e.code === 'ENOENT') return null; throw e; }
      let j = null;
      try { j = JSON.parse(raw); } catch {}
      return j && typeof j.text === 'string' ? j.text : raw;
    },
    async write(text) {
      writeAtomic(file, `${JSON.stringify({ note: 'Not encrypted: this file is kept safe only by its permissions (0600).', text: String(text) }, null, 2)}\n`);
    },
    async clear() { fs.rmSync(file, { force: true }); },
  };
}
const defaultStore = (dir, name) => (P.isWin ? dpapiStore(dir, name) : P.isMac ? keychainStore(dir, name) : fileStore(dir, name));
// a secret kept like the sign-in (DPAPI / Keychain / 0600) under its own name; a store as above. 'session' is refused:
// that is the sign-in's, and writing it would sign this PC out
function protectedStore(dir, name) {
  if (typeof dir !== 'string' || !dir) fail('protectedStore needs a folder', 400, 'bad_request');
  if (storeName(name) === SESSION_NAME) fail(`'${SESSION_NAME}' is the sync sign-in's own store: pick another name`, 400, 'bad_request');
  return defaultStore(path.resolve(dir), name);
}

// the default browser, never a window of Fleet View's own (Google refuses embedded sign-ins); true when it started
function openInBrowser(url) {
  try {
    const [exe, args] = P.isWin ? ['explorer.exe', [url]] : P.isMac ? ['open', [url]] : ['xdg-open', [url]];
    const c = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true });
    c.on('error', () => {});
    c.unref();
    return true;
  } catch { return false; }
}
// a small JSON object body -> { value } | { tooBig: true } | { bad: true }; what is over the limit is read and dropped
function readSmallJson(req, max) {
  return new Promise((resolve) => {
    let parts = [], size = 0, done = false;
    const end = (v) => { if (!done) { done = true; parts = []; resolve(v); } };
    req.on('data', (b) => { size += b.length; if (size <= max) parts.push(b); });
    req.on('end', () => {
      if (size > max) return end({ tooBig: true });
      let value = null;
      try { value = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'); } catch { return end({ bad: true }); }
      end(value && typeof value === 'object' && !Array.isArray(value) ? { value } : { bad: true });
    });
    req.on('error', () => end({ bad: true }));
  });
}

// ---------- the connection ----------
// createSync({ port, dataDir, demo, log, fetch, now, store, allowLoopbackUrl, openUrl, wallNow, monoNow, watchMs }) -> the API below.
// fetch, now, store, allowLoopbackUrl, openUrl (in place of the default browser), wallNow / monoNow (the wall and
// monotonic clocks the requests' watchdog compares) and watchMs (its tick) are for tests.
function createSync(opts = {}) {
  const dataDir = opts.dataDir || P.dataDir();
  const dir = syncDir(dataDir);
  const port = Number(opts.port) || 4777;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const fetchFn = (...a) => (opts.fetch || globalThis.fetch)(...a);
  const store = opts.store || defaultStore(dir);
  const urlOpts = { allowLoopback: !!opts.allowLoopbackUrl };
  const openUrl = typeof opts.openUrl === 'function' ? opts.openUrl : openInBrowser;
  const wallNow = typeof opts.wallNow === 'function' ? opts.wallNow : Date.now;
  const monoNow = typeof opts.monoNow === 'function' ? opts.monoNow : () => performance.now();
  const watchMs = Number(opts.watchMs) > 0 ? Number(opts.watchMs) : WATCH_MS;
  // sync-crypto.js needs this file, so it is loaded when first used, not at the top
  // onlyEmail (Henry's machines, private.json's syncEmail): the one Google account that may sign in here. Another one
  // is refused at the callback and never kept, and a kept sign-in for another account counts as signed out.
  const onlyEmail = typeof opts.onlyEmail === 'string' && opts.onlyEmail ? opts.onlyEmail.toLowerCase() : null;
  const allowed = (s) => !onlyEmail || String(s.email || '').toLowerCase() === onlyEmail;
  let refused = null; // { email, at }: the last sign-in turned away, for the start screen (10 minutes)

  // config.json is read again when it changes (stat only), so `setup` works without a restart
  let cfgSeen = null, cfg = null, cfgProblem = '';
  function config() {
    if (opts.demo) return null;
    let st;
    try { st = fs.statSync(configPath(dataDir)); } catch { cfgSeen = null; cfg = null; cfgProblem = ''; return null; }
    const seen = `${st.mtimeMs}:${st.size}`;
    if (seen !== cfgSeen) {
      const r = readConfig(dataDir, urlOpts);
      cfgSeen = seen; cfg = r.config || null; cfgProblem = r.problem || '';
      if (cfgProblem) log(`sync: ${cfgProblem}`);
    }
    return cfg;
  }
  const need = () => config() || fail('sync is not set up on this PC', 404, 'off');

  // ---------- who hears about sign-ins ----------
  const listeners = new Set();
  function emit(type, s) {
    const ev = { type, uid: s ? s.uid : null, email: s ? s.email || null : null };
    for (const fn of [...listeners]) {
      try { fn(ev); } catch (e) { log(`sync: an onChange listener failed: ${e && e.message}`); }
    }
  }

  // ---------- the session ----------
  // { url, uid, email, member, accessToken, refreshToken, expiresAt (ms) }; one for another project URL is ignored
  let session = null, sessionSeen, loading = null;
  const forThis = (s, c) => (s && c && s.url === c.url && allowed(s) ? s : null);
  function parseSession(text) {
    if (!text) return null;
    let j;
    try { j = JSON.parse(text); } catch { return null; }
    if (!j || j.v !== 1 || typeof j.refreshToken !== 'string' || !j.refreshToken || !UUID_RE.test(String(j.uid || ''))) return null;
    return {
      url: String(j.url || ''), uid: String(j.uid).toLowerCase(), email: typeof j.email === 'string' ? j.email : '',
      member: typeof j.member === 'boolean' ? j.member : null, refreshToken: j.refreshToken,
      accessToken: typeof j.accessToken === 'string' ? j.accessToken : '', expiresAt: Number(j.expiresAt) || 0,
    };
  }
  async function load() {
    const c = config();
    if (!c) return null;
    const stamp = store.stamp();
    if (stamp === null) {
      const was = session;
      session = null; sessionSeen = null;
      if (was) emit('signed-out', was); // another process signed out
      return null;
    }
    if (stamp !== sessionSeen) {
      if (!loading) {
        loading = (async () => {
          const was = session;
          try { session = parseSession(await store.read()); } catch (e) { log(`sync: the sign-in could not be read: ${e.message}`); session = null; }
          sessionSeen = stamp;
          // another process signed in or out (one that only renewed it changes nothing a listener holds)
          if (session && (!was || was.uid !== session.uid)) emit('signed-in', session);
          else if (!session && was) emit('signed-out', was);
        })().finally(() => { loading = null; });
      }
      await loading;
    }
    return forThis(session, c);
  }
  async function save(s) {
    const keep = { v: 1, url: s.url, uid: s.uid, email: s.email, member: s.member, refreshToken: s.refreshToken };
    if (!store.slim) Object.assign(keep, { accessToken: s.accessToken, expiresAt: s.expiresAt });
    await store.write(JSON.stringify(keep));
    session = s;
    sessionSeen = store.stamp();
  }
  async function forget() {
    const was = session;
    try { await store.clear(); } catch (e) { log(`sync: the sign-in could not be removed: ${e.message}`); }
    session = null;
    sessionSeen = store.stamp();
    if (was) emit('signed-out', was);
  }
  // a token answer -> a session (prev: the one it refreshes)
  function sessionFrom(t, url, prev) {
    const user = (t && t.user) || {};
    if (!t || typeof t.access_token !== 'string' || !t.access_token || typeof t.refresh_token !== 'string' || !t.refresh_token) fail('Supabase sent no tokens', 502, 'bad_answer');
    const uid = String(user.id || (prev && prev.uid) || '').toLowerCase();
    if (!UUID_RE.test(uid)) fail('Supabase sent no user id', 502, 'bad_answer');
    if (prev && uid !== prev.uid) fail('Supabase answered for another user', 502, 'bad_answer');
    // expires_in is relative, so a PC clock that is off does not matter; expires_at (seconds) only when it is missing
    const inS = Number(t.expires_in), atS = Number(t.expires_at);
    const expiresAt = inS > 0 ? now() + inS * 1000 : atS > 0 ? atS * 1000 : now() + 3600e3;
    return {
      url, uid, email: String(user.email || (prev && prev.email) || '').toLowerCase(), member: prev ? prev.member : null,
      accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt,
    };
  }

  // ---------- HTTP ----------
  // Requests in flight, for the watchdog: { wall0, mono0, deadline (wall clock), cut(why) }
  const flying = new Set();
  let watch = null;
  function watchdog() {
    const w = wallNow(), m = monoNow();
    for (const f of [...flying]) {
      if ((w - f.wall0) - (m - f.mono0) > SLEPT_MS) f.cut('slept');
      else if (w > f.deadline) f.cut('total');
    }
  }
  function fly(f) {
    flying.add(f);
    if (!watch) { watch = setInterval(watchdog, watchMs); if (watch.unref) watch.unref(); }
    return () => {
      flying.delete(f);
      if (!flying.size && watch) { clearInterval(watch); watch = null; }
    };
  }
  // the body as a Buffer, read piece by piece so f.moved() can push the stall timer back; at most MAX_ANSWER bytes
  async function readBody(r, f) {
    if (!r.body || typeof r.body.getReader !== 'function') return Buffer.from(await r.arrayBuffer());
    const reader = r.body.getReader();
    const parts = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ANSWER) {
        reader.cancel().catch(() => {});
        throw new SyncError(`Supabase sent more than ${Math.round(MAX_ANSWER / 1048576)} MB`, 0, 'too_big');
      }
      parts.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
      f.moved();
    }
    return Buffer.concat(parts, size);
  }
  // -> { status, headers, data } (JSON) or { status, headers, body } (o.raw: a Buffer). Never follows a redirect, so
  // the token can't go to another host. o.timeoutMs: start to end (monotonic and wall clock); o.headMs: the answer
  // must start within this (default timeoutMs); o.stallMs: after that, cut when no byte of the body comes for this long
  async function request(url, o) {
    const timeoutMs = o.timeoutMs || REST_TIMEOUT_MS;
    const headMs = Math.min(o.headMs || timeoutMs, timeoutMs);
    const stallMs = o.stallMs || 0;
    const secs = (ms) => Math.round(ms / 1000);
    const netFail = (e) => {
      const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
      return timeout ? new SyncError(`Supabase did not answer within ${secs(timeoutMs)} s`, 0, 'timeout')
        : new SyncError(`could not reach Supabase (${clip((e && e.cause && e.cause.code) || (e && e.message) || 'network error', 120)})`, 0, 'network');
    };
    const ac = new AbortController();
    let cutErr = null, cutNow;
    // a cut settles the request at once, whether or not fetch heeds the abort (a dead socket may never answer it)
    const cutP = new Promise((resolve, reject) => { cutNow = reject; });
    cutP.catch(() => {});
    let phase = null, total = null;
    const f = {
      wall0: wallNow(), mono0: monoNow(), deadline: 0,
      cut(why) {
        if (cutErr) return;
        cutErr = why === 'slept' ? Object.assign(new SyncError('the connection was cut by sleep (this machine slept while Supabase was answering); trying again', 0, 'network'), { slept: true })
          : why === 'head' ? new SyncError(`Supabase did not answer within ${secs(headMs)} s`, 0, 'timeout')
            : why === 'stall' ? new SyncError(`Supabase stopped sending (nothing for ${secs(stallMs)} s)`, 0, 'timeout')
              : new SyncError(`Supabase did not answer within ${secs(timeoutMs)} s`, 0, 'timeout');
        try { ac.abort(cutErr); } catch {}
        cutNow(cutErr);
      },
      moved() {
        if (!stallMs) return;
        clearTimeout(phase);
        phase = setTimeout(() => f.cut('stall'), stallMs);
        if (phase.unref) phase.unref();
      },
    };
    f.deadline = f.wall0 + timeoutMs;
    const land = fly(f);
    total = setTimeout(() => f.cut('total'), timeoutMs);
    if (total.unref) total.unref();
    if (headMs < timeoutMs) { phase = setTimeout(() => f.cut('head'), headMs); if (phase.unref) phase.unref(); }
    let r, buf;
    try {
      const fp = fetchFn(url, { method: o.method, headers: o.headers, body: o.body, redirect: 'error', signal: ac.signal });
      Promise.resolve(fp).catch(() => {});
      r = await Promise.race([fp, cutP]);
      clearTimeout(phase); phase = null;
      f.moved(); // the answer started: from here the body must keep coming
      const bp = readBody(r, f);
      bp.catch(() => {});
      buf = await Promise.race([bp, cutP]);
    } catch (e) {
      try { ac.abort(); } catch {} // let go of the socket (a body cut short, one too big)
      if (cutErr) throw cutErr;
      if (e instanceof SyncError) throw e;
      throw netFail(e);
    } finally {
      clearTimeout(phase); clearTimeout(total);
      land();
    }
    if (r.status < 200 || r.status > 299) {
      let j = null;
      try { j = JSON.parse(buf.toString('utf8')); } catch {}
      const j0 = j && typeof j === 'object' ? j : {};
      let status = r.status;
      const what = clip(j0.msg || j0.message || j0.error_description || j0.error || buf.toString('utf8').slice(0, 200) || `HTTP ${r.status}`);
      // Storage may answer 400 with the real status in its body ("404" for a missing object), or InvalidJWT for a
      // token that ran out
      const inBody = Number(j0.statusCode);
      if (inBody >= 400 && inBody < 600) status = inBody;
      if (j0.error === 'not_found') status = 404;
      else if (j0.error === 'InvalidJWT' || /\bjwt expired\b/i.test(what)) status = 401;
      const err = new SyncError(`Supabase said ${status}: ${what}`, status, clip(j0.error_code || j0.code || j0.error || '', 60));
      // busy (429) or down for a while (503): how long Supabase asked us to wait, for the scan-level back-off
      if ([429, 503].includes(status) || [429, 503].includes(r.status)) {
        const ra = parseRetryAfter(r.headers && typeof r.headers.get === 'function' ? r.headers.get('retry-after') : null, wallNow());
        if (ra !== null) err.retryAfterMs = ra;
      }
      throw err;
    }
    if (o.raw) return { status: r.status, headers: r.headers, body: buf };
    let data = null;
    if (buf.length) {
      try { data = JSON.parse(buf.toString('utf8')); } catch { throw new SyncError('Supabase sent something that is not JSON', r.status, 'bad_answer'); }
    }
    return { status: r.status, headers: r.headers, data };
  }
  const authHeaders = (c, token) => ({ apikey: c.key, Authorization: `Bearer ${token}` });
  const tokenCall = (c, grant, body) => request(`${c.url}/auth/v1/token?grant_type=${grant}`, {
    method: 'POST', headers: { apikey: c.key, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body), timeoutMs: AUTH_TIMEOUT_MS,
  }).then((r) => r.data);

  // ---------- tokens ----------
  // A restart in the middle of a renewal must not lose the sign-in. Each refresh token works once, so:
  //   - the stored one is never removed or replaced before the new one is safely kept: the store writes a temp file and
  //     renames it over (writeAtomic; the Keychain replaces its item in one step), and only after Supabase answered
  //   - a renewal the store did not take (unsaved) is kept in memory and saved again on the next call, so a restart
  //     after it does not find the spent token on disk
  //   - a process stopped after Supabase answered and before the new token was kept: the next start sends the old one
  //     again, which Supabase takes within its reuse interval (it answers with the same new one)
  //   - a refused token: the store is read again first, and a newer one there (another Fleet View process renewed it)
  //     is used; only then is it signed out, and one refused as already used says so plainly (lost, in status() and
  //     the log, kept in <dataDir>/sync/signin-lost.json until the next sign-in), never silently
  let refreshing = null, unsaved = null;
  const lostPath = path.join(dir, 'signin-lost.json');
  let lostNote; // undefined: not read yet; null: none; { at, code, message }
  function readLost() {
    if (lostNote !== undefined) return lostNote;
    lostNote = null;
    try {
      const j = JSON.parse(fs.readFileSync(lostPath, 'utf8'));
      if (j && typeof j.message === 'string') lostNote = { at: String(j.at || ''), code: String(j.code || ''), message: clip(j.message, 300) };
    } catch {}
    return lostNote;
  }
  function setLost(note) {
    lostNote = note;
    try {
      if (note) writeAtomic(lostPath, `${JSON.stringify(note, null, 2)}\n`);
      else fs.rmSync(lostPath, { force: true });
    } catch {}
  }
  async function keep(next) {
    try {
      await save(next);
      unsaved = null;
    } catch (e) {
      session = next;
      unsaved = next;
      log(`sync: the renewed sign-in could not be saved (it is tried again on the next request): ${e.message}`);
    }
  }
  // the sign-in in the store, when it is a newer one of the same account than s (another process renewed it)
  async function storedNewer(s, c) {
    let disk = null;
    try { disk = parseSession(await store.read()); } catch { return null; }
    return disk && disk.url === c.url && disk.uid === s.uid && disk.refreshToken !== s.refreshToken && allowed(disk) ? disk : null;
  }
  async function lostSignIn(e) {
    const used = e.code === 'refresh_token_already_used' || /already\s*used/i.test(String(e.message || ''));
    const note = {
      at: new Date(now()).toISOString(), code: used ? 'refresh_reused' : 'refused',
      message: used
        ? 'Supabase refused the saved sign-in as already used: it was renewed, but Fleet View stopped before the new one was saved. Sign in again.'
        : `Supabase refused to renew the sign-in (${clip(e.message, 160)}). Sign in again.`,
    };
    setLost(note);
    log(`sync: signed out: ${note.message}`);
    await forget();
    throw new SyncError(`signed out: ${note.message}`, 401, 'signed_out');
  }
  function refresh(s, c) {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      let cur = s;
      for (let tries = 0; ; tries++) {
        let t;
        try { t = await tokenCall(c, 'refresh_token', { refresh_token: cur.refreshToken }); } catch (e) {
          // Supabase refused the refresh token (revoked, used, the user gone): signed out, unless the store has a newer
          // one. Unreachable, busy (429) or failing (5xx): still signed in, and the next call tries again
          if (![400, 401, 403, 404].includes(e.status)) throw e;
          const disk = tries === 0 ? await storedNewer(cur, c) : null;
          if (!disk) return lostSignIn(e);
          log('sync: the sign-in was renewed by another Fleet View process: using that one');
          session = disk; sessionSeen = store.stamp(); unsaved = null;
          if (disk.accessToken && disk.expiresAt - now() > EARLY_MS) return disk;
          cur = disk;
          continue;
        }
        const next = sessionFrom(t, c.url, cur);
        await keep(next);
        emit('refreshed', next);
        return next;
      }
    })().finally(() => { refreshing = null; });
    return refreshing;
  }
  // the session with an access token that has at least a minute left (o.force: a new one in any case)
  async function fresh(o = {}) {
    const c = need();
    if (unsaved && !refreshing) {
      const u = unsaved;
      if (session === u) await keep(u); else unsaved = null; // signed out or in again since: that one is gone
    }
    const s = await load();
    if (!s) fail('not signed in to sync', 401, 'signed_out');
    if (!o.force && s.accessToken && s.expiresAt - now() > EARLY_MS) return s;
    return refresh(s, c);
  }
  // fn(session) with a good token; one 401 gets a new token and one more try
  async function authed(fn) {
    let s = await fresh();
    try { return await fn(s); } catch (e) {
      if (e.status !== 401) throw e;
      s = await fresh({ force: true });
      return fn(s);
    }
  }

  // ---------- REST: the fleet_sync schema ----------
  function queryString(q) {
    if (q == null || q === '') return '';
    const s = typeof q === 'string' ? q.replace(/^\?/, '') : new URLSearchParams(q).toString();
    return s ? `?${s}` : '';
  }
  async function rest(method, table, o = {}) {
    const c = need();
    const m = String(method || 'GET').toUpperCase();
    if (!['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(m)) fail(`not a method: ${clip(m, 20)}`, 400, 'bad_request');
    if (typeof table !== 'string' || !NAME_RE.test(table)) fail('not a table name', 400, 'bad_request');
    const qs = queryString(o.query);
    return authed(async (s) => {
      const headers = { ...authHeaders(c, s.accessToken), 'Accept-Profile': SCHEMA, 'Content-Profile': SCHEMA, Accept: 'application/json' };
      if (o.prefer) headers.Prefer = String(o.prefer);
      if (o.range) headers.Range = String(o.range);
      if (o.body !== undefined) headers['Content-Type'] = 'application/json';
      const r = await request(`${c.url}/rest/v1/${table}${qs}`, { method: m, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body), timeoutMs: o.timeoutMs || REST_TIMEOUT_MS });
      return o.full ? { status: r.status, data: r.data, range: r.headers.get('content-range') } : r.data;
    });
  }
  async function rpc(name, args, o = {}) {
    const c = need();
    if (typeof name !== 'string' || !NAME_RE.test(name)) fail('not a function name', 400, 'bad_request');
    return authed(async (s) => (await request(`${c.url}/rest/v1/rpc/${name}`, {
      method: 'POST', headers: { ...authHeaders(c, s.accessToken), 'Accept-Profile': SCHEMA, 'Content-Profile': SCHEMA, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(args || {}), timeoutMs: o.timeoutMs || REST_TIMEOUT_MS,
    })).data);
  }
  // after a sign-in: is this account on the members list? true / false, or null when it could not be asked
  async function memberCheck(c, token) {
    try {
      const r = await request(`${c.url}/rest/v1/rpc/is_member`, {
        method: 'POST', headers: { ...authHeaders(c, token), 'Accept-Profile': SCHEMA, 'Content-Profile': SCHEMA, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: '{}', timeoutMs: 15e3,
      });
      return r.data === true ? true : r.data === false ? false : null;
    } catch (e) { log(`sync: could not ask whether this account may sync (${e.message})`); return null; }
  }

  // ---------- Storage: the fleet-sync bucket, always under '<user id>/' ----------
  const objectUrl = (c, full) => `${c.url}/storage/v1/object/${BUCKET}/${full.split('/').map(encodeURIComponent).join('/')}`;
  const storage = {
    async upload(rel, buf, o = {}) {
      const c = need();
      checkRel(rel);
      if (!Buffer.isBuffer(buf) && !(buf instanceof Uint8Array)) fail('upload needs a Buffer', 400, 'bad_request');
      if (buf.length > MAX_OBJECT) fail(`${buf.length} bytes is over the bucket's 50 MB`, 413, 'too_big');
      return authed(async (s) => {
        const full = objectPath(s.uid, rel);
        await request(objectUrl(c, full), {
          method: 'POST', body: buf, timeoutMs: o.timeoutMs || STORAGE_TIMEOUT_MS,
          headers: { ...authHeaders(c, s.accessToken), 'Content-Type': o.contentType || 'application/octet-stream', 'x-upsert': o.upsert ? 'true' : 'false' },
        });
        return { path: rel, size: buf.length };
      });
    },
    async download(rel, o = {}) {
      const c = need();
      checkRel(rel);
      return authed(async (s) => (await request(objectUrl(c, objectPath(s.uid, rel)), {
        method: 'GET', raw: true, headers: authHeaders(c, s.accessToken),
        timeoutMs: o.timeoutMs || STORAGE_TIMEOUT_MS, headMs: o.headMs || REST_TIMEOUT_MS, stallMs: o.stallMs || STALL_MS,
      })).body);
    },
    async remove(rels, o = {}) {
      const c = need();
      if (!Array.isArray(rels) || !rels.length || rels.length > 1000) fail('remove takes 1 to 1000 paths', 400, 'bad_request');
      rels.forEach(checkRel);
      return authed(async (s) => (await request(`${c.url}/storage/v1/object/${BUCKET}`, {
        method: 'DELETE', timeoutMs: o.timeoutMs || REST_TIMEOUT_MS,
        headers: { ...authHeaders(c, s.accessToken), 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ prefixes: rels.map((r) => objectPath(s.uid, r)) }),
      })).data);
    },
  };

  // ---------- sign-in ----------
  const states = new Map(); // state -> { verifier, at, used, url }
  function prune() {
    const t = now();
    for (const [k, v] of states) if (t - v.at > STATE_KEEP_MS) states.delete(k);
    while (states.size >= STATE_MAX) states.delete(states.keys().next().value);
  }
  // -> { location: Supabase's authorize URL, state }
  function beginSignIn() {
    const c = need();
    prune();
    const state = crypto.randomBytes(24).toString('base64url');
    const verifier = pkceVerifier();
    states.set(state, { verifier, at: now(), used: false, url: c.url });
    const q = new URLSearchParams({
      provider: 'google',
      redirect_to: `http://127.0.0.1:${port}/sync/callback?state=${state}`,
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: 's256',
    });
    // Supabase passes these on to Google: straight to the one account allowed here, else the account picker
    if (onlyEmail) q.set('login_hint', onlyEmail);
    else q.set('prompt', 'select_account');
    return { location: `${c.url}/auth/v1/authorize?${q}`, state };
  }
  // q: the callback's query -> { ok, email, member } or { ok: false, message }
  async function finishSignIn(q) {
    const no = (message) => ({ ok: false, message });
    const c = config();
    if (!c) return no('sync is not set up on this PC');
    const state = typeof q.state === 'string' ? q.state : '';
    const e = state ? states.get(state) : null;
    if (!e) return no('Fleet View did not start this sign-in (or it restarted since). Start it again.');
    if (e.used) return no('This sign-in was used already. Start it again.');
    e.used = true;
    const verifier = e.verifier;
    e.verifier = null;
    if (now() - e.at > STATE_MS) return no('This sign-in took more than 10 minutes. Start it again.');
    if (e.url !== c.url) return no('The sync settings changed during the sign-in. Start it again.');
    if (q.error || q.error_description) return no(`Supabase said: ${clip(q.error_description || q.error, 200)}`);
    const code = typeof q.code === 'string' ? q.code : '';
    if (!/^[A-Za-z0-9._~-]{8,200}$/.test(code)) return no('No sign-in code came back.');
    let s;
    try { s = sessionFrom(await tokenCall(c, 'pkce', { auth_code: code, code_verifier: verifier }), c.url, null); } catch (err) {
      return no(`The sign-in was refused: ${err.message}`);
    }
    if (!allowed(s)) {
      refused = { email: s.email || '', at: now() };
      try { await request(`${c.url}/auth/v1/logout?scope=local`, { method: 'POST', headers: authHeaders(c, s.accessToken), timeoutMs: 10e3 }); } catch {}
      log(`sync: a sign-in as ${s.email || s.uid} was turned away (only ${onlyEmail} syncs here)`);
      return no(`Only ${onlyEmail} can sync here, and this was ${s.email || 'another account'}. Go back to Fleet View and sign in again with ${onlyEmail}.`);
    }
    refused = null;
    s.member = await memberCheck(c, s.accessToken);
    try { await save(s); } catch (err) { return no(`Signed in, but the sign-in could not be saved: ${err.message}`); }
    unsaved = null;
    setLost(null);
    emit('signed-in', s);
    log(`sync: signed in as ${s.email || s.uid}${s.member === false ? ' (not on the members list: it can reach nothing)' : ''}`);
    return { ok: true, email: s.email, member: s.member };
  }
  async function signOut() {
    const c = config();
    const s = c ? await load().catch(() => null) : null;
    if (c && s && s.accessToken && s.expiresAt - now() > 5000) {
      try { await request(`${c.url}/auth/v1/logout?scope=local`, { method: 'POST', headers: authHeaders(c, s.accessToken), timeoutMs: 10e3 }); } catch (e) {
        log(`sync: sign-out: the server was not told (${e.message}); its refresh token stays until it expires`);
      }
    }
    setLost(null);
    await forget();
  }
  async function status() {
    const c = config();
    if (!c) return cfgProblem ? { configured: false, problem: cfgProblem } : { configured: false };
    const s = await load().catch(() => null);
    const turnedAway = !s && refused && now() - refused.at < STATE_MS ? refused.email || 'another account' : null;
    // the last sign-in was lost (a renewal Supabase refused): what happened, until the next sign-in
    const lost = s ? null : readLost();
    return {
      configured: true, signedIn: !!s, email: s ? s.email || null : null, member: s ? s.member : null,
      ...(onlyEmail ? { onlyEmail } : {}), ...(turnedAway ? { refused: turnedAway } : {}),
      ...(lost ? { lost: lost.message, lostAt: lost.at || null, lostCode: lost.code || null } : {}),
      expiresAt: s && s.accessToken && s.expiresAt ? new Date(s.expiresAt).toISOString() : null,
    };
  }

  // ---------- routes ----------
  function page(res, code, title, lines) {
    const esc = (t) => String(t).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`
      + `<title>Fleet View sync</title><style>:root{color-scheme:light dark}body{font:15px/1.5 system-ui,sans-serif;max-width:36em;margin:3em auto;padding:0 16px;background:#fff;color:#222}`
      + `@media (prefers-color-scheme:dark){body{background:#1c1c1c;color:#ddd}}h1{font-size:1.3em}</style></head><body>`
      + `<h1>${esc(title)}</h1>${lines.map((l) => `<p>${esc(l)}</p>`).join('')}</body></html>`;
    res.writeHead(code, {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    });
    res.end(html);
  }
  async function handle(req, res, pathname, h) {
    const send = (code, o) => h.sendJson(res, code, o);
    const remote = () => { try { return !!h.remote(req); } catch { return true; } };
    // this PC's own page only: not a remote browser, and not a request another site's page sent
    const pcOnly = () => {
      if (remote()) return false;
      const site = req.headers && req.headers['sec-fetch-site'];
      return site !== 'cross-site' && site !== 'same-site';
    };
    try {
      if (pathname === '/sync/status') {
        if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, { ok: false, message: 'GET' });
        return send(200, await status());
      }
      if (!config()) return send(404, { ok: false, message: 'sync is not set up on this PC' });
      if (pathname === '/sync/signin') {
        if (req.method !== 'GET') return send(405, { ok: false, message: 'GET' });
        if (remote()) return send(403, { ok: false, message: 'only on the PC' });
        const site = req.headers && req.headers['sec-fetch-site'];
        if (site === 'cross-site' || site === 'same-site') return send(403, { ok: false, message: 'bad origin' });
        const { location } = beginSignIn();
        res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Length': 0 });
        return res.end();
      }
      if (pathname === '/sync/callback') {
        if (req.method !== 'GET') return send(405, { ok: false, message: 'GET' });
        if (remote()) return send(403, { ok: false, message: 'only on the PC' });
        const sp = new URL(req.url, 'http://x').searchParams;
        const q = {};
        for (const k of ['state', 'code', 'error', 'error_description']) if (sp.has(k)) q[k] = sp.get(k);
        const r = await finishSignIn(q);
        if (!r.ok) return page(res, 400, 'Sync sign-in did not work', [r.message]);
        const lines = [r.member === true ? 'This account may sync.' : r.member === false
          ? 'This Google account is not on the sync members list, so it can read and write nothing. Sign in with another one.'
          : 'Fleet View could not check the sync members list just now; the server checks it on every request.'];
        return page(res, 200, `Signed in as ${r.email || 'your Google account'}`, [...lines, 'You can close this tab.']);
      }
      if (pathname === '/sync/signout') {
        if (req.method !== 'POST') return send(405, { ok: false, message: 'POST' });
        if (remote()) return send(403, { ok: false, message: 'only on the PC' });
        await signOut();
        return send(200, { ok: true });
      }
      if (pathname === '/sync/open-signin') {
        if (req.method !== 'POST') return send(405, { ok: false, message: 'POST' });
        if (!pcOnly()) return send(403, { ok: false, message: 'only on the PC' });
        const url = `http://127.0.0.1:${port}/sync/signin`;
        if (!openUrl(url)) return send(500, { ok: false, message: `The browser did not open: open ${url} in it yourself.` });
        return send(200, { ok: true, message: 'Your browser is opening the Google sign-in.' });
      }
      return send(404, { ok: false, message: 'no such route' });
    } catch (e) {
      log(`sync: ${req.method} ${pathname} failed: ${e && e.message}`);
      if (!res.headersSent) return send(e && e.status >= 400 && e.status < 600 ? e.status : 500, { ok: false, message: (e && e.message) || 'failed' });
      try { res.end(); } catch {}
    }
  }

  const api = {
    enabled: () => !!config(),
    status, handle, signOut, beginSignIn, finishSignIn,
    uid: async () => { const s = await load(); return s ? s.uid : null; },
    email: async () => { const s = await load(); return s ? s.email || null : null; },
    onChange(fn) {
      if (typeof fn !== 'function') fail('onChange takes a function', 400, 'bad_request');
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    accessToken: async () => (await fresh()).accessToken,
    checkMember: async () => {
      const c = need();
      const s = await fresh();
      const m = await memberCheck(c, s.accessToken);
      if (m !== null && m !== s.member) { s.member = m; try { await save(s); } catch {} }
      return m;
    },
    rest, rpc, storage,
    // resolves once no renewal is under way (fleet-view.js waits for it, briefly, before a restart)
    settled: () => (refreshing ? refreshing.then(() => {}, () => {}) : Promise.resolve()),
    storeKind: store.kind,
  };
  return api;
}

// a path inside the bucket folder: segments of [A-Za-z0-9._-], never '.' or '..', no empty one, at most 900 characters
function checkRel(rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 900) fail('not a storage path', 400, 'bad_path');
  for (const seg of rel.split('/')) if (!SEGMENT_RE.test(seg) || seg === '.' || seg === '..') fail(`not a storage path: ${clip(rel, 120)}`, 400, 'bad_path');
  return rel;
}
// '<uid>/<rel>': the only shape a caller can make, so nobody leaves their own folder
function objectPath(uid, rel) {
  if (typeof uid !== 'string' || !UUID_RE.test(uid)) fail('no user id', 401, 'signed_out');
  return `${uid.toLowerCase()}/${checkRel(rel)}`;
}

// ---------- CLI ----------
// cli(argv, { dataDir, out, err, fetch, store }) -> exit code
async function cli(argv, io = {}) {
  const out = io.out || ((t) => console.log(t)), err = io.err || ((t) => console.error(t));
  const dataDir = io.dataDir || P.dataDir();
  const [cmd, ...rest] = argv;
  const flag = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  const make = () => createSync({ dataDir, fetch: io.fetch, store: io.store });
  if (cmd === 'setup') {
    const u = checkUrl(flag('--url')), k = checkKey(flag('--key'));
    if (!u.ok) { err(`--url: ${u.message}`); return 2; }
    if (!k.ok) { err(`--key: ${k.message}`); return 2; }
    writeConfig(dataDir, u.url, k.key);
    out(`Sync is set up on this machine for ${u.url}; the settings are in ${configPath(dataDir)}.`);
    out('Next: sign in with Google: node sync-api.js signin (Fleet View must be running).');
    return 0;
  }
  if (cmd === 'status') {
    const s = await make().status();
    if (!s.configured) { out(s.problem ? `Sync is off: ${s.problem}` : 'Sync is off (not set up on this machine).'); return 0; }
    const c = readConfig(dataDir).config;
    out(`Sync is set up for ${c ? c.url : '?'}.`);
    out(s.signedIn ? `Signed in as ${s.email || '?'}; ${s.member === true ? 'a sync member' : s.member === false ? 'NOT a sync member (it can reach nothing)' : 'membership not checked yet'}.` : 'Not signed in.');
    if (s.expiresAt) out(`The current access token runs out at ${s.expiresAt} (renewed by itself).`);
    return 0;
  }
  if (cmd === 'signout' || cmd === 'off') {
    const api = make();
    if (api.enabled()) await api.signOut();
    if (cmd === 'off') {
      fs.rmSync(configPath(dataDir), { force: true });
      out('Sync is off on this machine: signed out and the settings removed.');
    } else out('Signed out.');
    return 0;
  }
  if (cmd === 'signin') {
    if (!readConfig(dataDir).config) { err('Sync is not set up on this machine: run setup first.'); return 2; }
    const port = Number(flag('--port')) || 4777;
    if (!Number.isInteger(port) || port < 1 || port > 65535) { err('--port: not a port'); return 2; }
    const url = `http://127.0.0.1:${port}/sync/signin`;
    out(`Opening ${url} in your browser (Fleet View must be running on port ${port}). If nothing opens, open it yourself.`);
    openInBrowser(url);
    return 0;
  }
  err([
    'usage:',
    '  node sync-api.js setup --url https://<project>.supabase.co --key <the publishable key>',
    '  node sync-api.js signin [--port 4777]',
    '  node sync-api.js status',
    '  node sync-api.js signout',
    '  node sync-api.js off        (signs out and deletes the settings: sync is off again)',
  ].join('\n'));
  return 2;
}

module.exports = {
  createSync, cli, checkUrl, checkKey, readConfig, writeConfig, readSmallJson, configPath, pkceVerifier, pkceChallenge, objectPath, checkRel,
  dpapiStore, keychainStore, keychainService, fileStore, protectedStore, syncDir, SyncError, SCHEMA, BUCKET,
  isTransient, parseRetryAfter, createScanHealth, SCAN_BACKOFF_MIN_MS, SCAN_BACKOFF_MAX_MS, RETRY_AFTER_MAX_MS,
};

if (require.main === module) {
  cli(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.error(e && e.message ? e.message : String(e)); process.exitCode = 1; });
}
