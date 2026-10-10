// Fleet View web: the Map view.
//
// A graph of conversations, their agents, repos, PRs and the files they touch, drawn on a canvas.
// The layout is a small hand-written spring and repulsion simulation that keeps its positions between
// polls, so nodes never jump: new nodes start next to what they link to and the rest stays put.
//
// Rule (Henry): nothing pulses, blinks, flashes or gets brighter when something happens. Life comes from
// MOTION at constant brightness only: tool calls travel as comets along an edge, a working conversation's
// ring of dots turns slowly, running agents orbit, nodes drift a few pixels, and recent-work dashes flow.
// The aura behind a conversation grows with its tool calls but its alpha is fixed. Fades are driven by age
// only (recent-work paths dim steadily over ten minutes). sin/cos are used for positions, angles and scale,
// never for alpha. A comet arriving at a repo or a conversation nudges it: a short scale bump (at most one per
// 250 ms) and, for a repo, a kick of its ring's rotation; nothing gets brighter. prefers-reduced-motion turns
// off drift, orbit, rotation, flow and these nudges (comets still travel).
//
// Transitions (Henry, 2026-10-07: changes of state must feel organic, not snap): a conversation's look morphs
// into its next one over MORPH_MS (the new look settles in from 90% size over the old one); its size, aura,
// memory gauge, link and turning ring all glide (exponential easing, see glide). Going idle, the ring of dots
// slows to a stop while its dots shrink into the orb; starting work, they grow out and pick up speed. A new
// conversation or repo grows in with a slight overshoot (BIRTH_MS); one that leaves shrinks as it fades.
// prefers-reduced-motion snaps all of these to their end.
//
// Look: conversations and agents are lit orbs; a repo is a hub (a faceted hexagon in its colour, with the repo's
// initial, inside a turning ring of arcs with ticks) over a faint territory blob, its name on a pill in its
// colour right next to it. A hub shows presence by size and motion: each live conversation is a small satellite
// in its colour orbiting the hub, a soft halo widens and the ring's arcs lengthen while it has live
// conversations, and the ring turns faster (plus an inner counter-turning dash ring grows) while they work.
// A dormant hub (no live conversation) is smaller, its arcs short, turning slowly; PRs are small rings with a pull-request glyph; edges are gentle curves (always
// bent to the same side for a pair) with a colour gradient, and names sit on small frosted pills.
//
// Repo spots (Henry: repos must never jump across the map): every repo keeps the spot it first got. Only the
// first layout packs the repos in rows to fit the window; a repo that appears later takes the nearest free spot
// around the others, and one that leaves keeps its spot for when it comes back, so nothing else moves. The
// spacing rule may still nudge a group a little (and its spot moves with it). Dragging a repo's hub moves its
// whole group and pins it there: a pinned repo never moves by itself, and others make way for it. Spots and
// pins are saved (settings.mapSpots), so they survive reloads. A repo added from the map's empty-space menu
// takes the spot where that menu was opened, pinned (mapPlaceRepo). A conversation can be dragged too: it stays
// where it was dropped, as an offset from its repo's hub (saved under its node id, 's:<id>'), so it moves along
// with its repo, and the others make way for it. Dropping a conversation on another repo's group (a dashed ring
// marks it while dragging) moves it there (ui.moveSession, the same as the menu's "Move to workspace"). A repo's or
// conversation's right-click menu offers "Unpin" (mapPinned / mapUnpin). `g` re-arranges the repos that aren't pinned, `G` unpins every
// repo and conversation too. The camera fits the map when it first shows (and on `0` or `g`), then holds
// still. A resize (the panel opening) keeps the view where it is, held by its top-left corner.
//
// Repo anchors: every repo in the shell's list (state.repoAnchors: [{ root, name, color }], the repo menu's list,
// less removed repos) has its hub and territory even with no conversation on the map, steady like any hub, so
// a repo added by hand can be right-clicked for a new session. A removed repo is not in it, and its
// conversations are not in state.sessions either, so its hub, territory and nodes all leave together.
// Finished conversations: the ones in the shell's "recently finished" strip (state.finishedSessions) are drawn
// as small dim orbs on their repo, steady (no drift, aura, gauge, agents or files). Removing one from the strip
// (its x or the menu's Remove) hides it in the shell, which takes it off both. Gradients are cached per colour (see paint below),
// and the canvas is cleared, not filled, in glass mode so the window's acrylic shows through.
//
//   export function renderMap(el, state, ui)
//     el    container that fills the area under the header; the canvas lives inside it
//     state GET /state JSON
//     ui    { selectedId, setSelected(id), open(id), saveSettings(obj), keys, reveal(req), openUrl(url),
//           contextMenu(target, x, y), setMulti(ids) }:
//           the map sets ui.keys.map. reveal / openUrl may be missing (older shell); the map then falls back
//           to POST /reveal and window.open itself. setMulti may be missing too.
//   also exported: mapSelection, setMapSelection, mapLens, setMapLens, setMapReplay (see "Command center")
//
// Acting on nodes: a click picks (a conversation's pick opens the shell's detail panel through
// ui.setSelected). Double-click, a click on the node already picked, or Enter acts on it: a conversation or
// agent opens the conversation, a PR opens on GitHub, a file opens in VS Code, a repo opens in Explorer.
// A right-click on a conversation, an agent or a repo calls ui.contextMenu(target, clientX, clientY) with
// { kind: 'session', id } or { kind: 'repo', root, name, color } (the shell's menu, app.js).
//
// New sessions: state.pending (from the shell) lists conversations started in the desktop window that have no
// log yet. Each is drawn at its repo as a hollow node with a steady dashed ring in its account's colour, and
// becomes the real node in place: the shell calls rekeyNode(oldKey, id) when it gets its id, and the node
// keeps its position when /state lists it. A conversation that leaves the map fades out over 400 ms.
//
// Tests (?fixture=1 or ?debug=1): window.__map = { nodes, stats, debug, comet(fromId, toId) }. nodes() lists
// each node's draw params too (scale, alpha, spin, fin); debug() has the reactions and label rectangles.
//
// Command center (2026-10-08). The map is also where many conversations are steered at once:
//   Multi-select: Ctrl+click toggles a conversation into the selection; Shift+drag on empty space draws a thin
//     dashed band (fixed alpha) and adds every conversation inside it. Selected ones wear a steady double ring.
//     A plain click goes back to a single pick, Esc clears the selection first. mapSelection() lists the ids,
//     setMapSelection(ids) sets them (the cards' own multi-select), and every change calls ui.setMulti(ids).
//     Right-click on a selected conversation (2+ selected) calls ui.contextMenu({ kind: 'sessions', ids }).
//   Teams (state.teams): members are tied by a soft braided double curve in the team's colour (fixed alpha)
//     with the team's name on a pill; hover shows the order and the last messages, right-click calls
//     ui.contextMenu({ kind: 'team', id }). A team message (a feed entry with `to`) travels as a comet from
//     one member to the other along that link, and a new order (a team's `at` changes) sends one comet from
//     the pill to each member.
//   Conflicts (state.conflicts): nodes like the shared-file ones, tied to their conversations by dashed
//     lines: a branch glyph (two on one branch, gold), a folder glyph (two live in one worktree, red) or a
//     '#nnn' tag (two migrations with one number, red). Right-click on one, or on a shared-file node, calls
//     ui.contextMenu({ kind: 'conflict', id, kind2, label, sessions, rel?, root?, files? }).
//   Parity (s.parity): a dotted line from the web side (cyan) to the app side (mint) between partners,
//     "web ↔ app" on hover; a conversation that changed one side only has a small hollow ghost orb beside
//     it on a dashed line, with "no app change" (or "no web change").
//   Ship to phones: a PR's tooltip and ship row show the 'app' step (eas update / build / submit and the
//     platforms), its colour counts it, and the PR wears a small phone badge in that step's colour.
//   Handoffs: a faint arrowed line from the conversation it was picked up from (s.pickedUpFrom, when on the
//     map, finished ones too), and a small tick on the memory gauge where the handoff limit is.
//   Worktrees (state.worktrees): tiny satellites on an outer ring of their repo's hub, only for the ones a live
//     conversation works in (idle ones are noise). Hover one for its name, branch and last commit; the hub's
//     tooltip counts them all and lists the stale ones (no commit for 3 days).
//   Lenses: setMapLens(name) / mapLens(), `k` cycles: state (the usual looks), cost (orb size and colour by
//     cost), account (A / B colours), idle (cyan when fresh, fading toward faint with time since its last
//     activity) and context (green, gold, red by context used). Saved as settings.mapLens. A lens change
//     morphs like a change of state.
//   Saved views: Shift+1..9 keeps the view (its centre in world units and its scale), 1..9 glides back to it;
//     settings.mapViews (localStorage fv.mapViews when the server doesn't keep them).
//   `n` / `N`: the next / previous conversation that needs you, picked and glided to the middle.
//   Overlay: ./map-overlay.js, when present, is mounted on the map's container with mountMapOverlay(el, API)
//     (see overlayApi) and gets frame(now) every frame, the keys the map doesn't take, and destroy().
//   Replay: setMapReplay(on). While on, the shell feeds the map a state rebuilt from the timeline: nothing
//     is born or saved (spots, made during replay, are forgotten when it ends), and comets run on state.now.

// colours and fonts follow the shell's design tokens (app.css); the canvas can't read CSS variables
// per frame, so the values are repeated here
const COL = {
  bg: '#0a0c13', text: '#eef0fa', dim: '#8a92b2', faint: '#4c5372',
  ember: '#ff6a2b', gold: '#ffc24a', rose: '#ff4d8d', violet: '#a47bff', cyan: '#3fd8ff',
  mint: '#3dffa8', red: '#ff4d5e', accA: '#3fb950', accB: '#d97757', accC: '#58a6ff',
};
const UI = "'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif";
const DISPLAY = "'Segoe UI Variable Display', 'Segoe UI', system-ui, sans-serif";
const MONO = "'Cascadia Mono', Consolas, monospace";
const ACC_FONT = `700 8.5px ${UI}`;
const HOLE = 'rgba(14,17,27,0.92)';        // inside of a hollow node, over the glass or the solid page
const PILL_BG = 'rgba(18,21,32,0.72)', PILL_EDGE = 'rgba(255,255,255,0.07)', LABEL_HALO = 'rgba(10,12,19,0.55)';
// DOM overlays (tooltip, legend, hint) use the shell's CSS variables, with these values as fallbacks
const CSS_UI = `var(--font-ui, ${UI})`, CSS_MONO = `var(--font-mono, ${MONO})`;
const GLASS_BOX = 'background:var(--float-bg, var(--glass-bg-strong, rgba(18,21,32,0.78)));border:1px solid var(--glass-edge, rgba(255,255,255,0.07));' +
  'box-shadow:inset 0 1px 0 var(--glass-highlight, rgba(255,255,255,0.10)),0 10px 30px rgba(0,0,0,0.35);' +
  'backdrop-filter:blur(18px) saturate(1.3);-webkit-backdrop-filter:blur(18px) saturate(1.3);' +
  'color:var(--text, #eef0fa);font-variant-numeric:tabular-nums;';
// the legend's edges: under the overlay's lens chips (map-overlay.js, top 12 + ~34) and above its replay clock
// (bottom 14 + 32) and the replay bar
const LEGEND_TOP = 56, LEGEND_LOW = 72;
const FADE_MS = 10 * 60e3;          // recent-work paths fade out over ten minutes
const MAX_RECENT = 14;              // recent files drawn per conversation
const MAX_AGENTS = 16;              // agents drawn per conversation
const ZMIN = 0.2, ZMAX = 6;

// world-space layout constants
const CHARGE = { session: 100, repo: 115, pr: 30, clash: 42, conflict: 42, recent: 20 };
const MASS = { session: 3, repo: 5, pr: 1.2, clash: 1.5, conflict: 1.5, recent: 1 };
const REST = { repo: 115, pr: 42, clash: 85, conflict: 80, recent: 55 };
// hard spacing (Henry: removing a repo or a conversation must never leave things crowded; the canvas is big):
// a repo's whole group keeps CLUSTER_GAP clear of every other group, nodes of different repos keep APART_OTHER,
// conversations of one repo keep APART_SAME. Enforced by moving positions, so it holds after the layout settles.
const CLUSTER_GAP = 90, CLUSTER_PAD = 45, APART_OTHER = 120, APART_SAME = 56;

// motion
const TAU = Math.PI * 2;
const COMET_MS = 900;               // travel time along an edge
const COMET_TAIL = 6, COMET_GAP = 0.045; // tail dots and their spacing (fraction of the trip)
const COMET_MAX = 60;               // concurrent comets; the oldest are dropped
const COMET_STAGGER = 80;           // ms between launches when the feed arrives in a burst
const COMET_MAX_AGE = 10e3;         // feed entries older than this never launch (a re-shown session's history)
const RING_DOTS = 18, RING_TURN_MS = 12e3;
const ORBIT_TURN_MS = 40e3;         // running agents: one turn around their conversation
const DRIFT_PX = 3;                 // node drift amplitude at zoom 1
const FLOW_PX_S = 16;               // recent-work dash flow speed
const AURA_MIN = 14, AURA_MAX = 42, AURA_CALLS = 60, AURA_ALPHA = 0.17;
const TERR_ALPHA = 0.06;            // repo territory blob, fixed
const BUSY = new Set(['WORKING', 'AGENTS']);
const DASH_NONE = [], DASH_READ = [2, 3], DASH_WROTE_FLOW = [8, 3], DASH_CLASH = [6, 4], DASH_FRESH = [2, 2];
const PUSH_RE = /\bgit\s+push\b|\bgh\s+pr\b|\bpush(ed)?\s+the\s+branch\b|\bopen(ed)?\s+(the|a)\s+pr\b/i;
const ease = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
// ease-out with a slight overshoot, for things growing in
const backOut = (u) => { const c = 1.2, v = u - 1; return 1 + (c + 1) * v * v * v + c * v * v; };

// repo hubs: a faceted hexagon core, a ring of arc segments that turns once per HUB_TURN_MS, and satellite ticks.
// An arriving comet nudges the hub with MOTION only: a scale bump (at most one per BUMP_GAP ms) and a rotation
// kick of the ring that accumulates and eases in. Alpha and colours never change.
const HUB_TURN_MS = 20e3, HUB_RING = 1.5, HUB_TICKS = 1.9, HUB_SEGS = 6;
const BUMP_MS = 350, BUMP_UP = 0.15, BUMP_GAP = 250, KICK = Math.PI / 6, KICK_EASE_MS = 140;
const HUB_R = 10, SAT_RING = 2.4, SAT_MAX = 10, SAT_TURN_MS = 30e3, HUB_HALO_ALPHA = 0.16;
const WT_RING = 3.45;               // worktree satellites: their ring, in core radii
// transitions: a look morphs over MORPH_MS; new nodes grow in over BIRTH_MS (see "Transitions" at the top)
const MORPH_MS = 700, BIRTH_MS = 650;
const FIN_R = 6.5, FIN_CHARGE_CUT = 50; // finished conversations: smaller, and they push their neighbours less

const NEEDS_YOU = new Set(['ASKING', 'QUESTION', 'STALLED', 'ERROR']);
const GHOST_MS = 650;                // a conversation that leaves the map shrinks and fades out over this
const DASH_NEW = [3, 3];             // a new session's ring (steady, never moving)
const DASH_HO = [5, 4];              // a handing-off conversation's ring, turning slowly: it is in transit
const HANDOFF_GHOST_MS = 950;        // a handed-off node flies into its pickup and is absorbed over this
const STEP_NAMES = ['push', 'PR', 'checks', 'merged', 'live'];

// command center (see "Command center" at the top)
const LENSES = ['state', 'cost', 'account', 'idle', 'context'];
const DASH_BAND = [5, 4], DASH_GHOST = [2, 3], DASH_LINK = [3, 4];
const TEAM_ALPHA = 0.42, PARITY_ALPHA = 0.6, TRAIL_ALPHA = 0.26, CONFLICT_LINE_ALPHA = 0.5;
const GLIDE_MS = 650;               // saved views, n / N and the overlay's panTo glide over this
const IDLE_FULL_MS = 60 * 60e3;     // the idle lens: fully faded after an hour without activity
const WT_MAX = 16;                  // worktree satellites drawn per hub

let I = null; // the one map instance (layout survives tab switches and container swaps)
let pendingMulti = null; // a selection set before the map exists (setMapSelection)
let overlayMod = null; // the overlay module's import, once

// ---------- small helpers ----------
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const hashNum = (s) => { let h = 7; for (const ch of String(s)) h = (h * 33 + ch.charCodeAt(0)) >>> 0; return (h % 1000) / 1000; };
const ctxColor = (pct) => (pct > 90 ? COL.red : pct >= 70 ? COL.gold : COL.mint);
const ctxPct = (s) => (s.context && s.context.limit ? Math.round((100 * s.context.used) / s.context.limit) : null);
// each Claude account's colour (the same as its Windows Terminal tab); the accounts drawn so far go in the legend
const ACC_COL = { A: COL.accA, B: COL.accB, C: COL.accC, D: '#bc8cff', E: '#e3b341', F: '#f778ba' };
const accSeen = new Set(['A', 'B']);
const accColor = (a) => { const k = typeof a === 'string' && /^[A-Z]$/.test(a) ? a : 'B'; accSeen.add(k); return ACC_COL[k] || COL.dim; };
const lastParts = (rel) => String(rel || '').replace(/\\/g, '/').split('/').filter(Boolean).slice(-2).join('/');
function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  return Math.floor(s / 3600) + 'h ' + (Math.floor(s / 60) % 60) + 'm ago';
}
// a ship's colour; the 'app' step (phones: eas update / build / submit) counts too: shipping to the phones
// shows gold, and live on the web with the phones not done yet stays violet
function shipColor(ship) {
  if (!ship || !ship.steps || ship.fresh) return COL.faint;
  const st = Object.fromEntries(ship.steps);
  if (ship.steps.some(([, v]) => v === 'fail')) return COL.red;
  if (st.app === 'pending') return COL.gold;
  if (st.live === 'ok' && 'app' in st && st.app !== 'ok') return COL.violet;
  if (st.live === 'ok') return COL.mint;
  if (st.merged === 'ok') return COL.violet;
  if (st.checks === 'pending') return COL.gold;
  if (st.checks === 'ok') return COL.cyan;
  return COL.dim;
}
const STEP_LOOK = { ok: ['◆', COL.mint], pending: ['◈', COL.gold], fail: ['✕', COL.red], na: ['–', COL.faint], none: ['◇', COL.faint] };
// a step's name in the ship row: the app step says what ran and for which phones ("app (update · all)")
function stepName(name, ship) {
  if (name !== 'app' || !ship || !ship.app) return name;
  const a = ship.app;
  return `app (${[a.kind, a.platforms].filter(Boolean).join(' · ') || 'eas'})`;
}

// ---------- lenses: what a conversation's colour (and, for cost, its size) says ----------
// a conversation's context used in %, from /state's context or a replay frame's ctx (a fraction)
function ctxOf(s) {
  const p = ctxPct(s);
  if (p !== null) return p;
  if (typeof s.ctx === 'number' && Number.isFinite(s.ctx)) return Math.round(s.ctx <= 1 ? s.ctx * 100 : s.ctx);
  return null;
}
// a ramp mint -> gold -> red over t in 0..1 (hex, so orb() can build its gradient from it)
function ramp(t) {
  t = clamp(t, 0, 1);
  const q = Math.round(t * 20) / 20; // 21 steps: few cached gradients
  return q < 0.5 ? mixHex(COL.mint, COL.gold, q * 2) : mixHex(COL.gold, COL.red, (q - 0.5) * 2);
}
const costT = (c) => clamp(Math.log10(1 + Math.max(0, c || 0)) / Math.log10(51), 0, 1); // $0 .. $50
function lensColor(lens, s) {
  if (lens === 'cost') return ramp(costT(s.cost));
  if (lens === 'account') return accColor(s.account);
  if (lens === 'idle') {
    const age = Date.now() - I.skew - (s.last || 0);
    return mixHex(COL.cyan, COL.faint, Math.round(clamp(age / IDLE_FULL_MS, 0, 1) * 20) / 20);
  }
  if (lens === 'context') { const p = ctxOf(s); return p === null ? COL.dim : ramp(p / 100); }
  return s.hue || COL.cyan;
}
// the small readout under a conversation's name in a lens, or null
function lensText(lens, s) {
  if (lens === 'cost') return '$' + (s.cost || 0).toFixed(2);
  if (lens === 'idle') return s.last ? ago(Date.now() - I.skew - s.last).replace(' ago', '') : null;
  if (lens === 'context') { const p = ctxOf(s); return p === null ? null : p + '%'; }
  return null;
}

// ---------- public entry ----------
export function renderMap(el, state, ui) {
  if (!el || !state) return;
  if (!I) I = createInstance(state);
  if (I.el !== el) attach(el);
  I.ui = ui || {};
  I.state = state;
  I.skew = Date.now() - (state.now || Date.now());
  I.deploy = deployByRepo(state);
  if (!I.W) { const r = el.getBoundingClientRect(); I.W = Math.round(r.width); I.H = Math.round(r.height); I.sized = false; }
  syncSettings(state.settings || {});
  rebuild();
  ingestFeed(state);
  ingestTeams(state);
  syncSelection();
  start();
}

// a repo's production deploy, by hub id: building (any build running), failed (the newest one failed), else
// clean (the newest went live, or none in the last 3 hours). Only repos that deploy at all (state.deployRepos,
// plus any with a deploy listed) get one; d is the deploy behind it (null when clean with none recent).
function deployByRepo(state) {
  const out = new Map();
  for (const root of Array.isArray(state.deployRepos) ? state.deployRepos : []) if (root) out.set(repoId(root), { state: 'clean', d: null });
  // state.deploys: building first, then newest, so the first one seen per repo decides
  for (const d of Array.isArray(state.deploys) ? state.deploys : []) {
    if (!d || !d.root) continue;
    const id = repoId(d.root), cur = out.get(id);
    if (cur && cur.d) continue;
    out.set(id, { state: d.state === 'building' ? 'building' : d.state === 'failed' ? 'failed' : 'clean', d });
  }
  return out;
}

// ---------- command center: selection, lens, views, replay ----------
export function mapSelection() { return I ? [...I.multi] : pendingMulti ? [...pendingMulti] : []; }
// the shell sets the selection (the cards' multi-select); it doesn't call ui.setMulti back
export function setMapSelection(ids) {
  const list = Array.isArray(ids) ? ids.filter((x) => typeof x === 'string' && x) : [];
  if (!I) { pendingMulti = new Set(list); return; }
  I.multi = new Set(list);
  I.dirty = true;
}
function setMulti(set) {
  I.multi = set;
  I.dirty = true;
  try { I.ui.setMulti && I.ui.setMulti([...set]); } catch (err) { console.error(err); }
}
function clearMulti() { if (I.multi.size) setMulti(new Set()); }

// the picked node, for the shell's Delete key: { kind, sid?, root?, name? } or null
export function mapPicked() {
  const n = I && I.sel ? I.byId.get(I.sel) : null;
  return n ? { kind: n.kind, sid: n.sid || null, root: n.root || null, name: n.name || null } : null;
}
export function mapLens() { return I ? I.lens : 'state'; }
export function setMapLens(name) {
  if (!I || !LENSES.includes(name) || name === I.lens) return;
  I.lens = name;
  I.lensAt = Date.now();
  I.dirty = true;
  try { I.ui.saveSettings && I.ui.saveSettings({ mapLens: name }); } catch { /* shell gone */ }
}

// Replay (the overlay's scrubber): the shell renders the map from a state rebuilt from the timeline. Spots made
// while it runs are forgotten when it ends (the live spots come back), and the comets' seen-list starts over.
export function setMapReplay(on) {
  if (!I) return;
  on = !!on;
  if (on === I.replay) return;
  I.replay = on;
  I.seen.clear();
  I.replayT = null;
  I.comets.length = 0; I.cometQ.length = 0; // the scene jumps: what was travelling stops
  if (on) {
    I.spotsBack = new Map([...I.homeXY].map(([id, h]) => [id, { ...h }]));
    I.feedInit = true; // the first replay state's feed (its last 10 s) travels
  } else {
    if (I.spotsBack) { I.homeXY = I.spotsBack; I.spotsBack = null; I.alpha = Math.max(I.alpha, 0.3); }
    I.feedInit = false; // back live: the live feed is history again
    I.teamAt.clear(); I.teamInit = false;
  }
  I.dirty = true;
}

// mapLens and mapViews from the settings: taken when the saved value changes, and not for a few seconds after a
// change made here (a poll that still carries the old value, or the echo of an earlier save, must not undo it)
const ECHO_MS = 4000;
function syncSettings(set) {
  if (set.mapLens !== I.lensSeen) {
    I.lensSeen = set.mapLens;
    if (LENSES.includes(set.mapLens) && set.mapLens !== I.lens && !(Date.now() - (I.lensAt || 0) < ECHO_MS)) { I.lens = set.mapLens; I.dirty = true; }
  }
  if ('mapViews' in set) {
    const sig = JSON.stringify(set.mapViews || {});
    if (sig !== I.viewsSeen) {
      I.viewsSeen = sig; I.viewsLocal = false;
      if (!(Date.now() - (I.viewsAt || 0) < ECHO_MS)) I.views = cleanViews(set.mapViews);
    }
  } else if (!I.viewsLocal) {
    // a server that doesn't keep them: this browser keeps them
    let v = null;
    try { v = JSON.parse(localStorage.getItem('fv.mapViews') || 'null'); } catch { v = null; }
    I.views = cleanViews(v); I.viewsLocal = true;
  }
}
function cleanViews(v) {
  const out = {};
  if (v && typeof v === 'object') for (const k of '123456789') {
    const x = v[k];
    if (x && [x.x, x.y, x.zoom].every(Number.isFinite) && x.zoom > 0) out[k] = { x: x.x, y: x.y, zoom: x.zoom };
  }
  return out;
}
// Shift+digit: keep the view as its centre in world units and its scale (zoom here is the drawn scale, world to
// screen, so it comes back the same however the camera's fit changed since)
function saveView(d) {
  if (!I.cam) return;
  const [x, y] = toWorld(I.W / 2, I.H / 2);
  I.views[d] = { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, zoom: Math.round(K() * 1000) / 1000 };
  const all = { ...I.views };
  I.viewsAt = Date.now();
  if (I.viewsLocal) { try { localStorage.setItem('fv.mapViews', JSON.stringify(all)); } catch { /* storage off */ } }
  else { try { I.ui.saveSettings && I.ui.saveSettings({ mapViews: all }); } catch { /* shell gone */ } }
  flash(`view ${d} saved`);
}
function jumpView(d) {
  const v = I.views[d];
  if (!v || !I.cam) { flash(`no view ${d} yet · Shift+${d} saves one`); return; }
  glideTo(v.x, v.y, v.zoom / (I.cam.fit || 1));
}
// a short note at the bottom of the map (saved views), gone after a moment; fixed alpha, no animation
function flash(text) {
  if (!I.noteEl) return;
  I.noteEl.textContent = text;
  I.noteEl.style.display = 'block';
  clearTimeout(I.noteTimer);
  I.noteTimer = setTimeout(() => { if (I && I.noteEl) I.noteEl.style.display = 'none'; }, 1600);
}

// glide the view so the world point (x, y) sits in the middle, at zoom z (the user's zoom factor; default: as is)
function glideTo(x, y, z) {
  if (!I.cam || !Number.isFinite(x) || !Number.isFinite(y)) return;
  const tz = clamp(Number.isFinite(z) && z > 0 ? z : I.zoom, ZMIN, ZMAX);
  const to = { x: x - I.cam.cx, y: y - I.cam.cy, z: tz };
  I.camUntil = 0; // the camera holds still: the glide decides
  if (I.still) { I.pan = { x: to.x, y: to.y }; I.zoom = to.z; I.glide = null; saveZoomSoon(); I.dirty = true; return; }
  I.glide = { from: { x: I.pan.x, y: I.pan.y, z: I.zoom }, to, at: performance.now() };
  I.dirty = true;
}
function stepGlide(now) {
  const g = I.glide;
  if (!g) return false;
  const u = clamp((now - g.at) / GLIDE_MS, 0, 1), e = ease(u);
  I.pan.x = g.from.x + (g.to.x - g.from.x) * e;
  I.pan.y = g.from.y + (g.to.y - g.from.y) * e;
  I.zoom = g.from.z * Math.pow(g.to.z / g.from.z, e);
  if (u >= 1) { I.glide = null; saveZoomSoon(); }
  return true;
}
function saveZoomSoon() {
  clearTimeout(I.saveTimer);
  I.saveTimer = setTimeout(() => { try { I.ui.saveSettings && I.ui.saveSettings({ zoom: Math.round(I.zoom * 1000) / 1000 }); } catch { /* shell gone */ } }, 600);
}

// n / N: the next (previous) conversation that needs you, longest waiting first
function nextNeedsYou(dir) {
  const list = I.nodes.filter((n) => n.kind === 'session' && !n.fin && !n.s.pending && NEEDS_YOU.has(n.s.state))
    .sort((a, b) => (a.s.last || 0) - (b.s.last || 0) || (a.id < b.id ? -1 : 1));
  if (!list.length) { flash('nothing needs you'); return; }
  const i = list.findIndex((n) => n.id === I.sel);
  const n = list[i < 0 ? (dir > 0 ? 0 : list.length - 1) : (i + dir + list.length) % list.length];
  pickAndGlide(n);
}
// pick a node (panel, not a live session) and glide it to the middle
function pickAndGlide(n) {
  if (!n) return;
  I.sel = n.id; I.kbTip = true; I.dirty = true;
  try { I.ui.setSelected && I.ui.setSelected(n.sid || null, 'keys'); } catch { /* shell gone */ }
  const w = worldOf(n);
  if (w) glideTo(w[0], w[1]);
}
// a node's position in world units (agents are placed on screen, so theirs comes back from the screen)
function worldOf(n) {
  if (n.p) return [n.p.x, n.p.y];
  if (n.sx !== undefined && I.cam) return toWorld(n.sx, n.sy);
  return null;
}

// ---------- the overlay (map-overlay.js, optional) ----------
// the API it gets: see "Overlay" at the top. Positions: x, y in world units; sx, sy on the canvas.
function overlayApi() {
  const pt = (a, b) => { const r = [a, b]; r.x = a; r.y = b; return r; }; // [x, y] that also has .x / .y
  return {
    nodes: () => {
      if (!I) return [];
      const out = [];
      for (const n of I.nodes) {
        if (n.sx === undefined) continue;
        const w = worldOf(n) || [0, 0], s = n.s;
        const isS = n.kind === 'session';
        out.push({
          id: n.id, kind: n.kind, x: w[0], y: w[1], sx: n.sx, sy: n.sy, r: n.RG || n.R || 4,
          color: isS ? s.stateColor || s.hue || COL.cyan : nodeColor(n), hue: s ? s.hue || null : n.color || null,
          state: isS ? s.state : n.kind === 'agent' ? n.a.state : null,
          needsYou: !!(isS && !n.fin && !s.pending && NEEDS_YOU.has(s.state)),
          name: isS ? s.name || s.id : n.kind === 'agent' ? n.a.label : n.kind === 'repo' ? n.name : n.kind === 'pr' ? '#' + n.num : n.kind === 'conflict' ? n.k.label : n.kind === 'clash' ? lastParts(n.c.rel) : n.kind === 'recent' ? lastParts(n.f.rel) : n.id,
          sid: n.sid || null, last: isS ? s.last || null : null, fin: !!n.fin, root: n.root || (s && s.repo && s.repo.root) || null,
        });
      }
      return out;
    },
    camera: () => {
      if (!I || !I.cam) return null;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of I.sim || []) { if (!n.p) continue; minX = Math.min(minX, n.p.x); maxX = Math.max(maxX, n.p.x); minY = Math.min(minY, n.p.y); maxY = Math.max(maxY, n.p.y); }
      if (!Number.isFinite(minX)) { minX = minY = -100; maxX = maxY = 100; }
      return {
        pan: { x: I.pan.x, y: I.pan.y }, zoom: I.zoom, W: I.W, H: I.H, k: K(), cx: I.cam.cx, cy: I.cam.cy,
        toScreen: (x, y) => pt(...toScreen(x, y)), toWorld: (sx, sy) => pt(...toWorld(sx, sy)),
        bounds: { minX, minY, maxX, maxY },
      };
    },
    panTo: (x, y, zoom) => { if (I) glideTo(x, y, zoom); },
    select: (id) => {
      if (!I) return false;
      const n = I.byId.get(id) || I.byId.get('s:' + id);
      if (!n) return false;
      clearMulti();
      I.sel = n.id; I.kbTip = true; I.dirty = true;
      try { I.ui.setSelected && I.ui.setSelected(n.sid || null, 'keys'); } catch { /* shell gone */ }
      return true;
    },
    lens: () => mapLens(),
    setLens: (name) => setMapLens(name),
    lenses: () => LENSES.slice(),
    state: () => (I ? I.state : null),
    replay: () => !!(I && I.replay),
  };
}
// a non-conversation node's colour (the overlay's minimap)
function nodeColor(n) {
  if (n.kind === 'repo') return n.color || COL.dim;
  if (n.kind === 'pr') return shipColor(n.ship);
  if (n.kind === 'clash') return n.c.writers >= 2 ? COL.red : COL.gold;
  if (n.kind === 'conflict') return conflictColor(n.k);
  if (n.kind === 'agent') return n.a.state === 'fail' ? COL.red : n.s.hue || COL.cyan;
  if (n.kind === 'recent') return n.s.hue || COL.dim;
  return COL.dim;
}
const conflictColor = (k) => (k.kind === 'branch' ? COL.gold : COL.red);
function mountOverlay(el) {
  if (I.overlay) { try { I.overlay.destroy(); } catch (err) { console.error(err); } I.overlay = null; }
  if (!overlayMod) overlayMod = import('./map-overlay.js').catch(() => null);
  const inst = I;
  overlayMod.then((m) => {
    if (!m || typeof m.mountMapOverlay !== 'function' || I !== inst || I.el !== el || I.overlay) return;
    try { I.overlay = m.mountMapOverlay(el, overlayApi()) || null; } catch (err) { console.error(err); I.overlay = null; }
    I.dirty = true;
  }).catch(() => {});
}

// timing of the last frames, for the harness: { avgMs, maxMs, frames, comets }
export function mapStats() {
  if (!I) return null;
  const s = I.stats;
  return { avgMs: s.n ? s.sum / s.n : 0, maxMs: s.max, frames: s.frames, comets: I.comets.length, queued: I.cometQ.length };
}

// node positions on screen, for the harness's click tests: [{ id, kind, x, y, cx, cy, sid, pending, root }]
// (x, y on the canvas; cx, cy in the window's client pixels; wx, wy in the layout's world units). Fading nodes
// are listed with ghost: true.
export function mapNodes() {
  if (!I) return [];
  const r = I.canvas ? I.canvas.getBoundingClientRect() : { left: 0, top: 0 };
  const out = I.nodes.filter((n) => n.sx !== undefined).map((n) => ({
    id: n.id, kind: n.kind, x: n.sx, y: n.sy, cx: r.left + n.sx, cy: r.top + n.sy, sid: n.sid || null, wx: n.p ? n.p.x : null, wy: n.p ? n.p.y : null,
    pending: !!(n.s && n.s.pending), root: n.root || null, name: n.kind === 'session' ? n.s.name : n.name || null,
    // draw params: the bump scale (1 at rest), the alpha the node was drawn at, a hub's ring angle, finished
    fin: !!n.fin, state: n.kind === 'session' ? n.s.state : null, R: n.R, scale: n.bs || 1, alpha: n.da === undefined ? 1 : n.da, spin: n.spin === undefined ? null : n.spin,
    multi: !!(n.kind === 'session' && I.multi.has(n.sid)),
  }));
  for (const g of I.ghosts) out.push({ id: g.n.id, kind: g.n.kind, ghost: true, x: g.n.sx, y: g.n.sy, cx: r.left + g.n.sx, cy: r.top + g.n.sy, sid: g.n.sid || null });
  return out;
}

// the right-click menu's "Unpin": target { kind: 'repo', root } or { kind: 'session', id }
const pinKey = (t) => (!t ? null : t.kind === 'repo' && t.root ? repoId(t.root) : t.kind === 'session' && t.id ? 's:' + t.id : null);
export function mapPinned(t) { const k = I && pinKey(t); return !!(k && I.homeXY.has(k) && I.homeXY.get(k).pin); }
// a repo keeps its spot but may move again; a conversation goes back on its repo's ring
export function mapUnpin(t) {
  const k = I && pinKey(t);
  if (!k || !I.homeXY.has(k)) return;
  if (k.startsWith('s:')) I.homeXY.delete(k); else I.homeXY.get(k).pin = false;
  I.alpha = Math.max(I.alpha, 0.3);
  I.dirty = true;
  saveSpotsSoon(300, true);
}

// "Add workspace" from the map's empty-space menu: the new repo's hub takes the spot where the menu was opened
// (client coordinates), pinned there like a drop, instead of the nearest free spot. false when the map isn't showing.
export function mapPlaceRepo(root, clientX, clientY) {
  if (!active() || !I.cam || !I.canvas || !root || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return false;
  const r = I.canvas.getBoundingClientRect();
  const [x, y] = toWorld(clientX - r.left, clientY - r.top);
  const id = repoId(root);
  I.homeXY.set(id, { x, y, pin: true });
  // a repo that was on the map before (removed, then added back) goes there too
  const p = I.pos.get(id);
  if (p) { p.x = x; p.y = y; p.vx = 0; p.vy = 0; }
  I.alpha = Math.max(I.alpha, 0.3);
  I.dirty = true;
  saveSpotsSoon(300, true);
  return true;
}

// for tests: the map's inner numbers
export function mapDebug() {
  if (!I) return null;
  return { nodes: I.nodes.length, drawn: I.nodes.filter((n) => n.sx !== undefined).length, W: I.W, H: I.H, cam: I.cam, running: I.running, sized: I.sized,
    nanPos: [...I.pos.values()].filter((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y)).length, alpha: I.alpha, ghosts: I.ghosts.length, lastDraw: I.lastDraw,
    react: I.react ? Object.fromEntries([...I.react].map(([id, r]) => [id, { hits: r.hits, bumps: r.bumps, kick: r.kT, kickNow: r.kC }])) : {},
    labels: I.labelRects ? Object.fromEntries(I.labelRects) : {},
    comets: I.comets.concat(I.cometQ).map((c) => c.a + '>' + c.b),
    multi: [...I.multi], lens: I.lens, views: I.views, replay: I.replay, overlay: !!I.overlay, glide: !!I.glide, pan: { ...I.pan }, zoom: I.zoom,
    teams: (I.teams || []).map((t) => ({ id: t.t.id, pairs: t.pairs.length, pill: t.pill || null })),
    links: (I.linkHits || []).map((l) => ({ kind: l.kind, id: l.id, mid: l.mid, pts: l.pts })),
    worktrees: (I.wtHits || []).map((w) => ({ name: w.w.name, x: w.x, y: w.y, live: !!w.w.live, stale: !!w.w.stale })),
    ghosts: (I.parGhosts || []).map((g) => ({ sid: g.n.sid, x: g.x, y: g.y, missing: g.missing })) };
}

// for tests: send a comet from one node to another (ids as mapNodes lists them); it launches now
export function mapComet(from, to) {
  if (!I || !I.byId.has(from) || !I.byId.has(to)) return false;
  const a = I.byId.get(from);
  I.cometQ.push({ a: from, b: to, at: performance.now(), hue: (a.s && a.s.hue) || a.color || COL.cyan });
  I.dirty = true;
  return true;
}
if (typeof location !== 'undefined' && /[?&](fixture|debug)(=|&|$)/.test(location.search)) {
  window.__map = { nodes: () => mapNodes(), stats: () => mapStats(), debug: () => mapDebug(), comet: mapComet,
    selection: () => mapSelection(), setSelection: (ids) => setMapSelection(ids), lens: (n) => (n ? setMapLens(n) : mapLens()), replay: (on) => setMapReplay(on),
    // what a point on the canvas hits: { node, over, extra } (ids / kinds)
    hit: (x, y) => { if (!I) return null; const o = hitOver(x, y), n = hitTest(x, y), e = hitExtra(x, y); return { node: n ? n.id : null, over: o ? o.kind + ':' + o.id : null, extra: e ? e.kind + ':' + e.id : null }; } };
}

// a new conversation got its id: its node, position and pick move over, so the real node takes its place
export function rekeyNode(oldKey, id) {
  if (!I || !oldKey || !id) return;
  const from = 's:' + oldKey, to = 's:' + id;
  for (const m of [I.pos, I.aura, I.look]) if (m.has(from) && !m.has(to)) { m.set(to, m.get(from)); m.delete(from); }
  // the drawn node too, so the next rebuild doesn't see it leave (no fade for a node that only changed its key)
  const n = I.byId.get(from);
  if (n && !I.byId.has(to)) { I.byId.delete(from); n.id = to; n.sid = id; I.byId.set(to, n); }
  if (I.sel === from) I.sel = to;
  if (I.hover === from) I.hover = to;
  I.dirty = true;
}

// lets a test page show the legend without a key press
export function toggleMapLegend(on) {
  if (!I) return;
  setLegend(on === undefined ? !I.legend : !!on);
}

function createInstance(state) {
  const z = Number(state && state.settings && state.settings.zoom);
  return {
    el: null, canvas: null, ctx: null, tip: null, legendEl: null, emptyEl: null,
    W: 0, H: 0, dpr: 1,
    pos: new Map(),           // node id -> { x, y, vx, vy } in world units, kept between polls
    ang: new Map(),           // agent node id -> current orbit angle (eases toward its slot)
    homeOrder: [],
    homeXY: loadSpots(state), // cluster id -> its spot { x, y, pin }: sticky, saved as settings.mapSpots
    spotsTimer: 0,
    nodes: [], byId: new Map(), springs: [], paths: [], clashes: [],
    sig: '', alpha: 0, settledOnce: false,
    cam: null, pan: { x: 0, y: 0 }, zoom: Number.isFinite(z) && z > 0 ? clamp(z, ZMIN, ZMAX) : 1,
    sel: null, hover: null, kbTip: false, legend: false,
    raf: 0, running: false, lastDraw: 0, dirty: true,
    ghosts: [],               // conversations that just left the map: { n, at }, faded out over GHOST_MS
    drag: null, saveTimer: 0, ui: {}, state: null, skew: 0, measure: new Map(),
    // motion
    time: 0, lastT: 0,        // animation clock in ms (stops while the map is hidden, so nothing jumps)
    aura: new Map(),          // session node id -> eased aura radius (screen px at ks 1)
    look: new Map(),          // session node id -> its look and eased levels (see lookOf)
    agl: new Map(),           // agent node id -> eased running level (1 running, 0 done)
    hub: new Map(),           // repo node id -> its eased presence, activity, spin and satellites (see hubOf)
    orb: new Map(),           // agent node id -> orbit offset (radians), advanced only while running
    lab: new Map(),           // label key -> anchor index it last used, so drifting labels don't hop
    seen: new Map(),          // feed key -> [t...] already seen
    feedInit: false,
    comets: [], cometQ: [], nextLaunch: 0,
    reduce: typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null,
    stats: { sum: 0, n: 0, max: 0, frames: 0, ring: new Float32Array(120), i: 0 },
    // command center
    multi: pendingMulti || new Set(), // conversation ids in the multi-selection
    lens: LENSES.includes(state && state.settings && state.settings.mapLens) ? state.settings.mapLens : 'state', lensSeen: undefined,
    views: {}, viewsSeen: null, viewsLocal: false, glide: null,
    teams: [], teamAt: new Map(), teamInit: false, virt: new Map(), // team pills as comet ends ('T:<id>')
    conflicts: [], parity: [], trails: [],
    linkHits: [], wtHits: [], parGhosts: [], hoverX: null, band: null,
    replay: false, replayT: null, spotsBack: null, overlay: null,
  };
}

function attach(el) {
  I.el = el;
  if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
  el.style.overflow = 'hidden';
  if (!I.canvas) {
    const cv = document.createElement('canvas');
    cv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;cursor:default;outline:none';
    I.canvas = cv;
    I.ctx = cv.getContext('2d');
    const tip = document.createElement('div');
    tip.style.cssText = `position:absolute;display:none;pointer-events:none;z-index:5;max-width:340px;${GLASS_BOX}` +
      `border-radius:var(--radius-sm, 8px);padding:9px 12px;font:12px/1.5 ${CSS_UI};overflow-wrap:anywhere`;
    I.tip = tip;
    const lg = document.createElement('div');
    // between the overlay's lens chips (top left) and its replay clock (bottom left), clear of both
    lg.style.cssText = `position:absolute;left:14px;top:${LEGEND_TOP}px;display:none;z-index:4;${GLASS_BOX}` +
      `border-radius:var(--radius, 12px);padding:12px 14px;font:12px/1.5 ${CSS_UI};max-width:min(380px,calc(100% - 28px));` +
      `max-height:calc(100% - ${LEGEND_TOP + LEGEND_LOW}px);overflow:auto;scrollbar-width:thin;scrollbar-color:rgba(138,146,178,0.35) transparent`;
    lg.appendChild(buildLegend());
    I.legendEl = lg;
    const em = document.createElement('div');
    em.style.cssText = `position:absolute;inset:0;display:none;align-items:center;justify-content:center;flex-direction:column;gap:6px;pointer-events:none;font:13px ${CSS_UI};color:${COL.dim}`;
    I.emptyEl = em;
    const hint = document.createElement('div');
    hint.style.cssText = `position:absolute;right:14px;bottom:12px;z-index:3;pointer-events:none;font:11px/1 ${CSS_UI};color:${COL.dim};` +
      `background:${PILL_BG};border:1px solid ${PILL_EDGE};border-radius:999px;padding:4px 9px`;
    const kb = document.createElement('b');
    kb.textContent = 'L';
    kb.style.cssText = `font:600 11px/1 ${CSS_MONO};color:${COL.text};margin-right:6px`;
    hint.append(kb, 'legend');
    I.hintEl = hint;
    // a short note (saved views, n with nothing waiting), bottom centre
    const note = document.createElement('div');
    note.style.cssText = `position:absolute;left:50%;bottom:14px;transform:translateX(-50%);display:none;z-index:4;pointer-events:none;${GLASS_BOX}` +
      `border-radius:999px;padding:5px 12px;font:12px/1.3 ${CSS_UI};white-space:nowrap`;
    I.noteEl = note;
    wireMouse(cv);
  }
  el.appendChild(I.canvas);
  el.appendChild(I.emptyEl);
  el.appendChild(I.hintEl);
  el.appendChild(I.noteEl);
  el.appendChild(I.legendEl);
  el.appendChild(I.tip);
  I.W = 0; I.sized = false; // force a resize check
  I.dirty = true;
  mountOverlay(el);
}

const active = () => !!(I && I.el && I.el.isConnected && I.el.getClientRects().length > 0);

// Keys come through the shell's ui.keys.map hook, not a window listener of our own: the shell routes
// keys to the open repo menu, the open-confirm box and the / filter first, and only then to the map.
function start() {
  if (I.ui && I.ui.keys) I.ui.keys.map = onKey;
  if (I.running || document.hidden) return;
  I.running = true;
  I.dirty = true;
  I.lastT = 0;
  I.raf = requestAnimationFrame(frame);
}
// the loop stops while the window is hidden; come back without waiting for the next poll
document.addEventListener('visibilitychange', () => { if (I && !document.hidden && active()) start(); });
function stop() {
  I.running = false;
  cancelAnimationFrame(I.raf);
  if (I.tip) I.tip.style.display = 'none';
}

// ---------- graph ----------
// a repo hub's id: its root, the same for "Z:/x/" and "z:\x"
const repoId = (root) => 'r:' + String(root).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
function visibleSessions(state) {
  const set = state.settings || {};
  // the shell (app.js) has already applied the repo menu and the / filter, with its own rules (a repo
  // picked by folder name, a query that matches the branch); filtering again here would drop sessions
  // new sessions the desktop window started (no log yet) come from the shell as state.pending
  // the "recently finished" strip's conversations (state.finishedSessions, from the shell) show too, as small
  // dim nodes on their repo; other finished conversations stay off the map unless showDone
  if (Array.isArray(state.allSessions)) {
    // a handing-off stand-in whose pickup runs here is drawn as that pickup (its node was re-keyed to it)
    const out = (state.sessions || []).filter((s) => (s.state !== 'DONE' || !!((I.ui && I.ui.showDone) || set.showDone)) && !(s.handing && s.pendingNext));
    const ids = new Set(out.map((s) => s.id));
    for (const s of state.finishedSessions || []) if (s && !ids.has(s.id)) { ids.add(s.id); out.push(s); }
    return out.concat(state.pending || []);
  }
  const q = String((I.ui && I.ui.query != null ? I.ui.query : set.query) || '').trim();
  const repo = (I.ui && I.ui.repo !== undefined ? I.ui.repo : set.repo) || null;
  const showDone = !!((I.ui && I.ui.showDone) || set.showDone);
  let re = null;
  if (q) { try { re = new RegExp(q, 'i'); } catch { re = null; } }
  const ql = q.toLowerCase();
  return (state.sessions || []).filter((s) => {
    if (s.state === 'DONE' && !showDone) return false;
    if (repo && (!s.repo || String(s.repo.root).toLowerCase() !== String(repo).toLowerCase())) return false;
    if (!q) return true;
    const hay = [s.name, s.goal, s.repo && s.repo.name].filter(Boolean).join('\n');
    return re ? re.test(hay) : hay.toLowerCase().includes(ql);
  });
}

function rebuild() {
  const state = I.state, nowC = Date.now() - I.skew;
  const list = visibleSessions(state);
  const finIds = Array.isArray(state.finishedSessions) ? new Set(state.finishedSessions.map((s) => s && s.id)) : null;
  const visible = new Set(list.map((s) => s.id));
  const nodes = [], byId = new Map(), springs = [], paths = [];
  const add = (n) => { const had = byId.get(n.id); if (had) return had; n.h = hashNum(n.id); byId.set(n.id, n); nodes.push(n); return n; };

  // clashes between conversations that are both on the map
  const clashes = [];
  const clashKeys = new Map();
  for (const c of state.clashes || []) {
    const ss = (c.sessions || []).filter((x) => visible.has(x.id));
    if (ss.length < 2) continue;
    const cc = { ...c, sessions: ss, id: 'f:' + c.key };
    clashes.push(cc);
    clashKeys.set(c.key, cc);
  }
  // conflicts (state.conflicts) between conversations that are both on the map: a branch, a worktree, a migration
  const conflicts = [];
  for (const c of Array.isArray(state.conflicts) ? state.conflicts : []) {
    if (!c || typeof c.id !== 'string') continue;
    const ss = (c.sessions || []).filter((id) => visible.has(id));
    if (ss.length < 2) continue;
    conflicts.push({ ...c, sessions: ss });
  }

  for (const s of list) {
    const sn = add({ id: 's:' + s.id, kind: 'session', s, sid: s.id, agents: [], fin: !!(finIds && finIds.has(s.id) && s.state === 'DONE') });
    if (s.repo && s.repo.root) {
      const rid = repoId(s.repo.root);
      const rn = add({ id: rid, kind: 'repo', name: s.repo.name || s.repo.root, root: s.repo.root, color: s.repo.color || COL.dim, sessions: [], members: [] });
      rn.sessions.push(s);
      springs.push({ a: sn.id, b: rid, rest: REST.repo, repo: rn });
      sn.cl = rid;
    } else sn.cl = '_none';
    if (sn.fin) continue; // a finished conversation: only its link to the repo (steady, nothing around it)
    // agents orbit their conversation on fixed slots, so they are placed, not simulated
    const ags = (s.agents || []).slice(-MAX_AGENTS);
    ags.forEach((a, i) => {
      const an = add({ id: `a:${s.id}:${a.id}`, kind: 'agent', a, s, sid: s.id, parent: sn.id, idx: i, count: ags.length });
      sn.agents.push(an);
    });
    if (s.ship && s.ship.pr) {
      const pid = `p:${s.ship.repo || ''}#${s.ship.pr}`;
      const pn = add({ id: pid, kind: 'pr', s, sid: s.id, num: s.ship.pr, ship: s.ship, cl: sn.cl });
      springs.push({ a: sn.id, b: pn.id, rest: REST.pr });
    }
    // files: the shared ones (clashes) stay; the rest show while touched in the last ten minutes
    const files = (s.files || []).slice().sort((a, b) => b.t - a.t);
    let recentCount = 0;
    for (const f of files) {
      const age = nowC - f.t;
      const cc = clashKeys.get(f.key);
      if (!cc) {
        if (age >= FADE_MS || recentCount >= MAX_RECENT) continue;
        recentCount++;
        const fid = 'f:' + f.key;
        const fn = add({ id: fid, kind: 'recent', f, s, sid: null, cl: sn.cl, lastT: f.t });
        fn.lastT = Math.max(fn.lastT, f.t);
        springs.push({ a: sn.id, b: fid, rest: REST.recent });
        paths.push({ a: sn.id, b: fid, t: f.t, wrote: f.wrote, hue: s.hue });
      } else if (age < FADE_MS) {
        paths.push({ a: sn.id, b: cc.id, t: f.t, wrote: f.wrote, hue: s.hue });
      }
    }
  }
  // the listed repos with no conversation on the map: their hub alone (its territory around it)
  for (const r of state.repoAnchors || []) {
    if (!r || !r.root) continue;
    add({ id: repoId(r.root), kind: 'repo', name: r.name || r.root, root: r.root, color: r.color || COL.dim, sessions: [], members: [] });
  }
  // a repo's territory is drawn around its conversations and their PRs
  for (const n of nodes) if ((n.kind === 'session' || n.kind === 'pr') && n.cl !== '_none') { const r = byId.get(n.cl); if (r && r.members) r.members.push(n); }
  // a repo with more conversations holds them on a wider ring, so their labels have room
  for (const e of springs) if (e.repo) e.rest = 70 + 17 * e.repo.sessions.length;
  for (const cc of clashes) {
    const first = byId.get('s:' + cc.sessions[0].id);
    add({ id: cc.id, kind: 'clash', c: cc, sid: null, cl: first ? first.cl : '_none' });
    for (const x of cc.sessions) springs.push({ a: 's:' + x.id, b: cc.id, rest: REST.clash });
  }
  for (const k of conflicts) {
    const first = byId.get('s:' + k.sessions[0]);
    add({ id: k.id, kind: 'conflict', k, sid: null, cl: first ? first.cl : '_none' });
    for (const id of k.sessions) springs.push({ a: 's:' + id, b: k.id, rest: REST.conflict, conflict: true });
  }
  // worktrees on their repo's hub (state.worktrees, the main checkout left out by the server)
  for (const w of Array.isArray(state.worktrees) ? state.worktrees : []) {
    const r = w && w.root && byId.get(repoId(w.root));
    if (r && r.kind === 'repo') (r.wts || (r.wts = [])).push(w);
  }
  for (const n of nodes) if (n.kind === 'repo' && n.wts) {
    n.wts.sort((a, b) => (a.name < b.name ? -1 : 1));
    n.wtsLive = n.wts.filter((w) => w.live); // only these are drawn
  }
  // teams: pairs of members that are both on the map (all pairs up to 4 members, a ring around them beyond)
  const teams = [];
  for (const t of Array.isArray(state.teams) ? state.teams : []) {
    if (!t || !t.id || !Array.isArray(t.members)) continue;
    const ms = t.members.filter((id) => byId.has('s:' + id));
    if (ms.length < 2) continue;
    teams.push({ t, members: ms, pairs: [] });
  }
  // parity partners (one line per pair, from the web side to the app side) and one-sided changes
  const parity = [], seenPair = new Set();
  for (const s of list) {
    const p = s.parity;
    if (!p || byId.get('s:' + s.id).fin) continue;
    if (p.partner && byId.has('s:' + p.partner)) {
      const key = s.id < p.partner ? s.id + '|' + p.partner : p.partner + '|' + s.id;
      if (seenPair.has(key)) continue;
      seenPair.add(key);
      const o = byId.get('s:' + p.partner).s;
      // the web side first: the one that wrote web files, or that didn't write app files
      const webFirst = (s.side && s.side.web) || !(s.side && s.side.app) || (o.side && o.side.app);
      parity.push(webFirst ? { a: 's:' + s.id, b: 's:' + p.partner } : { a: 's:' + p.partner, b: 's:' + s.id });
    }
  }
  // handoff trails: from the conversation it was picked up from, when that one is on the map too
  const trails = [];
  for (const s of list) {
    const f = s.pickedUpFrom && s.pickedUpFrom.id;
    if (f && f !== s.id && byId.has('s:' + f)) trails.push({ a: 's:' + f, b: 's:' + s.id, name: s.pickedUpFrom.name || f });
  }

  // seed positions for new nodes next to something they link to
  const nb = new Map();
  for (const e of springs) {
    if (!nb.has(e.a)) nb.set(e.a, []);
    if (!nb.has(e.b)) nb.set(e.b, []);
    nb.get(e.a).push(e.b); nb.get(e.b).push(e.a);
  }
  assignHomes(nodes);
  const sim = nodes.filter((n) => n.kind !== 'agent');
  let fresh = 0;
  // repos first, then sessions, then the rest, so each new node can find an anchor that already exists
  const order = { repo: 0, session: 1, pr: 2, clash: 3, conflict: 3, recent: 4 };
  for (const n of sim.slice().sort((a, b) => order[a.kind] - order[b.kind])) {
    let p = I.pos.get(n.id);
    if (!p) {
      const anchor = (nb.get(n.id) || []).map((id) => I.pos.get(id)).find(Boolean);
      const home = I.homeXY.get(n.kind === 'repo' ? n.id : n.cl) || { x: 0, y: 0 };
      const base = anchor || home;
      const r = anchor ? (n.kind === 'session' ? REST.repo : n.kind === 'pr' ? REST.pr : REST.recent) : n.kind === 'repo' ? 0 : 60;
      let a = hashNum(n.id) * Math.PI * 2;
      // a new conversation takes the widest free gap around its repo, so the ring fills evenly
      if (n.kind === 'session' && anchor) {
        const taken = [];
        for (const m of sim) { const mp = I.pos.get(m.id); if (m !== n && m.kind === 'session' && m.cl === n.cl && mp) taken.push(Math.atan2(mp.y - anchor.y, mp.x - anchor.x)); }
        if (taken.length) {
          taken.sort((x, y) => x - y);
          let best = 0, gapBest = -1;
          taken.forEach((t, i) => {
            const nx = i + 1 < taken.length ? taken[i + 1] : taken[0] + Math.PI * 2;
            if (nx - t > gapBest) { gapBest = nx - t; best = t + (nx - t) / 2; }
          });
          a = best;
        }
      }
      p = { x: base.x + Math.cos(a) * r, y: base.y + Math.sin(a) * r, vx: 0, vy: 0 };
      const h = n.kind === 'session' && I.homeXY.get(n.id), hub = h && I.pos.get(n.cl);
      if (hub) { p.x = hub.x + h.x; p.y = hub.y + h.y; } // a conversation dragged before: back where it was
      I.pos.set(n.id, p);
      fresh++;
    }
    n.p = p;
    // drift: two slow waves per axis, periods 6-10 s, phases fixed per node id (a draw offset only)
    const w = (sfx) => TAU / (6000 + 4000 * hashNum(n.id + sfx));
    n.dr = n.fin ? null : [w('x1'), hashNum(n.id + 'px') * TAU, w('x2') * 0.62, hashNum(n.id + 'qx') * TAU,
      w('y1'), hashNum(n.id + 'py') * TAU, w('y2') * 0.62, hashNum(n.id + 'qy') * TAU];
  }
  // conversations that left: fade out where they were (only when the map was on screen just now)
  const tNow = performance.now();
  if (I.byId && I.lastDraw && tNow - I.lastDraw < 1500) {
    for (const old of I.nodes) {
      if (old.kind !== 'session' || byId.has(old.id) || old.sx === undefined) continue;
      // handed off: it flies into its pickup's node instead of fading where it was
      const to = state.handoffPairs && state.handoffPairs.get(old.sid);
      if (!I.ghosts.some((g) => g.n.id === old.id)) I.ghosts.push({ n: old, at: tNow, to: to && byId.has('s:' + to) ? 's:' + to : null });
    }
  }
  I.ghosts = I.ghosts.filter((g) => !byId.has(g.n.id) && tNow - g.at < (g.to ? HANDOFF_GHOST_MS : GHOST_MS));
  for (const id of [...I.pos.keys()]) if (!byId.has(id)) I.pos.delete(id);
  for (const id of [...I.ang.keys()]) if (!byId.has(id)) I.ang.delete(id);
  for (const id of [...I.orb.keys()]) if (!byId.has(id)) I.orb.delete(id);
  for (const id of [...I.aura.keys()]) if (!byId.has(id)) I.aura.delete(id);
  for (const id of [...I.agl.keys()]) if (!byId.has(id)) I.agl.delete(id);
  for (const id of [...I.hub.keys()]) if (!byId.has(id)) I.hub.delete(id);
  for (const id of [...I.look.keys()]) if (!byId.has(id) && !I.ghosts.some((g) => g.n.id === id)) I.look.delete(id);
  if (I.terr) for (const id of [...I.terr.keys()]) if (!byId.has(id)) I.terr.delete(id);

  I.nodes = nodes; I.byId = byId; I.springs = springs; I.paths = paths; I.clashes = clashes; I.sim = sim;
  I.conflicts = conflicts; I.teams = teams; I.parity = parity; I.trails = trails;
  if (sim.length && !I.camUntil) I.camUntil = performance.now() + 2000;
  const sig = sim.map((n) => n.id).sort().join('|');
  if (sig !== I.sig) {
    I.sig = sig;
    I.lab.clear();
    I.alpha = Math.max(I.alpha, I.settledOnce ? 0.35 : 1);
    // first look (or a big change): settle before showing, so the map opens calm instead of exploding
    if (!I.settledOnce || fresh > 6) { for (let i = 0; i < 260; i++) simStep(); I.settledOnce = true; }
  }
  if (I.sel && !byId.has(I.sel)) I.sel = null;
  if (I.hover && !byId.has(I.hover)) I.hover = null;
  I.emptyEl.style.display = nodes.length ? 'none' : 'flex';
  if (!nodes.length) {
    I.emptyEl.textContent = '';
    const a = document.createElement('div'); a.textContent = 'No live conversations';
    a.style.color = COL.dim; I.emptyEl.appendChild(a);
    if (state.hiddenDone) {
      const b = document.createElement('div'); b.style.color = COL.faint; b.style.fontSize = '12px';
      b.textContent = `${state.hiddenDone} finished ${state.hiddenDone === 1 ? 'conversation' : 'conversations'} hidden`;
      I.emptyEl.appendChild(b);
    }
  }
  I.dirty = true;
}

// ---------- signals: each new tool call travels along an edge as a comet ----------
// The shell rebases timestamps on every poll (a few ms of jitter), so an entry is "seen" when the same
// sid/who/verb/what was seen within 1.5 s of its t. Everything in the first state the map sees is history.
function ingestFeed(state) {
  const feed = state.feed || [];
  const nowC = Date.now() - I.skew, nowP = performance.now(); // in replay, nowC is state.now (the replay's clock)
  // replay scrubbed back: what was seen is ahead of the clock now, so it may travel again
  if (I.replay) { if (I.replayT !== null && state.now < I.replayT) I.seen.clear(); I.replayT = state.now; }
  const first = !I.feedInit;
  I.feedInit = true;
  for (const e of feed) {
    if (!e || typeof e.t !== 'number') continue;
    const key = e.sid + '\u0001' + e.who + '\u0001' + e.verb + '\u0001' + e.what;
    let ts = I.seen.get(key);
    if (ts && ts.some((t) => Math.abs(t - e.t) < 1500)) continue;
    if (!ts) I.seen.set(key, (ts = []));
    ts.push(e.t);
    if (first || nowC - e.t > COMET_MAX_AGE) continue;
    const ends = cometEnds(e);
    if (!ends) continue;
    const at = Math.max(nowP, I.nextLaunch);
    if (at - nowP > 2000) continue; // a backlog that big is history by the time it would launch
    I.nextLaunch = at + COMET_STAGGER;
    I.cometQ.push({ a: ends[0], b: ends[1], at, hue: ends[2] });
  }
  // forget entries that dropped out of the feed long ago
  if (I.seen.size > 400) {
    for (const [k, ts] of I.seen) if (ts[ts.length - 1] < nowC - 15 * 60e3) I.seen.delete(k);
  }
}

const baseName = (rel) => { const p = String(rel || '').replace(/\\/g, '/').split('/'); return (p[p.length - 1] || '').toLowerCase(); };

// [from id, to id, hue] for a feed entry, or null when its conversation isn't on the map
function cometEnds(e) {
  const sn = I.byId.get('s:' + e.sid);
  if (!sn) return null;
  const hue = sn.s.hue || COL.cyan;
  // a message to another conversation (a teammate): from one to the other, along their team's link
  if (e.to) {
    const tn = I.byId.get('s:' + e.to);
    if (!tn) return null;
    const team = I.teams.find((t) => t.members.includes(e.sid) && t.members.includes(e.to));
    return [sn.id, tn.id, (team && team.t.color) || hue];
  }
  if (e.who && e.who !== 'main') {
    const ag = sn.agents.find((n) => n.a.label === e.who && n.a.state === 'run') || sn.agents.find((n) => n.a.label === e.who);
    if (ag) return [ag.id, sn.id, hue];
  } else if (e.what) {
    const w = String(e.what).toLowerCase();
    for (const p of I.paths) {
      if (p.a !== sn.id) continue;
      const b = I.byId.get(p.b);
      if (!b) continue;
      const base = baseName(b.kind === 'recent' ? b.f.rel : b.c && b.c.rel);
      if (base && (w === base || (base.length >= 4 && w.includes(base)))) return [sn.id, b.id, hue];
    }
  }
  if ((e.verb === 'shell' || e.verb === 'pwsh') && PUSH_RE.test(String(e.what || ''))) {
    const pr = I.nodes.find((n) => n.kind === 'pr' && n.sid === e.sid);
    if (pr) return [sn.id, pr.id, hue];
  }
  if (sn.cl && sn.cl !== '_none' && I.byId.has(sn.cl)) return [sn.id, sn.cl, hue];
  return null;
}

// A team's new order (its `at` moved on): one comet from the team's pill to each member. A team seen for the first
// time is history, unless its order is younger than COMET_MAX_AGE (it was just made).
function ingestTeams(state) {
  const nowC = Date.now() - I.skew, first = !I.teamInit;
  I.teamInit = true;
  for (const t of Array.isArray(state.teams) ? state.teams : []) {
    if (!t || !t.id) continue;
    const prev = I.teamAt.get(t.id);
    I.teamAt.set(t.id, t.at);
    if (first || !Number.isFinite(t.at) || (prev !== undefined && !(t.at > prev))) continue;
    if (prev === undefined && nowC - t.at > COMET_MAX_AGE) continue;
    const tm = I.teams.find((x) => x.t.id === t.id);
    if (!tm) continue;
    let at = Math.max(performance.now() + 120, I.nextLaunch); // after the pill has been placed once
    for (const id of tm.members) {
      I.cometQ.push({ a: 'T:' + t.id, b: 's:' + id, at, hue: t.color || COL.cyan });
      at += COMET_STAGGER;
    }
    I.nextLaunch = at;
  }
  if (I.teamAt.size > 200) for (const id of [...I.teamAt.keys()]) if (!(state.teams || []).some((t) => t && t.id === id)) I.teamAt.delete(id);
}

// the saved spots: settings.mapSpots [{ id, x, y, pin }]
function loadSpots(state) {
  const m = new Map(), list = state && state.settings && state.settings.mapSpots;
  if (Array.isArray(list)) for (const s of list) {
    if (s && typeof s.id === 'string' && Number.isFinite(s.x) && Number.isFinite(s.y)) m.set(s.id, { x: s.x, y: s.y, pin: !!s.pin });
  }
  return m;
}
// save the spots in a moment (pinned ones first, at most 300). A save already waiting stays, so the small
// nudges of the spacing rule can't keep putting it off; force (a drop, a re-arrange) saves sooner.
function saveSpotsSoon(ms = 1500, force = false) {
  if (I.replay) return; // replay: its spots are forgotten when it ends
  if (I.spotsTimer && !force) return;
  clearTimeout(I.spotsTimer);
  I.spotsTimer = setTimeout(() => {
    if (!I) return;
    I.spotsTimer = 0;
    if (I.replay) return;
    const list = [...I.homeXY].map(([id, h]) => ({ id, x: Math.round(h.x), y: Math.round(h.y), pin: !!h.pin }))
      .sort((a, b) => rank(a) - rank(b)).slice(0, 300);
    try { I.ui.saveSettings && I.ui.saveSettings({ mapSpots: list }); } catch { /* shell gone */ }
  }, ms);
}
// kept first when there are too many: pinned repos, other repo spots, then pinned conversations
const rank = (x) => (x.id.startsWith('s:') ? 2 : x.pin ? 0 : 1);
const pinned = (id) => { const h = I.homeXY.get(id); return !!(h && h.pin); };
// a dragged conversation's place: its saved offset from its repo's hub (or its group's spot when it has no repo)
function convBase(n) {
  const hub = I.byId && I.byId.get(n.cl);
  return hub && hub.p ? hub.p : I.homeXY.get(n.cl) || null;
}
function convPin(n) {
  const h = n.kind === 'session' && I.homeXY.get(n.id), b = h && convBase(n);
  return b ? { x: b.x + h.x, y: b.y + h.y } : null;
}
// the repo whose group a dragged conversation is over, when it isn't its own: the nearest hub whose group
// reaches the point (null over its own group or empty space)
function dropRepo(n) {
  if (!n.p || !n.s || n.s.pending || n.s.demo || typeof (I.ui && I.ui.moveSession) !== 'function') return null;
  const ext = groupExt(I.sim);
  let best = null, bd = Infinity;
  for (const r of I.sim) {
    if (r.kind !== 'repo' || !r.p) continue;
    const d = Math.hypot(n.p.x - r.p.x, n.p.y - r.p.y);
    if (d <= Math.max(70, (ext.get(r.id) || 40) * 0.9) && d < bd) { bd = d; best = r; }
  }
  return best && best.id !== n.cl ? best : null;
}

// Each cluster (a repo and its conversations) gets a spot it keeps (see "Repo spots" at the top).
function assignHomes(nodes) {
  const ids = [];
  for (const n of nodes) if (n.kind === 'repo') ids.push(n.id);
  if (nodes.some((n) => n.kind === 'session' && n.cl === '_none')) ids.push('_none');
  for (const id of ids) if (!I.homeOrder.includes(id)) I.homeOrder.push(id);
  const live = I.homeOrder.filter((id) => ids.includes(id));
  // repos that already have a spot keep it: only new ones are placed
  const missing = live.filter((id) => !I.homeXY.has(id));
  if (!missing.length) return;
  const size = new Map();
  for (const n of nodes) { const c = n.kind === 'repo' ? n.id : n.cl; size.set(c, (size.get(c) || 0) + 1); }
  // clusters are packed in rows, each as wide as its size needs, rows centred; the target row width
  // follows the canvas shape so several repos use the width instead of piling up in the middle
  const aspect = I.W && I.H ? I.W / I.H : 1.6;
  // at least the room separate() keeps around the group as it is now, so homes and spacing never pull apart
  const ext = groupExt(nodes);
  const radius = (id) => Math.max(70 + 30 * Math.sqrt(Math.ceil((size.get(id) || 1) / 4) * 4), ((ext.get(id) || 0) + CLUSTER_PAD) / 1.15);
  const placed = live.filter((id) => I.homeXY.has(id));
  if (placed.length) {
    // the nearest free spot to the middle of the others, clear of each of them (stretched to the window's shape)
    const s = Math.sqrt(clamp(aspect, 0.5, 3));
    for (const id of missing) {
      const others = live.filter((o) => o !== id && I.homeXY.has(o)).map((o) => [o, I.homeXY.get(o)]);
      const cx = others.reduce((t, [, h]) => t + h.x, 0) / others.length, cy = others.reduce((t, [, h]) => t + h.y, 0) / others.length;
      const free = (x, y) => others.every(([o, h]) => Math.hypot(x - h.x, y - h.y) >= (radius(id) + radius(o)) * 1.15 + CLUSTER_GAP);
      let spot = null;
      for (let ring = 1; ring < 120 && !spot; ring++) {
        const r = ring * 40, steps = Math.max(6, Math.round((TAU * r) / 40));
        for (let k = 0; k < steps && !spot; k++) {
          const a = (k / steps) * TAU, x = cx + Math.cos(a) * r * s, y = cy + Math.sin(a) * r / s;
          if (free(x, y)) spot = { x, y, pin: false };
        }
      }
      I.homeXY.set(id, spot || { x: cx, y: cy, pin: false });
    }
    saveSpotsSoon();
    return;
  }
  // the first layout: try every row width that changes the packing and keep the one that lets the camera zoom in most
  const pack = (rowW) => {
    const rows = [];
    let row = null;
    for (const id of live) {
      const w = 2 * radius(id) * 1.3 + CLUSTER_GAP;
      if (!row || (row.w + w > rowW + 0.5 && row.ids.length)) rows.push((row = { ids: [], ws: [], w: 0, h: 0 }));
      row.ids.push(id); row.ws.push(w); row.w += w; row.h = Math.max(row.h, 2 * radius(id) * 1.15 + CLUSTER_GAP);
    }
    return rows;
  };
  let rows = pack(Infinity), bestScore = -1;
  const widths = new Set([Infinity]);
  for (let i = 0; i < live.length; i++) { let w = 0; for (let j = i; j < live.length; j++) { w += 2 * radius(live[j]) * 1.3 + CLUSTER_GAP; widths.add(w); } }
  for (const rw of widths) {
    const r = pack(rw);
    const tw = Math.max(...r.map((x) => x.w)), th = r.reduce((t, x) => t + x.h, 0);
    // the current packing wins near-ties, so repos don't swap rows back and forth as their sizes wobble
    const same = r.map((x) => x.ids.join(',')).join('/') === I.homeSig;
    const score = Math.min(aspect / tw, 1 / th) * (same ? 1.05 : 1);
    if (score > bestScore * 1.02) { bestScore = score; rows = r; }
  }
  const totalH = rows.reduce((t, r) => t + r.h, 0);
  I.homeSig = rows.map((r) => r.ids.join(',')).join('/');
  let y = -totalH / 2;
  for (const r of rows) {
    let x = -r.w / 2;
    r.ids.forEach((id, i) => { I.homeXY.set(id, { x: x + r.ws[i] / 2, y: y + r.h / 2, pin: false }); x += r.ws[i]; });
    y += r.h;
  }
  saveSpotsSoon();
}

// re-arrange: the repos that aren't pinned (all of them with unpin) get new spots around the pinned ones
function rearrange(unpin) {
  for (const [id, h] of [...I.homeXY]) if (unpin || !h.pin) I.homeXY.delete(id);
  assignHomes(I.nodes);
  I.alpha = Math.max(I.alpha, 0.3);
  I.dirty = true;
  I.camUntil = performance.now() + 1500; // the camera fits the new layout
  saveSpotsSoon(300, true);
}

// A dragged repo's members (conversations, PRs, files) ease toward their place around the hub each frame instead
// of moving with it as one rigid block: conversations keep up closely, the dots around them lag a little more,
// the far ones a little more again. No overshoot, and it ends on the shape the group had when the drag began.
function startTrail(hub) {
  if (I.trail && I.trail.hub === hub) return;
  const offs = new Map();
  for (const m of I.sim) if (m.p && m !== hub && m.cl === hub.id) offs.set(m, { x: m.p.x - hub.p.x, y: m.p.y - hub.p.y });
  I.trail = { hub, offs, t: performance.now() };
}
function trailStep(now) {
  const tr = I.trail;
  if (!tr) return false;
  if (!tr.hub.p || I.byId.get(tr.hub.id) !== tr.hub) { I.trail = null; return false; }
  const dt = Math.min(64, Math.max(1, now - tr.t)) / 16.7;
  tr.t = now;
  let most = 0;
  for (const [m, o] of tr.offs) {
    if (!m.p || m.cl !== tr.hub.id) { tr.offs.delete(m); continue; }
    const tx = tr.hub.p.x + o.x, ty = tr.hub.p.y + o.y, ex = tx - m.p.x, ey = ty - m.p.y;
    const far = Math.min(1, Math.hypot(o.x, o.y) / 500);
    const k = (m.kind === 'session' ? 0.3 : 0.2) * (1 - 0.35 * far);
    const f = 1 - Math.pow(1 - k, dt);
    m.p.x += ex * f; m.p.y += ey * f; m.p.vx = m.p.vy = 0;
    most = Math.max(most, Math.abs(ex), Math.abs(ey));
  }
  if (most < 0.3 && !(I.drag && I.drag.node === tr.hub.id)) {
    for (const [m, o] of tr.offs) if (m.p) { m.p.x = tr.hub.p.x + o.x; m.p.y = tr.hub.p.y + o.y; }
    I.trail = null;
  }
  return true;
}

function simStep() {
  const ns = I.sim, n = ns.length, al = I.alpha;
  if (!n) return;
  for (let i = 0; i < n; i++) {
    const a = ns[i];
    const ca = CHARGE[a.kind] + (a.kind === 'session' ? 7 * a.agents.length - (a.fin ? FIN_CHARGE_CUT : 0) : 0);
    for (let j = i + 1; j < n; j++) {
      const b = ns[j];
      let dx = a.p.x - b.p.x, dy = a.p.y - b.p.y, d2 = dx * dx + dy * dy;
      if (d2 > 700 * 700) continue;
      if (d2 < 1) { const t = hashNum(a.id + b.id) * Math.PI * 2; dx = Math.cos(t); dy = Math.sin(t); d2 = 1; }
      const cb = CHARGE[b.kind] + (b.kind === 'session' ? 7 * b.agents.length - (b.fin ? FIN_CHARGE_CUT : 0) : 0);
      const d = Math.sqrt(d2), f = Math.min(30, (ca * cb) / d2) * al;
      const fx = (dx / d) * f, fy = (dy / d) * f;
      a.p.vx += fx / MASS[a.kind]; a.p.vy += fy / MASS[a.kind];
      b.p.vx -= fx / MASS[b.kind]; b.p.vy -= fy / MASS[b.kind];
    }
  }
  for (const e of I.springs) {
    const a = I.byId.get(e.a), b = I.byId.get(e.b);
    if (!a || !b || !a.p || !b.p) continue;
    const dx = b.p.x - a.p.x, dy = b.p.y - a.p.y, d = Math.sqrt(dx * dx + dy * dy) || 0.1;
    const f = 0.09 * (d - e.rest) * al;
    const fx = (dx / d) * f, fy = (dy / d) * f;
    a.p.vx += fx / MASS[a.kind]; a.p.vy += fy / MASS[a.kind];
    b.p.vx -= fx / MASS[b.kind]; b.p.vy -= fy / MASS[b.kind];
  }
  for (const nd of ns) {
    if (I.trail && I.trail.offs.has(nd)) continue; // trailing a dragged repo: trailStep moves it
    const h = I.homeXY.get(nd.kind === 'repo' ? nd.id : nd.cl) || { x: 0, y: 0 };
    if (nd.kind === 'repo' && h.pin) { nd.p.x = h.x; nd.p.y = h.y; nd.p.vx = nd.p.vy = 0; continue; }
    const cp = nd.kind === 'session' && convPin(nd);
    if (cp) { nd.p.x = cp.x; nd.p.y = cp.y; nd.p.vx = nd.p.vy = 0; continue; }
    const pull = (nd.kind === 'repo' ? 0.03 : nd.kind === 'session' ? 0.004 : 0.001) * al;
    nd.p.vx -= (nd.p.x - h.x) * pull; nd.p.vy -= (nd.p.y - h.y) * pull;
    nd.p.vx *= 0.55; nd.p.vy *= 0.55;
    const v = Math.hypot(nd.p.vx, nd.p.vy);
    if (v > 14) { nd.p.vx *= 14 / v; nd.p.vy *= 14 / v; }
    nd.p.x += nd.p.vx; nd.p.y += nd.p.vy;
  }
  separate(0.3);
  I.alpha *= 0.985;
}

// Push apart whatever is closer than the hard spacing above: whole repo groups first (hub and members move
// together, so a group keeps its shape), then single nodes. Moves a share of the overlap per call, so it eases
// apart over a few frames. Returns the largest move (0 when nothing overlaps).
function separate(share) {
  const ns = I.sim;
  if (!ns || ns.length < 2) return 0;
  let most = 0;
  const groups = new Map(); // repo id -> { hub, members, ext }
  const ext = groupExt(ns);
  for (const n of ns) if (n.kind === 'repo' && n.p) groups.set(n.id, { hub: n, members: [], ext: ext.get(n.id) || 40 });
  for (const n of ns) { const g = n.kind !== 'repo' && n.p && groups.get(n.cl); if (g) g.members.push(n); }
  const gs = [...groups.values()];
  const shift = (g, dx, dy) => {
    if (!dx && !dy) return;
    for (const n of [g.hub, ...g.members]) { n.p.x += dx; n.p.y += dy; }
    const h = I.homeXY.get(g.hub.id);
    if (h && !h.pin) { h.x += dx; h.y += dy; I.spotsMoved = true; }
  };
  for (let i = 0; i < gs.length; i++) for (let j = i + 1; j < gs.length; j++) {
    const a = gs[i], b = gs[j];
    let dx = b.hub.p.x - a.hub.p.x, dy = b.hub.p.y - a.hub.p.y, d = Math.hypot(dx, dy);
    const want = a.ext + b.ext + 2 * CLUSTER_PAD + CLUSTER_GAP;
    if (d >= want) continue;
    const pa = pinned(a.hub.id), pb = pinned(b.hub.id);
    if (pa && pb) continue; // both placed by hand: left as they are
    if (d < 0.5) { const t = hashNum(a.hub.id + b.hub.id) * TAU; dx = Math.cos(t); dy = Math.sin(t); d = 1; }
    const m = (want - d) * share, ma = pa ? 0 : pb ? m : m / 2, mb = pb ? 0 : pa ? m : m / 2;
    shift(a, (-dx / d) * ma, (-dy / d) * ma); shift(b, (dx / d) * mb, (dy / d) * mb);
    most = Math.max(most, ma, mb);
  }
  for (let i = 0; i < ns.length; i++) for (let j = i + 1; j < ns.length; j++) {
    const a = ns[i], b = ns[j];
    if (!a.p || !b.p || a.kind === 'repo' || b.kind === 'repo') continue;
    const same = a.cl === b.cl && a.cl !== '_none';
    if (same && (a.kind !== 'session' || b.kind !== 'session')) continue;
    const want = same ? APART_SAME : APART_OTHER;
    let dx = b.p.x - a.p.x, dy = b.p.y - a.p.y, d = Math.hypot(dx, dy);
    if (d >= want) continue;
    if (d < 0.5) { const t = hashNum(a.id + b.id) * TAU; dx = Math.cos(t); dy = Math.sin(t); d = 1; }
    // a conversation placed by hand stays put: the other one makes way
    const pa = a.kind === 'session' && pinned(a.id), pb = b.kind === 'session' && pinned(b.id);
    if (pa && pb) continue;
    const m = (want - d) * share, ma = pa ? 0 : pb ? m : m / 2, mb = pb ? 0 : pa ? m : m / 2;
    a.p.x -= (dx / d) * ma; a.p.y -= (dy / d) * ma; b.p.x += (dx / d) * mb; b.p.y += (dy / d) * mb;
    most = Math.max(most, m);
  }
  return most;
}

// How far each repo's conversations and PRs reach from its hub (at least 40): the group's size for spacing.
// Recent files and clash nodes don't count: they come and go, and a clash sits between two repos, so counting
// them pushed whole repos apart and nothing brought them back.
function groupExt(nodes) {
  const hubs = new Map(), ext = new Map();
  for (const n of nodes) { const p = n.kind === 'repo' && I.pos.get(n.id); if (p) { hubs.set(n.id, p); ext.set(n.id, 40); } }
  for (const n of nodes) {
    if (n.kind !== 'session' && n.kind !== 'pr') continue;
    const h = hubs.get(n.cl), p = I.pos.get(n.id);
    if (h && p) ext.set(n.cl, Math.max(ext.get(n.cl), Math.hypot(p.x - h.x, p.y - h.y)));
  }
  return ext;
}

// Glide each repo's whole group (its hub and everything on it) a share of the way to its grid home, so the map
// always ends on the packed layout assignHomes picked to fit the window, not wherever the forces left it.
// Returns the largest move.
function gather(share = 0.03) {
  const ns = I.sim;
  if (!ns || !I.homeXY) return 0;
  const moves = new Map();
  let most = 0;
  for (const n of ns) {
    const h = n.kind === 'repo' && n.p && I.homeXY.get(n.id);
    if (!h) continue;
    const dx = (h.x - n.p.x) * share, dy = (h.y - n.p.y) * share;
    moves.set(n.id, { dx, dy });
    most = Math.max(most, Math.hypot(dx, dy));
  }
  if (most < 0.05) return most;
  for (const n of ns) { const m = n.p && moves.get(n.kind === 'repo' ? n.id : n.cl); if (m) { n.p.x += m.dx; n.p.y += m.dy; } }
  return most;
}

// ---------- camera ----------
function camTarget() {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const n of I.sim || []) { x0 = Math.min(x0, n.p.x); x1 = Math.max(x1, n.p.x); y0 = Math.min(y0, n.p.y); y1 = Math.max(y1, n.p.y); }
  if (!isFinite(x0)) { x0 = y0 = -100; x1 = y1 = 100; }
  // room for orbiting agents and labels around the edge
  const bw = Math.max(200, x1 - x0 + 260), bh = Math.max(200, y1 - y0 + 130);
  const fit = clamp(Math.min((I.W - 60) / bw, (I.H - 60) / bh), 0.25, 1.5);
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, fit };
}
function updateCamera(snap) {
  const t = camTarget();
  if (!I.cam || snap) { I.cam = t; return false; }
  const c = I.cam;
  const moving = Math.abs(t.cx - c.cx) > 0.3 || Math.abs(t.cy - c.cy) > 0.3 || Math.abs(t.fit / c.fit - 1) > 0.002;
  c.cx += (t.cx - c.cx) * 0.1; c.cy += (t.cy - c.cy) * 0.1;
  c.fit *= Math.pow(t.fit / c.fit, 0.1);
  return moving;
}
const K = () => I.cam.fit * I.zoom;
const toScreen = (x, y) => [(x - I.cam.cx - I.pan.x) * K() + I.W / 2, (y - I.cam.cy - I.pan.y) * K() + I.H / 2];
const toWorld = (sx, sy) => [(sx - I.W / 2) / K() + I.cam.cx + I.pan.x, (sy - I.H / 2) / K() + I.cam.cy + I.pan.y];

function zoomAt(sx, sy, factor) {
  if (!I.cam) return;
  I.glide = null; // the hand wins over a glide
  const [wx, wy] = toWorld(sx, sy);
  I.zoom = clamp(I.zoom * factor, ZMIN, ZMAX);
  const [nx, ny] = toWorld(sx, sy);
  I.pan.x += wx - nx; I.pan.y += wy - ny;
  I.dirty = true;
  saveZoomSoon();
}

// ---------- frame loop ----------
function frame() {
  if (!active() || document.hidden) { stop(); return; }
  I.raf = requestAnimationFrame(frame);
  const t0 = performance.now();
  const dt = I.lastT ? Math.min(100, t0 - I.lastT) : 16;
  I.lastT = t0; I.dt = dt;
  I.still = !!(I.reduce && I.reduce.matches);
  if (!I.still) I.time += dt;
  const r = I.el.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  // the strips above the map (the alert line, Recently finished) change height without changing its size much:
  // its top edge moves on screen, and the view must not move with it
  const top0 = I.top, left0 = I.left;
  I.top = r.top; I.left = r.left;
  const shifted = I.cam && top0 != null && (Math.abs(r.top - top0) >= 0.5 || Math.abs(r.left - left0) >= 0.5);
  if (shifted) { I.pan.x += (r.left - left0) / K(); I.pan.y += (r.top - top0) / K(); I.dirty = true; }
  if (!I.sized || Math.round(r.width) !== I.W || Math.round(r.height) !== I.H || dpr !== I.dpr) {
    I.sized = true;
    const W0 = I.W, H0 = I.H;
    I.W = Math.round(r.width); I.H = Math.round(r.height); I.dpr = dpr;
    I.canvas.width = Math.max(1, Math.round(I.W * dpr)); I.canvas.height = Math.max(1, Math.round(I.H * dpr));
    // the solid page colour (Edge, no glass) comes from the shell's --bg when it sets one
    try { I.bgFill = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || COL.bg; } catch { I.bgFill = COL.bg; }
    const before = I.homeSig;
    assignHomes(I.nodes);
    if (before && before !== I.homeSig) I.alpha = Math.max(I.alpha, 0.3);
    if (!I.camInit) { updateCamera(true); I.camInit = true; }
    else if (I.cam && W0 && H0) {
      // a resized map (the panel opening, the window) doesn't move the view: what's on screen stays put,
      // held by its top-left corner (the panel takes room from the right), and by where that corner is on
      // screen (above)
      I.pan.x += (I.W - W0) / (2 * K()); I.pan.y += (I.H - H0) / (2 * K());
    }
    I.dirty = true;
  }
  if (I.alpha > 0.01) { simStep(); simStep(); I.dirty = true; }
  else if (separate(0.15) > 0.05) I.dirty = true; // settled: still never let anything sit too close
  if (gather() > 0.05) I.dirty = true;
  if (trailStep(t0)) I.dirty = true;
  if (I.spotsMoved) { I.spotsMoved = false; saveSpotsSoon(3000); }
  // the camera fits the map when it first shows (and on 0 or a re-arrange), then holds still: changes never pan
  // or zoom the view by themselves
  if (!(I.drag && I.drag.node) && performance.now() < (I.camUntil || Infinity) && updateCamera(false)) I.dirty = true;
  if (stepGlide(t0)) I.dirty = true;
  // continuous motion while anything moves; otherwise only on change (and a slow tick for age fades)
  const moving = (!I.still && I.nodes.length > 0) || I.comets.length > 0 || I.cometQ.length > 0 || I.ghosts.length > 0;
  if (I.dirty || moving || t0 - I.lastDraw > 250) {
    draw(); I.lastDraw = t0; I.dirty = false;
    const ms = performance.now() - t0, s = I.stats;
    s.frames++;
    s.sum += ms - (s.n === s.ring.length ? s.ring[s.i] : 0);
    s.ring[s.i] = ms; s.i = (s.i + 1) % s.ring.length; s.n = Math.min(s.ring.length, s.n + 1);
    if (ms > s.max) s.max = ms;
  }
  // the overlay (edge pointers, minimap, ...) follows every frame; its errors never stop the map
  if (I.overlay && typeof I.overlay.frame === 'function') { try { I.overlay.frame(performance.now()); } catch (err) { console.error(err); } }
}

// ---------- drawing ----------
function font(px, weight = 400, fam = UI) { return `${weight} ${px}px ${fam}`; }
function measure(ctx, f, text) {
  const key = f + '|' + text;
  let w = I.measure.get(key);
  if (w === undefined) {
    ctx.font = f; w = ctx.measureText(text).width;
    if (I.measure.size > 4000) I.measure.clear();
    I.measure.set(key, w);
  }
  return w;
}
// wrap at spaces, dashes, underscores and slashes; never cut a name, only break it
function wrap(ctx, f, text, maxW) {
  const tokens = String(text).match(/[^\s\-_/]+[\s\-_/]*|[\s\-_/]+/g) || [String(text)];
  const lines = [];
  let cur = '';
  const pushLong = (tok) => {
    let part = '';
    for (const ch of tok) {
      if (part && measure(ctx, f, part + ch) > maxW) { lines.push(part); part = ''; }
      part += ch;
    }
    return part;
  };
  for (const tok of tokens) {
    if (!cur) { cur = measure(ctx, f, tok.trimEnd()) > maxW ? pushLong(tok) : tok; continue; }
    if (measure(ctx, f, (cur + tok).trimEnd()) <= maxW) cur += tok;
    else { lines.push(cur.trimEnd()); cur = measure(ctx, f, tok.trimEnd()) > maxW ? pushLong(tok) : tok; }
  }
  if (cur.trim()) lines.push(cur.trimEnd());
  return lines.length ? lines : [String(text)];
}

function sessionRadius(s, ks) {
  const base = s.state === 'DONE' ? 7 : 7.5 + Math.min(5, Math.sqrt(s.calls20 || 0) * 0.9);
  return base * ks;
}

// ---------- paint: gradients are built once per colour in unit space and drawn through a transform ----------
// (a canvas gradient is fixed to its coordinates, so a unit gradient placed with setTransform can be reused
// by every node of that colour at any size and position; nothing is allocated per frame for them)
const WHITE = [255, 255, 255], BLACK = [5, 7, 13];
const RGB = new Map(), RGBA = new Map();
function hexRgb(hex) {
  let v = RGB.get(hex);
  if (!v) {
    const h = String(hex || COL.dim);
    v = [parseInt(h.slice(1, 3), 16) || 0, parseInt(h.slice(3, 5), 16) || 0, parseInt(h.slice(5, 7), 16) || 0];
    RGB.set(hex, v);
  }
  return v;
}
function rgba(hex, a) {
  hex = hex || COL.dim;
  a = Math.round(a * 100) / 100;
  let m = RGBA.get(hex);
  if (!m) RGBA.set(hex, (m = new Map()));
  let s = m.get(a);
  if (!s) { const c = hexRgb(hex); s = `rgba(${c[0]},${c[1]},${c[2]},${a})`; m.set(a, s); }
  return s;
}
// a hex colour taken part of the way to another (hex too, so orb() can build its gradient from it)
const HEXMIX = new Map();
function mixHex(hex, to, t) {
  const k = hex + to + t;
  let v = HEXMIX.get(k);
  if (!v) {
    const a = hexRgb(hex), b = hexRgb(to);
    v = '#' + a.map((c, i) => Math.round(c + (b[i] - c) * t).toString(16).padStart(2, '0')).join('');
    HEXMIX.set(k, v);
  }
  return v;
}
function mix(hex, to, t) {
  const c = hexRgb(hex || COL.dim);
  return `rgb(${Math.round(c[0] + (to[0] - c[0]) * t)},${Math.round(c[1] + (to[1] - c[1]) * t)},${Math.round(c[2] + (to[2] - c[2]) * t)})`;
}
// cache(kind, a, b, build): one gradient per kind and colour pair, for the life of the canvas
function cache(kind, a, b, build) {
  const P = I.paint || (I.paint = new Map());
  let m1 = P.get(kind);
  if (!m1) P.set(kind, (m1 = new Map()));
  let m2 = m1.get(a);
  if (!m2) m1.set(a, (m2 = new Map()));
  let g = m2.get(b);
  if (!g) { g = build(I.ctx, a, b); m2.set(b, g); }
  return g;
}
const buildOrb = (c, hue) => {
  // light from the top left: a lighter tint, then the hue, then a darker rim
  const g = c.createRadialGradient(-0.36, -0.42, 0.04, 0, 0, 1.04);
  g.addColorStop(0, mix(hue, WHITE, 0.55)); g.addColorStop(0.5, hue); g.addColorStop(1, mix(hue, BLACK, 0.45));
  return g;
};
const buildAura = (c, hue) => {
  const g = c.createRadialGradient(0, 0, 0, 0, 0, 1);
  g.addColorStop(0, rgba(hue, AURA_ALPHA)); g.addColorStop(0.5, rgba(hue, AURA_ALPHA * 0.42)); g.addColorStop(1, rgba(hue, 0));
  return g;
};
const buildTerr = (c, hue) => {
  const g = c.createRadialGradient(0, 0, 0, 0, 0, 1);
  g.addColorStop(0, rgba(hue, TERR_ALPHA)); g.addColorStop(0.65, rgba(hue, TERR_ALPHA * 0.6)); g.addColorStop(1, rgba(hue, 0));
  return g;
};
const buildDiamond = (c, hue) => {
  const g = c.createLinearGradient(-0.5, -1, 0.5, 1);
  g.addColorStop(0, mix(hue, WHITE, 0.42)); g.addColorStop(0.5, hue); g.addColorStop(1, mix(hue, BLACK, 0.38));
  return g;
};
// along an edge drawn in its own frame: (0,0) is the source, (1,0) the target
const buildEdge = (alpha) => (c, a, b) => {
  const g = c.createLinearGradient(0, 0, 1, 0);
  g.addColorStop(0, rgba(a, alpha)); g.addColorStop(1, rgba(b, alpha));
  return g;
};
const EDGE_LIVE = buildEdge(0.3), EDGE_DONE = buildEdge(0.1);

// transforms: unit space at (x, y) scaled by s, an edge's own frame, and back to plain screen pixels
function unit(ctx, x, y, s) { const d = I.dpr; ctx.setTransform(d * s, 0, 0, d * s, d * x, d * y); }
function screen(ctx) { const d = I.dpr; ctx.setTransform(d, 0, 0, d, 0, 0); }

function orb(ctx, x, y, r, hue) {
  if (r < 0.5) return;
  unit(ctx, x, y, r);
  ctx.fillStyle = cache('orb', hue || COL.dim, '', buildOrb);
  ctx.beginPath(); ctx.arc(0, 0, 1, 0, TAU); ctx.fill();
  // a faint 1px rim highlight along the lit side
  if (r >= 2.5) {
    ctx.strokeStyle = 'rgba(255,255,255,0.24)'; ctx.lineWidth = 1 / r;
    ctx.beginPath(); ctx.arc(0, 0, 1 - 0.5 / r, Math.PI * 1.06, Math.PI * 1.78); ctx.stroke();
  }
  screen(ctx);
}

// Curved edges: a quadratic bend of 12% of the length, always to the same side for a given pair (the
// side comes from both ends' hashes, so it holds whichever end draws it). Comets ride the same curve.
const BEND = 0.12, BEND_MAX = 46;
const CP = { x: 0, y: 0 };
function bendSide(a, b) {
  const s = ((a.h + b.h) * 977) % 1 < 0.5 ? 1 : -1;
  return a.h <= b.h ? s : -s;
}
function bend(a, b) {
  const dx = b.sx - a.sx, dy = b.sy - a.sy, d = Math.hypot(dx, dy) || 1;
  const straight = a.kind === 'agent' || b.kind === 'agent';
  const s = straight ? 0 : bendSide(a, b) * Math.min(d * BEND, BEND_MAX);
  CP.x = (a.sx + b.sx) / 2 - (dy / d) * s; CP.y = (a.sy + b.sy) / 2 + (dx / d) * s;
  return CP;
}
function curve(ctx, a, b) {
  const c = bend(a, b);
  ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.quadraticCurveTo(c.x, c.y, b.sx, b.sy); ctx.stroke();
}
// a curve with a gradient from source colour to target colour, drawn in the edge's own frame
function gradCurve(ctx, a, b, ca, cb, width, done) {
  const dx = b.sx - a.sx, dy = b.sy - a.sy, d = Math.hypot(dx, dy);
  if (d < 2) return;
  const s = bendSide(a, b) * Math.min(d * BEND, BEND_MAX) / d;
  const p = I.dpr;
  ctx.setTransform(p * dx, p * dy, -p * dy, p * dx, p * a.sx, p * a.sy);
  ctx.strokeStyle = cache(done ? 'eD' : 'eL', ca || COL.dim, cb || COL.dim, done ? EDGE_DONE : EDGE_LIVE);
  ctx.lineWidth = width / d;
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(0.5, s, 1, 0); ctx.stroke();
  screen(ctx);
}

// repo territories: a faint soft blob behind each repo's cluster, eased in world units as it moves
function drawTerritories(ctx, k, ks, ox, oy) {
  const kT = 1 - Math.exp(-(I.dt || 16) / 320);
  const terr = I.terr || (I.terr = new Map());
  for (const n of I.nodes) {
    if (n.kind !== 'repo') continue;
    let x0 = n.p.x, x1 = n.p.x, y0 = n.p.y, y1 = n.p.y;
    for (const m of n.members) {
      if (!m.p) continue;
      if (m.p.x < x0) x0 = m.p.x; else if (m.p.x > x1) x1 = m.p.x;
      if (m.p.y < y0) y0 = m.p.y; else if (m.p.y > y1) y1 = m.p.y;
    }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    let r = 0;
    for (const m of n.members) if (m.p) r = Math.max(r, Math.hypot(m.p.x - cx, m.p.y - cy));
    r = Math.max(r, Math.hypot(n.p.x - cx, n.p.y - cy));
    let t = terr.get(n.id);
    if (!t) terr.set(n.id, (t = { x: cx, y: cy, r }));
    else { t.x += (cx - t.x) * kT; t.y += (cy - t.y) * kT; t.r += (r - t.r) * kT; }
    // room for the agents' orbit and the names underneath
    const R = t.r * k + Math.max(32 * k, 22 * ks) + 30 * ks;
    n.tx = t.x * k + ox; n.ty = t.y * k + oy; n.tR = R;
    if (n.tx + R < 0 || n.tx - R > I.W || n.ty + R < 0 || n.ty - R > I.H) continue;
    unit(ctx, n.tx, n.ty, R);
    ctx.fillStyle = cache('terr', n.color, '', buildTerr);
    ctx.beginPath(); ctx.arc(0, 0, 1, 0, TAU); ctx.fill();
    screen(ctx);
  }
}

function draw() {
  const ctx = I.ctx, W = I.W, H = I.H;
  if (!W || !H || !I.cam) return;
  screen(ctx);
  // glass (the desktop window): the canvas stays see-through so the window's acrylic shows behind the map
  if (document.documentElement.classList.contains('glass')) ctx.clearRect(0, 0, W, H);
  else { ctx.fillStyle = I.bgFill || COL.bg; ctx.fillRect(0, 0, W, H); }
  const k = K(), ks = clamp(Math.sqrt(k), 0.8, 1.35);
  const nowC = Date.now() - I.skew;
  const selNode = I.sel ? I.byId.get(I.sel) : null;
  const hovNode = I.hover ? I.byId.get(I.hover) : null;
  const focusSid = (hovNode && hovNode.sid) || (selNode && selNode.sid) || null;

  // screen positions, plus a slow drift that is purely a draw offset (the layout never sees it)
  const ox = I.W / 2 - (I.cam.cx + I.pan.x) * k, oy = I.H / 2 - (I.cam.cy + I.pan.y) * k;
  const amp = I.still ? 0 : DRIFT_PX * ks, tm = I.time;
  for (const n of I.sim) {
    let x = n.p.x * k + ox, y = n.p.y * k + oy;
    const d = n.dr;
    if (amp && d) {
      x += amp * (0.7 * Math.sin(tm * d[0] + d[1]) + 0.3 * Math.sin(tm * d[2] + d[3]));
      y += amp * (0.7 * Math.sin(tm * d[4] + d[5]) + 0.3 * Math.sin(tm * d[6] + d[7]));
    }
    n.sx = x; n.sy = y;
  }
  const nowP = performance.now();
  I.nowP = nowP;
  for (const n of I.nodes) {
    if (n.kind === 'session') { const L = lookOf(n, nowP); n.R = L.rb * ks; n.RG = n.R + (n.fin ? 2.5 : 4.5) * ks; n.bs = bumpScale(n.id, nowP) * L.grow; }
    else if (n.kind === 'repo') {
      const H = hubOf(n, nowP);
      n.R = HUB_R * ks * (0.84 + 0.16 * H.pres + 0.04 * Math.min(H.act, 3)) * H.grow;
      n.RG = n.R * (HUB_TICKS + (SAT_RING + 0.2 - HUB_TICKS) * H.pres) + 1.5 * ks; n.bs = bumpScale(n.id, nowP);
      // worktree satellites ride an outer ring: its name goes outside them (RO), its hit area stays the hub (RG)
      n.RO = n.wtsLive && n.wtsLive.length ? Math.max(n.RG, n.R * WT_RING + 3.6 * ks) : n.RG;
    }
    else if (n.kind === 'pr') n.R = 6.5 * ks;
    else if (n.kind === 'clash') n.R = 4.6 * ks;
    else if (n.kind === 'conflict') { n.R = 6.8 * ks; n.RG = undefined; }
    else if (n.kind === 'recent') n.R = 2.6 * ks;
  }
  // agents: on slots around their conversation, eased by angle so a new agent slides in
  // running agents also orbit slowly (their offset only advances while they run, so done ones stay put)
  let orbitMoving = false;
  const orbStep = I.still ? 0 : (TAU * (I.dt || 16)) / ORBIT_TURN_MS;
  for (const n of I.nodes) {
    if (n.kind !== 'agent') continue;
    const sn = I.byId.get(n.parent);
    let off = I.orb.get(n.id) || 0;
    if (orbStep && n.a.state === 'run') { off = (off + orbStep) % TAU; I.orb.set(n.id, off); }
    const target = -Math.PI / 2 + (n.idx / n.count) * Math.PI * 2 + (n.count > 1 ? 0 : Math.PI / 4) + off;
    let a = I.ang.get(n.id);
    if (a === undefined) a = target;
    let d = target - a; d = Math.atan2(Math.sin(d), Math.cos(d));
    if (Math.abs(d) > 0.002) { a += d * 0.15; orbitMoving = true; } else a = target;
    I.ang.set(n.id, a);
    const ro = Math.max(32 * k, sn.RG + 10 * ks) + (n.count > 10 ? 4 * ks : 0);
    n.sx = sn.sx + Math.cos(a) * ro; n.sy = sn.sy + Math.sin(a) * ro; n.R = 3.6 * ks; n.ang = a;
    const lv0 = I.agl.get(n.id);
    n.lv = glide(lv0 === undefined ? (n.a.state === 'run' ? 1 : 0) : lv0, n.a.state === 'run' ? 1 : 0, 600);
    I.agl.set(n.id, n.lv);
  }
  if (orbitMoving) I.dirty = true;
  I.k = k;

  const byId = I.byId;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  // hit areas of the things that aren't nodes, rebuilt every frame
  I.linkHits = []; I.wtHits = []; I.parGhosts = []; I.virt.clear();

  drawTerritories(ctx, k, ks, ox, oy);

  // auras: a soft glow in the conversation's colour whose SIZE follows its last 20 minutes of tool calls
  // (eased over ~2 s); its alpha is fixed, so nothing gets brighter when something happens
  // A finished conversation's aura shrinks away instead of vanishing.
  const auraK = I.still ? 1 : 1 - Math.exp(-(I.dt || 16) / 600);
  for (const n of I.nodes) {
    if (n.kind !== 'session' || n.s.pending) continue;
    const want = n.s.state === 'DONE' ? 0 : AURA_MIN + ((AURA_MAX - AURA_MIN) * Math.min(n.s.calls20 || 0, AURA_CALLS)) / AURA_CALLS;
    let r0 = I.aura.get(n.id);
    r0 = r0 === undefined ? want : r0 + (want - r0) * auraK;
    I.aura.set(n.id, r0);
    if (r0 < 0.6) { n.aura = 0; continue; }
    const R = Math.max(r0 * ks, (n.RG + 3 * ks) * Math.min(1, r0 / AURA_MIN));
    n.aura = R;
    if (n.sx + R < 0 || n.sx - R > W || n.sy + R < 0 || n.sy - R > H) continue;
    const hue = I.lens === 'state' || n.s.state === 'DONE' ? n.s.hue || COL.cyan : lensColor(I.lens, n.s);
    unit(ctx, n.sx, n.sy, R);
    ctx.fillStyle = cache('aura', hue, '', buildAura);
    ctx.beginPath(); ctx.arc(0, 0, 1, 0, TAU); ctx.fill();
    screen(ctx);
    // working: a ring of small dots that slowly turns (constant alpha); going idle it slows to a stop while the
    // dots shrink and draw in toward the orb, and starting work they grow back out as it picks up speed
    const L = I.look.get(n.id), b = L ? L.busy : 0;
    if (b > 0.02) {
      const rr = Math.max(R * 0.8, n.RG + 4 * ks) * (0.8 + 0.2 * b), dr = 1.2 * ks * b;
      ctx.fillStyle = rgba(hue, 0.5);
      ctx.beginPath();
      for (let i = 0; i < RING_DOTS; i++) {
        const a = L.ringA + (i / RING_DOTS) * TAU;
        const x = n.sx + Math.cos(a) * rr, y = n.sy + Math.sin(a) * rr;
        ctx.moveTo(x + dr, y); ctx.arc(x, y, dr, 0, TAU);
      }
      ctx.fill();
    }
  }

  // links: conversation -> repo (a gradient from its colour to the repo's), -> PR, -> agents
  for (const e of I.springs) {
    const a = byId.get(e.a), b = byId.get(e.b);
    if (!a || !b) continue;
    if (b.kind === 'repo') {
      const L = I.look.get(a.id), lv = L ? L.live : a.s.state === 'DONE' ? 0 : 1;
      if (lv > 0.01 && lv < 0.99) { ctx.globalAlpha = (0.1 + 0.2 * lv) / 0.3; gradCurve(ctx, a, b, a.s.hue, b.color, 1.1, false); ctx.globalAlpha = 1; }
      else gradCurve(ctx, a, b, a.s.hue, b.color, 1.1, lv <= 0.01);
    }
    else if (b.kind === 'pr') {
      ctx.strokeStyle = rgba(shipColor(b.ship), 0.32); ctx.lineWidth = 0.9;
      curve(ctx, a, b);
    }
  }
  for (const n of I.nodes) {
    if (n.kind !== 'agent') continue;
    const sn = byId.get(n.parent);
    ctx.strokeStyle = rgba(n.a.state === 'fail' ? COL.red : n.s.hue, 0.14 + 0.18 * n.lv); ctx.lineWidth = 0.9;
    const ux = Math.cos(n.ang), uy = Math.sin(n.ang);
    line(ctx, sn.sx + ux * (sn.RG + 2), sn.sy + uy * (sn.RG + 2), n.sx - ux * n.R, n.sy - uy * n.R);
  }

  // recent-work paths: steady fade from 0.9 to 0.08 over ten minutes, from timestamps every frame;
  // while the conversation works, the dashes flow from it toward the file (opacity unchanged)
  const fileAlpha = I.fileAlpha || (I.fileAlpha = new Map());
  fileAlpha.clear();
  const flow = I.still ? 0 : (I.time / 1000) * FLOW_PX_S;
  for (const p of I.paths) {
    const a = byId.get(p.a), b = byId.get(p.b);
    if (!a || !b) continue;
    const age = clamp((nowC - p.t) / FADE_MS, 0, 1);
    const op = 0.9 - 0.82 * age;
    const dim = focusSid && a.sid !== focusSid ? 0.45 : 1;
    ctx.strokeStyle = rgba(p.hue, op * 0.6 * dim); ctx.lineWidth = p.wrote ? 1.1 : 0.9;
    if (flow && BUSY.has(a.s.state)) { ctx.setLineDash(p.wrote ? DASH_WROTE_FLOW : DASH_READ); ctx.lineDashOffset = -flow; }
    else { ctx.setLineDash(p.wrote ? DASH_NONE : DASH_READ); ctx.lineDashOffset = 0; }
    curve(ctx, a, b);
    fileAlpha.set(b.id, Math.max(fileAlpha.get(b.id) || 0, op));
  }
  ctx.setLineDash(DASH_NONE); ctx.lineDashOffset = 0;

  // command center links: handoff trails, parity pairs, teams, conflicts' lines to their conversations
  drawTrails(ctx, ks);
  drawParity(ctx, ks);
  drawTeams(ctx, ks);
  for (const e of I.springs) {
    if (!e.conflict) continue;
    const a = byId.get(e.a), b = byId.get(e.b);
    if (!a || !b || a.sx === undefined || b.sx === undefined) continue;
    ctx.strokeStyle = rgba(conflictColor(b.k), CONFLICT_LINE_ALPHA); ctx.lineWidth = 1.1; ctx.setLineDash(DASH_LINK);
    curve(ctx, a, b);
    ctx.setLineDash(DASH_NONE);
  }

  // clash lines: dashed between every pair of conversations sharing a file; red when 2+ edited it
  const pairCount = I.pairCount || (I.pairCount = new Map());
  pairCount.clear();
  const clashLabels = [];
  for (const c of I.clashes) {
    const color = c.writers >= 2 ? COL.red : COL.gold;
    const lab = { c, color, mids: [] };
    clashLabels.push(lab);
    for (let i = 0; i < c.sessions.length; i++) {
      for (let j = i + 1; j < c.sessions.length; j++) {
        const a = byId.get('s:' + c.sessions[i].id), b = byId.get('s:' + c.sessions[j].id);
        if (!a || !b) continue;
        const key = a.id < b.id ? a.id + '|' + b.id : b.id + '|' + a.id;
        const nth = pairCount.get(key) || 0;
        pairCount.set(key, nth + 1);
        const off = nth === 0 ? 0 : (nth % 2 ? 1 : -1) * Math.ceil(nth / 2) * 16;
        const dx = b.sx - a.sx, dy = b.sy - a.sy, d = Math.hypot(dx, dy) || 1;
        const px = -dy / d, py = dx / d;
        const base = bend(a, b);
        const cx = base.x + px * off * 2, cy = base.y + py * off * 2;
        ctx.strokeStyle = rgba(color, 0.62); ctx.lineWidth = 1.3; ctx.setLineDash(DASH_CLASH);
        ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.quadraticCurveTo(cx, cy, b.sx, b.sy); ctx.stroke();
        ctx.setLineDash(DASH_NONE);
        lab.mids.push({ ax: a.sx, ay: a.sy, bx: b.sx, by: b.sy, cx, cy });
      }
    }
  }

  drawComets(ctx, ks, false);

  // nodes
  for (const n of I.nodes) {
    if (n.kind === 'recent') {
      const op = Math.max(0.14, fileAlpha.get(n.id) || 0.08);
      if (n.f.wrote) { ctx.fillStyle = rgba(n.s.hue, op); circle(ctx, n.sx, n.sy, n.R); ctx.fill(); }
      else { ctx.strokeStyle = rgba(COL.dim, op); ctx.lineWidth = 1.1; circle(ctx, n.sx, n.sy, n.R * 0.85); ctx.stroke(); }
    }
  }
  for (const n of I.nodes) {
    if (n.kind === 'clash') {
      const color = n.c.writers >= 2 ? COL.red : COL.gold;
      ctx.fillStyle = HOLE; circle(ctx, n.sx, n.sy, n.R + 1.4); ctx.fill();
      orb(ctx, n.sx, n.sy, n.R, color);
    } else if (n.kind === 'repo') {
      drawHub(ctx, n);
      drawDeploy(ctx, n, ks);
      if (I.drag && I.drag.drop === n.id) {
        // where a dragged conversation will move to
        ctx.save(); ctx.setLineDash([5, 4]); ctx.strokeStyle = rgba(n.color || COL.dim, 0.9); ctx.lineWidth = 2;
        circle(ctx, n.sx, n.sy, n.R * 2.2 + 10); ctx.stroke(); ctx.restore();
      }
    } else if (n.kind === 'pr') {
      drawPr(ctx, n, ks);
    } else if (n.kind === 'conflict') {
      drawConflict(ctx, n, ks);
    } else if (n.kind === 'agent') {
      if (n.a.state === 'fail') {
        ctx.strokeStyle = COL.red; ctx.lineWidth = 1.8; cross(ctx, n.sx, n.sy, n.R * 0.8);
      } else {
        // a finished agent settles: smaller and dimmer over 600 ms
        ctx.globalAlpha = 0.42 + 0.58 * n.lv; orb(ctx, n.sx, n.sy, n.R * (0.85 + 0.15 * n.lv), n.s.hue); ctx.globalAlpha = 1;
      }
    }
  }
  for (const n of I.nodes) if (n.kind === 'session') drawSession(ctx, n, ks, n.id === I.sel, n.id === I.hover);
  drawParityGhosts(ctx, k, ks);
  drawGhosts(ctx, ks);
  // comets into a repo ride over its hub and fade out inside the core
  drawComets(ctx, ks, true);
  // selection / hover ring for non-conversation nodes
  for (const id of [I.hover, I.sel]) {
    const n = id && byId.get(id);
    if (!n || n.kind === 'session') continue;
    ctx.strokeStyle = id === I.sel ? COL.cyan : rgba(COL.dim, 0.7); ctx.lineWidth = id === I.sel ? 1.6 : 1;
    circle(ctx, n.sx, n.sy, (n.kind === 'repo' ? n.RG : n.R) + 4 * ks); ctx.stroke();
  }

  drawLabels(ctx, k, ks, clashLabels, selNode, hovNode, fileAlpha);
  // the rubber band (Shift+drag): a thin dashed rectangle at a fixed alpha
  if (I.band) {
    const b = I.band, x = Math.min(b.x0, b.x1), y = Math.min(b.y0, b.y1), w = Math.abs(b.x1 - b.x0), h = Math.abs(b.y1 - b.y0);
    ctx.fillStyle = rgba(COL.cyan, 0.06); ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = rgba(COL.cyan, 0.8); ctx.lineWidth = 1; ctx.setLineDash(DASH_BAND);
    ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h));
    ctx.setLineDash(DASH_NONE);
  }
  if (I.tip.style.display !== 'none' || hovNode || I.hoverX || (I.kbTip && selNode)) updateTip();
}

// a PR: a small dark ring in its ship colour with a pull-request glyph inside; hollow while new work
// since the PR hasn't reached it (fresh)
function drawPr(ctx, n, ks) {
  const c = shipColor(n.ship), r = n.R;
  ctx.fillStyle = HOLE; circle(ctx, n.sx, n.sy, r); ctx.fill();
  if (!n.ship.fresh) { ctx.fillStyle = rgba(c, 0.2); circle(ctx, n.sx, n.sy, r); ctx.fill(); }
  ctx.strokeStyle = c; ctx.lineWidth = 1.4;
  if (n.ship.fresh) ctx.setLineDash(DASH_FRESH);
  circle(ctx, n.sx, n.sy, r - 0.7); ctx.stroke();
  ctx.setLineDash(DASH_NONE);
  if (r < 4.5) return;
  // glyph (a pull request): the base branch on the left, the PR's branch on the right curving into it
  // with an arrow head
  unit(ctx, n.sx, n.sy, r);
  ctx.strokeStyle = c; ctx.fillStyle = c; ctx.lineWidth = 1.2 / r;
  ctx.beginPath();
  ctx.moveTo(-0.3, -0.3); ctx.lineTo(-0.3, 0.3);
  ctx.moveTo(0.3, 0.26); ctx.lineTo(0.3, -0.12); ctx.quadraticCurveTo(0.3, -0.36, 0.04, -0.36);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(-0.1, -0.36); ctx.lineTo(0.1, -0.52); ctx.lineTo(0.1, -0.2); ctx.closePath();
  ctx.moveTo(-0.15, -0.42); ctx.arc(-0.3, -0.42, 0.15, 0, TAU);
  ctx.moveTo(-0.15, 0.42); ctx.arc(-0.3, 0.42, 0.15, 0, TAU);
  ctx.moveTo(0.45, 0.42); ctx.arc(0.3, 0.42, 0.15, 0, TAU);
  ctx.fill();
  screen(ctx);
  // shipping to the phones (the 'app' step): a small phone badge at the top right, in that step's colour
  const app = n.ship.steps.find(([nm]) => nm === 'app');
  if (app) {
    const pc = (STEP_LOOK[app[1]] || STEP_LOOK.none)[1], w = 4.2 * ks, h = 6.6 * ks, x = n.sx + r * 0.62, y = n.sy - r * 0.62 - h * 0.6;
    ctx.fillStyle = HOLE; roundRect(ctx, x - 1, y - 1, w + 2, h + 2, 2); ctx.fill();
    ctx.strokeStyle = pc; ctx.lineWidth = 1.1; roundRect(ctx, x, y, w, h, 1.3); ctx.stroke();
    ctx.fillStyle = pc; ctx.fillRect(x + w / 2 - 0.6, y + h - 1.9, 1.2, 0.9);
  }
}

// ---------- command center layers (see "Command center" at the top) ----------
// a node pair's curve (the same bend as edges and comets; flip: bent to the other side), as n + 1 points
function curvePts(a, b, n, flip) {
  const c = bend(a, b), cx = flip ? a.sx + b.sx - c.x : c.x, cy = flip ? a.sy + b.sy - c.y : c.y, pts = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n, f = 1 - u;
    pts.push([f * f * a.sx + 2 * f * u * cx + u * u * b.sx, f * f * a.sy + 2 * f * u * cy + u * u * b.sy]);
  }
  return pts;
}
// the shortest distance from a point to a polyline
function distPts(pts, x, y) {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], dx = x1 - x0, dy = y1 - y0, l2 = dx * dx + dy * dy || 1;
    const t = clamp(((x - x0) * dx + (y - y0) * dy) / l2, 0, 1);
    best = Math.min(best, Math.hypot(x - (x0 + t * dx), y - (y0 + t * dy)));
  }
  return best;
}
const onScreen = (n) => n && n.sx !== undefined && n.sy !== undefined;

// Teams: every pair of members (a ring around their middle past 4 members) tied by two strands that braid
// around the shared curve, in the team's colour at a fixed alpha. The crossings slide slowly along the link
// (motion only). The pill with the team's name sits at the link's middle (the members' middle for 3+); comets
// of a new order start there (a virtual comet end, 'T:<team id>').
function drawTeams(ctx, ks) {
  const N = 28, ph = I.still ? 0 : I.time / 2600;
  for (const tm of I.teams) {
    const ns = tm.members.map((id) => I.byId.get('s:' + id)).filter(onScreen);
    tm.pairs = []; tm.pill = null; tm.rect = null;
    if (ns.length < 2) continue;
    let mx = 0, my = 0;
    for (const n of ns) { mx += n.sx; my += n.sy; }
    mx /= ns.length; my /= ns.length;
    if (ns.length <= 4) { for (let i = 0; i < ns.length; i++) for (let j = i + 1; j < ns.length; j++) tm.pairs.push([ns[i], ns[j]]); }
    else {
      const ring = ns.slice().sort((a, b) => Math.atan2(a.sy - my, a.sx - mx) - Math.atan2(b.sy - my, b.sx - mx));
      ring.forEach((n, i) => tm.pairs.push([n, ring[(i + 1) % ring.length]]));
    }
    const col = /^#[0-9a-f]{6}$/i.test(tm.t.color || '') ? tm.t.color : COL.violet;
    ctx.strokeStyle = rgba(col, TEAM_ALPHA); ctx.lineWidth = 1.1;
    let mid = null;
    for (const [a, b] of tm.pairs) {
      const pts = curvePts(a, b, N);
      const d = Math.hypot(b.sx - a.sx, b.sy - a.sy), amp = Math.min(3.4 * ks, d * 0.05), tw = Math.max(2, Math.round(d / 60));
      for (const sg of [1, -1]) {
        ctx.beginPath();
        for (let i = 0; i <= N; i++) {
          const p0 = pts[Math.max(0, i - 1)], p1 = pts[Math.min(N, i + 1)];
          let nx = p0[1] - p1[1], ny = p1[0] - p0[0];
          const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l;
          const u = i / N, o = sg * amp * Math.sin(Math.PI * u) * Math.sin(Math.PI * tw * u - ph * TAU);
          const x = pts[i][0] + nx * o, y = pts[i][1] + ny * o;
          if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        }
        ctx.stroke();
      }
      if (!mid) mid = pts[N / 2];
      I.linkHits.push({ kind: 'team', id: tm.t.id, pts, mid: pts[N / 2] });
    }
    const pill = tm.pairs.length === 1 && mid ? mid : [mx, my];
    tm.pill = { x: pill[0], y: pill[1], color: col };
    I.virt.set('T:' + tm.t.id, { id: 'T:' + tm.t.id, kind: 'team', sx: pill[0], sy: pill[1], h: hashNum(tm.t.id), R: 0, RG: 0 });
  }
}

// Parity partners: a thin dotted line from the web side (cyan) to the app side (mint), fixed alpha. It bends to
// the other side than the pair's usual curve, which a team's braid (partners are often a team) takes.
const PAR_EDGE = buildEdge(PARITY_ALPHA);
function drawParity(ctx, ks) {
  for (const p of I.parity) {
    const a = I.byId.get(p.a), b = I.byId.get(p.b);
    if (!onScreen(a) || !onScreen(b)) continue;
    const dx = b.sx - a.sx, dy = b.sy - a.sy, d = Math.hypot(dx, dy);
    if (d < 4) continue;
    const s = -bendSide(a, b) * Math.min(d * BEND, BEND_MAX) / d, q = I.dpr;
    ctx.setTransform(q * dx, q * dy, -q * dy, q * dx, q * a.sx, q * a.sy);
    ctx.strokeStyle = cache('par', COL.cyan, COL.mint, PAR_EDGE);
    ctx.lineWidth = (1.6 * ks) / d; ctx.setLineDash([0.01 / d, (4.2 * ks) / d]);
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(0.5, s, 1, 0); ctx.stroke();
    ctx.setLineDash(DASH_NONE);
    screen(ctx);
    const pts = curvePts(a, b, 20, true);
    I.linkHits.push({ kind: 'parity', id: p.a + '|' + p.b, pts, mid: pts[10], a, b });
  }
}

// Handoff trails: a faint line from the conversation it was picked up from, with a small arrow at its end.
function drawTrails(ctx, ks) {
  for (const t of I.trails) {
    const a = I.byId.get(t.a), b = I.byId.get(t.b);
    if (!onScreen(a) || !onScreen(b)) continue;
    const pts = curvePts(a, b, 20);
    ctx.strokeStyle = rgba(COL.dim, TRAIL_ALPHA); ctx.lineWidth = 1;
    curve(ctx, a, b);
    // the arrow: just outside the target's ring, along the curve's end
    const c = bend(a, b), tx = b.sx - c.x, ty = b.sy - c.y, tl = Math.hypot(tx, ty) || 1, ux = tx / tl, uy = ty / tl;
    const back = (b.RG || b.R || 6) + 3 * ks, hx = b.sx - ux * back, hy = b.sy - uy * back, al = 5 * ks, aw = 2.8 * ks;
    ctx.fillStyle = rgba(COL.dim, TRAIL_ALPHA * 1.8);
    ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(hx - ux * al - uy * aw, hy - uy * al + ux * aw); ctx.lineTo(hx - ux * al + uy * aw, hy - uy * al - ux * aw); ctx.closePath(); ctx.fill();
    I.linkHits.push({ kind: 'handoff', id: t.a + '>' + t.b, pts, mid: pts[10], a, b });
  }
}

// A one-sided change in a parity repo: a small hollow ghost orb beside the conversation (past its agents),
// on a dashed line, for the side it didn't change. Fixed alpha.
function drawParityGhosts(ctx, k, ks) {
  for (const n of I.nodes) {
    if (n.kind !== 'session' || n.fin || n.s.pending || !n.s.parity || !n.s.parity.missing || !onScreen(n)) continue;
    const miss = n.s.parity.missing, col = miss === 'app' ? COL.mint : COL.cyan;
    const hub = I.byId.get(n.cl);
    let vx = 1, vy = 0;
    if (onScreen(hub)) { vx = n.sx - hub.sx; vy = n.sy - hub.sy; const l = Math.hypot(vx, vy) || 1; vx /= l; vy /= l; }
    // turned 40 degrees off the line from the hub, so it doesn't sit on the name underneath
    const c = Math.cos(-0.7), s = Math.sin(-0.7), dx = vx * c - vy * s, dy = vx * s + vy * c;
    const out = (n.agents.length ? Math.max(32 * k, n.RG + 10 * ks) + 3.6 * ks : n.RG) + 14 * ks, r = 5 * ks;
    const x = n.sx + dx * out, y = n.sy + dy * out;
    ctx.strokeStyle = rgba(col, 0.5); ctx.lineWidth = 1; ctx.setLineDash(DASH_GHOST);
    line(ctx, n.sx + dx * (n.RG + 2), n.sy + dy * (n.RG + 2), x - dx * (r + 1.5), y - dy * (r + 1.5));
    ctx.fillStyle = HOLE; circle(ctx, x, y, r); ctx.fill();
    ctx.fillStyle = rgba(col, 0.1); ctx.fill();
    ctx.strokeStyle = rgba(col, 0.75); ctx.lineWidth = 1.2; circle(ctx, x, y, r - 0.6); ctx.stroke();
    ctx.setLineDash(DASH_NONE);
    I.parGhosts.push({ n, x, y, r, missing: miss, col });
  }
}

// A conflict node: a ring with a branch glyph (two conversations on one branch, gold), a folder glyph (two live
// in one worktree, red), or a '#nnn' tag (two migrations with one number, red).
function drawConflict(ctx, n, ks) {
  const k = n.k, c = conflictColor(k), r = n.R;
  if (k.kind === 'migration') {
    const f = font(10, 700, MONO), t = String(k.label || '').startsWith('#') ? k.label : '#' + (k.label || '?');
    const w = measure(ctx, f, t) + 10, h = 15, x = n.sx - w / 2, y = n.sy - h / 2;
    ctx.fillStyle = HOLE; roundRect(ctx, x, y, w, h, h / 2); ctx.fill();
    ctx.fillStyle = rgba(c, 0.16); ctx.fill();
    ctx.strokeStyle = c; ctx.lineWidth = 1.3; roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, h / 2 - 0.5); ctx.stroke();
    ctx.font = f; ctx.fillStyle = c; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(t, n.sx, n.sy + 0.5);
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    n.RG = w / 2;
    return;
  }
  ctx.fillStyle = HOLE; circle(ctx, n.sx, n.sy, r); ctx.fill();
  ctx.fillStyle = rgba(c, 0.16); ctx.fill();
  ctx.strokeStyle = c; ctx.lineWidth = 1.4; circle(ctx, n.sx, n.sy, r - 0.7); ctx.stroke();
  unit(ctx, n.sx, n.sy, r);
  ctx.strokeStyle = c; ctx.fillStyle = c; ctx.lineWidth = 1.2 / r;
  ctx.beginPath();
  if (k.kind === 'branch') {
    // a branch: the trunk on the left, a branch curving off it to the right
    ctx.moveTo(-0.28, -0.42); ctx.lineTo(-0.28, 0.42);
    ctx.moveTo(0.3, -0.24); ctx.quadraticCurveTo(0.3, 0.12, -0.28, 0.2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-0.13, -0.46); ctx.arc(-0.28, -0.46, 0.15, 0, TAU);
    ctx.moveTo(-0.13, 0.46); ctx.arc(-0.28, 0.46, 0.15, 0, TAU);
    ctx.moveTo(0.45, -0.34); ctx.arc(0.3, -0.34, 0.15, 0, TAU);
    ctx.fill();
  } else {
    // a folder
    ctx.moveTo(-0.5, -0.34); ctx.lineTo(-0.16, -0.34); ctx.lineTo(-0.04, -0.2); ctx.lineTo(0.5, -0.2);
    ctx.lineTo(0.5, 0.38); ctx.lineTo(-0.5, 0.38); ctx.closePath();
    ctx.moveTo(-0.5, -0.06); ctx.lineTo(0.5, -0.06);
    ctx.stroke();
  }
  screen(ctx);
}

// worktree satellites on a hub's outer ring (fixed slots from the top, no motion), small filled rounded squares so
// they read apart from the round conversation satellites and agents; only worktrees a live conversation works in
function drawWorktrees(ctx, n, r, ks) {
  const list = n.wtsLive;
  if (!list || !list.length) return;
  const m = Math.min(list.length, WT_MAX), R = r * WT_RING, sr = 2.3 * ks, hue = n.color || COL.dim;
  for (let i = 0; i < m; i++) {
    const w = list[i], a = -Math.PI / 2 + (i - (m - 1) / 2) * (TAU / Math.max(m, 8));
    const x = n.sx + Math.cos(a) * R, y = n.sy + Math.sin(a) * R;
    ctx.fillStyle = HOLE; roundRect(ctx, x - sr - 1, y - sr - 1, 2 * sr + 2, 2 * sr + 2, 1.6); ctx.fill();
    ctx.fillStyle = hue; roundRect(ctx, x - sr, y - sr, 2 * sr, 2 * sr, 1.2); ctx.fill();
    I.wtHits.push({ w, x, y, r: sr, hub: n });
  }
}

// Comets: a head dot at constant brightness and a six-dot tail that thins toward the edge colour. They
// ride the drawn curve, so they follow drifting nodes; the tail slides into the target and is gone. When the
// head reaches its target, a repo or a conversation there gets a small bump (arrive). Comets that end at a
// repo are drawn in a second pass (late), over the hub, and fade out as they sink into its core.
function drawComets(ctx, ks, late) {
  const now = performance.now();
  if (!late) {
    const q = I.cometQ;
    while (q.length && q[0].at <= now) {
      const c = q.shift();
      if (now - c.at > 1000) continue; // queued while the map was hidden: history now
      // colours once per comet, not per frame: head, then tail dots fading toward the edge's alpha
      c.cols = [c.hue];
      for (let j = 1; j <= COMET_TAIL; j++) c.cols.push(rgba(c.hue, 0.7 - (0.55 * (j - 1)) / (COMET_TAIL - 1)));
      I.comets.push(c);
    }
    if (I.comets.length > COMET_MAX) I.comets.splice(0, I.comets.length - COMET_MAX);
    const end = 1 + COMET_TAIL * COMET_GAP;
    let keep = 0;
    for (let i = 0; i < I.comets.length; i++) {
      const c = I.comets[i];
      const u = (now - c.at) / COMET_MS;
      const a = cometNode(c.a), b = cometNode(c.b);
      if (u > end || !a || !b || a.sx === undefined || b.sx === undefined) continue;
      I.comets[keep++] = c;
      c.into = b.kind === 'repo';
      if (u >= 1 && !c.hit) { c.hit = true; arrive(b, now); }
    }
    I.comets.length = keep;
  }
  const W = I.W, H = I.H;
  for (const c of I.comets) {
    if (!!c.into !== late) continue;
    const u = (now - c.at) / COMET_MS;
    if (u < 0) continue;
    const a = cometNode(c.a), b = cometNode(c.b);
    // both ends off screen on the same side: nothing of it shows
    if ((a.sx < 0 && b.sx < 0) || (a.sx > W && b.sx > W) || (a.sy < 0 && b.sy < 0) || (a.sy > H && b.sy > H)) continue;
    const cp = bend(a, b), cx = cp.x, cy = cp.y;
    const sink = late ? b.R * 1.25 : 0; // within this distance of the hub's centre a dot fades out
    for (let j = COMET_TAIL; j >= 0; j--) {
      const v = u - j * COMET_GAP;
      if (v < 0 || (j === 0 && v > 1)) continue;
      const e = ease(v > 1 ? 1 : v), f = 1 - e;
      const x = f * f * a.sx + 2 * f * e * cx + e * e * b.sx, y = f * f * a.sy + 2 * f * e * cy + e * e * b.sy;
      if (sink) {
        const d = Math.hypot(x - b.sx, y - b.sy);
        if (d < 0.5) continue;
        ctx.globalAlpha = d < sink ? d / sink : 1;
      }
      ctx.fillStyle = c.cols[j];
      circle(ctx, x, y, (j === 0 ? 2.6 : 2 - j * 0.15) * ks);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}

// a comet's end: a node, or a team's pill ('T:<team id>', placed each frame in drawTeams)
function cometNode(id) { return I.byId.get(id) || I.virt.get(id) || null; }

// ---------- reactions: motion only ----------
// I.react: node id -> { bump: when its last scale bump started, kT: ring rotation asked for by kicks, kC: eased so far }
function arrive(n, now) {
  if (!n || (n.kind !== 'repo' && n.kind !== 'session') || I.still) return;
  const R = I.react || (I.react = new Map());
  let r = R.get(n.id);
  if (!r) R.set(n.id, (r = { bump: -Infinity, kT: 0, kC: 0, hits: 0, bumps: 0 }));
  r.hits++;
  // a burst never stacks into a jitter: one bump per BUMP_GAP; the ring's kicks add up and ease in together
  if (now - r.bump >= BUMP_GAP) { r.bump = now; r.bumps++; }
  if (n.kind === 'repo') r.kT += KICK;
}
// 1 -> 1 + BUMP_UP -> 1 over BUMP_MS: a quick rise, then an ease-out back
function bumpScale(id, now) {
  const r = I.react && I.react.get(id);
  if (!r) return 1;
  const u = (now - r.bump) / BUMP_MS;
  if (!(u >= 0 && u < 1)) return 1;
  const shape = u < 0.22 ? Math.sin((u / 0.22) * (Math.PI / 2)) : Math.pow(1 - (u - 0.22) / 0.78, 3);
  return 1 + BUMP_UP * shape;
}

// A repo hub: a faceted hexagon core with a soft gradient in the repo colour, a ring of HUB_SEGS arcs turning
// once per HUB_TURN_MS (plus any eased kicks), and three satellite ticks riding the ring's gaps. Drawn in unit
// space (the core's radius is 1), so one cached gradient serves every hub of a colour at any size.
const HEX = Array.from({ length: 6 }, (_, i) => [Math.cos(-Math.PI / 2 + (i * Math.PI) / 3), Math.sin(-Math.PI / 2 + (i * Math.PI) / 3)]);
function hexPath(ctx, s) {
  ctx.moveTo(HEX[0][0] * s, HEX[0][1] * s);
  for (let i = 1; i < 6; i++) ctx.lineTo(HEX[i][0] * s, HEX[i][1] * s);
  ctx.closePath();
}
function facets(ctx, list) {
  ctx.beginPath();
  for (const i of list) { const a = HEX[i], b = HEX[(i + 1) % 6]; ctx.moveTo(0, 0); ctx.lineTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.closePath(); }
}
const buildGem = (c, hue) => mix(hue, WHITE, 0.5);
const buildHalo = (c, hue) => {
  const g = c.createRadialGradient(0, 0, 0, 0, 0, 1);
  g.addColorStop(0, rgba(hue, HUB_HALO_ALPHA)); g.addColorStop(0.45, rgba(hue, HUB_HALO_ALPHA * 0.45)); g.addColorStop(1, rgba(hue, 0));
  return g;
};
// a repo's eased presence (1 while it has a live conversation), activity (how many work, up to 3), its ring's
// spin and orbit phase, and its satellites (one per live conversation, sid -> { lv, b, a, hue })
function hubOf(n, now) {
  let H = I.hub.get(n.id);
  const live = [];
  let busy = 0;
  for (const s of n.sessions) { if (s.state === 'DONE') continue; live.push(s); if (BUSY.has(s.state)) busy++; }
  if (!H) {
    H = { pres: live.length ? 1 : 0, act: Math.min(busy, 3), spin: hashNum(n.id) * TAU, orb: hashNum(n.id + 'o') * TAU, sats: new Map(), grow: 1,
      born: !I.still && !I.replay && I.lastDraw && now - I.lastDraw < 1500 ? now : -Infinity };
    I.hub.set(n.id, H);
  }
  H.pres = glide(H.pres, live.length ? 1 : 0, 900);
  H.act = glide(H.act, Math.min(busy, 3), 1200);
  if (!I.still) {
    const dt = I.dt || 16, a1 = Math.min(1, H.act);
    // dormant: a slow turn; working: up to twice as fast with more conversations at work
    H.spin = (H.spin + ((TAU * dt) / HUB_TURN_MS) * (0.3 + 0.7 * a1 + 0.5 * Math.max(0, H.act - 1))) % (TAU * 64);
    H.orb = (H.orb + ((TAU * dt) / SAT_TURN_MS) * (0.4 + 0.6 * a1)) % TAU;
  }
  const u = (now - H.born) / BIRTH_MS;
  H.grow = u >= 0 && u < 1 ? backOut(u) : 1;
  // satellites: live conversations on even slots (by id, so they keep their order), eased in and out
  live.sort((x, y) => (x.id < y.id ? -1 : 1));
  const m = Math.min(live.length, SAT_MAX), want = new Set();
  for (let i = 0; i < m; i++) {
    const s = live[i];
    want.add(s.id);
    let sat = H.sats.get(s.id);
    const slot = (i / m) * TAU;
    if (!sat) H.sats.set(s.id, (sat = { lv: 0, b: BUSY.has(s.state) ? 1 : 0, a: slot }));
    sat.hue = s.hue || COL.cyan; sat.slot = slot;
    sat.b = glide(sat.b, BUSY.has(s.state) ? 1 : 0, 600);
  }
  for (const [sid, sat] of H.sats) {
    sat.lv = glide(sat.lv, want.has(sid) ? 1 : 0, 550);
    if (!want.has(sid) && sat.lv < 0.02) { H.sats.delete(sid); continue; }
    if (want.has(sid)) {
      let d = sat.slot - sat.a; d = Math.atan2(Math.sin(d), Math.cos(d));
      sat.a = I.still || Math.abs(d) < 0.002 ? sat.slot : sat.a + d * (1 - Math.exp(-(I.dt || 16) / 260));
    }
  }
  return H;
}
// the repo's initial for the hub's core: its first letter or digit
const initial = (name) => { const m = String(name || '').match(/[\p{L}\p{N}]/u); return m ? m[0].toUpperCase() : ''; };

// A repo hub (see "Look" at the top). Drawn in unit space (the core's radius is 1), so one cached gradient
// serves every hub of a colour at any size. An arriving comet's eased kicks add to the ring's spin.
function drawHub(ctx, n) {
  const hue = n.color || COL.dim, r = n.R * (n.bs || 1);
  const H = I.hub.get(n.id) || { pres: 0, act: 0, spin: 0, orb: 0, sats: new Map() };
  const rr = I.react && I.react.get(n.id);
  if (rr && rr.kC !== rr.kT) {
    rr.kC += (rr.kT - rr.kC) * (1 - Math.exp(-(I.dt || 16) / KICK_EASE_MS));
    if (Math.abs(rr.kT - rr.kC) < 1e-3) rr.kC = rr.kT;
    if (rr.kC > TAU * 64) { rr.kC -= TAU * 64; rr.kT -= TAU * 64; }
  }
  const spin = H.spin + (rr ? rr.kC : 0), pres = H.pres, act = Math.min(1, H.act);
  n.spin = spin; n.da = ctx.globalAlpha;
  // the halo: a soft glow whose SIZE grows with presence and work (its alpha is fixed)
  const hr = r * (1.7 + 1.5 * pres + 0.5 * (Math.min(H.act, 3) / 3));
  unit(ctx, n.sx, n.sy, hr);
  ctx.fillStyle = cache('hubHalo', hue, '', buildHalo);
  ctx.beginPath(); ctx.arc(0, 0, 1, 0, TAU); ctx.fill();
  unit(ctx, n.sx, n.sy, r);
  // the ring of arcs (longer and thicker while live), and ticks in every other gap
  const seg = TAU / HUB_SEGS, span = seg * (0.3 + 0.36 * pres);
  ctx.strokeStyle = rgba(hue, 0.66); ctx.lineWidth = (1.1 + 0.6 * pres) / r;
  ctx.beginPath();
  for (let i = 0; i < HUB_SEGS; i++) {
    const a0 = spin + i * seg;
    ctx.moveTo(Math.cos(a0) * HUB_RING, Math.sin(a0) * HUB_RING); ctx.arc(0, 0, HUB_RING, a0, a0 + span);
  }
  ctx.stroke();
  const tick = HUB_RING + 0.12 + (HUB_TICKS - HUB_RING - 0.12) * (0.45 + 0.55 * pres);
  ctx.strokeStyle = rgba(hue, 0.5); ctx.lineWidth = 1.2 / r;
  ctx.beginPath();
  for (let i = 0; i < HUB_SEGS; i += 2) {
    const a = spin + i * seg + span + (seg - span) / 2, ca = Math.cos(a), sa = Math.sin(a);
    ctx.moveTo(ca * (HUB_RING + 0.12), sa * (HUB_RING + 0.12)); ctx.lineTo(ca * tick, sa * tick);
  }
  ctx.stroke();
  // at work: a fine inner ring of dashes turning the other way, its dashes growing out of nothing
  if (act > 0.02) {
    const ir = 1.24, dl = 0.2 * act;
    ctx.strokeStyle = rgba(hue, 0.55); ctx.lineWidth = 1 / r;
    ctx.beginPath();
    for (let i = 0; i < 12; i++) {
      const a0 = -spin * 1.6 + (i * TAU) / 12;
      ctx.moveTo(Math.cos(a0) * ir, Math.sin(a0) * ir); ctx.arc(0, 0, ir, a0, a0 + dl);
    }
    ctx.stroke();
  }
  // the satellites' faint track
  if (pres > 0.02 && H.sats.size) {
    ctx.strokeStyle = rgba(hue, 0.14); ctx.lineWidth = (0.9 * pres) / r;
    ctx.beginPath(); ctx.arc(0, 0, SAT_RING, 0, TAU); ctx.stroke();
  }
  // the core: a gradient hexagon, lit facets top left, shaded facets bottom right
  ctx.fillStyle = cache('hub', hue, '', buildDiamond);
  ctx.beginPath(); hexPath(ctx, 1); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.12)'; facets(ctx, [4, 5]); ctx.fill();
  ctx.fillStyle = 'rgba(5,7,13,0.22)'; facets(ctx, [1, 2]); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.24)'; ctx.lineWidth = 1 / r;
  ctx.beginPath(); hexPath(ctx, 1 - 0.5 / r); ctx.stroke();
  screen(ctx);
  // the repo's initial on the core when there's room for it, else a small light gem
  const ch = r >= 6.5 ? initial(n.name) : '';
  if (ch) {
    ctx.font = font(Math.round(r * 1.05), 700, DISPLAY); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 2.2; ctx.strokeStyle = 'rgba(5,7,13,0.5)'; ctx.strokeText(ch, n.sx, n.sy + r * 0.06);
    ctx.fillStyle = 'rgba(255,255,255,0.96)'; ctx.fillText(ch, n.sx, n.sy + r * 0.06);
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  } else {
    unit(ctx, n.sx, n.sy, r);
    ctx.fillStyle = cache('hubGem', hue, '', buildGem);
    ctx.beginPath(); hexPath(ctx, 0.34); ctx.fill();
    screen(ctx);
  }
  // satellites: one per live conversation in its colour, larger while it works, growing in and shrinking out
  const ks = clamp(Math.sqrt(I.k || 1), 0.8, 1.35);
  for (const sat of H.sats.values()) {
    const sr = ks * (1.8 + 0.9 * sat.b) * sat.lv;
    if (sr < 0.3) continue;
    const a = H.orb + sat.a, R = r * SAT_RING;
    ctx.fillStyle = HOLE; circle(ctx, n.sx + Math.cos(a) * R, n.sy + Math.sin(a) * R, sr + 1); ctx.fill();
    ctx.fillStyle = sat.hue; circle(ctx, n.sx + Math.cos(a) * R, n.sy + Math.sin(a) * R, sr); ctx.fill();
  }
  drawWorktrees(ctx, n, r, ks);
}

// A repo's production deploy (Vercel) on its hub: a small triangle badge at its upper right, gold while a
// build runs, mint when Vercel is clean (nothing building, the last deploy live), red when the last one failed.
// Building also sweeps a gold arc round the hub on a faint track, one turn per DEPLOY_TURN_MS (motion only; with
// reduced motion the arc stands still); failed draws a thin red ring. Repos that don't deploy get nothing.
const DEPLOY_TURN_MS = 1500;
function drawDeploy(ctx, n, ks) {
  const dp = I.deploy && I.deploy.get(n.id);
  if (!dp) return;
  screen(ctx);
  const c = dp.state === 'building' ? COL.gold : dp.state === 'failed' ? COL.red : COL.mint;
  const ro = (n.RO || n.RG || n.R) * (n.bs || 1) + 3.5 * ks;
  if (dp.state === 'building') {
    ctx.lineWidth = 2 * ks;
    ctx.strokeStyle = rgba(COL.gold, 0.16); circle(ctx, n.sx, n.sy, ro); ctx.stroke();
    const a = (I.time / DEPLOY_TURN_MS) * TAU;
    ctx.strokeStyle = COL.gold; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(n.sx, n.sy, ro, a, a + TAU * 0.28); ctx.stroke();
    ctx.lineCap = 'butt';
  } else if (dp.state === 'failed') {
    ctx.lineWidth = 1.4 * ks; ctx.strokeStyle = rgba(COL.red, 0.55); circle(ctx, n.sx, n.sy, ro); ctx.stroke();
  }
  const ba = -Math.PI / 4, bx = n.sx + Math.cos(ba) * ro, by = n.sy + Math.sin(ba) * ro, br = 5.4 * ks;
  ctx.fillStyle = HOLE; circle(ctx, bx, by, br + 1.6); ctx.fill();
  ctx.lineWidth = 1; ctx.strokeStyle = rgba(c, 0.55); circle(ctx, bx, by, br + 1.6); ctx.stroke();
  const t = br * 0.66;
  ctx.fillStyle = c; ctx.beginPath();
  ctx.moveTo(bx, by - t); ctx.lineTo(bx + t * 1.05, by + t * 0.68); ctx.lineTo(bx - t * 1.05, by + t * 0.68); ctx.closePath(); ctx.fill();
}

// conversations that just left the map: drawn where they were, shrinking as their opacity falls to 0 over
// GHOST_MS (a fade by age, nothing brightens). Their world position is kept, so they follow a pan or zoom.
function drawGhosts(ctx, ks) {
  if (!I.ghosts.length) return;
  const now = performance.now(), k = K();
  const ox = I.W / 2 - (I.cam.cx + I.pan.x) * k, oy = I.H / 2 - (I.cam.cy + I.pan.y) * k;
  I.ghosts = I.ghosts.filter((g) => now - g.at < (g.to ? HANDOFF_GHOST_MS : GHOST_MS));
  for (const g of I.ghosts) {
    const n = g.n;
    if (n.p) { n.sx = n.p.x * k + ox; n.sy = n.p.y * k + oy; }
    const tgt = g.to && I.byId.get(g.to);
    if (tgt && tgt.sx !== undefined) { handoffGhost(ctx, g, n, tgt, now, ks); continue; }
    const u = clamp((now - g.at) / GHOST_MS, 0, 1);
    n.R = n.fin ? FIN_R * ks : sessionRadius(n.s, ks); n.RG = n.R + (n.fin ? 2.5 : 4.5) * ks; n.bs = 1 - 0.45 * ease(u);
    ctx.globalAlpha = 1 - ease(u);
    drawSession(ctx, n, ks, false, false);
    ctx.globalAlpha = 1;
  }
}

// a handed-off conversation on its way into its pickup: it lifts off its spot, curves over to the new node
// (shrinking, a fading violet trail behind it) and sinks into it, which takes a brief violet halo
function handoffGhost(ctx, g, n, tgt, now, ks) {
  const u = clamp((now - g.at) / HANDOFF_GHOST_MS, 0, 1), m = ease(u);
  const x0 = n.sx, y0 = n.sy, x1 = tgt.sx, y1 = tgt.sy;
  // a gentle arc: the control point sits off the straight line by a fifth of its length
  const dx = x1 - x0, dy = y1 - y0, cx = (x0 + x1) / 2 - dy * 0.2, cy = (y0 + y1) / 2 + dx * 0.2;
  const at = (t) => [(1 - t) * (1 - t) * x0 + 2 * (1 - t) * t * cx + t * t * x1, (1 - t) * (1 - t) * y0 + 2 * (1 - t) * t * cy + t * t * y1];
  const ga = ctx.globalAlpha;
  // trail: a few dots behind the head, fainter toward the start
  for (let i = 1; i <= 6; i++) {
    const t = m - i * 0.045;
    if (t <= 0) break;
    const [tx, ty] = at(t);
    ctx.globalAlpha = ga * (1 - u) * (0.5 - i * 0.07);
    ctx.fillStyle = COL.violet; circle(ctx, tx, ty, (3.2 - i * 0.35) * ks); ctx.fill();
  }
  const [hx, hy] = at(m);
  n.R = n.fin ? FIN_R * ks : sessionRadius(n.s, ks); n.RG = n.R + 4.5 * ks; n.bs = 1 - 0.7 * m;
  const sx = n.sx, sy = n.sy;
  n.sx = hx; n.sy = hy;
  ctx.globalAlpha = ga * (1 - m * m);
  drawSession(ctx, n, ks, false, false);
  n.sx = sx; n.sy = sy;
  // the pickup's halo as the old one arrives
  if (u > 0.55) {
    const v = (u - 0.55) / 0.45;
    ctx.globalAlpha = ga * 0.55 * (1 - v);
    ctx.strokeStyle = COL.violet; ctx.lineWidth = 2 * ks;
    circle(ctx, x1, y1, (tgt.R || 10 * ks) + (4 + 14 * ease(v)) * ks); ctx.stroke();
  }
  ctx.globalAlpha = ga;
}

function line(ctx, x0, y0, x1, y1) { ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); }
function circle(ctx, x, y, r) { ctx.beginPath(); ctx.arc(x, y, Math.max(0.5, r), 0, Math.PI * 2); }
function cross(ctx, x, y, r) { ctx.beginPath(); ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r); ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r); ctx.stroke(); }

// A conversation's look key: what drawLook draws for it. WORKING and AGENTS look the same.
// In a lens other than 'state' a live conversation is an orb in the lens's colour ('L:<lens>').
const lookKey = (s) => (s.handing ? 'HANDOFF' : s.pending ? 'NEW' : I && I.lens !== 'state' && s.state !== 'DONE' ? 'L:' + I.lens
  : BUSY.has(s.state) ? 'BUSY' : s.state === 'QUESTION' ? 'ASKING' : s.state);
// the cost lens: the orb's size follows its cost ($0 .. $50, log scale)
const costRadius = (s) => 6 + 9 * costT(s.cost);
const gaugeOn = (s) => !s.pending && !s.handing && s.state !== 'DONE' && ctxPct(s) !== null;
// exponential easing toward want with time constant tau (ms); reduced motion snaps
function glide(cur, want, tau) {
  if (I.still || cur === undefined) return want;
  const v = cur + (want - cur) * (1 - Math.exp(-(I.dt || 16) / tau));
  return Math.abs(want - v) < 1e-3 ? want : v;
}
// A conversation's look and its eased levels, updated once per frame:
//   key, prev, at  the look it shows, the one it morphs from and when that started (MORPH_MS)
//   rb             radius at ks 1, gliding to the state's size
//   busy           1 while it works: the ring of dots' size, and its speed (ringA advances by it)
//   live           1 until it's done: its link to the repo
//   g, frac        the memory gauge's thickness and its filled fraction
//   grow           its birth scale (BIRTH_MS, with a slight overshoot); 1 once grown
function lookOf(n, now) {
  const s = n.s, key = lookKey(s);
  const size = n.fin ? FIN_R : I.lens === 'cost' && !s.pending && s.state !== 'DONE' ? costRadius(s) : sessionRadius(s, 1);
  const frac = s.context && s.context.limit ? clamp(s.context.used / s.context.limit, 0, 1) : 0;
  let L = I.look.get(n.id);
  if (!L) {
    L = { key, prev: null, at: -Infinity, rb: size, busy: key === 'BUSY' ? 1 : 0, live: s.state === 'DONE' ? 0 : 1,
      g: gaugeOn(s) ? 1 : 0, frac, ringA: hashNum(n.id) * TAU, grow: 1,
      born: !I.still && !I.replay && I.lastDraw && now - I.lastDraw < 1500 ? now : -Infinity };
    I.look.set(n.id, L);
  } else if (L.key !== key) {
    // flipping back mid-morph reverses it from where it is, instead of starting over
    const u = (now - L.at) / MORPH_MS;
    if (L.prev === key && u < 1) { L.prev = L.key; L.at = now - (1 - u) * MORPH_MS; }
    else { L.prev = L.key; L.at = I.still ? -Infinity : now; }
    L.key = key;
  }
  L.rb = glide(L.rb, size, 420);
  L.busy = glide(L.busy, key === 'BUSY' ? 1 : 0, 650);
  L.live = glide(L.live, s.state === 'DONE' ? 0 : 1, 700);
  L.g = glide(L.g, gaugeOn(s) ? 1 : 0, 500);
  L.frac = glide(L.frac, frac, 600);
  if (!I.still) L.ringA = (L.ringA + ((TAU * (I.dt || 16)) / RING_TURN_MS) * L.busy) % TAU;
  const u = (now - L.born) / BIRTH_MS;
  L.grow = u >= 0 && u < 1 ? backOut(u) : 1;
  return L;
}

// one look, at (x, y) with radius R
function drawLook(ctx, key, s, x, y, R, ks) {
  if (key.startsWith('L:')) { orb(ctx, x, y, R, lensColor(key.slice(2), s)); return; }
  switch (key) {
    case 'NEW': {
      // a new session, no message yet: hollow, with a steady dashed ring in its account's colour
      const c = accColor(s.account);
      ctx.fillStyle = HOLE; circle(ctx, x, y, R); ctx.fill();
      ctx.fillStyle = rgba(c, 0.12); ctx.fill();
      ctx.strokeStyle = c; ctx.lineWidth = 1.8 * ks; ctx.setLineDash(DASH_NEW); ctx.lineDashOffset = 0;
      circle(ctx, x, y, R - ks); ctx.stroke(); ctx.setLineDash(DASH_NONE);
      break;
    }
    case 'HANDOFF': {
      // handing off to a fresh conversation: hollow, a violet dashed ring that turns slowly (in transit)
      ctx.fillStyle = HOLE; circle(ctx, x, y, R); ctx.fill();
      ctx.fillStyle = rgba(COL.violet, 0.14); ctx.fill();
      ctx.strokeStyle = COL.violet; ctx.lineWidth = 1.8 * ks; ctx.setLineDash(DASH_HO); ctx.lineDashOffset = -(I.time || 0) * 0.012;
      circle(ctx, x, y, R - ks); ctx.stroke(); ctx.setLineDash(DASH_NONE); ctx.lineDashOffset = 0;
      break;
    }
    case 'BUSY':
      orb(ctx, x, y, R, s.hue || COL.cyan);
      break;
    case 'ASKING':
      ctx.fillStyle = HOLE; circle(ctx, x, y, R); ctx.fill();
      ctx.fillStyle = rgba(COL.gold, 0.14); ctx.fill();
      ctx.strokeStyle = COL.gold; ctx.lineWidth = 2 * ks;
      circle(ctx, x, y, R - ks); ctx.stroke();
      orb(ctx, x, y, Math.max(1.5, R - 4.6 * ks), COL.gold);
      break;
    case 'STALLED':
      ctx.fillStyle = HOLE; circle(ctx, x, y, R); ctx.fill();
      // a ring of dots: broken, at 60% gold
      if (!I.dashStall || I.dashStall[1] !== 4.2 * ks) I.dashStall = [0.1, 4.2 * ks];
      ctx.strokeStyle = rgba(COL.gold, 0.6); ctx.lineWidth = 2.2 * ks; ctx.setLineDash(I.dashStall);
      circle(ctx, x, y, R - ks); ctx.stroke(); ctx.setLineDash(DASH_NONE);
      break;
    case 'ERROR':
      ctx.fillStyle = HOLE; circle(ctx, x, y, R); ctx.fill();
      ctx.fillStyle = rgba(COL.red, 0.14); ctx.fill();
      ctx.strokeStyle = COL.red; ctx.lineWidth = 2 * ks;
      circle(ctx, x, y, R - ks); ctx.stroke();
      ctx.lineWidth = 1.8 * ks; cross(ctx, x, y, R * 0.38);
      break;
    default: { // DONE and anything unknown: smaller and quieter, in a muted version of its own colour, with a faint rim
      const h = /^#[0-9a-f]{6}$/i.test(s.hue || '') ? s.hue : COL.dim;
      orb(ctx, x, y, R, mixHex(h, COL.faint, 0.4));
      ctx.strokeStyle = rgba(h, 0.45); ctx.lineWidth = 1.2 * ks;
      circle(ctx, x, y, R + 1.8 * ks); ctx.stroke();
    }
  }
}

function drawSession(ctx, n, ks, selected, hovered) {
  const s = n.s, bs = n.bs || 1, R = n.R * bs, x = n.sx, y = n.sy;
  n.da = ctx.globalAlpha;
  const L = I.look.get(n.id), key = L ? L.key : lookKey(s);
  const ring = 2.5 * ks;
  // a change of state: the new look settles in over the old one, which fades out under it
  const u = L && L.prev ? clamp(((I.nowP || performance.now()) - L.at) / MORPH_MS, 0, 1) : 1;
  if (u < 1) {
    const ga = ctx.globalAlpha, m = ease(u);
    ctx.globalAlpha = ga * (1 - m * m); drawLook(ctx, L.prev, s, x, y, R * (1 - 0.1 * m), ks);
    ctx.globalAlpha = ga * m; drawLook(ctx, key, s, x, y, R * (0.9 + 0.1 * m), ks);
    ctx.globalAlpha = ga;
  } else {
    if (L) L.prev = null;
    drawLook(ctx, key, s, x, y, R, ks);
  }
  // memory gauge: context used, clockwise from 12 o'clock over a faint full track; it thins away when done
  const g = L ? L.g : gaugeOn(s) ? 1 : 0;
  if (g > 0.02 && s.context && s.context.limit) {
    const RG = Math.max(0, n.RG * bs);
    ctx.strokeStyle = rgba(COL.dim, 0.14); ctx.lineWidth = ring * g;
    circle(ctx, x, y, RG); ctx.stroke();
    const frac = L ? L.frac : clamp(s.context.used / s.context.limit, 0, 1);
    if (frac > 0) {
      ctx.strokeStyle = ctxColor(ctxPct(s));
      ctx.beginPath(); ctx.arc(x, y, Math.max(0.5, RG), -Math.PI / 2, -Math.PI / 2 + Math.max(0.02, frac) * Math.PI * 2); ctx.stroke(); // (0 at birth)
    }
    // where the handoff limit sits on the gauge: a small tick across it
    const hf = Number(s.context.handoff) / s.context.limit;
    if (hf > 0.005 && hf < 0.995) {
      const a = -Math.PI / 2 + hf * TAU, ca = Math.cos(a), sa = Math.sin(a), r0 = RG - ring * g * 0.9, r1 = RG + ring * g * 0.9 + 1.2 * ks;
      ctx.strokeStyle = rgba(COL.text, 0.8); ctx.lineWidth = 1.3;
      line(ctx, x + ca * r0, y + sa * r0, x + ca * r1, y + sa * r1);
    }
  }
  // in the multi-selection: a steady double ring
  if (n.sid && I.multi.has(n.sid)) {
    ctx.strokeStyle = COL.cyan; ctx.lineWidth = 1.2;
    circle(ctx, x, y, n.RG + 4.5 * ks); ctx.stroke();
    circle(ctx, x, y, n.RG + 7.7 * ks); ctx.stroke();
  }
  if (selected) { ctx.strokeStyle = COL.cyan; ctx.lineWidth = 1.6; circle(ctx, x, y, n.RG + 4.5 * ks); ctx.stroke(); }
  else if (hovered) { ctx.strokeStyle = rgba(COL.dim, 0.7); ctx.lineWidth = 1; circle(ctx, x, y, n.RG + 4.5 * ks); ctx.stroke(); }
}

// ---------- labels with collision avoidance ----------
// Labels sit on small frosted pills. A line is a list of segments: { t, f, c } text, or { acc, c } an
// account tag drawn as a tiny coloured circle with its letter.
const PILL_X = 7, PILL_Y = 2.5, ACC_D = 13, ACC_GAP = 5, HERE_W = 13;
const segW = (ctx, sg) => (sg.acc !== undefined ? ACC_GAP + ACC_D : sg.here ? ACC_GAP + HERE_W : measure(ctx, sg.f, sg.t));
// "here": the conversation runs live in Fleet View's own window. A small terminal glyph after the account.
function drawHere(ctx, x, y, c) {
  const w = HERE_W, h = 10, x0 = x + 0.5, y0 = Math.round(y - h / 2) - 0.5;
  ctx.strokeStyle = c; ctx.lineWidth = 1.2;
  roundRect(ctx, x0, y0, w - 1, h, 2.5); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x0 + 3, y0 + 3); ctx.lineTo(x0 + 5.5, y0 + 5); ctx.lineTo(x0 + 3, y0 + 7);
  ctx.moveTo(x0 + 7, y0 + 7.2); ctx.lineTo(x0 + 9.5, y0 + 7.2); ctx.stroke();
}
function drawLabels(ctx, k, ks, clashLabels, selNode, hovNode, fileAlpha) {
  const W = I.W, H = I.H;
  const placed = [];
  const obstacles = [];
  for (const n of I.nodes) {
    if (n.kind !== 'recent' && n.sx !== undefined) {
      const r = (n.RO || n.RG || n.R) + (n.kind === 'session' || n.kind === 'repo' ? 2 : 1);
      obstacles.push({ id: n.id, sid: n.kind === 'agent' || n.kind === 'pr' ? n.sid : null, x: n.sx - r, y: n.sy - r, w: 2 * r, h: 2 * r });
    }
  }
  // ownSid: a conversation's own agents and PR don't block its name (second try, when nothing else fits)
  const hit = (r, owner, ignoreObs, ownSid) => {
    if (r.x < 2 || r.y < 2 || r.x + r.w > W - 2 || r.y + r.h > H - 2) return true;
    for (const p of placed) if (r.x < p.x + p.w + 3 && r.x + r.w + 3 > p.x && r.y < p.y + p.h + 1 && r.y + r.h + 1 > p.y) return true;
    if (!ignoreObs) for (const o of obstacles) if (o.id !== owner && (!ownSid || o.sid !== ownSid) && r.x < o.x + o.w && r.x + r.w > o.x && r.y < o.y + o.h && r.y + r.h > o.y) return true;
    return false;
  };
  const jobs = [];
  const focusSid = (hovNode && hovNode.sid) || (selNode && selNode.sid) || null;
  const noSel = !selNode;

  for (const n of I.nodes) {
    if (n.kind === 'session') {
      const s = n.s, must = n === selNode || n === hovNode;
      const f = n.fin && !must ? font(11, 500) : font(12, 600);
      const maxW = must ? 260 : k < 0.55 ? 150 : 200;
      const lines = wrap(I.ctx, f, s.name || s.id, maxW).map((t) => [{ t, f, c: s.state === 'DONE' ? COL.dim : COL.text }]);
      lines[lines.length - 1].push({ acc: s.account || '?', c: accColor(s.account) });
      if (I.ui && typeof I.ui.isHosted === 'function' && I.ui.isHosted(s.id)) lines[lines.length - 1].push({ here: true, c: COL.cyan });
      const pct = ctxPct(s);
      // in a lens, its value (cost, idle time, context) sits under the orb instead of the context %
      const lt = I.lens !== 'state' && s.state !== 'DONE' && !s.pending ? lensText(I.lens, s) : null;
      const showPct = !lt && pct !== null && s.state !== 'DONE' && (k >= 1.25 || must);
      let below = n.RG + 5 * ks;
      if (showPct || lt) {
        const pf = font(10, 600, MONO), t = lt || pct + '%', c = lt ? lensColor(I.lens, s) : ctxColor(pct);
        jobs.push({ prio: (must ? 2000 : 900) + 1, must, owner: n.id, lines: [[{ t, f: pf, c }]], lh: 11, pill: true, anchors: [(w, h) => [n.sx - w / 2, n.sy + n.RG + 2 * ks]] });
        below += 17;
      }
      const prio = must ? 2000 : NEEDS_YOU.has(s.state) ? 950 : s.state === 'DONE' ? 300 : 800 + Math.min(50, s.calls20 || 0);
      const off = n.RG + 6 * ks;
      // just outside the ring of agents, for a conversation whose agents fill every spot next to it
      const ring = n.agents.length ? Math.max(32 * k, n.RG + 10 * ks) + (n.agents.length > 10 ? 4 * ks : 0) + 3.6 * ks + 4 : off;
      jobs.push({
        prio, must, owner: n.id, sid: s.id, lines, lh: 15, pill: true,
        anchors: [
          (w, h) => [n.sx - w / 2, n.sy + below],
          (w, h) => [n.sx - w / 2, n.sy - off - h],
          (w, h) => [n.sx + off + 2, n.sy - h / 2],
          (w, h) => [n.sx - off - 2 - w, n.sy - h / 2],
          (w, h) => [n.sx + off * 0.7, n.sy + off * 0.7],
          (w, h) => [n.sx - off * 0.7 - w, n.sy + off * 0.7],
          (w, h) => [n.sx + off * 0.7, n.sy - off * 0.7 - h],
          (w, h) => [n.sx - off * 0.7 - w, n.sy - off * 0.7 - h],
          (w, h) => [n.sx - w / 2, n.sy + below + 14],
          (w, h) => [n.sx - w / 2, n.sy + Math.max(below, ring)],
          (w, h) => [n.sx - w / 2, n.sy - ring - h],
          (w, h) => [n.sx + ring + 2, n.sy - h / 2],
          (w, h) => [n.sx - ring - 2 - w, n.sy - h / 2],
        ],
      });
    } else if (n.kind === 'repo') {
      // the repo's name right next to its hub (below, above, beside, then a little farther out), on a pill
      // in the repo's colour; placed before the conversations' names so it keeps its spot by the hub
      const f = font(13, 700, DISPLAY);
      const must = n === selNode || n === hovNode;
      const g = (n.RO || n.RG) + 3, d = g * 0.72;
      jobs.push({
        prio: must ? 1900 : 1000, must, owner: n.id, lines: [[{ t: n.name, f, c: n.color }]], lh: 17, pill: true,
        anchors: [
          (w, h) => [n.sx - w / 2, n.sy + g], (w, h) => [n.sx - w / 2, n.sy - g - h],
          (w, h) => [n.sx + g, n.sy - h / 2], (w, h) => [n.sx - g - w, n.sy - h / 2],
          (w, h) => [n.sx + d, n.sy + d], (w, h) => [n.sx - d - w, n.sy + d],
          (w, h) => [n.sx + d, n.sy - d - h], (w, h) => [n.sx - d - w, n.sy - d - h],
          (w, h) => [n.sx - w / 2, n.sy + g + 12], (w, h) => [n.sx - w / 2, n.sy - g - 12 - h],
        ],
      });
    } else if (n.kind === 'pr') {
      const must = n === selNode || n === hovNode;
      if (!must && k < 0.45) continue;
      const f = font(10, 600, MONO);
      jobs.push({
        prio: must ? 1800 : 420, must, owner: n.id, lines: [[{ t: '#' + n.num, f, c: shipColor(n.ship) }]], lh: 12, pill: true,
        anchors: [(w, h) => [n.sx + n.R + 4, n.sy - h / 2], (w, h) => [n.sx - n.R - 4 - w, n.sy - h / 2], (w, h) => [n.sx - w / 2, n.sy + n.R + 3], (w, h) => [n.sx - w / 2, n.sy - n.R - 3 - h]],
      });
    } else if (n.kind === 'agent') {
      const must = n === selNode || n === hovNode;
      const show = must || focusSid === n.sid || (noSel && k >= 0.7);
      if (!show) continue;
      const f = font(10.5, 500);
      const c = n.a.state === 'fail' ? COL.red : n.a.state === 'run' ? n.s.hue : COL.dim;
      const ux = Math.cos(n.ang), uy = Math.sin(n.ang);
      const g = n.R + 4;
      jobs.push({
        prio: must ? 1700 : focusSid === n.sid ? 600 : 200, must, owner: n.id, lines: [[{ t: n.a.label, f, c }]], lh: 12, pill: true,
        anchors: [
          (w, h) => [n.sx + ux * g + (ux >= 0 ? 0 : -w), n.sy + uy * g - h / 2 + (Math.abs(uy) > 0.85 ? uy * h / 2 : 0)],
          (w, h) => [n.sx + g, n.sy - h / 2],
          (w, h) => [n.sx - g - w, n.sy - h / 2],
        ],
      });
    } else if (n.kind === 'recent' && n === hovNode) {
      const f = font(10, 500, MONO);
      jobs.push({ prio: 1600, must: true, owner: n.id, lines: [[{ t: lastParts(n.f.rel), f, c: COL.text }]], lh: 12, pill: true, anchors: [(w, h) => [n.sx + 6, n.sy - h / 2], (w, h) => [n.sx - 6 - w, n.sy - h / 2]] });
    } else if (n.kind === 'clash' && n === hovNode) {
      const f = font(10, 600, MONO);
      jobs.push({ prio: 1600, must: true, owner: n.id, lines: [[{ t: lastParts(n.c.rel), f, c: n.c.writers >= 2 ? COL.red : COL.gold }]], lh: 12, pill: true, anchors: [(w, h) => [n.sx + 7, n.sy - h / 2], (w, h) => [n.sx - 7 - w, n.sy - h / 2]] });
    } else if (n.kind === 'conflict' && n.k.kind !== 'migration') {
      // the branch's or the worktree's name beside its node (a migration's tag is its own label)
      const must = n === selNode || n === hovNode, f = font(10, 600, MONO), g = (n.RG || n.R) + 4;
      jobs.push({ prio: must ? 1600 : 640, must, owner: n.id, lines: [[{ t: String(n.k.label || ''), f, c: conflictColor(n.k) }]], lh: 12, pill: true,
        anchors: [(w, h) => [n.sx + g, n.sy - h / 2], (w, h) => [n.sx - g - w, n.sy - h / 2], (w, h) => [n.sx - w / 2, n.sy + g], (w, h) => [n.sx - w / 2, n.sy - g - h]] });
    }
  }
  // team pills: the team's name at its link's middle
  for (const tm of I.teams) {
    if (!tm.pill) continue;
    const p = tm.pill, hov = I.hoverX && I.hoverX.kind === 'team' && I.hoverX.id === tm.t.id;
    jobs.push({ prio: hov ? 1650 : 860, must: hov, soft: true, owner: 'T:' + tm.t.id, lines: [[{ t: tm.t.name || 'team', f: font(10.5, 600), c: p.color }]], lh: 13, pill: true,
      // on the link's middle, else beside it, a little farther out each time
      anchors: [[0, 0], [0, -1], [0, 1], [1, 0], [-1, 0], [0, -2], [0, 2], [1.4, -1], [-1.4, 1], [1.4, 1], [-1.4, -1], [0, -3], [0, 3]]
        .map(([ax, ay]) => (w, h) => [p.x - w / 2 + ax * (w / 2 + 8), p.y - h / 2 + ay * (h + 4)]) });
  }
  // a hovered parity line says what it is
  if (I.hoverX && I.hoverX.kind === 'parity' && I.hoverX.l) {
    const m = I.hoverX.l.mid, f = font(10, 600);
    jobs.push({ prio: 1650, must: true, owner: 'P:' + I.hoverX.id, lines: [[{ t: 'web', f, c: COL.cyan }, { t: ' ↔ ', f, c: COL.dim }, { t: 'app', f, c: COL.mint }]], lh: 12, pill: true,
      anchors: [(w, h) => [m[0] - w / 2, m[1] - h - 5], (w, h) => [m[0] - w / 2, m[1] + 5]] });
  }
  // one-sided changes: "no app change" beside the ghost orb
  for (const gh of I.parGhosts) {
    const f = font(10, 500), g = gh.r + 4, hov = I.hoverX && I.hoverX.kind === 'ghost' && I.hoverX.id === 'g:' + gh.n.sid;
    jobs.push({ prio: hov ? 1600 : 520, must: hov, soft: true, owner: 'g:' + gh.n.sid, lines: [[{ t: gh.missing === 'web' ? 'no web change' : 'no app change', f, c: gh.col }]], lh: 12, pill: true,
      anchors: [(w, h) => [gh.x + g, gh.y - h / 2], (w, h) => [gh.x - g - w, gh.y - h / 2], (w, h) => [gh.x - w / 2, gh.y - g - h], (w, h) => [gh.x - w / 2, gh.y + g]] });
  }
  for (const cl of clashLabels) {
    const f = font(10, 600, MONO);
    jobs.push({
      prio: cl.c.writers >= 2 ? 700 : 650, must: false, owner: null, key: 'cl:' + cl.c.key,
      lines: [[{ t: (cl.c.writers >= 2 ? '⚠ ' : '') + lastParts(cl.c.rel), f, c: cl.color }]], lh: 12, pill: true,
      // one label per shared file, at the midpoint of the first of its lines where it fits
      // when the midpoint is taken, slide along the line a little either way
      anchors: [0.5, 0.4, 0.6, 0.3, 0.7].flatMap((t) => cl.mids.map((m) => {
        const u = 1 - t, x = u * u * m.ax + 2 * u * t * m.cx + t * t * m.bx, y = u * u * m.ay + 2 * u * t * m.cy + t * t * m.by;
        return (w, h) => [x - w / 2, y - h / 2];
      })),
    });
  }

  jobs.sort((a, b) => b.prio - a.prio);
  if (I.labelRects) I.labelRects.clear();
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  for (const j of jobs) {
    const widths = j.lines.map((ln) => ln.reduce((w, sg) => w + segW(ctx, sg), 0));
    const px = j.pill ? PILL_X : 0, py = j.pill ? PILL_Y : 0;
    const w = Math.ceil(Math.max(...widths)) + 2 * px, h = j.lines.length * j.lh + 2 * py;
    // nodes drift every frame, so a label keeps the anchor it had while that one still fits; without
    // this a label near a neighbour would hop between spots as the two sway
    const key = j.key || j.owner + '|' + j.lh;
    const prev = I.lab.get(key);
    const tryAll = (ignoreObs, ownSid) => {
      for (let i = prev === undefined ? 0 : -1; i < j.anchors.length; i++) {
        const idx = i < 0 ? prev : i;
        if (i >= 0 && idx === prev) continue;
        const an = j.anchors[idx];
        if (!an) continue;
        const [x, y] = an(w, h);
        const r = { x, y, w, h };
        if (!hit(r, j.owner, ignoreObs, ownSid)) { I.lab.set(key, idx); return r; }
      }
      return null;
    };
    let rect = tryAll(j.must);
    if (!rect && j.sid) rect = tryAll(false, j.sid);
    if (!rect && j.soft) rect = tryAll(true); // a team pill: over nodes rather than not at all (other labels still win)
    if (!rect && j.must) {
      const [x, y] = j.anchors[0](w, h);
      rect = { x: clamp(x, 2, W - w - 2), y: clamp(y, 2, H - h - 2), w, h };
    }
    if (!rect) continue;
    placed.push(rect);
    if (j.owner) (I.labelRects || (I.labelRects = new Map())).set(j.owner + '|' + j.lh, rect);
    if (j.owner && j.owner.startsWith('T:')) { const tm = I.teams.find((x) => 'T:' + x.t.id === j.owner); if (tm) tm.rect = rect; }
    if (j.pill) {
      const rr = j.lines.length > 1 ? 8 : h / 2;
      ctx.fillStyle = PILL_BG;
      roundRect(ctx, rect.x, rect.y, rect.w, rect.h, rr); ctx.fill();
      ctx.strokeStyle = PILL_EDGE; ctx.lineWidth = 1;
      roundRect(ctx, rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1, rr - 0.5); ctx.stroke();
    }
    j.lines.forEach((ln, i) => {
      const lw = widths[i];
      let x = rect.x + (rect.w - lw) / 2;
      const y = rect.y + py + i * j.lh + j.lh / 2 + 0.5;
      for (const sg of ln) {
        if (sg.acc !== undefined) {
          const cx = x + ACC_GAP + ACC_D / 2, r = ACC_D / 2;
          ctx.fillStyle = rgba(sg.c, 0.2); circle(ctx, cx, y - 0.5, r); ctx.fill();
          ctx.strokeStyle = rgba(sg.c, 0.55); ctx.lineWidth = 1; circle(ctx, cx, y - 0.5, r - 0.5); ctx.stroke();
          ctx.font = ACC_FONT; ctx.fillStyle = sg.c; ctx.textAlign = 'center';
          ctx.fillText(sg.acc, cx, y);
          ctx.textAlign = 'left';
          x += ACC_GAP + ACC_D;
          continue;
        }
        if (sg.here) { drawHere(ctx, x + ACC_GAP, y - 0.5, sg.c); x += ACC_GAP + HERE_W; continue; }
        ctx.font = sg.f;
        // a label without a pill (a repo's name) gets a soft dark edge, so it reads over any backdrop
        if (!j.pill) { ctx.strokeStyle = LABEL_HALO; ctx.lineWidth = 3; ctx.strokeText(sg.t, x, y); }
        ctx.fillStyle = sg.c; ctx.fillText(sg.t, x, y);
        x += measure(ctx, sg.f, sg.t);
      }
    });
  }
}
function roundRect(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r); ctx.closePath();
}

// ---------- hit testing and input ----------
function hitTest(sx, sy) {
  let best = null, bd = Infinity;
  const rank = { session: 0, repo: 1, agent: 2, pr: 2, clash: 2, conflict: 2, recent: 3 };
  for (const n of I.nodes) {
    if (n.sx === undefined) continue;
    const d = Math.hypot(n.sx - sx, n.sy - sy);
    const reach = (n.RG || n.R || 4) + (n.kind === 'recent' ? 7 : 6);
    if (d > reach) continue;
    const score = d + rank[n.kind] * 6;
    if (score < bd) { bd = score; best = n; }
  }
  return best;
}

// what's under the mouse that isn't a node. A team's pill (drawn over everything) and worktree satellites (tiny,
// on a hub's outer ring) come before the nodes (hitOver); the rest only where no node is: a parity ghost, then
// the nearest link (team, parity, handoff) within 5 px. Returns { kind, id, ... } or null.
function hitOver(sx, sy) {
  for (const tm of I.teams) {
    const r = tm.rect;
    if (r && sx >= r.x && sx <= r.x + r.w && sy >= r.y && sy <= r.y + r.h) return { kind: 'team', id: tm.t.id };
  }
  for (const w of I.wtHits) if (Math.hypot(w.x - sx, w.y - sy) <= w.r + 3) return { kind: 'worktree', id: w.w.path, w: w.w, hub: w.hub };
  return null;
}
function hitExtra(sx, sy) {
  for (const g of I.parGhosts) if (Math.hypot(g.x - sx, g.y - sy) <= g.r + 4) return { kind: 'ghost', id: 'g:' + g.n.sid, g };
  let best = null, bd = 5;
  for (const l of I.linkHits) { const d = distPts(l.pts, sx, sy); if (d < bd) { bd = d; best = l; } }
  return best ? { kind: best.kind, id: best.id, l: best } : null;
}
// the shell's menu targets for a conflict node and a shared-file (clash) node
function conflictTarget(k) {
  const f = Array.isArray(k.files) && k.files[0];
  return { kind: 'conflict', id: k.id, kind2: k.kind, label: k.label, sessions: k.sessions.slice(), root: k.root || null,
    rel: f ? f.rel : undefined, abs: f ? f.abs : undefined, files: Array.isArray(k.files) ? k.files.slice() : undefined };
}
function clashTarget(c) {
  return { kind: 'conflict', id: c.id, kind2: 'clash', label: lastParts(c.rel), sessions: c.sessions.map((x) => x.id), root: c.root || null,
    rel: c.rel, abs: fileAbs(c.key, null) || undefined, writers: c.writers };
}

function select(n, fromKeys) {
  I.sel = n ? n.id : null;
  I.kbTip = !!fromKeys;
  I.dirty = true;
  // arrow keys only show the panel; a click on a conversation also starts its live session (desktop window)
  try { I.ui.setSelected && I.ui.setSelected(n ? n.sid || null : null, fromKeys ? 'keys' : 'click'); } catch { /* shell gone */ }
  if (fromKeys && n) ensureVisible(n);
}

function syncSelection() {
  const want = I.ui && I.ui.selectedId;
  const cur = I.sel ? I.byId.get(I.sel) : null;
  if (want) {
    if (!cur || cur.sid !== want) I.sel = I.byId.has('s:' + want) ? 's:' + want : I.sel;
  } else if (cur && cur.sid && I.ui && 'selectedId' in I.ui) I.sel = null;
}

function ensureVisible(n) {
  const m = 60;
  let dx = 0, dy = 0;
  if (n.sx < m) dx = n.sx - m; else if (n.sx > I.W - m) dx = n.sx - (I.W - m);
  if (n.sy < m) dy = n.sy - m; else if (n.sy > I.H - m) dy = n.sy - (I.H - m);
  if (dx || dy) { I.pan.x += dx / K(); I.pan.y += dy / K(); I.dirty = true; }
}

function wireMouse(cv) {
  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = cv.getBoundingClientRect();
    zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });
  cv.addEventListener('mousedown', (e) => {
    if (e.button !== 0 && e.button !== 1) return;
    e.preventDefault();
    // a left-drag on a repo's hub moves the repo (and pins it), on a conversation moves that conversation
    // (and pins it); anywhere else it pans
    // Ctrl (or Shift) on a node: a click toggles it in the multi-selection, a drag pans; Shift on empty space
    // draws the rubber band
    const r = cv.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
    const hit = e.button === 0 ? hitTest(sx, sy) : null;
    const mod = e.ctrlKey || e.metaKey;
    if (e.button === 0 && e.shiftKey && !mod && !hit) {
      I.glide = null;
      I.drag = { x: e.clientX, y: e.clientY, moved: false, button: 0, node: null, band: { x0: sx, y0: sy, x1: sx, y1: sy, base: new Set(I.multi) } };
      return;
    }
    I.drag = { x: e.clientX, y: e.clientY, moved: false, button: e.button, mod, shift: e.shiftKey,
      node: !mod && !e.shiftKey && hit && (hit.kind === 'repo' || hit.kind === 'session') ? hit.id : null };
  });
  window.addEventListener('mousemove', (e) => {
    if (!I || I.canvas !== cv) return;
    if (I.drag) {
      const dx = e.clientX - I.drag.x, dy = e.clientY - I.drag.y;
      if (!I.drag.moved && Math.hypot(dx, dy) > 4) I.drag.moved = true;
      if (I.drag.band && I.drag.moved) {
        // the band: everything inside it joins the selection it started from
        const b = I.drag.band, r = cv.getBoundingClientRect();
        b.x1 = e.clientX - r.left; b.y1 = e.clientY - r.top;
        const x0 = Math.min(b.x0, b.x1), x1 = Math.max(b.x0, b.x1), y0 = Math.min(b.y0, b.y1), y1 = Math.max(b.y0, b.y1);
        const set = new Set(b.base);
        for (const n of I.nodes) if (n.kind === 'session' && !n.s.pending && onScreen(n) && n.sx >= x0 && n.sx <= x1 && n.sy >= y0 && n.sy <= y1) set.add(n.sid);
        I.multi = set; I.band = b; I.dirty = true;
        hideTip();
        return;
      }
      if (I.drag.moved && !I.drag.band) {
        const hub = I.drag.node && I.byId.get(I.drag.node);
        const base = hub && hub.kind === 'session' && hub.p && convBase(hub);
        if (base) {
          // one conversation: it follows the mouse, kept as an offset from its repo's hub
          hub.p.x += dx / K(); hub.p.y += dy / K(); hub.p.vx = hub.p.vy = 0;
          I.homeXY.set(hub.id, { x: hub.p.x - base.x, y: hub.p.y - base.y, pin: true });
          // its PR and recent files come along most of the way (only the ones tied to it alone), so they
          // trail a little behind instead of being hauled by the weak springs; the springs settle the rest
          if (!I.drag.dots) {
            const ties = new Map();
            for (const s of I.springs) for (const id of [s.a, s.b]) ties.set(id, (ties.get(id) || 0) + 1);
            I.drag.dots = [];
            for (const s of I.springs) {
              const o = s.a === hub.id ? s.b : s.b === hub.id ? s.a : null;
              const m = o && ties.get(o) === 1 && I.byId.get(o);
              if (m && m.p && (m.kind === 'pr' || m.kind === 'recent')) I.drag.dots.push(m);
            }
          }
          for (const m of I.drag.dots) { m.p.x += 0.8 * dx / K(); m.p.y += 0.8 * dy / K(); }
          I.alpha = Math.max(I.alpha, 0.05);
          const to = dropRepo(hub);
          I.drag.drop = to ? to.id : null;
        } else if (hub && hub.kind === 'repo' && hub.p) {
          // the hub follows the mouse and everything on it trails behind, easing back into the same shape
          // (trailStep); its spot follows and is pinned
          const wx = dx / K(), wy = dy / K();
          hub.p.x += wx; hub.p.y += wy; hub.p.vx = hub.p.vy = 0;
          startTrail(hub);
          // its territory glow moves with it (its easing is for changes of shape, not for the drag)
          const t = I.terr && I.terr.get(hub.id);
          if (t) { t.x += wx; t.y += wy; }
          I.homeXY.set(hub.id, { x: hub.p.x, y: hub.p.y, pin: true });
          I.alpha = Math.max(I.alpha, 0.05);
        } else { I.glide = null; I.pan.x -= dx / K(); I.pan.y -= dy / K(); }
        I.drag.x = e.clientX; I.drag.y = e.clientY;
        I.dirty = true; cv.style.cursor = 'grabbing';
        hideTip();
        return;
      }
    }
    if (e.target !== cv) return;
    const r = cv.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const wt = hitOver(sx, sy);
    const n = wt ? null : hitTest(sx, sy);
    const x = wt || (n ? null : hitExtra(sx, sy));
    const id = n ? n.id : null;
    I.mouse = { x: sx, y: sy };
    I.kbTip = false;
    if (id !== I.hover) { I.hover = id; I.dirty = true; }
    const xk = (o) => (o ? o.kind + ':' + o.id : null);
    if (xk(x) !== xk(I.hoverX)) { I.hoverX = x; I.dirty = true; } else if (x) I.hoverX = x;
    cv.style.cursor = n && n.kind === 'repo' ? 'grab' : n && (n.kind === 'session' || nodeAction(n)) ? 'pointer' : 'default';
    updateTip();
  });
  window.addEventListener('mouseup', (e) => {
    if (!I || I.canvas !== cv || !I.drag) return;
    const d = I.drag;
    I.drag = null;
    cv.style.cursor = 'default';
    if (d.band) {
      I.band = null; I.dirty = true;
      const same = I.multi.size === d.band.base.size && [...I.multi].every((id) => d.band.base.has(id));
      if (d.moved && !same) setMulti(new Set(I.multi));
      else I.multi = d.band.base;
      return;
    }
    if (d.moved && d.node) {
      const n = I.byId.get(d.node), to = d.drop && I.byId.get(d.drop);
      if (n && n.kind === 'session' && to && to.p && n.p) {
        // dropped on another repo: it moves there (the server keeps it), placed where it was let go
        I.homeXY.set(n.id, { x: n.p.x - to.p.x, y: n.p.y - to.p.y, pin: true });
        n.cl = to.id;
        // a move that didn't happen: back on its own repo's ring
        const undo = () => { if (I && I.homeXY.get(n.id)) { I.homeXY.delete(n.id); I.alpha = Math.max(I.alpha, 0.3); saveSpotsSoon(300, true); } };
        try { Promise.resolve(I.ui.moveSession(n.sid, to.root)).then((ok) => { if (!ok) undo(); }, undo); } catch (err) { console.error(err); undo(); }
      }
      saveSpotsSoon(300, true); I.dirty = true;
    }
    if (d.moved || d.button !== 0 || e.target !== cv) return;
    const r = cv.getBoundingClientRect();
    let n = hitTest(e.clientX - r.left, e.clientY - r.top);
    if (d.mod || d.shift) {
      // Ctrl+click: in or out of the multi-selection (the conversation picked so far joins it first)
      const sid = n && (n.kind === 'session' || n.kind === 'agent') && !(n.s && n.s.pending) ? n.sid : null;
      if (!sid) return;
      const set = new Set(I.multi), cur = !set.size && I.sel ? I.byId.get(I.sel) : null;
      if (cur && cur.kind === 'session' && cur.sid && cur.sid !== sid && !cur.s.pending) set.add(cur.sid);
      if (set.has(sid)) set.delete(sid); else set.add(sid);
      I.lastClick = null;
      setMulti(set);
      return;
    }
    clearMulti(); // a plain click: back to a single pick
    // the second click of a double-click belongs to the node the first one hit, even when the view moved
    // in between (a pick opens the shell's detail panel, which can narrow the map and shift every node)
    if (e.detail >= 2) n = recentClick() || n;
    else I.lastClick = n ? { id: n.id, t: performance.now() } : null;
    // a second, separate click on a picked PR, file or repo acts on it (a conversation's second click
    // only keeps it picked: opening a terminal tab takes a double-click or Enter)
    if (n && n.id === I.sel && e.detail === 1 && n.kind !== 'session' && n.kind !== 'agent' && act(n)) return;
    if (e.detail >= 2 && n && n.id === I.sel) return; // already picked: don't re-pick (no extra redraw)
    // (a file dot only gets picked: it opens from its right-click menu, a double-click or Enter)
    select(n, false);
  });
  cv.addEventListener('mouseleave', () => { if (I.hover || I.hoverX) { I.hover = null; I.hoverX = null; I.dirty = true; } hideTip(); });
  // right-click: the shell's menu for a conversation (or an agent's conversation) or a repo
  cv.addEventListener('contextmenu', (e) => {
    if (!I || !I.ui || typeof I.ui.contextMenu !== 'function') return;
    const r = cv.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
    const over = hitOver(sx, sy);
    const n = over ? null : hitTest(sx, sy);
    let target = null;
    if (over) target = over.kind === 'team' ? { kind: 'team', id: over.id } : null;
    else if (n && (n.kind === 'session' || n.kind === 'agent') && n.sid) {
      // one of a multi-selection of 2+: the menu for all of them
      target = I.multi.size >= 2 && I.multi.has(n.sid) ? { kind: 'sessions', ids: [...I.multi] } : { kind: 'session', id: n.sid };
    }
    else if (n && n.kind === 'repo' && n.root) target = { kind: 'repo', root: n.root, name: n.name, color: n.color };
    else if (n && n.kind === 'conflict') target = conflictTarget(n.k);
    else if (n && n.kind === 'clash') target = clashTarget(n.c);
    // a file dot or a PR dot: its own menu (Open, Copy, its conversation), not the empty-space one
    else if (n && n.kind === 'recent') target = { kind: 'file', rel: n.f.rel, abs: fileAbs(n.f.key, n.f) || undefined, wrote: !!n.f.wrote, sid: n.s.id };
    else if (n && n.kind === 'pr') target = { kind: 'pr', num: n.num, url: prUrl(n) || undefined, sid: n.sid };
    else if (!n) { const x = hitExtra(sx, sy); if (x && x.kind === 'team') target = { kind: 'team', id: x.id }; }
    if (!target && over && over.kind === 'worktree' && over.hub && over.hub.root) target = { kind: 'repo', root: over.hub.root, name: over.hub.name, color: over.hub.color };
    if (!target) return; // the shell decides about the browser's own menu
    e.preventDefault();
    hideTip();
    try { I.ui.contextMenu(target, e.clientX, e.clientY); } catch (err) { console.error(err); }
  });
  cv.addEventListener('dblclick', (e) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey) return; // multi-select clicks never open anything
    const r = cv.getBoundingClientRect();
    const n = recentClick() || hitTest(e.clientX - r.left, e.clientY - r.top);
    if (n) act(n);
  });
}

// the node the last single click hit, while a double-click on it is still possible
function recentClick() {
  const c = I.lastClick;
  return c && performance.now() - c.t < 700 ? I.byId.get(c.id) || null : null;
}

function openSid(sid) { try { I.ui.open && I.ui.open(sid); } catch { /* shell gone */ } }

// returns true when the key was the map's (the shell then stops there)
// Keys the map doesn't take go on to the overlay (I.overlay.key(e), true when it took the key).
function overlayKey(e) {
  if (!I.overlay || typeof I.overlay.key !== 'function') return false;
  try { return !!I.overlay.key(e); } catch (err) { console.error(err); return false; }
}
function onKey(e) {
  if (!active()) return false;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return false;
  if (e.ctrlKey || e.altKey || e.metaKey) return overlayKey(e);
  const key = e.key;
  const dirs = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (key === 'Escape') {
    // the innermost first: the legend, the multi-selection, then the overlay's own (the replay bar); else the
    // shell clears the filter and the pick
    let done = true;
    if (I.legend) setLegend(false);
    else if (I.multi.size) clearMulti();
    else done = overlayKey(e);
    if (done) e.preventDefault();
    return done;
  }
  let handled = true;
  if (dirs[key]) {
    const [dx, dy] = dirs[key];
    if (e.shiftKey) { I.pan.x += (dx * 90) / K(); I.pan.y += (dy * 90) / K(); I.dirty = true; }
    else moveSel(dx, dy);
  } else if (key === '+' || key === '=' || e.code === 'NumpadAdd') zoomAt(I.W / 2, I.H / 2, 1.25);
  else if (key === '-' || key === '_' || e.code === 'NumpadSubtract') zoomAt(I.W / 2, I.H / 2, 0.8);
  else if (key === '0') { I.pan = { x: 0, y: 0 }; I.zoom = 1; I.camUntil = performance.now() + 1500; zoomAt(I.W / 2, I.H / 2, 1); }
  else if (key === 'l' || key === 'L') setLegend(!I.legend);
  else if (key === 'g') rearrange(false);
  else if (key === 'G') rearrange(true);
  else if (key === 'k' || key === 'K') {
    // lenses: k the next, K the one before
    const i = LENSES.indexOf(I.lens);
    setMapLens(LENSES[(i + (key === 'k' ? 1 : LENSES.length - 1)) % LENSES.length]);
    flash(`lens: ${I.lens}`);
  }
  else if (key === 'n') nextNeedsYou(1);
  else if (key === 'N') nextNeedsYou(-1);
  // saved views: Shift+1..9 keeps the view, 1..9 glides back to it (e.code: Shift+1 is '!' as a key)
  else if (e.shiftKey && /^Digit[1-9]$/.test(e.code || '')) saveView(e.code.slice(5));
  else if (/^[1-9]$/.test(key)) jumpView(key);
  else if (key === 'Enter' || key === 'o' || key === 'O') {
    const n = I.sel && I.byId.get(I.sel);
    if (!n || !act(n)) handled = false;
  } else handled = false;
  if (!handled) return overlayKey(e);
  e.preventDefault();
  return true;
}

// arrows: the nearest node in that direction, favouring nodes straight ahead
function moveSel(dx, dy) {
  const cur = I.sel ? I.byId.get(I.sel) : null;
  const px = cur ? cur.sx : I.W / 2, py = cur ? cur.sy : I.H / 2;
  let best = null, bs = Infinity;
  for (const n of I.nodes) {
    if (n === cur || n.kind === 'recent' || n.sx === undefined) continue;
    const vx = n.sx - px, vy = n.sy - py;
    const along = vx * dx + vy * dy, perp = Math.abs(vx * dy - vy * dx);
    if (along <= 3) continue;
    const score = along + perp * 2.2 + (n.kind === 'session' ? 0 : 25);
    if (score < bs) { bs = score; best = n; }
  }
  if (!best && !cur) best = I.nodes.find((n) => n.kind === 'session') || null;
  if (best) select(best, true);
}

// ---------- acting on nodes: PR -> GitHub, file -> VS Code, repo -> Explorer ----------
const isHttps = (u) => typeof u === 'string' && /^https:\/\//i.test(u);
function allSessions() {
  const st = I.state || {};
  return Array.isArray(st.allSessions) ? st.allSessions : st.sessions || [];
}
// a shared file's absolute path, from any conversation that touched it (the server only reveals paths it listed)
function fileAbs(key, own) {
  if (own && own.abs) return own.abs;
  for (const s of allSessions()) for (const f of s.files || []) if (f.key === key && f.abs) return f.abs;
  return null;
}
// { hint, run } for a node that does something on double-click / Enter, or null
function nodeAction(n) {
  if (!n) return null;
  if (n.kind === 'pr') {
    const url = prUrl(n);
    return url ? { hint: 'open PR on GitHub', run: () => openUrl(url) } : null;
  }
  if (n.kind === 'recent' || n.kind === 'clash') {
    const abs = n.kind === 'recent' ? fileAbs(n.f.key, n.f) : fileAbs(n.c.key, null);
    return abs ? { hint: 'open the file', run: () => reveal({ kind: 'file', path: abs }) } : null;
  }
  if (n.kind === 'conflict') {
    const f = Array.isArray(n.k.files) && n.k.files.find((x) => x && x.abs);
    return f ? { hint: 'open the migration in VS Code', run: () => reveal({ kind: 'file', path: f.abs }) } : null;
  }
  if (n.kind === 'repo') return n.root ? { hint: 'open the folder in Explorer', run: () => reveal({ kind: 'folder', path: n.root }) } : null;
  if ((n.kind === 'session' || n.kind === 'agent') && n.sid) return { hint: 'open the conversation', run: () => openSid(n.sid) };
  return null;
}
// a PR dot's GitHub link: its conversation's, else another one's that shipped the same PR
function prUrl(n) {
  let url = n.s.links && n.s.links.pr;
  if (!isHttps(url)) {
    const o = allSessions().find((s) => s.ship && s.ship.pr === n.num && (s.ship.repo || '') === (n.ship.repo || '') && s.links && isHttps(s.links.pr));
    url = o ? o.links.pr : null;
  }
  return isHttps(url) ? url : null;
}
// runs a node's action once: a click on the picked node followed by a double-click must not open it twice
function act(n) {
  const a = nodeAction(n);
  if (!a) return false;
  const now = performance.now();
  if (I.lastAct && I.lastAct.id === n.id && now - I.lastAct.t < 700) return true;
  I.lastAct = { id: n.id, t: now };
  a.run();
  return true;
}
function openUrl(url) {
  if (!isHttps(url)) return;
  try {
    if (I.ui && typeof I.ui.openUrl === 'function') I.ui.openUrl(url);
    else window.open(url, '_blank', 'noopener');
  } catch { /* shell gone */ }
}
function reveal(req) {
  try {
    if (I.ui && typeof I.ui.reveal === 'function') { I.ui.reveal(req); return; }
    fetch('/reveal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req) }).catch(() => {});
  } catch { /* shell gone */ }
}

// ---------- tooltip ----------
function hideTip() { if (I && I.tip) I.tip.style.display = 'none'; }
// the shell's right-click menu is open: no tooltip comes back over it while the pointer still rests on a node
function menuIsOpen() { try { return !!(I && I.ui && typeof I.ui.menuOpen === 'function' && I.ui.menuOpen()); } catch { return false; } }

function updateTip() {
  const n = (I.hover && I.byId.get(I.hover)) || (I.kbTip && I.sel && I.byId.get(I.sel)) || null;
  const xo = !n && I.hoverX ? I.hoverX : null;
  if ((!n && !xo) || I.drag || menuIsOpen()) { hideTip(); return; }
  const key = (n ? n.id : 'x:' + xo.kind + ':' + xo.id) + '|' + (I.state && I.state.now);
  if (I.tipKey !== key) {
    I.tipKey = key;
    if (n) fillTip(n);
    else if (!fillTipX(xo)) { I.hoverX = null; I.tipKey = null; hideTip(); return; }
  }
  const tip = I.tip;
  tip.style.display = 'block';
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  let x, y;
  if ((I.hover || xo) && I.mouse) {
    x = I.mouse.x + 16; y = I.mouse.y + 14;
    if (x + tw > I.W - 8) x = I.mouse.x - 16 - tw;
    if (y + th > I.H - 8) y = Math.max(8, I.H - 8 - th);
  } else {
    // picked with the keys: sit above the node, clear of its own label underneath
    const r = (n.RG || n.R || 4) + 14;
    x = n.sx - 40; y = n.sy - r - th;
    if (y < 8) y = n.sy + r + 40;
    if (x + tw > I.W - 8) x = I.W - 8 - tw;
    if (y + th > I.H - 8) y = Math.max(8, I.H - 8 - th);
  }
  tip.style.left = Math.max(8, x) + 'px';
  tip.style.top = Math.max(8, y) + 'px';
}

// mono: the value is a path, a branch or a number column (Cascadia Mono); everything else is Segoe UI
function row(parent, label, value, color, mono) {
  const d = document.createElement('div');
  if (label) { const l = document.createElement('span'); l.textContent = label + '  '; l.style.color = COL.dim; d.appendChild(l); }
  const v = document.createElement('span'); v.textContent = value; if (color) v.style.color = color;
  if (mono) v.style.cssText += `;font:11.5px ${CSS_MONO}`;
  d.appendChild(v); parent.appendChild(d); return d;
}
function shipRow(parent, ship) {
  if (!ship || !ship.steps) return;
  const d = document.createElement('div');
  const l = document.createElement('span'); l.textContent = 'ship  '; l.style.color = COL.dim; d.appendChild(l);
  ship.steps.forEach(([name, st], i) => {
    const [g, c] = STEP_LOOK[st] || STEP_LOOK.none;
    const s = document.createElement('span'); s.style.color = c; s.textContent = `${g} ${stepName(name, ship)}`; d.appendChild(s);
    if (i < ship.steps.length - 1) { const sep = document.createElement('span'); sep.textContent = ' ─ '; sep.style.color = COL.faint; d.appendChild(sep); }
  });
  parent.appendChild(d);
}

function fillTip(n) {
  const tip = I.tip, nowC = Date.now() - I.skew;
  tip.textContent = '';
  const head = document.createElement('div');
  head.style.cssText = `font:600 13px/1.35 var(--font-display, ${DISPLAY});margin-bottom:4px`;
  if (n.kind === 'session') {
    const s = n.s;
    const name = document.createElement('span'); name.textContent = s.name || s.id; head.appendChild(name);
    const acc = document.createElement('span'); acc.textContent = '  ' + (s.account || '?'); acc.style.color = accColor(s.account); head.appendChild(acc);
    tip.appendChild(head);
    const st = row(tip, '', s.label || s.state, s.stateColor || COL.dim);
    st.style.cssText += `;font:600 11px ${CSS_UI};letter-spacing:0.06em;margin-bottom:2px`;
    if (s.turnStart && (s.state === 'WORKING' || s.state === 'AGENTS')) st.lastChild.textContent += `   working ${Math.max(0, Math.round((nowC - s.turnStart) / 60e3))}m`;
    else if (NEEDS_YOU.has(s.state) && s.last) st.lastChild.textContent += `   waiting ${Math.max(0, Math.round((nowC - s.last) / 60e3))}m`;
    // what it runs in the background: a server (dev server, emulator) is listed but does not keep it WORKING
    for (const b of (s.background || []).slice(0, 3)) row(tip, b.server ? 'serving' : 'background', `${b.label} · ${Math.max(0, Math.round((nowC - b.t) / 60e3))}m`, b.server ? COL.dim : COL.violet);
    if (s.repo) row(tip, 'repo', s.repo.name + (s.worktree ? ` · ${s.worktree}` : ''), s.repo.color);
    if (s.branch) row(tip, 'branch', s.branch, null, true);
    if (s.model || s.context) {
      const pct = ctxPct(s);
      const d = row(tip, 'model', s.model || '?');
      if (pct !== null) {
        const c = document.createElement('span'); c.textContent = `   ctx ${pct}%`; c.style.cssText = `color:${ctxColor(pct)};font:11.5px ${CSS_MONO}`; d.appendChild(c);
      }
    }
    if (s.goal) row(tip, 'goal', s.goal);
    if (s.lastAction) {
      const a = s.lastAction;
      row(tip, '▸', `${a.who && a.who !== 'main' ? a.who + '  ' : ''}${a.verb || ''} ${a.what || ''}  · ${ago(nowC - a.t)}`);
    }
    if (s.waitingOn && NEEDS_YOU.has(s.state)) {
      const w = row(tip, 'waiting on', s.waitingOn, COL.gold);
      w.style.marginTop = '3px';
    }
    if (s.agents && s.agents.length) {
      const run = s.agents.filter((a) => a.state === 'run').length, fail = s.agents.filter((a) => a.state === 'fail').length;
      row(tip, 'agents', `${run} running · ${s.agents.length - run - fail} done${fail ? ` · ${fail} failed` : ''}`);
    }
    if (s.ship && (s.ship.pr || s.ship.steps)) { shipRow(tip, s.ship); if (s.ship.pr) tip.lastChild.lastChild.after(Object.assign(document.createElement('span'), { textContent: `   PR #${s.ship.pr}`, style: `color:${COL.dim}` })); }
    const clash = I.clashes.filter((c) => c.sessions.some((x) => x.id === s.id));
    for (const c of clash) {
      const others = c.sessions.filter((x) => x.id !== s.id).map((x) => { const o = I.byId.get('s:' + x.id); return o ? o.s.name : x.id; });
      const me = c.sessions.find((x) => x.id === s.id);
      row(tip, '⚠', `also ${me && me.wrote ? 'editing' : 'reading'} ${lastParts(c.rel)} with ${others.join(', ')}`, c.writers >= 2 ? COL.red : COL.gold);
    }
    const tm = s.team && I.teams.find((x) => x.t.id === s.team);
    if (tm) {
      const others = tm.t.members.filter((id) => id !== s.id).map(nameOf);
      row(tip, 'team', `${tm.t.name || 'team'} · with ${others.join(', ')}`, tm.t.color || COL.violet);
    }
    if (s.parity && s.parity.partner) {
      const web = s.side && s.side.web, app = s.side && s.side.app;
      row(tip, 'parity', `${web && !app ? 'web side' : app && !web ? 'app side' : 'paired'} · ${web && !app ? 'app' : app && !web ? 'web' : 'other side'}: ${nameOf(s.parity.partner)}`, COL.cyan);
    } else if (s.parity && s.parity.missing) row(tip, 'parity', `changed one side only: no ${s.parity.missing} change yet`, s.parity.missing === 'app' ? COL.mint : COL.cyan);
    if (s.pickedUpFrom && s.pickedUpFrom.id) row(tip, 'picked up from', s.pickedUpFrom.name || s.pickedUpFrom.id, COL.dim);
    if (s.context && s.context.limit && Number(s.context.handoff) > 0 && s.context.handoff < s.context.limit) {
      row(tip, 'handoff at', `${fmtTokens(s.context.handoff)} (the tick on its gauge)`, COL.dim);
    }
    if (I.multi.has(s.id)) row(tip, '', `in the selection (${I.multi.size})`, COL.cyan);
    const u = row(tip, '', `${fmtTokens(s.tokens)} tok  $${(s.cost || 0).toFixed(2)}${s.usagePending ? ' …' : ''}`, COL.dim, true);
    u.style.marginTop = '3px';
    u.append(Object.assign(document.createElement('span'), { textContent: `   · ${ago(nowC - s.last)}`, style: `color:${COL.faint}` }));
  } else if (n.kind === 'agent') {
    head.textContent = n.a.label; tip.appendChild(head);
    row(tip, '', n.a.state === 'run' ? 'running' : n.a.state === 'fail' ? 'failed' : 'done', n.a.state === 'fail' ? COL.red : n.a.state === 'run' ? n.s.hue : COL.dim);
    if (n.a.phase) row(tip, 'phase', n.a.phase);
    row(tip, 'for', n.s.name);
  } else if (n.kind === 'repo') {
    head.textContent = n.name; head.style.color = n.color; tip.appendChild(head);
    row(tip, '', n.root, COL.dim, true);
    row(tip, 'conversations', String(n.sessions.length));
    const dp = I.deploy && I.deploy.get(n.id), d = dp && dp.d;
    if (dp) {
      const text = dp.state === 'building' ? `building${d && d.createdAt ? ` · started ${ago(nowC - d.createdAt)}` : ''}`
        : dp.state === 'failed' ? `deploy failed${d && d.readyAt ? ` · ${ago(nowC - d.readyAt)}` : ''}`
        : `clean, nothing building${d && d.readyAt ? ` · last live ${ago(nowC - d.readyAt)}` : ''}`;
      row(tip, 'production', text, dp.state === 'building' ? COL.gold : dp.state === 'failed' ? COL.red : COL.mint);
      if (d && d.title) row(tip, '', `${d.pr ? `#${d.pr} ` : ''}${d.title}`, COL.dim);
    }
    if (n.wts && n.wts.length) {
      const live = n.wts.filter((w) => w.live).length, stale = n.wts.filter((w) => w.stale);
      row(tip, 'worktrees', `${n.wts.length} · ${live} live${stale.length ? ` · ${stale.length} stale` : ''}`);
      for (const w of stale.slice(0, 8)) row(tip, '  stale', `${w.name} · last commit ${w.lastCommit ? ago(nowC - w.lastCommit) : 'unknown'}`, COL.faint, true);
      if (stale.length > 8) row(tip, '', `+${stale.length - 8} more stale`, COL.faint);
    }
  } else if (n.kind === 'pr') {
    head.textContent = `PR #${n.num}`; tip.appendChild(head);
    if (n.ship.repo) row(tip, '', n.ship.repo, COL.dim, true);
    shipRow(tip, n.ship);
    if (n.ship.fresh) row(tip, '', 'new work since this PR', COL.faint);
    row(tip, 'for', n.s.name);
  } else if (n.kind === 'clash') {
    head.textContent = lastParts(n.c.rel); head.style.color = n.c.writers >= 2 ? COL.red : COL.gold; tip.appendChild(head);
    row(tip, '', n.c.rel, COL.dim, true);
    row(tip, '', n.c.writers >= 2 ? `${n.c.writers} conversations edited it` : 'shared: only one edited it', n.c.writers >= 2 ? COL.red : COL.gold);
    for (const x of n.c.sessions) { const o = I.byId.get('s:' + x.id); row(tip, x.wrote ? '✎' : '·', o ? o.s.name : x.id); }
  } else if (n.kind === 'conflict') {
    const k = n.k, c = conflictColor(k);
    head.textContent = k.kind === 'branch' ? `branch ${k.label}` : k.kind === 'worktree' ? `worktree ${k.label}` : `migration ${k.label}`;
    head.style.color = c; tip.appendChild(head);
    const nm = k.sessions.map(nameOf).join(' and ');
    row(tip, '', k.kind === 'branch' ? `${nm} are on the same branch: pushing from both overwrites each other's work`
      : k.kind === 'worktree' ? `${nm} work live in one worktree folder: they edit the same files on disk`
        : `${nm} wrote migrations with the same number: only one can run`, c);
    if (k.root) row(tip, '', k.root, COL.dim, true);
    for (const f of Array.isArray(k.files) ? k.files : []) row(tip, '✎', `${f.rel} · ${nameOf(f.sid)}`, null, true);
  } else if (n.kind === 'recent') {
    head.textContent = lastParts(n.f.rel); tip.appendChild(head);
    row(tip, '', n.f.rel, COL.dim, true);
    row(tip, n.f.wrote ? '✎ edited' : 'read', `${n.s.name} · ${ago(nowC - n.f.t)}`);
  }
  // what a click does here
  const a = nodeAction(n);
  let hint = null;
  if (n.kind === 'session') hint = 'click: details · double-click / Enter: open the conversation · Ctrl+click: select several';
  else if (a) hint = `double-click / Enter: ${a.hint}`;
  else if (n.kind === 'pr') hint = 'no GitHub link for this PR yet';
  if (n.kind === 'clash' || n.kind === 'conflict' || n.kind === 'recent' || n.kind === 'pr') hint = (hint ? hint + ' · ' : '') + 'right-click: actions';
  if (hint) {
    const h = row(tip, '', hint, COL.dim);
    h.style.cssText += `;margin-top:6px;padding-top:5px;border-top:1px solid var(--line, rgba(120,130,170,0.18));font:11px ${CSS_UI}`;
  }
}
// a conversation's name by id (on the map, or anywhere in the state)
function nameOf(id) {
  const n = I.byId.get('s:' + id);
  if (n && n.s) return n.s.name || id;
  const s = allSessions().find((x) => x.id === id);
  return (s && s.name) || id;
}
// the tooltip for things that aren't nodes: a worktree, a parity ghost, a team, a parity line, a handoff trail.
// Returns false when it's gone.
function fillTipX(x) {
  const tip = I.tip, nowC = Date.now() - I.skew;
  tip.textContent = '';
  const head = document.createElement('div');
  head.style.cssText = `font:600 13px/1.35 var(--font-display, ${DISPLAY});margin-bottom:4px`;
  const hint = (text) => { const h = row(tip, '', text, COL.dim); h.style.cssText += `;margin-top:6px;padding-top:5px;border-top:1px solid var(--line, rgba(120,130,170,0.18));font:11px ${CSS_UI}`; };
  if (x.kind === 'worktree') {
    const w = x.w;
    head.textContent = w.name || 'worktree'; head.style.color = (x.hub && x.hub.color) || COL.text; tip.appendChild(head);
    if (w.branch) row(tip, 'branch', w.branch, null, true);
    row(tip, '', w.path, COL.dim, true);
    row(tip, 'last commit', w.lastCommit ? ago(nowC - w.lastCommit) : 'unknown');
    row(tip, '', w.live ? 'a live conversation works here' : w.stale ? 'stale: nothing live, no commit for 3+ days' : 'no live conversation here', w.live ? COL.mint : w.stale ? COL.faint : COL.dim);
    return true;
  }
  if (x.kind === 'ghost') {
    const g = x.g, s = g.n.s;
    head.textContent = g.missing === 'web' ? 'no web change' : 'no app change'; head.style.color = g.col; tip.appendChild(head);
    row(tip, '', `${s.name} changed the ${g.missing === 'web' ? 'phone app' : 'website'} only, and no partner conversation covers the ${g.missing === 'web' ? 'website' : 'app'}`);
    row(tip, '', 'web and app ship together: make the same change on the other side, or say why in the PR', COL.dim);
    return true;
  }
  if (x.kind === 'team') {
    const tm = I.teams.find((t) => t.t.id === x.id);
    if (!tm) return false;
    const t = tm.t;
    head.textContent = t.name || 'team'; head.style.color = t.color || COL.violet; tip.appendChild(head);
    row(tip, 'members', t.members.map(nameOf).join(', '));
    if (t.order) {
      const o = row(tip, 'order', t.order.length > 360 ? t.order.slice(0, 359) + '…' : t.order);
      if (t.at) o.append(Object.assign(document.createElement('span'), { textContent: `  · ${ago(nowC - t.at)}`, style: `color:${COL.faint}` }));
    }
    const msgs = (Array.isArray(t.messages) ? t.messages : []).slice(-4);
    if (msgs.length) {
      const h = row(tip, '', 'last messages', COL.dim); h.style.marginTop = '4px';
      for (const m of msgs) {
        const text = String(m.text || '');
        const r = row(tip, `${nameOf(m.from)} → ${nameOf(m.to)}`, text.length > 160 ? text.slice(0, 159) + '…' : text);
        r.append(Object.assign(document.createElement('span'), { textContent: `  · ${ago(nowC - m.t)}`, style: `color:${COL.faint}` }));
      }
    }
    hint('right-click: message the team, add, disband');
    return true;
  }
  if (x.kind === 'parity' && x.l) {
    head.textContent = 'web ↔ app'; tip.appendChild(head);
    row(tip, 'web', x.l.a.s.name, COL.cyan);
    row(tip, 'app', x.l.b.s.name, COL.mint);
    row(tip, '', 'partners: one change, made on both sides', COL.dim);
    return true;
  }
  if (x.kind === 'handoff' && x.l) {
    head.textContent = 'handoff'; tip.appendChild(head);
    row(tip, '', `${x.l.a.s.name} → ${x.l.b.s.name}`);
    row(tip, '', 'picked up where the earlier conversation stopped', COL.dim);
    return true;
  }
  return false;
}
function fmtTokens(t) {
  t = t || 0;
  if (t >= 1e9) return (t / 1e9).toFixed(1) + 'B';
  if (t >= 1e6) return (t / 1e6).toFixed(1) + 'M';
  if (t >= 1e3) return Math.round(t / 1e3) + 'k';
  return String(t);
}

// ---------- legend ----------
function setLegend(on) {
  if (!I) return;
  I.legend = on;
  if (I.legendEl) I.legendEl.style.display = on ? 'block' : 'none';
  if (I.hintEl) I.hintEl.style.display = on ? 'none' : 'block';
}

function buildLegend() {
  const NS = 'http://www.w3.org/2000/svg';
  const wrapEl = document.createElement('div');
  const title = document.createElement('div');
  title.textContent = 'Map legend';
  title.style.cssText = `flex:1 1 auto;font:600 13px var(--font-display, ${DISPLAY});color:${COL.text}`;
  // a × beside the title closes it (as l and Esc do)
  const head = document.createElement('div');
  head.style.cssText = 'display:flex;align-items:center;gap:8px;margin:-4px -6px 4px 0';
  const x = document.createElement('button');
  x.type = 'button'; x.title = 'close (l or Esc)'; x.setAttribute('aria-label', 'close the legend');
  x.style.cssText = `flex:none;display:grid;place-items:center;width:26px;height:26px;padding:0;border:0;border-radius:7px;background:transparent;color:${COL.dim};cursor:pointer`;
  x.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  x.addEventListener('mouseenter', () => { x.style.background = 'rgba(255,255,255,0.07)'; x.style.color = COL.text; });
  x.addEventListener('mouseleave', () => { x.style.background = 'transparent'; x.style.color = COL.dim; });
  x.addEventListener('pointerdown', (e) => e.stopPropagation());
  x.addEventListener('click', (e) => { e.stopPropagation(); setLegend(false); });
  head.append(title, x);
  wrapEl.appendChild(head);
  let gid = 0;
  // an orb like the map's: lighter top left, the hue, a darker rim
  const orbSvg = (cx, cy, r, color, op = 1) => {
    const id = 'fvorb' + ++gid;
    return `<defs><radialGradient id="${id}" cx="0.32" cy="0.29" r="0.75"><stop offset="0" stop-color="${mix(color, WHITE, 0.55)}"/>` +
      `<stop offset="0.5" stop-color="${color}"/><stop offset="1" stop-color="${mix(color, BLACK, 0.45)}"/></radialGradient></defs>` +
      `<circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#${id})" opacity="${op}"/>`;
  };
  const icon = (svg) => {
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('width', '30'); s.setAttribute('height', '20'); s.setAttribute('viewBox', '0 0 30 20');
    s.style.cssText = 'flex:none;margin-right:10px';
    s.innerHTML = svg; return s;
  };
  const item = (svg, text) => {
    const d = document.createElement('div');
    d.style.cssText = 'display:flex;align-items:center;margin:2px 0';
    d.appendChild(icon(svg));
    const t = document.createElement('span'); t.textContent = text; d.appendChild(t);
    wrapEl.appendChild(d);
  };
  const sec = (text) => {
    const d = document.createElement('div'); d.textContent = text;
    d.style.cssText = `color:${COL.dim};font:600 10px ${CSS_UI};margin:9px 0 3px;letter-spacing:0.08em;text-transform:uppercase`;
    wrapEl.appendChild(d);
  };
  const track = `<circle cx="15" cy="10" r="7.5" fill="none" stroke="${rgba(COL.dim, 0.18)}" stroke-width="2.5"/>`;
  const arc = (d, c) => `<path d="${d}" fill="none" stroke="${c}" stroke-width="2.5" stroke-linecap="round"/>`;
  sec('Conversations');
  item(orbSvg(15, 10, 6, COL.cyan), 'working (an orb in its colour)');
  item(orbSvg(15, 10, 5, COL.violet) + orbSvg(5, 10, 2, COL.violet) + orbSvg(25, 10, 2, COL.violet) + orbSvg(15, 2.2, 1.8, COL.violet, 0.45), 'agents running (orbs around it)');
  item(`<circle cx="15" cy="10" r="6.5" fill="${rgba(COL.gold, 0.14)}" stroke="${COL.gold}" stroke-width="1.8"/>` + orbSvg(15, 10, 2.6, COL.gold), 'needs you / asked you');
  item(`<circle cx="15" cy="10" r="6.5" fill="none" stroke="${rgba(COL.gold, 0.6)}" stroke-width="2" stroke-linecap="round" stroke-dasharray="0.1 3.6"/>`, 'stalled? (quiet 5 min mid-turn)');
  item(`<circle cx="15" cy="10" r="6.5" fill="${rgba(COL.red, 0.14)}" stroke="${COL.red}" stroke-width="1.8"/><path d="M12.6 7.6l4.8 4.8M17.4 7.6l-4.8 4.8" stroke="${COL.red}" stroke-width="1.6" stroke-linecap="round"/>`, 'API error');
  item(orbSvg(15, 10, 4.4, mixHex(COL.cyan, COL.faint, 0.5)), 'finished, in "Recently finished" (smaller and muted, on its repo; removing it there removes it here)');
  item(`<circle cx="15" cy="10" r="6.5" fill="${rgba(COL.accB, 0.12)}" stroke="${COL.accB}" stroke-width="1.6" stroke-dasharray="3 3"/>`, 'new session, no message yet (dashed in its account colour)');
  sec('Context gauge');
  item(track + arc('M15 2.5 A7.5 7.5 0 0 1 22.5 10', COL.mint), 'under 70% of context used');
  item(track + arc('M15 2.5 A7.5 7.5 0 1 1 7.9 7.7', COL.gold), '70–90%');
  item(track + arc('M15 2.5 A7.5 7.5 0 1 1 12.7 2.9', COL.red), 'over 90%');
  sec('Other nodes');
  const hub = (c) => {
    const hex = (r) => Array.from({ length: 6 }, (_, i) => { const a = -Math.PI / 2 + (i * Math.PI) / 3; return `${(15 + Math.cos(a) * r).toFixed(2)},${(10 + Math.sin(a) * r).toFixed(2)}`; }).join(' ');
    const arcs = Array.from({ length: 6 }, (_, i) => {
      const a0 = 0.3 + (i * Math.PI) / 3, a1 = a0 + (Math.PI / 3) * 0.64, R = 7.4;
      return `M${(15 + Math.cos(a0) * R).toFixed(2)} ${(10 + Math.sin(a0) * R).toFixed(2)}A${R} ${R} 0 0 1 ${(15 + Math.cos(a1) * R).toFixed(2)} ${(10 + Math.sin(a1) * R).toFixed(2)}`;
    }).join('');
    const id = 'fvhub' + ++gid;
    return `<defs><linearGradient id="${id}" x1="0.25" y1="0" x2="0.75" y2="1"><stop offset="0" stop-color="${mix(c, WHITE, 0.42)}"/><stop offset="0.5" stop-color="${c}"/>` +
      `<stop offset="1" stop-color="${mix(c, BLACK, 0.38)}"/></linearGradient></defs>` +
      `<path d="${arcs}" fill="none" stroke="${rgba(c, 0.66)}" stroke-width="1.3" stroke-linecap="round"/>` +
      `<polygon points="${hex(4.6)}" fill="url(#${id})" stroke="rgba(255,255,255,0.24)" stroke-width="0.8"/><polygon points="${hex(1.6)}" fill="${mix(c, WHITE, 0.5)}"/>`;
  };
  item(hub(COL.ember), 'repo: a hub in its colour, its ring turns slowly and nudges when work arrives (territory: the faint blob)');
  const vtri = (cx, c) => `<circle cx="${cx}" cy="10" r="5.6" fill="${HOLE}" stroke="${rgba(c, 0.55)}" stroke-width="1"/><path d="M${cx} 6.6l3.6 5.6h-7.2z" fill="${c}"/>`;
  item(`<circle cx="15" cy="10" r="7.6" fill="none" stroke="${rgba(COL.gold, 0.16)}" stroke-width="2"/><path d="M15 2.4A7.6 7.6 0 0 1 22.6 10" fill="none" stroke="${COL.gold}" stroke-width="2" stroke-linecap="round"/>` + vtri(15, COL.gold), 'repo deploying to production (Vercel): gold arc turning round the hub');
  item(vtri(9, COL.mint) + vtri(22, COL.red), 'repo on production: clean, nothing building · last deploy failed');
  item(orbSvg(9, 10, 3.2, COL.cyan) + orbSvg(21, 10, 2.8, COL.cyan, 0.42), 'agent running · done');
  item(`<path d="M12 7l6 6M18 7l-6 6" stroke="${COL.red}" stroke-width="1.8" stroke-linecap="round"/>`, 'agent failed');
  const pr = (cx, c) => `<circle cx="${cx}" cy="10" r="4.6" fill="${rgba(c, 0.2)}" stroke="${c}" stroke-width="1.3"/>` +
    `<path d="M${cx - 1.4} 8.6v2.8M${cx + 1.4} 11.2v-1.8q0 -1.1 -1.2 -1.1" fill="none" stroke="${c}" stroke-width="0.8" stroke-linecap="round"/>` +
    `<g fill="${c}"><circle cx="${cx - 1.4}" cy="8.1" r="0.7"/><circle cx="${cx - 1.4}" cy="11.9" r="0.7"/><circle cx="${cx + 1.4}" cy="11.9" r="0.7"/></g>`;
  item(pr(5, COL.gold) + pr(15, COL.cyan) + pr(25, COL.violet), 'PR: checks running · passed · merged');
  item(pr(9, COL.mint) + pr(21, COL.red), 'PR: live · failed');
  sec('Files');
  item(`<path d="M2 10 H28" stroke="${COL.red}" stroke-width="1.4" stroke-dasharray="5 3" opacity="0.7"/>` + orbSvg(15, 10, 3.6, COL.red), 'same file edited by 2+ conversations');
  item(`<path d="M2 10 H28" stroke="${COL.gold}" stroke-width="1.4" stroke-dasharray="5 3" opacity="0.7"/>` + orbSvg(15, 10, 3.6, COL.gold), 'shared file, only one edits it');
  item(`<path d="M3 13 Q15 6 26 10" fill="none" stroke="${COL.cyan}" stroke-width="1.1" opacity="0.7"/><circle cx="27" cy="10" r="2.4" fill="${COL.cyan}"/>`, 'file edited, last 10 min (fades with age)');
  item(`<path d="M3 13 Q15 6 26 10" fill="none" stroke="${COL.cyan}" stroke-width="1" stroke-dasharray="2 3" opacity="0.5"/><circle cx="27" cy="10" r="2" fill="none" stroke="${COL.dim}" stroke-width="1.1"/>`, 'file read, last 10 min');
  sec('Working together');
  item(`<circle cx="15" cy="10" r="6" fill="none" stroke="${COL.cyan}" stroke-width="1.1"/><circle cx="15" cy="10" r="8.6" fill="none" stroke="${COL.cyan}" stroke-width="1.1"/>` + orbSvg(15, 10, 3.6, COL.cyan),
    'in the selection (Ctrl+click, Shift+drag; right-click: orders for all)');
  const braid = (c) => `<path d="M2 10 C6 6 9 6 12 10 S18 14 21 10 S26 6 28 10" fill="none" stroke="${rgba(c, 0.6)}" stroke-width="1.1"/>` +
    `<path d="M2 10 C6 14 9 14 12 10 S18 6 21 10 S26 14 28 10" fill="none" stroke="${rgba(c, 0.6)}" stroke-width="1.1"/>`;
  item(braid('#ff9f43'), 'a team: members braided in its colour, its name on a pill (hover: the order and messages)');
  item(`<path d="M2 10 H28" stroke="${COL.dim}" stroke-width="1" opacity="0.6"/>` + orbSvg(15, 10, 2.4, '#ff9f43'), 'a message between teammates travels along the link');
  item(`<defs><linearGradient id="fvpar" gradientUnits="userSpaceOnUse" x1="3" y1="10" x2="27" y2="10"><stop offset="0" stop-color="${COL.cyan}"/><stop offset="1" stop-color="${COL.mint}"/></linearGradient></defs>` +
    `<path d="M3 10 H27" stroke="url(#fvpar)" stroke-width="1.6" stroke-linecap="round" stroke-dasharray="0.1 4"/>`, 'web ↔ app partners (website side cyan, app side mint)');
  item(orbSvg(8, 10, 4, COL.cyan) + `<path d="M13 10 H20" stroke="${rgba(COL.mint, 0.5)}" stroke-dasharray="2 3"/><circle cx="24" cy="10" r="3.6" fill="none" stroke="${rgba(COL.mint, 0.7)}" stroke-width="1.1" stroke-dasharray="2 3"/>`,
    'changed one side only: "no app change" (or web)');
  item(`<path d="M3 10 H22" stroke="${rgba(COL.dim, 0.5)}" stroke-width="1"/><path d="M27 10 L21 7 L21 13 Z" fill="${rgba(COL.dim, 0.6)}"/>`, 'handoff: from the conversation it was picked up from');
  item(track + arc('M15 2.5 A7.5 7.5 0 0 1 22.5 10', COL.mint) + `<path d="M21.2 14.4 L24.2 16.6" stroke="${COL.text}" stroke-width="1.3"/>`, 'the tick on the gauge: where it should hand off');
  sec('Conflicts (right-click: actions)');
  const cring = (c, glyph) => `<circle cx="15" cy="10" r="6.5" fill="${rgba(c, 0.16)}" stroke="${c}" stroke-width="1.3"/>${glyph}`;
  item(cring(COL.gold, `<path d="M13 6.6v6.8M16.9 7.6q0 3.2 -3.9 3.6" fill="none" stroke="${COL.gold}" stroke-width="1"/>`), 'two conversations on one branch');
  item(cring(COL.red, `<path d="M11.8 7.6h2.2l0.8 0.9h3.4v4.3h-6.4z" fill="none" stroke="${COL.red}" stroke-width="1"/>`), 'two live in one worktree folder');
  item(`<rect x="3" y="4" width="24" height="12" rx="6" fill="${rgba(COL.red, 0.16)}" stroke="${COL.red}" stroke-width="1.2"/>` +
    `<text x="15" y="13.2" text-anchor="middle" font-family="Cascadia Mono, Consolas, monospace" font-weight="700" font-size="6.6" fill="${COL.red}">#0142</text>`, 'two migrations with one number');
  sec('Repos and shipping');
  item(hub(COL.mint) + `<rect x="13.5" y="0.2" width="3" height="3" rx="0.8" fill="${COL.mint}"/>`,
    'worktree a live conversation works in (idle ones: hover the hub)');
  item(pr(13, COL.gold) + `<rect x="19" y="3" width="5" height="8" rx="1.3" fill="none" stroke="${COL.gold}" stroke-width="1.1"/>`, 'PR shipping to the phones (the badge: the app step)');
  sec('Lenses (k)');
  item(orbSvg(6, 10, 2.6, COL.mint) + orbSvg(15, 10, 4, COL.gold) + orbSvg(25, 10, 5.4, COL.red), 'cost: bigger and hotter as it costs more');
  // the accounts in the legend: up to 3 fit its 30 px swatch
  const accs = [...accSeen].sort().slice(0, 3), accX = (i) => (accs.length > 2 ? 5 + i * 10 : 8 + i * 14);
  item(accs.map((a, i) => orbSvg(accX(i) + (accs.length > 2 ? 0 : 1), 10, accs.length > 2 ? 3.4 : 4, ACC_COL[a] || COL.dim)).join(''), 'account: ' + accs.join(' · '));
  item(orbSvg(9, 10, 4, COL.cyan) + orbSvg(21, 10, 4, mixHex(COL.cyan, COL.faint, 0.8)), 'idle: fresh · quiet for an hour');
  item(orbSvg(6, 10, 3.6, COL.mint) + orbSvg(15, 10, 3.6, COL.gold) + orbSvg(24, 10, 3.6, COL.red), 'context: little · much · nearly full');
  sec('Double-click (or click when picked)');
  const act = (text) => { const d = document.createElement('div'); d.textContent = text; d.style.cssText = 'margin:1px 0 1px 40px'; wrapEl.appendChild(d); };
  act('conversation: open it (one click shows details)');
  act('PR: open it on GitHub');
  act('file: click to open it (VS Code, or its own app for images and documents)');
  act('repo: open the folder in Explorer');
  act('right-click a conversation, a repo, a team or a conflict: its menu');
  sec('Accounts');
  const small = accs.length > 2;
  const acc = (cx, c, t) => `<circle cx="${cx}" cy="10" r="${small ? 4.8 : 6.5}" fill="${rgba(c, 0.2)}" stroke="${rgba(c, 0.55)}"/>` +
    `<text x="${cx}" y="${small ? 12.5 : 13.2}" text-anchor="middle" font-family="Segoe UI Variable Text, Segoe UI" font-weight="700" font-size="${small ? 7 : 9}" fill="${c}">${t}</text>`;
  item(accs.map((a, i) => acc(accX(i), ACC_COL[a] || COL.dim, a)).join(''), 'Claude account ' + accs.join(' · '));
  const keys = document.createElement('div');
  keys.style.cssText = `margin-top:10px;padding-top:8px;border-top:1px solid var(--line, rgba(120,130,170,0.18));color:${COL.dim};font:11px ${CSS_UI}`;
  keys.textContent = 'wheel zoom · drag pan · drag a repo or conversation to pin it · g re-arrange (G unpins all) · 0 recenter · arrows pick · Enter/o open or act · ' +
    'Ctrl+click select · Shift+drag select an area · Esc clear · n / N next that needs you · k lens · Shift+1..9 save a view, 1..9 go back · l close';
  wrapEl.appendChild(keys);
  return wrapEl;
}
