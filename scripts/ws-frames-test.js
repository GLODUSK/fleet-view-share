// ws-frames.js and live.js on top of it: a test, run with the system node:   node scripts/ws-frames-test.js
// The frame reader alone (a fake connection object): the RFC 6455 accept value, frame headers at every length step,
// a masked text message, one fed a byte at a time, a fragmented one, ping -> pong, the close handshake, and what it
// refuses (unmasked, RSV bits, an oversized header before its body, a long or fragmented control frame, a continuation
// with nothing to continue, an unknown opcode). Then live.js over a real socket on a spare port, its session host
// pointed at a test pipe that is not there (FV_HOST_PIPE, FV_HOST_DIR: the running host on this PC is never touched):
// 404 off /live, 403 with no Origin, then { t: 'host', up: false }, list -> [], an unknown op, a fragmented request,
// ping -> pong, and an unmasked frame closed with 1002. Exit 0 = all pass.
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-frames-test-'));
// before live.js (and desktop/host.js) load: a session host that is not running, in a folder of this test's own
process.env.FV_HOST_PIPE = process.platform === 'win32' ? `\\\\.\\pipe\\fleet-view-host-wsft${process.pid}` : path.join(T, `fleet-view-host-wsft${process.pid}.sock`);
process.env.FV_HOST_DIR = T;
const WF = require(path.join(ROOT, 'ws-frames.js'));

let failures = 0, passes = 0;
const ok = (cond, what) => { if (cond) passes++; else { failures++; console.log(`FAIL ${what}`); } };
const eq = (a, b, what) => ok(JSON.stringify(a) === JSON.stringify(b), `${what}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(pred, ms = 3000) { const end = Date.now() + ms; for (;;) { const v = pred(); if (v) return v; if (Date.now() > end) return null; await sleep(5); } }

function clientFrame(op, payload, o = {}) {
  const len = o.len !== undefined ? o.len : payload.length;
  let head;
  if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
  else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[1] = 127; head.writeUInt32BE(Math.floor(len / 2 ** 32), 2); head.writeUInt32BE(len >>> 0, 6); }
  head[0] = (o.fin === false ? 0 : 0x80) | (o.rsv ? 0x40 : 0) | op;
  if (o.unmasked) return Buffer.concat([head, payload]);
  head[1] |= 0x80;
  const mask = crypto.randomBytes(4), data = Buffer.from(payload);
  for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
  return Buffer.concat([head, mask, data]);
}

// a connection object as live.js and relay-lan.js keep one, its handlers recording what the reader asked for
function fakeConn(max = 1000) {
  const c = { ...WF.state(), got: [], closes: [], pongs: [], goneN: 0 };
  c.h = {
    max,
    close: (code, why) => { if (!c.closing) { c.closing = true; c.closes.push([code, why]); } },
    message: (b) => { c.got.push(b.toString('utf8')); return true; },
    pong: (d) => c.pongs.push(d.toString('utf8')),
    gone: () => { c.goneN++; c.gone = true; },
  };
  return c;
}

async function frames() {
  eq(WF.acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=', 'the accept value of RFC 6455\'s example key');
  ok(WF.acceptKey('nope') === null && WF.acceptKey('') === null && WF.acceptKey(undefined) === null, 'a bad key: null');
  {
    // empty continuation frames never move a message's size: past PARTS_MAX of them it is 1009 all the same
    const c = fakeConn();
    WF.feed(c, clientFrame(0x1, Buffer.from('a'), { fin: false }), c.h);
    const empty = clientFrame(0x0, Buffer.alloc(0), { fin: false });
    WF.feed(c, Buffer.concat(Array.from({ length: WF.PARTS_MAX + 5 }, () => empty)), c.h);
    eq(c.closes.map((x) => x[0]), [1009], 'a message in more than PARTS_MAX frames (empty ones): closed 1009');
    ok(!c.frag || c.frag.parts.length <= WF.PARTS_MAX, 'and its parts stop growing');
  }
  {
    // closing: every frame but the close is read and thrown away (no message, no pong)
    const c = fakeConn();
    c.closing = true;
    WF.feed(c, Buffer.concat([clientFrame(0x1, Buffer.from('late')), clientFrame(0x9, Buffer.from('p'))]), c.h);
    ok(c.got.length === 0 && c.pongs.length === 0, 'after the close handshake started, messages and pings are ignored');
    WF.feed(c, clientFrame(0x8, Buffer.from([0x03, 0xe8])), c.h);
    await waitUntil(() => c.goneN === 1, 500);
    ok(c.goneN === 1, "but the client's close still lets the socket go");
  }
  {
    // h.frame: every frame goes through the caller's budget, and false stops the reader
    const c = fakeConn();
    let n = 0;
    c.h.frame = () => { n++; if (n > 3) { c.h.close(1008); return false; } return true; };
    WF.feed(c, Buffer.concat(Array.from({ length: 6 }, () => clientFrame(0x9, Buffer.alloc(0)))), c.h);
    ok(n === 4 && c.pongs.length === 3 && c.closes[0][0] === 1008, `h.frame sees pings too, and false stops reading (${n}, ${c.pongs.length})`);
  }
  for (const [n, head] of [[0, 2], [125, 2], [126, 4], [65535, 4], [65536, 10]]) {
    const f = WF.frame(0x2, Buffer.alloc(n));
    ok(f.length === n + head && f[0] === 0x82 && !(f[1] & 0x80), `a server frame of ${n} bytes: a ${head}-byte header, FIN, not masked`);
  }
  eq([...WF.closePayload(1008)], [0x03, 0xf0], 'the close payload: the code alone');

  let c = fakeConn();
  WF.feed(c, clientFrame(0x1, Buffer.from('{"a":1}')), c.h);
  eq(c.got, ['{"a":1}'], 'a masked text message');
  c = fakeConn();
  const two = Buffer.concat([clientFrame(0x1, Buffer.from('one')), clientFrame(0x1, Buffer.from('two'))]);
  for (const byte of two) WF.feed(c, Buffer.from([byte]), c.h);
  eq(c.got, ['one', 'two'], 'two messages fed a byte at a time');
  c = fakeConn();
  WF.feed(c, Buffer.concat([clientFrame(0x1, Buffer.from('hel'), { fin: false }), clientFrame(0x9, Buffer.from('p')), clientFrame(0x0, Buffer.from('lo'))]), c.h);
  eq([c.got, c.pongs], [['hello'], ['p']], 'a fragmented message, with a ping between its frames answered');
  c = fakeConn();
  c.missed = 2;
  WF.feed(c, clientFrame(0xA, Buffer.alloc(0)), c.h);
  ok(c.missed === 0, 'any frame (a pong) says the client is there');
  c = fakeConn();
  WF.feed(c, clientFrame(0x8, WF.closePayload(1000)), c.h);
  await sleep(5);
  ok(c.closes[0][0] === 1000 && c.goneN === 1, 'a close frame is answered with its code, then the socket goes');
  c = fakeConn();
  WF.feed(c, clientFrame(0x8, WF.closePayload(999)), c.h);
  ok(c.closes[0][0] === 1002, 'a close frame with a code no one may send: answered 1002');
  const refused = [
    ['an unmasked frame', clientFrame(0x1, Buffer.from('x'), { unmasked: true }), 1002],
    ['an RSV bit (no extensions)', clientFrame(0x1, Buffer.from('x'), { rsv: true }), 1002],
    ['a header longer than max, before its body', clientFrame(0x1, Buffer.alloc(0), { len: 1001 }), 1009],
    ['a 64-bit length over 4 GB', Buffer.from([0x81, 0xff, 0, 0, 0, 1, 0, 0, 0, 0]), 1009],
    ['a ping over 125 bytes', clientFrame(0x9, Buffer.alloc(126)), 1002],
    ['a fragmented ping', clientFrame(0x9, Buffer.from('x'), { fin: false }), 1002],
    ['a continuation with nothing to continue', clientFrame(0x0, Buffer.from('x')), 1002],
    ['an unknown opcode', clientFrame(0x3, Buffer.from('x')), 1002],
    ['a one-byte close frame', clientFrame(0x8, Buffer.from([3])), 1002],
  ];
  for (const [what, buf, code] of refused) {
    c = fakeConn();
    WF.feed(c, buf, c.h);
    ok(c.closes.length === 1 && c.closes[0][0] === code && !c.got.length, `${what}: closed ${code} (${JSON.stringify(c.closes)})`);
  }
  c = fakeConn(10);
  WF.feed(c, Buffer.concat([clientFrame(0x1, Buffer.alloc(6, 97), { fin: false }), clientFrame(0x0, Buffer.alloc(6, 97))]), c.h);
  ok(c.closes[0] && c.closes[0][0] === 1009 && !c.got.length, 'fragments that add up past max: 1009');
  c = fakeConn(10);
  WF.feed(c, Buffer.alloc(80), c.h);
  ok(c.closes[0] && c.closes[0][0] === 1009, 'more bytes buffered than max allows: 1009');
}

// a client on a real socket -> { status, msgs, closeCode, ended, pongs, raw(buf), send(obj), close() }
function connect(port, p, headers) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    const c = { status: 0, msgs: [], closeCode: null, ended: false, pongs: 0 };
    let buf = Buffer.alloc(0), done = false;
    const finish = () => { if (!done) { done = true; resolve(c); } };
    c.raw = (b) => { try { s.write(b); } catch {} };
    c.send = (o) => c.raw(clientFrame(0x1, Buffer.from(JSON.stringify(o))));
    c.close = () => s.destroy();
    s.on('error', () => {});
    s.on('close', () => { c.ended = true; finish(); });
    s.on('connect', () => {
      const h = { Host: `127.0.0.1:${port}`, Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13', ...headers };
      s.write(`GET ${p} HTTP/1.1\r\n${Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
    });
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!c.status) {
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        c.status = Number((/^HTTP\/1\.1 (\d{3})/.exec(buf.subarray(0, i).toString('latin1')) || [])[1]) || -1;
        buf = buf.subarray(i + 4);
        finish();
      }
      for (;;) {
        if (buf.length < 2) break;
        let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { if (buf.length < 10) break; len = buf.readUInt32BE(6); off = 10; }
        if (buf.length < off + len) break;
        const op = buf[0] & 0x0f, data = buf.subarray(off, off + len);
        buf = buf.subarray(off + len);
        if (op === 0x1) c.msgs.push(JSON.parse(data.toString('utf8')));
        else if (op === 0x8) c.closeCode = data.readUInt16BE(0);
        else if (op === 0xA) c.pongs++;
      }
    });
  });
}

async function live() {
  const LIVE = require(path.join(ROOT, 'live.js'));
  const logs = [];
  const ctx = { authorize: () => true, state: () => ({ repos: [], sessions: [] }), log: (t) => logs.push(t) };
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  server.on('upgrade', (req, socket, head) => LIVE.upgrade(req, socket, head, ctx));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port, origin = { Origin: `http://127.0.0.1:${port}` };
  try {
    let c = await connect(port, '/other', origin);
    ok(c.status === 404, `live.js: an upgrade off /live is 404 (${c.status})`);
    c = await connect(port, '/live', {});
    ok(c.status === 403, `live.js: no Origin is 403 (${c.status})`);
    c = await connect(port, '/live', origin);
    ok(c.status === 101, `live.js: /live with an Origin it authorizes: 101 (${c.status})`);
    ok(await waitUntil(() => c.msgs.length), 'live.js: the host state comes first');
    eq(c.msgs[0], { t: 'host', up: false }, 'live.js: the host is not running (a test pipe that is not there)');
    c.send({ n: 1, op: 'list', args: [] });
    c.send({ n: 2, op: 'nope' });
    const req = Buffer.from(JSON.stringify({ n: 3, op: 'snapshot', args: ['bad key'] }));
    c.raw(Buffer.concat([clientFrame(0x1, req.subarray(0, 5), { fin: false }), clientFrame(0x0, req.subarray(5))]));
    c.raw(clientFrame(0x9, Buffer.from('hi')));
    await waitUntil(() => c.msgs.length >= 4 && c.pongs);
    eq(c.msgs.slice(1), [{ n: 1, ok: true, v: [] }, { n: 2, ok: false, message: 'unknown op' }, { n: 3, ok: true, v: '' }], 'live.js: list -> [], an unknown op, a fragmented snapshot of a bad key -> \'\'');
    ok(c.pongs === 1, 'live.js: a ping is answered with a pong');
    c.raw(clientFrame(0x1, Buffer.from('{}'), { unmasked: true }));
    await waitUntil(() => c.ended, 3000);
    ok(c.closeCode === 1002 && c.ended, `live.js: an unmasked frame closes the socket with 1002 (${c.closeCode})`);
    ok(LIVE.clientCount() === 0, 'live.js: no client left');
  } finally {
    server.close();
  }
}

frames().then(live).catch((e) => { failures++; console.log(`FAIL the test crashed: ${e && e.stack}`); }).finally(() => {
  try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
  console.log(`${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
});
