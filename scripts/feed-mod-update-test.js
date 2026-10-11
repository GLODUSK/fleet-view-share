#!/usr/bin/env node
// Tests feed-mod.js: a made-up home folder in the temp folder with several Claude logins, and a fake `claude` that
// records each command and does what claude plugin update would to installed_plugins.json. Nothing real is spawned
// and no real login is read. Prints PASS/FAIL per check and exits 1 on any failure.
//   node scripts/feed-mod-update-test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const FM = require(path.join(__dirname, '..', 'feed-mod.js'));

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`PASS: ${name}`);
  else { failures++; console.log(`FAIL: ${name}${detail ? ` (${detail})` : ''}`); }
};
const write = (f, j) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(j, null, 2)); };
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-mod-test-'));
const HOME = path.join(ROOT, 'home');
const MOD = path.join(ROOT, 'fleet-view', 'mod');
const OTHER = path.join(ROOT, 'elsewhere', 'mod');
const PROJ = path.join(ROOT, 'proj');
fs.mkdirSync(PROJ, { recursive: true });
write(path.join(MOD, 'fleet-view-feed', '.claude-plugin', 'plugin.json'), { name: 'fleet-view-feed', version: '0.1.1' });

const entry = (scope, version, projectPath) => ({ scope, installPath: `cache/${version}`, version, ...(projectPath ? { projectPath } : {}) });
const login = (name, { entries, market = MOD, shareWith } = {}) => {
  const dir = path.join(HOME, name);
  fs.mkdirSync(dir, { recursive: true });
  if (shareWith) { fs.symlinkSync(path.join(HOME, shareWith, 'plugins'), path.join(dir, 'plugins'), 'junction'); return; }
  write(path.join(dir, 'plugins', 'installed_plugins.json'), { version: 2, plugins: entries ? { 'fleet-view-feed@fleet-view': entries, 'other@x': [entry('user', '9.9.9')] } : { 'other@x': [entry('user', '9.9.9')] } });
  if (market) write(path.join(dir, 'plugins', 'known_marketplaces.json'), { 'fleet-view': { source: { source: 'directory', path: market }, installLocation: market } });
};
// B: stale in user scope and in a project; A shares B's plugins folder; C: no mod; D: current; E: marketplace elsewhere;
// F: claude fails to update it; G: a project install whose folder is gone
login('.claude', { entries: [entry('user', '0.1.0'), entry('project', '0.1.0', PROJ)] });
login('.claude-a', { shareWith: '.claude' });
login('.claude-c', {});
login('.claude-d', { entries: [entry('user', '0.1.1')] });
login('.claude-e', { entries: [entry('user', '0.1.0')], market: OTHER });
login('.claude-f', { entries: [entry('user', '0.1.0')] });
login('.claude-g', { entries: [entry('user', '0.1.1'), entry('project', '0.1.0', path.join(ROOT, 'gone'))] });
fs.mkdirSync(path.join(HOME, '.claude-handoffs')); // not a login: two letters

const calls = [];
// the fake claude: `plugin update` sets that scope's version to the mod's, except in F, where it fails
const run = async (args, { cfg, cwd }) => {
  const dir = cfg || path.join(HOME, '.claude');
  calls.push({ login: path.basename(dir), args: args.join(' '), cwd, cfg });
  if (args[1] === 'update' && args[0] === 'plugin') {
    if (path.basename(dir) === '.claude-f') return { code: 1, out: 'Checking…\nFailed to update: disk full' };
    const f = path.join(dir, 'plugins', 'installed_plugins.json');
    const j = read(f);
    const scope = args[args.indexOf('--scope') + 1];
    for (const e of j.plugins[args[2]]) if (e.scope === scope && (scope === 'user' || e.projectPath === cwd)) e.version = '0.1.1';
    write(f, j);
  }
  return { code: 0, out: 'ok' };
};

(async () => {
  const lines = [];
  const res = await FM.check({ home: HOME, modDir: MOD, log: (t) => lines.push(t), run });
  const by = Object.fromEntries(res.map((r) => [r.login, r]));
  for (const l of lines) console.log(`  log: ${l}`);

  check('every login is listed once, ~/.claude-handoffs is not', res.map((r) => r.login).join() === '~/.claude,~/.claude-a,~/.claude-c,~/.claude-d,~/.claude-e,~/.claude-f,~/.claude-g', res.map((r) => r.login).join());
  check('one log line per login', lines.length === res.length && lines.every((l) => l.startsWith('feed mod: ')));

  check('B is updated in both scopes', by['~/.claude'].status === 'updated' && /0\.1\.0 → 0\.1\.1 in ~\/\.claude \(user, project /.test(by['~/.claude'].line), by['~/.claude'].line);
  const b = calls.filter((c) => c.login === '.claude').map((c) => c.args);
  check('B runs marketplace update, then plugin update per stale scope', b.join(' | ') === 'plugin marketplace update fleet-view | plugin update fleet-view-feed@fleet-view --scope user | plugin update fleet-view-feed@fleet-view --scope project', b.join(' | '));
  check('the project scope runs in its project folder, user scope in home', calls.some((c) => /--scope project/.test(c.args) && c.cwd === PROJ) && calls.some((c) => /--scope user/.test(c.args) && c.cwd === HOME));
  check('B runs without CLAUDE_CONFIG_DIR, the letters with theirs', calls.filter((c) => c.login === '.claude').every((c) => c.cfg === null) && calls.filter((c) => c.login === '.claude-f').every((c) => c.cfg === path.join(HOME, '.claude-f')));
  const after = read(path.join(HOME, '.claude', 'plugins', 'installed_plugins.json'));
  check('the other plugin is untouched', after.plugins['other@x'][0].version === '9.9.9');

  check('A shares B\'s plugins folder: nothing run there', by['~/.claude-a'].status === 'shared' && !calls.some((c) => c.login === '.claude-a'), by['~/.claude-a'].line);
  check('C has no mod: left alone, nothing installed', by['~/.claude-c'].status === 'absent' && !calls.some((c) => c.login === '.claude-c'));
  check('D is current: nothing run', by['~/.claude-d'].status === 'current' && /0\.1\.1 is current/.test(by['~/.claude-d'].line) && !calls.some((c) => c.login === '.claude-d'));
  check('E takes the mod from another folder: left alone', by['~/.claude-e'].status === 'elsewhere' && !calls.some((c) => c.login === '.claude-e'), by['~/.claude-e'].line);
  check('F: a failed update says so, with claude\'s last line', by['~/.claude-f'].status === 'failed' && /still 0\.1\.0 .*disk full/.test(by['~/.claude-f'].line), by['~/.claude-f'].line);
  check('G: a project install whose folder is gone is left alone', by['~/.claude-g'].status === 'current' && /0\.1\.1 is current .*left alone: no such folder/.test(by['~/.claude-g'].line) && !calls.some((c) => c.login === '.claude-g'), by['~/.claude-g'].line);

  // a second start after the update: nothing more to do
  calls.length = 0;
  const again = await FM.check({ home: HOME, modDir: MOD, log: () => {}, run });
  check('a second check runs only the one that still fails', calls.every((c) => c.login === '.claude-f') && again.find((r) => r.login === '~/.claude').status === 'current');

  // no mod folder (an old checkout): one line, nothing run
  calls.length = 0;
  const none = [];
  await FM.check({ home: HOME, modDir: path.join(ROOT, 'nothing'), log: (t) => none.push(t), run });
  check('no mod here: one line and nothing run', none.length === 1 && !calls.length, none.join());

  // start() with off: logs why, runs nothing
  const off = [];
  FM.start({ home: HOME, modDir: MOD, log: (t) => off.push(t), run, off: 'a demo', delayMs: 0 });
  await new Promise((r) => setTimeout(r, 30));
  check('start() in a demo only logs', off.join() === 'feed mod: not checked (a demo)' && !calls.length, off.join());

  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
  console.log(failures ? `${failures} failed` : 'all passed');
  process.exit(failures ? 1 : 0);
})();
