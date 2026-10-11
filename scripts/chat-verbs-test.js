// Tests for the API's chat verbs (api.js: POST .../now, .../unsend, .../model, .../message with now, GET .../activity)
// and the screen readers they use (screen.js promptBox, spinner, effortShown), against a fake session host on a test
// pipe, with LOCALAPPDATA and USERPROFILE in a temp folder. No live host, no claude, nothing of the real settings:
// node scripts/chat-verbs-test.js
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-chat-verbs-'));
const home = path.join(dir, 'home');
fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
process.env.LOCALAPPDATA = path.join(dir, 'local');
process.env.USERPROFILE = home;
process.env.FV_HOST_PIPE = process.platform === 'win32' ? `\\\\.\\pipe\\fleet-view-host-chatverbs-${process.pid}` : path.join(dir, `fleet-view-host-chatverbs-${process.pid}.sock`);
process.env.FV_HOST_DIR = path.join(dir, 'host');

const H = require('../desktop/host.js');
const SCREEN = require('../screen.js');
const API = require('../api.js');

let n = 0;
const ok = (name) => { n++; console.log('ok', name); };
const ID = '0000000a-0000-4000-8000-000000000000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- the screen readers ----------
const RULE = '─'.repeat(40);
{
  assert.deepEqual(SCREEN.promptBox(['hello', RULE, '❯ ', RULE, '  ? for shortcuts']), { text: '', lines: 1 });
  assert.deepEqual(SCREEN.promptBox(['x', RULE, '❯ first line', '  second', RULE, 'footer']), { text: 'first line\nsecond', lines: 2 });
  assert.deepEqual(SCREEN.promptBox([RULE, '❯ Press up to edit queued messages', RULE]), { text: '', lines: 1 });
  assert.equal(SCREEN.promptBox(['no box here', 'at all']), null);
  assert.deepEqual(SCREEN.spinner(['✻ Brewing… (12s · ↓ 1.2k tokens · esc to interrupt)']), { verb: 'Brewing', detail: '12s · ↓ 1.2k tokens', strong: true });
  assert.deepEqual(SCREEN.spinner(['✶ Thinking… (3m 2s · ↑ 900 tokens', '· esc to interrupt)']), { verb: 'Thinking', detail: '3m 2s · ↑ 900 tokens', strong: true });
  assert.equal(SCREEN.spinner(['* Not a spinner']), null);
  assert.equal(SCREEN.spinner(['✻ Cooking…']).strong, false);
  assert.equal(SCREEN.effortShown([RULE, '❯ ', RULE, '  ◐ xhigh · /effort']), 'xhigh');
  assert.equal(SCREEN.effortShown(['nothing']), null);
  ok('screen.js: promptBox, spinner and effortShown read what compose.js reads');
}

// ---------- the fake session host ----------
const fake = { list: [], screen: '', writes: [], onWrite: null };
const screenOf = (rows) => rows.join('\r\n');
const box = (text = '', footer = '  ? for shortcuts') => [RULE, ...(text ? text.split('\n').map((l, i) => (i ? `  ${l}` : `❯ ${l}`)) : ['❯ ']), RULE, footer];
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
      if (msg.t === 'hello') { sock.write(JSON.stringify({ t: 'hello', ok: true, pid: 4242 }) + '\n'); continue; }
      let v = null;
      if (msg.op === 'list') v = fake.list;
      else if (msg.op === 'snapshot') v = fake.screen;
      else if (msg.op === 'write') { fake.writes.push(msg.a[1]); if (fake.onWrite) fake.onWrite(msg.a[1]); v = true; }
      sock.write(JSON.stringify({ t: 'res', n: msg.n, v }) + '\n');
    }
  });
});

API.ensureToken();
const tok = fs.readFileSync(API.TOKEN_FILE, 'utf8').trim();
const ctx = {
  log: () => {}, sendJson: (res, code, out) => res.done([code, out]), readBody: (req, res, cb) => cb(req.body),
  successorOf: () => null, nameOf: () => 'web', turnInfo: () => ({ promptAt: Date.now() + 1000, turnOpen: true }),
  doing: () => 'Bash npm test', queue: [], transcript: async () => ({ total: 0, from: 0, items: [], queue: ctx.queue.slice() }),
};
function call(method, pathname, body, extra = {}) {
  return new Promise((resolve) => {
    const req = { method, url: pathname, body, headers: { authorization: `Bearer ${tok}`, ...extra } };
    const res = Object.assign(new EventEmitter(), { destroyed: false, writableFinished: true, done: resolve });
    API.handle(req, res, pathname, ctx);
  });
}
const S = `/api/sessions/${ID}`;
const live = (o = {}) => { fake.list = [{ id: ID, alive: true, status: 'busy', account: 'B', cols: 80, rows: 24, ...o }]; };
const reset = () => { fake.writes = []; fake.onWrite = null; ctx.queue = []; };
// the text pasted since the last reset, without the bracketed-paste marks, and the keys pressed
const pasted = () => fake.writes.filter((w) => w.startsWith('\x1b[200~')).map((w) => w.slice(6, -6)).join('');

(async () => {
  await new Promise((r) => server.listen(process.env.FV_HOST_PIPE, r));

  // ---------- activity ----------
  {
    reset(); live();
    ctx.queue = ['and then this'];
    fake.screen = screenOf(['some output', '✻ Brewing… (12s · ↓ 1.2k tokens · esc to interrupt)', '', ...box('', '  ◐ high · /effort')]);
    const [code, out] = await call('GET', `${S}/activity`);
    assert.equal(code, 200);
    assert.equal(out.busy, true);
    assert.equal(out.line, 'Brewing… (12s · ↓ 1.2k tokens)');
    assert.equal(out.verb, 'Brewing');
    assert.equal(out.doing, 'Bash npm test');
    assert.equal(out.effort, 'high');
    assert.deepEqual(out.queue, ['and then this']);
    assert.equal(out.waiting, null);
    live({ status: 'idle' });
    fake.screen = screenOf(['done.', '', ...box()]);
    const [, idle] = await call('GET', `${S}/activity`);
    assert.equal(idle.busy, false);
    assert.equal(idle.line, null);
    fake.screen = screenOf(['Do you want to proceed?', '❯ 1. Yes', '  2. No', '', 'Esc to cancel']);
    live({ status: 'waiting', waitingFor: 'approve Bash(npm test)' });
    const [, menu] = await call('GET', `${S}/activity`);
    assert.equal(menu.busy, false);
    assert.equal(menu.waiting, 'menu');
    assert.equal(menu.menu.kind, 'permission');
    fake.list = [{ id: ID, alive: false, exitCode: 0 }];
    const [, dead] = await call('GET', `${S}/activity`);
    assert.equal(dead.alive, false);
    assert.equal(dead.busy, false);
    assert.equal((await call('POST', `${S}/activity`, {}))[0], 405);
    ok('activity: the spinner line, doing, effort and queue; not busy idle, on a menu or ended');
  }

  // ---------- send now ----------
  {
    reset(); live();
    fake.screen = screenOf(['✻ Brewing… (2s · esc to interrupt)', '', ...box()]);
    ctx.queue = ['do this next'];
    const [code, out] = await call('POST', `${S}/now`, {});
    assert.equal(code, 200);
    assert.deepEqual(out.sent, ['do this next']);
    assert.deepEqual(fake.writes, ['\x18', '\x13']);
    reset(); live({ status: 'idle' });
    assert.equal((await call('POST', `${S}/now`, {}))[0], 409);
    reset(); live(); // busy, nothing queued
    const [c2, o2] = await call('POST', `${S}/now`, {});
    assert.equal(c2, 409);
    assert.match(o2.message, /nothing is queued/);
    assert.deepEqual(fake.writes, []);
    reset(); live({ status: 'waiting', waitingFor: 'dialog open' });
    assert.equal((await call('POST', `${S}/now`, {}))[0], 409);
    ok('now: Ctrl+X then Ctrl+S only while busy with something queued');
  }

  // ---------- message with now ----------
  {
    reset(); live();
    fake.screen = screenOf(['✻ Brewing… (2s · esc to interrupt)', '', ...box()]);
    const [code, out] = await call('POST', `${S}/message`, { text: 'stop and look at this', now: true });
    assert.equal(code, 200, out.message);
    assert.equal(out.sentNow, true);
    assert.equal(pasted(), 'stop and look at this');
    assert.deepEqual(fake.writes.slice(-3), ['\r', '\x18', '\x13']);
    reset(); live({ status: 'idle' });
    const [, o2] = await call('POST', `${S}/message`, { text: 'hello', now: true });
    assert.equal(o2.sentNow, undefined);
    assert.ok(!fake.writes.includes('\x18'));
    assert.equal((await call('POST', `${S}/message`, { text: 'x', now: 'yes' }))[0], 400);
    ok('message now: sent while busy, then the send-now chord; idle: just sent');
  }

  // ---------- unsend ----------
  {
    // out of Claude Code's queue: Up pulls both, Ctrl+U clears, the other one goes back
    reset(); live();
    ctx.queue = ['take this back', 'keep this one'];
    let boxText = '';
    const draw = () => { fake.screen = screenOf(['✻ Brewing… (2s · esc to interrupt)', '', ...box(boxText)]); };
    draw();
    fake.onWrite = (w) => {
      if (w === '\x1b[A') boxText = ctx.queue.join('\n');
      else if (w.startsWith('\x15')) boxText = '';
      else if (w === '\r') { boxText = ''; }
      draw();
    };
    const [code, out] = await call('POST', `${S}/unsend`, { text: 'take this back' });
    assert.equal(code, 200, out.message);
    assert.equal(out.where, 'claude');
    assert.equal(out.requeued, 1);
    assert.equal(fake.writes[0], '\x1b[A');
    assert.equal(pasted(), 'keep this one');
    assert.equal(fake.writes[fake.writes.length - 1], '\r');
    // Claude took it meanwhile: Up brings back only the other, which goes back; 409 taken
    reset(); live();
    ctx.queue = ['gone already', 'still here'];
    boxText = ''; draw();
    fake.onWrite = (w) => {
      if (w === '\x1b[A') boxText = 'still here';
      else if (w.startsWith('\x15') || w === '\r') boxText = '';
      draw();
    };
    const [c2, o2] = await call('POST', `${S}/unsend`, { text: 'gone already' });
    assert.equal(c2, 409);
    assert.equal(o2.taken, true);
    assert.equal(o2.requeued, 1);
    assert.equal(pasted(), 'still here');
    // not queued at all
    reset(); live();
    const [c3, o3] = await call('POST', `${S}/unsend`, { text: 'never sent' });
    assert.equal(c3, 409);
    assert.equal(o3.taken, true);
    assert.deepEqual(fake.writes, []);
    // something typed in the prompt: nothing pressed
    reset(); live();
    ctx.queue = ['take this back'];
    boxText = 'a draft'; draw();
    const [c4] = await call('POST', `${S}/unsend`, { text: 'take this back' });
    assert.equal(c4, 409);
    assert.deepEqual(fake.writes, []);
    assert.equal((await call('POST', `${S}/unsend`, {}))[0], 400);
    ok('unsend: out of Claude Code\'s queue, the others queued again; taken, not queued, a draft in the box');
  }

  // ---------- model and effort ----------
  {
    const file = path.join(home, '.claude', 'settings.json');
    const start = { model: 'claude-opus-5-5', theme: 'dark', modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } } };
    fs.writeFileSync(file, JSON.stringify(start, null, 2) + '\n');
    reset(); live({ status: 'idle' });
    let footer = '  ◐ high · /effort', said = [];
    const draw = () => { fake.screen = screenOf(['earlier output', ...said, '', ...box('', footer)]); };
    draw();
    let typed = '';
    // Claude Code: on Enter, saves the pick as the default (and another key changes meanwhile), then says so
    fake.onWrite = (w) => {
      if (w.startsWith('\x1b[200~')) { typed += w.slice(6, -6); return; }
      if (w !== '\r') return;
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      let m;
      if ((m = /^\/model (\S+)$/.exec(typed))) { j.model = m[1]; j.other = 1; said.push(`  ⎿  Set model to ${m[1]} and saved as your default for new sessions`); }
      if ((m = /^\/effort (\S+)$/.exec(typed))) { (j.modelSettings[j.model] = j.modelSettings[j.model] || {}).effortLevel = m[1]; footer = `  ◐ ${m[1]} · /effort`; said.push(`  ⎿  Set effort level to ${m[1]}: thinks longer`); }
      typed = '';
      fs.writeFileSync(file, JSON.stringify(j, null, 2) + '\n');
      draw();
    };
    const [code, out] = await call('POST', `${S}/model`, { model: 'claude-haiku-5-5', effort: 'xhigh' });
    assert.equal(code, 200, out.message);
    assert.equal(out.ok, true, out.message);
    assert.equal(out.defaultKept, true);
    assert.equal(out.restored, true);
    assert.equal(out.effortNow, 'xhigh');
    assert.match(out.said[0], /^Set model to claude-haiku-5-5/);
    assert.match(out.said[1], /^Set effort level to xhigh/);
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(after, { ...start, other: 1 }); // the default back, the other change kept
    assert.ok(pasted() === '/model claude-haiku-5-5/effort xhigh');
    // busy, an overseer without the phone, bad input: nothing typed
    reset(); live({ status: 'busy' });
    assert.equal((await call('POST', `${S}/model`, { effort: 'low' }))[0], 409);
    reset(); live({ status: 'idle', role: 'chief' });
    assert.equal((await call('POST', `${S}/model`, { effort: 'low' }))[0], 403);
    assert.equal((await call('POST', `${S}/model`, { effort: 'low', via: 'phone' }))[0], 403); // no relay key
    assert.equal((await call('POST', `${S}/model`, { effort: 'nope' }))[0], 400);
    assert.equal((await call('POST', `${S}/model`, { model: 'x y' }))[0], 400);
    assert.equal((await call('POST', `${S}/model`, {}))[0], 400);
    assert.deepEqual(fake.writes, []);
    // a draft in the prompt box: refused before anything is typed
    reset(); live({ status: 'idle' });
    fake.screen = screenOf(['x', '', ...box('half a thought')]);
    assert.equal((await call('POST', `${S}/model`, { effort: 'low' }))[0], 409);
    assert.deepEqual(fake.writes, []);
    // settings.json not JSON: refused, the file untouched
    fs.writeFileSync(file, '{ not json');
    draw();
    assert.equal((await call('POST', `${S}/model`, { effort: 'low' }))[0], 409);
    assert.equal(fs.readFileSync(file, 'utf8'), '{ not json');
    ok('model: /model and /effort typed, the default put back with other changes kept; busy, overseer, draft, bad file refused');
  }

  // ---------- Fleet View's own queue ----------
  {
    reset(); live({ status: 'waiting', waitingFor: 'approve Bash(x)' });
    fake.screen = screenOf(['Do you want to proceed?', '❯ 1. Yes', '  2. No', '', 'Esc to cancel']);
    const [c1, o1] = await call('POST', `${S}/message`, { text: 'after the menu', queue: true });
    assert.equal(c1, 202, o1.message);
    assert.ok(API.queuedIds().includes(ID));
    const [c2, o2] = await call('POST', `${S}/unsend`, { text: 'after the menu' });
    assert.equal(c2, 200, o2.message);
    assert.equal(o2.where, 'fleetView');
    assert.ok(!API.queuedIds().includes(ID));
    ok('unsend: text waiting in Fleet View for a menu is dropped there');
  }

  // ---------- the transcript's queue ----------
  {
    reset(); live();
    ctx.queue = ['queued one'];
    const [, a] = await call('GET', `${S}/transcript`);
    assert.deepEqual(a.queue, ['queued one']);
    fake.list = [{ id: ID, alive: false }];
    const [, b] = await call('GET', `${S}/transcript`);
    assert.deepEqual(b.queue, []);
    ok('transcript: queue while it runs, none once it ended');
  }

  const paths = API.ENDPOINTS.map((e) => `${e.method} ${e.path}`);
  for (const p of ['POST /api/sessions/:id/now', 'POST /api/sessions/:id/unsend', 'POST /api/sessions/:id/model', 'GET /api/sessions/:id/activity']) assert.ok(paths.includes(p), p);
  ok('GET /api lists the new verbs');
})().then(() => { console.log(`${n} tests passed`); }, (e) => { console.error(e); process.exitCode = 1; })
  .finally(() => { server.close(); setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} process.exit(); }, 100); });
