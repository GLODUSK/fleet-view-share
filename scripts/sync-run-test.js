// sync-run-test.js: sync-run.js starts the two loops only when all three gates are open, and stops them when one
// closes. A fake sync-api object and fake loops; a temp data folder for the key. Run: node scripts/sync-run-test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const S = require(path.join(__dirname, '..', 'sync-api.js'));
const C = require(path.join(__dirname, '..', 'sync-crypto.js'));
const { createSyncRunner } = require(path.join(__dirname, '..', 'sync-run.js'));

let pass = 0, fail = 0;
const ok = (c, name) => { if (c) pass++; else { fail++; console.log(`FAIL ${name}`); } };

function fakeSync() {
  const listeners = new Set();
  const s = {
    on: false, signedIn: false, member: true, who: 'u1', email: 'a@b.c',
    enabled: () => s.on,
    status: async () => (s.on ? { configured: true, signedIn: s.signedIn, member: s.signedIn ? s.member : null, email: s.signedIn ? s.email : null } : { configured: false }),
    uid: async () => (s.signedIn ? s.who : null),
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    fire() { for (const fn of listeners) fn({}); },
    listeners,
  };
  return s;
}
function fakeLoop(kind, made) {
  const l = { kind, started: 0, stopped: 0, start() { l.started++; }, async stop() { l.stopped++; }, status: () => ({ kind }), conflicts: () => [] };
  made.push(l);
  return l;
}

(async () => {
  const dir = fs.mkdtempSync(path.join(process.env.SYNC_TEST_DIR || os.tmpdir(), 'fv-sync-run-'));
  try {
    const sync = fakeSync(), made = [], logs = [];
    const runner = createSyncRunner({
      sync, dataDir: dir, log: (t) => logs.push(t), projects: () => [], roots: () => ['X'], checkMs: 1e6,
      makeUploader: (a) => { ok(a.key && a.key.length === 32 && a.api === sync && Array.isArray(a.projects()), 'the uploader gets the key, the api and the projects'); return fakeLoop('up', made); },
      makeMaterializer: (a) => { ok(a.roots()[0] === 'X', 'the materializer gets the roots'); return fakeLoop('down', made); },
    });
    await runner.start();
    ok(made.length === 0 && /not set up/.test(runner.status().reason), 'off without config');
    sync.on = true;
    await runner.check();
    ok(made.length === 0 && /not signed in/.test(runner.status().reason), 'off while signed out');
    sync.signedIn = true;
    sync.member = false;
    await runner.check();
    ok(made.length === 0 && /members/.test(runner.status().reason), 'off for a non-member');
    sync.member = true;
    await runner.check();
    ok(made.length === 0 && /no sync key/.test(runner.status().reason), 'off without a key');

    const key = crypto.randomBytes(32);
    await C.saveKey(S.syncDir(dir), key);
    await runner.check();
    ok(made.length === 2 && made.every((l) => l.started === 1), 'both loops start when every gate is open');
    ok(runner.status().running === true && runner.status().up.kind === 'up', 'status shows them running');
    await runner.check();
    ok(made.length === 2, 'a second check with nothing changed starts nothing new');

    sync.signedIn = false;
    sync.fire();
    await runner.check(); // the fired check may still be running: this one waits for it and runs once more
    ok(made.every((l) => l.stopped === 1) && !runner.status().running, 'a sign-out stops both');

    sync.signedIn = true;
    await runner.check();
    ok(made.length === 4, 'a sign-in starts new loops');
    sync.who = 'u2';
    await runner.check();
    ok(made.length === 6 && made[2].stopped === 1 && made[3].stopped === 1, 'another account restarts them');
    await C.saveKey(S.syncDir(dir), crypto.randomBytes(32));
    await runner.check();
    ok(made.length === 8 && made[4].stopped === 1, 'a changed key restarts them');

    await runner.stop();
    ok(made[6].stopped === 1 && made[7].stopped === 1 && sync.listeners.size === 0, 'stop() stops the loops and the listener');
    await runner.check();
    ok(made.length === 8, 'nothing starts after stop()');
    ok(!logs.some((t) => t.includes(key.toString('base64')) || t.includes(key.toString('hex'))), 'the key never reaches the log');
    // no projects given: neither side gets one, so each keeps its own A and B folders (one shared folder stays both)
    const seen = [];
    const r2 = createSyncRunner({
      sync, dataDir: dir, checkMs: 1e6,
      makeUploader: (a) => { seen.push('projects' in a); return fakeLoop('up', []); },
      makeMaterializer: (a) => { seen.push('projects' in a); return fakeLoop('down', []); },
    });
    await r2.start();
    ok(seen.length === 2 && seen.every((x) => x === false), 'no projects given: neither side gets a projects option');
    await r2.stop();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
