// bots.js: the server side of Bots, Henry's overseers besides the Chief (chief.js). Each bot is one hosted session
// whose role is 'bot:<id>' (desktop/host.js), in its own folder ~/Bots/<slug>, whose CLAUDE.md (bot/BRIEF.md filled in)
// holds Henry's standing instructions for it. Henry gives it tasks in its chat; they need not touch the fleet or a repo.
// fleet-view.js requires it and hands it what it needs (createBots below).
//
// - The registry: settings.bots in ~/.fleet-view.json, [{ id, name, brief, account, model, effort, folder, createdAt,
//   ids: [its conversations, oldest first, at most 50], told: [the ids told theirs], removed? }]. A removed bot keeps
//   its folder, its logs and its ids: they stay tagged in /state, so its conversations never show on the map.
// - Start, one at a time per bot: the conversation running already is taken as it is; else its newest one is resumed
//   with the role (api.js openBot); else a new session starts in its folder (api.js startBot: the folder is not a listed
//   repo, the registry vouches for it), named after the bot.
// - Follow it: tick() reads the host's list while sessions.json shows a bot's role, and adds each conversation with
//   that role (a handoff's pickup, a /clear) to its bot's ids. Each new one is told its id once, as the Chief is
//   (chief.js createTeller). A removed bot's session that comes back (a restore) is ended.
// - /state: tagger() and tagState() put bot: '<bot id>' ('chief' for the Chief's) on each overseer conversation in
//   sessions, finished and removed; view() is state.bots. The ~/Bots folders are never a workspace (inBots).
// - Who is talking: api.js frames what reaches a bot as it does for the Chief (isOverseer).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const CHIEF = require(path.join(__dirname, 'chief.js'));
const API = require(path.join(__dirname, 'api.js'));
const P = require(path.join(__dirname, 'platform.js'));

const BOTS_DIR = path.join(os.homedir(), 'Bots');
const TEMPLATE_FILE = path.join(__dirname, 'bot', 'BRIEF.md');
const NAME_MAX = 40, BRIEF_MAX = 4000, SLUG_MAX = 32;
const IDS_MAX = 50; // conversation ids kept per bot
const BOTS_MAX = 50; // bots not removed
const HOST_EVERY_MS = 10e3; // while a bot is in sessions.json: how often the host's list is read
const HOST_DOWN = 'the Fleet View desktop app is not running';
const BOT_ID_RE = /^[0-9a-f]{12}$/;
const { convId } = CHIEF;
const roleOf = (id) => `bot:${id}`;
const botOfRole = (role) => { const m = /^bot:([0-9a-f]{12})$/.exec(typeof role === 'string' ? role : ''); return m ? m[1] : null; };
const startPrompt = (name) => `[Fleet View] You are ${name}, one of Henry's bots. Your standing instructions are in CLAUDE.md in this folder. Your conversation id comes in the next message.`;
const idNote = (name, id) => `[Fleet View] You are ${name}, one of Henry's bots. Your id: ${id}.`;
const CHANGED_NOTE = '[Fleet View] Your instructions changed: read CLAUDE.md again.';

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
// account, model, effort, as POST /api/sessions takes them; one left out is base's. -> { account, model, effort } or { err }
function checkOpts(b, base, accounts) {
  const out = { account: base.account, model: base.model, effort: base.effort };
  if (b.account != null) {
    if (typeof b.account !== 'string' || !accounts.includes(b.account)) return { err: `account must be one of ${accounts.join(', ')}` };
    out.account = b.account;
  }
  if (b.model != null) {
    if (typeof b.model !== 'string' || !API.MODEL_RE.test(b.model)) return { err: 'model must be a model name like opus, sonnet, haiku or claude-opus-5-5[1m] (letters, digits, . - [ ])' };
    out.model = b.model;
  }
  if (b.effort != null) {
    if (!API.EFFORTS.includes(b.effort)) return { err: `effort must be one of ${API.EFFORTS.join(', ')}` };
    out.effort = b.effort;
  }
  return out;
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
// one bot as state.bots and the answers show it; l: its running session from the host's list ({ id }), if any
function viewOf(b, l) {
  return { id: b.id, name: b.name, brief: b.brief, account: b.account, model: b.model, effort: b.effort, folder: b.folder, createdAt: b.createdAt,
    convId: (l && l.id) || b.ids[b.ids.length - 1] || null, live: !!l };
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
      told: Array.isArray(b.told) ? [...new Set(b.told.map(convId).filter(Boolean))] : [], ...(b.removed === true ? { removed: true } : {}) });
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
  let ticking = false, fileM = -1, fileBots = false, askedAt = 0, askedM = -1, hostDown = false;
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
      t = CHIEF.createTeller({ api: d.api, ctx: d.ctx, note: (id) => idNote(bot.name, id), told: bot.told, log: (x) => log(`${bot.name}: ${x}`),
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

  // POST /bots, /api/bots { name, brief?, account?, model?, effort? }: the bot, its folder (trusted for every account)
  // and its CLAUDE.md, then it starts. Made but not started: ok false, with bot
  async function create(b) {
    if (d.demo) return [503, { ok: false, message: 'the demo makes no bots' }];
    b = b && typeof b === 'object' ? b : {};
    const n = checkName(b.name, bots);
    if (n.err) return [400, { ok: false, message: n.err }];
    const br = checkBrief(b.brief);
    if (br.err) return [400, { ok: false, message: br.err }];
    const o = checkOpts(b, CHIEF.DEFAULTS, accounts());
    if (o.err) return [400, { ok: false, message: o.err }];
    if (bots.filter((x) => !x.removed).length >= BOTS_MAX) return [409, { ok: false, message: `at most ${BOTS_MAX} bots: remove one first` }];
    let id;
    do id = crypto.randomBytes(6).toString('hex'); while (byId(id));
    const folder = pickFolder(base, slugOf(n.name), bots, (p) => fs.existsSync(p));
    if (!folder) return [409, { ok: false, message: `no free folder for ${n.name} in ${base}` }];
    const bot = { id, name: n.name, brief: br.brief, account: o.account, model: o.model, effort: o.effort, folder, createdAt: Date.now(), ids: [], told: [] };
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
      const [code, out] = await d.api.startBot({ repo: bot.folder, account: bot.account, model: bot.model, effort: bot.effort, prompt: startPrompt(bot.name), name: bot.name, role }, d.ctx);
      // another start got in first (it is running already): that one is the bot
      if (code === 409 && convId(out && out.id)) {
        follow(bot, convId(out.id));
        return [200, { ok: true, bot: view1(bot), id: convId(out.id), key: out.id, started: false, message: out.message }];
      }
      if (code !== 200) return [code, { ...out, bot: view1(bot) }];
      const cid = convId(out.id);
      if (cid) { follow(bot, cid); live.set(bot.id, { id: cid, key: out.key, status: null, pending: false }); }
      log(`started ${bot.name} (${cid || out.key}) in ${bot.folder}`);
      return [200, { ok: out.ok !== false, bot: view1(bot), id: cid, key: out.key, started: true, ...(out.promptSent === false ? { promptSent: false } : {}), message: out.message }];
    } finally { starting.delete(bot.id); }
  }

  // POST /bots/:id, /api/bots/:id { name?, brief?, account?, model?, effort? }: CLAUDE.md is written again, and a running
  // bot is told once to read it. Account, model and effort take effect in its next new conversation (a resume keeps them)
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
    view: () => (d.demo ? [] : listView(bots, live)),
    list: () => [200, { ok: true, bots: d.demo ? [] : listView(bots, live) }],
    // ~/.fleet-view.json's bots
    saveShape: () => bots.map((b) => ({ ...b, ids: [...b.ids], told: [...b.told] })),
    create, start, update, remove, tick,
    // /state's tags, with the Chief's ids (chief.js chiefIds)
    tagOf: (chiefIds) => tagger(chiefIds, bots),
    // api.js resumable: a bot's conversation (not a removed bot's) may be resumed in its folder, with its role
    vouch: (id) => { const b = bots.find((x) => !x.removed && x.ids.includes(id)); return b ? { role: roleOf(b.id), folder: b.folder } : null; },
    inBots: (p) => inBots(p, base),
    // for tests
    _state: () => ({ bots, live, starting: [...starting] }),
  };
}

module.exports = { createBots, checkName, checkBrief, checkOpts, slugOf, pickFolder, inBots, fillBrief, tagger, tagState, viewOf, listView, loadBots,
  startPrompt, idNote, roleOf, botOfRole, BOTS_DIR, TEMPLATE_FILE, CHANGED_NOTE, IDS_MAX, NAME_MAX, BRIEF_MAX };
