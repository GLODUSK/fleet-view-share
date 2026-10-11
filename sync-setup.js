// sync-setup.js: the first start on Henry's machines. Before the page shows anything it asks once: work locally, or
// sync with Blackbox (Henry's sync project, docs/sync.md). Sync then walks through, in order: the project's address
// and publishable key (written by itself from private.json's syncUrl and syncKey; asked only when it has none), the
// Google sign-in (only private.json's syncEmail, sync-api.js onlyEmail), the sync passphrase, the Claude accounts (each letter
// signed in as the login Blackbox has for it; sync-accounts.js moves a login that is here under another letter by
// itself), and the first pass of sync. Only then does the page open (web/setup.js draws it).
//
// Only Henry's own checkouts ask: they have private.json ({ syncName, syncEmail, syncUrl, syncKey }), which
// scripts/publish-share.js leaves out of the public share repo. A friend's install has none, never asks, and its sync
// stays off as before (no config, no network).
//
// The choice is kept in <dataDir>/sync/mode.json: { mode: 'sync' | 'local', done, at }. done: the page got past the
// start (sync ready, or "Open now"); until then it asks again at every start. No file: a machine that has sync set up
// already counts as { mode: 'sync', done: true } (the PC that synced before this existed), any other asks.
// sync-run.js's mode() gate stops sync while the mode is 'local'.
//
// Routes (fleet-view.js sends these here before sync-api.js's own):
//   GET  /sync/setup           what the start screen needs (below); a remote browser gets { ask: false } only
//   POST /sync/mode            { mode: 'sync' | 'local' }   this PC only
//   POST /sync/done            the start screen is finished (mode stays)   this PC only
//   POST /sync/connect         { url, key }: what `node sync-api.js setup` does (the same checks: a Supabase project
//                              address and its publishable key, never a secret one)   this PC only, private only
//   POST /sync/accounts/check  looks at the gates again now (a sign-in just finished) and answers the accounts part
//   GET /sync/setup -> { private, name, mode, done, ask, configured, problem, signedIn, email, member, hasKey,
//     accounts: sync-accounts.js last() | null, signins: accounts.js view().jobs, running, reason,
//     progress: { up, down } | null, ready }
//   ready: sync runs and both loops have looked once (what was on Blackbox is here, what is here is up or on its way).
'use strict';
const fs = require('fs');
const path = require('path');
const S = require(path.join(__dirname, 'sync-api.js'));
const C = require(path.join(__dirname, 'sync-crypto.js'));

const BODY_MAX = 4096;
const MODES = ['sync', 'local'];

// -> { syncName, syncEmail, connect: { url, key } | null } or null (no private.json: a friend's install)
// syncEmail: the only Google account that may sync (sync-api.js onlyEmail); connect: Blackbox's address and its
// publishable key, so the start screen connects by itself instead of asking for them
function readPrivate(appDir) {
  let j;
  try { j = JSON.parse(fs.readFileSync(path.join(appDir, 'private.json'), 'utf8')); } catch { return null; }
  if (!j || typeof j !== 'object') return null;
  const email = typeof j.syncEmail === 'string' ? j.syncEmail.trim().toLowerCase() : '';
  const u = S.checkUrl(j.syncUrl), k = S.checkKey(j.syncKey);
  return {
    syncName: typeof j.syncName === 'string' && j.syncName.trim() ? j.syncName.trim().slice(0, 40) : 'Blackbox',
    syncEmail: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null,
    connect: u.ok && k.ok ? { url: u.url, key: k.key } : null,
  };
}

function createSyncSetup(o = {}) {
  const dataDir = o.dataDir;
  const dir = S.syncDir(dataDir);
  const file = path.join(dir, 'mode.json');
  const sync = o.sync;
  const runner = o.runner || null;
  const accountSync = o.accountSync || null;
  const accountsView = typeof o.accountsView === 'function' ? o.accountsView : null; // accounts.js view(): sign-ins going on
  const log = typeof o.log === 'function' ? o.log : () => {};
  const priv = o.private !== undefined ? o.private : readPrivate(o.appDir || __dirname);

  function readMode() {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (j && MODES.includes(j.mode)) return { mode: j.mode, done: !!j.done };
    } catch {}
    return null;
  }
  function writeMode(mode, done) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ mode, done: !!done, at: new Date().toISOString() })}\n`);
    fs.renameSync(tmp, file);
  }
  // { mode, done }: the file, else a machine with sync set up is a syncing one, else nothing chosen yet
  function current() {
    const m = readMode();
    if (m) return m;
    if (sync && sync.enabled()) return { mode: 'sync', done: true };
    return { mode: null, done: false };
  }

  // sync chosen on a machine with no config yet: write it from private.json (what /sync/connect does), so the start
  // screen goes straight to the Google sign-in
  function autoConnect() {
    if (!priv || !priv.connect || !sync || sync.enabled() || current().mode !== 'sync') return false;
    S.writeConfig(dataDir, priv.connect.url, priv.connect.key);
    log(`sync: connected to ${priv.syncName} by itself (private.json)`);
    if (runner) runner.check();
    return true;
  }

  async function view(remote) {
    if (!remote) { try { autoConnect(); } catch (e) { log(`sync: could not connect by itself: ${e && e.message}`); } }
    const m = current();
    const ask = !!priv && !remote && (m.mode === null || (m.mode === 'sync' && !m.done));
    if (remote) return { ask: false, private: !!priv, mode: m.mode };
    const out = { private: !!priv, name: priv ? priv.syncName : 'Blackbox', mode: m.mode, done: m.done, ask,
      onlyEmail: priv ? priv.syncEmail : null, autoConnect: !!(priv && priv.connect) };
    if (!sync) return out;
    const st = await sync.status().catch(() => ({ configured: false }));
    Object.assign(out, {
      configured: !!st.configured, problem: st.problem || null, signedIn: !!st.signedIn, email: st.email || null,
      refused: st.refused || null,
      member: st.member === undefined ? null : st.member, hasKey: st.configured ? C.hasKey(dir) : false,
    });
    out.accounts = accountSync ? accountSync.last() : null;
    // the sign-ins going on (accounts.js jobs: status, message, the claude.ai link for a private window)
    try { out.signins = accountsView ? accountsView().jobs || {} : {}; } catch { out.signins = {}; }
    const r = runner ? runner.status() : { running: false, reason: 'not started' };
    out.running = !!r.running;
    out.reason = r.running ? '' : r.reason || '';
    const pick = (x, keys) => (x && typeof x === 'object' && !x.error ? Object.fromEntries(keys.map((k) => [k, x[k] === undefined ? null : x[k]])) : null);
    const up = r.running ? pick(r.up, ['synced', 'conversations', 'pending', 'lastScanAt']) : null;
    const down = r.running ? pick(r.down, ['laidDown', 'lastScanAt']) : null;
    out.progress = r.running ? { up, down } : null;
    out.ready = !!(r.running && up && up.lastScanAt && down && down.lastScanAt);
    return out;
  }

  // true when it answered (the route is one of these)
  function handle(req, res, pathname, h) {
    const routes = ['/sync/setup', '/sync/mode', '/sync/done', '/sync/connect', '/sync/accounts/check'];
    if (!routes.includes(pathname)) return false;
    const send = (code, body) => h.sendJson(res, code, body);
    const remote = (() => { try { return !!h.remote(req); } catch { return true; } })();
    const site = req.headers && req.headers['sec-fetch-site'];
    const pcOnly = !remote && site !== 'cross-site' && site !== 'same-site';
    const go = async () => {
      if (pathname === '/sync/setup') {
        if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, { ok: false, message: 'GET' });
        return send(200, await view(remote));
      }
      if (req.method !== 'POST') return send(405, { ok: false, message: 'POST' });
      if (!pcOnly) return send(403, { ok: false, message: 'only on the PC' });
      if (!priv) return send(404, { ok: false, message: 'no sync on this install' });
      if (pathname === '/sync/accounts/check') {
        if (runner) await runner.check();
        return send(200, { ok: true, accounts: accountSync ? accountSync.last() : null, running: !!(runner && runner.status().running) });
      }
      if (pathname === '/sync/done') {
        const m = current();
        if (m.mode !== 'sync') return send(409, { ok: false, message: 'sync is not the choice here' });
        writeMode('sync', true);
        return send(200, { ok: true });
      }
      const b = await S.readSmallJson(req, BODY_MAX);
      if (b.tooBig) return send(413, { ok: false, message: 'That is too long.' });
      if (b.bad || !b.value || typeof b.value !== 'object') return send(400, { ok: false, message: 'Send JSON.' });
      if (pathname === '/sync/mode') {
        const mode = b.value.mode;
        if (!MODES.includes(mode)) return send(400, { ok: false, message: 'mode is sync or local' });
        writeMode(mode, mode === 'local');
        log(`sync: this machine ${mode === 'local' ? 'works locally' : `syncs with ${priv.syncName}`}`);
        if (!autoConnect() && runner) runner.check();
        return send(200, { ok: true, mode });
      }
      // /sync/connect
      const u = S.checkUrl(b.value.url), k = S.checkKey(b.value.key);
      b.value = null;
      if (!u.ok) return send(400, { ok: false, field: 'url', message: `The address: ${u.message}.` });
      if (!k.ok) return send(400, { ok: false, field: 'key', message: `The key: ${k.message}.` });
      S.writeConfig(dataDir, u.url, k.key);
      log(`sync: set up for ${u.url} from the page`);
      if (runner) runner.check();
      return send(200, { ok: true });
    };
    Promise.resolve().then(go).catch((e) => {
      log(`sync: ${req.method} ${pathname} failed: ${e && e.message}`);
      if (!res.headersSent) send(500, { ok: false, message: (e && e.message) || 'failed' });
    });
    return true;
  }

  return { handle, view, mode: () => current().mode, current, private: () => priv };
}

module.exports = { createSyncSetup, readPrivate };
