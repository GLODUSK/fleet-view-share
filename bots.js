// bots.js: the server side of Bots, Henry's overseers of the fleet. Each bot is one hosted session
// whose role is 'bot:<id>' (desktop/host.js), in its own folder ~/Bots/<slug>, whose CLAUDE.md (bot/BRIEF.md filled in)
// holds Henry's standing instructions for it. Henry gives it tasks in its chat; they need not touch the fleet or a repo.
// fleet-view.js requires it and hands it what it needs (createBots below).
//
// - The registry: settings.bots in ~/.fleet-view.json, [{ id, name, brief, role, account, model, effort, folder, createdAt,
//   ids: [its conversations, oldest first, at most 50], told: [the ids told theirs], removed?, shape?, color?, lookAt? }].
//   role (Henry, 2026-10-13: "give them roles in their bot profile"): a short line, at most 60 characters ('' none),
//   in its CLAUDE.md (bot/BRIEF.md {{role}}) and next to its name in the team briefs and notes (fleet-view.js memberOf).
//   A removed bot keeps its folder, its logs and its ids: they stay tagged in /state, so its conversations never show on
//   the map. shape and color are its avatar's look (web/mascot.js), set when it is made or changed, or by the bot
//   itself (look below: POST /api/bots/look, fv look); left out, the page picks them. lookAt: when they last changed
//   (lookItems below: the look, and the role, go to Henry's other machines, sync-prefs.js botLooks; lookAt moves when
//   either changes). model and effort may each be 'dynamic' (a new bot's are): its sessions start on DYNAMIC_START,
//   and the page sizes each message Henry sends it and switches first when needed (switchTo below: POST
//   /bots/:id/switch, the page only).
// - Start, one at a time per bot: the conversation running already is taken as it is; else its newest one is resumed
//   with the role (api.js openBot); else a new session starts in its folder (api.js startBot: the folder is not a listed
//   repo, the registry vouches for it), named after the bot.
// - Follow it: tick() reads the host's list while sessions.json shows a bot's role, and adds each conversation with
//   that role (a handoff's pickup, a /clear) to its bot's ids. Each new one is told its id once
//   (overseer.js createTeller). A removed bot's session that comes back (a restore) is ended.
// - /state: tagger() and tagState() put bot: '<bot id>' on each overseer conversation in
//   sessions, finished and removed; view() is state.bots. The ~/Bots folders are never a workspace (inBots).
// - Another machine's bots: registries never sync (sync-prefs.js), but sync brings their chats here, into ~/Bots/<slug>.
//   elsewhere() makes one bot of each such folder that no bot here owns, from its conversations: tagged like a bot's,
//   so they are the Bots tab's alone too, and listed in state.bots with elsewhere: true (no Start, Edit, Remove or
//   Tasks here: it is run and changed on its own machine). Henry, 2026-10-11: the PC's Panchito on the Mac. Its look is
//   the one its machine gave it: each bot's look syncs by its folder's name (lookItems, sync-prefs.js botLooks), and
//   elsewhereView wears it (fleet-view.js settings.botLooks keeps the other machines').
// - Who is talking: api.js frames what reaches a bot by where it came from (isOverseer, overseer.js frame).
// - Tasks and routines: each bot keeps its task list in tasks.json in its folder (bot-tasks.js has the format), one-off
//   and recurring, updated by the bot itself as Henry gives, finishes, changes or cancels work (bot/BRIEF.md says so).
//   schedule() (every few seconds, fleet-view.js) delivers each task that comes due to its bot as a "[Fleet View]
//   Scheduled task: ..." message, starting the bot first when it is not running (start below), so a bot never has
//   to poll. The run is written into the file before it is delivered, so a restart never fires it twice; with the
//   desktop app down nothing fires (it does once the app is back, once). state.bots[].tasks is the list as the Bots tab
//   shows it; POST /bots/:id/tasks/:taskId { action: pause | resume | run | delete } (the page only) changes it, run
//   delivering it now. The first schedule() after a start also writes every bot's CLAUDE.md again when bot/BRIEF.md
//   changed (a Fleet View update) and tells a running bot to read it, so bots made before a change learn it too.
// - Long context (Henry, 2026-10-12): a bot keeps its whole chat in context instead of handing off at 200k. Its
//   sessions run on the 1M-context version of their model (longModel, runOpts), named in its folder's
//   .claude/settings.json too (writeModel) so a resume does as well; ~/.claude/hooks/session-length.py leaves sessions
//   in ~/Bots alone. The Bots tab shows all its conversations as one chat anyway (state.bots ids).
// - On the map and watching (Henry, 2026-10-13): a bot may be put on the map (map: { x, y }, world coordinates; POST
//   /bots/:id/map, the page only) and set to watch up to 8 conversations, each with a job (watches: [{ id, job, since,
//   last? }]; WATCH_JOBS: report, answer, review; POST /bots/:id/watch, the page only, from the map or a conversation's
//   menu). It is told once when a watch is set, changed or stopped. watchTick() (every few seconds, fleet-view.js)
//   reads each watched conversation's facts from the raw sessions (d.watchFacts) and messages the bot, started first
//   when it is not running, when one's turn ends, it asks something, errors or stalls (watchEvent: held 10 s, once per
//   situation, never for what was there at first sight, so a restart fires nothing), so a bot never polls. A handoff
//   moves the watch to the pickup; a conversation gone from Fleet View ends it. Off the map, every watch stops.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const OVERSEER = require(path.join(__dirname, 'overseer.js'));
const API = require(path.join(__dirname, 'api.js'));
const P = require(path.join(__dirname, 'platform.js'));
const TASKS = require(path.join(__dirname, 'bot-tasks.js'));
const SWITCH = require(path.join(__dirname, 'account-switch.js'));

const BOTS_DIR = path.join(os.homedir(), 'Bots');
const TEMPLATE_FILE = path.join(__dirname, 'bot', 'BRIEF.md');
const NAME_MAX = 40, BRIEF_MAX = 4000, ROLE_MAX = 60, SLUG_MAX = 32;
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
// what a registry entry without its own account, model or effort runs on
const FALLBACK = { account: 'B', model: 'claude-sonnet-5-5', effort: 'medium' };
const NEW_BOT = { account: FALLBACK.account, model: DYNAMIC, effort: DYNAMIC };
const { convId } = OVERSEER;
const roleOf = (id) => `bot:${id}`;
const botOfRole = (role) => { const m = /^bot:([0-9a-f]{12})$/.exec(typeof role === 'string' ? role : ''); return m ? m[1] : null; };
// What Fleet View says to a bot. A new bot gets two notes, the start prompt and then its id, and greeted Henry after
// each; now it answers the first with a bare "ok" (the Bots tab hides that) and says hello once, to the id note of
// the conversation it was started in. A handoff's pickup or a /clear gets an id note too, answered with "ok": the
// bot is not new there. The Bots tab shows these notes as small grey lines (chats-model.js botFeed), not bubbles.
const startPrompt = (name) => `[Fleet View] You are ${name}, one of Henry's bots. Your standing instructions are in CLAUDE.md in this folder. Your conversation id comes in the next message: reply to this one with just "ok".`;
const idNote = (name, id, greet = false) => `[Fleet View] You are ${name}, one of Henry's bots. Your id: ${id}. ${greet ? 'Greet Henry in one short line, nothing more.' : 'Reply with just "ok".'}`;
const CHANGED_NOTE = '[Fleet View] Your instructions changed: read CLAUDE.md again, then say so in one short line.';

// ---------- on the map and watching ----------
const MAP_MAX = 100000; // a map spot's x and y, either way from the middle
const WATCHES_MAX = 8; // conversations one bot watches
const WATCH_SETTLE_MS = 10e3; // a watched conversation's new state must hold this long before the bot hears of it (no flickers)
const WATCH_TRIES = 3; // a watch note that could not go in: tried this many times, then dropped
// the jobs a watch may have: label (the page's words for it) and line (the note's words for the bot; <id> is the
// watched conversation's id)
const WATCH_JOBS = {
  report: { label: 'Tell me when it needs me', line: 'tell Henry in one or two lines what happened and whether he needs to do anything (`fv read <id>` for more).' },
  answer: { label: 'Answer its questions', line: 'when it asks something and Henry\'s instructions or the conversation make the answer clear, answer it yourself (`fv menu <id>`, `fv answer <id> ...`, or `fv send <id> "..." --from <your id>`) and tell Henry in one line what you answered; otherwise tell Henry what it asks. When its turn just ended, say in one line what it did.' },
  review: { label: "Review its work when it's done", line: 'when it says its work is done (a PR opened or merged, a fix shipped), review the change (`gh pr diff`, `fv transcript <id>`) and tell Henry what you found. Otherwise reply with just `[quiet]`.' },
};
const WATCH_WHAT = ['finished', 'asks', 'error', 'stalled'];
const WHAT_SAYS = { finished: 'finished its turn', asks: 'is asking something', error: 'hit an error', stalled: 'looks stalled' };
const isJob = (j) => typeof j === 'string' && Object.prototype.hasOwnProperty.call(WATCH_JOBS, j);
// review hears only of a finished turn; report and answer of everything
const jobWants = (job, what) => (job === 'review' ? what === 'finished' : true);
const jobLine = (job, cid) => WATCH_JOBS[job].line.split('<id>').join(cid);
// a map spot: rounded to a tenth, kept within MAP_MAX
const coord = (n) => Math.round(Math.max(-MAP_MAX, Math.min(MAP_MAX, n)) * 10) / 10 || 0; // never -0
const mapPoint = (v) => (v && typeof v === 'object' && Number.isFinite(v.x) && Number.isFinite(v.y) ? { x: coord(v.x), y: coord(v.y) } : null);
// POST /bots/:id/map's at: { x, y } (numbers) or null (off the map). -> { at } or { err }
function checkAt(v) {
  if (v === null) return { at: null };
  const at = mapPoint(v);
  return at ? { at } : { err: 'at must be { x, y } (numbers, the map\'s world coordinates), or null: off the map' };
}
// the watches as saved, checked: a known job, a conversation id once, at most WATCHES_MAX; last only when it makes sense
function readWatches(v) {
  const out = [];
  for (const w of Array.isArray(v) ? v : []) {
    const cid = w && typeof w === 'object' ? convId(w.id) : null;
    if (!cid || !isJob(w.job) || out.some((x) => x.id === cid)) continue;
    const l = w.last && typeof w.last === 'object' && Number.isFinite(w.last.at) && WATCH_WHAT.includes(w.last.what) ? { at: Math.round(w.last.at), what: w.last.what } : null;
    out.push({ id: cid, job: w.job, since: Number.isFinite(w.since) && w.since > 0 ? Math.round(w.since) : 0, ...(l ? { last: l } : {}) });
    if (out.length >= WATCHES_MAX) break;
  }
  return out;
}
// what a watched conversation's state counts as: asks (ASKING, QUESTION), error, stalled, rest (IDLE, DONE: its turn
// ended), busy (working), none (not listed)
const classOf = (st) => (st === 'ASKING' || st === 'QUESTION' ? 'asks' : st === 'ERROR' ? 'error' : st === 'STALLED' ? 'stalled'
  : st === 'IDLE' || st === 'DONE' ? 'rest' : st ? 'busy' : 'none');
// One look at a watched conversation. seen: what the last look kept ({ cls, since (when cls began), replyAt (the
// newest reply accounted for), fired (the last event's key) }), or null for the first; fact: { state, replyAt }.
// -> { seen, event: null | { what, key } }. The first sight only records (what is there already, and after a restart,
// is never news). An event once the state has held WATCH_SETTLE_MS: asks, error, stalled, or finished for a rest with
// a newer reply (held from that reply). The key (what:since, or finished:replyAt) makes each situation fire once
function watchEvent(seen, fact, now) {
  const cls = classOf(fact && fact.state);
  const replyAt = fact && Number.isFinite(fact.replyAt) ? fact.replyAt : 0;
  const needs = cls === 'asks' || cls === 'error' || cls === 'stalled';
  if (!seen) return { seen: { cls, since: now, replyAt, fired: needs ? `${cls}:${now}` : null }, event: null };
  if (cls !== seen.cls) return { seen: { ...seen, cls, since: now }, event: null };
  let what = null, key = null, held = seen.since;
  if (needs) { what = cls; key = `${cls}:${seen.since}`; }
  else if (cls === 'rest' && replyAt > (seen.replyAt || 0)) { what = 'finished'; key = `finished:${replyAt}`; held = Math.max(seen.since, replyAt); }
  if (!what || now - held < WATCH_SETTLE_MS || key === seen.fired) return { seen, event: null };
  return { seen: { ...seen, fired: key, ...(what === 'finished' ? { replyAt } : {}) }, event: { what, key } };
}
// a conversation inside a note's first line: its name in quotes (OVERSEER.headName: no quote or bracket can end them), its id
const quoted = (name, cid) => `"${OVERSEER.headName(name || cid.slice(0, 8), 60)}" (${cid})`;
// the note for one bot's events (each { id, name, what, lastReply, job }): one block each
function watchNote(evs) {
  const block = (e) => [`${quoted(e.name, e.id)} ${WHAT_SAYS[e.what]}.`, `Its last reply: ${OVERSEER.oneLine(e.lastReply, 400) || 'none'}`, `Your job for it: ${jobLine(e.job, e.id)}`];
  if (evs.length === 1) { const [first, ...rest] = block(evs[0]); return [`[Fleet View] Watch: ${first}`, ...rest].join('\n'); }
  return [`[Fleet View] Watch: ${evs.length} updates.`, ...evs.flatMap((e) => ['', ...block(e)])].join('\n');
}
const watchSetNote = (name, cid, job) => `[Fleet View] Henry set you to watch ${quoted(name, cid)} with the job: ${jobLine(job, cid).replace(/\.$/, '')}. Fleet View will message you when its turn ends, it asks something, errors or stalls; you never need to poll it. Reply with just "ok".`;
const watchStopNote = (name, cid) => `[Fleet View] Henry stopped your watch on ${quoted(name, cid)}. Reply with just "ok".`;
const watchGoneNote = (name, cid) => `[Fleet View] ${quoted(name, cid)}, which you were watching, is gone from Fleet View; the watch ended. Reply with just "ok".`;
// the tasks Henry deleted in one burst ([{ id, title }]): one a line, its id (the bot's own key) and its title as the
// file had it. web/chats-model.js goneNote reads this shape back into one short line for Henry: keep the two together
function taskGoneNote(tasks) {
  const one = tasks.length === 1, it = one ? 'it' : 'them';
  return [`[Fleet View] Henry deleted ${one ? 'a task' : `${tasks.length} tasks`} from your tasks.json:`,
    ...tasks.map((t) => `- ${t.id}${t.title ? `: ${t.title}` : ''}`),
    `Leave ${it} out: don't add ${it} back, and read the file fresh before you next change it. Reply with just "ok".`].join('\n');
}
// a burst of deletes: told once no delete came for GONE_QUIET_MS (or GONE_HOLD_MS after the first), at most GONE_MAX
const GONE_QUIET_MS = 4000, GONE_HOLD_MS = 30000, GONE_MAX = 50;
// bot.gone as saved, checked: { tasks: [{ id, title }], first, last } or none
function readGone(g) {
  if (!g || typeof g !== 'object' || !Array.isArray(g.tasks)) return null;
  const tasks = g.tasks.filter((t) => t && typeof t.id === 'string' && TASKS.ID_RE.test(t.id))
    .map((t) => ({ id: t.id, title: OVERSEER.oneLine(typeof t.title === 'string' ? t.title : '', 200) })).slice(-GONE_MAX);
  return tasks.length ? { tasks, first: Number.isFinite(g.first) ? g.first : 0, last: Number.isFinite(g.last) ? g.last : 0 } : null;
}

// ---------- checks ----------
// C1 controls (0x80-0x9f): cleanText keeps them, and a name or a role goes into one line of the bot's prompts
const hasC1 = (s) => [...s].some((ch) => ch.charCodeAt(0) >= 0x80 && ch.charCodeAt(0) <= 0x9f);
// name: 1 to 40 characters on one line, no control characters (invisible ones dropped, as api.js cleanText does), and
// no other bot's that is not removed, in any case. self: the bot being changed. -> { name } or { err }
function checkName(v, bots, self = null) {
  const t = typeof v === 'string' ? API.cleanText(v) : null;
  const name = t && !/[\n\t]/.test(t) && !hasC1(t) ? t.trim() : '';
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
// role: what the bot does, in a few words ("QA", "Deploy watch"): up to 60 characters on one line, cleaned as a name is
// (invisible characters dropped, no control characters), trimmed; left out, null or blank is none (''). -> { role } or { err }
function checkRole(v) {
  if (v == null) return { role: '' };
  if (typeof v !== 'string') return { err: 'role must be text' };
  const t = API.cleanText(v);
  // cleanText says null for blank text too: with a character in front, only bad characters still do
  const bad = t === null ? API.cleanText(`.${v}`) === null : /[\n\t]/.test(t.trim()) || hasC1(t);
  if (bad) return { err: 'role must be one line of text, without control characters' };
  const role = (t || '').trim();
  if (role.length > ROLE_MAX) return { err: `role must be at most ${ROLE_MAX} characters` };
  return { role };
}
// account, model, effort, as POST /api/sessions takes them, or 'dynamic' for the model or the effort (sized for each
// message Henry sends from the page: web/chats-model.js sizeTask, switched through switchTo below) or for the account
// (each new conversation starts on the one with the most usage left: roomiest); one left out is base's.
// -> { account, model, effort } or { err }
function checkOpts(b, base, accounts) {
  const out = { account: base.account, model: base.model, effort: base.effort };
  if (b.account != null) {
    if (typeof b.account !== 'string' || (b.account !== DYNAMIC && !accounts.includes(b.account))) return { err: `account must be one of ${accounts.join(', ')}, or dynamic` };
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
// A Dynamic account's pick for a new conversation: of the accounts here, the one with the most usage left, judged by
// the fuller of its 5-hour and weekly limits (usage: /state's usage, usage-watch.js view), the weekly one breaking a
// tie. An account with no read yet comes after every one with a read; with none read, the default account (else the
// first). Resuming a conversation keeps the account it ran on. The same pick as switching accounts (account-switch.js)
const roomiest = (accounts, usage, def = NEW_BOT.account) => SWITCH.roomiest(accounts, usage, def);
// Long context (Henry, 2026-10-12): a bot keeps its whole chat with Henry in context. It never hands off at 200k
// (~/.claude/hooks/session-length.py leaves sessions in ~/Bots alone), and runs on a model's 1M-context version:
// opus and sonnet have one ('claude-sonnet-5-5' -> 'claude-sonnet-5-5[1m]'); any other model is left as it is
const longModel = (m) => (typeof m === 'string' && /^(?:claude-)?(?:opus|sonnet)(?:-[\w.-]*)?$/i.test(m) ? `${m}[1m]` : m);
// what a session of the bot starts on: its model (its 1M-context version) and effort, a dynamic one's base (DYNAMIC_START)
const runOpts = (bot) => ({ model: longModel(bot.model === DYNAMIC ? DYNAMIC_START.model : bot.model), effort: bot.effort === DYNAMIC ? DYNAMIC_START.effort : bot.effort });
// The same model in the bot's folder's .claude/settings.json, so a resume (which names no model: api.js openBot, the
// host's restore after a restart) runs on it too and its long chat still fits. Only "model" is set; the rest of the
// file is kept. -> true when the file was written
function writeModel(bot) {
  const model = runOpts(bot).model;
  if (typeof model !== 'string' || !model) return false;
  const dir = path.join(bot.folder, '.claude'), file = path.join(dir, 'settings.json');
  let j = {};
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') return false; } // not JSON: left alone
  if (!j || typeof j !== 'object' || Array.isArray(j)) return false;
  if (j.model === model) return false;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...j, model }, null, 2) + '\n');
  return true;
}

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
// a look from checkLook laid on a bot: a value is set, null takes the key away; lookAt is now when that changed it
function applyLook(bot, look, now = Date.now()) {
  const was = `${bot.shape || ''}|${bot.color || ''}`;
  for (const k of ['shape', 'color']) {
    if (!(k in look)) continue;
    if (look[k] === null) delete bot[k];
    else bot[k] = look[k];
  }
  if (`${bot.shape || ''}|${bot.color || ''}` !== was) bot.lookAt = now;
}
// a bot's folder's name, lower case: its key on every machine (sync-prefs.js botLooks, chatOrder's bots:<slug>)
const slugKey = (folder) => path.basename(String(folder)).toLowerCase();
// its look and role as the botLooks group carries them, or null with none: { slug, shape?, color?, role?, at? } (at:
// lookAt, else when it was made)
function lookItem(b) {
  if (!b || (!b.shape && !b.color && !b.role)) return null;
  const at = Number.isFinite(b.lookAt) && b.lookAt > 0 ? b.lookAt : Number.isFinite(b.createdAt) && b.createdAt > 0 ? b.createdAt : 0;
  return { slug: slugKey(b.folder), ...(b.shape ? { shape: b.shape } : {}), ...(b.color ? { color: b.color } : {}), ...(b.role ? { role: b.role } : {}), ...(at ? { at: Math.round(at) } : {}) };
}
// the folder names the bots here own (not a removed one's: another machine's bot of that name may show here)
const ownSlugs = (bots) => new Set((bots || []).filter((b) => b && !b.removed && typeof b.folder === 'string').map((b) => slugKey(b.folder)));
const notOwn = (own) => (x) => !!x && typeof x.slug === 'string' && !own.has(x.slug.toLowerCase());
// The botLooks group as this machine holds it: its own bots' looks, one per bot not removed that has one, made from the
// registry each time (so this machine alone says how its bots look), then others' (another machine's bots, kept in
// fleet-view.js settings.botLooks) for the folders none of its bots owns
const lookItems = (bots, others) => [...(bots || []).filter((b) => b && !b.removed).map(lookItem).filter(Boolean), ...(Array.isArray(others) ? others : []).filter(notOwn(ownSlugs(bots)))];
// the group's items as they come in, less those for a folder a bot here owns (never put in over its registry)
const othersOf = (bots, items) => (Array.isArray(items) ? items : []).filter(notOwn(ownSlugs(bots)));

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
// what bot/BRIEF.md's {{role}} says: the role, or that there is none
const roleLine = (role) => (role ? `Your role: ${role}\n\nHenry set it in your bot profile. In a team, the others see it next to your name, so keep to it.`
  : 'Henry has not given you a role (he sets one in your bot profile): your standing instructions below say what you do.');
// its CLAUDE.md: the template with {{name}}, {{role}} and {{brief}} filled in, in one pass (a brief holding "{{name}}"
// keeps it)
function fillBrief(template, bot) {
  const vals = { name: bot.name, role: roleLine(bot.role), brief: bot.brief || 'None yet.' };
  return String(template).replace(/\{\{(name|role|brief)\}\}/g, (_, k) => vals[k]);
}

// ---------- /state ----------
// each overseer conversation -> its tag: its bot's id (a removed bot's too)
function tagger(bots) {
  const m = new Map();
  for (const b of bots || []) for (const id of (b && b.ids) || []) m.set(id, b.id);
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
// after itself), else the slug. -> [{ id, name, folder, slug (its folder's name, lower case), ids (oldest first), convId
// (the newest), account, at }]
const elsewhereId = (slug) => crypto.createHash('sha1').update(`elsewhere:${String(slug).toLowerCase()}`).digest('hex').slice(0, 12);
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
    return { id: elsewhereId(g.slug),
      name: (typeof top.name === 'string' && top.name.trim()) || g.slug, folder: g.folder, slug: g.slug.toLowerCase(), ids: cs.map((x) => x.id),
      convId: top.id, account: top.account || null, at: top.last || 0 };
  });
}
// one of those as state.bots shows it: it never runs here and has nothing to change here. look: the one its machine
// gave it ({ shape?, color?, role? }: sync-prefs.js botLooks), if any; else the page draws it in its account's colour
// (and its role is '')
const lookRole = (look) => { const r = look && typeof look.role === 'string' ? checkRole(look.role) : null; return r && !r.err ? r.role : ''; };
const elsewhereView = (e, look) => ({ id: e.id, name: e.name, brief: '', role: lookRole(look), account: e.account, model: null, effort: null, folder: e.folder,
  createdAt: e.at, convId: e.convId, ids: [...e.ids], live: false,
  shape: look && SHAPES.includes(look.shape) ? look.shape : null, color: look && typeof look.color === 'string' && COLOR_RE.test(look.color) ? look.color.toLowerCase() : null,
  tasks: [], elsewhere: true, map: null, watches: [] });
// one watch as state.bots shows it: name, the watched conversation's Fleet View name now (nameOf), else null; last,
// the newest watch note it got for it ({ at, what }), else null
function watchView(w, nameOf) {
  let name = null;
  try { const n = nameOf ? nameOf(w.id) : null; if (typeof n === 'string' && n.trim()) name = n; } catch {}
  return { id: w.id, job: w.job, since: w.since, name, last: w.last ? { at: w.last.at, what: w.last.what } : null };
}
// one bot as state.bots and the answers show it; l: its running session from the host's list ({ id }), if any. ids:
// every conversation it went through, oldest first (the Bots tab shows them as one chat: web/chat.js opts.history).
// map: its spot on the map, else null; watches: what it watches (watchView; nameOf(id) -> a conversation's name)
function viewOf(b, l, nameOf) {
  return { id: b.id, name: b.name, brief: b.brief, role: b.role || '', account: b.account, model: b.model, effort: b.effort, folder: b.folder, createdAt: b.createdAt,
    convId: (l && l.id) || b.ids[b.ids.length - 1] || null, ids: [...b.ids], live: !!l, shape: b.shape || null, color: b.color || null,
    map: b.map ? { x: b.map.x, y: b.map.y } : null, watches: (b.watches || []).map((w) => watchView(w, nameOf)) };
}
// state.bots: the bots not removed, newest first (of two made the same millisecond, the later). live: bot id -> its
// running session
const listView = (bots, live, nameOf) => (bots || []).filter((b) => b && !b.removed).reverse().sort((a, b) => b.createdAt - a.createdAt)
  .map((b) => viewOf(b, live && live.get(b.id), nameOf));
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
    const role = checkRole(b.role);
    out.push({ id: b.id, name: b.name, brief: str(b.brief, ''), role: role.err ? '' : role.role, account: str(b.account, FALLBACK.account), model: str(b.model, FALLBACK.model),
      effort: str(b.effort, FALLBACK.effort), folder: b.folder, createdAt: Number.isFinite(b.createdAt) ? b.createdAt : 0, ids,
      told: Array.isArray(b.told) ? [...new Set(b.told.map(convId).filter(Boolean))] : [], ...(b.removed === true ? { removed: true } : {}),
      ...(SHAPES.includes(b.shape) ? { shape: b.shape } : {}), ...(typeof b.color === 'string' && COLOR_RE.test(b.color) ? { color: b.color.toLowerCase() } : {}),
      ...(Number.isFinite(b.lookAt) && b.lookAt > 0 ? { lookAt: Math.round(b.lookAt) } : {}),
      // on the map and watching (a removed bot is neither)
      ...(b.removed !== true && mapPoint(b.map) ? { map: mapPoint(b.map) } : {}), watches: b.removed === true ? [] : readWatches(b.watches),
      // deleted tasks it is still to be told of
      ...(b.removed !== true && readGone(b.gone) ? { gone: readGone(b.gone) } : {}) });
  }
  return out;
}

// ---------- the server's part ----------
// deps: { api (api.js: hostList, deliverText, startBot, openBot, endHosted), ctx (api.js's ctx), saved (settings.bots as
//   saved), save() (the registry changed), log(text), demo, exists(id) -> its log is on disk, turnInfo(id) -> { promptAt }
//   or null, sessionsFile, trustFolder(dir), accounts() -> the account letters, usage() -> /state's usage (a Dynamic
//   account's pick: roomiest), rename(id, name) (its Fleet View name), and for watching: watchFacts(ids) -> [{ id,
//   name, state, lastReply, replyAt, gone, next }] (fleet-view.js botWatchFacts), known(id) -> Fleet View lists it or
//   its log is on disk, nameOf(id) -> its Fleet View name or null,
//   base (the Bots folder) and template (bot/BRIEF.md), which tests set }
function createBots(deps) {
  const d = deps || {};
  const base = d.base || BOTS_DIR, templateFile = d.template || TEMPLATE_FILE;
  const bots = loadBots(d.saved, base);
  let live = new Map(); // bot id -> { id, key, status, pending } of its running session, from the host's list
  const chains = new Map(); // bot id -> its starts and its removal, one after another
  const starting = new Set(); // bots whose start may be typing its prompt: no id note meanwhile
  const tellers = new Map(); // bot id -> overseer.js createTeller
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
  const nameOf = (cid) => { try { return d.nameOf ? d.nameOf(cid) : null; } catch { return null; } };
  const view1 = (b) => viewOf(b, live.get(b.id), nameOf);
  const accounts = () => { try { const a = d.accounts ? d.accounts() : null; if (Array.isArray(a) && a.length) return a; } catch {} return ['A', 'B']; };
  const usageNow = () => { try { return (d.usage && d.usage()) || {}; } catch { return {}; } };
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
      t = OVERSEER.createTeller({ api: d.api, ctx: d.ctx, note: (id) => idNote(bot.name, id, greet.has(id)), told: bot.told, log: (x) => log(`${bot.name}: ${x}`),
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

  // POST /bots, /api/bots { name, brief?, role?, account?, model?, effort?, shape?, color? }: the bot, its folder (trusted for
  // every account) and its CLAUDE.md, then it starts. Made but not started: ok false, with bot
  async function create(b) {
    if (d.demo) return [503, { ok: false, message: 'the demo makes no bots' }];
    b = b && typeof b === 'object' ? b : {};
    const n = checkName(b.name, bots);
    if (n.err) return [400, { ok: false, message: n.err }];
    const br = checkBrief(b.brief);
    if (br.err) return [400, { ok: false, message: br.err }];
    const rl = checkRole(b.role);
    if (rl.err) return [400, { ok: false, message: rl.err }];
    const o = checkOpts(b, NEW_BOT, accounts());
    if (o.err) return [400, { ok: false, message: o.err }];
    const lk = checkLook(b);
    if (lk.err) return [400, { ok: false, message: lk.err }];
    if (bots.filter((x) => !x.removed).length >= BOTS_MAX) return [409, { ok: false, message: `at most ${BOTS_MAX} bots: remove one first` }];
    let id;
    do id = crypto.randomBytes(6).toString('hex'); while (byId(id));
    const folder = pickFolder(base, slugOf(n.name), bots, (p) => fs.existsSync(p));
    if (!folder) return [409, { ok: false, message: `no free folder for ${n.name} in ${base}` }];
    const bot = { id, name: n.name, brief: br.brief, role: rl.role, account: o.account, model: o.model, effort: o.effort, folder, createdAt: Date.now(), ids: [], told: [], watches: [] };
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
    try { writeModel(bot); } catch (e) { log(`could not write ${bot.name}'s .claude/settings.json: ${e.code || e.message}`); }
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
      const account = bot.account === DYNAMIC ? roomiest(accounts(), usageNow()) : bot.account;
      if (bot.account === DYNAMIC) log(`${bot.name}: dynamic account, starting on ${account}`);
      const [code, out] = await d.api.startBot({ repo: bot.folder, account, ...runOpts(bot), prompt: startPrompt(bot.name), name: bot.name, role }, d.ctx);
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

  // POST /bots/:id, /api/bots/:id { name?, brief?, role?, account?, model?, effort?, shape?, color? }: CLAUDE.md is
  // written again (the role is in it too), and a running bot is told once to read it. Account, model and effort take
  // effect in its next new conversation (a resume keeps them); shape and color at once (they are not in CLAUDE.md)
  async function update(id, b) {
    const bot = byId(id);
    if (!bot || bot.removed) return noBot();
    b = b && typeof b === 'object' ? b : {};
    const next = {};
    if ('name' in b) { const n = checkName(b.name, bots, bot.id); if (n.err) return [400, { ok: false, message: n.err }]; next.name = n.name; }
    if ('brief' in b) { const br = checkBrief(b.brief); if (br.err) return [400, { ok: false, message: br.err }]; next.brief = br.brief; }
    if ('role' in b) { const rl = checkRole(b.role); if (rl.err) return [400, { ok: false, message: rl.err }]; next.role = rl.role; }
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
    const reroled = next.role !== undefined && next.role !== (bot.role || '');
    Object.assign(bot, next);
    applyLook(bot, lk);
    if (reroled) bot.lookAt = Date.now(); // its role goes to the other machines with its look (botLooks)
    save();
    try { writeModel(bot); } catch (e) { log(`could not write ${bot.name}'s .claude/settings.json: ${e.code || e.message}`); }
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
      // off the map, and nothing watched any more
      delete bot.map;
      bot.watches = [];
      forgetAll(bot);
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
  // keep: the other tasks are written back exactly as read, not settled (a delete touches nothing else)
  function changeTask(bot, taskId, fn, keep = false) {
    const r = TASKS.readFile(bot.folder);
    if (r.err) return [409, { ok: false, message: `${bot.name}'s ${r.err}` }];
    const t = r.data.tasks.find((x) => x && typeof x === 'object' && x.id === taskId);
    if (!t || !TASKS.readTask(t)) return [404, { ok: false, message: `${bot.name} has no task ${taskId}` }];
    const res = fn(t, r.data);
    if (res === false) return [409, { ok: false, message: 'nothing to change' }];
    if (!keep) TASKS.settle(r.data, Date.now());
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
    // delete: out of the file as it is now (re-read: what the bot just wrote stays), the rest as it was. The scheduler
    // reads the file fresh before each run, so it never fires again; a run already on its way ends on its own (its
    // notes find no task and are dropped). sentFor is kept: a stale rewrite by the bot can't fire its last time again
    if (action === 'delete') {
      const r = done(changeTask(bot, taskId, (t, data) => { data.tasks = data.tasks.filter((x) => x !== t); return true; }, true), 'deleted');
      if (r[0] === 200) tellDeleted(bot, taskId, (r[1].task && r[1].task.title) || '');
      return r;
    }
    return [400, { ok: false, message: 'action must be pause, resume, run or delete' }];
  }

  // ---------- on the map and watching ----------
  const seen = new Map(); // `${bot id}/${conversation id}` -> watchEvent's seen for that watch (memory only: a restart sees afresh)
  const pending = new Map(); // bot id -> { events: [{ id, name, what, key, lastReply, tries }], gone: [{ id, name }] } not yet delivered
  let watching = false, watchWaits = false;
  const seenKey = (bot, cid) => `${bot.id}/${cid}`;
  const watchOf = (bot, cid) => (bot.watches || []).find((w) => w.id === cid) || null;
  const pendOf = (bot) => { let p = pending.get(bot.id); if (!p) { p = { events: [], gone: [] }; pending.set(bot.id, p); } return p; };
  // a watch that stopped or moved: what was seen of it, and its undelivered events, go
  function forget(bot, cid) {
    seen.delete(seenKey(bot, cid));
    const p = pending.get(bot.id);
    if (p) p.events = p.events.filter((e) => e.id !== cid);
  }
  function forgetAll(bot) {
    for (const k of [...seen.keys()]) if (k.startsWith(`${bot.id}/`)) seen.delete(k);
    pending.delete(bot.id);
  }
  // the bot's running conversation, from the host's list, or null (not running, or the desktop app is down)
  async function runningConv(bot) {
    const list = await d.api.hostList();
    const p = (list || []).find((x) => x && x.alive && (x.role === roleOf(bot.id) || bot.ids.includes(convId(x.id))) && convId(x.id));
    return p ? convId(p.id) : null;
  }
  // how a watch note goes in: queued behind a menu, the bot's chat not opened, as Fleet View's own text (a fresh object each time)
  const noteOpts = () => ({ kind: 'message', queue: true, open: false, via: 'server' });
  // the bot may hold the old task list in mind (a running conversation, or its last one resumed) and write a deleted
  // task back with its next edit: it is told. Deletes in a row go into one note (bot.gone, saved: a restart keeps
  // them), sent by watchTick once they stop; the delete's answer does not wait for it
  function tellDeleted(bot, taskId, title) {
    const now = Date.now();
    const g = bot.gone || { tasks: [], first: now, last: now };
    g.tasks = [...g.tasks.filter((t) => t.id !== taskId), { id: taskId, title: OVERSEER.oneLine(title, 200) }].slice(-GONE_MAX);
    if (now - g.last >= GONE_QUIET_MS) g.first = now; // a new burst (the last one waits for the bot to run): it waits its own
    g.last = now;
    bot.gone = g;
    save();
  }
  // bot.gone told, once the burst is over and the bot is running (queued behind what it is doing, its chat not
  // opened). One not running keeps it until it is; a note that did not go in is tried again next pass
  async function deliverGone(bot) {
    const g = bot.gone;
    const now = Date.now();
    if (!g || (now - g.last < GONE_QUIET_MS && now - g.first < GONE_HOLD_MS)) return;
    const to = await runningConv(bot);
    if (!to || bot.gone !== g) return;
    const tasks = [...g.tasks];
    const [dc, dout] = await d.api.deliverText(to, taskGoneNote(tasks), noteOpts(), d.ctx);
    if (dc !== 200 && dc !== 202) { log(`${bot.name}: not told of ${tasks.length} deleted task${tasks.length === 1 ? '' : 's'} yet: ${(dout && dout.message) || `error ${dc}`}`); return; }
    // what was deleted while it went in stays for the next note
    const left = bot.gone ? bot.gone.tasks.filter((t) => !tasks.includes(t)) : [];
    if (left.length) bot.gone = { ...bot.gone, tasks: left };
    else delete bot.gone;
    save();
    log(`${bot.name}: told of ${tasks.length} deleted task${tasks.length === 1 ? '' : 's'} (${tasks.map((t) => t.id).join(', ')})`);
  }

  // POST /bots/:id/map { at: { x, y } | null } (the page only): put it on the map or move it there; null takes it off,
  // and every watch of it stops (the bot is not told of each)
  function setMap(id, b) {
    const bot = byId(id);
    if (!bot || bot.removed) return noBot();
    b = b && typeof b === 'object' ? b : {};
    if (!('at' in b)) return [400, { ok: false, message: 'give at: { x, y }, or null to take it off the map' }];
    const a = checkAt(b.at);
    if (a.err) return [400, { ok: false, message: a.err }];
    if (a.at) {
      const moved = !!bot.map;
      bot.map = a.at;
      save();
      return [200, { ok: true, bot: view1(bot), message: `${moved ? 'moved' : 'put'} ${bot.name} on the map` }];
    }
    const was = !!bot.map, n = bot.watches.length;
    delete bot.map;
    bot.watches = [];
    forgetAll(bot);
    save();
    if (was || n) log(`${bot.name} is off the map${n ? `; its ${n} watch${n === 1 ? '' : 'es'} stopped` : ''}`);
    return [200, { ok: true, bot: view1(bot), message: `took ${bot.name} off the map${n ? ` and stopped its ${n} watch${n === 1 ? '' : 'es'}` : ''}` }];
  }

  // POST /bots/:id/watch { id, job: report | answer | review | null } (the page only, from the map or a conversation's
  // menu; the bot need not be on the map): watch that conversation with that job, change the job, or (null) stop. A
  // bot's own conversation is never watched. The bot is told once, started first for a new watch or
  // job; a stop is told only to a running bot. The answer is ok even when the note did not go in (message says so)
  async function setWatch(id, b) {
    const bot = byId(id);
    if (!bot || bot.removed) return noBot();
    b = b && typeof b === 'object' ? b : {};
    const cid = typeof b.id === 'string' ? convId(b.id) : null;
    if (!cid) return [400, { ok: false, message: 'id must be a conversation id' }];
    const job = b.job;
    if (job !== null && !isJob(job)) return [400, { ok: false, message: `job must be one of ${Object.keys(WATCH_JOBS).join(', ')}, or null to stop watching` }];
    const w = watchOf(bot, cid);
    const name = nameOf(cid);
    if (job === null) {
      if (!w) return [200, { ok: true, bot: view1(bot), message: `${bot.name} was not watching it` }];
      bot.watches = bot.watches.filter((x) => x !== w);
      forget(bot, cid);
      save();
      log(`${bot.name} stopped watching ${cid}`);
      let untold = 'it is not running';
      try {
        const to = await runningConv(bot);
        if (to) {
          const [dc, dout] = await d.api.deliverText(to, watchStopNote(name, cid), noteOpts(), d.ctx);
          untold = dc === 200 || dc === 202 ? null : (dout && dout.message) || `error ${dc}`;
        }
      } catch (e) { untold = (e && e.message) || String(e); }
      return [200, { ok: true, bot: view1(bot), message: `${bot.name} stopped watching it${untold ? `; it was not told (${untold})` : ''}` }];
    }
    if (!w) {
      const ownBot = bots.find((x) => x.ids.includes(cid));
      if (ownBot) return [400, { ok: false, message: `that is ${ownBot.id === bot.id ? `${bot.name}'s own` : `a bot's (${ownBot.name})`} conversation: a bot watches only the fleet's` }];
      let known = true;
      try { known = d.known ? !!d.known(cid) : true; } catch { known = false; }
      if (!known) return [400, { ok: false, message: 'Fleet View does not know that conversation' }];
      if (bot.watches.length >= WATCHES_MAX) return [409, { ok: false, message: `${bot.name} watches ${WATCHES_MAX} conversations already: stop one first` }];
    } else if (w.job === job) return [200, { ok: true, bot: view1(bot), message: `${bot.name} watches it already, with that job` }];
    if (w) w.job = job;
    else { seen.delete(seenKey(bot, cid)); bot.watches = [...bot.watches, { id: cid, job, since: Date.now() }]; }
    save();
    log(`${bot.name} ${w ? 'watches' : 'now watches'} ${cid}: ${job}`);
    const did = w ? `${bot.name} watches it now with the job "${WATCH_JOBS[job].label}"` : `${bot.name} watches it: "${WATCH_JOBS[job].label}"`;
    try {
      const [sc, so] = await start(bot.id);
      const to = sc === 200 && so && so.ok !== false ? so.id : null;
      if (!to) return [200, { ok: true, bot: view1(bot), message: `watching it; ${bot.name} did not start: ${(so && so.message) || `error ${sc}`}` }];
      const [dc, dout] = await d.api.deliverText(to, watchSetNote(name, cid, job), noteOpts(), d.ctx);
      if (dc !== 200 && dc !== 202) return [200, { ok: true, bot: view1(bot), message: `watching it; could not tell ${bot.name}: ${(dout && dout.message) || `error ${dc}`}` }];
    } catch (e) { return [200, { ok: true, bot: view1(bot), message: `watching it; could not tell ${bot.name}: ${(e && e.message) || e}` }]; }
    return [200, { ok: true, bot: view1(bot), message: `${did}; it was told` }];
  }

  // one look at a bot's watches (facts: conversation id -> its fact): a handoff moves a watch to the pickup, one gone
  // from Fleet View ends (the bot is told, if it is running), and what is news for its job waits for delivery
  function lookAtWatches(bot, facts, now) {
    let changed = false;
    for (const w of [...bot.watches]) {
      const f = facts.get(w.id);
      if (!f) continue;
      const next = convId(f.next);
      if (next && next !== w.id) {
        const was = w.id;
        forget(bot, was);
        if (watchOf(bot, next)) bot.watches = bot.watches.filter((x) => x !== w); // it watched the pickup already
        else w.id = next;
        changed = true;
        log(`${bot.name}'s watch on ${was} goes on in ${next} (a handoff)`);
        continue;
      }
      if (f.gone) {
        bot.watches = bot.watches.filter((x) => x !== w);
        forget(bot, w.id);
        pendOf(bot).gone.push({ id: w.id, name: f.name || nameOf(w.id) });
        changed = true;
        log(`${bot.name}'s watch on ${w.id} ended: it is gone from Fleet View`);
        continue;
      }
      const k = seenKey(bot, w.id);
      const r = watchEvent(seen.get(k), f, now);
      seen.set(k, r.seen);
      if (!r.event || !jobWants(w.job, r.event.what)) continue;
      const p = pendOf(bot);
      if (p.events.some((e) => e.id === w.id && e.key === r.event.key)) continue;
      p.events.push({ id: w.id, name: f.name || nameOf(w.id), what: r.event.what, key: r.event.key, lastReply: f.lastReply || null, tries: 0 });
    }
    if (changed) save();
  }
  // what waits for one bot, delivered: the gone notes (to a running bot only, once), then its events in one note,
  // the bot started first when it is not running. A note that did not go in is tried again next pass, WATCH_TRIES
  // times at most per event
  async function deliverWatch(bot) {
    const p = pending.get(bot.id);
    if (!p) return;
    if (p.gone.length) {
      const gone = p.gone;
      p.gone = [];
      const to = await runningConv(bot);
      if (to) for (const g of gone) await d.api.deliverText(to, watchGoneNote(g.name, g.id), noteOpts(), d.ctx);
    }
    // only for watches it still has, as their job is now
    p.events = p.events.filter((e) => { const w = watchOf(bot, e.id); return !!w && jobWants(w.job, e.what); });
    const evs = [...p.events];
    if (evs.length) {
      const text = watchNote(evs.map((e) => ({ ...e, job: watchOf(bot, e.id).job })));
      const [sc, so] = await start(bot.id);
      const to = sc === 200 && so && so.ok !== false ? so.id : null;
      let ok = false, why = '';
      if (!to) why = `${bot.name} did not start (${(so && so.message) || `error ${sc}`})`;
      else {
        const [dc, dout] = await d.api.deliverText(to, text, noteOpts(), d.ctx);
        ok = dc === 200 || dc === 202;
        if (!ok) why = (dout && dout.message) || `error ${dc}`;
      }
      if (ok) {
        const at = Date.now();
        for (const e of evs) { const w = watchOf(bot, e.id); if (w) w.last = { at, what: e.what }; }
        p.events = p.events.filter((e) => !evs.includes(e));
        save();
        log(`${bot.name}: watch note with ${evs.length} update${evs.length === 1 ? '' : 's'} (${evs.map((e) => `${e.id.slice(0, 8)} ${e.what}`).join(', ')})`);
      } else {
        for (const e of evs) e.tries++;
        const dropped = evs.filter((e) => e.tries >= WATCH_TRIES);
        p.events = p.events.filter((e) => !dropped.includes(e));
        log(`${bot.name}: watch note not delivered (${why})${dropped.length ? `; ${dropped.length} update${dropped.length === 1 ? '' : 's'} dropped after ${WATCH_TRIES} tries` : '; tried again next pass'}`);
      }
    }
    if (!p.events.length && !p.gone.length) pending.delete(bot.id);
  }
  // every few seconds (fleet-view.js): each watched conversation looked at (d.watchFacts, read only for the watched
  // ids), and what is news delivered, one bot's after another of its own (firing: never beside one of its scheduled
  // tasks), and the tasks Henry deleted told (deliverGone). Nothing at all while no bot watches anything or has deleted
  // tasks to hear of; with the desktop app down nothing is delivered (it waits). Resolves when every delivery this
  // pass began has ended (the tests wait for that)
  async function watchTick() {
    if (d.demo || watching) return;
    const mine = bots.filter((b) => !b.removed && b.watches.length);
    if (!mine.length && !pending.size && !bots.some((b) => !b.removed && b.gone)) return;
    watching = true;
    const jobs = [];
    try {
      if (mine.length) {
        const now = Date.now();
        const ids = [...new Set(mine.flatMap((b) => b.watches.map((w) => w.id)))];
        let list = [];
        try { list = (d.watchFacts && d.watchFacts(ids)) || []; } catch (e) { log(`watch facts failed: ${(e && e.message) || e}`); }
        const facts = new Map(list.filter((f) => f && convId(f.id)).map((f) => [convId(f.id), f]));
        for (const bot of mine) lookAtWatches(bot, facts, now);
      }
      const due = bots.filter((b) => !b.removed && !firing.has(b.id) && (pending.has(b.id) || b.gone));
      if (!due.length) return;
      if ((await d.api.hostList()) === null) { if (!watchWaits) log(`watch notes wait: ${HOST_DOWN}`); watchWaits = true; return; }
      watchWaits = false;
      for (const bot of due) {
        firing.add(bot.id);
        jobs.push((async () => {
          try { await deliverGone(bot); } catch (e) { log(`${bot.name}: deleted-tasks note failed: ${(e && e.message) || e}`); }
          try { await deliverWatch(bot); } catch (e) { log(`${bot.name}: watch note failed: ${(e && e.message) || e}`); }
          finally { firing.delete(bot.id); }
        })());
      }
    } catch (e) {
      log(`watch failed: ${(e && e.message) || e}`);
    } finally { watching = false; }
    await Promise.all(jobs);
  }

  // bot/BRIEF.md changed since a bot's CLAUDE.md was written (a Fleet View update): written again, and a running bot is
  // told to read it (once; a bot not running reads it when it next starts)
  async function refreshBriefs() {
    let tpl;
    try { tpl = template(); } catch { return; }
    const stale = [];
    for (const b of bots) {
      if (b.removed) continue;
      try { if (writeModel(b)) log(`${b.name} runs on ${runOpts(b).model} (its .claude/settings.json)`); } catch (e) { log(`could not write ${b.name}'s .claude/settings.json: ${e.code || e.message}`); }
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
      // the host's list when sessions.json changed, and every HOST_EVERY_MS while a bot runs or the list
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
    view: () => (d.demo ? [] : listView(bots, live, nameOf).map(withTasks)),
    list: () => [200, { ok: true, bots: d.demo ? [] : listView(bots, live, nameOf).map(withTasks) }],
    // the conversation each bot's row opens (its convId): fleet-view.js keeps these listed however quiet they are
    chatIds: () => (d.demo ? [] : listView(bots, live).map((v) => v.convId).filter(Boolean)),
    // ~/.fleet-view.json's bots
    saveShape: () => bots.map((b) => ({ ...b, ids: [...b.ids], told: [...b.told], ...(b.map ? { map: { ...b.map } } : {}),
      ...(b.gone ? { gone: { ...b.gone, tasks: b.gone.tasks.map((t) => ({ ...t })) } } : {}),
      watches: (b.watches || []).map((w) => ({ ...w, ...(w.last ? { last: { ...w.last } } : {}) })) })),
    create, start, update, remove, look, switchTo, tick,
    // on the map and watching: POST /bots/:id/map and /bots/:id/watch (the page only), and the watcher (fleet-view.js
    // runs it every few seconds)
    setMap, setWatch, watchTick,
    // tasks and routines: the scheduler (fleet-view.js runs it every few seconds), GET and POST /bots/:id/tasks
    schedule, tasks, taskAction,
    // /state's tags
    tagOf: () => tagger(bots),
    // api.js resumable: a bot's conversation (not a removed bot's) may be resumed in its folder, with its role
    vouch: (id) => { const b = bots.find((x) => !x.removed && x.ids.includes(id)); return b ? { role: roleOf(b.id), folder: b.folder } : null; },
    inBots: (p) => inBots(p, base),
    // a conversation's bot's role (not a removed bot's), '' for none or no bot: the team briefs name it (fleet-view.js memberOf)
    roleFor: (cid) => { const b = cid ? bots.find((x) => !x.removed && x.ids.includes(cid)) : null; return (b && b.role) || ''; },
    // another machine's bots, from these conversations (elsewhereBots)
    elsewhere: (convs) => (d.demo ? [] : elsewhereBots(convs, base, bots)),
    // the botLooks group (sync-prefs.js) as this machine holds it, with others (fleet-view.js settings.botLooks); and
    // the items that come in, less the ones a bot here owns (what settings.botLooks keeps)
    lookItems: (others) => (d.demo ? [] : lookItems(bots, others)),
    othersOf: (items) => othersOf(d.demo ? [] : bots, items),
    // for tests
    _state: () => ({ bots, live, starting: [...starting] }),
  };
}

module.exports = { createBots, watchEvent, watchNote, checkAt, readWatches, WATCH_JOBS, WATCH_SETTLE_MS, WATCHES_MAX, WATCH_TRIES, elsewhereBots, elsewhereView, elsewhereId, checkName, checkBrief, checkRole, checkOpts, checkLook, applyLook, lookItem, lookItems, othersOf, slugKey, SHAPES, DYNAMIC, DYNAMIC_START, runOpts, longModel, writeModel, slugOf, pickFolder, inBots, fillBrief, roleLine, tagger, tagState, viewOf, listView, loadBots,
  startPrompt, idNote, roomiest, roleOf, botOfRole, BOTS_DIR, TEMPLATE_FILE, CHANGED_NOTE, IDS_MAX, NAME_MAX, BRIEF_MAX, ROLE_MAX };
