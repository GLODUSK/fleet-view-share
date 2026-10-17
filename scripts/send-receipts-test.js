// Tests for sends that are asked for again and sends caught by a restart (api.js): a message's clientId and its receipt
// (a repeat here, a repeat after a restart from send-receipts.json, one a restart left unknown: 409 maybeSent unless the
// transcript shows it, a refused one not kept, a repeat with wait waiting for the turn it started), the prompt box
// before a send (someone's text there: 409 typed, or it waits in the queue; this server's own leftover: cleared and
// typed again; a queued one a menu stopped before its Enter and sent by hand since: never typed again), a write the
// session host refused (409 "not sent"), and the drain an update's restart waits on (503 draining meanwhile, the
// queue typing nothing). Against a fake session host on a test pipe, with LOCALAPPDATA, USERPROFILE and HOME in a temp
// folder: no live host, no claude, nothing of the real data folder. node scripts/send-receipts-test.js
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-send-receipts-'));
const home = path.join(dir, 'home');
fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
process.env.LOCALAPPDATA = path.join(dir, 'local');
process.env.USERPROFILE = home;
process.env.HOME = home;
process.env.FV_HOST_PIPE = require('./test-support.js').testPipe(`receipts-${process.pid}`);
process.env.FV_HOST_DIR = path.join(dir, 'host');

const H = require('../desktop/host.js');
const API = require('../api.js');

let n = 0;
const ok = (name) => { n++; console.log('ok', name); };
const ID = '0000000b-0000-4000-8000-000000000000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- the fake session host ----------
const RULE = '─'.repeat(40);
const fake = { list: [], screen: '', writes: [], onWrite: null, answer: null, delay: 0 };
const screenOf = (rows) => rows.join('\r\n');
const box = (text = '') => screenOf(['done.', '', RULE, ...(text ? text.split('\n').map((l, i) => (i ? `  ${l}` : `❯ ${l}`)) : ['❯ ']), RULE, '  ? for shortcuts']);
const MENU = screenOf(['Do you want to proceed?', '❯ 1. Yes', '  2. No', '', 'Esc to cancel']);
fs.mkdirSync(process.env.FV_HOST_DIR, { recursive: true });
fs.writeFileSync(H.hostFile(), JSON.stringify({ token: 'tok' }));
const server = net.createServer((sock) => {
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('error', () => {});
  sock.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (msg.t === 'hello') { sock.write(JSON.stringify({ t: 'hello', ok: true, pid: 4243 }) + '\n'); continue; }
      let v = null, wait = 0;
      if (msg.op === 'list') v = fake.list;
      else if (msg.op === 'snapshot') v = fake.screen;
      else if (msg.op === 'write') {
        // the host's answer to a write: true, or (fake.answer) { ok: false, reason } with nothing typed
        if (fake.answer) v = fake.answer;
        else { fake.writes.push(msg.a[1]); if (fake.onWrite) fake.onWrite(msg.a[1]); v = true; wait = fake.delay; }
      }
      const res = JSON.stringify({ t: 'res', n: msg.n, v }) + '\n';
      if (wait) setTimeout(() => sock.write(res), wait); else sock.write(res);
    }
  });
});

API.ensureToken();
const tok = fs.readFileSync(API.TOKEN_FILE, 'utf8').trim();
const ctx = {
  log: () => {}, sendJson: (res, code, out) => res.done([code, out]), readBody: (req, res, cb) => cb(req.body),
  successorOf: () => null, nameOf: () => 'web', whereIs: () => ({ known: true, cwd: dir, account: 'B' }), sessionInfo: () => null,
  turnInfo: () => ({ promptAt: Date.now() + 1000, turnOpen: true }),
  items: [], queue: [], transcript: async () => ({ total: ctx.items.length, from: 0, items: ctx.items.slice(), queue: ctx.queue.slice() }),
};
function call(method, pathname, body, extra = {}) {
  return new Promise((resolve) => {
    const req = { method, url: pathname, body, headers: { authorization: `Bearer ${tok}`, ...extra } };
    const res = Object.assign(new EventEmitter(), { destroyed: false, writableFinished: true, done: resolve });
    API.handle(req, res, pathname, ctx);
  });
}
const S = `/api/sessions/${ID}`;
const live = (o = {}) => { fake.list = [{ id: ID, alive: true, status: 'idle', account: 'B', cols: 80, rows: 24, ...o }]; };
const reset = () => { fake.writes = []; fake.onWrite = null; fake.answer = null; fake.delay = 0; ctx.items = []; ctx.queue = []; ctx.turnInfo = () => ({ promptAt: Date.now() + 1000, turnOpen: true }); };
const pasted = () => fake.writes.filter((w) => w.startsWith('\x1b[200~')).map((w) => w.slice(6, -6)).join('');
const receipt = (cid) => JSON.parse(fs.readFileSync(API.sendParts.RECEIPTS_FILE, 'utf8')).find((r) => r.cid === cid) || null;
const until = async (f, ms = 8000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (f()) return true; return f(); };

(async () => {
  await new Promise((r) => server.listen(process.env.FV_HOST_PIPE, r));

  // ---------- a clientId: sent once; a repeat here is the first answer ----------
  {
    reset(); live(); fake.screen = box();
    const [c, o] = await call('POST', `${S}/message`, { text: 'run the tests', clientId: 'cid-once-0001' });
    assert.equal(c, 200, o.message);
    assert.equal(pasted(), 'run the tests');
    assert.equal(o.clientId, 'cid-once-0001');
    const r = receipt('cid-once-0001');
    assert.equal(r.state, 'sent');
    assert.equal(r.id, ID);
    const writes = fake.writes.length;
    const [c2, o2] = await call('POST', `${S}/message`, { text: 'run the tests', clientId: 'cid-once-0001' });
    assert.equal(c2, 200);
    assert.equal(o2.repeat, true);
    assert.equal(fake.writes.length, writes, 'nothing typed again');
    ok('clientId: typed once, the receipt says sent, a repeat gets the first answer and types nothing');
  }

  // ---------- after a restart: the receipt from send-receipts.json ----------
  {
    API.sendParts.forget();
    const writes = fake.writes.length;
    const [c, o] = await call('POST', `${S}/message`, { text: 'run the tests', clientId: 'cid-once-0001' });
    assert.equal(c, 200, o.message);
    assert.equal(o.repeat, true);
    assert.match(o.message, /before Fleet View restarted/);
    assert.equal(fake.writes.length, writes);
    // with wait: the turn it started (ended since), and its reply, as the first call would have given
    const at = receipt('cid-once-0001').sentAt;
    ctx.turnInfo = () => ({ promptAt: at + 5, turnOpen: false, turnEndT: at + 50, lastReply: 'all green', replyAt: at + 50 });
    API.sendParts.forget();
    const [c2, o2] = await call('POST', `${S}/message`, { text: 'run the tests', clientId: 'cid-once-0001', wait: 30 });
    assert.equal(c2, 200, o2.message);
    assert.equal(o2.endedBy, 'reply');
    assert.equal(o2.reply, 'all green');
    assert.equal(fake.writes.length, writes);
    ok('after a restart: a repeat types nothing; with wait it waits for the turn it started and gives its reply');
  }

  // ---------- a restart before it said (started): the transcript decides ----------
  {
    reset(); live(); fake.screen = box();
    const list = JSON.parse(fs.readFileSync(API.sendParts.RECEIPTS_FILE, 'utf8'));
    const at = Date.now() - 5000;
    list.push({ cid: 'cid-cut-00001', kind: 'message', key: ID, at, until: Date.now() + 600e3, state: 'started', snip: 'look at the logs' });
    fs.writeFileSync(API.sendParts.RECEIPTS_FILE, JSON.stringify(list));
    API.sendParts.forget();
    const [c, o] = await call('POST', `${S}/message`, { text: 'look at the logs', clientId: 'cid-cut-00001' });
    assert.equal(c, 409);
    assert.equal(o.maybeSent, true);
    assert.match(o.message, /restarted while sending it.*Look at it/);
    assert.deepEqual(fake.writes, []);
    ctx.items = [{ i: 0, type: 'user', t: at + 1000, text: 'look at the logs   please' }];
    const [c2, o2] = await call('POST', `${S}/message`, { text: 'look at the logs', clientId: 'cid-cut-00001' });
    assert.equal(c2, 200, o2.message);
    assert.equal(o2.repeat, true);
    assert.deepEqual(fake.writes, []);
    // in Claude Code's queue counts too
    list.push({ cid: 'cid-cut-00002', kind: 'message', key: ID, at, until: Date.now() + 600e3, state: 'started', snip: 'and then deploy' });
    fs.writeFileSync(API.sendParts.RECEIPTS_FILE, JSON.stringify(list));
    API.sendParts.forget();
    ctx.items = []; ctx.queue = ['and then deploy'];
    const [c3] = await call('POST', `${S}/message`, { text: 'and then deploy', clientId: 'cid-cut-00002' });
    assert.equal(c3, 200);
    assert.deepEqual(fake.writes, []);
    ok('a send a restart cut before it said: 409 maybeSent, nothing typed; in the transcript or Claude Code\'s queue it counts as sent');
  }

  // ---------- refused ones are not kept; bad and reused clientIds ----------
  {
    reset(); live(); fake.screen = MENU;
    const [c] = await call('POST', `${S}/message`, { text: 'after the menu', clientId: 'cid-menu-0001' });
    assert.equal(c, 409);
    assert.equal(receipt('cid-menu-0001'), null, 'a refused send keeps no receipt');
    fake.screen = box();
    const [c2, o2] = await call('POST', `${S}/message`, { text: 'after the menu', clientId: 'cid-menu-0001' });
    assert.equal(c2, 200, o2.message);
    assert.equal(o2.repeat, undefined);
    assert.equal(pasted(), 'after the menu');
    assert.equal((await call('POST', `${S}/message`, { text: 'x', clientId: 'bad id!' }))[0], 400);
    assert.equal((await call('POST', `${S}/message`, { text: 'x', clientId: 'short' }))[0], 400);
    const [c3, o3] = await call('POST', '/api/sessions/0000000c-0000-4000-8000-000000000000/message', { text: 'x', clientId: 'cid-menu-0001' });
    assert.equal(c3, 409);
    assert.match(o3.message, /another request/);
    ok('a refused send keeps no receipt (asked again, it tries again); a bad clientId is 400, one reused for another session 409');
  }

  // ---------- the prompt box: someone else's text ----------
  {
    reset(); live(); fake.screen = box('half typed by Henry');
    const [c, o] = await call('POST', `${S}/message`, { text: 'hello' });
    assert.equal(c, 409);
    assert.equal(o.typed, true);
    assert.match(o.message, /typed in its prompt/);
    assert.deepEqual(fake.writes, []);
    // with queue: it waits, and goes in once the prompt is empty
    const [c2, o2] = await call('POST', `${S}/message`, { text: 'queued hello', queue: true });
    assert.equal(c2, 202, o2.message);
    assert.equal(o2.typed, true);
    await sleep(4500);
    assert.deepEqual(fake.writes, [], 'not typed while the text is there');
    fake.screen = box();
    assert.ok(await until(() => pasted() === 'queued hello'), `typed once the prompt is empty (${JSON.stringify(fake.writes)})`);
    assert.ok(await until(() => API.queuedIds().length === 0));
    ok('someone\'s text in the prompt: 409 typed and nothing typed; queued, it waits until the prompt is empty');
  }

  // ---------- the prompt box: this server's own leftover ----------
  {
    reset(); live(); fake.screen = box();
    // a menu comes up just before the Enter: the text is left in the prompt
    fake.onWrite = (w) => { if (w.startsWith('\x1b[200~')) fake.screen = MENU; };
    const [c, o] = await call('POST', `${S}/message`, { text: 'fix the build' });
    assert.equal(c, 409);
    assert.equal(o.menu, true);
    // the menu is answered; the text sits in the prompt
    fake.screen = box('fix the build');
    fake.writes = [];
    fake.onWrite = (w) => { if (w.startsWith('\x15')) fake.screen = box(); };
    const [c2, o2] = await call('POST', `${S}/message`, { text: 'fix the build' });
    assert.equal(c2, 200, o2.message);
    assert.ok(fake.writes[0].startsWith('\x15'), `cleared first (${JSON.stringify(fake.writes)})`);
    assert.equal(pasted(), 'fix the build');
    assert.equal(fake.writes.at(-1), '\r');
    ok('what this server left in the prompt (a menu before its Enter) is cleared, then typed once and sent');
  }

  // ---------- the queue: a menu before its Enter, then Henry's Enter on the text left in the prompt ----------
  {
    reset(); live(); fake.screen = MENU;
    const [c, o] = await call('POST', `${S}/message`, { text: 'ship it after the menu', queue: true });
    assert.equal(c, 202, o.message);
    // the menu is answered, and another comes up just as the queued text is pasted (before its Enter)
    fake.onWrite = (w) => { if (w.startsWith('\x1b[200~')) fake.screen = MENU; };
    fake.screen = box();
    const left = () => { try { return JSON.parse(fs.readFileSync(API.sendParts.QUEUE_FILE, 'utf8')).some((q) => q.leftAt); } catch { return false; } };
    assert.ok(await until(left), `the try is marked as left in the prompt (${JSON.stringify(fake.writes)})`);
    assert.equal(pasted(), 'ship it after the menu');
    assert.ok(!fake.writes.includes('\r'), 'no Enter: a menu came up first');
    assert.equal(API.queuedIds().length, 1, 'still waiting');
    // Henry answers it and presses Enter on the text in the prompt himself: the prompt is empty, the transcript has it
    fake.onWrite = null;
    ctx.items = [{ i: 0, type: 'user', t: Date.now(), text: 'ship it after the menu' }];
    fake.screen = box();
    assert.ok(await until(() => API.queuedIds().length === 0), 'it leaves the queue as sent');
    assert.equal(pasted(), 'ship it after the menu', 'never typed again');
    assert.ok(!fake.writes.includes('\r'));
    ok('queued: a menu before its Enter leaves it waiting; sent from the prompt by hand meanwhile, it is never typed again');
  }

  // ---------- the queue while a restart drains: nothing new is typed ----------
  {
    reset(); live(); fake.screen = MENU;
    const [c] = await call('POST', `${S}/message`, { text: 'after the restart', queue: true });
    assert.equal(c, 202);
    await API.drain(1000);
    fake.screen = box();
    await sleep(4500);
    assert.deepEqual(fake.writes, [], 'nothing typed while draining');
    API.sendParts.undrain();
    assert.ok(await until(() => pasted() === 'after the restart' && API.queuedIds().length === 0), `typed once it takes sends again (${JSON.stringify(fake.writes)})`);
    ok('the queue starts no typing while a restart drains (the next server goes on with it)');
  }

  // ---------- a write the host refused ----------
  {
    reset(); live(); fake.screen = box();
    fake.answer = { ok: false, reason: 'ending' };
    const [c, o] = await call('POST', `${S}/message`, { text: 'too late', clientId: 'cid-lost-0001' });
    assert.equal(c, 409);
    assert.equal(o.lost, 'ending');
    assert.match(o.message, /^not sent: that session is ending/);
    assert.equal(receipt('cid-lost-0001'), null);
    ok('a write the session host refused (the session is ending): 409 "not sent" at once, no receipt kept');
  }

  // ---------- the drain an update's restart waits on ----------
  {
    reset(); live(); fake.screen = box();
    assert.equal(API.sendParts.busy(), 0);
    const quick = await API.drain(2000);
    assert.equal(quick.left, 0);
    assert.ok(quick.ms < 500);
    API.sendParts.undrain();
    fake.delay = 400; // each paste takes a while to go in
    const first = call('POST', `${S}/message`, { text: 'slow one' });
    await sleep(100);
    assert.ok(API.sendParts.busy() > 0, 'a send being typed holds a restart');
    const drained = API.drain(5000);
    const [c, o] = await call('POST', `${S}/message`, { text: 'during the drain' });
    assert.equal(c, 503);
    assert.equal(o.draining, true);
    const d = await drained;
    assert.equal(d.left, 0);
    assert.ok(d.ms >= 200, `it waited for the send (${d.ms} ms)`);
    const [c1, o1] = await first;
    assert.equal(c1, 200, o1.message);
    assert.equal(pasted(), 'slow one');
    // capped: one that never finishes does not hold it past its time
    API.sendParts.undrain();
    fake.delay = 3000;
    const stuck = call('POST', `${S}/message`, { text: 'stuck one' });
    await sleep(100);
    const capped = await API.drain(500);
    assert.ok(capped.left > 0 && capped.ms >= 500 && capped.ms < 1500, JSON.stringify(capped));
    await stuck;
    API.sendParts.undrain();
    ok('drain: none in flight, it ends at once; a send being typed holds it, new POSTs get 503 draining; capped at its time');
  }

  console.log(`\nall ${n} passed`);
  server.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
