// bots.js: the server side of Bots, Henry's overseers besides the Chief (chief.js). Each bot is one hosted session
// whose role is 'bot:<id>' (desktop/host.js), in its own folder ~/Bots/<slug>, whose CLAUDE.md (bot/BRIEF.md filled in)
// holds Henry's standing instructions for it. Henry gives it tasks in its chat; they need not touch the fleet or a repo.
// fleet-view.js requires it and hands it what it needs (createBots below).
//
// - The registry: settings.bots in ~/.fleet-view.json, [{ id, name, brief, account, model, effort, folder, createdAt,
//   ids: [its conversations, oldest first, at most 50], told: [the ids told theirs], removed?, shape?, color? }]. A
//   removed bot keeps its folder, its logs and its ids: they stay tagged in /state, so its conversations never show on
//   the map. shape and color are its avatar's look (web/mascot.js), set when it is made or changed, or by the bot
//   itself (look below: POST /api/bots/look, fv look); left out, the page picks them. model and effort may each be
//   'dynamic' (a new bot's are): its sessions start on DYNAMIC_START, and the page sizes each message Henry sends it
//   and switches first when needed (switchTo below: POST /bots/:id/switch, the page only).
// - Start, one at a time per bot: the conversation running already is taken as it is; else its newest one is resumed
//   with the role (api.js openBot); else a new session starts in its folder (api.js startBot: the folder is not a listed
//   repo, the registry vouches for it), named after the bot.
// - Follow it: tick() reads the host's list while sessions.json shows a bot's role, and adds each conversation with
//   that role (a handoff's pickup, a /clear) to its bot's ids. Each new one is told its id once, as the Chief is
//   (chief.js createTeller). A removed bot's session that comes back (a restore) is ended.
// - /state: tagger() and tagState() put bot: '<bot id>' ('chief' for the Chief's) on each overseer conversation in
//   sessions, finished and removed; view() is state.bots. The ~/Bots folders are never a workspace (inBots).
// - Another machine's bots: registries never sync (sync-prefs.js), but sync brings their chats here, into ~/Bots/<slug>.
//   elsewhere() makes one bot of each such folder that no bot here owns, from its conversations: tagged like a bot's,
//   so they are the Bots tab's alone too, and listed in state.bots with elsewhere: true (no Start, Edit, Remove or
//   Tasks here: it is run and changed on its own machine). Henry, 2026-10-11: the PC's Panchito on the Mac.
// - Who is talking: api.js frames what reaches a bot as it does for the Chief (isOverseer).
// - Tasks and routines: each bot keeps its task list in tasks.json in its folder (bot-tasks.js has the format), one-off
//   and recurring, updated by the bot itself as Henry gives, finishes, changes or cancels work (bot/BRIEF.md says so).
//   schedule() (every few seconds, fleet-view.js) delivers each task that comes due to its bot as a "[Fleet View]
//   Scheduled task: ..." message, starting the bot first when it is not running (start below), so a bot never has
//   to poll. The run is written into the file before it is delivered, so a restart never fires it twice; with the
//   desktop app down nothing fires (it does once the app is back, once). state.bots[].tasks is the list as the Bots tab
//   shows it; POST /bots/:id/tasks/:taskId { action: pause | resume | run | delete } (the page only) changes it, run
//   delivering it now. The first schedule() after a start also writes every bot's CLAUDE.md again when bot/BRIEF.md
//   changed (a Fleet View update) and tells a running bot to read it, so bots made before a change learn it too.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const CHIEF = require(path.join(__dirname, 'chief.js'));
const API = require(path.join(__dirname, 'api.js'));
const P = require(path.join(__dirname, 'platform.js'));
const TASKS = require(path.join(__dirname, 'bot-tasks.js'));

const BOTS_DIR = path.join(os.homedir(), 'Bots');
const TEMPLATE_FILE = path.join(__dirname, 'bot', 'BRIEF.md');
const NAME_MAX = 40, BRIEF_MAX = 4000, SLUG_MAX = 32;
const IDS_MAX = 50; // conversation ids kept per bot
const BOTS_MAX = 50; // bots not removed
const HOST_EVERY_MS = 10e3; // while a bot is in sessions.json: how often the host's list is read
const HOST_DOWN = 'the Fleet View desktop app is not running';
const HOLD_MS = 5 * 60e3; // a due task whose run could not be written into tasks.json: how long before it is tried again
const BOT_ID_RE = /^[0-9a-f]{12}$/;
// the avatar shapes, as web/mascot.js SHAPES lists them (scripts/bots-test.mjs checks the two agree)
const SHAPES = ['hex', 'drop', 'round', 'pill', 'tri', 'square', 'star', 'clover', 'flower', 'heart'];
const COLOR_RE = /^#[0-9a-f]{6}$/i;
// Dynamic: a bot's model or effort may be 'dynamic' (a new bot's are), sized for each message instead of fixed. Its
// sessions start on DYNAMIC_START (Fleet View's own start notes are quick ones), and before each message Henry sends
// from the page, the page sizes it (web/chats-model.js sizeTask) and switches through switchTo when it needs to
const DYNAMIC = 'dynamic';
const DYNAMIC_START = { model: 'claude-sonnet-5-5', effort: 'low' };
const NEW_BOT = { account: CHIEF.DEFAULTS.account, model: DYNAMIC, effort: DYNAMIC };
const { convId } = CHIEF;
const roleOf = (id) => `bot:${id}`;
const botOfRole = (role) => { const m = /^bot:([0-9a-f]{12})$/.exec(typeof role === 'string' ? role : ''); return m ? m[1] : null; };
// What Fleet View says to a bot. A new bot gets two notes, the start prompt and then its id, and greeted Henry after
// each; now it answers the first with a bare "ok" (the Bots tab hides that) and says hello once, to the id note of
// the conversation it was started in. A handoff's pickup or a /clear gets an id note too, answered with "ok": the
// bot is not new there. The Bots tab shows these notes as small grey lines (chats-model.js botFeed), not bubbles.
const startPrompt = (name) => `[Fleet View] You are ${name}, one of Henry's bots. Your standing instructions are in CLAUDE.md in this folder. Your conversation id comes in the next message: reply to this one with just "ok".`;
const idNote = (name, id, greet = false) => `[Fleet View] You are ${name}, one of Henry's bots. Your id: ${id}. ${greet ? 'Greet Henry in one short line, nothing more.' : 'Reply with just "ok".'}`;
const CHANGED_NOTE = '[Fleet View] Your instructions changed: read CLAUDE.md again, then say so in one short line.';

// ---------- checks ----------
// name: 1 to 40 characters on one line, no control characters (invisible ones dropped, as api.js cleanText does), and
// no other bot's that is not removed, in any case. self: the bot being changed. -> { name } or { err }
function checkName(v, bots, self = null) {
  const t = typeof v === 'string' ? API.cleanText(v) : null;
  // C1 controls (0x80-0x9f) too: cleanText keeps them, and the name goes into the first line of the bot's prompts
  const c1 = (s) => [...s].some((ch) => ch.charCodeAt(0) >= 0x80 && ch.charCodeAt(0) <= 0x9f);
  const name = t && !/[\n\t]/.test(t) && !c1(t) ? t.trim() : '';
  if (!name || name.length > NAME_MAX) return { err: `name must be 1 to ${NAME_MAX} characters on one line, without control characters` };
  const low = name.toLowerCase();
  if ((bots || []).some((b) => b && !b.removed && b.id !== self && String(b.name).toLowerCase() === low)) return { err: `there is a bot called ${name} already` };
  return { name };
}
// brief: up to 4000 characters, cleaned as api.js cleanText does; left out or blank is none. -> { brief } or { err }
function checkBrief(v) {
  if (v == null) return { brief: '' };
  if (typeof v !== 'string') return { err: 'brief must be text' };
  const t = API.cleanText(v);
  // cleanText says null for blank text too: with a character in front, only bad characters still do
  if (t === null && API.cleanText(`.${v}`) === null) return { err: 'brief must be text without control characters other than new lines and tabs' };
  const brief = (t || '').trim();
  if (brief.length > BRIEF_MAX) return { err: `brief must be at most ${BRIEF_MAX} characters` };
  return { brief };
}
// account, model, effort, as POST /api/sessions takes them, or 'dynamic' for the model or the effort (sized for each
// message Henry sends from the page: web/chats-model.js sizeTask, switched through switchTo below); one left out is
// base's. -> { account, model, effort } or { err }
function checkOpts(b, base, accounts) {
  const out = { account: base.account, model: base.model, effort: base.effort };
  if (b.account != null) {
    if (typeof b.account !== 'string' || !accounts.includes(b.account)) return { err: `account must be one of ${accounts.join(', ')}` };
    out.account = b.account;
  }
  if (b.model != null) {
    if (typeof b.model !== 'string' || (b.model !== DYNAMIC && !API.MODEL_RE.test(b.model))) return { err: 'model must be a model name like opus, sonnet, haiku or claude-opus-5-5[1m] (letters, digits, . - [ ]), or dynamic' };
    out.model = b.model;
  }
  if (b.effort != null) {
    if (b.effort !== DYNAMIC && !API.EFFORTS.includes(b.effort)) return { err: `effort must be one of ${API.EFFORTS.join(', ')}, or dynamic` };
    out.effort = b.effort;
  }
  return out;
}
// what a session of the bot starts on: its model and effort, a dynamic one's base (DYNAMIC_START)
const runOpts = (bot) => ({ model: bot.model === DYNAMIC ? DYNAMIC_START.model : bot.model, effort: bot.effort === DYNAMIC ? DYNAMIC_START.effort : bot.effort });

// shape and color, as POST /bots and /bots/:id take them: one from SHAPES, a #rrggbb colour (kept in lower case);
// null or "" clears it (the page picks again), one left out stays as it is. -> { shape?, color? } (a key only for
// what changes; null to clear) or { err }
function checkLook(b) {
  const out = {};
  if (b && 'shape' in b) {
    if (b.shape === null || b.shape === '') out.shape = null;
    else if (typeof b.shape === 'string' && SHAPES.includes(b.shape)) out.shape = b.shape;
    else return { err: `shape must be one of ${SHAPES.join(', ')} (or null: picked for it)` };
  }
  if (b && 'color' in b) {
    if (b.color === null || b.color === '') out.color = null;
    else if (typeof b.color === 'string' && COLOR_RE.test(b.color)) out.color = b.color.toLowerCase();
    else return { err: 'color must be a colour like #58a6ff (or null: its account\'s)' };
  }
  return out;
}
// a look from checkLook laid on a bot: a value is set, null takes the key away
function applyLook(bot, look) {
  for (const k of ['shape', 'color']) {
    if (!(k in look)) continue;
    if (look[k] === null) delete bot[k];
    else bot[k] = look[k];
  }
}

// ---------- the folder and its CLAUDE.md ----------
// the folder name a bot's name gives: lower case letters, digits and dashes (accents dropped), at most 32; "bot" when
// nothing is left, and never a name Windows keeps for a device
function slugOf(name) {
  let s = String(name || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX).replace(/-+$/, '');
  if (!s) s = 'bot';
  if (/^(?:con|prn|aux|nul|com\d|lpt\d)$/.test(s)) s += '-bot';
  return s;
}
const pathKey = (p) => P.foldCase(path.resolve(String(p)));
// base/<slug>, else base/<slug>-2, -3… : one no bot has (a removed one keeps its folder) and nothing is at yet, so a
// folder that is not a bot's is never written into. null when none of the first 99 is free
function pickFolder(base, slug, bots, exists) {
  const taken = new Set((bots || []).filter((b) => b && typeof b.folder === 'string').map((b) => pathKey(b.folder)));
  for (let n = 1; n < 100; n++) {
    const f = path.join(base, n === 1 ? slug : `${slug}-${n}`);
    if (!taken.has(pathKey(f)) && !exists(f)) return f;
  }
  return null;
}
// the Bots folder or one in it: never a workspace
function inBots(p, base = BOTS_DIR) {
  if (typeof p !== 'string' || !p) return false;
  const k = pathKey(p), b = pathKey(base);
  return k === b || k.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}
// its CLAUDE.md: the template with {{name}} and {{brief}} filled in, in one pass (a brief holding "{{name}}" keeps it)
function fillBrief(template, bot) {
  const vals = { name: bot.name, brief: bot.brief || 'None yet.' };
  return String(template).replace(/\{\{(name|brief)\}\}/g, (_, k) => vals[k]);
}

// ---------- /state ----------
// each overseer conversation -> its tag: its bot's id (a removed bot's too), 'chief' for the Chief's (chiefIds)
function tagger(chiefIds, bots) {
  const m = new Map();
  for (const b of bots || []) for (const id of (b && b.ids) || []) m.set(id, b.id);
  for (const id of chiefIds || []) if (id) m.set(id, 'chief');
  return (id) => m.get(id) || null;
}
// bot: <tag> on each overseer entry of st.sessions, st.finished and st.removed (the page and the phone filter by it)
function tagState(st, tagOf) {
  for (const k of ['sessions', 'finished', 'removed']) {
    for (const x of (st && st[k]) || []) { const t = x ? tagOf(x.id) : null; if (t) x.bot = t; }
  }
  return st;
}
// another machine's bots, from the conversations here (each { id, root?, cwd?, name, last, account }): one per folder
// ~/Bots/<slug> that holds some and that no bot here (bots, a removed one's too) owns. Its id is made from the slug, so
// it stays the same from one /state to the next; its name is its newest conversation's (a bot names its sessions
// after itself), else the slug. -> [{ id, name, folder, ids (oldest first), convId (the newest), account, at }]
function elsewhereBots(convs, base = BOTS_DIR, bots = []) {
  const groups = new Map(); // folder key -> { folder, slug, convs }
  const b = pathKey(base);
  for (const c of convs || []) {
    const p = c && (c.root || c.cwd);
    if (!c || !c.id || !inBots(p, base) || pathKey(p) === b) continue;
    if ((bots || []).some((x) => x && typeof x.folder === 'string' && inBots(p, x.folder))) continue;
    const slug = path.relative(path.resolve(base), path.resolve(p)).split(/[\\/]/)[0];
    const folder = path.join(base, slug), k = pathKey(folder);
    if (!groups.has(k)) groups.set(k, { folder, slug, convs: [] });
    groups.get(k).convs.push(c);
  }
  return [...groups.values()].map((g) => {
    const cs = g.convs.sort((x, y) => (x.last || 0) - (y.last || 0));
    const top = cs[cs.length - 1];
    return { id: crypto.createHash('sha1').update(`elsewhere:${g.slug.toLowerCase()}`).digest('hex').slice(0, 12),
      name: (typeof top.name === 'string' && top.name.trim()) || g.slug, folder: g.folder, ids: cs.map((x) => x.id),
      convId: top.id, account: top.account || null, at: top.last || 0 };
  });
}
// one of those as state.bots shows it: it never runs here and has nothing to change here
const elsewhereView = (e) => ({ id: e.id, name: e.name, brief: '', account: e.account, model: null, effort: null, folder: e.folder,
  createdAt: e.at, convId: e.convId, live: false, shape: null, color: null, tasks: [], elsewhere: true });
// one bot as state.bots and the answers show it; l: its running session from the host's list ({ id }), if any
function viewOf(b, l) {
  return { id: b.id, name: b.name, brief: b.brief, account: b.account, model: b.model, effort: b.effort, folder: b.folder, createdAt: b.createdAt,
    convId: (l && l.id) || b.ids[b.ids.length - 1] || null, live: !!l, shape: b.shape || null, color: b.color || null };
}
// state.bots: the bots not removed, newest first (of two made the same millisecond, the later). live: bot id -> its
// running session
const listView = (bots, live) => (bots || []).filter((b) => b && !b.removed).reverse().sort((a, b) => b.createdAt - a.createdAt)
  .map((b) => viewOf(b, live && live.get(b.id)));
// the registry as saved, checked (an entry that makes no sense is dropped)
function loadBots(saved, base = BOTS_DIR) {
  const out = [];
  const str = (v, def) => (typeof v === 'string' ? v : def);
  for (const b of Array.isArray(saved) ? saved : []) {
    if (!b || typeof b !== 'object' || !BOT_ID_RE.test(b.id) || typeof b.name !== 'string' || typeof b.folder !== 'string' || !path.isAbsolute(b.folder)) continue;
    // a folder of its own under the Bots folder, never elsewhere (CLAUDE.md is written there): a hand-edited one is dropped
    if (!inBots(b.folder, base) || pathKey(b.folder) === pathKey(base)) continue;
    if (out.some((x) => x.id === b.id)) continue;
    const ids = Array.isArray(b.ids) ? [...new Set(b.ids.map(convId).filter(Boolean))].slice(-IDS_MAX) : [];
    out.push({ id: b.id, name: b.name, brief: str(b.brief, ''), account: str(b.account, CHIEF.DEFAULTS.account), model: str(b.model, CHIEF.DEFAULTS.model),
      effort: str(b.effort, CHIEF.DEFAULTS.effort), folder: b.folder, createdAt: Number.isFinite(b.createdAt) ? b.createdAt : 0, ids,
      told: Array.isArray(b.told) ? [...new Set(b.told.map(convId).filter(Boolean))] : [], ...(b.removed === true ? { removed: true } : {}),
      ...(SHAPES.includes(b.shape) ? { shape: b.shape } : {}), ...(typeof b.color === 'string' && COLOR_RE.test(b.color) ? { color: b.color.toLowerCase() } : {}) });
  }
  return out;
}

// ---------- the server's part ----------
// deps: { api (api.js: hostList, deliverText, startBot, openBot, endHosted), ctx (api.js's ctx), saved (settings.bots as
//   saved), save() (the registry changed), log(text), demo, exists(id) -> its log is on disk, turnInfo(id) -> { promptAt }
//   or null, sessionsFile, trustFolder(dir), accounts() -> the account letters, rename(id, name) (its Fleet View name),
//   base (the Bots folder) and template (bot/BRIEF.md), which tests set }
function createBots(deps) {
  const d = deps || {};
  const base = d.base || BOTS_DIR, templateFile = d.template || TEMPLATE_FILE;
  const bots = loadBots(d.saved, base);
  let live = new Map(); // bot id -> { id, key, status, pending } of its running session, from the host's list
  const chains = new Map(); // bot id -> its starts and its removal, one after another
  const starting = new Set(); // bots whose start may be typing its prompt: no id note meanwhile
  const tellers = new Map(); // bot id -> chief.js createTeller
  const firstSeen = new Map(); // conversation id -> when it was first seen as a bot's
  const greet = new Set(); // conversations a start began fresh: their id note asks for the one hello (idNote)
  let ticking = false, fileM = -1, fileBots = false, askedAt = 0, askedM = -1, hostDown = false;
  const taskFiles = new Map(); // bot id -> { key (its tasks.json's mtime and size), data, err } as last read
  const firing = new Set(); // bots a task is being delivered to: nothing else fires for them meanwhile
  const sentFor = new Map(); // `${bot id}/${task id}` -> the due time last delivered by the schedule (a stale rewrite of the file by the bot can't fire it again)
  const heldTill = new Map(); // `${bot id}/${task id}` -> no scheduled try before this (its run could not be written)
  let scheduling = false, briefsChecked = false;
  const log = (t) => { try { if (d.log) d.log(`bots: ${t}`); } catch {} };
  const save = () => { try { if (d.save) d.save(); } catch {} };
  const byId = (id) => bots.find((b) => b.id === id) || null;
  const view1 = (b) => viewOf(b, live.get(b.id));
  const accounts = () => { try { const a = d.accounts ? d.accounts() : null; if (Array.isArray(a) && a.length) return a; } catch {} return ['A', 'B']; };
  // bot/BRIEF.md with its CRs dropped (a CRLF checkout), so every CLAUDE.md has the same line ends
  const template = () => fs.readFileSync(templateFile, 'utf8').split(String.fromCharCode(13)).join('');
  const noBot = () => [404, { ok: false, message: 'no such bot (GET /api/bots lists them)' }];

  // a conversation of the bot's: first seen now, and added to its ids (the oldest dropped past IDS_MAX)
  function follow(bot, id) {
    if (!firstSeen.has(id)) {
      firstSeen.set(id, Date.now());
      if (firstSeen.size > 200) firstSeen.delete(firstSeen.keys().next().value);
    }
    if (bot.ids.includes(id)) return;
    bot.ids = [...bot.ids, id].slice(-IDS_MAX);
    save();
    log(`${bot.name} goes on in ${id}`);
  }
  function tellerOf(bot) {
    let t = tellers.get(bot.id);
    if (!t) {
      t = CHIEF.createTeller({ api: d.api, ctx: d.ctx, note: (id) => idNote(bot.name, id, greet.has(id)), told: bot.told, log: (x) => log(`${bot.name}: ${x}`),
        save: () => { bot.told = t.told(); save(); } });
      tellers.set(bot.id, t);
    }
    return t;
  }
  // fn after whatever this bot has going (a start, its removal), even when that failed
  function inTurn(id, fn) {
    const p = (chains.get(id) || Promise.resolve()).then(fn, fn);
    const tail = p.catch(() => {});
    chains.set(id, tail);
    tail.then(() => { if (chains.get(id) === tail) chains.delete(id); });
    return p;
  }

  // POST /bots, /api/bots { name, brief?, account?, model?, effort?, shape?, color? }: the bot, its folder (trusted for
  // every account) and its CLAUDE.md, then it starts. Made but not started: ok false, with bot
  async function create(b) {
    if (d.demo) return [503, { ok: false, message: 'the demo makes no bots' }];
    b = b && typeof b === 'object' ? b : {};
    const n = checkName(b.name, bots);
    if (n.err) return [400, { ok: false, message: n.err }];
    const br = checkBrief(b.brief);
    if (br.err) return [400, { ok: false, message: br.err }];
    const o = checkOpts(b, NEW_BOT, accounts());
    if (o.err) return [400, { ok: false, message: o.err }];
    const lk = checkLook(b);
    if (lk.err) return [400, { ok: false, message: lk.err }];
    if (bots.filter((x) => !x.removed).length >= BOTS_MAX) return [409, { ok: false, message: `at most ${BOTS_MAX} bots: remove one first` }];
    let id;
    do id = crypto.randomBytes(6).toString('hex'); while (byId(id));
    const folder = pickFolder(base, slugOf(n.name), bots, (p) => fs.existsSync(p));
    if (!folder) return [409, { ok: false, message: `no free folder for ${n.name} in ${base}` }];
    const bot = { id, name: n.name, brief: br.brief, account: o.account, model: o.model, effort: o.effort, folder, createdAt: Date.now(), ids: [], told: [] };
    applyLook(bot, lk);
    let text;
    try { text = fillBrief(template(), bot); } catch (e) { return [500, { ok: false, message: `could not read ${templateFile}: ${e.code || e.message}` }]; }
    try { fs.mkdirSync(base, { recursive: true }); } catch (e) { return [500, { ok: false, message: `could not make ${base}: ${e.code || e.message}` }]; }
    // not recursive: a folder that turned up since it was picked is not ours, and is refused
    try { fs.mkdirSync(folder); } catch (e) {
      return [409, { ok: false, message: e.code === 'EEXIST' ? `${folder} is there already and is not a bot's folder` : `could not make ${folder}: ${e.code || e.message}` }];
    }
    try { fs.writeFileSync(path.join(folder, 'CLAUDE.md'), text); } catch (e) {
      try { fs.rmdirSync(folder); } catch {}
      return [500, { ok: false, message: `could not write ${path.join(folder, 'CLAUDE.md')}: ${e.code || e.message}` }];
    }
    // its task list, empty, so the bot finds the file and its format there (CLAUDE.md says how to keep it)
    try { TASKS.writeFile(folder, { version: TASKS.VERSION, tasks: [] }); } catch (e) { log(`could not write ${TASKS.fileOf(folder)}: ${e.code || e.message}`); }
    // a new folder would open on "Do you trust the files in this folder?", and the start prompt could not go in
    try { if (d.trustFolder) d.trustFolder(folder); } catch (e) { log(`could not trust ${folder}: ${e.message}`); }
    bots.push(bot);
    save();
    log(`made ${bot.name} (${id}) in ${folder}`);
    const [code, out] = await start(id);
    return [code, { ...out, message: out.ok ? `made ${bot.name} and started it` : `made ${bot.name}, but it did not start: ${out.message}` }];
  }

  // POST /bots/:id/start, /api/bots/:id/start: the conversation running already, else its newest one resumed with its
  // role, else a new one in its folder. A second start waits for the first, then finds it running
  function start(id) {
    const bot = byId(id);
    if (!bot || bot.removed) return Promise.resolve(noBot());
    return inTurn(id, () => doStart(bot));
  }
  async function doStart(bot) {
    if (d.demo) return [503, { ok: false, message: 'the demo starts no bots' }];
    if (bot.removed) return noBot();
    const role = roleOf(bot.id);
    starting.add(bot.id);
    try {
      const list = await d.api.hostList();
      if (list === null) return [503, { ok: false, bot: view1(bot), message: HOST_DOWN }];
      const p = list.find((x) => x && x.alive && (x.role === role || bot.ids.includes(convId(x.id))));
      if (p) {
        const cid = convId(p.id);
        if (cid) follow(bot, cid);
        live.set(bot.id, { id: cid, key: p.id, status: p.status || null, pending: !!p.pending });
        return [200, { ok: true, bot: view1(bot), id: cid, key: p.id, started: false, message: `${bot.name} is running already` }];
      }
      const last = bot.ids[bot.ids.length - 1];
      if (last && d.exists && d.exists(last)) {
        const [code, out] = await d.api.openBot(last, d.ctx);
        if (code === 200) {
          live.set(bot.id, { id: last, key: last, status: null, pending: false });
          log(`resumed ${bot.name} (${last})`);
          return [200, { ok: true, bot: view1(bot), id: last, key: last, started: true, resumed: true, message: `resumed ${bot.name}${out.ready || out.alreadyRunning ? '' : '; it is not idle yet'}` }];
        }
        // the desktop app is down, the conversation is open in a terminal, or it ended at once: said as it is
        if (code === 503 || code === 502 || (out && out.elsewhere)) return [code, { ...out, bot: view1(bot) }];
        log(`could not resume ${bot.name} (${last}: ${(out && out.message) || code}); it starts a new conversation`);
      }
      const [code, out] = await d.api.startBot({ repo: bot.folder, account: bot.account, ...runOpts(bot), prompt: startPrompt(bot.name), name: bot.name, role }, d.ctx);
      // another start got in first (it is running already): that one is the bot
      if (code === 409 && convId(out && out.id)) {
        follow(bot, convId(out.id));
        return [200, { ok: true, bot: view1(bot), id: convId(out.id), key: out.id, started: false, message: out.message }];
      }
      if (code !== 200) return [code, { ...out, bot: view1(bot) }];
      const cid = convId(out.id);
      if (cid) { greet.add(cid); if (greet.size > 100) greet.delete(greet.values().next().value); follow(bot, cid); live.set(bot.id, { id: cid, key: out.key, status: null, pending: false }); }
      log(`started ${bot.name} (${cid || out.key}) in ${bot.folder}`);
      return [200, { ok: out.ok !== false, bot: view1(bot), id: cid, key: out.key, started: true, ...(out.promptSent === false ? { promptSent: false } : {}), message: out.message }];
    } finally { starting.delete(bot.id); }
  }

  // POST /bots/:id, /api/bots/:id { name?, brief?, account?, model?, effort?, shape?, color? }: CLAUDE.md is written
  // again, and a running bot is told once to read it. Account, model and effort take effect in its next new
  // conversation (a resume keeps them); shape and color at once (they are not in CLAUDE.md)
  async function update(id, b) {
    const bot = byId(id);
    if (!bot || bot.removed) return noBot();
    b = b && typeof b === 'object' ? b : {};
    const next = {};
    if ('name' in b) { const n = checkName(b.name, bots, bot.id); if (n.err) return [400, { ok: false, message: n.err }]; next.name = n.name; }
    if ('brief' in b) { const br = checkBrief(b.brief); if (br.err) return [400, { ok: false, message: br.err }]; next.brief = br.brief; }
    const o = checkOpts(b, bot, accounts());
    if (o.err) return [400, { ok: false, message: o.err }];
    Object.assign(next, o);
    const lk = checkLook(b);
    if (lk.err) return [400, { ok: false, message: lk.err }];
    const file = path.join(bot.folder, 'CLAUDE.md');
    let text, before = null;
    try { text = fillBrief(template(), { ...bot, ...next }); } catch (e) { return [500, { ok: false, message: `could not read ${templateFile}: ${e.code || e.message}` }]; }
    try { before = fs.readFileSync(file, 'utf8'); } catch {}
    const changed = text !== before;
    if (changed) {
      try { fs.mkdirSync(bot.folder, { recursive: true }); fs.writeFileSync(file, text); } catch (e) {
        return [500, { ok: false, bot: view1(bot), message: `could not write ${file}: ${e.code || e.message}` }];
      }
    }
    const renamed = next.name !== undefined && next.name !== bot.name;
    Object.assign(bot, next);
    applyLook(bot, lk);
    save();
    const now = (live.get(bot.id) || {}).id || bot.ids[bot.ids.length - 1];
    if (renamed && now && d.rename) { try { d.rename(now, bot.name); } catch {} }
    let told = false;
    if (changed) {
      const list = await d.api.hostList();
      const p = (list || []).find((x) => x && x.alive && x.role === roleOf(bot.id) && convId(x.id));
      if (p) {
        const [, r] = await d.api.deliverText(convId(p.id), CHANGED_NOTE, { kind: 'message', queue: true, open: false, via: 'server' }, d.ctx);
        told = !!(r && r.ok);
      }
    }
    log(`changed ${bot.name}${changed ? ': CLAUDE.md written again' : ''}${told ? ', and it was told' : ''}`);
    return [200, { ok: true, bot: view1(bot), message: !changed ? `saved ${bot.name}` : told ? `saved ${bot.name}; it reads CLAUDE.md again` : `saved ${bot.name}; it reads the new CLAUDE.md when it next starts` }];
  }

  // POST /bots/:id/switch { id, model?, effort? } (the page only): Dynamic's switch before a message, for the part of
  // the bot's model and effort that is dynamic (a fixed one is never changed here). id is the conversation the page
  // sends to, one of the bot's; api.js switchModel types /model and /effort while it is idle (answering "Switch
  // model?") and puts the default for new sessions back as it was, so no other session starts on what this picked
  async function switchTo(id, b) {
    const bot = byId(id);
    if (!bot || bot.removed) return noBot();
    b = b && typeof b === 'object' ? b : {};
    const cid = typeof b.id === 'string' ? convId(b.id) : null;
    if (!cid || !bot.ids.includes(cid)) return [400, { ok: false, message: `id must be one of ${bot.name}'s conversations` }];
    const body = {};
    if (b.model != null) {
      if (bot.model !== DYNAMIC) return [409, { ok: false, message: `${bot.name}'s model is not dynamic` }];
      if (typeof b.model !== 'string' || !API.MODEL_RE.test(b.model)) return [400, { ok: false, message: 'model must be a model name like claude-opus-5-5' }];
      body.model = b.model;
    }
    if (b.effort != null) {
      if (bot.effort !== DYNAMIC) return [409, { ok: false, message: `${bot.name}'s effort is not dynamic` }];
      if (!API.EFFORTS.includes(b.effort)) return [400, { ok: false, message: `effort must be one of ${API.EFFORTS.join(', ')}` }];
      body.effort = b.effort;
    }
    if (!Object.keys(body).length) return [400, { ok: false, message: 'give model, effort or both' }];
    if (!d.api.switchModel) return [503, { ok: false, message: 'switching is not available' }];
    const [code, out] = await d.api.switchModel(cid, body, d.ctx, 'henry');
    log(`${bot.name}: dynamic switch to ${[body.model, body.effort].filter(Boolean).join(', ')} -> ${code}${out && out.message ? ` (${out.message})` : ''}`);
    return [code, out];
  }

  // POST /api/bots/look { from, shape?, color? }: a bot changes its own look. from is the caller's conversation id (the
  // id note told it); only a bot's own conversation (not a removed bot's) is let in, and only shape and color change.
  // Any session can read the API token and say any from, so nothing here is more than its avatar's look
  function look(b) {
    b = b && typeof b === 'object' ? b : {};
    const from = typeof b.from === 'string' ? convId(b.from) : null;
    if (!from) return [400, { ok: false, message: 'from must be your conversation id (Fleet View told it to you: "Your id: ...")' }];
    const bot = bots.find((x) => !x.removed && x.ids.includes(from));
    if (!bot) return [403, { ok: false, message: 'only a bot changes its own look: from is not one of a bot\'s conversations' }];
    const extra = Object.keys(b).filter((k) => !['from', 'shape', 'color'].includes(k));
    if (extra.length) return [400, { ok: false, message: `a bot changes only its shape and color here, not ${extra.slice(0, 3).join(', ')}` }];
    if (!('shape' in b) && !('color' in b)) return [400, { ok: false, message: `give shape (${SHAPES.join(', ')}) and/or color (#rrggbb); null for the one picked for you` }];
    const lk = checkLook(b);
    if (lk.err) return [400, { ok: false, message: lk.err }];
    applyLook(bot, lk);
    save();
    log(`${bot.name} changed its look (${bot.shape || 'shape picked for it'}, ${bot.color || "its account's colour"})`);
    return [200, { ok: true, bot: view1(bot), message: `${bot.name} looks like this now: ${bot.shape || 'shape picked for it'}, ${bot.color || "its account's colour"}` }];
  }

  // POST /bots/:id/remove, /api/bots/:id/remove: its running session ended (Ctrl+C, as the page's Remove conversation
  // ends one; the host drops it from its restore list), then it leaves the list. Its folder, logs and ids are kept
  function remove(id) {
    const bot = byId(id);
    if (!bot || bot.removed) return Promise.resolve(noBot());
    return inTurn(id, async () => {
      if (bot.removed) return noBot();
      const ended = await endSessions(bot);
      bot.removed = true;
      live.delete(bot.id);
      save();
      log(`removed ${bot.name}${ended ? ` (ended ${ended} session${ended === 1 ? '' : 's'})` : ''}`);
      return [200, { ok: true, bot: viewOf(bot, null), message: `removed ${bot.name}; its folder ${bot.folder} and its conversations are kept` }];
    });
  }
  // ends each running session of the bot's -> how many
  async function endSessions(bot) {
    const list = await d.api.hostList();
    let n = 0;
    for (const p of list || []) {
      if (!p || !p.alive || !(p.role === roleOf(bot.id) || bot.ids.includes(convId(p.id)))) continue;
      const [code] = await d.api.endHosted(p.id);
      if (code === 200) n++;
    }
    return n;
  }

  // ---------- tasks and routines (bot-tasks.js) ----------
  // its tasks.json as last read: read again only when its mtime or size changed. A file just read is put right
  // (settle: ids, nextRun) and written back when that changed something
  function tasksOf(bot, now = Date.now()) {
    const f = TASKS.fileOf(bot.folder);
    let key = 'none';
    try { const st = fs.statSync(f); key = `${st.mtimeMs}:${st.size}`; } catch {}
    const c = taskFiles.get(bot.id);
    if (c && c.key === key) return c;
    const r = TASKS.readFile(bot.folder);
    if (r.err) log(`${bot.name}: ${r.err}`);
    if (r.data && !r.missing && TASKS.settle(r.data, now)) {
      try { TASKS.writeFile(bot.folder, r.data); try { const st = fs.statSync(f); key = `${st.mtimeMs}:${st.size}`; } catch {} } catch (e) {
        log(`${bot.name}: could not write ${f}: ${e.code || e.message}`);
      }
    }
    const out = { key, data: r.data || null, err: r.err || null };
    taskFiles.set(bot.id, out);
    return out;
  }
  // one task changed in the file as it is now (read fresh: the bot may have just written it): fn(task, data) changes it
  // in place and says false to leave the file alone; the file is put right (settle) and written whole. -> [code, out]
  function changeTask(bot, taskId, fn) {
    const r = TASKS.readFile(bot.folder);
    if (r.err) return [409, { ok: false, message: `${bot.name}'s ${r.err}` }];
    const t = r.data.tasks.find((x) => x && typeof x === 'object' && x.id === taskId);
    if (!t || !TASKS.readTask(t)) return [404, { ok: false, message: `${bot.name} has no task ${taskId}` }];
    const res = fn(t, r.data);
    if (res === false) return [409, { ok: false, message: 'nothing to change' }];
    TASKS.settle(r.data, Date.now());
    try { TASKS.writeFile(bot.folder, r.data); } catch (e) { return [500, { ok: false, message: `could not write ${TASKS.fileOf(bot.folder)}: ${e.code || e.message}` }]; }
    taskFiles.delete(bot.id);
    return [200, { ok: true, task: TASKS.viewTask(t), res }];
  }
  // state.bots[].tasks: open ones first by next run, then paused, then done (newest run first); tasksError when the
  // file can't be read
  function tasksView(bot) {
    const c = tasksOf(bot);
    const rank = { open: 0, paused: 1, done: 2 };
    const tasks = ((c.data && c.data.tasks) || []).map(TASKS.viewTask).filter(Boolean)
      .sort((a, b) => rank[a.status] - rank[b.status] || (a.nextRun == null) - (b.nextRun == null) || (a.nextRun || 0) - (b.nextRun || 0) || (b.lastRun || 0) - (a.lastRun || 0))
      .slice(0, TASKS.TASKS_MAX);
    return { tasks, ...(c.err ? { tasksError: c.err } : {}) };
  }
  const withTasks = (v) => { const b = byId(v.id); return b ? { ...v, ...tasksView(b) } : v; };

  // one run of a task delivered to its bot: written into the file first (a restart never fires it again), then the
  // bot started when it is not running (start: its running conversation, its last one resumed, or a new one), then
  // the message; what became of it goes on the run (convId, or why it was not delivered). by: 'schedule' | 'henry'
  async function fire(bot, taskId, by, due = null) {
    let run = null, text = null;
    const now = Date.now();
    const key = `${bot.id}/${taskId}`;
    const [code, out] = changeTask(bot, taskId, (t) => {
      // a scheduled run only while it is still due as the file says now
      if (by === 'schedule' && !TASKS.dueTasks({ tasks: [t] }, now).length) return false;
      run = TASKS.markRun(t, now, by, due);
      text = TASKS.runText(t, due, now, by);
      return true;
    });
    if (code !== 200) {
      // the last read said it was due and the file now says not (read it again next pass), or its run could not be
      // written: then no scheduled try for a while, not one every pass
      taskFiles.delete(bot.id);
      if (by === 'schedule' && code >= 500) { heldTill.set(key, now + HOLD_MS); log(`${bot.name}: task ${taskId} waits ${HOLD_MS / 60e3} min: ${out && out.message}`); }
      return [code, out];
    }
    if (by === 'schedule') sentFor.set(key, due);
    const entry = (t) => (Array.isArray(t.runs) ? t.runs : []).find((x) => x && x.at === run.at && x.by === by);
    const note = (o) => { changeTask(bot, taskId, (t) => { const r = entry(t); if (!r) return false; Object.assign(r, o); return true; }); };
    // not delivered: the run says so, and a scheduled one-off is tried again (bot-tasks.js failRun)
    const failed = (why) => {
      let result = `not delivered: ${why}`;
      changeTask(bot, taskId, (t) => { const r = entry(t); if (!r) return false; result = TASKS.failRun(t, r, why, by); if (t.lastRun == null) sentFor.delete(key); return true; });
      log(`${bot.name}: task ${taskId} ${result}`);
    };
    const [sc, so] = await start(bot.id);
    const cid = sc === 200 && so && so.ok !== false ? so.id : null;
    if (!cid) {
      const why = (so && so.message) || `error ${sc}`;
      failed(`${bot.name} did not start (${why})`);
      return [sc === 200 ? 502 : sc, { ok: false, message: `${bot.name} did not start: ${why}` }];
    }
    const [dc, dout] = await d.api.deliverText(cid, text, { kind: 'message', queue: true, open: true, via: 'server' }, d.ctx);
    const ok = dc === 200 || dc === 202;
    if (ok) note({ convId: cid, ...(dc === 202 ? { result: 'queued: a menu was up, it goes in once that is answered' } : {}) });
    else { note({ convId: cid }); failed((dout && dout.message) || `error ${dc}`); }
    log(`${bot.name}: ${by === 'henry' ? 'ran' : 'scheduled'} task ${taskId} -> ${dc}${dout && dout.message ? ` (${dout.message})` : ''}`);
    return ok ? [200, { ok: true, id: cid, message: `sent it to ${bot.name}` }] : [dc, { ok: false, message: (dout && dout.message) || `could not send it to ${bot.name}` }];
  }

  // every few seconds (fleet-view.js): each bot's due tasks delivered, one bot's after another of its own; the host's
  // list is asked first, and with the desktop app down nothing fires (or moves on): it does once it is back. Resolves
  // when every delivery this pass began has ended (the tests wait for that)
  async function schedule() {
    if (d.demo || scheduling) return;
    scheduling = true;
    const jobs = [];
    try {
      if (!briefsChecked) { briefsChecked = true; await refreshBriefs(); }
      const now = Date.now();
      const due = [];
      for (const b of bots) {
        if (b.removed || firing.has(b.id)) continue;
        const c = tasksOf(b, now);
        const list = (c.data ? TASKS.dueTasks(c.data, now) : []).filter((x) => {
          const key = `${b.id}/${x.task.id}`;
          return !((heldTill.get(key) || 0) > now) && sentFor.get(key) !== x.due;
        });
        if (list.length) due.push({ bot: b, list });
      }
      if (!due.length) return;
      if ((await d.api.hostList()) === null) { log(`scheduled tasks wait: ${HOST_DOWN}`); return; }
      for (const { bot, list } of due) {
        firing.add(bot.id);
        jobs.push((async () => {
          try { for (const x of list) await fire(bot, x.task.id, 'schedule', x.due); } catch (e) { log(`${bot.name}: scheduled task failed: ${(e && e.message) || e}`); }
          finally { firing.delete(bot.id); }
        })());
      }
    } catch (e) {
      log(`schedule failed: ${(e && e.message) || e}`);
    } finally { scheduling = false; }
    await Promise.all(jobs);
  }

  // GET /bots/:id/tasks: its list, as state.bots shows it
  function tasks(id) {
    const bot = byId(id);
    if (!bot || bot.removed) return noBot();
    return [200, { ok: true, file: TASKS.fileOf(bot.folder), ...tasksView(bot) }];
  }
  // POST /bots/:id/tasks/:taskId { action } (the page only): pause (it does not fire until resumed), resume (from its
  // next time on: what it missed while paused is not caught up; a one-off whose time passed meanwhile runs on Run now
  // only), run (delivered now; the schedule stays as it is), delete (out of the file)
  async function taskAction(id, taskId, b) {
    const bot = byId(id);
    if (!bot || bot.removed) return noBot();
    const action = b && typeof b === 'object' ? b.action : null;
    if (typeof taskId !== 'string' || !TASKS.ID_RE.test(taskId)) return [400, { ok: false, message: 'no such task id' }];
    if (action === 'run') {
      if (d.demo) return [503, { ok: false, message: 'the demo runs no tasks' }];
      if (firing.has(bot.id)) return [409, { ok: false, message: `${bot.name} is being given a task already; try again in a moment` }];
      firing.add(bot.id);
      try { return await fire(bot, taskId, 'henry'); } finally { firing.delete(bot.id); }
    }
    const done = (r, msg) => (r[0] === 200 ? [200, { ...r[1], res: undefined, message: msg }] : r);
    if (action === 'pause') return done(changeTask(bot, taskId, (t) => { if (t.status === 'paused') return false; t.status = 'paused'; t.nextRun = null; return true; }), 'paused');
    if (action === 'resume') return done(changeTask(bot, taskId, (t) => { if (t.status === 'open') return false; t.status = 'open'; t.nextRun = null; TASKS.skipMissed(t, Date.now()); return true; }), 'resumed');
    if (action === 'delete') {
      return done(changeTask(bot, taskId, (t, data) => { data.tasks = data.tasks.filter((x) => x !== t); return true; }), 'deleted');
    }
    return [400, { ok: false, message: 'action must be pause, resume, run or delete' }];
  }

  // bot/BRIEF.md changed since a bot's CLAUDE.md was written (a Fleet View update): written again, and a running bot is
  // told to read it (once; a bot not running reads it when it next starts)
  async function refreshBriefs() {
    let tpl;
    try { tpl = template(); } catch { return; }
    const stale = [];
    for (const b of bots) {
      if (b.removed) continue;
      const file = path.join(b.folder, 'CLAUDE.md');
      const text = fillBrief(tpl, b);
      let before = null;
      try { before = fs.readFileSync(file, 'utf8'); } catch {}
      if (before === text) continue;
      try { fs.mkdirSync(b.folder, { recursive: true }); fs.writeFileSync(file, text); stale.push(b); } catch (e) { log(`could not write ${file}: ${e.code || e.message}`); }
    }
    if (!stale.length) return;
    log(`wrote CLAUDE.md again for ${stale.map((b) => b.name).join(', ')} (bot/BRIEF.md changed)`);
    const list = await d.api.hostList();
    for (const b of stale) {
      const p = (list || []).find((x) => x && x.alive && x.role === roleOf(b.id) && convId(x.id));
      if (p) await d.api.deliverText(convId(p.id), CHANGED_NOTE, { kind: 'message', queue: true, open: false, via: 'server' }, d.ctx);
    }
  }

  // every few seconds (fleet-view.js): follow each bot to its new conversations, and tell each new one its id
  function sessionsHaveBots() {
    try {
      const j = JSON.parse(fs.readFileSync(d.sessionsFile, 'utf8'));
      return !!(j && Array.isArray(j.sessions) && j.sessions.some((x) => x && botOfRole(x.role)));
    } catch { return false; }
  }
  async function tick() {
    if (d.demo || ticking || !d.sessionsFile) return;
    ticking = true;
    try {
      const now = Date.now();
      let m = 0;
      try { m = fs.statSync(d.sessionsFile).mtimeMs; } catch {}
      if (m !== fileM) { fileM = m; fileBots = sessionsHaveBots(); }
      if (!fileBots) { live = new Map(); return; }
      // as chief.js: the host's list when sessions.json changed, and every HOST_EVERY_MS while a bot runs or the list
      // did not come; a bot that ended (still in the file for the restore) is not polled for
      if (m === askedM && ((!live.size && !hostDown) || now - askedAt < HOST_EVERY_MS)) return;
      askedAt = now; askedM = m; hostDown = true;
      const list = await d.api.hostList();
      hostDown = list == null;
      const mine = (list || []).map((p) => ({ p, bot: p ? byId(botOfRole(p.role)) : null })).filter((x) => x.bot);
      const next = new Map();
      // ended ones first, so a running one is its bot's newest id
      for (const { p, bot } of [...mine.filter((x) => !x.p.alive), ...mine.filter((x) => x.p.alive)]) {
        const cid = convId(p.id);
        if (cid) follow(bot, cid);
        if (p.alive) next.set(bot.id, { id: cid, key: p.id, status: p.status || null, pending: !!p.pending });
      }
      live = next;
      for (const [bid, l] of [...live]) {
        const bot = byId(bid);
        if (bot.removed) {
          // a removed bot's session came back (a restore after the host was down): it ends
          if (!chains.has(bid)) { live.delete(bid); log(`${bot.name} was removed: its session ${l.key} ends`); await d.api.endHosted(l.key); }
          continue;
        }
        if (!l.id) continue;
        const info = d.turnInfo ? d.turnInfo(l.id) : null;
        const t = tellerOf(bot);
        if (t.due({ id: l.id, pending: l.pending, starting: starting.has(bid), firstSeen: firstSeen.get(l.id), promptAt: info && info.promptAt, now })) await t.tell(l.id);
      }
    } catch (e) {
      log(`tick failed: ${(e && e.message) || e}`);
    } finally { ticking = false; }
  }

  return {
    // state.bots, and GET /api/bots
    view: () => (d.demo ? [] : listView(bots, live).map(withTasks)),
    list: () => [200, { ok: true, bots: d.demo ? [] : listView(bots, live).map(withTasks) }],
    // ~/.fleet-view.json's bots
    saveShape: () => bots.map((b) => ({ ...b, ids: [...b.ids], told: [...b.told] })),
    create, start, update, remove, look, switchTo, tick,
    // tasks and routines: the scheduler (fleet-view.js runs it every few seconds), GET and POST /bots/:id/tasks
    schedule, tasks, taskAction,
    // /state's tags, with the Chief's ids (chief.js chiefIds)
    tagOf: (chiefIds) => tagger(chiefIds, bots),
    // api.js resumable: a bot's conversation (not a removed bot's) may be resumed in its folder, with its role
    vouch: (id) => { const b = bots.find((x) => !x.removed && x.ids.includes(id)); return b ? { role: roleOf(b.id), folder: b.folder } : null; },
    inBots: (p) => inBots(p, base),
    // another machine's bots, from these conversations (elsewhereBots)
    elsewhere: (convs) => (d.demo ? [] : elsewhereBots(convs, base, bots)),
    // for tests
    _state: () => ({ bots, live, starting: [...starting] }),
  };
}

module.exports = { createBots, elsewhereBots, elsewhereView, checkName, checkBrief, checkOpts, checkLook, SHAPES, DYNAMIC, DYNAMIC_START, runOpts, slugOf, pickFolder, inBots, fillBrief, tagger, tagState, viewOf, listView, loadBots,
  startPrompt, idNote, roleOf, botOfRole, BOTS_DIR, TEMPLATE_FILE, CHANGED_NOTE, IDS_MAX, NAME_MAX, BRIEF_MAX };
