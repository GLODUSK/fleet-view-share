// Sync API: a test of sync-api.js, run with the system node:   node scripts/sync-api-test.js
// Off by default: with no config it makes no network call, starts no process and sets no timer, and every /sync
// route but GET /sync/status says 404. The setup CLI refuses a bad URL or a secret key and never prints the key.
// PKCE matches RFC 7636's test vector. The sign-in against a fake Supabase (a local HTTP server standing in for Auth,
// PostgREST and Storage): a state that is unknown, expired or used once already is refused; the code exchange, the
// members check, a refresh before expiry, one retry after a 401, a refresh that can't reach Supabase (still signed in)
// and one Supabase refuses (signed out). The REST and Storage helpers send the fleet_sync profile headers and keep
// every object under '<user id>/' ('../' and absolute names are refused). Remote browsers may read the status but
// not sign in or out. onChange hears signed-in, refreshed and signed-out (also by another process), with no token in
// them; email() gives the account. On Windows, the DPAPI store's round trip, with the secret never in a process's
// arguments. protectedStore(dir, name) keeps another secret beside the sign-in without touching it, and refuses
// 'session' and bad names; the file store gives back any text exactly and still reads a sign-in from before.
// The Sync card's routes: POST /sync/open-signin opens /sync/signin in the default browser, only on this PC (not
// remote, not cross-site); /sync/passphrase is gone. The key with no passphrase: signed out, sync-run.js waits; the
// first machine's sign-in makes the key in Blackbox's settings, a second machine's sign-in fetches the same one and
// starts at once (no minute wait); the key never reaches a log.
// Last, publish-share.js's guard, in a throwaway git repo: a planted Supabase key, project URL or sync config stops
// its dry run, and sync-api.js, this test and docs/sync.md pass it.
// Everything happens in a temp folder (SYNC_TEST_DIR, or the system temp folder), deleted at the end
// (SYNC_TEST_KEEP=1 keeps it). Exit 0 = all pass.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const cp = require('child_process');
const { Readable } = require('stream');

// every process start, timer and fetch from here on is counted (the off state must make none); patched before
// sync-api.js is loaded, so its own references are the counting ones
const started = [];
const realSpawn = cp.spawn, realExecFile = cp.execFile;
cp.spawn = function (...a) { started.push(a); return realSpawn.apply(this, a); };
cp.execFile = function (...a) { started.push(a); return realExecFile.apply(this, a); };
let timers = 0;
const realSetTimeout = global.setTimeout, realSetInterval = global.setInterval;
global.setTimeout = function (...a) { timers++; return realSetTimeout.apply(this, a); };
global.setInterval = function (...a) { timers++; return realSetInterval.apply(this, a); };
const realFetch = global.fetch;
let offFetches = 0;
global.fetch = async () => { offFetches++; throw new Error('the network is not allowed here'); };

const ROOT = path.resolve(__dirname, '..');
const S = require(path.join(ROOT, 'sync-api.js'));
const atLoad = { spawns: started.length, timers, fetches: offFetches };

const base = process.env.SYNC_TEST_DIR || os.tmpdir();
fs.mkdirSync(base, { recursive: true });
const T = fs.realpathSync(fs.mkdtempSync(path.join(base, 'sync-test-')));

let failures = 0, passes = 0;
const ok = (cond, what) => { if (cond) passes++; else { failures++; console.log(`FAIL ${what}`); } };
const eq = (a, b, what) => ok(JSON.stringify(a) === JSON.stringify(b), `${what}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
async function rejects(p, check, what) {
  try { await p; ok(false, `${what}: it did not fail`); } catch (e) { ok(check(e), `${what}: ${e && e.code} ${e && e.status} ${e && e.message}`); }
}
// values shaped like the real thing are put together here, so this file holds none the share guard would flag
const KEY = 'sb_' + 'publishable_' + 'TestOnlyKey0123456789abcd';
const SECRET_KEY = 'sb_' + 'secret_' + 'TestOnlyKey0123456789abcd';
const jwt = (payload) => [{ alg: 'HS256', typ: 'JWT' }, payload].map((o) => Buffer.from(JSON.stringify(o)).toString('base64url')).join('.') + '.c2lnbmF0dXJlLW5vdC1yZWFs';
const SB_URL = 'https://' + 'test-project' + '.supabase' + '.co';

// a fake http req/res for handle()
function fakeRes() {
  const r = { statusCode: 0, headers: {}, body: '', headersSent: false, json: null };
  r.writeHead = (code, h) => { r.statusCode = code; Object.assign(r.headers, h || {}); r.headersSent = true; return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.end = (b) => { if (b) r.body += String(b); };
  return r;
}
const ctx = (remote) => ({
  sendJson: (res, code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.json = o; res.end(JSON.stringify(o)); },
  readBody: (req, res, cb) => cb({}),
  remote: () => (remote ? { name: 'pc.example.ts.net', login: 'someone', device: 'a Mac' } : null),
});
async function route(api, method, url, o = {}) {
  const head = { method, url, headers: o.headers || {} };
  // a body: the request is a stream, as http gives it
  const req = o.body === undefined ? head : Object.assign(Readable.from([Buffer.from(o.body)]), head), res = fakeRes();
  await api.handle(req, res, decodeURIComponent(new URL(url, 'http://x').pathname), ctx(o.remote));
  return res;
}
const memStore = () => {
  let text = null, n = 0;
  return { kind: 'memory', stamp: () => (text === null ? null : `m${n}`), read: async () => text, write: async (t) => { text = t; n++; }, clear: async () => { text = null; n++; }, peek: () => text };
};

// ---------- the fake Supabase ----------
const UID = crypto.randomUUID();
const fake = { codes: new Map(), refresh: new Map(), access: new Map(), calls: [], objects: new Map(), member: true, refreshDown: false, settings: new Map() };
const issue = (uid, email) => {
  const at = `at-${crypto.randomBytes(12).toString('hex')}`, rt = `rt-${crypto.randomBytes(12).toString('hex')}`;
  fake.access.set(at, uid);
  fake.refresh.set(rt, { uid, email });
  return { access_token: at, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: rt, user: { id: uid, email, aud: 'authenticated' } };
};
const server = http.createServer((req, res) => {
  const parts = [];
  req.on('data', (b) => parts.push(b));
  req.on('end', () => {
    const body = Buffer.concat(parts), u = new URL(req.url, 'http://x');
    fake.calls.push({ method: req.method, path: u.pathname, search: u.search, headers: req.headers, body });
    const json = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.headers.apikey !== KEY) return json(401, { message: 'No API key found in request' });
    if (u.pathname === '/auth/v1/token') {
      const b = JSON.parse(body.toString() || '{}'), grant = u.searchParams.get('grant_type');
      if (grant === 'pkce') {
        const c = fake.codes.get(b.auth_code);
        if (!c) return json(404, { code: 404, error_code: 'flow_state_not_found', msg: 'invalid flow state, no valid flow state found' });
        fake.codes.delete(b.auth_code);
        if (S.pkceChallenge(b.code_verifier) !== c.challenge) return json(400, { code: 400, error_code: 'bad_code_verifier', msg: 'code challenge does not match previously saved code verifier' });
        return json(200, issue(c.uid, c.email));
      }
      if (grant === 'refresh_token') {
        if (fake.refreshDown) return void res.destroy();
        const who = fake.refresh.get(b.refresh_token);
        if (!who) return json(400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token: Refresh Token Not Found' });
        fake.refresh.delete(b.refresh_token);
        return json(200, issue(who.uid, who.email));
      }
      return json(400, { msg: 'unsupported_grant_type' });
    }
    const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
    const uid = fake.access.get(token);
    if (u.pathname.startsWith('/storage/')) {
      if (!uid) return json(400, { statusCode: '403', error: 'InvalidJWT', message: 'jwt expired' });
      const pre = '/storage/v1/object/fleet-sync';
      if (u.pathname === pre && req.method === 'DELETE') {
        const { prefixes } = JSON.parse(body.toString());
        const gone = prefixes.filter((p) => fake.objects.delete(p)).map((name) => ({ name }));
        return json(200, gone);
      }
      if (!u.pathname.startsWith(pre + '/')) return json(400, { statusCode: '404', error: 'not_found', message: 'Bucket not found' });
      const name = u.pathname.slice(pre.length + 1).split('/').map(decodeURIComponent).join('/');
      if (!name.startsWith(uid + '/')) return json(400, { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' });
      if (req.method === 'POST') {
        if (fake.objects.has(name) && req.headers['x-upsert'] !== 'true') return json(400, { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' });
        fake.objects.set(name, body);
        return json(200, { Key: `fleet-sync/${name}`, Id: crypto.randomUUID() });
      }
      if (req.method === 'GET') {
        if (!fake.objects.has(name)) return json(400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        return res.end(fake.objects.get(name));
      }
      return json(405, { message: 'no' });
    }
    if (!uid) return json(401, { code: 'PGRST303', message: 'JWT expired' });
    if (u.pathname === '/auth/v1/logout') {
      for (const [rt, who] of fake.refresh) if (who.uid === uid) fake.refresh.delete(rt);
      fake.access.delete(token);
      res.writeHead(204);
      return res.end();
    }
    const profile = req.method === 'GET' || req.method === 'HEAD' ? req.headers['accept-profile'] : req.headers['content-profile'];
    if (profile !== 'fleet_sync') return json(406, { code: 'PGRST106', message: 'The schema must be one of the following: public' });
    if (u.pathname === '/rest/v1/rpc/is_member') return json(200, fake.member);
    if (u.pathname === '/rest/v1/devices') {
      if (req.method === 'GET') return json(200, [{ id: 'd1', name: 'pc', user_id: uid }]);
      if (req.method === 'POST') return json(201, [{ ...JSON.parse(body.toString()), user_id: uid, prefer: req.headers.prefer || null }]);
    }
    if (u.pathname === '/rest/v1/settings') { // the sync-key row (sync-crypto.js); one table for every user here
      if (req.method === 'GET') { const k = String(u.searchParams.get('key') || '').replace(/^eq\./, ''); return json(200, fake.settings.has(k) ? [{ value_enc: fake.settings.get(k) }] : []); }
      if (req.method === 'POST') {
        const b = JSON.parse(body.toString());
        if (!fake.settings.has(b.key) || !/ignore-duplicates/.test(req.headers.prefer || '')) fake.settings.set(b.key, b.value_enc);
        res.writeHead(201);
        return res.end();
      }
    }
    if (u.pathname === '/rest/v1/slow') return; // never answers
    if (u.pathname === '/rest/v1/broken') return json(403, { code: '42501', details: null, hint: null, message: 'permission denied for table broken' });
    json(404, { message: 'no such thing' });
  });
});
const callsOf = (p, grant) => fake.calls.filter((c) => c.path === p && (!grant || c.search.includes(`grant_type=${grant}`)));

async function main() {
  // ---------- off: no config ----------
  eq(atLoad, { spawns: 0, timers: 0, fetches: 0 }, 'loading sync-api.js starts nothing');
  const offDir = path.join(T, 'off');
  const before = { spawns: started.length, timers, fetches: offFetches };
  const off = S.createSync({ dataDir: offDir, port: 4777 });
  ok(off.enabled() === false, 'no config: enabled() is false');
  eq(await off.status(), { configured: false }, 'no config: status');
  eq((await route(off, 'GET', '/sync/status')).json, { configured: false }, 'no config: GET /sync/status');
  eq((await route(off, 'GET', '/sync/status', { remote: true })).json, { configured: false }, 'no config: a remote browser reads the status too');
  for (const [m, u] of [['GET', '/sync/signin'], ['GET', '/sync/callback?state=x&code=y'], ['POST', '/sync/signout'], ['POST', '/sync/open-signin'], ['GET', '/sync/passphrase'], ['GET', '/sync'], ['GET', '/sync/other']]) {
    eq((await route(off, m, u)).statusCode, 404, `no config: ${m} ${u} is 404`);
  }
  await rejects(off.rest('GET', 'devices'), (e) => e.code === 'off', 'no config: rest() says off');
  await rejects(off.rpc('is_member'), (e) => e.code === 'off', 'no config: rpc() says off');
  await rejects(off.storage.upload('a/b', Buffer.from('x')), (e) => e.code === 'off', 'no config: upload() says off');
  await rejects(off.storage.download('a/b'), (e) => e.code === 'off', 'no config: download() says off');
  await rejects(off.accessToken(), (e) => e.code === 'off', 'no config: accessToken() says off');
  eq(await off.uid(), null, 'no config: uid() is null');
  await off.signOut();
  eq({ spawns: started.length, timers, fetches: offFetches }, before, 'no config: no process, no timer, no fetch');
  ok(!fs.existsSync(path.join(offDir, 'sync')), 'no config: nothing written to disk');
  global.fetch = realFetch;

  // ---------- the setup CLI ----------
  const cliDir = path.join(T, 'cli');
  const run = async (args) => { const out = [], err = []; const code = await S.cli(args, { dataDir: cliDir, out: (t) => out.push(t), err: (t) => err.push(t) }); return { code, out: out.join('\n'), err: err.join('\n') }; };
  const cfgFile = S.configPath(cliDir);
  const badUrls = [undefined, '', 'not a url', SB_URL.replace('https', 'http'), 'https://example.com', `${SB_URL}/rest/v1`, `${SB_URL}?x=1`, `${SB_URL}#x`,
    SB_URL.replace('https://', 'https://user:pw@'), `${SB_URL}:8443`, 'http://127.0.0.1:5000', 'https://evil.com/.supabase.co'];
  for (const u of badUrls) {
    const r = await run(['setup', ...(u === undefined ? [] : ['--url', u]), '--key', KEY]);
    ok(r.code === 2 && /--url/.test(r.err), `setup refuses the URL ${u}`);
  }
  const badKeys = [[undefined, /missing/], ['hello', /not a Supabase publishable key/], [SECRET_KEY, /secret key/], [jwt({ role: 'service_role', iss: 'supabase' }), /service_role/], ['sb_' + 'publishable_' + 'short', /not a Supabase/]];
  for (const [k, re] of badKeys) {
    const r = await run(['setup', '--url', SB_URL, ...(k === undefined ? [] : ['--key', k])]);
    ok(r.code === 2 && re.test(r.err), `setup refuses the key ${String(k).slice(0, 20)}: ${r.err}`);
    ok(!r.err.includes(SECRET_KEY) && !r.out.includes(SECRET_KEY), 'a refused secret key is not printed');
  }
  ok(!fs.existsSync(cfgFile), 'nothing was saved for a refused setup');
  let r = await run(['setup', '--url', SB_URL.toUpperCase().replace('HTTPS', 'https') + '/', '--key', KEY]);
  ok(r.code === 0, `setup takes a good URL and key: ${r.err}`);
  ok(!r.out.includes(KEY) && !r.err.includes(KEY), 'setup never prints the key');
  eq(JSON.parse(fs.readFileSync(cfgFile, 'utf8')), { url: SB_URL, publishableKey: KEY }, 'the saved config (URL lowercased, no slash)');
  if (process.platform !== 'win32') ok((fs.statSync(cfgFile).mode & 0o777) === 0o600, 'config.json is 0600');
  const anon = jwt({ role: 'anon', iss: 'supabase' });
  r = await run(['setup', '--url', SB_URL, '--key', anon]);
  ok(r.code === 0 && JSON.parse(fs.readFileSync(cfgFile, 'utf8')).publishableKey === anon, 'setup takes an older anon JWT key');
  r = await run(['status']);
  ok(r.code === 0 && /set up for/.test(r.out) && /Not signed in/.test(r.out) && !r.out.includes(anon), `status, not signed in: ${r.out}`);
  r = await run(['bogus']);
  ok(r.code === 2 && /usage/.test(r.err), 'an unknown command prints the usage');
  r = await run(['off']);
  ok(r.code === 0 && !fs.existsSync(cfgFile), 'off removes the config');
  // the real CLI, in its own process, with the data folder moved into the temp folder
  const home = path.join(T, 'home');
  fs.mkdirSync(home, { recursive: true });
  const env = { ...process.env, LOCALAPPDATA: home, XDG_STATE_HOME: home, HOME: home };
  const node = (args) => cp.spawnSync(process.execPath, [path.join(ROOT, 'sync-api.js'), ...args], { encoding: 'utf8', env, windowsHide: true });
  let p = node(['setup', '--url', SB_URL, '--key', KEY]);
  ok(p.status === 0 && !p.stdout.includes(KEY) && !p.stderr.includes(KEY), `the CLI's setup in its own process: ${p.stderr}`);
  const dataDir = process.platform === 'win32' ? path.join(home, 'fleet-view') : process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'fleet-view') : path.join(home, 'fleet-view');
  ok(fs.existsSync(S.configPath(dataDir)), 'it saved the config in <dataDir>/sync/config.json');
  p = node(['status']);
  ok(p.status === 0 && /Not signed in/.test(p.stdout), `the CLI's status: ${p.stdout}${p.stderr}`);
  p = node([]);
  ok(p.status === 2, 'the CLI with no command exits 2');

  // ---------- PKCE ----------
  eq(S.pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', 'PKCE: RFC 7636 appendix B');
  const v1 = S.pkceVerifier(), v2 = S.pkceVerifier();
  ok(/^[A-Za-z0-9_-]{43}$/.test(v1) && v1 !== v2, 'PKCE: a verifier is 43 base64url characters, new each time');

  // ---------- the fake Supabase: sign-in, tokens, REST, Storage ----------
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const fakeUrl = `http://127.0.0.1:${server.address().port}`;
  const liveDir = path.join(T, 'live');
  let clock = Date.now();
  const logs = [];
  const store = memStore();
  const api = S.createSync({ dataDir: liveDir, port: 4777, fetch: realFetch, now: () => clock, store, allowLoopbackUrl: true, log: (t) => logs.push(t) });
  ok(!api.enabled(), 'before setup: off');
  const events = [];
  const unsub = api.onChange((e) => events.push(e));
  api.onChange(() => { throw new Error('a listener that breaks'); });
  const lastEvent = () => events[events.length - 1] || {};
  fs.mkdirSync(path.join(liveDir, 'sync'), { recursive: true });
  fs.writeFileSync(S.configPath(liveDir), JSON.stringify({ url: fakeUrl, publishableKey: KEY }));
  ok(api.enabled(), 'a config written while running turns it on (no restart)');
  const strict = S.createSync({ dataDir: liveDir, store: memStore() });
  ok(!strict.enabled() && /url/.test((await strict.status()).problem || ''), 'a config pointing anywhere but https://*.supabase.co is refused');
  eq(await api.status(), { configured: true, signedIn: false, email: null, member: null, expiresAt: null }, 'configured, not signed in');

  // GET /sync/signin -> Supabase's authorize URL
  const signin = async () => {
    const res = await route(api, 'GET', '/sync/signin', { headers: { 'sec-fetch-site': 'none' } });
    ok(res.statusCode === 302, `GET /sync/signin redirects (${res.statusCode})`);
    const loc = new URL(res.headers.Location);
    const back = new URL(loc.searchParams.get('redirect_to'));
    return { loc, back, state: back.searchParams.get('state'), challenge: loc.searchParams.get('code_challenge') };
  };
  const a = await signin();
  ok(a.loc.origin === fakeUrl && a.loc.pathname === '/auth/v1/authorize', `it goes to <url>/auth/v1/authorize (${a.loc.origin}${a.loc.pathname})`);
  eq([a.loc.searchParams.get('provider'), a.loc.searchParams.get('code_challenge_method'), a.loc.searchParams.get('prompt')], ['google', 's256', 'select_account'], 'provider, method, prompt');
  ok(/^[A-Za-z0-9_-]{43}$/.test(a.challenge), 'the code challenge is a base64url sha256');
  eq(`${a.back.origin}${a.back.pathname}`, 'http://127.0.0.1:4777/sync/callback', 'redirect_to is this port\'s /sync/callback');
  ok(/^[A-Za-z0-9_-]{32}$/.test(a.state || ''), 'redirect_to carries a random state');
  // Supabase sends the browser back with ?code= (after Google): the fake knows the code and the challenge
  const code = crypto.randomUUID();
  fake.codes.set(code, { challenge: a.challenge, uid: UID, email: 'Member@Example.com' });
  let res = await route(api, 'GET', `/sync/callback?state=${a.state}&code=${code}`);
  ok(res.statusCode === 200 && /Signed in as member@example\.com/.test(res.body) && /This account may sync/.test(res.body), `the callback signs in: ${res.statusCode} ${res.body.slice(0, 300)}`);
  ok(/default-src 'none'/.test(res.headers['Content-Security-Policy'] || ''), 'the callback page has a strict CSP');
  const ex = callsOf('/auth/v1/token', 'pkce');
  ok(ex.length === 1 && JSON.parse(ex[0].body).auth_code === code && ex[0].headers.apikey === KEY && !ex[0].headers.authorization, 'one PKCE exchange, with the apikey');
  ok(callsOf('/rest/v1/rpc/is_member').length === 1, 'it asked is_member once');
  let st = await api.status();
  ok(st.configured && st.signedIn && st.email === 'member@example.com' && st.member === true && /^\d{4}-/.test(st.expiresAt || ''), `status after sign-in: ${JSON.stringify(st)}`);
  const firstAccess = [...fake.access.keys()][0], firstRefresh = [...fake.refresh.keys()][0];
  ok(!JSON.stringify(st).includes(firstAccess) && !JSON.stringify(st).includes(firstRefresh) && !JSON.stringify(st).includes(KEY), 'status holds no token and no key');
  eq((await route(api, 'GET', '/sync/status', { remote: true })).json, st, 'a remote browser reads the same status');
  ok(JSON.parse(store.peek()).refreshToken === firstRefresh, 'the sign-in went to the store');
  eq(events, [{ type: 'signed-in', uid: UID, email: 'member@example.com' }], 'onChange: signed-in, with uid and email');
  ok(logs.some((l) => /an onChange listener failed/.test(l)), 'onChange: a listener that throws is logged, the others still run');
  eq([await api.uid(), await api.email()], [UID, 'member@example.com'], 'uid() and email()');
  let threwOn = false;
  try { api.onChange('nope'); } catch (e) { threwOn = e.code === 'bad_request'; }
  ok(threwOn, 'onChange takes only a function');

  // the states
  const n0 = fake.calls.length;
  res = await route(api, 'GET', `/sync/callback?state=${a.state}&code=${code}`);
  ok(res.statusCode === 400 && /used already/.test(res.body), 'the same callback again is refused (used)');
  res = await route(api, 'GET', `/sync/callback?state=nope&code=${code}`);
  ok(res.statusCode === 400 && /did not start/.test(res.body), 'an unknown state is refused');
  res = await route(api, 'GET', `/sync/callback?code=${code}`);
  ok(res.statusCode === 400 && /did not start/.test(res.body), 'no state is refused');
  const b = await signin();
  clock += 11 * 60e3;
  res = await route(api, 'GET', `/sync/callback?state=${b.state}&code=${crypto.randomUUID()}`);
  ok(res.statusCode === 400 && /10 minutes/.test(res.body), 'a state older than 10 minutes is refused');
  res = await route(api, 'GET', `/sync/callback?state=${b.state}&code=${crypto.randomUUID()}`);
  ok(res.statusCode === 400 && /used already/.test(res.body), 'an expired state stays refused');
  const c = await signin();
  res = await route(api, 'GET', `/sync/callback?state=${c.state}&error=access_denied&error_description=${encodeURIComponent('The user cancelled <b>')}`);
  ok(res.statusCode === 400 && /The user cancelled &#60;b&#62;/.test(res.body), 'an error from Supabase is shown, escaped');
  ok(fake.calls.length === n0, 'none of those reached Supabase');
  const d = await signin();
  const wrong = crypto.randomUUID();
  fake.codes.set(wrong, { challenge: S.pkceChallenge(S.pkceVerifier()), uid: UID, email: 'member@example.com' });
  res = await route(api, 'GET', `/sync/callback?state=${d.state}&code=${wrong}`);
  ok(res.statusCode === 400 && /refused/.test(res.body) && /code challenge does not match/.test(res.body), 'a code made for another verifier is refused by Supabase');
  ok((await api.status()).signedIn, 'a failed sign-in leaves the old one');

  // PC only, and not from another site
  for (const [m, u] of [['GET', '/sync/signin'], ['GET', `/sync/callback?state=${d.state}&code=x`], ['POST', '/sync/signout']]) {
    res = await route(api, m, u, { remote: true });
    ok(res.statusCode === 403, `a remote browser can't ${m} ${u.split('?')[0]} (${res.statusCode})`);
  }
  for (const site of ['cross-site', 'same-site']) {
    res = await route(api, 'GET', '/sync/signin', { headers: { 'sec-fetch-site': site } });
    ok(res.statusCode === 403, `a ${site} page can't start a sign-in`);
  }
  eq((await route(api, 'POST', '/sync/signin')).statusCode, 405, 'POST /sync/signin is 405');
  eq((await route(api, 'GET', '/sync/signout')).statusCode, 405, 'GET /sync/signout is 405');
  ok((await api.status()).signedIn, 'still signed in after the refused requests');

  // REST
  let rows = await api.rest('GET', 'devices', { query: { select: '*' } });
  ok(Array.isArray(rows) && rows[0].user_id === UID, 'rest GET reads rows');
  let last = fake.calls[fake.calls.length - 1];
  ok(last.headers['accept-profile'] === 'fleet_sync' && last.headers.apikey === KEY && last.headers.authorization === `Bearer ${firstAccess}` && last.search === '?select=*', 'rest GET sends Accept-Profile, apikey, the token and the query');
  rows = await api.rest('POST', 'devices', { body: { name: 'laptop' }, prefer: 'return=representation' });
  last = fake.calls[fake.calls.length - 1];
  ok(rows[0].name === 'laptop' && last.headers['content-profile'] === 'fleet_sync' && last.headers.prefer === 'return=representation' && last.headers['content-type'] === 'application/json', 'rest POST sends Content-Profile, Prefer and JSON');
  const full = await api.rest('GET', 'devices', { full: true });
  ok(full.status === 200 && Array.isArray(full.data), 'rest { full: true } gives the status too');
  await rejects(api.rest('GET', 'broken'), (e) => e.status === 403 && /permission denied/.test(e.message) && e.code === '42501' && !e.message.includes(firstAccess), 'a PostgREST error comes back with its status, code and message');
  const nBad = fake.calls.length;
  await rejects(api.rest('GET', 'devices; drop'), (e) => e.code === 'bad_request', 'a bad table name is refused');
  await rejects(api.rest('TRACE', 'devices'), (e) => e.code === 'bad_request', 'a bad method is refused');
  await rejects(api.rpc('../x'), (e) => e.code === 'bad_request', 'a bad function name is refused');
  ok(fake.calls.length === nBad, 'refused names never reach Supabase');
  ok((await api.rpc('is_member')) === true, 'rpc(is_member)');
  await rejects(api.rest('GET', 'slow', { timeoutMs: 300 }), (e) => e.code === 'timeout' && /did not answer/.test(e.message), 'a call that hangs times out');

  // refresh before expiry, once for calls at the same moment
  clock = Date.parse(st.expiresAt) - 30e3; // 30 s left: under the minute
  const nRefresh = callsOf('/auth/v1/token', 'refresh_token').length;
  const [r1, r2] = await Promise.all([api.rest('GET', 'devices'), api.rest('GET', 'devices')]);
  ok(Array.isArray(r1) && Array.isArray(r2), 'calls near expiry work');
  const refreshes = callsOf('/auth/v1/token', 'refresh_token').slice(nRefresh);
  ok(refreshes.length === 1 && JSON.parse(refreshes[0].body).refresh_token === firstRefresh, 'one refresh, with the old refresh token, for both');
  eq([events.length, lastEvent()], [2, { type: 'refreshed', uid: UID, email: 'member@example.com' }], 'onChange: one refreshed for one refresh');
  const second = JSON.parse(store.peek());
  ok(second.refreshToken !== firstRefresh && fake.refresh.has(second.refreshToken), 'the new refresh token was saved at once');
  last = fake.calls[fake.calls.length - 1];
  ok(last.headers.authorization === `Bearer ${second.accessToken}`, 'the call used the new access token');
  // a 401: one new token, one more try
  fake.access.delete(second.accessToken);
  rows = await api.rest('GET', 'devices');
  ok(Array.isArray(rows) && callsOf('/auth/v1/token', 'refresh_token').length === nRefresh + 2, 'a 401 gets a new token and one more try');
  // Supabase can't be reached for the refresh: an error, still signed in
  clock += 3600e3;
  fake.refreshDown = true;
  await rejects(api.rest('GET', 'devices'), (e) => e.code === 'network', 'a refresh that can\'t reach Supabase fails the call');
  ok((await api.status()).signedIn, '... and leaves it signed in');
  fake.refreshDown = false;
  ok(Array.isArray(await api.rest('GET', 'devices')), 'it works again once Supabase answers');

  // Storage
  const conv = crypto.randomUUID();
  const rel = `transcripts/${conv}/0/1`;
  eq(S.objectPath(UID, rel), `${UID}/${rel}`, 'objectPath puts the user id first');
  for (const bad of ['../x', '..', '.', 'a/../b', 'a/./b', '/abs', 'C:/x', 'C:\\x', 'a\\b', '', 'a//b', 'a/b/', '%2e%2e/x', `../${crypto.randomUUID()}/x`, 'a b', 'x'.repeat(901), 42, null]) {
    let threw = false;
    try { S.objectPath(UID, bad); } catch (e) { threw = e.code === 'bad_path'; }
    ok(threw, `objectPath refuses ${JSON.stringify(bad).slice(0, 40)}`);
  }
  let threw = false;
  try { S.objectPath('../someone', 'x'); } catch { threw = true; }
  ok(threw, 'objectPath refuses a user id that is not a UUID');
  const nSt = fake.calls.length;
  await rejects(api.storage.upload(`../${crypto.randomUUID()}/x`, Buffer.from('x')), (e) => e.code === 'bad_path', 'upload refuses ../');
  await rejects(api.storage.upload('/etc/passwd', Buffer.from('x')), (e) => e.code === 'bad_path', 'upload refuses an absolute name');
  await rejects(api.storage.download('a/../../b'), (e) => e.code === 'bad_path', 'download refuses ../');
  await rejects(api.storage.remove(['ok', '../x']), (e) => e.code === 'bad_path', 'remove refuses ../');
  await rejects(api.storage.upload('x', 'a string'), (e) => e.code === 'bad_request', 'upload takes only a Buffer');
  ok(fake.calls.length === nSt, 'refused paths never reach Supabase');
  const bytes = crypto.randomBytes(5000);
  const up = await api.storage.upload(rel, bytes);
  ok(up.size === 5000 && fake.objects.has(`${UID}/${rel}`), 'upload lands under <uid>/');
  last = fake.calls[fake.calls.length - 1];
  ok(last.path === `/storage/v1/object/fleet-sync/${UID}/${rel}` && last.headers['x-upsert'] === 'false', 'upload: the bucket path and x-upsert false');
  await rejects(api.storage.upload(rel, bytes), (e) => e.status === 409, 'a second upload to the same name is refused (no upsert)');
  ok((await api.storage.upload(rel, bytes, { upsert: true })).size === 5000, 'upsert: true replaces it');
  ok(Buffer.compare(await api.storage.download(rel), bytes) === 0, 'download gives the same bytes');
  await rejects(api.storage.download(`transcripts/${conv}/0/2`), (e) => e.status === 404, 'a missing object is a 404');
  const gone = await api.storage.remove([rel]);
  ok(Array.isArray(gone) && gone.length === 1 && !fake.objects.size, 'remove deletes it');
  ok(JSON.parse(fake.calls[fake.calls.length - 1].body.toString()).prefixes[0] === `${UID}/${rel}`, 'remove sends <uid>/ names');
  // Storage's InvalidJWT (a 400) counts as a 401: one new token, one more try
  fake.access.delete(JSON.parse(store.peek()).accessToken);
  ok((await api.storage.upload(rel, bytes)).size === 5000, 'an InvalidJWT from Storage gets a new token and one more try');

  // sign out: told to Supabase, gone here
  const atOut = JSON.parse(store.peek()).accessToken;
  res = await route(api, 'POST', '/sync/signout');
  ok(res.statusCode === 200 && callsOf('/auth/v1/logout').length === 1 && callsOf('/auth/v1/logout')[0].search === '?scope=local', 'signout tells Supabase (scope=local)');
  ok(!fake.access.has(atOut) && store.peek() === null, 'the token is revoked and the store is empty');
  ok(!(await api.status()).signedIn, 'signed out');
  eq(lastEvent(), { type: 'signed-out', uid: UID, email: 'member@example.com' }, 'onChange: signed-out on sign-out');
  eq([await api.uid(), await api.email()], [null, null], 'signed out: uid() and email() are null');
  await rejects(api.rest('GET', 'devices'), (e) => e.code === 'signed_out', 'signed out: rest() says so');

  // a refresh Supabase refuses: signed out
  const e2 = await signin();
  const code2 = crypto.randomUUID();
  fake.codes.set(code2, { challenge: e2.challenge, uid: UID, email: 'member@example.com' });
  res = await route(api, 'GET', `/sync/callback?state=${e2.state}&code=${code2}`);
  ok(res.statusCode === 200, 'signed in again');
  clock += 2 * 3600e3;
  fake.refresh.clear(); // revoked on the server
  await rejects(api.rest('GET', 'devices'), (e) => e.code === 'signed_out', 'a refused refresh: the call fails as signed out');
  ok(!(await api.status()).signedIn && store.peek() === null, 'a refused refresh signs out');
  eq(events.slice(-2).map((e) => e.type), ['signed-in', 'signed-out'], 'onChange: signed-in again, then signed-out on a refused refresh');

  // someone not on the members list: told so on the page
  fake.member = false;
  const f = await signin();
  const code3 = crypto.randomUUID();
  fake.codes.set(code3, { challenge: f.challenge, uid: crypto.randomUUID(), email: 'stranger@example.com' });
  res = await route(api, 'GET', `/sync/callback?state=${f.state}&code=${code3}`);
  ok(res.statusCode === 200 && /not on the sync members list/.test(res.body), 'a non-member is told the account can reach nothing');
  eq((await api.status()).member, false, 'status: member false');
  // is_member can't be asked (the schema not exposed yet): member unknown
  delete fake.member;
  const g = await signin();
  const code4 = crypto.randomUUID();
  fake.codes.set(code4, { challenge: g.challenge, uid: UID, email: 'member@example.com' });
  res = await route(api, 'GET', `/sync/callback?state=${g.state}&code=${code4}`);
  ok(res.statusCode === 200 && /could not check/.test(res.body), 'members check unavailable: the page says so');
  eq((await api.status()).member, null, 'status: member null');
  // another process (the CLI) signs out: the server notices
  await store.clear();
  ok(!(await api.status()).signedIn, 'a sign-out by another process is seen');
  eq(lastEvent().type, 'signed-out', 'onChange: a sign-out by another process is heard');
  // another process signs in: heard on the next read
  await store.write(JSON.stringify({ v: 1, url: fakeUrl, uid: UID, email: 'member@example.com', member: true, refreshToken: 'rt-from-the-cli' }));
  ok((await api.status()).signedIn && lastEvent().type === 'signed-in', 'onChange: a sign-in by another process is heard');
  const tokensSeen = [...fake.access.keys(), ...fake.refresh.keys(), firstAccess, firstRefresh, 'rt-from-the-cli'];
  ok(!tokensSeen.some((t) => JSON.stringify(events).includes(t)), 'onChange events hold no token');
  const nEv = events.length;
  unsub();
  await store.clear();
  await api.status();
  ok(events.length === nEv, 'unsubscribed: no more events');
  ok(!logs.some((l) => [...fake.access.keys(), ...fake.refresh.keys(), KEY].some((t) => l.includes(t))), 'no token or key in the log');

  // ---------- onlyEmail: one Google account may sync (Henry's machines, private.json's syncEmail) ----------
  {
    const dir = path.join(T, 'only');
    fs.mkdirSync(path.join(dir, 'sync'), { recursive: true });
    fs.writeFileSync(S.configPath(dir), JSON.stringify({ url: fakeUrl, publishableKey: KEY }));
    const onlyStore = memStore(), onlyLogs = [];
    const only = S.createSync({ dataDir: dir, port: 4777, fetch: realFetch, store: onlyStore, allowLoopbackUrl: true, onlyEmail: 'Henry@Example.com', log: (t) => onlyLogs.push(t) });
    fake.member = true;
    const tryAs = async (api, email) => {
      const r1 = await route(api, 'GET', '/sync/signin');
      const loc = new URL(r1.headers.Location), back = new URL(loc.searchParams.get('redirect_to'));
      const c = crypto.randomUUID();
      fake.codes.set(c, { challenge: loc.searchParams.get('code_challenge'), uid: UID, email });
      return { loc, res: await route(api, 'GET', `/sync/callback?state=${back.searchParams.get('state')}&code=${c}`) };
    };
    let t = await tryAs(only, 'other@example.com');
    eq([t.loc.searchParams.get('login_hint'), t.loc.searchParams.get('prompt')], ['henry@example.com', null], 'only: Google is sent straight to the one account (login_hint, no picker)');
    ok(t.res.statusCode === 400 && /Only henry@example\.com can sync/.test(t.res.body) && /other@example\.com/.test(t.res.body), `only: another account is turned away (${t.res.statusCode})`);
    let st = await only.status();
    ok(!st.signedIn && st.refused === 'other@example.com' && st.onlyEmail === 'henry@example.com' && onlyStore.peek() == null, `only: nothing kept, and status says who was turned away: ${JSON.stringify(st)}`);
    ok(onlyLogs.some((l) => /turned away/.test(l)), 'only: the refusal is logged');
    t = await tryAs(only, 'Henry@Example.com');
    st = await only.status();
    ok(t.res.statusCode === 200 && st.signedIn && st.email === 'henry@example.com' && !st.refused, `only: the one account signs in: ${JSON.stringify(st)}`);
    // a kept sign-in for another account (made before the rule, or by the CLI) counts as signed out
    const other = S.createSync({ dataDir: dir, port: 4777, fetch: realFetch, store: onlyStore, allowLoopbackUrl: true, onlyEmail: 'someone@example.com' });
    st = await other.status();
    ok(!st.signedIn && (await other.uid().catch(() => null)) == null, 'only: a kept sign-in for another account is not used');
    // without onlyEmail (a friend's install): the account picker, as before
    const free = S.createSync({ dataDir: dir, port: 4777, fetch: realFetch, store: memStore(), allowLoopbackUrl: true });
    const r1 = await route(free, 'GET', '/sync/signin');
    const loc = new URL(r1.headers.Location);
    eq([loc.searchParams.get('login_hint'), loc.searchParams.get('prompt')], [null, 'select_account'], 'no onlyEmail: the account picker, no hint');
  }

  // ---------- the Sync card's routes ----------
  {
    const C = require(path.join(ROOT, 'sync-crypto.js'));
    const { createSyncRunner } = require(path.join(ROOT, 'sync-run.js'));
    const opened = [], cardLogs = [];
    const machine = (name) => {
      const dir = path.join(T, `card-${name}`);
      fs.mkdirSync(path.join(dir, 'sync'), { recursive: true });
      fs.writeFileSync(S.configPath(dir), JSON.stringify({ url: fakeUrl, publishableKey: KEY }));
      return { dir, api: S.createSync({ dataDir: dir, port: 4777, fetch: realFetch, store: memStore(), allowLoopbackUrl: true, log: (t) => cardLogs.push(t), openUrl: (u) => { opened.push(u); return true; } }) };
    };
    const signInAs = async (x, email) => {
      const r1 = await route(x.api, 'GET', '/sync/signin');
      const loc = new URL(r1.headers.Location), back = new URL(loc.searchParams.get('redirect_to'));
      const c = crypto.randomUUID();
      fake.codes.set(c, { challenge: loc.searchParams.get('code_challenge'), uid: UID, email });
      const r2 = await route(x.api, 'GET', `/sync/callback?state=${back.searchParams.get('state')}&code=${c}`);
      ok(r2.statusCode === 200 && (await x.api.status()).signedIn, `card: ${email} signs in`);
    };
    const A = machine('a'), B = machine('b');
    fake.member = true;
    fake.settings.clear();

    // PC only: a remote browser, or another site's page, gets 403 and nothing opens
    for (const o of [{ remote: true }, { headers: { 'sec-fetch-site': 'cross-site' } }, { headers: { 'sec-fetch-site': 'same-site' } }]) {
      const r = await route(A.api, 'POST', '/sync/open-signin', o);
      ok(r.statusCode === 403, `card: open-signin refused for ${JSON.stringify(o)} (${r.statusCode})`);
    }
    ok(opened.length === 0, 'card: refused requests opened nothing');
    eq((await route(A.api, 'GET', '/sync/open-signin')).statusCode, 405, 'card: GET /sync/open-signin is 405');

    // the sign-in opens in the default browser, on this port's /sync/signin
    let r = await route(A.api, 'POST', '/sync/open-signin', { headers: { 'sec-fetch-site': 'same-origin' } });
    ok(r.statusCode === 200 && r.json.ok, `card: POST /sync/open-signin answers ok (${r.statusCode})`);
    eq(opened, ['http://127.0.0.1:4777/sync/signin'], 'card: it opens http://127.0.0.1:<port>/sync/signin');
    const failing = S.createSync({ dataDir: A.dir, store: memStore(), allowLoopbackUrl: true, openUrl: () => false });
    r = await route(failing, 'POST', '/sync/open-signin');
    ok(r.statusCode === 500 && /yourself/.test(r.json.message), 'card: a browser that does not start says to open it by hand');

    eq((await route(A.api, 'GET', '/sync/passphrase')).statusCode, 404, 'card: there is no /sync/passphrase any more');

    // no passphrase: the runner fetches (or on the first machine makes) the key once signed in
    const made = [];
    const loop = () => { const l = { start() { made.push(l); }, async stop() {}, status: () => ({}) }; return l; };
    const runnerOf = (x) => createSyncRunner({ sync: x.api, dataDir: x.dir, log: (t) => cardLogs.push(t), checkMs: 1e6, makeUploader: loop, makeMaterializer: loop });
    const settle = async (n) => { for (let i = 0; i < 100 && made.length < n; i++) await new Promise((res2) => realSetTimeout(res2, 20)); };
    const runA = runnerOf(A);
    await runA.start();
    ok(!runA.status().running && /not signed in/.test(runA.status().reason) && !C.hasKey(S.syncDir(A.dir)), 'card: signed out, no key is made');
    await signInAs(A, 'member@example.com');
    await settle(2);
    ok(made.length === 2 && runA.status().running, 'card: the first machine runs as soon as it signs in');
    const keyA = await C.loadKey(S.syncDir(A.dir));
    const row = JSON.parse(fake.settings.get('sync-key'));
    ok(keyA && keyA.length === 32 && Buffer.from(row.key, 'base64').equals(keyA), 'card: it made the key and put it in Blackbox');
    await runA.stop();

    const runB = runnerOf(B);
    await runB.start();
    ok(!runB.status().running && !C.hasKey(S.syncDir(B.dir)), 'card: the second machine waits for its sign-in');
    await signInAs(B, 'member@example.com');
    await settle(4);
    ok(made.length === 4 && runB.status().running, 'card: the second machine runs as soon as it signs in (no minute wait)');
    ok((await C.loadKey(S.syncDir(B.dir))).equals(keyA), 'card: ... with the same key as the first machine');
    await runB.stop();

    const all = JSON.stringify([cardLogs, logs]);
    ok(!all.includes(keyA.toString('base64')) && !all.includes(keyA.toString('hex')), 'card: the key is in no log');
    await C.forgetKey(S.syncDir(A.dir));
    await C.forgetKey(S.syncDir(B.dir));
  }

  // ---------- named stores: protectedStore and the file store ----------
  const pdir = path.join(T, 'protected');
  for (const bad of ['session', '', 'Relay', '../x', 'a/b', 'a.b', '-x', 'x'.repeat(42), 7, null]) {
    let refused = false;
    try { S.protectedStore(pdir, bad); } catch (e) { refused = e.code === 'bad_request'; }
    ok(refused, `protectedStore refuses the name ${JSON.stringify(bad).slice(0, 50)}`);
  }
  let noDir = false;
  try { S.protectedStore('', 'relay-keys'); } catch (e) { noDir = e.code === 'bad_request'; }
  ok(noDir, 'protectedStore needs a folder');
  const ps = S.protectedStore(pdir, 'relay-keys');
  ok(ps.kind === (process.platform === 'win32' ? 'dpapi' : process.platform === 'darwin' ? 'keychain' : 'file'), `protectedStore picks the OS's store (${ps.kind})`);
  ok(path.dirname(ps.file) === path.resolve(pdir) && path.basename(ps.file).startsWith('relay-keys.'), `its file is <dir>/relay-keys.* (${ps.file})`);
  const fdir = path.join(T, 'file-store');
  const fs1 = S.fileStore(fdir, 'relay-keys'), fsSession = S.fileStore(fdir);
  ok(path.basename(fs1.file) === 'relay-keys.json' && path.basename(fsSession.file) === 'session.json', 'file store: <name>.json, session.json by default');
  const anyText = 'not JSON at all: é 中 "quotes" \n line two';
  await fs1.write(anyText);
  ok((await fs1.read()) === anyText, 'file store: any text comes back exactly');
  ok((await fsSession.read()) === null, 'file store: a named secret leaves the sign-in alone');
  const sessionText = JSON.stringify({ v: 1, refreshToken: 'rt-x' });
  await fsSession.write(sessionText);
  ok((await fsSession.read()) === sessionText && (await fs1.read()) === anyText, 'file store: both kept side by side');
  if (process.platform !== 'win32') ok((fs.statSync(fs1.file).mode & 0o777) === 0o600, 'file store: mode 0600');
  fs.writeFileSync(fsSession.file, JSON.stringify({ note: 'Not encrypted', ...JSON.parse(sessionText) }, null, 2));
  eq(JSON.parse(await fsSession.read()).refreshToken, 'rt-x', 'file store: a sign-in saved before { text } still reads');
  await fs1.clear();
  ok(fs1.stamp() === null && (await fs1.read()) === null && (await fsSession.read()) !== null, 'file store: clearing one leaves the other');

  // ---------- the DPAPI store (Windows) ----------
  if (process.platform === 'win32') {
    const dir = path.join(T, 'dpapi');
    const st2 = S.dpapiStore(dir);
    const secret = `rt-${crypto.randomBytes(16).toString('hex')}`;
    const text = JSON.stringify({ v: 1, refreshToken: secret, note: 'é ü 中' });
    const from = started.length;
    ok(st2.stamp() === null && (await st2.read()) === null, 'DPAPI: empty at first');
    await st2.write(text);
    const blob = fs.readFileSync(path.join(dir, 'session.bin'));
    ok(blob.length > 100 && !blob.includes(secret) && !blob.includes(Buffer.from(secret, 'utf16le')) && !blob.includes(Buffer.from(text).toString('base64')), 'DPAPI: session.bin holds no plain secret');
    ok((await st2.read()) === text, 'DPAPI: the round trip gives the same text');
    const args = started.slice(from).map((a) => JSON.stringify(a.slice(0, 2)));
    ok(args.length === 2 && args.every((x) => !x.includes(secret) && !x.includes(Buffer.from(text).toString('base64'))), 'DPAPI: the secret is never in a command line');
    ok(st2.stamp() !== null, 'DPAPI: stamp while signed in');
    fs.writeFileSync(path.join(dir, 'session.bin'), Buffer.from('not a dpapi blob'));
    await rejects(st2.read(), (e) => /DPAPI failed/.test(e.message), 'DPAPI: a damaged file is an error, not a crash');
    await st2.clear();
    ok(st2.stamp() === null && (await st2.read()) === null, 'DPAPI: cleared');
    ok(S.createSync({ dataDir: path.join(T, 'x') }).storeKind === 'dpapi', 'DPAPI is the store on Windows');
    // a named secret beside the sign-in
    const signIn = S.dpapiStore(dir), keys = S.protectedStore(dir, 'relay-keys');
    await signIn.write('the sign-in');
    await keys.write('the relay keys');
    ok(fs.existsSync(path.join(dir, 'relay-keys.bin')) && !fs.readFileSync(path.join(dir, 'relay-keys.bin')).includes('the relay keys'), 'DPAPI: relay-keys.bin, encrypted');
    eq([await signIn.read(), await keys.read()], ['the sign-in', 'the relay keys'], 'DPAPI: a named secret does not overwrite the sign-in');
    await keys.clear();
    ok((await keys.read()) === null && (await signIn.read()) === 'the sign-in', 'DPAPI: clearing it leaves the sign-in');
    await signIn.clear();
  } else console.log('skip: the DPAPI store (Windows only)');

  // ---------- publish-share.js's guard, in a throwaway repo ----------
  const G = path.join(T, 'share-guard');
  const copy = (rel) => { fs.mkdirSync(path.dirname(path.join(G, rel)), { recursive: true }); fs.copyFileSync(path.join(ROOT, rel), path.join(G, rel)); };
  for (const f of ['scripts/publish-share.js', 'version.js', 'platform.js', 'sync-api.js', 'scripts/sync-api-test.js', 'docs/sync.md']) copy(f);
  const gEnv = { ...process.env, GIT_AUTHOR_NAME: 'sync test', GIT_AUTHOR_EMAIL: 'sync@test', GIT_COMMITTER_NAME: 'sync test', GIT_COMMITTER_EMAIL: 'sync@test', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args) => { const x = cp.spawnSync('git', ['-C', G, ...args], { encoding: 'utf8', env: gEnv, windowsHide: true }); if (x.status !== 0) throw new Error(`git ${args.join(' ')}: ${x.stderr}`); return x.stdout.trim(); };
  git('init', '-q', '-b', 'main');
  const commitAll = (msg) => { git('add', '-A'); git('commit', '-q', '--allow-empty', '-m', msg); };
  const dry = () => cp.spawnSync(process.execPath, [path.join(G, 'scripts', 'publish-share.js'), '--test', 'guard-check', '--ref', 'HEAD', '--dry-run'], { encoding: 'utf8', env: gEnv, windowsHide: true });
  commitAll('clean');
  p = dry();
  ok(p.status === 0, `the guard passes sync-api.js, its test and docs/sync.md: ${p.stderr}`);
  ok(['sync-api.js', 'scripts/sync-api-test.js', 'docs/sync.md'].every((f) => p.stdout.split(/\r?\n/).includes(f)), 'the dry run lists them as published');
  const planted = [
    ['planted-key.js', `const key = '${KEY}';\n`, 'a Supabase API key'],
    ['planted-url.md', `See ${'https://' + 'abcdefghij0123456789' + '.supabase.co'} for it.\n`, 'a Supabase project URL'],
    ['planted-jwt.js', `const t = '${jwt({ role: 'anon', ref: 'abcdefghij0123456789' })}';\n`, 'a JWT'],
    ['sync/config.json', `${JSON.stringify({ url: 'https://<project>.supabase.co' })}\n`, 'a secrets file'],
  ];
  for (const [file, text, what] of planted) {
    fs.mkdirSync(path.dirname(path.join(G, file)), { recursive: true });
    fs.writeFileSync(path.join(G, file), text);
    commitAll(`plant ${file}`);
    p = dry();
    ok(p.status === 2 && p.stderr.includes(file) && p.stderr.includes(what) && /Nothing was published/.test(p.stderr), `the guard refuses ${file} (${what}): exit ${p.status} ${p.stderr.slice(0, 300)}`);
    fs.rmSync(path.join(G, file));
    commitAll(`unplant ${file}`);
  }
  p = dry();
  ok(p.status === 0, 'clean again: the guard passes');
}

main().catch((e) => { failures++; console.log(`FAIL the test crashed: ${e && e.stack}`); }).finally(() => {
  try { server.close(); if (server.closeAllConnections) server.closeAllConnections(); } catch {}
  if (process.env.SYNC_TEST_KEEP !== '1') { try { fs.rmSync(T, { recursive: true, force: true }); } catch {} } else console.log(`kept ${T}`);
  console.log(`${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
});
