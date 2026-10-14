// sync-prefs.js: what Henry decides about his conversations and workspaces, the same on every device. Hiding or
// removing a conversation, renaming one, moving one to a workspace, hiding, adding, renaming or ordering a workspace,
// the colours picked for workspaces and conversations (repoHues, sessHues), the map's spots, the teams, where a kind of work stays (hostRules), a chat kept on or let go from a machine
// (pinOverrides), the chats whose model or effort is Dynamic (dynamicChats), the Bots list's order and pins (chatOrder), a bot's look
// (botLooks), housekeeping's keep-pins on GitHub branches (keepPins) and the parity rules (parity) are intent, not
// a view of one screen: done on the PC, the Mac does it too. What belongs to one
// screen (view, zoom, camera, window bounds, query, the repo filter, saved map views, accounts turned off, push
// targets, bots (the registry; only their looks go), compact, finishedOpen, steady, notify) never leaves the machine.
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
//   { v: 1, device, at, after: { by, at } | null, items: [portable items], gone?: [[key, at]] }
// after: the row the writer had agreed on when it wrote this one (its device and at), so a reader knows whether the
// writer had seen its own last write. gone: the group's tombstones (a key taken out, and when, on the clock of the
// device that took it out; GONE_MS, GONE_MAX), left out when there are none; an older device ignores it. Portable items are the local ones with every repo root made { origin, name },
// so a root means the same repo on a machine where it lives in another folder (GROUPS below says what each group's
// items are). Groups other than repoOrder are sets: their order is never a change.
//
// Each device remembers per group the snapshot it last agreed on (base: the portable items, at and by: the at and
// device of the row then; prev: the base before its own last write; ride: base's keys that did not translate here
// then). Every round (5 s, or a nudge after a local save) it compares this machine's items with base:
//   - changed here: it lists the rows first (so a change made elsewhere is merged, not overwritten), then writes the
//     whole group, at most every 3 s per group
//   - a row whose at or device differs from base's, written by another device: taken. With no change here, it
//     replaces this machine's items; with one (both changed), the two are merged item by item (merge3: what changed
//     here wins, what was dropped here stays dropped, the rest is the other device's; unless the tombstones and the
//     items' own times say the other side's change came later; teams field by field; repoOrder by mergeOrder) and the
//     result written back. A row written without this device's last write (its after is not that write: both wrote
//     at once) is merged the same way against prev, so that write is not lost
//   - first join (this device never agreed on the group, or no row yet): a device that never agreed on any group takes
//     the row, adding its own items only when they are newer than the row (join); a device that syncs other groups
//     already joins a new group with the row (union: this machine's win on the same item); applied here and written
// Besides the first join and the tombstones, a row's at is only compared for equality. This device's own rows are skipped.
// Items that do not translate here (a repo with no checkout here: no folder with that origin or that name) are never
// lost: one this machine has under the same key stays as it is, and the rest ride along in base and go up again with
// the next write, so the device that has that repo gets them back. One that rode along and translates now (that repo
// turned up here) is put in here at the start of a round, never taken for a delete.
// Every device lists the prefs:* keys and updated_at every 10 s and fetches a value (key=in.(...)) only for the rows
// whose updated_at moved (compared as times: PostgREST answers +00:00 where this device wrote Z). A row that does not
// open with the key is said once and ignored until it changes, and never written over by a first join. In repoOrder
// an item that does not translate here rides at its place in the order, so such a device never reorders it.
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
const TEAM_MSGS = 50, TEAM_SUCC = 10; // a team keeps its last 50 messages and 10 successors (fleet-view.js cleanTeams)
// Tombstones: a key taken out of a group is remembered with when (this device's clock) for GONE_MS, at most GONE_MAX
// per group, and goes up in the row's gone, so a merge can tell a removal from an item the other device never had
const GONE_MS = 30 * 24 * 3600e3, GONE_MAX = 500;

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
// a colour's tone round the wheel, 0-359 (fleet-view.js cleanHue), or null
const cleanHue = (h) => (Number.isFinite(h) ? ((Math.round(h) % 360) + 360) % 360 : null);
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
  hiddenRepos: rootAtGroup(),
  // workspaces added by hand (fleet-view.js addedRepos, POST /repos/add): { root, at }; one added on the PC is added on
  // the Mac too when the Mac has a checkout of that repo (else it rides along), one removed goes on both
  addedRepos: rootAtGroup(),
  // workspaces renamed in Fleet View: { root, name }
  repoNames: {
    clean(x) { const root = x && cleanRoot(x.root); return root && typeof x.name === 'string' && x.name && x.name.length <= 200 ? { root, name: x.name } : null; },
    out(x, tr) { const r = x && rootOut(tr, x.root); const p = r && this.clean({ root: r.root, name: x.name }); return p && { p, known: r.known }; },
    in(p, tr) { const root = rootIn(tr, p.root); return root ? { root, name: p.name } : null; },
    key: (p) => rootKey(p.root), lkey: (l) => spotId(l.root),
  },
  // workspace colours picked in Fleet View (right-click "Colour"; fleet-view.js repoHues): { root, hue, at }, hue a tone
  // round the colour wheel (0-359), at when it was picked. "Default" takes the item out
  repoHues: {
    clean(x) { const root = x && cleanRoot(x.root), hue = x && cleanHue(x.hue); return root && hue !== null ? { root, hue, ...(num(x.at) > 0 ? { at: num(x.at) } : {}) } : null; },
    out(x, tr) { const r = x && rootOut(tr, x.root); const p = r && this.clean({ root: r.root, hue: x.hue, at: x.at }); return p && { p, known: r.known }; },
    in(p, tr) { const root = rootIn(tr, p.root); return root ? { root, hue: p.hue, ...(p.at ? { at: p.at } : {}) } : null; },
    key: (p) => rootKey(p.root), lkey: (l) => spotId(l.root),
  },
  // a conversation's own colour (fleet-view.js sessHues): { id, hue, at }; it wins over its workspace's
  sessHues: {
    clean(x) {
      const hue = x && cleanHue(x.hue);
      return x && typeof x === 'object' && UUID_RE.test(lower(x.id)) && hue !== null ? { id: lower(x.id), hue, ...(num(x.at) > 0 ? { at: num(x.at) } : {}) } : null;
    },
    out(x) { const p = this.clean(x); return p && { p, known: true }; },
    in: (p) => p, key: idOf, lkey: idOf,
  },
  // the workspace list's order: roots (here) / portable roots (in the row)
  repoOrder: {
    ordered: true,
    clean: (x) => cleanRoot(x),
    out(x, tr) { const r = rootOut(tr, x); return r && { p: r.root, known: r.known }; },
    in: (p, tr) => rootIn(tr, p),
    key: (p) => rootKey(p), lkey: (l) => spotId(l),
  },
  // the Bots list's order and pins (fleet-view.js chatOrder): { key, pin? } here, the pinned ones first; { k, pin? } in
  // the row. A team's key goes as it is; a bot's goes by its folder's name ('bots:<slug>'), since its
  // id is each machine's own: the other machine lists it as one of its elsewhere bots (bots.js), whose id comes from
  // that name (translate.bot: { out(bot id) -> slug | null, in(slug) -> bot id | null })
  chatOrder: {
    ordered: true,
    clean(x) {
      const k = x && typeof x.k === 'string' ? x.k : null;
      return k && CHAT_PORTABLE_RE.test(k) ? { k, ...(x.pin === true ? { pin: true } : {}) } : null;
    },
    out(x, tr) {
      if (!x || typeof x.key !== 'string' || !CHAT_KEY_RE.test(x.key)) return null;
      let k = x.key;
      if (k.startsWith('bot:')) { let s = null; try { s = tr.bot ? tr.bot.out(k.slice(4)) : null; } catch {} k = typeof s === 'string' && s ? 'bots:' + lower(s) : null; }
      const p = k && this.clean({ k, pin: x.pin });
      return p && { p, known: true };
    },
    in(p, tr) {
      let key = p.k;
      if (key.startsWith('bots:')) { let id = null; try { id = tr.bot ? tr.bot.in(key.slice(5)) : null; } catch {} key = typeof id === 'string' && /^[0-9a-f]{12}$/.test(id) ? 'bot:' + id : null; }
      return key ? { key, ...(p.pin ? { pin: true } : {}) } : null;
    },
    key: (p) => p.k, lkey: (l) => l.key,
  },
  // a bot's look (its avatar's shape and colour: bots.js) and its role, by its folder's name, lower case (fleet-view.js
  // botLooks): { slug, shape?, color?, role?, at? }, one of the three at least, at when the look or role last changed. A bot's registry is
  // its machine's own, but the other machine lists it as an elsewhere bot from that folder, which wears this look. Each
  // machine's items for its own bots are made from its registry every read (that machine alone changes them); a bot back
  // to Default on both, or removed, has none (its elsewhere bot is its account's colour again)
  botLooks: {
    clean: (x) => cleanBotLook(x),
    out(x) { const p = this.clean(x); return p && { p, known: true }; },
    in: (p) => p, key: (p) => p.slug, lkey: (l) => l.slug,
  },
  // the map's pinned spots: { id, x, y, pin: true }. A repo's (id r:<root>) goes up as { repo, x, y, pin } and comes
  // back under this machine's root for it; a conversation's (s:<id>) and any other go as they are. Unpinned spots
  // stay on each machine: the map's spacing rule nudges them to fit that screen's groups, so two machines would keep
  // moving each other's; a pinned one only moves when it is dragged. at: when it last changed here (fleet-view.js stamps
  // it; an older device's spots have none), so an unpin made after a drag elsewhere wins over that drag (merge3)
  mapSpots: {
    localOnly: (x) => !x || x.pin !== true,
    // a pinned repo spot the merged group no longer has (unpinned or dropped on another device) stays here unpinned
    // where it is, so the page sees the unpin (web/map.js syncSpots) instead of a spot gone, which it would put back
    // pinned and send again. A conversation's spot is dropped as before (the page puts it back on its repo's ring)
    demote: (x) => (x && typeof x.id === 'string' && x.id.startsWith('r:') ? { ...x, pin: false } : null),
    clean(x) {
      if (!x || typeof x !== 'object' || x.pin !== true || !Number.isFinite(x.x) || !Number.isFinite(x.y) || Math.abs(x.x) > 1e6 || Math.abs(x.y) > 1e6) return null;
      const pos = { x: Math.round(x.x), y: Math.round(x.y), pin: x.pin === true, ...(num(x.at) > 0 ? { at: num(x.at) } : {}) };
      if (x.repo) { const repo = cleanRoot(x.repo); return repo ? { repo, ...pos } : null; }
      return typeof x.id === 'string' && x.id && x.id.length <= 1100 && !x.id.startsWith('r:') ? { id: x.id, ...pos } : null;
    },
    out(x, tr) {
      if (!x || typeof x.id !== 'string') return null;
      if (!x.id.startsWith('r:')) { const p = this.clean(x); return p && { p, known: true }; }
      const r = rootOut(tr, x.id.slice(2));
      const p = r && this.clean({ repo: r.root, x: x.x, y: x.y, pin: x.pin, at: x.at });
      return p && { p, known: r.known };
    },
    in(p, tr) {
      const pos = { x: p.x, y: p.y, pin: p.pin, ...(p.at ? { at: p.at } : {}) };
      if (!p.repo) return { id: p.id, ...pos };
      const root = rootIn(tr, p.repo);
      return root ? { id: spotId(root), ...pos } : null;
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
        at: num(x.at) || 0, messages: list(x.messages, TEAM_MSGS), successors: list(x.successors, TEAM_SUCC),
      };
    },
    out(x) { const p = this.clean(x); return p && { p, known: true }; },
    in: (p) => p, key: idOf, lkey: idOf,
    // a team's time: its newest message or hand-off, else when it was made
    time: (p) => Math.max(p.at || 0, ...p.messages.map((m) => Number(m.t) || 0), ...p.successors.map((s) => Number(s.at) || 0)) || null,
    // changed on both devices: field by field. A field changed here is this device's, else the other's; the messages
    // and the successors are both devices' together, one of each (the same t, from, to and text; the same from, to
    // and at), in time order, the newest TEAM_MSGS and TEAM_SUCC
    merge(b, l, r) {
      const pick = (f) => (b && sig(l[f]) === sig(b[f]) ? r[f] : l[f]);
      const both = (f, keyOf, timeOf, n) => {
        const m = new Map();
        for (const x of [...(r[f] || []), ...(l[f] || [])]) { const k = keyOf(x); if (!m.has(k)) m.set(k, x); }
        return [...m.values()].sort((a, c) => timeOf(a) - timeOf(c)).slice(-n);
      };
      return this.clean({
        id: l.id, name: pick('name'), color: pick('color'), members: pick('members'), lead: pick('lead'), order: pick('order'), at: pick('at'),
        messages: both('messages', (m) => sig([m.t, m.from, m.to, m.text]), (m) => Number(m.t) || 0, TEAM_MSGS),
        successors: both('successors', (m) => sig([m.from, m.to, m.at]), (m) => Number(m.at) || 0, TEAM_SUCC),
      }) || l;
    },
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
  // a chat's Dynamic parts (fleet-view.js dynamicChats, POST /chat/dynamic): { id, model, effort, at }, one per chat
  dynamicChats: {
    clean: (x) => cleanDynamicChat(x),
    out(x) { const p = this.clean(x); return p && { p, known: true }; },
    in: (p) => p, key: idOf, lkey: idOf,
  },
  // housekeeping's "Keep" on a GitHub branch (housekeeping.js remotePins): { root, branch, at } here, { repo, branch, at }
  // in the row. A GitHub branch is the same on every device, so its keep-pin is too; worktrees and local branches are
  // each machine's own and never go
  keepPins: {
    clean(x) {
      const repo = x && typeof x === 'object' ? cleanRoot(x.repo) : null;
      const branch = x && typeof x.branch === 'string' && x.branch && x.branch.length <= 255 && !/[\x00-\x1f]/.test(x.branch) ? x.branch : null;
      return repo && branch && num(x.at) > 0 ? { repo, branch, at: num(x.at) } : null;
    },
    out(x, tr) { const r = x && rootOut(tr, x.root); const p = r && this.clean({ repo: r.root, branch: x.branch, at: x.at }); return p && { p, known: r.known }; },
    in(p, tr) { const root = rootIn(tr, p.repo); return root ? { root, branch: p.branch, at: p.at } : null; },
    key: (p) => rootKey(p.repo) + '|' + p.branch, lkey: (l) => spotId(l.root) + '|' + l.branch,
  },
  // parity rules (fleet-view.js settings.parity): { name, web, app, core }, one per repo name (lower case)
  parity: {
    clean(x) {
      if (!x || typeof x !== 'object' || typeof x.name !== 'string' || !x.name.trim() || x.name.length > 200) return null;
      const pre = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s && s.length <= 200).slice(0, 40) : []);
      const r = { name: x.name.trim(), web: pre(x.web), app: pre(x.app), core: pre(x.core) };
      return r.web.length && r.app.length ? r : null;
    },
    out(x) { const p = this.clean(x); return p && { p, known: true }; },
    in: (p) => p, key: (p) => lower(p.name), lkey: (l) => lower(l.name),
  },
};
const GROUP_NAMES = Object.keys(GROUPS);
// a group of { root, at } (hiddenRepos, addedRepos)
function rootAtGroup() {
  return {
    clean(x) { const root = x && cleanRoot(x.root); return root && num(x.at) > 0 ? { root, at: num(x.at) } : null; },
    out(x, tr) { const r = x && rootOut(tr, x.root); const p = r && this.clean({ root: r.root, at: x.at }); return p && { p, known: r.known }; },
    in(p, tr) { const root = rootIn(tr, p.root); return root ? { root, at: p.at } : null; },
    key: (p) => rootKey(p.root), lkey: (l) => spotId(l.root),
  };
}
// an item's time (when it was made or last changed), from its own at (a group's time() when it has one); null when it
// has none (names, repoNames, repoOrder, hostRules, parity, an older device's spots): those merge as before, by base
function timeOf(g, p) {
  const G = GROUPS[g];
  let t = null;
  try { t = G.time ? G.time(p) : p && p.at; } catch {}
  return Number.isFinite(t) && t > 0 ? t : null;
}
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

// a chat's Dynamic parts: { id, model, effort (true: sized for each message), at }; null when neither is on
function cleanDynamicChat(x) {
  if (!x || typeof x !== 'object' || !UUID_RE.test(lower(x.id)) || !(num(x.at) > 0)) return null;
  const model = x.model === true, effort = x.effort === true;
  return model || effort ? { id: lower(x.id), model, effort, at: num(x.at) } : null;
}

// a bot's look (the botLooks group): { slug: its folder's name, lower case, shape?: one of BOT_SHAPES, color?: #rrggbb
// (lower case), role?: its role (bots.js checkRole: one line, at most BOT_ROLE_MAX), at? }; null when the slug, a shape
// or a colour given is not one, or it has none of the three. A role that is not one is left out (the look still goes)
const BOT_SHAPES = ['hex', 'drop', 'round', 'pill', 'tri', 'square', 'star', 'clover', 'flower', 'heart']; // bots.js SHAPES (scripts/sync-prefs-test.js checks the two agree)
const BOT_SLUG_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const BOT_ROLE_MAX = 60; // bots.js ROLE_MAX
const botRole = (v) => { const t = typeof v === 'string' ? v.trim() : ''; return t && t.length <= BOT_ROLE_MAX && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(t) ? t : ''; };
function cleanBotLook(x) {
  if (!x || typeof x !== 'object' || typeof x.slug !== 'string' || !BOT_SLUG_RE.test(lower(x.slug))) return null;
  if (x.shape != null && !BOT_SHAPES.includes(x.shape)) return null;
  if (x.color != null && (typeof x.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(x.color))) return null;
  const role = botRole(x.role);
  if (!x.shape && !x.color && !role) return null;
  return { slug: lower(x.slug), ...(x.shape ? { shape: x.shape } : {}), ...(x.color ? { color: lower(x.color) } : {}), ...(role ? { role } : {}), ...(num(x.at) > 0 ? { at: num(x.at) } : {}) };
}

// the Bots list's order (fleet-view.js settings.chatOrder, web/chats-model.js sortContacts): { pinned: [keys], keys:
// [keys] }, a row's key ('bot:<bot id>', 'team:<team id>') in one list only (pinned wins), at most max in each; any
// other key is dropped (an older file's or machine's 'chief', from before the Chief was removed); null when it is not one
const CHAT_KEY_RE = /^(?:bot:[0-9a-f]{12}|team:t[0-9a-f]{6,16})$/;
const CHAT_PORTABLE_RE = /^(?:team:t[0-9a-f]{6,16}|bots:[a-z0-9][a-z0-9_.-]{0,63})$/;
const CHAT_ORDER_MAX = 300;
function cleanChatOrder(o, max = CHAT_ORDER_MAX) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const seen = new Set();
  const list = (v) => {
    const out = [];
    for (const k of Array.isArray(v) ? v.slice(0, max * 2) : []) {
      if (out.length >= max) break;
      if (typeof k === 'string' && CHAT_KEY_RE.test(k) && !seen.has(k)) { seen.add(k); out.push(k); }
    }
    return out;
  };
  const pinned = list(o.pinned);
  return { pinned, keys: list(o.keys) };
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
// a group joined for the first time while this device already syncs others (a group a newer release added): both, this
// machine's item on the same key (ordered: this machine's order, then the row's others woven in where they stand)
function union(g, remote, local) {
  const G = GROUPS[g], m = byKey(g, remote), l = byKey(g, local);
  if (G.ordered) return weave(g, local, remote, (p) => !l.has(G.key(p)));
  for (const [k, p] of l) m.set(k, p);
  return [...m.values()];
}
// a device's very first join (it never agreed on any group: a fresh sync, a new key, a lost state): the row's items
// (the row's on a key both have; ordered: the row's order), plus this machine's items the row does not have, less
// those the row's tombstones (gone: Map key -> when) say were taken out after the item's own time (or at all, for an
// item with no time: names, workspace names, the order, rules). So a machine that comes back with an old copy of the
// settings never puts back what the others removed, and one joining for the first time loses nothing of its own
function join(g, remote, local, gone) {
  const G = GROUPS[g], K = (p) => String(G.key(p)), r = new Set(remote.map(K)), gm = gone instanceof Map ? gone : new Map();
  const keep = (p) => {
    if (r.has(K(p))) return false;
    const gt = gm.get(K(p)), t = timeOf(g, p);
    return gt == null || (t != null && t > gt);
  };
  return G.ordered ? weave(g, remote, local, keep) : [...remote, ...local.filter(keep)];
}
// list with the items of from that pick() takes woven in, each after the nearest one before it in from that the list
// has (at the start when none), so an item keeps its place among the others
function weave(g, list, from, pick) {
  const K = (p) => String(GROUPS[g].key(p)), out = list.slice(), have = new Set(out.map(K));
  for (let i = 0; i < from.length; i++) {
    const p = from[i], k = K(p);
    if (have.has(k) || !pick(p)) continue;
    let pos = 0;
    for (let j = i - 1; j >= 0; j--) { const at = out.findIndex((x) => K(x) === K(from[j])); if (at >= 0) { pos = at + 1; break; } }
    out.splice(pos, 0, p);
    have.add(k);
  }
  return out;
}
// an ordered group changed on both: this machine's order for what both have, less what the other device took out,
// with what the other device put in woven in where it stands there (a repo only the other machine has keeps its
// place, and is never dropped)
function mergeOrder(g, base, local, remote) {
  const K = (p) => String(GROUPS[g].key(p));
  const kb = new Set(base.map(K)), kl = new Set(local.map(K)), kr = new Set(remote.map(K));
  const out = local.filter((p) => kr.has(K(p)) || !kb.has(K(p)));
  return weave(g, out, remote, (p) => !kb.has(K(p)) && !kl.has(K(p)));
}
// both changed since base: the row's items, with what changed here put in and what was dropped here taken out
// (ordered: mergeOrder). o: { goneHere, goneThere } (Map key -> when it was taken out, here and in the row):
//   - changed here, taken out there after that change (its tombstone is newer than the item's time): out
//   - taken out here, changed there after that (the item's time is past this device's tombstone): the change stays
//   - changed on both (a team): the group's merge(), field by field
// An item with no time, or no tombstone to compare with (an older device's row), merges as before: this device wins
function merge3(g, base, local, remote, o = {}) {
  const G = GROUPS[g];
  if (G.ordered) return mergeOrder(g, base, local, remote);
  const here = o.goneHere instanceof Map ? o.goneHere : new Map(), there = o.goneThere instanceof Map ? o.goneThere : new Map();
  const m = byKey(g, remote), b = byKey(g, base), l = byKey(g, local);
  for (const [k, p] of l) {
    const bp = b.get(k), rp = m.get(k);
    if (bp && sig(bp) === sig(p)) continue; // not changed here
    if (bp && !rp) {
      const t = timeOf(g, p), gt = there.get(String(k));
      if (t != null && gt != null && gt > t) continue; // taken out there after it changed here
    }
    m.set(k, rp && G.merge && (!bp || sig(rp) !== sig(bp)) ? G.merge(bp, p, rp) : p);
  }
  for (const [k, bp] of b) {
    if (l.has(k)) continue;
    const rp = m.get(k);
    if (rp && sig(rp) !== sig(bp)) {
      const t = timeOf(g, rp), gt = here.get(String(k));
      if (t != null && gt != null && t > gt) continue; // changed there after it was taken out here
    }
    m.delete(k);
  }
  return [...m.values()];
}
// tombstones: [[key, at]] (saved, and a row's gone) <-> Map; pruned to GONE_MS before t and the newest GONE_MAX
function goneIn(list) {
  const m = new Map();
  for (const x of Array.isArray(list) ? list.slice(0, GONE_MAX * 2) : []) {
    if (!Array.isArray(x) || typeof x[0] !== 'string' || !x[0] || x[0].length > 1200 || !(num(x[1]) > 0)) continue;
    if (!(m.get(x[0]) >= num(x[1]))) m.set(x[0], num(x[1]));
  }
  return m;
}
function goneOut(m, t) {
  return [...m].filter(([, at]) => !Number.isFinite(t) || t - at < GONE_MS).sort((a, b) => a[1] - b[1]).slice(-GONE_MAX);
}

// The page's single-item changes (POST /settings { <group>Ops: [...] }, web/app.js and web/map.js), applied to this
// machine's own list of that group, so a stale page never sends back a whole list over what another device changed:
//   applyOps(kind, list, ops) -> the new list, or null when ops is not a list
//   hiddenRepos  { op: 'add', root, at } | { op: 'remove', root }      list: [{ root, at }]
//   repoNames    { op: 'add', root, name } | { op: 'remove', root }    list: [{ root, name }]
//   mapSpots     { op: 'add', id, x, y, pin } | { op: 'remove', id }   list: [{ id, x, y, pin, at? }]
//   repoOrder    { op: 'move', root, before } | { op: 'add', root, before } | { op: 'remove', root }   list: [roots];
//                before: the root it goes in front of (null, or one not listed: the end)
// 'add' puts an item in or replaces the one of the same key (roots compare in lower case, \ and / alike); an op that
// is not one is skipped. The caller cleans the result as it cleans a whole list (its caps and checks).
const OPS_MAX = 600;
const OP_KINDS = {
  hiddenRepos: { key: (x) => normKey(x.root), item: (o) => ({ root: o.root, ...(Number.isFinite(o.at) ? { at: o.at } : {}) }) },
  repoNames: { key: (x) => normKey(x.root), item: (o) => (typeof o.name === 'string' && o.name ? { root: o.root, name: o.name } : null) },
  mapSpots: { key: (x) => x.id, item: (o) => (Number.isFinite(o.x) && Number.isFinite(o.y) ? { id: o.id, x: o.x, y: o.y, pin: o.pin === true } : null) },
};
// max (optional): a cap the result is held to by dropping, from the end, the items no op put in or moved, so a change
// the page just made is never the one cut (repoOrder: an add goes at the end)
function applyOps(kind, list, ops, max) {
  if (!Array.isArray(ops)) return null;
  const cur = applyEach(kind, list, ops);
  if (Number.isFinite(max) && cur.length > max) {
    const kOf = kind === 'repoOrder' ? normKey : OP_KINDS[kind] ? OP_KINDS[kind].key : null;
    const named = new Set();
    for (const o of ops.slice(0, OPS_MAX)) if (kOf && o && typeof o === 'object' && o.op !== 'remove') { try { named.add(kOf(kind === 'repoOrder' ? o.root : o)); } catch {} }
    for (let i = cur.length - 1; i >= 0 && cur.length > max; i--) { let k = null; try { k = kOf ? kOf(cur[i]) : null; } catch {} if (!named.has(k)) cur.splice(i, 1); }
  }
  return cur;
}
// at most max of list, the newest by atOf (a later one first on a tie), in their order: a list an add op appends to
// (hiddenRepos) keeps what was just added
function newest(list, max, atOf = (x) => x && x.at) {
  if (!Array.isArray(list) || list.length <= max) return list;
  const keep = new Set(list.map((x, i) => [Number(atOf(x)) || 0, i]).sort((a, b) => b[0] - a[0] || b[1] - a[1]).slice(0, Math.max(0, max)).map((x) => x[1]));
  return list.filter((_, i) => keep.has(i));
}
function applyEach(kind, list, ops) {
  const cur = Array.isArray(list) ? list.slice() : [];
  for (const o of ops.slice(0, OPS_MAX)) {
    if (!o || typeof o !== 'object' || !['add', 'remove', 'move'].includes(o.op)) continue;
    if (kind === 'repoOrder') {
      if (typeof o.root !== 'string' || !o.root || o.root.length > 1024) continue;
      const k = normKey(o.root), i = cur.findIndex((r) => normKey(r) === k);
      if (o.op === 'remove') { if (i >= 0) cur.splice(i, 1); continue; }
      if (o.op === 'add' && i >= 0) continue;
      if (i >= 0) cur.splice(i, 1);
      const j = typeof o.before === 'string' ? cur.findIndex((r) => normKey(r) === normKey(o.before)) : -1;
      cur.splice(j >= 0 ? j : cur.length, 0, o.root);
      continue;
    }
    const K = OP_KINDS[kind];
    if (!K || o.op === 'move') continue;
    if (kind === 'mapSpots' ? typeof o.id !== 'string' || !o.id || o.id.length > 1100 : typeof o.root !== 'string' || !o.root || o.root.length > 1024) continue;
    const k = K.key(o), i = cur.findIndex((x) => x && K.key(x) === k);
    if (o.op === 'remove') { if (i >= 0) cur.splice(i, 1); continue; }
    const item = K.item(o);
    if (!item) continue;
    if (i >= 0) cur[i] = item; else cur.push(item);
  }
  return cur;
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

// an ordered group's list with these items of base put in, each after the nearest one before it in base that the list
// has (first when none)
function placeIn(G, list, add, base) {
  const next = list.slice();
  for (const p of add) {
    const i = base.findIndex((b) => G.key(b) === G.key(p));
    let pos = 0;
    for (let j = i - 1; j >= 0; j--) { const at = next.findIndex((x) => G.key(x) === G.key(base[j])); if (at >= 0) { pos = at + 1; break; } }
    next.splice(pos, 0, p);
  }
  return next;
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

  let me = null, st = null, firstEver = false; // st: the saved state, once me is known
  let lastRead = -Infinity, ready = false, writes = 0, fetched = 0, taken = 0;
  const lastWrite = new Map(); // group -> this clock at its last write
  const stamps = new Map(); // group -> the updated_at its row had when last listed (fetched or written)
  const unopened = new Set(); // groups whose row is there but does not open (a newer version's): never first-joined over

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
        if (Array.isArray(x.gone) && x.gone.length) groups[g].gone = goneOut(goneIn(x.gone));
      }
    }
    st = { v: 1, device: me, keyId, groups };
    // never agreed on any group: this device's first join (join(), not union(), for every group)
    firstEver = !Object.keys(groups).length;
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
  // (ordered: each where it stands in base, so a repo only another machine has keeps its place in the order)
  function view(g, local, base) {
    const G = GROUPS[g], mine = portable(g, local, tr), have = new Set(mine.map((p) => G.key(p)));
    const ride = [];
    for (const p of base || []) {
      if (have.has(G.key(p))) continue;
      let l = null;
      try { l = G.in(p, tr); } catch {}
      if (!l) ride.push(p);
    }
    if (G.ordered && ride.length) { const rk = new Set(ride.map((p) => String(G.key(p)))); return weave(g, mine, base, (p) => rk.has(String(G.key(p)))); }
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
    // an item of this machine's that the group no longer has, kept here in its local-only form (a pinned repo spot
    // unpinned elsewhere stays, unpinned). Not one whose repo the items still name (a stale copy of a spot this
    // machine has under another root: dropped)
    if (G.demote) {
      const keys = new Set(items.map((p) => String(G.key(p))));
      for (const x of Array.isArray(local) ? local : []) {
        if (G.localOnly && G.localOnly(x)) continue;
        let r = null, lk = null, d = null;
        try { r = G.out(x, tr); lk = G.lkey(x); d = G.demote(x); } catch {}
        if (!r || !r.p || keys.has(String(G.key(r.p))) || lk == null || out.has(lk) || !d) continue;
        out.set(lk, d);
      }
    }
    o.apply(g, [...out.values()]);
  }
  // what this device agreed on for group g: the row (at, by) and what this machine holds as agreed; gone: its tombstones
  // (a Map), less the keys the agreed items have (back again)
  function agree(g, at, by, base, prev, gone, keep = false) {
    const was = st.groups[g];
    const gm = gone instanceof Map ? new Map(gone) : goneIn(was && was.gone);
    if (!keep) for (const p of base) gm.delete(String(GROUPS[g].key(p)));
    st.groups[g] = { at, by, base, ride: rideOf(g, base) };
    if (prev) st.groups[g].prev = prev;
    const list = goneOut(gm, now());
    if (list.length) st.groups[g].gone = list;
  }
  // the keys of base that items lacks: taken out, now (kept when one was noted already, by dirty() at the time)
  function noteGone(g, gm, base, items, t) {
    const G = GROUPS[g], have = new Set(items.map((p) => String(G.key(p))));
    for (const p of base || []) { const k = String(G.key(p)); if (!have.has(k) && !gm.has(k)) gm.set(k, t); }
    return gm;
  }

  async function write(g, items, t) {
    const gs = st.groups[g];
    const at = Math.max(t, gs ? gs.at + 1 : 0);
    const k = `prefs:${g}`;
    const after = gs ? { by: gs.by, at: gs.at } : null;
    const gm = noteGone(g, goneIn(gs && gs.gone), gs ? gs.base : [], items, t);
    for (const p of items) gm.delete(String(GROUPS[g].key(p)));
    const gone = goneOut(gm, t);
    lastWrite.set(g, t);
    // gone: only when there are tombstones (an older device reads none, and writes none: see merge3)
    const row = { v: 1, device: me, at, after, items, ...(gone.length ? { gone } : {}) };
    await api.rest('POST', 'settings', {
      query: { on_conflict: 'user_id,key' }, prefer: 'resolution=merge-duplicates,return=minimal',
      body: { key: k, value_enc: K.sealText(JSON.stringify(row), key, `setting:${k}`), updated_at: new Date(at).toISOString() },
    });
    writes++;
    stamps.set(g, at);
    agree(g, at, me, items, gs ? gs.base : [], gm);
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
    return { device: lower(v.device), at: v.at, after: a, items: cleanItems(g, v.items), gone: goneIn(v.gone) };
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
    // tombstones: this device's (noted as they happened, dirty()) and the row's
    const here = gs ? noteGone(g, goneIn(gs.gone), gs.base, mine, t) : new Map();
    const opts = { goneHere: here, goneThere: v.gone };
    const merged = !gs ? (firstEver ? join(g, v.items, mine, v.gone) : union(g, v.items, mine))
      : missed ? merge3(g, gs.prev || [], mine, v.items, opts) : changed ? merge3(g, gs.base, mine, v.items, opts) : v.items;
    try { applyGroup(g, merged, local); } catch (e) { logOnce(`apply|${g}`, `prefs: the ${g} from ${short(v.device)} could not be put in here (${errText(e)})`); return; }
    taken++;
    log(`prefs: took ${g} from ${short(v.device)} (${v.items.length} item${v.items.length === 1 ? '' : 's'}${!gs ? (firstEver ? ', this device\'s first join' : ', joined with this device\'s') : missed ? ', merged with this device\'s write it did not have' : changed ? ', merged with a change here' : ''})`);
    // what this machine holds now, as agreed: the row's, with what rides along
    const after = readLocal();
    const now2 = view(g, after ? after[g] : [], merged);
    // both devices' tombstones, the newest of each
    const gm = new Map(here);
    for (const [k, at] of v.gone) if (!(gm.get(k) >= at)) gm.set(k, at);
    // changed here too (or first join, or a write the row missed): the result goes up. Not written: base stays the
    // row's, so this machine's items differ from it and the next round tries again
    if ((changed || missed) && sigOf(g, now2) !== sigOf(g, v.items)) {
      agree(g, v.at, v.device, v.items, undefined, gm, true); // (write() drops the tombstones of what goes up)
      try { await write(g, now2, t); } catch (e) { logOnce(`write|${g}`, `prefs: the ${g} could not be written (${errText(e)})`); }
    } else agree(g, v.at, v.device, now2, undefined, gm);
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
        // ordered: each where it stands in base, after the nearest one before it that this machine lists
        if (G.ordered) next = placeIn(G, mine, add, gs.base);
        else next = [...mine, ...add];
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
    const moved = [], listed = new Set();
    for (const row of Array.isArray(rows) ? rows : []) {
      const m = row && typeof row.key === 'string' ? KEY_RE.exec(row.key) : null;
      if (!m || !GROUPS[m[1]]) continue;
      listed.add(m[1]);
      if (stamps.get(m[1]) !== stampOf(row.updated_at)) moved.push(m[1]);
    }
    for (const g of [...unopened]) if (!listed.has(g)) unopened.delete(g); // that row is gone
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
        if (v) { unopened.delete(m[1]); await take(m[1], v, now()); } else unopened.add(m[1]);
      }
    }
    // the first join is this first full read: every row there was is taken by now, so a group that turns up later (a
    // newer release's) joins as union() says
    firstEver = false;
    ready = true;
    return true;
  }
  // the groups changed here since they were agreed (or never agreed: first join with no row)
  // A key taken out here is noted with this clock the first round that sees it (its tombstone), so a merge later
  // knows when it went
  function dirty() {
    const all = readLocal(), out = new Map();
    if (!all) return out;
    let noted = false;
    for (const g of GROUP_NAMES) {
      if (!(g in all)) continue; // a group read() does not give is not synced
      const gs = st.groups[g];
      const mine = view(g, all[g], gs ? gs.base : []);
      if (!gs || sigOf(g, mine) !== sigOf(g, gs.base)) {
        out.set(g, mine);
        if (gs) {
          const gm = goneIn(gs.gone), n = gm.size;
          noteGone(g, gm, gs.base, mine, now());
          if (gm.size !== n) { gs.gone = goneOut(gm, now()); noted = true; }
        }
      }
    }
    if (noted) saveState();
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
        // a row is there that does not open here: never written over with this machine's items (it may hold what only
        // a newer version reads)
        if (unopened.has(g)) continue;
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

module.exports = { createPrefs, makeTranslate, GROUPS, GROUP_NAMES, TIMING, GONE_MS, GONE_MAX, cleanRoot, cleanHostRule, cleanPinOverride, cleanDynamicChat, cleanChatOrder, CHAT_ORDER_MAX, cleanBotLook, BOT_SHAPES, spotId, portable, cleanItems,
  union, join, merge3, mergeOrder, weave, timeOf, applyOps, newest };
