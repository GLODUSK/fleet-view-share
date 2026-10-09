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
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

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
      file, session, next: lowId(f.next_session) || lowId(st.next), account: f.account === 'A' ? 'A' : f.account === 'B' ? 'B' : null,
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

// a fresh launch key for one claude process (the host sets it as CLAUDE_LAUNCH_KEY)
const newLaunchKey = () => `fv-${crypto.randomUUID()}`;

// A handoff file path that is safe to put on a cmd command line inside double quotes: a .md file directly in
// the handoffs folder, no quotes or cmd metacharacters, and it exists. Returns the path or null.
function safeFile(file) {
  if (typeof file !== 'string' || !file || file.length > 400) return null;
  if (!/^[\w .:\\/()+,=@~-]+\.md$/i.test(file)) return null;
  let abs;
  try { abs = path.resolve(file); } catch { return null; }
  if (path.dirname(abs).toLowerCase() !== path.resolve(dir()).toLowerCase()) return null;
  try { if (!fs.statSync(abs).isFile()) return null; } catch { return null; }
  return abs;
}

// The restart request a session left for its launcher, if any: reads and deletes .restart/<key>.json.
// Returns { file, cwd, session } (file checked by safeFile, cwd a string or null) or null.
function takeRestart(key) {
  if (typeof key !== 'string' || !KEY_RE.test(key)) return null;
  const f = path.join(dir(), '.restart', `${key}.json`);
  if (!fs.existsSync(f)) return null;
  const j = readJson(f);
  try { fs.unlinkSync(f); } catch {}
  if (!j || typeof j !== 'object') return null;
  const file = safeFile(j.file);
  if (!file) return null;
  return { file, cwd: typeof j.cwd === 'string' && j.cwd ? j.cwd : null, session: lowId(j.session) };
}

// the interactive pickup command for a checked handoff file. It starts at the effort the old session had (the
// handoff's `effort:`); none recorded, the settings default
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
function pickupCommand(file) {
  let effort = '';
  try { effort = String(parseFront(fs.readFileSync(file, 'utf8').slice(0, 4096)).effort || '').toLowerCase(); } catch {}
  return `claude ${EFFORTS.has(effort) ? `--effort ${effort} ` : ''}"/pickup ${file}"`;
}

module.exports = { dir, limit, parseFront, readAll, newLaunchKey, safeFile, takeRestart, pickupCommand, DEFAULT_LIMIT };
