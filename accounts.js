// Fleet View: adding, signing in and removing Claude accounts (the Accounts list at the top of the Usage card).
//
// An account is one letter. B is the default login in ~/.claude (its account file ~/.claude.json); every other is
// a folder ~/.claude-<x> with its own .claude.json and .credentials.json. fleet-view.js lists them from the folders,
// so adding or removing one here is all it takes; nothing else keeps a list.
//
//   add({ email })      a new letter (A, then C, D, ...; B again when B has no login), its folder made like B's
//                       (below), and a sign-in started for it
//   login(a, { email }) sign that letter in again, to the same login or another ("Switch login"): sessions running
//                       on it carry on with the new login when claude next reads its credentials
//   code(a, text)       the code claude.ai shows when the sign-in finished in another browser, typed into it
//   cancel(a)           stop a sign-in; a letter added for it goes again
//   remove(a)           sign the letter out: its login and account file are backed up first (BACKUP_DIR), then B is
//                       signed out (claude auth logout) and any other letter's folder is moved aside
//                       (~/.claude-x.removed-<time>, or the folder ~/.claude-x links to). Refused while a claude
//                       runs on it: { ok: false, live: [{ id, name }] }
//   view()              { list: [{ a, email, org, signedIn, sameAs }], jobs: { a: { status, url, message, email } } }
//
// A sign-in is `claude auth login --claudeai [--email <e>]` with the letter's CLAUDE_CONFIG_DIR, no terminal: it
// opens the browser on claude.ai and finishes by itself once the browser says yes (the browser signs in with the
// claude.ai account it is on). Its "visit:" link is kept for the page, for a private window, whose code then goes
// in through code(). A login that is already another letter's is not kept: the letter's old login comes back
// (or a new letter goes again) and the job says so (status 'same').
//
// A new letter's folder: when ~/.claude is a link to a folder elsewhere (J:\Cache\ClaudeCode), the new one is made
// next to that folder (J:\Cache\ClaudeCode-<x>) with ~/.claude-<x> a junction to it; else ~/.claude-<x> itself.
// In it: junctions to B's shared folders (conversations, hooks, skills, plugins, ...), so every account sees the
// same conversations and setup; hard links to CLAUDE.md, history.jsonl and settings.local.json; a copy of
// settings.json; and an account file seeded from B's with its projects (trust, allowed tools) and MCP servers but
// no login. Nothing here ever deletes a folder: what goes is moved aside.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const LETTERS = 'ACDEFGHIJKLMNOPQRSTUVWXYZ';
const SHARE_DIRS = ['agents', 'commands', 'file-history', 'hooks', 'paste-cache', 'plugins', 'projects', 'session-env', 'sessions', 'shell-snapshots', 'skills', 'tasks'];
const LINK_FILES = ['CLAUDE.md', 'history.jsonl', 'settings.local.json'];
const COPY_FILES = ['settings.json'];
const SEED_KEYS = ['installMethod', 'hasCompletedOnboarding', 'lastOnboardingVersion', 'lastReleaseNotesSeen', 'projects', 'mcpServers', 'githubRepoPaths',
  'officialMarketplaceAutoInstallAttempted', 'officialMarketplaceAutoInstalled', 'claudeInChromeDefaultEnabled', 'hasCompletedClaudeInChromeOnboarding'];
const LOGIN_MS = 10 * 60e3; // a sign-in nobody finished is stopped
const KEEP_JOB_MS = 3 * 60e3; // a finished one stays in view this long
// no % (cmd would read a variable in it) nor any other character cmd treats specially: it goes on claude's command line
const EMAIL_RE = /^[A-Za-z0-9._+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
const CODE_RE = /^[A-Za-z0-9_\-#.~]{8,600}$/;
const URL_RE = /https:\/\/\S*oauth\S*/;
// what must not reach the claude started here from Fleet View's own environment (as host.js's childEnv)
const DROP_ENV = /^(CLAUDE_CONFIG_DIR|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_SWAP_KEY|CLAUDE_SWAP_PAYER|CLAUDE_LAUNCH_KEY|CLAUDECODE|CLAUDE_PID|ELECTRON_RUN_AS_NODE|CLAUDE_CODE_(CHILD_SESSION|SESSION_ID|MESSAGING_SOCKET|MESSAGING_TOKEN|ENTRYPOINT|SESSION_ATTENDED)|FLEET_VIEW_\w+|FV_\w+)$/i;

const stamp = (t = new Date()) => t.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');

function createAccounts(o = {}) {
  const home = o.home || os.homedir();
  const backupDir = o.backupDir || path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'fleet-view', 'accounts');
  const log = o.log || (() => {});
  const changed = o.changed || (() => {});
  const liveOn = o.liveOn || (() => []);
  const claudeCmd = o.claudeCmd || 'claude';
  const jobs = new Map(); // letter -> { status, url, message, email, at, child, fresh, before, out }

  const dirOf = (a) => path.join(home, a === 'B' ? '.claude' : '.claude-' + a.toLowerCase());
  const fileOf = (a) => (a === 'B' ? path.join(home, '.claude.json') : path.join(dirOf(a), '.claude.json'));
  const credOf = (a) => path.join(dirOf(a), '.credentials.json');
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const readBuf = (f) => { try { return fs.readFileSync(f); } catch { return null; } };
  const exists = (f) => { try { fs.lstatSync(f); return true; } catch { return false; } };

  // B, then every ~/.claude-<x> folder there is
  function letters() {
    const out = ['B'];
    try {
      for (const e of fs.readdirSync(home, { withFileTypes: true })) {
        const m = /^\.claude-([a-z])$/i.exec(e.name);
        if (!m) continue;
        try { if (fs.statSync(path.join(home, e.name)).isDirectory()) out.push(m[1].toUpperCase()); } catch {}
      }
    } catch {}
    return [...new Set(out)].sort((x, y) => (x === 'B' ? -1 : y === 'B' ? 1 : x < y ? -1 : 1));
  }
  function loginOf(a) {
    const acc = (readJson(fileOf(a)) || {}).oauthAccount;
    if (!acc || !exists(credOf(a))) return null;
    return { id: acc.accountUuid || acc.emailAddress || null, email: acc.emailAddress || null, org: acc.organizationName || null };
  }
  // the letter (other than a) already signed in to login id, or null
  const holderOf = (id, a) => (id ? letters().find((x) => x !== a && (loginOf(x) || {}).id === id) || null : null);

  function view() {
    const now = Date.now();
    const seen = {};
    const list = letters().map((a) => {
      const l = loginOf(a);
      const sameAs = l && l.id && seen[l.id] ? seen[l.id] : null;
      if (l && l.id && !sameAs) seen[l.id] = a;
      return { a, email: l ? l.email : null, org: l ? l.org : null, signedIn: !!l, sameAs };
    });
    const out = {};
    for (const [a, j] of jobs) {
      if (j.status !== 'waiting' && now - j.at > KEEP_JOB_MS) { jobs.delete(a); continue; }
      out[a] = { status: j.status, url: j.url || null, message: j.message || null, email: j.email || null, fresh: !!j.fresh };
    }
    return { list, jobs: out };
  }

  // ---------- a new letter's folder ----------
  function nextLetter() {
    if (!loginOf('B') && !jobs.has('B')) return 'B';
    const have = new Set(letters());
    return [...LETTERS].find((x) => !have.has(x) && !exists(dirOf(x)) && !jobs.has(x)) || null;
  }
  function makeFolder(a) {
    const link = dirOf(a), bHome = dirOf('B');
    let bReal = bHome;
    try { bReal = fs.realpathSync(bHome); } catch {}
    const linked = path.resolve(bReal).toLowerCase() !== path.resolve(bHome).toLowerCase();
    let real = linked ? path.join(path.dirname(bReal), path.basename(bReal) + '-' + a.toLowerCase()) : link;
    // an old folder of that name (one moved aside keeps its own) is left as it is
    if (linked && exists(real)) real = `${real}-${stamp()}`;
    fs.mkdirSync(real);
    if (linked) fs.symlinkSync(real, link, 'junction');
    for (const d of SHARE_DIRS) {
      try { if (fs.statSync(path.join(bReal, d)).isDirectory()) fs.symlinkSync(path.join(bReal, d), path.join(real, d), 'junction'); } catch (e) { log(`accounts: no ${d} link in ${a}: ${e.message}`); }
    }
    for (const f of LINK_FILES) {
      const from = path.join(bReal, f);
      if (!exists(from)) continue;
      try { fs.linkSync(from, path.join(real, f)); } catch { try { fs.copyFileSync(from, path.join(real, f)); } catch {} }
    }
    for (const f of COPY_FILES) { try { fs.copyFileSync(path.join(bReal, f), path.join(real, f)); } catch {} }
    const b = readJson(fileOf('B')) || {};
    const seed = {};
    for (const k of SEED_KEYS) if (k in b) seed[k] = b[k];
    fs.writeFileSync(path.join(real, '.claude.json'), JSON.stringify(seed, null, 2));
    log(`accounts: made ${link}${linked ? ` -> ${real}` : ''}`);
  }
  // a letter's folder moved aside (never deleted): ~/.claude-x and, when it is a link, the folder it links to
  function moveAside(a) {
    const link = dirOf(a), t = stamp();
    const st = fs.lstatSync(link);
    if (st.isSymbolicLink()) {
      const real = fs.realpathSync(link);
      try { fs.unlinkSync(link); } catch { spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'rmdir', link], { windowsHide: true, timeout: 10e3 }); }
      if (exists(link)) throw new Error(`could not remove the link ${link}`);
      try { fs.renameSync(real, `${real}.removed-${t}`); } catch (e) { log(`accounts: ${real} stays where it is: ${e.message}`); }
    } else fs.renameSync(link, `${link}.removed-${t}`);
    log(`accounts: ${a} moved aside`);
  }
  function backup(a, why) {
    const l = loginOf(a);
    const to = path.join(backupDir, `${a}-${(l && l.email) || 'no-login'}-${why}-${stamp()}`.replace(/[^\w.@+-]/g, '_'));
    fs.mkdirSync(to, { recursive: true });
    for (const [from, name] of [[credOf(a), '.credentials.json'], [fileOf(a), '.claude.json']]) { try { fs.copyFileSync(from, path.join(to, name)); } catch {} }
    return to;
  }

  // ---------- signing in ----------
  function childEnv(a) {
    const env = {};
    for (const [k, v] of Object.entries(process.env)) if (!DROP_ENV.test(k)) env[k] = v;
    if (a !== 'B') env.CLAUDE_CONFIG_DIR = dirOf(a);
    return env;
  }
  function treeKill(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return;
    try { spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' }).on('error', () => {}); } catch {}
  }
  function startLogin(a, { email, fresh }) {
    const before = { cred: readBuf(credOf(a)), file: readBuf(fileOf(a)), login: loginOf(a) };
    const args = ['auth', 'login', '--claudeai'].concat(email ? ['--email', email] : []);
    const j = { status: 'waiting', url: null, message: 'Your browser is opening claude.ai to sign in.', email: email || null, at: Date.now(), fresh, before, out: '' };
    jobs.set(a, j);
    let child;
    try {
      // cmd finds claude.cmd or claude.exe on PATH, as the session host's panels do
      child = spawn(process.env.ComSpec || 'cmd.exe', [`/d /s /c "${claudeCmd} ${args.join(' ')}"`], { env: childEnv(a), cwd: home, windowsHide: true, windowsVerbatimArguments: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { return finish(a, j, false, `could not start claude: ${e.message}`); }
    j.child = child;
    const take = (d) => {
      j.out = (j.out + d).slice(-8000);
      const m = URL_RE.exec(j.out);
      if (m && !j.url) j.url = m[0];
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', (e) => finish(a, j, false, `claude did not start: ${e.message}`));
    child.on('exit', (code) => finish(a, j, code === 0 && /success/i.test(j.out), null));
    j.timer = setTimeout(() => { if (j.status === 'waiting') { treeKill(child.pid); finish(a, j, false, 'Nobody finished the sign-in in 10 minutes, so it stopped.'); } }, LOGIN_MS);
    if (j.timer.unref) j.timer.unref();
    log(`accounts: signing in ${a}${email ? ' as ' + email : ''}`);
    return j;
  }
  // the letter's login as it was before the sign-in (a new letter: its folder goes again)
  function undo(a, j) {
    if (j.fresh && a !== 'B') { try { moveAside(a); } catch (e) { log(`accounts: could not move ${a} aside: ${e.message}`); } return; }
    // still the old login: left alone, since a session on it may have refreshed its token meanwhile
    const now = loginOf(a);
    if (j.before.login ? now && now.id === j.before.login.id : !now) return;
    for (const [f, buf] of [[credOf(a), j.before.cred], [fileOf(a), j.before.file]]) {
      try { if (buf) fs.writeFileSync(f, buf); else if (exists(f) && f === credOf(a)) fs.unlinkSync(f); } catch (e) { log(`accounts: could not put ${f} back: ${e.message}`); }
    }
  }
  function finish(a, j, ok, why) {
    if (j.status !== 'waiting') return;
    clearTimeout(j.timer);
    j.at = Date.now();
    j.child = null;
    const l = ok ? loginOf(a) : null;
    const other = l ? holderOf(l.id, a) : null;
    if (ok && l && other) {
      undo(a, j);
      j.status = 'same';
      j.message = `${l.email || 'That login'} is already Claude ${other}, so nothing changed. To add another account, sign out of claude.ai in the browser first, or open the link in a private window.`;
    } else if (ok && l) {
      j.status = 'done';
      j.email = l.email;
      j.message = j.before.login && j.before.login.id === l.id ? `Claude ${a} is signed in again as ${l.email}.` : `Claude ${a} is now ${l.email}.`;
    } else {
      // a sign-in that failed or was stopped leaves the letter as it was
      if (j.status === 'waiting') undo(a, j);
      j.status = 'failed';
      j.message = why || (j.out.match(/(error|failed)[^\n]*/i) || ['The sign-in did not finish.'])[0].slice(0, 300);
    }
    log(`accounts: ${a} sign-in ${j.status}${l && l.email ? ' (' + l.email + ')' : ''}`);
    changed(a);
  }

  // ---------- what the page asks for ----------
  function add(b = {}) {
    const email = cleanEmail(b.email);
    if (email === false) return [400, { ok: false, message: 'That is not an email address.' }];
    const a = nextLetter();
    if (!a) return [409, { ok: false, message: 'Every letter is taken.' }];
    if (a !== 'B') {
      try { makeFolder(a); } catch (e) { log(`accounts: could not make ${a}: ${e.message}`); return [500, { ok: false, message: `Could not make the folder for Claude ${a}: ${e.message}` }]; }
    }
    startLogin(a, { email, fresh: true });
    changed(a);
    return [200, { ok: true, account: a }];
  }
  function login(a, b = {}) {
    const email = cleanEmail(b.email);
    if (email === false) return [400, { ok: false, message: 'That is not an email address.' }];
    if (!letters().includes(a)) return [404, { ok: false, message: `There is no Claude ${a}.` }];
    if (jobs.get(a) && jobs.get(a).status === 'waiting') return [409, { ok: false, message: `Claude ${a} is already signing in.` }];
    startLogin(a, { email, fresh: false });
    changed(a);
    return [200, { ok: true, account: a }];
  }
  function code(a, text) {
    const j = jobs.get(a);
    const c = typeof text === 'string' ? text.trim() : '';
    if (!j || j.status !== 'waiting' || !j.child) return [409, { ok: false, message: `Claude ${a} is not signing in.` }];
    if (!CODE_RE.test(c)) return [400, { ok: false, message: 'That does not look like the code claude.ai showed.' }];
    try { j.child.stdin.write(c + '\n'); } catch (e) { return [500, { ok: false, message: e.message }]; }
    j.message = 'Code sent; finishing the sign-in.';
    return [200, { ok: true }];
  }
  function cancel(a) {
    const j = jobs.get(a);
    if (!j || j.status !== 'waiting') return [409, { ok: false, message: `Claude ${a} is not signing in.` }];
    if (j.child) treeKill(j.child.pid);
    finish(a, j, false, 'Sign-in stopped.');
    return [200, { ok: true }];
  }
  function remove(a) {
    if (!letters().includes(a)) return [404, { ok: false, message: `There is no Claude ${a}.` }];
    const j = jobs.get(a);
    if (j && j.status === 'waiting') return [409, { ok: false, message: `Claude ${a} is signing in; stop that first.` }];
    const live = liveOn(a);
    if (live.length) return [409, { ok: false, live, message: `${live.length === 1 ? '1 session runs' : `${live.length} sessions run`} on Claude ${a}.` }];
    const l = loginOf(a);
    const saved = backup(a, 'removed');
    try {
      if (a === 'B') {
        const r = spawnSync(process.env.ComSpec || 'cmd.exe', [`/d /s /c "${claudeCmd} auth logout"`], { env: childEnv('B'), cwd: home, windowsHide: true, windowsVerbatimArguments: true, encoding: 'utf8', timeout: 30e3 });
        if (r.status !== 0 && loginOf('B')) throw new Error(String(r.stderr || r.stdout || 'claude auth logout failed').trim().slice(0, 300));
      } else moveAside(a);
    } catch (e) {
      log(`accounts: could not remove ${a}: ${e.message}`);
      return [500, { ok: false, message: `Could not remove Claude ${a}: ${e.message}` }];
    }
    jobs.delete(a);
    log(`accounts: removed ${a}${l && l.email ? ' (' + l.email + ')' : ''}; backup in ${saved}`);
    changed(a);
    return [200, { ok: true, backup: saved, message: `Claude ${a}${l && l.email ? ` (${l.email})` : ''} is removed. Its login is saved in ${saved}.` }];
  }
  // '' or undefined: none given; false: not an email
  function cleanEmail(e) {
    if (e == null || e === '') return '';
    const s = String(e).trim();
    return EMAIL_RE.test(s) ? s : false;
  }

  // POST /accounts/add { email? } · /accounts/login { account, email? } · /accounts/code { account, code }
  // · /accounts/cancel { account } · /accounts/remove { account }; answers [code, json]
  function route(pathname, b) {
    const a = b && typeof b.account === 'string' && /^[a-z]$/i.test(b.account) ? b.account.toUpperCase() : null;
    if (pathname === '/accounts/add') return add(b || {});
    if (!a) return [400, { ok: false, message: 'account is needed' }];
    if (pathname === '/accounts/login') return login(a, b);
    if (pathname === '/accounts/code') return code(a, b.code);
    if (pathname === '/accounts/cancel') return cancel(a);
    if (pathname === '/accounts/remove') return remove(a);
    return [404, { ok: false, message: 'no such thing' }];
  }

  return { view, add, login, code, cancel, remove, route, letters, loginOf, _jobs: jobs };
}

module.exports = { createAccounts };
