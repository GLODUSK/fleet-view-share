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
  // the effort drawn right-aligned on a row with other text, read glued to it
  assert.equal(SCREEN.effortShown(['  ⎿  Set model to Sonnet 5.5 and saved as your default for new sessions○ low · /effort']), 'low');
  assert.equal(SCREEN.effortShown(['…default for new sessions○xhigh·/effort']), 'xhigh');
  assert.equal(SCREEN.effortShown(['…default for new sessionshigh · /effort', RULE, '❯ ', RULE, '  ? for shortcuts']), 'high');
  ok('screen.js: promptBox, spinner and effortShown read what compose.js reads');
}

// ---------- menus: 2.1.296's unnumbered trust question, the older numbered one ----------
// the raw pty output of Claude Code 2.1.296's folder trust question on the Mac (cols 120): every space drawn as a
// move to a column (CSI n G), "No, exit" first with the ❯ on it, no numbers
const TRUST_RAW = "\u001b7\u001b[r\u001b8\u001b[?25h\u001b[?25l\u001b[?2004h\u001b[?2031h\u001b[?1004h\r\r\n\u001b[38;2;255;193;7m────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\u001b[39m\r\r\n\u001b[2G\u001b[38;2;255;193;7m\u001b[1mAccessing\u001b[12Gworkspace:\u001b[22m\u001b[39m\r\r\n\r\r\n\u001b[2G\u001b[1m/Users/henry/code/fleet-view\u001b[22m\r\r\n\r\r\n\u001b[2GQuick\u001b[8Gsafety\u001b[15Gcheck:\u001b[22GIs\u001b[25Gthis\u001b[30Ga\u001b[32Gproject\u001b[40Gyou\u001b[44Gcreated\u001b[52Gor\u001b[55Gone\u001b[59Gyou\u001b[63Gtrust?\u001b[70G(Like\u001b[76Gyour\u001b[81Gown\u001b[85Gcode,\u001b[91Ga\u001b[93Gwell-known\u001b[104Gopen\u001b[109Gsource\r\r\n\u001b[2Gproject,\u001b[11Gor\u001b[14Gwork\u001b[19Gfrom\u001b[24Gyour\u001b[29Gteam).\u001b[36GIf\u001b[39Gnot,\u001b[44Gtake\u001b[49Ga\u001b[51Gmoment\u001b[58Gto\u001b[61Greview\u001b[68Gwhat's\u001b[75Gin\u001b[78Gthis\u001b[83Gfolder\u001b[90Gfirst.\r\r\n\r\r\n\u001b[2GClaude\u001b[9GCode'll\u001b[17Gbe\u001b[20Gable\u001b[25Gto\u001b[28Gread,\u001b[34Gedit,\u001b[40Gand\u001b[44Gexecute\u001b[52Gfiles\u001b[58Ghere.\r\r\n\r\r\n\u001b[2G\u001b[38;2;153;153;153mSecurity\u001b[11Gguide\u001b[39m\r\r\n\r\r\n\u001b[2G\u001b[38;2;177;185;249m❯\u001b[4GNo,\u001b[8Gexit\u001b[39m\r\r\n\u001b[4GYes,\u001b[9GI\u001b[11Gtrust\u001b[17Gthis\u001b[22Gfolder\r\r\n\r\r\n\u001b[2G\u001b[38;2;153;153;153mEnter\u001b[8Gto\u001b[11Gconfirm\u001b[19G·\u001b[21GEsc\u001b[25Gto\u001b[28Gcancel\u001b[39m\r\r\n\u001b[1C\u001b[4A\u001b[>0q\u001b[?u\u001b]7501;?\u0007\u001b[c";
// the same with the ❯ moved down to "Yes, I trust this folder"
const TRUST_RAW_YES = TRUST_RAW.replace('\x1b[2G\x1b[38;2;177;185;249m❯\x1b[4GNo,\x1b[8Gexit\x1b[39m\r\r\n\x1b[4GYes,',
  '\x1b[4GNo,\x1b[8Gexit\r\r\n\x1b[2G\x1b[38;2;177;185;249m❯\x1b[4GYes,');
{
  assert.notEqual(TRUST_RAW_YES, TRUST_RAW);
  const m = SCREEN.menuDetailsShown(TRUST_RAW, 120, 30);
  assert.ok(m, 'the unnumbered trust question reads as a menu');
  assert.equal(m.kind, 'trust');
  assert.equal(m.unnumbered, true);
  assert.equal(m.title, 'Quick safety check: Is this a project you created or one you trust?');
  assert.ok(m.context.includes('/Users/henry/code/fleet-view'));
  assert.deepEqual(m.options.map(({ n, label, on }) => ({ n, label, on })), [{ n: 1, label: 'No, exit', on: true }, { n: 2, label: 'Yes, I trust this folder', on: false }]);
  assert.ok(SCREEN.menuShown(TRUST_RAW, 120, 30));
  const y = SCREEN.menuDetailsShown(TRUST_RAW_YES, 120, 30);
  assert.equal(y.kind, 'trust');
  assert.deepEqual(y.options.map((o) => o.on), [false, true]);
  assert.notEqual(y.sig, m.sig, 'the sig changes when the pointer moves');
  // a narrower panel: the question wraps onto more rows, the menu still reads
  assert.equal(SCREEN.menuDetailsShown(TRUST_RAW, 80, 30)?.kind, 'trust');

  // a reply that merely has a "❯ something" line over another indented line, no keys line: not a menu
  assert.equal(SCREEN.menuDetails(['● Here is the layout:', '', '  ❯ First thing', '    Second thing', '', RULE, '❯ ', RULE, '  ? for shortcuts']), null);
  assert.equal(SCREEN.menuDetails(['● Steps:', '  ❯ No, exit', '    Yes, I trust this folder', '', '  that is all']), null);
  // the keys line too far under them, two pointers, or the options at two indentations: not a menu
  assert.equal(SCREEN.menuDetails([RULE, ' Pick', '', ' ❯ One', '   Two', '', '', '', ' Enter to confirm · Esc to cancel']), null);
  assert.equal(SCREEN.menuDetails([RULE, ' Pick', '', ' ❯ One', ' ❯ Two', '', ' Enter to confirm · Esc to cancel']), null);
  assert.equal(SCREEN.menuDetails([RULE, ' Pick', '', ' ❯ One', '     Two', '', ' Enter to confirm · Esc to cancel']), null);
  // a list in a command's panel (its ▔ edge above): the panel's, not a menu
  assert.equal(SCREEN.menuDetails(['▔'.repeat(40), ' Theme', '', ' ❯ Dark mode', '   Light mode', '', ' ↑/↓ to navigate · Enter to select · Esc to cancel']), null);
  // the prompt box holding a typed "Enter to confirm": not a menu
  assert.equal(SCREEN.menuDetails(['done.', RULE, '❯ No, exit', '  Yes', '  Enter to confirm', RULE, '  ? for shortcuts']), null);
  // an unnumbered menu not about trust is never a question (only a question is answered without allowPermission)
  const other = SCREEN.menuDetails([RULE, ' Pick a colour', '', ' ❯ Type something.', '   Chat about this', '', ' Enter to select · Esc to cancel']);
  assert.equal(other.kind, 'other');
  assert.ok(other.options.every((o) => !o.free));

  // the older numbered trust question still reads as before
  const old = SCREEN.menuDetails([RULE, ' Do you trust the files in this folder?', '', ' /Users/henry/code/fleet-view', '',
    ' Claude Code may read, write, or execute files contained in this directory. This can pose security risks.', '',
    ' ❯ 1. Yes, proceed', '   2. No, exit', '', ' Enter to confirm · Esc to exit']);
  assert.equal(old.kind, 'trust');
  assert.equal(old.title, 'Do you trust the files in this folder?');
  assert.equal(old.unnumbered, undefined);
  assert.deepEqual(old.options.map(({ n, label, on }) => ({ n, label, on })), [{ n: 1, label: 'Yes, proceed', on: true }, { n: 2, label: 'No, exit', on: false }]);

  // tail text: a move to a column on the Mac turned into the spaces it skips
  const plain = API.plainText(TRUST_RAW);
  assert.ok(plain.includes(' Yes, I trust this folder'), plain);
  assert.ok(plain.includes(' Quick safety check: Is this a project you created or one you trust?'));
  assert.ok(plain.includes(' Enter to confirm · Esc to cancel'));
  assert.equal(API.plainText('ab\x1b[5Gc\x1b[2Gd\r\n\x1b[3Ge\x1b[2Cf'), 'ab  cd\n  e  f');
  ok('screen.js: the unnumbered trust question (kind, title, pointer, sig), not a reply, the numbered one as before; plainText\'s CSI G');
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

  // ---------- model: "Switch model?", another menu, a save written late ----------
  {
    const file = path.join(home, '.claude', 'settings.json');
    const start = { model: 'claude-opus-5-5', theme: 'dark', modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } } };
    const EDGE = '▔'.repeat(60);
    // Claude Code 2.1's question before a switch mid-conversation, as the session host's screen showed it
    const confirm = [EDGE, '   Switch model?', '   Your next response will be slower and use more tokens', '',
      '   This conversation is cached for the current model. Switching to Sonnet 5.5 means the full history gets re-read on',
      '   your next message.', '', '   ❯ 1. Yes, switch to Sonnet 5.5', '     2. No, go back', EDGE];
    let footer, said, menu, typed;
    const draw = () => { fake.screen = screenOf(['earlier output', ...said, '', ...(menu || box('', footer))]); };
    const save = (f) => { const j = JSON.parse(fs.readFileSync(file, 'utf8')); f(j); fs.writeFileSync(file, JSON.stringify(j, null, 2) + '\n'); };
    const switched = () => { menu = null; save((j) => { j.model = 'sonnet'; j.other = 1; }); said.push('  ⎿  Set model to Sonnet 5.5 and saved as your default for new sessions'); };
    // a fake Claude Code: onEnter(typed) on Enter, onKey(key) on any other key; /effort always saves and says so
    const begin = (onEnter, onKey = () => {}) => {
      fs.writeFileSync(file, JSON.stringify(start, null, 2) + '\n');
      reset(); live({ status: 'idle' });
      footer = '  ◐ high · /effort'; said = []; menu = null; typed = '';
      draw();
      fake.onWrite = (w) => {
        if (w.startsWith('\x1b[200~')) { typed += w.slice(6, -6); return; }
        if (w === '\r') {
          const t = typed, m = /^\/effort (\S+)$/.exec(t);
          typed = '';
          if (m) { save((j) => { (j.modelSettings[j.model] = j.modelSettings[j.model] || {}).effortLevel = m[1]; }); footer = `  ◐ ${m[1]} · /effort`; said.push(`  ⎿  Set effort level to ${m[1]}`); } else onEnter(t);
        } else onKey(w);
        draw();
      };
    };

    // "Switch model?": its Yes picked, then /effort, then the default put back
    begin((t) => { if (/^\/model /.test(t)) menu = confirm; }, (k) => { if (menu && k === '1') switched(); });
    const [c1, o1] = await call('POST', `${S}/model`, { model: 'sonnet', effort: 'medium' });
    assert.equal(c1, 200, o1.message);
    assert.equal(o1.ok, true, o1.message);
    assert.equal(o1.confirmed, 'Yes, switch to Sonnet 5.5');
    assert.match(o1.said[0], /^Set model to Sonnet 5\.5/);
    assert.match(o1.said[1], /^Set effort level to medium/);
    assert.equal(o1.effortNow, 'medium');
    assert.equal(o1.defaultKept, true);
    assert.ok(fake.writes.includes('1'));
    assert.ok(!fake.writes.includes('\x1b'));
    assert.equal(pasted(), '/model sonnet/effort medium');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { ...start, other: 1 });

    // another menu after /model: closed with Esc, nothing more typed, 409; Claude Code's save after it closed is put back
    begin((t) => { if (/^\/model /.test(t)) menu = [RULE, '  Pick a model family', '  ❯ 1. Opus', '    2. Sonnet', '', '  Enter to select · Esc to cancel']; },
      (k) => { if (menu && k === '\x1b') { menu = null; said.push('  ⎿  Kept model as Opus'); setTimeout(() => save((j) => { j.model = 'sonnet'; }), 2000); } });
    const [c2, o2] = await call('POST', `${S}/model`, { model: 'sonnet', effort: 'low' });
    assert.equal(c2, 409, o2.message);
    assert.equal(o2.ok, false);
    assert.equal(o2.closed, true);
    assert.equal(o2.menu.title, 'Pick a model family');
    assert.equal(menu, null);
    assert.ok(fake.writes.includes('\x1b'));
    assert.equal(pasted(), '/model sonnet');
    assert.equal(o2.defaultKept, true);
    assert.equal(o2.restored, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), start);

    // Claude Code writes the default again a moment after the menu closed: put back as well
    begin((t) => { if (/^\/model /.test(t)) menu = confirm; },
      (k) => { if (menu && k === '1') { switched(); setTimeout(() => save((j) => { j.model = 'sonnet'; j.modelSettings.sonnet = { effortLevel: 'low' }; }), 800); } });
    const [c3, o3] = await call('POST', `${S}/model`, { model: 'sonnet' });
    assert.equal(c3, 200, o3.message);
    assert.equal(o3.ok, true, o3.message);
    assert.equal(o3.defaultKept, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { ...start, other: 1 });
    ok('model: "Switch model?" answered Yes; another menu closed (409); the default put back after a late save');
  }

  // ---------- answer: the unnumbered trust question ----------
  {
    // compose.js's parseMenu reads it the same (everything but kind)
    const { parseMenu } = await import('../web/compose.js');
    for (const raw of [TRUST_RAW, TRUST_RAW_YES]) {
      const rows = SCREEN.render(raw, 120, 30, 40, false);
      const { kind, ...rest } = SCREEN.menuDetails(rows);
      assert.equal(kind, 'trust');
      assert.deepEqual(parseMenu(rows), rest);
    }
    assert.equal(parseMenu(['● Steps:', '  ❯ No, exit', '    Yes, I trust this folder', '', '  that is all']), null);

    reset(); live({ status: 'waiting', waitingFor: 'trust', cols: 120, rows: 30 });
    fake.screen = TRUST_RAW;
    const [c0, o0] = await call('GET', `${S}/menu`);
    assert.equal(c0, 200, o0.message);
    assert.equal(o0.menu.kind, 'trust');
    assert.equal(o0.menu.unnumbered, true);
    // trust still needs allowPermission
    const [c1, o1] = await call('POST', `${S}/answer`, { option: 2 });
    assert.equal(c1, 403, o1.message);
    assert.deepEqual(fake.writes, []);
    // picked with ↓ and Enter, never a digit
    fake.onWrite = (w) => {
      if (w === '\x1b[B') fake.screen = TRUST_RAW_YES;
      else if (w === '\r' && fake.screen === TRUST_RAW_YES) fake.screen = screenOf(['', ...box()]);
    };
    const [c2, o2] = await call('POST', `${S}/answer`, { option: 2, sig: o0.menu.sig, allowPermission: true });
    assert.equal(c2, 200, o2.message);
    assert.deepEqual(fake.writes, ['\x1b[B', '\r']);
    assert.deepEqual(o2.answered, { n: 2, label: 'Yes, I trust this folder' });
    assert.equal(o2.changed, true);
    // the ❯ on it already: Enter alone
    reset(); fake.screen = TRUST_RAW_YES;
    fake.onWrite = (w) => { if (w === '\r') fake.screen = screenOf(['', ...box()]); };
    const [c3, o3] = await call('POST', `${S}/answer`, { option: 2, allowPermission: true });
    assert.equal(c3, 200, o3.message);
    assert.deepEqual(fake.writes, ['\r']);
    // Enter that does nothing after the pointer moved: not reported as a change
    reset(); fake.screen = TRUST_RAW;
    fake.onWrite = (w) => { if (w === '\x1b[B') fake.screen = TRUST_RAW_YES; };
    const [c4, o4] = await call('POST', `${S}/answer`, { option: 2, allowPermission: true });
    assert.equal(c4, 200, o4.message);
    assert.equal(o4.changed, false);
    ok('answer: the unnumbered trust question picked with ↓ and Enter (no digit), only with allowPermission; parseMenu agrees');
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
