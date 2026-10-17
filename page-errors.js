// Fleet View: the log of the page's own errors (review 2026-10-17: one error while drawing froze the map and the sky
// until a reload, and nothing anywhere said so; a session checking server.log or window.log could not see it).
//
// The page (web/head.js window.fvPageError) posts the first error a minute: an uncaught error, an unhandled promise
// rejection, or one the map caught in a frame or a rebuild (web/map.js pageError). It lands in <data>/page-errors.log as
// JSON lines: { at (ISO), local (this machine's clock), version (this server's, version.js), where ('map frame',
// 'map rebuild', 'window', 'promise'...), message, stack, more (errors the page held back since the one before) }.
// At LOG_MAX it moves to page-errors.log.1 (replacing the older one). Only the error's message and stack, never what a
// conversation says. The server takes at most PER_MIN lines a minute, from all its pages together (each page already
// sends one a minute; a page on another machine, or a dozen windows, must not fill the disk).
//
//   createPageErrors({ dir, version?, now? }) -> { log(e) -> line | null, recent(n), route(method, body) -> [code, out] }
//   GET  /page-errors   { recent: the last 50 lines, newest last }
//   POST /page-errors { where, message, stack, more }   one more line (429 over PER_MIN)
'use strict';
const fs = require('fs');
const path = require('path');

const LOG_MAX = 1 << 20, RECENT = 50, PER_MIN = 20;
const str = (v, n) => (typeof v === 'string' && v ? v.slice(0, n) : null);
const pad = (v) => String(v).padStart(2, '0');
const localTime = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

function createPageErrors({ dir, version = () => '', now = () => new Date() }) {
  const LOG = path.join(dir, 'page-errors.log');
  let minute = 0, count = 0;
  // a line written, or null: a bad body, over PER_MIN this minute, or the disk said no
  function log(e) {
    if (!e || typeof e !== 'object') return null;
    const message = str(e.message, 300);
    if (!message) return null;
    const d = now(), m = Math.floor(d.getTime() / 60000);
    if (m !== minute) { minute = m; count = 0; }
    if (++count > PER_MIN) return null;
    let v = '';
    try { v = String(typeof version === 'function' ? version() : version || ''); } catch {}
    const line = { at: d.toISOString(), local: localTime(d), version: v.slice(0, 40), where: str(e.where, 40) || 'page', message,
      stack: str(e.stack, 2000), more: Number.isFinite(e.more) && e.more > 0 ? Math.min(Math.round(e.more), 1e6) : 0 };
    try {
      fs.mkdirSync(dir, { recursive: true });
      try { if (fs.statSync(LOG).size > LOG_MAX) fs.renameSync(LOG, LOG + '.1'); } catch {}
      fs.appendFileSync(LOG, JSON.stringify(line) + '\n');
    } catch { return null; }
    return line;
  }
  function recent(n = RECENT) {
    let text = '';
    try { text = fs.readFileSync(LOG, 'utf8'); } catch { return []; }
    const out = [];
    for (const l of text.split('\n').slice(-n - 1)) { if (!l) continue; try { out.push(JSON.parse(l)); } catch {} }
    return out.slice(-n);
  }
  function route(method, b) {
    if (method === 'GET') return [200, { recent: recent() }];
    if (!b || typeof b !== 'object' || !str(b.message, 300)) return [400, { ok: false, message: 'bad error' }];
    return log(b) ? [200, { ok: true }] : [429, { ok: false, message: 'not logged' }];
  }
  return { log, recent, route };
}

module.exports = { createPageErrors, LOG_MAX, PER_MIN };
