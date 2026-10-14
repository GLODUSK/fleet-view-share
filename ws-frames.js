// ws-frames.js: the server side of RFC 6455 framing, no npm package, used by live.js (the page's /live socket).
// Only what a server needs: the handshake's accept value, a frame to send (never masked), and a reader for what a
// client sends (always masked). The caller keeps its own policy
// (who may connect, what a message means, how big one may be); this file only cuts bytes into frames.
//
// The reader works on the caller's connection object c, which holds its state in these fields:
//   chunks, have, need   the bytes read but not used yet, their count, and how many the next step needs (start: [], 0, 2)
//   frag                 a fragmented message being put together ({ parts, size }), or null
//   missed               pings the client left unanswered; any frame from it sets this back to 0
//   closing, gone        the close handshake was started; the socket is gone (both set by the caller)
// and calls the caller's handlers h:
//   h.max                the largest message, all its frames together (bytes); past it the reader closes with 1009
//   h.close(code, why)   start the close handshake (the caller writes the close frame and lets the socket go later)
//   h.message(buf)       one whole text or binary message; returns false when it closed the socket for it
//   h.pong(data)         answer a ping with this payload
//   h.gone()             the client's close frame arrived and was answered: let the socket go now
//   h.frame(op)          optional: called for every frame (control and continuation ones too); returning false means
//                        the caller closed the socket for it (a per-socket frame budget)
// Rules: version 13 only, no extensions (RSV bits set: 1002), client frames must be masked (1002), control frames
// must be whole and at most 125 bytes (1002), 16- and 64-bit lengths (a length over 4 GB: 1009), continuation frames,
// ping, pong and the close handshake; an unknown opcode is 1002. A message in more than PARTS_MAX frames is 1009 (empty
// continuation frames would otherwise grow it without its size ever moving). Once the close handshake started, every
// frame but the client's close is read and thrown away.
'use strict';
const crypto = require('crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const PARTS_MAX = 1024;

// the client's Sec-WebSocket-Key -> the Sec-WebSocket-Accept value, or null when the key is not 16 bytes of base64
function acceptKey(key) {
  const k = String(key || '').trim();
  if (!/^[A-Za-z0-9+/]{22}==$/.test(k) || Buffer.from(k, 'base64').length !== 16) return null;
  return crypto.createHash('sha1').update(k + GUID).digest('base64');
}

// one frame from the server: FIN set, never masked
function frame(op, payload) {
  const len = payload.length;
  let head;
  if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
  else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[1] = 127; head.writeUInt32BE(Math.floor(len / 2 ** 32), 2); head.writeUInt32BE(len >>> 0, 6); }
  head[0] = 0x80 | op;
  return Buffer.concat([head, payload]);
}

// the close frame's payload: the code, then the reason (at most 120 bytes of it)
function closePayload(code, reason = '') {
  const r = Buffer.from(String(reason).slice(0, 120));
  const p = Buffer.alloc(2 + r.length);
  p.writeUInt16BE(code, 0);
  r.copy(p, 2);
  return p;
}

// a fresh connection state, to spread into the caller's object
const state = () => ({ chunks: [], have: 0, need: 2, frag: null, missed: 0, closing: false, gone: false });

// bytes from the client: as many whole frames as they hold
function feed(c, chunk, h) {
  if (c.gone) return;
  c.chunks.push(chunk);
  c.have += chunk.length;
  if (c.have > h.max + 64) { c.chunks = []; c.have = 0; c.need = 2; return h.close(1009, 'message too big'); }
  while (!c.gone && c.have >= c.need) {
    const b = c.chunks.length === 1 ? c.chunks[0] : Buffer.concat(c.chunks, c.have);
    c.chunks = [b];
    const used = parseFrame(c, b, h);
    if (used < 0) return; // closed
    if (used === 0) return; // c.need was raised: wait for more
    const rest = b.subarray(used);
    c.chunks = rest.length ? [rest] : [];
    c.have = rest.length;
    c.need = 2;
  }
}

// one frame from the front of b: the bytes it took, 0 when more are needed (c.need says how many), -1 when closed
function parseFrame(c, b, h) {
  if (b.length < 2) { c.need = 2; return 0; }
  const fin = (b[0] & 0x80) !== 0, op = b[0] & 0x0f;
  if (b[0] & 0x70) { h.close(1002, 'no extensions'); return -1; }
  if (!(b[1] & 0x80)) { h.close(1002, 'client frames must be masked'); return -1; }
  let len = b[1] & 0x7f, off = 2;
  if (len === 126) {
    if (b.length < 4) { c.need = 4; return 0; }
    len = b.readUInt16BE(2); off = 4;
  } else if (len === 127) {
    if (b.length < 10) { c.need = 10; return 0; }
    if (b.readUInt32BE(2) !== 0) { h.close(1009, 'message too big'); return -1; }
    len = b.readUInt32BE(6); off = 10;
  }
  if (op >= 0x8 && (!fin || len > 125)) { h.close(1002, 'bad control frame'); return -1; }
  if (len > h.max) { h.close(1009, 'message too big'); return -1; }
  const total = off + 4 + len;
  if (b.length < total) { c.need = total; return 0; }
  const mask = b.subarray(off, off + 4);
  const data = Buffer.from(b.subarray(off + 4, total));
  for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
  c.missed = 0; // anything from it means it is there
  if (c.closing && op !== 0x8) return total; // closing: only its close frame still counts
  if (h.frame && h.frame(op) === false) return -1;
  switch (op) {
    case 0x0: // continuation
      if (!c.frag) { h.close(1002, 'nothing to continue'); return -1; }
      c.frag.size += data.length;
      if (c.frag.size > h.max || c.frag.parts.length >= PARTS_MAX) { h.close(1009, 'message too big'); return -1; }
      c.frag.parts.push(data);
      if (fin) { const m = Buffer.concat(c.frag.parts, c.frag.size); c.frag = null; if (!h.message(m)) return -1; }
      return total;
    case 0x1: case 0x2: // text, binary
      if (c.frag) { h.close(1002, 'a message is still open'); return -1; }
      if (!fin) { c.frag = { parts: [data], size: data.length }; return total; }
      return h.message(data) ? total : -1;
    case 0x8: { // close: answer it (with its code, or 1000) and let the socket go
      if (data.length === 1) { h.close(1002, 'bad close frame'); return -1; }
      if (!c.closing) {
        const code = data.length >= 2 ? data.readUInt16BE(0) : 1000;
        const ok = (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1011) || (code >= 3000 && code <= 4999);
        h.close(ok ? code : 1002);
      }
      setImmediate(() => h.gone());
      return -1;
    }
    case 0x9: h.pong(data); return total; // ping: pong with its payload
    case 0xA: return total; // pong
    default: h.close(1002, 'unknown opcode'); return -1;
  }
}

module.exports = { GUID, PARTS_MAX, acceptKey, frame, closePayload, state, feed };
