// Tests for left-map.js (the log of conversations leaving the map, and the "looks wrong" check): node scripts/left-map-test.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLeftMap, looksWrong, noteLeft, leftList, RULES, LOG_MAX, KEEP_IDS } = require(path.join(__dirname, '..', 'left-map.js'));

const MIN = 60e3, H = 3600e3, W = 45 * MIN, K = 3 * H, now = Date.UTC(2026, 9, 16, 9, 0, 0);
const lw = (o) => looksWrong({ now, windowMs: W, keepDoneMs: K, fileExists: true, ...o });

// ---------- looksWrong ----------
// a transcript that is gone is always worth a warning, whatever took it off (a hide too)
for (const rule of Object.keys(RULES)) assert.strictEqual(lw({ rule, state: 'DONE', lastActive: now - 5 * H, endedAt: now - 5 * H, fileExists: false }), 'its transcript file is gone', rule);
// hides, Start clean and another device's list are deliberate, however recent
for (const rule of ['hidden', 'hidden-api', 'set-aside', 'other-device']) {
  assert.strictEqual(lw({ rule, state: 'WORKING', lastActive: now - 10e3, endedAt: null }), null, rule);
  assert.strictEqual(lw({ rule, state: 'DONE', lastActive: now - MIN, endedAt: now - MIN }), null, rule);
}
// finished-3h: right when it ended 3 h ago or more
assert.strictEqual(lw({ rule: 'finished-3h', state: 'DONE', lastActive: now - 3 * H, endedAt: now - 3 * H }), null);
assert.strictEqual(lw({ rule: 'finished-3h', state: 'DONE', lastActive: now - 5 * MIN, endedAt: now - 4 * H }), null); // touched since, ended long ago
// ... wrong when it ended 20 min ago, or was not finished at all
assert.strictEqual(lw({ rule: 'finished-3h', state: 'DONE', lastActive: now - 20 * MIN, endedAt: now - 20 * MIN }), 'left by finished-3h but it ended 20 min ago');
assert.strictEqual(lw({ rule: 'finished-3h', state: 'WORKING', lastActive: now - 5 * H, endedAt: now - 5 * H }), 'left by finished-3h but it was WORKING, not finished');
assert.strictEqual(lw({ rule: 'finished-3h', state: null, lastActive: now - 5 * H, endedAt: null }), 'left by finished-3h but it was not read yet, not finished');
// a finished one with no end of turn goes by its last activity
assert.strictEqual(lw({ rule: 'quiet-window', state: 'DONE', lastActive: now - 4 * H, endedAt: null }), null);
assert.strictEqual(lw({ rule: 'quiet-window', state: 'DONE', lastActive: now - H, endedAt: null }), 'left by quiet-window but it ended 60 min ago');
// quiet-window and late-unfinished: right when quiet past the window, wrong inside it
assert.strictEqual(lw({ rule: 'quiet-window', state: 'STALLED', lastActive: now - 46 * MIN, endedAt: null }), null);
assert.strictEqual(lw({ rule: 'quiet-window', state: 'STALLED', lastActive: now - 10 * MIN, endedAt: null }), 'left by quiet-window but it was active 10 min ago');
assert.strictEqual(lw({ rule: 'late-unfinished', state: null, lastActive: now - 2 * H, endedAt: null }), null);
assert.strictEqual(lw({ rule: 'late-unfinished', state: null, lastActive: now - 30e3, endedAt: null }), 'left by late-unfinished but it was active 30 s ago');
// aged-out-while-off: right when it is old by both rules, wrong when it was not
assert.strictEqual(lw({ rule: 'aged-out-while-off', state: 'DONE', lastActive: now - 10 * H, endedAt: now - 10 * H }), null);
assert.strictEqual(lw({ rule: 'aged-out-while-off', state: 'ASKING', lastActive: now - 10 * H, endedAt: null }), null);
assert.strictEqual(lw({ rule: 'aged-out-while-off', state: 'DONE', lastActive: now - 2 * H, endedAt: now - 2 * H }), 'left by aged-out-while-off but it ended 2 h ago');
assert.strictEqual(lw({ rule: 'aged-out-while-off', state: 'ASKING', lastActive: now - 5 * MIN, endedAt: null }), 'left by aged-out-while-off but it was active 5 min ago');
// file-gone with the file there (fileExists unknown) is no age rule
assert.strictEqual(lw({ rule: 'file-gone', state: 'WORKING', lastActive: now - MIN, fileExists: null }), null);
// no times at all: nothing to hold it to
assert.strictEqual(lw({ rule: 'quiet-window', state: 'STALLED', lastActive: null, endedAt: null }), null);

// ---------- the log ----------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-left-map-'));
try {
  let t = now;
  const L = createLeftMap({ dir, now: () => t });
  assert.deepStrictEqual(L.recent(), []);
  const facts = { id: '8095647c-1111-2222-3333-444455556666', name: 'Ship the map', repo: 'Z:\\Github\\fleet-view', cwd: 'Z:\\Github\\fleet-view', account: 'A', file: 'x.jsonl', state: 'DONE', lastActive: now - 4 * H + 0.4, endedAt: now - 4 * H };
  const r = L.left(facts, 'finished-3h');
  assert.deepStrictEqual(r, { t: now, id: facts.id, name: 'Ship the map', repo: facts.repo, cwd: facts.cwd, account: 'A', state: 'DONE', rule: 'finished-3h', why: RULES['finished-3h'], lastActive: now - 4 * H, endedAt: now - 4 * H });
  t += 1000;
  const r2 = L.left({ id: 'b', state: 'STALLED', lastActive: now - MIN }, 'file-gone', { by: 'quiet-window', wrong: 'its transcript file is gone' });
  assert.strictEqual(r2.by, 'quiet-window');
  assert.strictEqual(r2.wrong, 'its transcript file is gone');
  assert.strictEqual(r2.name, null);
  assert.strictEqual(r2.endedAt, null);
  t += 1000;
  assert.strictEqual(L.left({ id: 'c' }, 'hidden', { why: 'hidden on another device' }).why, 'hidden on another device');
  // an unknown rule or no id: nothing written
  assert.strictEqual(L.left({ id: 'd' }, 'made-up'), null);
  assert.strictEqual(L.left({}, 'hidden'), null);
  assert.deepStrictEqual(L.recent().map((x) => x.id), [facts.id, 'b', 'c']);
  assert.deepStrictEqual(L.recent(2).map((x) => x.id), ['b', 'c']);
  // one line each, JSON
  const text = fs.readFileSync(L.LOG, 'utf8');
  assert.strictEqual(text.split('\n').filter(Boolean).length, 3);
  for (const l of text.split('\n').filter(Boolean)) JSON.parse(l);

  // rotation: at LOG_MAX it moves to left-map.log.1, and recent() still reaches back into it
  fs.writeFileSync(L.LOG, text + `${JSON.stringify({ t: 1, id: 'pad', rule: 'hidden', why: 'x'.repeat(200) })}\n`.repeat(Math.ceil(LOG_MAX / 200)));
  assert.ok(fs.statSync(L.LOG).size >= LOG_MAX);
  t += 1000;
  L.left({ id: 'after' }, 'set-aside');
  assert.ok(fs.existsSync(L.LOG + '.1'));
  assert.strictEqual(fs.readFileSync(L.LOG, 'utf8').split('\n').filter(Boolean).length, 1);
  const back = L.recent(5);
  assert.strictEqual(back.length, 5);
  assert.strictEqual(back[4].id, 'after');
  assert.strictEqual(back[3].id, 'pad');
  // a big file is read from its tail only, and whole lines only: many more records than the first tail holds
  const many = L.recent(1000);
  assert.strictEqual(many.length, 1000);
  assert.ok(many.every((x) => x && typeof x.id === 'string'));
  assert.strictEqual(many[999].id, 'after');
  // a torn last line (a crash mid-write) is skipped
  fs.appendFileSync(L.LOG, '{"t":5,"id":"tor');
  assert.strictEqual(L.recent(1)[0].id, 'after');

  // ---------- on-map.json ----------
  assert.deepStrictEqual(L.readOnMap(), []);
  const list = [{ id: 'a', name: 'one', file: 'a.jsonl', state: 'WORKING', lastActive: now }, { id: 'b', state: 'DONE' }];
  assert.strictEqual(L.writeOnMap(list), true);
  assert.deepStrictEqual(createLeftMap({ dir }).readOnMap(), list);
  assert.ok(!fs.existsSync(L.ON + '.tmp'));
  // a damaged file reads as nothing on the map, and entries with no id are left out
  fs.writeFileSync(L.ON, '{"sessions": [');
  assert.deepStrictEqual(L.readOnMap(), []);
  fs.writeFileSync(L.ON, JSON.stringify({ sessions: [{ id: 'a' }, { name: 'no id' }, null] }));
  assert.deepStrictEqual(L.readOnMap(), [{ id: 'a' }]);

  // ---------- shown-again.json ----------
  assert.strictEqual(L.readShown(K).size, 0);
  assert.strictEqual(L.writeShown(new Map([['x', t - H], ['old', t - 5 * H]])), true);
  assert.deepStrictEqual([...L.readShown(K)], [['x', t - H]]); // older than maxAge: counts for nothing
  assert.ok(!fs.existsSync(L.SHOWN + '.tmp'));
  fs.writeFileSync(L.SHOWN, JSON.stringify({ ids: { y: 'soon', z: -1, w: t - MIN } }));
  assert.deepStrictEqual([...L.readShown(K)], [['w', t - MIN]]);
  fs.writeFileSync(L.SHOWN, '{"ids":');
  assert.strictEqual(L.readShown(K).size, 0);

  // ---------- latest: the newest record of each, from the log's tail ----------
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-left-map-'));
  try {
    let t2 = now;
    const L2 = createLeftMap({ dir: dir2, now: () => t2 });
    assert.strictEqual(L2.latest().size, 0);
    // 800 ids, the last 100 of them twice (hidden the second time)
    for (let i = 0; i < 900; i++) { t2 += 1000; L2.left({ id: `c${i < 800 ? i : i - 100}` }, i < 800 ? 'quiet-window' : 'hidden'); }
    const by = L2.latest(600);
    assert.strictEqual(by.size, 600); // the newest 500 records hold only 400 ids: it reads further back
    assert.strictEqual([...by.keys()][0], 'c200');
    const last = [...by.values()].pop();
    assert.strictEqual(last.id, 'c799');
    assert.strictEqual(last.rule, 'hidden'); // its newest record, not its first
    assert.strictEqual(by.get('c700').rule, 'hidden');
    assert.strictEqual(L2.latest().size, 200);
  } finally {
    fs.rmSync(dir2, { recursive: true, force: true });
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------- noteLeft and leftList: the menus' "Left the map" ----------
{
  const by = new Map();
  const rec = (id, rule, t) => ({ id, rule, t });
  noteLeft(by, rec('a', 'finished-3h', 1));
  noteLeft(by, rec('b', 'quiet-window', 2));
  noteLeft(by, rec('c', 'late-unfinished', 3));
  noteLeft(by, rec('d', 'aged-out-while-off', 4));
  noteLeft(by, rec('e', 'file-gone', 5)); // gone: never listed
  noteLeft(by, rec('f', 'hidden', 6)); // hidden: Removed conversations lists it
  noteLeft(by, null);
  noteLeft(by, { rule: 'finished-3h' });
  assert.strictEqual(by.size, 6);
  assert.deepStrictEqual(leftList(by).map((r) => r.id), ['d', 'c', 'b', 'a']);
  // seen again: its newest record counts, and it moves to the front
  noteLeft(by, rec('a', 'quiet-window', 7));
  assert.deepStrictEqual(leftList(by).map((r) => r.id), ['a', 'd', 'c', 'b']);
  assert.strictEqual(leftList(by)[0].rule, 'quiet-window');
  // hidden after it aged out: off this list
  noteLeft(by, rec('b', 'set-aside', 8));
  assert.deepStrictEqual(leftList(by).map((r) => r.id), ['a', 'd', 'c']);
  // skip() and max
  assert.deepStrictEqual(leftList(by, { skip: (r) => r.id === 'd' }).map((r) => r.id), ['a', 'c']);
  assert.deepStrictEqual(leftList(by, { max: 2 }).map((r) => r.id), ['a', 'd']);
  // at cap the oldest goes
  const small = new Map();
  for (let i = 0; i < 10; i++) noteLeft(small, rec(`x${i}`, 'finished-3h', i), 4);
  assert.deepStrictEqual([...small.keys()], ['x6', 'x7', 'x8', 'x9']);
  assert.strictEqual(KEEP_IDS, 200);
}
console.log('left-map-test: ok');
