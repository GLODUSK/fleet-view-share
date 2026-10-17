// Fleet View: the projects folders' conversation logs, <projects>/<project folder>/<id>.jsonl, listed and stat'd off
// the event loop (fs.promises) for the server's discover (every 8 s), its history index (every 30 s) and its look-ups
// of a log by id (findLog). Each of those walked the folders with synchronous stats of its own: 1,683 logs took 144 ms
// warm every 8 s, and 46 s after a cold boot, with the server answering nothing for a minute (2026-10-16 20:50; the
// launcher took it for no server and started a second one). One round lists every project folder and stats a log when
//   - it is new on its folder's listing, or want(id) is true (a conversation the server holds or a claude runs), or
//   - it was written in the last HOT_MS (by its last stat), or
//   - its last stat is OLD_EVERY_MS old: a log quiet for over an hour is looked at once a minute, not every round
// A log gone from its folder's listing is forgotten. At most `jobs` folder reads and stats are out at once, so libuv's
// pool (four threads) keeps room for the poll's own stats and reads. Nothing here blocks the event loop.
//
//   createSweep({ roots, fsp, now, want, jobs }) -> {
//     round() -> Promise          one round over every folder (call it again for another: a round asked for while
//                                 one runs gets that one)
//     statFiles(files, projs?) -> Promise   stats just these logs, and every log in the project folders projs(name)
//                                 picks: the start's first read, before any full listing (the logs the last run
//                                 showed, the ones the history index has as recent, the bots' folders)
//     list()                      every log known: [{ file, name, id, proj, pdir, account, root, m }], m its mtimeMs
//                                 (0 when its stat failed)
//     mtimeOf(file)               its known mtimeMs, or undefined
//     full, at, ms, gen           a round has listed every folder; when the last round ended, how long it took, rounds
//     stats()                     { files, rounds, lastMs, lastStats, lastLists, full } for /health
//   }
//   roots() -> [{ dir, account }]  the projects folders, both accounts'
'use strict';
const fs = require('fs');
const path = require('path');

// JOBS a round at once; statFiles FIRST_JOBS (the start's first read, when nothing else reads)
const HOT_MS = 3600e3, OLD_EVERY_MS = 60e3, JOBS = 2, FIRST_JOBS = 4;
// both are case-insensitive by default
const fold = (p) => (process.platform === 'win32' || process.platform === 'darwin' ? path.resolve(p).toLowerCase() : path.resolve(p));

function createSweep({ roots, fsp = fs.promises, now = Date.now, want = () => false, jobs = JOBS }) {
  const files = new Map(); // file -> entry
  const out = { full: false, at: 0, ms: 0, gen: 0 };
  let running = null, lastStats = 0, lastLists = 0;

  // fn over items, at most n at once
  async function pool(items, fn, n = jobs) {
    let i = 0;
    const run = async () => { while (i < items.length) await fn(items[i++]); };
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
  }
  const entry = (file, name, proj, pdir, r) => ({ file, name, id: name.slice(0, -6), proj, pdir, account: r.account, root: r.dir, m: 0, statAt: 0 });
  async function stat(e) {
    try { e.m = (await fsp.stat(e.file)).mtimeMs; } catch { e.m = 0; }
    e.statAt = now();
  }
  const listDir = (d) => fsp.readdir(d).catch(() => null); // null: not a folder, or gone

  async function doRound() {
    const t0 = now(), rs = roots() || [];
    const dirs = [];
    await pool(rs, async (r) => { for (const proj of (await listDir(r.dir)) || []) dirs.push({ r, proj, pdir: path.join(r.dir, proj) }); });
    const seen = new Set(), due = [];
    await pool(dirs, async (d) => {
      const names = await listDir(d.pdir);
      for (const name of names || []) {
        if (!name.endsWith('.jsonl')) continue;
        const file = path.join(d.pdir, name);
        seen.add(file);
        let e = files.get(file);
        if (!e) files.set(file, (e = entry(file, name, d.proj, d.pdir, d.r)));
        const t = now();
        if (!e.statAt || want(e.id) || t - e.m < HOT_MS || t - e.statAt >= OLD_EVERY_MS) due.push(e);
      }
    });
    await pool(due, stat);
    for (const f of [...files.keys()]) if (!seen.has(f)) files.delete(f);
    lastStats = due.length;
    lastLists = dirs.length + rs.length;
    out.full = true;
    out.at = now();
    out.ms = out.at - t0;
    out.gen++;
  }
  function round() {
    if (!running) running = doRound().finally(() => { running = null; });
    return running;
  }
  async function statFiles(list, projs) {
    const rs = (roots() || []).map((r) => ({ r, key: fold(r.dir) }));
    const rootOf = (dir) => { const k = fold(dir); const x = rs.find((y) => y.key === k); return x ? x.r : null; };
    const want = new Map();
    const add = (file) => {
      const name = path.basename(file), pdir = path.dirname(file), r = name.endsWith('.jsonl') ? rootOf(path.dirname(pdir)) : null;
      if (r && !want.has(file)) want.set(file, files.get(file) || entry(file, name, path.basename(pdir), pdir, r));
    };
    for (const f of list || []) if (typeof f === 'string' && f) add(f);
    if (projs) {
      await pool(rs, async ({ r }) => {
        for (const proj of (await listDir(r.dir)) || []) {
          if (!projs(proj)) continue;
          const pdir = path.join(r.dir, proj);
          for (const name of (await listDir(pdir)) || []) if (name.endsWith('.jsonl')) add(path.join(pdir, name));
        }
      });
    }
    await pool([...want.values()], async (e) => { await stat(e); if (e.m) files.set(e.file, e); }, FIRST_JOBS);
  }
  return Object.assign(out, {
    round, statFiles,
    list: () => [...files.values()],
    mtimeOf: (file) => { const e = files.get(file); return e ? e.m : undefined; },
    stats: () => ({ files: files.size, rounds: out.gen, lastMs: out.ms, lastStats, lastLists, full: out.full }),
  });
}

module.exports = { createSweep, HOT_MS, OLD_EVERY_MS };
