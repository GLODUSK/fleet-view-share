// Tests for fv across a server restart (scripts/fv.js retrying): a call that reached nothing (refused, 503 draining) is
// tried again whatever it is; one cut off on its way only when doing it twice is safe (a read, a wait with the time it
// has left, a send or start under its clientId), with one line on stderr; any other cut call fails saying it may have
// been done. fv send and fv start give a clientId, the same on every try. Against a fake API (env.call): nothing is
// sent anywhere. node scripts/fv-retry-test.js
'use strict';
const assert = require('assert/strict');
const path = require('path');
const FV = require(path.join(__dirname, 'fv.js'));

let n = 0;
const ok = (what) => { n++; console.log(`ok ${n} - ${what}`); };
const ID = '0000000d-0000-4000-8000-000000000000';
const err = (how) => Object.assign(new Error(how === 'refused' ? 'Fleet View is not running on port 4777' : how === 'timedOut' ? 'Fleet View did not answer in time' : 'socket hang up'), { [how]: true });
// a fake API: each call takes the next of `script` (an error kind to throw, or an answer), then answers ok
function fake(script) {
  const calls = [];
  const call = async (method, p, body) => {
    calls.push({ method, p, body });
    const next = script.shift();
    if (typeof next === 'string') throw err(next);
    if (next) return next;
    return { code: 200, j: { ok: true, message: 'sent' } };
  };
  return { call, calls };
}

(async () => {
  // ---------- retrying itself ----------
  {
    const said = [];
    const f = fake(['refused', 'refused']);
    const r = await FV.retrying(f.call, (l) => said.push(l))('POST', `/sessions/${ID}/answer`, { option: 1 });
    assert.equal(r.code, 200);
    assert.equal(f.calls.length, 3);
    assert.equal(said.length, 1);
    assert.match(said[0], /not answering \(restarting\?\); trying again/);
    ok('refused (nothing reached the server): tried again whatever the call, one line on stderr');
  }
  {
    const f = fake([{ code: 503, j: { ok: false, draining: true, message: 'restarting' } }]);
    const r = await FV.retrying(f.call)('POST', '/teams/t123456/message', { text: 'x' });
    assert.equal(r.code, 200);
    assert.equal(f.calls.length, 2);
    // a plain 503 (the desktop app is not running) is an answer: no retry
    const g = fake([{ code: 503, j: { ok: false, message: 'the Fleet View desktop app is not running' } }]);
    assert.equal((await FV.retrying(g.call)('POST', '/teams/t123456/message', {})).code, 503);
    assert.equal(g.calls.length, 1);
    ok('503 draining (the server waits for sends before it restarts) is tried again; any other 503 is the answer');
  }
  {
    const f = fake(['cut']);
    const r = await FV.retrying(f.call)('GET', '/sessions', null);
    assert.equal(r.code, 200);
    assert.equal(f.calls.length, 2);
    const g = fake(['cut']);
    await assert.rejects(FV.retrying(g.call)('POST', `/sessions/${ID}/answer`, { option: 2 }), /broke off the call.*it may have been done\. Look \(fv read 0000000d/);
    assert.equal(g.calls.length, 1);
    const h = fake(['cut']);
    await assert.rejects(FV.retrying(h.call)('POST', `/sessions/${ID}/message`, { text: 'hi' }), /the message may have gone in\. Look \(fv read/);
    assert.equal(h.calls.length, 1);
    const k = fake(['timedOut']);
    await assert.rejects(FV.retrying(k.call)('POST', '/sessions', { prompt: 'x', clientId: 'abcdefgh12345678' }), /did not answer in time: the session may have started\. Look \(fv hosted\)/);
    assert.equal(k.calls.length, 1);
    ok('a cut read is tried again; a cut answer or a message without clientId fails saying it may have been done; a timeout is never tried again');
  }
  {
    // an error that is none of the client's kinds (no restart): it goes as it is, at once, read or not
    const boom = () => { throw new Error('bad token file'); };
    for (const [m, p] of [['GET', '/sessions'], ['POST', `/sessions/${ID}/message`]]) {
      let calls = 0;
      const t0 = Date.now();
      await assert.rejects(FV.retrying(async () => { calls++; boom(); })(m, p, { clientId: 'abcdefgh12345678' }), /^Error: bad token file$/);
      assert.equal(calls, 1);
      assert.ok(Date.now() - t0 < 400);
    }
    ok('any other error is no restart: never tried again, and said as it is');
  }
  {
    const f = fake(['cut', 'refused']);
    const t0 = Date.now();
    const r = await FV.retrying(f.call)('POST', `/sessions/${ID}/message`, { text: 'hi', clientId: 'abcdefgh12345678', wait: 60 });
    assert.equal(r.code, 200);
    assert.equal(f.calls.length, 3);
    assert.ok(f.calls.every((c) => c.body.clientId === 'abcdefgh12345678'), 'the same clientId every time');
    assert.ok(Date.now() - t0 >= 1400, 'it waited between tries');
    // a wait goes on for the time it has left (the API's default 1800 s when none was given)
    const w = fake(['cut', 'refused']);
    await FV.retrying(w.call)('POST', `/sessions/${ID}/wait`, {});
    assert.equal(w.calls[0].body.timeout, undefined);
    assert.ok(w.calls[2].body.timeout <= 1800 && w.calls[2].body.timeout >= 1797, JSON.stringify(w.calls[2].body));
    ok('a send under its clientId is tried again with the same id; a wait with the seconds it has left');
  }

  // ---------- fv send and fv start ----------
  {
    const f = fake(['cut', { code: 200, j: { ok: true, id: ID, repeat: true, message: 'sent before Fleet View restarted (not typed again)' } }]);
    const out = [], errs = [];
    const code = await FV.main(['send', ID, 'run the tests'], { call: f.call }, (l) => out.push(l), (l) => errs.push(l));
    assert.equal(code, 0, errs.join('\n'));
    const sends = f.calls.filter((c) => /\/message$/.test(c.p));
    assert.equal(sends.length, 2);
    assert.match(sends[0].body.clientId, /^[A-Za-z0-9_-]{16}$/);
    assert.equal(sends[1].body.clientId, sends[0].body.clientId);
    assert.deepEqual(out, ['sent before Fleet View restarted (not typed again)']);
    assert.ok(errs.some((l) => /trying again/.test(l)));
    // a repeat a restart left unknown: the server's 409 maybeSent, said as it is
    const g = fake([{ code: 409, j: { ok: false, maybeSent: true, message: 'Fleet View restarted while sending it, and its transcript does not show it: look at it' } }]);
    const errs2 = [];
    assert.equal(await FV.main(['send', ID, 'x'], { call: g.call }, () => {}, (l) => errs2.push(l)), 1);
    assert.match(errs2[0], /^fv: Fleet View restarted while sending it/);
    const s = fake([]);
    await FV.main(['start', __dirname, 'look around'], { call: s.call }, () => {}, () => {});
    assert.match(s.calls.find((c) => c.p === '/sessions').body.clientId, /^[A-Za-z0-9_-]{16}$/);
    ok('fv send and fv start carry a clientId, the same on the try again; a repeat\'s answer and 409 maybeSent are said as the server says them');
  }

  console.log(`\nall ${n} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
