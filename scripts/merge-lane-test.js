#!/usr/bin/env node
// Tests scripts/merge-lane.js: runs it as a child process with FV_MERGE_LANE_DIR set to a temp folder, so the real
// lane is never touched. Prints PASS/FAIL per check and exits 1 on any failure. Takes about 10 s (two waits).
//   node scripts/merge-lane-test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'merge-lane.js');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-lane-test-'));
const LOCK = path.join(DIR, 'merge-lane.json');
const env = { ...process.env, FV_MERGE_LANE_DIR: DIR };
delete env.CLAUDE_CODE_SESSION_ID;

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`PASS: ${name}`);
  else { failures++; console.log(`FAIL: ${name}${detail ? ` (${detail})` : ''}`); }
};
const run = (...args) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { env, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
};
const runAsync = (...args) => new Promise((resolve) => {
  const c = spawn(process.execPath, [SCRIPT, ...args], { env });
  let out = '';
  c.stdout.on('data', (d) => { out += d; });
  c.stderr.on('data', (d) => { out += d; });
  c.on('close', (code) => resolve({ code, out }));
});
const lock = () => { try { return JSON.parse(fs.readFileSync(LOCK, 'utf8')); } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let r = run('status');
  check('status on a free lane says free', r.code === 0 && /^free/.test(r.out), r.out);

  r = run('take', '--who', 'A', '--note', 'PR #1, server');
  check('take', r.code === 0 && lock() && lock().who === 'A' && lock().note === 'PR #1, server', r.out);

  const firstAt = lock().at;
  await sleep(20);
  r = run('take', '--who', 'A');
  check('re-take by the same who refreshes', r.code === 0 && lock().who === 'A' && lock().at !== firstAt, r.out);

  r = run('take', '--who', 'B');
  check('take by another is refused and names the holder', r.code === 1 && /held by A/.test(r.out) && lock().who === 'A', r.out);

  r = run('status');
  check('status names the holder, note and age', r.code === 0 && /held by A/.test(r.out) && /ago/.test(r.out), r.out);

  r = run('release', '--who', 'B');
  check('release by the wrong who is refused', r.code === 1 && lock() && lock().who === 'A', r.out);

  r = run('release', '--who', 'A');
  check('release', r.code === 0 && !fs.existsSync(LOCK), r.out);

  r = run('release', '--who', 'A');
  check('release of a free lane exits 0', r.code === 0, r.out);

  r = run('take', '--who', 'B');
  check('take after release', r.code === 0 && lock().who === 'B', r.out);

  const waiting = runAsync('take', '--who', 'C', '--wait', '20');
  await sleep(1000);
  run('release', '--who', 'B');
  r = await waiting;
  check('--wait takes the lane once the holder releases', r.code === 0 && lock() && lock().who === 'C', r.out);

  const t0 = Date.now();
  r = run('take', '--who', 'D', '--wait', '2');
  const took = Date.now() - t0;
  check('--wait times out', r.code === 1 && lock().who === 'C' && took >= 1900 && took < 6000, `${r.code} after ${took} ms: ${r.out}`);

  fs.writeFileSync(LOCK, JSON.stringify({ who: 'E', note: 'gone', at: new Date(Date.now() - 46 * 60 * 1000).toISOString() }));
  r = run('take', '--who', 'F');
  check('a lock held over 45 min is taken over', r.code === 0 && lock().who === 'F' && /taken over/.test(r.out), r.out);

  r = run('take');
  check('take without --who or CLAUDE_CODE_SESSION_ID exits 2', r.code === 2, r.out);

  const logText = fs.existsSync(path.join(DIR, 'merge-lane.log')) ? fs.readFileSync(path.join(DIR, 'merge-lane.log'), 'utf8') : '';
  check('the log has takes, a refusal, a release and a takeover',
    /take: A/.test(logText) && /refused: B/.test(logText) && /release: A/.test(logText) && /takeover: F/.test(logText), logText);

  fs.rmSync(DIR, { recursive: true, force: true });
  console.log(failures ? `${failures} failed` : 'all passed');
  process.exit(failures ? 1 : 0);
})();
