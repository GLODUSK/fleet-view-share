// sync-run.js: runs conversation sync inside the server. It starts the uploader (sync-up.js) and the materializer
// (sync-down.js) when all three gates are open, and stops them when any one closes:
//   1. sync is set up on this PC (<dataDir>/sync/config.json, sync-api.js enabled())
//   2. someone is signed in, and the server has not said they are off the members list (sync-api.js status())
//   3. the sync key is on this PC (sync-crypto.js loadKey: the page's Sync card or `node sync-crypto.js passphrase`
//      saves it)
// The gates are looked at when sync-api.js reports a sign-in, a sign-out or a key saved from the page (onChange,
// 'key-saved'), and once a minute (a key saved
// from a terminal, a config written by `sync-api.js setup`). Off by default: a PC with none of the three runs no loop,
// sets no timer beyond the minute check and reaches no network.
//
//   createSyncRunner({ sync, dataDir, log, projects, roots, intervalMs, checkMs, makeUploader, makeMaterializer })
//     -> { start(), stop(), check(), status() }
//   sync: sync-api.js createSync()'s object; projects: () => [{ account, dir }], every account's folder even when two
//   are one (by default each side's own: ~/.claude and ~/.claude-a); roots: () => [repo folders] (the
//   repos Fleet View lists; the materializer matches a synced repo's origin against them). makeUploader and
//   makeMaterializer are for tests; by default sync-up.js createUploader and sync-down.js createMaterializer.
'use strict';
const path = require('path');
const S = require(path.join(__dirname, 'sync-api.js'));
const C = require(path.join(__dirname, 'sync-crypto.js'));

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

  let run = null; // { uid, keyId, up, down }
  let why = 'not started'; // why it is not running, for status()
  let timer = null, offChange = null, checking = null, again = false, stopped = true;

  const keyId = (key) => C.sha256(key).slice(0, 16); // tells a changed key apart, never shown
  async function halt(reason) {
    why = reason;
    if (!run) return;
    const r = run;
    run = null;
    log(`sync: stopped (${reason})`);
    await Promise.allSettled([r.up.stop(), r.down.stop()]);
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
    if (!sync.enabled()) return halt('sync is not set up on this PC');
    const st = await sync.status();
    if (!st.signedIn) return halt('not signed in');
    if (st.member === false) return halt('this account is not on the sync members list');
    const uid = await sync.uid();
    const key = await C.loadKey(S.syncDir(dataDir));
    if (!key) return halt('no sync key on this PC (set the passphrase in the Sync card, or node sync-crypto.js passphrase)');
    const kid = keyId(key);
    if (run && run.uid === uid && run.keyId === kid) return;
    if (run) await halt(run.uid !== uid ? 'another account signed in' : 'the sync key changed');
    if (stopped) return;
    const args = { api: sync, dataDir, key, log };
    if (projects) args.projects = () => projects();
    const up = makeUploader(args);
    const down = makeMaterializer({ ...args, roots: () => roots() });
    run = { uid, keyId: kid, up, down };
    why = '';
    up.start(intervalMs);
    down.start(intervalMs);
    log(`sync: running as ${st.email || 'the signed-in account'}`);
  }

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
  };
}

module.exports = { createSyncRunner };
