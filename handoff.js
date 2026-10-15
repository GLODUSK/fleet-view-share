// Fleet View: session handoffs. Long Claude Code sessions checkpoint themselves at ~200k context tokens: a
// Stop hook has Claude write a handoff summary, and the launcher that started claude restarts a FRESH
// conversation that picks it up (`claude [--effort <level>] "/pickup <file>"`). The hooks and launchers live outside this repo;
// this file only reads what they leave in %USERPROFILE%\.claude-handoffs (FV_HANDOFF_DIR overrides it, for tests):
//   config.json                  { limitTokens }   (missing: 200000)
//   <YYYY-MM-DD_HHmmss>_<id8>.md   a handoff: frontmatter between --- lines (session, account, cwd, created,
//                                title, effort, and next_session once a new conversation picked it up), then markdown
//   .state/<sessionId>.json      { contextTokens, limit, due, handoff, handedOffAt, next }   (may be missing)
//   .restart/<launchKey>.json    { file, cwd, session }: written by Claude in a session whose launcher set
//                                CLAUDE_LAUNCH_KEY=<launchKey>; claude is killed ~4 s later, and the launcher
//                                (claude-run.ps1, or Fleet View's session host) starts the pickup in its place
// Used by fleet-view.js (the cards' "handed off" / "picked up from" lines) and desktop/host.js (the restart).
// The handoff folder stays on its machine, so the link also comes from the new conversation's own log (pickupOf:
// the HANDOFF text `/pickup` leaves there), which syncs: the chain holds on the other machine too.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const P = require(path.join(__dirname, 'platform.js'));

const ID_RE = /^[0-9a-f-]{36}$/i;
const KEY_RE = /^[\w.-]{1,80}$/;
const DEFAULT_LIMIT = 200000;

const dir = () => process.env.FV_HANDOFF_DIR || path.join(process.env.USERPROFILE || os.homedir(), '.claude-handoffs');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const lowId = (v) => (typeof v === 'string' && ID_RE.test(v.trim()) ? v.trim().toLowerCase() : null);

// the context size a session hands off at
function limit() {
  const n = Number((readJson(path.join(dir(), 'config.json')) || {}).limitTokens);
  return Number.isFinite(n) && n >= 10000 ? Math.round(n) : DEFAULT_LIMIT;
}

// the frontmatter of a handoff file: { key: value } from the lines between the first two --- lines
function parseFront(text) {
  const out = {};
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/);
  if ((lines[0] || '').trim() !== '---') return out;
  for (let i = 1; i < lines.length && i < 60; i++) {
    if (lines[i].trim() === '---') return out;
    const m = /^\s*([A-Za-z_][\w-]*)\s*:\s*(.*?)\s*$/.exec(lines[i]);
    if (m) out[m[1].toLowerCase()] = m[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  return out;
}

// every handoff, linked both ways. Files are read once per mtime (only their first 4 KB: the frontmatter).
//   { bySession: Map(old id -> rec), byNext: Map(new id -> rec) }
//   rec = { file, session, next, account, cwd, title, created, handedOffAt }
const fileCache = new Map(); // path -> { m, front }
function readAll() {
  const d = dir();
  const bySession = new Map(), byNext = new Map();
  let names = [];
  try { names = fs.readdirSync(d); } catch { return { bySession, byNext }; }
  const seen = new Set();
  for (const n of names) {
    if (!/\.md$/i.test(n)) continue;
    const file = path.join(d, n);
    seen.add(file);
    let m = 0;
    try { m = fs.statSync(file).mtimeMs; } catch { continue; }
    let c = fileCache.get(file);
    if (!c || c.m !== m) {
      let text = '';
      try { const fd = fs.openSync(file, 'r'); try { const b = Buffer.alloc(4096); text = b.toString('utf8', 0, fs.readSync(fd, b, 0, 4096, 0)); } finally { fs.closeSync(fd); } } catch { continue; }
      c = { m, front: parseFront(text) };
      fileCache.set(file, c);
    }
    const f = c.front, session = lowId(f.session);
    if (!session) continue;
    const st = readJson(path.join(d, '.state', `${session}.json`)) || {};
    const rec = {
      file, session, next: lowId(f.next_session) || lowId(st.next), account: typeof f.account === 'string' && /^[a-z]$/i.test(f.account) ? f.account.toUpperCase() : null,
      cwd: f.cwd || null, title: f.title ? String(f.title).slice(0, 200) : null, created: Date.parse(f.created) || Math.round(m),
      handedOffAt: Date.parse(st.handedOffAt) || null,
    };
    // a session handed off more than once (it was resumed after a handoff): the newest one wins
    const old = bySession.get(session);
    if (!old || rec.created >= old.created) bySession.set(session, rec);
    if (rec.next) byNext.set(rec.next, rec);
  }
  for (const f of fileCache.keys()) if (!seen.has(f)) fileCache.delete(f);
  return { bySession, byNext };
}

// The handoff a conversation picked up, from its own log. `/pickup` runs `handoff.py pickup`, whose output lands in
// the new conversation's log as a user text item that starts
//   HANDOFF <path of the .md file>
//   from session <old id> (account A), folder <cwd>, <created ISO time>
// (after a "(Note: this handoff was already picked up by session …)" line when it is picked up again).
// The log syncs to the other machine and the handoff folder does not, so this links the chain there too.
// Returns { from (the old id, lower case), file (the path as written, / or \), created (ms or null) } or null.
const PICKUP_RE = /^\s*(?:\(Note:[^\r\n]*\)[ \t]*\r?\n\s*)?HANDOFF[ \t]+(\S[^\r\n]*?)[ \t]*\r?\n[ \t]*from session ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b([^\r\n]*)/i;
function pickupOf(text) {
  if (typeof text !== 'string' || text.length < 20) return null;
  const m = PICKUP_RE.exec(text.slice(0, 2000));
  if (!m) return null;
  const tail = m[3].split(',').pop().trim();
  return { from: m[2].toLowerCase(), file: m[1].replace(/^"(.*)"$/, '$1'), created: Date.parse(tail) || null };
}

// pickupOf over a log record's message content (a string, or blocks whose text blocks are read)
function pickupIn(content) {
  for (const x of typeof content === 'string' ? [content] : Array.isArray(content) ? content : []) {
    const p = pickupOf(typeof x === 'string' ? x : x && x.type === 'text' ? x.text : null);
    if (p) return p;
  }
  return null;
}

// The successor of each conversation by those log lines: Map(old id -> { id, at }) from conversations
// { id, pickupFrom, pickupAt } (at: when it picked up). A conversation never succeeds itself; picked up twice, the
// later pickup wins.
function successorsFromLogs(list) {
  const out = new Map();
  for (const x of list) {
    if (!x || !x.pickupFrom || !x.id) continue;
    const id = String(x.id).toLowerCase();
    if (x.pickupFrom === id) continue;
    const old = out.get(x.pickupFrom);
    if (!old || (x.pickupAt || 0) >= (old.at || 0)) out.set(x.pickupFrom, { id, at: x.pickupAt || null });
  }
  return out;
}

// The chain links of one conversation s ({ id, pickupArg, pickupFrom }): from the handoff files (links: readAll())
// first, then the logs (succ: successorsFromLogs(all)); all: every conversation listed ({ id, pickupArg }).
//   { h: s's own handoff rec or null, next: its successor's id or null, at: when it handed off (ms) or null,
//     from: { id, rec } (rec: the file's, null when only s's log names it) or null }
// The successor by file: next_session (or the state file), else the conversation that ran `/pickup <that file>`.
// Nothing links a conversation to itself.
const baseOf = (f) => String(f || '').split(/[\\/]/).pop().toLowerCase();
function linksOf(s, links, succ, all) {
  const id = String(s.id).toLowerCase();
  const h = links.bySession.get(id) || null;
  let from = links.byNext.get(id) || null;
  if (!from && s.pickupArg) {
    const want = baseOf(s.pickupArg);
    for (const r of links.bySession.values()) if (baseOf(r.file) === want) { from = r; break; }
  }
  let next = h ? h.next : null, at = h ? h.handedOffAt || h.created || null : null;
  if (h && !next) for (const x of all) if (x.pickupArg && baseOf(x.pickupArg) === baseOf(h.file)) { next = String(x.id).toLowerCase(); break; }
  if (next === id) next = null;
  if (!next) {
    const by = succ.get(id);
    if (by && by.id !== id) { next = by.id; at = at || by.at || null; }
  }
  let f = null;
  if (from) { if (from.session !== id) f = { id: from.session, rec: from }; }
  else if (s.pickupFrom && s.pickupFrom !== id) f = { id: s.pickupFrom, rec: null };
  return { h, next, at, from: f };
}

// where this machine keeps a handoff file a log names (the same name in the handoff folder), or null when it has none
function localFile(file) {
  const base = String(file || '').split(/[\\/]/).pop();
  if (!base || !/\.md$/i.test(base)) return null;
  const f = path.join(dir(), base);
  try { return fs.statSync(f).isFile() ? f : null; } catch { return null; }
}

// ---------- the summary itself (GET /handoff-summary) ----------
// A handoff file's summary: its markdown without the front matter, or null. Only a .md file right in the handoff
// folder is read (at most SUMMARY_MAX bytes).
const SUMMARY_MAX = 1 << 20;
const FRONT_RE = /^﻿?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;
function summaryFromFile(file) {
  const f = path.resolve(String(file || ''));
  if (!/\.md$/i.test(f) || path.dirname(f).toLowerCase() !== path.resolve(dir()).toLowerCase()) return null;
  try {
    const fd = fs.openSync(f, 'r');
    try {
      const b = Buffer.alloc(Math.min(fs.fstatSync(fd).size, SUMMARY_MAX));
      const text = b.toString('utf8', 0, fs.readSync(fd, b, 0, b.length, 0)).replace(/\r\n?/g, '\n').replace(FRONT_RE, '').trim();
      return text || null;
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

// The summary in a pickup's HANDOFF text (pickupOf's): the text less its two header lines, and less what `/pickup`
// itself adds after the handoff's own markdown (handoff.py's "CHECK BEFORE STOPPING: …", the command's "The handoff
// above is from the previous session …"). Null when nothing is left.
const PICKUP_HEAD_RE = /^\s*(?:\(Note:[^\n]*\)[ \t]*\n\s*)?HANDOFF[^\n]*\n[ \t]*from session [^\n]*(?:\n|$)/;
const PICKUP_TAIL_RE = /\n[ \t]*\n(?:CHECK BEFORE STOPPING:|The handoff above is from the previous session)[\s\S]*$/;
function summaryBody(text) {
  const s = String(text || '').replace(/\r\n?/g, '\n').replace(PICKUP_HEAD_RE, '').replace(PICKUP_TAIL_RE, '').trim();
  return s || null;
}

// The handoff summary a conversation's own log holds (its `/pickup`'s HANDOFF text), for the machine without the
// handoff file: { text, from, file, created, at (its record's time) } or null. Only the head of the log is read: lines
// that start in its first LOG_HEAD bytes, at most LOG_LINES of them, and a line no longer than LOG_LINE_MAX (the
// pickup's comes among a conversation's first records; the rest of a long log is never read). Remembered per file: a
// find while the log has not shrunk (logs only grow), a miss while its size and mtime stay the same.
const LOG_HEAD = 64 << 10, LOG_LINES = 40, LOG_LINE_MAX = 1 << 20;
const logSummaries = new Map(); // file -> { size, mtime, out }
function summaryFromLog(file, o = {}) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  if (!st.isFile()) return null;
  const c = logSummaries.get(file);
  if (c && (c.out ? st.size >= c.size : st.size === c.size && st.mtimeMs === c.mtime)) return c.out;
  const out = scanLog(file, o.head || LOG_HEAD, o.lines || LOG_LINES, o.lineMax || LOG_LINE_MAX);
  if (logSummaries.size > 200) logSummaries.clear();
  logSummaries.set(file, { size: st.size, mtime: st.mtimeMs, out });
  return out;
}
// one log line: the summary when it is a user record whose text pickupOf knows
function summaryInLine(buf) {
  if (!buf.includes('HANDOFF') || !buf.includes('"user"')) return null; // most lines: not even parsed
  let d;
  try { d = JSON.parse(buf.toString('utf8')); } catch { return null; }
  if (!d || d.type !== 'user' || d.isSidechain) return null;
  const content = d.message && d.message.content;
  for (const x of typeof content === 'string' ? [content] : Array.isArray(content) ? content : []) {
    const t = typeof x === 'string' ? x : x && x.type === 'text' ? x.text : null;
    const p = pickupOf(t);
    if (!p) continue;
    const text = summaryBody(t);
    if (text) return { text, from: p.from, file: p.file, created: p.created, at: Date.parse(d.timestamp) || null };
  }
  return null;
}
function scanLog(file, head, maxLines, lineMax) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return null; }
  try {
    const buf = Buffer.alloc(64 << 10);
    let pos = 0, lineStart = 0, lines = 0, parts = [];
    for (;;) {
      const got = fs.readSync(fd, buf, 0, buf.length, pos);
      if (!got) return parts.length ? summaryInLine(Buffer.concat(parts)) : null; // the last line, with no newline yet
      let i = 0;
      while (i < got) {
        const nl = buf.indexOf(10, i);
        if (nl === -1 || nl >= got) { parts.push(Buffer.from(buf.subarray(i, got))); break; }
        parts.push(buf.subarray(i, nl));
        const r = summaryInLine(Buffer.concat(parts));
        parts = [];
        if (r) return r;
        lines++; lineStart = pos + nl + 1; i = nl + 1;
        if (lines >= maxLines || lineStart >= head) return null;
      }
      pos += got;
      if (pos - lineStart > lineMax) return null; // a line too long to be the pickup's
    }
  } catch { return null; } finally { fs.closeSync(fd); }
}

// a fresh launch key for one claude process (the host sets it as CLAUDE_LAUNCH_KEY)
const newLaunchKey = () => `fv-${crypto.randomUUID()}`;

// A handoff file path that is safe to put on a cmd command line inside double quotes: a .md file directly in
// the handoffs folder, no quotes or cmd metacharacters (letters of any language are fine, as in a home folder
// named after its owner), and it exists. Returns the path or null.
function safeFile(file) {
  if (typeof file !== 'string' || !file || file.length > 400) return null;
  if (!/^[\p{L}\p{N}_ .:\\/()+,=@~-]+\.md$/iu.test(file)) return null;
  let abs;
  try { abs = path.resolve(file); } catch { return null; }
  if (P.foldCase(path.dirname(abs)) !== P.foldCase(path.resolve(dir()))) return null;
  try { if (!fs.statSync(abs).isFile()) return null; } catch { return null; }
  return abs;
}

// The restart request a session left for its launcher, if any, from .restart/<key>.json: { file, cwd, session } (file
// checked by safeFile, cwd a string or null) or null. takeRestart deletes it; peekRestart leaves it (the host's restore
// list, saved while the session is still to be killed). restartKeys: the keys that have one now (one readdir)
const restartFile = (key) => (typeof key === 'string' && KEY_RE.test(key) ? path.join(dir(), '.restart', `${key}.json`) : null);
function restartOf(j) {
  if (!j || typeof j !== 'object') return null;
  const file = safeFile(j.file);
  if (!file) return null;
  return { file, cwd: typeof j.cwd === 'string' && j.cwd ? j.cwd : null, session: lowId(j.session) };
}
function takeRestart(key) {
  const f = restartFile(key);
  if (!f || !fs.existsSync(f)) return null;
  const j = readJson(f);
  try { fs.unlinkSync(f); } catch {}
  return restartOf(j);
}
function peekRestart(key) {
  const f = restartFile(key);
  return f && fs.existsSync(f) ? restartOf(readJson(f)) : null;
}
function restartKeys() {
  try { return new Set(fs.readdirSync(path.join(dir(), '.restart')).filter((n) => /\.json$/i.test(n)).map((n) => n.slice(0, -5))); } catch { return new Set(); }
}

// the interactive pickup command for a checked handoff file. It starts at the effort the old session had (the
// handoff's `effort:`); none recorded, the settings default
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
function pickupCommand(file) {
  let effort = '';
  try { effort = String(parseFront(fs.readFileSync(file, 'utf8').slice(0, 4096)).effort || '').toLowerCase(); } catch {}
  return `claude ${EFFORTS.has(effort) ? `--effort ${effort} ` : ''}"/pickup ${file}"`;
}

module.exports = { dir, limit, parseFront, readAll, pickupOf, pickupIn, successorsFromLogs, linksOf, localFile, summaryFromFile, summaryBody, summaryFromLog, newLaunchKey, safeFile, takeRestart, peekRestart, restartKeys, pickupCommand, DEFAULT_LIMIT };
