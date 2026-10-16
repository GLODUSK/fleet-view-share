// Fleet View: the log of conversations leaving the map (Henry, 2026-10-16: one aged out overnight while the PC was off
// and nothing said where it went). Every departure is one JSON line in <data>/left-map.log:
//   { t, id, name, repo, cwd, account, state, rule, why, by?, lastActive, endedAt, wrong? }
// rule is a stable slug (RULES below), why its words; by is the rule that was checking when the transcript turned out to
// be gone (rule file-gone). wrong: why the departure breaks the map's own rules (looksWrong), worked out again from the
// raw times so a bug in the rule code shows up here instead of hiding behind it. At LOG_MAX it moves to left-map.log.1
// (replacing the older one), as server.log does.
// The conversations on the map are kept in <data>/on-map.json ({ t, sessions: [{ id, name, repo, cwd, account, file,
// state, lastActive, endedAt }] }), so the next start can tell which ones left while Fleet View was off.
// The menus' "Left the map" list (web/app.js) is the newest record of each conversation (noteLeft, latest), less the
// ones whose newest is not an age rule (leftList). "Show again" times go in <data>/shown-again.json ({ t, ids: { <id>:
// when } }), so one shown again stays for its 3 hours across a restart.
//
//   looksWrong({ now, rule, state, lastActive, endedAt, fileExists, windowMs, keepDoneMs }) -> null | reason
//   noteLeft(byId, record, cap) -> byId: the newest record per id, newest last, at most cap ids
//   leftList(byId, { skip(record), max }) -> records, newest first: the age-rule ones skip() keeps
//   createLeftMap({ dir, now }) -> { left(facts, rule, extra) -> record, recent(n), latest(cap) -> byId, readOnMap(),
//     writeOnMap(list), readShown(maxAgeMs) -> Map id -> when, writeShown(map) }
'use strict';
const fs = require('fs');
const path = require('path');

const LOG_MAX = 2 << 20, TAIL = 64 << 10, TAIL_MAX = 1 << 20;
const RULES = {
  'finished-3h': 'finished over 3 h ago',
  'quiet-window': 'quiet past the activity window',
  'late-unfinished': 'an old log not ending on a finished turn',
  'other-device': 'another device runs it and no longer lists it',
  'set-aside': 'set aside by Start clean',
  'hidden': 'hidden or removed on the page',
  'hidden-api': 'hidden through the automation API',
  'aged-out-while-off': 'aged out while Fleet View was off',
  'file-gone': 'its transcript file is gone',
};
// the rules that go by time, which looksWrong checks against the times themselves
const AGE = new Set(['finished-3h', 'quiet-window', 'late-unfinished', 'aged-out-while-off']);
const ago = (ms) => (ms < 90e3 ? `${Math.max(0, Math.round(ms / 1000))} s` : ms < 90 * 60e3 ? `${Math.round(ms / 60e3)} min` : `${Math.round(ms / 3600e3 * 10) / 10} h`);
const num = (v) => (Number.isFinite(v) && v > 0 ? Math.round(v) : null);
const str = (v, n) => (typeof v === 'string' && v ? v.slice(0, n) : null);

// null, or why this departure breaks the rules. Hides, Start clean and another device's list are Henry's or that
// device's call, never wrong, but a transcript that is gone always is (a deleted conversation). By the times: a finished
// conversation stays KEEP_DONE_MS after it ended, any other WINDOW_MS after it was last active
function looksWrong({ now, rule, state, lastActive, endedAt, fileExists, windowMs, keepDoneMs }) {
  if (fileExists === false) return 'its transcript file is gone';
  if (!AGE.has(rule)) return null;
  const done = state === 'DONE';
  if (rule === 'finished-3h' && !done) return `left by finished-3h but it was ${state ? state : 'not read yet'}, not finished`;
  if (done) {
    const end = num(endedAt) || num(lastActive);
    if (end && now - end < keepDoneMs) return `left by ${rule} but it ended ${ago(now - end)} ago`;
    return null;
  }
  const last = num(lastActive);
  if (last && now - last < windowMs) return `left by ${rule} but it was active ${ago(now - last)} ago`;
  return null;
}

// the newest record per conversation, newest last (a Map keeps the order things were put in): one seen again moves to
// the end, and past cap the oldest goes
const KEEP_IDS = 200;
function noteLeft(byId, rec, cap = KEEP_IDS) {
  if (!rec || typeof rec.id !== 'string' || !rec.id) return byId;
  byId.delete(rec.id);
  byId.set(rec.id, rec);
  while (byId.size > cap) byId.delete(byId.keys().next().value);
  return byId;
}
// the "Left the map" list: newest first, at most max, each one's newest record when that is an age rule (one hidden,
// set aside or gone since is not there for these rules) and skip() does not leave it out
function leftList(byId, { skip = () => false, max = 50 } = {}) {
  const out = [], recs = [...byId.values()];
  for (let i = recs.length - 1; i >= 0 && out.length < max; i--) {
    const r = recs[i];
    if (r && AGE.has(r.rule) && !skip(r)) out.push(r);
  }
  return out;
}

function createLeftMap({ dir, now = Date.now }) {
  const LOG = path.join(dir, 'left-map.log'), ON = path.join(dir, 'on-map.json'), SHOWN = path.join(dir, 'shown-again.json');
  // one line for a departure -> the record written (or null when it could not be)
  function left(f, rule, extra = {}) {
    if (!f || typeof f.id !== 'string' || !RULES[rule]) return null;
    const rec = { t: now(), id: f.id, name: str(f.name, 120), repo: str(f.repo, 1024), cwd: str(f.cwd, 1024), account: str(f.account, 80), state: str(f.state, 20),
      rule, why: str(extra.why, 200) || RULES[rule], ...(extra.by ? { by: extra.by } : {}), lastActive: num(f.lastActive), endedAt: num(f.endedAt), ...(extra.wrong ? { wrong: str(extra.wrong, 300) } : {}) };
    try {
      fs.mkdirSync(dir, { recursive: true });
      try { if (fs.statSync(LOG).size >= LOG_MAX) fs.renameSync(LOG, LOG + '.1'); } catch {}
      fs.appendFileSync(LOG, JSON.stringify(rec) + '\n');
    } catch { return null; }
    return rec;
  }
  // the last bytes of a file, whole lines only, newest last: never the whole of a big one
  const tailLines = (file, bytes) => {
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const size = fs.fstatSync(fd).size, len = Math.min(size, bytes), buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      const ls = buf.toString('utf8').split('\n');
      if (len < size) ls.shift(); // cut mid-line
      return { lines: ls.filter(Boolean), all: len >= size };
    } catch { return { lines: [], all: true }; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
  };
  const parse = (ls) => { const out = []; for (const l of ls) { try { out.push(JSON.parse(l)); } catch {} } return out; };
  // the newest n records, newest last, from left-map.log and, when it has too few, left-map.log.1
  function recent(n = 50) {
    let out = [];
    for (const file of [LOG, LOG + '.1']) {
      let bytes = TAIL, got;
      for (;;) {
        got = tailLines(file, bytes);
        if (got.all || got.lines.length >= n - out.length || bytes >= TAIL_MAX) break;
        bytes *= 4;
      }
      out = parse(got.lines).concat(out);
      if (out.length >= n) break;
    }
    return out.slice(-n);
  }
  // the newest record of up to cap conversations: more of the log's tail until it has them or the log runs out
  function latest(cap = KEEP_IDS) {
    const byId = new Map();
    for (let n = 500; ; n *= 4) {
      const recs = recent(n);
      byId.clear();
      for (const r of recs) noteLeft(byId, r, Infinity);
      if (byId.size >= cap || recs.length < n || n >= 32000) break;
    }
    while (byId.size > cap) byId.delete(byId.keys().next().value);
    return byId;
  }
  function readOnMap() {
    try { const j = JSON.parse(fs.readFileSync(ON, 'utf8')); return Array.isArray(j && j.sessions) ? j.sessions.filter((x) => x && typeof x.id === 'string') : []; } catch { return []; }
  }
  // through a tmp file and a rename, so a crash mid-write leaves the last list
  function writeOnMap(list) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(ON + '.tmp', JSON.stringify({ t: now(), sessions: list }));
      fs.renameSync(ON + '.tmp', ON);
      return true;
    } catch { return false; }
  }
  // the "Show again" times younger than maxAge (older ones count for nothing), id -> when
  function readShown(maxAge) {
    const out = new Map(), t = now();
    try {
      const j = JSON.parse(fs.readFileSync(SHOWN, 'utf8'));
      for (const [id, at] of Object.entries((j && j.ids) || {})) if (typeof id === 'string' && Number.isFinite(at) && at > 0 && t - at < maxAge) out.set(id, at);
    } catch {}
    return out;
  }
  function writeShown(map) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(SHOWN + '.tmp', JSON.stringify({ t: now(), ids: Object.fromEntries(map) }));
      fs.renameSync(SHOWN + '.tmp', SHOWN);
      return true;
    } catch { return false; }
  }
  return { left, recent, latest, readOnMap, writeOnMap, readShown, writeShown, LOG, ON, SHOWN };
}

module.exports = { createLeftMap, looksWrong, noteLeft, leftList, RULES, AGE, LOG_MAX, KEEP_IDS };
