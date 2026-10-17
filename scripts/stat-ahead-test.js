// stat-ahead-test.js: the server's poll asks its stats and subagent listings off the event loop (statAhead), after one
// fs.statSync in pollOne took 2,092 ms on 2026-10-17 01:11 and froze the server. fleet-view.js's tailing helpers and
// statAhead run here in a vm on a temp folder: statAhead lists a conversation's subagent logs exactly as pollOne's
// sync listing does, stats them all, gives up on a slow stat after STAT_WAIT_MS without asking it twice, fills the
// cache when it lands, and forgets what is no longer polled; readNew with a known size reads what it reads without.
// Run: node scripts/stat-ahead-test.js (exit 0 = all pass)
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

let n = 0;
const ok = (what) => { n++; console.log(`ok ${n} - ${what}`); };

// the block from the tails map to the default-model reader: readNew, mtime, ls, readJson and the stat-ahead helpers
const src = fs.readFileSync(path.join(__dirname, '..', 'fleet-view.js'), 'utf8');
const from = src.indexOf('const tails = new Map();'), to = src.indexOf('// the model a new conversation starts on');
assert.ok(from > 0 && to > from, 'fleet-view.js has the tailing block');
const block = src.slice(from, to);

// fs with a stat that can be held back (slow.has(file): it answers only when let go) and a count of stats asked
const slow = new Map(), asked = new Map();
const fsx = Object.assign({}, fs, {
  promises: Object.assign({}, fs.promises, {
    stat: (f) => {
      asked.set(f, (asked.get(f) || 0) + 1);
      if (!slow.has(f)) return fs.promises.stat(f);
      return new Promise((res, rej) => slow.get(f).push(() => fs.promises.stat(f).then(res, rej)));
    },
  }),
});
const sessions = new Map();
const ctx = { fs: fsx, path, sessions, Buffer, JSON, Math, Promise, Set, Map, Number, setTimeout, clearTimeout };
vm.createContext(ctx);
vm.runInContext(block + '\n;globalThis.T = { readNew, mtime, ls, statKnown, statFlying, subKnown, listSubs, statAhead, STAT_WAIT_MS };', ctx);
const T = ctx.T;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-stat-ahead-'));
const w = (p, text = '') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
const line = (o) => JSON.stringify(o) + '\n';

(async () => {
  try {
    // a conversation with plain subagents, a workflow run's agents, its journal and no summary yet
    const dir = path.join(tmp, 'proj', 'sess1'), file = path.join(tmp, 'proj', 'sess1.jsonl');
    w(file, line({ type: 'user', n: 1 }));
    const sub = path.join(dir, 'subagents');
    w(path.join(sub, 'agent-a.jsonl'), line({ a: 1 }));
    w(path.join(sub, 'agent-a.meta.json'), '{}');
    w(path.join(sub, 'b.jsonl'), line({ b: 1 }));
    w(path.join(sub, 'workflows', 'wf_1', 'agent-c.jsonl'), line({ c: 1 }));
    w(path.join(sub, 'workflows', 'wf_1', 'journal.jsonl'), line({ type: 'started', key: 'k' }));
    w(path.join(sub, 'workflows', 'wf_1', 'notes.jsonl'), '');
    w(path.join(sub, 'workflows', 'other', 'agent-d.jsonl'), line({ d: 1 }));

    // pollOne's sync listing, as written there
    const syncFiles = T.ls(sub).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(sub, f));
    for (const x of T.ls(path.join(sub, 'workflows'))) for (const f of T.ls(path.join(sub, 'workflows', x))) if (f.startsWith('agent-') && f.endsWith('.jsonl')) syncFiles.push(path.join(sub, 'workflows', x, f));
    const l = await T.listSubs(dir);
    assert.deepStrictEqual([...l.files], syncFiles);
    assert.deepStrictEqual([...l.wfs], ['wf_1']);
    assert.deepStrictEqual([...(await T.listSubs(path.join(tmp, 'nothing-here'))).files], []);
    ok('listSubs lists the subagent logs in pollOne\'s order, and the wf_ runs (a missing folder: none)');

    sessions.set('s1', { id: 's1', file, dir });
    sessions.set('demo', { id: 'demo', demo: true, file: path.join(tmp, 'demo.jsonl'), dir: path.join(tmp, 'demo') });
    await T.statAhead();
    assert.strictEqual(T.statKnown.get(file).mtimeMs, T.mtime(file));
    assert.strictEqual(T.statKnown.get(file).size, fs.statSync(file).size);
    for (const f of syncFiles) assert.strictEqual(T.statKnown.get(f) && T.statKnown.get(f).mtimeMs, T.mtime(f), f);
    assert.ok(T.statKnown.get(path.join(sub, 'workflows', 'wf_1', 'journal.jsonl')));
    assert.strictEqual(T.statKnown.get(path.join(dir, 'workflows', 'wf_1.json')), null); // no summary yet: missing
    assert.ok(!T.statKnown.has(path.join(tmp, 'demo.jsonl')) && !T.subKnown.has(path.join(tmp, 'demo')));
    assert.strictEqual(T.statFlying.size, 0);
    ok('statAhead stats the log, every subagent log, each run\'s journal and summary (missing: null); demo ones are left out');

    // a slow stat: the round gives up on it after STAT_WAIT_MS, the next round does not ask it again, it lands later
    const agentA = path.join(sub, 'agent-a.jsonl');
    fs.appendFileSync(agentA, line({ a: 2 }));
    slow.set(agentA, []);
    asked.clear();
    const t0 = Date.now();
    await T.statAhead();
    const took = Date.now() - t0;
    assert.ok(took >= T.STAT_WAIT_MS - 20 && took < T.STAT_WAIT_MS + 400, `waited ${took} ms`);
    assert.strictEqual(T.statKnown.get(agentA).size, fs.statSync(agentA).size - line({ a: 2 }).length); // its last answer
    assert.ok(T.statFlying.has(agentA));
    await T.statAhead();
    assert.strictEqual(asked.get(agentA), 1);
    assert.strictEqual(asked.get(file), 2);
    for (const go of slow.get(agentA)) go();
    slow.delete(agentA);
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(T.statKnown.get(agentA).size, fs.statSync(agentA).size);
    assert.ok(!T.statFlying.has(agentA));
    ok(`a slow stat: the round ends after ${took} ms with its last answer, is not asked twice, and lands when it answers`);

    // a new subagent log: asked in the same round, once the listing has found it
    const agentE = path.join(sub, 'agent-e.jsonl');
    w(agentE, line({ e: 1 }));
    await T.statAhead();
    assert.ok(T.subKnown.get(dir).files.includes(agentE) && T.statKnown.get(agentE));
    ok('a log the listing newly finds is asked in the same round');

    // readNew with the known size reads what it reads without, a known-missing file reads nothing
    const f2 = path.join(tmp, 'tail.jsonl'), f3 = path.join(tmp, 'tail2.jsonl');
    const lines = [line({ x: 1 }), line({ x: 2 }), 'not json\n', line({ x: 3 })].join('');
    w(f2, lines); w(f3, lines);
    const a1 = T.readNew(f2, 1 << 20), b1 = T.readNew(f3, 1 << 20, fs.statSync(f3).size);
    fs.appendFileSync(f2, line({ x: 4 }) + '{"half":'); fs.appendFileSync(f3, line({ x: 4 }) + '{"half":');
    const a2 = T.readNew(f2, 1 << 20), b2 = T.readNew(f3, 1 << 20, fs.statSync(f3).size);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(b1)), JSON.parse(JSON.stringify(a1)));
    assert.deepStrictEqual(JSON.parse(JSON.stringify(b2)), JSON.parse(JSON.stringify(a2)));
    assert.strictEqual(a1.length, 3); assert.strictEqual(a2.length, 1);
    assert.deepStrictEqual([...T.readNew(path.join(tmp, 'gone.jsonl'), 1 << 20, null)], []);
    ok('readNew with a known size reads the same records as with its own stat; null (missing) reads none');

    // nothing polled any more: the caches empty
    sessions.clear();
    await T.statAhead();
    assert.strictEqual(T.statKnown.size, 0);
    assert.strictEqual(T.subKnown.size, 0);
    ok('files and folders no longer polled are forgotten');
    console.log(`all ${n} passed`);
  } catch (e) {
    console.error(e.stack || e);
    process.exitCode = 1;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})();
