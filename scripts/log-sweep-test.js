// log-sweep-test.js: log-sweep.js, the server's sweep of the projects folders off the event loop (discover, the
// history index and findLog used to walk them with synchronous stats: 144 ms a round warm, 46 s after a cold boot).
// On two temp projects folders (accounts A and B) and a made-up clock: a round lists every log with its folder,
// account and mtime; the next round stats again only the new, the wanted and the recently written, and the quiet ones
// once OLD_EVERY_MS has passed; a log gone from its folder is forgotten; a round asked for while one runs is that one;
// no more than `jobs` reads are out at once; statFiles takes just the logs (and project folders) it is given.
// Run: node scripts/log-sweep-test.js (exit 0 = all pass)
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const LS = require(path.join(__dirname, '..', 'log-sweep.js'));

let n = 0;
const ok = (what) => { n++; console.log(`ok ${n} - ${what}`); };
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-log-sweep-'));
const A = path.join(T, 'a', 'projects'), B = path.join(T, 'b', 'projects');
const ID = (i) => `dddddddd-0000-4000-8000-${String(i).padStart(12, '0')}`;
const NOW = Date.parse('2026-10-17T12:00:00Z');
// a log written `ago` ms before NOW
function log(root, proj, id, ago) {
  const f = path.join(root, proj, `${id}.jsonl`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '{}\n');
  const t = new Date(NOW - ago);
  fs.utimesSync(f, t, t);
  return f;
}

// fs.promises with every stat and readdir counted, and how many were out at once
const count = { stat: new Map(), readdir: 0, out: 0, most: 0 };
const track = (p) => { count.out++; count.most = Math.max(count.most, count.out); return p.finally(() => { count.out--; }); };
const fsp = {
  stat: (f) => { count.stat.set(f, (count.stat.get(f) || 0) + 1); return track(new Promise((r) => setTimeout(r, 2)).then(() => fs.promises.stat(f))); },
  readdir: (d) => { count.readdir++; return track(fs.promises.readdir(d)); },
};
const stats = (f) => count.stat.get(f) || 0;

(async () => {
  try {
    const hot = log(A, 'Z--Github-x', ID(1), 60e3);
    const old = log(A, 'Z--Github-x', ID(2), 5 * 3600e3);
    const other = log(B, 'C--Users-henry', ID(3), 2 * 3600e3);
    const wanted = log(B, 'C--Users-henry', ID(4), 3 * 24 * 3600e3);
    fs.writeFileSync(path.join(A, 'Z--Github-x', 'notes.txt'), 'x');
    fs.writeFileSync(path.join(A, 'stray-file.jsonl'), '{}');
    fs.mkdirSync(path.join(A, 'Z--Github-x', ID(1)), { recursive: true }); // a session's own folder: not a log
    let now = NOW;
    const want = new Set([ID(4)]);
    const sw = LS.createSweep({ roots: () => [{ dir: A, account: 'A' }, { dir: B, account: 'B' }, { dir: path.join(T, 'gone'), account: 'C' }], fsp, now: () => now, want: (id) => want.has(id), jobs: 2 });
    assert.strictEqual(sw.full, false);
    const p1 = sw.round(), p2 = sw.round();
    assert.strictEqual(p1, p2, 'a round asked for while one runs is that one');
    await p1;
    const byFile = new Map(sw.list().map((x) => [x.file, x]));
    assert.deepStrictEqual([...byFile.keys()].sort(), [hot, old, other, wanted].sort());
    const h = byFile.get(hot);
    assert.deepStrictEqual([h.id, h.name, h.proj, h.pdir, h.account, h.root], [ID(1), `${ID(1)}.jsonl`, 'Z--Github-x', path.dirname(hot), 'A', A]);
    assert.strictEqual(Math.round(h.m), NOW - 60e3);
    assert.strictEqual(byFile.get(other).account, 'B');
    assert.ok(sw.full && sw.gen === 1 && sw.at === NOW && sw.mtimeOf(old) === byFile.get(old).m && sw.mtimeOf(path.join(T, 'nope')) === undefined);
    assert.ok(count.most <= 2, `at most 2 out at once (${count.most})`);
    ok('round: every log in every projects folder, with its account, folder and mtime; a missing folder is none');

    // the next round, a little later: the hot one and the wanted one again, not the quiet ones
    now += 8e3;
    await sw.round();
    assert.deepStrictEqual([stats(hot), stats(old), stats(other), stats(wanted)], [2, 1, 1, 2]);
    // a quiet log written again is seen within a minute (its next due stat)
    const t2 = new Date(NOW + 9e3);
    fs.utimesSync(old, t2, t2);
    await sw.round();
    assert.strictEqual(Math.round(sw.mtimeOf(old)), NOW - 5 * 3600e3, 'not yet: a quiet log is stat\'d once a minute');
    now += 61e3;
    await sw.round();
    assert.deepStrictEqual([stats(old), stats(other)], [2, 2]);
    assert.strictEqual(Math.round(sw.mtimeOf(old)), NOW + 9e3);
    ok('later rounds: the new, wanted and recently written logs each round, a quiet one once a minute');

    // a new log is stat'd at once; a deleted one is forgotten
    const fresh = log(B, 'C--Users-henry', ID(5), 0);
    fs.unlinkSync(other);
    await sw.round();
    assert.ok(sw.mtimeOf(fresh) > 0 && sw.mtimeOf(other) === undefined);
    assert.ok(!sw.list().some((x) => x.file === other));
    assert.strictEqual(sw.stats().files, 4);
    ok('a new log is stat\'d in its first round, a deleted one forgotten');

    // statFiles: only the logs given (under one of the roots, there), and every log in the project folders picked
    const sw2 = LS.createSweep({ roots: () => [{ dir: A, account: 'A' }, { dir: B, account: 'B' }], fsp, now: () => now });
    const bot = log(A, 'C--Users-henry-Bots-pablito', ID(6), 9 * 24 * 3600e3);
    await sw2.statFiles([hot, path.join(A, 'Z--Github-x', `${ID(9)}.jsonl`), path.join(T, 'elsewhere', 'p', `${ID(1)}.jsonl`), 'not a path'], (proj) => proj.endsWith('-pablito'));
    assert.deepStrictEqual(sw2.list().map((x) => x.file).sort(), [hot, bot].sort());
    assert.strictEqual(sw2.list().find((x) => x.file === bot).account, 'A');
    assert.strictEqual(sw2.full, false, 'statFiles is not a full listing');
    await sw2.round();
    assert.ok(sw2.full && sw2.list().length === 5);
    ok('statFiles: just the logs given that are there, under a root, and the picked project folders\' logs');

    // Windows and macOS: a root named in another case is the same folder
    if (process.platform === 'win32' || process.platform === 'darwin') {
      const sw3 = LS.createSweep({ roots: () => [{ dir: A.toUpperCase(), account: 'A' }], fsp, now: () => now });
      await sw3.statFiles([hot]);
      assert.strictEqual(sw3.list().length, 1);
      ok('statFiles: the root matched without regard to case');
    }
    console.log(`log-sweep-test: ${n} passed`);
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    fs.rmSync(T, { recursive: true, force: true });
  }
})();
