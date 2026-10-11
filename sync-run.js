// sync-run.js: runs conversation sync inside the server. It starts the uploader (sync-up.js), the materializer
// (sync-down.js) and the mover (sync-move.js, "Continue here") when all three gates are open, and stops them when any
// one closes:
//   1. sync is set up on this PC (<dataDir>/sync/config.json, sync-api.js enabled())
//   2. someone is signed in, and the server has not said they are off the members list (sync-api.js status())
//   3. the sync key is on this PC (sync-crypto.js loadKey: the page's Sync card or `node sync-crypto.js passphrase`
//      saves it)
// The gates are looked at when sync-api.js reports a sign-in, a sign-out or a key saved from the page (onChange,
// 'key-saved'), and once a minute (a key saved
// from a terminal, a config written by `sync-api.js setup`). Off by default: a PC with none of the three runs no loop,
// sets no timer beyond the minute check and reaches no network.
//
//   createSyncRunner({ sync, dataDir, log, projects, roots, host, isOpen, intervalMs, checkMs, makeUploader,
//                      makeMaterializer, makeMover })
//     -> { start(), stop(), check(), status(), move(id, { force }), moveStatus(id), cancelMove(id), owners(), device() }
//   sync: sync-api.js createSync()'s object; projects: () => [{ account, dir }], every account's folder even when two
//   are one (by default each side's own: ~/.claude and ~/.claude-a); roots: () => [repo folders] (the
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
//   owners() -> Map id -> { device, name, live, moving }: conversations another device owns (live: its lease is
//     ahead), and this device's own moves (moving 'here' or 'away'); an empty Map while not running
//   device() -> { id, name } of this device | null
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
  const host = o.host && typeof o.host.list === 'function' ? o.host : null;
  const isOpenOpt = typeof o.isOpen === 'function' ? o.isOpen : null;

  let run = null; // { uid, keyId, up, down, mover }
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
      await Promise.allSettled([r.mover ? r.mover.stop() : null, r.up.stop(), r.down.stop()]);
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
    if (!sync.enabled()) return halt('sync is not set up on this PC', true);
    const st = await sync.status();
    if (!st.signedIn) return halt('not signed in', true);
    if (st.member === false) return halt('this account is not on the sync members list', true);
    const uid = await sync.uid();
    const key = await C.loadKey(S.syncDir(dataDir));
    if (!key) return halt('no sync key on this PC (set the passphrase in the Sync card, or node sync-crypto.js passphrase)', true);
    const kid = keyId(key);
    if (run && run.uid === uid && run.keyId === kid) return;
    if (run) await halt(run.uid !== uid ? 'another account signed in' : 'the sync key changed');
    if (stopped) return;
    const args = { api: sync, dataDir, key, log };
    if (projects) args.projects = () => projects();
    const up = makeUploader(args);
    const down = makeMaterializer({ ...args, roots: () => roots(), isOpen });
    let mover = null;
    try { mover = makeMover({ ...args, up, down, host: hostFor, isOpen: isOpenOpt || (() => false) }); } catch (e) { log(`sync: conversations can't move between devices here: ${e && e.message}`); }
    run = { uid, keyId: kid, up, down, mover };
    why = '';
    if (hostFor) hostFor.list().catch(() => {});
    up.start(intervalMs);
    down.start(intervalMs);
    if (mover) mover.start();
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
  };
}

module.exports = { createSyncRunner };
