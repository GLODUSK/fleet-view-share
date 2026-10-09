// Fleet View automation API: lets a local script start a Claude Code session with a prompt, send it follow-ups,
// read its status and latest reply, and stop it, through the live sessions the desktop app's session host
// (desktop/host.js) already runs. fleet-view.js hands every /api/ request here (see handle()).
//
// Who may call it: a script on this machine that can read %LOCALAPPDATA%\fleet-view\api-token. Every request
// needs "Authorization: Bearer <token>"; the token is made on the server's first start (32 random bytes, hex) and
// is never logged, served or put in /state. A request that carries an Origin header is refused whatever it says,
// so no web page can use the API, not even Fleet View's own. The server's Host check and 127.0.0.1 bind still apply.
//
// The server never starts the session host. When it is not running (no host.json, or its pipe does not answer)
// every call that needs it answers 503. Each call opens its own connection to the host's pipe, says hello with
// the token from host.json (the same way desktop/terms.js does), sends its requests and closes it.
//
// Prompts and messages go in as a bracketed paste (ESC[200~ text ESC[201~), the way the panel's Reply does
// (web/term.js), so new lines stay in the prompt; then Enter, separately, sends it. Control characters other
// than new line and tab are refused, so nothing in the text can end the paste early or press a key.
//
// Never into a menu: while Claude shows a select menu (a permission prompt, a question, the plan approval) an
// Enter picks its highlighted option, so the sender would have answered for that session (approved a tool call).
// So the session's screen is read before the paste and again just before the Enter (its output played into a
// small terminal grid, screen.js), and a menu there turns the send down with 409.
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
// requiring it only defines functions (runHost runs only when host.js is the main module, the pty module
// loads on first use), so the server gets the same pipe name and host.json path the window uses
const H = require(path.join(__dirname, 'desktop', 'host.js'));
const SCREEN = require(path.join(__dirname, 'screen.js'));

const DATA_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'fleet-view');
const TOKEN_FILE = path.join(DATA_DIR, 'api-token');
const CALL_MS = 8000; // one host request
const START_MS = 60000; // a new session reporting its conversation id and going idle
const POLL_MS = 500;
const ENTER_DELAY_MS = 300; // between the paste and its Enter, so Claude Code takes the paste in first
const SETTLE_MS = 1000; // after a new session first says idle, before its prompt goes in: its input box may still be drawing
const TAIL_MAX = 20000;
const TAKE_MS = 6000; // after a send: how long to wait for Claude to take the message up (busy, or in the transcript)
const PANEL_CLOSE_MS = 4000; // a "/" panel closed before a send: the host re-reads the pid files every 800 ms
const SKEW_MS = 500; // transcript times vs. the moment it was sent
const WAIT_DEFAULT_S = 1800, WAIT_MAX_S = 3600; // "wait": true, and the most a caller may ask for
const BAD_CHARS = /[\x00-\x08\x0b-\x1f\x7f]/; // after \r\n became \n: everything but \n and \t
const HOST_DOWN = 'the Fleet View desktop app is not running';

// ---------- the token ----------
let token = null;
// read it, or make it on the first start; the file is the user's own (LOCALAPPDATA), like host.json
function ensureToken() {
  try {
    const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(t)) { token = t; return; }
  } catch {}
  const t = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, t + '\n');
  token = t;
}
function authorized(req) {
  if (!token) return false;
  const m = /^Bearer\s+([0-9a-f]{64})\s*$/i.exec(String(req.headers.authorization || ''));
  if (!m) return false;
  const given = Buffer.from(m[1].toLowerCase()), want = Buffer.from(token);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

// ---------- the host's pipe ----------
class HostDown extends Error {}
// one connection: resolves { hello, call(op, ...args) -> Promise, close(), dead }, or rejects with HostDown
function connectHost() {
  return new Promise((resolve, reject) => {
    const info = H.readJson(H.hostFile());
    if (!info || typeof info.token !== 'string') return reject(new HostDown(HOST_DOWN));
    const sock = net.connect(H.pipeName());
    const waiting = new Map(); // n -> { ok, fail, timer }
    let buf = '', hello = null, seq = 0, settled = false, conn = null;
    const fail = (e) => {
      if (conn) conn.dead = true;
      if (!settled) { settled = true; reject(e); }
      for (const w of waiting.values()) { clearTimeout(w.timer); w.fail(e); }
      waiting.clear();
      sock.destroy();
    };
    const helloTimer = setTimeout(() => fail(new HostDown(HOST_DOWN)), 4000);
    sock.setEncoding('utf8');
    sock.on('error', () => fail(new HostDown(HOST_DOWN)));
    sock.on('close', () => fail(new HostDown('the session host closed the connection')));
    sock.on('connect', () => sock.write(JSON.stringify({ t: 'hello', token: info.token, pid: process.pid }) + '\n'));
    sock.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (!msg || typeof msg !== 'object') continue;
        if (msg.t === 'hello' && !hello) {
          hello = msg;
          clearTimeout(helloTimer);
          settled = true;
          conn = { hello, call, dead: false, users: 0, idle: null, close: () => { conn.dead = true; sock.removeAllListeners('close'); sock.end(); } };
          resolve(conn);
        } else if (msg.t === 'res' && waiting.has(msg.n)) {
          const w = waiting.get(msg.n);
          waiting.delete(msg.n);
          clearTimeout(w.timer);
          if (msg.err) w.fail(new Error(msg.err)); else w.ok(msg.v);
        }
        // events (live output, list updates) are not needed here
      }
    });
    function call(op, ...a) {
      return new Promise((ok, no) => {
        const n = ++seq;
        const timer = setTimeout(() => { waiting.delete(n); no(new Error(`the session host did not answer ${op}`)); }, CALL_MS);
        waiting.set(n, { ok, fail: no, timer });
        sock.write(JSON.stringify({ t: 'req', n, op, a }) + '\n');
      });
    }
  });
}
// Calls share one connection, so a script that polls does not fill host.log with a connect and disconnect
// line per call. It closes after IDLE_CLOSE_MS without a call, so the host can still exit when nothing uses it.
const IDLE_CLOSE_MS = 30000;
let shared = null; // a Promise of the connection
let hostPid = null;
async function withHost(fn) {
  let host = shared && await shared.catch(() => null);
  if (!host || host.dead) {
    shared = connectHost();
    try { host = await shared; } catch (e) { shared = null; throw e; }
    // another host process counts new-<n> from 1 again: keys remembered from the last one mean nothing now
    if (host.hello.pid !== hostPid) { keyToId.clear(); hostPid = host.hello.pid; }
  }
  host.users++;
  clearTimeout(host.idle);
  try { return await fn(host); } finally {
    if (--host.users === 0) host.idle = setTimeout(() => { if (!host.users) { host.close(); if (shared) shared.then((h) => { if (h === host) shared = null; }, () => {}); } }, IDLE_CLOSE_MS);
  }
}

// ---------- helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// a new session's key once it has its id: kept so a caller can still use the key create gave it
const keyToId = new Map(); // 'new-<n>' -> id
const resolveKey = (k) => keyToId.get(k) || k;
const keyOf = (id) => { for (const [k, v] of keyToId) if (v === id) return k; return null; };

// the text as it goes into the prompt: \r\n made \n, then nothing but printable text, \n and \t
function cleanText(v) {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\r\n/g, '\n');
  if (!t.trim() || BAD_CHARS.test(t)) return null;
  return t;
}
// paste it (new lines as the \r a terminal sends inside a paste), then Enter on its own. beforeEnter: an async
// check just before the Enter; when it answers true (a menu came up) the Enter is not sent. -> { entered }
async function sendText(host, id, text, beforeEnter) {
  await host.call('write', id, `\x1b[200~${text.replace(/\n/g, '\r')}\x1b[201~`);
  await sleep(ENTER_DELAY_MS);
  if (beforeEnter && await beforeEnter()) return { entered: false };
  await host.call('write', id, '\r');
  return { entered: true };
}

// ---------- is Claude showing a menu? ----------
// The pty's size now: the host's list (a newer host), else sessions.json (the host rewrites it on every change),
// else the host's default. The output was drawn for that size, so the grid must have it too.
function sizeOf(p) {
  if (Number.isInteger(p.cols) && Number.isInteger(p.rows)) return { cols: p.cols, rows: p.rows };
  try {
    const j = H.readJson(H.sessionsFile());
    const e = j && Array.isArray(j.sessions) ? j.sessions.find((x) => x && (x.id === p.id || x.pendingKey === p.id)) : null;
    if (e && Number.isInteger(e.cols) && Number.isInteger(e.rows)) return { cols: e.cols, rows: e.rows };
  } catch {}
  return { cols: 120, rows: 32 };
}
// the menu on that session's screen now ({ options }), or null
async function menuNow(host, p) {
  const raw = await host.call('snapshot', p.id);
  const { cols, rows } = sizeOf(p);
  return SCREEN.menuShown(typeof raw === 'string' ? raw : '', cols, rows);
}
// A panel open in that session (/usage, /config: its claude waits on "dialog open") would take the text. One a
// "/" command opened (the host's slashPanel) gets Esc, as the host itself does after a minute left alone, and
// this waits until the host's list says it closed; any other (a startup dialog: Esc could refuse it) is left
// alone. An older host sends no waitingFor: nothing to do. -> { p } (its entry now) or { err }
async function closePanel(host, p) {
  const open = (x) => !!(x && x.alive && x.status === 'waiting' && x.waitingFor === 'dialog open');
  if (!open(p)) return { p };
  if (!p.slashPanel) return { err: 'a panel is open in its terminal (like /usage): close it there first (Esc)' };
  await host.call('write', p.id, '\x1b');
  for (const end = Date.now() + PANEL_CLOSE_MS; Date.now() < end;) {
    await sleep(POLL_MS / 2);
    const now = hosted(await host.call('list'), p.id);
    if (!now || !now.alive) return { err: 'that session has ended' };
    if (!open(now)) return { p: now };
  }
  return { err: `the ${p.slashPanel} panel is still open in its terminal: close it there first` };
}
const MENU_UP = 'Claude is asking something: answer it first';
const MENU_LATE = `${MENU_UP} (a menu came up just before Enter: the text is in its prompt box, not sent)`;

// "wait": false or absent -> 0, true -> the default, a number of seconds -> that many (1..WAIT_MAX_S); else null
function waitMs(v) {
  if (v === undefined || v === false) return 0;
  if (v === true) return WAIT_DEFAULT_S * 1000;
  return Number.isInteger(v) && v >= 1 && v <= WAIT_MAX_S ? v * 1000 : null;
}

// After a send. First, always: wait (up to TAKE_MS) until Claude has taken the message up, so a status read
// right after this call can't see the "idle" from before it (the host re-reads pid files every 800 ms).
// Then, with ms > 0: wait until the turn that message started has ended, and give its reply. A message sent while
// Claude was busy is queued: it shows up in the transcript only when the running turn ends, so that turn's end
// is not taken for this one's.
// -> { taken, done, endedBy?, reply?, question? }; done is false when it timed out or the caller went away
async function afterSend(host, id, sentAt, before, ms, ctx, gone) {
  const since = sentAt - SKEW_MS;
  const look = async () => {
    const p = hosted(await host.call('list'), id);
    return { p, ti: ctx.turnInfo(id) };
  };
  let taken = false, sawBusy = false;
  for (const until = Date.now() + TAKE_MS; Date.now() < until && !gone();) {
    await sleep(POLL_MS);
    const { p, ti } = await look();
    if (!p || !p.alive) break;
    if (p.status === 'busy' && before !== 'busy') sawBusy = true;
    if (sawBusy || (ti && ti.promptAt >= since)) { taken = true; break; }
  }
  if (!ms) return { taken, done: false };
  for (const until = sentAt + ms; Date.now() < until;) {
    if (gone()) return { taken, done: false };
    const { p, ti } = await look();
    if (!p) return { taken, done: true, endedBy: 'gone' };
    if (!p.alive) return { taken, done: true, endedBy: 'exit', reply: ti ? ti.lastReply || null : null };
    if (p.status === 'busy' && before !== 'busy') sawBusy = true;
    const landed = !!ti && ti.promptAt >= since;
    if (ti && (landed || sawBusy)) {
      // a question or an error from before this message (not yet cleared in the transcript) is not this turn's
      if (ti.asking && ti.askAt >= since) return { taken: true, done: true, endedBy: 'question', question: ti.askText, reply: ti.lastReply || null };
      if (ti.apiError && !ti.turnOpen && ti.errAt >= since) return { taken: true, done: true, endedBy: 'apiError', reply: ti.lastReply || null };
      // the turn ended after this message landed (or, when it went in while idle, after it was sent)
      const ended = !ti.turnOpen && ti.turnEndT >= (landed ? ti.promptAt : since);
      if (ended && p.status !== 'busy') return { taken: true, done: true, endedBy: 'reply', reply: ti.lastReply || null };
    }
    await sleep(POLL_MS);
  }
  return { taken, done: false, timedOut: true };
}

// terminal output as plain text: escape sequences gone, carriage returns made new lines
function plainText(s) {
  return String(s || '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC (titles, links)
    .replace(/\x1b\[(\d*)C/g, (_, n) => ' '.repeat(Math.min(200, Number(n) || 1))) // cursor forward: the spaces it skips
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '') // CSI (colours, other cursor moves)
    .replace(/\x1b[PX^_][\s\S]*?\x1b\\/g, '') // DCS and the like
    .replace(/\x1b[@-_]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

function hosted(list, key) {
  const id = resolveKey(key);
  return (Array.isArray(list) ? list : []).find((p) => p && p.id === id) || null;
}

// what a caller sees of one session: the host's view joined with what /state knows of the conversation
function describe(p, info) {
  return {
    id: p.id, key: keyOf(p.id) || (H.NEW_RE.test(p.id) ? p.id : null), alive: !!p.alive, status: p.status || null,
    pending: !!p.pending, exitCode: p.alive ? null : p.exitCode ?? null,
    name: info ? info.name || null : null,
    state: info ? info.state : null, label: info ? info.label : null,
    lastReply: info ? info.lastReply || null : null, waitingOn: info ? info.waitingOn || null : null,
    endedAt: info ? info.endedAt || null : null,
    cwd: (info && info.cwd) || p.cwd || null, account: p.account === 'A' ? 'A' : 'B',
  };
}

// ---------- the requests ----------
// POST /api/sessions { repo, account, prompt, chrome?, wait? }
async function startSession(b, ctx, gone) {
  if (!b || typeof b !== 'object') return [400, { ok: false, message: 'bad json' }];
  const repo = b.repo, prompt = cleanText(b.prompt);
  if (typeof repo !== 'string' || !repo || repo.length > 1024 || !path.isAbsolute(repo)) return [400, { ok: false, message: 'repo must be an absolute folder path' }];
  if (ctx.UNSAFE_PATH.test(repo)) return [400, { ok: false, message: 'that path has characters Fleet View will not pass on' }];
  if (b.account !== 'A' && b.account !== 'B') return [400, { ok: false, message: 'account must be "A" or "B"' }];
  if (!prompt) return [400, { ok: false, message: 'prompt must be text, without control characters other than new lines and tabs' }];
  if ('chrome' in b && typeof b.chrome !== 'boolean') return [400, { ok: false, message: 'chrome must be true or false' }];
  const ms = waitMs(b.wait);
  if (ms === null) return [400, { ok: false, message: `wait must be true, false or a number of seconds from 1 to ${WAIT_MAX_S}` }];
  // the same rule as the window's "New session": a folder /state lists, that exists
  if (!new Set(ctx.allowedFolders().map(H.normDir)).has(H.normDir(repo))) return [403, { ok: false, message: 'that folder is not a repo Fleet View lists' }];
  let isDir = false;
  try { isDir = fs.statSync(repo).isDirectory(); } catch {}
  if (!isDir) return [400, { ok: false, message: `the folder is gone: ${repo}` }];

  return withHost(async (host) => {
    const o = { cwd: repo, account: b.account };
    if (typeof b.chrome === 'boolean') o.chrome = b.chrome;
    const r = await host.call('create', o);
    if (!r || !r.ok || typeof r.key !== 'string') return [502, { ok: false, message: (r && r.message) || 'the session host could not start it' }];
    const key = r.key;
    // an older host ignores chrome and does not echo it back: say so instead of failing
    const chromeApplied = typeof b.chrome === 'boolean' ? r.chrome === b.chrome : null;
    // wait for Claude Code to say which conversation it is, and to be ready for input. The entry is found by its
    // pty's pid, which stays the same when the host re-keys it from new-<n> to the conversation id.
    const until = Date.now() + START_MS;
    let id = null, p = null;
    while (Date.now() < until) {
      await sleep(POLL_MS);
      const list = await host.call('list');
      p = (list || []).find((x) => x && (Number.isInteger(r.pid) ? x.pid === r.pid : x.id === key)) || null;
      if (!p) return [502, { ok: false, key, id: null, chromeApplied, message: 'the session ended before it was ready' }];
      if (!p.alive) return [502, { ok: false, key, id: H.ID_RE.test(p.id) ? p.id : null, chromeApplied, message: `the session ended before it was ready (code ${p.exitCode})` }];
      if (H.ID_RE.test(p.id) && !p.pending) { id = p.id; keyToId.set(key, id); }
      if (id && p.status === 'idle') break;
    }
    if (!id || !p || p.status !== 'idle') {
      // nothing was typed: the session is left running for a person to look at in the panel
      return [200, { ok: false, key, id, chromeApplied, promptSent: false, message: 'the session did not get ready within 60 s (it may be asking whether to trust the folder); the prompt was not sent, and the session is still running in the panel' }];
    }
    await sleep(SETTLE_MS);
    // a fresh session can open on a question (trusting the folder, a setting): nothing goes into it
    if (await menuNow(host, p)) return [200, { ok: false, key, id, chromeApplied, promptSent: false, menu: true, message: `${MENU_UP}; the prompt was not sent, and the session is still running in the panel` }];
    const sentAt = Date.now();
    const sent = await sendText(host, id, prompt, () => menuNow(host, p));
    if (!sent.entered) return [200, { ok: false, key, id, chromeApplied, promptSent: false, menu: true, message: `${MENU_LATE}; the session is still running in the panel` }];
    const w = await afterSend(host, id, sentAt, 'idle', ms, ctx, gone);
    return [200, { ok: true, key, id, chromeApplied, promptSent: true, ...w, message: doneText(w, ms, 'started, and the prompt was sent') }];
  });
}

function doneText(w, ms, sent) {
  if (!ms) return w.taken ? `${sent}; Claude took it up` : `${sent}; Claude has not taken it up yet`;
  if (!w.done) return `${sent}; ${w.timedOut ? `no reply within ${Math.round(ms / 1000)} s` : 'stopped waiting'}`;
  return { reply: `${sent}; Claude replied`, question: `${sent}; Claude asked a question`, apiError: `${sent}; the turn ended on an API error`,
    exit: `${sent}; the session ended`, gone: `${sent}; the session is gone` }[w.endedBy];
}

// POST /api/sessions/:id/message { text, wait?, from? }
// from: the conversation id of the sender, when one conversation messages another (scripts/fleet-msg.js). The
// text then goes in after a line saying who it is from, and the server records it (its team's messages, the
// feed, an alert when the two share no team).
const FROM_RE = /^[\w.-]{1,80}$/;
async function sendMessage(key, b, ctx, gone) {
  let text = cleanText(b && b.text);
  if (!text) return [400, { ok: false, message: 'text must be text, without control characters other than new lines and tabs' }];
  const ms = waitMs(b.wait);
  if (ms === null) return [400, { ok: false, message: `wait must be true, false or a number of seconds from 1 to ${WAIT_MAX_S}` }];
  let from = null;
  if (b.from !== undefined && b.from !== null) {
    if (typeof b.from !== 'string' || !FROM_RE.test(b.from)) return [400, { ok: false, message: 'from must be a conversation id' }];
    from = H.ID_RE.test(b.from) ? b.from.toLowerCase() : b.from;
  }
  const original = text;
  if (from) {
    // the name with no control characters (an ESC in a title could end the paste early and type the rest as
    // keys), quotes or line breaks, so the first line stays one line of plain text
    const name = String((ctx.nameOf && ctx.nameOf(from)) || '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/"/g, "'")
      .replace(/\s+/g, ' ').trim().slice(0, 80) || from.slice(0, 8);
    text = `[Message from teammate "${name}" (${from})]\n${text}`;
  }
  return withHost(async (host) => {
    const p = hosted(await host.call('list'), key);
    if (!p) return [404, { ok: false, message: 'no such hosted session' }];
    if (!p.alive) return [409, { ok: false, message: 'that session has ended' }];
    if (from && p.id.toLowerCase() === from.toLowerCase()) return [400, { ok: false, message: 'a conversation cannot message itself' }];
    // a panel left open (like /usage) would take the text: one a "/" command opened is closed first
    const shut = await closePanel(host, p);
    if (shut.err) return [409, { ok: false, id: p.id, panel: true, message: shut.err }];
    // the status before it was sent: busy means Claude was mid-turn, and the message is queued behind it
    const status = shut.p.status || null;
    // a permission prompt, a question or the plan approval: the Enter would answer it for that session
    if (await menuNow(host, p)) return [409, { ok: false, id: p.id, menu: true, message: MENU_UP }];
    const sentAt = Date.now();
    const sent = await sendText(host, p.id, text, () => menuNow(host, p));
    if (!sent.entered) return [409, { ok: false, id: p.id, menu: true, message: MENU_LATE }];
    if (from && ctx.noteMessage) ctx.noteMessage(from, H.ID_RE.test(p.id) ? p.id.toLowerCase() : p.id, original);
    const w = await afterSend(host, p.id, sentAt, status, ms, ctx, gone);
    return [200, { ok: true, id: p.id, status, ...w, message: doneText(w, ms, status === 'busy' ? 'sent while Claude was busy (queued)' : 'sent') }];
  });
}

// GET /api/sessions/:id[?tail=N]
async function readSession(key, query, ctx) {
  let tail = 0;
  if (query.has('tail')) {
    tail = Number(query.get('tail'));
    if (!Number.isInteger(tail) || tail < 0) return [400, { ok: false, message: 'tail must be a whole number' }];
    tail = Math.min(TAIL_MAX, tail);
  }
  return withHost(async (host) => {
    const p = hosted(await host.call('list'), key);
    if (!p) return [404, { ok: false, message: 'no such hosted session' }];
    const out = { ok: true, ...describe(p, H.ID_RE.test(p.id) ? ctx.sessionInfo(p.id.toLowerCase()) : null) };
    // the current turn, from the transcript: when its message went in and when it ended (ms, 0 when unknown)
    const ti = H.ID_RE.test(p.id) ? ctx.turnInfo(p.id.toLowerCase()) : null;
    out.turn = ti ? { startedAt: ti.promptAt || null, endedAt: ti.turnOpen ? null : ti.turnEndT || null, open: ti.turnOpen } : null;
    if (tail) out.tail = plainText(await host.call('snapshot', p.id)).slice(-tail);
    return [200, out];
  });
}

// GET /api/sessions
async function listSessions(ctx) {
  return withHost(async (host) => {
    const list = await host.call('list');
    return [200, { ok: true, sessions: (list || []).map((p) => describe(p, H.ID_RE.test(p.id) ? ctx.sessionInfo(p.id.toLowerCase()) : null)) }];
  });
}

// POST /api/sessions/:id/stop
async function stopSession(key) {
  return withHost(async (host) => {
    const p = hosted(await host.call('list'), key);
    if (!p) return [404, { ok: false, message: 'no such hosted session' }];
    await host.call('kill', p.id);
    return [200, { ok: true, id: p.id }];
  });
}

// ---------- routing ----------
// ctx: { sendJson, readBody, log, UNSAFE_PATH, allowedFolders() -> the folder paths a new session may start in,
//        sessionInfo(id) -> the conversation as /state shows it, or null,
//        turnInfo(id) -> { promptAt, turnEndT, turnOpen, asking, askAt, askText, apiError, errAt, lastReply }, or null,
//        nameOf(id) -> a conversation's name or null, noteMessage(from, to, text) -> records a message between two }
function handle(req, res, pathname, ctx) {
  const what = `${req.method} ${pathname}`;
  const answer = ([code, out]) => {
    // one line per failed call, never the token or the text
    if (code >= 400) ctx.log(`api: ${what} -> ${code} ${out && out.message ? out.message : ''}`.trim());
    if (!res.destroyed) ctx.sendJson(res, code, out);
  };
  // a caller that hung up while it waited for a reply: stop waiting
  let hungUp = false;
  res.on('close', () => { if (!res.writableFinished) hungUp = true; });
  const gone = () => hungUp;
  const run = (p) => p.then(answer, (e) => answer(e instanceof HostDown ? [503, { ok: false, message: e.message }] : [500, { ok: false, message: String((e && e.message) || e) }]));
  if (req.headers.origin !== undefined) return answer([403, { ok: false, message: 'the API is for local scripts, not web pages' }]);
  if (!authorized(req)) return answer([401, { ok: false, message: 'missing or wrong API token' }]);
  const m = /^\/api\/sessions(?:\/([^/]+))?(?:\/(message|stop))?$/.exec(pathname);
  if (!m) return answer([404, { ok: false, message: 'not found' }]);
  const [, key, verb] = m;
  if (key && !H.KEY_RE.test(key)) return answer([400, { ok: false, message: 'not a session id' }]);
  const k = key && H.ID_RE.test(key) ? key.toLowerCase() : key;
  if (req.method === 'POST') {
    if (!key) return ctx.readBody(req, res, (b) => run(startSession(b, ctx, gone)));
    if (verb === 'message') return ctx.readBody(req, res, (b) => run(sendMessage(k, b, ctx, gone)));
    if (verb === 'stop') return run(stopSession(k));
    return answer([405, { ok: false, message: 'method not allowed' }]);
  }
  if (req.method === 'GET' && !verb) {
    if (!key) return run(listSessions(ctx));
    return run(readSession(k, new URL(req.url, 'http://x').searchParams, ctx));
  }
  return answer([405, { ok: false, message: 'method not allowed' }]);
}

module.exports = { ensureToken, handle, plainText, cleanText, TOKEN_FILE };
