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
//   createSyncRunner({ sync, dataDir, log, projects, roots, host, isOpen, mode, accounts, snapshot, accountOf,
//                      intervalMs, checkMs, prefs, relay, version, makeUploader, makeMaterializer, makeMover, makeLive,
//                      makePrefs, makeLink })
//     -> { start(), stop(), check(), status(), move(id, { force }), moveStatus(id), cancelMove(id), owners(), device(),
//          live(), prefsChanged(), link(), missing(), rescan() }
//   sync: sync-api.js createSync()'s object; projects: () => [{ account, dir }], every account's folder even when two
//   are one (by default each side's own: ~/.claude and ~/.claude-a); accountOf(id) -> the account a conversation ran
//   under here or null (fleet-view.js: its claude process, or remembered), the uploader's option of that name, so its
//   row says a when it ran on A in a folder A shares with B; roots: () => [repo folders] (the
//   repos Fleet View lists; the materializer matches a synced repo's origin against them). host: { list() ->
//   Promise<desktop/host.js list()'s items | null>, kill(id) -> Promise } (api.js hostList / hostKill); isOpen(id) ->
//   true while a Claude Code process here has it open (fleet-view.js's live pid files). The materializer never lays
//   down a conversation that isOpen, or the host's last list (alive), says is open. makeUploader, makeMaterializer and
//   makeMover are for tests; by default sync-up.js createUploader, sync-down.js createMaterializer and sync-move.js
//   createMover.
//
// "Continue here" (sync-move.js), each safe to call while sync is not running:
//   move(id, { force }) -> the job (sync-move.js's job JSON) at once; the work goes on in the background. Throws an
//     Error with .code 'not_running' (its message says why sync is not running), 'bad_id' or 'not_elsewhere' (no
//     other device has it). A second move() of the same id gives the same job; force: true forces it.
//   moveStatus(id) -> the job | null      cancelMove(id) -> true when it was stopped
//   owners() -> Map id -> { device, name, live, moving, account }: conversations another device owns (live: its lease
//     is ahead; account: its row's, 'a' | 'b' | null), and this device's own moves (moving 'here' or 'away'); an empty
//     Map while not running
//   device() -> { id, name } of this device | null
// What runs where (sync-live.js), beside the mover and only with it (it needs the mover's device id): snapshot() ->
// the conversations this device owns, as fleet-view.js's /state shows them, published for the other devices;
//   live() -> sync-live.js live(): the other devices' fresh snapshots | null while not running (or no snapshot given)
// The shared settings (sync-prefs.js), beside the mover and only with it (the same device id): prefs: { read(),
// apply(group, items), translate, load(), save(state) } (sync-prefs.js createPrefs's options of those names);
//   prefsChanged() -> a local save: the prefs loop runs a round soon (nothing while not running)
// The link between machines (link.js, docs/link.md), beside the mover and only with it (it names this machine by the
// mover's device id) and only when a relay is given (relay.js: link.js keeps the other machine there as a computer):
//   link() -> link.js's object while sync runs, else null. Stopped with sync: no socket, no timer, no key read
// <dataDir>/sync/away.json (what the session host refuses to open, sync-move.js) is deleted when sync stops for a
// gate (not set up, signed out, not a member, no key), and kept when the server stops: the host still needs it.
'use strict';
const path = require('path');
const S = require(path.join(__dirname, 'sync-api.js'));
const C = require(path.join(__dirname, 'sync-crypto.js'));
const M = require(path.join(__dirname, 'sync-move.js'));

const CHECK_MS = 60e3;
const INTERVAL_MS = 5e3;

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
  const relay = o.relay && typeof o.relay.addComputer === 'function' ? o.relay : null;
  const snapshot = typeof o.snapshot === 'function' ? o.snapshot : null;
  const accountOf = typeof o.accountOf === 'function' ? o.accountOf : null;
  const prefsOpt = o.prefs && typeof o.prefs.read === 'function' && typeof o.prefs.apply === 'function' ? o.prefs : null;
  const host = o.host && typeof o.host.list === 'function' ? o.host : null;
  const isOpenOpt = typeof o.isOpen === 'function' ? o.isOpen : null;
  // mode() -> 'local' stops sync here (null / 'sync': the other gates decide); accounts: sync-accounts.js's object
  const modeOf = typeof o.mode === 'function' ? o.mode : () => null;
  const accounts = o.accounts && typeof o.accounts.reconcile === 'function' ? o.accounts : null;

  let run = null; // { uid, keyId, up, down, mover, live, prefs, link }
  let why = 'not started'; // why it is not running, for status()
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
  // gate: it stopped because a gate closed (not because the server stops): nothing is away any more
  async function halt(reason, gate = false) {
    why = reason;
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
    if (stopped) return halt('stopped');
    let mode = null;
    try { mode = modeOf(); } catch {}
    if (mode === 'local') return halt('this machine works locally (chosen at the start; the Sync card can switch it)', true);
    if (!sync.enabled()) return halt('sync is not set up on this PC', true);
    const st = await sync.status();
    if (!st.signedIn) return halt('not signed in', true);
    if (st.member === false) return halt('this account is not on the sync members list', true);
    const uid = await sync.uid();
    let key = null;
    try {
      const r = await C.fetchKey(sync, S.syncDir(dataDir));
      key = r.key;
      if (r.fetched) log(r.created ? 'sync: made the sync key and put it in Blackbox' : r.replaced ? 'sync: the sync key here was not Blackbox\'s: using Blackbox\'s now' : 'sync: fetched the sync key from Blackbox');
    } catch (e) {
      return halt(`no sync key on this PC (it could not be fetched from Blackbox: ${(e && e.message) || e})`, true);
    }
    const kid = keyId(key);
    if (accounts) {
      const r = await accounts.reconcile({ api: sync, key });
      // a list that could not be read leaves a running sync alone, and keeps a stopped one stopped
      if (!r || (!r.ok && !(r.error && run))) return halt((r && r.reason) || 'the Claude accounts could not be checked', true);
    }
    if (run && run.uid === uid && run.keyId === kid) return;
    if (run) await halt(run.uid !== uid ? 'another account signed in' : 'the sync key changed');
    if (stopped) return;
    const args = { api: sync, dataDir, key, log };
    if (projects) args.projects = () => projects();
    const up = makeUploader(accountOf ? { ...args, accountOf: (id) => accountOf(id) } : args);
    const down = makeMaterializer({ ...args, roots: () => roots(), isOpen });
    let mover = null;
    try { mover = makeMover({ ...args, up, down, host: hostFor, isOpen: isOpenOpt || (() => false) }); } catch (e) { log(`sync: conversations can't move between devices here: ${e && e.message}`); }
    // the device id is the mover's (it makes the device row on its first tick): no mover, no snapshots
    const deviceId = () => { const d = mover.device(); return d ? d.id : null; };
    let live = null;
    if (mover && snapshot) {
      try { live = makeLive({ ...args, device: deviceId, online: (d) => (typeof mover.online === 'function' ? mover.online(d) : null), snapshot: () => snapshot() }); } catch (e) { log(`sync: what runs on the other devices can't be shown here: ${e && e.message}`); }
    }
    let prefs = null;
    if (mover && prefsOpt) {
      const p = prefsOpt;
      try { prefs = makePrefs({ ...args, device: deviceId, read: () => p.read(), apply: (g, items) => p.apply(g, items), translate: p.translate, load: p.load, save: p.save }); } catch (e) { log(`sync: settings can't be shared with the other devices here: ${e && e.message}`); }
    }
    let link = null;
    if (mover && relay) {
      try { link = makeLink({ ...args, device: deviceId, relay, version: o.version }); } catch (e) { log(`sync: this machine can't link with the others: ${e && e.message}`); }
    }
    run = { uid, keyId: kid, up, down, mover, live, prefs, link };
    why = '';
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
      await halt('stopped');
    },
    check,
    // nothing secret: whether it runs, why not, and the two loops' own status
    status() {
      if (!run) return { running: false, reason: why };
      const safe = (f) => { try { return f(); } catch (e) { return { error: e && e.message }; } };
      return {
        running: true,
        up: safe(() => run.up.status()),
        down: safe(() => run.down.status()),
        conflicts: safe(() => (typeof run.down.conflicts === 'function' ? run.down.conflicts() : [])),
        live: run.live ? safe(() => run.live.status()) : null,
        prefs: run.prefs ? safe(() => run.prefs.status()) : null,
      };
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
  };
}

module.exports = { createSyncRunner };
