// Fleet View automation API: lets a local script (or a Claude Code session, through scripts/fv.js) start Claude
// Code sessions, send them messages, wait for them, read and answer their menus, read any conversation's
// transcript, and stop and clear away what it started, through the live sessions the desktop app's session host
// (desktop/host.js) already runs. fleet-view.js hands every /api request here (see handle()). GET /api lists the
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
// as asked. note(id): called once it went in. -> [code, json]
async function deliver(host, p, text, ms, ctx, gone, note, extra = {}) {
  // a panel left open (like /usage) would take the text: one a "/" command opened is closed first
  const shut = await closePanel(host, p);
  if (shut.err) return [409, { ok: false, id: p.id, ...extra, panel: true, message: shut.err }];
  // the status before it was sent: busy means Claude was mid-turn, and the message is queued behind it
  const status = shut.p.status || null;
  // a permission prompt, a question or the plan approval: the Enter would answer it for that session
  const m = await menuNow(host, p);
  if (m) return [409, { ok: false, id: p.id, ...extra, menu: m, message: MENU_UP }];
  const sentAt = Date.now();
  const sent = await sendText(host, p.id, text, () => menuNow(host, p));
  if (!sent.entered) return [409, { ok: false, id: p.id, ...extra, menu: true, message: MENU_LATE }];
  if (note) note(p.id);
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

// ---------- the requests ----------
// GET /api: what there is, for a caller (or a Claude) finding its way from the command line
const ENDPOINTS = [
  { method: 'GET', path: '/api', does: 'this list' },
  { method: 'GET', path: '/api/conversations', query: 'state?, repo?, all?=1, limit?', does: 'every conversation Fleet View shows (not only hosted): id, name, state, repo, branch, lastReply, hosted, alive' },
  { method: 'GET', path: '/api/sessions', does: 'the sessions the desktop app hosts, with status and latest reply' },
  { method: 'POST', path: '/api/sessions', body: '{ repo, account: "A"|"B"|"C"…, prompt, name?, model?, effort?, forkFrom?, temp?, chrome?, wait? }', does: 'start a session in a repo (forkFrom: carrying a conversation\'s history), set its name/model/effort, send the prompt; temp: hidden from the map once it ends' },
  { method: 'GET', path: '/api/sessions/:id', query: 'tail?', does: 'one hosted session: status, state, latest reply, its turn; tail: the last characters of its screen' },
  { method: 'POST', path: '/api/sessions/:id/message', body: '{ text, wait?, from? }', does: 'send a message (refused while a menu is up); wait: until the turn ends' },
  { method: 'POST', path: '/api/sessions/:id/wait', body: '{ timeout? (s, default 1800) }', does: 'wait, sending nothing, until it is ready for you: endedBy idle | reply | question | menu | apiError | exit | gone' },
  { method: 'GET', path: '/api/sessions/:id/menu', does: 'the select menu on its screen now: kind (question|permission|plan|trust|other), title, context, options, sig; or null' },
  { method: 'POST', path: '/api/sessions/:id/answer', body: '{ option: n | "esc", sig?, text?, allowPermission?, wait? }', does: 'answer the menu (text: for a "Type something." option); any menu but a question needs allowPermission (esc never does)' },
  { method: 'POST', path: '/api/sessions/:id/interrupt', does: 'press Esc once to stop Claude mid-turn (not while a menu is up)' },
  { method: 'POST', path: '/api/sessions/:id/open', body: '{ account?, prompt?, wait? }', does: 'resume a conversation Fleet View knows as a hosted session; prompt: then send it' },
  { method: 'GET', path: '/api/sessions/:id/transcript', query: 'since?, limit? (default the last 50, at most 500)', does: 'any conversation\'s transcript, compact: user, assistant, tool (name, input, result), note, thinking' },
  { method: 'POST', path: '/api/sessions/:id/stop', body: '{ remove? }', does: 'end the session (remove: also hide it from the map)' },
  { method: 'POST', path: '/api/sessions/:id/remove', does: 'hide a conversation from the map (not one still running: stop it first); logs are kept' },
];
function describeApi() {
  return [200, { ok: true, version: 2, auth: 'Authorization: Bearer <%LOCALAPPDATA%\\fleet-view\\api-token>', endpoints: ENDPOINTS,
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

// POST /api/sessions/:id/message { text, wait?, from? }
// from: the conversation id of the sender, when one conversation messages another (scripts/fleet-msg.js). The
// text then goes in after a line saying who it is from, and the server records it (its team's messages, the
// feed, an alert when the two share no team).
const FROM_RE = /^[\w.-]{1,80}$/;
async function sendMessage(key, b, ctx, gone) {
  let text = cleanText(b && b.text);
  if (!text) return [400, { ok: false, message: 'text must be text, without control characters other than new lines and tabs' }];
  const ms = waitMs(b.wait);
  if (ms === null) return [400, { ok: false, message: WAIT_BAD }];
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
    const { p, err } = await need(host, key, true);
    if (err) return err;
    if (from && p.id.toLowerCase() === from.toLowerCase()) return [400, { ok: false, message: 'a conversation cannot message itself' }];
    const note = from && ctx.noteMessage ? (id) => ctx.noteMessage(from, convId(id) || id, original) : null;
    return deliver(host, p, text, ms, ctx, gone, note);
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
  const where = ctx.whereIs(id);
  if (!where.known) return [404, { ok: false, message: 'no such conversation (its log is not on disk)' }];
  const cwd = where.cwd;
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || ctx.UNSAFE_PATH.test(cwd)) return [409, { ok: false, id, message: 'Fleet View does not know which folder that conversation worked in' }];
  // inside a folder a new session may start in (its repo, or a checkout of it)
  const dir = H.normDir(cwd);
  const allowed = ctx.allowedFolders().map(H.normDir).some((f) => dir === f || dir.startsWith(f.endsWith(path.sep) ? f : f + path.sep));
  if (!allowed) return [403, { ok: false, id, message: `its folder is not in a repo Fleet View lists: ${cwd}` }];
  let isDir = false;
  try { isDir = fs.statSync(cwd).isDirectory(); } catch {}
  if (!isDir) return [409, { ok: false, id, message: `its folder is gone: ${cwd}` }];
  return withHost(async (host) => {
    let p = hosted(await host.call('list'), id);
    let alreadyRunning = !!(p && p.alive);
    if (!alreadyRunning) {
      const r = await host.call('open', { id, cwd, account: b.account || where.account || 'B' });
      if (!r || !r.ok) return [502, { ok: false, id, message: (r && r.message) || 'the session host could not open it' }];
      if (r.message === 'already running') alreadyRunning = true; // it started meanwhile
    }
    // ready: idle (a resumed claude says busy while it loads); one already running is taken as it is (a message
    // to a busy one is queued, as message does)
    const until = Date.now() + START_MS;
    for (;;) {
      p = hosted(await host.call('list'), id);
      if (!p || !p.alive) return [502, { ok: false, id, alreadyRunning, message: `the session ended before it was ready${p ? ` (code ${p.exitCode})` : ''}` }];
      if (alreadyRunning || p.status === 'idle' || Date.now() >= until) break;
      if (gone()) return [200, { ok: true, id, alreadyRunning, ready: false, message: 'stopped waiting' }];
      await sleep(POLL_MS);
    }
    const ready = p.status === 'idle';
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
//        nameOf(id) -> a conversation's name or null, noteMessage(from, to, text) -> records a message between two,
//        rename(id, name) -> [code, json], hide(id) -> off the map, markTemp(id), isTemp(id),
//        conversations({ state, repo, all, limit }) -> [row], transcript(id, { since, limit }) -> Promise,
//        whereIs(id) -> { known, cwd, account } }
const VERBS = 'message|stop|remove|menu|answer|wait|interrupt|open|transcript';
const GET_VERBS = new Set(['menu', 'transcript']);
const ROUTE = new RegExp(`^/api/sessions(?:/([^/]+))?(?:/(${VERBS}))?$`);
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

module.exports = { ensureToken, handle, hostList, plainText, cleanText, pasteWrites, TOKEN_FILE, ENDPOINTS };
