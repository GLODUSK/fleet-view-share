// sync-prefs.js: what Henry decides about his conversations and workspaces, the same on every device. Hiding or
// removing a conversation, renaming one, moving one to a workspace, hiding, renaming or ordering a workspace, the map's
// spots, the teams, where a kind of work stays (hostRules) and a chat kept on or let go from a machine (pinOverrides)
// are intent, not a view of one screen: done on the PC, the Mac does it too. What belongs to one
// screen (view, zoom, camera, window bounds, query, the repo filter, saved map views, accounts turned off, push
// targets, bots, compact, finishedOpen, steady, notify) never leaves the machine.
//
//   createPrefs({ api, key, log, now, device, read, apply, translate, load, save, timing })
//     -> { start(), stop(), tick(), nudge(), status() }
//
//   api        sync-api.js createSync()'s object (rest() only); key: the 32-byte sync key (the rows are sealed with it)
//   device()   this device's id (sync-move.js's device().id; nothing is written or read until it is known)
//   read()     -> { <group>: [local items] } for the GROUPS below, as this machine holds them (fleet-view.js)
//   apply(group, items) replaces that group here with these local items (in memory and saved; fleet-view.js)
//   translate  { out(root) -> { origin, name, known } | null, in({ origin, name }) -> a root here | null }: a repo root
//              as this machine names it, to and from the portable { origin (GitHub owner/name, or null), name (the
//              folder's name) }; known: the root is a folder this machine has (else its spot may be stale data)
//   load() / save(state): what this device last agreed with the table, kept across restarts (fleet-view.js keeps it
//              in settings.prefsSync): { v, device, keyId, groups: { <group>: { at, by, base } } }
//   now()      the clock (Date.now); timing: { ...TIMING } overrides (tests)
//
// The row: fleet_sync.settings key prefs:<group>, ONE per group that every device writes (last writer wins on the
// server), sealed with sync-crypto.js sealText(json, key, 'setting:prefs:<group>'), upserted on (user_id, key) with
// updated_at = its at (no migration: the settings table takes any key):
//   { v: 1, device, at, after: { by, at } | null, items: [portable items] }
// after: the row the writer had agreed on when it wrote this one (its device and at), so a reader knows whether the
// writer had seen its own last write. Portable items are the local ones with every repo root made { origin, name },
// so a root means the same repo on a machine where it lives in another folder (GROUPS below says what each group's
// items are). Groups other than repoOrder are sets: their order is never a change.
//
// Each device remembers per group the snapshot it last agreed on (base: the portable items, at and by: the at and
// device of the row then; prev: the base before its own last write; ride: base's keys that did not translate here
// then). Every round (5 s, or a nudge after a local save) it compares this machine's items with base:
//   - changed here: it lists the rows first (so a change made elsewhere is merged, not overwritten), then writes the
//     whole group, at most every 3 s per group
//   - a row whose at or device differs from base's, written by another device: taken. With no change here, it
//     replaces this machine's items; with one (both changed), the two are merged item by item (what changed here wins,
//     what was dropped here stays dropped, the rest is the other device's) and the result written back. A row written
//     without this device's last write (its after is not that write: both wrote at once) is merged the same way
//     against prev, so that write is not lost
//   - first join (this device never agreed on the group, or no row yet): the row and this machine's items are joined
//     (this machine's win on the same item), applied here and written
// A row's at is only ever compared for equality, never with this machine's clock. This device's own rows are skipped.
// Items that do not translate here (a repo with no checkout here: no folder with that origin or that name) are never
// lost: one this machine has under the same key stays as it is, and the rest ride along in base and go up again with
// the next write, so the device that has that repo gets them back. One that rode along and translates now (that repo
// turned up here) is put in here at the start of a round, never taken for a delete.
// Every device lists the prefs:* keys and updated_at every 10 s and fetches a value (key=in.(...)) only for the rows
// whose updated_at moved (compared as times: PostgREST answers +00:00 where this device wrote Z). A row that does not
// open with the key is said once and ignored until it changes.
'use strict';
const path = require('path');
const K = require(path.join(__dirname, 'sync-crypto.js'));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY_RE = /^prefs:([A-Za-z]+)$/;
const TEAM_RE = /^t[0-9a-f]{6,16}$/;
const TIMING = {
  tickMs: 5e3, // the loop's round
  minGapMs: 3e3, // at most one write of a group this often
  readMs: 10e3, // the rows are listed this often
  nudgeMs: 1e3, // a nudge (a local save) runs a round this soon
};
const MAX_ITEMS = 1000; // a snapshot carries at most this many (every group's own cap is lower)

const lower = (s) => (typeof s === 'string' ? s.toLowerCase() : '');
const short = (id) => String(id).slice(0, 8);
const errText = (e) => String((e && e.message) || e || '').replace(/\s+/g, ' ').slice(0, 200);
const waited = (t, last, ms) => t - last >= ms || t < last;
const num = (v) => (Number.isFinite(v) ? Math.round(v) : null);
const sig = (list) => JSON.stringify(list);
// an updated_at as a time (Z and +00:00 alike), or the text itself when it is not one
const stampOf = (s) => { const n = Date.parse(s); return Number.isFinite(n) ? n : String(s || ''); };

// the map's id for a repo's spot (web/map.js repoId): r: and the root, \ for /, no trailing \, lower case
const spotId = (root) => 'r:' + String(root).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();

// a portable root: { origin, name }, one of them at least
function cleanRoot(r) {
  if (!r || typeof r !== 'object') return null;
  const origin = typeof r.origin === 'string' && r.origin && r.origin.length <= 300 && !/\s/.test(r.origin) ? r.origin : null;
  const name = typeof r.name === 'string' && r.name && r.name.length <= 255 && !/[\\/\x00-\x1f]/.test(r.name) ? r.name : null;
  return origin || name ? { origin, name } : null;
}
// the key a portable root goes by: its origin, else its folder's name (lower case)
const rootKey = (r) => (r.origin ? 'o:' + lower(r.origin) : 'n:' + lower(r.name));
// a local root -> { root (portable), known } | null
function rootOut(tr, root) {
  if (typeof root !== 'string' || !root) return null;
  let o = null;
  try { o = tr.out(root); } catch {}
  const r = cleanRoot(o);
  return r ? { root: r, known: !!(o && o.known) } : null;
}
function rootIn(tr, r) {
  let x = null;
  try { x = tr.in(r); } catch {}
  return typeof x === 'string' && x ? x : null;
}

// The groups. Each: clean (a portable item as read from a row, or null), out (local item -> { p, known } | null),
// in (portable item -> local item | null when it does not translate here), key (a portable item's key) and lkey (a
// local item's key, to keep one per key); ordered: the order is the data (a merge takes this machine's whole list);
// localOnly(local item): one this machine keeps to itself (never goes up, and stays when the group is put in here).
const idOf = (x) => x.id;
const GROUPS = {
  // hidden and removed conversations: { id, at, forgot? }; at is when it was hidden (it shows again once it works
  // after that), forgot: taken off the Removed list for good (settings.forgotten)
  hidden: {
    clean(x) {
      if (!x || typeof x !== 'object' || !UUID_RE.test(lower(x.id)) || !(num(x.at) > 0)) return null;
      return x.forgot === true ? { id: lower(x.id), at: num(x.at), forgot: true } : { id: lower(x.id), at: num(x.at) };
    },
    out(x) { const p = this.clean(x); return p && { p, known: true }; },
    in: (p) => p, key: idOf, lkey: idOf,
  },
  // Fleet View's own names: { id, name }, name null for one cleared by hand
  names: {
    clean(x) {
      if (!x || typeof x !== 'object' || !UUID_RE.test(lower(x.id))) return null;
      if (x.name !== null && (typeof x.name !== 'string' || !x.name || x.name.length > 200)) return null;
      return { id: lower(x.id), name: x.name };
    },
    out(x) { const p = this.clean(x); return p && { p, known: true }; },
    in: (p) => p, key: idOf, lkey: idOf,
  },
  // conversations moved to a workspace by hand: { id, root, at }, root null for "back to its own repo"
  moved: {
    clean(x) {
      if (!x || typeof x !== 'object' || !UUID_RE.test(lower(x.id)) || !(num(x.at) > 0)) return null;
      const root = x.root === null ? null : cleanRoot(x.root);
      if (x.root !== null && !root) return null;
      return { id: lower(x.id), root, at: num(x.at) };
    },
    out(x, tr) {
      if (!x || typeof x !== 'object') return null;
      const r = x.root == null ? null : rootOut(tr, x.root);
      if (x.root != null && !r) return null;
      const p = this.clean({ id: x.id, root: r ? r.root : null, at: x.at });
      return p && { p, known: r ? r.known : true };
    },
    in(p, tr) {
      if (!p.root) return { id: p.id, root: null, at: p.at };
      const root = rootIn(tr, p.root);
      return root ? { id: p.id, root, at: p.at } : null;
    },
    key: idOf, lkey: idOf,
  },
  // workspaces taken off the list: { root, at }
  hiddenRepos: {
    clean(x) { const root = x && cleanRoot(x.root); return root && num(x.at) > 0 ? { root, at: num(x.at) } : null; },
    out(x, tr) { const r = x && rootOut(tr, x.root); const p = r && this.clean({ root: r.root, at: x.at }); return p && { p, known: r.known }; },
    in(p, tr) { const root = rootIn(tr, p.root); return root ? { root, at: p.at } : null; },
    key: (p) => rootKey(p.root), lkey: (l) => spotId(l.root),
  },
  // workspaces renamed in Fleet View: { root, name }
  repoNames: {
    clean(x) { const root = x && cleanRoot(x.root); return root && typeof x.name === 'string' && x.name && x.name.length <= 200 ? { root, name: x.name } : null; },
    out(x, tr) { const r = x && rootOut(tr, x.root); const p = r && this.clean({ root: r.root, name: x.name }); return p && { p, known: r.known }; },
    in(p, tr) { const root = rootIn(tr, p.root); return root ? { root, name: p.name } : null; },
    key: (p) => rootKey(p.root), lkey: (l) => spotId(l.root),
  },
  // the workspace list's order: roots (here) / portable roots (in the row)
  repoOrder: {
    ordered: true,
    clean: (x) => cleanRoot(x),
    out(x, tr) { const r = rootOut(tr, x); return r && { p: r.root, known: r.known }; },
    in: (p, tr) => rootIn(tr, p),
    key: (p) => rootKey(p), lkey: (l) => spotId(l),
  },
  // the map's pinned spots: { id, x, y, pin: true }. A repo's (id r:<root>) goes up as { repo, x, y, pin } and comes
  // back under this machine's root for it; a conversation's (s:<id>) and any other go as they are. Unpinned spots
  // stay on each machine: the map's spacing rule nudges them to fit that screen's groups, so two machines would keep
  // moving each other's; a pinned one only moves when it is dragged
  mapSpots: {
    localOnly: (x) => !x || x.pin !== true,
    clean(x) {
      if (!x || typeof x !== 'object' || x.pin !== true || !Number.isFinite(x.x) || !Number.isFinite(x.y) || Math.abs(x.x) > 1e6 || Math.abs(x.y) > 1e6) return null;
      const at = { x: Math.round(x.x), y: Math.round(x.y), pin: x.pin === true };
      if (x.repo) { const repo = cleanRoot(x.repo); return repo ? { repo, ...at } : null; }
      return typeof x.id === 'string' && x.id && x.id.length <= 1100 && !x.id.startsWith('r:') ? { id: x.id, ...at } : null;
    },
    out(x, tr) {
      if (!x || typeof x.id !== 'string') return null;
      if (!x.id.startsWith('r:')) { const p = this.clean(x); return p && { p, known: true }; }
      const r = rootOut(tr, x.id.slice(2));
      const p = r && this.clean({ repo: r.root, x: x.x, y: x.y, pin: x.pin });
      return p && { p, known: r.known };
    },
    in(p, tr) {
      if (!p.repo) return { id: p.id, x: p.x, y: p.y, pin: p.pin };
      const root = rootIn(tr, p.repo);
      return root ? { id: spotId(root), x: p.x, y: p.y, pin: p.pin } : null;
    },
    key: (p) => (p.repo ? 'r:' + rootKey(p.repo) : p.id), lkey: idOf,
  },
  // teams: as fleet-view.js keeps them, less seenAt (when this machine last saw a member: each device its own)
  teams: {
    clean(x) {
      if (!x || typeof x !== 'object' || typeof x.id !== 'string' || !TEAM_RE.test(x.id) || !Array.isArray(x.members)) return null;
      const members = x.members.filter((m) => typeof m === 'string' && m.length <= 80).slice(0, 50);
      if (members.length < 2) return null;
      const list = (v, n) => (Array.isArray(v) ? v.filter((m) => m && typeof m === 'object').slice(-n) : []);
      return {
        id: x.id, name: typeof x.name === 'string' ? x.name.slice(0, 200) : '', color: typeof x.color === 'string' ? x.color.slice(0, 20) : null,
        members, lead: typeof x.lead === 'string' ? x.lead.slice(0, 80) : null, order: typeof x.order === 'string' ? x.order.slice(0, 4000) : '',
        at: num(x.at) || 0, messages: list(x.messages, 50), successors: list(x.successors, 10),
      };
    },
    out(x) { const p = this.clean(x); return p && { p, known: true }; },
    in: (p) => p, key: idOf, lkey: idOf,
  },
  // where a kind of work stays (fleet-view.js hostRules): { id, repo: { origin, name } | null, paths: [globs],
  // tools: [tool names, a trailing * for a prefix], host: the device's name }. Portable as they are: the repo is
  // already { origin, name }
  hostRules: {
    clean: (x) => cleanHostRule(x),
    out(x) { const p = this.clean(x); return p && { p, known: true }; },
    in: (p) => p, key: idOf, lkey: idOf,
  },
  // a chat's own stays-on choice (fleet-view.js pinOverrides, POST /sync/pin): { id, mode: 'free' | 'stay', host?,
  // hostDevice?, at }, one per chat, so the host lets a freed chat go and the other machine stops refusing its move
  pinOverrides: {
    clean: (x) => cleanPinOverride(x),
    out(x) { const p = this.clean(x); return p && { p, known: true }; },
    in: (p) => p, key: idOf, lkey: idOf,
  },
};
const GROUP_NAMES = Object.keys(GROUPS);
// a stays-on rule, cleaned (null when it is not one): an id, a host, and at least one path glob or tool name
function cleanHostRule(x) {
  if (!x || typeof x !== 'object' || typeof x.id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(x.id)) return null;
  const host = typeof x.host === 'string' ? x.host.trim().slice(0, 100) : '';
  const strs = (v, re, n) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string' && re.test(s)).slice(0, n) : []);
  const paths = strs(x.paths, /^[^\n\r\0]{1,200}$/, 20);
  const tools = strs(x.tools, /^[A-Za-z0-9_.*-]{1,80}$/, 20);
  if (!host || (!paths.length && !tools.length)) return null;
  const repo = x.repo ? cleanRoot(x.repo) : null;
  if (x.repo && !repo) return null;
  // hostDevice: the host's sync device id (host keeps its name, and is the match while it has none); pinOn: what pins a
  // chat (host-rules.js PIN_ON), left out for 'any', the default
  const hostDevice = typeof x.hostDevice === 'string' && UUID_RE.test(lower(x.hostDevice)) ? lower(x.hostDevice) : null;
  const pinOn = PIN_ON.includes(x.pinOn) && x.pinOn !== 'any' ? x.pinOn : null;
  return { id: x.id, repo, paths, tools, host, ...(hostDevice ? { hostDevice } : {}), ...(pinOn ? { pinOn } : {}),
    ...(typeof x.note === 'string' && x.note ? { note: x.note.slice(0, 300) } : {}) };
}
const PIN_ON = ['any', 'edits', 'tools', 'none']; // host-rules.js PIN_ON
// a chat's own stays-on choice, cleaned (null when it is not one): { id: the chat's id, mode: 'free' (never pinned) |
// 'stay' (pinned to host, with or without a rule's evidence), host?: a device's name (stay needs one; free keeps the
// host it was pinned to, for "Keep on <host>"), hostDevice?: its sync device id, at }
function cleanPinOverride(x) {
  if (!x || typeof x !== 'object' || !UUID_RE.test(lower(x.id)) || (x.mode !== 'free' && x.mode !== 'stay') || !(num(x.at) > 0)) return null;
  const host = typeof x.host === 'string' ? x.host.trim().slice(0, 100) : '';
  if (x.mode === 'stay' && !host) return null;
  const hostDevice = host && typeof x.hostDevice === 'string' && UUID_RE.test(lower(x.hostDevice)) ? lower(x.hostDevice) : null;
  return { id: lower(x.id), mode: x.mode, ...(host ? { host } : {}), ...(hostDevice ? { hostDevice } : {}), at: num(x.at) };
}

// local items -> portable ones, one per key: a root this machine has wins over a stale one that names the same repo
function portable(g, items, tr) {
  const G = GROUPS[g], out = new Map();
  for (const x of Array.isArray(items) ? items.slice(0, MAX_ITEMS) : []) {
    let r = null;
    try { r = G.out(x, tr); } catch {}
    if (!r || !r.p) continue;
    const k = G.key(r.p), had = out.get(k);
    if (!had || (!had.known && r.known)) out.set(k, r);
  }
  return [...out.values()].map((r) => r.p);
}
// a row's items, cleaned, one per key (the first)
function cleanItems(g, items) {
  const G = GROUPS[g], out = new Map();
  for (const x of Array.isArray(items) ? items.slice(0, MAX_ITEMS) : []) {
    const p = G.clean(x);
    if (p && !out.has(G.key(p))) out.set(G.key(p), p);
  }
  return [...out.values()];
}
const byKey = (g, list) => new Map(list.map((p) => [GROUPS[g].key(p), p]));
// a group's items as compared: in order for an ordered group, else by key (a set: its order is never a change)
function sigOf(g, list) {
  if (GROUPS[g].ordered) return sig(list);
  return sig(list.map((p) => [String(GROUPS[g].key(p)), p]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map((x) => x[1]));
}
// first join: both, this machine's item on the same key (ordered: this machine's order, then the row's others)
function union(g, remote, local) {
  const m = byKey(g, remote), l = byKey(g, local);
  if (GROUPS[g].ordered) return [...local, ...remote.filter((p) => !l.has(GROUPS[g].key(p)))];
  for (const [k, p] of l) m.set(k, p);
  return [...m.values()];
}
// both changed since base: the row's items, with what changed here put in and what was dropped here taken out
// (ordered: this machine's whole list)
function merge3(g, base, local, remote) {
  if (GROUPS[g].ordered) return local;
  const m = byKey(g, remote), b = byKey(g, base), l = byKey(g, local);
  for (const [k, p] of l) if (!b.has(k) || sig(b.get(k)) !== sig(p)) m.set(k, p);
  for (const k of b.keys()) if (!l.has(k)) m.delete(k);
  return [...m.values()];
}

// The translation of repo roots, from what this machine knows:
//   makeTranslate({ roots: () => [local roots], originOf(root) -> 'owner/name' | null, exists(root) -> bool })
//   out(root): a root this machine lists -> its origin and folder name, known. Any other (a folder not listed, or
//     another machine's path that came in with old data): its own origin when it has one here, else the origin of the
//     root here with the same folder name (so a stale path names the repo this machine has), else no origin; known
//     only when the folder is there.
//   in({ origin, name }): the root here with that origin (the one with that folder name first), else one with that
//     folder name and no other origin, else null. Root keys compare in lower case, \ and / alike.
// Only roots whose folder is there are listed (a conversation copied from another machine may carry that machine's
// path: never a place to put a setting). A root's origin, once seen, is kept for the run, so a checkout that drops out
// for a while (a drive away, a folder moved) still goes by its origin, and its items keep their keys.
// The index is made again at most once a round (refresh(), which createPrefs calls at the start of each).
const normKey = (r) => String(r || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
const baseName = (r) => String(r || '').split(/[\\/]+/).filter(Boolean).pop() || '';
function makeTranslate(o = {}) {
  const rootsOf = typeof o.roots === 'function' ? o.roots : () => [];
  const originOf = typeof o.originOf === 'function' ? o.originOf : () => null;
  const exists = typeof o.exists === 'function' ? o.exists : () => false;
  const safe = (f, x) => { try { return f(x); } catch { return null; } };
  const seen = new Map(); // root key -> its origin, as last seen this run
  let idx = null;
  function index() {
    if (idx) return idx;
    idx = { byKey: new Map(), byOrigin: new Map(), byName: new Map() };
    let list = [];
    try { list = rootsOf() || []; } catch {}
    for (const root of list) {
      if (typeof root !== 'string' || !root || idx.byKey.has(normKey(root)) || !safe(exists, root)) continue;
      const origin = safe(originOf, root) || null;
      if (origin) seen.set(normKey(root), origin);
      const e = { root, origin, name: baseName(root) };
      idx.byKey.set(normKey(root), e);
      if (origin) { const k = lower(origin); if (!idx.byOrigin.has(k)) idx.byOrigin.set(k, []); idx.byOrigin.get(k).push(e); }
      const n = lower(e.name);
      if (n) { if (!idx.byName.has(n)) idx.byName.set(n, []); idx.byName.get(n).push(e); }
    }
    return idx;
  }
  function out(root) {
    if (typeof root !== 'string' || !root) return null;
    const x = index(), hit = x.byKey.get(normKey(root));
    if (hit) return { origin: hit.origin, name: hit.name, known: true };
    const name = baseName(root), own = safe(originOf, root) || seen.get(normKey(root));
    if (own) return { origin: own, name, known: !!safe(exists, root) };
    const same = (x.byName.get(lower(name)) || []).find((e) => e.origin);
    return { origin: same ? same.origin : null, name, known: false };
  }
  function into(p) {
    const r = cleanRoot(p);
    if (!r) return null;
    const x = index(), n = lower(r.name);
    if (r.origin) {
      const list = x.byOrigin.get(lower(r.origin));
      if (list && list.length) return (list.find((e) => lower(e.name) === n) || list[0]).root;
    }
    const same = (x.byName.get(n) || []).find((e) => !e.origin || (r.origin && lower(e.origin) === lower(r.origin)));
    return same ? same.root : null;
  }
  return { out, in: into, refresh() { idx = null; } };
}

function createPrefs(o = {}) {
  const api = o.api;
  if (!api || typeof api.rest !== 'function') throw new Error('createPrefs needs the sync api');
  const key = o.key;
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('createPrefs needs the 32-byte sync key');
  if (typeof o.read !== 'function' || typeof o.apply !== 'function') throw new Error('createPrefs needs read() and apply()');
  const tr = o.translate && typeof o.translate.out === 'function' && typeof o.translate.in === 'function' ? o.translate : { out: () => null, in: () => null };
  const log = typeof o.log === 'function' ? o.log : () => {};
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const tm = { ...TIMING, ...(o.timing || {}) };
  const deviceOf = typeof o.device === 'function' ? o.device : () => o.device;
  const said = new Map();
  const logOnce = (k, t) => { if (said.get(k) === t) return; said.set(k, t); log(t); };
  const keyId = K.sha256(key).slice(0, 16);

  let me = null, st = null; // st: the saved state, once me is known
  let lastRead = -Infinity, ready = false, writes = 0, fetched = 0, taken = 0;
  const lastWrite = new Map(); // group -> this clock at its last write
  const stamps = new Map(); // group -> the updated_at its row had when last listed (fetched or written)

  function loadState() {
    let s = null;
    try { s = typeof o.load === 'function' ? o.load() : null; } catch {}
    const ok = s && typeof s === 'object' && s.v === 1 && s.device === me && s.keyId === keyId && s.groups && typeof s.groups === 'object';
    const groups = {};
    if (ok) {
      for (const g of GROUP_NAMES) {
        const x = s.groups[g];
        if (!x || !Number.isFinite(x.at) || typeof x.by !== 'string' || !Array.isArray(x.base)) continue;
        groups[g] = { at: x.at, by: x.by, base: cleanItems(g, x.base), ride: Array.isArray(x.ride) ? x.ride.filter((k) => typeof k === 'string') : [] };
        if (Array.isArray(x.prev)) groups[g].prev = cleanItems(g, x.prev);
      }
    }
    st = { v: 1, device: me, keyId, groups };
  }
  function saveState() { try { if (typeof o.save === 'function') o.save(st); } catch (e) { logOnce('save', `prefs: what this device agreed on could not be saved (${errText(e)})`); } }

  // this machine's items of every group, local and portable
  function readLocal() {
    let all = null;
    try { all = o.read(); } catch (e) { logOnce('read-local', `prefs: this device's settings could not be read (${errText(e)})`); return null; }
    return all && typeof all === 'object' ? all : null;
  }
  // what this machine holds of group g, portable: its own items, and base's items that do not translate here (they
  // ride along so the device that has their repo keeps them)
  function view(g, local, base) {
    const G = GROUPS[g], mine = portable(g, local, tr), have = new Set(mine.map((p) => G.key(p)));
    const ride = [];
    for (const p of base || []) {
      if (have.has(G.key(p))) continue;
      let l = null;
      try { l = G.in(p, tr); } catch {}
      if (!l) ride.push(p);
    }
    return [...mine, ...ride];
  }
  // the keys of a group's portable items that do not translate here (they ride along)
  function rideOf(g, items) {
    const G = GROUPS[g], out = [];
    for (const p of items) {
      let l = null;
      try { l = G.in(p, tr); } catch {}
      if (!l) out.push(String(G.key(p)));
    }
    return out;
  }
  // puts the portable items in here: each translated, or (when it does not translate) this machine's own item of
  // that key kept; one per local key. The group's local-only items stay as they are (unless an item put in takes
  // their place)
  function applyGroup(g, items, local) {
    const G = GROUPS[g], mineByKey = new Map();
    for (const x of Array.isArray(local) ? local : []) {
      let r = null;
      try { r = G.out(x, tr); } catch {}
      if (r && r.p && !mineByKey.has(G.key(r.p))) mineByKey.set(G.key(r.p), x);
    }
    const out = new Map();
    for (const p of items) {
      let l = null;
      try { l = G.in(p, tr); } catch {}
      if (!l) l = mineByKey.get(G.key(p)) || null;
      if (!l) continue;
      const lk = G.lkey(l);
      if (!out.has(lk)) out.set(lk, l);
    }
    if (G.localOnly) {
      for (const x of Array.isArray(local) ? local : []) {
        if (!G.localOnly(x)) continue;
        let lk = null;
        try { lk = G.lkey(x); } catch {}
        if (lk != null && !out.has(lk)) out.set(lk, x);
      }
    }
    o.apply(g, [...out.values()]);
  }
  // what this device agreed on for group g: the row (at, by) and what this machine holds as agreed
  function agree(g, at, by, base, prev) {
    st.groups[g] = { at, by, base, ride: rideOf(g, base) };
    if (prev) st.groups[g].prev = prev;
  }

  async function write(g, items, t) {
    const gs = st.groups[g];
    const at = Math.max(t, gs ? gs.at + 1 : 0);
    const k = `prefs:${g}`;
    const after = gs ? { by: gs.by, at: gs.at } : null;
    lastWrite.set(g, t);
    await api.rest('POST', 'settings', {
      query: { on_conflict: 'user_id,key' }, prefer: 'resolution=merge-duplicates,return=minimal',
      body: { key: k, value_enc: K.sealText(JSON.stringify({ v: 1, device: me, at, after, items }), key, `setting:${k}`), updated_at: new Date(at).toISOString() },
    });
    writes++;
    stamps.set(g, at);
    agree(g, at, me, items, gs ? gs.base : []);
    said.delete(`write|${g}`);
  }

  // one row's value -> { device, at, after, items } or null (said once) when it does not open as a snapshot of group g
  function openRow(row, g) {
    let v = null;
    try { v = JSON.parse(K.openText(row.value_enc, key, `setting:${row.key}`)); } catch {}
    if (!v || v.v !== 1 || !UUID_RE.test(lower(v.device)) || !Number.isFinite(v.at) || !Array.isArray(v.items)) {
      logOnce(`bad|${row.key}`, `prefs: the ${g} row does not open with this key; ignored`);
      return null;
    }
    const a = v.after && typeof v.after === 'object' && typeof v.after.by === 'string' && Number.isFinite(v.after.at) ? { by: lower(v.after.by), at: v.after.at } : null;
    return { device: lower(v.device), at: v.at, after: a, items: cleanItems(g, v.items) };
  }
  // a row another device wrote (or this one, in a run that forgot it): taken in
  async function take(g, v, t) {
    const gs = st.groups[g];
    if (gs && gs.at === v.at && gs.by === v.device) return; // agreed on already
    if (v.device === me && gs && gs.by === me) return; // this device's own write
    const all = readLocal();
    if (!all) return;
    const local = all[g];
    const mine = view(g, local, gs ? gs.base : []);
    const changed = !gs || sigOf(g, mine) !== sigOf(g, gs.base);
    // this device wrote last and the row was made without that write (both wrote at once): what this device wrote
    // counts as changed here, against what it had agreed before it
    const missed = !!gs && gs.by === me && !(v.after && v.after.by === me && v.after.at === gs.at);
    const merged = !gs ? union(g, v.items, mine) : missed ? merge3(g, gs.prev || [], mine, v.items) : changed ? merge3(g, gs.base, mine, v.items) : v.items;
    try { applyGroup(g, merged, local); } catch (e) { logOnce(`apply|${g}`, `prefs: the ${g} from ${short(v.device)} could not be put in here (${errText(e)})`); return; }
    taken++;
    log(`prefs: took ${g} from ${short(v.device)} (${v.items.length} item${v.items.length === 1 ? '' : 's'}${!gs ? ', joined with this device\'s' : missed ? ', merged with this device\'s write it did not have' : changed ? ', merged with a change here' : ''})`);
    // what this machine holds now, as agreed: the row's, with what rides along
    const after = readLocal();
    const now2 = view(g, after ? after[g] : [], merged);
    // changed here too (or first join, or a write the row missed): the result goes up. Not written: base stays the
    // row's, so this machine's items differ from it and the next round tries again
    if ((changed || missed) && sigOf(g, now2) !== sigOf(g, v.items)) {
      agree(g, v.at, v.device, v.items);
      try { await write(g, now2, t); } catch (e) { logOnce(`write|${g}`, `prefs: the ${g} could not be written (${errText(e)})`); }
    } else agree(g, v.at, v.device, now2);
    saveState();
  }
  // items that rode along and translate now (their repo turned up here): put in here, never taken for a delete. With
  // no other change here, what this machine holds is then what it agreed on (no write); with one, that goes up as usual
  function adopt(all) {
    let put = false;
    for (const g of GROUP_NAMES) {
      const gs = st.groups[g];
      if (!gs || !gs.ride || !gs.ride.length || !(g in all)) continue;
      const G = GROUPS[g], ride = new Set(gs.ride);
      const comes = gs.base.filter((p) => { if (!ride.has(String(G.key(p)))) return false; try { return !!G.in(p, tr); } catch { return false; } });
      if (!comes.length) continue;
      const local = all[g], mine = portable(g, local, tr), have = new Set(mine.map((p) => G.key(p)));
      const add = comes.filter((p) => !have.has(G.key(p)));
      const cameK = new Set(comes.map((p) => G.key(p))), addK = new Set(add.map((p) => G.key(p)));
      // no other change here: what this machine holds is base less the ones it is about to put in
      const clean = sigOf(g, view(g, local, gs.base)) === sigOf(g, gs.base.filter((p) => !addK.has(G.key(p))));
      if (add.length) {
        let next;
        if (G.ordered) {
          // each where it stands in base: after the nearest one before it that this machine lists
          next = mine.slice();
          for (const p of add) {
            const i = gs.base.findIndex((b) => G.key(b) === G.key(p));
            let pos = 0;
            for (let j = i - 1; j >= 0; j--) { const at = next.findIndex((x) => G.key(x) === G.key(gs.base[j])); if (at >= 0) { pos = at + 1; break; } }
            next.splice(pos, 0, p);
          }
        } else next = [...mine, ...add];
        try { applyGroup(g, next, local); } catch (e) { logOnce(`apply|${g}`, `prefs: the ${g} could not be put in here (${errText(e)})`); continue; }
        log(`prefs: put in ${add.length} ${g} item${add.length === 1 ? '' : 's'} for a repo found here`);
      }
      const after = readLocal();
      gs.ride = gs.ride.filter((k) => !cameK.has(k));
      if (clean && after) gs.base = view(g, after[g], gs.base);
      put = true;
    }
    if (put) saveState();
  }
  async function read(t) {
    lastRead = t;
    let rows;
    try { rows = await api.rest('GET', 'settings', { query: { select: 'key,updated_at', key: 'like.prefs:*' } }); said.delete('list'); } catch (e) { logOnce('list', `prefs: the shared settings could not be listed (${errText(e)})`); return false; }
    const moved = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      const m = row && typeof row.key === 'string' ? KEY_RE.exec(row.key) : null;
      if (!m || !GROUPS[m[1]]) continue;
      if (stamps.get(m[1]) !== stampOf(row.updated_at)) moved.push(m[1]);
    }
    if (moved.length) {
      let full;
      try {
        full = await api.rest('GET', 'settings', { query: { select: 'key,value_enc,updated_at', key: `in.(${moved.map((g) => `"prefs:${g}"`).join(',')})` } });
        said.delete('fetch');
      } catch (e) { logOnce('fetch', `prefs: the shared settings could not be read (${errText(e)})`); return false; }
      for (const row of Array.isArray(full) ? full : []) {
        const m = row && typeof row.key === 'string' ? KEY_RE.exec(row.key) : null;
        if (!m || !moved.includes(m[1])) continue;
        fetched++;
        stamps.set(m[1], stampOf(row.updated_at));
        const v = openRow(row, m[1]);
        if (v) await take(m[1], v, now());
      }
    }
    ready = true;
    return true;
  }
  // the groups changed here since they were agreed (or never agreed: first join with no row)
  function dirty() {
    const all = readLocal(), out = new Map();
    if (!all) return out;
    for (const g of GROUP_NAMES) {
      if (!(g in all)) continue; // a group read() does not give is not synced
      const gs = st.groups[g];
      const mine = view(g, all[g], gs ? gs.base : []);
      if (!gs || sigOf(g, mine) !== sigOf(g, gs.base)) out.set(g, mine);
    }
    return out;
  }
  async function tickOnce() {
    if (!me) {
      let d = null;
      try { d = deviceOf(); } catch {}
      d = lower(d && typeof d === 'object' ? d.id : d);
      if (!UUID_RE.test(d)) return; // the mover has not asked for its device row yet
      me = d;
      loadState();
    }
    try { if (typeof tr.refresh === 'function') tr.refresh(); } catch {}
    const t = now();
    { const all = readLocal(); if (all) adopt(all); }
    let due = dirty();
    // a change here lists the rows first, so one made elsewhere since is merged in, never written over
    if (waited(t, lastRead, tm.readMs) || (due.size && [...due.keys()].some((g) => waited(t, lastWrite.get(g) ?? -Infinity, tm.minGapMs)))) {
      if (!(await read(t))) return;
      due = dirty();
    }
    if (!ready || !due.size) return;
    let wrote = false;
    for (let [g, items] of due) {
      const t2 = now();
      if (!waited(t2, lastWrite.get(g) ?? -Infinity, tm.minGapMs)) continue;
      // first join with no row: this machine's items go through the translation once, which mends stale ones (a
      // spot under another machine's path is put on this machine's root for that repo, or left out)
      if (!st.groups[g]) {
        const all = readLocal();
        if (!all) continue;
        try { applyGroup(g, items, all[g]); } catch (e) { logOnce(`apply|${g}`, `prefs: the ${g} could not be put in here (${errText(e)})`); continue; }
        const after = readLocal();
        if (after) items = view(g, after[g], items);
      }
      try { await write(g, items, t2); wrote = true; } catch (e) { logOnce(`write|${g}`, `prefs: the ${g} could not be written (${errText(e)})`); }
    }
    if (wrote) saveState();
  }

  // ---------- the loop ----------
  let running = false, timer = null, dueAt = 0, ticking = null;
  function tick() {
    if (ticking) return ticking;
    ticking = tickOnce().catch((e) => logOnce('tick', `prefs: a round failed (${errText(e)})`)).finally(() => { ticking = null; });
    return ticking;
  }
  function schedule(ms) {
    if (!running) return;
    const at = Date.now() + ms;
    if (timer && dueAt <= at) return; // one sooner is set already
    if (timer) clearTimeout(timer);
    dueAt = at;
    timer = setTimeout(loop, ms);
    if (timer.unref) timer.unref();
  }
  async function loop() {
    timer = null;
    if (!running) return;
    await tick();
    schedule(tm.tickMs);
  }
  function start() { if (running) return; running = true; schedule(0); }
  async function stop() {
    running = false;
    if (timer) { clearTimeout(timer); timer = null; }
    try { if (ticking) await ticking; } catch {}
  }
  // a local save: a round soon, so a change goes up within a few seconds
  function nudge() { schedule(tm.nudgeMs); }
  const status = () => ({ device: me, ready, writes, fetched, taken, groups: st ? Object.keys(st.groups).length : 0 });

  return { start, stop, tick, nudge, status };
}

module.exports = { createPrefs, makeTranslate, GROUPS, GROUP_NAMES, TIMING, cleanRoot, cleanHostRule, cleanPinOverride, spotId, portable, cleanItems, union, merge3 };
