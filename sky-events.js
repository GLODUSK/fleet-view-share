// Fleet View: the log of the map's sky events, and the kinds switched off (Henry, 2026-10-14: "make sure we keep track of
// them so i can point out 'hey what was that?' at the specific time so we can get rid of them").
//
// The map (web/map.js skyLog) posts one line each time a space event or a far event (web/sky-far.js) starts; it lands in
// <data>/sky-events.log as JSON lines: { at (ISO), local (this machine's clock, "2026-10-14 15:42:07"), kind, label, what,
// ms, where ("upper left"...), x, y, w, h }. At LOG_MAX it moves to sky-events.log.1 (replacing the older one).
// "What was that at 3:42?": the line whose local time is just before then, and still running (ms) at it.
// The kinds switched off live in <data>/sky-events.json ({ off: [kind] }); the map reads them (GET) every couple of minutes
// and never shows those again; one running when it is switched off ends.
//
//   createSkyEvents({ dir }) -> { log(shown), recent(n), off(), setOff(list), route(method, body) -> [code, out] }
//   GET  /sky-events            { off, recent: the last 50 lines, newest last }
//   POST /sky-events { shown }  one more line;  { off: [kind] } replaces the list;  { offAdd: kind } / { offRemove: kind }
'use strict';
const fs = require('fs');
const path = require('path');

const LOG_MAX = 1 << 20, OFF_MAX = 200, RECENT = 50;
const KIND = /^[a-z0-9-]{1,40}$/;
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);
const num = (v) => (Number.isFinite(v) ? Math.round(v) : null);
const pad = (v) => String(v).padStart(2, '0');
const localTime = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

function createSkyEvents({ dir, now = () => new Date() }) {
  const LOG = path.join(dir, 'sky-events.log'), OFF = path.join(dir, 'sky-events.json');
  let off = null;
  const readOff = () => {
    if (off) return off;
    try { const j = JSON.parse(fs.readFileSync(OFF, 'utf8')); off = Array.isArray(j.off) ? j.off.filter((k) => KIND.test(k)).slice(0, OFF_MAX) : []; } catch { off = []; }
    return off;
  };
  const writeOff = (list) => {
    off = [...new Set(list.filter((k) => typeof k === 'string' && KIND.test(k)))].slice(0, OFF_MAX);
    try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(OFF, JSON.stringify({ off }, null, 2)); } catch {}
    return off;
  };
  function log(shown) {
    if (!shown || typeof shown !== 'object' || !KIND.test(shown.kind || '')) return false;
    const d = now();
    const line = { at: d.toISOString(), local: localTime(d), kind: shown.kind, label: str(shown.label, 80), what: str(shown.what, 300), ms: num(shown.ms),
      where: str(shown.where, 30), x: num(shown.x), y: num(shown.y), w: num(shown.w), h: num(shown.h) };
    try {
      fs.mkdirSync(dir, { recursive: true });
      try { if (fs.statSync(LOG).size > LOG_MAX) fs.renameSync(LOG, LOG + '.1'); } catch {}
      fs.appendFileSync(LOG, JSON.stringify(line) + '\n');
    } catch { return false; }
    return true;
  }
  function recent(n = RECENT) {
    let text = '';
    try { text = fs.readFileSync(LOG, 'utf8'); } catch { return []; }
    const out = [];
    for (const l of text.split('\n').slice(-n - 1)) { if (!l) continue; try { out.push(JSON.parse(l)); } catch {} }
    return out.slice(-n);
  }
  function route(method, b) {
    if (method === 'GET') return [200, { off: readOff(), recent: recent() }];
    if (!b || typeof b !== 'object') return [400, { ok: false, message: 'bad json' }];
    if (b.shown) return log(b.shown) ? [200, { ok: true }] : [400, { ok: false, message: 'bad event' }];
    if (Array.isArray(b.off)) return [200, { ok: true, off: writeOff(b.off) }];
    if (typeof b.offAdd === 'string') return [200, { ok: true, off: writeOff(readOff().concat(b.offAdd)) }];
    if (typeof b.offRemove === 'string') return [200, { ok: true, off: writeOff(readOff().filter((k) => k !== b.offRemove)) }];
    return [400, { ok: false, message: 'nothing to do' }];
  }
  return { log, recent, off: readOff, setOff: writeOff, route };
}

module.exports = { createSkyEvents };
