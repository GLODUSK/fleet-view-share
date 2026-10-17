// forks-test.js: a fork never looks like the conversation it came from (Fleet View #552). forks.js tells a fork from its
// log (the records copied from its source keep the source's id in session_id; the last such record names its own
// source, a fork of a fork too), and confirms it by the first copied record's uuid being in the source's log (a /clear
// successor names its predecessor in every record but copied none), reads the title lines copied to its head, and
// says whether its name is its own yet.
// Then the real fork of the issue when its log is on this machine (read only), and last a --demo server on a spare
// port with its own data folder: its two demo forks show as "fork of order-export-csv" (no name of its own) and under
// a name of its own with forkOf, in /state and GET /api/conversations; fv status's lines say which it is a fork of.
// Run: node scripts/forks-test.js (exit 0 = all pass)
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const FORKS = require(path.join(__dirname, '..', 'forks.js'));

let n = 0;
const ok = (what) => { n++; console.log(`ok ${n} - ${what}`); };
const FORK = '00f985e2-ae39-494a-a0ce-c5fb28f23893', SRC = '0a2cc1d1-5098-4aa6-93a7-2f686f18ce13', GRAND = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-8888-4777-8666-555555555555';
const L = (o) => JSON.stringify(o);
// a fork's log as Claude Code writes it: the source's titles again at its head (with the fork's id), records copied
// from a grandparent and then from its source (their session_id kept, sessionId made the fork's), then its own
const forkLog = () => [
  L({ type: 'custom-title', customTitle: 'left-map-departure-log', sessionId: FORK }),
  L({ type: 'ai-title', aiTitle: 'Auto-deleted conversations bug', sessionId: FORK }),
  L({ type: 'agent-name', agentName: 'left-map-departure-log', sessionId: FORK }),
  L({ type: 'mode', mode: 'normal', sessionId: FORK }),
  L({ parentUuid: null, type: 'user', uuid: 'u0', message: { role: 'user', content: 'start' }, sessionId: FORK }),
  L({ parentUuid: 'u0', type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' }, session_id: GRAND, userType: 'external', sessionId: FORK }),
  L({ parentUuid: 'u1', type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [] }, session_id: SRC, userType: 'external', sessionId: FORK }),
  // a tool's output that holds another id as a field of its own (not the record's): not a source
  L({ parentUuid: 'a1', type: 'user', uuid: 'u2', toolUseResult: { session_id: OTHER }, message: { role: 'user', content: [{ type: 'tool_result', content: `"session_id":"${OTHER}"` }] }, session_id: FORK, sessionId: FORK }),
  L({ parentUuid: 'u2', type: 'custom-title', customTitle: 'later title' }),
  L({ parentUuid: 'u2', type: 'assistant', uuid: 'a2', message: { role: 'assistant', content: [] }, session_id: FORK, userType: 'external', sessionId: FORK }),
].join('\n') + '\n';

function units() {
  // ---------- recordSource: what ingestMain notes per record ----------
  assert.strictEqual(FORKS.recordSource({ session_id: SRC.toUpperCase(), sessionId: FORK }, FORK), SRC);
  assert.strictEqual(FORKS.recordSource({ session_id: FORK }, FORK.toUpperCase()), null);
  assert.strictEqual(FORKS.recordSource({ sessionId: SRC }, FORK), null);
  assert.strictEqual(FORKS.recordSource({ session_id: 'not-an-id' }, FORK), null);
  assert.strictEqual(FORKS.recordSource(null, FORK), null);
  ok('recordSource: a record\'s own session_id naming another conversation (any case), never its sessionId or a non-id');

  // ---------- sourceIn: the last copied record, from text ----------
  const text = forkLog();
  assert.strictEqual(FORKS.sourceIn(text, FORK), SRC);
  ok('sourceIn: a fork of a fork names its own source (the newest copied record), not the grandparent');
  assert.strictEqual(FORKS.sourceIn(text.split('\n').filter((l) => !l.includes(`"session_id":"${SRC}"`)).join('\n'), FORK), GRAND);
  assert.strictEqual(FORKS.sourceIn(text.replace(new RegExp(`"session_id":"(${SRC}|${GRAND})",`, 'g'), ''), FORK), null);
  ok('sourceIn: an id inside a tool\'s output never counts; no copied record, no source');
  // the read stops inside a copied record: that line is not taken, the one before is
  const cut = text.slice(0, text.indexOf(`"session_id":"${SRC}"`) + 20);
  assert.strictEqual(FORKS.sourceIn(cut, FORK), GRAND);
  ok('sourceIn: a line cut by the end of the read is skipped');
  // a pickup of a handoff or a /clear: a log of its own, its records all its own id
  const own = [L({ type: 'custom-title', customTitle: 'x', sessionId: FORK }), L({ parentUuid: null, type: 'user', uuid: 'p', session_id: FORK, sessionId: FORK, message: { content: `/pickup ${SRC}` } })].join('\n') + '\n';
  assert.strictEqual(FORKS.sourceIn(own, FORK), null);
  ok('sourceIn: a log of its own (a pickup naming its predecessor in its text) is no fork');

  // ---------- firstCopied and isCopied: a foreign session_id alone is no fork ----------
  // the source's own log: the records the fork copied, with their uuids
  const srcLog = [
    L({ parentUuid: null, type: 'user', uuid: 'u0', message: { role: 'user', content: 'start' }, session_id: SRC, sessionId: SRC }),
    L({ parentUuid: 'u0', type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' }, session_id: GRAND, sessionId: SRC }),
    L({ parentUuid: 'u1', type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [] }, session_id: SRC, sessionId: SRC }),
  ].join('\n') + '\n';
  const c = FORKS.firstCopied(text, FORK);
  assert.deepStrictEqual(c, { from: GRAND, uuid: 'u1' });
  assert.strictEqual(FORKS.isCopied(srcLog, c.uuid), true);
  ok('firstCopied: a fork\'s first copied record (with its uuid) is in its source\'s log: a fork');
  // a /clear successor (or a "continue from where you left off"): every record carries the id its claude started with,
  // the predecessor's, but the records are new ones
  const cleared = [
    L({ type: 'mode', mode: 'normal', sessionId: FORK }),
    L({ parentUuid: null, type: 'user', uuid: 'c0', message: { role: 'user', content: '<local-command-caveat>Caveat: …</local-command-caveat>' }, session_id: SRC, sessionId: FORK }),
    L({ parentUuid: 'c0', type: 'user', uuid: 'c1', message: { role: 'user', content: '<command-name>/clear</command-name>' }, session_id: SRC, sessionId: FORK }),
    L({ parentUuid: 'c1', type: 'assistant', uuid: 'c2', message: { role: 'assistant', content: [] }, session_id: SRC, sessionId: FORK }),
  ].join('\n') + '\n';
  assert.strictEqual(FORKS.sourceIn(cleared, FORK), SRC, 'the session_id alone would call it a fork');
  const cc = FORKS.firstCopied(cleared, FORK);
  assert.deepStrictEqual(cc, { from: SRC, uuid: 'c0' });
  assert.strictEqual(FORKS.isCopied(srcLog, cc.uuid), false);
  ok('firstCopied: a /clear successor\'s first record is not in its predecessor\'s log: no fork');
  assert.strictEqual(FORKS.firstCopied(own, FORK), null);
  assert.strictEqual(FORKS.firstCopied(text.slice(0, text.indexOf(`"session_id":"${GRAND}"`) + 10), FORK), null);
  assert.strictEqual(FORKS.isCopied(srcLog, ''), false);
  ok('firstCopied: none in a log of its own or a cut line; isCopied of no uuid is false');

  // ---------- titlesIn: the titles copied to its head ----------
  assert.deepStrictEqual(FORKS.titlesIn(text), { custom: 'left-map-departure-log', ai: 'Auto-deleted conversations bug', agent: 'left-map-departure-log' });
  assert.deepStrictEqual(FORKS.titlesIn(L({ type: 'mode' }) + '\n' + L({ parentUuid: null, type: 'user' }) + '\n' + L({ type: 'custom-title', customTitle: 'after' })), {});
  assert.deepStrictEqual(FORKS.titlesIn(''), {});
  ok('titlesIn: the title lines before its first message; one after it is the fork\'s own');

  // ---------- ownName and label ----------
  const had = ['left-map-departure-log', 'Auto-deleted conversations bug'];
  assert.strictEqual(FORKS.ownName({ custom: 'left-map-departure-log', ai: 'Auto-deleted conversations bug' }, had), '');
  assert.strictEqual(FORKS.label('', 'left-map-departure-log'), 'fork of left-map-departure-log');
  assert.strictEqual(FORKS.ownName({}, had), '');
  ok('ownName: still the copied names (or none) -> none of its own, so it shows as "fork of <source>"');
  assert.strictEqual(FORKS.ownName({ custom: 'excel-export', ai: 'Auto-deleted conversations bug' }, had), 'excel-export');
  assert.strictEqual(FORKS.ownName({ custom: 'left-map-departure-log', ai: 'Excel export trial' }, had), 'Excel export trial');
  assert.strictEqual(FORKS.ownName({ renamed: 'left-map-departure-log', custom: 'x' }, had), 'left-map-departure-log');
  assert.strictEqual(FORKS.ownName({ remote: 'fork of left-map-departure-log', custom: 'left-map-departure-log' }, had), '');
  assert.strictEqual(FORKS.ownName({ remote: 'trial', custom: 'left-map-departure-log' }, had), 'trial');
  assert.strictEqual(FORKS.label('excel-export', 'left-map-departure-log'), 'excel-export');
  ok('ownName: a /rename or a new Claude Code title after the fork, a Fleet View rename (whatever it says), the running device\'s name');

  // ---------- fv status ----------
  const FV = require(path.join(__dirname, 'fv.js'));
  const lines = FV.statusLines({ members: [
    { id: FORK, name: 'fork of left-map-departure-log', state: 'IDLE', repo: 'fleet-view', forkOf: { id: SRC, name: 'left-map-departure-log', named: false } },
    { id: OTHER, name: 'excel-export', state: 'DONE', forkOf: { id: SRC, name: 'left-map-departure-log', named: true } },
    { id: GRAND, name: 'plain', state: 'DONE', repo: 'r', forkOf: null },
  ] });
  assert.match(lines[0], /fork of left-map-departure-log {2}IDLE/);
  assert.strictEqual(lines[1], '      fleet-view · fork of (0a2cc1d1)');
  assert.match(lines[2], /excel-export {2}DONE/);
  assert.strictEqual(lines[3], '      fork of left-map-departure-log (0a2cc1d1)');
  assert.strictEqual(lines[5], '      r');
  ok('fv status: a fork\'s second line names its source (by name once its own name no longer says so)');
}

// the issue's real fork, read only, when its log is on this machine
function real() {
  const home = os.homedir();
  const file = path.join(home, '.claude', 'projects', 'Z--Github-fleet-view--claude-worktrees-left-map', `${FORK}.jsonl`);
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch {}
  if (!text) { ok('the issue\'s fork log is not on this machine: skipped'); return; }
  assert.strictEqual(FORKS.sourceIn(text, FORK), SRC);
  assert.strictEqual(FORKS.titlesIn(text.slice(0, 64 << 10)).custom, 'left-map-departure-log');
  // what ingestMain sees record by record: the last copied one names the source
  let last = null;
  for (const line of text.split('\n')) { let d; try { d = JSON.parse(line); } catch { continue; } last = FORKS.recordSource(d, FORK) || last; }
  assert.strictEqual(last, SRC);
  ok(`the issue's fork (${FORK.slice(0, 8)}) names ${SRC.slice(0, 8)} as its source and has its titles at its head`);
  // the check fleet-view.js forkConfirmed makes: its first copied record is in its source's log's first MB
  const head = (f) => { const fd = fs.openSync(f, 'r'); try { const b = Buffer.alloc(1 << 20); return b.toString('utf8', 0, fs.readSync(fd, b, 0, b.length, 0)); } finally { fs.closeSync(fd); } };
  const srcFile = findLog(SRC);
  if (srcFile) {
    const c = FORKS.firstCopied(head(file), FORK);
    assert.ok(c && FORKS.isCopied(head(srcFile), c.uuid), JSON.stringify(c));
    ok(`the issue's fork: its first copied record is in ${SRC.slice(0, 8)}'s log`);
  }
  // /clear successors and a continuation from the review (Henry's machine): a foreign session_id, but no fork
  let seen = 0;
  for (const [succ, pred] of [['4104939e', 'da35520d'], ['b5da33fa', '79f02773']]) {
    const f = findLog(succ), p = findLog(pred);
    if (!f || !p) continue;
    const id = path.basename(f, '.jsonl'), c = FORKS.firstCopied(head(f), id);
    assert.ok(!c || !FORKS.isCopied(head(p), c.uuid), `${succ} <- ${pred}`);
    seen++;
  }
  if (seen) ok(`${seen} real /clear successor${seen === 1 ? '' : 's'}: not a fork of ${seen === 1 ? 'its' : 'their'} predecessor`);
}
// a log by the start of its id, in any account's projects folders (read only), or null
function findLog(prefix) {
  const home = os.homedir();
  let roots = [];
  try { roots = fs.readdirSync(home).filter((d) => /^\.claude(-[a-z])?$/.test(d)).map((d) => path.join(home, d, 'projects')); } catch {}
  for (const r of roots) {
    let dirs = [];
    try { dirs = fs.readdirSync(r); } catch { continue; }
    for (const d of dirs) {
      let fl = [];
      try { fl = fs.readdirSync(path.join(r, d)); } catch { continue; }
      const hit = fl.find((x) => x.startsWith(prefix) && x.endsWith('.jsonl'));
      if (hit) return path.join(r, d, hit);
    }
  }
  return null;
}

// ---------- a --demo server ----------
const TS = require('./test-support.js');
let PORT = 0; // a free port, picked when the server starts
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
  PORT = await TS.freePort();
  const data = fs.mkdtempSync(path.join(process.env.FV_TEST_TMP || os.tmpdir(), 'fv-forks-'));
  const env = { ...process.env, LOCALAPPDATA: data, HOME: data, USERPROFILE: data, XDG_STATE_HOME: data };
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'fleet-view.js'), '--demo', '--port', String(PORT), '--no-open'], { env, stdio: 'ignore', windowsHide: true });
  try {
    let up = false;
    for (let i = 0; i < 120 && !up; i++) { try { up = (await req('/state')).code === 200; } catch {} if (!up) await new Promise((r) => setTimeout(r, 500)); }
    assert.ok(up, 'the demo server answers /state');
    const st = (await req('/state')).j;
    const all = st.sessions || [];
    const byName = (nm) => all.filter((x) => x.name === nm);
    const src = byName('order-export-csv');
    assert.strictEqual(src.length, 1, 'one order-export-csv: the fork does not show under its name');
    assert.strictEqual(src[0].forkOf, null);
    const f1 = byName('fork of order-export-csv');
    assert.strictEqual(f1.length, 1, `the fork shows as "fork of order-export-csv": ${all.map((x) => x.name).join(', ')}`);
    assert.deepStrictEqual(f1[0].forkOf, { id: src[0].id, name: 'order-export-csv', named: false });
    const f2 = byName('ranking-weights-trial');
    assert.strictEqual(f2.length, 1);
    assert.strictEqual(f2[0].forkOf.name, 'ranking-eval-harness');
    assert.strictEqual(f2[0].forkOf.named, true);
    ok('/state: a fork under its copied name shows as "fork of <source>" with forkOf; one with its own name keeps it, forkOf named');

    const token = fs.readFileSync(path.join(TS.dataDirIn(data), 'api-token'), 'utf8').trim();
    const r = await req('/api/conversations?all=1', { Authorization: `Bearer ${token}` });
    assert.strictEqual(r.code, 200);
    const c1 = r.j.conversations.find((x) => x.id === f1[0].id);
    assert.ok(c1 && c1.name === 'fork of order-export-csv' && c1.forkOf && c1.forkOf.id === src[0].id, JSON.stringify(c1));
    assert.strictEqual(r.j.conversations.find((x) => x.id === src[0].id).forkOf, null);
    ok('GET /api/conversations: the same name and forkOf (fv ls lists it so)');
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 300));
    try { fs.rmSync(data, { recursive: true, force: true }); } catch {}
  }
}

(async () => {
  units();
  real();
  await demo();
  console.log(`\n${n} passed, 0 failed`);
})().catch((e) => { console.error('FAIL', (e && e.stack) || e); process.exit(1); });
