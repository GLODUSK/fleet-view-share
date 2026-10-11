// sync-setup-test.js: sync-setup.js, the start screen's server side, over a real local HTTP server with a fake
// sync-api object and a fake runner: who is asked (only a private checkout, only this PC, only until it is done; a
// machine that synced before is not), the mode file, /sync/connect's checks (a secret key is refused, nothing is
// written then), what a remote browser and another site's page may do, and the accounts check.
// Run: node scripts/sync-setup-test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const S = require(path.join(__dirname, '..', 'sync-api.js'));
const { createSyncSetup, readPrivate } = require(path.join(__dirname, '..', 'sync-setup.js'));

let pass = 0, fail = 0;
const ok = (c, name) => { if (c) pass++; else { fail++; console.log(`FAIL ${name}`); } };

const sendJson = (res, code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
function serve(setup, remote) {
  const srv = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (!setup.handle(req, res, p, { sendJson, remote: () => remote.on })) sendJson(res, 404, { passed: true });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}
async function call(srv, method, p, body, headers = {}) {
  const r = await fetch(`http://127.0.0.1:${srv.address().port}${p}`, {
    method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { code: r.status, body: await r.json() };
}

// made up, and put together here so the share repo's secret check (publish-share.js) does not take them for real ones
const PROJECT = `https://${'abcdefghij'.repeat(2)}.supa` + 'base.co';
const PUB = 'sb_publish' + `able_${'a'.repeat(20)}`;
const SECRET = 'sb_sec' + `ret_${'x'.repeat(22)}`;

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-sync-setup-'));
  try {
    // the marker: Henry's checkout has it (this repo), and its name is read
    ok(readPrivate(path.join(__dirname, '..')) && readPrivate(path.join(__dirname, '..')).syncName === 'Blackbox', 'private.json: this checkout is private, named Blackbox');
    ok(readPrivate(tmp) === null, 'private.json: a folder without it is not');

    const sync = { on: false, enabled: () => sync.on, status: async () => (sync.on ? { configured: true, signedIn: false } : { configured: false }) };
    let checks = 0;
    const runner = { check: async () => { checks++; }, status: () => ({ running: false, reason: 'not signed in' }) };
    const last = { ok: false, reason: 'sign in Claude A', letters: [] };
    const remote = { on: false };
    const setup = createSyncSetup({ dataDir: tmp, sync, runner, accountSync: { last: () => last }, private: { syncName: 'Blackbox' }, accountsView: () => ({ jobs: { A: { status: 'waiting' } } }) });
    const srv = await serve(setup, remote);
    const modeFile = path.join(S.syncDir(tmp), 'mode.json');

    let r = await call(srv, 'GET', '/sync/setup');
    ok(r.body.ask === true && r.body.mode === null && r.body.name === 'Blackbox', 'a fresh private machine is asked');
    ok(r.body.accounts.reason === last.reason && r.body.signins.A.status === 'waiting', 'it carries the accounts and the sign-ins');
    ok((await call(srv, 'GET', '/sync/other')).body.passed, 'other routes are not taken');

    // a remote browser is never asked and may not choose
    remote.on = true;
    r = await call(srv, 'GET', '/sync/setup');
    ok(r.body.ask === false && !('accounts' in r.body), 'remote: not asked, no accounts');
    ok((await call(srv, 'POST', '/sync/mode', { mode: 'local' })).code === 403, 'remote: no choosing');
    remote.on = false;
    ok((await call(srv, 'POST', '/sync/mode', { mode: 'local' }, { 'Sec-Fetch-Site': 'cross-site' })).code === 403, 'another site: no choosing');
    ok(!fs.existsSync(modeFile), 'nothing written by a refused request');

    // the choice
    ok((await call(srv, 'POST', '/sync/mode', { mode: 'other' })).code === 400, 'a mode is sync or local');
    r = await call(srv, 'POST', '/sync/mode', { mode: 'local' });
    ok(r.code === 200 && JSON.parse(fs.readFileSync(modeFile, 'utf8')).mode === 'local' && setup.mode() === 'local', 'local is kept');
    ok((await call(srv, 'GET', '/sync/setup')).body.ask === false, 'local: not asked again');
    ok((await call(srv, 'POST', '/sync/done')).code === 409, 'done needs sync as the choice');
    r = await call(srv, 'POST', '/sync/mode', { mode: 'sync' });
    ok(r.code === 200 && setup.mode() === 'sync' && checks >= 2, 'sync is kept, and the runner looks again');
    ok((await call(srv, 'GET', '/sync/setup')).body.ask === true, 'sync, not done: asked at every start');

    // connect: the same checks as `node sync-api.js setup`
    const cfg = S.configPath(tmp);
    r = await call(srv, 'POST', '/sync/connect', { url: PROJECT, key: SECRET });
    ok(r.code === 400 && r.body.field === 'key' && /secret/.test(r.body.message) && !fs.existsSync(cfg), 'a secret key is refused and nothing written');
    r = await call(srv, 'POST', '/sync/connect', { url: 'http://evil.example.com', key: PUB });
    ok(r.code === 400 && r.body.field === 'url' && !fs.existsSync(cfg), 'a non-Supabase address is refused');
    r = await call(srv, 'POST', '/sync/connect', { url: PROJECT + '/', key: PUB });
    const written = S.readConfig(tmp).config;
    ok(r.code === 200 && written && written.url === PROJECT && written.key === PUB, 'a publishable key and address are written as setup does');
    ok(!JSON.stringify(await call(srv, 'GET', '/sync/setup')).includes(PUB), 'the key never comes back');

    r = await call(srv, 'POST', '/sync/accounts/check');
    ok(r.code === 200 && r.body.accounts.reason === last.reason, 'accounts/check looks again and answers');
    ok((await call(srv, 'POST', '/sync/done')).code === 200 && setup.current().done === true, 'done is kept');
    ok((await call(srv, 'GET', '/sync/setup')).body.ask === false, 'done: not asked again');

    // a machine that synced before this existed (config, no mode file): syncing, done, never asked
    fs.rmSync(modeFile);
    sync.on = true;
    ok(setup.current().mode === 'sync' && setup.current().done && (await call(srv, 'GET', '/sync/setup')).body.ask === false, 'synced before: not asked');
    srv.close();

    // private.json with Blackbox's address, key and the one account: read and checked
    const pdir = path.join(tmp, 'priv');
    fs.mkdirSync(pdir, { recursive: true });
    fs.writeFileSync(path.join(pdir, 'private.json'), JSON.stringify({ syncName: 'Blackbox', syncEmail: ' Henry@Example.com ', syncUrl: `${PROJECT}/`, syncKey: PUB }));
    let pv = readPrivate(pdir);
    ok(pv && pv.syncEmail === 'henry@example.com' && pv.connect && pv.connect.url === PROJECT && pv.connect.key === PUB, `private.json: email, address and key read: ${JSON.stringify(pv && { ...pv, connect: !!pv.connect })}`);
    fs.writeFileSync(path.join(pdir, 'private.json'), JSON.stringify({ syncName: 'Blackbox', syncEmail: 'nope', syncUrl: PROJECT, syncKey: SECRET }));
    pv = readPrivate(pdir);
    ok(pv && pv.syncEmail === null && pv.connect === null, 'private.json: a bad email and a secret key are not taken');
    const mine = readPrivate(path.join(__dirname, '..'));
    ok(/@/.test(mine.syncEmail || '') && !!mine.connect, 'private.json: this checkout has the one account and Blackbox\'s address and key');

    // choosing sync with them connects by itself: no address or key asked
    const adir = path.join(tmp, 'auto');
    const autoSync = { enabled: () => !!S.readConfig(adir).config, status: async () => (S.readConfig(adir).config ? { configured: true, signedIn: false } : { configured: false }) };
    const auto = createSyncSetup({ dataDir: adir, sync: autoSync, runner, private: { syncName: 'Blackbox', syncEmail: 'henry@example.com', connect: { url: PROJECT, key: PUB } } });
    const srv3 = await serve(auto, remote);
    r = await call(srv3, 'GET', '/sync/setup');
    ok(r.body.ask === true && r.body.autoConnect === true && r.body.onlyEmail === 'henry@example.com' && !fs.existsSync(S.configPath(adir)), 'auto: nothing written before sync is chosen');
    r = await call(srv3, 'POST', '/sync/mode', { mode: 'sync' });
    const auto1 = S.readConfig(adir).config;
    ok(r.code === 200 && auto1 && auto1.url === PROJECT && auto1.key === PUB, 'auto: choosing sync writes the config');
    r = await call(srv3, 'GET', '/sync/setup');
    ok(r.body.configured === true && !JSON.stringify(r.body).includes(PUB), 'auto: configured, and the key never comes back');
    fs.rmSync(S.configPath(adir));
    r = await call(srv3, 'GET', '/sync/setup');
    ok(r.body.configured === true && !!S.readConfig(adir).config, 'auto: a config gone while syncing is written again on the next look');
    remote.on = true;
    fs.rmSync(S.configPath(adir));
    await call(srv3, 'GET', '/sync/setup');
    ok(!fs.existsSync(S.configPath(adir)), 'auto: a remote browser\'s look writes nothing');
    remote.on = false;
    srv3.close();

    // a friend's install (no private.json): never asked, and it can't set anything up
    sync.on = false;
    const friend = createSyncSetup({ dataDir: path.join(tmp, 'friend'), sync, runner, private: null });
    const srv2 = await serve(friend, remote);
    r = await call(srv2, 'GET', '/sync/setup');
    ok(r.body.ask === false && r.body.private === false, 'friend: not asked');
    r = await call(srv2, 'POST', '/sync/connect', { url: PROJECT, key: PUB });
    ok(r.code === 404 && !fs.existsSync(S.configPath(path.join(tmp, 'friend'))), 'friend: connect is not there');
    ok((await call(srv2, 'POST', '/sync/mode', { mode: 'sync' })).code === 404, 'friend: no mode');
    srv2.close();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
