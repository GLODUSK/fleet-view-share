// sync-run.js: runs conversation sync inside the server. It starts the uploader (sync-up.js), the materializer
// (sync-down.js) and the mover (sync-move.js, "Continue here") when all the gates are open, and stops them when any
// one closes:
//   0. this machine did not choose to work locally (o.mode(), sync-setup.js: the first-start choice)
//   1. sync is set up on this PC (<dataDir>/sync/config.json, sync-api.js enabled())
//   2. someone is signed in, and the server has not said they are off the members list (sync-api.js status())
//   3. the sync key is on this PC (sync-crypto.js fetchKey: the first check after the sign-in fetches it from Blackbox,
//      or makes it there on the first machine; no passphrase)
//   4. the Claude account letters here are Blackbox's (o.accounts.reconcile, sync-accounts.js: it moves a login to
//      its letter by itself and says which letters still need a sign-in). Looked at on every check, so a sign-in
//      done in the page starts sync within a minute (at once when the page asks for a check). While sync runs, a
//      list that could not be read (the network) does not stop it; a mismatch does.
// The gates are looked at when sync-api.js reports a sign-in or a sign-out (onChange), and once a minute (a config
// written by `sync-api.js setup`). Off by default: a PC with none of the three runs no loop,
// sets no timer beyond the minute check and reaches no network.
//
//   createSyncRunner({ sync, dataDir, log, projects, roots, host, isOpen, mode, accounts, snapshot, bound, accountOf,
//                      busy, intervalMs, checkMs, prefs, relay, version, makeUploader, makeMaterializer, makeMover,
//                      makeLive, makePrefs, makeLink, makeCarry })
//     -> { start(), stop(), check(), status(), move(id, { force, noWork }), moveStatus(id), cancelMove(id), owners(),
//          device(), live(), prefsChanged(), link(), missing(), rescan(), note(id), dropNote(id), peer(route, body, from) }
//   sync: sync-api.js createSync()'s object; projects: () => [{ account, dir }], every account's folder even when two
//   are one (by default each side's own: ~/.claude and ~/.claude-a); accountOf(id) -> the account a conversation ran
//   under here or null (fleet-view.js: its claude process, or remembered), the uploader's option of that name, so its
//   row says a when it ran on A in a folder A shares with B; busy(id) -> true while a turn of it runs here (the
//   uploader's option of that name: such a chat goes up at most every 45 s, and at once when its turn ends); the
//   uploader's ownerOf is the materializer's owner(id), so another device's conversation costs it no request;
//   roots: () => [repo folders] (the
//   repos Fleet View lists; the materializer matches a synced repo's origin against them). host: { list() ->
//   Promise<desktop/host.js list()'s items | null>, kill(id) -> Promise } (api.js hostList / hostKill); isOpen(id) ->
//   true while a Claude Code process here has it open (fleet-view.js's live pid files); trust(cwd, account) -> bool,
//   the mover's option of that name (fleet-view.js trustMoved: a moved chat's folder in a listed repo is trusted).
//   Stays-on rules (fleet-view.js hostRules): stays(mainRoot) -> [globs] (the carry's option); pinnedHere(id) -> { rule,
//   host, note } | null: a chat kept on this machine is never handed over (the mover's mayLeave refuses, code
//   'pinned') and its work gets no turn's snapshot (the carry's pinnedHere).
//   The materializer never lays down a conversation that isOpen, or the host's last list (alive), says is open. makeUploader, makeMaterializer and
//   makeMover are for tests; by default sync-up.js createUploader, sync-down.js createMaterializer and sync-move.js
//   createMover.
//
// "Continue here" (sync-move.js), each safe to call while sync is not running:
//   move(id, { force, noWork }) -> the job (sync-move.js's job JSON) at once; the work goes on in the background.
//     Throws an Error with .code 'not_running' (its message says why sync is not running), 'bad_id' or
//     'not_elsewhere' (no other device has it). A second move() of the same id gives the same job; force: true
//     forces it; noWork: true moves it without its work when the other machine can't pack it (workRefused).
//   A move carries what the chat needs besides the conversation (sync-carry.js, made beside the mover with this
//   machine's device id and the link): its work, the env files and sign-ins (over the link), the ready check and a
//   note for Claude. note(id) -> that note or null, dropNote(id) (both read <dataDir>/sync/notes.json, sync running or
//   not); peer(route, body, from) -> [status, json] for /peer/env and /peer/logins (the mover's, 404 while not running).
//   moveStatus(id) -> the job | null      cancelMove(id) -> true when it was stopped
//   owners() -> Map id -> { device, name, live, moving, account, bound }: conversations another device owns (live: its
//     lease is ahead; account: its row's, 'a' | 'b' | null; bound: its workspace is only on that device, sync-common.js
//     "portable or bound"), and this device's own moves (moving 'here' or 'away'); an empty Map while not running
//   device() -> { id, name } of this device | null
// What runs where (sync-live.js), beside the mover and only with it (it needs the mover's device id): snapshot() ->
// the conversations this device owns, as fleet-view.js's /state shows them, published for the other devices; bound()
// -> the ids of the ones whose workspace is only here (sync-live.js's option of that name);
//   live() -> sync-live.js live(): the other devices' fresh snapshots | null while not running (or no snapshot given)
// The shared settings (sync-prefs.js), beside the mover and only with it (the same device id): prefs: { read(),
// apply(group, items), translate, load(), save(state) } (sync-prefs.js createPrefs's options of those names);
//   prefsChanged() -> a local save: the prefs loop runs a round soon (nothing while not running)
// The link between machines (link.js, docs/link.md), beside the mover and only with it (it names this machine by the
// mover's device id) and only when a relay is given (relay.js: link.js keeps the other machine there as a computer):
//   link() -> link.js's object while sync runs, else null. Stopped with sync: no socket, no timer, no key read
// Sync health (status().health, health() below; GET /sync/activity, the header pill's colour and the Sync card): each
// loop (up, down, live) keeps sync-api.js createScanHealth's record, and HEALTH holds every threshold:
//   ok    every loop's recent scans ran clean
//   warn  a loop is backing off, its last scan failed (once or twice) or had an error on a row, or it had no clean
//         scan for HEALTH.staleMs
//   bad   signed out (or not a member, no key: sync stopped for a reason that needs Henry), a loop failed
//         HEALTH.badStreak times in a row, or nothing went through for HEALTH.deadMs
//   off   sync is off here (not set up, Work locally, not started)
// -> { level, part, name, why, error: { at, message } | null, tip }: part / name the worst loop, tip one line for the
// pill's title. A loop in the middle of a long scan with no error is not stale.
// <dataDir>/sync/away.json (what the session host refuses to open, sync-move.js) is deleted when sync is turned off
// here (not set up, or Work locally chosen), and kept when it stops for any other reason: signed out (a lost sign-in
// too), not a member, no key, or the server stopping. The other devices' chats stay theirs until sync runs again.
'use strict';
const path = require('path');
const S = require(path.join(__dirname, 'sync-api.js'));
const C = require(path.join(__dirname, 'sync-crypto.js'));
const M = require(path.join(__dirname, 'sync-move.js'));

const CHECK_MS = 60e3;
const INTERVAL_MS = 5e3;
// every threshold of the health colours, in one place
const HEALTH = {
  staleMs: 2 * 60e3, // warn: a loop had no clean scan for this long
  deadMs: 5 * 60e3, // bad: nothing went through (no scan ran to its end) for this long
  warnStreak: 1, // warn: this many scans in a row failed
  badStreak: 3, // bad: this many
};
const PARTS = [['up', 'Uploads'], ['down', 'Downloads'], ['live', 'Live status']];
const RANK = { ok: 0, warn: 1, bad: 2 };
const mins = (ms) => Math.max(1, Math.round(ms / 60e3));
const clock = (iso) => { const t = Date.parse(iso || ''); return t ? new Date(t).toTimeString().slice(0, 8) : ''; };
// a runner status() (without health) -> its health, as the header above says
function health(st, nowMs = Date.now()) {
  if (!st || !st.running) {
    const reason = (st && st.reason) || 'not started';
    if (st && st.off) return { level: 'off', part: null, name: null, why: reason, error: null, tip: `Conversation sync is off: ${reason}` };
    return { level: 'bad', part: null, name: null, why: reason, error: null, tip: `Conversation sync is not running: ${reason}` };
  }
  const startedAt = Date.parse(st.startedAt || '') || nowMs;
  const ago = (iso) => { const t = Date.parse(iso || ''); return t ? nowMs - t : nowMs - startedAt; }; // never: since it started
  let worst = null;
  for (const [part, name] of PARTS) {
    const p = st[part];
    if (!p || typeof p !== 'object') continue;
    let level = 'ok', why = '', error = null;
    const h = p.health;
    if (p.error && !h) { level = 'bad'; why = 'its status could not be read'; error = { at: null, message: String(p.error) }; }
    else if (h) {
      error = h.lastError || null;
      const streak = Number(h.failStreak) || 0;
      const busyClean = !!p.scanning && !streak && !error; // a long scan under way with nothing wrong
      const okAgo = ago(h.lastSuccessAt), cleanAgo = ago(h.lastCleanAt);
      if (streak >= HEALTH.badStreak) { level = 'bad'; why = `failed ${streak} times in a row`; }
      else if (!busyClean && okAgo >= HEALTH.deadMs) { level = 'bad'; why = h.lastSuccessAt ? `nothing went through for ${mins(okAgo)} min` : `nothing went through since sync started (${mins(okAgo)} min)`; }
      else if (h.backingOff) { level = 'warn'; why = `backing off${streak ? ` after ${streak} failed ${streak === 1 ? 'scan' : 'scans'}` : ''}`; }
      else if (streak >= HEALTH.warnStreak) { level = 'warn'; why = 'the last scan failed'; }
      else if (error) { level = 'warn'; why = 'the last scan hit an error'; }
      else if (!busyClean && cleanAgo >= HEALTH.staleMs) { level = 'warn'; why = `no clean scan for ${mins(cleanAgo)} min`; }
    }
    if (!worst || RANK[level] > RANK[worst.level]) worst = { level, part, name, why, error };
  }
  if (!worst || worst.level === 'ok') return { level: 'ok', part: null, name: null, why: '', error: null, tip: 'Conversation sync is healthy: every part scanned cleanly just now' };
  const w = worst, e = w.error;
  const tip = `Conversation sync: ${w.name}: ${w.why}${e && e.message ? ` (${e.message}${e.at ? `, at ${clock(e.at)}` : ''})` : ''}`;
  return { ...w, tip };
}

function createSyncRunner(o = {}) {
  const sync = o.sync;
  if (!sync || typeof sync.enabled !== 'function') throw new Error('createSyncRunner needs the sync-api object');
  const dataDir = o.dataDir;
  const log = typeof o.log === 'function' ? o.log : () => {};
  // never projectsDirs()'s list: it gives a folder two accounts share once, and the materializer then finds none for A
  const projects = typeof o.projects === 'function' ? o.projects : null;
  const roots = typeof o.roots === 'function' ? o.roots : () => [];
  const intervalMs = o.intervalMs || INTERVAL_MS;
  const checkMs = o.checkMs || CHECK_MS;
  const makeUploader = o.makeUploader || ((a) => require(path.join(__dirname, 'sync-up.js')).createUploader(a));
  const makeMaterializer = o.makeMaterializer || ((a) => require(path.join(__dirname, 'sync-down.js')).createMaterializer(a));
  const makeMover = o.makeMover || ((a) => M.createMover(a));
  const makeLive = o.makeLive || ((a) => require(path.join(__dirname, 'sync-live.js')).createLive(a));
  const makePrefs = o.makePrefs || ((a) => require(path.join(__dirname, 'sync-prefs.js')).createPrefs(a));
  const makeLink = o.makeLink || ((a) => require(path.join(__dirname, 'link.js')).createLink(a));
  const makeCarry = o.makeCarry || ((a) => require(path.join(__dirname, 'sync-carry.js')).createCarry(a));
  const notes = require(path.join(__dirname, 'sync-carry.js')).notesStore(dataDir);
  const relay = o.relay && typeof o.relay.addComputer === 'function' ? o.relay : null;
  const snapshot = typeof o.snapshot === 'function' ? o.snapshot : null;
  const boundIds = typeof o.bound === 'function' ? o.bound : null;
  const accountOf = typeof o.accountOf === 'function' ? o.accountOf : null;
  const busy = typeof o.busy === 'function' ? o.busy : null;
  const prefsOpt = o.prefs && typeof o.prefs.read === 'function' && typeof o.prefs.apply === 'function' ? o.prefs : null;
  const host = o.host && typeof o.host.list === 'function' ? o.host : null;
  const isOpenOpt = typeof o.isOpen === 'function' ? o.isOpen : null;
  // mode() -> 'local' stops sync here (null / 'sync': the other gates decide); accounts: sync-accounts.js's object
  const modeOf = typeof o.mode === 'function' ? o.mode : () => null;
  const accounts = o.accounts && typeof o.accounts.reconcile === 'function' ? o.accounts : null;
  // pinnedHere(id) -> { rule, host, note? } for a chat a stays-on rule keeps on this machine, else null: the mover
  // refuses to hand it over (mayLeave, code 'pinned'), and no turn's snapshot of its work is made
  const pinnedHere = typeof o.pinnedHere === 'function' ? o.pinnedHere : null;
  const mayLeave = (id) => {
    let p = null;
    try { p = pinnedHere(id); } catch {}
    if (!p) return true;
    return { code: 'pinned', message: p.note || 'a stays-on rule keeps it here' };
  };

  let run = null; // { uid, keyId, up, down, mover, live, prefs, link, startedAt }
  let why = 'not started'; // why it is not running, for status()
  let off = true; // and whether that is sync off here (health 'off') rather than stopped by a problem ('bad')
  let timer = null, offChange = null, checking = null, again = false, stopped = true;

  // the host's sessions that were alive at its last list (each list the mover asks for refreshes it)
  let hostAlive = new Set();
  const noteList = (l) => {
    if (Array.isArray(l)) hostAlive = new Set(l.filter((p) => p && p.alive && typeof p.id === 'string').map((p) => p.id.toLowerCase()));
    return l;
  };
  const hostFor = host ? { list: () => Promise.resolve(host.list()).then(noteList), kill: (id) => host.kill(id) } : null;
  const isOpen = (id) => {
    const k = typeof id === 'string' ? id.toLowerCase() : '';
    try { if (isOpenOpt && isOpenOpt(k)) return true; } catch {}
    return hostAlive.has(k);
  };

  const keyId = (key) => C.sha256(key).slice(0, 16); // tells a changed key apart, never shown
  // gate: sync is off here now (not set up, Work locally): nothing is away any more
  // quiet: not a problem (sync turned off here, the server stopping, or about to start again): health 'off', not 'bad'
  async function halt(reason, gate = false, quiet = gate) {
    why = reason;
    off = quiet;
    if (run) {
      const r = run;
      run = null;
      log(`sync: stopped (${reason})`);
      await Promise.allSettled([r.link ? r.link.stop() : null, r.prefs ? r.prefs.stop() : null, r.live ? r.live.stop() : null, r.mover ? r.mover.stop() : null, r.up.stop(), r.down.stop()]);
    }
    if (gate) M.dropAway(dataDir);
  }
  // one gate check at a time; a call while one runs asks for one more after it
  function check() {
    if (checking) { again = true; return checking; }
    checking = (async () => {
      do {
        again = false;
        try { await checkOnce(); } catch (e) { log(`sync: the gate check failed: ${e && e.message}`); }
      } while (again && !stopped);
    })().finally(() => { checking = null; });
    return checking;
  }
  async function checkOnce() {
    if (stopped) return halt('stopped', false, true);
    let mode = null;
    try { mode = modeOf(); } catch {}
    if (mode === 'local') return halt('this machine works locally (chosen at the start; the Sync card can switch it)', true);
    if (!sync.enabled()) return halt('sync is not set up on this PC', true);
    const st = await sync.status();
    // signed out, not a member, no key: away.json stays (halt without the gate), so the session host still refuses the
    // other devices' conversations: a lost sign-in (a restart that could not read it) must never let this machine run
    // a stale copy of a chat another machine owns. Only sync turned off (not set up, or Work locally) frees them.
    if (!st.signedIn) return halt(st.lost ? `not signed in (${st.lost})` : 'not signed in');
    if (st.member === false) return halt('this account is not on the sync members list');
    const uid = await sync.uid();
    let key = null;
    try {
      const r = await C.fetchKey(sync, S.syncDir(dataDir));
      key = r.key;
      if (r.fetched) log(r.created ? 'sync: made the sync key and put it in Blackbox' : r.replaced ? 'sync: the sync key here was not Blackbox\'s: using Blackbox\'s now' : 'sync: fetched the sync key from Blackbox');
    } catch (e) {
      return halt(`no sync key on this PC (it could not be fetched from Blackbox: ${(e && e.message) || e})`);
    }
    const kid = keyId(key);
    if (accounts) {
      const r = await accounts.reconcile({ api: sync, key });
      // a list that could not be read leaves a running sync alone, and keeps a stopped one stopped
      if (!r || (!r.ok && !(r.error && run))) return halt((r && r.reason) || 'the Claude accounts could not be checked', true, false);
    }
    if (run && run.uid === uid && run.keyId === kid) return;
    if (run) await halt(run.uid !== uid ? 'another account signed in' : 'the sync key changed', false, true);
    if (stopped) return;
    const args = { api: sync, dataDir, key, log };
    if (projects) args.projects = () => projects();
    // the uploader asks the materializer's rows whose a conversation is (no request for another device's), and holds a
    // chat mid-turn here to one upload every 45 s or so (busy)
    let down = null;
    const upArgs = { ...args, ownerOf: (id) => (down && typeof down.owner === 'function' ? down.owner(id) : null) };
    if (accountOf) upArgs.accountOf = (id) => accountOf(id);
    if (busy) upArgs.busy = (id) => busy(id);
    const up = makeUploader(upArgs);
    down = makeMaterializer({ ...args, roots: () => roots(), isOpen });
    let mover = null, link = null, carry = null;
    // the device id is the mover's (it makes the device row on its first tick): no mover, no snapshots
    const deviceId = () => { const d = mover && mover.device(); return d ? d.id : null; };
    try { carry = makeCarry({ ...args, device: deviceId, link: () => link, roots: () => roots(), ...(typeof o.stays === 'function' ? { stays: o.stays } : {}), ...(pinnedHere ? { pinnedHere: (id) => !!pinnedHere(id) } : {}) }); } catch (e) { log(`sync: a move carries the conversation alone here: ${e && e.message}`); }
    try { mover = makeMover({ ...args, up, down, host: hostFor, isOpen: isOpenOpt || (() => false), carry, ...(typeof o.trust === 'function' ? { trust: o.trust } : {}), ...(pinnedHere ? { mayLeave } : {}) }); } catch (e) { log(`sync: conversations can't move between devices here: ${e && e.message}`); }
    let live = null;
    if (mover && snapshot) {
      const liveArgs = { ...args, device: deviceId, online: (d) => (typeof mover.online === 'function' ? mover.online(d) : null),
        seenAt: (d) => (typeof mover.lastSeen === 'function' ? mover.lastSeen(d) : null), snapshot: () => snapshot() };
      if (boundIds) liveArgs.bound = () => boundIds();
      try { live = makeLive(liveArgs); } catch (e) { log(`sync: what runs on the other devices can't be shown here: ${e && e.message}`); }
    }
    let prefs = null;
    if (mover && prefsOpt) {
      const p = prefsOpt;
      try { prefs = makePrefs({ ...args, device: deviceId, read: () => p.read(), apply: (g, items) => p.apply(g, items), translate: p.translate, load: p.load, save: p.save }); } catch (e) { log(`sync: settings can't be shared with the other devices here: ${e && e.message}`); }
    }
    if (mover && relay) {
      try { link = makeLink({ ...args, device: deviceId, relay, version: o.version }); } catch (e) { log(`sync: this machine can't link with the others: ${e && e.message}`); }
    }
    run = { uid, keyId: kid, up, down, mover, live, prefs, link, carry, startedAt: new Date().toISOString() };
    why = '';
    off = false;
    if (hostFor) hostFor.list().catch(() => {});
    up.start(intervalMs);
    down.start(intervalMs);
    if (mover) mover.start();
    if (live) live.start();
    if (prefs) prefs.start();
    if (link) Promise.resolve(link.start()).catch((e) => log(`sync: the link did not start: ${e && e.message}`));
    log(`sync: running as ${st.email || 'the signed-in account'}`);
  }
  const notRunning = () => Object.assign(new Error(run ? 'conversations can\'t move between devices on this PC' : why || 'sync is not running'), { code: 'not_running' });

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      offChange = sync.onChange(() => { check(); });
      timer = setInterval(() => { check(); }, checkMs);
      if (timer.unref) timer.unref();
      return check();
    },
    async stop() {
      stopped = true;
      if (timer) { clearInterval(timer); timer = null; }
      if (offChange) { offChange(); offChange = null; }
      if (checking) await checking.catch(() => {});
      await halt('stopped', false, true);
    },
    check,
    // nothing secret: whether it runs, why not, and the two loops' own status
    // health: health() of the rest (the header pill's colour and title)
    status() {
      if (!run) { const st = { running: false, reason: why, off }; return { ...st, health: health(st) }; }
      const safe = (f) => { try { return f(); } catch (e) { return { error: e && e.message }; } };
      const st = {
        running: true,
        startedAt: run.startedAt,
        up: safe(() => run.up.status()),
        down: safe(() => run.down.status()),
        conflicts: safe(() => (typeof run.down.conflicts === 'function' ? run.down.conflicts() : [])),
        live: run.live ? safe(() => run.live.status()) : null,
        prefs: run.prefs ? safe(() => run.prefs.status()) : null,
      };
      return { ...st, health: health(st) };
    },
    move(id, opts = {}) {
      if (!run || !run.mover) throw notRunning();
      return run.mover.move(id, opts);
    },
    moveStatus(id) { return run && run.mover ? run.mover.status(id) : null; },
    cancelMove(id) { return run && run.mover ? run.mover.cancel(id) : false; },
    owners() {
      if (!run || !run.mover) return new Map();
      try { return run.mover.owners(); } catch { return new Map(); }
    },
    device() { return run && run.mover ? run.mover.device() : null; },
    live() {
      if (!run || !run.live) return null;
      try { return run.live.live(); } catch { return null; }
    },
    prefsChanged() { if (run && run.prefs) { try { run.prefs.nudge(); } catch {} } },
    link() { return run && run.link ? run.link : null; },
    // "Clone what's missing" (sync-clone.js): the materializer's missing() ({ at: null, repos: [] } while not running),
    // and rescan(): a scan now, so a repo just cloned brings its conversations without waiting for the next round
    missing() {
      if (!run || typeof run.down.missing !== 'function') return { at: null, repos: [] };
      try { return run.down.missing(); } catch { return { at: null, repos: [] }; }
    },
    rescan() { if (run && typeof run.down.scanOnce === 'function') run.down.scanOnce().catch(() => {}); },
    note(id) { try { return notes.get(id); } catch { return null; } },
    dropNote(id) { try { return notes.drop(id); } catch { return false; } },
    async peer(route, body, from) {
      if (!run || !run.mover || typeof run.mover.peer !== 'function') return [404, { ok: false, message: 'sync is not running here' }];
      return run.mover.peer(route, body, from);
    },
  };
}

module.exports = { createSyncRunner, health, HEALTH };
