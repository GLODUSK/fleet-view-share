// sync-run-test.js: sync-run.js starts the two loops and the mover only when all the gates are open (the mode is not
// local, set up, signed in, the key (fetched from Blackbox), the Claude accounts matching Blackbox's), and stops them when one closes. The mover gets the uploader, the materializer, the host and isOpen; the materializer's isOpen is
// isOpen or the host's last list; the uploader alone gets accountOf and busy, and its ownerOf is the materializer's owner(); move / moveStatus / cancelMove / owners (with the
// row's account) / device go to the mover, and say so when
// sync is not running; away.json goes when sync is turned off (not set up, Work locally) and stays otherwise (signed
// out, no key, not a member, stop()); "Start clean": skip() is the uploader's only() turned round, beforeStart runs
// before any loop (say() and a throw show as getting ready, warn), restart() runs it again. A fake sync-api object, fake loops, a fake
// mover and a fake host; a temp data folder for the key. Run: node scripts/sync-run-test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const S = require(path.join(__dirname, '..', 'sync-api.js'));
const C = require(path.join(__dirname, '..', 'sync-crypto.js'));
const SC = require(path.join(__dirname, '..', 'sync-common.js'));
const M = require(path.join(__dirname, '..', 'sync-move.js'));
const { createSyncRunner, health, HEALTH } = require(path.join(__dirname, '..', 'sync-run.js'));

let pass = 0, fail = 0;
const ok = (c, name) => { if (c) pass++; else { fail++; console.log(`FAIL ${name}`); } };
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), `${name}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

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
  const l = { kind, started: 0, stopped: 0, start() { l.started++; }, async stop() { l.stopped++; }, status: () => ({ kind }), conflicts: () => [], owners: () => new Map() };
  made.push(l);
  return l;
}
function fakeMover(args, made) {
  const m = {
    args, started: 0, stopped: 0, calls: [],
    start() { m.started++; }, async stop() { m.stopped++; },
    move(id, o) { m.calls.push(['move', id, o]); if (id === 'bad') throw Object.assign(new Error('not a conversation id'), { code: 'bad_id' }); return { id, phase: 'asking', force: !!(o && o.force) }; },
    status(id) { m.calls.push(['status', id]); return { id, phase: 'waiting' }; },
    cancel(id) { m.calls.push(['cancel', id]); return true; },
    owners: () => new Map([['c1', { device: 'd2', name: 'mac', live: true, moving: null, account: 'a' }]]),
    device: () => ({ id: 'd1', name: 'pc' }),
  };
  made.push(m);
  return m;
}

(async () => {
  const dir = fs.mkdtempSync(path.join(process.env.SYNC_TEST_DIR || os.tmpdir(), 'fv-sync-run-'));
  try {
    const sync = fakeSync(), made = [], logs = [], movers = [];
    const runner = createSyncRunner({
      sync, dataDir: dir, log: (t) => logs.push(t), projects: () => [], roots: () => ['X'], checkMs: 1e6,
      makeUploader: (a) => { ok(a.key && a.key.length === 32 && a.api === sync && Array.isArray(a.projects()), 'the uploader gets the key, the api and the projects'); return fakeLoop('up', made); },
      makeMaterializer: (a) => { ok(a.roots()[0] === 'X', 'the materializer gets the roots'); return fakeLoop('down', made); },
      makeMover: (a) => fakeMover(a, movers),
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
    ok(made.length === 0 && /no sync key.*Blackbox/.test(runner.status().reason), 'off while the key cannot be fetched from Blackbox');

    // Blackbox has the key (another machine made it): the next check fetches it, saves it here and starts
    const key = crypto.randomBytes(32), settings = [];
    let shared = key;
    sync.rest = async (method, table, o = {}) => {
      if (table !== 'settings') throw new Error(`unexpected table ${table}`);
      settings.push(method);
      return method === 'GET' ? [{ value_enc: JSON.stringify({ v: 1, key: shared.toString('base64') }) }] : null;
    };
    await runner.check();
    ok(made.length === 2 && made.every((l) => l.started === 1), 'both loops start when every gate is open');
    ok((await C.loadKey(S.syncDir(dir))).equals(key) && settings.join() === 'GET', 'the key came from Blackbox and is saved here');
    ok(logs.some((t) => /fetched the sync key from Blackbox/.test(t)), 'the log says it was fetched');
    ok(runner.status().running === true && runner.status().up.kind === 'up', 'status shows them running');
    await runner.check();
    ok(made.length === 2 && settings.join() === 'GET,GET', 'a second check with nothing changed starts nothing new (it only reads Blackbox\'s key)');

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
    // a key here that is not Blackbox's: put back to Blackbox's, nothing restarts
    await C.saveKey(S.syncDir(dir), crypto.randomBytes(32));
    await runner.check();
    ok(made.length === 6 && (await C.loadKey(S.syncDir(dir))).equals(key), 'a key here that is not Blackbox\'s is put back');
    ok(logs.some((t) => /using Blackbox's now/.test(t)), 'the log says the key here was replaced');
    // Blackbox's key made again: this machine takes it and the loops restart with it
    shared = crypto.randomBytes(32);
    await runner.check();
    ok(made.length === 8 && made[4].stopped === 1 && (await C.loadKey(S.syncDir(dir))).equals(shared), 'a changed key on Blackbox restarts them');

    await runner.stop();
    ok(made[6].stopped === 1 && made[7].stopped === 1 && sync.listeners.size === 0, 'stop() stops the loops and the listener');
    await runner.check();
    ok(made.length === 8, 'nothing starts after stop()');
    ok(!logs.some((t) => t.includes(key.toString('base64')) || t.includes(key.toString('hex'))), 'the key never reaches the log');
    // no projects given: neither side gets one, so each keeps its own A and B folders (one shared folder stays both)
    const seen = [];
    const r2 = createSyncRunner({
      sync, dataDir: dir, checkMs: 1e6,
      makeUploader: (a) => { seen.push('projects' in a || 'accountOf' in a || 'busy' in a); return fakeLoop('up', []); },
      makeMaterializer: (a) => { seen.push('projects' in a); return fakeLoop('down', []); },
    });
    await r2.start();
    ok(seen.length === 2 && seen.every((x) => x === false), 'no projects given: neither side gets a projects option (nor the uploader an accountOf or busy)');
    await r2.stop();
    ok(movers.length === 4 && movers.every((m) => m.started === 1 && m.stopped === 1), 'every run started its mover once, and every halt stopped it');

    // ---------- the mover, the host, isOpen and away.json ----------
    {
      const s3 = fakeSync();
      s3.on = true; s3.signedIn = true;
      const dir3 = path.join(dir, 'three');
      fs.mkdirSync(dir3, { recursive: true });
      await C.saveKey(S.syncDir(dir3), crypto.randomBytes(32));
      const mv = [], downs = [], ups = [], kills = [];
      let hostSessions = [{ id: 'AAAA-1', alive: true }, { id: 'bbbb-2', alive: false }];
      const host = { list: async () => hostSessions, kill: async (id) => { kills.push(id); } };
      const r3 = createSyncRunner({
        sync: s3, dataDir: dir3, checkMs: 1e6, host, isOpen: (id) => id === 'ext-3', accountOf: (id) => (id === 'c1' ? 'A' : null), busy: (id) => id === 'c1',
        makeUploader: (a) => { ups.push(a); ok(a.ownerOf('c1') === null, 'the uploader\'s ownerOf before the materializer is made: null'); return fakeLoop('up', []); },
        makeMaterializer: (a) => { downs.push(a); const l = fakeLoop('down', []); l.owner = (id) => ({ device: `d-${id}`, at: 1, checkedAt: 2 }); return l; },
        makeMover: (a) => fakeMover(a, mv),
      });
      let code = null, message = null;
      try { r3.move('c1'); } catch (e) { code = e.code; message = e.message; }
      ok(code === 'not_running' && message === 'not started', 'move() before start: not_running, with why');
      ok(r3.moveStatus('c1') === null && r3.cancelMove('c1') === false && r3.owners() instanceof Map && r3.owners().size === 0 && r3.device() === null, 'not running: moveStatus null, cancelMove false, owners empty, device null');
      await r3.start();
      const m = mv[0];
      ok(mv.length === 1 && m.started === 1, 'the mover starts with the loops');
      ok(m.args.api === s3 && m.args.dataDir === dir3 && m.args.key.length === 32 && m.args.up && m.args.up.kind === 'up' && m.args.down && m.args.down.kind === 'down', 'the mover gets the api, the data folder, the key, the uploader and the materializer');
      ok(m.args.isOpen('ext-3') === true && m.args.isOpen('x') === false, 'the mover gets isOpen');
      ok(ups[0].accountOf('c1') === 'A' && ups[0].accountOf('x') === null && !('accountOf' in downs[0]) && !('accountOf' in m.args), 'the uploader (only) gets accountOf');
      ok(ups[0].busy('c1') === true && ups[0].busy('x') === false && !('busy' in downs[0]), 'the uploader (only) gets busy');
      eq(ups[0].ownerOf('c1'), { device: 'd-c1', at: 1, checkedAt: 2 }, 'the uploader\'s ownerOf is the materializer\'s owner()');
      await m.args.host.list();
      ok(downs[0].isOpen('aaaa-1') && downs[0].isOpen('AAAA-1'), 'the materializer\'s isOpen: alive in the host\'s last list, any case');
      ok(!downs[0].isOpen('bbbb-2') && downs[0].isOpen('ext-3') && !downs[0].isOpen('cccc-3'), 'not when it ended there; yes when isOpen says so');
      hostSessions = [];
      await m.args.host.list();
      ok(!downs[0].isOpen('aaaa-1'), 'each host list the mover asks for refreshes it');
      await m.args.host.kill('AAAA-1');
      eq(kills, ['AAAA-1'], 'the mover\'s kill goes to the host');
      eq(r3.move('c1', { force: true }), { id: 'c1', phase: 'asking', force: true }, 'move() gives the mover\'s job');
      try { r3.move('bad'); } catch (e) { code = e.code; }
      eq(code, 'bad_id', 'the mover\'s bad_id comes through');
      ok(r3.moveStatus('c1').phase === 'waiting' && r3.cancelMove('c1') === true, 'moveStatus and cancelMove go to the mover');
      ok(r3.owners().get('c1').name === 'mac' && r3.owners().get('c1').account === 'a' && r3.device().name === 'pc', 'owners (with the row\'s account) and device go to the mover');
      // away.json: a lost sign-in keeps it (the host must go on refusing the other devices' chats); only sync turned
      // off here (not set up) deletes it
      SC.writeState(M.awayPath(dir3), { v: 1, at: 'x', ids: { c1: { device: 'mac', why: 'owned' } } });
      s3.signedIn = false;
      await r3.check();
      ok(m.stopped === 1 && fs.existsSync(M.awayPath(dir3)), 'signed out: the mover stops and away.json stays');
      try { r3.move('c1'); } catch (e) { code = e.code; message = e.message; }
      ok(code === 'not_running' && message === 'not signed in', 'move() while signed out: not_running, not signed in');
      for (const [what, set, unset, gone] of [
        ['no key', async () => C.forgetKey(S.syncDir(dir3)), async () => C.saveKey(S.syncDir(dir3), crypto.randomBytes(32)), false],
        ['not a member', async () => { s3.member = false; }, async () => { s3.member = true; }, false],
        ['not set up', async () => { s3.on = false; }, async () => { s3.on = true; }, true],
      ]) {
        s3.signedIn = true;
        await r3.check();
        SC.writeState(M.awayPath(dir3), { v: 1, at: 'x', ids: {} });
        await set();
        await r3.check();
        ok(fs.existsSync(M.awayPath(dir3)) === !gone && !r3.status().running, `${what}: away.json ${gone ? 'is gone' : 'stays'}`);
        await unset();
      }
      // a restart for another account keeps it (the new run writes it again); stop() keeps it (the host still needs it)
      s3.signedIn = true;
      await r3.check();
      ok(r3.status().running, 'running again');
      SC.writeState(M.awayPath(dir3), { v: 1, at: 'x', ids: {} });
      s3.who = 'u9';
      await r3.check();
      ok(fs.existsSync(M.awayPath(dir3)) && r3.status().running, 'another account: away.json stays');
      await r3.stop();
      ok(fs.existsSync(M.awayPath(dir3)) && mv.every((x) => x.stopped === 1), 'stop(): every mover stopped, away.json stays');
    }

    // ---------- the default mover; and a mover that can't be made ----------
    {
      const s4 = fakeSync();
      s4.on = true; s4.signedIn = true;
      s4.rest = async () => []; // a reachable Supabase that has nothing
      const dir4 = path.join(dir, 'four');
      fs.mkdirSync(dir4, { recursive: true });
      await C.saveKey(S.syncDir(dir4), crypto.randomBytes(32));
      const r4 = createSyncRunner({ sync: s4, dataDir: dir4, checkMs: 1e6, makeUploader: () => fakeLoop('up', []), makeMaterializer: () => fakeLoop('down', []) });
      await r4.start();
      let code = null;
      try { r4.move('6f1c2b8e-0d3a-4c5b-9e7f-1a2b3c4d5e6f'); } catch (e) { code = e.code; }
      eq(code, 'not_elsewhere', 'the default mover: a conversation no other device has is not_elsewhere');
      try { r4.move('nope'); } catch (e) { code = e.code; }
      eq(code, 'bad_id', 'the default mover: a bad id');
      ok(r4.owners().size === 0 && r4.moveStatus('6f1c2b8e-0d3a-4c5b-9e7f-1a2b3c4d5e6f') === null, 'the default mover: nothing owned elsewhere, no job');
      await r4.stop();
      const logs5 = [];
      const r5 = createSyncRunner({ sync: s4, dataDir: dir4, checkMs: 1e6, log: (t) => logs5.push(t), makeUploader: () => fakeLoop('up', []), makeMaterializer: () => fakeLoop('down', []), makeMover: () => { throw new Error('boom'); } });
      await r5.start();
      code = null;
      let message = null;
      try { r5.move('6f1c2b8e-0d3a-4c5b-9e7f-1a2b3c4d5e6f'); } catch (e) { code = e.code; message = e.message; }
      ok(r5.status().running && code === 'not_running' && /can't move between devices/.test(message) && logs5.some((t) => /boom/.test(t)), 'a mover that can\'t be made: sync runs without it, and move() says why');
      await r5.stop();
    }

    // ---------- stays-on rules: the carry gets stays and pinnedHere, the mover mayLeave (code 'pinned') ----------
    {
      const s7 = fakeSync();
      s7.on = true; s7.signedIn = true;
      s7.rest = async () => [];
      const dir7 = path.join(dir, 'seven');
      await C.saveKey(S.syncDir(dir7), crypto.randomBytes(32));
      const kept = 'aaaaaaaa-0000-4000-8000-000000000001', free = 'aaaaaaaa-0000-4000-8000-000000000002';
      let carryArgs = null;
      const mv7 = [];
      const r7 = createSyncRunner({
        sync: s7, dataDir: dir7, checkMs: 1e6, makeUploader: () => fakeLoop('up', []), makeMaterializer: () => fakeLoop('down', []),
        makeMover: (a) => fakeMover(a, mv7), makeCarry: (a) => { carryArgs = a; return { packOut() {} }; },
        stays: (root) => (root === 'R' ? ['**/*.blend'] : []),
        pinnedHere: (id) => (id === kept ? { rule: 'blender', host: 'BlackBox', note: 'Blender runs on BlackBox' } : null),
      });
      await r7.start();
      const may = mv7[0].args.mayLeave;
      ok(typeof may === 'function' && may(free) === true, 'stays-on: the mover lets a chat no rule keeps leave');
      eq(may(kept), { code: 'pinned', message: 'Blender runs on BlackBox' },'stays-on: the mover refuses one a rule keeps here');
      ok(carryArgs && carryArgs.stays('R')[0] === '**/*.blend' && carryArgs.pinnedHere(kept) === true && carryArgs.pinnedHere(free) === false, 'stays-on: the carry gets stays and pinnedHere');
      await r7.stop();
    }

    // ---------- gate 0, the mode, and gate 4, the Claude accounts ----------
    {
      const s6 = fakeSync();
      s6.on = true; s6.signedIn = true;
      const dir6 = path.join(dir, 'six');
      await C.saveKey(S.syncDir(dir6), crypto.randomBytes(32));
      let mode = 'local';
      let answer = { ok: false, reason: 'sign in Claude A to match Blackbox\'s accounts' };
      const asked = [];
      const made6 = [];
      const r6 = createSyncRunner({
        sync: s6, dataDir: dir6, checkMs: 1e6, mode: () => mode,
        accounts: { reconcile: async (a) => { asked.push(a); return answer; } },
        makeUploader: () => fakeLoop('up', made6), makeMaterializer: () => fakeLoop('down', made6), makeMover: (a) => fakeMover(a, []),
      });
      await r6.start();
      ok(!made6.length && /works locally/.test(r6.status().reason) && !asked.length, 'mode local: nothing runs and the accounts are not even read');
      mode = null;
      await r6.check();
      ok(!made6.length && r6.status().reason === answer.reason, 'accounts not matching: nothing runs, and it says why');
      ok(asked.length === 1 && asked[0].api === s6 && asked[0].key.length === 32, 'the accounts get the api and the key');
      answer = { ok: true };
      await r6.check();
      ok(made6.length === 2 && r6.status().running, 'accounts matching: sync runs');
      answer = { ok: false, error: true, reason: 'Blackbox\'s account list could not be read (offline)' };
      await r6.check();
      ok(r6.status().running && made6.length === 2, 'a list that could not be read leaves a running sync alone');
      answer = { ok: false, reason: 'sign in Claude B to match Blackbox\'s accounts' };
      await r6.check();
      ok(!r6.status().running && made6.every((l) => l.stopped === 1), 'accounts that stop matching stop sync');
      answer = { ok: false, error: true, reason: 'offline' };
      await r6.check();
      ok(!r6.status().running && made6.length === 2, 'a list that could not be read keeps a stopped sync stopped');
      // away.json stays through the accounts gate: not matching, or not readable at a start (run is null)
      SC.writeState(M.awayPath(dir6), { v: 1, at: 'x', ids: { c1: { device: 'mac', why: 'owned' } } });
      await r6.check();
      ok(!r6.status().running && fs.existsSync(M.awayPath(dir6)), 'accounts not readable with sync stopped: away.json stays');
      answer = { ok: false, reason: 'sign in Claude B to match Blackbox\'s accounts' };
      await r6.check();
      ok(!r6.status().running && fs.existsSync(M.awayPath(dir6)), 'accounts not matching: away.json stays');
      answer = { ok: true };
      mode = 'sync';
      await r6.check();
      ok(r6.status().running && made6.length === 4, 'mode sync and matching: runs again');
      mode = 'local';
      await r6.check();
      ok(!r6.status().running && made6[2].stopped === 1 && made6[3].stopped === 1, 'switching to local stops it');
      await r6.stop();
    }
    // ---------- "Start clean": skip (the uploader's only), beforeStart before any loop, restart ----------
    {
      const s7 = fakeSync();
      s7.on = true; s7.signedIn = true;
      const dir7 = path.join(dir, 'seven');
      await C.saveKey(S.syncDir(dir7), crypto.randomBytes(32));
      const made7 = [], order = [], aside = new Set(['aaaa-1']);
      let only = null, fresh = null, failWith = null, sayWhat = null, restartInside = false;
      const r7 = createSyncRunner({
        sync: s7, dataDir: dir7, checkMs: 1e6, log: () => {},
        skip: (id) => { if (id === 'throws') throw new Error('x'); return aside.has(id); },
        beforeStart: async (a) => {
          order.push('before');
          ok(a.api === s7 && typeof a.log === 'function' && typeof a.say === 'function', 'beforeStart gets the api, the log and say');
          if (sayWhat) { a.say(sayWhat); fresh = r7.status(); }
          if (failWith) throw new Error(failWith);
          if (restartInside) { restartInside = false; r7.restart('starting clean again'); }
        },
        makeUploader: (a) => { only = a.only; order.push('up'); return fakeLoop('up', made7); },
        makeMaterializer: () => fakeLoop('down', made7), makeMover: (a) => fakeMover(a, []),
      });
      sayWhat = 'starting clean: setting aside what is only here';
      failWith = 'starting clean: could not list Blackbox\'s conversations (offline)';
      await r7.start();
      ok(fresh && fresh.starting === true && fresh.reason === sayWhat && fresh.health.level === 'warn' && /getting ready: starting clean/.test(fresh.health.tip), 'say(): status says it is getting ready (warn, not bad) while beforeStart works');
      let st = r7.status();
      ok(!made7.length && !st.running && st.starting && st.reason === failWith && st.health.level === 'warn', 'beforeStart throws: no loop is made, and status says why (warn)');
      failWith = null; sayWhat = null;
      await r7.check();
      st = r7.status();
      ok(made7.length === 2 && st.running && !st.starting, 'the next check runs beforeStart again, and the loops start after it');
      eq(order, ['before', 'before', 'up'], 'beforeStart runs before the uploader is made');
      ok(typeof only === 'function' && only('aaaa-1') === false && only('bbbb-2') === true, 'skip: the uploader\'s only() leaves a set-aside conversation out');
      aside.delete('aaaa-1');
      ok(only('aaaa-1') === true, 'skip is read on every call: one taken off the list goes up');
      ok(only('throws') === false, 'skip that throws: held back');
      await r7.check();
      eq(order, ['before', 'before', 'up'], 'a check with sync running does not run beforeStart again');
      await r7.restart('starting clean');
      ok(made7[0].stopped === 1 && made7[1].stopped === 1 && made7.length === 4 && r7.status().running, 'restart(): the loops stop and start again');
      eq(order, ['before', 'before', 'up', 'before', 'up'], 'restart(): beforeStart runs again before the new loops');
      // a check under way (its status slow to answer): restart() stops the loops at once, not after it
      let release = null;
      const slow = new Promise((r) => { release = r; });
      const realStatus = s7.status;
      s7.status = async () => { await slow; return realStatus(); };
      const under = r7.check();
      const rs = r7.restart('starting clean');
      await new Promise((r) => setImmediate(r));
      ok(made7[2].stopped === 1 && made7[3].stopped === 1 && !r7.status().running, 'restart() during a slow check: the loops stop at once');
      s7.status = realStatus;
      release();
      await rs; await under;
      ok(made7.length === 6 && made7[4].stopped === 0 && r7.status().running, '...and start again once the check is through');
      eq(order, ['before', 'before', 'up', 'before', 'up', 'before', 'up'], '...with beforeStart before them');
      // restart() while beforeStart works (a second Start clean): it runs again, and the loops are made once, after it
      restartInside = true;
      await r7.restart('starting clean');
      ok(made7[4].stopped === 1 && made7.length === 8 && made7[6].stopped === 0 && r7.status().running, 'restart() during beforeStart: one set of loops, made after it ran again');
      eq(order.slice(7), ['before', 'before', 'up'], '...beforeStart ran twice before them');
      failWith = 'starting clean: could not list';
      await r7.restart('starting clean');
      ok(made7[6].stopped === 1 && made7[7].stopped === 1 && made7.length === 8 && !r7.status().running && r7.status().reason === failWith, 'restart() with beforeStart failing: stopped, nothing new made');
      await r7.stop();
      ok(!r7.status().starting && r7.status().health.level === 'off', 'stop(): no longer getting ready');
    }
    // ---------- health(): the header pill's colour from each loop's record (HEALTH holds the thresholds) ----------
    {
      const T0 = Date.parse('2026-10-12T12:00:00Z');
      const iso = (ms) => new Date(T0 + ms).toISOString();
      const clean = (ago = -10e3) => ({ lastSuccessAt: iso(ago), lastCleanAt: iso(ago), lastError: null, failStreak: 0, backingOff: false, backoffUntil: null });
      const st = (parts = {}) => ({ running: true, startedAt: iso(-3600e3), up: { health: clean(), ...parts.up }, down: { health: clean(), ...parts.down }, live: { health: clean(), ...parts.live } });
      const H = (s) => health(s, T0);
      eq(Object.keys(HEALTH).sort(), ['badStreak', 'deadMs', 'staleMs', 'warnStreak'], 'HEALTH: every threshold in one place');
      ok(H(st()).level === 'ok' && /healthy/.test(H(st()).tip), 'health: every loop clean just now: ok');
      const err = { at: iso(-5e3), message: 'Supabase said 503: down', code: null, status: 503 };
      let h = H(st({ down: { health: { ...clean(-20e3), lastError: err, failStreak: 1, backingOff: true, backoffUntil: iso(5e3) } } }));
      ok(h.level === 'warn' && h.part === 'down' && /Downloads: backing off/.test(h.tip) && h.tip.includes('Supabase said 503'), `health: a loop backing off: warn, its name and error in the tip (${h.tip})`);
      h = H(st({ up: { health: { ...clean(-20e3), lastError: err, failStreak: HEALTH.warnStreak } } }));
      ok(h.level === 'warn' && h.part === 'up' && /last scan failed/.test(h.why), `health: one failed scan: warn (${h.why})`);
      h = H(st({ live: { health: { ...clean(-20e3), lastError: err, failStreak: HEALTH.badStreak, backingOff: true } } }));
      ok(h.level === 'bad' && h.part === 'live' && /failed 3 times/.test(h.tip), `health: failed badStreak times: bad (${h.tip})`);
      h = H(st({ up: { health: { ...clean(-20e3), lastError: { ...err, status: 422 } } } }));
      ok(h.level === 'warn' && /hit an error/.test(h.why), 'health: an error on a row in the last scan: warn');
      h = H(st({ down: { health: clean(-HEALTH.staleMs - 1e3) } }));
      ok(h.level === 'warn' && /no clean scan for/.test(h.why), `health: no clean scan for staleMs: warn (${h.why})`);
      h = H(st({ down: { health: { ...clean(-HEALTH.deadMs - 60e3), lastCleanAt: iso(-HEALTH.deadMs - 60e3) } } }));
      ok(h.level === 'bad' && /nothing went through for 6 min/.test(h.why), `health: nothing through for deadMs: bad (${h.why})`);
      h = H(st({ up: { scanning: true, health: clean(-HEALTH.deadMs - 60e3) } }));
      ok(h.level === 'ok', 'health: a long scan under way with no error is not stale');
      h = H({ ...st(), startedAt: iso(-30e3), up: { health: { ...clean(), lastSuccessAt: null, lastCleanAt: null } } });
      ok(h.level === 'ok', 'health: just started, no scan through yet: ok');
      h = H(st({ up: { health: { ...clean(-20e3), lastError: err, failStreak: 1, backingOff: true } }, down: { health: { ...clean(-20e3), lastError: err, failStreak: 3 } } }));
      ok(h.level === 'bad' && h.part === 'down', 'health: the worst loop wins');
      h = H({ running: false, reason: 'not signed in', off: false });
      ok(h.level === 'bad' && /not signed in/.test(h.tip), 'health: signed out: bad');
      h = H({ running: false, reason: 'sync is not set up on this PC', off: true });
      ok(h.level === 'off', 'health: sync off here: off');
      h = H({ ...st(), up: { error: 'it broke' } });
      ok(h.level === 'bad' && h.part === 'up', 'health: a loop whose status() throws: bad');
    }

  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
