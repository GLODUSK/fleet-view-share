// Fleet View: what the server's usage scan has read of each log, kept across restarts in <data>/scan-cache.json.
// fleet-view.js's scanUsage reads every log a conversation owns from the start (its own and its agents'), a few MB a
// poll, for the tokens and cost of every reply and the PR links. Each restart read it all again: about 314 MB for the
// 30 conversations on the map (2026-10-17), a minute of polls with the event loop held 131 ms per 8 MB, the header's
// cost climbing from a small number meanwhile, and the bots' logs (which never hand off and grow 4 MB a day) read
// whole into one string for their PR links. With this, a restart takes each log up where the last run left it.
//
// Per log: off, the byte offset just past the last whole line read; tail, the bytes before off (up to TAIL_BYTES), to
// tell the same log grown from another one put in its place; size and m (mtimeMs) at the save; u, each reply's
// [tokens, cost, minute] by message id (the dedupe: a streamed reply is logged once per block, and a fork copies its
// source's replies; minute: the start of the minute it was logged in, ms, or null, for this PC's spend, which
// usage-watch.js keeps per minute in memory only and judges usage from elsewhere by: given back through the same dedupe
// as a read of the log, it counts once whichever of a fork and its source is on the map); prs, its PR links
// [number, repo, time].
//
//   createScanCache({ file, now, keepMs, sig }) -> {
//     sig                    what the counts were made with (fleet-view.js: its price list and counting rules): a file
//                            made with another is not used, so a price put right reaches every log (each is read
//                            again once) instead of only the replies counted after it
//     load()                 reads the file once (missing, unreadable or another sig's: an empty cache)
//     take(path) -> entry    the saved state of one log, handed out once (null when there is none); the caller checks
//                            it still fits the log (fits) before it counts any of it
//     save(live, { sync })   live: [path, state] pairs (the scan's states, in the shape below). Writes when anything
//                            changed since the last save (a temp file and a rename), and never before load(). Entries
//                            not live are kept until keepMs after they last were. Resolves (or, sync, returns) true
//                            when it wrote
//     size()
//   }
//   fits(entry, size, m, readAt) -> true when the saved state is this log's: unchanged since (size and m), or longer
//     with the same bytes before off (readAt(pos, len) -> Buffer: one small read of the log)
//   state: { off, tail: Buffer, u: Map(id -> [tok, cost, minute | null]), prs: Map(n -> [n, repo, t]), size, m }
'use strict';
const fs = require('fs');
const path = require('path');

const VERSION = 1;
const KEEP_MS = 3 * 24 * 3600e3, TAIL_BYTES = 128;
const fin = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const r7 = (v) => Math.round(v * 1e7) / 1e7;

function fits(e, size, m, readAt) {
  if (!e || !(e.off >= 0) || !(size >= e.off)) return false;
  if (size === e.size && m === e.m) return true;
  const n = e.tail ? e.tail.length : 0;
  if (!n) return e.off === 0;
  let got = null;
  try { got = readAt(e.off - n, n); } catch { return false; }
  return !!got && got.length === n && Buffer.compare(got, e.tail) === 0;
}

// a saved entry (JSON) -> the scan's state shape, or null when it is malformed
function fromJson(j) {
  if (!j || typeof j !== 'object') return null;
  const off = fin(j.off), size = fin(j.size), m = fin(j.m);
  if (off === null || off < 0 || size === null || m === null) return null;
  const u = new Map(), prs = new Map();
  for (const x of Array.isArray(j.u) ? j.u : []) if (Array.isArray(x) && typeof x[0] === 'string' && fin(x[1]) !== null && fin(x[2]) !== null) u.set(x[0], [x[1], x[2], fin(x[3])]);
  for (const x of Array.isArray(j.prs) ? j.prs : []) if (Array.isArray(x) && fin(x[0]) !== null && typeof x[1] === 'string') prs.set(x[0], [x[0], x[1], fin(x[2]) || 0]);
  let tail = Buffer.alloc(0);
  try { if (typeof j.tail === 'string') tail = Buffer.from(j.tail, 'base64'); } catch {}
  return { off, size, m, tail, u, prs, seen: fin(j.seen) || 0 };
}
function toJson(st, seen) {
  return {
    off: st.off, size: st.size, m: st.m, seen, tail: st.tail && st.tail.length ? Buffer.from(st.tail).toString('base64') : '',
    u: [...(st.u || [])].map(([id, v]) => [id, v[0], r7(v[1]), fin(v[2])]),
    prs: [...(st.prs || []).values()],
  };
}

function createScanCache({ file, now = Date.now, keepMs = KEEP_MS, sig: madeWith = '' }) {
  // path -> its JSON entry: the file's, and a live state's as it was last saved once it is live no more (its
  // conversation left the map), written back as they are until keepMs after they were last live
  const saved = new Map();
  const taken = new Set(); // paths handed out: once per run (a log read again is read from the start)
  let lastLive = new Map(), lastSig = null, loaded = false;
  function load() {
    if (loaded) return;
    loaded = true;
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (j && j.v === VERSION && (j.sig || '') === madeWith && j.files && typeof j.files === 'object') for (const [p, e] of Object.entries(j.files)) if (e && typeof e === 'object') saved.set(p, e);
    } catch {}
  }
  // handed out, an entry stays in `saved` as it was: the scan's live state is written in its place while there is one,
  // and it stands again for a log whose conversation left the map before a save had its live state
  function take(p) {
    if (taken.has(p)) return null;
    taken.add(p);
    const j = saved.get(p);
    return j ? fromJson(j) : null;
  }
  // what goes in the file: the live states, then the others seen in the last keepMs. sig says what changed, so an
  // unchanged cache is not even turned into JSON (body is null then)
  function build(live) {
    const t = now(), files = {}, nowLive = new Map(), states = [];
    let sig = '';
    for (const [p, st] of live) {
      if (!st || !(st.off > 0) || fin(st.size) === null || fin(st.m) === null) continue;
      states.push([p, st]);
      sig += `${p}\u0000${st.off}\u0000${st.u ? st.u.size : 0}\u0000${st.prs ? st.prs.size : 0}\n`;
    }
    // a log live at the last save and not now: kept as it was then
    const liveNow = new Set(states.map(([p]) => p));
    for (const [p, j] of lastLive) if (!liveNow.has(p)) saved.set(p, j);
    for (const [p, e] of saved) {
      if (liveNow.has(p)) continue;
      if (!(t - (fin(e.seen) || 0) < keepMs)) { saved.delete(p); continue; }
      sig += `${p}\u0000${e.seen}\n`;
    }
    if (sig === lastSig) return { body: null, sig }; // the same logs at the same offsets as the last save
    for (const [p, st] of states) { const j = toJson(st, t); files[p] = j; nowLive.set(p, j); }
    lastLive = nowLive;
    for (const [p, e] of saved) if (!files[p]) files[p] = e;
    return { body: JSON.stringify({ v: VERSION, sig: madeWith, at: t, files }), sig };
  }
  // writing: an async save under way (the next waits for its turn); closed: the exit's save is written, and an async
  // one finishing after it must not put an older file over it
  let writing = false, closed = false;
  function save(live, { sync = false } = {}) {
    const no = sync ? false : Promise.resolve(false);
    // never before load(): the file's entries would be lost
    if (!loaded || closed || (!sync && writing)) return no;
    if (sync) closed = true;
    let b = null;
    try { b = build(live); } catch {}
    if (!b || !b.body || b.sig === lastSig) return no;
    if (sync) {
      const tmp = file + '.tmp-exit';
      try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(tmp, b.body); fs.renameSync(tmp, file); lastSig = b.sig; return true; } catch { return false; }
    }
    const fsp = fs.promises, tmp = file + '.tmp';
    writing = true;
    return fsp.mkdir(path.dirname(file), { recursive: true }).then(() => fsp.writeFile(tmp, b.body))
      .then(() => { if (closed) return false; return fsp.rename(tmp, file).then(() => { lastSig = b.sig; return true; }); })
      .catch(() => false).finally(() => { writing = false; });
  }
  return { load, take, save, size: () => saved.size };
}

module.exports = { createScanCache, fits, fromJson, toJson, TAIL_BYTES, KEEP_MS };
