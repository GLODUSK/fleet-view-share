// Tests for files.js's fence (GET /file and GET /folders never show a secret, whoever asks) and secret-files.js (the
// list it shares with the phone's fence in relay.js): node scripts/files-test.js
// Everything happens in a temp folder, Fleet View's data folder among it (LOCALAPPDATA on Windows, HOME on a Mac,
// XDG_STATE_HOME elsewhere point there): nothing here reads or writes the real one.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const T = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fv-files-test-')));
process.env.LOCALAPPDATA = path.join(T, 'local');
if (process.platform !== 'win32') process.env.HOME = path.join(T, 'home');
process.env.XDG_STATE_HOME = path.join(T, 'state');
const P = require(path.join(__dirname, '..', 'platform.js'));
const S = require(path.join(__dirname, '..', 'secret-files.js'));
const FILES = require(path.join(__dirname, '..', 'files.js'));

let passes = 0, failures = 0;
const ok = (cond, what) => { if (cond) passes++; else { failures++; console.log(`FAIL ${what}`); } };
const write = (f, text) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f; };
// GET /file as the page asks it (no Origin: a same-site request) -> { code, body }
function get(q) {
  let out = null;
  const req = { method: 'GET', url: `/file?${new URLSearchParams(q)}`, headers: { host: '127.0.0.1:4794' } };
  FILES.serve(req, {}, { sendJson: (res, code, body) => { out = { code, body }; } });
  return out || { code: 0, body: {} };
}
const folders = (p) => FILES._test.folders(new URLSearchParams({ path: p }), { repos: () => [] });
const links = [];
// a folder link: a junction on Windows (no admin needed), a symlink elsewhere; null when it can't be made
function link(target, at) {
  try { fs.symlinkSync(target, at, P.isWin ? 'junction' : 'dir'); links.push(at); return at; } catch { return null; }
}

(async () => {
  // ---------- secret-files.js ----------
  for (const n of ['.env', '.env.local', '.ENV.production', 'server.pem', 'tls.KEY', 'AuthKey_AB12.p8', 'cert.p12', 'id_ed25519', 'id_rsa.pub', 'aws-credentials.txt',
    '.credentials.json', '.git-credentials', 'claude-ops-service-account.json', 'service_account.json', 'fcm-firebase-adminsdk-x.json', 'google-services.json',
    'GoogleService-Info.plist', '.npmrc', '_netrc', 'hosts.yml', 'secrets.yaml', 'kubeconfig', 'prod.tfstate', '.claude.json', '.claude.json.backup',
    '.claude.json.tmp.42980.0b47', 'home.claude.json', 'Credentials']) ok(S.secretName(n), `secretName: ${n} is a secret's name`);
  for (const n of ['.env.example', 'a.ts', 'secrets.ts', 'token.ts', 'oauth-tokens.ts', 'claude.js', 'CLAUDE.md', 'package.json', 'settings.json', '.github',
    'keys', 'monkey.json', 'README.md', 'server.log', '']) ok(!S.secretName(n), `secretName: ${n || '(empty)'} is not`);
  for (const n of ['.ssh', '.SSH', '.gnupg', '.aws', '.azure', '.kube', '.docker', 'Keychains', '.expo', 'com.vercel.cli', 'configstore']) ok(S.keyDir(n) && S.secretStep(n), `keyDir: ${n}`);
  for (const n of ['ssh', 'keys', '.github', '.claude']) ok(!S.keyDir(n), `keyDir: ${n} is not a keys folder`);
  // the key headers are put together here so no file in the repo holds one (publish-share.js refuses those)
  const PEM = `notes\n-----BEGIN ${'OPENSSH PRIVATE'} KEY-----\nAAAA\n`, EC = `-----BEGIN ${'EC PRIVATE'} KEY-----\nAAAA\n`;
  const SA = `{\n  "type" :  "service${'_'}account",\n  "project_id": "x"\n}`, PK = `{"private${'_'}key"\t: "x"}`;
  const TALK = 'the JSON has a field called "private_key" in it';
  const PGP = `-----BEGIN ${'PGP PRIVATE'} KEY BLOCK-----\n\nlQOYBF\n`, PGP_PUB = `-----BEGIN ${'PGP PUBLIC'} KEY BLOCK-----\n\nmQINBF\n`;
  for (const [s, want] of [[PEM, true], [EC, true], [SA, true], [PK, true], [PGP, true], [PGP_PUB, false], [TALK, false], ['', false], [null, false]]) ok(S.secretText(s) === want, `secretText: ${JSON.stringify(s)} -> ${want}`);
  ok(S.SECRET_TEXT_RES.length === 3, 'SECRET_TEXT_RES: the three patterns');
  // Fleet View's own docs and modules open in the viewer: none has a secret's name or text that looks like a key
  // (secret-files.js's header and docs/phone.md's fence describe the patterns without matching them)
  const ROOT = path.join(__dirname, '..');
  const own = ['', 'docs', 'scripts', 'desktop'].flatMap((d) => { try { return fs.readdirSync(path.join(ROOT, d)).map((n) => path.join(d, n)); } catch { return []; } })
    .filter((f) => /\.(?:md|m?js)$/.test(f));
  const tripped = own.filter((f) => f.split(/[\\/]/).some(S.secretStep) || S.secretText(fs.readFileSync(path.join(ROOT, f), 'utf8')));
  ok(own.length > 20 && !tripped.length, `Fleet View's own ${own.length} docs and modules open (refused: ${tripped.join(', ') || 'none'})`);

  // ---------- the temp places ----------
  const DATA = P.dataDir();
  if (!DATA.startsWith(T)) throw new Error(`the data folder is not in the temp folder (${DATA}): nothing is written`);
  const REPO = path.join(T, 'repo');
  const plain = { 'src/a.ts': 'export const a = 1;\n', 'src/secrets.ts': 'export {};\n', '.env.example': 'X=\n', 'gh/notes.md': '# gh\n',
    'src/play.json': SA, 'src/key.txt': PEM, 'src/pk.json': PK, 'src/talk.txt': TALK, 'src/ec.txt': EC };
  for (const [rel, text] of Object.entries(plain)) write(path.join(REPO, rel), text);
  const secretFiles = ['.env', '.env.local', 'certs/server.pem', 'keys/id_ed25519', 'aws-credentials.txt', 'gcp/x-service-account.json', 'fcm-firebase-adminsdk-x.json',
    'android/app/google-services.json', '.npmrc', 'gh/hosts.yml', 'Credentials/notes.md', 'conf/home.claude.json', 'conf/.claude.json.backup', '.claude.json',
    'Keychains/login.txt', '.ssh/config', 'deep/.aws/config', '.expo/state.json', 'AppData/Roaming/com.vercel.cli/Data/auth.json', '.config/configstore/firebase-tools.json'];
  for (const rel of secretFiles) write(path.join(REPO, rel), 'secret\n');
  const dataOpen = ['server.log', 'server.log.1', 'host.log', 'uploads/2026-10-17/0123abcd-notes.txt', 'housekeeping/report.json'];
  const dataShut = ['api-token', 'host.json', 'sync/config.json', 'sync/device.json', 'relay/devices.json', 'relay/pair.html', 'link/peers.json',
    'edge/Default/Preferences', 'electron-4777/Local State', 'remote-devices.json', 'sessions.json', 'accounts/C-removed/notes.txt'];
  for (const rel of [...dataOpen, ...dataShut]) write(path.join(DATA, rel), '{"x":1}\n');
  write(path.join(DATA, 'chat-images', '0123abcd.png'), '\x89PNG\r\n');

  // ---------- GET /file ----------
  for (const rel of ['src/a.ts', 'src/secrets.ts', '.env.example', 'gh/notes.md', 'src/talk.txt']) {
    const r = get({ path: path.join(REPO, rel) });
    ok(r.code === 200 && r.body.text === plain[rel], `GET /file ${rel}: 200 with its text (${r.code} ${r.body.message || ''})`);
  }
  for (const rel of secretFiles) {
    const r = get({ path: path.join(REPO, rel) });
    ok(r.code === 403 && !('text' in r.body) && /never shows secrets/.test(r.body.message), `GET /file ${rel}: 403 by its name (${r.code} ${r.body.message || ''})`);
  }
  ok(get({ path: '.env.local', cwd: REPO }).code === 403 && get({ path: 'src/../.npmrc', cwd: REPO }).code === 403, 'GET /file: a relative path is fenced the same');
  ok(get({ path: path.join(REPO, 'Credentials') }).code === 403 && get({ path: path.join(REPO, '.ssh') }).code === 403, 'GET /file: a folder with a secret\'s name, a keys folder: 403');
  ok(get({ path: path.join(REPO, '.ssh', 'missing') }).code === 403, 'GET /file: a missing file in a keys folder is 403, not 404 (nothing about it is told)');
  ok(get({ path: '~/.ssh/nothing-here' }).code === 403, 'GET /file: ~/.ssh: 403');
  // the text holds a key, whatever the name: 403, none of the text
  for (const rel of ['src/play.json', 'src/key.txt', 'src/pk.json', 'src/ec.txt']) {
    const r = get({ path: path.join(REPO, rel) });
    ok(r.code === 403 && r.body.secret === true && !('text' in r.body) && /private key/.test(r.body.message), `GET /file ${rel}: 403, its text holds a key (${r.code} ${JSON.stringify(r.body).slice(0, 90)})`);
  }
  // Fleet View's own data folder: its logs, uploads, pictures and Housekeeping's reports only
  for (const rel of dataOpen) {
    const r = get({ path: path.join(DATA, rel) });
    ok(r.code === 200 && r.body.text === '{"x":1}\n', `GET /file <data>/${rel}: 200 (${r.code} ${r.body.message || ''})`);
  }
  const img = get({ path: path.join(DATA, 'chat-images', '0123abcd.png') });
  ok(img.code === 200 && img.body.image === true, `GET /file <data>/chat-images/0123abcd.png: 200, a picture (${img.code})`);
  const listing = get({ path: DATA });
  ok(listing.code === 200 && listing.body.dir === true, `GET /file <data>: 200, its names (${listing.code})`);
  for (const rel of [...dataShut, 'sync', 'relay', 'edge', 'electron-4777']) {
    const r = get({ path: path.join(DATA, rel) });
    ok(r.code === 403 && !('text' in r.body) && !('entries' in r.body) && /own data folder/.test(r.body.message), `GET /file <data>/${rel}: 403, the data folder's message (${r.code} ${r.body.message || ''})`);
  }
  ok(!FILES._test.dataOk(path.join(DATA, '..x', 'api-token')) && FILES._test.dataOk(path.join(DATA, '..', 'x')), 'dataOk: a name starting with ".." is in the data folder; ".." itself leads out');
  ok(FILES._test.refusal(path.join(REPO, '.env')) === 'secret' && FILES._test.refusal(path.join(DATA, 'api-token')) === 'data' && FILES._test.refusal(path.join(REPO, 'src', 'a.ts')) === '',
    'refusal: secret, data, or none');
  ok(get({ path: 'api-token', cwd: DATA }).code === 403 && get({ path: 'uploads/../api-token', cwd: DATA }).code === 403
    && get({ path: path.join(DATA, 'uploads', '..', 'host.json') }).code === 403, 'GET /file: the data folder\'s token by a relative path or through uploads/..: 403');
  if (P.isWin || P.isMac) {
    const r = get({ path: path.join(path.dirname(DATA), 'FLEET-VIEW', 'API-TOKEN') });
    ok(r.code === 403, `GET /file: the token in another case: 403 (${r.code})`);
  }
  // links and junctions: checked where they really lead
  const toSync = link(path.join(DATA, 'sync'), path.join(REPO, 'linked-sync'));
  const toData = link(DATA, path.join(T, 'data-link'));
  const toSsh = link(path.join(REPO, '.ssh'), path.join(REPO, 'plain-name'));
  ok(toSync && toData && toSsh, 'the links were made (else their cases did not run)');
  if (toSync) ok(get({ path: path.join(toSync, 'config.json') }).code === 403, 'GET /file: a link into the data folder\'s sync/: 403');
  if (toData) {
    ok(get({ path: path.join(toData, 'api-token') }).code === 403 && get({ path: path.join(toData, 'relay', 'devices.json') }).code === 403, 'GET /file: a link to the data folder: its token and keys are 403');
    ok(get({ path: path.join(toData, 'server.log') }).code === 200, 'GET /file: a link to the data folder: its logs still open');
  }
  if (toSsh) ok(get({ path: path.join(toSsh, 'config') }).code === 403, 'GET /file: a plain-named link to a keys folder: 403');
  // readable() (also /reveal's first check)
  ok(FILES.readable(path.join(REPO, 'src', 'a.ts')) && FILES.readable(path.join(DATA, 'server.log')) && FILES.readable(DATA), 'readable: a plain file, a log, the data folder');
  ok(!FILES.readable(path.join(REPO, '.env')) && !FILES.readable(path.join(DATA, 'api-token')) && !FILES.readable(path.join(DATA, 'sync')), 'readable: not .env, the token or sync/');
  ok(FILES._test.dataOk(path.join(T, 'elsewhere', 'api-token')) && FILES._test.dataOk(path.dirname(DATA)), 'dataOk: outside the data folder, and the folder above it');
  if (P.isWin) {
    // a network path is refused by its name, before anything resolves it (that would make Windows reach the server)
    const orig = fs.realpathSync.native, seen = [];
    fs.realpathSync.native = (p, ...a) => { seen.push(String(p)); return orig(p, ...a); };
    try {
      ok(!FILES.readable('\\\\no-such-host-fv-test\\share\\a.txt') && !FILES.readable(`${path.join(REPO, 'src', 'a.ts')}:hidden`), 'readable: a network path, an alternate data stream: no');
      ok(!seen.some((p) => p.startsWith('\\\\')), `readable: a network path is never resolved (${seen.join(', ')})`);
    } finally { fs.realpathSync.native = orig; }
  }

  // ---------- GET /folders ----------
  let [code, b] = await folders(REPO);
  const names = (b.folders || []).map((x) => x.name);
  ok(code === 200 && b.ok && ['src', 'certs', 'keys', 'gh', 'gcp'].every((n) => names.includes(n)), `GET /folders repo: its plain folders (${names.join(', ')})`);
  ok(!names.includes('Credentials') && !names.includes('Keychains') && !names.includes('.ssh'), 'GET /folders repo: no folder with a secret\'s name, no keys folder');
  [code, b] = await folders(DATA);
  const dataNames = (b.folders || []).map((x) => x.name);
  ok(code === 200 && b.ok && ['uploads', 'chat-images', 'housekeeping'].every((n) => dataNames.includes(n)), `GET /folders <data>: uploads, chat-images, housekeeping (${dataNames.join(', ')})`);
  ok(!['sync', 'relay', 'link', 'edge', 'electron-4777', 'accounts'].some((n) => dataNames.includes(n)), 'GET /folders <data>: not sync, relay, link, the browser profiles or accounts');
  for (const p of [path.join(DATA, 'sync'), path.join(REPO, 'Credentials'), path.join(REPO, 'Keychains'), path.join(REPO, '.ssh'), ...(toSync ? [toSync] : []), ...(toSsh ? [toSsh] : [])]) {
    [code, b] = await folders(p);
    ok(code === 200 && b.ok === false && b.secret === true && !b.folders, `GET /folders ${path.relative(T, p)}: refused (${JSON.stringify(b).slice(0, 100)})`);
  }
  [code, b] = await folders(path.join(DATA, 'uploads'));
  ok(code === 200 && b.ok && b.folders.map((x) => x.name).includes('2026-10-17'), 'GET /folders <data>/uploads: open');
})().catch((e) => { failures++; console.log(`FAIL threw: ${e && e.stack || e}`); }).finally(() => {
  for (const l of links) { try { fs.unlinkSync(l); } catch { try { fs.rmdirSync(l); } catch {} } }
  try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
  console.log(`files: ${passes} passed, ${failures} failed`);
  process.exitCode = failures ? 1 : 0;
});
