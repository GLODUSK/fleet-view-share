// Fleet View automation API: lets a local script (or a Claude Code session, through scripts/fv.js) start Claude
// Code sessions, send them messages, wait for them, read and answer their menus, read any conversation's
// transcript, stop and clear away what it started, make teams of conversations that message each other (led by one
// of them, or as peers), read what each is doing for free (status) and ask several one question (ask), through
// the live sessions the desktop app's session host (desktop/host.js) already runs. fleet-view.js hands every /api
// request here (see handle()), and types its teams' briefs and notes through deliverText. GET /api lists the
// endpoints (ENDPOINTS below).
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
// Prompts and messages go in as bracketed pastes (ESC[200~ text ESC[201~), the way the panel's Reply does
// (web/term.js): one per line, in pieces of at most PASTE_MAX characters, the lines joined by Alt+Enter (a new
// line in the prompt); then Enter, separately, sends it. Claude Code wraps a paste of several lines or a long one
// in <pasted_content> tags, which tell the model the text is not the user's own request, so it is never pasted
// whole. Control characters other than new line and tab are refused, so nothing in the text can end a paste early
// or press a key. No caller text ever goes on a command line: a model or effort is checked against a fixed
// pattern and goes to the session host's create (claude --model <m> --effort <e>).
//
// Never into a menu: while Claude shows a select menu (a permission prompt, a question, the plan approval) an
// Enter picks its highlighted option, so the sender would have answered for that session (approved a tool call).
// So the session's screen is read before the paste and again just before the Enter (its output played into a
// small terminal grid, screen.js), and a menu there turns the send down with 409. A menu is answered only on
// purpose (POST .../answer), and any menu but a question (a permission prompt, the plan approval) only with allowPermission.
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
const VERSION = require(path.join(__dirname, 'version.js'));

const DATA_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'fleet-view');
const TOKEN_FILE = path.join(DATA_DIR, 'api-token');
const CALL_MS = 8000; // one host request
const START_MS = 60000; // a new session reporting its conversation id and going idle (and a resumed one going idle)
const POLL_MS = 500;
const ENTER_DELAY_MS = 300; // between the paste and its Enter, so Claude Code takes the paste in first
const SETTLE_MS = 1000; // after a new session first says idle, before its prompt goes in: its input box may still be drawing
const TAIL_MAX = 20000;
const TAKE_MS = 6000; // after a send: how long to wait for Claude to take the message up (busy, or in the transcript)
const PANEL_CLOSE_MS = 4000; // a "/" panel closed before a send: the host re-reads the pid files every 800 ms
const SKEW_MS = 500; // transcript times vs. the moment it was sent
const WAIT_DEFAULT_S = 1800, WAIT_MAX_S = 3600; // "wait": true, and the most a caller may ask for
const MENU_EVERY_MS = 2000; // while waiting on a turn: how often the screen is read for a menu
const ANSWER_MS = 3000; // after an answer: how long to wait for the menu to change
const TYPE_DELAY_MS = 300; // after pressing "Type something.", before its text goes in
const IDLE_ENDS_MS = 5000; // /wait: idle this long ends it even when the transcript still says the turn is open
const BAD_CHARS = /[\x00-\x08\x0b-\x1f\x7f]/; // after \r\n became \n: everything but \n and \t
const NAME_BAD = /[\x00-\x1f\x7f-\x9f]/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9.\-\[\]]{0,59}$/;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
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
// the host's list of sessions, or null when it is not running (fleet-view.js's temp sweep)
function hostList() {
  return withHost((host) => host.call('list')).then((l) => (Array.isArray(l) ? l : []), () => null);
}

// ---------- helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// a new session's key once it has its id: kept so a caller can still use the key create gave it
const keyToId = new Map(); // 'new-<n>' -> id
const resolveKey = (k) => keyToId.get(k) || k;
const keyOf = (id) => { for (const [k, v] of keyToId) if (v === id) return k; return null; };
const convId = (id) => (H.ID_RE.test(String(id || '')) ? String(id).toLowerCase() : null);

// the text as it goes into the prompt: \r\n made \n, then nothing but printable text, \n and \t
function cleanText(v) {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\r\n/g, '\n');
  if (!t.trim() || BAD_CHARS.test(t)) return null;
  return t;
}
// the writes that type text into Claude Code's prompt as the user's own (see the top): each line pasted in pieces
// of at most PASTE_MAX characters (never splitting a surrogate pair), Alt+Enter between lines. They go in
// PASTE_GAP_MS apart: an Alt+Enter read in one chunk with the pastes around it is lost. Kept in step with
// web/term.js pasteWrites.
const PASTE_MAX = 400, PASTE_GAP_MS = 40;
function pasteWrites(text) {
  const out = [];
  String(text).split('\n').forEach((line, x) => {
    if (x) out.push('\x1b\r');
    for (let i = 0; i < line.length;) {
      let j = Math.min(line.length, i + PASTE_MAX);
      if (j < line.length && /[\ud800-\udbff]/.test(line[j - 1])) j--;
      out.push(`\x1b[200~${line.slice(i, j)}\x1b[201~`);
      i = j;
    }
  });
  return out;
}
// type it (pasteWrites), then Enter on its own. beforeEnter: an async check just before the Enter; when it answers
// true (a menu came up) the Enter is not sent. -> { entered }
async function sendText(host, id, text, beforeEnter) {
  for (const [x, w] of pasteWrites(text).entries()) {
    if (x) await sleep(PASTE_GAP_MS);
    await host.call('write', id, w);
  }
  await sleep(ENTER_DELAY_MS);
  if (beforeEnter && await beforeEnter()) return { entered: false };
  await host.call('write', id, '\r');
  return { entered: true };
}
// One typing at a time into a conversation: deliver and the queue below both paste in chunks, and two at once (a
// team note and a teammate's queued message, say) would mix into one prompt. typeOne(id, fn) runs fn once whatever
// was typing into id has finished; typingInto(id): something is now.
const typing = new Map(); // id -> the promise of the last typing queued for it
function typeOne(id, fn) {
  const run = (typing.get(id) || Promise.resolve()).then(fn);
  const tail = run.catch(() => {});
  typing.set(id, tail);
  tail.then(() => { if (typing.get(id) === tail) typing.delete(id); });
  return run;
}
const typingInto = (id) => typing.has(id);

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
// the menu on that session's screen now ({ kind, title, context, more, options, sig }, screen.js), or null
async function menuNow(host, p) {
  const raw = await host.call('snapshot', p.id);
  const { cols, rows } = sizeOf(p);
  const m = SCREEN.menuDetailsShown(typeof raw === 'string' ? raw : '', cols, rows);
  // the sig as a caller passes it back: 12 hex characters, safe on any command line
  if (m) m.sig = crypto.createHash('sha1').update(m.sig).digest('hex').slice(0, 12);
  return m;
}
// A panel open in that session (/usage, /config: its claude waits on "dialog open") would take the text. One a
// "/" command opened (the host's slashPanel) gets Esc, as the host itself does after a minute left alone, and
// this waits until the host's list says it closed; any other (a startup dialog: Esc could refuse it) is left
// alone. An older host sends no waitingFor: nothing to do. -> { p } (its entry now) or { err }
const panelOpen = (x) => !!(x && x.alive && x.status === 'waiting' && x.waitingFor === 'dialog open');
async function closePanel(host, p) {
  if (!panelOpen(p)) return { p };
  if (!p.slashPanel) return { err: 'a panel is open in its terminal (like /usage): close it there first (Esc)' };
  await host.call('write', p.id, '\x1b');
  for (const end = Date.now() + PANEL_CLOSE_MS; Date.now() < end;) {
    await sleep(POLL_MS / 2);
    const now = hosted(await host.call('list'), p.id);
    if (!now || !now.alive) return { err: 'that session has ended' };
    if (!panelOpen(now)) return { p: now };
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
const WAIT_BAD = `wait must be true, false or a number of seconds from 1 to ${WAIT_MAX_S}`;

// Claude's latest reply, when it came after since (ms): a turn that ends on a question may have said nothing yet,
// and the reply before it belongs to an earlier turn
const replySince = (ti, since = 0) => (ti && ti.lastReply && (ti.replyAt || 0) >= since ? ti.lastReply : null);
// how a wait ended on a menu: a question (AskUserQuestion) or any other select menu, with the menu itself
function menuEnd(m, ti, since = 0) {
  return { endedBy: m.kind === 'question' ? 'question' : 'menu', menu: m, ...(ti && ti.asking && ti.askText ? { question: ti.askText } : {}), reply: replySince(ti, since) };
}

// After a send. First, always: wait (up to TAKE_MS) until Claude has taken the message up, so a status read
// right after this call can't see the "idle" from before it (the host re-reads pid files every 800 ms).
// Then, with ms > 0: wait until the turn that message started has ended, and give its reply. A message sent while
// Claude was busy is queued: it shows up in the transcript only when the running turn ends, so that turn's end
// is not taken for this one's. o.cont: nothing new went into the transcript (a menu was answered): the turn that
// was open goes on, and its end after sentAt is the one. Every MENU_EVERY_MS the screen is read too: a select menu
// there (a permission prompt mid-turn, a question) ends the wait with endedBy 'menu' (or 'question') and the menu.
// -> { taken, done, endedBy?, reply?, question?, menu? }; done is false when it timed out or the caller went away
async function afterSend(host, id, sentAt, before, ms, ctx, gone, o = {}) {
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
  let menuAt = 0, idleAt = 0;
  for (const until = sentAt + ms; Date.now() < until;) {
    if (gone()) return { taken, done: false };
    const { p, ti } = await look();
    if (!p) return { taken, done: true, endedBy: 'gone' };
    if (!p.alive) return { taken, done: true, endedBy: 'exit', reply: replySince(ti, since) };
    if (p.status === 'busy' && before !== 'busy') sawBusy = true;
    // after an answer the transcript may never close the turn (Esc on a permission prompt cuts it off): idle a while
    // with no menu ends it too
    idleAt = o.cont && p.status === 'idle' ? idleAt || Date.now() : 0;
    if (idleAt && Date.now() - idleAt >= IDLE_ENDS_MS && !(await menuNow(host, p))) return { taken, done: true, endedBy: 'reply', reply: replySince(ti, since) };
    const landed = !!ti && ti.promptAt >= since;
    if (ti && (landed || sawBusy || o.cont)) {
      // a message queued while busy lands later: the reply before it landed is the old turn's
      const rs = landed ? Math.max(since, ti.promptAt) : since;
      // a question or an error from before this message (not yet cleared in the transcript) is not this turn's
      if (ti.asking && ti.askAt >= since) {
        const m = await menuNow(host, p).catch(() => null);
        return { taken: true, done: true, endedBy: 'question', question: ti.askText, reply: replySince(ti, rs), ...(m ? { menu: m } : {}) };
      }
      if (ti.apiError && !ti.turnOpen && ti.errAt >= since) return { taken: true, done: true, endedBy: 'apiError', reply: replySince(ti, rs) };
      // the turn ended after this message landed (or, when it went in while idle, after it was sent)
      const ended = !ti.turnOpen && ti.turnEndT >= (landed ? ti.promptAt : since);
      if (ended && p.status !== 'busy') return { taken: true, done: true, endedBy: 'reply', reply: replySince(ti, rs) };
    }
    if (Date.now() - menuAt >= MENU_EVERY_MS) {
      menuAt = Date.now();
      const m = await menuNow(host, p);
      if (m) return { taken: true, done: true, ...menuEnd(m, ti, since) };
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
// a conversation's name for a reply, or the start of its id
const nameFor = (id, ctx) => (ctx && ctx.nameOf && convId(id) && ctx.nameOf(convId(id))) || String(id).slice(0, 8);

// what a caller sees of one session: the host's view joined with what /state knows of the conversation
function describe(p, info, ctx) {
  return {
    id: p.id, key: keyOf(p.id) || (H.NEW_RE.test(p.id) ? p.id : null), alive: !!p.alive, status: p.status || null,
    pending: !!p.pending, exitCode: p.alive ? null : p.exitCode ?? null,
    name: info ? info.name || null : null,
    state: info ? info.state : null, label: info ? info.label : null,
    lastReply: info ? info.lastReply || null : null, waitingOn: info ? info.waitingOn || null : null,
    endedAt: info ? info.endedAt || null : null,
    cwd: (info && info.cwd) || p.cwd || null, account: /^[A-Z]$/.test(p.account) ? p.account : 'B',
    temp: !!(ctx && ctx.isTemp && ctx.isTemp(p.id)),
  };
}
const infoOf = (p, ctx) => (convId(p.id) ? ctx.sessionInfo(convId(p.id)) : null);

// the hosted session a request names: { p } or { err: [code, json] }; alive: it must still run
async function need(host, key, alive) {
  const p = hosted(await host.call('list'), key);
  if (!p) return { err: [404, { ok: false, message: 'no such hosted session' }] };
  if (alive && !p.alive) return { err: [409, { ok: false, id: p.id, message: 'that session has ended' }] };
  return { p };
}

// Send text into a hosted, live session as message does: a "/" panel closed first, never into a menu, then wait
// as asked. note(id, sentAt, status): called once it went in (status: the session's before it, 'busy' or 'idle').
// q: { from, original, onSent?, onDrop? } to keep it in the queue (see below) instead of refusing it while a menu or a
// panel is up; it goes in later. -> [code, json]
async function deliver(host, p, text, ms, ctx, gone, note, extra = {}, q = null) {
  const later = (more, why = 'is showing a question or a prompt; it goes in once that is answered') => {
    enqueue(p.id, text, q);
    return [202, { ok: true, id: p.id, ...extra, ...more, queued: true, message: `queued: ${nameFor(p.id, ctx)} ${why}` }];
  };
  // text still waiting for it goes in first: this one waits behind it
  if (q && loadQueue().some((x) => x.id === p.id)) return later({ behind: true }, 'has text waiting for it already; this goes in after it');
  const typed = await typeOne(p.id, async () => {
    // as it is now: something else may have typed into it while this waited its turn
    const cur = hosted(await host.call('list'), p.id);
    if (!cur || !cur.alive) return { r: [409, { ok: false, id: p.id, ...extra, message: 'that session has ended' }] };
    // a panel left open (like /usage) would take the text: one a "/" command opened is closed first
    const shut = await closePanel(host, cur);
    if (shut.err) return { r: q ? later({ panel: true }) : [409, { ok: false, id: p.id, ...extra, panel: true, message: shut.err }] };
    // the status before it was sent: busy means Claude was mid-turn, and the message is queued behind it
    const status = shut.p.status || null;
    // a permission prompt, a question or the plan approval: the Enter would answer it for that session
    const m = await menuNow(host, cur);
    if (m) return { r: q ? later({ menu: m }) : [409, { ok: false, id: p.id, ...extra, menu: m, message: MENU_UP }] };
    const sentAt = Date.now();
    const sent = await sendText(host, p.id, text, () => menuNow(host, cur));
    if (!sent.entered) return { r: [409, { ok: false, id: p.id, ...extra, menu: true, message: MENU_LATE }] };
    return { sentAt, status };
  });
  if (typed.r) return typed.r;
  const { sentAt, status } = typed;
  if (note) note(p.id, sentAt, status);
  const w = await afterSend(host, p.id, sentAt, status, ms, ctx, gone);
  return [200, { ok: true, id: p.id, ...extra, status, ...w, message: doneText(w, ms, status === 'busy' ? 'sent while Claude was busy (queued)' : 'sent') }];
}

function doneText(w, ms, sent) {
  if (!ms) return w.taken ? `${sent}; Claude took it up` : `${sent}; Claude has not taken it up yet`;
  if (!w.done) return `${sent}; ${w.timedOut ? `no reply within ${Math.round(ms / 1000)} s` : 'stopped waiting'}`;
  return { reply: `${sent}; Claude replied`, question: `${sent}; Claude asked a question`, apiError: `${sent}; the turn ended on an API error`,
    menu: `${sent}; Claude is showing a menu (answer it with POST /api/sessions/:id/answer)`, idle: `${sent}; Claude is idle`,
    exit: `${sent}; the session ended`, gone: `${sent}; the session is gone` }[w.endedBy];
}

// ---------- text that waits for a menu to be answered ----------
// A conversation showing a question, a permission prompt or the plan approval can't be typed into (Enter would
// answer it), so text for it from deliverText waits here, by the same rules as the page's orders (web/orders.js):
// every Q_TICK_MS each waiting one is looked at, and it goes in once no menu has been on that screen for Q_CLEAR_MS,
// oldest first, one per conversation per tick. One still waiting after Q_MAX_MS, or whose conversation has not run
// in the session host for Q_GONE_MS, is dropped (and logged). It is kept in msg-queue.json, so a restart (every
// update) carries on with it, and follows a conversation that hands off to the one that carries on.
const QUEUE_FILE = path.join(DATA_DIR, 'msg-queue.json');
const Q_TICK_MS = 2000, Q_CLEAR_MS = 1500, Q_MAX_MS = 2 * 3600e3, Q_GONE_MS = 5 * 60e3;
let queue = null, qTimer = null, qTicking = false, qCtx = null; // queue: [{ id, text, at, from?, original? }]
function loadQueue() {
  if (queue) return queue;
  queue = [];
  try {
    const j = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
    if (Array.isArray(j)) queue = j.filter((q) => q && typeof q.id === 'string' && typeof q.text === 'string' && Number.isFinite(q.at)).slice(-500);
  } catch {}
  // an ask's question from before a restart: the ask is gone, so nobody would collect its answer
  const n = queue.length;
  queue = queue.filter((q) => q.kind !== 'question');
  if (queue.length < n && qCtx) qCtx.log(`api: dropped ${n - queue.length} queued question(s) whose ask a restart ended`);
  return queue;
}
function saveQueue() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(QUEUE_FILE + '.tmp', JSON.stringify(queue.map(({ id, text, at, from, original, kind }) => ({ id, text, at, ...(from ? { from, original } : {}), ...(kind ? { kind } : {}) }))));
    fs.renameSync(QUEUE_FILE + '.tmp', QUEUE_FILE);
  } catch (e) { if (qCtx) qCtx.log(`api: could not save the message queue: ${e.message}`); }
}
// q: { from, original, kind? } of a message between conversations (recorded once it goes in; kind 'question' for an
// ask's), or {}. q.onSent(id, sentAt, status) and q.onDrop(why), an ask's, are kept in memory only (hooks: a restart
// loses the asks anyway): called when it goes in, or is dropped.
function enqueue(id, text, q) {
  loadQueue();
  let x = queue.find((y) => y.id === id && y.text === text);
  if (!x) queue.push((x = { id, text, at: Date.now(), ...(q && q.from ? { from: q.from, original: q.original } : {}), ...(q && q.kind ? { kind: q.kind } : {}) }));
  if (q && (q.onSent || q.onDrop)) (x.hooks = x.hooks || []).push({ onSent: q.onSent, onDrop: q.onDrop });
  saveQueue();
  wakeQueue();
}
// runs a queued entry's hooks (an ask watching for it): 'onSent' or 'onDrop', with args
function runHooks(q, which, ...args) {
  for (const h of q.hooks || []) {
    try { if (h[which]) h[which](...args); } catch (e) { if (qCtx) qCtx.log(`api: a queued message's ${which} failed: ${e.message}`); }
  }
}
function wakeQueue() {
  if (qTimer || !loadQueue().length) return;
  qTimer = setInterval(tickQueue, Q_TICK_MS);
  if (qTimer.unref) qTimer.unref();
}
// at the server's start: what waited before the restart carries on
function startQueue(ctx) { qCtx = ctx; wakeQueue(); }
// the conversations with text waiting here (/state's queuedText: the page's own waiting orders go in after it)
const queuedIds = () => [...new Set(loadQueue().map((x) => x.id))];
function unqueue(q, why) {
  queue = queue.filter((x) => x !== q);
  saveQueue();
  if (why && qCtx) qCtx.log(`api: a message waiting for ${q.id} was dropped: ${why}`);
  if (why) runHooks(q, 'onDrop', why);
}
async function tickQueue() {
  if (qTicking) return;
  if (!loadQueue().length) { clearInterval(qTimer); qTimer = null; return; }
  qTicking = true;
  const now = Date.now();
  // no host: every waiting one counts as not running
  const gone = (q, why) => { q.clearAt = 0; if (!q.goneAt) q.goneAt = now; else if (now - q.goneAt > Q_GONE_MS) unqueue(q, why); };
  try {
    await withHost(async (host) => {
      const list = await host.call('list'), seen = new Set();
      for (const q of [...queue]) {
        if (now - q.at > Q_MAX_MS) { unqueue(q, 'still waiting after 2 hours'); continue; }
        // it handed off meanwhile: the one that carries on takes it
        const succ = qCtx && qCtx.successorOf && convId(q.id) ? qCtx.successorOf(convId(q.id)) : null;
        if (succ && succ !== q.id) { q.id = succ; saveQueue(); }
        if (seen.has(q.id)) continue;
        seen.add(q.id);
        const p = hosted(list, q.id);
        if (!p || !p.alive) { gone(q, 'it stopped running in Fleet View before it could take it'); continue; }
        q.goneAt = 0;
        if (panelOpen(p)) { if (p.slashPanel) await closePanel(host, p); q.clearAt = 0; continue; }
        if (await menuNow(host, p)) { q.clearAt = 0; continue; }
        if (!q.clearAt) { q.clearAt = now; continue; }
        if (now - q.clearAt < Q_CLEAR_MS) continue;
        // something is typing into it now (a note, a message): next tick
        if (typingInto(p.id)) continue;
        let sentAt = 0;
        const sent = await typeOne(p.id, () => { sentAt = Date.now(); return sendText(host, p.id, q.text, () => menuNow(host, p)); });
        if (!sent.entered) { unqueue(q, 'a menu came up just before Enter (the text is in its prompt box, not sent)'); continue; }
        unqueue(q);
        if (q.from && qCtx && qCtx.noteMessage) qCtx.noteMessage(q.from, convId(p.id) || p.id, q.original || q.text, q.kind ? { kind: q.kind } : undefined);
        runHooks(q, 'onSent', convId(p.id) || p.id, sentAt, p.status || null);
      }
    });
  } catch (e) {
    if (e instanceof HostDown) for (const q of [...queue]) gone(q, 'the desktop app was not running');
    else if (qCtx) qCtx.log(`api: the message queue failed: ${e.message}`);
  } finally { qTicking = false; }
}

// ---------- resuming a conversation in the desktop app ----------
// Can it be resumed here? Its log on disk, its folder known, inside a folder a new session could start in (its
// repo, or a checkout of it), and still there. -> { cwd, account } or { err: [code, json] }
function resumable(id, ctx) {
  const where = ctx.whereIs(id);
  if (!where.known) return { err: [404, { ok: false, id, message: 'no such conversation (its log is not on disk)' }] };
  const cwd = where.cwd;
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || ctx.UNSAFE_PATH.test(cwd)) return { err: [409, { ok: false, id, message: 'Fleet View does not know which folder that conversation worked in' }] };
  const dir = H.normDir(cwd);
  const allowed = ctx.allowedFolders().map(H.normDir).some((f) => dir === f || dir.startsWith(f.endsWith(path.sep) ? f : f + path.sep));
  if (!allowed) return { err: [403, { ok: false, id, message: `its folder is not in a repo Fleet View lists: ${cwd}` }] };
  let isDir = false;
  try { isDir = fs.statSync(cwd).isDirectory(); } catch {}
  if (!isDir) return { err: [409, { ok: false, id, message: `its folder is gone: ${cwd}` }] };
  return { cwd, account: where.account };
}
// The host's open (claude --resume, in its last folder under its account), as the panel's Open does, unless it runs
// here already; never one open in a terminal outside Fleet View (it would run twice, writing one transcript). Then
// up to START_MS for it to be idle (a resumed claude says busy while it loads).
// -> { p, alreadyRunning, ready, stopped? } or { err: [code, json] }
async function resumeIn(host, id, where, account, ctx, gone) {
  let p = hosted(await host.call('list'), id);
  let alreadyRunning = !!(p && p.alive);
  if (!alreadyRunning) {
    if (ctx.openElsewhere && ctx.openElsewhere(id)) return { err: [409, { ok: false, id, elsewhere: true, message: 'it is open in a terminal outside Fleet View: end it there first' }] };
    const r = await host.call('open', { id, cwd: where.cwd, account: account || where.account || 'B' });
    if (!r || !r.ok) return { err: [502, { ok: false, id, message: (r && r.message) || 'the session host could not open it' }] };
    if (r.message === 'already running') alreadyRunning = true; // it started meanwhile
  }
  // one already running is taken as it is (a message to a busy one is queued, as message does)
  const until = Date.now() + START_MS;
  for (;;) {
    p = hosted(await host.call('list'), id);
    if (!p || !p.alive) return { err: [502, { ok: false, id, alreadyRunning, message: `the session ended before it was ready${p ? ` (code ${p.exitCode})` : ''}` }] };
    if (alreadyRunning || p.status === 'idle' || Date.now() >= until) break;
    if (gone()) return { p, alreadyRunning, ready: false, stopped: true };
    await sleep(POLL_MS);
  }
  return { p, alreadyRunning, ready: p.status === 'idle' };
}

// ---------- text for a conversation: teams and messages between conversations ----------
// deliverText(key, text, o, ctx, gone) -> [code, json], the one way the server types text into a conversation for
// a team (briefs, notes) or from another conversation (sendMessage with from). o: { kind, from?, original?, wait?,
// open?, queue?, ask?, onSent?, onDrop? }: ask marks an ask's question (the feed says so); onSent(id, sentAt, status)
// is called once the text went in (now, or later from the queue), onDrop(why) when the queue drops it.
// - The handoff chain is followed first (ctx.successorOf): text for a conversation that handed off or ran /clear
//   goes to the one that carries on, and the reply says so (redirected: { from, to }).
// - One running in the session host gets it as message does; one showing a menu gets it later, through the queue
//   above (202 { queued: true }), unless queue is false.
// - One not running here is resumed in the desktop app first (resumeIn), unless it is open in a terminal outside
//   Fleet View (409 elsewhere), or open is false, or kind is 'note' (409 notRunning): a note about who joined or
//   left a team costs a Claude turn, so it goes only to conversations running now.
// text may be a function of the receiver's id (a message's reply line names it). from: the sender, refused as the
// receiver; with original (the text as the sender wrote it), recorded through ctx.noteMessage once it goes in.
async function deliverText(key, text, o, ctx, gone = () => false) {
  qCtx = qCtx || ctx;
  const asked = resolveKey(key);
  const succ = convId(asked) && ctx.successorOf ? ctx.successorOf(convId(asked)) : null;
  const id = succ && succ !== convId(asked) ? succ : asked;
  const extra = id !== asked ? { redirected: { from: convId(asked), to: id } } : {};
  if (o.from && convId(id) === o.from) return [400, { ok: false, id, ...extra, message: 'a conversation cannot message itself' }];
  const body = typeof text === 'function' ? text(id) : text;
  const name = nameFor(id, ctx), open = o.kind !== 'note' && o.open !== false;
  return withHost(async (host) => {
    let p = hosted(await host.call('list'), id);
    if (!p || !p.alive) {
      const cid = convId(id);
      if (cid && ctx.openElsewhere && ctx.openElsewhere(cid)) {
        return [409, { ok: false, id: cid, ...extra, elsewhere: true, message: `${name} is open in a terminal outside Fleet View, so nothing can be typed into it from here; tell the user` }];
      }
      if (!open || !cid) {
        const why = o.kind === 'note' ? `${name} is not running now, so it was not told`
          : o.from ? `${name} is not running in Fleet View (its panel was closed or it ended); without --no-open it is resumed first`
            : p ? 'that session has ended' : 'no such hosted session';
        return [p ? 409 : 404, { ok: false, id, ...extra, notRunning: true, message: why }];
      }
      const where = resumable(cid, ctx);
      if (where.err) return [where.err[0], { ...where.err[1], ...extra, message: `${name} is not running in Fleet View and can't be resumed: ${where.err[1].message}` }];
      const r = await resumeIn(host, cid, where, null, ctx, gone);
      if (r.err) return [r.err[0], { ...r.err[1], ...extra }];
      if (!r.ready) return [409, { ok: false, id: cid, ...extra, resumed: true, message: `${name} was resumed, but it was not idle within ${START_MS / 1000} s; nothing was typed` }];
      p = r.p;
      extra.resumed = !r.alreadyRunning;
      if (extra.resumed) await sleep(SETTLE_MS);
    }
    const from = o.from || null, kind = o.ask ? 'question' : null;
    const note = (to, at, status) => {
      if (from && ctx.noteMessage) ctx.noteMessage(from, convId(to) || to, o.original || body, kind ? { kind } : undefined);
      if (o.onSent) o.onSent(convId(to) || to, at, status);
    };
    return deliver(host, p, body, o.wait || 0, ctx, gone, note, extra,
      o.queue === false ? null : { from, original: o.original || body, ...(kind ? { kind } : {}), onSent: o.onSent, onDrop: o.onDrop });
  });
}

// ---------- the requests ----------
// GET /api: what there is, for a caller (or a Claude) finding its way from the command line
const ENDPOINTS = [
  { method: 'GET', path: '/api', does: 'this list, and fleetView: the Fleet View version (1.0.12; "" when unknown)' },
  { method: 'GET', path: '/api/conversations', query: 'state?, repo?, all?=1, limit?', does: 'every conversation Fleet View shows (not only hosted): id, name, state, repo, branch, lastReply, hosted, alive' },
  { method: 'GET', path: '/api/sessions', does: 'the sessions the desktop app hosts, with status and latest reply' },
  { method: 'POST', path: '/api/sessions', body: '{ repo, account: "A"|"B"|"C"…, prompt, name?, model?, effort?, forkFrom?, temp?, chrome?, wait? }', does: 'start a session in a repo (forkFrom: carrying a conversation\'s history), set its name/model/effort, send the prompt; temp: hidden from the map once it ends' },
  { method: 'GET', path: '/api/sessions/:id', query: 'tail?', does: 'one hosted session: status, state, latest reply, its turn; tail: the last characters of its screen' },
  { method: 'POST', path: '/api/sessions/:id/message', body: '{ text, wait?, from?, queue?, open? }', does: 'send a message; wait: until the turn ends. from: your conversation id (a message between conversations). queue: while a menu is up it waits and goes in once answered (202), else refused; open: one not running here is resumed first. Both default to true with from' },
  { method: 'POST', path: '/api/sessions/:id/wait', body: '{ timeout? (s, default 1800) }', does: 'wait, sending nothing, until it is ready for you: endedBy idle | reply | question | menu | apiError | exit | gone' },
  { method: 'GET', path: '/api/sessions/:id/menu', does: 'the select menu on its screen now: kind (question|permission|plan|trust|other), title, context, options, sig; or null' },
  { method: 'POST', path: '/api/sessions/:id/answer', body: '{ option: n | "esc", sig?, text?, allowPermission?, wait? }', does: 'answer the menu (text: for a "Type something." option); any menu but a question needs allowPermission (esc never does)' },
  { method: 'POST', path: '/api/sessions/:id/interrupt', does: 'press Esc once to stop Claude mid-turn (not while a menu is up)' },
  { method: 'POST', path: '/api/sessions/:id/open', body: '{ account?, prompt?, wait? }', does: 'resume a conversation Fleet View knows as a hosted session; prompt: then send it' },
  { method: 'GET', path: '/api/sessions/:id/transcript', query: 'since?, limit? (default the last 50, at most 500)', does: 'any conversation\'s transcript, compact: user, assistant, tool (name, input, result), note, thinking' },
  { method: 'POST', path: '/api/sessions/:id/stop', body: '{ remove? }', does: 'end the session (remove: also hide it from the map)' },
  { method: 'POST', path: '/api/sessions/:id/remove', does: 'hide a conversation from the map (not one still running: stop it first); logs are kept' },
  { method: 'GET', path: '/api/teams', does: 'the teams: id, name, members, lead, order, roster (each member\'s name, repo, branch, state, lead), messages' },
  { method: 'POST', path: '/api/teams', body: '{ members: [ids], order, name?, lead? }', does: 'make a team of exactly these 2..12 conversations (they leave other teams) and send each its brief: the order, its teammates and how to message them. lead: one of them directs the rest (they report to it); without, they are peers' },
  { method: 'POST', path: '/api/teams/:id/add', body: '{ member, lead? }', does: 'add a conversation: it gets the brief, the others a note with its id (lead: true: it joins as the lead)' },
  { method: 'POST', path: '/api/teams/:id/remove', body: '{ member }', does: 'take a conversation out; it and the others get a note (a team left with one is disbanded; one that loses its lead has none)' },
  { method: 'POST', path: '/api/teams/:id/lead', body: '{ member: id | null }', does: 'make a member the team\'s lead (it gets the lead\'s brief, the others a note), or null: no lead, peers again' },
  { method: 'POST', path: '/api/teams/:id/disband', does: 'end the team; every member gets a note (they keep working)' },
  { method: 'POST', path: '/api/teams/:id/message', body: '{ text, from? }', does: 'the text to every member but from (queued behind a menu, resumed when not running)' },
  { method: 'GET', path: '/api/status', query: 'team? | ids? (comma-separated) | from?', does: 'free (nothing is typed into them): what each member of a team (or these ids, or from\'s team; none: every unfinished conversation) is doing, its last reply, branch, PR, context, cost, lead, queued' },
  { method: 'POST', path: '/api/ask', body: '{ from, to?: [ids], team?, question, within? (s, 30..3600, default 600) }', does: 'ask several conversations one question: each answers in its own turn, and the answers are typed into from as one message once all answered or within passed (later ones one by one). Replies { ask: id, asked }' },
  { method: 'GET', path: '/api/ask/:id', query: 'wait? (s, up to 600)', does: 'an ask and its answers (status waiting | answered | asking | failed, reply); wait: until all answered or failed, or wait passes' },
  { method: 'POST', path: '/api/ask/:id/collected', body: '{ ids? }', does: 'the asker has these answers already (no ids: every one in now), so they are not typed into it' },
];
function describeApi() {
  return [200, { ok: true, version: 2, fleetView: VERSION.current().version, auth: 'Authorization: Bearer <%LOCALAPPDATA%\\fleet-view\\api-token>', endpoints: ENDPOINTS,
    notes: 'ids: a conversation id, or the new-<n> key POST /api/sessions gave. wait: true (30 min), false, or seconds 1..3600. A reply is { ok, message?, ... }; 400 bad input, 401 token, 403 refused, 404 no such session, 409 state conflict, 503 the desktop app is not running.' }];
}

// POST /api/sessions { repo, account, prompt, name?, model?, effort?, forkFrom?, temp?, chrome?, wait? }
// the Claude accounts on this machine (ctx.accounts from fleet-view.js: B plus one per ~/.claude-<x>), else A and B
const acctsOf = (ctx) => { try { const a = typeof ctx.accounts === 'function' ? ctx.accounts() : null; if (Array.isArray(a) && a.length) return a; } catch {} return ['A', 'B']; };
const acctOk = (a, ctx) => typeof a === 'string' && acctsOf(ctx).includes(a);
async function startSession(b, ctx, gone) {
  if (!b || typeof b !== 'object') return [400, { ok: false, message: 'bad json' }];
  const repo = b.repo, prompt = cleanText(b.prompt);
  if (typeof repo !== 'string' || !repo || repo.length > 1024 || !path.isAbsolute(repo)) return [400, { ok: false, message: 'repo must be an absolute folder path' }];
  if (ctx.UNSAFE_PATH.test(repo)) return [400, { ok: false, message: 'that path has characters Fleet View will not pass on' }];
  if (!acctOk(b.account, ctx)) return [400, { ok: false, message: `account must be one of ${acctsOf(ctx).join(', ')}` }];
  if (!prompt) return [400, { ok: false, message: 'prompt must be text, without control characters other than new lines and tabs' }];
  if ('chrome' in b && typeof b.chrome !== 'boolean') return [400, { ok: false, message: 'chrome must be true or false' }];
  if (b.name != null && (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 80 || NAME_BAD.test(b.name))) return [400, { ok: false, message: 'name must be text of 1 to 80 characters, without control characters' }];
  if (b.model != null && (typeof b.model !== 'string' || !MODEL_RE.test(b.model))) return [400, { ok: false, message: 'model must be a model name like opus, sonnet, haiku or claude-opus-5-5[1m] (letters, digits, . - [ ])' }];
  if (b.effort != null && !EFFORTS.includes(b.effort)) return [400, { ok: false, message: `effort must be one of ${EFFORTS.join(', ')}` }];
  if ('temp' in b && typeof b.temp !== 'boolean') return [400, { ok: false, message: 'temp must be true or false' }];
  let fork = null;
  if (b.forkFrom != null) {
    fork = convId(b.forkFrom);
    if (!fork) return [400, { ok: false, message: 'forkFrom must be a conversation id' }];
    if (!ctx.whereIs(fork).known) return [404, { ok: false, message: 'no such conversation to fork (its log is not on disk)' }];
  }
  const ms = waitMs(b.wait);
  if (ms === null) return [400, { ok: false, message: WAIT_BAD }];
  // the same rule as the window's "New session": a folder /state lists, that exists
  if (!new Set(ctx.allowedFolders().map(H.normDir)).has(H.normDir(repo))) return [403, { ok: false, message: 'that folder is not a repo Fleet View lists' }];
  let isDir = false;
  try { isDir = fs.statSync(repo).isDirectory(); } catch {}
  if (!isDir) return [400, { ok: false, message: `the folder is gone: ${repo}` }];

  return withHost(async (host) => {
    const o = { cwd: repo, account: b.account };
    if (typeof b.chrome === 'boolean') o.chrome = b.chrome;
    if (fork) o.forkFrom = fork;
    if (b.model != null) o.model = b.model;
    if (b.effort != null) o.effort = b.effort;
    const r = await host.call('create', o);
    if (!r || !r.ok || typeof r.key !== 'string') return [502, { ok: false, message: (r && r.message) || 'the session host could not start it' }];
    const key = r.key;
    // an older host ignores forkFrom, model and effort: a fresh conversation without the history, or on the default
    // model, so it goes again (typing /model or /effort instead would save them as the default for every session)
    const missing = [fork && r.forkFrom !== fork && 'fork a conversation', b.model != null && r.model !== b.model && 'set the model',
      b.effort != null && r.effort !== b.effort && 'set the effort'].filter(Boolean);
    if (missing.length) {
      await host.call('kill', key).catch(() => {});
      return [502, { ok: false, key, message: `the session host is too old to ${missing.join(' or ')} (restart it: node desktop/restart-host.js); the session it started was stopped` }];
    }
    // an older host ignores chrome and does not echo it back: say so instead of failing
    const chromeApplied = typeof b.chrome === 'boolean' ? r.chrome === b.chrome : null;
    // what every reply from here on carries
    const out = { key, id: null, chromeApplied, ...(b.model != null ? { model: b.model } : {}), ...(b.effort != null ? { effort: b.effort } : {}) };
    if (fork) out.forkFrom = fork;
    if (b.temp) out.temp = true;
    if (b.name != null) out.nameSet = false;
    // the name and the temp mark, once the conversation has its own id (a fork's first id may still be the
    // original's: never that one)
    const label = (id) => {
      if (!id || id === fork || out.labeled) return;
      out.labeled = true;
      if (b.name != null) out.nameSet = ctx.rename(id, b.name)[0] === 200;
      if (b.temp) ctx.markTemp(id);
    };
    const reply = (code, more) => { const { labeled, ...o2 } = out; return [code, { ...o2, ...more }]; };
    // wait for Claude Code to say which conversation it is, and to be ready for input. The entry is found by its
    // pty's pid, which stays the same when the host re-keys it from new-<n> to the conversation id.
    const byPid = (list) => (list || []).find((x) => x && (Number.isInteger(r.pid) ? x.pid === r.pid : x.id === key)) || null;
    const until = Date.now() + START_MS;
    let p = null;
    while (Date.now() < until) {
      await sleep(POLL_MS);
      p = byPid(await host.call('list'));
      if (!p) return reply(502, { ok: false, message: 'the session ended before it was ready' });
      if (!p.alive) { out.id = convId(p.id); return reply(502, { ok: false, message: `the session ended before it was ready (code ${p.exitCode})` }); }
      if (H.ID_RE.test(p.id) && !p.pending) { out.id = p.id; keyToId.set(key, p.id); label(p.id); }
      if (out.id && p.status === 'idle') break;
    }
    const id = out.id;
    if (!id || !p || p.status !== 'idle') {
      // nothing was typed: the session is left running for a person to look at in the panel
      return reply(200, { ok: false, promptSent: false, message: 'the session did not get ready within 60 s (it may be asking whether to trust the folder); the prompt was not sent, and the session is still running in the panel' });
    }
    await sleep(SETTLE_MS);
    // a fresh session can open on a question (trusting the folder, a setting): nothing goes into it
    const m0 = await menuNow(host, p);
    if (m0) return reply(200, { ok: false, promptSent: false, menu: m0, message: `${MENU_UP}; the prompt was not sent, and the session is still running in the panel` });
    const sentAt = Date.now();
    const sent = await sendText(host, id, prompt, () => menuNow(host, p));
    if (!sent.entered) return reply(200, { ok: false, promptSent: false, menu: true, message: `${MENU_LATE}; the session is still running in the panel` });
    // a fork still under the original's id gets its own once its claude writes the first message: follow the pid
    let now = id;
    if (fork && id === fork) {
      for (const end = Date.now() + TAKE_MS; Date.now() < end && now === fork;) {
        await sleep(POLL_MS);
        const q = byPid(await host.call('list'));
        if (!q || !q.alive) break;
        if (H.ID_RE.test(q.id)) now = q.id;
      }
      out.id = now; keyToId.set(key, now); label(now);
    }
    const w = await afterSend(host, now, sentAt, 'idle', ms, ctx, gone);
    return reply(200, { ok: true, promptSent: true, ...w, message: doneText(w, ms, 'started, and the prompt was sent') });
  });
}

// POST /api/sessions/:id/message { text, wait?, from?, queue?, open? }
// from: the conversation id of the sender, when one conversation messages another (fv send --from, or the older
// scripts/fleet-msg.js). It must be a conversation Fleet View knows; one that handed off counts as the one that
// carries on. The text then goes in after a line saying who it is from ("teammate" when the two share a team) and
// how to reply, and the server records it (its team's messages, the feed, an alert when they share no team).
// queue and open (both true by default with from, false without) go to deliverText: with queue, a receiver showing
// a menu gets it later (202 queued); with open, one not running here is resumed first. Without either it must be
// running here, and a menu turns it down (409), as before.
async function sendMessage(key, b, ctx, gone) {
  if (!b || typeof b !== 'object') return [400, { ok: false, message: 'bad json' }];
  const text = cleanText(b.text);
  if (!text) return [400, { ok: false, message: 'text must be text, without control characters other than new lines and tabs' }];
  const ms = waitMs(b.wait);
  if (ms === null) return [400, { ok: false, message: WAIT_BAD }];
  for (const k of ['queue', 'open']) if (k in b && typeof b[k] !== 'boolean') return [400, { ok: false, message: `${k} must be true or false` }];
  let from = null;
  if (b.from !== undefined && b.from !== null) {
    from = typeof b.from === 'string' ? convId(b.from) : null;
    if (!from) return [400, { ok: false, message: 'from must be your conversation id' }];
    if (!ctx.whereIs(from).known && !ctx.sessionInfo(from)) return [400, { ok: false, message: 'from is not a conversation Fleet View knows' }];
    from = (ctx.successorOf && ctx.successorOf(from)) || from;
  }
  const queue = 'queue' in b ? b.queue : !!from, open = 'open' in b ? b.open : !!from;
  if (!from) return deliverText(key, text, { kind: 'message', wait: ms, queue, open }, ctx, gone);
  const name = headName(from, ctx);
  // "your lead" when from leads a team the receiver is in, "teammate" when they share one without that
  const head = (to) => {
    const t = ctx.teamOf ? ctx.teamOf(from) : null;
    const mate = !!t && !!convId(to) && t.members.includes(convId(to));
    const who = mate && t.lead === from ? 'your lead ' : mate ? 'teammate ' : '';
    return `[Message from ${who}"${name}" (${from}). Reply with: fv send ${from} "message" --from ${convId(to) || to}]\n${text}`;
  };
  return deliverText(key, head, { kind: 'message', from, original: text, wait: ms, queue, open }, ctx, gone);
}
// a sender's name for the first line of what it sends: no control characters (an ESC in a title could end the
// paste early and type the rest as keys), quotes or line breaks, so the line stays one line of plain text
function headName(from, ctx) {
  return String(nameFor(from, ctx)).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/"/g, "'").replace(/\s+/g, ' ').trim().slice(0, 80) || from.slice(0, 8);
}

// ---------- teams ----------
// GET /api/teams, POST /api/teams { members, order, name?, lead? }, POST /api/teams/:id/add { member, lead? },
// POST /api/teams/:id/remove { member }, POST /api/teams/:id/lead { member | null }, POST /api/teams/:id/disband,
// POST /api/teams/:id/message { text, from? }.
// The teams are fleet-view.js's (ctx.teams), the same the page's "Work together" makes; each call sends the notes
// the page's do (who joined or left: only to members running now). Making a team sends each member its brief as an
// order, and adding one sends the newcomer its brief: both may resume a conversation that is not running.
const memberId = (m) => (typeof m === 'string' ? convId(resolveKey(m)) : null);
async function makeTeam(b, ctx) {
  if (!b || typeof b !== 'object') return [400, { ok: false, message: 'bad json' }];
  if (!Array.isArray(b.members)) return [400, { ok: false, message: 'members must be a list of conversation ids' }];
  const members = b.members.map(memberId);
  if (members.some((m) => !m)) return [400, { ok: false, message: 'members must be conversation ids (a new session has one once it has started)' }];
  const lead = b.lead == null ? b.lead : memberId(b.lead);
  if (b.lead != null && !lead) return [400, { ok: false, message: 'lead must be a conversation id (one of the members)' }];
  return ctx.teams.make({ members, order: b.order, name: b.name, ...('lead' in b ? { lead } : {}) });
}
async function addToTeam(tid, b, ctx) {
  const m = memberId(b && b.member);
  if (!m) return [400, { ok: false, message: 'member must be a conversation id' }];
  if ('lead' in b && typeof b.lead !== 'boolean') return [400, { ok: false, message: 'lead must be true or false' }];
  return ctx.teams.add(tid, m, b.lead === true);
}
// POST /api/teams/:id/lead { member: <id> | null }: makes member the team's lead, or (null) leaves it with none
async function leadTeam(tid, b, ctx) {
  if (!b || typeof b !== 'object' || !('member' in b)) return [400, { ok: false, message: 'give member: a conversation id, or null for no lead' }];
  const m = b.member === null ? null : memberId(b.member);
  if (b.member !== null && !m) return [400, { ok: false, message: 'member must be a conversation id, or null for no lead' }];
  return ctx.teams.lead(tid, m);
}
async function removeFromTeam(tid, b, ctx) {
  const m = memberId(b && b.member);
  if (!m) return [400, { ok: false, message: 'member must be a conversation id' }];
  return ctx.teams.remove(tid, m);
}
// POST /api/teams/:id/message { text, from? }: to every member but from (one removed from the map left out). With
// from, as from's message to each (sendMessage); without, after the team's line, as an order. Each one is resumed
// or queued as deliverText does.
async function messageTeam(tid, b, ctx, gone) {
  if (!b || typeof b !== 'object') return [400, { ok: false, message: 'bad json' }];
  const t = ctx.teams.get(tid);
  if (!t) return [404, { ok: false, message: 'no such team' }];
  const text = cleanText(b.text);
  if (!text) return [400, { ok: false, message: 'text must be text, without control characters other than new lines and tabs' }];
  let from = null;
  if (b.from != null) {
    from = memberId(b.from);
    if (!from) return [400, { ok: false, message: 'from must be your conversation id' }];
    from = (ctx.successorOf && ctx.successorOf(from)) || from;
  }
  const to = t.members.filter((m) => m !== from);
  if (!to.length) return [409, { ok: false, message: 'nobody else in the team to tell' }];
  const results = await Promise.all(to.map(async (m) => {
    let r;
    try {
      [, r] = from ? await sendMessage(m, { text, from }, ctx, gone)
        : await deliverText(m, `[Fleet View · team "${t.name}"]\n${text}`, { kind: 'order' }, ctx, gone);
    } catch (e) { r = { ok: false, message: e instanceof HostDown ? e.message : String((e && e.message) || e) }; }
    return { id: r.id || m, name: nameFor(r.id || m, ctx), ok: !!r.ok, ...(r.queued ? { queued: true } : {}), message: r.message || '' };
  }));
  const sent = results.filter((x) => x.ok && !x.queued).length, waiting = results.filter((x) => x.queued).length, bad = results.filter((x) => !x.ok);
  const message = [sent ? `sent to ${sent}` : '', waiting ? `queued for ${waiting}` : '',
    bad.length ? `not sent: ${bad.map((x) => `${x.name} (${x.message})`).join(', ')}` : ''].filter(Boolean).join(' · ');
  return [200, { ok: results.some((x) => x.ok), team: tid, results, message }];
}

// ---------- status: what conversations are doing, free ----------
// GET /api/status?team=<id> | ids=<id>,<id> | from=<id>: a team's members, these conversations, or from's team (none
// of them: every unfinished conversation not removed from the map), each as fleet-view.js's statusOf shows it, plus
// queued (text waits here for it, behind a menu). Nothing is typed into them: it costs them no turn.
async function readStatus(query, ctx) {
  const q = {};
  const team = query.get('team'), ids = query.get('ids'), from = query.get('from');
  if (team) {
    if (!/^t[0-9a-f]{6,16}$/.test(team)) return [400, { ok: false, message: 'not a team id (GET /api/teams lists them)' }];
    q.team = team;
  }
  if (ids) {
    q.ids = ids.split(',').map((s) => s.trim()).filter(Boolean).map(memberId);
    if (!q.ids.length || q.ids.length > 50 || q.ids.some((m) => !m)) return [400, { ok: false, message: 'ids must be 1 to 50 conversation ids, separated by commas' }];
  }
  if (from) {
    q.from = memberId(from);
    if (!q.from) return [400, { ok: false, message: 'from must be a conversation id' }];
  }
  const [code, out] = ctx.status(q);
  if (code !== 200) return [code, out];
  const waiting = new Set(queuedIds());
  return [200, { ...out, members: out.members.map((m) => ({ ...m, queued: waiting.has(m.id) })) }];
}

// ---------- asks: one question to several conversations, the answers collected for the asker ----------
// POST /api/ask { from, to?: [ids], team?, question, within? } types the question into each target as a message from
// `from` (queued behind a menu, resuming one not running, as deliverText does), then watches each one's turn after it
// landed, in the background (afterSend's reply collection; a queued one from when it goes in). When every target has
// answered or failed, or `within` seconds pass, ONE message with the answers is typed into `from`; an answer that
// comes after that is typed in on its own. GET /api/ask/:id?wait=s long-polls for the answers (fv ask --wait), and
// POST /api/ask/:id/collected says the asker has some already, so they are not typed in too. A target that could not
// be reached at all is in the POST's reply (asked), so it is not typed in again either.
// Asks live in this process's memory only: at most ASKS_MAX, each dropped ASK_KEEP_MS after it was asked (its
// watching stops then), and all lost when the server restarts (an update). That is fine: an asker that misses
// answers still has fv status and fv transcript.
const ASKS_MAX = 50, ASK_KEEP_MS = 2 * 3600e3, ASK_WITHIN_S = 600, ASK_REPLY_MAX = 3000, ASK_POLL_MAX_S = 600;
const ASK_GRACE_MS = 8000; // after a long poll ends: time for the asker to say it collected the answers, before any is typed
const ASK_MENU_MS = 2000; // while a target shows a question or a permission prompt: how often its screen is read
const asks = new Map(); // id -> ask (oldest first)
const settled = (x) => x.status === 'answered' || x.status === 'failed';
// text from a reply as it can be typed: \r\n made \n, no control characters but new line and tab
const typeable = (s) => String(s == null ? '' : s).replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ');
const askClip = (q) => { const s = String(q).replace(/\s+/g, ' ').trim(); return s.length > 80 ? s.slice(0, 79).trimEnd() + '…' : s; };
// what a GET shows of an ask
function askJson(a) {
  return { id: a.id, from: a.from, question: a.question, at: a.at, within: a.within, typed: a.typed,
    answers: a.targets.map((x) => ({ id: x.id, name: x.name, status: x.status, ...(x.at ? { at: x.at } : {}), ...(x.reply != null ? { reply: x.reply } : {}), ...(x.message ? { message: x.message } : {}) })) };
}
// one target's answer for the asker: its reply, clipped to ASK_REPLY_MAX with a pointer to the rest
function answerBody(x) {
  const r = typeable(x.reply).trim() || `(it replied with no text; fv transcript ${x.id} shows what it did)`;
  return r.length > ASK_REPLY_MAX ? `${r.slice(0, ASK_REPLY_MAX)}\n… (clipped: fv transcript ${x.id} for the rest)` : r;
}
// the lines for one target in the answers message -> [lines]
function answerLines(a, x) {
  const head = `── ${x.name} (${x.id}) · `;
  if (x.status === 'answered') {
    const ms = (x.at || Date.now()) - a.at;
    return [head + (ms < 60e3 ? 'answered within a minute' : `answered after ${Math.round(ms / 60e3)} min`), answerBody(x)];
  }
  if (x.status === 'failed') return [head + (x.reached ? `no answer: ${x.message}` : `not reached: ${x.message}`)];
  if (x.status === 'asking') return [head + `showing a question/permission prompt: ${x.message || 'a menu'}; it answers after the user does`];
  return [head + "not answered yet (still working); its answer comes by itself when it's done"];
}
// the one message with the answers (list: the targets it reports)
const summaryText = (a, list) => [`[Fleet View · answers to your question "${askClip(a.question)}"]`, ...list.flatMap((x) => answerLines(a, x))].join('\n');
// one answer that came after that message
function laterText(a, x) {
  if (x.status === 'answered') return `[Fleet View · ${x.name} (${x.id}) answered your question "${askClip(a.question)}"]\n${answerBody(x)}`;
  return `[Fleet View · ${x.name} (${x.id}) did not answer your question "${askClip(a.question)}": ${x.message}]`;
}
// wakes the long polls waiting on this ask
function wakeAsk(a) { const ws = [...a.waiters]; a.waiters.clear(); for (const f of ws) f(); }
function dropAsk(a) {
  a.dead = true;
  for (const t of [a.withinTimer, a.keepTimer, a.flushTimer]) clearTimeout(t);
  wakeAsk(a);
  asks.delete(a.id);
}
// types text into the asker (as Fleet View's, not a conversation's: queued behind a menu, resumed when not running);
// a.typeInto(text), when a test set one, takes it instead
function typeIntoAsker(a, text) {
  if (a.typeInto) return a.typeInto(text);
  // one open in a terminal outside Fleet View can't be typed into, and one removed from the map isn't brought back
  // for it: the answers stay in GET /api/ask/<id> (fv ask --wait prints them)
  const why = a.ctx.openElsewhere && a.ctx.openElsewhere(a.from) ? 'it is open in a terminal outside Fleet View'
    : a.ctx.isRemoved && a.ctx.isRemoved(a.from) ? 'it was removed from the map' : null;
  if (why) return a.ctx.log(`api: ask ${a.id}: the answers were not typed into ${a.from}: ${why}`);
  deliverText(a.from, text, { kind: 'message', queue: true, open: true }, a.ctx).then(([, r]) => {
    if (!r.ok) a.ctx.log(`api: ask ${a.id}: the answers could not be typed into ${a.from}: ${r.message}`);
  }, (e) => a.ctx.log(`api: ask ${a.id}: the answers could not be typed into ${a.from}: ${e.message}`));
}
// Types what is due into the asker: the answers message once every target has answered or failed (or within has
// passed), then each later answer on its own; never while a long poll waits on it (fv ask --wait prints them), nor
// in the ASK_GRACE_MS after one ended (the asker posts /collected then). With collected answers (an fv ask --wait
// that printed some), the message holds only the answers not collected, and no "not answered yet" lines: fv said
// those come later.
function flushAsk(a) {
  if (a.dead) return;
  clearTimeout(a.flushTimer);
  a.flushTimer = null;
  if (a.polling > 0) return; // the poll's end flushes again
  const wait = a.pollEnd + ASK_GRACE_MS - Date.now();
  if (wait > 0) { a.flushTimer = setTimeout(() => flushAsk(a), wait); return; }
  if (!a.typed) {
    if (!a.targets.every(settled) && Date.now() < a.at + a.within * 1000 - 50) return;
    a.typed = true;
    const list = a.targets.filter((x) => !x.collected && (!a.collectedAny || settled(x)));
    for (const x of list) if (settled(x)) x.told = true;
    if (list.length) typeIntoAsker(a, summaryText(a, list));
    return;
  }
  for (const x of a.targets) if (settled(x) && !x.collected && !x.told) { x.told = true; typeIntoAsker(a, laterText(a, x)); }
}
// a target answered (reply) or failed (message; reached: the question went in): recorded, and passed on when due
function settleAnswer(a, x, status, more) {
  if (a.dead || settled(x)) return;
  Object.assign(x, more, { status, at: Date.now() });
  if (status === 'answered' && a.ctx.noteMessage) a.ctx.noteMessage(x.id, a.from, typeable(x.reply), { kind: 'answer' });
  wakeAsk(a);
  flushAsk(a);
}
// what a menu that holds a target up is about, in a few words
const menuWhat = (m) => (m && m.title ? String(m.title).replace(/\s+/g, ' ').trim().slice(0, 120) : 'a menu');
// Watches one target's turn after its question went in (sentAt; before: its status then) until it replied: the
// same reply collection as a message's wait (afterSend). A question or a permission prompt mid-turn marks it
// 'asking' and is watched on the screen until the user answers it; then the turn goes on and is watched again.
async function watchAnswer(a, x, sentAt, before) {
  const gone = () => a.dead;
  x.status = 'waiting'; x.message = undefined; x.reached = true;
  wakeAsk(a);
  let cont = false;
  try {
    while (!a.dead) {
      const end = a.at + ASK_KEEP_MS;
      if (Date.now() >= end) return settleAnswer(a, x, 'failed', { message: 'it was still working 2 hours later, when Fleet View stopped watching it' });
      const w = await withHost((host) => afterSend(host, x.id, sentAt, before, end - sentAt, a.ctx, gone, { cont }));
      if (a.dead) return;
      if (!w.done) continue;
      if (w.endedBy === 'reply') return settleAnswer(a, x, 'answered', { reply: w.reply || '' });
      if (w.endedBy === 'apiError') return settleAnswer(a, x, 'failed', { message: 'its turn ended on an API error', ...(w.reply ? { reply: w.reply } : {}) });
      if (w.endedBy !== 'question' && w.endedBy !== 'menu') return settleAnswer(a, x, 'failed', { message: 'its session ended before it answered' });
      x.status = 'asking';
      x.message = w.menu ? menuWhat(w.menu) : askClip(w.question || 'a question');
      wakeAsk(a);
      for (;;) {
        await sleep(ASK_MENU_MS);
        if (a.dead || Date.now() >= end) break;
        const m = await withHost(async (host) => {
          const p = hosted(await host.call('list'), x.id);
          return !p || !p.alive ? 'gone' : menuNow(host, p);
        });
        if (m === 'gone') return settleAnswer(a, x, 'failed', { message: 'its session ended before it answered' });
        if (!m) break;
      }
      x.status = 'waiting'; x.message = undefined;
      wakeAsk(a);
      cont = true;
    }
  } catch (e) {
    settleAnswer(a, x, 'failed', { message: e instanceof HostDown ? e.message : `watching it failed: ${e.message}` });
  }
}
// Types the question into one target (deliverText) and starts watching it once it went in. -> { id, name, ok, queued?, message }
async function askOne(a, x, text) {
  let r;
  try {
    [, r] = await deliverText(x.id, text, {
      kind: 'message', from: a.from, original: a.question, ask: true, queue: true, open: true,
      onSent: (to, at, status) => {
        if (convId(to)) x.id = convId(to);
        watchAnswer(a, x, at, status).catch(() => {});
      },
      onDrop: (why) => settleAnswer(a, x, 'failed', { message: why }),
    }, a.ctx);
  } catch (e) { r = { ok: false, message: e instanceof HostDown ? e.message : String((e && e.message) || e) }; }
  if (!r.ok) {
    // the reply to the ask says so: not typed into the asker again
    x.collected = true;
    settleAnswer(a, x, 'failed', { message: r.message || 'not reached' });
  } else if (r.queued && !x.reached) {
    x.status = r.menu ? 'asking' : 'waiting';
    x.message = r.menu && typeof r.menu === 'object' ? menuWhat(r.menu) : undefined;
    wakeAsk(a);
  }
  return { id: r.id || x.id, name: x.name, ok: !!r.ok, ...(r.queued ? { queued: true } : {}), message: r.message || '' };
}
// POST /api/ask { from, to?: [ids], team?, question, within? (s, 30..3600, default 600) }
// -> { ok, ask: <id>, asked: [{ id, name, ok, queued?, message }], message }
async function postAsk(b, ctx) {
  if (!b || typeof b !== 'object') return [400, { ok: false, message: 'bad json' }];
  let from = typeof b.from === 'string' ? convId(b.from) : null;
  if (!from) return [400, { ok: false, message: 'from must be your conversation id' }];
  if (!ctx.whereIs(from).known && !ctx.sessionInfo(from)) return [400, { ok: false, message: 'from is not a conversation Fleet View knows' }];
  from = (ctx.successorOf && ctx.successorOf(from)) || from;
  const question = cleanText(b.question);
  if (!question) return [400, { ok: false, message: 'question must be text, without control characters other than new lines and tabs' }];
  let within = ASK_WITHIN_S;
  if (b.within != null) {
    if (!Number.isInteger(b.within) || b.within < 30 || b.within > 3600) return [400, { ok: false, message: 'within must be a number of seconds from 30 to 3600' }];
    within = b.within;
  }
  if (b.team == null && b.to == null) return [400, { ok: false, message: 'give to (conversation ids) or team' }];
  const ids = [];
  if (b.team != null) {
    if (typeof b.team !== 'string' || !/^t[0-9a-f]{6,16}$/.test(b.team)) return [400, { ok: false, message: 'not a team id (GET /api/teams lists them)' }];
    const t = ctx.teams.get(b.team);
    if (!t) return [404, { ok: false, message: 'no such team' }];
    ids.push(...t.members);
  }
  if (b.to != null) {
    const to = Array.isArray(b.to) ? b.to.map(memberId) : null;
    if (!to || !to.length || to.length > 20 || to.some((m) => !m)) return [400, { ok: false, message: 'to must be 1 to 20 conversation ids' }];
    ids.push(...to);
  }
  // one that handed off or ran /clear: the one that carries on; never the asker itself
  const targets = [...new Set(ids.map((m) => (ctx.successorOf && ctx.successorOf(m)) || m))].filter((m) => m !== from);
  if (!targets.length) return [409, { ok: false, message: 'nobody to ask (you cannot ask yourself)' }];
  const a = {
    id: 'a' + crypto.randomBytes(5).toString('hex'), from, question, at: Date.now(), within, ctx, typed: false, dead: false,
    collectedAny: false, polling: 0, pollEnd: 0, waiters: new Set(), withinTimer: null, keepTimer: null, flushTimer: null,
    targets: targets.map((id) => ({ id, name: headName(id, ctx), status: 'waiting', collected: false, told: false, reached: false })),
  };
  asks.set(a.id, a);
  while (asks.size > ASKS_MAX) dropAsk(asks.values().next().value);
  a.withinTimer = setTimeout(() => flushAsk(a), within * 1000);
  a.keepTimer = setTimeout(() => dropAsk(a), ASK_KEEP_MS);
  for (const t of [a.withinTimer, a.keepTimer]) if (t.unref) t.unref();
  // "your lead" for a target in a team the asker leads
  const name = headName(from, ctx);
  const text = (to) => {
    const t = ctx.teamOf ? ctx.teamOf(convId(to) || to) : null;
    const who = t && t.lead === from ? 'your lead ' : '';
    return `[Question from ${who}"${name}" (${from}) · answer it in your reply: Fleet View passes your reply back. Don't fv send it.]\n${question}`;
  };
  // this request counts as a poll while it types the questions (each waits up to TAKE_MS): an answer that comes
  // meanwhile waits for the asker's GET with wait (fv ask --wait starts it right after), or the grace after it
  a.polling++;
  let asked;
  try { asked = await Promise.all(a.targets.map((x) => askOne(a, x, text))); } finally {
    a.polling--;
    a.pollEnd = Date.now();
    flushAsk(a);
  }
  // the answers can't be typed into an asker open outside Fleet View (typeIntoAsker): fv ask --wait collects them
  const typedIn = !(ctx.openElsewhere && ctx.openElsewhere(from));
  const sent = asked.filter((x) => x.ok && !x.queued).length, waiting = asked.filter((x) => x.queued).length, bad = asked.filter((x) => !x.ok);
  const message = [sent ? `asked ${sent}` : '', waiting ? `queued for ${waiting}` : '',
    bad.length ? `not reached: ${bad.map((x) => `${x.name} (${x.message})`).join(', ')}` : ''].filter(Boolean).join(' · ');
  return [200, { ok: true, ask: a.id, asked, typedIn, message }];
}
// GET /api/ask/:id?wait=<s, up to 600>: the ask and its answers; with wait, once every target answered or failed,
// or wait passed. A wait running holds back typing the answers into the asker (flushAsk).
async function getAsk(aid, query, gone) {
  const a = asks.get(aid);
  if (!a) return [404, { ok: false, message: 'no such ask (asks are kept for 2 hours, and not across a Fleet View restart)' }];
  let wait = 0;
  if (query.has('wait')) {
    wait = Number(query.get('wait'));
    if (!Number.isInteger(wait) || wait < 0 || wait > ASK_POLL_MAX_S) return [400, { ok: false, message: `wait must be a number of seconds from 0 to ${ASK_POLL_MAX_S}` }];
  }
  if (wait && !a.targets.every(settled)) {
    a.polling++;
    try {
      for (const until = Date.now() + wait * 1000; !a.dead && !gone() && !a.targets.every(settled) && Date.now() < until;) {
        await new Promise((r) => {
          const done = () => { clearTimeout(t); r(); };
          const t = setTimeout(() => { a.waiters.delete(done); r(); }, Math.min(1000, Math.max(1, until - Date.now())));
          a.waiters.add(done);
        });
      }
    } finally {
      a.polling--;
      a.pollEnd = Date.now();
      if (!a.polling) flushAsk(a);
    }
  }
  return [200, { ok: true, ask: askJson(a) }];
}
// POST /api/ask/:id/collected { ids? }: the asker has these answers already (fv ask --wait printed them; no ids: every
// one answered or failed now), so they are not typed into it. Answers still to come are typed in as usual.
async function collectedAsk(aid, b) {
  const a = asks.get(aid);
  if (!a) return [404, { ok: false, message: 'no such ask (asks are kept for 2 hours, and not across a Fleet View restart)' }];
  let ids = null;
  if (b && b.ids != null) {
    if (!Array.isArray(b.ids) || b.ids.some((m) => !memberId(m))) return [400, { ok: false, message: 'ids must be conversation ids' }];
    ids = new Set(b.ids.map(memberId));
  }
  for (const x of a.targets) {
    if (ids ? !ids.has(x.id) : !settled(x)) continue;
    x.collected = true;
    a.collectedAny = true;
  }
  flushAsk(a);
  return [200, { ok: true, ask: askJson(a) }];
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
    const { p, err } = await need(host, key, false);
    if (err) return err;
    const out = { ok: true, ...describe(p, infoOf(p, ctx), ctx) };
    // the current turn, from the transcript: when its message went in and when it ended (ms, 0 when unknown)
    const ti = convId(p.id) ? ctx.turnInfo(convId(p.id)) : null;
    out.turn = ti ? { startedAt: ti.promptAt || null, endedAt: ti.turnOpen ? null : ti.turnEndT || null, open: ti.turnOpen } : null;
    if (tail) out.tail = plainText(await host.call('snapshot', p.id)).slice(-tail);
    return [200, out];
  });
}

// GET /api/sessions
async function listSessions(ctx) {
  return withHost(async (host) => {
    const list = await host.call('list');
    return [200, { ok: true, sessions: (list || []).map((p) => describe(p, infoOf(p, ctx), ctx)) }];
  });
}

// POST /api/sessions/:id/stop { remove? }: ends it (Ctrl+C, as the panel's close does); remove, or a temp session,
// also hides it from the map
async function stopSession(key, b, ctx) {
  if (!b || typeof b !== 'object') return [400, { ok: false, message: 'bad json' }];
  if ('remove' in b && typeof b.remove !== 'boolean') return [400, { ok: false, message: 'remove must be true or false' }];
  return withHost(async (host) => {
    const { p, err } = await need(host, key, false);
    if (err) return err;
    await host.call('kill', p.id);
    const id = convId(p.id);
    const removed = !!id && (b.remove === true || ctx.isTemp(id)) && ctx.hide(id);
    return [200, { ok: true, id: p.id, removed }];
  });
}

// POST /api/sessions/:id/remove: off the map (settings.hidden), for any conversation Fleet View knows, hosted or
// not; refused while it runs in the session host. Nothing on disk changes.
async function removeConversation(key, ctx) {
  const id = convId(resolveKey(key));
  if (!id) return [409, { ok: false, message: 'that session has no conversation id yet: stop it instead' }];
  let p = null;
  try { p = await withHost(async (host) => hosted(await host.call('list'), id)); } catch (e) { if (!(e instanceof HostDown)) throw e; }
  if (p && p.alive) return [409, { ok: false, id, alive: true, message: 'it is still running: stop it first (or stop it with remove: true)' }];
  if (!ctx.whereIs(id).known && !ctx.sessionInfo(id)) return [404, { ok: false, message: 'no such conversation' }];
  ctx.hide(id);
  return [200, { ok: true, id, removed: true }];
}

// GET /api/sessions/:id/menu
async function readMenu(key) {
  return withHost(async (host) => {
    const { p, err } = await need(host, key, false);
    if (err) return err;
    if (!p.alive) return [200, { ok: true, id: p.id, alive: false, menu: null }];
    return [200, { ok: true, id: p.id, alive: true, menu: await menuNow(host, p) }];
  });
}

// POST /api/sessions/:id/answer { option: n | "esc", sig?, text?, allowPermission?, wait? }
// The menu is read again first: none is 409, one whose sig differs from the caller's is 409 { stale, menu }. A
// menu other than a question (a tool's permission prompt, the folder trust question, the plan approval, one not
// recognised) is answered only with allowPermission: an orchestrator must never approve a tool call by accident. option "esc" presses Esc once (it cancels the menu). text goes with
// an AskUserQuestion's "Type something." option: its number, then the text pasted, then Enter. Any other option
// is its digit (Claude Code picks it at once), or ↑/↓ to it and Enter past 9. Then up to ANSWER_MS for the menu to
// change; with wait, once no menu is left, the turn is waited on like a message's.
async function answerMenu(key, b, ctx, gone) {
  if (!b || typeof b !== 'object') return [400, { ok: false, message: 'bad json' }];
  const esc = b.option === 'esc';
  if (!esc && !(Number.isInteger(b.option) && b.option >= 1 && b.option <= 99)) return [400, { ok: false, message: 'option must be an option\'s number or "esc"' }];
  if (b.sig != null && typeof b.sig !== 'string') return [400, { ok: false, message: 'sig must be the menu\'s sig, as GET .../menu gave it' }];
  if ('allowPermission' in b && typeof b.allowPermission !== 'boolean') return [400, { ok: false, message: 'allowPermission must be true or false' }];
  let text = null;
  if (b.text != null) {
    text = cleanText(b.text);
    if (!text) return [400, { ok: false, message: 'text must be text, without control characters other than new lines and tabs' }];
    if (esc) return [400, { ok: false, message: 'text goes with a "Type something." option, not esc' }];
    // a new line there would go in as Alt+Enter, inside the question's one-line answer: join the lines
    text = text.split(/\s*\n\s*/).filter(Boolean).join(' ');
  }
  const ms = waitMs(b.wait);
  if (ms === null) return [400, { ok: false, message: WAIT_BAD }];
  return withHost(async (host) => {
    const { p, err } = await need(host, key, true);
    if (err) return err;
    const m = await menuNow(host, p);
    if (!m) return [409, { ok: false, id: p.id, menu: false, message: 'no menu is up' }];
    if (b.sig != null && b.sig !== m.sig) return [409, { ok: false, id: p.id, stale: true, menu: m, message: 'the menu changed since you read it: read it again' }];
    // fail closed: only a question is answered without it. A permission prompt, the folder trust question, the plan
    // approval (its options turn on auto-accept or bypass) and any menu not recognised all need allowPermission;
    // Esc (deny, cancel) never does
    if (!esc && m.kind !== 'question' && b.allowPermission !== true) {
      const what = { permission: 'a permission prompt', trust: 'the folder trust question', plan: 'the plan approval' }[m.kind] || 'not a question';
      return [403, { ok: false, id: p.id, menu: m, message: `that is ${what}: only a question may be answered without allowPermission (Esc is always allowed)` }];
    }
    let answered;
    if (esc) {
      await host.call('write', p.id, '\x1b');
      answered = 'esc';
    } else {
      const opt = m.options.find((o) => o.n === b.option);
      if (!opt) return [400, { ok: false, id: p.id, menu: m, message: `no option ${b.option}: the menu has ${m.options.map((o) => o.n).join(', ')}` }];
      const typed = /^Type something/i.test(opt.label);
      if (text && !typed) return [400, { ok: false, id: p.id, menu: m, message: 'text goes only with a "Type something." option' }];
      if (typed && !text) return [400, { ok: false, id: p.id, menu: m, message: 'that option takes text: pass text' }];
      if (opt.n <= 9) await host.call('write', p.id, String(opt.n));
      else {
        // two digits would pick the first at once: move the pointer instead, then Enter
        const on = m.options.find((o) => o.on) || m.options[0];
        const d = opt.n - on.n;
        if (d) await host.call('write', p.id, (d > 0 ? '\x1b[B' : '\x1b[A').repeat(Math.abs(d)));
        await sleep(ENTER_DELAY_MS);
        const again = await menuNow(host, p);
        if (!again || again.title !== m.title || again.options.map((o) => o.label).join('\n') !== m.options.map((o) => o.label).join('\n') || !again.options.some((o) => o.n === opt.n && o.on)) return [409, { ok: false, id: p.id, menu: again, message: 'the pointer did not reach that option: nothing was picked' }];
        await host.call('write', p.id, '\r');
      }
      if (typed) {
        // the free answer: its box opened on the number. Only into the question still up: with no menu there the
        // paste would land in the prompt box and the Enter would send it as a message (fail closed)
        await sleep(TYPE_DELAY_MS);
        const notQuestion = async () => { const x = await menuNow(host, p); return !x || x.kind !== 'question'; };
        if (await notQuestion()) return [409, { ok: false, id: p.id, menu: await menuNow(host, p), message: 'the question is no longer up after picking that option: the text was not typed' }];
        const sent = await sendText(host, p.id, text, notQuestion);
        if (!sent.entered) return [409, { ok: false, id: p.id, message: 'the question went away before Enter: the text was pasted (it may sit in its prompt box) but not sent' }];
      }
      answered = { n: opt.n, label: opt.label };
    }
    const at = Date.now();
    let next = m;
    for (const end = at + ANSWER_MS; Date.now() < end;) {
      await sleep(POLL_MS / 2);
      const q = hosted(await host.call('list'), p.id);
      if (!q || !q.alive) { next = null; break; }
      next = await menuNow(host, q);
      if (!next || next.sig !== m.sig) break;
    }
    const changed = !next || next.sig !== m.sig;
    const out = { ok: true, id: p.id, answered, changed, next };
    if (!ms) return [200, { ...out, message: changed ? 'answered' : 'answered, but the menu has not changed yet' }];
    if (!changed) return [200, { ...out, done: false, message: 'answered, but the answer did not register: the menu is unchanged' }];
    // another menu (the next question, the submit step): that is where it waits now
    if (next) return [200, { ...out, done: true, ...menuEnd(next, ctx.turnInfo(p.id), at - SKEW_MS), message: 'answered; another menu is up' }];
    const w = await afterSend(host, p.id, at, null, ms, ctx, gone, { cont: true });
    return [200, { ...out, ...w, message: doneText(w, ms, 'answered') }];
  });
}

// POST /api/sessions/:id/wait { timeout? }: sends nothing; waits until the session is ready for you. At once when it
// is idle with its turn closed and no menu up; else until Claude replies, asks (a question, or any menu), errors,
// or the session ends. Idle IDLE_ENDS_MS in a row ends it too (a turn the transcript never closed, like one cut
// off with Esc).
async function waitSession(key, b, ctx, gone) {
  if (!b || typeof b !== 'object') return [400, { ok: false, message: 'bad json' }];
  let s = WAIT_DEFAULT_S;
  if (b.timeout !== undefined) {
    if (!Number.isInteger(b.timeout) || b.timeout < 1 || b.timeout > WAIT_MAX_S) return [400, { ok: false, message: `timeout must be a number of seconds from 1 to ${WAIT_MAX_S}` }];
    s = b.timeout;
  }
  return withHost(async (host) => {
    const { p: p0, err } = await need(host, key, false);
    if (err) return err;
    const id = p0.id;
    const start = Date.now();
    let idleAt = 0, menuAt = 0;
    const done = (w) => [200, { ok: true, id, done: true, ...w, waited: Math.round((Date.now() - start) / 1000) }];
    for (let first = true; Date.now() - start < s * 1000; first = false) {
      if (gone()) return [200, { ok: true, id, done: false, message: 'stopped waiting' }];
      const p = first ? p0 : hosted(await host.call('list'), id);
      if (!p) return done({ endedBy: 'gone' });
      const ti = convId(id) ? ctx.turnInfo(convId(id)) : null;
      if (!p.alive) return done({ endedBy: 'exit', reply: ti ? ti.lastReply || null : null });
      if (first || Date.now() - menuAt >= MENU_EVERY_MS) {
        menuAt = Date.now();
        const m = await menuNow(host, p);
        if (m) return done(menuEnd(m, ti));
      }
      if (ti && ti.asking && p.status !== 'busy') {
        const m = await menuNow(host, p);
        return done({ endedBy: 'question', question: ti.askText, reply: ti.lastReply || null, ...(m ? { menu: m } : {}) });
      }
      if (ti && ti.apiError && !ti.turnOpen && p.status !== 'busy') return done({ endedBy: 'apiError', reply: ti.lastReply || null });
      const quiet = p.status === 'idle';
      idleAt = quiet ? idleAt || Date.now() : 0;
      if (quiet && (!ti || !ti.turnOpen)) return done({ endedBy: first ? 'idle' : 'reply', reply: ti ? ti.lastReply || null : null });
      if (quiet && Date.now() - idleAt >= IDLE_ENDS_MS) return done({ endedBy: 'reply', reply: ti ? ti.lastReply || null : null });
      await sleep(POLL_MS);
    }
    return [200, { ok: true, id, done: false, timedOut: true, message: `still not ready after ${s} s` }];
  });
}

// POST /api/sessions/:id/interrupt: Esc once, as a person stops Claude mid-turn. Not while a menu is up (the Esc
// would answer it: use answer { option: "esc" }), and only while it works.
async function interruptSession(key) {
  return withHost(async (host) => {
    const { p, err } = await need(host, key, true);
    if (err) return err;
    const m = await menuNow(host, p);
    if (m) return [409, { ok: false, id: p.id, menu: m, message: 'a menu is up, and Esc would answer it: use answer with option "esc"' }];
    if (p.status !== 'busy') return [409, { ok: false, id: p.id, status: p.status || null, message: 'Claude is not working on anything' }];
    await host.call('write', p.id, '\x1b');
    return [200, { ok: true, id: p.id }];
  });
}

// POST /api/sessions/:id/open { account?, prompt?, wait? }: a conversation Fleet View knows (its log on disk) resumed
// as a hosted session (claude --resume, the host's open), in its last folder under its account, as the panel's Open
// does; it must be in a folder a new session could start in. Then up to START_MS for it to be idle; with prompt,
// that goes in as message's text does.
async function openSession(key, b, ctx, gone) {
  if (!b || typeof b !== 'object') return [400, { ok: false, message: 'bad json' }];
  const id = convId(resolveKey(key));
  if (!id) return [400, { ok: false, message: 'give a conversation id' }];
  if (b.account != null && !acctOk(b.account, ctx)) return [400, { ok: false, message: `account must be one of ${acctsOf(ctx).join(', ')}` }];
  let prompt = null;
  if (b.prompt != null) {
    prompt = cleanText(b.prompt);
    if (!prompt) return [400, { ok: false, message: 'prompt must be text, without control characters other than new lines and tabs' }];
  }
  const ms = waitMs(b.wait);
  if (ms === null) return [400, { ok: false, message: WAIT_BAD }];
  const where = resumable(id, ctx);
  if (where.err) return where.err;
  return withHost(async (host) => {
    const r = await resumeIn(host, id, where, b.account, ctx, gone);
    if (r.err) return r.err;
    const { p, alreadyRunning } = r;
    if (r.stopped) return [200, { ok: true, id, alreadyRunning, ready: false, message: 'stopped waiting' }];
    const ready = r.ready;
    if (!prompt) return [200, { ok: true, id, alreadyRunning, ready, status: p.status || null, message: alreadyRunning ? 'it was already running' : ready ? 'opened; Claude is idle' : 'opened, but it is not idle yet' }];
    if (!ready && !alreadyRunning) return [200, { ok: false, id, alreadyRunning, ready, promptSent: false, message: `opened, but it was not idle within ${START_MS / 1000} s; the prompt was not sent` }];
    if (!alreadyRunning) await sleep(SETTLE_MS);
    const [code, out] = await deliver(host, p, prompt, ms, ctx, gone, null, { alreadyRunning, ready });
    return [code, { ...out, promptSent: !!out.ok }];
  });
}

// GET /api/sessions/:id/transcript?since=<n>&limit=<m>: any conversation Fleet View knows, hosted or not
async function readTranscript(key, query, ctx) {
  const id = convId(resolveKey(key));
  if (!id) return [400, { ok: false, message: 'give a conversation id' }];
  const q = {};
  for (const k of ['since', 'limit']) {
    if (!query.has(k)) continue;
    const n = Number(query.get(k));
    if (!Number.isInteger(n) || n < (k === 'limit' ? 1 : 0)) return [400, { ok: false, message: `${k} must be a whole number${k === 'limit' ? ' from 1' : ''}` }];
    q[k] = n;
  }
  let t;
  try { t = await ctx.transcript(id, q); } catch { t = null; }
  if (!t) return [404, { ok: false, message: 'no such conversation (its log is not on disk)' }];
  return [200, { ok: true, id, ...t }];
}

// GET /api/conversations?state=&repo=&all=1&limit=: every conversation Fleet View shows, hosted or not
async function listConversations(query, ctx) {
  let limit = 100;
  if (query.has('limit')) {
    limit = Number(query.get('limit'));
    if (!Number.isInteger(limit) || limit < 1) return [400, { ok: false, message: 'limit must be a whole number from 1' }];
    limit = Math.min(1000, limit);
  }
  const state = query.get('state') || null;
  if (state && !/^[A-Za-z]{2,20}$/.test(state)) return [400, { ok: false, message: 'state must be a state name like WORKING, ASKING, IDLE or DONE' }];
  const repo = query.get('repo') || null;
  if (repo && repo.length > 1024) return [400, { ok: false, message: 'repo is too long' }];
  const all = /^(?:1|true|yes)$/i.test(query.get('all') || '');
  const rows = ctx.conversations({ state, repo, all, limit });
  // which ones the desktop app hosts (none when it is not running)
  let list = null;
  try { list = await withHost((host) => host.call('list')); } catch (e) { if (!(e instanceof HostDown)) throw e; }
  const byId = new Map((Array.isArray(list) ? list : []).filter((p) => p && convId(p.id)).map((p) => [convId(p.id), p]));
  const conversations = rows.map((r) => {
    const p = byId.get(r.id);
    const { openElsewhere, ...rest } = r;
    return { ...rest, hosted: !!p, alive: !!(p && p.alive) || !!openElsewhere, status: p && p.alive ? p.status || null : null };
  });
  return [200, { ok: true, hostRunning: list !== null, conversations }];
}

// ---------- routing ----------
// ctx: { sendJson, readBody, log, UNSAFE_PATH, allowedFolders() -> the folder paths a new session may start in,
//        sessionInfo(id) -> the conversation as /state shows it, or null,
//        turnInfo(id) -> { promptAt, turnEndT, turnOpen, asking, askAt, askText, apiError, errAt, lastReply }, or null,
//        nameOf(id) -> a conversation's name or null, noteMessage(from, to, text, { kind }?) -> records a message
//        between two, rename(id, name) -> [code, json], hide(id) -> off the map, markTemp(id), isTemp(id),
//        conversations({ state, repo, all, limit }) -> [row], transcript(id, { since, limit }) -> Promise,
//        whereIs(id) -> { known, cwd, account }, successorOf(id) -> the one that carries on or null,
//        openElsewhere(id) -> open in a claude outside Fleet View, isRemoved(id) -> removed from the map, teamOf(id) -> { id, name, lead, members } or null,
//        teams: { list(), get(id) -> { id, name, lead, members } or null, make(b), add(id, member, lead),
//        remove(id, member), lead(id, member | null), disband(id) } each -> [code, json] or a Promise of one,
//        status({ team, ids, from }) -> [code, json] }
const VERBS = 'message|stop|remove|menu|answer|wait|interrupt|open|transcript';
const GET_VERBS = new Set(['menu', 'transcript']);
const ROUTE = new RegExp(`^/api/sessions(?:/([^/]+))?(?:/(${VERBS}))?$`);
const TEAM_ROUTE = /^\/api\/teams(?:\/([^/]+))?(?:\/(add|remove|lead|disband|message))?\/?$/;
const ASK_ROUTE = /^\/api\/ask(?:\/([^/]+))?(?:\/(collected))?\/?$/;
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
  // a POST's body: {} when there is none
  const body = (fn) => ctx.readBody(req, res, (b) => run(fn(b)));
  if (req.headers.origin !== undefined) return answer([403, { ok: false, message: 'the API is for local scripts, not web pages' }]);
  if (!authorized(req)) return answer([401, { ok: false, message: 'missing or wrong API token' }]);
  const query = () => new URL(req.url, 'http://x').searchParams;
  if (pathname === '/api' || pathname === '/api/') {
    return req.method === 'GET' ? answer(describeApi()) : answer([405, { ok: false, message: 'method not allowed' }]);
  }
  if (pathname === '/api/conversations') {
    return req.method === 'GET' ? run(listConversations(query(), ctx)) : answer([405, { ok: false, message: 'method not allowed' }]);
  }
  const tm = TEAM_ROUTE.exec(pathname);
  if (tm) {
    const [, tid, tverb] = tm;
    if (tid && !/^t[0-9a-f]{6,16}$/.test(tid)) return answer([400, { ok: false, message: 'not a team id (GET /api/teams lists them)' }]);
    if (req.method === 'GET' && !tid) return answer(ctx.teams.list());
    if (req.method !== 'POST' || (tid && !tverb) || (!tid && tverb)) return answer([405, { ok: false, message: 'method not allowed' }]);
    if (!tid) return body((b) => makeTeam(b, ctx));
    if (tverb === 'add') return body((b) => addToTeam(tid, b, ctx));
    if (tverb === 'remove') return body((b) => removeFromTeam(tid, b, ctx));
    if (tverb === 'lead') return body((b) => leadTeam(tid, b, ctx));
    if (tverb === 'disband') return run(Promise.resolve(ctx.teams.disband(tid)));
    return body((b) => messageTeam(tid, b, ctx, gone));
  }
  if (pathname === '/api/status' || pathname === '/api/status/') {
    return req.method === 'GET' ? run(readStatus(query(), ctx)) : answer([405, { ok: false, message: 'method not allowed' }]);
  }
  const am = ASK_ROUTE.exec(pathname);
  if (am) {
    const [, aid, averb] = am;
    if (aid && !/^a[0-9a-f]{10}$/.test(aid)) return answer([400, { ok: false, message: 'not an ask id' }]);
    if (!aid && req.method === 'POST') return body((b) => postAsk(b, ctx));
    if (aid && !averb && req.method === 'GET') return run(getAsk(aid, query(), gone));
    if (aid && averb && req.method === 'POST') return body((b) => collectedAsk(aid, b));
    return answer([405, { ok: false, message: 'method not allowed' }]);
  }
  const m = ROUTE.exec(pathname);
  if (!m) return answer([404, { ok: false, message: 'not found (GET /api lists the endpoints)' }]);
  const [, key, verb] = m;
  if (key && !H.KEY_RE.test(key)) return answer([400, { ok: false, message: 'not a session id' }]);
  if (verb && !key) return answer([404, { ok: false, message: 'not found' }]);
  const k = key && H.ID_RE.test(key) ? key.toLowerCase() : key;
  if (req.method === 'GET') {
    if (!verb) return key ? run(readSession(k, query(), ctx)) : run(listSessions(ctx));
    if (verb === 'menu') return run(readMenu(k));
    if (verb === 'transcript') return run(readTranscript(k, query(), ctx));
    return answer([405, { ok: false, message: 'method not allowed' }]);
  }
  if (req.method === 'POST' && !GET_VERBS.has(verb)) {
    if (!key) return body((b) => startSession(b, ctx, gone));
    switch (verb) {
      case 'message': return body((b) => sendMessage(k, b, ctx, gone));
      case 'stop': return body((b) => stopSession(k, b, ctx));
      case 'remove': return run(removeConversation(k, ctx));
      case 'answer': return body((b) => answerMenu(k, b, ctx, gone));
      case 'wait': return body((b) => waitSession(k, b, ctx, gone));
      case 'interrupt': return run(interruptSession(k));
      case 'open': return body((b) => openSession(k, b, ctx, gone));
      default: break;
    }
  }
  return answer([405, { ok: false, message: 'method not allowed' }]);
}

// askParts: the ask's text builders and collection steps, for a test to drive without a session host
module.exports = { ensureToken, handle, hostList, plainText, cleanText, pasteWrites, deliverText, startQueue, queuedIds, TOKEN_FILE, ENDPOINTS,
  askParts: { asks, summaryText, laterText, answerLines, flushAsk, settleAnswer, askJson } };
