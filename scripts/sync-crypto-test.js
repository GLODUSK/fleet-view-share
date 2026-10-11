// Sync crypto: a test of sync-crypto.js, run with the system node:   node scripts/sync-crypto-test.js
// Seal and open round trips (text, binary, empty, gzip chunks); a wrong key, a wrong label (the blob moved elsewhere),
// a flipped byte, a cut blob or a missing FVS1 header never open; a gzip bomb is refused. The key: the first machine
// makes it and puts it in Blackbox's settings, a second machine fetches the same one, a key already here asks Blackbox
// nothing, two machines at once keep the first row, a damaged row is refused and saves nothing; the key is kept in the
// protected 'sync-key' store beside, never over, the sign-in.
// Everything happens in a temp folder, deleted at the end. Exit 0 = all pass.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const C = require(path.join(ROOT, 'sync-crypto.js'));
const S = require(path.join(ROOT, 'sync-api.js'));
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sync-crypto-test-')));

let failures = 0, passes = 0;
const ok = (cond, what) => { if (cond) passes++; else { failures++; console.log(`FAIL ${what}`); } };
const throwsCode = (fn, code, what) => { try { fn(); ok(false, `${what}: it did not throw`); } catch (e) { ok(e.code === code, `${what}: ${e.code} ${e.message}`); } };
async function rejectsCode(p, code, what) { try { await p; ok(false, `${what}: it did not fail`); } catch (e) { ok(e.code === code, `${what}: ${e.code} ${e.message}`); } }

// a fake api.rest for the settings table (one user)
function fakeApi() {
  const rows = new Map();
  return {
    rows,
    async rest(method, table, o = {}) {
      if (table !== 'settings') throw new Error(`unexpected table ${table}`);
      if (method === 'GET') { const k = String(o.query.key).replace(/^eq\./, ''); return rows.has(k) ? [{ value_enc: rows.get(k) }] : []; }
      if (method === 'POST') { if (!rows.has(o.body.key) || !/ignore-duplicates/.test(o.prefer)) rows.set(o.body.key, o.body.value_enc); return null; }
      throw new Error(`unexpected ${method}`);
    },
  };
}

async function main() {
  const key = crypto.randomBytes(32), other = crypto.randomBytes(32);
  for (const [what, data] of [['text', 'héllo 中 world'], ['binary', crypto.randomBytes(5000)], ['empty', Buffer.alloc(0)]]) {
    const blob = C.seal(data, key, 'transcripts/x/main/0/0');
    ok(blob.subarray(0, 4).toString() === 'FVS1', `${what}: FVS1 header`);
    const back = C.open(blob, key, 'transcripts/x/main/0/0');
    ok(Buffer.compare(back, Buffer.isBuffer(data) ? data : Buffer.from(data)) === 0, `${what}: round trip`);
  }
  const a = C.seal('same', key, 'l'), b = C.seal('same', key, 'l');
  ok(!a.equals(b), 'a new IV each time');
  const blob = C.seal('secret text', key, 'here');
  ok(!blob.includes(Buffer.from('secret text')), 'no plain text in the blob');
  throwsCode(() => C.open(blob, other, 'here'), 'bad_blob', 'another key does not open it');
  throwsCode(() => C.open(blob, key, 'there'), 'bad_blob', 'another label (a moved blob) does not open it');
  const flipped = Buffer.from(blob); flipped[20] ^= 1;
  throwsCode(() => C.open(flipped, key, 'here'), 'bad_blob', 'a flipped byte does not open');
  throwsCode(() => C.open(blob.subarray(0, blob.length - 1), key, 'here'), 'bad_blob', 'a cut blob does not open');
  throwsCode(() => C.open(Buffer.concat([Buffer.from('XXXX'), blob.subarray(4)]), key, 'here'), 'bad_blob', 'no FVS1 header');
  throwsCode(() => C.open(Buffer.alloc(10), key, 'here'), 'bad_blob', 'too short');
  throwsCode(() => C.seal('x', Buffer.alloc(16), 'l'), 'bad_key', 'a 16-byte key is refused');
  throwsCode(() => C.seal('x', key, ''), 'bad_request', 'an empty label is refused');

  const log = Buffer.from(Array.from({ length: 2000 }, (_, i) => `{"type":"user","n":${i}}\n`).join(''));
  const chunk = C.sealChunk(log, key, 'c');
  ok(chunk.length < log.length / 3, `chunks are gzipped (${chunk.length} of ${log.length})`);
  ok(Buffer.compare(C.openChunk(chunk, key, 'c'), log) === 0, 'chunk round trip');
  throwsCode(() => C.openChunk(C.seal(Buffer.from('not gzip'), key, 'c'), key, 'c'), 'bad_blob', 'a sealed non-gzip chunk is an error');
  const bomb = C.seal(zlib.gzipSync(Buffer.alloc(65 * 1024 * 1024)), key, 'c');
  throwsCode(() => C.openChunk(bomb, key, 'c'), 'bad_blob', 'a chunk inflating past 64 MB is refused');
  const t = C.sealText('My title', key, 'title:abc');
  ok(/^[A-Za-z0-9+/=]+$/.test(t) && C.openText(t, key, 'title:abc') === 'My title', 'sealText / openText');
  ok(C.sha256(Buffer.from('abc')) === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'sha256');

  // two machines and one settings table
  const api = fakeApi();
  const dirA = path.join(T, 'a', 'sync'), dirB = path.join(T, 'b', 'sync');
  ok((await C.loadKey(dirA)) === null && C.hasKey(dirA) === false, 'no key at first');
  const rA = await C.fetchKey(api, dirA);
  ok(rA.created === true && rA.fetched === true && rA.key.length === 32, 'the first machine makes it');
  const stored = JSON.parse(api.rows.get('sync-key'));
  ok(stored.v === 1 && Buffer.from(stored.key, 'base64').equals(rA.key), 'Blackbox holds it in the sync-key setting');
  const keyA = await C.loadKey(dirA);
  ok(keyA && keyA.equals(rA.key) && C.hasKey(dirA) === true, 'the key is saved on the first machine (hasKey says so)');
  const rB = await C.fetchKey(api, dirB);
  ok(rB.created === false && rB.fetched === true && (await C.loadKey(dirB)).equals(keyA), 'a second machine fetches the same key');
  ok(C.openText(C.sealText('across', keyA, 'x'), await C.loadKey(dirB), 'x') === 'across', 'what one machine seals the other opens');
  const quiet = { rest: async () => { throw new Error('asked Blackbox'); } };
  ok((await C.fetchKey(quiet, dirB)).fetched === false, 'a key already here asks Blackbox nothing');
  // two machines at once: the other one's row lands first, this one keeps that
  const race = fakeApi(), theirs = crypto.randomBytes(32);
  const get = race.rest;
  let first = true;
  race.rest = async (method, table, o) => {
    if (method === 'POST' && first) { first = false; race.rows.set('sync-key', JSON.stringify({ v: 1, key: theirs.toString('base64') })); }
    return get(method, table, o);
  };
  const dirC = path.join(T, 'c', 'sync');
  const rC = await C.fetchKey(race, dirC);
  ok(rC.created === false && rC.key.equals(theirs) && (await C.loadKey(dirC)).equals(theirs), 'a race keeps the first row');
  const broken = fakeApi();
  broken.rows.set('sync-key', '{"v":1,"key":"c2hvcnQ="}');
  const dirD = path.join(T, 'd', 'sync');
  await rejectsCode(C.fetchKey(broken, dirD), 'bad_blob', 'a damaged sync-key row is refused');
  ok((await C.loadKey(dirD)) === null, '... and saves nothing');
  const signIn = S.protectedStore(path.join(T, 'a'), 'other'); // a neighbour in another folder stays apart
  await signIn.write('neighbour');
  ok(fs.readdirSync(dirA).some((f) => f.startsWith('sync-key.')) && !fs.readdirSync(dirA).some((f) => f.startsWith('session.')), 'the key is in sync-key.*, not the sign-in\'s session.*');
  await C.forgetKey(dirA);
  ok((await C.loadKey(dirA)) === null && !C.hasKey(dirA) && (await signIn.read()) === 'neighbour', 'forgetKey removes only the key');
}

main().catch((e) => { failures++; console.log(`FAIL the test crashed: ${e && e.stack}`); }).finally(() => {
  try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
  console.log(`${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
});
