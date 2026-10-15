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
// (web/term.js): one per line, in pieces of at most PASTE_MAX characters, the lines joined by Ctrl+J (a new
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
const net = require('net');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
// requiring it only defines functions (runHost runs only when host.js is the main module, the pty module
// loads on first use), so the server gets the same pipe name and host.json path the window uses
const H = require(path.join(__dirname, 'desktop', 'host.js'));
const SCREEN = require(path.join(__dirname, 'screen.js'));
const VERSION = require(path.join(__dirname, 'version.js'));
const OVERSEER = require(path.join(__dirname, 'overseer.js'));
const ACCOUNTS = require(path.join(__dirname, 'accounts.js'));
const TT = require(path.join(__dirname, 'team-tree.js'));
const LAUNCH = require(path.join(__dirname, 'launch.js'));

const P = require(path.join(__dirname, 'platform.js'));
const DATA_DIR = P.dataDir();
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
const TRUST_NEXT_MS = 6000; // after the folder trust question was answered Yes: how long to watch for the Claude in Chrome offer
const TYPE_DELAY_MS = 300; // after pressing "Type something.", before its text goes in
const POINT_MS = 1500; // how long a moved pointer (or a typed answer) may take to show on the screen
const FREE_EMPTY = /^(?:type something\.?|other)$/i; // "Type something" with nothing typed in it
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
  // (macOS and Linux: readable by the user alone)
  fs.writeFileSync(TOKEN_FILE, t + '\n', P.isWin ? undefined : { mode: 0o600 });
  token = t;
}
function authorized(req) {
  if (!token) return false;
  const m = /^Bearer\s+([0-9a-f]{64})\s*$/i.exec(String(req.headers.authorization || ''));
  if (!m) return false;
  const given = Buffer.from(m[1].toLowerCase()), want = Buffer.from(token);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

// ---------- Henry's phone ----------
// Text sent to a session with no "from" reads like the user's own words, and every Claude session here can read the
// token. So for an overseer (a bot: isOverseer below; overseer.js frame) such text counts as Henry's only
// when it comes from the phone relay
// (relay.js, inside this server), which marks what Henry sent from his paired phone with "via": "phone" in the body
// AND the header X-Fleet-View-Relay: <relayKey()>. The key is made when this process starts and kept in memory only
// (never on disk, logged or served); fleet-view.js hands it to the relay. A caller that only has the token can't
// know it, so its "via": "phone" counts for nothing.
const RELAY_KEY = crypto.randomBytes(32).toString('hex');
const relayKey = () => RELAY_KEY;
// -> 'henry' for the relay's own requests, else null
function viaOf(req, b) {
  if (!b || typeof b !== 'object' || b.via !== 'phone') return null;
  const given = Buffer.from(String((req && req.headers && req.headers['x-fleet-view-relay']) || '')), want = Buffer.from(RELAY_KEY);
  return given.length === want.length && crypto.timingSafeEqual(given, want) ? 'henry' : null;
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
// end a hosted session (the host's kill: Ctrl+C twice, then the process tree; it is not resumed after a restart).
// For sync's mover (sync-move.js, through sync-run.js's host option); rejects when the host is not running
function hostKill(id) {
  return withHost((host) => host.call('kill', id));
}
// move a hosted conversation to another account at its pause (the host's switchAccount: the same conversation, resumed
// there; rescue: told "continue"). For fleet-view.js's account switching (account-switch.js); rejects when the host is
// not running, or is older than switchAccount ("unknown op")
function hostSwitch(id, account, rescue) {
  return withHost((host) => host.call('switchAccount', { id, account, rescue: rescue === true }));
}

// ---------- helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// a new session's key once it has its id: kept so a caller can still use the key create gave it
const keyToId = new Map(); // 'new-<n>' -> id
const resolveKey = (k) => keyToId.get(k) || k;
const keyOf = (id) => { for (const [k, v] of keyToId) if (v === id) return k; return null; };
const convId = (id) => (H.ID_RE.test(String(id || '')) ? String(id).toLowerCase() : null);
// the role the session host knows: the bots ('bot:<id>', bots.js) oversee the others for Henry, so what reaches them
// is framed by where it came from (overseer.js frame) wherever it is typed
const isBotRole = (role) => typeof role === 'string' && H.BOT_ROLE_RE.test(role);
const isOverseer = isBotRole;

// invisible format characters (zero-width spaces, word joiners, bidi marks, tag characters, a BOM), but not a
// zero-width joiner inside an emoji sequence: they hide what a line says, and they would let a line slip past a
// bot's mark check (overseer.js fold looks through them too)
const INVISIBLE = /(?<!\p{Extended_Pictographic}\ufe0f?)\u200d|\u200d(?!\p{Extended_Pictographic})|(?!\u200d)\p{Cf}/gu;
// the text as it goes into the prompt: \r\n and the other line breaks (U+0085, U+2028, U+2029) made \n, invisible
// format characters dropped, then nothing but printable text, \n and \t
function cleanText(v) {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\r\n|[\u0085\u2028\u2029]/g, '\n').replace(INVISIBLE, '');
  if (!t.trim() || BAD_CHARS.test(t)) return null;
  return t;
}
// the writes that type text into Claude Code's prompt as the user's own (see the top): each line pasted in pieces
// of at most PASTE_MAX characters (never splitting a surrogate pair), Ctrl+J (a line feed: a new line in the
// prompt) between lines. A text ending in "\" gets a space after it: Claude Code takes "\" then Enter as a new
// line, so the Enter would leave the message unsent. typePasted writes them. Kept in step with web/term.js
// pasteWrites and typeInto.
const PASTE_MAX = 400;
function pasteWrites(text) {
  const out = [];
  String(text).replace(/\\$/, '\\ ').split('\n').forEach((line, x) => {
    if (x) out.push('\n');
    for (let i = 0; i < line.length;) {
      let j = Math.min(line.length, i + PASTE_MAX);
      if (j < line.length && /[\ud800-\udbff]/.test(line[j - 1])) j--;
      out.push(`\x1b[200~${line.slice(i, j)}\x1b[201~`);
      i = j;
    }
  });
  return out;
}
// type text into conversation id: pasteWrites, back to back. Tested on Claude Code 2.1.296 (~10,000 characters,
// 10 to 100 lines, typed then sent): every write arrives, as plain text, in no time. The Alt+Enter (ESC CR) used
// before needed 40 ms around it, and even then a long text now and then had one read as Enter, sending the
// message half typed; Ctrl+J is one byte with no such race. Kept in step with web/term.js typeInto.
async function typePasted(host, id, text) {
  for (const w of pasteWrites(text)) await host.call('write', id, w);
}
// type it (typePasted), then Enter on its own. beforeEnter: an async check just before the Enter; when it answers
// true (a menu came up) the Enter is not sent. -> { entered }
async function sendText(host, id, text, beforeEnter) {
  await typePasted(host, id, text);
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
  return menuFrom(await host.call('snapshot', p.id), p);
}
// the same, from a snapshot already read (a reader that wants the menu and the rows of one moment)
function menuFrom(raw, p) {
  const { cols, rows } = sizeOf(p);
  const m = SCREEN.menuDetailsShown(typeof raw === 'string' ? raw : '', cols, rows);
  // the sig as a caller passes it back: 12 hex characters, safe on any command line
  if (m) m.sig = crypto.createHash('sha1').update(m.sig).digest('hex').slice(0, 12);
  return m;
}
// the command's panel on that session's screen (/usage, /config...: screen.js panelShown, as the page's card reads it),
// from a snapshot, or null: { title, tabs: [{ label, on }], body: [lines], keys, sig (12 hex, as a menu's), cmd (the
// "/" command that opened it, the host's slashPanel, else null) }. Read loose (its keys line may be missing while a tab
// loads) once the host says a panel is open there
function panelFrom(raw, p) {
  const { cols, rows } = sizeOf(p);
  const x = SCREEN.panelShown(typeof raw === 'string' ? raw : '', cols, rows, { loose: panelOpen(p) || !!p.slashPanel });
  if (!x) return null;
  return { title: x.title, tabs: x.tabs, body: x.body, keys: x.keys, sig: crypto.createHash('sha1').update(x.sig).digest('hex').slice(0, 12), cmd: p.slashPanel || null };
}
// the menu and the panel of one reading of its screen, weighed as the page's tick weighs them: a panel a "/" command
// opened is that command's, whatever list it shows; else a menu up is a question Claude asks (a permission prompt),
// and the panel under it is none. -> { menu, panel }, at most one of them
function shownFrom(raw, p) {
  let menu = menuFrom(raw, p);
  let panel = typeof raw === 'string' && raw.includes('▔'.repeat(12)) ? panelFrom(raw, p) : null;
  if (panel && menu && !p.slashPanel) panel = null;
  else if (panel) menu = null;
  return { menu, panel };
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

// Claude Code's one-time "Claude in Chrome extension detected" offer, which a fresh claude can open on (screen.js kind
// 'chrome'): answered "Yes, use my browser", as Henry's PC accounts did (Claude Code saves it for that account, so it
// does not come again). Not when the start asked for chrome: false (one session's ask is no reason to turn it off for
// every later one), and never any other menu. A digit in a numbered menu, else ↑/↓ until the pointer is on it, then
// Enter; it ignores keys for a moment after it opens, so it is tried up to three times. -> true once it went away
async function passChromeOffer(host, p, chrome, ctx) {
  if (chrome === false) return false;
  const yes = (m) => m.options.find((o) => /^Yes, use my browser$/i.test(o.label));
  const done = () => { if (ctx && ctx.log) ctx.log(`api: ${p.id}: answered Claude Code's Claude in Chrome offer: Yes, use my browser`); return true; };
  let sent = false;
  for (let t = 0; t < 3; t++) {
    await sleep(SETTLE_MS);
    const m = await menuNow(host, p);
    if (!m) return sent && done(); // gone: the keys before took, late
    const want = m.kind === 'chrome' && yes(m);
    if (!want) return false;
    if (!want.on && !m.unnumbered && want.n <= 9) await host.call('write', p.id, String(want.n));
    else {
      const from = m.options.findIndex((o) => o.on), to = m.options.indexOf(want);
      if (from < 0) return false;
      let on = from === to;
      if (!on) {
        await host.call('write', p.id, (to > from ? '\x1b[B' : '\x1b[A').repeat(Math.abs(to - from)));
        for (const end = Date.now() + POINT_MS; !on && Date.now() < end;) {
          await sleep(POLL_MS / 4);
          const x = await menuNow(host, p);
          on = !!(x && x.kind === 'chrome' && yes(x)?.on);
        }
      }
      if (!on) continue;
      await host.call('write', p.id, '\r');
    }
    sent = true;
    for (const end = Date.now() + ANSWER_MS; Date.now() < end;) {
      await sleep(POLL_MS / 2);
      const x = await menuNow(host, p);
      if (!x || x.kind !== 'chrome') return done();
    }
  }
  return false;
}

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
  let col = 0; // the column since the last line break, for a move to a column
  return String(s || '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC (titles, links)
    // cursor forward (CSI n C), and to column n (CSI n G: Claude Code on the Mac draws every space that way): the
    // spaces they skip on the line; a move left draws nothing
    .replace(/\x1b\[(\d*)([CG])|\x1b\[[0-?]*[ -/]*[@-~]|\r\n?|\n|[^\x1b\r\n]+/g, (t, n, f) => {
      if (f) {
        const k = f === 'C' ? Math.min(200, Number(n) || 1) : Math.max(0, Math.min(1000, Number(n) || 1) - 1 - col);
        col += k;
        return ' '.repeat(k);
      }
      if (t[0] === '\x1b') return t;
      if (t[0] === '\r' || t[0] === '\n') col = 0; else col += t.length;
      return t;
    })
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
    role: isOverseer(p.role) ? p.role : null,
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

// A message that is just "/model <x>" or "/effort <x>" (the phone's, a remote chat's) may bring up Claude Code's
// "Switch model?" / "Change effort level?" (isSwitchConfirm), which only an open page answered (web/compose.js
// sayYes); elsewhere it became a "Needs you" card with every later message queued behind it. The sender asked for the
// switch, so its Yes is picked here as switchModel picks it (answerMenu). Sent while idle: watched CONFIRM_WATCH_MS.
// Sent while busy (it waits in Claude Code's queue): watched from when Claude stops working, for as long, up to
// CONFIRM_BUSY_MS in all. Any other menu is never answered: the watch waits it out (busy) or ends (idle).
const SWITCH_CMD_RE = /^\/(?:model|effort)[ \t]+\S+[ \t]*$/;
const CONFIRM_WATCH_MS = 5000, CONFIRM_BUSY_MS = 30 * 60e3;
const switchWatch = new Map(); // id -> the watch now: a newer command's watch takes over from an older one
async function yesToSwitch(host, id, cmd, status, ctx, mine) {
  const cap = Date.now() + (status === 'busy' ? CONFIRM_BUSY_MS : CONFIRM_WATCH_MS);
  let end = status === 'busy' ? 0 : cap;
  while (Date.now() < cap) {
    await sleep(end ? POLL_MS / 2 : SWITCH_TICK_MS);
    if (switchWatch.get(id) !== mine) return null;
    const p = hosted(await host.call('list'), id);
    if (!p || !p.alive) return null;
    if (!end) { if (p.status === 'busy') continue; end = Math.min(cap, Date.now() + CONFIRM_WATCH_MS); }
    if (Date.now() > end) return null;
    const m = await menuNow(host, p);
    if (!m) continue;
    if (switchQuestion(m) && !isSwitchConfirm(m)) continue; // still drawing
    if (!isSwitchConfirm(m)) { if (status !== 'busy') return null; end = 0; continue; }
    const yes = m.options.find((o) => YES_SWITCH.test(o.label));
    const [code, a] = await answerMenu(p.id, { option: yes.n, sig: m.sig, allowPermission: true }, ctx, null, null);
    if (code === 200 && a.changed) {
      if (ctx && ctx.log) ctx.log(`api: ${p.id}: answered "${m.title}" with "${yes.label}" after a typed ${cmd}`);
      return yes.label;
    }
    // gone meanwhile (an open page answered it): done; still up: tried again while the watch lasts
    if (!(await menuNow(host, p))) return null;
  }
  return null;
}
const watchSwitch = (id, text, status, ctx) => {
  const cmd = typeof text === 'string' ? text.trim() : '';
  if (!SWITCH_CMD_RE.test(cmd)) return;
  // a host connection held by the watch (withHost), so it outlives the request that sent the text
  const mine = {};
  switchWatch.set(id, mine);
  withHost((h) => yesToSwitch(h, id, cmd, status, ctx, mine))
    .catch((e) => { if (ctx && ctx.log && !(e instanceof HostDown)) ctx.log(`api: ${id}: watching for the switch question after ${cmd} failed: ${e.message}`); })
    .finally(() => { if (switchWatch.get(id) === mine) switchWatch.delete(id); });
};

// Send text into a hosted, live session as message does: a "/" panel closed first, never into a menu, then wait
// as asked. note(id, sentAt, status): called once it went in (status: the session's before it, 'busy' or 'idle').
// q: { from, original, onSent?, onDrop? } to keep it in the queue (see below) instead of refusing it while a menu or a
// panel is up; it goes in later. now: one that went in while Claude was busy (into Claude Code's queue) is sent at
// once, as the page's Interrupt on a queued message does (pressSendNow). A typed /model or /effort has its switch
// question answered (watchSwitch). shell: text is a shell command for bash mode (typeShell), never queued. -> [code, json]
async function deliver(host, p, text, ms, ctx, gone, note, extra = {}, q = null, now = false, shell = false) {
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
    if (shell) {
      const bad = await typeShell(host, cur);
      if (bad) return { r: [409, { ok: false, id: p.id, ...extra, shell: true, message: bad }] };
    }
    const sentAt = Date.now();
    const sent = await sendText(host, p.id, text, () => menuNow(host, cur));
    if (!sent.entered) return { r: [409, { ok: false, id: p.id, ...extra, menu: true, message: MENU_LATE }] };
    const sentNow = now && status === 'busy';
    if (sentNow) { await sleep(ENTER_DELAY_MS); await pressSendNow(host, p.id); }
    return { sentAt, status, sentNow };
  });
  if (typed.r) return typed.r;
  const { sentAt, status, sentNow } = typed;
  if (note) note(p.id, sentAt, status);
  if (!shell) watchSwitch(p.id, text, status, ctx);
  const w = await afterSend(host, p.id, sentAt, status, ms, ctx, gone);
  return [200, { ok: true, id: p.id, ...extra, status, ...(sentNow ? { sentNow } : {}), ...(shell ? { shell } : {}), ...w,
    message: doneText(w, ms, shell ? 'run in bash mode' : sentNow ? 'sent now (Claude stopped the step it was on)' : status === 'busy' ? 'sent while Claude was busy (queued)' : 'sent') }];
}

// Bash mode, as the page's (compose.js send): Claude Code switches to it only on a "!" typed as a key of its own into an
// empty prompt (a pasted one is just text), and its box then draws "!" where the ❯ was (screen.js bashBox). So: the box
// must be on screen and empty (anything typed there would run with the command), the "!" goes alone, and the command is
// pasted only once the box shows bash mode, up to BANG_MS_MAX. One the box took as text instead gets a Backspace (that
// "!" is ours) and is refused. Runs inside the typing's turn (typeOne). -> null when the box is in bash mode, else why not
const BANG_MS_MAX = 1500;
const SHELL_TYPED = 'something is typed in its prompt: a shell command goes only into an empty prompt (clear it in the Session tab first)';
async function typeShell(host, p) {
  const rows0 = await rowsNow(host, p, 60, true);
  const box = SCREEN.promptBox(rows0);
  if (!box) return SCREEN.bashBox(rows0) ? 'its prompt is in bash mode already (from the terminal): leave it there first' : 'its prompt is not on screen';
  if (box.text) return SHELL_TYPED;
  await host.call('write', p.id, '!');
  for (const end = Date.now() + BANG_MS_MAX; Date.now() < end;) {
    await sleep(POLL_MS / 4);
    const rows = await rowsNow(host, p, 60, true);
    const bash = SCREEN.bashBox(rows);
    if (bash) return bash.text ? SHELL_TYPED : null;
    const now = SCREEN.promptBox(rows);
    if (now && now.text === '!') {
      await host.call('write', p.id, '\x7f');
      return 'Claude Code took the "!" as text, not bash mode (it was taken back): try again';
    }
    if (now && now.text) return SHELL_TYPED; // typed into meanwhile: left as it is
  }
  return 'Claude Code did not switch to bash mode (it may not read keys yet): look at its prompt in the Session tab';
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
        watchSwitch(p.id, q.text, p.status || null, qCtx);
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
// repo, or a checkout of it), and still there. A bot's conversation (ctx.botOf, bots.js) in the bot's own folder,
// which is not a listed repo, may be resumed too, and gets the bot's role back.
// -> { cwd, account, role? } or { err: [code, json] }
function resumable(id, ctx) {
  const where = ctx.whereIs(id);
  if (!where.known) return { err: [404, { ok: false, id, message: 'no such conversation (its log is not on disk)' }] };
  const cwd = where.cwd;
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || ctx.UNSAFE_PATH.test(cwd)) return { err: [409, { ok: false, id, message: 'Fleet View does not know which folder that conversation worked in' }] };
  const dir = H.normDir(cwd);
  const bot = ctx.botOf ? ctx.botOf(id) : null;
  const own = !!bot && typeof bot.folder === 'string' && isBotRole(bot.role) && dir === H.normDir(bot.folder);
  const allowed = own || ctx.allowedFolders().map(H.normDir).some((f) => dir === f || dir.startsWith(f.endsWith(path.sep) ? f : f + path.sep));
  if (!allowed) return { err: [403, { ok: false, id, message: `its folder is not in a repo Fleet View lists: ${cwd}` }] };
  let isDir = false;
  try { isDir = fs.statSync(cwd).isDirectory(); } catch {}
  if (!isDir) return { err: [409, { ok: false, id, message: `its folder is gone: ${cwd}` }] };
  return { cwd, account: where.account, ...(own ? { role: bot.role } : {}) };
}
// The host's open (claude --resume, in its last folder under its account, with where.role), as the panel's Open does,
// unless it runs here already; never one open in a terminal outside Fleet View (it would run twice, writing one
// transcript). Then up to START_MS for it to be idle (a resumed claude says busy while it loads).
// -> { p, alreadyRunning, ready, stopped? } or { err: [code, json] }
async function resumeIn(host, id, where, account, ctx, gone) {
  let p = hosted(await host.call('list'), id);
  let alreadyRunning = !!(p && p.alive);
  if (!alreadyRunning) {
    if (ctx.openElsewhere && ctx.openElsewhere(id)) return { err: [409, { ok: false, id, elsewhere: true, message: 'it is open in a terminal outside Fleet View: end it there first' }] };
    const r = await host.call('open', { id, cwd: where.cwd, account: account || where.account || 'B', ...(where.role ? { role: where.role } : {}) });
    // another device has it (sync): the host's own message ("This conversation is on <device>: use Continue here")
    if (r && r.away) return { err: [409, { ok: false, id, away: r.away, message: r.message }] };
    if (!r || !r.ok) return { err: [502, { ok: false, id, message: (r && r.message) || 'the session host could not open it' }] };
    if (r.message === 'already running') alreadyRunning = true; // it started meanwhile
  }
  // one already running is taken as it is (a message to a busy one is queued, as message does). One that opens on
  // the Claude in Chrome offer has it answered (passChromeOffer), its screen read every MENU_EVERY_MS while not idle
  const until = Date.now() + START_MS;
  let chromeOffer = null, menuAt = Date.now();
  for (;;) {
    p = hosted(await host.call('list'), id);
    if (!p || !p.alive) return { err: [502, { ok: false, id, alreadyRunning, message: `the session ended before it was ready${p ? ` (code ${p.exitCode})` : ''}` }] };
    if (alreadyRunning || p.status === 'idle' || Date.now() >= until) break;
    if (gone()) return { p, alreadyRunning, ready: false, stopped: true };
    if (!chromeOffer && Date.now() - menuAt >= MENU_EVERY_MS) {
      menuAt = Date.now();
      if ((await menuNow(host, p))?.kind === 'chrome' && await passChromeOffer(host, p, undefined, ctx)) chromeOffer = 'accepted';
    }
    await sleep(POLL_MS);
  }
  return { p, alreadyRunning, ready: p.status === 'idle', ...(chromeOffer ? { chromeOffer } : {}) };
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
// o.via, for text with no from: 'server' (Fleet View's own) or 'henry' (the phone relay, viaOf); an overseer (a bot)
// gets any other such text marked unsigned (overseer.js frame). Callers never set it from a request body.
// o.overseerText: the text an overseer gets instead (an ask's answers without the question in their header). o.now: see deliver.
// o.shell: text is a shell command, run in bash mode (deliver), never queued, never framed (an overseer's: Henry's only).
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
      if (r.chromeOffer) extra.chromeOffer = r.chromeOffer;
      if (!r.ready) return [409, { ok: false, id: cid, ...extra, resumed: true, message: `${name} was resumed, but it was not idle within ${START_MS / 1000} s; nothing was typed` }];
      p = r.p;
      extra.resumed = !r.alreadyRunning;
      if (extra.resumed) await sleep(SETTLE_MS);
    }
    const from = o.from || null, kind = o.ask ? 'question' : null;
    // a shell command runs as typed (a frame would be part of the command), and its output goes into the conversation
    // unsigned: in an overseer's only Henry's (the phone relay) may
    if (o.shell && isOverseer(p.role) && o.via !== 'henry') return [403, { ok: false, id: p.id, ...extra, message: 'only Henry runs a shell command in an overseer\'s session (his phone)' }];
    // an overseer reads text by where it came from (overseer.js frame): another conversation's (from), Fleet View's own,
    // Henry's (the phone relay), or unsigned
    const typed = o.shell ? body : isOverseer(p.role) ? OVERSEER.frame(o.overseerText != null ? o.overseerText : body, from ? 'bot' : o.via === 'server' || o.via === 'henry' ? o.via : 'unsigned') : body;
    const note = (to, at, status) => {
      if (from && ctx.noteMessage) ctx.noteMessage(from, convId(to) || to, o.original || body, kind ? { kind } : undefined);
      if (o.onSent) o.onSent(convId(to) || to, at, status);
    };
    // (a shell command is never queued behind a menu: the queue would paste it as a message)
    return deliver(host, p, typed, o.wait || 0, ctx, gone, note, extra,
      o.queue === false || o.shell ? null : { from, original: o.original || body, ...(kind ? { kind } : {}), onSent: o.onSent, onDrop: o.onDrop }, o.now === true, o.shell === true);
  });
}

// ---------- the requests ----------
// GET /api: what there is, for a caller (or a Claude) finding its way from the command line
const ENDPOINTS = [
  { method: 'GET', path: '/api', does: 'this list, and fleetView: the Fleet View version (1.0.12; "" when unknown)' },
  { method: 'GET', path: '/api/conversations', query: 'state?, repo?, all?=1, limit?', does: 'every conversation Fleet View shows (not only hosted): id, name, state, repo, branch, lastReply, hosted, alive' },
  { method: 'GET', path: '/api/sessions', does: 'the sessions the desktop app hosts, with status, latest reply and role ("bot:<bot id>" or null)' },
  { method: 'POST', path: '/api/sessions', body: '{ repo, account: "A"|"B"|"C"…, prompt, name?, model?, effort?, forkFrom?, temp?, chrome?, wait? }', does: 'start a session in a repo (forkFrom: carrying a conversation\'s history), set its name/model/effort, send the prompt; temp: hidden from the map once it ends. An account at 90% of its 5-hour or weekly limit gives way to the one with the most left (accountSwitched in the reply) while "Switch accounts when one runs low" is on' },
  { method: 'GET', path: '/api/bots', does: 'Henry\'s bots (overseers of the fleet, each in its own folder ~/Bots/<name> with its CLAUDE.md): id, name, brief, role, account, model, effort, folder, createdAt, convId, live' },
  { method: 'POST', path: '/api/bots', body: '{ name (1-40 characters), brief? (up to 4000), role? (what it does, one line, up to 60 characters; "" none), account?: "B", model?: "dynamic" (the default: sized for each message Henry sends from the page) or a name like "claude-sonnet-5-5", effort?: "dynamic" (the default) or "medium" }', does: 'Henry only (his phone, through the relay; a session gets 403): make a bot (its folder, its CLAUDE.md from the brief) and start it: { ok, bot, key, id }' },
  { method: 'POST', path: '/api/bots/:id', body: '{ name?, brief?, role?, account?, model?, effort? }', does: 'Henry only, as POST /api/bots: change a bot: its CLAUDE.md (with its role) is written again and a running one is told to read it (account, model and effort take effect in its next new conversation)' },
  { method: 'POST', path: '/api/bots/:id/start', does: 'start a bot: the conversation running already, else its newest one resumed, else a new one: { ok, bot, key, id }' },
  { method: 'POST', path: '/api/bots/look', body: '{ from: your conversation id, shape?: "hex"|"drop"|"round"|"pill"|"tri"|"square"|"star"|"clover"|"flower"|"heart", color?: "#rrggbb" }', does: 'a bot changes its own avatar (null: picked for it); only from a bot\'s own conversation, and only its look (fv look)' },
  { method: 'POST', path: '/api/bots/:id/remove', does: 'Henry only, as POST /api/bots: end a bot\'s session and take it off the list (its folder and conversations are kept)' },
  { method: 'GET', path: '/api/sessions/:id', query: 'tail?', does: 'one hosted session: status, state, latest reply, role, its turn; tail: the last characters of its screen' },
  { method: 'POST', path: '/api/sessions/:id/message', body: '{ text, wait?, from?, queue?, open?, now?, shell? }', does: 'send a message; wait: until the turn ends. from: your conversation id (a message between conversations). queue: while a menu is up it waits and goes in once answered (202), else refused; open: one not running here is resumed first. Both default to true with from. With from, leading /effort <level> and /model <name> lines switch the receiver (as POST .../model with queue: true; a bare command typed under the from line would be read as text) and the rest is sent: switch { ok, queued?, model?, effort?, message }. now (not with from): sent while Claude works, it goes at once, stopping the step Claude is on (sentNow). shell (not with from or now): text is a shell command, run in bash mode ("!" typed as a key of its own into an empty prompt, then the command; a leading "!" in text is dropped); 409 when its prompt is not empty or a menu is up, never queued' },
  { method: 'POST', path: '/api/sessions/:id/launch', body: '{ picks?: "recommended" | [n…], from?, wait?, dry? }', does: 'the chat\'s Launch button from outside the page: the conversation\'s newest reply offering options (a task list, every box unticked) gives them; picks (default the ones marked "(recommended)"; numbers from 1 as the list stands) are sent as the button sends them ("Go with these:", the numbered options, the launch line), so the page and the phone show them Launched; ones launched already are left out (skipped). A session below high effort, or not known, is switched to high first, as the button does. from, wait: as .../message. dry: nothing sent: { options: [{ n, text, rec, done }], picked, text }. 409 when there is no such reply or nothing left to launch' },
  { method: 'POST', path: '/api/sessions/:id/now', does: 'the page\'s Interrupt on a queued message: Claude stops the step it is on and takes every message queued in Claude Code now (only while it works with some queued): { sent: [texts] }' },
  { method: 'POST', path: '/api/sessions/:id/unsend', body: '{ text }', does: 'take a message back before Claude reads it: out of Fleet View\'s menu queue (where: "fleetView"), else out of Claude Code\'s queue as the page\'s Unsend does (where: "claude", requeued: the others put back); 409 taken when Claude has read it already' },
  { method: 'POST', path: '/api/sessions/:id/model', body: '{ model?, effort?, queue? }', does: 'switch this conversation\'s model and/or effort (/model, /effort, while Claude is idle) and put the default for new sessions back as it was: { said, defaultKept, restored, effortNow }. Not idle: 409 notReady, or with queue: true 202 { queued, model?, effort? }: applied once Claude finishes this step (GET /state\'s switchPending until then; dropped after 30 min). An overseer\'s: Henry only (his phone)' },
  { method: 'GET', path: '/api/sessions/:id/activity', does: 'the activity line, cheap to poll: busy, line ("Brewing… (12s · ↓ 1.2k tokens)"), verb, detail, doing (tool in use), waiting (menu | panel | null), menu { kind, title }, effort, queue (messages queued in Claude Code), mode (default | acceptEdits | plan | auto | bypass | null), bg (a shell command Ctrl+B can send to the background), prompt (its prompt box\'s text; a bash-mode one as "!<command>"; null when not on screen), rewind (the last POST .../rewind: { state: asking | sending | sent | restored | kept | failed, text, edit, message, at }, or null), fork (on a fork POST .../fork started: { state: working | done | failed, text, from, message, at }, or null), panel (a command\'s panel up, as the page\'s panel card shows it: { title, tabs: [{ label, on }], body: [lines], keys (its keys line), sig, cmd (the "/" command that opened it, or null) }, or null; POST .../panel drives it)' },
  { method: 'POST', path: '/api/sessions/:id/rewind', body: '{ text, nth?, edit? }', does: 'the page\'s Rewind (and Edit, with edit) on one of your messages: Claude Code\'s /rewind back to just before it. text: the message as the transcript has it; nth: which of the messages with that text, counted from the newest (default 0). Only while Claude is idle with no menu or panel up and nothing typed in its prompt (409). -> { menu, at }: Claude Code\'s restore question, now up, which the caller answers (POST .../answer); once restored the message leaves its prompt and edit is sent in its place (activity\'s rewind says how it ended). An overseer\'s: Henry only (his phone)' },
  { method: 'POST', path: '/api/sessions/:id/fork', body: '{ text, nth? }', does: 'the page\'s Fork on one of your messages: a fork of the conversation (claude --resume <id> --fork-session, in its folder under its account; it need not be running) that goes back to just before that message. text and nth as for .../rewind. -> { key, forkFrom, at } as soon as the fork started; then, once it is up, Claude Code\'s /rewind in the fork to the message, "Restore conversation" only (never the code: the original shares the folder), and the message cleared from the fork\'s prompt, for the caller\'s box (the fork\'s activity\'s fork says how it went). An overseer\'s: Henry only (his phone)' },
  { method: 'POST', path: '/api/sessions/:id/enter', body: '{ text }', does: 'the page\'s Send it on a message left in Claude Code\'s prompt: Enter once more, only while its prompt box holds exactly that text (spaces aside) and no menu is up' },
  { method: 'POST', path: '/api/sessions/:id/background', does: 'the page\'s Run in background: Ctrl+B, only while Claude works and its screen offers it (activity\'s bg)' },
  { method: 'POST', path: '/api/sessions/:id/mode', body: '{ mode: "default" | "acceptEdits" | "plan" | "auto" | "bypass" }', does: 'the permission mode: Shift+Tab until its footer shows that mode (at most 5 presses; 409 with the mode it is on when it has no such mode), only while Claude is idle with no menu up. An overseer\'s: Henry only (his phone)' },
  { method: 'POST', path: '/api/sessions/:id/panel', body: '{ key: "up" | "down" | "left" | "right" | "tab" | "enter" | "esc" } or { tab: n }', does: 'the page\'s panel card: drive a command\'s panel open in its terminal (/usage, /status, /config, /mcp...: activity\'s panel shows it): key pressed once, or Tab until tab n (from 0, as activity\'s panel lists them) is on. Only while a panel is up (409 otherwise, with the menu when a question is up instead). -> { panel }: as it reads after (null once it closed). An overseer\'s: Henry only (his phone)' },
  { method: 'POST', path: '/api/sessions/:id/wait', body: '{ timeout? (s, default 1800) }', does: 'wait, sending nothing, until it is ready for you: endedBy idle | reply | question | menu | apiError | exit | gone' },
  { method: 'GET', path: '/api/sessions/:id/menu', does: 'the select menu on its screen now: kind (question|permission|plan|trust|chrome|other), title, context, options, sig; or null' },
  { method: 'POST', path: '/api/sessions/:id/answer', body: '{ option: n | "submit" | "esc", sig?, text?, allowPermission?, wait? }', does: 'answer the menu (text: for a "Type something." option; "submit": a multiple-choice question\'s Submit); any menu but a question needs allowPermission (esc never does); the folder trust question answered Yes also has a Claude in Chrome offer that follows it answered Yes (chromeOffer: \'accepted\')' },
  { method: 'POST', path: '/api/sessions/:id/interrupt', does: 'press Esc once to stop Claude mid-turn (not while a menu is up)' },
  { method: 'POST', path: '/api/sessions/:id/open', body: '{ account?, prompt?, wait? }', does: 'resume a conversation Fleet View knows as a hosted session; prompt: then send it' },
  { method: 'GET', path: '/api/sessions/:id/transcript', query: 'since?, limit? (default the last 50, at most 500)', does: 'any conversation\'s transcript, compact: user, assistant, tool (name, input, result), note, thinking; queue: the messages queued in Claude Code (while it runs here)' },
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
  return [200, { ok: true, version: 2, fleetView: VERSION.current().version, auth: `Authorization: Bearer <${P.isWin ? '%LOCALAPPDATA%\\fleet-view\\api-token' : TOKEN_FILE}>`, endpoints: ENDPOINTS,
    notes: 'ids: a conversation id, or the new-<n> key POST /api/sessions gave. wait: true (30 min), false, or seconds 1..3600. A reply is { ok, message?, ... }; 400 bad input, 401 token, 403 refused, 404 no such session, 409 state conflict, 503 the desktop app is not running.' }];
}

// POST /api/sessions { repo, account, prompt, name?, model?, effort?, forkFrom?, temp?, chrome?, wait? }
// A fresh claude that opens on the Claude in Chrome offer has it answered Yes (passChromeOffer; chromeOffer: 'accepted'
// in the reply), unless chrome is false; any other startup dialog keeps the prompt from being sent, as before.
// A caller gives no role (400): a bot's is startBot's.
// the Claude accounts on this machine (ctx.accounts from fleet-view.js: B plus one per ~/.claude-<x>), else A and B
const acctsOf = (ctx) => { try { const a = typeof ctx.accounts === 'function' ? ctx.accounts() : null; if (Array.isArray(a) && a.length) return a; } catch {} return ['A', 'B']; };
const acctOk = (a, ctx) => typeof a === 'string' && acctsOf(ctx).includes(a);
// origin: 'server' (startBot), 'henry' (the phone relay, viaOf) or null: an overseer's prompt from anyone
// else is marked unsigned (overseer.js frame). vouched: the folder startBot vouches for (a bot's own, not a listed repo);
// only with it may role be a bot's ("bot:<id>", one live session each, 409)
async function startSession(b, ctx, gone, origin = null, vouched = null) {
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
  const botRole = vouched && isBotRole(b.role) ? b.role : null;
  if (b.role != null && !botRole) return [400, { ok: false, message: 'role cannot be given: a bot starts with POST /api/bots/<id>/start' }];
  const role = botRole;
  const typedPrompt = role && origin !== 'server' ? OVERSEER.frame(prompt, origin === 'henry' ? 'henry' : 'unsigned') : prompt;
  let fork = null;
  if (b.forkFrom != null) {
    fork = convId(b.forkFrom);
    if (!fork) return [400, { ok: false, message: 'forkFrom must be a conversation id' }];
    if (!ctx.whereIs(fork).known) return [404, { ok: false, message: 'no such conversation to fork (its log is not on disk)' }];
  }
  const ms = waitMs(b.wait);
  if (ms === null) return [400, { ok: false, message: WAIT_BAD }];
  // the same rule as the window's "New session": a folder /state lists (or the bot's own that startBot vouches for),
  // that exists
  const own = !!vouched && H.normDir(vouched) === H.normDir(repo);
  if (!own && !new Set(ctx.allowedFolders().map(H.normDir)).has(H.normDir(repo))) return [403, { ok: false, message: 'that folder is not a repo Fleet View lists' }];
  let isDir = false;
  try { isDir = fs.statSync(repo).isDirectory(); } catch {}
  if (!isDir) return [400, { ok: false, message: `the folder is gone: ${repo}` }];

  return withHost(async (host) => {
    if (role) {
      const live = ((await host.call('list')) || []).find((x) => x && x.alive && x.role === role);
      if (live) return [409, { ok: false, id: live.id, message: `that bot is running already (${live.id})` }];
    }
    // an account close to its limit: the new conversation starts on the one with the most left instead
    // (ctx.pickAccount, account-switch.js pickNew; the reply says so in accountSwitched)
    let pick = null;
    try { pick = ctx.pickAccount ? ctx.pickAccount(b.account, b.name || null) : null; } catch {}
    const o = { cwd: repo, account: pick && acctOk(pick.account, ctx) ? pick.account : b.account };
    if (typeof b.chrome === 'boolean') o.chrome = b.chrome;
    if (fork) o.forkFrom = fork;
    if (b.model != null) o.model = b.model;
    if (b.effort != null) o.effort = b.effort;
    if (role) o.role = role;
    const r = await host.call('create', o);
    if (!r || !r.ok || typeof r.key !== 'string') return [502, { ok: false, message: (r && r.message) || 'the session host could not start it' }];
    const key = r.key;
    // an older host ignores forkFrom, model, effort and role: a fresh conversation without the history, on the default
    // model, or without a bot's role, so it goes again (typing /model or /effort instead would
    // save them as the default for every session)
    const missing = [fork && r.forkFrom !== fork && 'fork a conversation', b.model != null && r.model !== b.model && 'set the model',
      b.effort != null && r.effort !== b.effort && 'set the effort', role && r.role !== role && 'start a bot'].filter(Boolean);
    if (missing.length) {
      await host.call('kill', key).catch(() => {});
      return [502, { ok: false, key, message: `the session host is too old to ${missing.join(' or ')} (restart it: node desktop/restart-host.js); the session it started was stopped` }];
    }
    // an older host ignores chrome and does not echo it back: say so instead of failing
    const chromeApplied = typeof b.chrome === 'boolean' ? r.chrome === b.chrome : null;
    // what every reply from here on carries
    const out = { key, id: null, chromeApplied, ...(b.model != null ? { model: b.model } : {}), ...(b.effort != null ? { effort: b.effort } : {}), ...(role ? { role } : {}),
      ...(o.account !== b.account ? { account: o.account, accountSwitched: { from: b.account, to: o.account, why: pick.text } } : {}) };
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
    // A startup dialog keeps it from going idle: the Claude in Chrome offer is answered (passChromeOffer, its screen
    // read every MENU_EVERY_MS until then), any other is left for a person
    const until = Date.now() + START_MS;
    const chromeOffer = async (m) => {
      if (out.chromeOffer || !m || m.kind !== 'chrome' || !(await passChromeOffer(host, p, b.chrome, ctx))) return false;
      out.chromeOffer = 'accepted';
      return true;
    };
    let p = null, menuAt = Date.now();
    while (Date.now() < until) {
      await sleep(POLL_MS);
      p = byPid(await host.call('list'));
      if (!p) return reply(502, { ok: false, message: 'the session ended before it was ready' });
      if (!p.alive) { out.id = convId(p.id); return reply(502, { ok: false, message: `the session ended before it was ready (code ${p.exitCode})` }); }
      if (H.ID_RE.test(p.id) && !p.pending) { out.id = p.id; keyToId.set(key, p.id); label(p.id); }
      if (out.id && p.status === 'idle') break;
      if (!out.chromeOffer && Date.now() - menuAt >= MENU_EVERY_MS) { menuAt = Date.now(); await chromeOffer(await menuNow(host, p)); }
    }
    const id = out.id;
    if (!id || !p || p.status !== 'idle') {
      // nothing was typed: the session is left running for a person to look at in the panel
      return reply(200, { ok: false, promptSent: false, message: 'the session did not get ready within 60 s (it may be asking whether to trust the folder); the prompt was not sent, and the session is still running in the panel' });
    }
    await sleep(SETTLE_MS);
    // a fresh session can open on a question (trusting the folder, a setting): nothing goes into it
    let m0 = await menuNow(host, p);
    if (await chromeOffer(m0)) { await sleep(SETTLE_MS); m0 = await menuNow(host, p); }
    if (m0) return reply(200, { ok: false, promptSent: false, menu: m0, message: `${MENU_UP}; the prompt was not sent, and the session is still running in the panel` });
    const sentAt = Date.now();
    const sent = await sendText(host, id, typedPrompt, () => menuNow(host, p));
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
    return reply(200, { ok: true, promptSent: true, ...w, message: doneText(w, ms, `started${out.chromeOffer ? ' (its Claude in Chrome offer answered Yes)' : ''}, and the prompt was sent`) });
  });
}

const serverFail = (e) => (e instanceof HostDown ? [503, { ok: false, message: e.message }] : [500, { ok: false, message: String((e && e.message) || e) }]);

// The server's own ways to run a bot (bots.js), without an HTTP request. startBot: POST /api/sessions with the bot's
// role "bot:<id>" in the bot's own folder, which is not a repo Fleet View lists (the registry vouches for it); the
// other checks and the reply are the same, and 409 with id while that bot runs. b: { repo, account, prompt, name,
// model, effort, role }. openBot: its conversation resumed with its role (resumable, through ctx.botOf), then up to
// START_MS for it to be idle. endHosted: a hosted session ended as the panel's close does (the host drops it from its
// restore list). Each -> a Promise of [code, json] (503 when the session host is not running).
function startBot(b, ctx) {
  const body = b && typeof b === 'object' ? b : {};
  return startSession(body, ctx, () => false, 'server', typeof body.repo === 'string' ? body.repo : null).catch(serverFail);
}
function openBot(id, ctx) {
  const cid = convId(id);
  if (!cid) return Promise.resolve([400, { ok: false, message: 'give a conversation id' }]);
  const where = resumable(cid, ctx);
  if (where.err) return Promise.resolve(where.err);
  if (!where.role) return Promise.resolve([409, { ok: false, id: cid, message: 'that is not a bot\'s conversation in its own folder' }]);
  return withHost(async (host) => {
    const r = await resumeIn(host, cid, where, null, ctx, () => false);
    if (r.err) return r.err;
    return [200, { ok: true, id: cid, alreadyRunning: r.alreadyRunning, ready: r.ready, ...(r.chromeOffer ? { chromeOffer: r.chromeOffer } : {}), message: r.alreadyRunning ? 'it was already running' : r.ready ? 'resumed; Claude is idle' : 'resumed, but it is not idle yet' }];
  }).catch(serverFail);
}
function endHosted(key) {
  return withHost(async (host) => { await host.call('kill', key); return [200, { ok: true, id: key }]; }).catch(serverFail);
}

// POST /api/sessions/:id/message { text, wait?, from?, queue?, open?, now? }
// from: the conversation id of the sender, when one conversation messages another (fv send --from, or the older
// scripts/fleet-msg.js). It must be a conversation Fleet View knows; one that handed off counts as the one that
// carries on. The text then goes in after a line saying who it is from ("teammate" when the two share a team) and
// how to reply, and the server records it (its team's messages, the feed, an alert when they share no team).
// Its leading "/effort <level>" and "/model <name>" lines are not sent: they switch the receiver (leadingSwitch).
// queue and open (both true by default with from, false without) go to deliverText: with queue, a receiver showing
// a menu gets it later (202 queued); with open, one not running here is resumed first. Without either it must be
// running here, and a menu turns it down (409), as before.
// now: sent while Claude works, it goes at once (deliver), not after the step Claude is on; only a message of your own
// (no from): one conversation never cuts another's step short.
// via: 'henry' when the phone relay sent it (viaOf), for a bot's framing; never read from the body here
async function sendMessage(key, b, ctx, gone, via = null) {
  if (!b || typeof b !== 'object') return [400, { ok: false, message: 'bad json' }];
  const text = cleanText(b.text);
  if (!text) return [400, { ok: false, message: 'text must be text, without control characters other than new lines and tabs' }];
  const ms = waitMs(b.wait);
  if (ms === null) return [400, { ok: false, message: WAIT_BAD }];
  for (const k of ['queue', 'open', 'now', 'shell']) if (k in b && typeof b[k] !== 'boolean') return [400, { ok: false, message: `${k} must be true or false` }];
  // shell: the text is a shell command for bash mode (its "!", when it has one, is the mode's: dropped), one's own,
  // never sent now (it does not queue the way a message does)
  if (b.shell === true) {
    if (b.from !== undefined && b.from !== null) return [400, { ok: false, message: 'shell goes only with a message of your own (no from)' }];
    if (b.now === true) return [400, { ok: false, message: 'shell and now do not go together' }];
    const cmd = text.replace(/^\s*!/, '');
    if (!cmd.trim()) return [400, { ok: false, message: 'a shell command must say what to run' }];
    return deliverText(key, cmd, { kind: 'message', wait: ms, queue: false, open: b.open === true, via, shell: true }, ctx, gone);
  }
  let from = null;
  if (b.from !== undefined && b.from !== null) {
    from = typeof b.from === 'string' ? convId(b.from) : null;
    if (!from) return [400, { ok: false, message: 'from must be your conversation id' }];
    if (!ctx.whereIs(from).known && !ctx.sessionInfo(from)) return [400, { ok: false, message: 'from is not a conversation Fleet View knows' }];
    from = (ctx.successorOf && ctx.successorOf(from)) || from;
  }
  const queue = 'queue' in b ? b.queue : !!from, open = 'open' in b ? b.open : !!from;
  if (from && b.now === true) return [400, { ok: false, message: 'now goes only with a message of your own (no from)' }];
  if (!from) return deliverText(key, text, { kind: 'message', wait: ms, queue, open, via, now: b.now === true }, ctx, gone);
  // "/effort <level>" or "/model <name>" on the first lines: under the header line below Claude reads it as text, never
  // as the command, so it is taken off and made the receiver's switch (switchModel with queue: one working switches
  // when it finishes this step). The rest, if any, goes on as the message
  const sw = leadingSwitch(text);
  if (sw) {
    const [sc, so] = await switchModel(key, { ...sw.want, queue: true }, ctx, via);
    const done = sc === 200 || sc === 202;
    if (ctx.log) ctx.log(`api: ${from} switched ${key} (${Object.values(sw.want).join(', ')}): ${sc} ${so.message || ''}`);
    const said = `${Object.entries(sw.want).map(([k, v]) => `${k} ${v}`).join(', ')}: ${done ? so.message : `not switched (${so.message})`}`;
    const sent = { switch: { ok: !!(done && so.ok), ...(so.queued ? { queued: true } : {}), ...sw.want, message: so.message } };
    if (!sw.rest) return [sc, { ...so, ...sent, message: said }];
    const [c, o] = await sendMessage(key, { ...b, text: sw.rest }, ctx, gone, via);
    return [c, { ...o, ...sent, message: `${said}; ${o.message || 'the rest sent'}` }];
  }
  const name = headName(from, ctx);
  // "your lead" when from leads a team the receiver is in, "teammate" when they share one without that (either of a
  // mid-level lead's two teams: the one it leads, the one above where it reports)
  const head = (to) => {
    const id = convId(to), rel = id ? TT.relation(teamsIn(from, ctx), from, id) : null;
    const who = rel === 'lead' ? 'your lead ' : rel === 'mate' ? 'teammate ' : '';
    return `[Message from ${who}"${name}" (${from}). Reply with: fv send ${from} "message" --from ${convId(to) || to}]\n${text}`;
  };
  return deliverText(key, head, { kind: 'message', from, original: text, wait: ms, queue, open }, ctx, gone);
}
// POST /api/sessions/:id/launch { picks?: "recommended" | [n…], from?, wait?, dry? }: the chat's Launch button, from
// outside the page (launch.js). The conversation's newest reply that offers a choice (a task list, every box
// unticked) gives the options; picks says which (default the ones marked "(recommended)"; numbers as the list stands,
// from 1); ones launched already are left out. It sends what the button sends, word for word, so the page and the
// phone grey them as Launched: "Go with these:", the numbered options, the launch line. Like the button it runs the
// launch at high effort or above: a session known to be below high, or not known, is switched to high first (queued
// while it works; an overseer's is Henry's to change, so it is left). from, wait: as POST .../message (with from the
// line saying who it is from goes above it). dry: send nothing; the options and the text that would go.
const LAUNCH_ITEMS = 500, LAUNCH_TEXT_MAX = 100000;
async function launchPicks(key, b, ctx, gone, via = null) {
  if (!b || typeof b !== 'object') return [400, { ok: false, message: 'bad json' }];
  const id = convId(resolveKey(key));
  if (!id) return [400, { ok: false, message: 'give a conversation id' }];
  const picks = b.picks === undefined ? 'recommended' : b.picks;
  if (picks !== 'recommended' && !(Array.isArray(picks) && picks.length && picks.every((n) => Number.isInteger(n) && n >= 1 && n <= 999))) {
    return [400, { ok: false, message: 'picks must be "recommended" or a list of option numbers (from 1)' }];
  }
  if ('dry' in b && typeof b.dry !== 'boolean') return [400, { ok: false, message: 'dry must be true or false' }];
  let t;
  try { t = await ctx.transcript(id, { limit: LAUNCH_ITEMS, textMax: LAUNCH_TEXT_MAX }); } catch { t = null; }
  if (!t) return [404, { ok: false, id, message: 'no such conversation (its log is not on disk)' }];
  const choice = LAUNCH.latestChoice(t.items || []);
  if (!choice) return [409, { ok: false, id, message: `none of its last ${LAUNCH_ITEMS} transcript items is a reply offering options (a task list with every box unticked)` }];
  const options = choice.options;
  const reply = { i: choice.item.i, t: choice.item.t || null };
  const c = LAUNCH.choose(options, picks);
  if (c.error) return [409, { ok: false, id, reply, options, message: c.error }];
  const text = LAUNCH.launchText(options, c.ns);
  const out = { id, reply, options, picked: c.ns, ...(c.skipped && c.skipped.length ? { skipped: c.skipped } : {}), text };
  if (b.dry === true) return [200, { ok: true, ...out, dry: true, message: `would launch ${c.ns.join(', ')}` }];
  // the button's effort: high or above for the session coordinating the launch (handto.js)
  const info = ctx.sessionInfo ? ctx.sessionInfo(id) : null;
  const was = info && EFFORTS.includes(info.effort) ? info.effort : null;
  let effort = null;
  if (!was || EFFORTS.indexOf(was) < EFFORTS.indexOf('high')) {
    const [sc, so] = await switchModel(key, { effort: 'high', queue: true }, ctx, via);
    effort = sc === 200 || sc === 202 ? { ok: true, from: was, to: 'high', ...(so.queued ? { queued: true } : {}) } : { ok: false, from: was, message: so.message || `HTTP ${sc}` };
  }
  const [code, sent] = await sendMessage(key, { text, ...(b.from != null ? { from: b.from } : {}), ...(b.wait !== undefined ? { wait: b.wait } : {}) }, ctx, gone, via);
  const said = `launched ${c.ns.join(', ')}${c.skipped && c.skipped.length ? ` (${c.skipped.join(', ')} launched already)` : ''}`;
  const eff = !effort ? '' : effort.ok ? `; effort ${effort.from || 'unknown'} -> high${effort.queued ? ' once this step ends' : ''}` : `; effort left at ${effort.from || 'what it is'} (${effort.message})`;
  if (!sent.ok) return [code, { ...sent, ...out, ...(effort ? { effort } : {}), message: `not launched: ${sent.message || `HTTP ${code}`}` }];
  return [code, { ...sent, ...out, ...(effort ? { effort } : {}), message: `${said}${eff}; ${sent.message || 'sent'}` }];
}

// a message's leading "/model <name>" and "/effort <level>" lines (blank lines between them and after them skipped)
// -> { want: { model?, effort? }, rest } or null: none there, or a value switchModel would refuse (sent as text then)
function leadingSwitch(text) {
  const lines = text.split('\n'), want = {};
  let i = 0;
  for (; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    if (!SWITCH_CMD_RE.test(l)) break;
    const [cmd, v] = l.split(/[ \t]+/);
    want[cmd.slice(1)] = v;
  }
  if (!Object.keys(want).length || switchBad(want)) return null;
  return { want, rest: lines.slice(i).join('\n').trim() };
}
// a sender's name for the first line of what it sends: no control characters (an ESC in a title could end the
// paste early and type the rest as keys), quotes, brackets or line breaks, so the line stays one line of plain text
// with the name inside its quotes (overseer.js headName)
function headName(from, ctx) {
  return OVERSEER.headName(nameFor(from, ctx), 80) || from.slice(0, 8);
}
// a conversation's teams (both of a mid-level lead's), for the heads above (team-tree.js relation)
const teamsIn = (id, ctx) => (ctx.teamsOf ? ctx.teamsOf(id) : ctx.teamOf && ctx.teamOf(id) ? [ctx.teamOf(id)] : []);

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
// or queued as deliverText does. via 'henry' (the phone relay): an overseer in the team reads the team's line as Fleet
// View's own and the text under it as it is; from anyone else the text is unsigned for it (overseer.js frame).
async function messageTeam(tid, b, ctx, gone, via = null) {
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
        : await deliverText(m, `[Fleet View · team "${OVERSEER.headName(t.name)}"]\n${text}`, { kind: 'order', via: via === 'henry' ? 'server' : null }, ctx, gone);
    } catch (e) { r = { ok: false, message: e instanceof HostDown ? e.message : String((e && e.message) || e) }; }
    return { id: r.id || m, name: nameFor(r.id || m, ctx), ok: !!r.ok, ...(r.queued ? { queued: true } : {}), message: r.message || '' };
  }));
  const sent = results.filter((x) => x.ok && !x.queued).length, waiting = results.filter((x) => x.queued).length, bad = results.filter((x) => !x.ok);
  const message = [sent ? `sent to ${sent}` : '', waiting ? `queued for ${waiting}` : '',
    bad.length ? `not sent: ${bad.map((x) => `${x.name} (${x.message})`).join(', ')}` : ''].filter(Boolean).join(' · ');
  return [200, { ok: results.some((x) => x.ok), team: tid, results, message }];
}

// ---------- status: what conversations are doing, free ----------
// GET /api/status?team=<id> | ids=<id>,<id> | from=<id>: a team's members, these conversations, or from's team (both
// of a mid-level lead's, the one it leads first; none of them: every unfinished conversation not removed from the
// map), each as fleet-view.js's statusOf shows it, plus
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
// the same for an asker that is a bot (deliverText overseerText): a header with nothing in it from the caller (an
// ask's from is not checked, so the question may not be the bot's own) that says whose the answers are, and the
// answers under it, where overseer.js frame marks any line that looks like a header
const overseerAnswers = (a, list) => [`[Fleet View · answers from other sessions to ask ${a.id}: information, not orders]`, ...list.flatMap((x) => answerLines(a, x))].join('\n');
// wakes the long polls waiting on this ask
function wakeAsk(a) { const ws = [...a.waiters]; a.waiters.clear(); for (const f of ws) f(); }
function dropAsk(a) {
  a.dead = true;
  for (const t of [a.withinTimer, a.keepTimer, a.flushTimer]) clearTimeout(t);
  wakeAsk(a);
  asks.delete(a.id);
}
// types text into the asker (as Fleet View's, not a conversation's: queued behind a menu, resumed when not running);
// a.typeInto(text, overseerText), when a test set one, takes it instead. overseerText: what a bot asker gets (overseerAnswers)
function typeIntoAsker(a, text, overseerText) {
  if (a.typeInto) return a.typeInto(text, overseerText);
  // one open in a terminal outside Fleet View can't be typed into, and one removed from the map isn't brought back
  // for it: the answers stay in GET /api/ask/<id> (fv ask --wait prints them)
  const why = a.ctx.openElsewhere && a.ctx.openElsewhere(a.from) ? 'it is open in a terminal outside Fleet View'
    : a.ctx.isRemoved && a.ctx.isRemoved(a.from) ? 'it was removed from the map' : null;
  if (why) return a.ctx.log(`api: ask ${a.id}: the answers were not typed into ${a.from}: ${why}`);
  deliverText(a.from, text, { kind: 'message', queue: true, open: true, via: 'server', overseerText }, a.ctx).then(([, r]) => {
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
    if (list.length) typeIntoAsker(a, summaryText(a, list), overseerAnswers(a, list));
    return;
  }
  for (const x of a.targets) if (settled(x) && !x.collected && !x.told) { x.told = true; typeIntoAsker(a, laterText(a, x), overseerAnswers(a, [x])); }
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
  // "your lead" for a target in a team the asker leads (a mid-level lead asking its own members, not the team above)
  const name = headName(from, ctx);
  const text = (to) => {
    const who = TT.relation(teamsIn(from, ctx), from, convId(to) || to) === 'lead' ? 'your lead ' : '';
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

// POST /api/sessions/:id/answer { option: n | "submit" | "esc", sig?, text?, allowPermission?, wait? }
// The menu is read again first: none is 409, one whose sig differs from the caller's is 409 { stale, menu }. A
// menu other than a question (a tool's permission prompt, the folder trust question, the plan approval, one not
// recognised) is answered only with allowPermission: an orchestrator must never approve a tool call by accident. option "esc" presses Esc once (it cancels the menu). text goes with
// an AskUserQuestion's "Type something." option (o.free): the pointer onto it, what it holds cleared, the text pasted,
// then Enter (in a multiple-choice question no Enter: that would untick it). Any other option is its digit (Claude
// Code picks it at once; in a multiple-choice question it ticks or unticks it), or ↑/↓ to it and Enter past 9,
// while the pointer is on "Type something" (a digit would be typed into it), or in a menu drawn without numbers
// (m.unnumbered: 2.1.296's trust question, or an MCP server's one-line "❯ Accept    Decline", where a digit does nothing). "submit": a multiple-choice question's
// Submit row. Then up to ANSWER_MS for the menu to
// change; with wait, once no menu is left, the turn is waited on like a message's. The folder trust question answered
// Yes: a Claude in Chrome offer that comes up after it is answered too (chromeOffer: 'accepted').
async function answerMenu(key, b, ctx, gone, via = null) {
  if (!b || typeof b !== 'object') return [400, { ok: false, message: 'bad json' }];
  const esc = b.option === 'esc';
  if (!esc && b.option !== 'submit' && !(Number.isInteger(b.option) && b.option >= 1 && b.option <= 99)) return [400, { ok: false, message: 'option must be an option\'s number, "submit" or "esc"' }];
  if (b.sig != null && typeof b.sig !== 'string') return [400, { ok: false, message: 'sig must be the menu\'s sig, as GET .../menu gave it' }];
  if ('allowPermission' in b && typeof b.allowPermission !== 'boolean') return [400, { ok: false, message: 'allowPermission must be true or false' }];
  let text = null;
  if (b.text != null) {
    text = cleanText(b.text);
    if (!text) return [400, { ok: false, message: 'text must be text, without control characters other than new lines and tabs' }];
    if (typeof b.option !== 'number') return [400, { ok: false, message: 'text goes with a "Type something." option' }];
    // a new line there would go in as Ctrl+J, inside the question's one-line answer: join the lines
    text = text.split(/\s*\n\s*/).filter(Boolean).join(' ');
  }
  const ms = waitMs(b.wait);
  if (ms === null) return [400, { ok: false, message: WAIT_BAD }];
  return withHost(async (host) => {
    const { p, err } = await need(host, key, true);
    if (err) return err;
    // an overseer's question answered in words by anyone but Henry: marked so (one line, overseer.js frame)
    if (text && isOverseer(p.role) && via !== 'henry') text = `${OVERSEER.UNSIGNED} ${OVERSEER.neutralise(text)}`;
    const m = await menuNow(host, p);
    if (!m) return [409, { ok: false, id: p.id, menu: false, message: 'no menu is up' }];
    if (b.sig != null && b.sig !== m.sig) return [409, { ok: false, id: p.id, stale: true, menu: m, message: 'the menu changed since you read it: read it again' }];
    // fail closed: only a question is answered without it. A permission prompt, the folder trust question, the plan
    // approval (its options turn on auto-accept or bypass) and any menu not recognised all need allowPermission;
    // Esc (deny, cancel) never does
    if (!esc && m.kind !== 'question' && b.allowPermission !== true) {
      const what = { permission: 'a permission prompt', trust: 'the folder trust question', plan: 'the plan approval', chrome: 'the Claude in Chrome offer' }[m.kind] || 'not a question';
      return [403, { ok: false, id: p.id, menu: m, message: `that is ${what}: only a question may be answered without allowPermission (Esc is always allowed)` }];
    }
    // the same question as m: its title and options, whatever the pointer, the ticks and the typed text say
    const sameQ = (x) => !!x && JSON.stringify([x.title, x.options.map((o) => (o.free ? '' : o.label))])
      === JSON.stringify([m.title, m.options.map((o) => (o.free ? '' : o.label))]);
    // the screen read again until ok(menu) holds for the same question -> that menu, or null
    const settle = async (ok) => {
      for (const end = Date.now() + POINT_MS; Date.now() < end;) {
        await sleep(POLL_MS / 4);
        const x = await menuNow(host, p);
        if (sameQ(x) && ok(x)) return x;
      }
      return null;
    };
    // the pointer to option n, or to a multiple-choice question's Submit row ('submit'), with ↑/↓
    const pointTo = async (want) => {
      const cur = await menuNow(host, p);
      if (!sameQ(cur)) return null;
      const rows = [], lastBox = cur.submit ? cur.options.filter((o) => o.check != null).pop() : null;
      for (const o of cur.options) { rows.push(o.n); if (o === lastBox) rows.push('submit'); }
      const from = cur.submit && cur.submit.on ? rows.indexOf('submit') : rows.indexOf(cur.options.find((o) => o.on)?.n);
      const to = rows.indexOf(want);
      if (from < 0 || to < 0) return null;
      const at = (x) => (want === 'submit' ? !!(x.submit && x.submit.on) : x.options.some((o) => o.n === want && o.on));
      if (from === to) return cur;
      await host.call('write', p.id, (to > from ? '\x1b[B' : '\x1b[A').repeat(Math.abs(to - from)));
      return settle(at);
    };
    let answered, before = m;
    if (esc) {
      await host.call('write', p.id, '\x1b');
      answered = 'esc';
    } else if (b.option === 'submit') {
      if (!m.submit) return [400, { ok: false, id: p.id, menu: m, message: 'this menu has no Submit row (only a multiple-choice question has one)' }];
      if (!(await pointTo('submit'))) return [409, { ok: false, id: p.id, menu: await menuNow(host, p), message: 'the pointer did not reach Submit: nothing was sent' }];
      await host.call('write', p.id, '\r');
      answered = 'submit';
    } else {
      const opt = m.options.find((o) => o.n === b.option);
      if (!opt) return [400, { ok: false, id: p.id, menu: m, message: `no option ${b.option}: the menu has ${m.options.map((o) => o.n).join(', ')}` }];
      const typed = !!opt.free, multi = opt.check != null;
      if (text && !typed) return [400, { ok: false, id: p.id, menu: m, message: 'text goes only with a "Type something." option' }];
      if (typed && !text) return [400, { ok: false, id: p.id, menu: m, message: 'that option takes text: pass text' }];
      // with the pointer on "Type something" a digit would be typed into it
      const onFree = !!m.options.find((o) => o.on)?.free;
      if (typed) {
        // onto it: its digit in a one-answer question (a digit there only moves the pointer), ↑/↓ in a
        // multiple-choice one (a digit there ticks it)
        let at = opt.on ? m : null;
        if (!at && !multi && opt.n <= 9 && !onFree && !m.unnumbered) {
          await host.call('write', p.id, String(opt.n));
          at = await settle((x) => x.options.some((o) => o.free && o.on));
        } else if (!at) at = await pointTo(opt.n);
        if (!at) return [409, { ok: false, id: p.id, menu: await menuNow(host, p), message: 'the pointer did not reach that option: nothing was typed' }];
        // what is typed there already goes first (Ctrl+U)
        if (!FREE_EMPTY.test(at.options.find((o) => o.free).label)) {
          await host.call('write', p.id, '\x15');
          await sleep(TYPE_DELAY_MS);
        }
        // only into the question still up: with no menu there the paste would land in the prompt box and the Enter
        // would send it as a message (fail closed)
        const notQuestion = async () => { const x = await menuNow(host, p); return !x || x.kind !== 'question'; };
        if (await notQuestion()) return [409, { ok: false, id: p.id, menu: await menuNow(host, p), message: 'the question is no longer up after picking that option: the text was not typed' }];
        if (multi) {
          // a multiple-choice question: the text ticks it, and Enter would untick it (Submit sends the answers)
          await typePasted(host, p.id, text);
        } else {
          const sent = await sendText(host, p.id, text, notQuestion);
          if (!sent.entered) return [409, { ok: false, id: p.id, message: 'the question went away before Enter: the text was pasted (it may sit in its prompt box) but not sent' }];
        }
      } else if (opt.n <= 9 && !onFree && !m.unnumbered) await host.call('write', p.id, String(opt.n));
      else {
        // two digits would pick the first at once, and a menu without numbers takes none: move the pointer
        // instead, then Enter
        const at = await pointTo(opt.n);
        if (!at) return [409, { ok: false, id: p.id, menu: await menuNow(host, p), message: 'the pointer did not reach that option: nothing was picked' }];
        before = at; // the pointer moved the sig: the answer shows as a change from this one
        await host.call('write', p.id, '\r');
      }
      answered = { n: opt.n, label: opt.label };
    }
    const at = Date.now();
    let next = before;
    for (const end = at + ANSWER_MS; Date.now() < end;) {
      await sleep(POLL_MS / 2);
      const q = hosted(await host.call('list'), p.id);
      if (!q || !q.alive) { next = null; break; }
      next = await menuNow(host, q);
      if (!next || next.sig !== before.sig) break;
    }
    const changed = !next || next.sig !== before.sig;
    // the folder trust question answered Yes: Claude Code may put up its Claude in Chrome offer next, which startSession
    // (it leaves trust to its caller) never sees. Watched up to TRUST_NEXT_MS, before any wait: the offer is passed
    // (passChromeOffer; the host keeps no record of a start's chrome: false, so undefined); idle with no menu, any
    // other menu or the session ending stops it, and leaves that alone
    let chromeOffer = null;
    if (changed && m.kind === 'trust' && /^yes\b/i.test(answered.label || '')) {
      for (const end = Date.now() + TRUST_NEXT_MS; Date.now() < end;) {
        const q = hosted(await host.call('list'), p.id);
        if (!q || !q.alive) break;
        const x = await menuNow(host, q);
        if (x && x.kind === 'chrome') { if (await passChromeOffer(host, q, undefined, ctx)) { chromeOffer = 'accepted'; next = await menuNow(host, q); } break; }
        if (x ? x.kind !== 'trust' : q.status === 'idle') break;
        await sleep(POLL_MS);
      }
    }
    const out = { ok: true, id: p.id, answered, changed, next, ...(chromeOffer ? { chromeOffer } : {}) };
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

// ---------- the chat's verbs: send now, unsend, model and effort, the activity line ----------
// What the page's Chat tab does below its feed (web/compose.js), for a caller that has no screen of its own (the
// phone's chat): the same keys and the same checks, with the screen read from the host's snapshot (screen.js ports of
// compose.js's readers) instead of an xterm.
const CHORD_MS = 150; // between the two keys of Claude Code's "send now" chord (compose.js waits the same)
const QUEUE_LOOKS = 8, QUEUE_LOOK_MS = 250; // a message just sent may take a moment to show in the transcript's queue
const flat = (v) => String(v || '').replace(/\[Image #\d+\]\s*/g, '').replace(/\s+/g, ' ').trim(); // compose.js flat
const squash = (v) => String(v || '').replace(/\s+/g, ''); // the prompt box wraps a message at its width
// the session's screen, its rows as drawn (the last n); marks: dim and inverse runs marked (screen.js render)
async function rowsNow(host, p, n = 60, marks = false) {
  const raw = await host.call('snapshot', p.id);
  const { cols, rows } = sizeOf(p);
  return SCREEN.render(typeof raw === 'string' ? raw : '', cols, rows, n, false, marks);
}
// the messages Claude Code holds queued for a conversation (typed while it works), oldest first, from its transcript's
// queue-operation lines (conversation.js) -> [text]
async function claudeQueue(id, ctx) {
  const cid = convId(id);
  if (!cid || !ctx.transcript) return [];
  try { const t = await ctx.transcript(cid, { limit: 1 }); return t && Array.isArray(t.queue) ? t.queue : []; } catch { return []; }
}
// Claude Code's "send now", Ctrl+X then Ctrl+S on its own (a chord; compose.js sendNow): it stops the step Claude is on
// and sends every queued message as the next turn, as that terminal's "ctrl+x ctrl+s to send now" does
async function pressSendNow(host, id) {
  await host.call('write', id, '\x18');
  await sleep(CHORD_MS);
  await host.call('write', id, '\x13');
}
const PANEL_UP = 'a panel is open in its terminal (like /usage): close it there first (Esc)';

// POST /api/sessions/:id/now: the page's Interrupt on a queued message. Only while Claude works with messages queued
// in Claude Code (its transcript says so), and no menu or panel up (the keys would go to it). Every queued message
// goes, as in the terminal. (POST .../message with now: true sends one and does this right after.)
async function sendNowSession(key, ctx) {
  return withHost(async (host) => {
    const { p, err } = await need(host, key, true);
    if (err) return err;
    if (panelOpen(p)) return [409, { ok: false, id: p.id, panel: true, message: PANEL_UP }];
    if (p.status !== 'busy') return [409, { ok: false, id: p.id, status: p.status || null, message: 'Claude is not working on anything: a message goes straight in' }];
    const m = await menuNow(host, p);
    if (m) return [409, { ok: false, id: p.id, menu: m, message: MENU_UP }];
    let queued = [];
    for (let i = 0; i < QUEUE_LOOKS && !queued.length; i++) {
      if (i) await sleep(QUEUE_LOOK_MS);
      queued = await claudeQueue(p.id, ctx);
    }
    if (!queued.length) return [409, { ok: false, id: p.id, queue: [], message: 'nothing is queued: Claude took it already' }];
    await typeOne(p.id, () => pressSendNow(host, p.id));
    return [200, { ok: true, id: p.id, sent: queued, message: `sent now: Claude stops the step it is on and takes ${queued.length === 1 ? 'the queued message' : `the ${queued.length} queued messages`}` }];
  });
}

// POST /api/sessions/:id/unsend { text }: takes a message back before Claude reads it. Text waiting in Fleet View's own
// queue (behind a menu, above; not one from another conversation) is just dropped there. Else it comes out of Claude
// Code's queue the way the page's Unsend does (compose.js unsendQueued): Up pulls every queued message into the
// prompt, Ctrl+U clears it a row at a time (Ctrl+C or Esc would stop Claude), and the others are queued again, each
// as it was (never into a menu: each one's Enter waits for none to be up). Claude Code reads its queue into the
// running turn at its next step (2 to 4 s after the send, often), so this often finds it gone: 409 taken.
async function unsendMessage(key, b, ctx) {
  if (!b || typeof b !== 'object') return [400, { ok: false, message: 'bad json' }];
  const text = cleanText(b.text);
  if (!text) return [400, { ok: false, message: 'text must be the message as it was sent' }];
  const want = flat(text);
  const asked = resolveKey(key);
  const succ = convId(asked) && ctx.successorOf ? ctx.successorOf(convId(asked)) : null;
  const id = succ && succ !== convId(asked) ? succ : asked;
  // as it waits in Fleet View's queue: framed for an overseer (overseer.js frame), else as it is
  const forms = new Set([text, OVERSEER.frame(text, 'henry'), OVERSEER.frame(text, 'unsigned')].map(flat));
  const mine = loadQueue().find((x) => x.id === id && !x.from && !x.kind && forms.has(flat(x.text)));
  if (mine) {
    unqueue(mine);
    return [200, { ok: true, id, unsent: true, where: 'fleetView', message: 'taken back: it was waiting in Fleet View for a menu to be answered' }];
  }
  return withHost(async (host) => {
    const { p, err } = await need(host, id, true);
    if (err) return err;
    // the others in Claude Code's queue (the transcript may lag the send by a moment)
    let rest = null;
    for (let i = 0; i < QUEUE_LOOKS && !rest; i++) {
      if (i) await sleep(QUEUE_LOOK_MS);
      const q = (await claudeQueue(p.id, ctx)).slice();
      let k = q.findIndex((x) => flat(x) === want);
      if (k < 0 && want) k = q.findIndex((x) => flat(x).includes(want.slice(0, 80)));
      if (k >= 0) { q.splice(k, 1); rest = q; }
    }
    if (!rest) return [409, { ok: false, id: p.id, taken: true, message: 'it is not queued any more: Claude already took it' }];
    if (panelOpen(p)) return [409, { ok: false, id: p.id, panel: true, message: PANEL_UP }];
    const m = await menuNow(host, p);
    if (m) return [409, { ok: false, id: p.id, menu: m, message: MENU_UP }];
    return typeOne(p.id, async () => {
      const box = async () => SCREEN.promptBox(await rowsNow(host, p, 60, true));
      const b0 = await box();
      if (!b0 || b0.text) return [409, { ok: false, id: p.id, message: b0 ? 'something is typed in its prompt: clear it in the Session tab first' : 'its prompt is not on screen' }];
      await host.call('write', p.id, '\x1b[A');
      let b1 = null;
      for (let i = 0; i < 10 && !(b1 && b1.text); i++) { await sleep(150); b1 = await box(); }
      if (!b1 || !b1.text) return [409, { ok: false, id: p.id, taken: true, message: 'it could not be taken back: the queue was empty (Claude took it)' }];
      // Ctrl+U until the prompt is empty
      let empty = false;
      for (let i = 0; i < 40 && !empty; i++) {
        const b2 = await box();
        if (!b2) break;
        if (!b2.text) { empty = true; break; }
        await host.call('write', p.id, '\x15'.repeat(Math.min(b2.lines + 1, 30)));
        await sleep(120);
      }
      if (!empty) return [409, { ok: false, id: p.id, message: 'the queued messages are in its prompt and it could not be cleared: clear it in the Session tab' }];
      // what Up pulled is what is queued now: the message itself, unless Claude took it meanwhile (then only the others
      // that are still queued go back)
      const pulled = squash(b1.text);
      const was = pulled.includes(squash(want).slice(0, 60));
      const back = rest.map(cleanText).filter((x) => x && pulled.includes(squash(x).slice(0, 60)));
      let requeued = 0;
      for (const x of back) {
        const sent = await sendText(host, p.id, x, () => menuNow(host, p));
        if (!sent.entered) return [409, { ok: false, id: p.id, unsent: was, requeued, menu: true, message: `${was ? 'taken back, but ' : ''}a menu came up while the other queued messages went back: the next one is in its prompt box, not sent` }];
        requeued++;
        await sleep(250);
      }
      if (!was) return [409, { ok: false, id: p.id, taken: true, requeued, message: 'Claude took it just now; the other queued messages are queued again' }];
      return [200, { ok: true, id: p.id, unsent: true, where: 'claude', requeued, message: requeued ? `taken back; the ${requeued} other queued message${requeued > 1 ? 's are' : ' is'} queued again` : 'taken back' }];
    });
  });
}

// ---------- the chat's other verbs: Send it, run in background, the permission mode ----------
// a text with no spaces at all (and no "\": Claude Code makes "\" then Enter a new line), so a box that wraps a long
// word anywhere still reads as the text (compose.js watchSent's squash)
const bare = (v) => flat(v).replace(/[\s\\]/g, '');
// the prompt box's text from marked rows: '' empty, a bash-mode box's as "!<command>" (as the feed shows a "!"
// command), null when neither is on screen
function boxText(marked) {
  const box = SCREEN.promptBox(marked);
  if (box) return box.text;
  const bash = SCREEN.bashBox(marked);
  return bash ? `!${bash.text}` : null;
}

// POST /api/sessions/:id/enter { text }: the page's Send it ('fv-chat-stuck', compose.js enterAgain) for a message left
// in Claude Code's prompt: it took the Enter as something else (one typed while it starts up is dropped), so the text
// sits there unsent. Enter once more, and only while the box holds exactly that text (bare, as above; a bash command as
// "!<command>") with no menu or panel up: anything else typed there, or a question the Enter would answer, gets no key.
async function enterAgain(key, b) {
  if (!b || typeof b !== 'object') return [400, { ok: false, message: 'bad json' }];
  const text = cleanText(b.text);
  const want = text ? bare(text) : '';
  if (!want) return [400, { ok: false, message: 'text must be the message as it was sent' }];
  return withHost(async (host) => {
    const { p, err } = await need(host, key, true);
    if (err) return err;
    if (panelOpen(p)) return [409, { ok: false, id: p.id, panel: true, message: PANEL_UP }];
    return typeOne(p.id, async () => {
      const m = await menuNow(host, p);
      if (m) return [409, { ok: false, id: p.id, menu: m, message: MENU_UP }];
      const now = boxText(await rowsNow(host, p, 60, true));
      if (now == null) return [409, { ok: false, id: p.id, message: 'its prompt is not on screen' }];
      if (bare(now) !== want) {
        return [409, { ok: false, id: p.id, gone: !now, message: now ? 'something else is in its prompt now: see the Session tab' : 'it is not in Claude\'s prompt any more: it went in, or was cleared' }];
      }
      await host.call('write', p.id, '\r');
      return [200, { ok: true, id: p.id, message: 'Enter pressed again' }];
    });
  });
}

// POST /api/sessions/:id/background: the page's Run in background (compose.js runInBackground): Ctrl+B, which sends the
// shell command Claude runs to the background so Claude carries on. Only while Claude works and its screen offers it
// ("ctrl+b to run in background"), with no menu or panel up (the key would go to them).
async function backgroundSession(key) {
  return withHost(async (host) => {
    const { p, err } = await need(host, key, true);
    if (err) return err;
    if (panelOpen(p)) return [409, { ok: false, id: p.id, panel: true, message: PANEL_UP }];
    return typeOne(p.id, async () => {
      const m = await menuNow(host, p);
      if (m) return [409, { ok: false, id: p.id, menu: m, message: MENU_UP }];
      const rows = await rowsNow(host, p, 40);
      const spin = SCREEN.spinner(rows);
      if (!(p.status === 'busy' || (spin && spin.strong)) || !SCREEN.bgOffered(rows)) {
        return [409, { ok: false, id: p.id, status: p.status || null, message: 'nothing can go to the background now: Claude Code offers it only while a shell command runs' }];
      }
      await host.call('write', p.id, '\x02');
      return [200, { ok: true, id: p.id, message: 'Ctrl+B pressed: the shell command goes on in the background' }];
    });
  });
}

// POST /api/sessions/:id/mode { mode }: the page's permission mode menu (compose.js switchMode): Shift+Tab, which cycles
// Claude Code's modes, until its footer shows the one asked for (screen.js modeShown, after each press up to
// MODE_LOOK_MS for the footer to redraw), at most MODE_MAX_PRESSES presses, stopping once round to where it began (a
// mode this session does not have: bypass only when it started with it, auto where Claude Code offers it). Only from a
// mode it can read, while Claude is idle, with no menu or panel up: Shift+Tab on a permission prompt answers it ("allow
// all edits during this session"). An overseer's mode is Henry's to change, as its model (only through the phone relay).
const MODES = ['default', 'acceptEdits', 'plan', 'auto', 'bypass'];
const MODE_LABEL = { default: 'Ask before edits', acceptEdits: 'Accept edits', plan: 'Plan mode', auto: 'Auto mode', bypass: 'Bypass permissions' };
const MODE_MAX_PRESSES = 5, MODE_STEP_MS = 250, MODE_LOOK_MS = 1000;
async function switchMode(key, b, ctx, via = null) {
  if (!b || typeof b !== 'object') return [400, { ok: false, message: 'bad json' }];
  if (!MODES.includes(b.mode)) return [400, { ok: false, message: `mode must be one of ${MODES.join(', ')}` }];
  const want = b.mode;
  return withHost(async (host) => {
    const { p, err } = await need(host, key, true);
    if (err) return err;
    if (isOverseer(p.role) && via !== 'henry') return [403, { ok: false, id: p.id, message: 'only Henry changes an overseer\'s permission mode (his phone)' }];
    if (panelOpen(p)) return [409, { ok: false, id: p.id, panel: true, message: PANEL_UP }];
    if (p.status !== 'idle') return [409, { ok: false, id: p.id, status: p.status || null, message: p.status === 'waiting' ? 'Claude is waiting on an answer: switch the mode once it is idle' : 'Claude is working: switch the mode once it is idle' }];
    return typeOne(p.id, async () => {
      const read = async () => SCREEN.modeShown(await rowsNow(host, p, 40));
      const m = await menuNow(host, p);
      if (m) return [409, { ok: false, id: p.id, menu: m, message: MENU_UP }];
      const from = await read();
      if (!from) return [409, { ok: false, id: p.id, message: 'its mode could not be read (the footer under its prompt is not on screen)' }];
      if (from === want) return [200, { ok: true, id: p.id, mode: from, changed: false, message: `it is on ${MODE_LABEL[from]} already` }];
      let now = from;
      for (let i = 0; i < MODE_MAX_PRESSES && now !== want; i++) {
        if (await menuNow(host, p)) break;
        const was = now;
        await host.call('write', p.id, '\x1b[Z');
        for (const end = Date.now() + MODE_LOOK_MS; Date.now() < end;) {
          await sleep(MODE_STEP_MS);
          const x = await read();
          if (x && x !== was) { now = x; break; }
        }
        if (now === from) break; // round the whole cycle without it
      }
      if (now === want) {
        if (ctx && ctx.log) ctx.log(`api: ${p.id}: permission mode ${from} -> ${now}`);
        return [200, { ok: true, id: p.id, mode: now, from, changed: true, message: `switched to ${MODE_LABEL[now]}` }];
      }
      const why = want === 'bypass' ? ' (only a session started with it has it)' : want === 'auto' ? ' (only where Claude Code offers it)' : '';
      return [409, { ok: false, id: p.id, mode: now, from, changed: now !== from, message: `couldn't switch to ${MODE_LABEL[want]}${why}; it is on ${MODE_LABEL[now] || now}` }];
    });
  });
}

// POST /api/sessions/:id/panel { key } | { tab }: the page's panel card (compose.js panelKey, panelTab) for a caller
// that has no terminal of its own (the phone): key, one of PANEL_KEYS, pressed once, as the card's keycaps press it;
// tab, which of the panel's tabs (from 0, as /activity's panel lists them): Tab pressed until that one is on, from the
// one on now. Only while a panel is on its screen (shownFrom: not a question Claude asks), so an Esc never reaches
// Claude mid-turn as an interrupt and an Enter never answers a menu. -> { panel }: the panel as it reads a moment after
// (null once it closed: an Esc waits up to PANEL_GONE_MS for that, as a search box takes one Esc first). An
// overseer's: Henry only (his phone), as its permission mode (a panel such as /permissions or /config changes it)
const PANEL_KEYS = { up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C', tab: '\t', enter: '\r', esc: '\x1b' };
const PANEL_TABS_MAX = 20;
const PANEL_TAB_MS = 90; // between the Tabs to a tab (compose.js panelTab)
const PANEL_LOOK_MS = 250; // after a key, before the panel is read again
const PANEL_GONE_MS = 1500; // after an Esc: how long to look for the panel to close
const NO_PANEL = 'no panel is open in its terminal (a "/" command such as /usage opens one)';
async function pressPanel(key, b, ctx, via = null) {
  if (!b || typeof b !== 'object') return [400, { ok: false, message: 'bad json' }];
  const hasKey = b.key !== undefined, hasTab = b.tab !== undefined;
  if (hasKey === hasTab) return [400, { ok: false, message: 'give key or tab (one of the two)' }];
  if (hasKey && !Object.prototype.hasOwnProperty.call(PANEL_KEYS, b.key)) return [400, { ok: false, message: `key must be one of ${Object.keys(PANEL_KEYS).join(', ')}` }];
  if (hasTab && !(Number.isInteger(b.tab) && b.tab >= 0 && b.tab < PANEL_TABS_MAX)) return [400, { ok: false, message: `tab must be a whole number from 0 to ${PANEL_TABS_MAX - 1} (which tab, from the left)` }];
  return withHost(async (host) => {
    const { p, err } = await need(host, key, true);
    if (err) return err;
    if (isOverseer(p.role) && via !== 'henry') return [403, { ok: false, id: p.id, message: 'only Henry drives an overseer\'s panel (his phone)' }];
    return typeOne(p.id, async () => {
      const read = async () => shownFrom(await host.call('snapshot', p.id), p);
      const now = await read();
      if (!now.panel) return [409, { ok: false, id: p.id, panel: null, ...(now.menu ? { menu: now.menu, message: MENU_UP } : { message: NO_PANEL }) }];
      let what;
      if (hasTab) {
        const tabs = now.panel.tabs, cur = tabs.findIndex((t) => t.on);
        if (!tabs.length) return [409, { ok: false, id: p.id, panel: now.panel, message: 'this panel has no tabs' }];
        if (b.tab >= tabs.length) return [409, { ok: false, id: p.id, panel: now.panel, message: `this panel has ${tabs.length} tabs` }];
        if (cur < 0) return [409, { ok: false, id: p.id, panel: now.panel, message: 'which tab is on could not be read' }];
        for (let n = (b.tab - cur + tabs.length) % tabs.length; n > 0; n--) {
          await host.call('write', p.id, PANEL_KEYS.tab);
          if (n > 1) await sleep(PANEL_TAB_MS);
        }
        what = `on the ${tabs[b.tab].label} tab`;
      } else {
        await host.call('write', p.id, PANEL_KEYS[b.key]);
        what = `${b.key === 'esc' ? 'Esc' : b.key === 'enter' ? 'Enter' : b.key === 'tab' ? 'Tab' : `${b.key[0].toUpperCase()}${b.key.slice(1)}`} pressed`;
      }
      // the panel as it reads now: an Esc looks a while longer for it to close
      let after = null;
      for (const end = Date.now() + (b.key === 'esc' ? PANEL_GONE_MS : 0); ;) {
        await sleep(PANEL_LOOK_MS);
        after = (await read()).panel;
        if (!after || Date.now() >= end) break;
      }
      return [200, { ok: true, id: p.id, panel: after, message: after ? what : `${what}: the panel closed` }];
    });
  });
}

// ---------- Rewind and Edit on one of your messages ----------
// What the page's Rewind and Edit do (web/chat.js rewind and editMsg, web/compose.js rewindTo, rewindSteps, takeRewound
// and restored), for a caller with no terminal of its own (the phone's chat): Claude Code's own /rewind, driven through
// the host, with the screen read from its snapshot. "/rewind" is typed and sent, ↑ walks up its list (newest at the
// bottom) until the ❯ is on the nth entry from the end that shows the message (screen.js rewindList, rewindMatches: an
// entry is the message's first line, cut to the width), and Enter picks it. Claude Code then asks what to restore
// (code and conversation, the conversation, the code, or Never mind). As on the page that question is the user's: it is
// never answered here (the phone shows it as a menu card, POST .../answer). Once answered, Claude Code puts the message
// back into its prompt; followRewind clears it there and, for an Edit, sends the edited text in its place
// (deliverText, as POST .../message would), or the restore left the conversation as it was and the edit is not sent.
// GET .../activity's `rewind` says how it ended, so the caller can put the text back in its own box: the old message
// after a Rewind (as the page's box gets it), the edit when it did not go.
// Unlike the page, it never stops Claude first (Esc mid-turn) or starts a session that is not running: only while
// Claude is idle, no menu or panel up and nothing typed in its prompt (409 says which). Something unexpected on screen
// mid-way is backed out of (rewindBackOut) and said. An overseer's conversation is Henry's alone to rewind (his phone).
const REWIND_ROWS = 24; // /rewind's list needs about this many rows to show its entries and ❯ (compose.js)
const REWIND_LINES = 80; // the rows its list is read from (compose.js PANEL_LINES)
const REWIND_WALK_MS = 40000; // the walk up its list at most (the relay gives the whole route 60 s)
const REWIND_PRESSES = 500; // ↑ presses at most (compose.js)
const REWIND_PICK_MS = 6000; // after the pick: how long Claude Code may take to ask what to restore
const REWIND_TICK_MS = 400; // followRewind: how often it reads the screen
const REWIND_FOLLOW_MS = 120000; // ...and for how long (compose.js takeRewound)
const REWIND_EMPTY_MS = 1500; // the question gone and the prompt empty this long: nothing was restored (compose.js)
const REWIND_SHOW_MS = 180000; // how long after it ended GET .../activity still says how
const rewinds = new Map(); // host id -> the rewind followed now (followRewind)
const clipText = (v) => { const s = String(v || '').replace(/\s+/g, ' ').trim(); return s.length > 60 ? `${s.slice(0, 59)}…` : s; };
// a restore question rather than the list itself (a list footer that reads as a menu, or the question drawn under the
// list's header): its options are Claude Code's restore choices
const RESTORE_OPT = /^(?:Restore\b|Never mind\b|Summarize\b)/i;
const restoreAsked = (m) => !!m && m.options.some((o) => RESTORE_OPT.test(String(o.label || '').trim()));

// Ctrl+U until the prompt box is empty (it clears a row at a time; Unsend's loop) -> true once it is
async function clearPrompt(host, p) {
  for (let i = 0; i < 40; i++) {
    const box = SCREEN.promptBox(await rowsNow(host, p, 60, true));
    if (!box) return false;
    if (!box.text) return true;
    await host.call('write', p.id, '\x15'.repeat(Math.min(box.lines + 1, 30)));
    await sleep(120);
  }
  return false;
}
// Something other than what was expected is on screen mid-way: back out of it, so nothing is left half done. The list
// or its restore question gets one Esc (never two: two quick Escs at Claude Code's prompt open its rewind list),
// "/rewind" left in the prompt is cleared. Any other menu is left alone: Esc would answer it (deny a tool call).
// -> what happened, for the 409
async function rewindBackOut(host, p, what) {
  const raw = await host.call('snapshot', p.id);
  const { cols, rows } = sizeOf(p);
  const s = typeof raw === 'string' ? raw : '';
  const L = SCREEN.render(s, cols, rows, REWIND_LINES, false);
  const m = menuFrom(s, p);
  if (SCREEN.rewindList(L) || restoreAsked(m)) {
    await host.call('write', p.id, '\x1b');
    return `${what} (Esc closed /rewind: see the Session tab)`;
  }
  if (m) return `${what}; Claude is asking something now ("${clipText(m.title || 'a menu')}"): answer it in the chat`;
  const box = SCREEN.promptBox(SCREEN.render(s, cols, rows, 60, false, true));
  if (box && /^\/rewind\b/.test(box.text)) return (await clearPrompt(host, p)) ? `${what} ("/rewind" was cleared from its prompt)` : `${what}; "/rewind" is still in its prompt: clear it in the Session tab`;
  return `${what}: see the Session tab`;
}

// POST /api/sessions/:id/rewind { text, nth?, edit? }: text is the message as the transcript has it, nth which of the
// messages showing that text it is, counted from the newest (0, the default: the newest), edit the text to send in its
// place (Edit). -> 200 { ok, id, menu, at, message }: menu is Claude Code's restore question now up (null when it
// restored at once), to be answered by the caller; at, when it started (GET .../activity's rewind.at for this one)
async function rewindSession(key, b, ctx, via = null) {
  if (!b || typeof b !== 'object') return [400, { ok: false, message: 'bad json' }];
  const text = cleanText(b.text);
  if (!text) return [400, { ok: false, message: 'text must be the message as it was sent' }];
  if (b.nth != null && !(Number.isInteger(b.nth) && b.nth >= 0 && b.nth < REWIND_PRESSES)) return [400, { ok: false, message: `nth must be a whole number from 0 (the newest message with that text) to ${REWIND_PRESSES - 1}` }];
  const nth = b.nth || 0;
  let edit = null;
  if (b.edit != null) {
    edit = cleanText(b.edit);
    if (!edit) return [400, { ok: false, message: 'edit must be the text to send in its place, without control characters other than new lines and tabs' }];
  }
  return withHost(async (host) => {
    const { p, err } = await need(host, key, true);
    if (err) return err;
    // it drops turns from the conversation: an overseer's history is Henry's to change, as its model and mode
    if (isOverseer(p.role) && via !== 'henry') return [403, { ok: false, id: p.id, message: 'only Henry rewinds an overseer\'s conversation (his phone)' }];
    if (panelOpen(p)) return [409, { ok: false, id: p.id, panel: true, message: PANEL_UP }];
    if (p.status !== 'idle') return [409, { ok: false, id: p.id, status: p.status || null, message: p.status === 'waiting' ? 'Claude is waiting on an answer: answer it first, then rewind' : 'Claude is working: stop it first, then rewind' }];
    return typeOne(p.id, () => rewindSteps(host, p, text, nth, edit, ctx, via));
  });
}

async function rewindSteps(host, p0, text, nth, edit, ctx, via) {
  const w = await rewindWalk(host, p0, text, nth);
  if (w.err) return w.err;
  const { p, menu } = w;
  // followed from here: what the restore puts back in its prompt is cleared, and an edit sent in its place
  const job = { id: p.id, text, edit, via, at: Date.now(), sawMenu: !!menu, emptyAt: 0, state: 'asking', message: '', doneAt: 0 };
  rewinds.set(p.id, job);
  followRewind(job, ctx);
  if (ctx && ctx.log) ctx.log(`api: ${p.id}: rewound to before a message${edit ? ' (an edit)' : ''}${menu ? '; Claude Code asks what to restore' : ''}`);
  const then = edit ? 'your edit goes in once the conversation is back' : 'the message comes back to your box';
  return [200, { ok: true, id: p.id, menu, at: job.at, message: menu ? `Claude Code asks what to restore: answer it; ${then}` : `went back to just before it; ${then}` }];
}

// The walk itself, for Rewind and Fork from here (followFork): the prompt checked empty and idle with no menu, the
// terminal made tall enough, "/rewind" and Enter, ↑ up its list to the nth entry from the newest that shows text, Enter,
// then up to REWIND_PICK_MS for Claude Code to ask what to restore (or restore at once). -> { p (at the size it was
// read), menu (the restore question, or null), restored } or { err: [409, json] }, anything half done backed out of
async function rewindWalk(host, p0, text, nth) {
  let p = p0;
  const no = (code, message, more = {}) => ({ err: [code, { ok: false, id: p.id, ...more, message }] });
  const m0 = await menuNow(host, p);
  if (m0) return no(409, MENU_UP, { menu: m0 });
  // the prompt, empty: one read can miss it (a redraw on its way), so it is read again for a moment (compose.js)
  const boxNow = async () => SCREEN.promptBox(await rowsNow(host, p, 60, true));
  let b0 = await boxNow();
  for (let i = 0; i < 10 && !(b0 && !b0.text); i++) { await sleep(150); b0 = await boxNow(); }
  if (!b0) return no(409, 'its prompt is not on screen: see the Session tab');
  if (b0.text) return no(409, `something is typed in its prompt ("${clipText(b0.text)}"): clear it in the Session tab first`);
  if (SCREEN.spinner(await rowsNow(host, p, 40))?.strong) return no(409, 'Claude is working: stop it first, then rewind');
  // a short terminal shows too little of the list: made taller first, as the page does (compose.js growRows), and the
  // screen then read at that size
  const size = sizeOf(p);
  if (size.rows < REWIND_ROWS) {
    await host.call('resize', p.id, size.cols, REWIND_ROWS);
    await sleep(600); // the pty takes the new size and Claude Code redraws
    const fresh = hosted(await host.call('list'), p.id) || p;
    p = { ...fresh, cols: size.cols, rows: Math.max(REWIND_ROWS, Number.isInteger(fresh.rows) ? fresh.rows : 0) };
  }
  // "/rewind" and Enter, never into a menu that came up meanwhile
  const sent = await sendText(host, p.id, '/rewind', () => menuNow(host, p));
  if (!sent.entered) return no(409, `${MENU_UP} (a menu came up just before Enter: "/rewind" is in its prompt box, not sent)`, { menu: true });
  const list = async () => SCREEN.rewindList(await rowsNow(host, p, REWIND_LINES));
  let r = null;
  for (let i = 0; i < 20 && !r; i++) { await sleep(150); r = await list(); }
  if (!r) return no(409, await rewindBackOut(host, p, 'its /rewind list did not open'));
  // up the list to the message (the nth of that text from the newest): ↑, then up to 8 looks for the ❯ to move
  let seen = 0, last = r.sig, picked = false;
  const until = Date.now() + REWIND_WALK_MS;
  for (let i = 0; i < REWIND_PRESSES && !picked; i++) {
    if (Date.now() > until) { await host.call('write', p.id, '\x1b'); return no(409, 'finding that message in /rewind\'s list took too long (Esc closed it)'); }
    await host.call('write', p.id, '\x1b[A');
    let n = null;
    for (let j = 0; j < 8; j++) { await sleep(60); n = await list(); if (!n || n.sig !== last) break; }
    if (!n) return no(409, await rewindBackOut(host, p, 'the /rewind list closed'));
    if (n.sig === last) break; // the top, and it wasn't there
    last = n.sig;
    if (SCREEN.rewindMatches(n.sel, text) && seen++ === nth) { await host.call('write', p.id, '\r'); picked = true; }
  }
  if (!picked) {
    await host.call('write', p.id, '\x1b');
    return no(409, seen ? `/rewind's list has ${seen === 1 ? 'one message' : `${seen} messages`} with that text, not ${nth + 1} (Esc closed it)` : 'that message isn\'t in /rewind\'s list (Esc closed it)', { notFound: true });
  }
  // Claude Code asks what to restore, or (nothing to ask) restores at once: up to REWIND_PICK_MS for either, each look
  // one snapshot (the menu and the rows of one moment)
  let menu = null, restored = false;
  for (const end = Date.now() + REWIND_PICK_MS; Date.now() < end && !menu && !restored;) {
    await sleep(150);
    const raw = await host.call('snapshot', p.id);
    const s = typeof raw === 'string' ? raw : '';
    const { cols, rows } = sizeOf(p);
    const m = menuFrom(s, p);
    if (SCREEN.rewindList(SCREEN.render(s, cols, rows, REWIND_LINES, false))) { if (restoreAsked(m)) menu = m; continue; } // still the list
    if (m) menu = m;
    else if (SCREEN.promptBox(SCREEN.render(s, cols, rows, 60, false, true))) restored = true;
  }
  if (!menu && !restored) return no(409, await rewindBackOut(host, p, 'Claude Code did not take the pick'));
  return { p, menu, restored };
}

// After the pick (compose.js takeRewound and restored): every REWIND_TICK_MS, while the restore question is up, it
// waits; once it is gone, what the restore put back in the prompt is cleared there (Ctrl+U), and then an edit goes in its
// place (deliverText: a menu up meanwhile refuses it) or, a plain Rewind, the message is the caller's to put back in its
// box. The prompt left empty REWIND_EMPTY_MS after the question went: the conversation stayed as it was ("Restore code"
// only, or "Never mind"), and the edit is not sent. A newer rewind of the same session takes over (the older one stops).
// job.state: asking -> sending -> sent | restored | kept | failed (GET .../activity's rewind)
async function followRewind(job, ctx) {
  const mine = () => rewinds.get(job.id) === job;
  const end = (state, message) => {
    if (!mine()) return;
    Object.assign(job, { state, message, doneAt: Date.now() });
    if (ctx && ctx.log) ctx.log(`api: ${job.id}: rewind ${state}`);
  };
  try {
    while (mine() && Date.now() - job.at < REWIND_FOLLOW_MS) {
      await sleep(REWIND_TICK_MS);
      if (!mine()) return;
      const step = await withHost(async (host) => {
        const p = hosted(await host.call('list'), job.id);
        if (!p || !p.alive) return { end: ['failed', 'the session ended before the restore'] };
        const raw = await host.call('snapshot', p.id);
        const s = typeof raw === 'string' ? raw : '';
        if (menuFrom(s, p)) { job.sawMenu = true; job.emptyAt = 0; return null; }
        const { cols, rows } = sizeOf(p);
        const box = SCREEN.promptBox(SCREEN.render(s, cols, rows, 60, false, true));
        if (!box) return null;
        if (!box.text) {
          if (!job.sawMenu) return null;
          if (!job.emptyAt) job.emptyAt = Date.now();
          return Date.now() - job.emptyAt >= REWIND_EMPTY_MS ? { end: ['kept', 'the conversation stayed as it was (Restore code only, or Never mind)'] } : null;
        }
        const clear = await typeOne(p.id, () => clearPrompt(host, p));
        return clear ? { cleared: true } : { end: ['failed', 'the old message is in its prompt and could not be cleared: clear it in the Session tab'] };
      });
      if (!step) continue;
      if (step.end) return end(...step.end);
      if (!mine()) return;
      if (!job.edit) return end('restored', 'went back to just before your message: it is back in your box to change and send again');
      job.state = 'sending';
      // the host may still list the /rewind dialog as open for a moment (it reads the pid files every 800 ms), and the
      // send would press Esc to close it: wait for the list to catch up first
      await withHost(async (host) => {
        for (const stop = Date.now() + 2500; Date.now() < stop;) {
          if (!panelOpen(hosted(await host.call('list'), job.id))) return;
          await sleep(POLL_MS / 2);
        }
      });
      if (!mine()) return;
      const [code, out] = await deliverText(job.id, job.edit, { kind: 'message', queue: false, open: false, via: job.via }, ctx);
      return code === 200 ? end('sent', 'went back to just before your message and sent your edit in its place')
        : end('failed', `went back to just before your message, but your edit was not sent: ${(out && out.message) || code}`);
    }
    if (mine()) end('kept', 'nothing came back into its prompt within 2 minutes: the conversation may be as it was (see the Session tab)');
  } catch (e) {
    end('failed', `the restore could not be followed: ${String((e && e.message) || e)}`);
  }
}
// what GET .../activity says of the session's rewind: { state, text, edit, message, at }, or null (none, or one that
// ended over REWIND_SHOW_MS ago)
function rewindNow(id) {
  const j = rewinds.get(id);
  if (!j) return null;
  if (j.doneAt && Date.now() - j.doneAt > REWIND_SHOW_MS) { rewinds.delete(id); return null; }
  return { state: j.state, text: j.text, edit: j.edit, message: j.message || null, at: j.at };
}

// ---------- Fork from one of your messages ----------
// What the page's Fork on a message does (web/forkat.js, web/app.js forkFromMessage), for a caller with no terminal of
// its own (the phone's chat): a fork of the conversation (claude --resume <id> --fork-session, the host's create, in its
// folder under its account), answered as soon as the host started it, so the caller is not held for minutes. Then, in
// the background (followFork): once the fork is up (its prompt empty a moment, nothing running, no menu or panel: a
// trust question waits for a person), Rewind's walk up its /rewind list to the message (rewindWalk), and on Claude Code's
// question "Restore conversation" only, picked here: never the code, since the fork works in the original's folder and
// restoring code would undo the original's edits too. What the restore puts back in the fork's prompt is cleared there;
// the message is the caller's to put in the fork's box. GET .../activity's `fork`, read on the fork, says how it goes.
// The fork is followed by its pty's pid, so the host's re-keys (new-<n> to an id; from the original's id to its own once
// it writes, when the original was not running) never lose it, and its new-<n> key keeps naming it (keyToId). The
// original is untouched and need not be running. An overseer's conversation is Henry's alone to fork (his phone); the
// fork does not take its role.
const FORK_READY_MS = 1500; // its prompt empty and nothing running this long before /rewind goes in (forkat.js)
const FORK_START_MS = 3 * 60e3; // a fork not ready by then (a trust question no one answers) is left as it is
const FORK_TICK_MS = 300;
const FORK_BOX_MS = 8000; // after the restore: how long the message may take to come back into its prompt
const FORK_SHOW_MS = 10 * 60e3; // how long after it ended GET .../activity still says how (and its key is followed)
const FORK_OPTION = /^Restore conversation$/i;
const forks = new Set(); // the forks followed: { pid, key, from, text, nth, at, state, message, doneAt }
// the fork's entry in the host's list, wherever the host has re-keyed it
const forkEntry = (list, job) => (Array.isArray(list) ? list : []).find((x) => x && (Number.isInteger(job.pid) ? x.pid === job.pid : x.id === resolveKey(job.key))) || null;

// POST /api/sessions/:id/fork { text, nth? }: text and nth as for .../rewind. -> 200 { ok, key, forkFrom, account, at,
// message }: key, the fork's (new-<n>, as POST /api/sessions gives it, followed to its id); at, when it started (the
// fork's activity's fork.at)
async function forkSession(key, b, ctx, via = null) {
  if (!b || typeof b !== 'object') return [400, { ok: false, message: 'bad json' }];
  const text = cleanText(b.text);
  if (!text) return [400, { ok: false, message: 'text must be the message as it was sent' }];
  if (b.nth != null && !(Number.isInteger(b.nth) && b.nth >= 0 && b.nth < REWIND_PRESSES)) return [400, { ok: false, message: `nth must be a whole number from 0 (the newest message with that text) to ${REWIND_PRESSES - 1}` }];
  const nth = b.nth || 0;
  return withHost(async (host) => {
    const p = hosted(await host.call('list'), key);
    const id = convId(p ? p.id : resolveKey(key));
    if (!id) return [409, { ok: false, message: 'it has no conversation id yet: fork it once it has started' }];
    // its history is an overseer's: Henry's to branch, as it is his to rewind
    const bot = ctx.botOf ? ctx.botOf(id) : null;
    if ((isOverseer(p && p.role) || (bot && isBotRole(bot.role))) && via !== 'henry') return [403, { ok: false, id, message: 'only Henry forks an overseer\'s conversation (his phone)' }];
    const where = resumable(id, ctx);
    if (where.err) return where.err;
    const account = p && acctOk(p.account, ctx) ? p.account : acctOk(where.account, ctx) ? where.account : 'B';
    const r = await host.call('create', { cwd: where.cwd, account, forkFrom: id });
    if (!r || !r.ok || typeof r.key !== 'string') return [502, { ok: false, id, message: (r && r.message) || 'the session host could not start the fork' }];
    // an older host ignores forkFrom: a fresh conversation without the history, so it goes again
    if (r.forkFrom !== id) {
      await host.call('kill', r.key).catch(() => {});
      return [502, { ok: false, id, message: 'the session host is too old to fork a conversation (restart it: node desktop/restart-host.js); the session it started was stopped' }];
    }
    for (const j of forks) if (j.doneAt && Date.now() - j.doneAt > FORK_SHOW_MS) forks.delete(j);
    const job = { pid: Number.isInteger(r.pid) ? r.pid : null, key: r.key, from: id, text, nth, at: Date.now(), state: 'working', message: '', doneAt: 0 };
    forks.add(job);
    followFork(job, ctx);
    if (ctx && ctx.log) ctx.log(`api: ${id}: forked as ${r.key}, to go back to just before a message`);
    return [200, { ok: true, key: r.key, id: null, forkFrom: id, account, at: job.at, message: 'forked: once it is up it goes back to just before your message, which then waits for its box' }];
  });
}

// job.state: working -> done | failed (GET .../activity's fork). A failed one has the whole conversation.
async function followFork(job, ctx) {
  const end = (state, message) => {
    Object.assign(job, { state, message, doneAt: Date.now() });
    if (ctx && ctx.log) ctx.log(`api: ${job.key}: fork from a message ${state}${state === 'failed' ? `: ${message}` : ''}`);
  };
  // the fork in the host's list now, its key followed to its id
  const look = async (host) => {
    const q = forkEntry(await host.call('list'), job);
    if (q && H.ID_RE.test(q.id) && !q.pending) keyToId.set(job.key, q.id);
    return q;
  };
  const GONE = 'the fork ended before it went back to your message';
  const whole = (why) => `${why}; the fork has the whole conversation`;
  try {
    // 1. up: its prompt on screen and empty, no spinner, nothing asked, for FORK_READY_MS. The screen, not the host's
    // status: a fork of a running conversation stays new-<n> without one until it writes (its pid file names the original)
    let since = 0;
    for (;;) {
      await sleep(FORK_TICK_MS);
      if (Date.now() - job.at > FORK_START_MS) return end('failed', whole('it was not ready to go back within 3 minutes (it may be asking whether to trust the folder)'));
      const st = await withHost(async (host) => {
        const q = await look(host);
        if (!q || !q.alive) return 'gone';
        if (q.status === 'busy' || panelOpen(q) || (await menuNow(host, q))) return 'not';
        const box = SCREEN.promptBox(await rowsNow(host, q, 60, true));
        return box && !box.text && !SCREEN.spinner(await rowsNow(host, q, 40))?.strong ? 'ready' : 'not';
      });
      if (st === 'gone') return end('failed', GONE);
      if (st !== 'ready') since = 0;
      else if (!since) since = Date.now();
      else if (Date.now() - since >= FORK_READY_MS) break;
    }
    // 2. /rewind, up its list to the message, Enter (Rewind's walk)
    const w = await withHost(async (host) => {
      const q = await look(host);
      if (!q || !q.alive) return { gone: true };
      return typeOne(q.id, () => rewindWalk(host, q, job.text, job.nth));
    });
    if (w.gone) return end('failed', GONE);
    if (w.err) return end('failed', whole(w.err[1].message));
    // 3. its question: "Restore conversation" (not "Restore code and conversation", its default when files changed)
    if (w.menu) {
      const opt = w.menu.options.find((o) => FORK_OPTION.test(String(o.label || '').trim()));
      if (!opt) {
        await withHost(async (host) => { const q = await look(host); if (q && q.alive) await host.call('write', q.id, '\x1b'); });
        return end('failed', whole('Claude Code did not offer to restore the conversation alone (Esc closed its question)'));
      }
      const [code, a] = await answerMenu(job.key, { option: opt.n, sig: w.menu.sig, allowPermission: true }, ctx, null, null);
      if (code !== 200) return end('failed', `"Restore conversation" could not be picked (${(a && a.message) || code}): see the fork's Session tab`);
    }
    // 4. the message the restore puts back in its prompt: cleared there (it is the caller's for the fork's box)
    const after = await withHost(async (host) => {
      let asked = false;
      for (const stop = Date.now() + FORK_BOX_MS; Date.now() < stop;) {
        await sleep(200);
        const q = await look(host);
        if (!q || !q.alive) return 'gone';
        asked = !!(await menuNow(host, q));
        if (asked) continue;
        const box = SCREEN.promptBox(await rowsNow(host, q, 60, true));
        if (box && box.text) return (await typeOne(q.id, () => clearPrompt(host, q))) ? 'cleared' : 'stuck';
      }
      return asked ? 'asked' : 'empty';
    });
    if (after === 'gone') return end('failed', GONE);
    if (after === 'asked') return end('failed', 'Claude Code\'s restore question is still up in the fork: answer it there');
    if (after === 'stuck') return end('failed', 'went back to just before your message, but it is still in the fork\'s prompt: clear it in the Session tab');
    end('done', 'went back to just before your message: it waits for your box to edit and send');
  } catch (e) {
    if (!job.doneAt) end('failed', `the fork could not be followed: ${String((e && e.message) || e)}`);
  }
  // its key kept naming it while it is shown, until it has its own id (it gets one once it writes, after a message)
  try {
    while (Date.now() - job.doneAt < FORK_SHOW_MS) {
      const q = await withHost(look);
      if (!q || !q.alive || (H.ID_RE.test(q.id) && !q.pending && q.id !== job.from)) return;
      await sleep(POLL_MS * 4);
    }
  } catch {}
}
// what GET .../activity says of the fork it reads (by its pty's pid): { state, text, from, message, at }, or null (not a
// fork from a message, or one that ended over FORK_SHOW_MS ago)
function forkNow(p) {
  for (const j of forks) {
    if (!(Number.isInteger(j.pid) ? p.pid === j.pid : resolveKey(j.key) === p.id)) continue;
    if (j.doneAt && Date.now() - j.doneAt > FORK_SHOW_MS) { forks.delete(j); return null; }
    return { state: j.state, text: j.text, from: j.from, message: j.message || null, at: j.at };
  }
  return null;
}

// POST /api/sessions/:id/model { model?, effort? }: the page's model and effort picker, for this conversation only.
// Claude Code has no session-only switch: /model <id> and /effort <level> switch the running session AND save the
// choice in its account's settings.json as the default for every new session (`model`, and
// `modelSettings.<model>.effortLevel`). The page's picker accepts that (its menu says so); this does not. It types the
// commands as the page does, waits until Claude Code has saved them, then puts those keys back as they were (the rest
// of the file as Claude Code left it), so new sessions start as before. Only while Claude is idle with nothing typed in
// its prompt (a command typed mid-turn waits in Claude Code's queue, and would be saved after this stopped watching),
// and one switch at a time (settingsTurn), so a second can't take the first's value for the one to put back; with
// queue: true one asked for meanwhile waits until then (queueSwitch, below).
// An overseer's (a bot's) model is Henry's to change (as his phone changes a bot's: bots.js), so for one
// of them only the phone relay may (viaOf).
// Mid-conversation, /model may first ask "Switch model?" and /effort "Change effort level?" (the history is re-read): the caller asked
// for the switch, so its Yes is picked (answerMenu, by its sig). Any other menu that comes up after the typing is
// closed with Esc (409), so nothing is left up. Once anything was typed the default goes back on every way out, after
// Claude Code's save has landed (it may write after a menu closes), and is looked at once more a moment later.
const SAVE_MS = 5000; // how long Claude Code may take to save a switch
const LATE_SAVE_MS = 3000; // a command whose save was not seen: how long its late save is waited for
const SETTLE_SAVE_MS = 1500; // after the default is put back: when it is looked at again and the screen read for the effort
// Claude Code 2.1.299's question (its binary: kind "model" | "effort", title "Switch model?" | "Change effort level?",
// subtitle "Your next response will be slower and use more tokens" or "A PreModelSwitch hook asked you to confirm",
// then a two-option select: `Yes, switch to ${model or effort}` and "No, go back"; numbered unless hideIndexes, and in
// its screen-reader mode "y. …" / "n. …" over "Enter y/n:"). Both options and the title, nothing looser: never another menu
const SWITCH_Q = /^(?:Switch model|Change effort level)\?/;
const YES_SWITCH = /^(?:y\.\s*)?Yes, switch to\b/;
const NO_SWITCH = /^(?:n\.\s*)?No, go back\b/;
const switchQuestion = (m) => !!m && SWITCH_Q.test(String(m.title || '').trim());
const isSwitchConfirm = (m) => switchQuestion(m) && Array.isArray(m.options) && m.options.length === 2
  && m.options.some((o) => YES_SWITCH.test(o.label)) && m.options.some((o) => NO_SWITCH.test(o.label));
const SAVED_KEYS = ['model', 'modelSettings', 'effortLevel'];
// the home the session host starts claude under (host.js acctDir), and the account's folder in it (accounts.js)
const settingsFileOf = (account) => path.join(ACCOUNTS.configDir(account, process.env.USERPROFILE || os.homedir()), 'settings.json');
let settingsTurn = Promise.resolve();
// the file's text, or '' when there is none -> { raw, json } or null when it is there but not JSON
function readSettings(file) {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') return null; }
  if (!raw.trim()) return { raw, json: {} };
  try { const j = JSON.parse(raw.replace(/^﻿/, '')); return j && typeof j === 'object' && !Array.isArray(j) ? { raw, json: j } : null; } catch { return null; }
}
// the keys of `before` back in the file as it is now -> true when it wrote
function putBack(file, before, existed) {
  const now = readSettings(file);
  if (!now) return false;
  const j = { ...now.json };
  for (const k of SAVED_KEYS) { if (k in before) j[k] = before[k]; else delete j[k]; }
  if (JSON.stringify(j) === JSON.stringify(now.json)) return false;
  if (!existed && !Object.keys(j).length) { try { fs.unlinkSync(file); } catch {} return true; }
  fs.writeFileSync(file + '.fv-tmp', JSON.stringify(j, null, 2) + (/\n$/.test(now.raw) || !now.raw ? '\n' : ''));
  fs.renameSync(file + '.fv-tmp', file);
  return true;
}
// what Claude Code said about a command, from what the screen got after it: the last line that answers it
const SAID_RE = /(Set model to .*|Kept model as .*|Set effort level to .*|Effort level set to .*|Couldn't save .*|The model was not changed.*|Cloud session couldn't switch .*)$/;
function saidSince(before, after) {
  const tail = before.slice(-400);
  const at = tail ? after.lastIndexOf(tail) : -1;
  const fresh = at >= 0 ? after.slice(at + tail.length) : after.slice(-4000);
  const lines = plainText(fresh).split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) { const m = SAID_RE.exec(lines[i]); if (m) return m[1].trim(); }
  return null;
}
// switchModel's checks of the body -> [400, json] or null
function switchBad(b) {
  if (!b || typeof b !== 'object') return [400, { ok: false, message: 'bad json' }];
  if (b.model == null && b.effort == null) return [400, { ok: false, message: 'give model, effort or both' }];
  if (b.model != null && (typeof b.model !== 'string' || !MODEL_RE.test(b.model))) return [400, { ok: false, message: 'model must be a model name like opus, sonnet, haiku or claude-opus-5-5[1m] (letters, digits, . - [ ])' }];
  if (b.effort != null && !EFFORTS.includes(b.effort)) return [400, { ok: false, message: `effort must be one of ${EFFORTS.join(', ')}` }];
  if ('queue' in b && typeof b.queue !== 'boolean') return [400, { ok: false, message: 'queue must be true or false' }];
  return null;
}
// The switch itself, now or never: a refusal before anything was typed because the session can't take it yet (Claude
// working or waiting, a panel or a menu up, its prompt box not on screen or not empty) says notReady, which
// switchModel queues with queue: true, and the queued switch's tick (tickSwitches) takes as "try again later"
async function switchNow(key, b, ctx, via = null) {
  const bad = switchBad(b);
  if (bad) return bad;
  const run = settingsTurn.then(() => withHost(async (host) => {
    const { p, err } = await need(host, key, true);
    if (err) return err;
    if (isOverseer(p.role) && via !== 'henry') return [403, { ok: false, id: p.id, message: 'only Henry changes an overseer\'s model or effort (his phone)' }];
    if (panelOpen(p)) return [409, { ok: false, id: p.id, panel: true, notReady: true, message: PANEL_UP }];
    if (p.status !== 'idle') return [409, { ok: false, id: p.id, status: p.status || null, notReady: true, message: p.status === 'waiting' ? 'Claude is waiting on an answer: switch once it is idle' : 'Claude is working: switch once it is idle (or interrupt it first)' }];
    const account = /^[A-Z]$/.test(p.account) ? p.account : 'B';
    const file = settingsFileOf(account);
    const was = readSettings(file);
    if (!was) return [409, { ok: false, id: p.id, message: `its account's settings.json is not JSON, so the default could not be kept: nothing was changed (${file})` }];
    const existed = !!was.raw;
    const before = {};
    for (const k of SAVED_KEYS) if (k in was.json) before[k] = JSON.parse(JSON.stringify(was.json[k]));
    const out = { ok: true, id: p.id, account, ...(b.model != null ? { model: b.model } : {}), ...(b.effort != null ? { effort: b.effort } : {}) };
    const said = [];
    // typed: something went in, so the default goes back however this ends; unsaved: a command whose save was not seen
    let wrote = false, typed = false, unsaved = false;
    const restore = () => {
      try { if (putBack(file, before, existed)) wrote = true; } catch (e) { ctx.log(`api: model switch for ${p.id}: could not put the default back in ${file}: ${e.message}`); }
    };
    // a menu up after the typing came from it: Esc, then up to POINT_MS for it to go -> 409
    const closeOurs = async (m, cmd) => {
      await host.call('write', p.id, '\x1b');
      let gone = false;
      for (const end = Date.now() + POINT_MS; Date.now() < end && !gone;) { await sleep(POLL_MS / 4); gone = !(await menuNow(host, p)); }
      return [409, { ...out, ok: false, menu: m, closed: gone, said, message: `${cmd} brought up "${m.title || 'a menu'}", which this does not answer: ${gone ? 'it was closed (Esc)' : 'Esc did not close it'}, and nothing more was typed` }];
    };
    let res;
    try {
      res = await typeOne(p.id, async () => {
        let last = null;
        for (const cmd of [b.model != null && `/model ${b.model}`, b.effort != null && `/effort ${b.effort}`].filter(Boolean)) {
          const m = await menuNow(host, p);
          if (m && last) return closeOurs(m, last);
          if (m) return [409, { ...out, ok: false, menu: m, said, notReady: true, message: MENU_UP }];
          const box = SCREEN.promptBox(await rowsNow(host, p, 60, true));
          if (!box || box.text) return [409, { ...out, ok: false, said, ...(last ? {} : { notReady: true }), message: box ? 'something is typed in its prompt: clear it in the Session tab first' : 'its prompt is not on screen' }];
          const raw0 = String((await host.call('snapshot', p.id)) || '');
          const file0 = readSettings(file);
          typed = true; unsaved = true; last = cmd;
          const sent = await sendText(host, p.id, cmd, () => menuNow(host, p));
          if (!sent.entered) return [409, { ...out, ok: false, menu: true, said, message: MENU_LATE }];
          // saved (the file changed), or Claude Code answered without saving (kept, refused); a menu first: "Switch
          // model?" gets its Yes, any other is closed
          let line = null, saved = false, elsewhere = false;
          for (let end = Date.now() + SAVE_MS; Date.now() < end;) {
            await sleep(POLL_MS / 2);
            const q = await menuNow(host, p);
            if (q && isSwitchConfirm(q)) {
              const yes = q.options.find((o) => YES_SWITCH.test(o.label));
              const [code, a] = await answerMenu(p.id, { option: yes.n, sig: q.sig, allowPermission: true }, ctx, null, via);
              if (code !== 200 || !a.changed) {
                const now = await menuNow(host, p);
                // gone before its Yes went in: an open page answers this question too (web/compose.js sayYes), so it
                // was answered there, and the save is waited for as after our own answer. The same question with
                // another sig (the pointer moved, or it was drawn again): read again
                if (!now && !elsewhere) { elsewhere = true; out.confirmed = `${yes.label} (answered elsewhere)`; end = Date.now() + SAVE_MS; continue; }
                if (now && switchQuestion(now)) continue;
                if (now) return closeOurs(now, cmd);
                return [409, { ...out, ok: false, menu: q, said, message: `${cmd} asked "${q.title}" and its Yes could not be picked: ${a.message}` }];
              }
              out.confirmed = yes.label;
              end = Date.now() + SAVE_MS; // the save comes after the answer
              continue;
            }
            // the question still drawing (its options not readable yet, or read mid-redraw after a page's answer):
            // looked at again until SAVE_MS is up, then closed as any other menu (below)
            if (q && switchQuestion(q)) continue;
            if (q) return closeOurs(q, cmd);
            const snap = String((await host.call('snapshot', p.id)) || '');
            const f = readSettings(file);
            if (f && file0 && f.raw !== file0.raw) { saved = true; line = saidSince(raw0, snap); break; }
            line = saidSince(raw0, snap);
            if (line && !/^Set /.test(line)) break;
          }
          said.push(line || `${cmd}: Claude Code said nothing about it`);
          if (saved) unsaved = false;
          restore();
        }
        // a menu that came up after the last save
        const m = await menuNow(host, p);
        if (m) return closeOurs(m, last);
        return null;
      });
    } finally {
      if (typed) {
        restore();
        // a save not seen yet (a menu closed, a refusal, an error): up to LATE_SAVE_MS for it to land
        if (unsaved) {
          const seen = (readSettings(file) || {}).raw;
          for (const end = Date.now() + LATE_SAVE_MS; Date.now() < end;) {
            await sleep(POLL_MS / 2);
            const f = readSettings(file);
            if (f && f.raw !== seen) break;
          }
          restore();
        }
        // and once more a moment later (Claude Code may write again after a menu closes); the footer then shows the
        // effort the session runs at, after it read the put-back file
        await sleep(SETTLE_SAVE_MS);
        restore();
        if (wrote) ctx.log(`api: model switch for ${p.id}: the default in ${file} was put back`);
      }
    }
    const now = readSettings(file);
    const defaultKept = !!now && SAVED_KEYS.every((k) => JSON.stringify(now.json[k]) === JSON.stringify(before[k]));
    if (res) {
      if (!typed) return res;
      const [code, o] = res;
      return [code, { ...o, defaultKept, restored: wrote, message: `${o.message}${defaultKept ? '' : `; the default for new sessions could not be put back in ${file}`}` }];
    }
    const effortNow = SCREEN.effortShown(await rowsNow(host, p, 40));
    const kept = b.effort == null || !effortNow || effortNow === b.effort;
    const ok = kept && defaultKept;
    return [200, { ...out, ok, said, defaultKept, restored: wrote, effortNow,
      message: ok ? `switched for this conversation; the default for new sessions is unchanged${wrote ? ' (put back after Claude Code saved it)' : ''}`
        : !defaultKept ? `switched, but the default for new sessions could not be put back in ${file}`
          : `the session shows ${effortNow} effort, not ${b.effort}: Claude Code may have followed the default when it was put back` }];
  }));
  settingsTurn = run.catch(() => {});
  return run;
}

// A refused switch: one server.log line (id, why), at most one per session a minute so a caller's loop can't flood it
// (the ones held back are counted in the next line)
// (handle's own line for a failed call is left out for these: quietOuts)
const REFUSAL_LOG_MS = 60e3;
const refusalLog = new Map(); // id -> { at, held }
const quietOuts = new WeakSet(); // replies whose refusal is logged here already
function logRefusal(ctx, id, why) {
  if (!ctx || !ctx.log) return;
  const t = Date.now(), r = refusalLog.get(id);
  if (r && t - r.at < REFUSAL_LOG_MS) { r.held++; return; }
  refusalLog.delete(id);
  refusalLog.set(id, { at: t, held: 0 });
  if (refusalLog.size > 200) refusalLog.delete(refusalLog.keys().next().value);
  ctx.log(`api: model switch for ${id}: ${why}${r && r.held ? ` (and ${r.held} more like it in the last minute)` : ''}`);
}

// ---------- a switch that waits for Claude to finish ----------
// POST .../model with queue: true, while the session can't take a switch now (notReady: Claude working, waiting on
// an answer, a panel or a menu up, its prompt box not on screen or holding a draft): kept here, one per conversation
// (a later one replaces the parts it names), and switched through switchNow once that session has been idle with no
// panel for SWITCH_SETTLE_MS (a turn's end can be followed at once by a message Claude Code had queued). Looked at every
// SWITCH_TICK_MS while any waits; a not-ready refusal again waits SWITCH_RETRY_MS. Dropped once applied, after
// SWITCH_MAX_MS, or when its session ends; a switch that fails keeps its reason (/state's switchPending.error, the log)
// for SWITCH_FAILED_KEEP_MS and is not tried again. In memory only: a server restart forgets it (it asked "when Claude
// finishes this step", and the step a restart sees is another).
const SWITCH_TICK_MS = 1500, SWITCH_SETTLE_MS = 1500, SWITCH_RETRY_MS = 5000, SWITCH_MAX_MS = 30 * 60e3, SWITCH_FAILED_KEEP_MS = 5 * 60e3;
const pendingSwitch = new Map(); // conversation id -> { model?, effort?, at, via, ctx, idleAt, nextAt, error?, failedAt? }
let swTimer = null, swTicking = false;
const swKey = (id) => convId(id) || String(id);
function queueSwitch(id, b, ctx, via) {
  const k = swKey(id);
  let x = pendingSwitch.get(k);
  // one that failed is done with: this one starts afresh
  if (!x || x.error) pendingSwitch.set(k, (x = { at: 0, idleAt: 0, nextAt: 0 }));
  if (b.model != null) x.model = b.model;
  if (b.effort != null) x.effort = b.effort;
  Object.assign(x, { at: Date.now(), via, ctx });
  if (!swTimer) { swTimer = setInterval(tickSwitches, SWITCH_TICK_MS); if (swTimer.unref) swTimer.unref(); }
  return x;
}
// what the switch now done covers no longer waits (a part asked again meanwhile for another value still does)
function settleSwitch(k, done) {
  const x = pendingSwitch.get(k);
  if (!x) return;
  for (const p of ['model', 'effort']) if (done[p] != null && x[p] === done[p]) delete x[p];
  if (x.model == null && x.effort == null) pendingSwitch.delete(k);
}
function dropSwitch(k, x, why) {
  if (pendingSwitch.get(k) === x) pendingSwitch.delete(k);
  if (why && x.ctx && x.ctx.log) x.ctx.log(`api: queued model switch for ${k} (${[x.model, x.effort].filter(Boolean).join(', ')}) dropped: ${why}`);
}
async function tickSwitches() {
  if (swTicking) return;
  if (!pendingSwitch.size) { clearInterval(swTimer); swTimer = null; return; }
  swTicking = true;
  try {
    await withHost(async (host) => {
      const list = await host.call('list');
      for (let [k, x] of [...pendingSwitch]) {
        if (pendingSwitch.get(k) !== x) continue;
        const now = Date.now();
        if (now - x.at > SWITCH_MAX_MS) { dropSwitch(k, x, x.error ? null : `not applied within ${SWITCH_MAX_MS / 60e3} minutes`); continue; }
        if (x.error) { if (now - x.failedAt > SWITCH_FAILED_KEEP_MS) dropSwitch(k, x); continue; }
        // it handed off meanwhile: the one that carries on takes it (unless that one has its own already)
        const succ = x.ctx && x.ctx.successorOf && convId(k) ? x.ctx.successorOf(convId(k)) : null;
        if (succ && succ !== k && !pendingSwitch.has(succ)) { pendingSwitch.delete(k); pendingSwitch.set((k = succ), x); }
        const p = hosted(list, k);
        if (!p || !p.alive) { dropSwitch(k, x, 'its session ended'); continue; }
        if (p.status !== 'idle' || panelOpen(p) || typingInto(p.id)) { x.idleAt = 0; continue; }
        if (!x.idleAt) { x.idleAt = now; continue; }
        if (now - x.idleAt < SWITCH_SETTLE_MS || now < x.nextAt) continue;
        const want = { ...(x.model != null ? { model: x.model } : {}), ...(x.effort != null ? { effort: x.effort } : {}) };
        const [code, out] = await switchNow(k, want, x.ctx, x.via);
        if (code === 200 && out.ok) {
          settleSwitch(k, want);
          if (x.ctx && x.ctx.log) x.ctx.log(`api: queued model switch for ${k} applied (${Object.values(want).join(', ')}): ${out.message}`);
        } else if (out && out.notReady) {
          x.idleAt = 0; x.nextAt = Date.now() + SWITCH_RETRY_MS;
        } else if (pendingSwitch.get(k) === x) {
          x.error = (out && out.message) || `failed (${code})`; x.failedAt = Date.now();
          if (x.ctx && x.ctx.log) x.ctx.log(`api: queued model switch for ${k} (${Object.values(want).join(', ')}) failed: ${code} ${x.error}`);
        }
      }
    });
  } catch (e) {
    // no host: each waits on (SWITCH_MAX_MS ends it); anything else is logged once a tick
    if (!(e instanceof HostDown)) { const c = [...pendingSwitch.values()].find((x) => x.ctx && x.ctx.log); if (c) c.ctx.log(`api: the queued model switches failed: ${e.message}`); }
  } finally { swTicking = false; }
}
// /state's switchPending for a conversation: { model?, effort?, at, error? } or null
function switchPending(id) {
  const x = id ? pendingSwitch.get(swKey(id)) : null;
  if (!x) return null;
  return { ...(x.model != null ? { model: x.model } : {}), ...(x.effort != null ? { effort: x.effort } : {}), at: x.at, ...(x.error ? { error: x.error } : {}) };
}

// POST /api/sessions/:id/model { model?, effort?, queue? }: switchNow, and with queue: true a switch the session
// can't take now waits for it (queueSwitch): 202 { ok, queued, id, model?, effort? } with what will be applied.
// Validation and the overseer rule come first either way; a switch made now settles a queued one's same parts.
async function switchModel(key, b, ctx, via = null) {
  const bad = switchBad(b);
  if (bad) return bad;
  const [code, out] = await switchNow(key, b, ctx, via);
  if (code === 409 && out && out.notReady && out.id) {
    if (b.queue === true) {
      const x = queueSwitch(out.id, b, ctx, via);
      logRefusal(ctx, out.id, `queued until Claude finishes this step (${out.message})`);
      return [202, { ok: true, queued: true, id: out.id, ...(x.model != null ? { model: x.model } : {}), ...(x.effort != null ? { effort: x.effort } : {}), message: 'applies when Claude finishes this step' }];
    }
    logRefusal(ctx, out.id, `refused: ${out.message}`);
    quietOuts.add(out);
  } else if (code === 200 && out && out.ok && out.id) settleSwitch(swKey(out.id), b);
  return [code, out];
}

// GET /api/sessions/:id/activity: the page's activity line (compose.js drawAct, its tick's reading) for a caller to
// poll: busy as the page has it (the host says busy, or the screen shows the live spinner, and no menu or panel up),
// line ("Brewing… (12s · ↓ 1.2k tokens)", or "Working…" without a spinner), the spinner's verb and detail, doing (the
// tool running or the last action, from the transcript: doingOf), waiting ('menu' | 'panel' | null) with the menu's
// kind and title, the effort its footer shows, and queue (what Claude Code holds queued, while it runs). Also what the
// page's tick reads besides: mode (the permission mode its footer shows: screen.js modeShown, null when it can't be
// read), bg (a shell command runs that Ctrl+B can send to the background: POST .../background), and prompt (the prompt
// box's text, "" empty, a bash-mode box's as "!<command>", null when it isn't on screen), so a caller can tell a message
// it sent is still sitting there unsent (POST .../enter), and panel: a command's panel up (/usage, /config...), as the
// page's panel card shows it (panelFrom; null when none), for a caller to show and drive (POST .../panel). One host
// list, one read of its screen (rendered once, with the dim marks the box needs; once more with the colour marks while a
// panel's edge is on it) and the transcript's cached state: cheap enough to poll every second or two.
async function readActivity(key, ctx) {
  return withHost(async (host) => {
    const { p, err } = await need(host, key, false);
    if (err) return err;
    const cid = convId(p.id);
    let doing = null;
    try { doing = cid && ctx.doing ? ctx.doing(cid) : null; } catch {}
    // rewind: how a Rewind or Edit from here is going (rewindNow), so the caller can put the text back in its box
    // fork: on a fork from a message, how its going back is going (forkNow), so the caller can put the message in its box
    const base = { ok: true, id: p.id, alive: !!p.alive, status: p.status || null, waitingFor: p.waitingFor || null, doing, rewind: rewindNow(p.id), fork: forkNow(p) };
    if (!p.alive) return [200, { ...base, busy: false, line: null, verb: null, detail: null, waiting: null, menu: null, effort: null, queue: [], mode: null, bg: false, prompt: null, panel: null }];
    const raw = await host.call('snapshot', p.id);
    const { cols, rows: high } = sizeOf(p);
    const marked = SCREEN.render(typeof raw === 'string' ? raw : '', cols, high, 60, false, true);
    const rows = marked.map((l) => l.replace(/[\x01-\x04]/g, '').replace(/\s+$/, '')).slice(-40);
    const spin = SCREEN.spinner(rows);
    let m = SCREEN.menuDetails(rows);
    // a command's panel (only when its top edge is on screen, as the page's tick: reading it costs another render),
    // weighed against a menu as shownFrom does
    let shown = marked.some((l) => /▔{12}/.test(l)) ? panelFrom(raw, p) : null;
    if (shown && m && !p.slashPanel) shown = null;
    else if (shown) m = null;
    const panel = panelOpen(p) || !!shown;
    const busy = (p.status === 'busy' || !!(spin && spin.strong)) && !m && !panel;
    return [200, { ...base, busy, line: busy ? `${spin ? `${spin.verb}…` : 'Working…'}${spin && spin.detail ? ` (${spin.detail})` : ''}` : null,
      verb: spin ? spin.verb : null, detail: spin ? spin.detail || null : null, waiting: m ? 'menu' : panel ? 'panel' : null,
      menu: m ? { kind: m.kind, title: m.title } : null, effort: SCREEN.effortShown(rows), queue: await claudeQueue(p.id, ctx),
      mode: m || panel ? null : SCREEN.modeShown(rows), bg: busy && SCREEN.bgOffered(rows), prompt: m || panel ? null : boxText(marked), panel: shown }];
  });
}

// POST /api/sessions/:id/open { account?, prompt?, wait? }: a conversation Fleet View knows (its log on disk) resumed
// as a hosted session (claude --resume, the host's open), in its last folder under its account, as the panel's Open
// does; it must be in a folder a new session could start in. Then up to START_MS for it to be idle; with prompt,
// that goes in as message's text does.
async function openSession(key, b, ctx, gone, via = null) {
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
    const { p, alreadyRunning } = r, co = r.chromeOffer ? { chromeOffer: r.chromeOffer } : {};
    if (r.stopped) return [200, { ok: true, id, alreadyRunning, ready: false, message: 'stopped waiting' }];
    const ready = r.ready;
    if (!prompt) return [200, { ok: true, id, alreadyRunning, ready, ...co, status: p.status || null, message: alreadyRunning ? 'it was already running' : ready ? 'opened; Claude is idle' : 'opened, but it is not idle yet' }];
    if (!ready && !alreadyRunning) return [200, { ok: false, id, alreadyRunning, ready, ...co, promptSent: false, message: `opened, but it was not idle within ${START_MS / 1000} s; the prompt was not sent` }];
    if (!alreadyRunning) await sleep(SETTLE_MS);
    const typed = isOverseer(p.role) ? OVERSEER.frame(prompt, via === 'henry' ? 'henry' : 'unsigned') : prompt;
    const [code, out] = await deliver(host, p, typed, ms, ctx, gone, null, { alreadyRunning, ready, ...co });
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
  // queue: the messages Claude Code holds queued, only while its claude runs here (one that ended with some queued
  // left them in its log)
  let live = false;
  try { live = !!(await withHost(async (host) => hosted(await host.call('list'), id)))?.alive; } catch (e) { if (!(e instanceof HostDown)) throw e; }
  return [200, { ok: true, id, ...t, queue: live && Array.isArray(t.queue) ? t.queue : [] }];
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
//        conversations({ state, repo, all, limit }) -> [row], transcript(id, { since, limit }) -> Promise of { ..., queue },
//        whereIs(id) -> { known, cwd, account }, successorOf(id) -> the one that carries on or null,
//        openElsewhere(id) -> open in a claude outside Fleet View, isRemoved(id) -> removed from the map, teamOf(id) -> { id, name, lead, members } or null,
//        teamsOf(id) -> [those]: both of a mid-level lead's teams, the one above first,
//        teams: { list(), get(id) -> { id, name, lead, members } or null, make(b), add(id, member, lead),
//        remove(id, member), lead(id, member | null), disband(id) } each -> [code, json] or a Promise of one,
//        status({ team, ids, from }) -> [code, json], doing(id) -> what it is doing in a few words, or null,
//        bots: { list(), create(b), start(id), update(id, b), remove(id), look(b) } each -> [code, json] or a Promise of one
//        (/api/bots, bots.js), botOf(id) -> { role, folder } when id is a bot's conversation, else null (resumable) }
const VERBS = 'message|stop|remove|menu|answer|wait|interrupt|open|transcript|now|unsend|model|activity|enter|background|mode|rewind|fork|panel';
const GET_VERBS = new Set(['menu', 'transcript', 'activity']);
const ROUTE = new RegExp(`^/api/sessions(?:/([^/]+))?(?:/(${VERBS}))?$`);
const TEAM_ROUTE = /^\/api\/teams(?:\/([^/]+))?(?:\/(add|remove|lead|disband|message))?\/?$/;
const ASK_ROUTE = /^\/api\/ask(?:\/([^/]+))?(?:\/(collected))?\/?$/;
const BOT_ROUTE = /^\/api\/bots(?:\/([^/]+))?(?:\/(start|remove))?\/?$/;
function handle(req, res, pathname, ctx) {
  const what = `${req.method} ${pathname}`;
  const answer = ([code, out]) => {
    // one line per failed call, never the token or the text
    if (code >= 400 && !(out && quietOuts.has(out))) ctx.log(`api: ${what} -> ${code} ${out && out.message ? out.message : ''}`.trim());
    if (!res.destroyed) ctx.sendJson(res, code, out);
  };
  // a caller that hung up while it waited for a reply: stop waiting
  let hungUp = false;
  res.on('close', () => { if (!res.writableFinished) hungUp = true; });
  const gone = () => hungUp;
  const run = (p) => p.then(answer, (e) => answer(e instanceof HostDown ? [503, { ok: false, message: e.message }] : [500, { ok: false, message: String((e && e.message) || e) }]));
  // a POST's body: {} when there is none
  const body = (fn) => ctx.readBody(req, res, (b) => run(fn(b)));
  // the phone relay's own requests count as Henry's for a bot (viaOf); a "via": "phone" without its key does not
  const via = (b) => {
    const v = viaOf(req, b);
    if (!v && b && typeof b === 'object' && b.via === 'phone') ctx.log(`api: ${what}: "via": "phone" without the relay's key (treated as unsigned)`);
    return v;
  };
  if (req.headers.origin !== undefined) return answer([403, { ok: false, message: 'the API is for local scripts, not web pages' }]);
  if (!authorized(req)) return answer([401, { ok: false, message: 'missing or wrong API token' }]);
  const query = () => new URL(req.url, 'http://x').searchParams;
  if (pathname === '/api' || pathname === '/api/') {
    return req.method === 'GET' ? answer(describeApi()) : answer([405, { ok: false, message: 'method not allowed' }]);
  }
  // a bot's own look (bots.js look): its shape and colour, from its own conversation (from), nothing else
  if (pathname === '/api/bots/look') {
    if (req.method !== 'POST') return answer([405, { ok: false, message: 'method not allowed' }]);
    if (!ctx.bots || !ctx.bots.look) return answer([404, { ok: false, message: 'not found' }]);
    return body((b) => Promise.resolve(b ? ctx.bots.look(b) : [400, { ok: false, message: 'bad json' }]));
  }
  // the bots (bots.js): GET lists them; POST makes one, /:id changes one, /:id/start starts it, /:id/remove removes it
  const bm = BOT_ROUTE.exec(pathname);
  if (bm) {
    const [, bid, bverb] = bm;
    if (!ctx.bots) return answer([404, { ok: false, message: 'not found' }]);
    if (bid && !/^[0-9a-f]{12}$/.test(bid)) return answer([400, { ok: false, message: 'not a bot id (GET /api/bots lists them)' }]);
    if (req.method === 'GET' && !bid) return answer(ctx.bots.list());
    if (req.method !== 'POST') return answer([405, { ok: false, message: 'method not allowed' }]);
    if (bverb === 'start') return run(Promise.resolve(ctx.bots.start(bid)));
    // a bot's brief is its standing orders, and every session here can read the token: making, changing or removing a
    // bot is Henry's (the page's /bots, or his phone through the relay: viaOf); anyone may start one
    return body((b) => {
      if (!b) return Promise.resolve([400, { ok: false, message: 'bad json' }]);
      if (via(b) !== 'henry') return Promise.resolve([403, { ok: false, message: 'only Henry makes, changes or removes a bot (the Bots tab, or his phone); POST /api/bots/:id/start starts one' }]);
      return Promise.resolve(bverb === 'remove' ? ctx.bots.remove(bid) : bid ? ctx.bots.update(bid, b) : ctx.bots.create(b));
    });
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
    return body((b) => messageTeam(tid, b, ctx, gone, via(b)));
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
    if (verb === 'activity') return run(readActivity(k, ctx));
    return answer([405, { ok: false, message: 'method not allowed' }]);
  }
  if (req.method === 'POST' && !GET_VERBS.has(verb)) {
    if (!key) return body((b) => startSession(b, ctx, gone, via(b)));
    switch (verb) {
      case 'message': return body((b) => sendMessage(k, b, ctx, gone, via(b)));
      case 'launch': return body((b) => launchPicks(k, b, ctx, gone, via(b)));
      case 'stop': return body((b) => stopSession(k, b, ctx));
      case 'remove': return run(removeConversation(k, ctx));
      case 'answer': return body((b) => answerMenu(k, b, ctx, gone, via(b)));
      case 'wait': return body((b) => waitSession(k, b, ctx, gone));
      case 'interrupt': return run(interruptSession(k));
      case 'open': return body((b) => openSession(k, b, ctx, gone, via(b)));
      case 'now': return run(sendNowSession(k, ctx));
      case 'unsend': return body((b) => unsendMessage(k, b, ctx));
      case 'model': return body((b) => switchModel(k, b, ctx, via(b)));
      case 'enter': return body((b) => enterAgain(k, b));
      case 'background': return run(backgroundSession(k));
      case 'mode': return body((b) => switchMode(k, b, ctx, via(b)));
      case 'rewind': return body((b) => rewindSession(k, b, ctx, via(b)));
      case 'fork': return body((b) => forkSession(k, b, ctx, via(b)));
      case 'panel': return body((b) => pressPanel(k, b, ctx, via(b)));
      default: break;
    }
  }
  return answer([405, { ok: false, message: 'method not allowed' }]);
}

// askParts: the ask's text builders and collection steps, for a test to drive without a session host
// relayKey: the phone relay's key (see viaOf), for fleet-view.js to hand the relay
module.exports = { ensureToken, handle, startBot, openBot, endHosted, hostList, hostKill, hostSwitch, relayKey, viaOf, isOverseer, plainText, cleanText, pasteWrites, deliverText,
  startQueue, queuedIds, switchModel, switchPending, launchPicks, isSwitchConfirm, TOKEN_FILE, ENDPOINTS, MODEL_RE, EFFORTS,
  askParts: { asks, summaryText, laterText, overseerAnswers, answerLines, flushAsk, settleAnswer, askJson },
  // the queued switches and their tick, for a test to age one or run a tick at once
  switchParts: { pending: pendingSwitch, tick: tickSwitches, refusals: refusalLog } };
