#!/usr/bin/env node
// Tests updater.js's "Update automatically": on for an install that never touched it (no update.json, or one without
// "auto"), off only when update.json says auto: false. A friend's install is played by a clone of a local bare repo
// in the temp folder holding a copy of updater.js and what it loads; its data folder is a temp one too. A new commit
// on the bare repo is the update, and autoTick must pull it in by itself. No network, nothing real is touched.
// Prints PASS/FAIL per check and exits 1 on any failure.
//   node scripts/updater-test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`PASS: ${name}`);
  else { failures++; console.log(`FAIL: ${name}${detail ? ` (${detail})` : ''}`); }
};
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const SRC = path.resolve(__dirname, '..');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-test-'));
const ORIGIN = path.join(ROOT, 'origin.git'), SEED = path.join(ROOT, 'seed'), FRIEND = path.join(ROOT, 'friend');
// the data folder (update.json) before updater.js is loaded: it reads platform.js's dataDir() once
process.env.LOCALAPPDATA = path.join(ROOT, 'data');
process.env.HOME = process.env.USERPROFILE = path.join(ROOT, 'home');
process.env.XDG_STATE_HOME = path.join(ROOT, 'state');
fs.mkdirSync(process.env.HOME, { recursive: true });
const DATA = require(path.join(SRC, 'platform.js')).dataDir();
const PREFS = path.join(DATA, 'update.json');
const writePrefs = (p) => { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(PREFS, JSON.stringify(p)); };

const ident = ['-c', 'user.name=test', '-c', 'user.email=test@example.com'];
let n = 0;
const publish = () => {
  fs.writeFileSync(path.join(SEED, `change-${++n}.txt`), `${n}\n`);
  git(SEED, 'add', '-A');
  git(SEED, ...ident, 'commit', '-q', '-m', `Fleet View change ${n}`);
  git(SEED, 'push', '-q', 'origin', 'HEAD:main');
};

try {
  git(ROOT, 'init', '-q', '--bare', '-b', 'main', ORIGIN);
  git(ROOT, 'init', '-q', '-b', 'main', SEED);
  for (const f of ['updater.js', 'version.js', 'platform.js', 'version.json']) fs.copyFileSync(path.join(SRC, f), path.join(SEED, f));
  git(SEED, 'remote', 'add', 'origin', ORIGIN);
  publish();
  git(ROOT, 'clone', '-q', ORIGIN, FRIEND);
  const U = require(path.join(FRIEND, 'updater.js'));
  const head = () => git(FRIEND, 'rev-parse', 'HEAD');
  const upstream = () => git(ORIGIN, 'rev-parse', 'main');

  // a fresh install: no update.json at all
  check('no update.json: Update automatically is on', !fs.existsSync(PREFS) && U.status().auto === true, JSON.stringify({ auto: U.status().auto }));
  publish();
  (async () => {
    await U.check();
    check('the new commit is found', U.status().behind === 1 && U.status().enabled, JSON.stringify({ behind: U.status().behind, error: U.status().error }));
    await U.autoTick();
    check('no update.json: the update goes in by itself', head() === upstream(), `${head()} vs ${upstream()}`);

    // update.json holding other things (relaunchWanted), never "auto": still on
    writePrefs({ relaunchWanted: '1.0.1' });
    check('update.json without "auto": on', U.status().auto === true);
    publish();
    await U.check();
    await U.autoTick();
    check('update.json without "auto": the update goes in by itself', head() === upstream());

    // switched off: stays put
    writePrefs({ auto: false });
    check('auto: false: off', U.status().auto === false);
    publish();
    await U.check();
    await U.autoTick();
    check('auto: false: the update waits', head() !== upstream() && U.status().behind === 1);

    // switched on again
    writePrefs({ auto: true });
    check('auto: true: on', U.status().auto === true);
    await U.autoTick();
    check('auto: true: the update goes in by itself', head() === upstream());
  })().catch((e) => { failures++; console.log(`FAIL: threw ${e && e.stack}`); }).finally(() => {
    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
    console.log(failures ? `${failures} failed` : 'all passed');
    process.exit(failures ? 1 : 0);
  });
} catch (e) {
  console.log(`FAIL: setup: ${e && e.message}`);
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
  process.exit(1);
}
