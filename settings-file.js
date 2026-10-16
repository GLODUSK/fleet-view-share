// Safe reads and writes of ~/.fleet-view.json, the server's settings: it holds the bots registry, teams, names, the
// hidden list and the rest, so a torn write or a hand edit that broke it must never quietly turn into {} and then be
// saved over the only copy.
//
//   read(file, { log, fallback }) -> object. Strips a UTF-8 BOM (Windows PowerShell 5.1 and old Notepad add one). A
//     file that does not parse to an object is moved aside to <file>.corrupt-<time> and <file>.bak is used instead,
//     else {}. A file it can't read (locked) is tried again a few times, then .bak is used. A missing file reads as
//     <file>.bak when that parses (said in the log), else the fallback file (another path to read in its place),
//     else {}. log(text) says what happened. readOnly (a
//     server that never saves, the demo): a broken file is left where it is. Never throws.
//   peek(file) -> the object on disk now, or null (missing, unreadable, not an object). Changes nothing.
//   write(file, obj, { log }) -> true when written, false when the file already held exactly this. Writes
//     <file>.<pid>.tmp, flushes it to disk and renames it over the file; on Windows a rename that the antivirus or a
//     reader holding the file blocks is tried again a few times, then the file is written in place. The file it
//     replaces is first copied to <file>.bak when it parses (so .bak is the last good file), or moved aside to
//     <file>.corrupt-<time> when it doesn't (a broken hand edit is kept, never written over). Throws when it can't.
//   snapshot(obj) -> { key: JSON text }, what merge compares against: the file as loaded, then each write's ours.
//   merge(ours, base, disk) -> { out, base }. out is what to write: per top-level key, ours where this process
//     changed it since base, else disk's as it is now, so a key a hand edit (or another writer) changed meanwhile is
//     kept instead of being put back to what this process loaded. base is the next merge's. disk null: ours.
'use strict';
const fs = require('fs');

const RETRY = new Set(['EPERM', 'EBUSY', 'EACCES']);
const WAITS = [20, 50, 100, 200]; // ms between tries of a rename or read something else holds
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// the object in text, or null when it is not JSON or not an object
function parse(text) {
  try {
    const j = JSON.parse(String(text).replace(/^\uFEFF/, ''));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
  } catch { return null; }
}

// the file's text; a locked file (EBUSY and the like) is tried again a few times. Throws as readFileSync does.
function readText(file) {
  for (let i = 0; ; i++) {
    try { return fs.readFileSync(file, 'utf8'); } catch (e) {
      if (!RETRY.has(e.code) || i >= WAITS.length) throw e;
      sleep(WAITS[i]);
    }
  }
}

// 20261014-153012, local time
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// a file that does not parse goes to <file>.corrupt-<time> (a second one in the same second gets -2, -3...);
// its new name, or null when it could not be moved
function moveAside(file) {
  let to = `${file}.corrupt-${stamp()}`;
  for (let n = 2; fs.existsSync(to); n++) to = `${file}.corrupt-${stamp()}-${n}`;
  try { fs.renameSync(file, to); return to; } catch {}
  try { fs.copyFileSync(file, to); return to; } catch { return null; }
}

function fromBak(file, log) {
  const bak = file + '.bak';
  let text;
  try { text = readText(bak); } catch { log(`no ${bak} to fall back on: starting with empty settings`); return {}; }
  const j = parse(text);
  if (!j) { log(`${bak} does not parse either: starting with empty settings`); return {}; }
  let at = '';
  try { at = ` (saved ${fs.statSync(bak).mtime.toISOString()})`; } catch {}
  log(`using ${bak}${at} instead`);
  return j;
}

function read(file, o = {}) {
  const log = o.log || (() => {});
  let text;
  try { text = readText(file); } catch (e) {
    if (e.code === 'ENOENT') {
      // gone with its .bak still there (a crash between saves lost it): the .bak, never the fallback's or empty
      // settings, which the next save would make the only copy (the bots registry went that way on 2026-10-14)
      const bak = peek(file + '.bak');
      if (bak) { log(`${file} is missing: using ${file}.bak instead`); return bak; }
      return o.fallback ? read(o.fallback, { log, readOnly: o.readOnly }) : {};
    }
    log(`could not read ${file}: ${e.message}`);
    return fromBak(file, log);
  }
  const j = parse(text);
  if (j) return j;
  const to = o.readOnly ? null : moveAside(file);
  log(`${file} does not parse${text.trim() ? '' : ' (it is empty)'}: ${to ? `moved it to ${to}` : o.readOnly ? 'left as it is' : 'could not move it aside'}`);
  return fromBak(file, log);
}

function peek(file) {
  try { return parse(readText(file)); } catch { return null; }
}

// written and flushed to disk, so a power cut after the rename finds the whole file
function writeDurable(file, text) {
  const fd = fs.openSync(file, 'w');
  try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function write(file, obj, o = {}) {
  const log = o.log || (() => {});
  const text = JSON.stringify(obj, null, 2);
  let prev = null;
  try { prev = readText(file); } catch {}
  if (prev === text) return false;
  if (prev !== null) {
    if (parse(prev)) { try { fs.copyFileSync(file, file + '.bak'); } catch {} }
    else { const to = moveAside(file); log(`${file} did not parse before this save: ${to ? `kept it as ${to}` : 'could not keep a copy'}`); }
  }
  const tmp = `${file}.${process.pid}.tmp`;
  const drop = () => { try { fs.unlinkSync(tmp); } catch {} };
  try { writeDurable(tmp, text); } catch (e) { drop(); throw e; }
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return true; } catch (e) {
      if (!RETRY.has(e.code)) { drop(); throw e; }
      if (i < WAITS.length) { sleep(WAITS[i]); continue; }
      // still held after every try: written in place, as it always was before
      log(`could not rename ${tmp} over ${file} (${e.code}): written in place`);
      try { fs.writeFileSync(file, text); } finally { drop(); }
      return true;
    }
  }
}

function snapshot(obj) {
  const s = {};
  for (const [k, v] of Object.entries(obj || {})) if (v !== undefined) s[k] = JSON.stringify(v);
  return s;
}

function merge(ours, base, disk) {
  const next = snapshot(ours);
  if (!disk) return { out: ours, base: next };
  const out = {};
  for (const k of new Set([...Object.keys(ours), ...Object.keys(disk)])) {
    const v = next[k] === (base || {})[k] ? disk[k] : ours[k];
    if (v !== undefined) out[k] = v;
  }
  return { out, base: next };
}

module.exports = { read, peek, write, snapshot, merge };
