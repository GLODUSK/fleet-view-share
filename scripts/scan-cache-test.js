// scan-cache-test.js: the usage scan's cache across restarts (scan-cache.js; fleet-view.js scanUsage). A restart read
// every log on the map again from the start for its cost (about 314 MB, 2026-10-17), the header's cost climbing
// meanwhile, and the bots' whole logs into one string for their PR links. First scan-cache.js alone: fits() tells
// the same log (unchanged, or grown with the same bytes before the offset) from another; the file keeps what it
// should, for how long, never before load() and never after the exit's save. Then fleet-view.js's scanUsage, run in a
// vm on a temp log: a scan in small reads counts the same as one read (a character split across two reads included,
// and a reply whose text names "pr-link"); after a restart the counts, PR links and this PC's spend come back with no
// read of the log (at the first poll, its budget spent or not), a grown log is read only past its offset, and a log
// put in its place is read from the start; a fork's copied replies count once in the header and in this PC's spend,
// whichever of the fork and its source is on the map.
// Run: node scripts/scan-cache-test.js (exit 0 = all pass)
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const SC = require(path.join(__dirname, '..', 'scan-cache.js'));

let n = 0;
const ok = (what) => { n++; console.log(`ok ${n} - ${what}`); };
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-scan-cache-'));

// ---------- scan-cache.js ----------
async function moduleChecks() {
  // ---------- fits ----------
  const tail = Buffer.from('end of a line}\n');
  const e = { off: 100, size: 120, m: 5, tail };
  assert.strictEqual(SC.fits(e, 120, 5, () => { throw new Error('no read when unchanged'); }), true);
  assert.strictEqual(SC.fits(e, 150, 6, (pos, len) => (pos === 100 - tail.length && len === tail.length ? Buffer.from(tail) : null)), true);
  assert.strictEqual(SC.fits(e, 150, 6, () => Buffer.from('another line!!}\n')), false);
  assert.strictEqual(SC.fits(e, 99, 6, () => tail), false, 'shorter than its offset');
  assert.strictEqual(SC.fits(e, 150, 6, () => { throw new Error('gone'); }), false);
  assert.strictEqual(SC.fits({ off: 0, size: 0, m: 1, tail: Buffer.alloc(0) }, 10, 2, () => null), true);
  assert.strictEqual(SC.fits(null, 10, 2, () => null), false);
  ok('fits: unchanged, or grown with the same bytes before the offset; not shorter, not other bytes');

  // ---------- the file ----------
  let now = Date.parse('2026-10-17T12:00:00Z');
  const F = path.join(T, 'data', 'scan-cache.json');
  // each reply with the minute it came in (msg_2's log gave no time)
  const state = (off, extra = {}) => ({ off, size: off + 10, m: 7, tail: Buffer.from('x\n'), u: new Map([['msg_1', [10, 0.5, now - 60e3]], ['msg_2', [4, 0.25, null]]]), prs: new Map([[42, [42, 'o/r', 9]]]), ...extra });
  let c = SC.createScanCache({ file: F, now: () => now, keepMs: 3600e3 });
  assert.strictEqual(c.save([['/l/a.jsonl', state(50)]], { sync: true }), false, 'never before load');
  assert.ok(!fs.existsSync(F));
  c.load();
  assert.strictEqual(c.take('/l/a.jsonl'), null);
  assert.strictEqual(await c.save([['/l/a.jsonl', state(50)], ['/l/b.jsonl', state(0)]]), true);
  const j = JSON.parse(fs.readFileSync(F, 'utf8'));
  assert.deepStrictEqual(Object.keys(j.files), ['/l/a.jsonl'], 'a log read to nowhere yet is left out');
  assert.deepStrictEqual(j.files['/l/a.jsonl'].u, [['msg_1', 10, 0.5, now - 60e3], ['msg_2', 4, 0.25, null]]);
  assert.strictEqual(await c.save([['/l/a.jsonl', state(50)]]), false, 'nothing changed: no write');
  // a restart: taken once, as it was
  c = SC.createScanCache({ file: F, now: () => now, keepMs: 3600e3 });
  c.load();
  const t1 = c.take('/l/a.jsonl');
  assert.deepStrictEqual([t1.off, t1.size, t1.m, t1.tail.toString(), [...t1.u], [...t1.prs.values()]], [50, 60, 7, 'x\n', [['msg_1', [10, 0.5, now - 60e3]], ['msg_2', [4, 0.25, null]]], [[42, 'o/r', 9]]]);
  assert.strictEqual(c.take('/l/a.jsonl'), null, 'taken once a run');
  // a log no longer live is kept as it was last saved, until keepMs after that
  assert.strictEqual(await c.save([['/l/a.jsonl', state(80)], ['/l/c.jsonl', state(30)]]), true);
  now += 60e3;
  assert.strictEqual(await c.save([['/l/c.jsonl', state(30)]]), true);
  let files = JSON.parse(fs.readFileSync(F, 'utf8')).files;
  assert.deepStrictEqual([files['/l/a.jsonl'].off, files['/l/c.jsonl'].off], [80, 30], 'gone from the map: kept as last saved');
  now += 3600e3;
  assert.strictEqual(await c.save([['/l/c.jsonl', state(31)]]), true);
  files = JSON.parse(fs.readFileSync(F, 'utf8')).files;
  assert.deepStrictEqual(Object.keys(files), ['/l/c.jsonl'], 'and dropped keepMs after it was last live');
  // the exit's save closes it: an async save after it writes nothing
  assert.strictEqual(c.save([['/l/c.jsonl', state(40)]], { sync: true }), true);
  assert.strictEqual(await c.save([['/l/c.jsonl', state(41)]]), false);
  assert.strictEqual(JSON.parse(fs.readFileSync(F, 'utf8')).files['/l/c.jsonl'].off, 40);
  // made with other prices or counting rules (sig): not used, so a price put right reaches every log
  const G = path.join(T, 'data', 'sig.json');
  c = SC.createScanCache({ file: G, now: () => now, sig: 'prices-1' });
  c.load();
  assert.strictEqual(await c.save([['/l/a.jsonl', state(50)]]), true);
  c = SC.createScanCache({ file: G, now: () => now, sig: 'prices-1' });
  c.load();
  assert.strictEqual(c.size(), 1);
  c = SC.createScanCache({ file: G, now: () => now, sig: 'prices-2' });
  c.load();
  assert.ok(c.size() === 0 && c.take('/l/a.jsonl') === null, 'another sig: an empty cache');
  // a broken file is an empty cache
  fs.writeFileSync(F, '{ broken');
  c = SC.createScanCache({ file: F });
  c.load();
  assert.strictEqual(c.size(), 0);
  ok('the file: never before load, only changes written (each reply with its minute), taken once, kept keepMs after it was live, closed at exit, not used with other prices');
}

// ---------- fleet-view.js's scanUsage, in a vm ----------
const src = fs.readFileSync(path.join(__dirname, '..', 'fleet-view.js'), 'utf8');
const from = src.indexOf('function addPr(s, n, repo, t) {'), to = src.indexOf('const fmtTok');
assert.ok(from > 0 && to > from, 'fleet-view.js has the usage scan block');
const block = src.slice(from, to);
// fs with the bytes each read takes counted
let readBytes = 0;
const fsx = Object.assign({}, fs, { readSync: (...a) => { const got = fs.readSync(...a); readBytes += got; return got; } });
// one server run: its own module state (a restart is a new one)
function run(dataDir) {
  const local = [];
  const ctx = {
    fs: fsx, path, Buffer, JSON, Math, Date, Number, Map, Set, Array, String,
    WEB: true, DEMO: false, P: { dataDir: () => dataDir }, SCAN_CACHE_JS: SC,
    sessions: new Map(), statKnown: new Map(), knownSize: (k) => (k ? k.size : null), knownM: (k) => (k ? k.mtimeMs : 0),
    USAGE: { addLocal: (a, t, usd) => { if (Number.isFinite(t) && usd) local.push([a, t, usd]); } },
    accountFor: (s) => s.account,
  };
  vm.createContext(ctx);
  vm.runInContext(block + '\n;globalThis.T = { scanUsage, scanCacheSave, get spentAll() { return spentAll; }, SCAN };', ctx);
  const sess = (id, file) => { const s = { id, file, account: 'B', prs: new Map(), msgUsage: new Map(), usageScan: new Map(), tokens: 0, cost: 0 }; ctx.sessions.set(id, s); return s; };
  // scans a session's log to its end, `budget` bytes a poll; how many polls it took
  const scan = (s, budget = 8 << 20) => {
    for (let i = 0; i < 1000; i++) {
      ctx.T.scanUsage(s, [s.file], { left: budget }, false);
      if (!s.usagePending) { assert.strictEqual(s.usageScan.get(s.file).off, fs.statSync(s.file).size, 'not pending: read to the end'); return i + 1; }
    }
    throw new Error('never finished');
  };
  ctx.T.SCAN.load();
  return { T: ctx.T, sess, scan, local };
}
const iso = (ms) => new Date(ms).toISOString();
const base = Date.now() - 30 * 60e3;
const reply = (id, i, out, text = 'ok') => JSON.stringify({ type: 'assistant', timestamp: iso(base + i * 1000), message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 100, output_tokens: out, cache_read_input_tokens: 1000 }, content: [{ type: 'text', text }] } });
const prLink = (num, i) => JSON.stringify({ type: 'pr-link', prNumber: num, prRepository: 'GLODUSK/fleet-view', timestamp: iso(base + i * 1000) });
const lines = [
  JSON.stringify({ type: 'user', message: { content: 'hello' } }),
  reply('msg_a', 1, 5), reply('msg_a', 2, 50), // a streamed reply: its last copy counts
  prLink(586, 3),
  reply('msg_b', 4, 70, 'ünïcödé ✓ that names {"type":"pr-link"} in its text'),
  reply('msg_c', 5, 30, '漢字'.repeat(40)),
  prLink(587, 6), prLink(586, 7),
];
const LOG = path.join(T, 'proj', 'sess-1.jsonl');
fs.mkdirSync(path.dirname(LOG), { recursive: true });
fs.writeFileSync(LOG, lines.join('\n') + '\n');
const D = path.join(T, 'data2');

(async () => {
  try {
    await moduleChecks();
    // one read and many small ones count the same
    const one = run(path.join(T, 'one'));
    const s1 = one.sess('s1', LOG);
    assert.strictEqual(one.scan(s1), 1);
    const small = run(D);
    const s2 = small.sess('s1', LOG);
    assert.ok(small.scan(s2, 97) > 5);
    assert.deepStrictEqual([s2.tokens, Math.round(s2.cost * 1e6), [...s2.prs]], [s1.tokens, Math.round(s1.cost * 1e6), [...s1.prs]]);
    assert.strictEqual(s1.tokens, 3 * 1100 + 50 + 70 + 30);
    assert.deepStrictEqual([...s1.prs], [[586, 'GLODUSK/fleet-view'], [587, 'GLODUSK/fleet-view']]);
    assert.strictEqual(s1.lastPr, 586, 'the newest pr-link names the last PR');
    ok(`scanUsage: small reads (a character split across two) count as one read: ${s1.tokens} tokens, PRs ${[...s1.prs.keys()]}`);

    // the restart: everything back, nothing of the log read
    assert.strictEqual(small.T.scanCacheSave(true), true);
    const r2 = run(D);
    const s3 = r2.sess('s1', LOG);
    readBytes = 0;
    r2.T.scanUsage(s3, [s3.file], { left: 0 }, false);
    assert.strictEqual(s3.tokens, s1.tokens, 'taken up from the cache even when the poll\'s budget is spent');
    r2.scan(s3);
    assert.strictEqual(readBytes, 0, 'an unchanged log is not read at all');
    assert.deepStrictEqual([s3.tokens, Math.round(s3.cost * 1e6), [...s3.prs], s3.lastPr], [s1.tokens, Math.round(s1.cost * 1e6), [...s1.prs], 586]);
    assert.strictEqual(Math.round(r2.T.spentAll * 1e6), Math.round(s1.cost * 1e6), 'the header total');
    const sum = (l) => Math.round(l.reduce((x, [, , usd]) => x + usd, 0) * 1e6);
    assert.strictEqual(sum(r2.local), sum(small.local), 'this PC\'s spend by minute comes back');
    assert.ok(r2.local.every(([a, t]) => a === 'B' && t % 60e3 === 0));
    ok('a restart: tokens, cost, PR links and this PC\'s spend come back, and the log is not read');

    // grown: only the new bytes are read
    const more = [reply('msg_d', 8, 40), prLink(590, 9)].join('\n') + '\n';
    fs.appendFileSync(LOG, more);
    assert.strictEqual(r2.T.scanCacheSave(true), true);
    const r3 = run(D);
    const s4 = r3.sess('s1', LOG);
    readBytes = 0;
    r3.scan(s4);
    const grownRead = readBytes;
    assert.ok(grownRead <= Buffer.byteLength(more) + SC.TAIL_BYTES, `a grown log: only past its offset (${grownRead} bytes)`);
    const fresh = run(path.join(T, 'fresh')), s5 = fresh.sess('s1', LOG);
    fresh.scan(s5);
    assert.deepStrictEqual([s4.tokens, Math.round(s4.cost * 1e6), [...s4.prs]], [s5.tokens, Math.round(s5.cost * 1e6), [...s5.prs]]);
    ok(`a grown log: read from its offset (${grownRead} bytes of ${fs.statSync(LOG).size}), the same counts as a read from the start`);

    // another log in its place, longer: read from the start
    assert.strictEqual(r3.T.scanCacheSave(true), true);
    fs.writeFileSync(LOG, [reply('msg_z', 1, 9), prLink(700, 2)].join('\n') + '\n' + 'x'.repeat(4000) + '\n');
    const r4 = run(D);
    const s6 = r4.sess('s1', LOG);
    r4.scan(s6);
    assert.deepStrictEqual([s6.tokens, [...s6.prs.keys()]], [1109, [700]]);
    ok('another log put in its place: read from the start, nothing of the old one counted');

    // a fork copies its source's replies: the header counts them once, before and after a restart
    const SRC = path.join(T, 'proj', 'src.jsonl'), FORK = path.join(T, 'proj', 'fork.jsonl');
    fs.writeFileSync(SRC, [reply('msg_s1', 1, 10), reply('msg_s2', 2, 20)].join('\n') + '\n');
    fs.writeFileSync(FORK, [reply('msg_s1', 1, 10), reply('msg_s2', 2, 20), reply('msg_f1', 3, 30)].join('\n') + '\n');
    const D2 = path.join(T, 'data3');
    const f1 = run(D2), a = f1.sess('a', SRC), b = f1.sess('b', FORK);
    f1.scan(b); f1.scan(a);
    const header = Math.round(f1.T.spentAll * 1e6);
    assert.strictEqual(header, Math.round(b.cost * 1e6), 'the fork holds every reply once');
    assert.strictEqual(f1.T.scanCacheSave(true), true);
    const f2 = run(D2), a2 = f2.sess('a', SRC), b2 = f2.sess('b', FORK);
    f2.scan(a2); f2.scan(b2);
    assert.deepStrictEqual([Math.round(f2.T.spentAll * 1e6), Math.round(a2.cost * 1e6), Math.round(b2.cost * 1e6)], [header, Math.round(a.cost * 1e6), Math.round(b.cost * 1e6)]);
    assert.strictEqual(sum(f2.local), sum(f1.local), 'and this PC\'s spend once');
    // the fork counted the copied replies' spend first (f1), and has left the map since: its source alone gives it all
    // back, as a read of its log would (this PC's spend tells usage from elsewhere: none of it may go missing)
    assert.strictEqual(f2.T.scanCacheSave(true), true);
    const f3 = run(D2), a3 = f3.sess('a', SRC);
    readBytes = 0;
    f3.scan(a3);
    assert.strictEqual(readBytes, 0);
    assert.deepStrictEqual([Math.round(f3.T.spentAll * 1e6), sum(f3.local)], [Math.round(a.cost * 1e6), Math.round(a.cost * 1e6)]);
    ok('a fork\'s copied replies count once in the header, before and after a restart (in either order); this PC\'s spend too, whichever of the two is on the map');
    console.log(`scan-cache-test: ${n} passed`);
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    fs.rmSync(T, { recursive: true, force: true });
  }
})();
