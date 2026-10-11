// node scripts/accounts-test.js: accounts.js against a made-up home folder and a stand-in claude (no real login is
// touched, nothing goes to claude.ai). Exit code 0 when all pass.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAccounts } = require('../accounts.js');

let failed = 0, passed = 0;
const ok = (cond, name) => { if (cond) passed++; else { failed++; console.log(`FAIL ${name}`); } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accounts-test-'));
const home = path.join(tmp, 'home'), real = path.join(tmp, 'cache', 'ClaudeCode');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(path.join(real, 'projects'), { recursive: true });
fs.mkdirSync(path.join(real, 'skills'), { recursive: true });
fs.writeFileSync(path.join(real, 'CLAUDE.md'), 'rules');
fs.writeFileSync(path.join(real, 'settings.json'), '{"x":1}');
fs.writeFileSync(path.join(real, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"b"}}');
// ~/.claude is a link to a folder elsewhere, as on Henry's PC
fs.symlinkSync(real, path.join(home, '.claude'), 'junction');
fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'u-b', emailAddress: 'b@x.com' }, userID: 'secret', projects: { 'Z:/r': { hasTrustDialogAccepted: true } }, mcpServers: { m: {} } }));

// the stand-in claude: `auth login` signs the folder in as TEST_EMAIL (after a line on stdin with TEST_WAIT), `auth logout` signs out
const fake = path.join(tmp, 'fake-claude.js');
fs.writeFileSync(fake, `
const fs = require('fs'), path = require('path');
const dir = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.TEST_HOME, '.claude');
const file = process.env.CLAUDE_CONFIG_DIR ? path.join(dir, '.claude.json') : path.join(process.env.TEST_HOME, '.claude.json');
const j = JSON.parse(fs.readFileSync(file, 'utf8'));
const cmd = process.argv.slice(2).join(' ');
if (cmd.startsWith('auth status')) { console.log(JSON.stringify({ loggedIn: !!j.oauthAccount && fs.existsSync(path.join(dir, '.credentials.json')) })); process.exit(0); }
if (cmd.startsWith('auth logout')) { fs.unlinkSync(path.join(dir, '.credentials.json')); delete j.oauthAccount; fs.writeFileSync(file, JSON.stringify(j)); process.exit(0); }
console.log('Opening browser to sign in...');
console.log("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=abc");
const done = (code) => {
  if (process.env.TEST_FAIL) { console.log('Login failed: no'); process.exit(1); }
  j.oauthAccount = { accountUuid: 'u-' + process.env.TEST_EMAIL, emailAddress: process.env.TEST_EMAIL, code };
  fs.writeFileSync(path.join(dir, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"t"}}');
  fs.writeFileSync(file, JSON.stringify(j));
  console.log('Login successful.');
  process.exit(0);
};
if (process.env.TEST_WAIT) process.stdin.once('data', (d) => done(String(d).trim())); else setTimeout(done, 100);
`);
process.env.TEST_HOME = home;
let live = [];
const changes = [];
const A = createAccounts({ home, backupDir: path.join(tmp, 'backups'), claudeCmd: `node "${fake}"`, liveOn: () => live, changed: (a) => changes.push(a) });
const until = async (f, ms = 15000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) return false; await new Promise((r) => setTimeout(r, 50)); } return true; };
const job = (a) => A.view().jobs[a] || {};

(async () => {
  // 1. the list as it is
  let v = A.view();
  ok(v.list.length === 1 && v.list[0].a === 'B' && v.list[0].email === 'b@x.com', '1: B listed with its email');

  // 2. add: the next letter is A, made next to B's real folder and linked from ~/.claude-a
  process.env.TEST_EMAIL = 'a@x.com';
  let [code, out] = A.route('/accounts/add', { email: 'a@x.com' });
  ok(code === 200 && out.account === 'A', '2a: add answers with the letter');
  const aReal = path.join(tmp, 'cache', 'ClaudeCode-a');
  ok(fs.lstatSync(path.join(home, '.claude-a')).isSymbolicLink() && fs.existsSync(aReal), '2b: folder next to B, linked from home');
  ok(fs.lstatSync(path.join(aReal, 'projects')).isSymbolicLink() && fs.realpathSync(path.join(aReal, 'projects')) === fs.realpathSync(path.join(real, 'projects')), '2c: projects shared');
  ok(fs.readFileSync(path.join(aReal, 'CLAUDE.md'), 'utf8') === 'rules' && fs.readFileSync(path.join(aReal, 'settings.json'), 'utf8') === '{"x":1}', '2d: CLAUDE.md and settings');
  const seed = JSON.parse(fs.readFileSync(path.join(aReal, '.claude.json'), 'utf8'));
  ok(seed.projects && seed.mcpServers && !seed.oauthAccount && !seed.userID, '2e: account file seeded without the login');
  ok(job('A').status === 'waiting', '2f: signing in');
  ok(await until(() => job('A').status === 'done'), '2g: signed in');
  ok(/a@x\.com/.test(job('A').message) && A.view().list.find((x) => x.a === 'A').email === 'a@x.com', '2h: listed as a@x.com');
  ok(job('A').url && job('A').url.startsWith('https://claude.com/cai/oauth'), '2i: the link is kept');
  ok(changes.includes('A'), '2j: Fleet View is told');

  // 3. add with a login another letter has: not kept, the new folder goes again
  process.env.TEST_EMAIL = 'b@x.com';
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')), oauthAccount: { accountUuid: 'u-b@x.com', emailAddress: 'b@x.com' } }));
  [code, out] = A.route('/accounts/add', {});
  ok(code === 200 && out.account === 'C', '3a: next letter C');
  ok(await until(() => job('C').status === 'same'), '3b: same login as B');
  ok(!fs.existsSync(path.join(home, '.claude-c')) && A.view().list.every((x) => x.a !== 'C'), '3c: C moved aside');
  ok(fs.readdirSync(path.join(tmp, 'cache')).some((n) => /^ClaudeCode-c\.removed-/.test(n)), '3d: its folder kept aside, not deleted');

  // 4. switch A to another login
  process.env.TEST_EMAIL = 'a2@x.com';
  [code] = A.route('/accounts/login', { account: 'a' });
  ok(code === 200, '4a: switch starts');
  ok(A.route('/accounts/login', { account: 'A' })[0] === 409, '4b: one sign-in at a time');
  ok(await until(() => job('A').status === 'done') && A.view().list.find((x) => x.a === 'A').email === 'a2@x.com', '4c: A is a2 now');

  // 5. a failed switch keeps the old login
  process.env.TEST_EMAIL = 'a3@x.com'; process.env.TEST_FAIL = '1';
  A.route('/accounts/login', { account: 'A' });
  ok(await until(() => job('A').status === 'failed'), '5a: failed');
  ok(A.view().list.find((x) => x.a === 'A').email === 'a2@x.com' && /failed/i.test(job('A').message), '5b: still a2, says why');
  delete process.env.TEST_FAIL;

  // 6. the code from claude.ai goes to the sign-in
  process.env.TEST_EMAIL = 'a4@x.com'; process.env.TEST_WAIT = '1';
  A.route('/accounts/login', { account: 'A' });
  await until(() => job('A').url);
  ok(A.route('/accounts/code', { account: 'A', code: 'bad code!' })[0] === 400, '6a: a bad code is refused');
  ok(A.route('/accounts/code', { account: 'A', code: 'abcDEF123-_#xyz' })[0] === 200, '6b: code sent');
  ok(await until(() => job('A').status === 'done'), '6c: signed in with it');
  ok(JSON.parse(fs.readFileSync(path.join(aReal, '.claude.json'), 'utf8')).oauthAccount.code === 'abcDEF123-_#xyz', '6d: claude got the code');

  // 7. stop a sign-in of a new letter: it goes again
  process.env.TEST_EMAIL = 'd@x.com';
  [code, out] = A.route('/accounts/add', {});
  await until(() => job(out.account).url);
  ok(A.route('/accounts/cancel', { account: out.account })[0] === 200 && job(out.account).status === 'failed', '7a: stopped');
  ok(!fs.existsSync(path.join(home, '.claude-' + out.account.toLowerCase())), '7b: the new letter is gone');
  delete process.env.TEST_WAIT;
  await new Promise((r) => setTimeout(r, 300));

  // 8. remove: refused while a claude runs on it, then backed up and moved aside
  live = [{ id: 's1', name: 'work' }];
  [code, out] = A.route('/accounts/remove', { account: 'A' });
  ok(code === 409 && out.live.length === 1, '8a: refused while a session runs');
  live = [];
  [code, out] = A.route('/accounts/remove', { account: 'A' });
  ok(code === 200 && !fs.existsSync(path.join(home, '.claude-a')), '8b: removed');
  ok(fs.existsSync(path.join(out.backup, '.credentials.json')) && fs.existsSync(path.join(out.backup, '.claude.json')), '8c: login backed up');
  ok(fs.existsSync(path.join(real, 'projects')) && fs.existsSync(path.join(real, 'CLAUDE.md')), '8d: B untouched');

  // 9. remove B: signed out, and the next add signs B in again
  [code, out] = A.route('/accounts/remove', { account: 'B' });
  ok(code === 200 && !fs.existsSync(path.join(real, '.credentials.json')) && A.view().list[0].signedIn === false, '9a: B signed out');
  process.env.TEST_EMAIL = 'b2@x.com';
  [code, out] = A.route('/accounts/add', {});
  ok(out.account === 'B', '9b: add fills B first');
  ok(await until(() => job('B').status === 'done') && A.view().list[0].email === 'b2@x.com', '9c: B is b2');

  // 10. what the page sends is checked
  ok(A.route('/accounts/add', { email: 'nope' })[0] === 400, '10a: bad email');
  ok(A.route('/accounts/remove', {})[0] === 400 && A.route('/accounts/remove', { account: 'Q' })[0] === 404, '10b: bad account');

  // 11. a letter asked for (the start screen signs in the letter Blackbox has for a login)
  const free = () => [...'ACDEFGHIJ'].find((x) => !fs.existsSync(path.join(home, `.claude-${x.toLowerCase()}`)));
  const d = free();
  process.env.TEST_EMAIL = 'd@x.com';
  [code, out] = A.route('/accounts/add', { email: 'd@x.com', letter: d.toLowerCase() });
  ok(code === 200 && out.account === d, `11a: add gives the letter asked for (${d})`);
  ok(await until(() => job(d).status === 'done') && (A.loginOf(d) || {}).email === 'd@x.com', '11b: that letter is signed in');
  ok(A.route('/accounts/add', { letter: d })[0] === 409, '11c: a letter that is there is refused');
  ok(A.route('/accounts/add', { letter: 'B' })[0] === 409, '11d: B while it is signed in is refused');
  ok(A.route('/accounts/add', { letter: 'bad' })[0] === 400, '11e: a letter is one letter');

  // 12. relabel: the login of one letter becomes another letter's (sync-accounts.js); B never moves
  const relabeled = [];
  const R = createAccounts({ home, backupDir: path.join(tmp, 'backups'), claudeCmd: `node "${fake}"`, liveOn: () => live, relabeled: (f, t) => relabeled.push(`${f}>${t}`) });
  const dFolder = fs.realpathSync(path.join(home, `.claude-${d.toLowerCase()}`));
  const to = [...'GHIJKLMN'].find((x) => !fs.existsSync(path.join(home, `.claude-${x.toLowerCase()}`)));
  let r = await R.relabel(d, to);
  ok(r[0] === 200 && r[1].signedIn === true, `12a: ${d} -> ${to} is done and still signed in`);
  ok(!fs.existsSync(path.join(home, `.claude-${d.toLowerCase()}`)) && fs.realpathSync(path.join(home, `.claude-${to.toLowerCase()}`)) === dFolder, '12b: the new name links to the same folder, the old one is gone');
  ok((R.loginOf(to) || {}).email === 'd@x.com' && !R.letters().includes(d) && relabeled.join() === `${d}>${to}`, '12c: the login is the new letter\'s, and the server is told');
  ok((await R.relabel('B', 'Q'))[0] === 409 && (await R.relabel(to, 'B'))[0] === 409, '12d: B never moves and nothing becomes B');
  ok((await R.relabel(to, 'B'.toLowerCase()))[0] === 409, '12e: lower case is the same letter');
  ok((await R.relabel('Q', 'R'))[0] === 404, '12f: a letter that is not there');
  const other = R.letters().find((x) => x !== 'B' && x !== to);
  if (other) ok((await R.relabel(to, other))[0] === 409, '12g: onto a letter that is there');
  live = [{ id: 'x', name: 'busy' }];
  ok((await R.relabel(to, 'S'))[0] === 409 && R.letters().includes(to), '12h: not while a session runs on it');
  live = [];
  // a plain folder (not a link) is renamed
  const plain = path.join(home, '.claude-t');
  fs.mkdirSync(plain);
  fs.writeFileSync(path.join(plain, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'u-t', emailAddress: 't@x.com' } }));
  fs.writeFileSync(path.join(plain, '.credentials.json'), '{}');
  r = await R.relabel('T', 'U');
  ok(r[0] === 200 && fs.existsSync(path.join(home, '.claude-u', '.claude.json')) && !fs.existsSync(plain), '12i: a plain folder is renamed');

  // 13. a finished sign-in does not hold its letter (it once gave out C after A had just been given back)
  const next = free();
  A._jobs.set(next, { status: 'same', at: Date.now(), message: 'x' });
  process.env.TEST_EMAIL = 'n@x.com';
  [code, out] = A.route('/accounts/add', { email: 'n@x.com' });
  ok(code === 200 && out.account === next, `13: add gives ${next}, the letter a finished sign-in had (got ${out.account})`);
  await until(() => job(out.account).status !== 'waiting');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
