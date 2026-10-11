// chief.js: the server side of the Chief (README "The Chief"), Henry's chief of staff for the fleet: the one hosted
// session whose role is 'chief' (desktop/host.js). fleet-view.js requires it and hands it what it needs
// (createChief below); api.js uses frame() on every text it types into a chief.
//
// - Start and adopt: POST /api/chief/start starts the Chief through api.js's startChief (the same checks as POST
//   /api/sessions with role "chief"), one start at a time, or answers with the one running already.
// - Follow it: a handoff (the pickup is a new conversation) or a /clear gives the Chief a new id. tick() watches the
//   host's sessions.json (rewritten on every change, it records role) and asks the host's list only while a chief is
//   in it, so settings.chief.id (in /state) stays on the live Chief, else on the last one while its log exists.
// - Tell it its id: the Chief can't find its own id, so each new conversation that takes the role is told once
//   ("[Fleet View] You are the Chief. Your id: …"), once its first message went in. The ids told are kept in memory
//   and in ~/.fleet-view.json (chief.told), never told twice.
// - GET /chief/briefing: who needs Henry, who works on what, what finished, the production deploys, and the same as
//   a few plain lines. Built from what the server has already (no model call, no fv ask, no GitHub call).
// - Watch mode (settings.chief.watch, off by default): at most every 15 minutes, and only when something new is
//   there for the Chief to act on (a stalled session, one blocked on another, an order of the Chief's with no
//   progress), one batched note starting "[Fleet View · watch]". Never while the Chief is busy or shows a menu.
// - Who is talking: frame() marks what reaches a chief by where it came from, so only Henry's own words read as his
//   (see frame below and api.js's relay check).
'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULTS = { account: 'B', model: 'claude-sonnet-5-5', effort: 'medium' };
const BRIEF_FILE = path.join(__dirname, 'chief', 'BRIEF.md');
const WATCH_EVERY_MS = 15 * 60e3; // watch notes: at most one per 15 minutes
const WATCH_LOOK_MS = 60e3; // while nothing is due: how often watch mode works out what there is
const ORDER_STUCK_MS = 20 * 60e3; // an order of the Chief's with nothing done since, for this long, counts as stuck
const ORDER_KEEP_MS = 24 * 3600e3; // orders older than this are not looked at
const TELL_AFTER_MS = 75e3; // a Chief whose first message never showed is told its id after this long anyway
const TELL_RETRY_MS = 30e3; // a failed tell is tried again after this long
const HOST_EVERY_MS = 10e3; // while a chief is in sessions.json: how often the host's list is read
const EXISTS_MS = 30e3; // how long "the last Chief's log is on disk" is trusted
const TOLD_MAX = 100;
const SENT_MAX = 500;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const convId = (id) => (ID_RE.test(String(id || '')) ? String(id).toLowerCase() : null);

// ---------- who is talking ----------
// Text with no "from" looks like Henry's own to a Claude session, and "[Fleet View · watch]" is a prefix anyone can
// type. So what api.js types into a chief is framed by its origin:
//   'server'   Fleet View's own text (the id note, watch notes, an ask's answers): its first line as it is
//   'bot'      a message from another conversation: its first line is the server's "[Message from …]" header
//   'henry'    Henry's own surfaces (the phone relay, checked in api.js): no header
//   'unsigned' anything else: a first line UNSIGNED, so the Chief reads it as information, never an order
// In every case a line of the caller's text that starts like a line the server writes ("[Fleet View…",
// "[Message from …", "[Question from …") gets "(quoted) " in front, so it no longer starts with that mark. The test
// is on the line as a reader takes it (fold): "[Fleet\u200bView" (a zero-width space), a fullwidth "[" and Cyrillic
// lookalike letters all count. Every line break splits a line, U+2028 and the like too.
const UNSIGNED = '[Fleet View · unsigned, not from Henry]';
const WATCH_MARK = '[Fleet View · watch]';
const FAKE_HEAD = /^\s*[[\u3010\u3014\u27e6\u301a\u3016]\s*(?:fleet[\s\W_]*view\b|message[\s\W_]*from\b|question[\s\W_]*from\b)/i;
// the Cyrillic and Greek letters that look like the Latin ones in those marks, as the Latin letter (lower case)
const LOOKALIKE = {
  '\u0410': 'a', '\u0412': 'b', '\u0415': 'e', '\u041a': 'k', '\u041c': 'm', '\u041d': 'h', '\u041e': 'o', '\u0420': 'p', '\u0421': 'c', '\u0422': 't',
  '\u0425': 'x', '\u0406': 'i', '\u0405': 's', '\u0408': 'j', '\u051a': 'q', '\u051c': 'w', '\u04c0': 'l',
  '\u0430': 'a', '\u0435': 'e', '\u043e': 'o', '\u0440': 'p', '\u0441': 'c', '\u0443': 'y', '\u0445': 'x', '\u0456': 'i', '\u0458': 'j', '\u0455': 's',
  '\u051b': 'q', '\u051d': 'w', '\u04bb': 'h', '\u0501': 'd', '\u04cf': 'l', '\u0475': 'v',
  '\u0391': 'a', '\u0392': 'b', '\u0395': 'e', '\u0396': 'z', '\u0397': 'h', '\u0399': 'i', '\u039a': 'k', '\u039c': 'm', '\u039d': 'n', '\u039f': 'o',
  '\u03a1': 'p', '\u03a4': 't', '\u03a5': 'y', '\u03a7': 'x',
  '\u03b1': 'a', '\u03b5': 'e', '\u03b9': 'i', '\u03ba': 'k', '\u03bd': 'v', '\u03bf': 'o', '\u03c1': 'p', '\u03c4': 't', '\u03c5': 'u', '\u03c7': 'x',
  '\u03c9': 'w', '\u0261': 'g', '\u0131': 'i', '\u0269': 'i',
};
// a line as a reader takes it: compatibility forms folded (a fullwidth bracket is [, the fl ligature fl), invisible
// format characters and combining marks dropped, lookalike letters made Latin
const fold = (line) => String(line).normalize('NFKD').replace(/[\p{Cf}\p{Mn}\p{Me}]/gu, '').replace(/[^\x00-\x7f]/g, (c) => LOOKALIKE[c] || c);
const neutralise = (line) => (FAKE_HEAD.test(fold(line)) ? `(quoted) ${line}` : line);
const LINE_BREAK = /\r\n|[\n\r\v\f\u0085\u2028\u2029]/;
function frame(text, origin) {
  const lines = String(text == null ? '' : text).split(LINE_BREAK);
  if (origin === 'server' || origin === 'bot') return [lines[0], ...lines.slice(1).map(neutralise)].join('\n');
  if (origin === 'henry') return lines.map(neutralise).join('\n');
  return [UNSIGNED, ...lines.map(neutralise)].join('\n');
}

// ---------- small helpers ----------
function ago(ms) {
  const m = Math.max(0, Math.round(ms / 60e3));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} d`;
}
const oneLine = (s, n) => {
  const t = String(s == null ? '' : s).replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
};
const NEEDS = new Set(['ASKING', 'QUESTION', 'ERROR', 'STALLED']);
const WORKS = new Set(['WORKING', 'AGENTS']);

// ---------- GET /chief/briefing ----------
// f: { now, chiefIds: [ids] (left out of every list), sessions: [{ id, name, repo (its name), state, label, doing,
// waitingOn, since (when it started waiting, for one that needs Henry), turnStart, active, removed }],
// finished: [{ id, name, repo, summary, at }], deploys: [{ repo, state, title, at }] }
// -> { at, needsYou, working, finished, deploys, text }, each list newest first and capped.
function whatOf(s) {
  const w = oneLine(s.waitingOn, 120);
  if (s.state === 'ASKING') return w ? `asks: ${w}` : 'waits on a permission or a menu';
  if (s.state === 'QUESTION') return w ? `asked: ${w}` : 'asked you a question';
  if (s.state === 'ERROR') return w ? `error: ${w}` : 'hit an error';
  if (s.state === 'STALLED') return w ? `stalled: ${w}` : 'stalled';
  return oneLine(s.label, 60) || String(s.state || '').toLowerCase();
}
function buildBriefing(f) {
  const now = Number.isFinite(f.now) ? f.now : Date.now();
  const chief = new Set(f.chiefIds || []);
  const keep = (x) => x && typeof x.id === 'string' && !chief.has(x.id) && !x.removed;
  const sessions = (f.sessions || []).filter(keep);
  const num = (v) => (Number.isFinite(v) ? Math.round(v) : 0);
  const needsAll = sessions.filter((s) => NEEDS.has(s.state)), workAll = sessions.filter((s) => WORKS.has(s.state));
  const needsYou = needsAll
    .map((s) => ({ id: s.id, name: oneLine(s.name, 80), repo: s.repo || null, what: whatOf(s), since: num(s.since || s.active) }))
    .sort((a, b) => b.since - a.since).slice(0, 10);
  const working = workAll
    .map((s) => ({ id: s.id, name: oneLine(s.name, 80), repo: s.repo || null, doing: oneLine(s.doing || s.label, 160) || 'working', since: num(s.turnStart || s.active) }))
    .sort((a, b) => b.since - a.since).slice(0, 12);
  const finished = (f.finished || []).filter(keep)
    .map((x) => ({ id: x.id, name: oneLine(x.name, 80), repo: x.repo || null, summary: oneLine(x.summary, 160) || null, at: num(x.at) }))
    .sort((a, b) => b.at - a.at).slice(0, 10);
  const deploys = (f.deploys || []).filter((d) => d && ['building', 'live', 'failed'].includes(d.state))
    .map((d) => ({ repo: d.repo || null, state: d.state, title: oneLine(d.title, 120) || null, at: num(d.at) }))
    .sort((a, b) => b.at - a.at).slice(0, 6);
  const b = { at: now, needsYou, working, finished, deploys };
  b.text = briefingText(b, { needsYou: needsAll.length, working: workAll.length });
  return b;
}
// the same as 3 to 12 short plain lines, what needs Henry first; counts: the totals before the lists were capped
function briefingText(b, counts = {}) {
  const now = b.at, lines = [];
  const who = (x) => `${x.name}${x.repo ? ` (${x.repo})` : ''}`;
  const n = Number.isInteger(counts.needsYou) ? counts.needsYou : b.needsYou.length;
  lines.push(n ? `${n} need${n === 1 ? 's' : ''} you:` : 'Nobody needs you.');
  for (const x of b.needsYou.slice(0, 4)) lines.push(`- ${who(x)}: ${oneLine(x.what, 90)}, ${ago(now - x.since)}`);
  if (n > 4) lines.push(`- and ${n - 4} more`);
  const w = Number.isInteger(counts.working) ? counts.working : b.working.length;
  lines.push(w ? `${w} working:` : 'Nobody is working right now.');
  for (const x of b.working.slice(0, 2)) lines.push(`- ${who(x)}: ${oneLine(x.doing, 90)}`);
  if (w > 2) lines.push(`- and ${w - 2} more`);
  lines.push(b.finished.length
    ? `Finished: ${b.finished.slice(0, 3).map((x) => x.name).join(', ')}${b.finished.length > 3 ? ` and ${b.finished.length - 3} more` : ''}.`
    : 'Nothing finished lately.');
  if (b.deploys.length) {
    lines.push(`Deploys: ${b.deploys.slice(0, 3).map((d) => `${d.repo || '?'} ${d.state}${d.state !== 'live' && d.title ? ` (${d.title})` : ''}`).join('; ')}.`);
  }
  return lines.slice(0, 12).join('\n');
}

// ---------- watch mode ----------
// What the Chief should act on now. f: { now, chiefIds, sessions: [{ id, name, state, since, waitingOn, lastReply,
// replyAt, actionAt, removed }], orders: [{ to, t }] (messages a Chief sent), conflicts: [{ id, kind, label,
// sessions: [ids] }] } -> [{ key, line }]. The key changes when the situation does (a new stall, a new order), so
// one item is reported once.
const BLOCKED_RE = /\b(?:blocked|waiting|wait)\b[^.\n]{0,60}?\b(?:on|for|by|until)\b/i;
function watchItems(f) {
  const now = Number.isFinite(f.now) ? f.now : Date.now();
  const chief = new Set(f.chiefIds || []);
  const list = (f.sessions || []).filter((s) => s && typeof s.id === 'string' && !chief.has(s.id) && !s.removed);
  const byId = new Map(list.map((s) => [s.id, s]));
  const out = [];
  for (const s of list) {
    if (s.state === 'STALLED') {
      out.push({ key: `stalled:${s.id}:${Math.round(s.since || 0)}`, line: `${oneLine(s.name, 60)} stalled${s.waitingOn ? ` (${oneLine(s.waitingOn, 80)})` : ''}, ${ago(now - (s.since || now))}` });
      continue;
    }
    // its turn ended saying it is blocked on, or waiting for, another session by name
    if ((s.state === 'IDLE' || s.state === 'DONE') && s.lastReply) {
      const r = String(s.lastReply).slice(0, 600);
      if (!BLOCKED_RE.test(r)) continue;
      const low = r.toLowerCase();
      const other = list.find((o) => o !== s && o.state !== 'DONE' && typeof o.name === 'string' && o.name.trim().length >= 4 && low.includes(o.name.trim().toLowerCase()));
      if (other) out.push({ key: `blocked:${s.id}:${Math.round(s.replyAt || 0)}`, line: `${oneLine(s.name, 60)} says it is blocked on ${oneLine(other.name, 60)}` });
    }
  }
  for (const c of f.conflicts || []) {
    const names = (c.sessions || []).map((id) => byId.get(id)).filter(Boolean).map((s) => oneLine(s.name, 40));
    if (names.length < 2) continue;
    const what = c.kind === 'branch' ? 'the same branch' : c.kind === 'worktree' ? 'the same worktree' : c.kind === 'migration' ? 'the same migration number' : 'the same thing';
    out.push({ key: `conflict:${c.id}`, line: `${names.join(' and ')} are on ${what}: ${oneLine(c.label, 80)}` });
  }
  // the newest order to each session; stuck when nothing moved since for ORDER_STUCK_MS
  const last = new Map();
  for (const o of f.orders || []) {
    if (!o || typeof o.to !== 'string' || !Number.isFinite(o.t) || now - o.t > ORDER_KEEP_MS) continue;
    if (!last.has(o.to) || last.get(o.to) < o.t) last.set(o.to, o.t);
  }
  for (const [to, t] of last) {
    if (now - t < ORDER_STUCK_MS) continue;
    const s = byId.get(to);
    if (!s) continue;
    const moved = (s.replyAt || 0) > t + 5e3 || (s.actionAt || 0) > t + 5e3 || WORKS.has(s.state);
    if (!moved) out.push({ key: `order:${to}:${Math.round(t)}`, line: `${oneLine(s.name, 60)} has done nothing on your order from ${ago(now - t)} ago` });
  }
  return out;
}
// One look: st { lastAt, sent: [keys] }, items from watchItems, o { on, busy }. -> { text, keys }: the note to send
// (null: nothing) and the keys it covers. Nothing when off, when nothing is new, within WATCH_EVERY_MS of the last
// note, or while the Chief is busy (the items stay new, so they go in the next note).
function watchStep(st, items, now, o) {
  const none = { text: null, keys: [] };
  if (!o || !o.on) return none;
  const sent = new Set((st && st.sent) || []);
  const fresh = (items || []).filter((x) => !sent.has(x.key));
  if (!fresh.length) return none;
  if (st && st.lastAt && now - st.lastAt < WATCH_EVERY_MS) return none;
  if (o.busy) return none;
  const shown = fresh.slice(0, 6);
  const text = [`${WATCH_MARK} ${fresh.length === 1 ? 'One thing' : `${fresh.length} things`} to look at:`,
    ...shown.map((x) => `- ${x.line}`),
    ...(fresh.length > shown.length ? [`- and ${fresh.length - shown.length} more (fv status)`] : []),
    'Act only as "Acting on your own" in chief/BRIEF.md allows, and tell Henry in one line what you did.'].join('\n');
  return { text, keys: fresh.map((x) => x.key) };
}
// after a note went in: its keys count as sent; keys of items that are gone are forgotten
function watchCommit(st, keys, now, items) {
  const live = new Set((items || []).map((x) => x.key));
  const sent = [...new Set([...((st && st.sent) || []).filter((k) => live.has(k)), ...keys])].slice(-SENT_MAX);
  return { lastAt: now, sent };
}

// ---------- telling the Chief its id ----------
const idNote = (id) => `[Fleet View] You are the Chief. Your id: ${id}. Read chief/BRIEF.md in the Fleet View folder.`;
// o: { id, told: Set, pending, starting, firstSeen, promptAt, now }. Once per id, never while a start is typing its
// prompt (the two pastes would mix), and only after its first message went in (else after TELL_AFTER_MS)
function shouldTell(o) {
  if (!o || !convId(o.id) || o.pending || o.starting) return false;
  if (o.told && o.told.has(convId(o.id))) return false;
  return (o.promptAt || 0) > 0 || (Number.isFinite(o.firstSeen) && o.now - o.firstSeen >= TELL_AFTER_MS);
}

// the live Chief in the host's list: alive, role 'chief'
const pickChief = (list) => (Array.isArray(list) ? list : []).find((p) => p && p.alive && p.role === 'chief') || null;

// ---------- the server's part ----------
// deps: { api (api.js: hostList, deliverText, startChief), ctx (api.js's ctx), saved (settings.chief as saved),
//   save() (settings changed), log(text), demo, exists(id) -> its log is on disk, facts(chiefIds) -> buildBriefing's
//   input, watchFacts(chiefIds) -> watchItems' input, turnInfo(id) -> { promptAt } or null, sessionsFile,
//   normDir(p) -> a folder as the host compares it, dir (where chief/BRIEF.md is) }
function createChief(deps) {
  const d = deps || {};
  const s0 = d.saved && typeof d.saved === 'object' ? d.saved : {};
  let watch = s0.watch === true;
  let lastId = convId(s0.lastId);
  let told = Array.isArray(s0.told) ? [...new Set(s0.told.map(convId).filter(Boolean))].slice(-TOLD_MAX) : [];
  let live = null; // { id, key, status, waitingFor, pending } of the live Chief, from the host's list
  let wst = { lastAt: 0, sent: [] }, lookedAt = 0;
  let starting = false, startChain = Promise.resolve();
  let ticking = false, telling = false, tellTry = 0;
  let tellQueued = null; // the id whose note waits in api.js's queue (behind a menu): told once it goes in
  let fileM = -1, fileChief = false, askedAt = 0, askedM = -1, hostDown = false;
  const firstSeen = new Map();
  let existsAt = 0, existsId = null, existsOk = false;
  const log = (t) => { try { if (d.log) d.log(`chief: ${t}`); } catch {} };
  const save = () => { try { if (d.save) d.save(); } catch {} };
  const toldSet = () => new Set(told);
  const chiefIds = () => [...new Set([...told, lastId, live && live.id].filter(Boolean))];

  function lastExists() {
    if (!lastId) return false;
    const now = Date.now();
    if (existsId !== lastId || now - existsAt > EXISTS_MS) {
      existsId = lastId; existsAt = now;
      try { existsOk = !!(d.exists && d.exists(lastId)); } catch { existsOk = false; }
    }
    return existsOk;
  }
  // /state settings.chief
  function view() {
    if (d.demo) return { id: null, watch };
    return { id: (live && live.id) || (lastExists() ? lastId : null), watch };
  }
  // ~/.fleet-view.json's chief
  const saveShape = () => ({ lastId, watch, told: told.slice(-TOLD_MAX) });
  // POST /settings { chief: { watch } }: off stops it at once (tick looks at it before every note)
  function setWatch(on) {
    if (typeof on !== 'boolean' || on === watch) return;
    watch = on;
    if (on) { wst = { lastAt: 0, sent: wst.sent }; lookedAt = 0; }
    log(`watch mode ${on ? 'on' : 'off'}`);
    save();
  }
  function noteId(id) {
    id = convId(id);
    if (!id) return;
    if (!firstSeen.has(id)) firstSeen.set(id, Date.now());
    if (firstSeen.size > 50) firstSeen.delete(firstSeen.keys().next().value);
    if (lastId !== id) { lastId = id; existsId = null; save(); }
  }

  // POST /api/chief/start { account?, model?, effort? }: one at a time; a second click waits for the first, then
  // finds its Chief running and adopts it
  function start(b) {
    const run = () => doStart(b && typeof b === 'object' ? b : {});
    const p = startChain.then(run, run);
    startChain = p.catch(() => {});
    return p;
  }
  function folderFor() {
    const norm = d.normDir || ((p) => path.resolve(p).toLowerCase());
    const allowed = (d.ctx && typeof d.ctx.allowedFolders === 'function' ? d.ctx.allowedFolders() : []).filter((p) => typeof p === 'string' && p);
    const home = d.dir || __dirname;
    if (allowed.some((p) => norm(p) === norm(home))) return { folder: home, own: true };
    const first = allowed.find((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
    return { folder: first || null, own: false };
  }
  const startPrompt = () => `[Fleet View] You are the Chief, Henry's chief of staff for the Fleet View fleet. Read ${path.join(d.dir || __dirname, 'chief', 'BRIEF.md')} now and follow it. Your conversation id comes in the next message.`;
  async function doStart(b) {
    if (d.demo) return [503, { ok: false, message: 'the demo starts no Chief' }];
    starting = true;
    try {
      const list = await d.api.hostList();
      if (list === null) return [503, { ok: false, message: 'the Fleet View desktop app is not running' }];
      const p = pickChief(list);
      if (p) {
        const id = convId(p.id);
        if (id) noteId(id);
        return [200, { ok: true, id, key: p.id, started: false, message: 'the Chief is running already' }];
      }
      const { folder, own } = folderFor();
      if (!folder) return [409, { ok: false, message: 'no folder to start the Chief in: Fleet View lists no repo' }];
      const body = { repo: folder, account: b.account != null ? b.account : DEFAULTS.account, model: b.model != null ? b.model : DEFAULTS.model,
        effort: b.effort != null ? b.effort : DEFAULTS.effort, prompt: startPrompt(), name: 'Chief' };
      const [code, out] = await d.api.startChief(body, d.ctx);
      // another start got in first (fv, another page): that one is the Chief
      if (code === 409 && convId(out && out.id)) { noteId(out.id); return [200, { ok: true, id: convId(out.id), key: out.id, started: false, message: out.message }]; }
      if (code !== 200) return [code, out];
      if (out.id) noteId(out.id);
      log(`started ${out.id || out.key} in ${folder}${own ? '' : ' (the Fleet View folder is not one Fleet View lists)'}`);
      return [200, { ok: true, id: convId(out.id), key: out.key, started: true, folder, ...(own ? {} : { note: `started in ${folder}: the Fleet View folder is not a repo Fleet View lists` }),
        ...(out.ok ? {} : { promptSent: false }), message: out.message }];
    } finally { starting = false; }
  }

  // GET /chief/briefing
  function briefing() {
    const ids = chiefIds();
    return buildBriefing({ ...(d.facts ? d.facts(ids) : {}), chiefIds: ids });
  }

  // every few seconds (fleet-view.js): follow the Chief, tell a new one its id, and watch
  function sessionsHaveChief() {
    try {
      const j = JSON.parse(fs.readFileSync(d.sessionsFile, 'utf8'));
      return !!(j && Array.isArray(j.sessions) && j.sessions.some((x) => x && x.role === 'chief'));
    } catch { return false; }
  }
  async function tick() {
    if (d.demo || ticking || !d.sessionsFile) return;
    ticking = true;
    try {
      const now = Date.now();
      let m = 0;
      try { m = fs.statSync(d.sessionsFile).mtimeMs; } catch {}
      if (m !== fileM) { fileM = m; fileChief = sessionsHaveChief(); }
      if (!fileChief) { live = null; return; }
      // the host's list is read when sessions.json changed, and every HOST_EVERY_MS while a Chief runs; a chief that
      // ended (still in the file for the restore) is not polled for, so the host can still exit when nothing uses it.
      // A list that did not come (the host restarting) is asked for again every HOST_EVERY_MS too.
      if (m === askedM && ((!live && !hostDown) || now - askedAt < HOST_EVERY_MS)) return;
      askedAt = now; askedM = m; hostDown = true;
      const list = await d.api.hostList();
      hostDown = list == null;
      const p = list ? pickChief(list) : null;
      live = p ? { id: convId(p.id), key: p.id, status: p.status || null, waitingFor: p.waitingFor || null, pending: !!p.pending } : null;
      const id = live && live.id;
      if (!id) return;
      noteId(id);
      const info = d.turnInfo ? d.turnInfo(id) : null;
      if (!telling && tellQueued !== id && now - tellTry >= TELL_RETRY_MS && shouldTell({ id, told: toldSet(), pending: live.pending, starting, firstSeen: firstSeen.get(id), promptAt: info && info.promptAt, now })) {
        await tellId(id);
      }
      if (watch && told.includes(id)) await watchTick(id, now);
    } catch (e) {
      log(`tick failed: ${(e && e.message) || e}`);
    } finally { ticking = false; }
  }
  // the note counts as told only once it went in: one queued behind a menu waits for onSent, and one the queue drops
  // (onDrop) is tried again. After a restart the queue's hooks are gone; the next try finds the same text queued
  // (api.js keeps one of each) and hooks onto it, so it still goes in once.
  function markTold(id) {
    if (tellQueued === id) tellQueued = null;
    if (told.includes(id)) return;
    told = [...told, id].slice(-TOLD_MAX);
    save();
  }
  async function tellId(id) {
    telling = true; tellTry = Date.now();
    try {
      const [, r] = await d.api.deliverText(id, idNote(id), { kind: 'message', queue: true, open: false, via: 'server',
        onSent: () => { if (!told.includes(id)) log(`told ${id} its id`); markTold(id); },
        onDrop: (why) => { if (tellQueued === id) tellQueued = null; log(`the id note for ${id} was dropped (${why}); it goes again`); } }, d.ctx);
      if (r && r.ok && !r.queued) markTold(id); // onSent ran already
      else if (r && r.ok) { if (!told.includes(id)) tellQueued = id; log(`the id note for ${id} waits behind a menu`); }
      else log(`could not tell ${id} its id: ${(r && r.message) || 'no answer'}`);
    } finally { telling = false; }
  }
  async function watchTick(id, now) {
    if (wst.lastAt && now - wst.lastAt < WATCH_EVERY_MS) return; // cheap: nothing is worked out before it is due
    const busy = !live || live.status === 'busy' || live.status === 'shell' || (live.status === 'waiting' && live.waitingFor !== 'dialog open');
    if (busy) return;
    // the facts cost a whole /state: once a minute at most while nothing is found
    if (now - lookedAt < WATCH_LOOK_MS) return;
    lookedAt = now;
    const ids = chiefIds();
    const items = watchItems({ ...(d.watchFacts ? d.watchFacts(ids) : {}), chiefIds: ids, now });
    const step = watchStep(wst, items, now, { on: watch, busy });
    if (!step.text || !watch) return;
    // queue false: a menu that came up turns it down, and the next look tries again (so off stops it at once)
    const [, r] = await d.api.deliverText(id, step.text, { kind: 'message', queue: false, open: false, via: 'server' }, d.ctx);
    if (r && r.ok) { wst = watchCommit(wst, step.keys, now, items); log(`watch note to ${id}: ${step.keys.length} item(s)`); }
  }

  return { view, saveShape, setWatch, start, briefing, tick, chiefIds,
    // for tests
    _state: () => ({ watch, lastId, told: [...told], live, wst, starting }) };
}

module.exports = { createChief, frame, neutralise, fold, buildBriefing, briefingText, watchItems, watchStep, watchCommit, shouldTell, idNote, pickChief,
  DEFAULTS, BRIEF_FILE, WATCH_EVERY_MS, ORDER_STUCK_MS, TELL_AFTER_MS, UNSIGNED, WATCH_MARK };
