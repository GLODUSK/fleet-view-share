// fv-ids-test.js: fv's short conversation ids (Fleet View #544). The first 8+ characters of an id name any conversation
// fv open could open, one that left the map too: GET /api/conversations?prefix= answers { ids } from every log on disk
// (api.js idsWithPrefix over fleet-view.js's idsStartingWith), and scripts/fv.js resolveId asks it, with the hosted
// sessions, keeps the "matches 2 conversations" refusal, and falls back to the whole list on a server from before
// ?prefix=. Last, a --demo server on a spare port with its own data folder routes ?prefix= (and refuses a bad one).
// Run: node scripts/fv-ids-test.js (exit 0 = all pass)
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const API = require(path.join(__dirname, '..', 'api.js'));
const FV = require(path.join(__dirname, 'fv.js'));

let n = 0;
const ok = (what) => { n++; console.log(`ok ${n} - ${what}`); };
const OFF = '2fdc63cf-6a4e-463b-a336-5da86a4f7dd0'; // the issue's conversation: on disk, off the map
const ON = '0a2cc1d1-5098-4aa6-93a7-2f686f18ce13';
const TWIN = '2fdc63cf-0000-4000-8000-000000000001';
const HOSTED = '7f00aa11-2222-4333-8444-555566667777';

async function helpers() {
  // ---------- idsWithPrefix ----------
  assert.deepStrictEqual(API.idsWithPrefix('2fdc63cf', [ON], new Set([OFF.toUpperCase(), 'demo-1', 'new-3']).values(), [OFF]), [OFF]);
  assert.deepStrictEqual(API.idsWithPrefix('2FDC63CF', [OFF, TWIN]), [TWIN, OFF].sort());
  assert.deepStrictEqual(API.idsWithPrefix('', [OFF]), []);
  assert.deepStrictEqual(API.idsWithPrefix('2fdc63cf-6a4e', [OFF, TWIN]), [OFF]);
  assert.deepStrictEqual(API.idsWithPrefix('2fdc63cf', null, undefined, []), []);
  ok('idsWithPrefix: across lists, any case in, lowercase out, each once, conversation ids only (not demo- or new- keys)');

  // ---------- GET /api/conversations?prefix= ----------
  const asked = [];
  const ctx = { idsStartingWith: (p) => { asked.push(p); return [OFF.toUpperCase(), OFF, TWIN, 'demo-3']; }, conversations: () => { throw new Error('not for a prefix'); } };
  const q = (s) => new URLSearchParams(s);
  let [code, j] = await API.listConversations(q('prefix=2FDC63CF'), ctx);
  assert.strictEqual(code, 200);
  assert.deepStrictEqual(j, { ok: true, prefix: '2fdc63cf', ids: [TWIN, OFF].sort() });
  assert.deepStrictEqual(asked, ['2fdc63cf']);
  ok('?prefix= answers every id the server knows that starts with it (lowercased, each once), not the conversation list');
  for (const bad of ['', '2fdc63c', 'zzzzzzzz', '2fdc63cf/..', 'a'.repeat(37)]) {
    [code, j] = await API.listConversations(q(`prefix=${encodeURIComponent(bad)}`), ctx);
    assert.strictEqual(code, 400, bad);
    assert.match(j.message, /first 8 or more characters/);
  }
  assert.strictEqual(asked.length, 1);
  ok('?prefix= under 8 characters, not hex, or longer than an id is 400, and nothing is looked up');
  // a ctx without idsStartingWith (an embedder from before it): the whole list, hidden ones too
  let want = null;
  [code, j] = await API.listConversations(q('prefix=0a2cc1d1'), { conversations: (o) => { want = o; return [{ id: ON }, { id: OFF }]; } });
  assert.deepStrictEqual([code, j.ids, want.all], [200, [ON], true]);
  ok('without ctx.idsStartingWith it matches against the whole list, hidden ones too');
  assert.ok(API.ENDPOINTS.some((e) => e.path === '/api/conversations' && /prefix/.test(e.query)), 'GET /api lists prefix');
  ok('GET /api lists the prefix query');
}

// ---------- fv.js resolveId ----------
async function resolve() {
  const calls = [];
  // conv: what GET /conversations?prefix= answers (null: a server from before it, which lists conversations)
  const fake = ({ conv = [], list = [], hosted = [], code = 200 } = {}) => async (method, p) => {
    calls.push(p);
    if (p.startsWith('/conversations?prefix=')) {
      if (code !== 200) return { code, j: { ok: false, message: 'server down' } };
      return conv === null ? { code: 200, j: { ok: true, conversations: list.slice(0, 100).map((id) => ({ id })) } } : { code: 200, j: { ok: true, ids: conv } };
    }
    if (p.startsWith('/conversations?all=1')) return { code: 200, j: { ok: true, conversations: list.map((id) => ({ id })) } };
    if (p === '/sessions') return { code: 200, j: { ok: true, sessions: hosted.map((id) => ({ id })) } };
    return { code: 404, j: { ok: false, message: 'not found' } };
  };
  const refused = async (call, given, re) => {
    let err = null;
    try { await FV.resolveId(call, given); } catch (e) { err = e; }
    assert.ok(err, `${given}: refused`);
    assert.match(err.message, re);
    return err;
  };

  // the issue: off the map, so not on /state's list, but its log is on disk
  calls.length = 0;
  assert.strictEqual(await FV.resolveId(fake({ conv: [OFF], list: [ON] }), '2fdc63cf'), OFF);
  assert.deepStrictEqual(calls.sort(), ['/conversations?prefix=2fdc63cf', '/sessions']);
  ok('fv: an 8-character prefix of a conversation off the map resolves (one ?prefix= call and /sessions, not the whole list)');
  assert.strictEqual(await FV.resolveId(fake({ conv: [OFF] }), '2FDC63CF-6a4e'), OFF);
  ok('fv: any case, and a longer prefix with its dash, resolve the same');
  assert.strictEqual(await FV.resolveId(fake({ conv: [], hosted: [HOSTED] }), '7f00aa11'), HOSTED);
  ok('fv: a hosted session the list does not have yet resolves from /sessions');
  await refused(fake({ conv: [OFF, TWIN] }), '2fdc63cf', new RegExp(`2fdc63cf matches 2 conversations: .*${TWIN}.*give more characters`));
  await refused(fake({ conv: [OFF], hosted: [TWIN] }), '2fdc63cf', /matches 2 conversations/);
  ok('fv: several matches (on disk or hosted) still refuse with the list');
  await refused(fake({ conv: [], hosted: [HOSTED] }), 'deadbeef', /no conversation id starts with deadbeef/);
  ok('fv: no match says so');
  await refused(fake({ code: 503, hosted: [] }), 'deadbeef', /server down/);
  ok('fv: a server that cannot answer and no hosted match: its message');

  // a server from before ?prefix= ignores it and answers its first 100: fv asks for the whole list then
  calls.length = 0;
  const many = Array.from({ length: 150 }, (_, i) => `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`);
  assert.strictEqual(await FV.resolveId(fake({ conv: null, list: [...many, OFF] }), '2fdc63cf'), OFF);
  assert.ok(calls.includes('/conversations?all=1&limit=100000'), calls.join(' '));
  ok('fv: an older server (no ids in the answer) falls back to its whole list, past its first 100');

  // ids fv takes as they are, and ones it refuses before asking
  calls.length = 0;
  assert.strictEqual(await FV.resolveId(fake(), OFF), OFF);
  assert.strictEqual(await FV.resolveId(fake(), 'new-3'), 'new-3');
  assert.strictEqual(calls.length, 0);
  for (const bad of ['2fdc63c', 'hello-world', `${OFF}0`]) await refused(fake(), bad, /not a conversation id/);
  await refused(fake(), undefined, /give a conversation id/);
  assert.strictEqual(calls.length, 0);
  ok('fv: a full id and a new- key go as they are; under 8 characters, not hex, or too long are refused without a call');
}

// ---------- a --demo server routes ?prefix= ----------
const PORT = 4794;
function req(p, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, method: 'GET', path: p, headers }, (res) => {
      let s = '';
      res.on('data', (c) => { s += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch {} resolve({ code: res.statusCode, j }); });
    });
    r.on('error', reject);
    r.setTimeout(20000, () => r.destroy(new Error('timeout')));
    r.end();
  });
}
async function demo() {
  const data = fs.mkdtempSync(path.join(process.env.FV_TEST_TMP || os.tmpdir(), 'fv-ids-'));
  const env = { ...process.env, LOCALAPPDATA: data, HOME: data, USERPROFILE: data, XDG_STATE_HOME: data };
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'fleet-view.js'), '--demo', '--port', String(PORT), '--no-open'], { env, stdio: 'ignore', windowsHide: true });
  try {
    let up = false;
    for (let i = 0; i < 120 && !up; i++) { try { up = (await req('/state')).code === 200; } catch {} if (!up) await new Promise((r) => setTimeout(r, 500)); }
    assert.ok(up, 'the demo server answers /state');
    const token = fs.readFileSync(path.join(data, 'fleet-view', 'api-token'), 'utf8').trim();
    const auth = { Authorization: `Bearer ${token}` };
    let r = await req('/api/conversations?prefix=deadbeef', auth);
    assert.deepStrictEqual([r.code, r.j], [200, { ok: true, prefix: 'deadbeef', ids: [] }]);
    r = await req('/api/conversations?prefix=dead', auth);
    assert.strictEqual(r.code, 400);
    r = await req('/api/conversations?all=1', auth);
    assert.ok(r.code === 200 && Array.isArray(r.j.conversations) && r.j.conversations.length > 0 && !('ids' in r.j), 'the list as before without prefix');
    ok('a --demo server: ?prefix= answers { ids } through fleet-view.js (none: demo ids are not conversation ids), a short one is 400, the list is as before');
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 300));
    try { fs.rmSync(data, { recursive: true, force: true }); } catch {}
  }
}

(async () => {
  await helpers();
  await resolve();
  await demo();
  console.log(`\n${n} passed, 0 failed`);
})().catch((e) => { console.error('FAIL', (e && e.stack) || e); process.exit(1); });
