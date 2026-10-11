#!/usr/bin/env node
// The merge lane: a lock a Claude session takes before it merges to Fleet View's main and keeps until its restart
// has finished, so two sessions never merge and restart at the same moment and host restarts come one after another.
// The lock is <dataDir>/merge-lane.json (%LOCALAPPDATA%\fleet-view on Windows); FV_MERGE_LANE_DIR overrides the
// folder (for tests). Every take, takeover, release and refused take adds a line to merge-lane.log beside it.
//   node scripts/merge-lane.js take [--who <id>] [--note <text>] [--wait <seconds>]
//   node scripts/merge-lane.js release [--who <id>] [--force]
//   node scripts/merge-lane.js status
// --who defaults to CLAUDE_CODE_SESSION_ID. A take the same holder repeats refreshes it. A take while someone else
// holds the lane exits 1, or with --wait checks every 5 s until it is free (exit 0) or the wait runs out (exit 1).
// A lane held over 45 minutes is taken over: its holder died or forgot. Exit 2 means a usage error.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const WIN = process.platform === 'win32';
const DIR = process.env.FV_MERGE_LANE_DIR || (WIN ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'fleet-view')
  : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support', 'fleet-view') : path.join(os.homedir(), '.local', 'share', 'fleet-view'));
const LOCK = path.join(DIR, 'merge-lane.json');
const LOG = path.join(DIR, 'merge-lane.log');
const STALE_MS = 45 * 60 * 1000;
const POLL_MS = 5000;

const argv = process.argv.slice(2);
const cmd = argv[0];
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null; };
const who = arg('--who') || process.env.CLAUDE_CODE_SESSION_ID || '';
const note = arg('--note') || '';

function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function log(line) {
  try { fs.mkdirSync(DIR, { recursive: true }); fs.appendFileSync(LOG, `${stamp()} ${line}\n`); } catch {}
}
function ago(at) {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(at)) / 1000));
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${(s / 3600).toFixed(1)} h ago`;
}
function describe(h) { return `${h.who}${h.note ? ` (${h.note})` : ''}, taken ${ago(h.at)}`; }

// The holder, or null when the lane is free. A lock file that cannot be read as JSON counts as held "unknown" from
// its file time, so a half-written lock is never taken over until it is stale.
function holder() {
  let text;
  try { text = fs.readFileSync(LOCK, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  try { const h = JSON.parse(text); if (h && h.who && h.at) return h; } catch {}
  let at = new Date().toISOString();
  try { at = fs.statSync(LOCK).mtime.toISOString(); } catch {}
  return { who: 'unknown', note: 'unreadable lock file', at };
}
function writeLock(fd, keepNote) {
  const rec = { who, note: note || keepNote || '', at: new Date().toISOString() };
  fs.writeSync(fd, JSON.stringify(rec, null, 2) + '\n');
  fs.closeSync(fd);
}

// One attempt: 'taken', 'refreshed', 'takeover' or the holder that refused it.
function tryTake() {
  fs.mkdirSync(DIR, { recursive: true });
  try { writeLock(fs.openSync(LOCK, 'wx')); return { result: 'taken' }; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const h = holder();
  if (!h) return tryTake(); // released between the open and the read
  if (h.who === who) { writeLock(fs.openSync(LOCK, 'w'), h.note); return { result: 'refreshed' }; }
  if (Date.now() - Date.parse(h.at) > STALE_MS) {
    // Rename the stale lock away first, so of two sessions taking it over at once only one wins the rename.
    const aside = `${LOCK}.${process.pid}.stale`;
    try { fs.renameSync(LOCK, aside); } catch { return { result: 'busy', holder: holder() || h }; }
    try { fs.unlinkSync(aside); } catch {}
    try { writeLock(fs.openSync(LOCK, 'wx')); return { result: 'takeover', previous: h }; } catch (e) { if (e.code !== 'EEXIST') throw e; }
    return { result: 'busy', holder: holder() || h };
  }
  return { result: 'busy', holder: h };
}

function take() {
  const r = tryTake();
  if (r.result === 'taken') { log(`take: ${who}${note ? ` (${note})` : ''}`); console.log(`merge lane taken by ${who}`); return true; }
  if (r.result === 'refreshed') { log(`take: ${who} again (refreshed)`); console.log(`merge lane already yours (${who}); refreshed`); return true; }
  if (r.result === 'takeover') {
    log(`takeover: ${who} took the lane from ${describe(r.previous)}, held over 45 min`);
    console.log(`merge lane taken over from ${describe(r.previous)}: held over 45 minutes, so its holder died or forgot`);
    return true;
  }
  return r.holder;
}

function main() {
  if (cmd === 'status') {
    const h = holder();
    console.log(h ? `held by ${describe(h)}` : 'free');
    return 0;
  }
  if (cmd !== 'take' && cmd !== 'release') {
    console.error('usage: node scripts/merge-lane.js take|release|status [--who <id>] [--note <text>] [--wait <seconds>] [--force]');
    return 2;
  }
  if (!who && !(cmd === 'release' && argv.includes('--force'))) {
    console.error('merge-lane: no --who given and CLAUDE_CODE_SESSION_ID is not set');
    return 2;
  }
  if (cmd === 'release') {
    const h = holder();
    if (!h) { console.log('merge lane is already free'); return 0; }
    if (h.who !== who && !argv.includes('--force')) {
      console.log(`not released: the merge lane is held by ${describe(h)}, not ${who}`);
      return 1;
    }
    fs.unlinkSync(LOCK);
    log(`release: ${who || '(forced)'}${h.who !== who ? ` forced, was ${h.who}` : ''}`);
    console.log(`merge lane released${h.who !== who ? ` (forced; it was ${h.who}'s)` : ''}`);
    return 0;
  }
  const waitArg = arg('--wait');
  const wait = waitArg === null ? 0 : Number(waitArg);
  if (!Number.isFinite(wait) || wait < 0) { console.error('merge-lane: --wait takes a number of seconds'); return 2; }
  const first = take();
  if (first === true) return 0;
  log(`refused: ${who}${note ? ` (${note})` : ''}, held by ${describe(first)}`);
  console.log(`merge lane is held by ${describe(first)}`);
  if (!wait) return 1;
  console.log(`waiting up to ${wait} s for it`);
  const deadline = Date.now() + wait * 1000;
  return new Promise((resolve) => {
    const tick = () => {
      const r = take();
      if (r === true) return resolve(0);
      const left = deadline - Date.now();
      if (left <= 0) {
        log(`refused: ${who} gave up waiting after ${wait} s, held by ${describe(r)}`);
        console.log(`gave up after ${wait} s: still held by ${describe(r)}`);
        return resolve(1);
      }
      setTimeout(tick, Math.min(POLL_MS, left));
    };
    setTimeout(tick, Math.min(POLL_MS, deadline - Date.now()));
  });
}

Promise.resolve(main()).then((code) => { process.exitCode = code; }, (e) => { console.error(`merge-lane: ${e.message}`); process.exitCode = 2; });
