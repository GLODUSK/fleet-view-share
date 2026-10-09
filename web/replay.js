// Fleet View web: Replay (what the map looked like a while ago).
//
// The server keeps a timeline (GET /timeline?from&to, see README "Timeline"): a frame of every conversation's
// state, cost and context every minute and after each change of state, every feed entry, and the ship events
// (merged, live, failed checks and deploys). This module loads a stretch of it and, for any moment T in it,
// builds an object shaped like GET /state, so the map can draw that moment with its own code, comets included.
//
// The picture at T: the conversations of the newest frame at or before T (before the first frame, the first
// one). A frame only carries the fields the map needs most, so the rest are filled in:
//   - context from the frame's share in use (ctx, 0 to 1) and the live conversation's window size;
//   - last (last activity) from the newest event at or before T, else the time its state began;
//     turnStart is when the current state began (the frames before T show when it changed);
//   - calls20: its events in the 20 minutes before T (the map sizes orbs and auras by it);
//   - agents: the agents (feed entries whose who is not 'main') that did something in the 3 minutes before T,
//     shown running; files: the files its main thread read or edited in the 10 minutes before T (up to 14),
//     so the feed's comets have somewhere to land. Both are stand-ins: names only, no paths to open;
//   - ship: the five steps, from the ship events at or before T (merged, live, checksFail, deployFail);
//     a conversation with none has every step 'none', as /state lists it;
//   - model, goal and worktree from the live conversation of the same id (they rarely change); files [],
//     agents [], calls [], spark [] and the rest are empty defaults.
// Repos come from the frame's conversations plus the live state's list (a repo with no conversation at T still
// has its anchor, so hubs don't come and go). Teams are the live teams, cut to the members the frame puts in
// them and to messages sent by T. Branch conflicts (two unfinished conversations on one branch of one repo) are
// worked out from the frame; worktree and migration conflicts, clashes and alerts are left empty. feed is the
// events in (T - 10 s, T]; settings come from the live state; now = T, and replay: { t, from, to, speed,
// playing, range } marks it as a replay (the shell shows its pill and the map uses state.now as its clock).
//
//   export function createReplay({ fetchJson, onState, onExit, onChange, live })
//     fetchJson(url) -> Promise of the parsed JSON (default: fetch with no cache);
//     onState(st)    each replay state, as the scrubber moves or plays, at most 10 a second (the last one of a
//                    burst is always sent). Default: emitReplay(true, st);
//     onExit()       once when the replay ends (exit). Default: emitReplay(false, null);
//     onChange(info) whenever the scrubber's numbers change (t, range, playing, speed, loading, error), for the
//                    bar's readout;
//     live           the live /state (an object or a function returning it), for repos, teams and settings.
//   returns { start(range), load(range), seek(t), play(speed), pause(), toggle(), setSpeed(x), exit(), destroy(),
//             info(), timeline() }
//     start opens the replay on the last `range` ms (default an hour) at its newest moment; load changes the
//     range and keeps T when it is still inside (a range longer than the recording starts at its first frame);
//     play at the end starts over from the range's start, and playing stops at the range's end. Speeds are
//     multiples of real time (1, 10, 60).
//
//   export function emitReplay(on, state)
//     the page's contract (app.js listens): window.dispatchEvent(new CustomEvent('fv-replay', { detail: { on, state } }))
//     for each replay state (on: true), and once with on: false (state null) when the replay ends.
//   export function buildReplayState(timeline, t, live)    the /state-shaped object for moment t
//   export function replaySummary(timeline, t)             "3 live · 2 waiting · $4.10 so far" for the readout
//     (live: unfinished conversations at t; waiting: the ones that need you; so far: what they spent since the
//     range's first frame).
//
// Nothing here draws or animates; playing is a plain 10-a-second timer, so prefers-reduced-motion changes nothing.

const NEEDS_YOU = new Set(['ASKING', 'QUESTION', 'STALLED', 'ERROR']);
const STEP_NAMES = ['push', 'PR', 'checks', 'merged', 'live'];
const FEED_WINDOW = 10e3, CALLS_WINDOW = 20 * 60e3, AGENT_WINDOW = 3 * 60e3, FILE_WINDOW = 10 * 60e3;
const MAX_FILES = 14, MAX_AGENTS = 16, SCAN_MAX = 400;
const EMIT_GAP = 100, TICK_MS = 100;
const FILE_RE = /^[^\s/\\]+\.[A-Za-z0-9]{1,8}$/;
const MAIN_BRANCHES = new Set(['main', 'master', 'HEAD', '']);

export function emitReplay(on, state) {
  try { window.dispatchEvent(new CustomEvent('fv-replay', { detail: { on: !!on, state: on ? state : null } })); } catch { /* no window */ }
}

const defaultFetch = (url) => fetch(url, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))));

// ---------- the timeline, indexed once per object ----------
const IDX = new WeakMap();
// the last index whose value is <= t, or -1
function lastLE(arr, t) {
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m] <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
}
function index(tl) {
  let X = tl && IDX.get(tl);
  if (X) return X;
  const frames = ((tl && tl.frames) || []).filter((f) => f && typeof f.t === 'number' && Array.isArray(f.sessions)).slice().sort((a, b) => a.t - b.t);
  const events = ((tl && tl.events) || []).filter((e) => e && typeof e.t === 'number' && e.sid).slice().sort((a, b) => a.t - b.t);
  const ships = ((tl && tl.ships) || []).filter((s) => s && typeof s.t === 'number').slice().sort((a, b) => a.t - b.t);
  // when each conversation's state began, per frame (a run of frames with the same state shares it)
  const since = [];
  let prev = null;
  for (const f of frames) {
    const m = new Map();
    for (const s of f.sessions) {
      const p = prev && prev.get(s.id);
      m.set(s.id, p && p.state === s.state ? p : { state: s.state, t: f.t });
    }
    since.push(m);
    prev = m;
  }
  const bySid = new Map(); // sid -> { t: [times], e: [entries] }, oldest first
  for (const e of events) {
    let b = bySid.get(e.sid);
    if (!b) bySid.set(e.sid, (b = { t: [], e: [] }));
    b.t.push(e.t); b.e.push(e);
  }
  const shipBySid = new Map();
  for (const s of ships) { if (!s.sid) continue; if (!shipBySid.has(s.sid)) shipBySid.set(s.sid, []); shipBySid.get(s.sid).push(s); }
  const startCost = new Map();
  if (frames[0]) for (const s of frames[0].sessions) startCost.set(s.id, +s.cost || 0);
  X = { frames, frameT: frames.map((f) => f.t), events, evT: events.map((e) => e.t), ships, shipT: ships.map((s) => s.t), since, bySid, shipBySid, startCost };
  if (tl && typeof tl === 'object') IDX.set(tl, X);
  return X;
}
function frameAt(X, t) {
  if (!X.frames.length) return -1;
  return Math.max(0, lastLE(X.frameT, t));
}

// ---------- one moment as a /state ----------
function shipAt(list, t) {
  const steps = { push: 'none', PR: 'none', checks: 'none', merged: 'none', live: 'none' };
  let pr = null, repo = null;
  for (const s of list || []) {
    if (s.t > t) break;
    if (s.pr != null) pr = s.pr;
    if (s.repo) repo = s.repo;
    steps.push = 'ok'; steps.PR = 'ok';
    if (s.kind === 'checksFail') steps.checks = 'fail';
    else if (s.kind === 'merged') { steps.checks = 'ok'; steps.merged = 'ok'; if (steps.live === 'none') steps.live = 'pending'; }
    else if (s.kind === 'live') { steps.merged = 'ok'; steps.checks = 'ok'; steps.live = 'ok'; }
    else if (s.kind === 'deployFail') steps.live = 'fail';
  }
  return { pr, repo, steps: STEP_NAMES.map((k) => [k, steps[k]]), fresh: false, app: null };
}

function activity(b, sid, t, root) {
  const out = { last: null, calls20: 0, agents: [], files: [] };
  if (!b) return out;
  const i = lastLE(b.t, t);
  if (i < 0) return out;
  out.last = b.t[i];
  out.calls20 = i - lastLE(b.t, t - CALLS_WINDOW);
  const who = new Set(), seen = new Set();
  for (let j = i, n = 0; j >= 0 && n < SCAN_MAX; j--, n++) {
    const e = b.e[j], age = t - e.t;
    if (age > FILE_WINDOW && age > AGENT_WINDOW) break;
    if (e.who && e.who !== 'main') {
      if (age <= AGENT_WINDOW && !who.has(e.who) && who.size < MAX_AGENTS) {
        who.add(e.who);
        out.agents.push({ id: `a:${sid}:replay:${e.who}`, label: e.who, state: 'run', phase: null });
      }
    } else if (age <= FILE_WINDOW && (e.verb === 'read' || e.verb === 'edit' || e.verb === 'write') && FILE_RE.test(String(e.what || '')) && out.files.length < MAX_FILES) {
      const rel = String(e.what);
      if (seen.has(rel)) continue;
      seen.add(rel);
      out.files.push({ key: `${root || ''}|replay|${rel}`, rel, root: root || null, abs: null, t: e.t, wrote: e.verb !== 'read', replay: true });
    }
  }
  return out;
}

const liveOf = (live) => (typeof live === 'function' ? live() : live) || {};

export function buildReplayState(timeline, t, live) {
  const X = index(timeline);
  const L = liveOf(live);
  const liveById = new Map((L.sessions || []).map((s) => [s.id, s]));
  const fi = frameAt(X, t);
  const frame = fi >= 0 ? X.frames[fi] : { t, sessions: [] };
  const since = fi >= 0 ? X.since[fi] : new Map();
  const sessions = [];
  for (const f of frame.sessions) {
    if (!f || !f.id) continue;
    const ls = liveById.get(f.id);
    const began = (since.get(f.id) || {}).t || frame.t;
    const root = f.repo && f.repo.root;
    const act = activity(X.bySid.get(f.id), f.id, t, root);
    const limit = (ls && ls.context && ls.context.limit) || 1e6;
    const ctx = typeof f.ctx === 'number' ? { used: Math.round(f.ctx * limit), limit, handoff: (ls && ls.context && ls.context.handoff) || null } : null;
    const busy = f.state === 'WORKING' || f.state === 'AGENTS';
    sessions.push({
      id: f.id, name: f.name || f.id, account: f.account || null, state: f.state || 'IDLE', label: f.label || f.state || '',
      stateColor: f.stateColor || null, hue: f.hue || null, repo: f.repo || null, branch: f.branch || null,
      worktree: (ls && ls.worktree) || null, model: (ls && ls.model) || null, effort: null, goal: (ls && ls.goal) || null,
      context: ctx, cost: +f.cost || 0, tokens: +f.tokens || 0, lastAction: f.lastAction || null, team: f.team || null,
      last: act.last || began, turnStart: busy ? began : null, calls20: act.calls20,
      agents: f.state === 'DONE' ? [] : act.agents, files: f.state === 'DONE' ? [] : act.files,
      ship: shipAt(X.shipBySid.get(f.id), t),
      calls: [], spark: [], planSteps: null, progress: null, waitingOn: null, lastReply: null, handoff: null, pickedUpFrom: null,
      side: null, parity: null, links: { pr: null, branch: null, deploy: null, repoFolder: root || null },
      moved: false, active: 0, usagePending: false, endedAt: f.state === 'DONE' ? began : null, cwd: null, openElsewhere: false,
    });
  }
  // repos: the frame's, then the live list's, each once
  const repos = new Map();
  const norm = (r) => String(r).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  for (const s of sessions) {
    if (!s.repo || !s.repo.root) continue;
    const k = norm(s.repo.root);
    if (!repos.has(k)) repos.set(k, { root: s.repo.root, name: s.repo.name, color: s.repo.color, live: 0 });
    if (s.state !== 'DONE') repos.get(k).live++;
  }
  for (const r of L.repos || []) if (r && r.root && !repos.has(norm(r.root))) repos.set(norm(r.root), { root: r.root, name: r.name, color: r.color, live: 0 });
  const repoList = [...repos.values()];
  // teams: live teams with the members the frame puts in them
  const teams = [];
  for (const tm of L.teams || []) {
    const members = sessions.filter((s) => s.team === tm.id).map((s) => s.id);
    if (members.length < 2) continue;
    teams.push({ ...tm, members, messages: (tm.messages || []).filter((m) => m && m.t <= t) });
  }
  // branch conflicts between unfinished conversations
  const byBranch = new Map();
  for (const s of sessions) {
    if (s.state === 'DONE' || !s.repo || !s.branch || MAIN_BRANCHES.has(s.branch)) continue;
    const k = norm(s.repo.root) + '\u0001' + s.branch;
    if (!byBranch.has(k)) byBranch.set(k, { id: 'k:branch:' + s.branch, kind: 'branch', label: s.branch, root: s.repo.root, sessions: [] });
    byBranch.get(k).sessions.push(s.id);
  }
  const conflicts = [...byBranch.values()].filter((c) => c.sessions.length > 1);
  // the feed: events in (t - 10 s, t]
  const hi = lastLE(X.evT, t), lo = lastLE(X.evT, t - FEED_WINDOW);
  const feed = X.events.slice(lo + 1, hi + 1);
  const finished = sessions.filter((s) => s.state === 'DONE');
  const live2 = sessions.filter((s) => s.state !== 'DONE');
  return {
    now: t, demo: !!L.demo, title: L.title, build: L.build, home: L.home, settings: L.settings || {},
    repos: repoList, repoAnchors: repoList.map((r) => ({ root: r.root, name: r.name, color: r.color })),
    counts: {
      live: live2.length, agents: live2.reduce((n, s) => n + s.agents.length, 0), waiting: live2.filter((s) => NEEDS_YOU.has(s.state)).length,
      mergedToday: X.ships.filter((s) => s.kind === 'merged' && s.t <= t).length, cost: sessions.reduce((n, s) => n + s.cost, 0),
    },
    week: L.week, alert: null, alerts: [], hiddenDone: 0,
    sessions, allSessions: sessions, pending: [], removed: [],
    finished: finished.map((s) => ({ id: s.id, name: s.name, account: s.account, repo: s.repo, endedAt: s.endedAt, summary: '' })),
    finishedSessions: finished,
    clashes: [], allClashes: [], conflicts, worktrees: L.worktrees || [], teams, tools: L.tools || {},
    feed, replay: { t },
  };
}

export function replaySummary(timeline, t) {
  const X = index(timeline);
  const fi = frameAt(X, t);
  if (fi < 0) return 'nothing recorded yet';
  let live = 0, waiting = 0, spent = 0;
  for (const s of X.frames[fi].sessions) {
    if (s.state !== 'DONE') live++;
    if (NEEDS_YOU.has(s.state)) waiting++;
    spent += Math.max(0, (+s.cost || 0) - (X.startCost.get(s.id) || 0));
  }
  return `${live} live · ${waiting} waiting · $${spent.toFixed(2)} so far`;
}

// ---------- the player ----------
export function createReplay({ fetchJson = defaultFetch, onState = (st) => emitReplay(true, st), onExit = () => emitReplay(false, null), onChange = null, live = null } = {}) {
  const R = { open: false, tl: null, from: 0, to: 0, t: 0, range: 3600e3, playing: false, speed: 1, loading: false, error: null };
  let seq = 0, lastEmit = -Infinity, emitTimer = null, tick = null, lastTick = 0;

  const info = () => ({ open: R.open, t: R.t, from: R.from, to: R.to, range: R.range, playing: R.playing, speed: R.speed, loading: R.loading, error: R.error });
  const changed = () => { try { onChange && onChange(info()); } catch (e) { console.error(e); } };

  function sendNow() {
    emitTimer = null;
    if (!R.open || !R.tl) return;
    lastEmit = performance.now();
    const st = buildReplayState(R.tl, R.t, live);
    st.replay = { t: R.t, from: R.from, to: R.to, speed: R.speed, playing: R.playing, range: R.range };
    try { onState(st); } catch (e) { console.error(e); }
  }
  // at most one state per EMIT_GAP; the last of a burst always goes out
  function send() {
    if (!R.open || !R.tl) return;
    const wait = EMIT_GAP - (performance.now() - lastEmit);
    if (wait <= 0) { clearTimeout(emitTimer); sendNow(); } else if (!emitTimer) emitTimer = setTimeout(sendNow, wait);
  }

  async function load(range) {
    if (typeof range === 'number' && range > 0) R.range = Math.min(24 * 3600e3, range);
    const my = ++seq;
    R.loading = true; R.error = null;
    changed();
    const to = Date.now(), from = to - R.range;
    let tl = null;
    try { tl = await fetchJson(`/timeline?from=${Math.round(from)}&to=${Math.round(to)}`); } catch (e) { R.error = (e && e.message) || 'could not load the timeline'; }
    if (my !== seq) return;
    R.loading = false;
    if (tl && !R.error) {
      if (tl.ok === false || !Array.isArray(tl.frames)) R.error = (tl && tl.error) || 'no timeline from the server';
      else if (!tl.frames.length) R.error = 'nothing recorded in this range yet';
    }
    if (R.error) { changed(); return; }
    const keep = R.tl && R.t >= from && R.t <= to;
    R.tl = tl;
    // a range longer than what was recorded starts at the first frame
    const first = tl.frames.reduce((m, f) => (f && typeof f.t === 'number' && f.t < m ? f.t : m), Infinity);
    R.from = Math.max(typeof tl.from === 'number' ? tl.from : from, isFinite(first) ? first : -Infinity);
    R.to = typeof tl.to === 'number' ? tl.to : to;
    if (!keep) R.t = R.to;
    R.t = Math.min(R.to, Math.max(R.from, R.t));
    changed();
    send();
  }

  function start(range) { R.open = true; R.tl = null; R.t = 0; return load(range || R.range); }

  function seek(t) {
    if (!R.open || !R.tl || typeof t !== 'number' || !isFinite(t)) return;
    R.t = Math.min(R.to, Math.max(R.from, t));
    changed();
    send();
  }

  function step() {
    const now = performance.now(), dt = Math.min(1000, now - lastTick);
    lastTick = now;
    R.t = Math.min(R.to, R.t + dt * R.speed);
    if (R.t >= R.to) { pause(); send(); return; }
    changed();
    send();
  }
  function play(speed) {
    if (typeof speed === 'number' && speed > 0) R.speed = speed;
    if (!R.open || !R.tl) return;
    if (R.t >= R.to - 1000) R.t = R.from; // at the end: start over
    R.playing = true;
    lastTick = performance.now();
    clearInterval(tick);
    tick = setInterval(step, TICK_MS);
    changed();
    send();
  }
  function pause() {
    clearInterval(tick); tick = null;
    if (!R.playing) return;
    R.playing = false;
    changed();
  }
  const toggle = () => (R.playing ? pause() : play());
  function setSpeed(x) { if (typeof x === 'number' && x > 0) { R.speed = x; changed(); } }

  function exit() {
    const was = R.open;
    seq++;
    clearInterval(tick); tick = null;
    clearTimeout(emitTimer); emitTimer = null;
    Object.assign(R, { open: false, tl: null, playing: false, loading: false, error: null });
    changed();
    if (was) { try { onExit(); } catch (e) { console.error(e); } }
  }

  return { start, load, seek, play, pause, toggle, setSpeed, exit, destroy: exit, info, timeline: () => R.tl };
}
