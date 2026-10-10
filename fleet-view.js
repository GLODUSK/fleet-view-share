#!/usr/bin/env node
// fleet-view: a live terminal view of every Claude Code session on this machine,
// what each one is doing right now, how far its plan has got, and how close its work is to production.
// Read-only on the session logs under ~/.claude/projects; PR, check and deploy state comes from the gh CLI.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, spawn, spawnSync } = require('child_process');
const HO = require(path.join(__dirname, 'handoff.js'));
const API = require(path.join(__dirname, 'api.js'));
const CONV = require(path.join(__dirname, 'conversation.js'));
const CMDS = require(path.join(__dirname, 'commands.js'));
const FILES = require(path.join(__dirname, 'files.js'));
const CHANGES = require(path.join(__dirname, 'changes.js'));
const PREVIEW = require(path.join(__dirname, 'preview.js'));
const UPDATER = require(path.join(__dirname, 'updater.js'));
const VERSION = require(path.join(__dirname, 'version.js'));
const CODEGRAPH = require(path.join(__dirname, 'code-index.js'));

// ---------- options ----------
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : def;
};
if (opt('help', false)) {
  console.log(`fleet-view  live view of Claude Code sessions

  --web               (default) serve the view on http://127.0.0.1:PORT and open it in the app window
                      (desktop/ Electron window with acrylic blur once installed, else Edge)
  --tui               the terminal view instead of the app window
  --port <n>          web: port to serve on (default 4777)
  --no-open           web: serve without opening a window
  --window <min>      show sessions active in the last N minutes (default 45)
  --scratch-dir <dir> where "Add workspace… · New scratchpad" makes its folders (default ~/Scratchpads)
  --filter <regex>    only sessions whose title, goal or folder matches
  --root <dir>        one projects folder (default: every account's, ~/.claude/projects and ~/.claude-<x>/projects)
  --title <text>      fixed header text (default: the repo picked in the header menu)
  --repo <name>       start on one workspace (folder name or path); "all" shows every workspace
  --solid             paint a solid background instead of letting the terminal blur show
  --no-github         skip PR, check and deploy lookups
  --install-profile   add the blurred "Fleet View" profile to Windows Terminal
  --install-startup   start Fleet View at sign-in (a "Fleet View" shortcut in the Startup folder)
  --remove-startup    remove that shortcut
  --view cards|map|wall  start in the Cards, Map (graph) or Wall (big tiles) view
  --demo              made-up conversations instead of your real ones, for recordings
  --snapshot          print one frame of the active view and exit
  --version           print Fleet View's version (1.0.12) and exit

  keys: q quit   v/Tab next view   r repo menu (or click the name top left)   / filter
        click a conversation to open it
        Cards: c compact/full cards
        Map:   arrows/hjkl select   +/- zoom   shift+arrows pan   0 recenter   Enter open card   o open convo

  Your last view, zoom, filter, repo and compact settings are kept in ~/.fleet-view.json.`);
  process.exit(0);
}
if (opt('version', false)) {
  const v = VERSION.current();
  console.log(`Fleet View ${VERSION.label(v, 'version unknown')}${v.commit ? ` (${v.commit.slice(0, 7)})` : ''}`);
  process.exit(0);
}
const DEMO = !!opt('demo', false);
// Claude accounts: one letter each. B is the default login in ~/.claude; every other is a folder ~/.claude-<letter>
// (~/.claude-a is A, ~/.claude-c is C, and so on), each with its launcher %APPDATA%\npm\claude-<letter>.cmd.
// A new ~/.claude-<letter> folder is a new account here with no code change (the list is read again every minute).
const acctId = (a) => (typeof a === 'string' && /^[a-z]$/i.test(a) ? a.toUpperCase() : 'B');
const acctDir = (a) => path.join(os.homedir(), acctId(a) === 'B' ? '.claude' : '.claude-' + acctId(a).toLowerCase());
// Two folders signed in to the same login are one account (Henry, 2026-10-10: "b and c are the same account"): the
// later letter is an alias of the first (B first, then A, C, ...). It is not listed, its limits are not read twice,
// and its conversations count as the first's. Its projects folder is still read (acctFolders), so none go missing.
let acctList = null, acctFolderList = ['B'], acctAlias = {}, acctListAt = 0;
const loginOf = (a) => {
  try {
    const o = JSON.parse(fs.readFileSync(a === 'B' ? path.join(os.homedir(), '.claude.json') : path.join(acctDir(a), '.claude.json'), 'utf8')).oauthAccount;
    return (o && (o.accountUuid || o.emailAddress)) || null;
  } catch { return null; }
};
function accountsHere() {
  if (acctList && Date.now() - acctListAt < 60e3) return acctList;
  const out = new Set(['B']);
  try {
    for (const e of fs.readdirSync(os.homedir(), { withFileTypes: true })) {
      const m = /^\.claude-([a-z])$/i.exec(e.name);
      if (!m) continue;
      try { if (fs.statSync(path.join(os.homedir(), e.name)).isDirectory()) out.add(m[1].toUpperCase()); } catch {}
    }
  } catch {}
  acctFolderList = [...out].sort();
  const byLogin = {}, alias = {};
  for (const a of [...acctFolderList].sort((x, y) => (x === 'B' ? -1 : y === 'B' ? 1 : x < y ? -1 : 1))) {
    const login = loginOf(a);
    if (login && byLogin[login]) alias[a] = byLogin[login]; else if (login) byLogin[login] = a;
  }
  acctAlias = alias;
  acctList = acctFolderList.filter((a) => !alias[a]);
  acctListAt = Date.now();
  return acctList;
}
// every account folder, aliases too: where conversation logs and live processes are looked for
const acctFolders = () => (accountsHere(), acctFolderList);
// the account a config folder (or a folder in it) belongs to: ~/.claude-<x> is X (or the account X is an alias of), anything else B
const accountOf = (dir) => { const m = /[\\/]\.claude-([a-z])(?:[\\/]|$)/i.exec(dir || ''); const a = m ? m[1].toUpperCase() : 'B'; return acctAlias[a] || a; };
// Session logs live under every account's config dir; --root picks one folder (its account comes from the folder name).
// B's folder comes first, so a junction shared by several accounts is read once, as B's.
// on some machines ~/.claude-<x>/projects is a junction to ~/.claude/projects: read a folder once
// (then which account a conversation belongs to comes from its running process, see accountsFromProcesses)
// The list is built again when accountsHere changes, so an account logged into while Fleet View runs shows within a minute.
const ROOT_OPT = typeof opt('root', null) === 'string' ? path.resolve(opt('root')) : null;
let rootsFor = null, rootsList = [];
function roots() {
  if (ROOT_OPT) return rootsList.length ? rootsList : (rootsList = [{ dir: ROOT_OPT, account: accountOf(ROOT_OPT) }]);
  const accts = acctFolders(), key = accts.map((a) => a + (acctAlias[a] || '')).join();
  if (key === rootsFor) return rootsList;
  const seen = new Set(), out = [];
  for (const r of [...accts].sort((x, y) => (x === 'B' ? -1 : y === 'B' ? 1 : 0)).map((a) => ({ dir: path.join(acctDir(a), 'projects'), account: acctAlias[a] || a }))) {
    let real = r.dir;
    try { real = fs.realpathSync(real); } catch {}
    if (!seen.has(real.toLowerCase())) { seen.add(real.toLowerCase()); out.push(r); }
  }
  rootsFor = key;
  return (rootsList = out);
}
const rootLabel = () => roots().map((r) => r.dir).join(' + ');
// --web (the default) serves the view to an app window; --tui (and --snapshot / --install-profile) is the terminal view;
// --install-startup / --remove-startup only add or remove the autostart shortcut and leave
const STARTUP_FLAG = opt('install-startup', false) ? 'install' : opt('remove-startup', false) ? 'remove' : null;
const WEB = !opt('tui', false) && !opt('snapshot', false) && !opt('install-profile', false) && !STARTUP_FLAG;
const PORT = Math.max(1, Math.min(65535, Number(opt('port', 4777)) || 4777));
const NO_OPEN = !!opt('no-open', false);
const WINDOW_MS = Number(opt('window', 45)) * 60e3;
const FILTER = opt('filter', null) ? new RegExp(opt('filter'), 'i') : null;
const TITLE = typeof opt('title', null) === 'string' ? opt('title').toUpperCase() : DEMO ? 'ACME' : null;
const SOLID = !!opt('solid', false);
const GITHUB = !opt('no-github', false) && !DEMO;
const VIEWS = ['cards', 'map', 'wall'];
const WEB_ONLY_VIEW = 'projects'; // a view only the page has (web/projects.js)

// settings that survive a restart; flags on the command line win, and the demo never saves
const SETTINGS_FILE = path.join(os.homedir(), '.fleet-view.json');
const OLD_SETTINGS_FILE = path.join(os.homedir(), '.agent-pulse.json'); // from when this was Agent Pulse
let saved = {};
try { saved = JSON.parse(fs.readFileSync(fs.existsSync(SETTINGS_FILE) ? SETTINGS_FILE : OLD_SETTINGS_FILE, 'utf8')) || {}; } catch {}
if (!saved || typeof saved !== 'object' || Array.isArray(saved)) saved = {};
// the page's Projects view is kept for the page; the terminal view starts in Cards instead
let view = VIEWS.includes(opt('view', null)) ? opt('view') : VIEWS.includes(saved.view) || (WEB && saved.view === WEB_ONLY_VIEW) ? saved.view : 'cards';
let query = DEMO ? '' : typeof saved.query === 'string' ? saved.query : ''; // the / filter, matched like --filter
// the repo picked in the header menu (a repo root path, or a bare folder name from --repo), or null for every repo
const repoArg = opt('repo', null);
let repoSel = DEMO ? null : typeof repoArg === 'string' ? (repoArg.toLowerCase() === 'all' ? null : repoArg) : typeof saved.repo === 'string' ? saved.repo : null;
let saveTimer = null;
// the app window's last place and size on screen, { x, y, w, h }, saved by the page
let webBounds = saved.webBounds && ['x', 'y', 'w', 'h'].every((k) => Number.isFinite(saved.webBounds[k])) ? saved.webBounds : null;
// the app window's "recently finished" strip: open (true) or collapsed
let finishedOpen = DEMO || saved.finishedOpen !== false;
// the page's steady mode (on unless turned off)
let steady = saved.steady !== false;
// the mini window: its place and size, and whether it was open
const okBounds = (b, minW, minH) => !!b && typeof b === 'object' && ['x', 'y', 'w', 'h'].every((k) => Number.isFinite(b[k])) && b.w >= minW && b.h >= minH;
const roundBounds = (b) => ({ x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) });
let miniBounds = okBounds(saved.miniBounds, 1, 1) ? roundBounds(saved.miniBounds) : null;
let miniOpen = saved.miniOpen === true;
// conversations hidden from the page's views (right-click, "Hide from map"): [{ id, at }], at most 500.
// The page shows one again when it gets busy after `at`; the server only keeps the list.
const HIDDEN_MAX = 500;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function cleanHidden(list, now = Date.now()) {
  if (!Array.isArray(list)) return null;
  const out = new Map();
  for (const x of list.slice(0, HIDDEN_MAX)) {
    const id = typeof x === 'string' ? x : x && typeof x === 'object' ? x.id : null;
    if (typeof id !== 'string' || !UUID_RE.test(id)) continue;
    const at = x && typeof x === 'object' && Number.isFinite(x.at) && x.at > 0 && x.at <= now + 60e3 ? Math.round(x.at) : now;
    out.set(id.toLowerCase(), { id: id.toLowerCase(), at });
  }
  return [...out.values()];
}
let hidden = cleanHidden(saved.hidden) || [];
// Hidden by the automation API (api.js: stop { remove }, remove, a temp session that ended): id -> when. The page
// keeps its own copy of the hidden list and saves all of it back; one saved in the half minute after the server
// hid something, before the page's /state poll took that up, would put the conversation back. So for that long a
// save that leaves it out keeps it (applySettings).
const apiHidAt = new Map();
const API_HIDE_GUARD_MS = 30e3;
// the API's throwaway sessions (POST /api/sessions { temp: true }): conversation ids, hidden from the map as soon
// as they are stopped or end (sweepTemp), at most 200, kept in settings so a restart doesn't forget them
const API_TEMP_MAX = 200;
let apiTemp = DEMO ? [] : (Array.isArray(saved.apiTemp) ? saved.apiTemp : []).filter((x) => typeof x === 'string' && UUID_RE.test(x)).map((x) => x.toLowerCase()).slice(-API_TEMP_MAX);
// repos removed from the page (the repo menu's ×, Delete or "Remove from list", or "Remove repo" on a repo's
// right-click menu): [{ root, at }], at most 200. /state leaves them out of repos[]; the page leaves them and their
// conversations out of every view. A hidden repo comes back by itself, and leaves the list, once a conversation in
// it has activity after `at` (pruneHiddenRepos).
const HIDDEN_REPOS_MAX = 200;
const rootKey = (r) => String(r || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
function cleanHiddenRepos(list, now = Date.now()) {
  if (!Array.isArray(list)) return null;
  const out = new Map();
  for (const x of list.slice(0, HIDDEN_REPOS_MAX)) {
    const root = typeof x === 'string' ? x : x && typeof x === 'object' ? x.root : null;
    if (typeof root !== 'string' || !root.trim() || root.length > 1024) continue;
    const at = x && typeof x === 'object' && Number.isFinite(x.at) && x.at > 0 && x.at <= now + 60e3 ? Math.round(x.at) : now;
    out.set(rootKey(root), { root, at });
  }
  return [...out.values()];
}
let hiddenRepos = cleanHiddenRepos(saved.hiddenRepos) || [];
// drops the hidden repos that a conversation worked in after they were hidden; true when the list changed
function pruneHiddenRepos(list) {
  if (!hiddenRepos.length) return false;
  const lastIn = new Map();
  // real activity (a prompt or a reply), not the log's time: a resumed claude writes its cost and monitors there
  for (const s of list) if (s.root) { const k = rootKey(s.root); lastIn.set(k, Math.max(lastIn.get(k) || 0, s.actT || 0)); }
  const keep = hiddenRepos.filter((h) => !((lastIn.get(rootKey(h.root)) || 0) > h.at));
  if (keep.length === hiddenRepos.length) return false;
  hiddenRepos = keep;
  saveSettings();
  return true;
}
const repoHidden = (root) => !!root && hiddenRepos.some((h) => rootKey(h.root) === rootKey(root));
// repos added by hand (the page's "Add workspace…", POST /repos/add): [{ root, name, at }], at most 100. /state lists
// them in repos[] even with no conversations, so the page draws them and a new session may start in them.
// Removing one (POST /repos/remove) drops it for good; adding a hidden repo takes it off hiddenRepos.
const ADDED_REPOS_MAX = 100;
// (also /reveal's check: cmd.exe treats these specially, so a path holding one is never passed on)
const UNSAFE_PATH = /["%^&|<>\x00-\x1f]/;
function cleanAddedRepos(list, now = Date.now()) {
  if (!Array.isArray(list)) return null;
  const out = new Map();
  for (const x of list.slice(0, ADDED_REPOS_MAX)) {
    const root = x && typeof x === 'object' ? x.root : null;
    if (typeof root !== 'string' || !root.trim() || root.length > 1024 || UNSAFE_PATH.test(root) || !path.isAbsolute(root)) continue;
    const at = Number.isFinite(x.at) && x.at > 0 && x.at <= now + 60e3 ? Math.round(x.at) : now;
    out.set(rootKey(root), { root, name: path.basename(root) || root, at });
  }
  return [...out.values()];
}
let addedRepos = DEMO ? [] : cleanAddedRepos(saved.addedRepos) || [];
// the map's repo spots (web/map.js): [{ id, x, y, pin }], at most 300
function cleanMapSpots(v) {
  if (!Array.isArray(v)) return null;
  const out = [];
  for (const s of v.slice(0, 300)) {
    if (!s || typeof s.id !== 'string' || !s.id || s.id.length > 1100) continue;
    if (!Number.isFinite(s.x) || !Number.isFinite(s.y) || Math.abs(s.x) > 1e6 || Math.abs(s.y) > 1e6) continue;
    out.push({ id: s.id, x: Math.round(s.x), y: Math.round(s.y), pin: s.pin === true });
  }
  return out;
}
let mapSpots = DEMO ? [] : cleanMapSpots(saved.mapSpots) || [];
// the map's lens (how its orbs are coloured and sized) and its saved views (Shift+1..9 on the map: { x, y, zoom })
const MAP_LENSES = ['state', 'cost', 'account', 'idle', 'context'];
let mapLens = MAP_LENSES.includes(saved.mapLens) ? saved.mapLens : 'state';
function cleanMapViews(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out = {};
  for (const k of ['1', '2', '3', '4', '5', '6', '7', '8', '9']) {
    const x = v[k];
    if (!x || typeof x !== 'object') continue;
    if (![x.x, x.y, x.zoom].every(Number.isFinite) || Math.abs(x.x) > 1e6 || Math.abs(x.y) > 1e6 || x.zoom <= 0 || x.zoom > 64) continue;
    out[k] = { x: Math.round(x.x * 100) / 100, y: Math.round(x.y * 100) / 100, zoom: Math.round(x.zoom * 1000) / 1000 };
  }
  return out;
}
let mapViews = cleanMapViews(saved.mapViews) || {};
// where the map was looking when it last moved: the world point at its top-left corner and its scale ({ x, y, k })
function cleanMapCamera(c) {
  if (!c || typeof c !== 'object' || ![c.x, c.y, c.k].every(Number.isFinite) || Math.abs(c.x) > 1e6 || Math.abs(c.y) > 1e6 || c.k <= 0 || c.k > 64) return null;
  return { x: Math.round(c.x * 10) / 10, y: Math.round(c.y * 10) / 10, k: Math.round(c.k * 1000) / 1000 };
}
let mapCamera = DEMO ? null : cleanMapCamera(saved.mapCamera);
// desktop notifications for new alerts (the page asks; on unless turned off)
let notify = saved.notify !== false;
// accounts turned off (right-click on empty space · Accounts): their conversations, and workspaces only they use,
// leave /state and the terminal view; the page offers no new sessions on them. Running sessions keep running.
const cleanOffAccounts = (v) => (Array.isArray(v) ? [...new Set(v.filter((a) => typeof a === 'string' && /^[A-Z]$/.test(a)))].sort() : null);
let offAccounts = cleanOffAccounts(saved.offAccounts) || [];
const acctOff = (s) => offAccounts.length > 0 && offAccounts.includes(accountFor(s));
// Parity rules: in a repo with one, a change users see is made on the website and in the phone app in the same
// task. Each rule names a repo by its folder name and the path prefixes (relative to the checkout) of its sides:
// web, app (the phone app) and core (code both use). A file matches the first side, in the order app, core, web,
// whose prefix it starts with. Built in: detailforge-web. settings.parity ([{ name, web, app, core }], at most 20)
// adds rules or replaces the built-in one of the same name.
const PARITY_BUILTIN = [{ name: 'detailforge-web', app: ['mobile/'], core: ['packages/core/'], web: ['app/', 'components/', 'src/', 'lib/', 'public/'] }];
function cleanParity(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  const prefixes = (v) => (Array.isArray(v) ? v : []).filter((p) => typeof p === 'string' && p.trim() && p.length <= 200).slice(0, 40)
    .map((p) => p.trim().replace(/\\/g, '/').replace(/^\.?\/+/, '').toLowerCase()).map((p) => (p.endsWith('/') ? p : p + '/'));
  for (const r of list.slice(0, 20)) {
    if (!r || typeof r !== 'object' || typeof r.name !== 'string' || !r.name.trim() || r.name.length > 200) continue;
    const rule = { name: r.name.trim(), web: prefixes(r.web), app: prefixes(r.app), core: prefixes(r.core) };
    if (rule.web.length && rule.app.length) out.push(rule);
  }
  return out;
}
let parityRules = cleanParity(saved.parity) || [];
// Teams: conversations told to work together (the page's "Work together", POST /teams). Each is
// { id, name, color, members: [ids], lead, order, at, messages: [{ t, from, to, text }], successors: [{ from, to, at }],
// seenAt }: lead is the member that directs the others (null: they are peers; the conversation that carries on
// for a lead that hands off leads in its place), messages are the last 50 between members (through `fv send --from`
// and the API's `from`; an ask's questions and answers too), successors the
// last 10 members that handed off (or ran /clear) and were swapped for the conversation that carries on, seenAt the
// last time a member was in the session list. At most 50 teams of up to 12 members, saved with the rest; a team
// whose members have all been gone for 24 hours is dropped (pruneTeams).
const TEAMS_MAX = 50, TEAM_MEMBERS_MAX = 12, TEAM_MSGS_MAX = 50, TEAM_GONE_MS = 24 * 3600e3;
const TEAM_COLORS = ['#ff9f43', '#3fd8ff', '#3dffa8', '#a47bff', '#ff4d8d', '#ffc24a', '#4d9bff', '#7cf06a', '#ff6a2b', '#e58bff'];
const MEMBER_RE = /^[\w.-]{1,80}$/;
function cleanTeams(list, now = Date.now()) {
  if (!Array.isArray(list)) return null;
  const out = [], taken = new Set();
  for (const x of list.slice(-TEAMS_MAX)) {
    if (!x || typeof x !== 'object' || typeof x.id !== 'string' || !/^t[0-9a-f]{6,16}$/.test(x.id)) continue;
    const members = [...new Set((Array.isArray(x.members) ? x.members : []).filter((m) => typeof m === 'string' && MEMBER_RE.test(m)).map((m) => m.toLowerCase()))].filter((m) => !taken.has(m)).slice(0, TEAM_MEMBERS_MAX);
    if (members.length < 2) continue;
    members.forEach((m) => taken.add(m));
    const at = Number.isFinite(x.at) && x.at > 0 && x.at <= now + 60e3 ? Math.round(x.at) : now;
    const msgs = (Array.isArray(x.messages) ? x.messages : []).filter((m) => m && Number.isFinite(m.t) && typeof m.from === 'string' && typeof m.to === 'string' && typeof m.text === 'string')
      .slice(-TEAM_MSGS_MAX).map((m) => ({ t: Math.round(m.t), from: m.from.slice(0, 80), to: m.to.slice(0, 80), text: m.text.slice(0, 300) }));
    const succ = (Array.isArray(x.successors) ? x.successors : []).filter((m) => m && typeof m.from === 'string' && typeof m.to === 'string' && Number.isFinite(m.at))
      .slice(-10).map((m) => ({ from: m.from.slice(0, 80), to: m.to.slice(0, 80), at: Math.round(m.at) }));
    const lead = typeof x.lead === 'string' && members.includes(x.lead.toLowerCase()) ? x.lead.toLowerCase() : null;
    out.push({ id: x.id, name: plainText(x.name, 80) || 'team', color: /^#[0-9a-f]{6}$/i.test(x.color || '') ? x.color : TEAM_COLORS[out.length % TEAM_COLORS.length],
      members, lead, order: typeof x.order === 'string' ? x.order.slice(0, 4000) : '', at, messages: msgs, successors: succ, seenAt: Number.isFinite(x.seenAt) ? Math.round(x.seenAt) : now });
  }
  return out;
}
// (plain is defined with the web helpers further down; this one is for settings read before them)
function plainText(s, n) { s = String(s || '').replace(/\s+/g, ' ').trim(); return n && s.length > n ? s.slice(0, n - 1) + '…' : s; }
let teams = DEMO ? [] : cleanTeams(saved.teams) || [];
// conversations moved to another repo by hand (a conversation's right-click, "Move to workspace", POST /sessions/move):
// [{ id, root, at }], at most 500; root null puts it back in the repo its tool calls point at. The move wins over
// the tool calls, and a conversation picked up from a handoff takes its predecessor's move (movedRootOf).
const MOVED_MAX = 500;
function cleanMoved(list, now = Date.now()) {
  if (!Array.isArray(list)) return null;
  const out = new Map();
  for (const x of list.slice(-MOVED_MAX)) {
    if (!x || typeof x !== 'object' || typeof x.id !== 'string' || !UUID_RE.test(x.id)) continue;
    const root = typeof x.root === 'string' && x.root.length <= 1024 && path.isAbsolute(x.root) && !UNSAFE_PATH.test(x.root) ? x.root : null;
    const at = Number.isFinite(x.at) && x.at > 0 && x.at <= now + 60e3 ? Math.round(x.at) : now;
    out.set(x.id.toLowerCase(), { id: x.id.toLowerCase(), root, at });
  }
  return out;
}
let moved = DEMO ? new Map() : cleanMoved(saved.moved) || new Map();
// conversations renamed in Fleet View (right-click "Rename", the panel's title, POST /rename): settings.names,
// { <id>: '<name>' }, at most 500. The name wins over Claude Code's own title (/rename, then its AI title) everywhere
// a conversation's name shows (baseName). A pickup of a handoff takes its predecessor's name (inheritName); null
// is a name cleared by hand, kept so the pickup doesn't take it again. Names are trimmed, one line, 80 characters.
const NAMES_MAX = 500;
// (plainText's \s already makes line and paragraph separators spaces)
const cleanName = (v) => (typeof v === 'string' ? plainText(v.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')).slice(0, 80).trim() : '');
function cleanNames(o) {
  const out = new Map();
  if (!o || typeof o !== 'object' || Array.isArray(o)) return out;
  for (const [id, v] of Object.entries(o).slice(-NAMES_MAX)) {
    if (!UUID_RE.test(id)) continue;
    const n = v === null ? null : cleanName(v);
    if (n !== '') out.set(id.toLowerCase(), n);
  }
  return out;
}
const names = DEMO ? new Map() : cleanNames(saved.names);
// where a conversation's work goes when it's done (right-click "Push to", POST /push-target): 'production' (the
// standing rule: merge to main and ship) or 'preview' (push the branch for a preview, don't merge). A repo's choice
// is the default for its conversations; a conversation's own choice wins over it, and a pickup of its handoff takes
// it (pushTargetOf). settings.pushTargets: { sessions: [{ id, target, at }], repos: [{ root, target, at }] }.
// The resolved list is written to %LOCALAPPDATA%\fleet-view\push-targets.json, which the push-target hook
// (scripts/push-target-hook.py) reads at every prompt to tell the conversation.
const PUSH_TARGETS = ['production', 'preview'];
function cleanPushTargets(o, now = Date.now()) {
  const out = { sessions: new Map(), repos: new Map() };
  if (!o || typeof o !== 'object') return out;
  const at = (x) => (Number.isFinite(x.at) && x.at > 0 && x.at <= now + 60e3 ? Math.round(x.at) : now);
  for (const x of Array.isArray(o.sessions) ? o.sessions.slice(-MOVED_MAX) : []) {
    if (!x || typeof x.id !== 'string' || !UUID_RE.test(x.id) || !PUSH_TARGETS.includes(x.target)) continue;
    out.sessions.set(x.id.toLowerCase(), { id: x.id.toLowerCase(), target: x.target, at: at(x) });
  }
  for (const x of Array.isArray(o.repos) ? o.repos.slice(-200) : []) {
    if (!x || typeof x.root !== 'string' || x.root.length > 1024 || !path.isAbsolute(x.root) || UNSAFE_PATH.test(x.root) || !PUSH_TARGETS.includes(x.target)) continue;
    out.repos.set(rootKey(x.root), { root: x.root, target: x.target, at: at(x) });
  }
  return out;
}
const pushTargets = DEMO ? cleanPushTargets(null) : cleanPushTargets(saved.pushTargets);
const PUSH_FILE = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'fleet-view', 'push-targets.json');
let pushFileText = null;
// the conversation's own choice, or the one the conversation it picked up from had (following handoffs back, like
// movedRootOf; a pickup keeps its own copy). null: it follows its repo
function pushTargetOf(s) {
  if (s.demo) return null;
  const own = pushTargets.sessions.get(s.id);
  if (own) return own.target;
  const seen = new Set([s.id]);
  for (let x = s, i = 0; i < 8; i++) {
    const from = handoffOf(x, Date.now()).pickedUpFrom;
    if (!from || seen.has(from.id)) return null;
    seen.add(from.id);
    const m = pushTargets.sessions.get(from.id);
    if (m) {
      pushTargets.sessions.set(s.id, { id: s.id, target: m.target, at: Date.now() });
      saveSettings();
      return m.target;
    }
    x = sessions.get(from.id) || { id: from.id };
  }
  return null;
}
const repoPushTarget = (root) => (root && pushTargets.repos.get(rootKey(root))?.target) || null;
// POST /push-target { id, target } or { root, target }: target 'production', 'preview' or null (a conversation
// back to its repo's choice; a repo back to production). Returns [code, json].
function setPushTarget(b) {
  const target = b.target == null || b.target === '' ? null : b.target;
  if (target !== null && !PUSH_TARGETS.includes(target)) return [400, { ok: false, message: 'target is production or preview' }];
  if (typeof b.id === 'string' && b.id) {
    if (!UUID_RE.test(b.id)) return [400, { ok: false, message: 'no conversation given' }];
    const id = b.id.toLowerCase();
    pushTargets.sessions.delete(id);
    if (target) pushTargets.sessions.set(id, { id, target, at: Date.now() });
    while (pushTargets.sessions.size > MOVED_MAX) pushTargets.sessions.delete(pushTargets.sessions.keys().next().value);
  } else {
    const root = b.root;
    if (typeof root !== 'string' || root.length > 1024 || UNSAFE_PATH.test(root) || !path.isAbsolute(root)) return [400, { ok: false, message: 'give the full path of the workspace' }];
    const g = gitInfo(path.join(root, '_'));
    let r = g ? g.root : path.resolve(root);
    if (r.length > 3) r = r.replace(/[\/]+$/, '');
    pushTargets.repos.delete(rootKey(r));
    // production is the default, so a repo set back to it is just dropped
    if (target === 'preview') pushTargets.repos.set(rootKey(r), { root: r, target, at: Date.now() });
  }
  saveSettings();
  writePushFile();
  return [200, { ok: true, target }];
}
// the hook's copy: { sessions: { <id>: target }, repos: { <root key>: target } }, sessions with handoff picks resolved
function writePushFile() {
  if (DEMO || opt('snapshot', false)) return;
  const out = { sessions: {}, repos: {} };
  for (const s of sessions.values()) { const t = s.demo ? null : pushTargetOf(s); if (t) out.sessions[s.id] = t; }
  for (const x of pushTargets.sessions.values()) out.sessions[x.id] = x.target;
  for (const [k, x] of pushTargets.repos) out.repos[k] = x.target;
  const text = JSON.stringify(out, null, 1);
  if (text === pushFileText) return;
  try { fs.mkdirSync(path.dirname(PUSH_FILE), { recursive: true }); fs.writeFileSync(PUSH_FILE, text); pushFileText = text; } catch (e) { logOnce('pushfile', `could not save ${PUSH_FILE}: ${e.message}`); }
}
// what the map showed, kept across restarts (closing Fleet View used to forget the repos and conversations):
//   sessions: [{ id, at }]  every unfinished conversation /state listed, at its last sight. At the next start they
//             are read again whatever their age, and they stay listed while they were active in the last day
//             (REMEMBER_MS) instead of leaving 45 minutes after they went quiet. One leaves when it finishes,
//             is removed, or hands off.
//   repos:    [{ root, at }]  every repo /state listed; listed again at the next start, with or without
//             conversations, until removed (hiddenRepos) or unseen for 30 days
const REMEMBER_MS = 24 * 3600e3, REMEMBER_REPO_MS = 30 * 24 * 3600e3;
const remembered = { sessions: new Map(), repos: new Map() };
if (!DEMO && saved.remembered && typeof saved.remembered === 'object') {
  const now = Date.now();
  for (const x of Array.isArray(saved.remembered.sessions) ? saved.remembered.sessions.slice(-300) : []) {
    if (x && typeof x.id === 'string' && UUID_RE.test(x.id) && Number.isFinite(x.at) && now - x.at < REMEMBER_MS * 7) remembered.sessions.set(x.id.toLowerCase(), Math.round(x.at));
  }
  for (const x of Array.isArray(saved.remembered.repos) ? saved.remembered.repos.slice(-100) : []) {
    if (x && typeof x.root === 'string' && x.root.length <= 1024 && path.isAbsolute(x.root) && Number.isFinite(x.at) && now - x.at < REMEMBER_REPO_MS) remembered.repos.set(x.root, Math.round(x.at));
  }
}
let rememberedSavedAt = 0;
// a folder the page asks to add: absolute, an existing directory, no character cmd.exe treats specially; a folder
// inside a git repo is stored as that repo's root (worktrees as their main repo, like conversations' repos),
// any other folder as it is. Returns [code, json].
function addRepo(p) {
  if (typeof p !== 'string' || !p.trim() || p.length > 1000) return [400, { ok: false, message: 'no folder given' }];
  // a pasted path may come quoted ("…" or '…', Explorer's "Copy as path") and with forward slashes
  p = p.trim().replace(/^(["'])(.*)\1$/, '$2').trim().replace(/\//g, path.sep);
  if (UNSAFE_PATH.test(p)) return [400, { ok: false, message: 'that path has characters Fleet View will not pass on' }];
  if (!path.isAbsolute(p) || (process.platform === 'win32' && !/^([a-zA-Z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(p))) return [400, { ok: false, message: 'give the full path of the folder (like C:\\Users\\you\\projects\\my-app)' }];
  const dir = path.resolve(p);
  let st = null;
  try { st = fs.statSync(dir); } catch {}
  if (!st) return [400, { ok: false, message: `there is no folder at ${dir}` }];
  if (!st.isDirectory()) return [400, { ok: false, message: `${dir} is a file, not a folder` }];
  const g = gitInfo(path.join(dir, '_'));
  let root = g ? g.root : dir;
  if (root.length > 3) root = root.replace(/[\\/]+$/, '');
  if (UNSAFE_PATH.test(root)) return [400, { ok: false, message: 'that path has characters Fleet View will not pass on' }];
  const k = rootKey(root);
  const had = addedRepos.find((r) => rootKey(r.root) === k);
  const wasHidden = repoHidden(root);
  if (!had) {
    addedRepos.push({ root, name: repoName(root), at: Date.now() });
    if (addedRepos.length > ADDED_REPOS_MAX) addedRepos.splice(0, addedRepos.length - ADDED_REPOS_MAX);
  }
  if (wasHidden) hiddenRepos = hiddenRepos.filter((h) => rootKey(h.root) !== k);
  saveSettings();
  if (g && !DEMO) CODEGRAPH.want(g.top, g.root);
  const r = had || addedRepos[addedRepos.length - 1];
  return [200, { ok: true, repo: { root: r.root, name: r.name, color: toHex(familyColor(r.root)) }, git: !!g, already: !!had, unhidden: wasHidden }];
}
// "New scratchpad" (POST /repos/scratch): a new empty folder under SCRATCH_DIR, scratch-YYYY-MM-DD (then -2, -3…),
// added like any other folder. Returns [code, json] as addRepo does, with the folder made in repo.root.
const SCRATCH_DIR = path.resolve(typeof opt('scratch-dir') === 'string' ? opt('scratch-dir') : path.join(os.homedir(), 'Scratchpads'));
function addScratchRepo() {
  try { fs.mkdirSync(SCRATCH_DIR, { recursive: true }); } catch (e) { return [500, { ok: false, message: `could not make ${SCRATCH_DIR}: ${e.code || e.message}` }]; }
  const d = new Date(), day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  for (let n = 1; n <= 999; n++) {
    const dir = path.join(SCRATCH_DIR, n === 1 ? `scratch-${day}` : `scratch-${day}-${n}`);
    try { fs.mkdirSync(dir); } catch (e) { if (e.code === 'EEXIST') continue; return [500, { ok: false, message: `could not make ${dir}: ${e.code || e.message}` }]; }
    trustFolder(dir);
    return addRepo(dir);
  }
  return [500, { ok: false, message: `${SCRATCH_DIR} already has 999 scratchpads for today` }];
}
// Files dropped on the page's main view (POST /repos/scratch { paths }): a new scratchpad as above, with each file
// copied into it (a name taken already gets " (2)", " (3)"…). A folder is not copied: it stays where it is and comes
// back in dirs. -> [code, json] with copied: [{ name, from }], dirs: [path], failed: [{ path, message }]
const DROP_MAX = 20;
async function addScratchWith(paths) {
  if (!Array.isArray(paths) || !paths.length || paths.length > DROP_MAX) return [400, { ok: false, message: `paths must be 1 to ${DROP_MAX} file paths` }];
  if (!paths.every((p) => typeof p === 'string' && p.length <= 1024 && path.isAbsolute(p))) return [400, { ok: false, message: 'every path must be an absolute path' }];
  const kinds = paths.map((p) => { try { return fs.statSync(p); } catch { return null; } });
  if (!kinds.some(Boolean)) return [404, { ok: false, message: paths.length === 1 ? `not found: ${paths[0]}` : 'none of those files is there' }];
  const [code, out] = addScratchRepo();
  if (!out.ok) return [code, out];
  const dir = out.repo.root, copied = [], dirs = [], failed = [], taken = new Set();
  for (let i = 0; i < paths.length; i++) {
    const p = paths[i], st = kinds[i];
    if (!st) { failed.push({ path: p, message: 'not found' }); continue; }
    if (st.isDirectory()) { dirs.push(p); continue; }
    const ext = path.extname(p), stem = path.basename(p, ext);
    let name = path.basename(p);
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${stem} (${n})${ext}`;
    taken.add(name.toLowerCase());
    try { await fs.promises.copyFile(p, path.join(dir, name)); copied.push({ name, from: p }); } catch (e) { failed.push({ path: p, message: e.code || e.message }); }
  }
  return [200, { ...out, copied, dirs, failed }];
}
// Marks a folder Fleet View just made as trusted in each account's Claude Code config (~/.claude.json, and
// ~/.claude-<x>/.claude.json for the others), as answering "Do you trust the files in this folder?" with Yes does.
// Without it a new scratchpad opens on that question (unless a parent folder, like the home folder, is trusted),
// and the panel's prompt can't reach Claude. A config that is missing or unreadable is left alone.
function trustFolder(dir) {
  const key = path.resolve(dir).replace(/\\/g, '/');
  for (const f of accountsHere().map((a) => (a === 'B' ? path.join(os.homedir(), '.claude.json') : path.join(acctDir(a), '.claude.json')))) {
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (!j || typeof j !== 'object') continue;
      const projects = j.projects && typeof j.projects === 'object' ? j.projects : (j.projects = {});
      if (projects[key]?.hasTrustDialogAccepted === true) continue;
      projects[key] = { ...(projects[key] || {}), hasTrustDialogAccepted: true };
      const tmp = `${f}.fv-${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(j, null, 2));
      try { fs.renameSync(tmp, f); } catch { fs.writeFileSync(f, JSON.stringify(j, null, 2)); try { fs.unlinkSync(tmp); } catch {} }
    } catch (e) { if (e.code !== 'ENOENT') logOnce('trust:' + f, `could not mark ${dir} trusted in ${f}: ${e.code || e.message}`); }
  }
}
function removeAddedRepo(root) {
  if (typeof root !== 'string' || !root) return [400, { ok: false, message: 'no folder given' }];
  const k = rootKey(root), n = addedRepos.length;
  addedRepos = addedRepos.filter((r) => rootKey(r.root) !== k);
  if (addedRepos.length !== n) saveSettings();
  return [200, { ok: true, removed: addedRepos.length !== n }];
}
function saveSettings() {
  if (DEMO || opt('snapshot', false)) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSettings, 400);
}
function flushSettings() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  // keys this version doesn't know (written by a newer page or the desktop window) are kept as they were
  const out = { ...saved, view, zoom: map.zoom, query, repo: repoSel, compact, finishedOpen, steady, miniOpen, hidden, hiddenRepos, addedRepos, mapSpots,
    mapLens, mapViews, mapCamera, notify, offAccounts, teams, apiTemp,
    moved: [...moved.values()],
    names: Object.fromEntries(names),
    pushTargets: { sessions: [...pushTargets.sessions.values()], repos: [...pushTargets.repos.values()] },
    remembered: { sessions: [...remembered.sessions].map(([id, at]) => ({ id, at })), repos: [...remembered.repos].map(([root, at]) => ({ root, at })) } };
  if (webBounds) out.webBounds = webBounds; else delete out.webBounds;
  if (miniBounds) out.miniBounds = miniBounds; else delete out.miniBounds;
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(out, null, 2)); } catch (e) { logOnce('settings', `could not save ${SETTINGS_FILE}: ${e.message}`); }
}

// ---------- server log ----------
// %LOCALAPPDATA%\fleet-view\server.log: start and stop lines, crashes with their stack, server errors and why it
// restarted. Small on purpose: nothing per request. At 2 MB it moves to server.log.1 (replacing the older one).
const LOG_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'fleet-view');
const LOG_FILE = path.join(LOG_DIR, 'server.log');
const LOG_MAX = 2 << 20;
const errorText = (e) => (e && e.stack) || String(e);
function logLine(text) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    try { if (fs.statSync(LOG_FILE).size >= LOG_MAX) fs.renameSync(LOG_FILE, LOG_FILE + '.1'); } catch {}
    const d = new Date(), p = (n, w = 2) => String(n).padStart(w, '0');
    const at = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
    fs.appendFileSync(LOG_FILE, `${at} [node ${process.pid}] ${String(text).replace(/\r?\n/g, '\n    ')}\n`);
  } catch {}
}
// an error that can repeat every poll is written once a minute at most, with how many were left out
const logSeen = new Map(); // key -> { at, skipped }
function logOnce(key, text) {
  const now = Date.now(), seen = logSeen.get(key);
  if (seen && now - seen.at < 60e3) { seen.skipped++; return; }
  logLine(seen && seen.skipped ? `${text}\n(${seen.skipped} more like it in the last minute)` : text);
  // keys carry the error's message, so a long run can collect many: forget the ones older than a minute
  if (logSeen.size > 200) for (const [k, v] of logSeen) if (now - v.at >= 60e3) logSeen.delete(k);
  logSeen.set(key, { at: now, skipped: 0 });
}

// ---------- palette ----------
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const C = {
  bg: hex('#0a0c13'), line: hex('#262c42'),
  text: hex('#eef0fa'), dim: hex('#7a82a3'), faint: hex('#434a66'),
  ember: hex('#ff6a2b'), gold: hex('#ffc24a'), rose: hex('#ff4d8d'),
  violet: hex('#a47bff'), cyan: hex('#3fd8ff'), mint: hex('#3dffa8'), red: hex('#ff4d5e'),
};
const WHITE = [255, 255, 255];
const GRAD = [C.ember, C.gold, C.rose, C.violet, C.cyan, C.ember];
const mix = (a, b, t) => [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t));
const grad = (stops, t) => {
  t = ((t % 1) + 1) % 1;
  const s = t * (stops.length - 1), i = Math.floor(s);
  return mix(stops[i], stops[Math.min(i + 1, stops.length - 1)], s - i);
};
const scale = (c, k) => c.map((v) => Math.max(0, Math.min(255, Math.round(v * k))));
const fgc = (c) => `\x1b[38;2;${c[0]};${c[1]};${c[2]}m`;
const bgc = (c) => `\x1b[48;2;${c[0]};${c[1]};${c[2]}m`;
const hueOf = (s) => {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return grad([C.ember, C.gold, C.mint, C.cyan, C.violet, C.rose, C.ember], (h % 997) / 997);
};
const hashOf = (s) => { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; };
function hsl(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r, g, b].map((v) => Math.round((v + m) * 255));
}
// colour families: each repo gets one base hue, and its conversations are close shades of it,
// so clusters read at a glance (ember, gold, mint, cyan, violet, rose, then the in-betweens)
const FAMILIES = [22, 44, 152, 192, 262, 330, 8, 212, 120, 288];
const familyBase = (root) => FAMILIES[hashOf(String(root || '').toLowerCase()) % FAMILIES.length];
const familyColor = (root, light = 0.68) => hsl(familyBase(root), 0.9, light);
const shadeOf = (root, id) => { const k = hashOf(id); return hsl(familyBase(root) + ((k % 5) - 2) * 9, 0.82 + (k % 3) * 0.06, 0.6 + ((k >> 3) % 4) * 0.035); };

// A line is a list of segments [text, color, bold?]. Rendering clips to width and pads the rest.
// Cells keep the terminal's default background, which is the one Windows Terminal blurs with acrylic.
const BASE = SOLID ? bgc(C.bg) : '\x1b[49m';
const seg = (text, color = C.text, bold = false) => [String(text), color, bold];
const segLen = (segs) => segs.reduce((n, s) => n + [...s[0]].length, 0);
function renderLine(segs, width) {
  let out = BASE, used = 0;
  for (const [text, color, bold] of segs) {
    if (used >= width) break;
    const chars = [...text].slice(0, width - used);
    out += (bold ? '\x1b[1m' : '') + fgc(color) + chars.join('') + (bold ? '\x1b[22m' : '');
    used += chars.length;
  }
  return out + ' '.repeat(Math.max(0, width - used));
}
const lr = (left, right, width) => [...left, seg(' '.repeat(Math.max(1, width - segLen(left) - segLen(right)))), ...right];
const clean = (s, n) => {
  s = String(s || '').replace(/[\r\n\t]+/g, ' ').replace(/[^\x20-\x7E -ɏ‐-‧]/g, '').replace(/\s+/g, ' ').trim();
  return n && s.length > n ? s.slice(0, n - 1) + '…' : s;
};
const ago = (ms) => (ms < 60e3 ? `${Math.max(0, Math.round(ms / 1e3))}s` : ms < 3600e3 ? `${Math.round(ms / 60e3)}m` : `${(ms / 3600e3).toFixed(1)}h`);

// ---------- tailing jsonl files ----------
const tails = new Map(); // file -> { off, skip, rest }
function readNew(file, initialTail) {
  let size;
  try { size = fs.statSync(file).size; } catch { return []; }
  let st = tails.get(file);
  if (!st) { st = { off: Math.max(0, size - initialTail), skip: size > initialTail, rest: Buffer.alloc(0) }; tails.set(file, st); }
  if (size < st.off) { st.off = 0; st.rest = Buffer.alloc(0); }
  if (size === st.off) return [];
  const len = Math.min(size - st.off, 16 << 20);
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buf, 0, len, st.off); } finally { fs.closeSync(fd); }
  st.off += len;
  const all = Buffer.concat([st.rest, buf]);
  const cut = all.lastIndexOf(0x0a);
  if (cut < 0) { st.rest = all; return []; }
  st.rest = all.subarray(cut + 1);
  const lines = all.subarray(0, cut).toString('utf8').split('\n');
  if (st.skip) { lines.shift(); st.skip = false; }
  const out = [];
  for (const l of lines) {
    let d; try { d = JSON.parse(l); } catch { continue; }
    if (d && typeof d === 'object' && !Array.isArray(d)) out.push({ d, raw: l }); // a "null" or "3" line is no record
  }
  return out;
}
const mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
const ls = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
// the model a new conversation starts on: `model` in its account's settings.json (null when unset), read at most every 10 s
const defModels = new Map(); // config folder -> { at, model }
function defaultModelOf(projRoot) {
  const dir = projRoot ? path.dirname(projRoot) : path.join(os.homedir(), '.claude');
  let c = defModels.get(dir);
  if (!c || Date.now() - c.at > 10e3) {
    const m = (readJson(path.join(dir, 'settings.json')) || {}).model;
    defModels.set(dir, c = { at: Date.now(), model: typeof m === 'string' && m.trim() ? m.trim() : null });
  }
  return c.model;
}

// ---------- model ----------
const sessions = new Map(); // id -> session
const feed = []; // { t, sid, who, verb, what, to? } (to: a team message's receiver)
const alerts = []; // { n, t, s, text, color, kind, fail? }

function describeTool(name, input = {}) {
  const short = name.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '');
  switch (name) {
    case 'Bash': case 'PowerShell': return [name === 'Bash' ? 'shell' : 'pwsh', input.description || input.command];
    case 'Read': case 'Write': case 'Edit': case 'NotebookEdit': return [name.toLowerCase(), path.basename(String(input.file_path || input.notebook_path || ''))];
    case 'Grep': case 'Glob': return ['search', input.pattern];
    case 'Workflow': return ['plan', 'launching workflow'];
    case 'Agent': return ['agent', input.description];
    case 'Skill': return ['skill', input.skill];
    case 'AskUserQuestion': return ['ask', 'question for you'];
    case 'WebFetch': case 'WebSearch': return ['web', input.url || input.query];
    default: return [short.slice(0, 12).toLowerCase(), ''];
  }
}

const sparkQueue = []; // fresh tool calls, drawn as sparks in the Map view
let feedLive = false; // set after the first poll, so history from the initial tail doesn't spark

// file: the absolute path a read or edit touched, so the page can open it
function pushEvent(s, t, who, verb, what, file = null) {
  s.events.push(t);
  const e = { t, sid: s.id, who, verb, what: clean(what, 120) };
  if (!s.lastAction || t >= s.lastAction.t) s.lastAction = e;
  // the conversation's own recent calls, for the app window's detail panel (main and agents mixed, by time)
  s.calls.push({ t, who, verb, what: e.what, file });
  if (s.calls.length > 90) { s.calls.sort((a, b) => a.t - b.t); s.calls.splice(0, s.calls.length - 60); }
  feed.push(e);
  tlEvent(e);
  if (feedLive && Date.now() - t < 15e3) { sparkQueue.push(e); if (sparkQueue.length > 80) sparkQueue.shift(); }
}

// ---------- repos and files a session touches ----------
// A path's repo is the main checkout above it; a worktree's .git file points back to it.
const gitCache = new Map(); // dir -> { root, top } | null
// true when the branch HEAD names has a commit (a loose ref or a packed one), or HEAD is detached
function hasCommits(gd) {
  try {
    const head = fs.readFileSync(path.join(gd, 'HEAD'), 'utf8').trim();
    const ref = /^ref:\s*(.+)$/.exec(head)?.[1];
    if (!ref) return /^[0-9a-f]{40}/.test(head);
    if (fs.existsSync(path.join(gd, ref))) return true;
    try { return fs.readFileSync(path.join(gd, 'packed-refs'), 'utf8').includes(` ${ref}`); } catch { return false; }
  } catch { return true; } // unreadable: keep treating it as a repo, as before
}
function gitInfo(file) {
  let dir = path.dirname(file);
  const seen = [];
  let found = null;
  for (let i = 0; i < 24; i++) {
    if (gitCache.has(dir)) { found = gitCache.get(dir); break; }
    seen.push(dir);
    let st = null;
    try { st = fs.statSync(path.join(dir, '.git')); } catch {}
    // a .git with no commits (a stray `git init`, like one at the root of Z:\) is not a repo: files
    // beside a real repo would otherwise all land in it and show up as a repo called "Z:"
    if (st && st.isDirectory() && !hasCommits(path.join(dir, '.git'))) st = null;
    if (st) {
      let root = dir;
      if (st.isFile()) {
        try {
          const gd = path.resolve(dir, (/gitdir:\s*(.+)/.exec(fs.readFileSync(path.join(dir, '.git'), 'utf8')) || [])[1].trim());
          const k = gd.toLowerCase().lastIndexOf(`${path.sep}.git${path.sep}worktrees${path.sep}`);
          if (k > 0) root = gd.slice(0, k);
        } catch {}
      }
      found = { root, top: dir };
      break;
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  for (const d of seen) gitCache.set(d, found);
  return found;
}
const winPath = (p) => (path.sep === '\\' && /^\/[a-zA-Z](\/|$)/.test(p) ? `${p[1].toUpperCase()}:\\${p.slice(3)}` : p);

// the absolute path a Read, Write, Edit or NotebookEdit call names, else null
const toolFile = (c) => {
  const p = /^(Read|Write|Edit|NotebookEdit)$/.test(c.name) ? c.input?.file_path || c.input?.notebook_path : null;
  return p ? path.resolve(winPath(String(p))) : null;
};

function vote(s, root, t, top) {
  if (!root) return;
  s.repoVotes.push({ root, t, top: top || root });
  if (s.repoVotes.length > 400) s.repoVotes.shift();
}

function noteFile(s, t, p, wrote) {
  if (!p) return;
  const abs = path.resolve(winPath(String(p)));
  const g = gitInfo(abs);
  // the same file in two worktrees of one repo is the same file for collision purposes
  const rel = g ? path.relative(g.top, abs).replace(/\\/g, '/') : abs.replace(/\\/g, '/');
  const key = (g ? g.root + '|' : '') + rel.toLowerCase();
  const f = s.files.get(key) || { key, rel, root: g?.root, t: 0, wrote: false };
  if (t >= f.t) f.abs = abs; // the copy it touched last (two worktrees of one repo share a key)
  f.t = Math.max(f.t, t);
  f.wrote = f.wrote || wrote;
  s.files.set(key, f);
  vote(s, g?.root, t, g?.top);
  // the parity sides it touched, kept for as long as the conversation is (files[] forgets after the window)
  const rule = g && parityRule(g.root);
  const side = rule && sideOfPath(rule, rel);
  if (side) {
    if (!s.paritySeen) s.paritySeen = new Map();
    const k = rootKey(g.root), p = s.paritySeen.get(k) || { wrote: {}, touched: {} };
    p.touched[side] = true;
    if (wrote) p.wrote[side] = true;
    s.paritySeen.set(k, p);
  }
}

// the repos the first three absolute paths in a shell command point into ({ root, top } each)
function commandRepos(cmd) {
  const out = [];
  let n = 0;
  for (const m of String(cmd || '').matchAll(/(?:\b[A-Za-z]:[\\/]|(?<![\w.~])\/[a-zA-Z]\/)[^\s"'`;|&<>()]*/g)) {
    const g = gitInfo(path.join(path.resolve(winPath(m[0])), '_'));
    if (g) out.push(g);
    if (++n >= 3) break;
  }
  return out;
}
function noteCommand(s, t, input) {
  const cmd = String(input?.command || '');
  if (/\bgit\s+push\b/.test(cmd) && t > (s.pushedAt || 0)) s.pushedAt = t;
  for (const g of commandRepos(cmd)) vote(s, g.root, t, g.top);
}

function noteTool(s, t, c) {
  if (c.name === 'Bash' || c.name === 'PowerShell') { noteCommand(s, t, c.input); noteEas(s, t, c); }
  else if (c.name === 'Read' || c.name === 'Write' || c.name === 'Edit' || c.name === 'NotebookEdit') noteFile(s, t, c.input?.file_path || c.input?.notebook_path, c.name !== 'Read');
}

// ---------- the phone app's ship step: eas update / build / submit ----------
// A shell call that runs `eas update`, `eas build` or `eas submit` (Expo's CLI, which ships the phone app) is
// followed from its tool call to its result: s.eas is the latest one, { id, kind, state, at, platforms, auto }.
// state: 'running' until its result comes in, then 'ok' or 'fail' (the result's is_error, which a non-zero exit
// sets). A call sent to the background stays 'running' until its task notification says how it ended.
// kind: 'submit' for `eas build --auto-submit` too. platforms: --platform/-p, 'all' for an update without one.
// (eas, eas-cli, eas-cli@latest, eas.cmd; not build:list, update:list and the like)
const EAS_RE = /\beas(?:-cli)?(?:@[\w.^~-]+)?(?:\.cmd)?\s+(update|build|submit)(?![:\w-])([^\n;&|]*)/i;
function noteEas(s, t, c) {
  const m = EAS_RE.exec(String(c.input?.command || ''));
  if (!m) return;
  if (s.eas && s.eas.at > t) return; // an older record read after a newer one
  const args = m[2] || '';
  const p = /(?:--platform|-p)[\s=]+(all|ios|android)\b/i.exec(args);
  const auto = m[1].toLowerCase() === 'build' && /--auto-submit\b/i.test(args);
  const kind = auto ? 'submit' : m[1].toLowerCase();
  s.eas = { id: c.id || null, kind, state: 'running', at: t, platforms: p ? p[1].toLowerCase() : kind === 'update' ? 'all' : null, bg: null };
}
// a tool result (main log or an agent's): ends the eas call it answers
function noteResult(s, t, b) {
  const e = s.eas;
  if (!e || !e.id || b.tool_use_id !== e.id || e.state !== 'running' || e.bg) return;
  const text = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((x) => (x && x.type === 'text' ? x.text : '')).join('\n') : '';
  const bg = /running in background with ID:\s*(\w+)/i.exec(text);
  if (bg && !b.is_error) { e.bg = bg[1]; return; }
  e.state = b.is_error ? 'fail' : 'ok';
  e.endAt = t;
}
// a background eas call ended (its task notification): how
function easBackground(s) {
  const e = s.eas;
  if (!e || !e.bg || e.state !== 'running') return;
  const st = s.finished.get(e.bg);
  if (st) { e.state = st === 'completed' ? 'ok' : 'fail'; e.endAt = Date.now(); }
}
// { step: 'ok' | 'pending' | 'fail' | 'none', app: { kind, state, at, platforms } | null }; step null when the
// conversation neither wrote phone-app files nor ran eas
function appShipOf(s) {
  const side = sideOf(s, s.root);
  const e = s.eas;
  if (!e && !(side && side.app)) return null;
  if (!e) return { step: 'none', app: null };
  // a build that finished is not in the stores yet: pending until a submit (or an update) follows
  const step = e.state === 'running' ? 'pending' : e.state === 'fail' ? 'fail' : e.kind === 'build' ? 'pending' : 'ok';
  return { step, app: { kind: e.kind, state: step, at: Math.round(e.endAt || e.at), platforms: e.platforms } };
}

// ---------- parity: which side of a parity repo (web, phone app, shared core) a conversation wrote ----------
function parityRule(root) {
  if (!root) return null;
  const name = repoName(root).toLowerCase();
  return parityRules.find((r) => r.name.toLowerCase() === name) || PARITY_BUILTIN.find((r) => r.name === name) || null;
}
// the side a checkout-relative path is on, or null
function sideOfPath(rule, rel) {
  const p = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
  for (const k of ['app', 'core', 'web']) if (rule[k].some((x) => p.startsWith(x))) return k;
  return null;
}
// { web, app, core } for what it wrote in its repo (true when it wrote a file on that side), plus touched: the same
// for any file it read or wrote (running eas counts as touching the app); null when its repo has no parity rule.
// From every file it touched since Fleet View started reading it (paritySeen) and the files it still lists.
function sideOf(s, root) {
  const rule = parityRule(root);
  if (!rule) return null;
  const out = { web: false, app: false, core: false }, touched = { web: false, app: false, core: false, ...(s.eas ? { app: true } : {}) };
  const k = rootKey(root);
  const seen = s.paritySeen && s.paritySeen.get(k);
  if (seen) { Object.assign(touched, seen.touched); Object.assign(out, seen.wrote); }
  for (const f of s.files.values()) {
    if (!f.root || rootKey(f.root) !== k) continue;
    const side = sideOfPath(rule, f.rel);
    if (!side) continue;
    touched[side] = true;
    if (f.wrote) out[side] = true;
  }
  Object.defineProperty(out, 'touched', { value: touched, enumerable: false });
  return out;
}

// Claude Code's folder name under projects\ for a launch folder (Z:\Github\fleet-view -> z--github-fleet-view)
const projDirKey = (dir) => String(dir).replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
// the workspace a conversation was started in: the repo of its launch folder (its log's projects\ folder names it),
// or that folder when it is a workspace added by hand (a scratchpad). null when started outside any (the home folder)
function homeRootOf(s) {
  if (!s.homeCwd) return null;
  const g = gitInfo(path.join(s.homeCwd, '_'));
  if (g) return g.root;
  const k = rootKey(s.homeCwd);
  const a = addedRepos.find((r) => rootKey(r.root) === k);
  return a ? a.root : null;
}

// the repo a session works in: the one it was moved to, else the one it was started in, else the one its recent
// tool calls point at most, else its folder. Reading or editing another repo (a teammate's, after "Work together")
// does not move it: only "Move to workspace" does
function repoOf(s, now) {
  const mv = movedRootOf(s);
  if (mv) return mv;
  const home = homeRootOf(s);
  if (home) return home;
  const count = new Map();
  // a finished conversation counts the hour before its turn ended, so it keeps its repo while the
  // "recently finished" strip shows it (3 hours), instead of falling back to its folder after an hour
  const ref = s.state === 'DONE' && s.turnEndT ? Math.min(now, s.turnEndT) : now;
  for (const v of s.repoVotes) if (ref - v.t < 60 * 60e3) count.set(v.root, (count.get(v.root) || 0) + 1);
  let best = null, n = 0;
  for (const [r, c] of count) if (c > n) { best = r; n = c; }
  if (best) return best;
  // a conversation picked up from a handoff starts in the launcher's folder (usually the home folder),
  // not the repo: until its own tool calls say otherwise it works where the one it took over worked
  const prev = pickupRepo(s);
  if (prev) return prev;
  const g = s.cwd && gitInfo(path.join(s.cwd, '_'));
  return g ? g.root : s.cwd || null;
}

// the repo of the conversation s picked up from: the one its tool calls pointed at most, with no time
// limit (it may have ended hours ago), following earlier handoffs back while one has none
function pickupRepo(s) {
  const seen = new Set([s.id]);
  for (let x = s, i = 0; i < 8; i++) {
    const from = handoffOf(x, Date.now()).pickedUpFrom;
    x = from && !seen.has(from.id) ? sessions.get(from.id) : null;
    if (!x) return null;
    seen.add(x.id);
    const count = new Map();
    for (const v of x.repoVotes) count.set(v.root, (count.get(v.root) || 0) + 1);
    let best = null, n = 0;
    for (const [r, c] of count) if (c > n) { best = r; n = c; }
    if (best) return best;
  }
  return null;
}

// the repo s was moved to by hand, or the one the conversation it picked up from was moved to (following
// handoffs back); a pickup that takes a move keeps its own copy, so it outlives the handoff file. null: not moved
function movedRootOf(s) {
  if (s.demo) return null;
  const own = moved.get(s.id);
  if (own) return own.root;
  const seen = new Set([s.id]);
  for (let x = s, i = 0; i < 8; i++) {
    const from = handoffOf(x, Date.now()).pickedUpFrom;
    if (!from || seen.has(from.id)) return null;
    seen.add(from.id);
    const m = moved.get(from.id);
    if (m) {
      if (!m.root) return null;
      moved.set(s.id, { id: s.id, root: m.root, at: Date.now() });
      saveSettings();
      return m.root;
    }
    x = sessions.get(from.id) || { id: from.id };
  }
  return null;
}
// POST /sessions/move { id, root }: root a folder (stored as its repo's root, like Add workspace) or null (back to
// the repo its tool calls point at). Returns [code, json].
function moveSession(id, root) {
  if (typeof id !== 'string' || !UUID_RE.test(id)) return [400, { ok: false, message: 'no conversation given' }];
  id = id.toLowerCase();
  if (root == null || root === '') {
    moved.set(id, { id, root: null, at: Date.now() });
  } else {
    if (typeof root !== 'string' || root.length > 1024 || UNSAFE_PATH.test(root) || !path.isAbsolute(root)) return [400, { ok: false, message: 'give the full path of the workspace' }];
    const g = gitInfo(path.join(root, '_'));
    let r = g ? g.root : path.resolve(root);
    if (r.length > 3) r = r.replace(/[\\/]+$/, '');
    moved.delete(id); // re-added last, so the cap drops the oldest moves first
    moved.set(id, { id, root: r, at: Date.now() });
    if (repoHidden(r)) hiddenRepos = hiddenRepos.filter((h) => rootKey(h.root) !== rootKey(r));
  }
  while (moved.size > MOVED_MAX) moved.delete(moved.keys().next().value);
  for (const x of sessions.values()) x.hueAt = 0; // its pickups follow it: work every repo out again now
  saveSettings();
  const m = moved.get(id);
  return [200, { ok: true, id, root: m.root, name: m.root ? repoName(m.root) : null }];
}

// a conversation's name before trimming: the one given in Fleet View, else Claude Code's own title (its /rename,
// then its AI title), else '' (the callers fall back to the start of its id)
const baseName = (s) => (s && names.get(s.id)) || (s && (s.custom || s.aiTitle)) || '';
// the shown name of a conversation id, for lists that saved a name when something happened (alerts, ships):
// the current one while Fleet View knows the conversation, else the one given in Fleet View, else what was saved
function nameNow(id, had) {
  const s = sessions.get(id);
  if (s) return plain(baseName(s) || s.name || had || String(id).slice(0, 8), 80);
  return names.get(id) || had;
}
// a pickup of a handoff takes the name its predecessor was given in Fleet View (following handoffs back, like
// movedRootOf), unless it has one of its own; run at each poll while any conversation has a name
function inheritName(s) {
  if (s.demo || names.has(s.id) || ![...names.values()].some(Boolean)) return;
  const seen = new Set([s.id]);
  for (let x = s, i = 0; i < 8; i++) {
    const from = handoffOf(x, Date.now()).pickedUpFrom;
    if (!from || seen.has(from.id)) return;
    seen.add(from.id);
    if (names.has(from.id)) {
      const n = names.get(from.id);
      if (!n) return;
      names.set(s.id, n);
      saveSettings();
      return;
    }
    x = sessions.get(from.id) || { id: from.id };
  }
}
// POST /rename { id, name }: the name the conversation goes by in Fleet View; '' or null clears it (back to Claude
// Code's own title). Returns [code, json] with the name it shows now.
function renameSession(id, name) {
  if (typeof id === 'string' && /^new-/.test(id)) return [409, { ok: false, message: 'a new conversation can be renamed once it has started' }];
  if (typeof id !== 'string' || !(UUID_RE.test(id) || (DEMO && sessions.has(id)))) return [400, { ok: false, message: 'no conversation given' }];
  if (name != null && typeof name !== 'string') return [400, { ok: false, message: 'the name must be text' }];
  id = UUID_RE.test(id) ? id.toLowerCase() : id;
  const n = cleanName(name || '');
  names.delete(id); // re-added last, so the cap drops the oldest names first
  // cleared: null keeps a pickup from taking its predecessor's name again; nothing to keep in the demo
  if (n) names.set(id, n);
  else if (!DEMO) names.set(id, null);
  while (names.size > NAMES_MAX) names.delete(names.keys().next().value);
  const s = sessions.get(id);
  if (s) s.name = clean(baseName(s) || s.id.slice(0, 8), 40);
  saveSettings();
  return [200, { ok: true, id, name: n || null, shown: s ? plain(baseName(s) || s.id.slice(0, 8)) : n || null }];
}

function addPr(s, n, repo, t) {
  if (!n || !repo) return;
  s.prs.set(n, repo);
  if (t >= (s.lastPrT || 0)) { s.lastPr = n; s.lastPrT = t; s.repo = repo; }
}

// pr-link records name every PR a session opened or touched; read the whole log once for them,
// since the live tail only starts a few MB from the end
function scanPrs(s) {
  let text = '';
  try { text = fs.readFileSync(s.file, 'utf8'); } catch { return; }
  for (const m of text.matchAll(/\{"type":"pr-link"[^\n]*/g)) {
    try { const d = JSON.parse(m[0]); addPr(s, d.prNumber, d.prRepository, Date.parse(d.timestamp) || 0); } catch {}
  }
}

// ---------- tokens and cost ----------
// $ per million tokens at Anthropic API list prices (input, output, cache read), cached 2026-09-25.
// Cache writes are 1.25x input for the 5-minute TTL and 2x for 1 hour; fast mode doubles everything.
// It is what the same tokens would cost on the API, not what a Claude plan bills.
const PRICES = {
  'claude-fable-5-1': [10, 50, 0.25], 'claude-mythos-5-1': [10, 50, 0.25], 'claude-fable-5': [10, 50, 1],
  'claude-opus-5-5': [4, 20, 0.2], 'claude-opus-5': [5, 25, 0.5],
  'claude-opus-4-8': [5, 25, 0.5], 'claude-opus-4-7': [5, 25, 0.5], 'claude-opus-4-6': [5, 25, 0.5],
  'claude-sonnet-5-5': [2, 10, 0.2], 'claude-sonnet-5': [2, 10, 0.2], 'claude-sonnet-4-6': [3, 15, 0.3],
  'claude-haiku-4-5': [1, 5, 0.1],
};
const PRICE_KEYS = Object.keys(PRICES).sort((a, b) => b.length - a.length);
const priceOf = (model) => { const k = PRICE_KEYS.find((p) => String(model || '').startsWith(p)); return k ? PRICES[k] : null; };

// A streamed reply is logged once per content block with the same message id, and the
// usage on the last copy is the final one: keep the latest per id and count the difference.
function addUsage(s, msg, at) {
  const u = msg && msg.usage;
  if (!u || !msg.id) return;
  const c5 = u.cache_creation ? u.cache_creation.ephemeral_5m_input_tokens || 0 : u.cache_creation_input_tokens || 0;
  const c1 = u.cache_creation ? u.cache_creation.ephemeral_1h_input_tokens || 0 : 0;
  const inp = u.input_tokens || 0, out = u.output_tokens || 0, rd = u.cache_read_input_tokens || 0;
  const p = priceOf(msg.model), k = u.speed === 'fast' ? 2 : 1;
  const tok = inp + out + rd + c5 + c1;
  const cost = p ? (k * (inp * p[0] + out * p[1] + rd * p[2] + c5 * p[0] * 1.25 + c1 * p[0] * 2)) / 1e6 : 0;
  const old = s.msgUsage.get(msg.id);
  s.tokens += tok - (old ? old[0] : 0);
  s.cost += cost - (old ? old[1] : 0);
  s.msgUsage.set(msg.id, [tok, cost]);
  // forked and resumed conversations copy earlier messages into their own log: each card keeps
  // everything in its log, but the header total counts every message once
  const g = allUsage.get(msg.id);
  spentAll += cost - (g || 0);
  allUsage.set(msg.id, cost);
  // this PC's spend per account at the reply's own time, for telling usage from elsewhere (usage-watch.js)
  if (cost !== (g || 0)) USAGE.addLocal(accountFor(s), Date.parse(at), cost - (g || 0));
}
const allUsage = new Map(); // message id -> cost, across every conversation seen this run
let spentAll = 0;

// Usage is read from the start of every log the conversation owns (its own and all its agents'),
// separately from the live tail, a few MB per poll so a long history doesn't stall the screen.
function scanUsage(s, files, budget) {
  for (const file of files) {
    if (budget.left <= 0) { s.usagePending = true; return; }
    let size;
    try { size = fs.statSync(file).size; } catch { continue; }
    let st = s.usageScan.get(file);
    if (!st) s.usageScan.set(file, (st = { off: 0, rest: '' }));
    if (size < st.off) { st.off = 0; st.rest = ''; }
    if (size === st.off) continue;
    const len = Math.min(size - st.off, budget.left);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, len, st.off); } finally { fs.closeSync(fd); }
    st.off += len;
    budget.left -= len;
    const text = st.rest + buf.toString('utf8');
    const cut = text.lastIndexOf('\n');
    st.rest = cut < 0 ? text : text.slice(cut + 1);
    if (cut < 0) continue;
    for (const line of text.slice(0, cut).split('\n')) {
      if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
      try { const d = JSON.parse(line); if (d.type === 'assistant') addUsage(s, d.message, d.timestamp); } catch {}
    }
    if (st.off < size) { s.usagePending = true; return; }
  }
  s.usagePending = false;
}
const fmtTok = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`);
// plain ASCII with thousands separators: an approximately-equal sign comes from a fallback font and sits oddly
const fmtCost = (c) => '$' + (c >= 100 ? Math.round(c).toLocaleString('en-US') : c.toFixed(2));

// ---------- weekly plan limit ----------
// How much of each account's weekly Claude limit is left, from the endpoint claude's /usage reads, with the
// token claude keeps in <config>/.credentials.json. Read only: an expired token is skipped until claude
// refreshes it (a refresh here would rotate the token out from under claude). A value past its reset is dropped.
// Every 5 minutes; 30 s after a miss (the first read often times out while the logs are still being read).
// Every account here (accountsHere: B in ~/.claude, the others in ~/.claude-<x>); most machines have only B.
// An account with no .credentials.json (an API key, or not logged in) is skipped quietly at the 5-minute pace.
// Each read also goes to usage-watch.js, which compares the climb with what this PC spent to tell when an account is
// being used somewhere else; while something looks off it is read every 2 minutes.
const weekLeft = {}; // account -> { left: 0-100, resets: ms }
const UW = require(path.join(__dirname, 'usage-watch.js'));
const USAGE = UW.createWatch({
  file: DEMO ? null : path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'fleet-view', 'usage-watch.json'),
  alertPct: () => saved.usageAlertPct, alertUsd: () => saved.usageAlertUsd,
});
async function readWeekLeft() {
  let missed = false;
  for (const a of accountsHere()) {
    try {
      // no .credentials.json: an API key login, or not logged in yet. Nothing to read, and nothing wrong
      const cred = path.join(acctDir(a), '.credentials.json');
      if (!fs.existsSync(cred)) continue;
      const o = JSON.parse(fs.readFileSync(cred, 'utf8')).claudeAiOauth;
      if (!o || !o.accessToken || (o.expiresAt && o.expiresAt < Date.now())) { missed = true; continue; }
      const r = await fetch('https://api.anthropic.com/api/oauth/usage', { headers: { Authorization: 'Bearer ' + o.accessToken, 'anthropic-beta': 'oauth-2025-04-20' }, signal: AbortSignal.timeout(20e3) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json(), w = j.seven_day, f = j.five_hour;
      const left = (x) => ({ left: Math.max(0, Math.round(100 - x.utilization)), resets: Date.parse(x.resets_at) || null });
      // five: the 5-hour session limit, which can run out with week left
      if (w && typeof w.utilization === 'number') weekLeft[a] = { ...left(w), five: f && typeof f.utilization === 'number' ? left(f) : null };
      const u = UW.fromEndpoint(j, Date.now());
      if (u) USAGE.read(a, u, { pending: [...sessions.values()].some((x) => x.usagePending) });
    } catch (e) { missed = true; logOnce('week:' + a + ':' + (e && e.message), `weekly limit read for account ${a} failed: ${e && e.message}`); }
  }
  setTimeout(readWeekLeft, missed ? 30e3 : USAGE.suspicious() ? 2 * 60e3 : 5 * 60e3).unref();
}
const onlyListed = (o) => Object.fromEntries(Object.entries(o || {}).filter(([a]) => accountsHere().includes(a)));
const weekNow = (now) =>Object.fromEntries(Object.entries(weekLeft).filter(([, w]) => w && !(w.resets && w.resets < now)));

function ingestMain(s, recs) {
  for (const { d, raw } of recs) {
    if (d.type === 'custom-title' && d.customTitle) s.custom = d.customTitle;
    else if (d.type === 'agent-name' && d.agentName) s.custom = s.custom || d.agentName;
    else if (d.type === 'ai-title' && d.aiTitle) s.aiTitle = d.aiTitle;
    else if (d.type === 'last-prompt' && d.lastPrompt) s.prompt = d.lastPrompt;
    else if (d.type === 'pr-link') addPr(s, d.prNumber, d.prRepository, Date.parse(d.timestamp) || Date.now());
    if (raw.includes('task-notification')) {
      for (const m of raw.matchAll(/<task-id>(\w+)<\/task-id>[\s\S]*?<status>(\w+)<\/status>/g)) { s.finished.set(m[1], m[2]); if (m[2] !== 'running') s.bg.delete(m[1]); }
    }
    noteBackground(s, d);
    // a message typed while it was mid-turn: Claude Code logs it only as this attachment, when it reads it, so this
    // is when it landed (an ask's question to a busy member, api.js). Not a task's notice or another session's message.
    if (d.type === 'attachment' && !d.isSidechain) {
      const a = d.attachment;
      if (a && a.type === 'queued_command' && (!a.commandMode || a.commandMode === 'prompt') && typeof a.prompt === 'string' && a.prompt.trim() && !a.prompt.startsWith('<')) {
        const t = Date.parse(d.timestamp) || Date.now();
        s.prompt = a.prompt; s.promptAt = t; s.turnOpen = true;
        if (t > (s.actT || 0)) s.actT = t;
      }
      continue;
    }
    if (d.isSidechain || (d.type !== 'assistant' && d.type !== 'user')) continue;
    const t = Date.parse(d.timestamp) || Date.now();
    if (t > (s.actT || 0)) s.actT = t; // the last prompt, tool result or reply: real activity, unlike cost records
    if (d.cwd) { s.cwd = d.cwd; if (!s.homeCwd && s.dir && projDirKey(d.cwd) === path.basename(path.dirname(s.dir)).toLowerCase()) s.homeCwd = d.cwd; }
    if (d.gitBranch) s.gitBranch = d.gitBranch === 'HEAD' ? null : d.gitBranch; // the branch of its folder, when no tool call names a checkout
    const content = d.message?.content;
    const blocks = Array.isArray(content) ? content : [];
    if (d.type === 'assistant') {
      // the model and how full its context is, from the latest reply in the main log
      const msg = d.message || {}, u = msg.usage;
      if (msg.model && msg.model !== '<synthetic>') { s.model = msg.model; s.lastAsstT = Math.max(s.lastAsstT || 0, t); }
      if (typeof d.effort === 'string' && d.effort) s.effort = d.effort; // each reply records the effort it ran at
      if (u && typeof u.speed === 'string' && msg.model !== '<synthetic>') s.fast = u.speed === 'fast'; // and whether fast mode was on
      if (u && msg.model !== '<synthetic>') {
        const used = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        if (used > 0) s.ctxUsed = used;
        if (used > 200000) s.ctxBig = true; // a 1M-context model: it stays one after a /compact shrinks the context
      }
      const tools = blocks.filter((c) => c.type === 'tool_use');
      for (const c of tools) {
        const [verb, what] = describeTool(c.name, c.input);
        pushEvent(s, t, 'main', verb, what, toolFile(c));
        noteTool(s, t, c);
        if (BG_TOOLS.test(c.name)) { s.bgUse.set(c.id, { name: c.name, input: c.input || {} }); if (s.bgUse.size > 200) s.bgUse.delete(s.bgUse.keys().next().value); }
        if (c.name === 'AskUserQuestion') {
          s.asking = true;
          s.askAt = t;
          const qs = Array.isArray(c.input?.questions) ? c.input.questions : [];
          s.askText = qs.map((q) => q && q.question).filter(Boolean).join('  ') || c.input?.question || '';
          // the whole question with its choices, for the detail panel
          s.askFull = qs.filter((q) => q && q.question).map((q) => [q.question, ...(Array.isArray(q.options) ? q.options : [])
            .map((o) => (o && typeof o === 'object' ? `  - ${o.label || ''}${o.description ? `: ${o.description}` : ''}` : `  - ${o}`))].join('\n')).join('\n\n') || s.askText;
        }
      }
      // stop_reason says exactly why the model stopped: end_turn hands the turn back to you
      const sr = d.message?.stop_reason;
      const said = blocks.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
      if (said) s.lastSaid = said;
      // the latest reply in full, kept across tool calls; the text blocks of one message are joined
      if (said) {
        if (msg.id && msg.id === s.replyId) { if (!s.lastReply.endsWith(said)) s.lastReply = (s.lastReply + '\n\n' + said).slice(-20000); }
        else s.lastReply = said.slice(0, 20000);
        s.replyId = msg.id || null;
        s.replyAt = t;
      }
      // an API error ends the turn too, but the session is stuck until you retry
      if (d.isApiErrorMessage) { s.turnOpen = false; s.apiError = true; s.errAt = t; }
      else if (tools.length || sr === 'tool_use') s.turnOpen = true;
      else if (sr) { s.turnOpen = false; s.endedOnQuestion = endsOnQuestion(s.lastSaid); s.turnEndT = t; }
    } else if (!d.isMeta) {
      for (const b of blocks) if (b && b.type === 'tool_result') noteResult(s, t, b);
      s.asking = false;
      s.apiError = false;
      s.endedOnQuestion = false;
      s.lastSaid = '';
      const texts = typeof content === 'string' ? [content] : blocks.filter((c) => c.type === 'text').map((c) => c.text);
      if (texts.some((x) => /^\[Request interrupted by user/.test(x))) { s.turnOpen = false; s.turnEndT = t; continue; }
      // a conversation that started from a handoff (`claude "/pickup <file>"`, among its first few messages):
      // the file, for "picked up from"
      if (!s.pickupArg && (s.userMsgs = (s.userMsgs || 0) + 1) <= 3) {
        for (const x of texts) {
          const m = /<command-name>\/?pickup<\/command-name>[\s\S]*?<command-args>([^<]*)<\/command-args>/.exec(x || '') || /^\/pickup\s+(\S[^\n]*)$/.exec(String(x || '').trim());
          if (m) { s.pickupArg = m[1].trim().replace(/^"(.*)"$/, '$1') || null; break; }
        }
      }
      s.turnOpen = true;
      const typed = texts.find((x) => x && !x.startsWith('<'));
      if (typed) { s.prompt = typed; s.promptAt = t; }
    }
  }
}

// A shell started with run_in_background (or sent there with Ctrl+B) or an agent launched async runs on after
// the turn ends, and its <task-notification> starts the next turn: s.bg holds those still running, id -> start
// time, so a turn that ended while one runs is still WORKING, not DONE. Monitors are left out (they watch; the
// session is not busy). Only tasks of the claude running now count: one killed with its claude sends no notice.
// A TaskStop ends its task with no notice, so its own result does. A dev server, bundler or emulator never ends
// by itself: it is kept (it shows in the tooltip) but does not keep the session WORKING.
const BG_MAX_MS = 6 * 3600e3;
const BG_TOOLS = /^(?:Bash|PowerShell|Agent|Task|Workflow|TaskStop)$/;
const BG_SERVER = /\b(?:next\s+(?:dev|start)|expo\s+start|vite(?:\s+(?:dev|preview))?(?:\s|$)|(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:dev|start|serve|preview)\b|http-server|http.server|serve\s+-|webpack\s+serve|nodemon|emulator\s+-avd|storybook\s+dev)/i;
function noteBackground(s, d) {
  const r = d.toolUseResult;
  if (!r || typeof r !== 'object' || d.isSidechain) return;
  const res = Array.isArray(d.message?.content) ? d.message.content.find((b) => b && b.type === 'tool_result') : null;
  const use = res && s.bgUse.get(res.tool_use_id);
  if (use) s.bgUse.delete(res.tool_use_id);
  if (use && use.name === 'TaskStop') { if (!res.is_error) s.bg.delete(String(use.input.task_id || use.input.shell_id || '')); return; }
  const tid = r.backgroundTaskId || (r.status === 'async_launched' ? r.taskId || r.agentId : null);
  if (typeof tid !== 'string' || !tid || s.finished.has(tid)) return;
  const i = use ? use.input : {};
  const cmd = typeof i.command === 'string' ? i.command : '';
  const line = (x) => (typeof x === 'string' ? x.split('\n').map((l) => l.trim()).find(Boolean) || '' : '');
  const label = (use && use.name === 'Workflow' && line(r.summary)) || line(i.description) || cmdLabel(cmd) || line(cmd) || line(i.name) || (use ? use.name : 'task');
  s.bg.set(tid, { t: Date.parse(d.timestamp) || Date.now(), label: plain(label, 80), server: BG_SERVER.test(cmd) });
}
// a shell command with no description, as a label: its first real step (past cd / Set-Location / VAR=), long
// paths cut to their last part, and a polling loop (until / while) as "waiting: <what it checks>"
const BG_SKIP = /^(?:cd|pushd|Set-Location|sl|export|set|source|mkdir|New-Item|true|then|else|fi|done|do|for|echo|Write-Host|Write-Output|sleep|Start-Sleep|cat\s*>)(?:\s|$)|^\$?[\w:]+\s*=|^\}/i;
// split a shell line at && || ; and newlines that are not inside quotes or $( )
function cmdSteps(src) {
  const out = [];
  let cur = '', q = '', depth = 0;
  for (let k = 0; k < src.length; k++) {
    const ch = src[k], two = src.slice(k, k + 2);
    if (q) { if (ch === q) q = ''; cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (two === '$(') { depth++; cur += two; k++; continue; }
    if (ch === ')' && depth) { depth--; cur += ch; continue; }
    if (!depth && (two === '&&' || two === '||')) { out.push(cur); cur = ''; k++; continue; }
    if (!depth && ch === '\n' && /<<-?\s*['"]?\w+/.test(cur)) break; // a heredoc's body is text, not steps
    if (!depth && (ch === ';' || ch === '\n')) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}
function cmdLabel(cmd) {
  const src = String(cmd || '').trim();
  if (!src) return '';
  // until / while / for i in $(seq …) poll something: what they run is what they wait on
  let loop = /\bfor\s+\w+\s+in\s+\$\(seq\b/.test(src);
  let step = '';
  for (let x of cmdSteps(src.replace(/^(?:until|while)\s+true\s*;\s*do\b/i, 'while '))) {
    if (/^(?:until|while)\s/i.test(x)) { loop = true; x = x.replace(/^(?:until|while)\s+(?:!\s*)?/i, ''); }
    x = x.replace(/^[({]+\s*/, '').replace(/^(?:do|then)\s+/i, '').replace(/^foreach\s*\([^)]*\)\s*\{?\s*/i, '');
    const sub = /^\$?[\w:]+\s*=\s*\$\((.+?)\)?$/.exec(x); // o=$(npx eas build:list …) is the command inside
    if (sub) x = sub[1];
    x = x.replace(/^(?:[A-Z_][A-Z0-9_]*=\S+\s+)+(?=\S)/, ''); // CI=1 npx expo start: the command after its env
    if (x && !BG_SKIP.test(x) && !/^#/.test(x)) { step = x; break; }
  }
  if (!step) return '';
  step = step.replace(/^npx\s+(?:-y\s+|--yes\s+)?/, '').replace(/@latest\b/g, '').replace(/\s*(?:\d?>|\||<<).*$/, '')
    .replace(/(["']?)([A-Za-z]:)?[^\s"']*[\\/][^\s"']*\1/g, (p) => {
      const parts = p.replace(/["']/g, '').split(/[\\/]+/).filter(Boolean);
      return parts.length > 2 ? '…/' + parts[parts.length - 1] : p.replace(/["']/g, '');
    });
  return (loop ? 'waiting: ' : '') + step.replace(/\s+/g, ' ').trim();
}
// the tasks the claude running now still has: [{ label, t, server }], oldest first
function bgLiveList(s, lp, now) {
  if (!s.bg.size || !lp) return [];
  const out = [];
  for (const [id, b] of s.bg) {
    if (now - b.t > BG_MAX_MS) s.bg.delete(id);
    else if (b.t >= (lp.startedAt || 0) - 5e3) out.push(b);
  }
  return out;
}

// a reply that closes on a question is waiting on you; anything else is a finished turn.
// The question may sit in the last few lines ("Should I merge?" then "Let me know."),
// carry a short tail ("Merge now? (yes/no)"), or be one sentence of several ("Do you want the 24-hour
// change? Or I can ..."). Code and links are left out first, so "foo?.bar" and "?page=2" are not questions.
const ASKS_RE = /(?:^|[.!:]\s+)(?:want me to|should i|shall i|do you want|would you like|which (?:one|do you)|let me know (?:if|whether|which))\b/i;
function endsOnQuestion(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(-3)
    .map((l) => l.replace(/`[^`]*`/g, '').replace(/\bhttps?:\/\/\S+/g, '').replace(/[*_`\]"'\s]+$/, ''));
  return lines.some((l) => /\?[^?]{0,14}$/.test(l) || /\?(?=[\s)*_"'\]]|$)/.test(l)) || ASKS_RE.test(lines[lines.length - 1] || '');
}

function ingestAgent(s, a, recs) {
  for (const { d } of recs) {
    if (d.type === 'user' && s.eas && Array.isArray(d.message?.content)) {
      for (const b of d.message.content) if (b && b.type === 'tool_result') noteResult(s, Date.parse(d.timestamp) || Date.now(), b);
    }
    if (d.type !== 'assistant') continue;
    const t = Date.parse(d.timestamp) || Date.now();
    for (const c of d.message?.content || []) {
      if (c.type !== 'tool_use') continue;
      const [verb, what] = describeTool(c.name, c.input);
      pushEvent(s, t, a.label, verb, what, toolFile(c));
      noteTool(s, t, c);
    }
  }
}

function loadWorkflow(s, sdir) {
  // every run gets a journal dir as soon as it launches; the summary json only appears when it ends
  const jroot = path.join(sdir, 'subagents', 'workflows');
  const wdir = path.join(sdir, 'workflows');
  let best = null, bestM = 0;
  for (const id of ls(jroot)) {
    if (!id.startsWith('wf_')) continue;
    const m = mtime(path.join(jroot, id, 'journal.jsonl'));
    if (m > bestM) { bestM = m; best = id; }
  }
  if (!best) { s.wf = null; return; }
  const summaryFile = path.join(wdir, best + '.json');
  const summaryM = mtime(summaryFile);
  if (!s.wf || s.wf.runId !== best || (summaryM && !s.wf.summary)) {
    const j = summaryM ? readJson(summaryFile) || {} : {};
    let script = String(j.script || '');
    if (!script) {
      const f = ls(path.join(wdir, 'scripts')).find((x) => x.endsWith(best + '.js'));
      try { script = fs.readFileSync(path.join(wdir, 'scripts', f), 'utf8'); } catch {}
    }
    const pick = (k) => (script.match(new RegExp(k + `\\s*:\\s*(['"\`])((?:\\\\.|(?!\\1).)*)\\1`)) || [])[2] || '';
    const phaseBlock = (script.match(/phases\s*:\s*\[([\s\S]*?)\]/) || [])[1] || '';
    const phases = [...phaseBlock.matchAll(/title\s*:\s*(['"`])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]);
    s.wf = { runId: best, summary: !!summaryM, status: j.status, taskId: j.taskId, name: pick('name') || j.workflowName || best, desc: pick('description') || j.summary || '', phases: phases.length ? phases : ['Run'], jm: -1 };
  }
  const wf = s.wf;
  if (bestM !== wf.jm || !wf.agents) {
    const agents = new Map();
    let text = '';
    try { text = fs.readFileSync(path.join(jroot, best, 'journal.jsonl'), 'utf8'); } catch {}
    for (const l of text.split('\n')) {
      let d; try { d = JSON.parse(l); } catch { continue; }
      if (!d || typeof d !== 'object') continue;
      if (d.type === 'started') agents.set(d.key, { label: d.label || d.agentId, phase: d.phase, state: 'run', agentId: typeof d.agentId === 'string' && /^[\w-]{1,64}$/.test(d.agentId) ? d.agentId : null });
      else if ((d.type === 'result' || d.type === 'failed') && agents.has(d.key)) agents.get(d.key).state = d.type === 'result' ? 'done' : 'fail';
    }
    wf.agents = [...agents.values()];
    wf.dir = path.join(jroot, best);
    wf.fails = wf.agents.filter((a) => a.state === 'fail').length;
    wf.jm = bestM; // only once it is read: a journal that tripped the reader is read again next time
  }
  wf.done = wf.summary ? wf.status || 'completed' : s.finished.get(wf.taskId) || null;
  if (wf.done) for (const a of wf.agents) if (a.state === 'run') a.state = 'fail';
  planProgress(wf); // phases passed plus the share of the current phase's agents done
}

// ---------- GitHub: PR, checks, merge and production deploy ----------
const ships = new Map(); // "owner/repo#123" -> { at, state, checks, merged, live }
const mergedToday = new Map(); // repo -> Set of PR numbers merged since local midnight
let ghBusy = false, ghMergedAt = 0;
const gh = (args) => new Promise((res) => {
  execFile('gh', args, { timeout: 25000, windowsHide: true, maxBuffer: 8 << 20 }, (err, out) => {
    if (err) return res(null);
    try { res(JSON.parse(out)); } catch { res(null); }
  });
});

function evalChecks(rollup) {
  let pending = false;
  for (const c of rollup || []) {
    const v = String(c.conclusion || c.state || '').toUpperCase();
    if (c.status && c.status !== 'COMPLETED') pending = true;
    else if (['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(v)) continue;
    else if (['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', ''].includes(v)) pending = true;
    else return 'fail';
  }
  return pending ? 'pending' : 'ok';
}

async function refreshGithub() {
  if (!GITHUB || ghBusy) return;
  ghBusy = true;
  try {
    const list = [...sessions.values()];
    if (Date.now() - ghMergedAt > 60e3) {
      ghMergedAt = Date.now();
      const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
      const since = new Date(midnight.getTime() - 86400e3).toISOString().slice(0, 10);
      for (const repo of new Set(list.map((s) => s.repo).filter(Boolean))) {
        const r = await gh(['pr', 'list', '-R', repo, '--state', 'merged', '--search', `merged:>=${since}`, '--json', 'number,mergedAt', '--limit', '200']);
        if (Array.isArray(r)) mergedToday.set(repo, new Set(r.filter((p) => Date.parse(p.mergedAt) >= midnight.getTime()).map((p) => p.number)));
      }
    }
    for (const s of list) {
      if (!s.lastPr || !s.repo) continue;
      const key = `${s.repo}#${s.lastPr}`;
      const old = ships.get(key);
      // a finished conversation kept past the window (for the "recently finished" strip) is asked every 2 minutes
      const every = s.state === 'DONE' && !inWindow(s, Date.now()) ? 120e3 : 15e3;
      if (old && (old.live === 'ok' || old.live === 'na' || (old.state === 'CLOSED' && !old.merged) || Date.now() - old.at < every)) continue;
      const pr = await gh(['pr', 'view', String(s.lastPr), '-R', s.repo, '--json', 'state,mergedAt,statusCheckRollup,mergeCommit']);
      if (!pr) continue;
      const sh = { at: Date.now(), state: pr.state, checks: evalChecks(pr.statusCheckRollup), merged: pr.state === 'MERGED', mergedAt: Date.parse(pr.mergedAt) || 0, live: 'none' };
      if (sh.merged && pr.mergeCommit?.oid) sh.sha = String(pr.mergeCommit.oid).toLowerCase();
      // the top bar's deploy watch (below) may already know this merge commit's deploy: no second lookup
      const known = sh.sha ? dpBySha.get(`${String(s.repo).toLowerCase()}@${sh.sha}`) : null;
      if (known) {
        sh.live = known.state === 'live' ? 'ok' : known.state === 'failed' ? 'fail' : 'pending';
        sh.deployUrl = known.url || null;
      } else if (sh.merged && pr.mergeCommit?.oid) {
        const deps = await gh(['api', `repos/${s.repo}/deployments?sha=${pr.mergeCommit.oid}&environment=Production&per_page=1`]);
        if (Array.isArray(deps) && deps.length) {
          const st = await gh(['api', `repos/${s.repo}/deployments/${deps[0].id}/statuses?per_page=1`]);
          const v = Array.isArray(st) && st[0] ? st[0].state : 'pending';
          sh.live = v === 'success' ? 'ok' : v === 'failure' || v === 'error' ? 'fail' : 'pending';
          // where the deploy can be seen: the environment's own address, else the provider's page for it
          const u = Array.isArray(st) && st[0] ? st[0].environment_url || st[0].target_url : null;
          sh.deployUrl = typeof u === 'string' && /^https:\/\//i.test(u) ? u : null;
        } else sh.live = Date.now() - Date.parse(pr.mergedAt) > 30 * 60e3 ? 'na' : 'pending';
      }
      ships.set(key, sh);
    }
  } finally { ghBusy = false; }
}

// ---------- production deploys, for the map's repo hubs ----------
// Vercel (or any host) reports production deploys to GitHub, and the map shows them on the repo's hub: one building now,
// and when it went live (or failed). Every repo on the map with a GitHub remote is watched. Two sources, because
// Vercel's GitHub app writes the deployment record only once a build has finished: the deployments of the
// environment "Production" (their newest status: success is live, failure or error failed, inactive superseded,
// none yet or queued / pending / in_progress building), and the "Vercel" commit status on the default branch's
// newest commit, which says pending while the build runs. A commit's title, PR number and build start are read
// once per commit and kept. A repo is asked every 15 s while a deploy of it builds or a conversation in it pushed
// or merged in the last 10 minutes, else every 60 s; one refresh at a time, in the background like refreshGithub.
// /state deploys: per repo the newest deploy plus any still building, from the last 3 hours (see deploysJson).
const DEPLOY_KEEP_MS = 3 * 3600e3;
const dpRepos = new Map(); // "owner/name" (lower case) -> { slug, root, next, shown: [deploy], logged }
const dpBySha = new Map(); // "owner/name@sha" (lower case) -> the newest deploy known for that commit
const dpStatus = new Map(); // "owner/name#id" -> { state, final, readyAt, url }: a deployment's newest status
const dpCommits = new Map(); // "owner/name@sha" -> { title, pr, startAt }
const dpSeen = new Map(); // "owner/name@sha" -> the state the last look had (for the live / failed alerts)
const alertedShas = new Set(); // "<sha>:live" / "<sha>:fail": the deploy alert for that commit has been raised, by either path
let dpBusy = false, dpRoots = [];
const httpsOnly = (u) => (typeof u === 'string' && /^https:\/\//i.test(u) ? u : null);

// a commit message's title: the first line; a GitHub merge commit ("Merge pull request #N from owner/branch")
// gives its PR number and its second paragraph (else the branch); a squash merge ("Title (#N)") its number
function commitTitle(msg) {
  const text = String(msg || '');
  const first = text.split(/\r?\n/)[0].trim();
  const m = /^Merge pull request #(\d+) from (\S+)/.exec(first);
  if (m) {
    const second = (text.split(/\r?\n\s*\r?\n/)[1] || '').split(/\r?\n/)[0].trim();
    return { title: plain(second || m[2].replace(/^[^/]+\//, ''), 120), pr: +m[1] };
  }
  const sq = /^(.*\S)\s*\(#(\d+)\)$/.exec(first);
  if (sq) return { title: plain(sq[1], 120), pr: +sq[2] };
  return { title: plain(first, 120), pr: null };
}

// the repos to watch: the ones /state listed last (the map's), and any an active conversation works in
function deployTargets(now) {
  const out = new Map();
  const add = (root) => {
    if (!root || repoHidden(root) || isHomeRoot(root)) return;
    const g = githubOf(root);
    const k = g && g.slug.toLowerCase();
    if (k && !out.has(k)) out.set(k, { slug: g.slug, root });
  };
  for (const root of dpRoots) add(root);
  for (const s of sessions.values()) if (s.root && (s.state !== 'DONE' || inWindow(s, now))) add(s.root);
  return out;
}

// fast (every 15 s): a deploy is building, or a conversation in the repo pushed or saw its PR merge in the last 10 minutes
function deployHot(r, now) {
  if (r.shown.some((d) => d.state === 'building')) return true;
  const slug = r.slug.toLowerCase();
  for (const s of sessions.values()) {
    if (s.root && rootKey(s.root) === rootKey(r.root) && now - (s.pushedAt || 0) < 10 * 60e3) return true;
    const sh = s.lastPr && String(s.repo || '').toLowerCase() === slug ? ships.get(`${s.repo}#${s.lastPr}`) : null;
    if (sh && sh.merged && now - (sh.mergedAt || 0) < 10 * 60e3) return true;
  }
  return false;
}

async function refreshDeploys() {
  if (!GITHUB || dpBusy) return;
  dpBusy = true;
  try {
    const targets = deployTargets(Date.now());
    for (const [k, t] of targets) {
      let r = dpRepos.get(k);
      if (!r) dpRepos.set(k, (r = { slug: t.slug, root: t.root, next: 0, shown: [], logged: false }));
      r.root = t.root;
      if (Date.now() < r.next) continue;
      try { await deployRepo(r); } catch (e) { logOnce('deploys:' + (e && e.message), `deploy lookup failed for ${r.slug}\n${errorText(e)}`); }
      r.next = Date.now() + (deployHot(r, Date.now()) ? 15e3 : 60e3);
    }
    for (const k of [...dpRepos.keys()]) if (!targets.has(k)) dpRepos.delete(k);
    // the caches only need the last few hours of commits
    if (dpCommits.size > 600) for (const k of [...dpCommits.keys()].slice(0, 200)) dpCommits.delete(k);
    if (dpStatus.size > 600) for (const k of [...dpStatus.keys()].slice(0, 200)) dpStatus.delete(k);
    if (dpSeen.size > 600) for (const k of [...dpSeen.keys()].slice(0, 200)) dpSeen.delete(k);
    if (alertedShas.size > 600) for (const k of [...alertedShas].slice(0, 200)) alertedShas.delete(k);
  } finally { dpBusy = false; }
}

// one repo: its production deployments, the build running on its default branch, and what it shows
async function deployRepo(r) {
  const slug = r.slug, k = slug.toLowerCase(), now = Date.now();
  const deps = await gh(['api', `repos/${slug}/deployments?environment=Production&per_page=5`]);
  if (!Array.isArray(deps)) {
    // a repo gh can't read (no access, offline): written to the log once, until it works again
    if (!r.logged) { r.logged = true; logLine(`deploys: could not read the production deployments of ${slug} (gh api)`); }
    return;
  }
  r.logged = false;
  // hosted: the repo deploys somewhere at all (a production deployment of any age, or a Vercel status below),
  // so the map can show its hub as clean when nothing is building
  if (deps.length) r.hosted = true;
  const list = [];
  for (const d of deps) {
    const createdAt = Date.parse(d.created_at) || 0;
    if (!d.id || !d.sha || now - createdAt > DEPLOY_KEEP_MS) continue;
    const key = `${k}#${d.id}`;
    let st = dpStatus.get(key);
    if (!st || !st.final) {
      const ss = await gh(['api', `repos/${slug}/deployments/${d.id}/statuses?per_page=1`]);
      if (!Array.isArray(ss)) continue;
      const x = ss[0], v = x && x.state;
      const state = v === 'success' ? 'live' : v === 'failure' || v === 'error' ? 'failed' : v === 'inactive' ? 'inactive' : 'building';
      st = { state, final: state !== 'building', readyAt: state === 'live' || state === 'failed' ? Date.parse(x.created_at) || now : null, url: httpsOnly(x && (x.environment_url || x.target_url)) };
      dpStatus.set(key, st);
    }
    if (st.state === 'inactive') continue; // superseded
    list.push({ id: d.id, sha: String(d.sha).toLowerCase(), createdAt, state: st.state, readyAt: st.readyAt, url: st.url });
  }
  // the build running now: Vercel's commit status on the default branch's newest commit (its deployment
  // record comes only when it is done). Pending is building; failure or error with no deployment is failed
  // (a cancelled build is left out); success shows through the deployment above.
  const head = await gh(['api', `repos/${slug}/commits/HEAD/status`]);
  const hv = head && head.sha && Array.isArray(head.statuses) ? head.statuses.find((x) => /vercel/i.test(String(x.context || ''))) : null;
  const hsha = hv ? String(head.sha).toLowerCase() : null;
  if (hv) r.hosted = true;
  if (hv && !list.some((d) => d.sha === hsha)) {
    const at = Date.parse(hv.created_at) || now;
    const state = hv.state === 'pending' ? 'building' : (hv.state === 'failure' || hv.state === 'error') && !/cancel/i.test(String(hv.description || '')) ? 'failed' : null;
    if (state && now - at < DEPLOY_KEEP_MS) list.push({ id: `c${hsha.slice(0, 12)}`, sha: hsha, createdAt: at, state, readyAt: state === 'failed' ? Date.parse(hv.updated_at || hv.created_at) || now : null, url: httpsOnly(hv.target_url), started: state === 'building' ? at : null });
  }
  // what it shows: every one building, and the newest
  list.sort((a, b) => b.createdAt - a.createdAt);
  const shown = list.filter((d, i) => i === 0 || d.state === 'building');
  for (const d of shown) {
    const info = await commitInfo(slug, d.sha);
    const prevKnown = dpBySha.get(`${k}@${d.sha}`);
    // a build is as old as its start: the first "pending" Vercel status, or when we saw it building
    const start = Math.min(d.createdAt, info?.startAt || Infinity, d.started || Infinity, prevKnown?.createdAt || Infinity);
    Object.assign(d, { createdAt: start, title: info ? info.title : null, pr: info ? info.pr : null });
  }
  r.shown = shown;
  for (const d of shown) noteDeploy(r, d);
}

// a commit's title and PR number, and when its build started (the first Vercel status on it); kept per commit
async function commitInfo(slug, sha) {
  const key = `${slug.toLowerCase()}@${sha}`;
  if (dpCommits.has(key)) return dpCommits.get(key);
  const c = await gh(['api', `repos/${slug}/commits/${sha}`, '--jq', '{ m: .commit.message }']);
  if (!c) return null; // asked again on the next look
  const st = await gh(['api', `repos/${slug}/commits/${sha}/statuses?per_page=100`, '--jq', '[.[] | select(.context | test("vercel"; "i")) | .created_at]']);
  const times = Array.isArray(st) ? st.map((t) => Date.parse(t)).filter(Number.isFinite) : [];
  const info = { ...commitTitle(c.m), startAt: times.length ? Math.min(...times) : null };
  dpCommits.set(key, info);
  return info;
}

// a deploy as seen now: kept by commit (the per-PR ship step reads it), and an alert when one that was building
// went live or failed (not when it is first seen so: a restart does not repeat old news)
function noteDeploy(r, d) {
  const key = `${r.slug.toLowerCase()}@${d.sha}`;
  dpBySha.set(key, d);
  const prev = dpSeen.get(key);
  dpSeen.set(key, d.state);
  if (prev !== 'building' || d.state === 'building') return;
  const tag = d.state === 'live' ? 'live' : 'fail';
  if (alertedShas.has(`${d.sha}:${tag}`)) return; // the PR's own ship alert told it already
  alertedShas.add(`${d.sha}:${tag}`);
  const sid = deploySid(r, d), s = sid && sessions.get(sid);
  const who = s || { id: `deploy:${r.slug}`, name: repoName(r.root) };
  const name = repoName(r.root), what = d.title ? ` (${d.title})` : d.pr ? ` (PR #${d.pr})` : '';
  const extra = { repo: r.slug, pr: d.pr || null };
  if (d.state === 'live') raise(who, `${name} is live on production${what}`, C.mint, 'live', extra);
  else raise(who, `${name} production deploy failed${what}`, C.red, 'deployFail', { ...extra, fail: true });
}

// the conversation behind a deploy: the one whose PR it is (merged into that commit), else one that pushed to
// the repo's main branch in the 10 minutes before the build started
function deploySid(r, d) {
  const slug = r.slug.toLowerCase();
  let best = null, bestT = 0;
  for (const s of sessions.values()) {
    const sh = s.lastPr ? ships.get(`${s.repo}#${s.lastPr}`) : null;
    if (sh && sh.sha === d.sha) return s.id;
    if (d.pr && String(s.prs.get(d.pr) || '').toLowerCase() === slug && (s.lastPrT || 1) > bestT) { best = s.id; bestT = s.lastPrT || 1; }
  }
  if (best) return best;
  for (const s of sessions.values()) {
    if (!s.root || rootKey(s.root) !== rootKey(r.root) || !s.pushedAt || s.pushedAt > d.createdAt + 60e3 || d.createdAt - s.pushedAt > 10 * 60e3) continue;
    const br = s.demo ? s.demo.branch : branchOf(topOf(s, s.root));
    if ((br === 'main' || br === 'master') && s.pushedAt > bestT) { best = s.id; bestT = s.pushedAt; }
  }
  return best;
}

// /state deploys: building first, then newest; at most 3 hours old
function deploysJson(now) {
  const out = [];
  for (const r of dpRepos.values()) {
    for (const d of r.shown) {
      if (now - d.createdAt > DEPLOY_KEEP_MS) continue;
      out.push({ repo: r.slug, root: r.root, name: repoName(r.root), color: toHex(familyColor(r.root)), id: String(d.id), sha: d.sha, title: d.title || null, pr: d.pr || null,
        state: d.state, createdAt: d.createdAt, readyAt: d.readyAt || null, url: httpsOnly(d.url), sid: deploySid(r, d) });
    }
  }
  return out.sort((a, b) => (b.state === 'building') - (a.state === 'building') || b.createdAt - a.createdAt);
}

// /state deployRepos: the roots of the repos that deploy to production (the map marks their hubs: building,
// clean or failed)
function deployReposJson() {
  const out = [];
  for (const r of dpRepos.values()) if (r.hosted) out.push(r.root);
  return out;
}

// push → PR → checks → merged → live, from what the session did and what GitHub says; then → app (the phone app
// reaching the stores, eas update / build / submit) for a conversation that wrote phone-app files or ran eas.
// app: { kind, state, at, platforms } | null, the latest eas call
function shipOf(s) {
  const base = shipBase(s);
  const ap = appShipOf(s);
  if (!ap) return { ...base, app: null };
  const steps = [...base.steps, ['app', ap.step]];
  const value = base.fresh ? base.value : steps.reduce((v, [, st]) => v + (st === 'ok' || st === 'na' ? 1 : st === 'pending' ? 0.5 : 0), 0) / steps.length;
  return { ...base, steps, value, app: ap.app };
}
function shipBase(s) {
  const sh = s.lastPr ? ships.get(`${s.repo}#${s.lastPr}`) : null;
  // a new message, push or plan after the PR merged is a new piece of work: start the track again
  const after = Math.max(s.promptAt || 0, s.pushedAt || 0, s.wf && !s.wf.done ? s.wf.jm : 0);
  if (sh?.merged && after > sh.mergedAt + 60e3) {
    const steps = [['push', (s.pushedAt || 0) > sh.mergedAt + 60e3 ? 'ok' : 'none'], ['PR', 'none'], ['checks', 'none'], ['merged', 'none'], ['live', 'none']];
    return { steps, value: steps[0][1] === 'ok' ? 0.2 : 0, fresh: true };
  }
  const steps = [
    ['push', s.pushedAt || s.lastPr ? 'ok' : 'none'],
    ['PR', !s.lastPr ? 'none' : sh && sh.state === 'CLOSED' && !sh.merged ? 'fail' : 'ok'],
    ['checks', sh ? (sh.merged ? 'ok' : sh.checks) : s.lastPr ? 'pending' : 'none'],
    ['merged', sh?.merged ? 'ok' : 'none'],
    ['live', sh?.merged ? sh.live : 'none'],
  ];
  const value = steps.reduce((v, [, st]) => v + (st === 'ok' || st === 'na' ? 1 : st === 'pending' ? 0.5 : 0), 0) / steps.length;
  return { steps, value };
}

const mergesToday = (s) => { let n = 0; for (const [num, repo] of s.prs) if (mergedToday.get(repo)?.has(num)) n++; return n; };

// ---------- alerts ----------
// Every alert gets a number n that only grows, across restarts too (it starts from the clock), so the page can
// raise a desktop notification for each one once. kind says what happened (see /state alerts in the README).
// The last 50 are kept for /state (alert, alerts); a longer list (24 h, at most 1000) answers /since.
let alertSeq = Date.now();
const alertLog = [];
const ALERT_LOG_MAX = 1000;
function raise(s, text, color, kind, extra = {}) {
  const a = { n: ++alertSeq, t: Date.now(), s: { id: s.id, name: s.name || plain(baseName(s) || '', 80) || String(s.id).slice(0, 8) }, text, color, kind, ...extra };
  alerts.push(a);
  if (alerts.length > 50) alerts.shift();
  alertLog.push(a);
  while (alertLog.length > ALERT_LOG_MAX || (alertLog.length && a.t - alertLog[0].t > 24 * 3600e3)) alertLog.shift();
  // ship events for the timeline: merges, production deploys and failed checks
  const shipKind = { merged: 'merged', live: 'live', deployFail: 'deployFail', checks: 'checksFail' }[kind];
  if (shipKind) tlShip({ t: a.t, kind: shipKind, pr: extra.pr || null, repo: extra.repo || null, sid: s.id, name: a.s.name });
}

const STUCK_AGENT_MS = 20 * 60e3, OVER_LIMIT_EVERY_MS = 30 * 60e3;
function checkAlerts(s, prev) {
  const busy = (x) => x === 'WORKING' || x === 'AGENTS';
  let planAlert = false;
  if (s.ready && s.wf && s.wf.runId === s.seenRun) {
    if (s.wf.done && !s.seenDone) { raise(s, `plan ${s.wf.name} ${s.wf.done === 'completed' ? 'finished' : s.wf.done}`, s.wf.done === 'completed' ? C.mint : C.red, 'plan', s.wf.done === 'completed' ? {} : { fail: true }); planAlert = true; }
    else if (s.wf.fails > s.seenFails) raise(s, 'an agent failed', C.red, 'agentFail', { fail: true });
  }
  if (s.ready && !planAlert && busy(prev)) {
    // a prompt its live claude shows (s.liveWait) alerts like a question; a panel is open, holding its updates back
    if (s.state === 'ASKING') raise(s, !s.liveWait ? 'is asking you a question' : s.liveWait.panel ? 'has a panel open in its terminal, holding back its updates (Esc closes it)' : `waits on you: ${plain(s.liveWait.text, 80)}`, C.gold, 'question');
    else if (s.state === 'QUESTION') raise(s, 'asked you a question', C.gold, 'question');
    else if (s.state === 'ERROR') raise(s, 'hit an API error, retry it', C.red, 'error', { fail: true });
    else if (s.state === 'STALLED') raise(s, s.stoppedIdle ? 'stopped mid-turn; its session is idle (tell it to continue)' : 'quiet for 5 minutes mid-turn (permission prompt?)', C.gold, 'stalled');
    else if (s.state === 'DONE') raise(s, 'finished', C.mint, 'done');
  }
  if (s.wf) { s.seenRun = s.wf.runId; s.seenDone = !!s.wf.done; s.seenFails = s.wf.fails; }
  const key = s.lastPr && `${s.repo}#${s.lastPr}`;
  const sh = key && ships.get(key);
  if (sh) {
    const old = s.shipSeen.get(key);
    s.shipSeen.set(key, { checks: sh.checks, merged: sh.merged, live: sh.live });
    if (old && s.ready) {
      const pr = { pr: s.lastPr, repo: s.repo || null };
      if (sh.checks === 'fail' && old.checks !== 'fail') raise(s, `checks failed on PR #${s.lastPr}`, C.red, 'checks', { ...pr, fail: true });
      if (sh.merged && !old.merged) raise(s, `PR #${s.lastPr} merged`, C.mint, 'merged', pr);
      // once per merge commit: the top bar's deploy watch may have told it already (alertedShas, shared)
      const once = (tag) => { if (!sh.sha) return true; if (alertedShas.has(`${sh.sha}:${tag}`)) return false; alertedShas.add(`${sh.sha}:${tag}`); return true; };
      if (sh.live === 'ok' && old.live !== 'ok' && once('live')) raise(s, `PR #${s.lastPr} is live on production`, C.mint, 'live', pr);
      if (sh.live === 'fail' && old.live !== 'fail' && once('fail')) raise(s, `production deploy failed for PR #${s.lastPr}`, C.red, 'deployFail', { ...pr, fail: true });
    }
  }
  // a plan agent still running with no tool call (its log unchanged) for 20 minutes: once per agent
  if (s.wf && !s.wf.done && s.state !== 'DONE') {
    const now = Date.now();
    if (!s.stuckSeen) s.stuckSeen = new Set();
    for (const a of s.wf.agents) {
      if (a.state !== 'run') continue;
      const key = `${s.wf.runId}:${a.agentId || a.label}`;
      if (s.stuckSeen.has(key)) continue;
      const last = s.demo ? a.lastT || now : a.agentId && s.wf.dir ? mtime(path.join(s.wf.dir, `agent-${a.agentId}.jsonl`)) : 0;
      if (!last || now - last < STUCK_AGENT_MS) continue;
      s.stuckSeen.add(key);
      if (s.ready) raise(s, `agent ${plain(a.label || 'agent', 40)} has made no tool call for ${Math.round((now - last) / 60e3)} minutes`, C.gold, 'stuckAgent', { fail: true });
    }
  }
  // its context is past the handoff size by more than 10 % and no handoff was written: once per 30 minutes, and
  // only while it is mid-turn (the handoff hook runs as it works; one sitting idle past the size would otherwise
  // raise the same alert every 30 minutes until it is closed)
  if ((busy(s.state) || s.state === 'STALLED') && s.ctxUsed && s.ctxUsed > hoLimit * 1.1 && !(s.demo ? s.demo.handedOff : handoffLinks().bySession.has(s.id))) {
    const now = Date.now();
    // over already when Fleet View started: the first alert comes 30 minutes later, if it still has not handed off
    if (!s.ready) s.overAt = s.overAt || now;
    else if (now - (s.overAt || 0) >= OVER_LIMIT_EVERY_MS) { s.overAt = now; raise(s, `context at ${fmtTok(s.ctxUsed)}, past the ${fmtTok(hoLimit)} handoff size with no handoff`, C.gold, 'overLimit'); }
  }
  s.ready = true;
}

// ---------- discovery and polling ----------
// A conversation leaves the list once its log has been quiet for the window (--window), except one that
// finished its turn (DONE): it stays for 3 hours after it ended, so the app window's "recently finished"
// strip and detail panel can show it. Logs older than the window are read once at start; one that turns
// out not to be a finished turn is dropped and not read again until it changes.
const KEEP_DONE_MS = 3 * 3600e3;
const passed = new Map(); // session id -> log mtime when it was dropped
const endedAtOf = (s) => s.turnEndT || s.mtime || 0;
const keepDone = (s, now) => s.state === 'DONE' && now - endedAtOf(s) < KEEP_DONE_MS;
// an unfinished conversation the map showed (remembered): kept while it was active in the last day
const keepRemembered = (s, now) => s.state !== 'DONE' && remembered.sessions.has(s.id) && now - (s.actT || s.mtime || 0) < REMEMBER_MS;
// its live claude waits on you (a prompt, or a panel left open): kept however long its log has been quiet
const liveWaiting = (id) => liveProcs.get(id)?.status === 'waiting';
function dropSession(s) {
  sessions.delete(s.id);
  if (remembered.sessions.delete(s.id)) saveSettings();
  passed.set(s.id, s.mtime);
  // forget the tail offsets, so the conversation is read afresh if it comes back
  tails.delete(s.file);
  for (const f of s.agents.keys()) tails.delete(f);
  for (let i = feed.length - 1; i >= 0; i--) if (feed[i].sid === s.id) feed.splice(i, 1);
}

function discover() {
  const now = Date.now();
  const horizon = Math.max(WINDOW_MS, KEEP_DONE_MS);
  for (const [id, m] of passed) if (now - m > horizon) passed.delete(id);
  // every log in both accounts' projects folders; a conversation moved between accounts (/swap) can have
  // a log in each, and the one written last is the live one
  const found = new Map(); // id -> { file, pdir, m, account, root }
  for (const r of roots()) {
    for (const proj of ls(r.dir)) {
      const pdir = path.join(r.dir, proj);
      for (const f of ls(pdir)) {
        if (!f.endsWith('.jsonl')) continue;
        const file = path.join(pdir, f), m = mtime(file), id = f.slice(0, -6);
        const rem = remembered.sessions.has(id) && now - m < REMEMBER_MS * 7;
        if (!sessions.has(id) && !rem && !liveWaiting(id) && (now - m > horizon || (now - m > WINDOW_MS && passed.get(id) === m))) continue;
        const old = found.get(id);
        if (!old || m > old.m) found.set(id, { file, pdir, m, account: r.account, root: r.dir });
      }
    }
  }
  for (const [id, x] of found) {
    let s = sessions.get(id);
    if (s && s.file !== x.file && x.m > s.mtime) { sessions.delete(id); s = null; } // moved to the other account: read it afresh
    if (!s) {
      s = { id, file: x.file, dir: path.join(x.pdir, id), account: x.account, projRoot: x.root, events: [], calls: [], lastReply: '', prs: new Map(), finished: new Map(), bg: new Map(), bgUse: new Map(), agents: new Map(), shipSeen: new Map(), files: new Map(), repoVotes: [], msgUsage: new Map(), usageScan: new Map(), tokens: 0, cost: 0, shownPlan: 0, shownShip: 0, turnOpen: false, seenFails: 0 };
      const ct = readJson(path.join(s.dir, 'custom-title.json'));
      if (ct?.customTitle) s.custom = ct.customTitle;
      // older than the window: kept only if it is a finished turn, so its PRs are read once that is known
      s.late = now - x.m > WINDOW_MS && !remembered.sessions.has(id) && !liveWaiting(id);
      if (!s.late) scanPrs(s);
      sessions.set(id, s);
    }
    if (s.file === x.file) s.mtime = x.m;
  }
  for (const s of [...sessions.values()]) if (s.state && now - s.mtime > WINDOW_MS && !keepDone(s, now) && !keepRemembered(s, now) && !liveWaiting(s.id)) dropSession(s);
}

function poll() {
  const now = Date.now();
  const budget = { left: 8 << 20 }; // bytes of history read for token counts per poll, across sessions
  for (const s of [...sessions.values()]) {
    // one conversation whose log trips something must not stop the others, or the server
    try { pollOne(s, now, budget); } catch (e) { logOnce('poll:' + (e && e.message), `poll: skipped ${s.id} this round\n${errorText(e)}`); }
  }
  feedLive = true;
  feed.sort((a, b) => a.t - b.t);
  if (feed.length > 400) feed.splice(0, feed.length - 400);
  if (WEB) afterPoll(now);
}
// after every poll (and demo tick): conflict alerts, team upkeep, and a timeline frame when one is due
function afterPoll(now) {
  try { checkConflicts(now); } catch (e) { logOnce('conflicts:' + (e && e.message), `conflicts failed\n${errorText(e)}`); }
  try { pruneTeams(now); } catch (e) { logOnce('teams:' + (e && e.message), `teams failed\n${errorText(e)}`); }
  try { tlTick(now); } catch (e) { logOnce('timeline:' + (e && e.message), `timeline failed\n${errorText(e)}`); }
}
function pollOne(s, now, budget) {
  // a record at a time: a log line that trips the reader is skipped, not the rest of what was read
  const ingest = (fn, recs) => {
    for (const r of recs) {
      try { fn([r]); } catch (e) { logOnce('ingest:' + (e && e.message), `skipped a log line of ${s.id}\n${errorText(e)}`); }
    }
  };
  s.mtime = mtime(s.file);
  ingest((r) => ingestMain(s, r), readNew(s.file, 3 << 20));
  // an old log that doesn't end on a finished turn: drop it before reading its agents and history
  if (s.late && (s.turnOpen || s.asking || s.apiError || s.endedOnQuestion || now - endedAtOf(s) >= KEEP_DONE_MS)) { dropSession(s); return; }
  // subagents: plain Agent calls and workflow agents, tailed while they are fresh
  const sub = path.join(s.dir, 'subagents');
  const files = ls(sub).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(sub, f));
  for (const w of ls(path.join(sub, 'workflows'))) for (const f of ls(path.join(sub, 'workflows', w))) if (f.startsWith('agent-') && f.endsWith('.jsonl')) files.push(path.join(sub, 'workflows', w, f));
  for (const f of files) {
    const m = mtime(f);
    if (now - m > 5 * 60e3 && !s.agents.has(f)) continue;
    let a = s.agents.get(f);
    if (!a) {
      const meta = readJson(f.replace(/\.jsonl$/, '.meta.json')) || {};
      a = { label: clean(meta.description || path.basename(f, '.jsonl'), 28) };
      s.agents.set(f, a);
    }
    a.mtime = m;
    ingest((r) => ingestAgent(s, a, r), readNew(f, 256 << 10));
  }
  scanUsage(s, [s.file, ...files], budget);
  for (const [f, a] of s.agents) if (now - a.mtime > 10 * 60e3) s.agents.delete(f);
  loadWorkflow(s, s.dir);
  s.liveAgents = [...s.agents.values()].filter((a) => now - a.mtime < 90e3).length;
  s.last = Math.max(s.mtime, ...[...s.agents.values()].map((a) => a.mtime));
  inheritName(s);
  s.name = clean(baseName(s) || s.id.slice(0, 8), 40);
  const quiet = now - s.last;
  const prev = s.state;
  const lp = liveProcs.get(s.id);
  const fd = feedOf(lp);
  s.running = fd ? fd.tools : null;
  s.bgList = s.demo ? [] : bgLiveList(s, lp, now);
  s.bgLive = s.bgList.filter((b) => !b.server).length;
  // only DONE is hidden; a turn that went quiet mid-way may be a permission prompt, so it stays (STALLED)
  s.state = s.wf && !s.wf.done && s.wf.agents.some((a) => a.state === 'run') ? 'AGENTS'
    : s.asking ? 'ASKING'
    : s.apiError ? 'ERROR'
    : (fd ? fd.turnOpen : s.turnOpen) ? (quiet < 5 * 60e3 || (fd && (fd.tools.length || quiet < 15 * 60e3)) ? 'WORKING' : 'STALLED')
    : s.liveAgents > 0 ? 'AGENTS'
    : s.endedOnQuestion ? 'QUESTION'
    : s.bgLive > 0 ? 'WORKING' : 'DONE';
  // its live claude (sessions/<pid>.json) knows sooner than the log. A prompt ("approve Bash(…)", a question)
  // needs you now, not as STALLED? 5 minutes later, and beats a running plan, whose agents wait on it too. A
  // panel left open (/usage, /config) holds back background updates, so it only matters once the turn or plan
  // has stopped: it turns DONE, ASKED YOU or STALLED? into NEEDS YOU, never a turn still writing its log, and
  // an API error stays (its retry is the news). Either way a question in the log keeps its own text and choices.
  s.liveWait = null;
  if (lp && lp.status === 'waiting') {
    const panel = lp.waitingFor === PANEL_OPEN;
    if (!panel || s.state === 'DONE' || s.state === 'QUESTION' || s.state === 'STALLED') {
      s.state = 'ASKING';
      if (!s.asking) s.liveWait = { text: panel ? 'a panel is open in its terminal (like /usage); close it with Esc' : lp.waitingFor || 'waiting on you in its terminal', at: lp.statusAt, panel };
    }
  }
  // stalled with its claude idle (killed mid-turn and resumed: Claude Code starts no turn by itself), not a prompt
  s.stoppedIdle = s.state === 'STALLED' && !!lp && lp.status === 'idle' && now - lp.statusAt >= 30e3;
  // it handed off (handoff.js) and its claude is gone: finished, whatever its last turn looked like (it was
  // killed mid-turn). Not when it was resumed and went on after the handoff: that takes a reply from the
  // model, not the log's time, since a dying claude still writes a stopped-task notice and its cost there
  const ho = !s.demo && s.state !== 'DONE' ? handoffLinks(now).bySession.get(s.id) : null;
  if (ho && (ho.next || ho.handedOffAt) && !liveProcs.has(s.id) && (s.lastAsstT || 0) <= (ho.handedOffAt || ho.created) + 120e3) s.state = 'DONE';
  if (s.late) {
    if (!keepDone(s, now)) { dropSession(s); return; }
    s.late = false;
    scanPrs(s);
  }
  easBackground(s);
  if (prev && prev !== s.state) tl.changed = true;
  checkAlerts(s, prev);
  s.events = s.events.filter((t) => now - t < 30 * 60e3);
  // a finished conversation keeps its files while it is kept, for the detail panel
  const keepFiles = s.state === 'DONE' ? Math.max(WINDOW_MS, KEEP_DONE_MS) : WINDOW_MS;
  for (const [k, fl] of s.files) if (now - fl.t > keepFiles) s.files.delete(k);
}

// ---------- drawing ----------
const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
const BARS = ' ▁▂▃▄▅▆▇█';
const STATE = {
  WORKING: { color: C.cyan, label: 'WORKING' },
  AGENTS: { color: C.violet, label: 'AGENTS' },
  ASKING: { color: C.gold, label: 'NEEDS YOU' },
  QUESTION: { color: C.gold, label: 'ASKED YOU' },
  ERROR: { color: C.red, label: 'API ERROR' },
  STALLED: { color: C.gold, label: 'STALLED?' },
  DONE: { color: C.mint, label: 'DONE' },
  IDLE: { color: C.dim, label: 'IDLE' },
};
let compact = !DEMO && !!saved.compact;

// "1.2M tok  $4.10" for a conversation and all its agents; "…" while its history is still being read
function usageSegs(s) {
  if (!s.tokens && !s.usagePending) return [];
  return [seg(fmtTok(s.tokens) + ' tok  ', C.faint), seg(fmtCost(s.cost) + (s.usagePending ? '…' : ''), C.dim), seg('   ')];
}
const needsYou = (st) => st === 'ASKING' || st === 'QUESTION' || st === 'ERROR' || st === 'STALLED';

function spark(s, n, now) {
  const b = new Array(n).fill(0);
  for (const t of s.events) { const i = n - 1 - Math.floor((now - t) / 60e3); if (i >= 0 && i < n) b[i]++; }
  const max = Math.max(4, ...b);
  return b.map((v, i) => seg(BARS[Math.min(8, Math.ceil((v / max) * 8))], mix(C.faint, s.hue, 0.25 + 0.75 * (i / n))));
}

// one bar per card: the running plan's progress, otherwise how far the work is along the ship track
function bar(s, width, f) {
  const t = f / 12, wf = s.wf;
  const planMode = !!(wf && (!wf.done || Date.now() - wf.jm < 30 * 60e3));
  let p, done;
  if (planMode) { s.shownPlan += (wf.target - s.shownPlan) * 0.08; p = s.shownPlan; done = wf.done === 'completed'; }
  else { const v = shipOf(s).value; s.shownShip += (v - s.shownShip) * 0.08; p = s.shownShip; done = v >= 1; }
  p = Math.max(0, Math.min(1, p));
  const full = Math.floor(p * width + 0.001);
  const live = s.state === 'WORKING' || s.state === 'AGENTS';
  const glint = ((t * 0.35) % 1.6) * width;
  const head = full + ((t * 0.5) % 1.3) * (width - full); // the comet runs over the track still to go
  const segs = [];
  for (let i = 0; i < width; i++) {
    if (i < full) {
      const c = done ? C.mint : grad([C.ember, C.gold, C.mint], i / Math.max(1, width - 1));
      segs.push(seg('━', mix(c, WHITE, Math.max(0, 1 - Math.abs(i - glint) / 4) * 0.55)));
    } else if (i === full && p > 0 && !done) {
      segs.push(seg('╸', mix(C.gold, C.text, 0.5)));
    } else {
      const d = head - i;
      const k = live && d >= 0 && d < 10 ? 1 - d / 10 : 0;
      segs.push(seg('━', k ? mix(C.line, s.hue, k * 0.85) : C.line));
    }
  }
  return { segs, pct: p, mode: planMode ? 'plan' : 'ship', done };
}

function stepIcon(st, pulse) {
  return st === 'ok' ? ['◆', C.mint] : st === 'pending' ? ['◈', scale(C.gold, pulse)] : st === 'fail' ? ['✕', C.red] : st === 'na' ? ['–', C.faint] : ['◇', C.faint];
}

function shipTrack(s, pulse, tight) {
  const out = [];
  shipOf(s).steps.forEach(([label, st], i) => {
    const [icon, c] = stepIcon(st, pulse);
    if (i) out.push(seg(tight ? ' ' : ' ─ ', st === 'ok' ? C.mint : C.faint));
    out.push(seg(icon + (tight ? '' : ' '), c), seg(label, st === 'none' || st === 'na' ? C.dim : c, st === 'pending'));
  });
  return out;
}

function card(s, W, f, now) {
  const st = STATE[s.state];
  const pulse = 0.8; // steady: nothing pulses in brightness
  const busy = s.state === 'WORKING' || s.state === 'AGENTS';
  const lines = [];
  const icon = busy ? SPIN[f % SPIN.length] : s.state === 'IDLE' ? '○' : '◆';
  const iconC = s.state === 'IDLE' ? C.dim : busy ? s.hue : scale(C.gold, pulse + 0.2);
  const badgeC = needsYou(s.state) ? scale(st.color, 0.6 + 0.4 * pulse) : st.color;
  const nameC = s.state === 'IDLE' ? C.dim : C.text;
  const right = [...usageSegs(s), ...spark(s, 20, now), seg('  '), seg(ago(now - s.last).padStart(4), C.dim)];
  const focused = (s.id === focus.sid && now < focus.until) || s.id === pick.sid;
  lines.push(lr([seg(focused ? '▶' : ' ', focused ? C.cyan : C.text, focused), seg(icon, iconC, true), seg(' '), seg(s.name, nameC, true), seg('  '), seg(` ${st.label} `, badgeC, true)], right, W));
  if (!compact) {
    const goal = s.wf && !s.wf.done ? s.wf.desc || s.wf.name : s.prompt;
    lines.push([seg('   goal  ', C.faint), seg(clean(goal, W - 12) || '—', C.dim)]);
  }
  const a = s.lastAction;
  if (a) lines.push([seg('   ▸ ', s.hue), seg(a.who === 'main' ? '' : a.who + '  ', C.violet), seg(a.verb.padEnd(7), C.gold), seg(a.what, C.text)]);
  else lines.push([seg('   ▸ ', s.hue), seg('quiet', C.dim)]);
  const bw = Math.max(16, Math.min(56, W - 50));
  const b = bar(s, bw, f);
  const dots = [];
  if (b.mode === 'plan' && !s.wf.done) {
    for (const ag of s.wf.agents.slice(-14)) {
      dots.push(ag.state === 'done' ? seg('●', C.mint) : ag.state === 'fail' ? seg('✕', C.red) : seg('◉', mix(C.violet, C.cyan, 0.5)));
    }
  } else for (let i = 0; i < Math.min(14, s.liveAgents || 0); i++) dots.push(seg('◉', mix(C.violet, C.cyan, 0.5)));
  const barLine = [seg('   '), seg(b.mode + '  ', C.faint), ...b.segs, seg(`${String(Math.round(b.pct * 100)).padStart(4)}%`, b.done ? C.mint : C.text, true), seg('  '), ...dots];
  // name the agents running for this conversation, as many as fit
  const running = b.mode === 'plan' && !s.wf.done ? s.wf.agents.filter((x) => x.state === 'run').map((x) => x.label) : [...s.agents.values()].filter((x) => now - x.mtime < 90e3).map((x) => x.label);
  let used = segLen(barLine);
  running.forEach((label, i) => {
    const name = clean(label, 24);
    if (used + name.length + 4 > W - 1) return;
    barLine.push(seg('  '), seg('◉ ', mix(C.violet, C.cyan, 0.5)), seg(name, C.violet));
    used += name.length + 4;
  });
  lines.push(barLine);
  if (!compact) {
    const row = [seg('   ')];
    if (b.mode === 'plan') {
      const done = s.wf.done === 'completed';
      s.wf.phases.forEach((p, i) => {
        const past = done || i < s.wf.cur, cur = !done && i === s.wf.cur;
        if (i) row.push(seg(' ── ', past ? C.mint : C.faint));
        row.push(seg(past ? '◆ ' : cur ? '◈ ' : '◇ ', past ? C.mint : cur ? scale(C.gold, pulse + 0.3) : C.faint), seg(clean(p, 18), past ? C.mint : cur ? C.text : C.dim, cur));
      });
      row.push(seg('   │   ', C.line));
    }
    row.push(...shipTrack(s, pulse + 0.3));
    const tags = [];
    if (s.lastPr) tags.push(seg(shipOf(s).fresh ? `last PR #${s.lastPr}` : `PR #${s.lastPr}`, shipOf(s).fresh ? C.dim : C.cyan), seg('  '));
    const m = mergesToday(s);
    if (m) tags.push(seg(`✔ ${m} merged today`, C.mint), seg(' '));
    lines.push(lr(row, tags, W));
  }
  return lines;
}

// conversations still going, each with its repo. A conversation's colour is a shade of its repo's
// family, rechecked every few seconds as it moves.
// still inside the activity window (--window); finished conversations kept longer than that don't count as hidden
const inWindow = (s, now) => now - (s.last || s.mtime || 0) <= WINDOW_MS;
function activeSessions(now) {
  const list = [...sessions.values()].filter((s) => s.name && s.state !== 'DONE' && s.state !== 'IDLE');
  for (const s of list) refreshHue(s, now);
  return list;
}
function refreshHue(s, now) {
  if (!s.hueAt || now - s.hueAt > 5000) { s.root = repoOf(s, now); s.hue = shadeOf(s.root, s.id); s.hueAt = now; }
}

// ---------- repo menu: the name top left picks which repo the views show ----------
// a repo at a drive's root (Z:\ with its own .git) has no folder name: it is called by its drive, Z:
// the home folder isn't a repo: conversations start there (the launchers' folder) and sit there until their tool
// calls point at a repo, so it is shown as "no repo" rather than the user's name
const HOME_KEY = String(os.homedir()).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
const isHomeRoot = (root) => !!root && String(root).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase() === HOME_KEY;
const repoName = (root) => (!root || isHomeRoot(root) ? 'no workspace' : path.basename(root) || String(root).replace(/[\\/]+$/, '') || root);
// a picked path matches that repo root; a bare folder name (--repo detailforge-web) matches any root with that name
function inRepo(root) {
  if (!repoSel) return true;
  if (!root) return false;
  if (/[\\/]/.test(repoSel)) return path.resolve(root).toLowerCase() === path.resolve(repoSel).toLowerCase();
  return repoName(root).toLowerCase() === repoSel.toLowerCase();
}
const menu = { open: false, sel: 0, items: [], hits: [], title: null }; // title: { y, x0, x1 } of the clickable name
const brand = () => TITLE || (repoSel ? repoName(repoSel) : 'all workspaces').toUpperCase();
// "All workspaces" first, then every repo with a live conversation, busiest first; the picked one stays listed
function menuItems(now) {
  const count = new Map();
  pruneHiddenRepos([...sessions.values()]);
  for (const s of activeSessions(now)) if (s.root && !repoHidden(s.root)) count.set(s.root, (count.get(s.root) || 0) + 1);
  const repos = [...count].sort((a, b) => b[1] - a[1] || repoName(a[0]).localeCompare(repoName(b[0])));
  if (repoSel && !repos.some(([r]) => inRepo(r))) repos.push([repoSel, 0]);
  const all = [...count.values()].reduce((a, b) => a + b, 0);
  return [{ root: null, label: 'All workspaces', n: all }, ...repos.map(([root, n]) => ({ root, label: repoName(root), n }))];
}
const isCurrent = (it) => (it.root ? !!repoSel && inRepo(it.root) : !repoSel);
function openMenu() {
  menu.open = true;
  menu.items = menuItems(Date.now());
  menu.sel = Math.max(0, menu.items.findIndex(isCurrent));
}
function pickRepo(it) {
  menu.open = false;
  if (!it) return;
  repoSel = it.root;
  pick.sid = null; map.sel = null; focus.sid = null;
  saveSettings();
  notice = { text: `  showing ${it.root ? repoName(it.root) : 'every workspace'}`, color: C.mint, until: Date.now() + 2500 };
}

// sessions shown in every view: the picked repo, --filter and the / filter, most urgent first
function visibleList() {
  let q = null;
  try { q = query ? new RegExp(query, 'i') : null; } catch { q = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
  const list = activeSessions(Date.now()).filter((s) => {
    if (!inRepo(s.root) || acctOff(s)) return false;
    const text = `${s.name} ${s.prompt || ''} ${s.cwd || ''} ${s.wf?.desc || ''}`;
    return (!FILTER || FILTER.test(text)) && (!q || q.test(text));
  });
  const rank = { ASKING: 0, QUESTION: 1, WORKING: 2, AGENTS: 2, IDLE: 3, DONE: 3 };
  list.sort((a, b) => rank[a.state] - rank[b.state] || b.last - a.last);
  return list;
}

function frame(f) {
  const W = Math.max(60, process.stdout.columns || +process.env.COLUMNS || 120), H = Math.max(16, process.stdout.rows || +process.env.LINES || 48);
  const now = Date.now();
  const list = visibleList();
  // Enter on a session in the Map brings its card to the top for a while
  if (focus.sid && now < focus.until) {
    const i = list.findIndex((s) => s.id === focus.sid);
    if (i > 0) list.unshift(...list.splice(i, 1));
  }
  const out = headerLines(list, W, f, now);

  // cards, then the event stream in whatever space is left
  const per = compact ? 4 : 6;
  const fit = Math.max(1, Math.floor((H - out.length - 6) / per));
  if (!list.length) out.push([seg('   no sessions active in the window, waiting for agents…', C.dim)]);
  cardHits = [];
  pickOrder = list.map((s) => s.id);
  pick.cols = 1;
  // the picked card scrolls into view
  const at = pick.sid ? pickOrder.indexOf(pick.sid) : -1;
  if (at < 0) pick.top = 0;
  else if (at < pick.top) pick.top = at;
  else if (at >= pick.top + fit) pick.top = at - fit + 1;
  pick.top = Math.max(0, Math.min(pick.top, Math.max(0, list.length - fit)));
  for (const s of list.slice(pick.top, pick.top + fit)) {
    const top = out.length;
    out.push(...card(s, W, f, now));
    cardHits.push({ from: top, to: out.length - 1, sid: s.id });
    out.push([]);
  }
  const below = list.length - pick.top - fit;
  if (below > 0 || pick.top > 0) out.push([seg(`   ${pick.top ? `↑ ${pick.top} above   ` : ''}${below > 0 ? `↓ ${below} more` : ''}   (arrows scroll, c compact)`, C.dim)]);

  const left = H - out.length - 1;
  if (left >= 3) {
    out.push([seg('  ─ stream ', C.faint), seg('─'.repeat(Math.max(0, W - 13)), C.line)]);
    const names = new Map(list.map((s) => [s.id, s]));
    const recent = feed.filter((e) => names.has(e.sid)).slice(-(left - 1)).reverse();
    for (const e of recent) {
      const s = names.get(e.sid), k = Math.max(0.35, 1 - (now - e.t) / 300e3);
      out.push([seg('  '), seg(new Date(e.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + '  ', scale(C.dim, k)), seg('●', scale(s.hue, k)), seg(' ' + clean(s.name, 22).padEnd(23), scale(C.text, k * 0.9)), seg(e.who === 'main' ? '' : clean(e.who, 22) + '  ', scale(C.violet, k)), seg(e.verb.padEnd(7), scale(C.gold, k)), seg(e.what, scale(C.text, k * 0.75))]);
    }
  }
  while (out.length < H - 1) out.push([]);
  out.length = H - 1;
  out.push(footer(W, `  q quit   v next view   ↑↓ pick   enter open   c compact   / filter`));
  return '\x1b[H' + out.map((l) => renderLine(l, W)).join('\n');
}

function footer(W, keys) {
  if (notice && Date.now() < notice.until) return lr([seg(notice.text, notice.color, true)], [], W);
  if (typing) keys = `  / ${typed}▌   enter apply   esc cancel`;
  else if (query) keys += `   ·  filter: ${query} (esc clears)`;
  const gone = [...sessions.values()].filter((s) => s.name && (s.state === 'DONE' || s.state === 'IDLE') && inWindow(s, Date.now())).length;
  if (gone && !typing) keys += `   ·  ${gone} finished, hidden`;
  return lr([seg(keys, typing ? C.gold : C.faint)], [seg(DEMO ? 'demo data, nothing here is real  ' : `${GITHUB ? 'github on' : 'github off'}  ·  ${rootLabel()}  `, C.faint)], W);
}

// the header's numbers for the conversations a view shows; shared by the terminal views and /state
function headerCounts(list, now) {
  const live = list.filter((s) => s.state !== 'IDLE').length;
  const agents = list.reduce((n, s) => n + (s.wf && !s.wf.done ? s.wf.agents.filter((a) => a.state === 'run').length : s.liveAgents || 0), 0);
  // merges today in the picked repo's GitHub repos (every repo when none is picked)
  const ghRepos = repoSel ? new Set([...sessions.values()].filter((s) => s.repo && inRepo(s.root || repoOf(s, now))).map((s) => s.repo)) : null;
  const merged = [...mergedToday].reduce((n, [r, set]) => n + (!ghRepos || ghRepos.has(r) ? set.size : 0), 0);
  const waiting = list.filter((s) => needsYou(s.state)).length;
  const spent = DEMO ? [...sessions.values()].reduce((n, s) => n + (s.cost || 0), 0) : spentAll; // every conversation seen this run, filters aside
  return { live, agents, merged, waiting, spent };
}

// the four lines above the body, shared by both views
function headerLines(list, W, f, now) {
  const out = [];
  const name = `◆ ${brand()}${TITLE || DEMO ? '' : menu.open ? ' ▴' : ' ▾'}`;
  const title = `${name}  ·  FLEET VIEW`;
  menu.title = TITLE || DEMO ? null : { y: 1, x0: 2, x1: 2 + [...name].length - 1 };
  const tsegs = [seg('  ')];
  [...title].forEach((ch, i) => {
    tsegs.push(seg(ch, grad(GRAD, (i / title.length) * 0.6), true));
  });
  const { live, agents, merged, waiting, spent } = headerCounts(list, now);
  const clock = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  out.push([]);
  out.push(lr(tsegs, [seg(`${live}`, C.cyan, true), seg(' live  ', C.dim), seg(`${agents}`, C.violet, true), seg(' agents  ', C.dim), seg(`${waiting}`, C.gold, true), seg(' waiting  ', C.dim), seg(`${merged}`, C.mint, true), seg(' merged today  ', C.dim), ...(spent ? [seg(fmtCost(spent), C.text, true), seg(W >= 130 ? ' API cost  ' : ' API  ', C.dim)] : []), seg(clock + '  ', C.text)], W));
  const rule = [];
  for (let i = 0; i < W; i++) rule.push(seg('━', scale(grad(GRAD, i / W), 0.55)));
  out.push(rule);

  // the repo menu opens under the rule and pushes the view down while it is open
  menu.hits = [];
  if (menu.open) {
    menu.items = menuItems(now);
    menu.sel = Math.min(menu.sel, menu.items.length - 1);
    const wide = Math.max(...menu.items.map((it) => [...it.label].length)) + 4;
    menu.items.forEach((it, i) => {
      const on = i === menu.sel, cur = isCurrent(it);
      menu.hits.push({ y: out.length, i });
      out.push([seg('  '), seg(on ? ' ▸ ' : '   ', C.gold, true), seg(`${i < 9 ? i + 1 : ' '} `, C.faint),
        seg(clean(it.label, 40).padEnd(wide), it.root ? familyColor(it.root) : C.text, on || cur),
        seg(`${it.n} live`, C.dim), seg(cur ? '   ✓' : '', C.mint, true)]);
    });
    out.push([seg('     ↑↓ pick   enter show   1-9 jump   esc close', C.faint)]);
  }

  // the latest alert sits under the header for two minutes
  const al = alerts.length && now - alerts[alerts.length - 1].t < 120e3 ? alerts[alerts.length - 1] : null;
  if (al) {
    const on = now - al.t < 8000 && Math.floor(f / 3) % 2 === 0;
    out.push([seg('  ⚑ ', al.color, true), seg(clean(al.s.name, 40), on ? al.color : C.text, true), seg('  ' + al.text, al.color), seg(`   ${ago(now - al.t)} ago`, C.dim)]);
  } else out.push([]);
  return out;
}

// ---------- Map view: an Obsidian-style graph of sessions, agents, repos, PRs and shared files ----------
let focus = { sid: null, until: 0 }; // Enter on a session in the Map: highlight its card in Cards
let typing = false, typed = ''; // the / filter prompt
let pick = { sid: null, top: 0, cols: 1 }; // Cards and Wall: the conversation picked with the arrow keys
let pickOrder = []; // conversation ids in the order the current view shows them
let notice = null; // { text, color, until }: a one-line message in the footer
let cardHits = []; // Cards rows -> session, for mouse clicks
let pendingOpen = null; // { sid, until }: a live conversation waiting for a second click

// conversations open in a Windows Terminal window named after their repo; detailforge-* repos share "detailforge"
const windowFor = (root) => (!root || isHomeRoot(root) ? 'claude' : /detailforge/i.test(repoName(root)) ? 'detailforge' : repoName(root).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'claude');

// pop a conversation open in its own Windows Terminal tab with claude --resume.
// Variables that mark this process as a Claude child are cleared, or the tab would not save or colour.
function openConversation(s, now) {
  if (s.demo) { notice = { text: '  demo conversation: nothing to open', color: C.dim, until: now + 3000 }; return; }
  // any conversation that hasn't finished probably still has its own window, waiting ones included,
  // and two copies would both write to one log: confirm first. A double-click (< 0.6 s) doesn't count.
  const live = s.state !== 'DONE' && s.state !== 'IDLE';
  const confirmed = pendingOpen && pendingOpen.sid === s.id && now < pendingOpen.until && now - pendingOpen.at > 600;
  if (live && !confirmed) {
    if (pendingOpen && pendingOpen.sid === s.id && now - pendingOpen.at <= 600) return;
    pendingOpen = { sid: s.id, at: now, until: now + 5000 };
    notice = { text: `  ${s.name} may still be open in another window. Click again (or o) to open a second copy anyway.`, color: C.gold, until: now + 5000 };
    return;
  }
  pendingOpen = null;
  launchConversation(s).then((r) => { notice = { text: '  ' + r.message, color: r.ok ? C.mint : C.red, until: Date.now() + (r.ok ? 4000 : 5000) }; });
}

// start claude --resume <id> under the conversation's account (~/.claude-<x> for X, the default ~/.claude for B):
// in a Windows Terminal tab with that account's tab colour when the PC has Windows Terminal, else in a console
// window of its own (`cmd /c start`; Windows 10 has no Windows Terminal until it is installed). No confirmation
// here: the terminal view and the page each confirm before calling it. Resolves to { ok, message } once the
// window's program started (or could not).
// It runs through the account's launcher (%APPDATA%\npm\claude-<x>.cmd) when there is one, so /swap
// and session handoffs (handoff.js) restart in that same tab; else the bare claude, with the account set in the
// command itself (`set CLAUDE_CONFIG_DIR=%USERPROFILE%\.claude-<x>&&claude …`: a Windows Terminal that is already
// open makes the tab itself and never sees the environment given to wt.exe). A conversation from another
// config folder (--root) keeps the bare claude: the launcher would set its own.
const launcherFor = (acct, configDir) => {
  const norm = (d) => path.resolve(d).toLowerCase();
  if (configDir ? norm(configDir) !== norm(acctDir(acct)) : acct !== 'B') return null;
  const f = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm', `claude-${acctId(acct).toLowerCase()}.cmd`);
  return fs.existsSync(f) ? f : null;
};
// each account's Windows Terminal tab colour (claude-tabcolor.vbs uses the same ones)
const ACCT_TAB = { A: '#3fb950', B: '#d97757', C: '#58a6ff', D: '#bc8cff', E: '#e3b341', F: '#f778ba' };
// where wt.exe is, or null: its app alias in WindowsApps, else wherever `where` finds it. Looked up again after
// 5 minutes, so a Windows Terminal installed while Fleet View runs is used from then on.
let wtAt = { path: null, at: 0 };
function wtPath() {
  if (Date.now() - wtAt.at < 5 * 60e3) return wtAt.path;
  let p = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Microsoft', 'WindowsApps', 'wt.exe');
  try { fs.lstatSync(p); } catch {
    p = null;
    try {
      const r = spawnSync('where.exe', ['wt'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      if (r.status === 0) p = String(r.stdout).split(/\r?\n/).find((l) => l.trim()) || null;
    } catch {}
  }
  wtAt = { path: p && p.trim(), at: Date.now() };
  return wtAt.path;
}
function launchConversation(s) {
  if (s.demo) return Promise.resolve({ ok: false, message: 'demo conversation: nothing to open' });
  // tests only: FV_TEST_NO_LAUNCH=1 writes what it would open to server.log instead of starting a window
  if (process.env.FV_TEST_NO_LAUNCH === '1') {
    logLine(`test launch: ${s.id} account ${accountFor(s)} cwd ${s.cwd || '-'}`);
    return Promise.resolve({ ok: true, message: `test: would open ${s.name || s.id}` });
  }
  const env = { ...process.env, CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1' };
  // (FLEET_VIEW_* and FV_NO_OPEN are fleet-view.cmd's own: left in, "fleet-view" typed in that tab would skip its launcher;
  // ELECTRON_RUN_AS_NODE and FV_SERVER_OWNER mark the server the desktop window runs, and would follow anything started there)
  for (const k of Object.keys(env)) if (k === 'NO_COLOR' || k === 'WT_SESSION' || k === 'CLAUDECODE' || k === 'CLAUDE_PID' || k === 'CLAUDE_SWAP_KEY' || k === 'CLAUDE_SWAP_PAYER' || k === 'CLAUDE_LAUNCH_KEY' || k === 'CLAUDE_CONFIG_DIR' || k === 'FLEET_VIEW_CHILD' || k === 'FLEET_VIEW_LOOP' || k === 'FV_NO_OPEN' || k === 'ELECTRON_RUN_AS_NODE' || k === 'FV_SERVER_OWNER' || /^CLAUDE_CODE_(CHILD_SESSION|SESSION_ID|MESSAGING_SOCKET|MESSAGING_TOKEN|ENTRYPOINT|SESSION_ATTENDED|OAUTH_TOKEN)$/.test(k)) delete env[k];
  const acct = accountFor(s);
  const configDir = s.projRoot && accountOf(s.projRoot) === acct ? path.dirname(s.projRoot) : acct !== 'B' ? acctDir(acct) : null;
  if (configDir && path.resolve(configDir).toLowerCase() !== path.join(os.homedir(), '.claude').toLowerCase()) env.CLAUDE_CONFIG_DIR = configDir;
  // wt splits its command line at ';', and cmd reads a '%' as a variable: such a folder opens in the home folder instead
  const cwd = s.cwd && !/[;%"]/.test(s.cwd) && fs.existsSync(s.cwd) ? s.cwd.replace(/([^:])[\\/]+$/, '$1') : os.homedir();
  const name = s.name || s.id.slice(0, 8);
  const title = name.replace(/[;"%&^|<>]/g, ' ');
  const launcher = launcherFor(acct, configDir);
  // the account's own folder (~/.claude-<x>) goes in the command; any other config folder (--root) only in env
  const own = acct !== 'B' && configDir && path.resolve(configDir).toLowerCase() === acctDir(acct).toLowerCase();
  // wt gets these as separate arguments (spawn quotes a launcher path with spaces itself)
  const words = launcher ? [launcher, '--resume', s.id]
    : own ? ['set', `CLAUDE_CONFIG_DIR=%USERPROFILE%\\.claude-${acct.toLowerCase()}&&claude`, '--resume', s.id] : ['claude', '--resume', s.id];
  // a console window of its own; ok once `start` said it started it (exit code 0). Its command line is written out
  // as is (verbatim), so a launcher path with spaces is quoted here.
  const consoleWindow = () => new Promise((resolve) => {
    const failed = (why) => { logOnce('open:console:' + why, `open in a console window: ${why}`); resolve({ ok: false, message: `could not open a console window for ${name}` }); };
    const line = words.map((w, i) => (i === 0 && launcher && /\s/.test(w) ? `"${w}"` : w)).join(' ');
    try {
      const c = spawn(process.env.ComSpec || 'cmd.exe', [`/d /c start "${title}" /D "${cwd}" cmd /k ${line.replace(/&/g, '^&')}`], { env, windowsVerbatimArguments: true, windowsHide: true, stdio: 'ignore' });
      c.on('error', (e) => failed(e.message));
      c.on('exit', (code) => (code === 0 ? resolve({ ok: true, message: `opened ${name} in a new console window` }) : failed(`start said ${code}`)));
    } catch (e) { failed(e.message); }
  });
  const wt = wtPath();
  if (!wt) return consoleWindow();
  // a Windows Terminal tab; a console window instead when wt.exe won't start
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(wt, ['-w', windowFor(s.root), 'new-tab', '--title', title, '--tabColor', ACCT_TAB[acct] || '#8b949e', '-d', cwd, 'cmd', '/k', ...words], { env, detached: true, stdio: 'ignore', windowsHide: true });
    } catch (e) { logOnce('open:wt:' + e.message, `open in Windows Terminal: ${e.message}; a console window instead`); return resolve(consoleWindow()); }
    child.on('spawn', () => resolve({ ok: true, message: `opened ${name} in a new Windows Terminal tab` }));
    child.on('error', (e) => { logOnce('open:wt:' + e.message, `open in Windows Terminal: ${e.message}; a console window instead`); wtAt = { path: null, at: Date.now() }; resolve(consoleWindow()); });
    child.unref();
  });
}
const map = {
  pos: new Map(), // node id -> { x, y, vx, vy }, kept across frames so the map never jumps
  sel: null, // selected node id
  zoom: !DEMO && saved.zoom > 0 ? Math.min(8, Math.max(0.25, saved.zoom)) : 1, panX: 0, panY: 0,
  cam: null, // { cx, cy, k }, eased toward the fitted view
  alpha: 1, // layout temperature: hot after changes, a slow drift at rest
  sig: '',
  sparks: [], // { a, b, f0, color }: a tool call travelling along an edge
  prev: [], // rows painted last frame, so only changed rows are written
  screen: [], // node cell positions, for arrow-key selection
  snap: false, // snapshot: settle the layout and place the camera at once
};
const KIND = {
  session: { charge: 7, mass: 3 },
  repo: { charge: 8, mass: 5 },
  agent: { charge: 1.2, mass: 1 },
  pr: { charge: 2, mass: 1.2 },
  file: { charge: 3, mass: 1.5 },
};
const REST = { agent: 7, pr: 10, repo: 26, file: 18 };
const BRAILLE = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]]; // [row][col] dot bits of a 2x4 cell
const hashNum = (s) => { let h = 7; for (const ch of s) h = (h * 33 + ch.charCodeAt(0)) >>> 0; return (h % 1000) / 1000; };

// the colour of a PR node follows its ship stage
function shipColor(s) {
  const { steps, fresh } = shipOf(s);
  if (fresh) return C.faint;
  const st = Object.fromEntries(steps);
  if (steps.some(([, v]) => v === 'fail')) return C.red;
  if (st.live === 'ok') return C.mint;
  if (st.merged === 'ok') return C.violet;
  if (st.checks === 'pending') return C.gold;
  if (st.checks === 'ok') return C.cyan;
  return C.dim;
}

function buildGraph(list, now) {
  const nodes = [], edges = [], byId = new Map();
  const add = (n) => { if (!byId.has(n.id)) { byId.set(n.id, n); nodes.push(n); } return byId.get(n.id); };
  const fileUse = new Map(); // file key -> { f, users: Map(sid -> wrote) }
  for (const s of list) {
    const calls = s.events.filter((t) => now - t < 20 * 60e3).length;
    const sn = add({ id: 's:' + s.id, kind: 'session', s, label: s.name, calls, prio: 60 + Math.min(30, calls / 4) });
    const root = repoOf(s, now);
    s.mapRepo = null;
    if (root) {
      const rn = add({ id: 'r:' + root.toLowerCase(), kind: 'repo', label: path.basename(root) || root, path: root, sessions: [], prio: 55 });
      rn.sessions.push(s);
      edges.push({ a: sn.id, b: rn.id, kind: 'repo' });
      s.mapRepo = rn.id;
    }
    // the running plan's agents, plus plain subagents that are not part of a plan
    const ags = [];
    if (s.wf && (!s.wf.done || now - s.wf.jm < 30 * 60e3)) s.wf.agents.forEach((a, i) => ags.push({ id: `a:${s.id}:${s.wf.runId}:${i}`, label: a.label, state: a.state, phase: a.phase }));
    for (const [f, a] of s.agents) if (!f.includes(`${path.sep}workflows${path.sep}`)) ags.push({ id: `a:${s.id}:${f}`, label: a.label, state: now - a.mtime < 90e3 ? 'run' : 'done' });
    for (const a of ags.slice(-20)) { add({ ...a, kind: 'agent', s, prio: 10 }); edges.push({ a: sn.id, b: a.id, kind: 'agent' }); }
    if (s.lastPr && s.repo) {
      const pn = add({ id: `p:${s.repo}#${s.lastPr}`, kind: 'pr', label: `#${s.lastPr}`, num: s.lastPr, repo: s.repo, s, prio: 30 });
      edges.push({ a: sn.id, b: pn.id, kind: 'pr' });
    }
    for (const fl of s.files.values()) {
      let u = fileUse.get(fl.key);
      if (!u) fileUse.set(fl.key, (u = { f: fl, users: new Map() }));
      u.users.set(s.id, u.users.get(s.id) || fl.wrote);
    }
  }
  // only files two or more sessions touched: the collisions
  for (const [key, u] of fileUse) {
    if (u.users.size < 2) continue;
    const writers = [...u.users.values()].filter(Boolean).length;
    const fn = add({ id: 'f:' + key, kind: 'file', label: u.f.rel.split('/').slice(-2).join('/'), rel: u.f.rel, root: u.f.root, users: u.users, writers, prio: writers >= 2 ? 58 : 40 });
    for (const sid of u.users.keys()) edges.push({ a: 's:' + sid, b: fn.id, kind: 'file' });
  }
  return { nodes, edges, byId };
}

// Each repo's cluster gets a home on a grid shaped like the canvas, so several repos spread across
// the space instead of piling up in the middle. Biggest cluster first; a lone repo sits at the centre.
function clusterOf(n, g) {
  if (n.kind === 'repo') return n.id;
  if (n.kind === 'file') { const id = n.root ? 'r:' + n.root.toLowerCase() : null; return id && g.byId.has(id) ? id : '_none'; }
  return n.s?.mapRepo || '_none';
}
function clusterHomes(g, aspect) {
  const size = new Map();
  for (const n of g.nodes) { n.cl = clusterOf(n, g); size.set(n.cl, (size.get(n.cl) || 0) + 1); }
  const order = [...size].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const count = order.length;
  const cols = Math.max(1, Math.min(count, Math.round(Math.sqrt(count * Math.max(0.5, aspect)))));
  const rowsN = Math.ceil(count / cols);
  // a cluster's room grows with the square root of its node count; every cell is as big as the biggest
  const span = 2 * Math.max(...order.map(([, k]) => 16 + 9 * Math.sqrt(k)), 30);
  const homes = new Map();
  order.forEach(([id], i) => {
    const r = Math.floor(i / cols), c = i % cols;
    // the last row is centred when it isn't full
    const inRow = r === rowsN - 1 ? count - r * cols : cols;
    homes.set(id, { x: (c - (inRow - 1) / 2) * span * 1.15, y: (r - (rowsN - 1) / 2) * span });
  });
  return homes;
}

// spring/repulsion simulation, warm-started from last frame's positions
function layout(g, iters, aspect = 2) {
  const homes = clusterHomes(g, aspect);
  const P = map.pos;
  const sig = g.nodes.map((n) => n.id).join('|');
  if (sig !== map.sig) { map.sig = sig; map.alpha = Math.max(map.alpha, 0.45); }
  const nb = new Map();
  for (const e of g.edges) {
    if (!nb.has(e.a)) nb.set(e.a, []);
    if (!nb.has(e.b)) nb.set(e.b, []);
    nb.get(e.a).push(e.b); nb.get(e.b).push(e.a);
  }
  let cx = 0, cy = 0, cn = 0;
  for (const p of P.values()) { cx += p.x; cy += p.y; cn++; }
  const centre = cn ? { x: cx / cn, y: cy / cn } : { x: 0, y: 0 };
  for (const n of g.nodes) {
    let p = P.get(n.id);
    if (!p) {
      // a new node appears next to something it links to, so the rest of the map stays put
      const anchor = (nb.get(n.id) || []).map((id) => P.get(id)).find(Boolean);
      const r = anchor ? REST[n.kind] || 12 : 30 + Math.random() * 20, a = Math.random() * Math.PI * 2;
      const base = anchor || homes.get(clusterOf(n, g)) || centre;
      p = { x: base.x + Math.cos(a) * r, y: base.y + Math.sin(a) * r, vx: 0, vy: 0 };
      P.set(n.id, p);
    }
    n.p = p;
    n.ph = n.ph ?? hashNum(n.id);
  }
  for (const id of [...P.keys()]) if (!g.byId.has(id)) P.delete(id);
  const ns = g.nodes, n = ns.length;
  for (let it = 0; it < iters; it++) {
    const al = map.alpha;
    for (let i = 0; i < n; i++) {
      const a = ns[i], ka = KIND[a.kind];
      for (let j = i + 1; j < n; j++) {
        const b = ns[j], kb = KIND[b.kind];
        let dx = a.p.x - b.p.x, dy = a.p.y - b.p.y, d2 = dx * dx + dy * dy;
        if (d2 > 200 * 200) continue;
        if (d2 < 0.25) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 0.25; }
        const d = Math.sqrt(d2), f = ((30 * ka.charge * kb.charge) / d2) * al;
        const fx = (dx / d) * f, fy = (dy / d) * f;
        a.p.vx += fx / ka.mass; a.p.vy += fy / ka.mass;
        b.p.vx -= fx / kb.mass; b.p.vy -= fy / kb.mass;
      }
    }
    for (const e of g.edges) {
      const a = g.byId.get(e.a), b = g.byId.get(e.b);
      if (!a || !b) continue;
      const dx = b.p.x - a.p.x, dy = b.p.y - a.p.y, d = Math.sqrt(dx * dx + dy * dy) || 0.1;
      const f = 0.12 * (d - REST[e.kind]) * al;
      const fx = (dx / d) * f, fy = (dy / d) * f;
      a.p.vx += fx / KIND[a.kind].mass; a.p.vy += fy / KIND[a.kind].mass;
      b.p.vx -= fx / KIND[b.kind].mass; b.p.vy -= fy / KIND[b.kind].mass;
    }
    for (const nd of ns) {
      const h = homes.get(nd.cl) || { x: 0, y: 0 }, pull = (nd.kind === 'repo' ? 0.03 : 0.008) * al;
      nd.p.vx -= (nd.p.x - h.x) * pull; nd.p.vy -= (nd.p.y - h.y) * pull;
      nd.p.vx *= 0.6; nd.p.vy *= 0.6;
      const v = Math.hypot(nd.p.vx, nd.p.vy);
      if (v > 4) { nd.p.vx *= 4 / v; nd.p.vy *= 4 / v; }
      nd.p.x += nd.p.vx; nd.p.y += nd.p.vy;
    }
    map.alpha += (0.04 - map.alpha) * 0.015;
  }
}

// fit the graph to the canvas (in braille sub-pixels), then apply zoom and pan; eased so it glides
function camera(g, cw, ch) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const n of g.nodes) { x0 = Math.min(x0, n.p.x); x1 = Math.max(x1, n.p.x); y0 = Math.min(y0, n.p.y); y1 = Math.max(y1, n.p.y); }
  if (!g.nodes.length) { x0 = y0 = -10; x1 = y1 = 10; }
  const bw = Math.max(24, x1 - x0), bh = Math.max(24, y1 - y0);
  const fit = Math.max(0.2, Math.min(6, Math.min((cw - 60) / bw, (ch - 10) / bh)));
  const t = { cx: (x0 + x1) / 2 + map.panX, cy: (y0 + y1) / 2 + map.panY, k: fit * map.zoom };
  if (!map.cam || map.snap) map.cam = t;
  else {
    const c = map.cam;
    c.cx += (t.cx - c.cx) * 0.12; c.cy += (t.cy - c.cy) * 0.12;
    c.k *= Math.pow(t.k / c.k, 0.12);
  }
  return map.cam;
}

function canvas(w, h) {
  return { w, h, mask: new Uint8Array(w * h), col: new Array(w * h).fill(null), lum: new Float32Array(w * h), txt: new Array(w * h).fill(null) };
}
function dot(cv, x, y, color, lum) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= cv.w * 2 || y >= cv.h * 4) return;
  const i = (y >> 2) * cv.w + (x >> 1);
  cv.mask[i] |= BRAILLE[y & 3][x & 1];
  if (lum >= cv.lum[i]) { cv.lum[i] = lum; cv.col[i] = color; }
}
// a line whose colour blends from c0 at the start to c1 at the end; density below 1 keeps only that
// share of its dots (evenly spread), which is how a line fades in or dissolves away
function stroke(cv, x0, y0, x1, y1, c0, lum, c1 = c0, density = 1, seed = 0) {
  const n = Math.min(3000, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
  for (let i = 0; i <= n; i++) {
    if (density < 1 && ((i * 0.6180339887 + seed) % 1) >= density) continue;
    const t = i / (n || 1);
    dot(cv, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, c1 === c0 ? c0 : mix(c0, c1, t), lum);
  }
}
// density below 1 keeps only that share of the ring's dots, spread evenly (golden-ratio order), so a
// ring can dissolve: a terminal has no transparency, and a darker colour just reads as black dots
function ring(cv, x, y, r, color, lum, density = 1, seed = 0) {
  const steps = Math.max(8, Math.ceil(r * 5));
  for (let i = 0; i < steps; i++) {
    if (density < 1 && ((i * 0.6180339887 + seed) % 1) >= density) continue;
    const a = (i / steps) * Math.PI * 2;
    dot(cv, x + Math.cos(a) * r, y + Math.sin(a) * r, color, lum);
  }
}

function put(cv, x, y, text, color, bold) {
  [...text].forEach((ch, k) => { const cx = x + k; if (cx >= 0 && cx < cv.w && y >= 0 && y < cv.h) cv.txt[y * cv.w + cx] = [ch, color, bold]; });
}
function canvasRows(cv) {
  const rows = [];
  for (let y = 0; y < cv.h; y++) {
    const segs = [];
    for (let x = 0; x < cv.w; x++) {
      const i = y * cv.w + x;
      let cell;
      if (cv.txt[i]) cell = cv.txt[i];
      else if (cv.mask[i]) cell = [String.fromCharCode(0x2800 + cv.mask[i]), cv.col[i], false];
      else cell = [' ', C.faint, false];
      const last = segs[segs.length - 1];
      if (last && last[1] === cell[1] && last[2] === cell[2]) last[0] += cell[0];
      else segs.push([cell[0], cell[1], cell[2]]);
    }
    rows.push(segs);
  }
  return rows;
}

function nodeLook(n, f, now) {
  const pulse = 0.5; // steady: nothing pulses in brightness
  let glyph = '●', color = C.dim, bold = false;
  if (n.kind === 'session') {
    const s = n.s, busy = s.state === 'WORKING' || s.state === 'AGENTS';
    glyph = busy ? '◉' : '●';
    color = busy ? mix(s.hue, WHITE, 0.15 * pulse) : needsYou(s.state) ? scale(STATE[s.state].color, 0.65 + 0.35 * pulse) : STATE[s.state].color;
    bold = true;
  } else if (n.kind === 'agent') {
    // agents take their conversation's shade: running ones are brighter, done ones settle dim, failures stay red
    if (n.state === 'run') { glyph = '◉'; color = mix(n.s.hue, WHITE, 0.15 + 0.4 * pulse); }
    else if (n.state === 'fail') { glyph = '✕'; color = C.red; }
    else { glyph = '●'; color = scale(n.s.hue, 0.6); }
  } else if (n.kind === 'repo') { glyph = '◆'; color = familyColor(n.path, 0.74); bold = true; }
  else if (n.kind === 'pr') { glyph = '●'; color = shipColor(n.s); }
  else if (n.kind === 'file') { glyph = '●'; color = n.writers >= 2 ? scale(C.red, 0.7 + 0.3 * pulse) : C.gold; bold = true; }
  return { glyph, color, bold, pulse };
}

function details(n, W, f, now, lines) {
  if (!n) return [[seg('   nothing selected, every agent labelled: click a node or use the arrow keys to focus one', C.dim)]];
  const pulse = 0.8; // steady: nothing pulses in brightness
  const look = nodeLook(n, f, now);
  if (n.kind === 'session') {
    const was = compact; compact = false;
    const out = card(n.s, W, f, now);
    compact = was;
    return lines >= 5 ? out : [out[0], out[2]];
  }
  if (n.kind === 'agent') {
    const e = [...feed].reverse().find((x) => x.sid === n.s.id && x.who === n.label);
    const st = n.state === 'run' ? 'RUNNING' : n.state === 'fail' ? 'FAILED' : 'DONE';
    return [
      [seg(' '), seg(look.glyph, look.color, true), seg(' ' + n.label, C.text, true), seg(`  ${st} `, look.color, true)],
      [seg('   session  ', C.faint), seg(n.s.name, C.text), seg(n.phase ? `   phase  ${n.phase}` : '', C.dim)],
      e ? [seg('   ▸ ', n.s.hue), seg(e.verb.padEnd(7), C.gold), seg(e.what, C.text)] : [seg('   ▸ quiet', C.dim)],
    ];
  }
  if (n.kind === 'repo') {
    return [
      [seg(' ◆ ', look.color, true), seg(n.label, C.text, true), seg(`  ${n.sessions.length} session${n.sessions.length === 1 ? '' : 's'}`, C.dim)],
      [seg('   path  ', C.faint), seg(n.path, C.dim)],
      [seg('   ', C.faint), ...n.sessions.flatMap((s, i) => [seg(i ? '  ·  ' : '', C.faint), seg('● ', s.hue), seg(clean(s.name, 30), C.text)])],
    ];
  }
  if (n.kind === 'pr') {
    return [
      [seg(' ● ', look.color, true), seg(`PR #${n.num}`, C.text, true), seg('  ' + n.repo, C.dim)],
      [seg('   '), ...shipTrack(n.s, pulse + 0.3)],
      [seg('   session  ', C.faint), seg(n.s.name, C.text)],
    ];
  }
  const users = [...n.users.entries()].map(([sid, wrote]) => [sessions.get(sid), wrote]).filter(([s]) => s);
  return [
    [seg(' ● ', look.color, true), seg(n.rel, C.text, true), seg(n.writers >= 2 ? `  edited by ${n.writers} sessions` : `  touched by ${users.length} sessions`, n.writers >= 2 ? C.red : C.gold, true)],
    [seg('   workspace  ', C.faint), seg(n.root || '—', C.dim)],
    [seg('   '), ...users.flatMap(([s, wrote], i) => [seg(i ? '  ·  ' : '', C.faint), seg(wrote ? '✎ ' : '◌ ', wrote ? C.red : C.dim), seg(clean(s.name, 30), C.text)])],
  ];
}

function mapRows(f) {
  const W = Math.max(60, process.stdout.columns || +process.env.COLUMNS || 120), H = Math.max(16, process.stdout.rows || +process.env.LINES || 48);
  const now = Date.now();
  const list = visibleList();
  const out = headerLines(list, W, f, now);
  const stripH = H >= 26 ? 6 : 3;
  const rows = Math.max(4, H - out.length - stripH - 1);
  const g = buildGraph(list, now);
  layout(g, map.snap ? 500 : map.alpha > 0.2 ? 4 : 1, (W * 2) / (rows * 4));
  // nothing selected (at launch, or after a click on empty space) labels every agent; a node that left drops its selection
  if (map.sel && !g.byId.has(map.sel)) map.sel = null;
  const cw = W * 2, ch = rows * 4;
  map.cw = cw; map.ch = ch; // canvas size in sub-pixels, for zooming toward the cursor
  const cam = camera(g, cw, ch);
  // screen position in sub-pixels, with a slow per-node drift so the map breathes at rest
  for (const n of g.nodes) {
    n.sx = (n.p.x - cam.cx) * cam.k + cw / 2 + Math.sin(now / 2300 + n.ph * 40) * 0.7;
    n.sy = (n.p.y - cam.cy) * cam.k + ch / 2 + Math.cos(now / 2900 + n.ph * 40) * 0.7;
    n.cx = Math.floor(n.sx / 2); n.cy = Math.floor(n.sy / 4);
  }
  const cv = canvas(W, rows);
  const sel = map.sel && g.byId.get(map.sel);
  const looks = new Map(g.nodes.map((n) => [n.id, nodeLook(n, f, now)]));

  // appear and disappear: a new node fades in over 0.7 s, dot by dot, and one that leaves dissolves
  // over 0.9 s where it last was. Whatever is on screen when the map first opens is simply there.
  if (!map.born) { map.born = new Map(); map.ghosts = new Map(); map.last = new Map(); map.lastEdges = []; }
  const opening = map.born.size === 0;
  for (const n of g.nodes) if (!map.born.has(n.id)) map.born.set(n.id, opening || map.snap ? now - 1e4 : now);
  for (const id of [...map.born.keys()]) if (!g.byId.has(id)) map.born.delete(id);
  const fadeIn = (n) => Math.min(1, (now - map.born.get(n.id)) / 700);
  for (const [id, last] of map.last) {
    if (g.byId.has(id) || map.ghosts.has(id)) continue;
    map.ghosts.set(id, { ...last, t: now, edges: map.lastEdges.filter((e) => e.a === id || e.b === id) });
  }
  for (const [id, gh] of map.ghosts) {
    const u = (now - gh.t) / 900;
    if (u >= 1 || g.byId.has(id)) { map.ghosts.delete(id); continue; }
    const left = Math.pow(1 - u, 1.4);
    for (const e of gh.edges) stroke(cv, e.x0, e.y0, e.x1, e.y1, e.c0, 0.25, e.c1, left * 0.9, e.seed);
    ring(cv, gh.sx, gh.sy, gh.halo + u * 3, scale(gh.color, 0.75), 0.3, left, gh.ph);
    if (u < 0.5) put(cv, gh.cx, gh.cy, '·', scale(gh.color, 0.8), false);
  }

  // edges: each blends from the conversation's colour to the colour of what it links to (its repo's
  // family, an agent's shade, a PR's stage), dim at rest and brighter where they touch the selection;
  // links to a shared file run from the conversation's colour into the warning colour
  const endColor = (n) => (n.kind === 'repo' ? familyColor(n.path) : looks.get(n.id).color);
  const edgesNow = [];
  for (const e of g.edges) {
    const a = g.byId.get(e.a), b = g.byId.get(e.b);
    if (!a || !b) continue;
    const hot = sel && (sel.id === a.id || sel.id === b.id);
    const k = e.kind === 'file' ? 0.55 : hot ? 0.7 : 0.32;
    const c0 = scale(a.s ? a.s.hue : C.dim, k);
    const c1 = scale(e.kind === 'file' ? (b.writers >= 2 ? C.red : C.gold) : endColor(b), k);
    const seed = hashNum(e.a + e.b);
    stroke(cv, a.sx, a.sy, b.sx, b.sy, c0, hot ? 0.6 : 0.3, c1, Math.min(fadeIn(a), fadeIn(b)), seed);
    edgesNow.push({ a: e.a, b: e.b, x0: a.sx, y0: a.sy, x1: b.sx, y1: b.sy, c0, c1, seed });
  }

  // fresh tool calls become sparks: agent → session, or session → repo for the session's own calls
  let stagger = 0;
  for (const e of sparkQueue.splice(0)) {
    if (now - e.t > 6e3) continue;
    const sid = 's:' + e.sid;
    if (!g.byId.has(sid)) continue;
    let from = sid, to = g.byId.get(sid).s.mapRepo;
    if (e.who !== 'main') {
      const ag = g.nodes.find((n) => n.kind === 'agent' && n.s.id === e.sid && n.label === e.who && n.state === 'run') || g.nodes.find((n) => n.kind === 'agent' && n.s.id === e.sid && n.label === e.who);
      if (ag) { from = ag.id; to = sid; }
    }
    if (!to || !g.byId.has(to)) continue;
    map.sparks.push({ a: from, b: to, f0: f + (stagger++ % 8) * 2, color: g.byId.get(sid).s.hue });
  }
  if (map.sparks.length > 60) map.sparks.splice(0, map.sparks.length - 60);
  map.sparks = map.sparks.filter((sp) => f - sp.f0 <= 14 && g.byId.has(sp.a) && g.byId.has(sp.b));
  // each spark is a comet: a bright head and a six-dot tail that softens toward the conversation's colour
  for (const sp of map.sparks) {
    const u = (f - sp.f0) / 14;
    if (u < 0) continue;
    const a = g.byId.get(sp.a), b = g.byId.get(sp.b);
    for (let k = 6; k >= 0; k--) {
      const v = u - k * 0.022;
      if (v < 0) continue;
      const c = k === 0 ? mix(sp.color, WHITE, 0.6) : mix(mix(sp.color, WHITE, 0.3), scale(sp.color, 0.6), k / 6);
      dot(cv, a.sx + (b.sx - a.sx) * v, a.sy + (b.sy - a.sy) * v, c, 0.95 - k * 0.07);
    }
  }

  // halos: a session's size grows with its last 20 minutes of tool calls; brightness stays steady
  for (const n of g.nodes) {
    const lk = looks.get(n.id), fade = fadeIn(n);
    if (n.kind === 'session') {
      const s = n.s, busy = s.state === 'WORKING' || s.state === 'AGENTS';
      const r = 3 + Math.min(8, Math.sqrt(n.calls) * 1.1);
      ring(cv, n.sx, n.sy, r, scale(lk.color, busy ? 0.45 + 0.3 * lk.pulse : 0.3), 0.5, fade, n.ph);
      n.halo = r;
    } else if (n.kind === 'file' && n.writers >= 2) { ring(cv, n.sx, n.sy, 3 + lk.pulse * 2, scale(C.red, 0.5), 0.5, fade, n.ph); n.halo = 4; }
    else if (n.kind === 'repo') { ring(cv, n.sx, n.sy, 4, scale(familyColor(n.path), 0.45), 0.35, fade, n.ph); n.halo = 4; }
    else n.halo = 2;
  }
  if (sel) ring(cv, sel.sx, sel.sy, (sel.halo || 2) + 3, mix(C.cyan, WHITE, 0.5), 1);

  // node glyphs (a small dot while a node is still fading in), then labels by priority, never
  // overlapping each other or a node; a node gets its label once it has mostly appeared
  const occ = new Uint8Array(W * rows);
  map.screen = [];
  const lastNow = new Map();
  for (const n of g.nodes) {
    const lk = looks.get(n.id), fade = fadeIn(n);
    lastNow.set(n.id, { sx: n.sx, sy: n.sy, cx: n.cx, cy: n.cy, color: endColor(n), halo: n.halo || 2, ph: n.ph });
    if (n.cx < 0 || n.cx >= W || n.cy < 0 || n.cy >= rows) continue;
    if (fade < 0.45) put(cv, n.cx, n.cy, '·', scale(lk.color, 0.6 + fade), false);
    else put(cv, n.cx, n.cy, lk.glyph, lk.color, lk.bold || n === sel);
    occ[n.cy * W + n.cx] = 1;
    map.screen.push({ id: n.id, x: n.cx, y: n.cy * 2 });
  }
  map.last = lastNow;
  map.lastEdges = edgesNow;
  // with nothing selected every agent is labelled; with a selection only the agents around that
  // conversation are, so you can see who works for it
  const selSid = sel && sel.s ? sel.s.id : null;
  const agentShown = (n) => !sel || n.s.id === selSid;
  for (const n of g.nodes) if (n.kind === 'agent' && agentShown(n) && n !== sel) n.prio = n.state === 'run' ? 26 : 12;
  const labelled = g.nodes.filter((n) => (n === sel || n.kind !== 'agent' || agentShown(n)) && (n === sel || fadeIn(n) >= 0.6)).sort((a, b) => (b === sel) - (a === sel) || b.prio - a.prio);
  // labels by zoom: a terminal can't shrink its font, so zoomed out the names get shorter and the
  // small things (PRs, agents of unselected conversations, read-only shared files) drop out, leaving
  // repo titles and conversation names; zoomed in, names grow back to full length
  const tier = cam.k < 0.7 ? 0 : cam.k < 1.4 ? 1 : cam.k < 2.6 ? 2 : 3;
  const MAXLEN = { session: [14, 20, 26, 40], agent: [10, 14, 24, 32], repo: [24, 28, 32, 40], pr: [0, 8, 8, 8], file: [16, 20, 24, 36] };
  for (const n of labelled) {
    const lk = looks.get(n.id);
    const near = n === sel || (selSid && n.s?.id === selSid); // the selection and its agents keep a mid-length label
    const max = MAXLEN[n.kind][near ? Math.max(1, tier) : tier];
    if (!max || (tier === 0 && !near && n.kind === 'file' && n.writers < 2)) continue;
    const name = clean(n.label, max);
    const text = (n.kind === 'file' ? '⚠ ' : '') + (n.kind === 'repo' && tier === 0 ? name.toUpperCase() : name);
    const len = [...text].length;
    const spots = [[n.cx + 2, n.cy], [n.cx - 1 - len, n.cy], [n.cx - (len >> 1), n.cy - 1], [n.cx - (len >> 1), n.cy + 1]];
    for (const [x, y] of spots) {
      if (x < 0 || x + len > W || y < 0 || y >= rows) continue;
      let free = true;
      for (let k = Math.max(0, x - 1); k < Math.min(W, x + len + 1) && free; k++) if (occ[y * W + k]) free = false;
      if (!free) continue;
      for (let k = Math.max(0, x - 1); k < Math.min(W, x + len + 1); k++) occ[y * W + k] = 1;
      const color = n === sel ? mix(C.cyan, WHITE, 0.4)
        : n.kind === 'session' ? C.text
        : n.kind === 'repo' ? familyColor(n.path, 0.62) : n.kind === 'file' ? lk.color : n.kind === 'pr' ? lk.color : mix(n.s.hue, WHITE, 0.2);
      put(cv, x, y, text, color, n === sel || n.kind === 'session' || n.kind === 'repo');
      break;
    }
  }
  if (!g.nodes.length) put(cv, Math.max(0, (W >> 1) - 22), rows >> 1, 'no active sessions, waiting for agents…', C.dim, false);

  map.top = out.length; // canvas rows on screen, for mouse clicks
  map.rows = rows;
  for (const r of canvasRows(cv)) out.push(r);
  // the selected node's details
  const kindName = sel ? { session: 'session', agent: 'agent', repo: 'workspace', pr: 'pull request', file: 'shared file' }[sel.kind] : 'selection';
  out.push([seg('  ─ ', C.faint), seg(kindName + ' ', C.dim), seg('─'.repeat(Math.max(0, W - kindName.length - 6)), C.line)]);
  const det = details(sel, W, f, now, stripH - 1).slice(0, stripH - 1);
  while (det.length < stripH - 1) det.push([]);
  out.push(...det);
  while (out.length < H - 1) out.push([]);
  out.length = H - 1;
  out.push(footer(W, `  q quit   v next view   click/arrows select   o open convo   enter card   +/- zoom   shift+arrows pan   0 center   / filter`));
  return out.map((l) => renderLine(l, W));
}

// arrow keys: the nearest node roughly in that direction (y doubled, since cells are twice as tall as wide)
function moveSel(dx, dy) {
  const cur = map.screen.find((n) => n.id === map.sel);
  if (!cur) { map.sel = map.screen[0]?.id || null; return; }
  let best = null, bs = Infinity;
  for (const n of map.screen) {
    if (n.id === cur.id) continue;
    const vx = n.x - cur.x, vy = n.y - cur.y, d = Math.hypot(vx, vy);
    if (!d) continue;
    const cos = (vx * dx + vy * dy) / d;
    if (cos < 0.4) continue;
    const score = d * (2.2 - 1.2 * cos);
    if (score < bs) { bs = score; best = n; }
  }
  if (best) map.sel = best.id;
}

// ---------- Windows Terminal profile with acrylic blur ----------
const PROFILE_GUID = '{6a1c2f3e-7b4d-4e59-9a80-a93e7b015e00}';
function installProfile() {
  const base = path.join(process.env.LOCALAPPDATA || '', 'Packages');
  const files = ['Microsoft.WindowsTerminal_8wekyb3d8bbwe', 'Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe']
    .map((p) => path.join(base, p, 'LocalState', 'settings.json')).filter((f) => fs.existsSync(f));
  if (!files.length) { console.log('Windows Terminal settings.json not found.'); process.exit(1); }
  const script = path.resolve(__filename);
  const profile = {
    guid: PROFILE_GUID, name: 'Fleet View', hidden: false,
    // through fleet-view.cmd, whose loop restarts fleet-view.js in the same tab when it reloads after an update
    // (--tui: plain fleet-view.cmd means the app window now)
    commandline: `cmd.exe /c "${path.join(path.dirname(script), 'fleet-view.cmd')}" --tui`, startingDirectory: path.dirname(script),
    useAcrylic: true, opacity: 45, background: '#05060b', foreground: '#eef0fa', cursorColor: '#05060b',
    // slightly taller lines and a lighter weight soften the dim text; bold then reads as real bold
    font: { face: 'Cascadia Mono', cellHeight: '1.15', weight: 'semi-light' }, intenseTextStyle: 'bold',
    padding: '18, 14', scrollbarState: 'hidden',
    tabTitle: 'Fleet View', suppressApplicationTitle: true,
    // taskbar only: no 'window' bell (it flashes the whole window bright on
    // every alert) and no 'audible' one (Henry, 2026-10-05: no sound)
    bellStyle: ['taskbar'], closeOnExit: 'always',
  };
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    let j;
    try { j = JSON.parse(text); } catch { console.log(`${f} has comments or trailing commas; add the profile by hand (see README).`); continue; }
    fs.writeFileSync(f + '.fleet-view.bak', text);
    const list = Array.isArray(j.profiles) ? j.profiles : ((j.profiles = j.profiles || {}).list = j.profiles.list || []);
    const i = list.findIndex((p) => p.guid === PROFILE_GUID);
    if (i >= 0) list[i] = profile; else list.push(profile);
    fs.writeFileSync(f, JSON.stringify(j, null, 4) + '\n');
    console.log(`Fleet View profile written to ${f} (backup next to it).`);
  }
}

// ---------- Wall view: one big tile per conversation, for a second monitor ----------
const BIG = {
  0: ['█▀█', '█ █', '█▄█'], 1: ['▀█ ', ' █ ', '▄█▄'], 2: ['▀▀█', '█▀▀', '█▄▄'], 3: ['▀▀█', ' ▀█', '▄▄█'],
  4: ['█ █', '▀▀█', '  █'], 5: ['█▀▀', '▀▀█', '▄▄█'], 6: ['█▀▀', '█▀█', '█▄█'], 7: ['▀▀█', '  █', '  █'],
  8: ['█▀█', '█▀█', '█▄█'], 9: ['█▀█', '▀▀█', '▄▄█'], '%': ['▀ ▄', ' ▄▀', '▄▀▄'],
};
let wallHits = []; // tile rectangles -> session, for mouse clicks

// clip or pad a line of segments to exactly w cells
function fit(segs, w) {
  const out = [];
  let used = 0;
  for (const [t, c, b] of segs) {
    if (used >= w) break;
    const ch = [...t].slice(0, w - used);
    out.push([ch.join(''), c, b]);
    used += ch.length;
  }
  if (used < w) out.push([' '.repeat(w - used), C.faint, false]);
  return out;
}

function wrap(text, w, n) {
  const words = clean(text).split(' ');
  const lines = [''];
  for (const word of words) {
    const cur = lines[lines.length - 1];
    if (!cur) lines[lines.length - 1] = word;
    else if (cur.length + 1 + word.length <= w) lines[lines.length - 1] = cur + ' ' + word;
    else if (lines.length < n) lines.push(word);
    else { lines[n - 1] = clean(lines[n - 1] + ' ' + word, w); break; }
  }
  return lines.map((l) => clean(l, w));
}

function tile(s, tw, th, f, now) {
  const st = STATE[s.state];
  const pulse = 0.8; // steady: nothing pulses in brightness
  const busy = s.state === 'WORKING' || s.state === 'AGENTS';
  const edge = s.id === pick.sid ? mix(C.cyan, WHITE, 0.2 + 0.3 * pulse) // picked with the arrow keys
    : needsYou(s.state) ? scale(st.color, 0.45 + 0.4 * pulse) : scale(s.hue, 0.55);
  const iw = tw - 4;
  const icon = busy ? SPIN[f % SPIN.length] : '◆';
  const badge = ` ${st.label} `;
  const title = clean(s.name, Math.max(6, tw - 9 - badge.length));
  const fill = Math.max(1, tw - 8 - [...title].length - badge.length);
  const top = [seg('╭─ ', edge), seg(icon + ' ', busy ? s.hue : st.color, true), seg(title, C.text, true), seg(' ' + '─'.repeat(fill), edge), seg(badge, needsYou(s.state) ? scale(st.color, 0.6 + 0.4 * pulse) : st.color, true), seg('─╮', edge)];

  // big percentage on the left, what it is and why on the right
  const b = bar(s, iw, f);
  const digits = `${Math.round(b.pct * 100)}%`;
  const bigColor = b.done ? C.mint : mix(grad([C.ember, C.gold, C.mint], b.pct), WHITE, 0.15 * pulse);
  const big = [0, 1, 2].map((r) => [...digits].map((ch) => BIG[ch][r]).join(' '));
  const rw = Math.max(4, iw - [...big[0]].length - 3);
  const steps = shipOf(s).steps;
  const stage = b.mode === 'plan' ? `plan · ${s.wf.phases[s.wf.cur] || ''}${s.wf.done ? ' · done' : ''}` : `ship · ${(steps.find(([, v]) => v !== 'ok' && v !== 'na') || ['live'])[0]}`;
  const goal = wrap(s.wf && !s.wf.done ? s.wf.desc || s.wf.name : s.prompt || '', rw, 2);
  const rows = th - 2;
  // a very short tile has no room for the cost row, so the cost takes the goal's second line
  const right = [[seg(stage, C.gold, true)], [seg(goal[0] || '', C.dim)], rows < 5 && usageSegs(s).length ? usageSegs(s).slice(0, 2) : [seg(goal[1] || '', C.dim)]];
  const inner = [0, 1, 2].map((r) => [seg(big[r], bigColor, true), seg('   '), ...right[r]]);
  inner.push(b.segs);
  if (b.mode === 'plan') {
    const row = [];
    const done = s.wf.done === 'completed';
    s.wf.phases.forEach((p, i) => {
      const past = done || i < s.wf.cur, cur = !done && i === s.wf.cur;
      if (i) row.push(seg(' ─ ', past ? C.mint : C.faint));
      row.push(seg(past ? '◆ ' : cur ? '◈ ' : '◇ ', past ? C.mint : cur ? scale(C.gold, pulse + 0.3) : C.faint), seg(clean(p, 14), past ? C.mint : cur ? C.text : C.dim, cur));
    });
    inner.push(row);
  } else inner.push(shipTrack(s, pulse + 0.3, true));
  const a = s.lastAction;
  inner.push(a ? [seg('▸ ', s.hue), seg(a.who === 'main' ? '' : a.who + '  ', C.violet), seg(a.verb.padEnd(7), C.gold), seg(a.what, C.text)] : [seg('▸ quiet', C.dim)]);
  const ag = [];
  const list = b.mode === 'plan' && !s.wf.done ? s.wf.agents : [];
  for (const x of list.slice(-16)) ag.push(x.state === 'done' ? seg('●', C.mint) : x.state === 'fail' ? seg('✕', C.red) : seg('◉', mix(C.violet, C.cyan, 0.5)));
  const running = list.filter((x) => x.state === 'run').map((x) => x.label);
  if (ag.length) ag.push(seg('  '));
  ag.push(seg(running.length ? running.slice(0, 3).map((l) => clean(l, 18)).join('  ') : list.length ? 'all agents done' : 'no agents', running.length ? C.violet : C.faint));
  inner.push(ag);
  const tags = [];
  if (s.lastPr) tags.push(seg(shipOf(s).fresh ? `last PR #${s.lastPr}` : `PR #${s.lastPr}`, shipOf(s).fresh ? C.dim : C.cyan), seg('  '));
  const m = mergesToday(s);
  if (m) tags.push(seg(`✔ ${m} merged`, C.mint), seg('  '));
  inner.push(lr(tags, usageSegs(s).slice(0, 2), iw));

  // a short tile drops its least important rows first (agents, then phases, then the last action),
  // so the PR, tokens and cost row stays
  const keep = inner.map((_, i) => i);
  for (const drop of [6, 4, 5]) if (keep.length > rows) keep.splice(keep.indexOf(drop), 1);
  const lines = [top];
  for (let i = 0; i < rows; i++) lines.push([seg('│ ', edge), ...fit(inner[keep[i]] || [], iw), seg(' │', edge)]);
  lines.push([seg('╰' + '─'.repeat(tw - 2) + '╯', edge)]);
  return lines;
}

function wallRows(f) {
  const W = Math.max(60, process.stdout.columns || +process.env.COLUMNS || 120), H = Math.max(16, process.stdout.rows || +process.env.LINES || 48);
  const now = Date.now();
  const list = visibleList();
  const out = headerLines(list, W, f, now);
  const cols = Math.max(1, Math.floor((W - 1) / 46));
  const tw = Math.floor((W - 1) / cols) - 1;
  const avail = H - out.length - 2;
  const bands = Math.max(1, Math.ceil(list.length / cols));
  const th = Math.max(6, Math.min(10, Math.floor(avail / bands)));
  const fitBands = Math.max(1, Math.floor(avail / th));
  // too short for even one 6-row tile: say so rather than draw tiles the footer would cut
  const shown = avail < 6 ? [] : list.slice(0, fitBands * cols);
  wallHits = [];
  pickOrder = shown.map((s) => s.id);
  pick.cols = cols;
  if (!list.length) out.push([seg('   no conversations need watching right now', C.dim)]);
  else if (avail < 6) out.push([seg('   the window is too short for the wall: make it taller, or press v', C.dim)]);
  for (let r = 0; r * cols < shown.length; r++) {
    const row = shown.slice(r * cols, r * cols + cols);
    const tiles = row.map((s) => tile(s, tw, th, f, now));
    const y0 = out.length;
    row.forEach((s, j) => wallHits.push({ x0: 1 + j * (tw + 1), x1: j * (tw + 1) + tw, y0, y1: Math.min(y0 + th - 1, H - 2), sid: s.id }));
    for (let i = 0; i < th; i++) {
      const line = [seg(' ')];
      tiles.forEach((t) => { line.push(...fit(t[i], tw), seg(' ')); });
      out.push(line);
    }
  }
  if (list.length > shown.length) out.push([seg(`   + ${list.length - shown.length} more: make the window bigger, or filter with /`, C.dim)]);
  while (out.length < H - 1) out.push([]);
  out.length = H - 1;
  out.push(footer(W, `  q quit   v next view   arrows pick   enter open   / filter`));
  return out.map((l) => renderLine(l, W));
}

// ---------- demo: made-up conversations, so the screen can be recorded without real work on it ----------
const DEMO_CALLS = [
  ['shell', 'Run the checkout tests'], ['edit', 'CheckoutForm.tsx'], ['read', 'stripe.ts'], ['search', 'useCart'],
  ['shell', 'Build the web app'], ['edit', 'sync-queue.ts'], ['read', 'schema.prisma'], ['shell', 'Typecheck the workspace'],
  ['edit', 'ranking.py'], ['web', 'docs.stripe.com/webhooks'], ['shell', 'Push the branch and open the PR'], ['read', 'README.md'],
  ['edit', 'offline-banner.tsx'], ['shell', 'Run Lighthouse on /checkout'], ['search', 'retryWebhook'], ['edit', 'welcome-email.mdx'],
];
const DEMO_DEFS = [
  { name: 'checkout-redesign', repo: 'storefront-web', goal: 'Rebuild checkout with saved cards and Apple Pay, then review every screen', phases: ['Build', 'Review', 'Fix'], agents: ['build:cart', 'build:payments', 'build:address', 'build:receipts'], pr: 412, ship: 1, files: [['storefront-web', 'src/payments/stripe.ts', true], ['storefront-web', 'packages/core/cart.ts', false]] },
  { name: 'mobile-offline-sync', repo: 'storefront-app', goal: 'Queue edits while the phone is offline and sync them when it reconnects', phases: ['Design', 'Build', 'Verify'], agents: ['design:queue', 'build:sync', 'build:conflicts'], files: [['storefront-web', 'packages/core/cart.ts', false]] },
  { name: 'billing-webhooks-fix', repo: 'storefront-web', goal: 'Retry failed Stripe webhooks and alert when invoice totals drift', pr: 415, ship: 2, files: [['storefront-web', 'src/payments/stripe.ts', true]] },
  { name: 'search-relevance-tuning', repo: 'search-service', goal: 'Tune ranking weights against last week of click data', ask: 'QUESTION', pr: 208, ship: 3 },
  { name: 'docs-site-refresh', repo: 'docs', goal: 'Move the docs to the new theme and fix every broken link', ask: 'ASKING' },
  { name: 'perf-audit', repo: 'storefront-web', goal: 'Read-only audit of page weight and slow queries on /checkout', phases: ['Audit', 'Verify'], agents: ['audit:bundle', 'audit:images', 'audit:queries', 'audit:fonts', 'audit:cache'], branch: 'feat/checkout-redesign' },
  { name: 'onboarding-emails', repo: 'growth', goal: 'Write the five-email onboarding sequence and wire it to signup', pr: 77, ship: 1 },
  // a parity repo (detailforge-web): a web + app pair working as a team, and one that left the app out.
  // area: where its made-up edits land (so each stays on its side)
  { name: 'booking-reminders-web', repo: 'detailforge-web', goal: 'Text customers a reminder the day before a booking, with a setting to turn it off', area: 'app/bookings', pickedUpFrom: 'booking-reminders-plan',
    files: [['detailforge-web', 'app/bookings/reminders/page.tsx', true], ['detailforge-web', 'packages/core/reminders.ts', true], ['detailforge-web', 'supabase/migrations/0142_booking_reminders.sql', true]] },
  { name: 'booking-reminders-app', repo: 'detailforge-web', goal: 'The same booking reminder setting in the phone app, shipped to both stores', area: 'mobile/app/bookings', eas: true,
    files: [['detailforge-web', 'mobile/app/bookings/reminders.tsx', true], ['detailforge-web', 'packages/core/reminders.ts', false]] },
  { name: 'invoice-footer-web', repo: 'detailforge-web', goal: 'Show the shop address and tax id in the invoice footer', area: 'components/invoices',
    files: [['detailforge-web', 'components/invoices/InvoiceFooter.tsx', true], ['detailforge-web', 'supabase/migrations/0142_invoice_footer.sql', true]] },
];
// the demo team (the web + app pair) and what they say to each other
const DEMO_TEAM_ORDER = 'Ship booking reminders on the website and in the phone app together. Put the reminder rules in packages/core, the web settings page in app/bookings, and the app screen in mobile/. Merge when both sides are done.';
const DEMO_TEAM_MSGS = [
  ['booking-reminders-web', 'booking-reminders-app', 'I put reminderDue() and the opt-out flag in packages/core/reminders.ts. Import it, do not copy it.'],
  ['booking-reminders-app', 'booking-reminders-web', 'Got it. The app screen reads the same flag. I will not touch packages/core until you push.'],
  ['booking-reminders-web', 'booking-reminders-app', 'Pushed feat/booking-reminders. Migration 0142 adds reminders_enabled to shops.'],
  ['booking-reminders-app', 'booking-reminders-web', 'Pulled it. The setting screen works on Android; checking iOS next.'],
  ['booking-reminders-web', 'booking-reminders-app', 'Web PR is green. Tell me when the eas update is out and I will merge.'],
  ['booking-reminders-app', 'booking-reminders-web', 'eas update is out on production for both platforms.'],
];
// what each one last said, for the detail panel
const DEMO_REPLIES = [
  'Build phase: the four build agents are on cart, payments, address and receipts. Saved cards work end to end in the test shop; Apple Pay is wired but waits on the merchant ID check.\n\nNext: review every checkout screen at phone and desktop width, then fix what the review finds.',
  'The offline queue is designed: edits are stored in order with a version per record, and replayed when the phone reconnects.\n\nConflicts (the same order edited on two devices) keep the newest edit and show the other one as a note, so nothing is lost silently.',
  'Webhook retries now back off 1 min, 5 min, 30 min, then alert.\n\nNext is the invoice drift check: it compares Stripe\'s total with ours every night and flags anything more than 1 cent apart.',
  'I compared last week\'s click data against the new weights.\n\n- Clicks on the first three results: +4.1%\n- Long-tail queries (under 10 searches a week): -1.3%\n\nThe new weights lift clicks 4% but hurt long-tail queries a little. Should I ship them behind a flag?',
  'Moving the docs pages to the new theme, section by section. 64 of 212 pages are done; 9 broken links fixed so far.',
  'Audit so far: /checkout ships 412 KB of JavaScript, 160 KB of it from the date picker.\n\nThe slowest query is the saved-cards lookup (380 ms at p95); it is missing an index on customer_id.',
  'Emails 1 to 3 are written (welcome, first product, first sale). Wiring the sequence to the signup event now; 4 and 5 follow.',
  'The reminder rules are in packages/core (reminderDue, the opt-out flag) and the web settings page uses them. Migration 0142 adds reminders_enabled to shops.',
  'The reminder setting screen is in the app and reads the same flag from packages/core. Shipping it with eas update to both platforms.',
  'The invoice footer now shows the shop address and tax id on the web invoices.',
];
const DEMO_ASK_FULL = 'Which theme should the docs move to?\n  - New brand theme: new fonts, layout and colours; every page gets checked again\n  - Current theme with the new colours: a smaller change that ships today';
// conversations that finished a while ago, for the "recently finished" strip
const DEMO_DONE = [
  { name: 'order-export-csv', repo: 'storefront-web', ago: 7, pr: 409, goal: 'Let shop owners export orders as CSV for any date range',
    files: ['src/orders/export.ts', 'src/orders/ExportDialog.tsx', 'src/orders/export.test.ts'],
    reply: '## Done\n\nOrders can now be exported as CSV for any date range, from Orders, then Export. PR #409 is merged and live.\n\n- Big exports (over 5,000 orders) run in the background and arrive by email\n- Money columns keep two decimals and the shop\'s currency\n\nTests: 14 new, all passing.' },
  { name: 'image-cdn-migration', repo: 'storefront-web', ago: 31, pr: 405, goal: 'Serve product images from the new CDN with sizes per screen',
    files: ['src/media/cdn.ts', 'next.config.js', 'src/components/ProductImage.tsx'],
    reply: 'Product images now come from the new CDN in three sizes, and the page picks the right one for the screen. The home page is 38% lighter on phones.\n\nPR #405 merged; production picked it up without errors.' },
  { name: 'push-copy-pass', repo: 'storefront-app', ago: 64, goal: 'Rewrite the push notification texts in plain words',
    files: ['src/notifications/copy.ts'],
    reply: 'Rewrote all 23 push notification texts in plain words, each under 60 characters so phones don\'t cut them. No code paths changed; only the copy file.' },
  { name: 'ranking-eval-harness', repo: 'search-service', ago: 112, pr: 206, goal: 'Build a harness that scores ranking changes on last week\'s queries',
    files: ['eval/harness.py', 'eval/queries.sql', 'eval/README.md'],
    reply: 'The ranking harness is in: `python eval/harness.py --weights new.json` scores a weight file against last week\'s 40,000 queries in about two minutes and prints clicks and long-tail changes side by side.\n\nPR #206 merged.' },
  { name: 'pricing-page-typos', repo: 'docs', ago: 158, pr: 31, goal: 'Fix the typos and old prices on the pricing page',
    files: ['pages/pricing.mdx'],
    reply: 'Fixed 6 typos and the two old prices on the pricing page (Team is $49 now, not $39). PR #31 merged and the docs site is updated.' },
  // handed off to booking-reminders-web (the demo's handoff chain)
  { name: 'booking-reminders-plan', repo: 'detailforge-web', ago: 24, goal: 'Plan booking reminders for the website and the phone app', handedOffTo: 'booking-reminders-web',
    files: ['docs/reminders-plan.md'],
    reply: 'Plan written to docs/reminders-plan.md: reminder rules in packages/core, a settings page on the web, the same screen in the app. Context reached the handoff size, so a fresh conversation picks it up from here.' },
];
const pickOne = (a) => a[Math.floor(Math.random() * a.length)];
const demoRoot = (repo) => path.join(path.sep === '\\' ? 'D:\\' : '/', 'demo', repo);

// the same progress rule as a real plan: phases passed plus the share of the current phase's agents done
function planProgress(wf) {
  const n = wf.phases.length;
  let cur = 0;
  for (const a of wf.agents) cur = Math.max(cur, Math.max(0, wf.phases.indexOf(a.phase)));
  const inCur = wf.agents.filter((a) => Math.max(0, wf.phases.indexOf(a.phase)) === cur);
  const doneCur = inCur.filter((a) => a.state !== 'run').length + 0.35 * inCur.filter((a) => a.state === 'run').length;
  wf.cur = cur;
  wf.target = wf.done === 'completed' ? 1 : Math.min(0.99, (cur + (inCur.length ? doneCur / inCur.length : 0)) / n);
}

let demoRuns = 0;
function demoPlan(s, now) {
  const d = s.demo;
  s.wf = { runId: `demo-run-${++demoRuns}`, name: `${d.name}-plan`, desc: d.goal, phases: d.phases, agents: d.agents.map((label) => ({ label, phase: d.phases[0], state: 'run' })), jm: now, fails: 0, done: null };
  planProgress(s.wf);
}

// ship stage 1: PR open, checks running; 2: checks passed; 3: merged, deploying; 4: live
function demoShip(s, stage) {
  s.shipStage = stage;
  s.shipAt = Date.now();
  ships.set(`${s.repo}#${s.lastPr}`, { at: Date.now(), state: stage >= 3 ? 'MERGED' : 'OPEN', checks: stage >= 2 ? 'ok' : 'pending', merged: stage >= 3, live: stage >= 4 ? 'ok' : stage === 3 ? 'pending' : 'none',
    deployUrl: stage >= 4 ? `https://example.com/acme/${s.demo.repo}/pr-${s.lastPr}` : null });
  if (stage >= 3) { if (!mergedToday.has(s.repo)) mergedToday.set(s.repo, new Set()); mergedToday.get(s.repo).add(s.lastPr); }
}

function demoInit() {
  const now = Date.now();
  DEMO_DEFS.forEach((d, i) => {
    const root = demoRoot(d.repo);
    const s = {
      id: `demo-${i}`, file: '', dir: '', demo: { ...d, slug: `acme/${d.repo}` }, events: [], calls: [], lastReply: DEMO_REPLIES[i] || '', prs: new Map(), finished: new Map(), bg: new Map(), bgUse: new Map(), agents: new Map(), shipSeen: new Map(), files: new Map(),
      repoVotes: [{ root, t: now }], msgUsage: new Map(), usageScan: new Map(), shownPlan: 0, shownShip: 0, seenFails: 0,
      custom: d.name, name: d.name, prompt: d.goal, cwd: root, last: now, mtime: now, state: 'WORKING', since: now - Math.random() * 30e3,
      tokens: Math.round(3e5 + Math.random() * 6e6), cost: 0,
    };
    s.cost = (s.tokens / 1e6) * (0.9 + Math.random() * 0.8);
    // what the app window shows besides the terminal cards: account, model, context, branch, turn time
    s.account = i % 3 === 1 ? 'B' : 'A';
    s.model = i === 3 ? 'claude-sonnet-5-5' : 'claude-opus-5-5';
    s.ctxUsed = [92e3, 141e3, 186e3, 64e3, 151e3, 38e3, 119e3][i % 7];
    s.demo.branch = d.branch || (i === 4 ? 'main' : `feat/${d.name}`);
    if (d.eas) s.eas = { id: null, kind: 'update', state: 'running', at: now - 20e3, platforms: 'all', bg: null };
    s.demo.worktree = i === 4 ? null : d.name;
    s.promptAt = now - (3 + i * 4) * 60e3;
    if (d.ask === 'ASKING') { s.askText = 'Which theme should the docs move to: the new brand theme, or the current one with the new colours?'; s.askFull = DEMO_ASK_FULL; }
    if (d.ask === 'QUESTION') s.lastSaid = 'The new weights lift clicks 4% but hurt long-tail queries a little. Should I ship them behind a flag?';
    for (let k = 0; k < 60; k++) s.events.push(now - Math.random() * 20 * 60e3);
    if (d.pr) { s.repo = `acme/${d.repo}`; s.prs.set(d.pr, s.repo); s.lastPr = d.pr; s.lastPrT = now - 60e3; s.pushedAt = now - 90e3; demoShip(s, d.ship); }
    for (const [repo, rel, wrote] of d.files || []) {
      const key = demoRoot(repo) + '|' + rel.toLowerCase();
      s.files.set(key, { key, rel, root: demoRoot(repo), abs: path.join(demoRoot(repo), ...rel.split('/')), t: now - Math.random() * 8 * 60e3, wrote, seed: true });
    }
    if (d.phases) demoPlan(s, now);
    sessions.set(s.id, s);
  });
  DEMO_DONE.forEach((d, j) => {
    const i = DEMO_DEFS.length + j, root = demoRoot(d.repo), end = now - d.ago * 60e3;
    const s = {
      id: `demo-${i}`, file: '', dir: '', demo: { ...d, done: true, branch: `feat/${d.name}`, worktree: d.name, slug: `acme/${d.repo}` }, events: [], calls: [], lastReply: d.reply,
      prs: new Map(), finished: new Map(), bg: new Map(), bgUse: new Map(), agents: new Map(), shipSeen: new Map(), files: new Map(), repoVotes: [{ root, t: end }], msgUsage: new Map(), usageScan: new Map(),
      shownPlan: 0, shownShip: 0, seenFails: 0, custom: d.name, name: d.name, prompt: d.goal, cwd: root, last: end, mtime: end, turnEndT: end, state: 'DONE', ready: true,
      promptAt: end - (9 + j * 6) * 60e3, account: j % 2 ? 'B' : 'A', model: 'claude-opus-5-5', ctxUsed: [71e3, 132e3, 44e3, 158e3, 23e3][j % 5],
      tokens: Math.round(6e5 + Math.random() * 4e6), cost: 0,
    };
    s.cost = (s.tokens / 1e6) * 1.1;
    if (d.pr) { s.repo = `acme/${d.repo}`; s.prs.set(d.pr, s.repo); s.lastPr = d.pr; s.lastPrT = end - 6 * 60e3; s.pushedAt = end - 7 * 60e3; demoShip(s, 4); }
    d.files.forEach((rel, k) => {
      const key = root + '|' + rel.toLowerCase();
      s.files.set(key, { key, rel, root, abs: path.join(root, ...rel.split('/')), t: end - (k + 1) * 95e3, wrote: true, seed: true });
    });
    for (let k = 0; k < 24; k++) {
      const [verb, what] = DEMO_CALLS[(j * 5 + k) % DEMO_CALLS.length];
      const rel = d.files[k % d.files.length];
      const file = verb === 'edit' || verb === 'read' ? path.join(root, ...rel.split('/')) : null;
      s.calls.push({ t: end - 20e3 - k * 45e3, who: k % 3 ? 'main' : ['build:ui', 'build:api', 'build:tests'][(k / 3) % 3], verb, what: file ? path.basename(file) : what, file });
    }
    sessions.set(s.id, s);
  });
  for (const n of [401, 403, 405, 409]) { if (!mergedToday.has('acme/storefront-web')) mergedToday.set('acme/storefront-web', new Set()); mergedToday.get('acme/storefront-web').add(n); }
  // the team of two, with the messages they have sent so far
  const byName = (name) => [...sessions.values()].find((x) => x.demo && x.demo.name === name);
  const web = byName('booking-reminders-web'), app = byName('booking-reminders-app');
  if (web && app) {
    teams = [{ id: 't000000d1', name: 'booking reminders', color: TEAM_COLORS[0], members: [web.id, app.id], order: DEMO_TEAM_ORDER, at: now - 14 * 60e3, messages: [], seenAt: now }];
    DEMO_TEAM_MSGS.slice(0, 3).forEach(([from, to, text], k) => teams[0].messages.push({ t: now - (11 - k * 3) * 60e3, from: byName(from).id, to: byName(to).id, text }));
    demoMsgAt = now;
  }
  demoTimeline(now);
  demoTick();
  feedLive = true;
  // a few alerts of the newer kinds, so the list has them from the start
  const audit = byName('perf-audit'), docs = byName('docs-site-refresh');
  if (audit) raise(audit, 'agent audit:fonts has made no tool call for 22 minutes', C.gold, 'stuckAgent', { fail: true });
  if (docs) { docs.ctxUsed = 231e3; docs.overAt = now; raise(docs, 'context at 231k, past the 200k handoff size with no handoff', C.gold, 'overLimit'); }
  if (web) raise(web, 'wrote migration #0142, and so did invoice-footer-web', C.red, 'conflict', { conflict: 'k:migration:#0142' });
}
let demoMsgAt = 0, demoMsgN = 3;
// the demo's worktrees: one per demo conversation that has one, plus an old one nobody uses (stale)
const demoWt = new Map(); // path -> lastCommit
function demoWorktrees(root, now) {
  const out = [];
  const add = (name, branch, age) => {
    const p = path.join(root, '.claude', 'worktrees', name);
    if (!demoWt.has(p)) demoWt.set(p, now - age);
    out.push({ root, path: p, name, branch, lastCommit: demoWt.get(p) });
  };
  for (const s of sessions.values()) if (s.demo && s.demo.worktree && s.root && rootKey(s.root) === rootKey(root)) add(s.demo.worktree, s.demo.branch, ((hashOf(s.id) % 50) + 2) * 60e3);
  if (/storefront-web$/i.test(root)) add('spike-old-checkout', 'spike/old-checkout', 5 * 24 * 3600e3);
  return out;
}
// the last hour, made up: a frame a minute (states, costs growing), tool calls, and merges going live
function demoTimeline(now) {
  for (let k = 60; k >= 1; k--) {
    const t = now - k * 60e3;
    const sess = [];
    for (const s of sessions.values()) {
      const f = frameOf(s, now);
      const ended = s.turnEndT && s.state === 'DONE' ? s.turnEndT : 0;
      if (ended && t < ended - 40 * 60e3) continue; // not started yet
      let state = ended && t < ended ? 'WORKING' : s.state;
      if (s.demo.ask && !ended) state = Math.floor(k / 4) % 2 ? s.demo.ask : 'WORKING';
      else if (!ended && s.wf) state = 'AGENTS';
      const st = STATE[state] || STATE.IDLE;
      const share = Math.max(0.05, 1 - k / 70);
      sess.push({ ...f, state, label: st.label, stateColor: toHex(st.color), cost: Math.round(f.cost * share * 1e4) / 1e4, tokens: Math.round(f.tokens * share) });
      if (state === 'WORKING' || state === 'AGENTS') for (let n = 0; n < 4; n++) {
        const [verb, what] = DEMO_CALLS[(hashOf(s.id) + k * 7 + n) % DEMO_CALLS.length];
        tlEvent({ t: t + n * 13e3 + (hashOf(s.id) % 9e3), sid: s.id, who: 'main', verb, what });
      }
    }
    tlPush(t, sess);
  }
  tl.lastFrame = now - 60e3;
  for (const s of sessions.values()) {
    if (!s.demo.done || !s.lastPr || !s.turnEndT || now - s.turnEndT > 60 * 60e3) continue;
    tlShip({ t: s.turnEndT - 6 * 60e3, kind: 'merged', pr: s.lastPr, repo: s.repo, sid: s.id, name: s.name });
    tlShip({ t: s.turnEndT - 3 * 60e3, kind: 'live', pr: s.lastPr, repo: s.repo, sid: s.id, name: s.name });
  }
  tl.ships.sort((a, b) => a.t - b.t);
}

function demoTick() {
  const now = Date.now();
  for (const s of sessions.values()) {
    const d = s.demo, prev = s.state;
    if (d.done) continue; // a finished one stays as it ended
    // plans: agents finish one by one, then the next phase starts with fresh agents; a finished plan restarts later
    if (s.wf && !s.wf.done) {
      for (const a of s.wf.agents) if (a.state === 'run' && Math.random() < 0.07) { a.state = Math.random() < 0.05 ? 'fail' : 'done'; s.wf.jm = now; }
      const phase = s.wf.phases[s.wf.cur];
      if (s.wf.agents.filter((a) => a.phase === phase).every((a) => a.state !== 'run')) {
        const next = s.wf.phases[s.wf.cur + 1];
        if (next) for (let k = 0; k < (next === 'Fix' ? 2 : 3); k++) s.wf.agents.push({ label: `${next.toLowerCase()}:${pickOne(['ui', 'api', 'tests', 'docs', 'perf', 'a11y'])}`, phase: next, state: 'run' });
        else { s.wf.done = 'completed'; s.wf.doneAt = now; }
      }
      s.wf.fails = s.wf.agents.filter((a) => a.state === 'fail').length;
      planProgress(s.wf);
    } else if (s.wf && s.wf.done && now - s.wf.doneAt > 30e3) demoPlan(s, now);
    // PRs move along the ship track, and a live one is followed by a new PR
    if (s.lastPr) {
      if (s.shipStage < 4 && now - s.shipAt > 8e3 && Math.random() < 0.05) demoShip(s, s.shipStage + 1);
      else if (s.shipStage === 4 && now - s.shipAt > 40e3) { s.lastPr += 2; s.prs.set(s.lastPr, s.repo); s.lastPrT = now; demoShip(s, 1); }
    }
    // the asking conversations wait on you for a while, then carry on as if you answered
    if (d.ask) {
      const waiting = Math.floor((now - s.since) / 35e3) % 2 === 0;
      s.state = waiting ? d.ask : 'WORKING';
      if (waiting && prev !== d.ask) s.turnEndT = now;
    } else s.state = s.wf && !s.wf.done ? 'AGENTS' : 'WORKING';
    const busy = s.state === 'WORKING' || s.state === 'AGENTS';
    if (busy) {
      const running = s.wf && !s.wf.done ? s.wf.agents.filter((a) => a.state === 'run') : [];
      const n = 1 + Math.floor(Math.random() * (running.length ? 3 : 2));
      for (let k = 0; k < n; k++) {
        const [verb, what] = pickOne(DEMO_CALLS);
        const touch = verb === 'edit' || verb === 'read';
        const root = demoRoot(d.repo), rel = d.area ? `${d.area}/${what}` : `src/${d.name}/${what}`, abs = path.join(root, ...rel.split('/'));
        pushEvent(s, now - Math.random() * 1200, running.length && Math.random() < 0.75 ? pickOne(running).label : 'main', verb, what, touch ? abs : null);
        // reads and edits leave a trail of recently touched files, as real ones do
        if (touch) {
          const key = root + '|' + rel.toLowerCase();
          const old = s.files.get(key);
          s.files.set(key, { key, rel, root, abs, t: now, wrote: !!(old && old.wrote) || verb === 'edit', seed: old?.seed });
        }
      }
      for (const [k, fl] of s.files) if (!fl.seed && now - fl.t > 12 * 60e3) s.files.delete(k);
      const tok = Math.round(8e3 + Math.random() * 40e3);
      s.tokens += tok;
      s.cost += (tok / 1e6) * 1.3;
      s.last = now;
    }
    // the app's eas update: runs for 25 s, is out for a minute, then the next one starts
    if (s.eas) {
      if (s.eas.state === 'running' && now - s.eas.at > 25e3) { s.eas.state = 'ok'; s.eas.endAt = now; }
      else if (s.eas.state === 'ok' && now - s.eas.endAt > 60e3) s.eas = { id: null, kind: 'update', state: 'running', at: now, platforms: 'all', bg: null };
    }
    s.liveAgents = 0;
    if (prev !== s.state) tl.changed = true;
    checkAlerts(s, prev);
    s.events = s.events.filter((t) => now - t < 30 * 60e3);
  }
  // the team talks: a message every 20 s or so, through the same path as fleet-msg.js
  if (demoMsgAt && now - demoMsgAt > 20e3 && Math.random() < 0.3) {
    const [from, to, text] = DEMO_TEAM_MSGS[demoMsgN++ % DEMO_TEAM_MSGS.length];
    const by = (name) => [...sessions.values()].find((x) => x.demo && x.demo.name === name);
    if (by(from) && by(to)) noteMessage(by(from).id, by(to).id, text);
    demoMsgAt = now;
  }
  demoDeploys(now);
  feed.sort((a, b) => a.t - b.t);
  if (feed.length > 400) feed.splice(0, feed.length - 400);
  if (WEB) afterPoll(now);
}

// the demo's production deploys, through the same path as real ones (noteDeploy raises the live alert):
// storefront-web builds for 90 s, is live for 2 minutes, then the next merge builds; docs has one that failed
// a quarter of an hour ago (made again when it gets old, so the top bar keeps one)
const DEMO_DEPLOYS = [[412, 'Saved cards and Apple Pay at checkout'], [415, 'Retry failed Stripe webhooks with backoff'], [409, 'Export orders as CSV for any date range']];
let demoDpN = 0;
function demoDeploys(now) {
  const sha = (n) => require('crypto').createHash('sha1').update(`demo-deploy-${n}`).digest('hex');
  const repo = (slug, name) => {
    let r = dpRepos.get(slug);
    if (!r) dpRepos.set(slug, (r = { slug, root: demoRoot(name), next: 0, shown: [], logged: false }));
    return r;
  };
  const web = repo('acme/storefront-web', 'storefront-web');
  web.hosted = true;
  const build = (t) => {
    const n = demoDpN++, [pr, title] = DEMO_DEPLOYS[n % DEMO_DEPLOYS.length];
    return { id: String(7100000000 + n), sha: sha(n), title, pr, state: 'building', createdAt: t, readyAt: null, url: `https://example.com/acme/storefront-web/deploys/${n}` };
  };
  let d = web.shown[0];
  if (!d) d = build(now - 20e3);
  else if (d.state === 'building' && now - d.createdAt >= 90e3) Object.assign(d, { state: 'live', readyAt: now, url: 'https://example.com/acme/storefront-web' });
  else if (d.state === 'live' && now - d.readyAt >= 120e3) d = build(now);
  web.shown = [d];
  noteDeploy(web, d);
  const docs = repo('acme/docs', 'docs');
  docs.hosted = true;
  if (!docs.shown[0] || now - docs.shown[0].readyAt > 25 * 60e3) {
    const n = demoDpN++;
    docs.shown = [{ id: String(7100000000 + n), sha: sha(n), title: 'Docs theme: new fonts and layout', pr: 33, state: 'failed', createdAt: now - 16 * 60e3, readyAt: now - 14 * 60e3, url: 'https://example.com/acme/docs/deploys/failed' }];
    noteDeploy(docs, docs.shown[0]);
  }
}

// ---------- map camera by mouse ----------
let drag = null; // { x, y, empty?, moved? }: the last cell the mouse was at while dragging the map; empty: it started on empty space

// drag by cells: a column is 2 braille sub-pixels wide and a row 4 tall; the board follows the pointer
// at once (camera and target move together, so there is no easing lag under the hand)
function panBy(dxCells, dyCells) {
  if (!map.cam) return;
  const dx = (dxCells * 2) / map.cam.k, dy = (dyCells * 4) / map.cam.k;
  map.panX -= dx; map.panY -= dy;
  map.cam.cx -= dx; map.cam.cy -= dy;
}

// zoom keeping the point under the cursor still
function zoomAt(x, y, factor) {
  const old = map.zoom;
  map.zoom = Math.min(8, Math.max(0.25, map.zoom * factor));
  saveSettings();
  if (!map.cam || !map.cw) return;
  const k = map.cam.k, k2 = k * (map.zoom / old);
  const sx = x * 2 + 1, sy = (y - map.top) * 4 + 2;
  const inside = y >= map.top && y < map.top + map.rows;
  const ox = inside ? sx - map.cw / 2 : 0, oy = inside ? sy - map.ch / 2 : 0;
  const dcx = ox * (1 / k - 1 / k2), dcy = oy * (1 / k - 1 / k2);
  map.panX += dcx; map.panY += dcy;
  map.cam.cx += dcx; map.cam.cy += dcy; map.cam.k = k2;
}

// ---------- keys ----------
function onKey(k, quit) {
  if (typing) {
    if (k === '\r' || k === '\n') { query = typed; typing = false; map.sel = null; saveSettings(); }
    else if (k === '\x1b') typing = false;
    else if (k === '\x7f' || k === '\b') typed = typed.slice(0, -1);
    else if (k === '\x03') quit();
    else if (k.length === 1 && k >= ' ') typed += k;
    return;
  }
  if (k === '\x03') return quit();
  // the repo menu takes the keys while it is open; clicks go on to the mouse code below
  if (menu.open && !k.startsWith('\x1b[<')) {
    const step = { '\x1b[A': -1, '\x1bOA': -1, k: -1, '\x1b[B': 1, '\x1bOB': 1, j: 1 }[k];
    if (step) menu.sel = (menu.sel + step + menu.items.length) % menu.items.length;
    else if (k === '\r' || k === '\n') pickRepo(menu.items[menu.sel]);
    else if (/^[1-9]$/.test(k) && menu.items[+k - 1]) pickRepo(menu.items[+k - 1]);
    else if (k === '\x1b' || k === 'r' || k === 'q') menu.open = false;
    map.prev = [];
    return 'clear';
  }
  if (k === 'q') return quit();
  if (k === 'r' && menu.title) { openMenu(); map.prev = []; return 'clear'; }
  // Esc only clears the filter: a stray Esc (Alt+key, a split sequence) must never quit
  if (k === '\x1b') { query = ''; pick.sid = null; saveSettings(); return; }
  if (k === 'v' || k === '\t') { view = VIEWS[(VIEWS.indexOf(view) + 1) % VIEWS.length]; map.prev = []; saveSettings(); return 'clear'; }
  if (k === '/') { typing = true; typed = query; return; }
  // mouse (SGR reporting, with motion while a button is held). Cards and Wall: left click opens.
  // Map, like a design canvas: middle-drag (or left-drag on empty space) pans, the wheel zooms toward
  // the cursor, left click selects a node and a second click on a selected conversation opens it.
  const ms = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(k);
  if (ms) {
    const code = +ms[1], x = +ms[2] - 1, y = +ms[3] - 1, now = Date.now();
    const button = code & 3, motion = (code & 32) !== 0, wheel = (code & 64) !== 0;
    if (wheel) { if (view === 'map') zoomAt(x, y, button === 0 ? 1.15 : 1 / 1.15); return; }
    // a left click on empty space that didn't drag clears the selection
    if (ms[4] === 'm') { if (drag?.empty && !drag.moved) map.sel = null; else if (drag) saveSettings(); drag = null; return; }
    if (motion) {
      if (drag && view === 'map' && (x !== drag.x || y !== drag.y)) { panBy(x - drag.x, y - drag.y); drag.x = x; drag.y = y; drag.moved = true; }
      return;
    }
    if (view === 'map' && button === 1) { drag = { x, y }; return; }
    if (button !== 0) return;
    // the name top left opens the repo menu; a click on a line picks it, anywhere else closes it
    const t = menu.title;
    if (t && y === t.y && x >= t.x0 && x <= t.x1) { if (menu.open) menu.open = false; else openMenu(); map.prev = []; return 'clear'; }
    if (menu.open) {
      const hit = menu.hits.find((h) => h.y === y);
      if (hit) pickRepo(menu.items[hit.i]); else menu.open = false;
      map.prev = [];
      return 'clear';
    }
    if (view === 'cards') {
      const hit = cardHits.find((h) => y >= h.from && y <= h.to);
      if (hit && sessions.has(hit.sid)) openConversation(sessions.get(hit.sid), now);
      return;
    }
    if (view === 'wall') {
      const hit = wallHits.find((h) => x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1);
      if (hit && sessions.has(hit.sid)) openConversation(sessions.get(hit.sid), now);
      return;
    }
    if (y < map.top || y >= map.top + map.rows) return; // clicks in the strip or footer select nothing
    let best = null, bd = 4;
    for (const n of map.screen) { const d = Math.hypot(n.x - x, n.y - (y - map.top) * 2); if (d < bd) { bd = d; best = n; } }
    if (!best) { drag = { x, y, empty: true }; return; } // empty space: drag the board, or a plain click clears the selection
    if (best.id === map.sel && best.id.startsWith('s:') && sessions.has(best.id.slice(2))) return openConversation(sessions.get(best.id.slice(2)), now);
    map.sel = best.id;
    return;
  }
  if (view !== 'map') {
    if (view === 'cards' && k === 'c') { compact = !compact; saveSettings(); return; }
    // Cards and Wall: the arrow keys pick a conversation (Wall moves through the grid), Enter or o opens it
    const step = { '\x1b[A': -pick.cols, '\x1bOA': -pick.cols, k: -pick.cols, '\x1b[B': pick.cols, '\x1bOB': pick.cols, j: pick.cols,
      '\x1b[C': 1, '\x1bOC': 1, l: 1, '\x1b[D': -1, '\x1bOD': -1, h: -1 }[k];
    if (step !== undefined && pickOrder.length) {
      const at = pickOrder.indexOf(pick.sid);
      pick.sid = pickOrder[at < 0 ? 0 : Math.max(0, Math.min(pickOrder.length - 1, at + step))];
      return;
    }
    if (k === '\r' || k === '\n' || k === 'o') {
      if (!pick.sid || !pickOrder.includes(pick.sid)) { pick.sid = pickOrder[0] || null; return; }
      if (sessions.has(pick.sid)) openConversation(sessions.get(pick.sid), Date.now());
    }
    return;
  }
  if (k === 'o') {
    const n = map.sel && map.sel.startsWith('s:') ? map.sel.slice(2) : map.sel && map.sel.startsWith('a:') ? map.sel.split(':')[1] : null;
    if (n && sessions.has(n)) openConversation(sessions.get(n), Date.now());
    return;
  }
  const dir = { '\x1b[A': [0, -1], '\x1bOA': [0, -1], k: [0, -1], '\x1b[B': [0, 1], '\x1bOB': [0, 1], j: [0, 1], '\x1b[C': [1, 0], '\x1bOC': [1, 0], l: [1, 0], '\x1b[D': [-1, 0], '\x1bOD': [-1, 0], h: [-1, 0] }[k];
  if (dir) return moveSel(...dir);
  const pan = { '\x1b[1;2A': [0, -1], '\x1b[1;2B': [0, 1], '\x1b[1;2C': [1, 0], '\x1b[1;2D': [-1, 0] }[k];
  const kk = map.cam ? map.cam.k : 1;
  if (pan) { map.panX += (pan[0] * 16) / kk; map.panY += (pan[1] * 10) / kk; return; }
  if (k === '+' || k === '=') { map.zoom = Math.min(8, map.zoom * 1.25); saveSettings(); return; }
  if (k === '-' || k === '_') { map.zoom = Math.max(0.25, map.zoom / 1.25); saveSettings(); return; }
  if (k === '0') { map.zoom = 1; map.panX = map.panY = 0; saveSettings(); return; }
  if ((k === '\r' || k === '\n') && map.sel && map.sel.startsWith('s:')) {
    focus = { sid: map.sel.slice(2), until: Date.now() + 20e3 };
    view = 'cards'; map.prev = []; saveSettings();
    return 'clear';
  }
}

// Windows Terminal sends mouse clicks as text only when the console's input has
// ENABLE_VIRTUAL_TERMINAL_INPUT (0x200) set, and Node's raw mode leaves it off, so clicks never arrive.
// A short PowerShell attached to the same console turns it on, and turns QuickEdit (0x40) off so a
// click isn't taken as the start of a text selection. If it fails, the keyboard still does everything.
function enableVtInput() {
  const cs = 'using System; using System.Runtime.InteropServices; public static class FleetViewConsole { ' +
    '[DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int n); ' +
    '[DllImport("kernel32.dll")] public static extern bool GetConsoleMode(IntPtr h, out uint m); ' +
    '[DllImport("kernel32.dll")] public static extern bool SetConsoleMode(IntPtr h, uint m); }';
  const ps = `Add-Type -TypeDefinition '${cs}'; $h = [FleetViewConsole]::GetStdHandle(-10); $m = 0; ` +
    `if ([FleetViewConsole]::GetConsoleMode($h, [ref]$m)) { [void][FleetViewConsole]::SetConsoleMode($h, (($m -bor 0x280) -band (-bnot 0x40))) }`;
  try {
    // stdin is inherited so the helper sees this console's input handle; no window of its own
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: ['inherit', 'ignore', 'ignore'] });
    child.on('error', () => {});
  } catch {}
}

// ---------- web: the same model served as JSON to an app window (web/ holds the page) ----------
const http = require('http');
const WEB_DIR = path.join(__dirname, 'web');
const toHex = (c) => '#' + (c || C.dim).map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));
// whitespace folded, unicode kept (the page has real fonts), cut with … only when longer than n
const plain = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return n && s.length > n ? s.slice(0, n - 1) + '…' : s; };
// the end of a long reply is where its question is: keep the last n characters
const plainTail = (s, n) => { s = plain(s); return s.length > n ? '…' + s.slice(s.length - n + 1) : s; };
const RANK = { ASKING: 0, QUESTION: 1, ERROR: 2, STALLED: 3, WORKING: 4, AGENTS: 4, IDLE: 5, DONE: 6 };

// HEAD of a checkout: its branch name, or a short commit id when detached; re-read every few seconds
const headCache = new Map(); // top -> { at, branch }
function branchOf(top) {
  if (!top) return null;
  const c = headCache.get(top);
  if (c && Date.now() - c.at < 5000) return c.branch;
  let branch = null, detached = false;
  try {
    let gd = path.join(top, '.git');
    if (fs.statSync(gd).isFile()) gd = path.resolve(top, (/gitdir:\s*(.+)/.exec(fs.readFileSync(gd, 'utf8')) || [])[1].trim());
    const head = fs.readFileSync(path.join(gd, 'HEAD'), 'utf8').trim();
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    branch = m ? m[1] : head.slice(0, 7) || null;
    detached = !m;
  } catch {}
  headCache.set(top, { at: Date.now(), branch, detached });
  return branch;
}

// The GitHub repo ("owner/name") a checkout's remote points at (origin first), re-read every minute.
// Worktrees share their main checkout's config, so this is asked of the repo root.
const remoteCache = new Map(); // root -> { at, slug, remote }
function githubOf(root) {
  if (!root) return null;
  const c = remoteCache.get(root);
  if (c && Date.now() - c.at < 60e3) return c.slug ? c : null;
  let slug = null, remote = null, cur = null;
  try {
    for (const line of fs.readFileSync(path.join(root, '.git', 'config'), 'utf8').split(/\r?\n/)) {
      const h = /^\s*\[\s*remote\s+"([^"]+)"\s*\]/.exec(line);
      if (h) { cur = h[1]; continue; }
      if (/^\s*\[/.test(line)) { cur = null; continue; }
      const u = cur && /^\s*url\s*=\s*(.+?)\s*$/.exec(line);
      const m = u && /github\.com[:/]+([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(u[1]);
      if (m && (!slug || cur === 'origin')) { slug = `${m[1]}/${m[2]}`; remote = cur; }
    }
  } catch {}
  const r = { at: Date.now(), slug, remote };
  remoteCache.set(root, r);
  return slug ? r : null;
}
// has this branch been pushed to that remote? (a remote-tracking ref exists, loose or packed); re-read every 10 s
const pushedCache = new Map(); // "root|remote|branch" -> { at, yes }
function pushedBranch(root, remote, branch) {
  const key = `${root}|${remote}|${branch}`;
  const c = pushedCache.get(key);
  if (c && Date.now() - c.at < 10e3) return c.yes;
  const gd = path.join(root, '.git'), ref = `refs/remotes/${remote}/${branch}`;
  let yes = fs.existsSync(path.join(gd, ...ref.split('/')));
  if (!yes) { try { yes = fs.readFileSync(path.join(gd, 'packed-refs'), 'utf8').split(/\r?\n/).some((l) => l.endsWith(' ' + ref)); } catch {} }
  pushedCache.set(key, { at: Date.now(), yes });
  return yes;
}
const OWNER_REPO = /^[\w.-]+\/[\w.-]+$/;
const branchUrl = (slug, branch) => `https://github.com/${slug}/tree/${branch.split('/').map(encodeURIComponent).join('/')}`;

// a reply for the detail panel: line breaks kept, at most n characters; a long one keeps its start and its
// end (where a question usually sits)
function clipReply(text, n = 4000) {
  const t = String(text || '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (t.length <= n) return t || null;
  const tail = Math.floor(n / 3);
  return t.slice(0, n - tail - 5).trimEnd() + '\n\n…\n\n' + t.slice(t.length - tail).trimStart();
}
// the first line of a reply that says something: no blank lines, code, rules, table borders or bare headings
function summaryOf(text, n = 140) {
  const lines = [];
  let fence = false;
  for (const raw of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(raw)) { fence = !fence; continue; }
    if (fence) continue;
    const heading = /^\s*#{1,6}\s/.test(raw);
    const l = raw.replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, '')
      .replace(/^\|\s*|\s*\|$/g, '').replace(/\s*\|\s*/g, ' · ')
      .replace(/\*\*|__|`/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim();
    if (l.length < 4 || /^[-=_*·:\s]+$/.test(l)) continue;
    lines.push({ l, weak: heading || /^\s*\|/.test(raw) || (l.length < 30 && /:$/.test(l)) });
  }
  const best = lines.find((x) => !x.weak) || lines[0];
  return best ? clipWords(best.l, n) : '';
}
// at most n characters, cut between words so a number, price or name is never cut in half
function clipWords(text, n) {
  const t = plain(text);
  if (t.length <= n) return t;
  const cut = t.slice(0, n - 1), sp = cut.lastIndexOf(' ');
  return (sp > n * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s,;:.\-–—(]+$/, '') + '…';
}
// the checkout a session works in: the latest one its tool calls touched in its repo, else its folder's
function topOf(s, root) {
  if (!root) return null;
  for (let i = s.repoVotes.length - 1; i >= 0; i--) { const v = s.repoVotes[i]; if (v.root === root && v.top) return v.top; }
  const g = s.cwd && gitInfo(path.join(s.cwd, '_'));
  return g && g.root === root ? g.top : root;
}

// Which account a conversation runs on. Both accounts can share one projects folder (a junction), and /swap
// changes who pays without changing the folder, so the running claude process is asked: every live one has a
// <pid>.json in <config>/sessions naming its conversation, and its environment says the account
// (CLAUDE_SWAP_PAYER from the claude-a loop, else a B token, else CLAUDE_CONFIG_DIR ~/.claude-<x> = X, else B).
// The answer is kept per conversation for the rest of the run; one without a live process keeps its folder's.
const procAccount = new Map(); // "pid:sessionId" -> account letter | null (unreadable)
const liveAccount = new Map(); // sessionId -> account letter
let procBusy = false;
const ENV_PS = `$cs = @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class FvEnv {
  [StructLayout(LayoutKind.Sequential)] struct PBI { public IntPtr a; public IntPtr Peb; public IntPtr b; public IntPtr c; public IntPtr d; public IntPtr e; }
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int k, ref PBI p, int l, out int r);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(int a, bool i, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr h, IntPtr a, byte[] b, IntPtr n, out IntPtr r);
  static IntPtr Ptr(IntPtr h, IntPtr a) { var b = new byte[8]; IntPtr r; return ReadProcessMemory(h, a, b, (IntPtr)8, out r) ? (IntPtr)BitConverter.ToInt64(b, 0) : IntPtr.Zero; }
  public static string Get(int pid) {
    IntPtr h = OpenProcess(0x0410, false, pid);
    if (h == IntPtr.Zero) return null;
    try {
      var p = new PBI(); int rl;
      if (NtQueryInformationProcess(h, 0, ref p, Marshal.SizeOf(p), out rl) != 0) return null;
      IntPtr pp = Ptr(h, p.Peb + 0x20); if (pp == IntPtr.Zero) return null;
      IntPtr env = Ptr(h, pp + 0x80); if (env == IntPtr.Zero) return null;
      long n = Ptr(h, pp + 0x3F0).ToInt64(); if (n <= 0 || n > 1048576) n = 65536;
      var b = new byte[n]; IntPtr r;
      ReadProcessMemory(h, env, b, (IntPtr)n, out r);
      return r.ToInt64() > 0 ? Encoding.Unicode.GetString(b, 0, (int)r.ToInt64()) : null;
    } finally { CloseHandle(h); }
  }
}
'@
Add-Type -TypeDefinition $cs
foreach ($id in $env:FV_PIDS.Split(',')) {
  $e = [FvEnv]::Get([int]$id); $cfg = ''; $payer = ''; $tok = 0
  if ($e) { foreach ($kv in $e.Split([char]0)) {
    if ($kv -like 'CLAUDE_CONFIG_DIR=*') { $cfg = $kv.Substring(18) } elseif ($kv -like 'CLAUDE_SWAP_PAYER=*') { $payer = $kv.Substring(18) } elseif ($kv -like 'CLAUDE_CODE_OAUTH_TOKEN=*') { $tok = 1 } } }
  "$id|$(if ($e) { 1 } else { 0 })|$cfg|$payer|$tok"
}`;
const accountFor = (s) => liveAccount.get(s.id) || acctId(s.account);
// The live claude processes, from the same <config>/sessions/<pid>.json files: sessionId -> { pid, at, status,
// waitingFor, statusAt }, the newest file per conversation (a conversation open twice: the one that spoke last).
// A file whose pid is gone (claude was killed before it could remove it) does not count. Read on every poll: a few small files and a
// process.kill(pid, 0) each, no PowerShell. /state's "openElsewhere" comes from it. Fleet View's own hosted
// sessions write these files too; the page knows which ones it hosts and ignores the flag for them.
// status is 'busy', 'idle' or 'waiting' (else null); waitingFor says on what while it waits: 'dialog open' (a
// panel such as /usage), "approve Bash(…)", a question's text, "input needed". The state rules read both.
let liveProcs = new Map();
// The fleet-view-feed mod (mod/fleet-view-feed) writes <LOG_DIR>\live\<sessionId>.json from inside each claude
// on every turn start and end and every tool call: { loadedAt, turnOpen, turnAt, lastTurn, tools }. It counts
// only when written by the claude that runs now (loaded after that process started); then it, not the log,
// says whether a turn is open and which tools run (feedOf).
const FEED_DIR = path.join(LOG_DIR, 'live');
function readFeed(sid, startedAt) {
  const j = readJson(path.join(FEED_DIR, `${sid}.json`));
  if (!j || j.v !== 1 || j.sessionId !== sid || !(j.loadedAt >= (startedAt || 0) - 5000)) return null;
  const tools = (Array.isArray(j.tools) ? j.tools : []).filter((t) => t && typeof t.tool === 'string' && Number.isFinite(t.at))
    .map((t) => ({ tool: t.tool.slice(0, 60), what: typeof t.what === 'string' ? t.what.slice(0, 160) : '', agent: typeof t.agent === 'string' ? t.agent : null, at: t.at }));
  return { turnOpen: j.turnOpen === true, turnAt: Number.isFinite(j.turnAt) ? j.turnAt : null, lastTurn: j.lastTurn && typeof j.lastTurn.reason === 'string' ? j.lastTurn : null, tools, at: j.at || 0 };
}
// one file per conversation ever run: those untouched for 3 days go (at start, then hourly)
function pruneFeeds(now = Date.now()) {
  for (const f of ls(FEED_DIR)) {
    if (!f.endsWith('.json')) continue;
    try { const fp = path.join(FEED_DIR, f); if (now - fs.statSync(fp).mtimeMs > 3 * 86400e3) fs.unlinkSync(fp); } catch {}
  }
}
// the feed, once it has seen a turn in this process. Before that the log decides: a conversation killed
// mid-turn and resumed has no open turn in its new claude, and is STALLED? (tell it to continue) by its log.
// With it, a turn open in claude is WORKING while a tool runs, however long (a build, a test run), and
// STALLED? only after 15 quiet minutes with none; one it closed is closed, whatever the log's tail says.
const feedOf = (lp) => (lp && lp.feed && (lp.feed.turnOpen || lp.feed.lastTurn) ? lp.feed : null);
const LIVE_STATUS = new Set(['busy', 'idle', 'waiting']), PANEL_OPEN = 'dialog open';
const pidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};
function scanLiveProcs() {
  if (DEMO) return;
  const byId = new Map(), seenDirs = new Set();
  for (const r of roots().concat(ROOT_OPT ? [] : acctFolders().map((a) => ({ dir: path.join(acctDir(a), 'projects') })))) {
    const dir = path.join(path.dirname(r.dir), 'sessions');
    let real = dir;
    try { real = fs.realpathSync(dir).toLowerCase(); } catch { continue; }
    if (seenDirs.has(real)) continue;
    seenDirs.add(real);
    for (const f of ls(dir)) {
      if (!/^\d+\.json$/.test(f)) continue;
      const j = readJson(path.join(dir, f));
      if (!j || typeof j.sessionId !== 'string' || !Number.isInteger(j.pid) || !pidAlive(j.pid)) continue;
      const at = j.updatedAt || j.startedAt || 0, old = byId.get(j.sessionId);
      const wf = typeof j.waitingFor === 'string' ? j.waitingFor.trim().slice(0, 300) : '';
      if (!old || at > old.at) byId.set(j.sessionId, { pid: j.pid, at, startedAt: j.startedAt || 0,status: LIVE_STATUS.has(j.status) ? j.status : null, waitingFor: wf || null, statusAt: j.statusUpdatedAt || at });
    }
  }
  for (const [sid, p] of byId) p.feed = readFeed(sid, p.startedAt);
  liveProcs = byId;
  // a claude that went on in another conversation (/clear starts a new one, /resume opens another): the same
  // process (pid and start time) under a new sessionId. Its team follows it (successorOf).
  const now = Date.now();
  for (const [sid, p] of byId) {
    const was = procConv.get(p.pid);
    if (was && was.startedAt === p.startedAt && was.id !== sid && UUID_RE.test(was.id)) cleared.set(was.id.toLowerCase(), { to: sid.toLowerCase(), at: now });
  }
  procConv = new Map([...byId].map(([sid, p]) => [p.pid, { id: sid, startedAt: p.startedAt }]));
  for (const [id, c] of cleared) if (now - c.at > 24 * 3600e3) cleared.delete(id);
}
let procConv = new Map(); // claude pid -> { id, startedAt } at the last scan
function accountsFromProcesses() {
  if (DEMO || process.platform !== 'win32' || procBusy) return;
  const byId = liveProcs;
  for (const [sid, p] of byId) { const a = procAccount.get(`${p.pid}:${sid}`); if (a) liveAccount.set(sid, a); }
  const ask = [...byId].filter(([sid, p]) => !procAccount.has(`${p.pid}:${sid}`));
  if (!ask.length) return;
  procBusy = true;
  const enc = Buffer.from(ENV_PS, 'utf16le').toString('base64');
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], { timeout: 30000, windowsHide: true, env: { ...process.env, FV_PIDS: ask.map(([, p]) => p.pid).join(',') } }, (err, out) => {
    procBusy = false;
    const got = new Map();
    for (const line of String(out || '').split(/\r?\n/)) {
      const [pid, ok, cfg, payer, tok] = line.trim().split('|');
      if (!pid) continue;
      got.set(+pid, ok !== '1' ? null : /^[a-z]$/i.test(payer || '') ? payer.toUpperCase() : tok === '1' ? 'B' : accountOf((cfg || '').replace(/[\\/]+$/, '') + '/'));
    }
    for (const [sid, p] of ask) {
      if (!got.has(p.pid) && err) continue; // the helper failed: try again next round
      const a = got.get(p.pid) ?? null;
      procAccount.set(`${p.pid}:${sid}`, a);
      if (a) liveAccount.set(sid, a);
    }
  });
}

function progressOf(s, now) {
  const wf = s.wf;
  if (wf && (!wf.done || now - wf.jm < 30 * 60e3)) return { mode: 'plan', pct: clamp01(wf.target), done: wf.done === 'completed', phase: wf.phases[wf.cur] || null };
  const v = shipOf(s).value;
  return { mode: 'ship', pct: clamp01(v), done: v >= 1, phase: null };
}

// the running plan's agents plus plain subagents, with the same ids the terminal map uses
function agentsOf(s, now) {
  const ags = [];
  if (s.wf && (!s.wf.done || now - s.wf.jm < 30 * 60e3)) s.wf.agents.forEach((a, i) => ags.push({ id: `a:${s.id}:${s.wf.runId}:${i}`, label: plain(a.label || 'agent', 60), state: a.state, phase: a.phase || null }));
  for (const [f, a] of s.agents) if (!f.includes(`${path.sep}workflows${path.sep}`)) ags.push({ id: `a:${s.id}:${hashOf(f.toLowerCase()).toString(36)}`, label: plain(a.label || 'agent', 60), state: now - a.mtime < 90e3 ? 'run' : 'done', phase: null });
  return ags.slice(-20);
}

function waitingOf(s) {
  const last = s.lastAction ? `${s.lastAction.verb} ${s.lastAction.what}` : '';
  if (s.state === 'ASKING') return plain(s.liveWait ? s.liveWait.text : s.askText || s.lastSaid || 'question for you', 300) || null;
  if (s.state === 'QUESTION') return plainTail(String(s.lastSaid || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(-3).join(' '), 300) || null;
  if (s.state === 'STALLED') return s.stoppedIdle ? 'stopped mid-turn; its session is idle (tell it to continue)' : plainTail(s.lastSaid || last, 300) || null;
  return null;
}

const fileAbs = (f) => f.abs || (f.root ? path.join(f.root, ...f.rel.split('/')) : f.rel);

// ---------- handoffs (handoff.js): who handed off to whom ----------
// The handoff folder is read at most every 3 s (each file once per mtime).
let hoCache = null, hoAt = 0, hoLimit = HO.DEFAULT_LIMIT;
function handoffLinks(now = Date.now()) {
  if (DEMO) return { bySession: new Map(), byNext: new Map() };
  if (!hoCache || now - hoAt > 3000) {
    hoAt = now;
    try {
      hoCache = HO.readAll(); hoLimit = HO.limit();
      // a pickup named in a recent handoff that the list doesn't have yet: look for its log now, not at the next 8 s sweep
      if ([...hoCache.byNext].some(([id, r]) => now - r.created < 10 * 60e3 && !sessions.has(id) && !passed.has(id))) setImmediate(() => { try { discover(); } catch {} });
    } catch (e) { hoCache = hoCache || { bySession: new Map(), byNext: new Map() }; logOnce('handoffs:' + (e && e.message), `handoffs: could not read\n${errorText(e)}`); }
  }
  return hoCache;
}
const titleOf = (id) => { const x = sessions.get(id); return x ? plain(baseName(x) || x.name || '') || null : null; };
// { handoff: { next, nextName, at } | null, pickedUpFrom: { id, name, file } | null } for /state (file: the handoff summary)
function handoffOf(s, now) {
  if (s.demo) {
    // the demo's handoff chain: demo.handedOffTo / demo.pickedUpFrom name another demo conversation
    const by = (name) => [...sessions.values()].find((x) => x.demo && x.demo.name === name) || null;
    const nx = s.demo.handedOffTo ? by(s.demo.handedOffTo) : null, pf = s.demo.pickedUpFrom ? by(s.demo.pickedUpFrom) : null;
    return { handoff: nx ? { next: nx.id, nextName: nx.name, at: Math.round(s.turnEndT || now) } : null, pickedUpFrom: pf ? { id: pf.id, name: pf.name } : null };
  }
  const L = handoffLinks(now);
  const h = L.bySession.get(s.id);
  // the successor: named in the handoff (next_session) or its state file; else the conversation that ran
  // `/pickup <this file>`
  let from = L.byNext.get(s.id) || null;
  if (!from && s.pickupArg) {
    const want = path.basename(s.pickupArg).toLowerCase();
    for (const r of L.bySession.values()) if (path.basename(r.file).toLowerCase() === want) { from = r; break; }
  }
  let next = h ? h.next : null;
  if (h && !next) for (const x of sessions.values()) if (x.pickupArg && path.basename(x.pickupArg).toLowerCase() === path.basename(h.file).toLowerCase()) { next = x.id; break; }
  return {
    handoff: h && (next || h.handedOffAt || s.state === 'DONE') ? { next, nextName: next ? titleOf(next) : null, at: Math.round(h.handedOffAt || h.created) } : null,
    pickedUpFrom: from && from.session !== s.id ? { id: from.session, name: titleOf(from.session) || (from.title ? plain(from.title, 80) : null), file: from.file || null } : null,
  };
}

function sessionJson(s, now) {
  refreshHue(s, now);
  const st = STATE[s.state] || STATE.IDLE;
  const root = s.root || null;
  const top = s.demo ? null : topOf(s, root);
  const worktree = s.demo ? s.demo.worktree || null : top && root && path.resolve(top).toLowerCase() !== path.resolve(root).toLowerCase() ? path.basename(top) : null;
  const sh = shipOf(s);
  const prog = progressOf(s, now);
  const spark = new Array(20).fill(0);
  for (const t of s.events) { const i = 19 - Math.floor((now - t) / 60e3); if (i >= 0 && i < 20) spark[i]++; }
  const used = s.ctxUsed || 0;
  const wf = s.wf;
  const head = s.demo ? null : branchOf(top);
  const branch = s.demo ? s.demo.branch || null : head || s.gitBranch || null;
  const named = !!branch && (s.demo || !head || !headCache.get(top)?.detached);
  const ghr = s.demo ? (s.demo.slug ? { slug: s.demo.slug } : null) : githubOf(root);
  const shp = s.lastPr ? ships.get(`${s.repo}#${s.lastPr}`) : null;
  const ended = s.state === 'DONE' || s.state === 'QUESTION';
  const side = sideOf(s, root);
  const team = teamOf(s.id);
  return {
    id: s.id,
    name: plain(baseName(s) || s.name || s.id.slice(0, 8)),
    // renamed in Fleet View (POST /rename): the name above is that one, not Claude Code's own title
    renamed: !!names.get(s.id),
    account: accountFor(s),
    state: s.state, label: st.label, stateColor: toHex(st.color),
    hue: toHex(s.hue),
    repo: root ? { root, name: repoName(root), color: toHex(familyColor(root)) } : null,
    // moved to its repo by hand ("Move to workspace"), itself or the conversation it picked up from
    moved: !s.demo && !!movedRootOf(s),
    // where its work goes ("Push to"): its own choice (null: it follows the repo's) and the repo's (production by default)
    push: { own: pushTargetOf(s), repo: repoPushTarget(root) || 'production' },
    // its last prompt or reply (last is the log's time, which a resumed claude moves with cost records)
    active: Math.round(s.actT || 0),
    branch,
    worktree,
    model: s.model || null,
    // what it runs before its first reply names a model (the account's default; 'opus', 'sonnet' and the like are aliases)
    defaultModel: s.demo ? null : defaultModelOf(s.projRoot),
    effort: s.effort || null,
    fast: typeof s.fast === 'boolean' ? s.fast : null,
    // handoff: the context size it checkpoints itself at (handoff.js), for the "182k / 200k" readout
    context: used ? { used, limit: ctxLimit(s), handoff: hoLimit } : null,
    ...handoffOf(s, now),
    goal: plain(wf && !wf.done ? wf.desc || wf.name : s.prompt, 400) || null,
    lastAction: s.lastAction ? { t: Math.round(s.lastAction.t), who: s.lastAction.who, verb: s.lastAction.verb, what: s.lastAction.what } : null,
    waitingOn: waitingOf(s),
    // the tool calls running right now, from the fleet-view-feed mod (null without it): main's and its subagents'
    running: s.running && s.running.length ? s.running.map((r) => ({ tool: r.tool, what: plain(r.what, 160), agent: r.agent, at: Math.round(r.at) })) : null,
    // what it runs in the background (a shell, an async agent or workflow): servers do not count as work
    background: (s.bgList || []).map((b) => ({ label: b.label, t: Math.round(b.t), server: !!b.server })),
    turnStart: s.promptAt || null,
    last: s.last || s.mtime || now,
    tokens: s.tokens || 0, cost: s.cost || 0, usagePending: !!s.usagePending,
    spark,
    progress: prog,
    agents: agentsOf(s, now),
    ship: { pr: s.lastPr || null, repo: s.repo || null, steps: sh.steps.map(([k, v]) => [k, v]), fresh: !!sh.fresh, app: sh.app || null },
    // parity repos (parityRule): which sides it wrote, and its partner on the other side or the side it left out
    // (filled in by buildState, which sees every conversation); null in a repo with no parity rule
    side,
    parity: side ? { partner: null, missing: null } : null,
    team: team ? team.id : null,
    planSteps: prog.mode === 'plan' ? wf.phases.map((p, i) => {
      const done = wf.done === 'completed';
      return { name: p, state: done || i < wf.cur ? 'past' : i === wf.cur ? 'current' : 'future' };
    }) : null,
    files: [...s.files.values()].sort((a, b) => b.t - a.t).slice(0, 40).map((f) => ({ key: f.key, rel: f.rel, root: f.root || null, abs: fileAbs(f), t: f.t, wrote: !!f.wrote })),
    calls20: s.events.filter((t) => now - t < 20 * 60e3).length,
    // the detail panel: the latest reply in full (or, while it asks, the question and its choices), its own
    // recent tool calls, and where its PR, branch, deploy and folder are
    lastReply: clipReply(s.state === 'ASKING' && !s.liveWait && s.askFull ? s.askFull : s.lastReply),
    calls: [...s.calls].sort((a, b) => b.t - a.t).slice(0, 30).map((c) => ({ t: Math.round(c.t), who: c.who, verb: c.verb, what: c.what, file: c.file || null })),
    links: {
      pr: s.lastPr && OWNER_REPO.test(s.repo || '') ? `https://github.com/${s.repo}/pull/${s.lastPr}` : null,
      branch: named && ghr && (s.demo || pushedBranch(root, ghr.remote, branch)) ? branchUrl(ghr.slug, branch) : null,
      deploy: shp && shp.merged && shp.deployUrl ? shp.deployUrl : null,
      repoFolder: top || root || null,
    },
    endedAt: ended ? Math.round(endedAtOf(s)) : null,
    // where its last command ran: the desktop window starts its live session (claude --resume) there
    cwd: s.demo ? null : s.cwd || null,
    // a live claude process has this conversation open (a terminal, or Fleet View's own Session tab)
    openElsewhere: s.demo ? false : liveProcs.has(s.id),
  };
}

// the context window a conversation has: 1M for a [1m] model or one that ever went past 200k, else 200k
const ctxLimit = (s) => (/\[1m\]/i.test(s.model || '') || (s.ctxUsed || 0) > 200000 || s.ctxBig ? 1000000 : 200000);
// the checkout a conversation works in and its branch: { root, top, branch, named } (named: a branch, not a
// detached HEAD's commit id)
function branchInfo(s) {
  const root = s.root || null;
  if (s.demo) return { root, top: root && s.demo.worktree ? path.join(root, '.claude', 'worktrees', s.demo.worktree) : root, branch: s.demo.branch || null, named: !!s.demo.branch };
  const top = topOf(s, root);
  const head = branchOf(top);
  const branch = head || s.gitBranch || null;
  return { root, top, branch, named: !!branch && (!head || !headCache.get(top)?.detached) };
}

// ---------- parity partners (see parityRule) ----------
// A conversation that wrote files on one side only (web or app) is paired with another unfinished conversation
// in the same repo that wrote the other side and shares its branch (not main or master), its PR or its team.
// Without one, and when it has not even read a file on the other side, the side it left out is `missing`.
const MAIN_BRANCHES = new Set(['main', 'master']);
function parityPass(out) {
  for (const j of out) {
    if (!j.side) continue;
    const mine = j.side.web && !j.side.app ? 'web' : j.side.app && !j.side.web ? 'app' : null;
    if (!mine) continue;
    const other = mine === 'web' ? 'app' : 'web';
    const sameBranch = (x) => !!j.branch && x.branch === j.branch && !MAIN_BRANCHES.has(String(j.branch).toLowerCase());
    const samePr = (x) => !!j.ship.pr && x.ship.pr === j.ship.pr && x.ship.repo === j.ship.repo;
    const cands = out.filter((x) => x !== j && x.state !== 'DONE' && x.side && x.side[other] && x.repo && j.repo && rootKey(x.repo.root) === rootKey(j.repo.root));
    // a teammate first, then one on its PR, then one on its branch
    const partner = cands.find((x) => !!j.team && x.team === j.team) || cands.find(samePr) || cands.find(sameBranch) || null;
    const touched = j.side.touched || {};
    j.parity = { partner: partner ? partner.id : null, missing: !partner && !touched[other] ? other : null };
  }
}

// ---------- conflicts: unfinished conversations about to step on each other ----------
//   branch     two or more on the same branch name in one repo (not main, master or a detached HEAD)
//   worktree   two or more live ones in the same worktree folder (not the main checkout)
//   migration  two or more that wrote a migration with the same number in one repo (…/migration(s)/<nnn>_…)
// Each is { id: 'k:<kind>:<label>', kind, label, root, sessions: [ids] }, plus path (worktree) or
// files: [{ sid, rel, abs }] (migration). A branch conflict whose conversations all share one worktree is left
// to the worktree one.
const MIGRATION_RE = /\/migrations?\/(\d{3,})[_-]/i;
function conflictsOf(list) {
  const groups = new Map();
  const add = (kind, key, label, root, id, extra) => {
    let g = groups.get(kind + '|' + key);
    if (!g) groups.set(kind + '|' + key, (g = { kind, label, root, ids: new Set(), ...extra, files: extra && extra.files ? [] : undefined }));
    g.ids.add(id);
    if (extra && extra.files) g.files.push(...extra.files);
  };
  const now = Date.now();
  for (const s of list) {
    if (!s.state || s.state === 'DONE') continue;
    refreshHue(s, now); // its repo (s.root), worked out again every few seconds
    if (!s.root) continue;
    const b = branchInfo(s);
    if (b.named && b.branch && !MAIN_BRANCHES.has(b.branch.toLowerCase())) add('branch', `${rootKey(b.root)}|${b.branch}`, b.branch, b.root, s.id);
    const live = !!s.demo || liveProcs.has(s.id) || s.state === 'WORKING' || s.state === 'AGENTS';
    if (live && b.top && rootKey(b.top) !== rootKey(b.root)) add('worktree', rootKey(b.top), path.basename(b.top), b.root, s.id, { path: b.top });
    for (const f of s.files.values()) {
      if (!f.wrote || !f.root) continue;
      const m = MIGRATION_RE.exec('/' + f.rel);
      if (m) add('migration', `${rootKey(f.root)}|${m[1]}`, '#' + m[1], f.root, s.id, { files: [{ sid: s.id, rel: f.rel, abs: fileAbs(f) }] });
    }
  }
  const out = [], ids = new Set(), sets = new Set();
  const all = [...groups.values()].filter((g) => g.ids.size >= 2);
  for (const g of all) if (g.kind === 'worktree') sets.add([...g.ids].sort().join(','));
  for (const g of all.sort((a, b) => a.kind.localeCompare(b.kind) || String(a.label).localeCompare(String(b.label)))) {
    const members = [...g.ids].sort();
    if (g.kind === 'branch' && sets.has(members.join(','))) continue;
    let id = `k:${g.kind}:${g.label}`;
    if (ids.has(id)) id += `@${repoName(g.root)}`;
    for (let n = 2; ids.has(id); n++) id = `k:${g.kind}:${g.label}@${repoName(g.root)}#${n}`;
    ids.add(id);
    const c = { id, kind: g.kind, label: g.label, root: g.root, sessions: members };
    if (g.path) c.path = g.path;
    if (g.files) c.files = g.files.slice(0, 20);
    out.push(c);
  }
  return out;
}
// a 'conflict' alert for each new entry, once (one gone for 10 minutes counts as new when it comes back);
// the ones there when Fleet View starts are taken as known
const conflictSeen = new Map(); // id -> last time it was there
let conflictsReady = false;
function checkConflicts(now) {
  const list = conflictsOf([...sessions.values()].filter(inState));
  for (const c of list) {
    const known = conflictSeen.has(c.id);
    conflictSeen.set(c.id, now);
    if (known || !conflictsReady) continue;
    const s = sessions.get(c.sessions[0]);
    if (!s) continue;
    const others = c.sessions.slice(1).map((id) => sessions.get(id)?.name || id.slice(0, 8)).join(', ');
    const text = c.kind === 'branch' ? `is on branch ${c.label} with ${others}` : c.kind === 'worktree' ? `shares the worktree ${c.label} with ${others}` : `wrote migration ${c.label}, and so did ${others}`;
    raise(s, text, c.kind === 'branch' ? C.gold : C.red, 'conflict', { conflict: c.id });
  }
  for (const [id, t] of conflictSeen) if (now - t > 10 * 60e3) conflictSeen.delete(id);
  conflictsReady = true;
}

// ---------- worktrees: every git worktree of the repos on the map ----------
// From `git worktree list --porcelain` (each one's folder, branch and HEAD commit) and the time of each HEAD
// commit (what `git -C <path> log -1 --format=%ct` says, asked for all of them in one `git log --no-walk` in the
// repo, so a repo with 150 worktrees costs two git calls, not 151). Run in the background (never in a request or
// the poll), at most every 60 s per repo and two repos at a time, with a timeout; /state uses what was read last.
// The main checkout, bare and prunable entries (their folder is gone) are left out. /state lists at most 150 per
// repo (a repo can collect hundreds): every live one, then the most recently committed.
const wtCache = new Map(); // rootKey -> { root, at, busy, list: [{ path, branch, lastCommit }] }
let wtRunning = 0;
const WT_STALE_MS = 3 * 24 * 3600e3, WT_MAX = 2000, WT_SHOW = 150;
const gitAsync = (args, timeout = 10000) => new Promise((res) => {
  try {
    execFile('git', args, { timeout, windowsHide: true, maxBuffer: 4 << 20 }, (err, out) => res(err ? null : String(out)));
  } catch { res(null); }
});
async function refreshWorktrees(root) {
  const k = rootKey(root);
  let c = wtCache.get(k);
  if (!c) wtCache.set(k, (c = { root, at: 0, busy: false, list: [] }));
  if (c.busy || Date.now() - c.at < 60e3) return;
  c.busy = true; c.at = Date.now(); wtRunning++;
  try {
    if (!fs.existsSync(path.join(root, '.git'))) { c.list = []; return; }
    const out = await gitAsync(['-C', root, 'worktree', 'list', '--porcelain']);
    if (out == null) return; // keep the last list
    const items = [];
    let cur = null;
    for (const line of out.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) items.push((cur = { path: path.resolve(winPath(line.slice(9).trim())), branch: null, head: null, skip: false }));
      else if (!cur) continue;
      else if (line.startsWith('HEAD ')) cur.head = /^[0-9a-f]{40,64}$/i.test(line.slice(5).trim()) && !/^0+$/.test(line.slice(5).trim()) ? line.slice(5).trim().toLowerCase() : null;
      else if (line.startsWith('branch ')) cur.branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
      else if (line === 'bare' || line.startsWith('prunable')) cur.skip = true;
    }
    // the first entry is the main checkout
    const wts = items.slice(1).filter((w) => !w.skip && rootKey(w.path) !== k).slice(0, WT_MAX);
    // the commit time of every HEAD, 200 commits a call
    const times = new Map();
    const heads = [...new Set(wts.map((w) => w.head).filter(Boolean))];
    for (let i = 0; i < heads.length; i += 200) {
      const lo = await gitAsync(['-C', root, 'log', '--no-walk=unsorted', '--format=%H %ct', ...heads.slice(i, i + 200)], 15000);
      for (const l of String(lo || '').split(/\r?\n/)) { const m = /^([0-9a-f]{40,64}) (\d+)$/i.exec(l.trim()); if (m) times.set(m[1].toLowerCase(), Number(m[2]) * 1000); }
    }
    c.list = wts.map((w) => {
      const old = c.list.find((x) => rootKey(x.path) === rootKey(w.path));
      return { path: w.path, branch: w.branch, lastCommit: (w.head && times.get(w.head)) || (old ? old.lastCommit : 0) };
    });
  } finally { c.busy = false; wtRunning--; }
}
// the worktrees of these repo roots as /state lists them; starts a background refresh where one is due
function worktreesOf(roots, list, now) {
  const tops = new Set();
  for (const s of list) if (s.state && s.state !== 'DONE') { const b = branchInfo(s); if (b.top) tops.add(rootKey(b.top)); }
  const out = [];
  for (const root of roots) {
    if (!root || isHomeRoot(root)) continue;
    if (DEMO) { for (const w of demoWorktrees(root, now)) out.push({ ...w, live: tops.has(rootKey(w.path)), stale: !tops.has(rootKey(w.path)) && w.lastCommit > 0 && now - w.lastCommit > WT_STALE_MS }); continue; }
    const c = wtCache.get(rootKey(root));
    if ((!c || (!c.busy && now - c.at >= 60e3)) && wtRunning < 2) refreshWorktrees(root).catch((e) => logOnce('worktrees:' + (e && e.message), `worktrees of ${root} failed\n${errorText(e)}`));
    if (!c) continue;
    const mine = c.list.map((w) => {
      const live = tops.has(rootKey(w.path));
      return { root, path: w.path, name: path.basename(w.path), branch: w.branch, live, lastCommit: w.lastCommit, stale: !live && w.lastCommit > 0 && now - w.lastCommit > WT_STALE_MS };
    });
    if (mine.length > WT_SHOW) mine.sort((a, b) => b.live - a.live || b.lastCommit - a.lastCommit).splice(WT_SHOW);
    out.push(...mine);
  }
  return out;
}

// ---------- teams (see TEAMS_MAX) ----------
const teamOf = (id) => (id ? teams.find((t) => t.members.includes(String(id).toLowerCase())) || null : null);
const teamJson = (t) => ({ id: t.id, name: t.name, color: t.color, members: [...t.members], lead: t.lead || null, order: t.order, at: t.at, messages: t.messages.slice(-TEAM_MSGS_MAX).map((m) => ({ ...m })),
  successors: (t.successors || []).map((x) => ({ ...x })) });
// a member as briefs and notes name it: its name, repo and branch, as /state shows them
function memberOf(id) {
  const s = sessions.get(id);
  if (!s) return { id, name: nameNow(id, null) || String(id).slice(0, 8), repo: 'no workspace', branch: null };
  const root = s.root || null;
  return { id, name: plain(baseName(s) || s.name || id.slice(0, 8), 80), repo: root ? repoName(root) : 'no workspace',
    branch: (s.demo ? s.demo.branch : branchOf(topOf(s, root)) || s.gitBranch) || null };
}
const memberLine = (m) => `- ${m.name} (id ${m.id}, repo ${m.repo}, branch ${m.branch || 'none'})`;
// members talk with fv, which is on the PATH of the sessions Fleet View starts
const talkLine = (me) => `Talk to them directly: fv send <their id> "message" --from ${me}.`;
// The text a member gets with the team's order: the order, its teammates and how to reach them. This is the one
// copy: POST /teams with send types it into each member (web/orders.js keeps a fallback only for ?fixture=1).
function teamBrief(t, me) {
  const others = t.members.filter((m) => m !== me).map(memberOf);
  return [`[Fleet View order · team "${t.name}"]`, t.order, '', 'You are working together with:', ...others.map(memberLine),
    `${talkLine(me)} Their messages reach you starting with [Message from teammate]. Agree who changes which files before `
    + 'editing, tell them when you push or merge, and reply to their messages.'].join('\n');
}
// the fv commands a lead works with (its brief, and the note that makes it the lead) -> [lines]
function leadCommands(t, me) {
  return [
    `- fv status ${t.id}: what each is doing now, its last reply, branch, PR and context. Free: it costs them nothing, so use it first.`,
    `- fv ask ${t.id} "question" --from ${me}: each answers in its own turn, and the answers come back to you together as one message (slow ones later, one by one). Add --wait to get them printed right here if they answer within 100 seconds (a Bash call stops at 2 minutes). To ask one or a few: fv ask <id> <id> "question" --from ${me}.`,
    `- fv send <id> "instruction" --from ${me}: direct one of them.`,
    `- fv team say ${t.id} "text" --from ${me}: tell them all.`,
    `- fv team add ${t.id} <id> / fv team rm ${t.id} <id>: bring one in, or let one go.`,
    '- fv ls: every conversation.',
  ];
}
// The brief of a team's lead: the order, the members it leads and how to direct them and get information from them
function leadBrief(t, me) {
  const others = t.members.filter((m) => m !== me).map(memberOf);
  return [`[Fleet View order · you lead team "${t.name}"]`, t.order, '', 'You lead:', ...others.map(memberLine), '',
    'How this works: they report to you, and they don\'t coordinate with each other unless you tell them to. Split the work so no '
    + 'two of them edit the same files. The user talks to you; you talk to them. They carry on with what they were doing until '
    + 'you give them their part, so start by giving each its part.',
    ...leadCommands(t, me),
    'Their reports reach you starting with [Message from teammate].'].join('\n');
}
// the lines that tell a member of a team with a lead who leads it and how to report to it -> [lines]
function leadLines(t, me) {
  const lead = memberOf(t.lead);
  return [`Your lead is ${lead.name} (id ${lead.id}, repo ${lead.repo}, branch ${lead.branch || 'none'}): it gives you your part.`,
    `Report to it with fv send ${lead.id} "…" --from ${me} when you finish, when you are blocked, and before you merge.`,
    'Its questions arrive as [Question from your lead …]: just answer in your reply, and Fleet View passes it back; don\'t fv send '
    + 'the answer too. Its instructions arrive as [Message from your lead …].'];
}
// The brief of a member of a team with a lead: the order for context, its lead, how to report, and the others
function memberBrief(t, me) {
  const others = t.members.filter((m) => m !== me && m !== t.lead).map(memberOf);
  return [`[Fleet View order · team "${t.name}"]`, 'The team\'s order, for context:', t.order, '',
    ...leadLines(t, me).map((l, i) => (i ? l : `${l} Carry on with what you're doing until it does.`)),
    ...(others.length ? ['', 'The others in the team (so you know who is who; don\'t message them unless your lead says so):', ...others.map(memberLine)] : []),
  ].join('\n');
}
// the brief a member gets: the lead's, a led member's, or the peers' teamBrief
const briefFor = (t, me) => (!t.lead ? teamBrief(t, me) : me === t.lead ? leadBrief(t, me) : memberBrief(t, me));
// the lines that tell one member who the others in ids are and how to reach them (the notes below). With a lead:
// the lead gets its members and its commands, a member its lead and how to report to it
function contactLines(me, ids, t) {
  const list = ids.filter((m) => m !== me).map(memberOf);
  if (!list.length) return '';
  if (t && t.lead && ids.includes(t.lead)) {
    if (me === t.lead) return ['You lead:', ...list.map(memberLine), ...leadCommands(t, me)].join('\n');
    const rest = list.filter((m) => m.id !== t.lead);
    return [...leadLines(t, me), ...(rest.length ? ['The others (don\'t message them unless your lead says so):', ...rest.map(memberLine)] : [])].join('\n');
  }
  return [list.length === 1 ? 'The other conversation:' : 'The others:', ...list.map(memberLine),
    `${talkLine(me)} Their messages reach you starting with [Message from teammate].`].join('\n');
}
const joinNames = (a) => (a.length < 2 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);

// Text for one conversation, through api.js deliverText (it follows a handoff, waits behind a menu, resumes one that
// is not running). kind 'order' (a brief) may resume it; 'note' (who joined or left) goes only to a conversation
// running now, since every typed note costs a Claude turn. Nothing is typed in the demo.
// -> Promise of { id, name, ok, queued?, message }
async function tell(id, text, kind) {
  const name = memberOf(id).name;
  if (DEMO) return { id, name, ok: false, message: 'the demo types nothing' };
  try {
    const [, r] = await API.deliverText(id, text, { kind }, apiCtx);
    return { id: r.id || id, name, ok: !!r.ok, ...(r.queued ? { queued: true } : {}), message: r.message || '' };
  } catch (e) { return { id, name, ok: false, message: String((e && e.message) || e) }; }
}
// a note to each of ids: the team's prefix, the text and, with contacts, that member's contact lines over those ids
function noteEach(t, ids, text, contacts) {
  return Promise.all(ids.map((id) => tell(id, [`[Fleet View · team "${t.name}"]`, typeof text === 'function' ? text(id) : text,
    ...(contacts ? ['', contactLines(id, contacts, t)] : [])].join('\n').trim(), 'note')));
}
// what a reply says it told: { id, name, ok, queued?, message } each
const toldJson = (rs) => rs.map((r) => ({ id: r.id, name: r.name, ok: r.ok, ...(r.queued ? { queued: true } : {}), message: r.message }));

// Members taken out of the teams they were in (into a new team, or added to another): the teams that lost some,
// with a team left with one member dropped; one that loses its lead has none now (leadGone).
// -> [{ team, gone: [ids], disbanded, leadGone }]
function pullOut(ids, into) {
  const out = [];
  for (const x of teams) {
    if (x === into) continue;
    const gone = x.members.filter((m) => ids.includes(m));
    if (!gone.length) continue;
    x.members = x.members.filter((m) => !ids.includes(m));
    const leadGone = !!x.lead && gone.includes(x.lead);
    if (leadGone) x.lead = null;
    out.push({ team: x, gone, disbanded: x.members.length < 2, leadGone });
  }
  teams = teams.filter((x) => x === into || x.members.length >= 2);
  return out;
}
// what the rest of a team are told when its lead goes: no lead any more, peers again (with contact lines after it)
const NO_LEAD = 'The team has no lead now: carry on with your parts as peers, agree who changes which files before editing, and tell each other when you push or merge.';
// tells the rest of each team pullOut took members from -> Promise of [{ id, name, members, disbanded, told }]
function tellPulled(pulled, into) {
  return Promise.all(pulled.map(async ({ team: x, gone, disbanded, leadGone }) => {
    const text = `${joinNames(gone.map((m) => memberOf(m).name))} left this team to join "${into.name}".`
      + (disbanded ? ` The team "${x.name}" is disbanded: carry on with your own part.` : leadGone ? ` It was your lead. ${NO_LEAD}` : '');
    const told = await noteEach(x, x.members, text, disbanded ? null : x.members);
    return { id: x.id, name: x.name, members: [...x.members], disbanded, told: toldJson(told) };
  }));
}

// POST /teams { members: [ids] (2..12), order, name?, lead? }: a team of exactly those members, led by lead (one of
// them) or of peers (lead null or left out). Each member's brief is briefFor's: the lead's, a led member's, or the
// peers'. The same set as a team that is there already gives that team the new order (and name, and lead when
// lead is given); any other set is a new team, and members pulled
// out of other teams leave them (those teams are told; one left with one member is disbanded). The reply carries
// briefs ({ id: the text that member gets }) and left: the teams pulled from.
// o.send (the API's POST /api/teams, and the page's with send: true): the server sends each member its brief itself,
// as an order, and the reply's sent says how each went. One writer for every team text, so a brief never mixes with
// a note or a teammate's message typed into the same prompt (api.js typeOne).
async function postTeam(b, o = {}) {
  if (!b || typeof b !== 'object') return [400, { ok: false, message: 'bad json' }];
  const raw = Array.isArray(b.members) ? b.members : null;
  if (!raw || raw.some((m) => typeof m !== 'string' || !MEMBER_RE.test(m))) return [400, { ok: false, message: 'members must be conversation ids' }];
  // one that handed off or ran /clear counts as the conversation that carries on (its text would go there)
  const members = [...new Set(raw.map((m) => successorOf(m) || m.toLowerCase()))];
  if (members.length < 2 || members.length > TEAM_MEMBERS_MAX) return [400, { ok: false, message: `a team has 2 to ${TEAM_MEMBERS_MAX} conversations` }];
  if (members.some((m) => !sessions.has(m) && !UUID_RE.test(m))) return [400, { ok: false, message: 'not a conversation Fleet View knows' }];
  if (typeof b.order !== 'string' || !b.order.trim() || b.order.length > 4000) return [400, { ok: false, message: 'order must be text of at most 4000 characters' }];
  if (b.name != null && (typeof b.name !== 'string' || b.name.length > 200)) return [400, { ok: false, message: 'name must be text' }];
  // lead: one of the members (after the same successor mapping), or null for peers; left out keeps a same set's lead
  let lead;
  if (b.lead != null) {
    if (typeof b.lead !== 'string' || !MEMBER_RE.test(b.lead)) return [400, { ok: false, message: 'lead must be a conversation id' }];
    lead = successorOf(b.lead) || b.lead.toLowerCase();
    if (!members.includes(lead)) return [400, { ok: false, message: 'the lead must be one of the members' }];
  } else if ('lead' in b) lead = null;
  const now = Date.now(), order = b.order.replace(/\r\n?/g, '\n').trim();
  const name = plain(b.name, 80) || clipWords(order.split(/\s+/).slice(0, 5).join(' '), 40) || 'team';
  const same = teamOf(members[0]);
  let t, pulled = [];
  if (same && same.members.length === members.length && members.every((m) => same.members.includes(m))) {
    t = same;
    t.order = order; t.at = now; t.seenAt = now;
    if (b.name) t.name = name;
    if (lead !== undefined) t.lead = lead;
  } else {
    pulled = pullOut(members, null);
    const used = new Set(teams.map((x) => x.color));
    t = { id: 't' + require('crypto').randomBytes(5).toString('hex'), name, color: TEAM_COLORS.find((c) => !used.has(c)) || TEAM_COLORS[teams.length % TEAM_COLORS.length],
      members, lead: lead || null, order, at: now, messages: [], successors: [], seenAt: now };
    teams.push(t);
    if (teams.length > TEAMS_MAX) teams.splice(0, teams.length - TEAMS_MAX);
  }
  saveSettings();
  const briefs = Object.fromEntries(t.members.map((m) => [m, briefFor(t, m)]));
  const [left, sent] = await Promise.all([tellPulled(pulled, t), o.send ? Promise.all(t.members.map((m) => tell(m, briefs[m], 'order'))) : null]);
  return [200, { ok: true, team: teamJson(t), briefs, ...(left.length ? { left } : {}), ...(sent ? { sent: toldJson(sent) } : {}) }];
}
// POST /teams/add { id, member, lead? }: one more member. The team keeps its id, colour, order and messages; the member
// leaves the team it was in (told as above). The newcomer gets its brief as an order, the others a note with every
// member's id, the newcomer's too. lead true: the newcomer joins as the team's lead (in place of the lead it had),
// and the others' note says so. -> { ok, team, brief: what the newcomer got, told: the notes, left? }
async function addMember(b) {
  if (b && 'lead' in b && typeof b.lead !== 'boolean') return [400, { ok: false, message: 'lead must be true or false' }];
  if (!b || typeof b.id !== 'string' || typeof b.member !== 'string') return [400, { ok: false, message: 'give the team and the member' }];
  const t = teams.find((x) => x.id === b.id);
  if (!t) return [404, { ok: false, message: 'no such team' }];
  if (!MEMBER_RE.test(b.member.toLowerCase())) return [400, { ok: false, message: 'member must be a conversation id' }];
  // one that handed off or ran /clear joins as the conversation that carries on
  const m = successorOf(b.member) || b.member.toLowerCase();
  if (!MEMBER_RE.test(m) || (!sessions.has(m) && !UUID_RE.test(m))) return [400, { ok: false, message: 'member must be a conversation id' }];
  if (t.members.includes(m)) return [409, { ok: false, message: m === b.member.toLowerCase() ? 'it is in that team already' : `${memberOf(m).name} carries on for it, and is in that team already` }];
  if (t.members.length >= TEAM_MEMBERS_MAX) return [409, { ok: false, message: `a team has at most ${TEAM_MEMBERS_MAX} conversations` }];
  const pulled = pullOut([m], t);
  const old = [...t.members], was = t.lead || null;
  t.members.push(m);
  if (b.lead === true) t.lead = m;
  t.seenAt = Date.now();
  saveSettings();
  const who = memberOf(m).name;
  const note = b.lead !== true ? `${who} joined the team.`
    : (id) => (id === was ? `${who} joined the team and leads it now, in your place: you are a member and report to it.` : `${who} joined the team and leads it now.`);
  const [brief, told, left] = await Promise.all([
    tell(m, briefFor(t, m), 'order'),
    noteEach(t, old, note, t.members),
    tellPulled(pulled, t),
  ]);
  return [200, { ok: true, team: teamJson(t), brief: toldJson([brief])[0], told: toldJson(told), ...(left.length ? { left } : {}) }];
}
// POST /teams/remove { id }: disbands it; every member is told. -> { ok, team (as it was), told }
async function removeTeam(b) {
  if (!b || typeof b.id !== 'string') return [400, { ok: false, message: 'no team given' }];
  const t = teams.find((x) => x.id === b.id);
  if (!t) return [404, { ok: false, message: 'no such team' }];
  teams = teams.filter((x) => x !== t);
  saveSettings();
  const told = await noteEach(t, t.members, `The team "${t.name}" is disbanded. Finish your own part; don't message the others about it any more.`);
  return [200, { ok: true, team: teamJson(t), told: toldJson(told) }];
}
// POST /teams/leave { id, member, why?: 'left' | 'removed', hidden?, quiet? }: one member out. The rest are told
// (with the others' ids; a team left with one member is disbanded, and that one is told so; when the lead goes the
// team has no lead, and they are told to carry on as peers), and so is the member,
// that it left (why 'left') or was taken out ('removed'), unless it was removed from the map (hidden: it is
// ending). quiet: nobody is told (an order that never reached it, orders.js), except that a lead going leaves the
// rest, who were told to wait for it, a note that there is none. -> { ok, disbanded, team (the
// members left), told }
async function leaveTeam(b) {
  if (!b || typeof b.id !== 'string' || typeof b.member !== 'string') return [400, { ok: false, message: 'give the team and the member' }];
  const t = teams.find((x) => x.id === b.id);
  if (!t) return [404, { ok: false, message: 'no such team' }];
  // one that handed off or ran /clear: the conversation that carries on for it (not for quiet, which names the very
  // member an order failed for: never its successor)
  const lc = b.member.toLowerCase();
  const m = t.members.includes(lc) || b.quiet === true ? lc : successorOf(b.member) || lc;
  if (!t.members.includes(m)) return [404, { ok: false, message: 'not in that team' }];
  t.members = t.members.filter((x) => x !== m);
  // the lead going leaves the team with none: the rest are peers again
  const wasLead = t.lead === m;
  if (wasLead) t.lead = null;
  // a team of one is no team
  const disbanded = t.members.length < 2;
  if (disbanded) teams = teams.filter((x) => x !== t);
  saveSettings();
  const out = { ok: true, disbanded, team: teamJson(t), told: [] };
  // quiet, but it was the lead the rest were told to wait for: they hear there is none
  if (b.quiet === true && wasLead) {
    const lost = `${memberOf(m).name} didn't get the order, so it doesn't lead the team.`;
    out.told = toldJson(await (disbanded ? noteEach(t, t.members, `${lost} The team "${t.name}" is disbanded: carry on with the order on your own.`)
      : noteEach(t, t.members, `${lost} ${NO_LEAD}`, t.members)));
  }
  if (b.quiet === true) return [200, out];
  const removed = b.why === 'removed', who = memberOf(m).name;
  const rest = disbanded
    ? noteEach(t, t.members, `${who} ${removed ? 'was taken out' : 'left'}, so the team "${t.name}" is disbanded. Carry on with your own part.`)
    : noteEach(t, t.members, `${who} ${removed ? 'was taken out of the team' : 'left the team'}.${wasLead ? ` It was your lead. ${NO_LEAD}` : ''}`, t.members);
  const self = b.hidden === true ? Promise.resolve([])
    : noteEach(t, [m], removed ? `You were taken out of the team "${t.name}". Carry on with your own part; don't message its members about it.`
      : `You left the team "${t.name}". Carry on with your own part; don't message its members about it unless they message you.`);
  const [a, c] = await Promise.all([self, rest]);
  out.told = toldJson([...a, ...c]);
  return [200, out];
}
// POST /teams/lead { id, member: <id> | null } (and the API's POST /api/teams/:id/lead): sets the team's lead, or
// clears it (null). A new lead gets its brief as an order; the rest a note naming it and how to report to it. Clearing:
// each a note that the team has no lead now, peers again, with their contact lines. -> { ok, team, brief?, told }
async function setLead(b) {
  if (!b || typeof b.id !== 'string') return [400, { ok: false, message: 'give the team' }];
  const t = teams.find((x) => x.id === b.id);
  if (!t) return [404, { ok: false, message: 'no such team' }];
  if (b.member != null && (typeof b.member !== 'string' || !MEMBER_RE.test(b.member))) return [400, { ok: false, message: 'member must be a conversation id, or null for no lead' }];
  // one that handed off or ran /clear: the conversation that carries on for it
  const m = b.member == null ? null : t.members.includes(b.member.toLowerCase()) ? b.member.toLowerCase() : successorOf(b.member) || b.member.toLowerCase();
  if (m && !t.members.includes(m)) return [409, { ok: false, message: 'not a member of that team' }];
  if (m === (t.lead || null)) return [200, { ok: true, team: teamJson(t), told: [], message: m ? `${memberOf(m).name} leads it already` : 'the team has no lead already' }];
  const was = t.lead || null;
  t.lead = m;
  t.seenAt = Date.now();
  saveSettings();
  if (!m) {
    const told = await noteEach(t, t.members, `${memberOf(was).name} doesn't lead the team any more. ${NO_LEAD}`, t.members);
    return [200, { ok: true, team: teamJson(t), told: toldJson(told) }];
  }
  const who = memberOf(m).name;
  const note = (id) => (id === was ? `${who} (id ${m}) leads the team now, in your place: you are a member, it gives you your part, and you report to it.`
    : `${who} (id ${m}) leads the team now: it gives you your part, and you report to it.`);
  const [brief, told] = await Promise.all([tell(m, leadBrief(t, m), 'order'), noteEach(t, t.members.filter((x) => x !== m), note, t.members)]);
  return [200, { ok: true, team: teamJson(t), brief: toldJson([brief])[0], told: toldJson(told) }];
}
// a conversation removed from the map (the page's Remove, the API's remove, a temp session that ended) leaves its
// team; it is ending, so only the rest are told
function leaveOnHide(id) {
  const t = teamOf(id);
  if (!t) return;
  leaveTeam({ id: t.id, member: id, why: 'removed', hidden: true })
    .catch((e) => logOnce('team-hide:' + (e && e.message), `teams: taking a removed conversation out failed\n${errorText(e)}`));
}
// one removed from the map, unless it worked again since (the page's isHidden)
function hiddenNow(id) {
  const h = hidden.find((x) => x.id === id);
  if (!h) return false;
  const s = sessions.get(id);
  return !(s && s.state !== 'DONE' && s.state !== 'QUESTION' && (s.actT || 0) > h.at);
}
// for the API (api.js): a team by id with the members that can be told (not removed from the map), or null
function teamFor(id) {
  const t = teams.find((x) => x.id === id);
  return t ? { id: t.id, name: t.name, lead: t.lead || null, members: t.members.filter((m) => !hiddenNow(m)) } : null;
}
// GET /api/teams: every team, with its members' names, repos, branches, states and which one leads
function teamsList() {
  return teams.map((t) => ({ ...teamJson(t), roster: t.members.map((m) => ({ ...memberOf(m), state: sessions.get(m)?.state || null, removed: hiddenNow(m), lead: t.lead === m })) }));
}
// GET /api/status: what members are doing, free (nothing is typed into them). q: { team, ids, from }: a team's
// members, these conversations, or from's team; none of them: every unfinished conversation not removed from the
// map. Each row: { id, name, repo, branch, state, label, doing, lastReply (≤ 600), lastReplyAt, pr, ctx (0..1), cost,
// removed, lead } (api.js adds queued). -> [code, { ok, team?, members }]
function statusOf(q) {
  let t = null, ids;
  if (q.team) {
    t = teams.find((x) => x.id === q.team);
    if (!t) return [404, { ok: false, message: 'no such team' }];
    ids = [...t.members];
  } else if (q.ids && q.ids.length) {
    ids = [...new Set(q.ids.map((m) => successorOf(m) || m.toLowerCase()))];
  } else if (q.from) {
    t = teamOf(successorOf(q.from) || q.from.toLowerCase());
    if (!t) return [404, { ok: false, message: 'that conversation is in no team: give a team or ids' }];
    ids = [...t.members];
  }
  const st = buildState();
  const byId = new Map(st.sessions.map((s) => [s.id, s]));
  if (!ids) ids = st.sessions.filter((s) => s.state !== 'DONE' && !hiddenNow(s.id)).map((s) => s.id);
  const members = ids.map((id) => {
    const s = byId.get(id), raw = sessions.get(id), m = memberOf(id);
    const lead = t ? t.lead === id : !!(teamOf(id) && teamOf(id).lead === id);
    if (!s) return { id, name: m.name, repo: m.repo, branch: m.branch, state: raw ? raw.state || null : null, label: null, doing: null, lastReply: null, lastReplyAt: null, pr: null, ctx: null, cost: 0, removed: hiddenNow(id), lead };
    const run = s.running && s.running[0];
    const act = s.lastAction;
    const doing = run ? plain(`${run.tool}${run.what ? ' ' + run.what : ''}`, 200)
      : s.state === 'ASKING' && s.waitingOn ? plain(`asking: ${s.waitingOn}`, 200)
        : s.state === 'STALLED' && s.waitingOn ? plain(s.waitingOn, 200)
          : (s.state === 'WORKING' || s.state === 'AGENTS') && act ? plain(`${act.verb} ${act.what || ''}`, 200) : s.label || null;
    const shp = raw && raw.lastPr ? ships.get(`${raw.repo}#${raw.lastPr}`) : null;
    return {
      id, name: s.name, repo: s.repo ? s.repo.name : m.repo, branch: s.branch || null, state: s.state, label: s.label || null, doing,
      lastReply: s.lastReply ? plain(s.lastReply, 600) : null, lastReplyAt: raw && raw.replyAt ? Math.round(raw.replyAt) : null,
      pr: s.ship && s.ship.pr ? { number: s.ship.pr, state: shp ? String(shp.state || '').toLowerCase() || null : null, url: s.links ? s.links.pr : null } : null,
      ctx: s.context && s.context.limit ? Math.round((s.context.used / s.context.limit) * 1000) / 1000 : null,
      cost: Math.round((s.cost || 0) * 100) / 100, removed: hiddenNow(id), lead,
    };
  });
  return [200, { ok: true, ...(t ? { team: { id: t.id, name: t.name, lead: t.lead || null } } : {}), members }];
}

// The conversation that carries on for id: following its handoff (the summary's next session, or the one that
// picked it up) and /clear (cleared, see scanLiveProcs) for up to 8 hops, the last one Fleet View lists (or that
// runs now). null when there is none.
const cleared = new Map(); // id -> { to, at }: its claude went on in another conversation (/clear, /resume)
function successorOf(id) {
  if (typeof id !== 'string' || DEMO) return null;
  let cur = id.toLowerCase(), found = null;
  const seen = new Set([cur]);
  for (let i = 0; i < 8; i++) {
    const s = sessions.get(cur);
    const next = cleared.get(cur)?.to || (s ? handoffOf(s, Date.now()).handoff?.next : null) || null;
    if (!next || seen.has(next)) break;
    seen.add(next);
    if (sessions.has(next) || liveProcs.has(next)) found = next;
    cur = next;
  }
  return found;
}
// a member handed off (or ran /clear): its successor gets the brief (as an order: it runs, it just started; the
// lead's when it took over the lead), the others a note
function handedOn(t, from, to) {
  const was = memberOf(from).name, now = memberOf(to).name;
  const how = cleared.get(from)?.to === to ? `${was} ran /clear and goes on as ${now} (id ${to}).` : `${was} handed off; ${now} (id ${to}) carries on its part.`;
  const note = t.lead === to ? (id) => `${how} It leads the team now: report to it with fv send ${to} "…" --from ${id} from now on.` : `${how} Message that id from now on.`;
  Promise.all([
    tell(to, briefFor(t, to), 'order'),
    noteEach(t, t.members.filter((x) => x !== to), note),
  ]).then(([a, rest]) => logLine(`teams: ${from} handed off to ${to} in "${t.name}": brief ${a.ok ? (a.queued ? 'queued' : 'sent') : `not sent (${a.message})`}, ${rest.filter((x) => x.ok).length} told`),
    (e) => logOnce('team-handoff:' + (e && e.message), `teams: telling a handoff failed\n${errorText(e)}`));
}
// Every poll: a member that handed off or ran /clear is swapped for the conversation that carries on, unless that
// one is in another team. Teams whose members have all been gone from the session list for 24 hours leave; seenAt is
// saved every 10 minutes.
let teamsSavedAt = 0;
function pruneTeams(now) {
  if (!teams.length) return;
  let changed = false;
  const swaps = [];
  for (const t of teams) {
    for (const m of [...t.members]) {
      const to = successorOf(m);
      if (!to || to === m) continue;
      const other = teamOf(to);
      if (other && other !== t) continue;
      // in this team already (added by hand): the old one just goes
      t.members = other === t ? t.members.filter((x) => x !== m) : t.members.map((x) => (x === m ? to : x));
      // the successor of the lead is the lead
      if (t.lead === m) t.lead = to;
      t.successors = [...(t.successors || []), { from: m, to, at: now }].slice(-10);
      changed = true;
      if (other !== t) swaps.push([t, m, to]);
    }
  }
  if (changed) teams = teams.filter((t) => t.members.length >= 2);
  // told once every member is swapped, so each brief and note names (and goes to) the ones that carry on
  for (const [t, m, to] of swaps) if (teams.includes(t)) handedOn(t, m, to);
  for (const t of teams) if (t.members.some((m) => sessions.has(m))) t.seenAt = now;
  const keep = teams.filter((t) => now - (t.seenAt || 0) < TEAM_GONE_MS);
  if (keep.length !== teams.length) { teams = keep; changed = true; }
  if (changed || now - teamsSavedAt > 10 * 60e3) { teamsSavedAt = now; saveSettings(); }
}
// a message one conversation sent another (the API's `from`, scripts/fleet-msg.js): kept in their team's messages
// when both are in one, a feed entry with `to` (the map's comet), and a 'message' alert when they share no team:
// one per sender and receiver every MSG_ALERT_MS, so a back-and-forth outside a team raises one, not one a message.
// o.kind 'question' | 'answer' (api.js's asks) says so in the feed; an answer raises no alert (it is typed into the
// asker anyway)
const MSG_ALERT_MS = 10 * 60e3;
const msgAlertAt = new Map(); // 'from>to' -> when the last 'message' alert for them was raised
function noteMessage(from, to, text, o = {}) {
  if (typeof from !== 'string' || typeof to !== 'string' || !from || !to) return;
  from = UUID_RE.test(from) ? from.toLowerCase() : from;
  to = UUID_RE.test(to) ? to.toLowerCase() : to;
  const now = Date.now();
  const nameOf = (id) => { const x = sessions.get(id); return x ? x.name || plain(baseName(x) || '', 80) || id.slice(0, 8) : id.slice(0, 8); };
  const t = teamOf(from);
  const shared = t && t.members.includes(to) ? t : null;
  if (shared) {
    shared.messages.push({ t: now, from, to, text: plain(text, 300) });
    if (shared.messages.length > TEAM_MSGS_MAX) shared.messages.splice(0, shared.messages.length - TEAM_MSGS_MAX);
    saveSettings();
  }
  const kind = o.kind === 'question' ? ' (question)' : o.kind === 'answer' ? ' (answer)' : '';
  const e = { t: now, sid: from, who: 'main', verb: 'message', what: plain(`→ ${nameOf(to)}${kind}`, 120), to };
  feed.push(e);
  if (feed.length > 400) feed.splice(0, feed.length - 400);
  tlEvent(e);
  if (shared || o.kind === 'answer') return;
  const pair = `${from}>${to}`;
  if (now - (msgAlertAt.get(pair) || 0) < MSG_ALERT_MS) return;
  msgAlertAt.set(pair, now);
  for (const [k, at] of msgAlertAt) if (now - at >= MSG_ALERT_MS) msgAlertAt.delete(k);
  raise({ id: to, name: nameOf(to) }, `got a message from ${nameOf(from)}`, C.violet, 'message', { from });
}

// ---------- timeline: what the map looked like, for replay ----------
// A frame (every conversation /state lists, in a few fields: frameOf) is taken every 60 s, and after any
// conversation changes state (at most every 10 s). To stay small, frames are held as JSON text and most are
// deltas: a keyframe (every conversation) every 10 minutes, and in between only the conversations that changed
// since the frame before, plus the ids that left. GET /timeline expands them back into whole frames.
// Frames, every feed entry (events, at most 30000) and ship events (merges, production deploys, failed checks)
// are kept for 24 hours and appended to %LOCALAPPDATA%\fleet-view\timeline.jsonl every 10 s, one record per line
// ({ k: 'f', t, key: 1, sessions } | { k: 'f', t, d, g } | { k: 'e', … } | { k: 's', … }), so a restart keeps them.
// At start the file is read back and rewritten with only the last 24 hours (compacted); it is compacted again
// whenever it passes 30 MB. Not written in --demo (which makes up the last hour) or --tui.
const TL_FILE = path.join(LOG_DIR, 'timeline.jsonl');
const TL_KEEP_MS = 24 * 3600e3, TL_FILE_MAX = 30 << 20, TL_EVENTS_MAX = 30000, TL_FRAMES_MAX = 9000, TL_KEY_MS = 10 * 60e3;
const TL_OUT_MAX = 360; // frames one GET /timeline answers with, at most
// frames: [{ t, key, s }] (s: the JSON of the sessions array for a keyframe, of { d, g } for a delta);
// prev: id -> the JSON of that conversation in the newest frame
const tl = { frames: [], prev: new Map(), lastKey: 0, events: [], ships: [], keys: new Set(), lastFrame: 0, changed: false, pending: [], loaded: false, writing: false, flushAt: 0 };
const evKey = (e) => `${Math.round(e.t)}|${e.sid}|${e.who}|${e.verb}|${e.what}`;
function tlEvent(e) {
  if (!WEB || opt('snapshot', false)) return;
  // a tool call older than the timeline keeps (read again from a log at start) is not kept, or written
  if (Date.now() - e.t > TL_KEEP_MS) return;
  const k = evKey(e);
  if (tl.keys.has(k)) return;
  tl.keys.add(k);
  const x = { t: Math.round(e.t), sid: e.sid, who: e.who, verb: e.verb, what: e.what };
  if (e.to) x.to = e.to;
  tl.events.push(x);
  if (!DEMO) tl.pending.push({ k: 'e', ...x });
  if (tl.events.length > TL_EVENTS_MAX * 1.1) tlTrimEvents(Date.now());
}
function tlTrimEvents(now) {
  tl.events = tl.events.filter((e) => now - e.t < TL_KEEP_MS).sort((a, b) => a.t - b.t);
  if (tl.events.length > TL_EVENTS_MAX) tl.events.splice(0, tl.events.length - TL_EVENTS_MAX);
  tl.keys = new Set(tl.events.map(evKey));
}
function tlShip(x) {
  if (!WEB) return;
  tl.ships.push(x);
  if (tl.ships.length > 2000) tl.ships.shift();
  if (!DEMO) tl.pending.push({ k: 's', ...x });
}
// one conversation in a frame; ctx is the share of its context window in use (0..1)
function frameOf(s, now) {
  refreshHue(s, now);
  const st = STATE[s.state] || STATE.IDLE;
  const root = s.root || null;
  const used = s.ctxUsed || 0;
  const team = teamOf(s.id);
  return {
    id: s.id, name: plain(baseName(s) || s.name || s.id.slice(0, 8)), state: s.state, label: st.label, stateColor: toHex(st.color), hue: toHex(s.hue),
    account: accountFor(s), repo: root ? { root, name: repoName(root), color: toHex(familyColor(root)) } : null, branch: branchInfo(s).branch,
    // cost to the cent and tokens to the thousand, so a frame lists only the conversations that really moved
    cost: Math.round((s.cost || 0) * 100) / 100, tokens: Math.round((s.tokens || 0) / 1000) * 1000, ctx: used ? Math.round((used / ctxLimit(s)) * 100) / 100 : null,
    lastAction: s.lastAction ? { t: Math.round(s.lastAction.t), who: s.lastAction.who, verb: s.lastAction.verb, what: s.lastAction.what } : null,
    team: team ? team.id : null,
  };
}
// adds a frame of these conversations at time t (a keyframe when one is due, else a delta from the one before)
function tlPush(t, list) {
  const cur = new Map(list.map((x) => [x.id, JSON.stringify(x)]));
  let f;
  if (!tl.frames.length || t - tl.lastKey >= TL_KEY_MS) {
    f = { t, key: 1, s: '[' + [...cur.values()].join(',') + ']' };
    tl.lastKey = t;
  } else {
    const d = [], g = [];
    for (const [id, j] of cur) if (tl.prev.get(id) !== j) d.push(j);
    for (const id of tl.prev.keys()) if (!cur.has(id)) g.push(id);
    f = { t, key: 0, s: `{"d":[${d.join(',')}],"g":${JSON.stringify(g)}}` };
  }
  tl.prev = cur;
  tl.frames.push(f);
  return f;
}
// drops frames past 24 hours (or past the cap), then any deltas left at the front without their keyframe
function tlTrimFrames(now) {
  let i = 0;
  while (i < tl.frames.length && (now - tl.frames[i].t > TL_KEEP_MS || tl.frames.length - i > TL_FRAMES_MAX)) i++;
  while (i < tl.frames.length && !tl.frames[i].key) i++;
  if (i) tl.frames.splice(0, i);
}
const frameRecord = (f) => (f.key ? `{"k":"f","t":${f.t},"key":1,"sessions":${f.s}}` : `{"k":"f","t":${f.t},${f.s.slice(1)}`);
function takeFrame(now) {
  const f = tlPush(now, [...sessions.values()].filter(inState).map((s) => frameOf(s, now)));
  tl.lastFrame = now;
  tl.changed = false;
  if (!DEMO) tl.pending.push(frameRecord(f));
  tlTrimFrames(now);
  while (tl.ships.length && now - tl.ships[0].t > TL_KEEP_MS) tl.ships.shift();
  tlTrimEvents(now);
}
function tlTick(now) {
  if (!tl.loaded && !DEMO) return;
  if (now - tl.lastFrame >= 60e3 || (tl.changed && now - tl.lastFrame >= 10e3)) takeFrame(now);
  if (!DEMO && now - tl.flushAt >= 10e3) { tl.flushAt = now; tlFlush(); }
}
// whole frames, oldest first: for each held frame from index a to b whose index `want` accepts, { t, sessions }.
// Only the frames from the last keyframe at or before a are parsed, not the whole 24 hours.
function tlExpand(want, a = 0, b = tl.frames.length - 1) {
  const out = [];
  if (!tl.frames.length) return out;
  a = Math.max(0, Math.min(a, tl.frames.length - 1));
  b = Math.min(b, tl.frames.length - 1);
  let k = a;
  while (k > 0 && !tl.frames[k].key) k--;
  let cur = null;
  for (let i = k; i <= b; i++) {
    const f = tl.frames[i];
    if (f.key) cur = new Map(JSON.parse(f.s).map((x) => [x.id, x]));
    else if (cur) {
      const { d, g } = JSON.parse(f.s);
      for (const id of g) cur.delete(id);
      for (const x of d) cur.set(x.id, x);
    }
    if (cur && i >= a && want(f, i)) out.push({ t: f.t, sessions: [...cur.values()] });
  }
  return out;
}
// the file: read back (last 30 MB, last 24 hours) and rewritten compacted; once, at start
function tlLoad() {
  if (DEMO || tl.loaded) return;
  tl.loaded = true;
  const now = Date.now();
  let text = '';
  try {
    const size = fs.statSync(TL_FILE).size;
    const fd = fs.openSync(TL_FILE, 'r');
    try {
      const len = Math.min(size, TL_FILE_MAX), buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      text = buf.toString('utf8');
      if (len < size) text = text.slice(text.indexOf('\n') + 1); // the first line was cut
    } finally { fs.closeSync(fd); }
  } catch { return; }
  const frames = [], events = [], shipsIn = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (!d || !Number.isFinite(d.t) || now - d.t > TL_KEEP_MS || d.t > now + 60e3) continue;
    const { k, ...x } = d;
    if (k === 'f' && x.key && Array.isArray(x.sessions)) frames.push({ t: x.t, key: 1, list: x.sessions });
    else if (k === 'f' && Array.isArray(x.d) && Array.isArray(x.g)) frames.push({ t: x.t, key: 0, d: x.d, g: x.g });
    else if (k === 'e' && typeof x.sid === 'string') events.push(x);
    else if (k === 's' && typeof x.kind === 'string') shipsIn.push(x);
  }
  // the frames from the file, rebuilt in order (a delta with no keyframe before it is dropped), then any taken
  // since the start, re-based on them
  frames.sort((a, b) => a.t - b.t);
  const taken = tlExpand(() => true);
  tl.frames = []; tl.prev = new Map(); tl.lastKey = 0;
  let cur = null;
  for (const f of frames) {
    if (f.key) cur = new Map(f.list.map((x) => [x.id, x]));
    else if (cur) { for (const id of f.g) cur.delete(id); for (const x of f.d) if (x && x.id) cur.set(x.id, x); }
    else continue;
    if (!f.key && f.t - tl.lastKey < TL_KEY_MS) {
      // keep it a delta: the same change the file had
      const g = f.g.filter((id) => tl.prev.has(id)), d = f.d.filter((x) => x && x.id);
      for (const id of g) tl.prev.delete(id);
      for (const x of d) tl.prev.set(x.id, JSON.stringify(x));
      tl.frames.push({ t: f.t, key: 0, s: `{"d":[${d.map((x) => JSON.stringify(x)).join(',')}],"g":${JSON.stringify(g)}}` });
    } else tlPush(f.t, [...cur.values()]);
  }
  for (const f of taken) if (!tl.frames.length || f.t > tl.frames[tl.frames.length - 1].t) tlPush(f.t, f.sessions);
  tlTrimFrames(now);
  for (const e of events) { const key = evKey(e); if (!tl.keys.has(key)) { tl.keys.add(key); tl.events.push(e); } }
  tl.ships = shipsIn.sort((a, b) => a.t - b.t).concat(tl.ships);
  tlTrimEvents(now);
  if (tl.frames.length) tl.lastFrame = tl.frames[tl.frames.length - 1].t;
  tlCompact(true);
}
function tlLines() {
  const recs = [...tl.frames.map((f) => ({ t: f.t, line: frameRecord(f) })), ...tl.events.map((e) => ({ t: e.t, line: JSON.stringify({ k: 'e', ...e }) })),
    ...tl.ships.map((x) => ({ t: x.t, line: JSON.stringify({ k: 's', ...x }) }))];
  recs.sort((a, b) => a.t - b.t);
  return recs.map((r) => r.line).join('\n') + (recs.length ? '\n' : '');
}
// rewrite the file from what is held (the last 24 hours); sync at start, else in the background. When even that
// is over 24 MB (a busy day), the oldest tenth of the frames and events goes, until it fits.
function tlCompact(sync) {
  tl.pending = [];
  let body = tlLines();
  for (let i = 0; i < 20 && Buffer.byteLength(body) > TL_FILE_MAX * 0.8; i++) {
    const cutF = tl.frames.length > 1 ? tl.frames[Math.floor(tl.frames.length / 10)].t : 0;
    const cutE = tl.events.length > 1 ? tl.events[Math.floor(tl.events.length / 10)].t : 0;
    tl.frames = tl.frames.filter((f) => f.t >= cutF);
    while (tl.frames.length && !tl.frames[0].key) tl.frames.shift();
    tl.events = tl.events.filter((e) => e.t >= cutE);
    tl.keys = new Set(tl.events.map(evKey));
    body = tlLines();
  }
  const tmp = TL_FILE + '.tmp';
  if (sync) {
    try { fs.mkdirSync(LOG_DIR, { recursive: true }); fs.writeFileSync(tmp, body); fs.renameSync(tmp, TL_FILE); } catch (e) { logOnce('timeline-write', `timeline: could not write ${TL_FILE}: ${e.message}`); }
    return;
  }
  tl.writing = true;
  fs.promises.mkdir(LOG_DIR, { recursive: true }).then(() => fs.promises.writeFile(tmp, body)).then(() => fs.promises.rename(tmp, TL_FILE))
    .catch((e) => logOnce('timeline-write', `timeline: could not write ${TL_FILE}: ${e.message}`)).finally(() => { tl.writing = false; });
}
const pendingLines = () => tl.pending.splice(0).map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';
function tlFlush() {
  if (tl.writing || !tl.pending.length) return;
  const body = pendingLines();
  tl.writing = true;
  fs.promises.mkdir(LOG_DIR, { recursive: true }).then(() => fs.promises.appendFile(TL_FILE, body)).then(() => fs.promises.stat(TL_FILE))
    .then((st) => { tl.writing = false; if (st.size > TL_FILE_MAX) tlCompact(false); })
    .catch((e) => { tl.writing = false; logOnce('timeline-write', `timeline: could not write ${TL_FILE}: ${e.message}`); });
}
// at exit: what has not been written yet
function tlFlushSync() {
  if (DEMO || !tl.loaded || !tl.pending.length) return;
  try { fs.appendFileSync(TL_FILE, pendingLines()); } catch {}
}
// GET /timeline?from&to(&max): frames, events and ship events between from and to (ms; default the last hour,
// at most 24 hours). frames also has the last one before `from`, so the start of the range has a picture; more than
// `max` frames (default 1500) are thinned evenly, keeping the first and the last.
function timelineOut(q) {
  const now = Date.now();
  let to = Number(q.get('to')), from = Number(q.get('from'));
  if (!Number.isFinite(to) || to <= 0) to = now;
  if (!Number.isFinite(from) || from <= 0) from = to - 3600e3;
  if (from > to) [from, to] = [to, from];
  if (to - from > TL_KEEP_MS) from = to - TL_KEEP_MS;
  from = Math.round(from); to = Math.round(to);
  // at most TL_OUT_MAX frames whatever is asked (every frame expands to every conversation, so 24 hours of them
  // would be tens of MB built on this thread; the scrubber can't tell more apart anyway)
  const max = Math.max(10, Math.min(TL_OUT_MAX, Number(q.get('max')) || TL_OUT_MAX));
  // the indexes wanted: the last frame before `from`, every one in range, thinned to max
  let first = -1, last = -1, before = -1;
  tl.frames.forEach((f, i) => { if (f.t < from) before = i; else if (f.t <= to) { if (first < 0) first = i; last = i; } });
  if (before >= 0 && (first < 0 || before === first - 1)) first = before;
  if (first >= 0 && last < 0) last = first;
  const pick = new Set();
  if (first >= 0) {
    const n = last - first + 1;
    if (n <= max) for (let i = first; i <= last; i++) pick.add(i);
    else for (let k = 0; k < max; k++) pick.add(first + Math.round((k * (n - 1)) / (max - 1)));
  }
  const frames = first >= 0 ? tlExpand((f, i) => pick.has(i), first, last) : [];
  const events = tl.events.filter((e) => e.t >= from && e.t <= to).sort((a, b) => a.t - b.t);
  const shipsOut = tl.ships.filter((x) => x.t >= from && x.t <= to);
  return { ok: true, from, to, frames, events, ships: shipsOut };
}

// ---------- GET /since?t=<ms>: what happened while you were away ----------
// merged and live from the timeline's ship events; failed from the alerts (kept 24 h); finished, needs-you and
// cost from the conversations now; cost since t is each conversation's cost now less its cost in the newest frame
// at or before t (all of it when that frame doesn't have it); busiest by tool calls since t
function waitSince(s) {
  if (s.state === 'ASKING') return Math.round((s.liveWait ? s.liveWait.at : s.askAt) || s.turnEndT || s.last || 0);
  if (s.state === 'QUESTION') return Math.round(s.turnEndT || s.last || 0);
  if (s.state === 'ERROR') return Math.round(s.errAt || s.last || 0);
  return Math.round(s.last || s.mtime || 0);
}
function sinceOut(q) {
  const now = Date.now();
  let since = Number(q.get('t'));
  if (!Number.isFinite(since) || since <= 0 || since > now) since = now - 3600e3;
  since = Math.round(Math.max(since, now - 7 * 24 * 3600e3));
  const list = [...sessions.values()].filter(inState);
  const shipsSince = tl.ships.filter((x) => x.t > since);
  const shipRow = (x) => ({ pr: x.pr, repo: x.repo, sid: x.sid, name: nameNow(x.sid, x.name), t: x.t });
  let idx = -1;
  tl.frames.forEach((f, i) => { if (f.t <= since) idx = i; });
  const frame = idx >= 0 ? tlExpand((f, i) => i === idx, idx, idx)[0] || null : null;
  const base = new Map(frame ? frame.sessions.map((x) => [x.id, x.cost || 0]) : []);
  // since: the time of the frame the costs were measured from (null: the timeline doesn't reach back to t, so
  // each conversation counts all of its cost)
  const cost = { total: 0, byAccount: Object.fromEntries((DEMO ? ['A', 'B'] : accountsHere()).map((a) => [a, 0])), since: frame ? frame.t : null };
  for (const s of list) {
    const d = Math.max(0, (s.cost || 0) - (base.get(s.id) || 0));
    cost.total += d;
    cost.byAccount[accountFor(s)] = (cost.byAccount[accountFor(s)] || 0) + d;
  }
  const r2 = (v) => Math.round(v * 100) / 100;
  cost.total = r2(cost.total); for (const a of Object.keys(cost.byAccount)) cost.byAccount[a] = r2(cost.byAccount[a]);
  const calls = new Map();
  for (const e of tl.events) if (e.t > since && e.verb !== 'message') calls.set(e.sid, (calls.get(e.sid) || 0) + 1);
  const nameOf = (id) => { const x = sessions.get(id); return x ? plain(baseName(x) || x.name || id.slice(0, 8)) : id.slice(0, 8); };
  return {
    ok: true, since, now,
    merged: shipsSince.filter((x) => x.kind === 'merged').map(shipRow),
    live: shipsSince.filter((x) => x.kind === 'live').map(shipRow),
    failed: alertLog.filter((a) => a.t > since && a.fail).map((a) => {
      const o = { kind: a.kind, sid: a.s.id, name: nameNow(a.s.id, a.s.name), text: a.text, t: a.t };
      if (a.pr) { o.pr = a.pr; o.repo = a.repo || null; }
      return o;
    }),
    finished: list.filter((s) => s.state === 'DONE' && endedAtOf(s) > since).sort((a, b) => endedAtOf(b) - endedAtOf(a))
      .map((s) => ({ id: s.id, name: nameOf(s.id), t: Math.round(endedAtOf(s)), summary: summaryOf(s.lastReply) || clipWords(s.prompt, 140) || null })),
    cost,
    needsYou: list.filter((s) => needsYou(s.state)).map((s) => ({ id: s.id, name: nameOf(s.id), state: s.state, since: waitSince(s) })),
    busiest: [...calls].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, n]) => ({ id, name: nameOf(id), calls: n })),
  };
}

// The page's code version: the newest mtime among web/'s files and this script. The page reloads itself
// when it changes, so a merge that changes web/ shows up without Ctrl+R. It moves only once the files have
// been still for 3 s, so a checkout halfway through writing them never loads a half-new page.
let codeBuild = null, codeBuildAt = 0;
function buildOf() {
  const now = Date.now();
  if (codeBuild && now - codeBuildAt < 2000) return codeBuild;
  codeBuildAt = now;
  let max = mtime(__filename);
  for (const f of ls(WEB_DIR)) if (/\.(html|js|css)$/i.test(f)) max = Math.max(max, mtime(path.join(WEB_DIR, f)));
  if (!codeBuild || now - max > 3000) codeBuild = String(Math.round(max));
  return codeBuild;
}

// ---------- removed conversations: the page's "Removed conversations" menu, to continue one ----------
// /state lists the 50 most recently removed (settings.hidden, newest first). One still in the session map
// uses that; an older one is read from its log once (cached by the log's mtime): its title (custom-title,
// then ai-title, else its first typed prompt, 60 characters), the folder it last worked in, and its account.
// An id whose log is gone is left out of the list (it stays in settings).
const REMOVED_MAX = 50;
const removedLogs = new Map(); // id -> { file, account, root, m, info } | { missing: true, at }
// <id>.jsonl in the projects folders (both accounts'; the newest copy wins, like discover)
function findLog(id) {
  let best = null;
  for (const r of roots()) {
    for (const proj of ls(r.dir)) {
      const file = path.join(r.dir, proj, `${id}.jsonl`), m = mtime(file);
      if (m && (!best || m > best.m)) best = { file, m, account: r.account, root: r.dir, pdir: path.join(r.dir, proj) };
    }
  }
  return best;
}
// the title, last folder and first prompt of a log, without parsing every line: only lines that can hold them.
// A log over `cap` bytes is read as its first `head` bytes and its last cap - head. With votes: also the repos its
// tool calls point into ({ root: count }), from file paths and shell commands' paths, like repoOf.
function readLogInfo(file, pdir, id, { cap = 48 << 20, head = 4 << 20, votes = false } = {}) {
  let text = '';
  try {
    const size = fs.statSync(file).size;
    if (size <= cap) text = fs.readFileSync(file, 'utf8');
    else {
      // a huge log: its start (the first prompt) and its end (titles and the folder are written again later on)
      const fd = fs.openSync(file, 'r');
      try {
        const a = Buffer.alloc(head), b = Buffer.alloc(cap - head);
        fs.readSync(fd, a, 0, a.length, 0);
        fs.readSync(fd, b, 0, b.length, size - b.length);
        text = a.toString('utf8') + '\n' + b.toString('utf8');
      } finally { fs.closeSync(fd); }
    }
  } catch { return null; }
  let custom = null, ai = null, agentName = null, prompt = null, cwd = null;
  const ct = readJson(path.join(pdir, id, 'custom-title.json'));
  if (ct?.customTitle) custom = ct.customTitle;
  const lines = text.split('\n');
  const parse = (line) => { try { const d = JSON.parse(line); return d && typeof d === 'object' ? d : null; } catch { return null; } };
  // titles: the last of each kind wins
  for (const line of lines) {
    if (!line.includes('"custom-title"') && !line.includes('"ai-title"') && !line.includes('"agent-name"')) continue;
    const d = parse(line);
    if (!d) continue;
    if (d.type === 'custom-title' && d.customTitle) custom = d.customTitle;
    else if (d.type === 'ai-title' && d.aiTitle) ai = d.aiTitle;
    else if (d.type === 'agent-name' && d.agentName) agentName = d.agentName;
  }
  // the first prompt typed, from the start
  for (const line of lines) {
    if (!line.includes('"user"')) continue;
    const d = parse(line);
    if (!d || d.type !== 'user' || d.isSidechain || d.isMeta) continue;
    const c = d.message?.content;
    const texts = typeof c === 'string' ? [c] : Array.isArray(c) ? c.filter((x) => x && x.type === 'text').map((x) => x.text) : [];
    const typed = texts.find((x) => typeof x === 'string' && x.trim() && !x.startsWith('<') && !/^\[Request interrupted/.test(x));
    if (typed) { prompt = typed; break; }
  }
  // the folder of its last message, from the end
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"cwd"')) continue;
    const d = parse(lines[i]);
    if (d && !d.isSidechain && (d.type === 'user' || d.type === 'assistant') && typeof d.cwd === 'string' && d.cwd) { cwd = d.cwd; break; }
  }
  let count = null;
  if (votes) {
    count = {};
    const add = (g) => { if (g && g.root) count[g.root] = (count[g.root] || 0) + 1; };
    for (const line of lines) {
      if (!line.includes('"tool_use"')) continue;
      const d = parse(line);
      const c = d && d.type === 'assistant' && d.message?.content;
      if (!Array.isArray(c)) continue;
      for (const x of c) {
        if (!x || x.type !== 'tool_use' || !x.input || typeof x.input !== 'object') continue;
        if (x.name === 'Bash' || x.name === 'PowerShell') for (const g of commandRepos(x.input.command)) add(g);
        else { const p = toolFile(x); if (p) add(gitInfo(p)); }
      }
    }
  }
  return { title: custom || agentName || ai || null, prompt, cwd, votes: count };
}
function removedOne(h, now, budget) {
  const s = sessions.get(h.id);
  if (s && s.name && !s.demo) {
    refreshHue(s, now);
    const root = s.root || null;
    return {
      id: s.id, name: plain(baseName(s) || s.name || s.id.slice(0, 8)), account: accountFor(s),
      repo: root ? { name: repoName(root), root, color: toHex(familyColor(root)) } : null,
      cwd: s.cwd || null, removedAt: h.at, lastActive: Math.round(s.last || s.mtime || 0) || null,
    };
  }
  let c = removedLogs.get(h.id);
  if (c && c.missing && now - c.at < 60e3) return null;
  const m = c && !c.missing ? mtime(c.file) : 0;
  if (!c || c.missing || !m) {
    const f = findLog(h.id);
    if (!f) { removedLogs.set(h.id, { missing: true, at: now }); return null; }
    c = { file: f.file, pdir: f.pdir, account: f.account, root: f.root, m: 0, info: null };
    removedLogs.set(h.id, c);
  }
  const cur = mtime(c.file);
  if (!c.info || c.m !== cur) {
    // read on a later /state once this one has read its share (12 logs or 64 MB)
    if (budget.left <= 0 || (budget.bytes <= 0 && budget.left < 12)) return undefined;
    budget.left--;
    try { budget.bytes -= Math.min(fs.statSync(c.file).size, 48 << 20); } catch {}
    const info = readLogInfo(c.file, c.pdir, h.id);
    if (!info) return null;
    c.info = info; c.m = cur;
  }
  const { title, prompt, cwd } = c.info;
  const g = cwd ? gitInfo(path.join(cwd, '_')) : null;
  const root = g ? g.root : cwd || null;
  const acct = liveAccount.get(h.id) || acctId(c.account);
  return {
    id: h.id, name: plain(names.get(h.id) || title || plain(prompt, 60) || h.id.slice(0, 8), 80), account: acct,
    repo: root ? { name: repoName(root), root, color: toHex(familyColor(root)) } : null,
    cwd: cwd || null, removedAt: h.at, lastActive: Math.round(c.m) || null,
  };
}
// the list itself; at most 12 logs (64 MB) are read per call, so a long list fills in over a few polls
function removedList(now) {
  if (DEMO) return [];
  const budget = { left: 12, bytes: 64 << 20 };
  const out = [];
  const keep = new Set();
  for (const h of [...hidden].sort((a, b) => b.at - a.at)) {
    if (out.length >= REMOVED_MAX) break;
    keep.add(h.id);
    let r = null;
    try { r = removedOne(h, now, budget); } catch (e) { logOnce('removed:' + (e && e.message), `removed list: skipped ${h.id}\n${errorText(e)}`); }
    if (r) out.push(r);
  }
  for (const id of removedLogs.keys()) if (!keep.has(id)) removedLogs.delete(id);
  return out;
}
// a stand-in for POST /open of a conversation that is no longer in the session map: one in the history index
// (any age, the Projects view's "Older conversations"), else one on the hidden list or taken off it in the last 2 minutes
// (the page's Continue un-hides it first)
const recentlyContinued = new Map(); // id -> when it left the hidden list
function removedSession(id) {
  if (typeof id !== 'string' || !UUID_RE.test(id) || DEMO) return null;
  id = id.toLowerCase();
  const e = historyById(id);
  if (e && fs.existsSync(e.file)) return { id, name: historyName(e), cwd: e.cwd, account: e.account, projRoot: e.projRoot, root: e.repoRoot, state: 'DONE' };
  const t = recentlyContinued.get(id);
  if (!hidden.some((h) => h.id === id) && !(t && Date.now() - t < 120e3)) return null;
  const f = findLog(id);
  const info = f && readLogInfo(f.file, f.pdir, id);
  if (!info) return null;
  const g = info.cwd ? gitInfo(path.join(info.cwd, '_')) : null;
  return { id, name: plain(info.title || plain(info.prompt, 60) || id.slice(0, 8), 80), cwd: info.cwd, account: f.account, projRoot: f.root, root: g ? g.root : info.cwd || null, state: 'DONE' };
}

// ---------- history: every conversation log of any age, by repo (the Projects view's "Older conversations") ----------
// A background index of all the logs in the projects folders: per log { id, m (its mtime), title, prompt, cwd,
// account, projRoot, repoRoot }. repoRoot is the repo its tool calls point into most (file paths and shell
// commands' paths, like repoOf; at most the first 256 KB and last 2 MB of a big log are read), else the git
// repo of its last folder, else that folder. It is built a couple of logs at a time on its own timer (never
// inside /state); the folders are listed again every 30 s and a log whose mtime changed is read again. It is kept
// in %LOCALAPPDATA%\fleet-view\history.json by log path and mtime, so after a restart only new or changed logs
// are read. GET /repo-history?root=<repo> answers from it.
const HISTORY_FILE = path.join(LOG_DIR, 'history.json');
const HISTORY_VERSION = 1;
const HISTORY_RELIST_MS = 30e3;
const HISTORY_MAX = 20; // conversations per repo in the menu
const histIndex = new Map(); // log file -> entry
let histQueue = []; // { file, pdir, m, account, projRoot, id }, newest first
let histListedAt = 0, histListed = false, histDirty = false, histSavedAt = 0, histReads = 0, histOn = false;
const histFields = (e) => ({ id: e.id, file: e.file, m: e.m, title: e.title || null, prompt: e.prompt || null, cwd: e.cwd || null, account: acctId(e.account), projRoot: e.projRoot || null, repoRoot: e.repoRoot || null });
function loadHistory() {
  const j = readJson(HISTORY_FILE);
  if (!j || j.version !== HISTORY_VERSION || !Array.isArray(j.entries)) return;
  for (const e of j.entries) {
    if (!e || typeof e.file !== 'string' || typeof e.id !== 'string' || !UUID_RE.test(e.id) || !Number.isFinite(e.m)) continue;
    histIndex.set(e.file, histFields(e));
  }
}
function saveHistory() {
  if (!histDirty) return;
  histDirty = false;
  histSavedAt = Date.now();
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const tmp = HISTORY_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: HISTORY_VERSION, entries: [...histIndex.values()] }));
    fs.renameSync(tmp, HISTORY_FILE);
  } catch (e) { logOnce('history-save', `could not save ${HISTORY_FILE}: ${e.message}`); }
}
// every <id>.jsonl in the projects folders: the ones not indexed yet, or changed since, go on the queue
function listHistory() {
  const seen = new Set(), queue = [];
  for (const r of roots()) {
    for (const proj of ls(r.dir)) {
      const pdir = path.join(r.dir, proj);
      for (const f of ls(pdir)) {
        if (!f.endsWith('.jsonl') || !UUID_RE.test(f.slice(0, -6))) continue;
        const file = path.join(pdir, f), m = mtime(file);
        if (!m) continue;
        seen.add(file);
        const e = histIndex.get(file);
        if (!e || e.m !== m) queue.push({ file, pdir, m, account: r.account, projRoot: r.dir, id: f.slice(0, -6).toLowerCase() });
      }
    }
  }
  for (const file of [...histIndex.keys()]) if (!seen.has(file)) { histIndex.delete(file); histDirty = true; }
  histQueue = queue.sort((a, b) => b.m - a.m);
  histListedAt = Date.now();
  histListed = true;
}
// one step of the background build: at most 2 logs (and about 4 MB) per call
function historyStep() {
  const now = Date.now();
  if (!histListed || now - histListedAt > HISTORY_RELIST_MS) listHistory();
  let n = 0, bytes = 0;
  while (histQueue.length && n < 2 && bytes < 4 << 20) {
    const q = histQueue.shift();
    n++;
    let info = null;
    try {
      bytes += Math.min(fs.statSync(q.file).size, 2304 << 10);
      info = readLogInfo(q.file, q.pdir, q.id, { cap: 2304 << 10, head: 256 << 10, votes: true });
    } catch (e) { logOnce('history:' + (e && e.message), `history: skipped ${q.file}\n${errorText(e)}`); }
    histReads++;
    if (!info) continue;
    let repoRoot = null, best = 0;
    for (const [root, c] of Object.entries(info.votes || {})) if (c > best) { repoRoot = root; best = c; }
    if (!repoRoot && info.cwd) { const g = gitInfo(path.join(info.cwd, '_')); repoRoot = g ? g.root : info.cwd; }
    histIndex.set(q.file, histFields({ ...q, title: info.title, prompt: info.prompt ? plain(info.prompt, 200) : null, cwd: info.cwd, repoRoot }));
    histDirty = true;
  }
  if (histDirty && (!histQueue.length || now - histSavedAt > 10e3)) saveHistory();
}
const historyIndexing = () => histOn && (!histListed || histQueue.length > 0);
const historyName = (e) => plain(names.get(e.id) || e.title || plain(e.prompt, 60) || e.id.slice(0, 8), 80);
// the newest copy of each conversation (one moved between accounts can have a log in each)
function historyNewest() {
  const byId = new Map();
  for (const e of histIndex.values()) { const o = byId.get(e.id); if (!o || e.m > o.m) byId.set(e.id, e); }
  return byId;
}
function historyById(id) {
  let best = null;
  for (const e of histIndex.values()) if (e.id === id && (!best || e.m > best.m)) best = e;
  return best;
}
// GET /repo-history?root=<repo>: that repo's 20 newest conversations of any age, newest first
function repoHistory(root) {
  if (typeof root !== 'string' || !root.trim() || root.length > 1024) return [400, { ok: false, message: 'no repo given' }];
  if (DEMO) return [200, { ok: true, root, items: [], indexing: false }];
  const keys = new Set([rootKey(root)]);
  const g = path.isAbsolute(root) ? gitInfo(path.join(root, '_')) : null;
  if (g) keys.add(rootKey(g.root));
  const list = [...historyNewest().values()].filter((e) => e.repoRoot && keys.has(rootKey(e.repoRoot)))
    .sort((a, b) => b.m - a.m).slice(0, HISTORY_MAX);
  const items = list.map((e) => {
    const s = sessions.get(e.id);
    return {
      id: e.id, name: s && s.name && !s.demo ? plain(baseName(s) || s.name, 80) : historyName(e),
      account: liveAccount.get(e.id) || e.account, cwd: e.cwd || null,
      repo: { name: repoName(e.repoRoot), root: e.repoRoot, color: toHex(familyColor(e.repoRoot)) },
      lastActive: Math.round(s && s.last > e.m ? s.last : e.m), removed: hidden.some((h) => h.id === e.id),
    };
  });
  return [200, { ok: true, root, items, indexing: historyIndexing(), indexed: histIndex.size, reads: histReads }];
}

// keeps `remembered` (see REMEMBER_MS) up to date with what /state lists; saved when it changed, else every 10 min
function rememberMap(all, repos, now) {
  if (DEMO) return;
  let changed = false;
  const hid = new Set(hidden.map((h) => h.id));
  for (const s of all) {
    const shown = s.state !== 'DONE' && !hid.has(s.id) && !(s.root && repoHidden(s.root));
    if (shown) { if (!remembered.sessions.has(s.id)) changed = true; remembered.sessions.set(s.id, now); }
    else if (remembered.sessions.delete(s.id)) changed = true;
  }
  for (const root of repos.keys()) { if (isHomeRoot(root)) continue; if (!remembered.repos.has(root)) changed = true; remembered.repos.set(root, now); }
  for (const root of [...remembered.repos.keys()]) if (isHomeRoot(root) || repoHidden(root) || now - remembered.repos.get(root) > REMEMBER_REPO_MS) { remembered.repos.delete(root); changed = true; }
  while (remembered.repos.size > 100) remembered.repos.delete(remembered.repos.keys().next().value);
  while (remembered.sessions.size > 300) remembered.sessions.delete(remembered.sessions.keys().next().value);
  if (changed || now - rememberedSavedAt > 10 * 60e3) { rememberedSavedAt = now; saveSettings(); }
}

// GET /state: everything the page draws, computed fresh from the model
// the conversations /state lists: named, polled, and matching --filter
const inState = (s) => s.name && s.state && (!FILTER || FILTER.test(`${s.name} ${s.prompt || ''} ${s.cwd || ''} ${s.wf?.desc || ''}`));
function buildState() {
  const now = Date.now();
  const all = [...sessions.values()].filter((s) => inState(s) && !acctOff(s));
  all.sort((a, b) => (RANK[a.state] ?? 9) - (RANK[b.state] ?? 9) || b.last - a.last);
  const out = all.map((s) => sessionJson(s, now));
  // the repo menu: every repo in the window, busiest first, less the ones taken off it; the picked one stays listed
  pruneHiddenRepos(all);
  const repos = new Map();
  for (const s of all) if (s.root && !repoHidden(s.root) && (s.state !== 'DONE' || inWindow(s, now))) { const r = repos.get(s.root) || { root: s.root, name: repoName(s.root), live: 0 }; if (s.state !== 'DONE') r.live++; repos.set(s.root, r); }
  rememberMap(all, repos, now);
  // repos the map showed before (remembered) stay listed with or without conversations, until removed
  // (or until every conversation in them is on an account turned off)
  const offRoots = new Set();
  if (offAccounts.length) {
    const on = new Set();
    for (const s of sessions.values()) if (s.root) (acctOff(s) ? offRoots : on).add(rootKey(s.root));
    for (const k of on) offRoots.delete(k);
  }
  for (const root of remembered.repos.keys()) {
    if (repoHidden(root) || offRoots.has(rootKey(root)) || [...repos.keys()].some((r) => rootKey(r) === rootKey(root))) continue;
    repos.set(root, { root, name: repoName(root), live: 0, remembered: true });
  }
  // repos added by hand show even with no conversations (merged with a listed one of the same root)
  for (const a of addedRepos) {
    if (repoHidden(a.root)) continue;
    const have = [...repos.keys()].find((r) => rootKey(r) === rootKey(a.root));
    if (have) repos.get(have).added = true; else repos.set(a.root, { root: a.root, name: a.name, live: 0, added: true });
  }
  if (repoSel && ![...repos.keys()].some(inRepo)) repos.set(repoSel, { root: repoSel, name: repoName(repoSel), live: 0 });
  for (const r of repos.values()) { r.color = toHex(familyColor(r.root)); r.push = repoPushTarget(r.root) || 'production'; }
  writePushFile();
  dpRoots = [...repos.keys()]; // the deploy watch follows the repos listed
  // header numbers follow the picked repo and the / filter, like the terminal header
  const c = headerCounts(visibleList(), now);
  const al = alerts.length && now - alerts[alerts.length - 1].t < 120e3 ? alerts[alerts.length - 1] : null;
  // files two or more unfinished conversations touched
  const use = new Map();
  for (const s of all) {
    if (s.state === 'DONE') continue;
    for (const f of s.files.values()) {
      let u = use.get(f.key);
      if (!u) use.set(f.key, (u = { f, users: new Map() }));
      u.users.set(s.id, u.users.get(s.id) || !!f.wrote);
    }
  }
  const clashes = [];
  for (const [key, u] of use) {
    if (u.users.size < 2) continue;
    clashes.push({ key, rel: u.f.rel, root: u.f.root || null, writers: [...u.users.values()].filter(Boolean).length, sessions: [...u.users].map(([id, wrote]) => ({ id, wrote })) });
  }
  parityPass(out);
  const listed = new Set(out.map((x) => x.id));
  return {
    now, demo: DEMO, title: brand(), build: buildOf(),
    // the home folder, which the page names "no repo" like the server does
    home: DEMO ? null : os.homedir(),
    settings: { view, zoom: map.zoom, query, repo: repoSel, compact, finishedOpen, steady, miniBounds, miniOpen, hidden, hiddenRepos, addedRepos, mapSpots, autostart: autostartOn(),
      mapLens, mapViews, mapCamera, notify, parity: parityRules, offAccounts },
    repos: [...repos.values()].sort((a, b) => b.live - a.live || a.name.localeCompare(b.name)),
    counts: { live: c.live, agents: c.agents, waiting: c.waiting, mergedToday: c.merged, cost: c.spent },
    week: DEMO ? { A: { left: 64 }, B: { left: 91 } } : onlyListed(weekNow(now)),
    // each account's plan usage, and how much of it came from somewhere other than this PC (usage-watch.js);
    // an account that is gone, or is now an alias of another (same login), is left out though its history is kept
    usage: DEMO ? {} : onlyListed(USAGE.view(now)),
    // the Claude accounts here: B plus one per ~/.claude-<x> folder, sorted (just ['B']: the page shows no letters)
    accounts: DEMO ? ['A', 'B'] : accountsHere(),
    alert: al ? { t: al.t, sid: al.s.id, name: nameNow(al.s.id, al.s.name), text: al.text, color: toHex(al.color) } : null,
    hiddenDone: all.filter((s) => (s.state === 'DONE' || s.state === 'IDLE') && inWindow(s, now)).length,
    sessions: out,
    // the "recently finished" strip: the last 10 conversations that finished their turn in the last 3 hours
    // (one that never said or was asked anything, a conversation opened and left empty, is not listed)
    // the most recently removed conversations (settings.hidden), newest first, for the page's Continue
    removed: removedList(now),
    finished: out.filter((x) => x.state === 'DONE' && x.endedAt && now - x.endedAt < KEEP_DONE_MS && (x.lastReply || x.goal))
      .sort((a, b) => b.endedAt - a.endedAt).slice(0, 10)
      .map((x) => ({ id: x.id, name: x.name, account: x.account, repo: x.repo, endedAt: x.endedAt, summary: summaryOf(sessions.get(x.id)?.lastReply) || clipWords(x.goal, 140) || null })),
    clashes,
    conflicts: conflictsOf(all),
    worktrees: worktreesOf([...repos.keys()], all, now),
    // teams with at least one member listed (the rest wait in settings until they come back or are dropped)
    teams: teams.filter((t) => t.members.some((m) => listed.has(m))).map(teamJson),
    alerts: alerts.slice(-30).map((a) => ({ n: a.n, t: a.t, sid: a.s.id, name: nameNow(a.s.id, a.s.name), text: a.text, color: toHex(a.color), kind: a.kind, ...(a.from ? { from: a.from } : {}) })),
    // production deploys for the top bar: per repo the newest plus any building, last 3 hours (see refreshDeploys)
    deploys: deploysJson(now),
    deployRepos: deployReposJson(),
    // fleet-msg.js for older briefs, with forward slashes: node, Git Bash and PowerShell all take them;
    // pushHook and sendTo say which menu items can work on this PC (toolsHere)
    tools: { msg: path.join(__dirname, 'scripts', 'fleet-msg.js').replace(/\\/g, '/'), ...toolsHere() },
    // conversations the server has text waiting for (api.js's queue): the page's own waiting orders go in after it
    queuedText: DEMO ? [] : API.queuedIds(),
    feed: feed.slice(-120).map((e) => { const x = { t: Math.round(e.t), sid: e.sid, who: e.who, verb: e.verb, what: e.what }; if (e.to) x.to = e.to; return x; }),
  };
}

// What some menu items need from this PC, looked at once a minute:
// pushHook: "Push to" only does something when the push-target hook (scripts/push-target-hook.py, which the shared
// copy leaves out) is here and an account's settings.json runs it.
// sendTo: per account, whether it has the /handoff and /pickup commands "Send to Claude <X>" runs (a skill or a
// command file, as desktop/host.js sendToMissing checks) and its projects folder as a number, the same for
// accounts that share one folder: X can only pick up a conversation whose log is in its own projects folder.
let toolsSeen = null, toolsSeenAt = 0;
function toolsHere() {
  if (DEMO) return { pushHook: true, sendTo: { A: { commands: true, folder: 0 }, B: { commands: true, folder: 0 } } };
  if (toolsSeen && Date.now() - toolsSeenAt < 60e3) return toolsSeen;
  const isFile = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };
  const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
  const hook = isFile(path.join(__dirname, 'scripts', 'push-target-hook.py'))
    && accountsHere().some((a) => ['settings.json', 'settings.local.json'].some((n) => read(path.join(acctDir(a), n)).includes('push-target-hook')));
  const folders = [], sendTo = {};
  for (const a of accountsHere()) {
    let real = path.join(acctDir(a), 'projects');
    try { real = fs.realpathSync(real); } catch {}
    if (!folders.includes(real.toLowerCase())) folders.push(real.toLowerCase());
    const has = (n) => isFile(path.join(acctDir(a), 'skills', n, 'SKILL.md')) || isFile(path.join(acctDir(a), 'commands', `${n}.md`));
    sendTo[a] = { commands: has('handoff') && has('pickup'), folder: folders.indexOf(real.toLowerCase()) };
  }
  toolsSeen = { pushHook: hook, sendTo };
  toolsSeenAt = Date.now();
  return toolsSeen;
}

// POST /settings: any of view, zoom, query, repo, compact, finishedOpen, webBounds, steady, miniBounds, miniOpen,
// hidden (an array of up to 500 conversation ids, or { id, at } with the time it was hidden; replaces the list),
// hiddenRepos (an array of up to 200 { root, at }, root a string of at most 1024 characters; replaces the list),
// mapSpots (the map's repo spots, up to 300 { id, x, y, pin }; replaces the list), mapLens (one of MAP_LENSES),
// mapViews ({ '1'..'9': { x, y, zoom } }; replaces them), mapCamera ({ x, y, k }: the map's view), notify (bool), offAccounts (account letters turned off), parity (rules, see PARITY_BUILTIN)
function applySettings(b) {
  if (!b || typeof b !== 'object') return;
  if (VIEWS.includes(b.view) || (WEB && b.view === WEB_ONLY_VIEW)) view = b.view;
  if (Number.isFinite(b.zoom) && b.zoom > 0) map.zoom = Math.min(8, Math.max(0.25, b.zoom));
  if (typeof b.query === 'string') query = b.query.slice(0, 200);
  if ('repo' in b) repoSel = typeof b.repo === 'string' && b.repo && b.repo.toLowerCase() !== 'all' ? b.repo : null;
  if (typeof b.compact === 'boolean') compact = b.compact;
  if (typeof b.finishedOpen === 'boolean') finishedOpen = b.finishedOpen;
  const wb = b.webBounds;
  if (wb && ['x', 'y', 'w', 'h'].every((k) => Number.isFinite(wb[k])) && wb.w >= 200 && wb.h >= 150) webBounds = { x: Math.round(wb.x), y: Math.round(wb.y), w: Math.round(wb.w), h: Math.round(wb.h) };
  if (typeof b.steady === 'boolean') steady = b.steady;
  if (typeof b.miniOpen === 'boolean') miniOpen = b.miniOpen;
  if ('hidden' in b) {
    const h = cleanHidden(b.hidden);
    if (h) {
      const now = Date.now();
      // one the API hid moments ago, which the page had not taken up yet when it saved its list
      for (const [id, at] of apiHidAt) {
        if (now - at > API_HIDE_GUARD_MS) { apiHidAt.delete(id); continue; }
        if (!h.some((x) => x.id === id)) { const was = hidden.find((x) => x.id === id); if (was) h.push(was); }
      }
      const still = new Set(h.map((x) => x.id)), was = new Set(hidden.map((x) => x.id));
      for (const x of hidden) if (!still.has(x.id)) recentlyContinued.set(x.id, now);
      for (const [id, t] of recentlyContinued) if (now - t > 120e3 || still.has(id)) recentlyContinued.delete(id);
      hidden = h;
      // removed on the page just now: out of its team too (the page usually took it out already)
      for (const id of still) if (!was.has(id)) leaveOnHide(id);
    }
  }
  if ('hiddenRepos' in b) { const h = cleanHiddenRepos(b.hiddenRepos); if (h) hiddenRepos = h; }
  if ('mapSpots' in b) { const m = cleanMapSpots(b.mapSpots); if (m) mapSpots = m; }
  if (MAP_LENSES.includes(b.mapLens)) mapLens = b.mapLens;
  if ('mapViews' in b) { const v = cleanMapViews(b.mapViews); if (v) mapViews = v; }
  if ('mapCamera' in b) { const c = cleanMapCamera(b.mapCamera); if (c) mapCamera = c; }
  if (typeof b.notify === 'boolean') notify = b.notify;
  if ('offAccounts' in b) { const o = cleanOffAccounts(b.offAccounts); if (o) offAccounts = o; }
  if ('parity' in b) { const p = cleanParity(b.parity); if (p) { parityRules = p; saved.parity = p; } }
  if (b.miniBounds === null) miniBounds = null;
  else if (okBounds(b.miniBounds, 80, 40)) miniBounds = roundBounds(b.miniBounds);
  saveSettings();
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.map': 'application/json; charset=utf-8',
};
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function readBody(req, res, done) {
  let size = 0, called = false;
  const parts = [];
  const call = (j) => {
    if (called) return;
    called = true;
    try { done(j); } catch (e) { requestFailed(req, res, e); }
  };
  req.on('data', (b) => { size += b.length; if (size > 64 << 10) { req.destroy(); return; } parts.push(b); });
  req.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'); } catch {} call(j); });
  req.on('error', () => call(null));
}
// a request whose handler threw: log it and answer 500, instead of an uncaught exception that ends the server
function requestFailed(req, res, e) {
  logOnce('request:' + (e && e.message), `${req.method} ${String(req.url).split('?')[0]} failed\n${errorText(e)}`);
  try { if (!res.headersSent) sendJson(res, 500, { ok: false, message: 'server error' }); else res.end(); } catch {}
}

// ---------- POST /reveal: open a file in VS Code (a document or image in its default app), or a folder in Explorer ----------
// Only a path the page was given may be opened: a file some conversation touched (files[].abs, calls[].file),
// or a repo root or checkout (repo.root, links.repoFolder), or a handoff summary in HO.dir(). Nothing goes
// through a shell with unchecked input: Explorer gets the path as an argument, and VS Code's code.cmd (a batch
// file, so it needs cmd.exe) gets it inside quotes, with every character cmd treats specially refused up front (UNSAFE_PATH, defined with the added repos).
const samePath = (p) => { const r = path.resolve(String(p)); return process.platform === 'win32' ? r.toLowerCase() : r; };
function revealAllowed(kind, p) {
  const want = samePath(p);
  // a repo added by hand (it may have no conversations yet)
  if (kind !== 'file' && addedRepos.some((r) => samePath(r.root) === want)) return true;
  // a handoff summary (a "/pickup <file>" in the Chat tab): a .md right in the handoffs folder
  if (kind === 'file' && /\.md$/i.test(want) && samePath(path.dirname(want)) === samePath(HO.dir())) return true;
  // a file in a folder the page may read (the Changes tab, the file viewer)
  if (kind === 'file' && knownFolders().some((d) => { const r = samePath(d); return want.startsWith(r.endsWith(path.sep) ? r : r + path.sep); })) return true;
  for (const s of sessions.values()) {
    if (!inState(s)) continue;
    if (kind === 'file') {
      for (const f of s.files.values()) if (samePath(fileAbs(f)) === want) return true;
      for (const c of s.calls) if (c.file && samePath(c.file) === want) return true;
    } else {
      const root = s.root || null;
      const dirs = [root, s.demo ? null : topOf(s, root)];
      for (const f of s.files.values()) dirs.push(f.root);
      if (dirs.some((d) => d && samePath(d) === want)) return true;
    }
  }
  return false;
}
// start a program and wait up to `wait` ms for it: true when it ran (or is still running), false when it
// could not start or exited with an error
function run(file, args, opts = {}, wait = 15000) {
  return new Promise((res) => {
    let child, done = false;
    const finish = (v) => { if (!done) { done = true; res(v); } };
    const { anyExit, ...o } = opts; // anyExit: Explorer exits with 1 even when it opened the thing
    try { child = spawn(file, args, { stdio: 'ignore', windowsHide: true, ...o }); } catch { return finish(false); }
    child.on('error', () => finish(false));
    child.on('exit', (code) => finish(code === 0 || anyExit === true));
    setTimeout(() => { finish(true); child.unref(); }, wait);
  });
}
function vscodeCmd() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const known = [path.join(local, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft VS Code', 'bin', 'code.cmd')];
  const onPath = String(process.env.PATH || '').split(path.delimiter).filter(Boolean).map((d) => path.join(d.replace(/"/g, ''), 'code.cmd'));
  return [...known, ...onPath].find((f) => !UNSAFE_PATH.test(f) && fs.existsSync(f)) || null;
}
// documents and media that open in their Windows default app (Photos, a PDF reader, Office, a player): none of
// them runs anything when opened. Everything else (code, text, scripts, programs) goes to VS Code.
const DEFAULT_APP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tif', '.tiff', '.heic', '.avif',
  '.pdf', '.docx', '.xlsx', '.pptx', '.doc', '.xls', '.ppt', '.odt', '.ods', '.odp',
  '.mp4', '.mov', '.webm', '.mkv', '.avi', '.mp3', '.wav', '.m4a', '.ogg', '.flac']);
async function revealFile(p, line) {
  const target = line ? `${p}:${line}` : p;
  if (process.platform === 'win32') {
    if (DEFAULT_APP_EXT.has(path.extname(p).toLowerCase()) && await run('explorer.exe', [`"${p}"`], { anyExit: true, windowsVerbatimArguments: true }, 3000)) return { ok: true, message: `opened ${path.basename(p)}` };
    const code = vscodeCmd();
    const cmd = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
    // /s strips the outer quotes, leaving: "<code.cmd>" -g "<path>:<line>"
    if (code && await run(cmd, ['/d', '/v:off', '/s', '/c', `""${code}" -g "${target}""`], { windowsVerbatimArguments: true })) return { ok: true, message: `opened ${path.basename(p)} in VS Code` };
    // Without VS Code the file is only shown, selected, in Explorer. Its default app is not used: for a
    // .js, .bat, .cmd, .vbs or .exe a session touched, the default app would run it.
    if (await run('explorer.exe', [`/select,"${p}"`], { anyExit: true, windowsVerbatimArguments: true }, 3000)) return { ok: true, message: `VS Code was not found: showing ${path.basename(p)} in Explorer` };
    return { ok: false, message: `could not open ${path.basename(p)}` };
  }
  if (await run('code', ['-g', target])) return { ok: true, message: `opened ${path.basename(p)} in VS Code` };
  if (process.platform === 'darwin' && await run('open', ['-R', p])) return { ok: true, message: `VS Code was not found: showing ${path.basename(p)} in Finder` };
  if (process.platform !== 'darwin' && await run('xdg-open', [path.dirname(p)])) return { ok: true, message: `VS Code was not found: opened the folder of ${path.basename(p)}` };
  return { ok: false, message: `could not open ${path.basename(p)}` };
}
async function reveal(b) {
  const kind = b && b.kind, p = b && b.path;
  if ((kind !== 'file' && kind !== 'folder') || typeof p !== 'string' || !p || p.length > 1024) return [400, { ok: false, message: 'bad request' }];
  if (UNSAFE_PATH.test(p) || !path.isAbsolute(p)) return [400, { ok: false, message: 'that path has characters Fleet View will not pass on' }];
  if (!revealAllowed(kind, p)) return [403, { ok: false, message: 'not a path Fleet View is showing' }];
  if (DEMO) return [200, { ok: false, message: 'demo data: nothing to open' }];
  const abs = path.resolve(p);
  let st = null;
  try { st = fs.statSync(abs); } catch {}
  if (!st) return [200, { ok: false, message: `${path.basename(abs)} is no longer there` }];
  if (kind === 'folder') {
    if (!st.isDirectory()) return [200, { ok: false, message: 'not a folder' }];
    if (process.platform === 'win32') return [200, (await run('explorer.exe', [abs], { anyExit: true }, 3000)) ? { ok: true, message: `opened ${path.basename(abs) || abs}` } : { ok: false, message: 'could not start Explorer' }];
    return [200, (await run(process.platform === 'darwin' ? 'open' : 'xdg-open', [abs], {}, 3000)) ? { ok: true, message: `opened ${path.basename(abs)}` } : { ok: false, message: 'could not open the folder' }];
  }
  if (!st.isFile()) return [200, { ok: false, message: 'not a file' }];
  const line = Number.isInteger(b.line) && b.line > 0 && b.line < 1e7 ? b.line : null;
  return [200, await revealFile(abs, line)];
}

// ---------- what the automation API does to the map ----------
// hide a conversation the way the page's "Hide from map" does (settings.hidden; the page takes it up from /state)
function hideConversation(id) {
  if (typeof id !== 'string' || !UUID_RE.test(id) || DEMO) return false;
  id = id.toLowerCase();
  const now = Date.now();
  hidden = hidden.filter((h) => h.id !== id);
  hidden.push({ id, at: now });
  if (hidden.length > HIDDEN_MAX) hidden.sort((a, b) => a.at - b.at).splice(0, hidden.length - HIDDEN_MAX);
  recentlyContinued.delete(id);
  apiHidAt.set(id, now);
  apiTemp = apiTemp.filter((x) => x !== id);
  tempGoneAt.delete(id);
  saveSettings();
  leaveOnHide(id);
  return true;
}
function markTemp(id) {
  if (typeof id !== 'string' || !UUID_RE.test(id) || DEMO) return false;
  id = id.toLowerCase();
  if (!apiTemp.includes(id)) { apiTemp.push(id); if (apiTemp.length > API_TEMP_MAX) apiTemp.splice(0, apiTemp.length - API_TEMP_MAX); saveSettings(); }
  return true;
}
// A temp session that is no longer running in the session host is hidden and leaves apiTemp. Run every 10 s while
// there are any. It must be gone (or ended) on looks at least TEMP_GONE_MS apart, so a session host restarting (it
// ends every session and its successor resumes them) doesn't count; while the host is down nothing changes.
const tempGoneAt = new Map(); // id -> first look that found it gone
const TEMP_GONE_MS = 15e3;
let tempSweeping = false;
function sweepTemp() {
  if (DEMO || !apiTemp.length || tempSweeping) return;
  tempSweeping = true;
  API.hostList().then((list) => {
    tempSweeping = false;
    if (!list) return;
    const now = Date.now();
    for (const id of [...apiTemp]) {
      const p = list.find((x) => x && typeof x.id === 'string' && x.id.toLowerCase() === id);
      if (p && p.alive) { tempGoneAt.delete(id); continue; }
      const first = tempGoneAt.get(id) || now;
      tempGoneAt.set(id, first);
      if (now - first >= TEMP_GONE_MS) { hideConversation(id); logOnce('api-temp:' + id, `api: temp session ${id} ended: hidden from the map`); }
    }
    for (const id of tempGoneAt.keys()) if (!apiTemp.includes(id)) tempGoneAt.delete(id);
  }, () => { tempSweeping = false; });
}
// where a conversation Fleet View knows lives: { known (its log is on disk), cwd, account }
function whereIs(id) {
  if (typeof id !== 'string' || !UUID_RE.test(id) || DEMO) return { known: false, cwd: null, account: null };
  id = id.toLowerCase();
  const log = conversationLog(id);
  if (!log || !log.file) return { known: false, cwd: null, account: null };
  const s = sessions.get(id);
  if (s && !s.demo) return { known: true, cwd: s.cwd || null, account: accountFor(s) };
  const r = removedSession(id);
  if (r) return { known: true, cwd: r.cwd || null, account: liveAccount.get(id) || acctId(r.account) };
  const f = findLog(id);
  const info = f && readLogInfo(f.file, f.pdir, id);
  return { known: true, cwd: (info && info.cwd) || null, account: liveAccount.get(id) || acctId(f && f.account) };
}
// GET /api/conversations: every conversation /state lists, compact. q: { state, repo (a piece of its root or name),
// all (hidden ones too: removed, or in a removed repo), limit }. hosted and alive are filled in by api.js.
function conversationsFor(q) {
  const st = buildState();
  const hid = new Map(hidden.map((h) => [h.id, h.at]));
  const want = q.state ? String(q.state).toUpperCase() : null, repo = q.repo ? String(q.repo).toLowerCase() : null;
  const out = [];
  for (const s of st.sessions) {
    // hidden as the page sees it: on the list and quiet since, or in a removed repo
    const at = hid.get(s.id);
    const isHidden = (at !== undefined && !(s.active > at)) || !!(s.repo && repoHidden(s.repo.root));
    if (isHidden && !q.all) continue;
    if (want && s.state !== want) continue;
    if (repo && !(s.repo && (s.repo.root.toLowerCase().includes(repo) || s.repo.name.toLowerCase().includes(repo)))) continue;
    out.push({
      id: s.id, name: s.name, state: s.state, label: s.label, account: s.account, repo: s.repo ? s.repo.root : null,
      branch: s.branch || null, cwd: s.cwd || null, lastReply: s.lastReply ? plain(s.lastReply, 500) : null,
      waitingOn: s.waitingOn || null, active: s.active || null, pr: s.ship && Number.isInteger(s.ship.pr) ? s.ship.pr : null,
      openElsewhere: !!s.openElsewhere, hidden: isHidden, temp: apiTemp.includes(s.id),
    });
    if (out.length >= q.limit) break;
  }
  return out;
}

// what the automation API (api.js) needs from the server: the folders a new session may start in (the window's
// rule for "New session": repos /state lists, and the conversations' repo roots and checkouts) and one
// conversation as /state shows it
const apiCtx = {
  sendJson, readBody, log: (t) => logOnce('api:' + t, t), UNSAFE_PATH, accounts: () => (DEMO ? ['A', 'B'] : accountsHere()),
  allowedFolders() {
    const st = buildState(), out = [];
    const add = (p) => { if (typeof p === 'string' && p) out.push(p); };
    for (const r of st.repos) add(r.root);
    for (const s of st.sessions) { add(s.repo && s.repo.root); add(s.links && s.links.repoFolder); }
    return out;
  },
  sessionInfo(id) {
    const s = sessions.get(id);
    return s && inState(s) ? sessionJson(s, Date.now()) : null;
  },
  // where its turn is, from the transcript (ms times): for the API's "wait for the reply"
  turnInfo(id) {
    const s = sessions.get(id);
    if (!s) return null;
    return { promptAt: s.promptAt || 0, turnEndT: s.turnEndT || 0, turnOpen: !!s.turnOpen, asking: !!s.asking, askAt: s.askAt || 0,
      askText: s.asking ? s.askFull || s.askText || null : null, apiError: !!s.apiError, errAt: s.errAt || 0, lastReply: s.lastReply || '', replyAt: s.replyAt || 0 };
  },
  // a conversation's name for the "[Message from teammate …]" line, or null when Fleet View doesn't know it
  // (control characters out: titles come from records anyone's log can hold, and an ESC would end the paste)
  nameOf(id) {
    const s = sessions.get(id);
    return s ? plain(String(baseName(s) || s.name || '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' '), 80) || null : null;
  },
  // a message one conversation sent another went in: team messages, the feed, maybe an alert (o.kind: an ask's
  // 'question' or 'answer')
  noteMessage(from, to, text, o) { try { noteMessage(from, to, text, o); } catch (e) { logOnce('note-message:' + (e && e.message), `noting a message failed\n${errorText(e)}`); } },
  // its Fleet View name (the page's Rename) -> [code, json]
  rename: (id, name) => renameSession(id, name),
  // off the map (settings.hidden), and off the temp list -> true when it was a conversation id
  hide: hideConversation,
  // a throwaway session: hidden once it is stopped or ends
  markTemp,
  isTemp: (id) => typeof id === 'string' && apiTemp.includes(id.toLowerCase()),
  conversations: conversationsFor,
  // the conversation that carries on for one that handed off or ran /clear, or null
  successorOf,
  // open in a claude outside Fleet View (a terminal): resuming it here would run it twice
  openElsewhere: (id) => !DEMO && liveProcs.has(String(id || '').toLowerCase()),
  // removed from the map (the page's Remove), unless it worked again since: an ask's answers aren't typed into it
  isRemoved: (id) => hiddenNow(String(id || '').toLowerCase()),
  // the team a conversation is in: { id, name, lead, members } or null
  teamOf: (id) => { const t = teamOf(id); return t ? { id: t.id, name: t.name, lead: t.lead || null, members: [...t.members] } : null; },
  // the API's /api/teams: each answers [code, json] or a Promise of one
  teams: {
    list: () => [200, { ok: true, teams: teamsList() }],
    get: teamFor,
    make: (b) => postTeam(b, { send: true }),
    add: (id, member, lead) => addMember({ id, member, ...(lead === true ? { lead: true } : {}) }),
    remove: (id, member) => leaveTeam({ id, member, why: 'removed' }),
    disband: (id) => removeTeam({ id }),
    lead: (id, member) => setLead({ id, member }),
  },
  // GET /api/status: what members are doing, free -> [code, json] (statusOf)
  status: statusOf,
  // its transcript, compact (conversation.js transcriptOf) -> Promise of { total, from, items } or null (no log)
  transcript(id, q) {
    const where = conversationLog(id);
    if (!where) return Promise.resolve(null);
    if (where.demo) return Promise.resolve({ total: 0, from: 0, items: [] });
    return CONV.transcriptOf(where.file, q);
  },
  whereIs,
};

// the log the Chat tab reads (conversation.js): a conversation in the window, else any log under the projects
// folders with that id (an older one, opened from the history), the newer one when both accounts have it
const convoLogs = new Map(); // id -> log path found by looking
const convoMiss = new Map(); // id -> when a look found nothing: not looked for again for CONVO_MISS_MS
const CONVO_MISS_MS = 15000;
function conversationLog(id) {
  if (typeof id !== 'string' || !id) return null;
  const s = sessions.get(id);
  if (DEMO) return s ? { demo: true } : null;
  if (s && s.file) return { file: s.file };
  if (!UUID_RE.test(id)) return null;
  const known = convoLogs.get(id);
  if (known && fs.existsSync(known)) return { file: known };
  const missAt = convoMiss.get(id);
  if (missAt && Date.now() - missAt < CONVO_MISS_MS) return null;
  let best = null, bm = 0;
  for (const r of roots()) for (const proj of ls(r.dir)) { const f = path.join(r.dir, proj, id + '.jsonl'), m = mtime(f); if (m > bm) { bm = m; best = f; } }
  if (best) { if (convoLogs.size > 200) convoLogs.clear(); convoLogs.set(id, best); convoMiss.delete(id); }
  else { if (convoMiss.size > 200) convoMiss.clear(); convoMiss.set(id, Date.now()); }
  return best ? { file: best } : null;
}
// the folders the page may read from (GET /changes, GET /file, /preview): every conversation's folder and repo, the
// remembered repos, the ones added by hand and the handoff folder
function knownFolders() {
  const out = new Set();
  for (const s of sessions.values()) { if (s.cwd) out.add(s.cwd); if (s.root) out.add(s.root); }
  for (const r of remembered.repos.keys()) out.add(r);
  for (const a of addedRepos) if (a && a.root) out.add(a.root);
  if (!DEMO) out.add(HO.dir()); // the handoff summaries (a pickup's "Summary", opened in the viewer)
  return [...out];
}
const pageCtx = { sendJson, readBody, folders: knownFolders, log: (t) => logOnce('page:' + t, t) };
const convCtx = { sendJson, find: conversationLog, live: (id) => !DEMO && liveProcs.has(id), log: (t) => logOnce('chat:' + t, t) };

// Only this machine's own page may talk to the server: the Host must be this address (no DNS rebinding),
// and a browser's cross-site request (it carries another Origin) is refused. The automation API (/api/) takes
// no Origin at all and needs its token instead (api.js).
function handle(req, res) {
  try { handleRequest(req, res); } catch (e) { requestFailed(req, res, e); }
}
function handleRequest(req, res) {
  const host = String(req.headers.host || '').toLowerCase();
  if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) return sendJson(res, 403, { ok: false, message: 'bad host' });
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { return sendJson(res, 400, { ok: false, message: 'bad url' }); }
  if (pathname === '/api' || pathname.startsWith('/api/')) return API.handle(req, res, pathname, apiCtx);
  const origin = req.headers.origin;
  if (origin && origin !== `http://127.0.0.1:${PORT}` && origin !== `http://localhost:${PORT}`) return sendJson(res, 403, { ok: false, message: 'bad origin' });
  // the page's own routes: never for another site (a previewed dev page's <img src> sends no Origin)
  const site = req.headers['sec-fetch-site'];
  if ((site === 'cross-site' || site === 'same-site') && /^\/(changes|preview|file)(\/|$)/.test(pathname)) return sendJson(res, 403, { ok: false, message: 'bad origin' });
  if (pathname === '/changes' || pathname.startsWith('/changes/')) return void Promise.resolve(CHANGES.handle(req, res, pathname, pageCtx)).catch((e) => requestFailed(req, res, e));
  if (pathname === '/preview' || pathname.startsWith('/preview/')) return void Promise.resolve(PREVIEW.handle(req, res, pathname, pageCtx)).catch((e) => requestFailed(req, res, e));
  if (pathname === '/file') return void Promise.resolve(FILES.serve(req, res, pageCtx)).catch((e) => requestFailed(req, res, e));
  if (pathname === '/update' || pathname.startsWith('/update/')) return UPDATER.handle(req, res, pathname, pageCtx);
  if (req.method === 'POST') {
    if (pathname === '/open') {
      return readBody(req, res, (b) => {
        // a removed conversation outside the window (the page's Continue) opens from its log
        const s = b && typeof b.id === 'string' ? sessions.get(b.id) || removedSession(b.id) : null;
        if (!s) return sendJson(res, 404, { ok: false, message: 'no such conversation' });
        launchConversation(s).then((r) => sendJson(res, 200, r), (e) => requestFailed(req, res, e));
      });
    }
    if (pathname === '/reveal') {
      return readBody(req, res, (b) => {
        reveal(b).then(([code, out]) => sendJson(res, code, out), () => sendJson(res, 500, { ok: false, message: 'could not open it' }));
      });
    }
    if (pathname === '/repos/scratch') {
      return readBody(req, res, (b) => {
        if (b && b.paths != null) return void addScratchWith(b.paths).then(([code, out]) => sendJson(res, code, out), (e) => requestFailed(req, res, e));
        const [code, out] = addScratchRepo(); sendJson(res, code, out);
      });
    }
    if (pathname === '/repos/add' || pathname === '/repos/remove') {
      return readBody(req, res, (b) => {
        if (!b) return sendJson(res, 400, { ok: false, message: 'bad json' });
        const [code, out] = pathname === '/repos/add' ? addRepo(b.path) : removeAddedRepo(b.root);
        sendJson(res, code, out);
      });
    }
    if (pathname === '/rename') {
      return readBody(req, res, (b) => {
        if (!b) return sendJson(res, 400, { ok: false, message: 'bad json' });
        const [code, out] = renameSession(b.id, b.name);
        sendJson(res, code, out);
      });
    }
    if (pathname === '/push-target') {
      return readBody(req, res, (b) => {
        if (!b) return sendJson(res, 400, { ok: false, message: 'bad json' });
        const [code, out] = setPushTarget(b);
        sendJson(res, code, out);
      });
    }
    if (pathname === '/sessions/move') {
      return readBody(req, res, (b) => {
        if (!b) return sendJson(res, 400, { ok: false, message: 'bad json' });
        const [code, out] = moveSession(b.id, b.root);
        sendJson(res, code, out);
      });
    }
    // the page's teams; each sends its own notes, so the reply comes once they went in (or were queued)
    // (the page's Work together asks for send: the server types the briefs, as it types every other team text)
    const teamRoute = { '/teams': (b) => postTeam(b, { send: !!(b && b.send === true) }), '/teams/add': addMember, '/teams/remove': removeTeam, '/teams/leave': leaveTeam, '/teams/lead': setLead }[pathname];
    if (teamRoute) {
      return readBody(req, res, (b) => {
        if (!b) return sendJson(res, 400, { ok: false, message: 'bad json' });
        teamRoute(b).then(([code, out]) => sendJson(res, code, out), (e) => requestFailed(req, res, e));
      });
    }
    if (pathname === '/chat/image') return CONV.saveImage(req, res, convCtx);
    // "I know, keep using": the heads-up for that episode of usage from elsewhere stays away
    if (pathname === '/usage/ack') {
      return readBody(req, res, (b) => {
        if (!b || typeof b.account !== 'string' || typeof b.episode !== 'string') return sendJson(res, 400, { ok: false, message: 'account and episode are needed' });
        sendJson(res, 200, { ok: USAGE.ack(acctId(b.account), b.episode.slice(0, 40)) });
      });
    }
    if (pathname === '/settings') return readBody(req, res, (b) => { if (!b) return sendJson(res, 400, { ok: false, message: 'bad json' }); applySettings(b); sendJson(res, 200, { ok: true }); });
    return sendJson(res, 404, { ok: false, message: 'not found' });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { ok: false, message: 'method not allowed' });
  if (pathname === '/state') return sendJson(res, 200, buildState());
  if (pathname === '/timeline') return sendJson(res, 200, timelineOut(new URL(req.url, 'http://x').searchParams));
  if (pathname === '/since') return sendJson(res, 200, sinceOut(new URL(req.url, 'http://x').searchParams));
  if (pathname === '/conversation') return void CONV.conversation(req, res, convCtx).catch((e) => requestFailed(req, res, e));
  if (pathname === '/chat/commands') return sendJson(res, 200, CMDS.list(new URL(req.url, 'http://x').searchParams.get('cwd')));
  if (pathname === '/chat/files') {
    const q = new URL(req.url, 'http://x').searchParams;
    return void FILES.files(q.get('cwd'), q.get('q')).then((out) => sendJson(res, 200, out)).catch((e) => requestFailed(req, res, e));
  }
  if (pathname === '/chat/kind') return sendJson(res, 200, FILES.kind(new URL(req.url, 'http://x').searchParams.get('path')));
  if (pathname === '/conversation/image') return void CONV.conversationImage(req, res, convCtx).catch((e) => requestFailed(req, res, e));
  if (pathname === '/repo-history') {
    const [code, out] = repoHistory(new URL(req.url, 'http://x').searchParams.get('root'));
    return sendJson(res, code, out);
  }
  // static files from web/, never outside it
  const file = path.resolve(WEB_DIR, '.' + (pathname === '/' ? '/index.html' : pathname));
  const type = TYPES[path.extname(file).toLowerCase()];
  if (pathname.includes('\0') || !file.startsWith(WEB_DIR + path.sep) || !type) return sendJson(res, 404, { ok: false, message: 'not found' });
  fs.readFile(file, (err, buf) => {
    if (err) return sendJson(res, 404, { ok: false, message: 'not found' });
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}

// the desktop window (desktop/, Electron with Windows 11 acrylic) when `npm install` has been run there;
// its electron.exe path comes from desktop/node_modules/electron. It keeps one window per port by itself.
function electronExe() {
  const dir = path.join(__dirname, 'desktop');
  if (!fs.existsSync(path.join(dir, 'node_modules', 'electron', 'package.json'))) return null;
  try {
    const exe = require(path.join(dir, 'node_modules', 'electron'));
    return typeof exe === 'string' && fs.existsSync(exe) ? exe : null;
  } catch { return null; }
}

// the app window: the Electron desktop window if it is installed (and has not failed to start this run), else
// Edge in app mode with its own profile; either opens where the window was last time. Returns electron.exe's
// process when it started that.
let noElectron = false;
function openWindow() {
  const url = `http://127.0.0.1:${PORT}/`;
  const electron = noElectron ? null : electronExe();
  if (electron) {
    try {
      const args = [path.join(__dirname, 'desktop'), `--url=${url}?glass=1`];
      if (webBounds) args.push(`--bounds=${webBounds.x},${webBounds.y},${webBounds.w},${webBounds.h}`);
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE; // would start electron.exe as plain node
      const child = spawn(electron, args, { detached: true, stdio: 'ignore', windowsHide: false, env });
      child.on('error', () => console.log(`could not start the desktop window; open ${url} in a browser`));
      child.unref();
      return child;
    } catch {} // fall through to Edge
  }
  const edge = [path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe')].find((f) => fs.existsSync(f));
  try {
    if (edge) {
      const args = [`--app=${url}`, `--user-data-dir=${path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'fleet-view', 'edge')}`, '--no-first-run', '--no-default-browser-check'];
      if (webBounds) args.push(`--window-position=${webBounds.x},${webBounds.y}`, `--window-size=${webBounds.w},${webBounds.h}`);
      const child = spawn(edge, args, { detached: true, stdio: 'ignore' });
      child.on('error', () => console.log(`could not start Edge; open ${url} in a browser`));
      child.unref();
    } else if (process.platform === 'win32') {
      const child = spawn('explorer.exe', [url], { detached: true, stdio: 'ignore' }); // the default browser
      child.on('error', () => console.log(`open ${url} in a browser`));
      child.unref();
    } else console.log(`open ${url} in a browser`);
  } catch { console.log(`open ${url} in a browser`); }
}

// is a Fleet View already serving this port? (its /state answers with a sessions list)
function probeFleetView(answer) {
  let answered = false;
  const done = (v) => { if (!answered) { answered = true; answer(v); } };
  const req = http.get({ host: '127.0.0.1', port: PORT, path: '/state', timeout: 2000 }, (res) => {
    const parts = [];
    res.on('data', (b) => parts.push(b));
    res.on('error', () => done(false));
    res.on('end', () => { try { done(Array.isArray(JSON.parse(Buffer.concat(parts).toString('utf8')).sessions)); } catch { done(false); } });
  });
  req.on('timeout', () => req.destroy());
  req.on('error', () => done(false));
}

// the code's version for the log: "1.0.12 (02dddec), file <time> UTC": the version number (version.js), the git
// commit in parentheses when git can say (a restart check compares it with git merge-base), and fleet-view.js's own time
function versionOf() {
  let hash = '';
  try { hash = require('child_process').execFileSync('git', ['-C', __dirname, 'rev-parse', '--short', 'HEAD'], { timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch {}
  let at = '';
  try { at = fs.statSync(__filename).mtime.toISOString().slice(0, 19).replace('T', ' '); } catch {}
  const v = VERSION.current().version;
  return [v && hash ? `${v} (${hash})` : v || hash, at && `file ${at} UTC`].filter(Boolean).join(', ') || 'unknown';
}

// The server never stops without a line in the log. An exception nothing caught is written with its stack and the
// process exits with 76, which fleet-view.cmd's loop takes as a crash and starts it again (with --no-open, so the
// open window just reconnects). A promise nobody waited on is logged and the server keeps going.
const EXIT_CRASH = 76, EXIT_UPDATE = 75;
let exitReason = '';
function exitWith(code, reason) {
  exitReason = reason;
  try { flushSettings(); } catch {}
  try { if (histOn) saveHistory(); } catch {}
  try { tlFlushSync(); } catch {}
  process.exit(code);
}
function guardProcess() {
  process.on('uncaughtException', (e) => {
    logLine(`crash: uncaught exception, exiting with ${EXIT_CRASH} so the launcher restarts it\n${errorText(e)}`);
    try { console.error(errorText(e)); } catch {}
    exitWith(EXIT_CRASH, 'crash');
  });
  process.on('unhandledRejection', (e) => logOnce('rejection:' + (e && e.message), `unhandled promise rejection (still running)\n${errorText(e)}`));
  process.on('exit', (code) => logLine(`stop: exit code ${code}${exitReason ? ` (${exitReason})` : ''}`));
  // a console that went away must not turn a status line into a crash
  for (const out of [process.stdout, process.stderr]) out.on('error', () => {});
}

function startWeb() {
  // The desktop app owns the server: a plain launch (`fleet-view`, the sign-in shortcut) with the desktop window
  // installed just starts the app and leaves; the app starts this server hidden (--no-open) and stops it when it
  // quits, so no console window is left to close by accident. --no-open, --demo and the app's own start skip this.
  // The app's server answering on the port is the sign it started. When electron.exe won't start or closes before
  // that (blocked by antivirus, a graphics crash, a damaged download), or nothing answers within 20 s (60 s while
  // electron.exe is still running: a first start an antivirus scan holds up), this goes on as the server with the
  // Edge window instead, so a launch never ends with nothing running.
  if (!NO_OPEN && !DEMO && !noElectron && process.env.FV_SERVER_OWNER !== 'electron' && electronExe()) {
    const child = openWindow(), start = Date.now();
    let failed = false, exited = false;
    if (child) { child.on('error', () => { failed = true; }); child.on('exit', () => { exited = true; }); }
    const wait = () => probeFleetView((up) => {
      if (up) {
        logLine('launch: handed over to the desktop app (it runs the server)');
        return setTimeout(() => process.exit(0), 600);
      }
      const waited = Date.now() - start;
      if (!failed && !exited && child && (waited < 20e3 || (child.exitCode === null && waited < 60e3))) return setTimeout(wait, 1000);
      logLine(`launch: the desktop window ${failed || !child ? 'could not start' : exited ? 'closed before it answered' : `did not answer within ${Math.round(waited / 1000)} s`}; serving here, with the Edge window`);
      noElectron = true;
      startWeb();
    });
    setTimeout(wait, 1000);
    return;
  }
  guardProcess();
  // the automation API's token (api.js): made on the first start, never logged
  try { API.ensureToken(); } catch (e) { logLine(`api: could not make the API token: ${e.message}`); }
  const after = process.env.FV_RESTART_REASON ? `, restarted after ${process.env.FV_RESTART_REASON}` : '';
  logLine(`start: port ${PORT}, version ${versionOf()}, node ${process.version}${DEMO ? ', demo' : ''}${NO_OPEN ? ', --no-open' : ''}${process.env.FLEET_VIEW_LOOP === '1' ? '' : ', no restart loop'}${after}`);
  setTimeout(registerLauncher, 5000);
  const server = http.createServer(handle);
  let tries = 0, listening = false;
  server.on('error', (e) => {
    if (listening || e.code !== 'EADDRINUSE') {
      logLine(`http server error${listening ? '' : ` while starting on port ${PORT}`}\n${errorText(e)}`);
      console.error(`Fleet View could not serve on port ${PORT}: ${e.message}`);
      return exitWith(1, 'http server error');
    }
    probeFleetView((isFleet) => {
      if (isFleet) {
        // another Fleet View already serves the page: show its window and leave
        console.log(`Fleet View is already running on http://127.0.0.1:${PORT}/${NO_OPEN ? '' : '; opening its window'}`);
        if (!NO_OPEN) openWindow();
        setTimeout(() => exitWith(0, 'another Fleet View already serves this port'), 800);
      } else if (++tries <= 20) {
        // a reload or a restart after a crash: the old process may still be letting go of the port
        if (tries === 1) logLine(`port ${PORT} is busy; trying again for up to 6 s`);
        setTimeout(() => server.listen(PORT, '127.0.0.1'), 300);
      } else {
        console.error(`port ${PORT} is taken by another program; start with --port <n>`);
        logLine(`port ${PORT} is taken by another program`);
        exitWith(1, 'port taken');
      }
    });
  });
  server.listen(PORT, '127.0.0.1');
  server.once('listening', () => {
    listening = true;
    console.log(`Fleet View on http://127.0.0.1:${PORT}/  (${DEMO ? 'demo data' : rootLabel()}${GITHUB ? '' : ', github off'})`);
    console.log('Close this window, or press Ctrl+C, to stop it.');
    if (!NO_OPEN) openWindow();
    // Ctrl+C, a kill, or the console window closing (SIGHUP on Windows): a clean stop, so the loop ends
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => exitWith(0, sig));
    watchForUpdates(() => { console.log('fleet-view.js changed: reloading'); logLine('fleet-view.js changed on disk: reloading (exit 75)'); server.close(); exitWith(EXIT_UPDATE, 'update'); });
    // test only: FV_TEST_CRASH=1 throws an exception nothing catches 3 s after start, to check the crash log and restart
    // updates from the folder's git upstream (updater.js): the page's "Update available" pill
    if (!DEMO) UPDATER.start({ log: logLine, busy: () => [...sessions.values()].filter((s) => inState(s) && (s.state === 'WORKING' || s.state === 'AGENTS')).length });
    if (process.env.FV_TEST_CRASH === '1') setTimeout(() => { throw new Error('FV_TEST_CRASH: test crash 3 s after start'); }, 3000);
    const every = (ms, name, fn) => setInterval(() => { try { fn(); } catch (e) { logOnce(name + ':' + (e && e.message), `${name} failed\n${errorText(e)}`); } }, ms);
    if (DEMO) {
      demoInit();
      every(1500, 'demo', demoTick);
      return;
    }
    // the history index: what history.json holds now, the rest built in the background
    histOn = true;
    loadHistory();
    every(250, 'history', historyStep);
    try { tlLoad(); } catch (e) { tl.loaded = true; logLine(`timeline: could not read ${TL_FILE}\n${errorText(e)}`); }
    try { scanLiveProcs(); discover(); poll(); } catch (e) { console.error(e.stack); logLine(`first read of the logs failed\n${errorText(e)}`); }
    accountsFromProcesses();
    readWeekLeft();
    every(1500, 'procs', scanLiveProcs);
    pruneFeeds();
    every(3600e3, 'feeds', pruneFeeds);
    every(10000, 'accounts', accountsFromProcesses);
    const prs = () => refreshGithub().catch((e) => logOnce('github:' + (e && e.message), `GitHub lookup failed\n${errorText(e)}`));
    const deploys = () => refreshDeploys().catch((e) => logOnce('deploys:' + (e && e.message), `deploy lookup failed\n${errorText(e)}`));
    const github = () => { prs(); deploys(); };
    github();
    every(1500, 'poll', poll);
    every(8000, 'discover', discover);
    every(5000, 'github', github);
    every(60e3, 'codegraph', codeGraphs);
    setTimeout(() => { try { codeGraphs(); } catch {} }, 20e3);
    // the API's throwaway sessions: off the map once they end
    every(10000, 'api-temp', sweepTemp);
    // messages and orders that waited for a menu before the last restart (api.js's queue)
    API.startQueue(apiCtx);
  });
}

// code graphs (code-index.js): the main checkout of every repo added, or seen in the last week, and the checkout of
// every conversation active in the last day (its worktree, say) get a CodeGraph index, built one at a time
function codeGraphs() {
  const want = (dir) => {
    if (!dir || isHomeRoot(dir)) return;
    const g = gitInfo(path.join(dir, '_'));
    if (g && !isHomeRoot(g.top)) CODEGRAPH.want(g.top, g.root);
  };
  for (const r of addedRepos) if (!repoHidden(r.root)) want(r.root);
  const week = Date.now() - 7 * 24 * 3600e3, since = Date.now() - 24 * 3600e3;
  for (const [root, at] of remembered.repos) if (at > week && !repoHidden(root)) want(root);
  for (const s of sessions.values()) if (!s.demo && s.cwd && (s.last || s.mtime || 0) > since) want(s.cwd);
}

// ---------- autostart: a "Fleet View" shortcut in the user's Startup folder ----------
// --install-startup makes it (it runs fleet-view.vbs, which starts Fleet View with no console window, in this
// folder), --remove-startup deletes it.
// FV_STARTUP_DIR, for tests only, puts it in another folder.
const STARTUP_LNK = 'Fleet View.lnk';
const startupDir = () => process.env.FV_STARTUP_DIR || path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
let autostartSeen = { at: 0, on: false };
// for /state: is the shortcut there (looked at every 10 s at most)
function autostartOn() {
  const now = Date.now();
  if (now - autostartSeen.at > 10e3) autostartSeen = { at: now, on: fs.existsSync(path.join(startupDir(), STARTUP_LNK)) };
  return autostartSeen.on;
}
const STARTUP_PS = `$ErrorActionPreference = 'Stop'
$dir = if ($env:FV_STARTUP_DIR) { $env:FV_STARTUP_DIR } else { [Environment]::GetFolderPath('Startup') }
$lnk = Join-Path $dir '${STARTUP_LNK}'
if ($env:FV_STARTUP_ACTION -eq 'install') {
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
  $s.TargetPath = $env:FV_STARTUP_TARGET
  $s.Arguments = $env:FV_STARTUP_ARGS
  $s.WorkingDirectory = $env:FV_STARTUP_WORKDIR
  $s.WindowStyle = 1
  $s.Description = 'Fleet View: live view of every Claude Code session'
  if ($env:FV_STARTUP_ICON -and (Test-Path -LiteralPath $env:FV_STARTUP_ICON)) { $s.IconLocation = "$($env:FV_STARTUP_ICON),0" }
  $s.Save()
  "installed|$lnk"
} elseif (Test-Path -LiteralPath $lnk) { Remove-Item -LiteralPath $lnk -Force; "removed|$lnk" }
else { "absent|$lnk" }`;
function startupShortcut(action) {
  if (process.platform !== 'win32') { console.log('--install-startup and --remove-startup work on Windows only.'); process.exit(1); }
  const vbs = path.join(__dirname, 'fleet-view.vbs');
  const target = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');
  let out = '';
  try {
    out = require('child_process').execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(STARTUP_PS, 'utf16le').toString('base64')], {
      timeout: 30000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FV_STARTUP_ACTION: action, FV_STARTUP_TARGET: target, FV_STARTUP_ARGS: `//nologo "${vbs}"`, FV_STARTUP_WORKDIR: __dirname, FV_STARTUP_ICON: path.join(__dirname, 'desktop', 'fleet-view.ico') },
    }).toString().trim();
  } catch (e) {
    console.log(`could not ${action === 'install' ? 'make' : 'remove'} the startup shortcut: ${String((e.stderr && e.stderr.toString().trim()) || e.message).split(/\r?\n/)[0]}`);
    process.exit(1);
  }
  const [what, lnk] = out.split(/\r?\n/).pop().split('|');
  if (what === 'installed') console.log(`Made ${lnk}\nFleet View now starts when you sign in: it runs ${vbs} with no window, in ${__dirname}.\nUndo with: fleet-view --remove-startup`);
  else if (what === 'removed') console.log(`Removed ${lnk}\nFleet View no longer starts when you sign in.`);
  else if (what === 'absent') console.log(`There is no startup shortcut to remove (${lnk}).`);
  else { console.log(`unexpected answer from PowerShell: ${out}`); process.exit(1); }
  process.exit(0);
}

// ---------- launching with no console window ----------
// "fleet-view" typed in Run (Win+R) or the Start menu's search used to find fleet-view.cmd on PATH, and a .cmd
// opens a console (a Windows Terminal window) before it hands over to fleet-view.vbs. App Paths wins over PATH
// for those launches (not for a terminal, where the .cmd still runs in place), so the name is registered there
// to fleet-view.vbs, and a "Fleet View" Start menu shortcut (the app's icon, pinnable) runs it too. Done by the
// real server (port 4777) at each start: reg add is cheap, the shortcut is made only when it is missing.
const APP_PATHS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\fleet-view.exe';
function registerLauncher() {
  if (process.platform !== 'win32' || DEMO || PORT !== 4777 || process.env.FV_STARTUP_DIR) return;
  const vbs = path.join(__dirname, 'fleet-view.vbs');
  const cp = require('child_process');
  cp.execFile('reg', ['add', APP_PATHS_KEY, '/ve', '/d', vbs, '/f'], { windowsHide: true, timeout: 10000 }, (err) => {
    if (err) logOnce('app-paths', `launcher: could not register fleet-view in App Paths: ${err.message}`);
  });
  const programs = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  if (fs.existsSync(path.join(programs, STARTUP_LNK))) return;
  cp.execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(STARTUP_PS, 'utf16le').toString('base64')], {
    timeout: 30000, windowsHide: true,
    env: { ...process.env, FV_STARTUP_DIR: programs, FV_STARTUP_ACTION: 'install', FV_STARTUP_TARGET: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe'),
      FV_STARTUP_ARGS: `//nologo "${vbs}"`, FV_STARTUP_WORKDIR: __dirname, FV_STARTUP_ICON: path.join(__dirname, 'desktop', 'fleet-view.ico') },
  }, (err) => logLine(err ? `launcher: could not make the Start menu shortcut: ${err.message}` : `launcher: made the Start menu shortcut ${path.join(programs, STARTUP_LNK)}`));
}

// ---------- main ----------
// When fleet-view.js (or api.js or conversation.js, which it loads) changes on disk (a merge or pull), reload in
// the same window: exit with 75 and let fleet-view.cmd's loop start the new code, so the window keeps its place
// and size. A version that doesn't parse is left alone. Without the loop (started some other way) it only says an update is ready.
function watchForUpdates(reload) {
  const me = path.resolve(__filename);
  const files = [me, path.join(__dirname, 'api.js'), path.join(__dirname, 'screen.js'), path.join(__dirname, 'conversation.js'), path.join(__dirname, 'updater.js'), path.join(__dirname, 'version.js')];
  let timer = null;
  for (const file of files) {
    let last = mtime(file);
    fs.watchFile(file, { interval: 2000 }, () => {
      const m = mtime(file);
      if (!m || m === last) return;
      last = m;
      clearTimeout(timer);
      timer = setTimeout(check, 1500);
    });
  }
  function check() {
    const parses = files.every((f) => require('child_process').spawnSync(process.execPath, ['--check', f], { windowsHide: true }).status === 0);
    if (!parses) { if (WEB) console.log('an update to fleet-view.js does not parse yet; still running the old version'); notice ={ text: '  an update to fleet-view.js does not parse yet; still running the old version', color: C.gold, until: Date.now() + 8000 }; return; }
    if (process.env.FLEET_VIEW_LOOP === '1') reload();
    else notice = { text: '  fleet-view.js was updated: restart Fleet View to load it', color: C.cyan, until: Date.now() + 15000 };
  }
}

function start() {
  const write = (s) => process.stdout.write(s);
  const restore = () => write('\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[0m\x1b[?25h\x1b[?1049l');
  const quit = () => { flushSettings(); restore(); process.exit(0); };
  // alternate screen, hidden cursor, and the mouse reported as SGR sequences: presses, releases and
  // movement while a button is held (1002), which is what dragging the map needs
  write('\x1b[?1049h\x1b[?25l\x1b[2J\x1b[?1002h\x1b[?1006h');
  process.on('SIGINT', quit);
  process.on('exit', restore);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  if (process.stdin.isTTY && process.platform === 'win32') enableVtInput();
  process.stdin.resume();
  // one chunk can hold several keys, and a sequence can be split across chunks: an unfinished
  // escape at the end waits briefly for the rest instead of being read as a bare Esc
  let pending = '', flush = null;
  const feedKeys = (str) => {
    const keys = str.match(/\x1b\[<?[0-9;]*[A-Za-z~]|\x1bO[A-Za-z]|[\s\S]/g) || [];
    for (const k of keys) if (onKey(k, quit) === 'clear') write('\x1b[2J');
  };
  process.stdin.on('data', (b) => {
    clearTimeout(flush);
    let str = pending + b.toString();
    const tail = /\x1b(\[[<0-9;]*|O)?$/.exec(str);
    pending = tail ? tail[0] : '';
    if (tail) str = str.slice(0, tail.index);
    feedKeys(str);
    if (pending) flush = setTimeout(() => { const p = pending; pending = ''; feedKeys(p); }, 60);
  });
  process.stdin.on('error', () => {});
  process.stdout.on('resize', () => { map.prev = []; write('\x1b[2J'); });
  watchForUpdates(() => { flushSettings(); restore(); process.exit(75); });
  let f = 0;
  const paint = () => {
    if (view === 'cards') return write(frame(f++));
    // the map and the wall write only the rows that changed since the last frame
    const rows = view === 'map' ? mapRows(f++) : wallRows(f++);
    if (map.prev.length !== rows.length) map.prev = [];
    let out = '';
    rows.forEach((r, i) => { if (map.prev[i] !== r) out += `\x1b[${i + 1};1H` + r; });
    map.prev = rows;
    if (out) write(out);
  };
  setInterval(() => { try { paint(); } catch (e) { map.prev = []; write('\x1b[H' + e.stack); } }, 1000 / 12);
  if (DEMO) {
    demoInit();
    setInterval(() => { try { demoTick(); } catch {} }, 1500);
    return;
  }
  discover();
  poll();
  refreshGithub();
  setInterval(() => { try { poll(); } catch {} }, 1500);
  setInterval(() => { try { discover(); } catch {} }, 8000);
  setInterval(() => { refreshGithub().catch(() => {}); }, 5000);
}

if (STARTUP_FLAG) startupShortcut(STARTUP_FLAG);
else if (opt('install-profile', false)) installProfile();
else if (opt('snapshot', false)) {
  // one frame of the active view to stdout, for checking the layout without taking over the screen
  (async () => {
    if (DEMO) { demoInit(); for (let i = 0; i < 6; i++) demoTick(); }
    else {
      discover(); poll(); await refreshGithub(); poll();
      // finish reading token history so the printed costs are complete
      for (let i = 0; i < 400 && [...sessions.values()].some((x) => x.usagePending); i++) poll();
    }
    for (const s of sessions.values()) { if (s.wf) s.shownPlan = s.wf.target; s.shownShip = shipOf(s).value; }
    if (view === 'map') { map.snap = true; process.stdout.write('\x1b[H' + mapRows(30).join('\n') + '\x1b[0m\n'); }
    else if (view === 'wall') process.stdout.write('\x1b[H' + wallRows(30).join('\n') + '\x1b[0m\n');
    else process.stdout.write(frame(30) + '\x1b[0m\n');
    process.exit(0);
  })();
} else if (WEB) startWeb();
else start();
