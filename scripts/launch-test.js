// Tests for a Launch from outside the page (launch.js, api.js POST /api/sessions/:id/launch, fv launch): the options
// read from a reply's task list, what counts as launched, the picks, the message (word for word the page's and the
// phone's), the endpoint's dry run and refusals against a fake transcript, and fv launch's calls through a fake client.
// Nothing reaches a session host or a live server (LOCALAPPDATA, the host pipe and dir in a temp folder).
//   node scripts/launch-test.js
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-launch-test-'));
process.env.LOCALAPPDATA = path.join(dir, 'local');
process.env.FV_HOST_PIPE = process.platform === 'win32' ? `\\\\.\\pipe\\fleet-view-host-launch-${process.pid}` : path.join(dir, `fleet-view-host-launch-${process.pid}.sock`);
process.env.FV_HOST_DIR = path.join(dir, 'host');

const ROOT = path.join(__dirname, '..');
const L = require(path.join(ROOT, 'launch.js'));
const API = require(path.join(ROOT, 'api.js'));
const FV = require(path.join(ROOT, 'scripts', 'fv.js'));

let n = 0;
const ok = (name) => { n++; console.log('ok', name); };

// a reply as Claude writes one (CLAUDE.md "Options to pick from"), with bold names, code and two recommended
const REPLY = [
  'Here\'s what I\'d change:',
  '',
  '- [ ] **One ship command for Fleet View on the PC** (recommended): a `scripts/ship.js <PR#>` that does steps 1–7 of the repo CLAUDE.md in one go. · Opus, high',
  '- [ ] **Fix the 3 Windows-only test failures** (recommended): sync-common inTemp, the two sync-move 0600 checks',
  '  and sync-carry symlink. · Opus, medium',
  '- [ ] **A worktree remove helper**: `scripts/wt-remove.js <name>` unlinks the junctions. · Opus, low',
  '- [ ] **One phone ship command**: checks for native changes, then [ships](https://example.com/x) it. · Opus, medium',
].join('\n');

// ---------- the options ----------
{
  const o = L.optionsOf(REPLY);
  assert.equal(o.length, 4);
  assert.deepEqual(o.map((x) => x.n), [1, 2, 3, 4]);
  assert.deepEqual(o.map((x) => x.rec), [true, true, false, false]);
  assert.equal(o[0].text, 'One ship command for Fleet View on the PC: a scripts/ship.js <PR#> that does steps 1–7 of the repo CLAUDE.md in one go. · Opus, high');
  assert.equal(o[1].text, 'Fix the 3 Windows-only test failures: sync-common inTemp, the two sync-move 0600 checks and sync-carry symlink. · Opus, medium');
  assert.equal(o[3].text, 'One phone ship command: checks for native changes, then ships it. · Opus, medium');
  ok('optionsOf: every unticked item, in order; marks, code and links out; a wrapped line joins its option; (recommended) out of the text');

  assert.equal(L.optionsOf('- [x] done\n- [ ] not yet'), null);
  assert.equal(L.optionsOf('no list here\n- a plain item'), null);
  assert.deepEqual(L.optionsOf('```\n- [ ] in code\n```\n- [ ] real one').map((x) => x.text), ['real one']);
  assert.deepEqual(L.optionsOf('- [ ] **Parent**: x\n  - [ ] **Child** (Recommended): y\n- [ ] Third').map((x) => [x.n, x.text, x.rec]),
    [[1, 'Parent: x', false], [2, 'Child: y', true], [3, 'Third', false]]);
  assert.equal(L.optionsOf(`- [ ] ${'w'.repeat(500)}`)[0].text.length, 400);
  ok('optionsOf: a ticked box is progress (null); no task list is null; code blocks skipped; nested items count; 400 characters at most');
}

// ---------- the message, and what counts as launched ----------
{
  const o = L.optionsOf(REPLY);
  const text = L.launchText(o, [2, 1]);
  assert.equal(text, `Go with these:\n1. ${o[0].text}\n2. ${o[1].text}\n\n${L.LAUNCH_LINE}`);
  // it counts as a launch as it is, and under fv send --from's line
  assert.deepEqual([...L.launchedKeys([text])], ['one ship command for fleet view on the pc', 'fix the 3 windows-only test failures']);
  const fromLine = `[Message from "Panchito IT" (db591225-6ac6-45f4-a006-ee962b573ddc). Reply with: fv send db591225 "message" --from 64e4d121]\n${text}`;
  assert.equal(L.launchedKeys([fromLine]).size, 2);
  // what a bot typed by hand, all on one line, is not a launch the page knows: why fv launch exists
  assert.equal(L.launchedKeys(['[Message from "Panchito IT" (db591225). Reply with: …]\nGo with these: 1. One ship command for Fleet View on the PC (recommended) · Opus, high 2. Fix the 3 Windows-only test failures (recommended) · Opus, medium.']).size, 0);
  ok('launchText: the page\'s message; launchedKeys reads it alone and under a from line, not a one-line typed list');

  // the page's and the phone's words, the same as launch.js's
  const web = fs.readFileSync(path.join(ROOT, 'web', 'chat.js'), 'utf8');
  const phone = fs.readFileSync(path.join(ROOT, 'phone', 'src', 'lib', 'chat', 'compose.ts'), 'utf8');
  assert.equal(/const LAUNCH_LINE = '([^']+)';/.exec(web)[1], L.LAUNCH_LINE);
  assert.equal(/const LAUNCH_HEAD = '([^']+)';/.exec(web)[1], L.LAUNCH_HEAD);
  assert.equal(/LAUNCH_LINE =\s*'([^']+)';/.exec(phone)[1], L.LAUNCH_LINE);
  assert.equal(/LAUNCH_HEAD = '([^']+)';/.exec(phone)[1], L.LAUNCH_HEAD);
  ok('LAUNCH_HEAD and LAUNCH_LINE: web/chat.js, phone compose.ts and launch.js agree word for word');
}

// ---------- the picks ----------
{
  const o = L.optionsOf(REPLY).map((x) => ({ ...x, done: x.n === 2 }));
  assert.deepEqual(L.choose(o, 'recommended'), { ns: [1] });
  assert.deepEqual(L.choose(o, [3, 2, 3]), { ns: [3], skipped: [2] });
  assert.match(L.choose(o, [9]).error, /options 1 to 4; no 9/);
  assert.match(L.choose(o, [2]).error, /launched already/);
  assert.match(L.choose(o.map((x) => ({ ...x, done: x.rec })), 'recommended').error, /recommended options are launched already \(1, 2\)/);
  assert.match(L.choose(o.map((x) => ({ ...x, rec: false })), 'recommended').error, /no option in the list is marked/);
  ok('choose: the recommended ones not launched yet; numbers (launched ones skipped); refusals say why');

  // the newest reply with a choice; launches anywhere in the conversation count
  const items = [
    { i: 0, type: 'assistant', text: '- [ ] **Old**: a\n- [ ] **Older** (recommended): b' },
    { i: 1, type: 'user', text: 'thanks' },
    { i: 2, type: 'assistant', text: REPLY },
    { i: 3, type: 'user', text: `Go with these:\n2. ${L.optionsOf(REPLY)[1].text}\n\n${L.LAUNCH_LINE}` },
    { i: 4, type: 'assistant', text: 'On it.\n\n- [x] item 2 started' },
    { i: 5, type: 'tool', tool: { name: 'Bash' } },
  ];
  const c = L.latestChoice(items);
  assert.equal(c.item.i, 2);
  assert.deepEqual(c.options.map((x) => x.done), [false, true, false, false]);
  assert.equal(L.latestChoice([{ i: 0, type: 'assistant', text: 'nothing' }]), null);
  ok('latestChoice: the newest reply offering options (a progress list after it skipped), launches marked done');
}

// ---------- the endpoint (dry runs and refusals: nothing is sent) ----------
const ID = '0000000b-0000-4000-8000-000000000000';
async function endpoint() {
  const items = [{ i: 7, t: 1000, type: 'assistant', text: REPLY }];
  let asked = null;
  const ctx = { transcript: async (id, q) => { asked = { id, q }; return id === ID ? { total: 8, from: 0, items } : null; }, log() {} };
  let [code, j] = await API.launchPicks(ID, { dry: true }, ctx, () => false);
  assert.equal(code, 200);
  assert.deepEqual(j.picked, [1, 2]);
  assert.equal(j.text, L.launchText(L.optionsOf(REPLY), [1, 2]));
  assert.deepEqual(j.reply, { i: 7, t: 1000 });
  assert.equal(asked.q.limit, 500);
  assert.ok(asked.q.textMax >= 100000, 'a long reply is read whole');
  [code, j] = await API.launchPicks(ID, { picks: [4, 3], dry: true }, ctx, () => false);
  assert.deepEqual([code, j.picked], [200, [3, 4]]);
  [code, j] = await API.launchPicks(ID, { picks: [5] }, ctx, () => false);
  assert.equal(code, 409);
  assert.equal(j.options.length, 4, 'a refusal lists the options to pick from');
  [code] = await API.launchPicks(ID, { picks: 'all' }, ctx, () => false);
  assert.equal(code, 400);
  [code] = await API.launchPicks(ID, { picks: [0] }, ctx, () => false);
  assert.equal(code, 400);
  [code] = await API.launchPicks('not-an-id', {}, ctx, () => false);
  assert.equal(code, 400);
  [code] = await API.launchPicks('0000000c-0000-4000-8000-000000000000', {}, ctx, () => false);
  assert.equal(code, 404);
  items[0] = { i: 7, type: 'assistant', text: 'no options here' };
  [code, j] = await API.launchPicks(ID, {}, ctx, () => false);
  assert.equal(code, 409);
  assert.match(j.message, /offering options/);
  assert.ok(API.ENDPOINTS.some((e) => e.method === 'POST' && e.path === '/api/sessions/:id/launch'));
  ok('POST .../launch: dry run gives the picks and the exact text; bad picks 400; no such reply or option 409; listed in GET /api');
}

// ---------- fv launch ----------
async function cli() {
  const FROM = '11111111-1111-4111-8111-111111111111';
  const calls = [];
  const opts = L.optionsOf(REPLY).map((x) => ({ ...x, done: false }));
  const call = async (method, p, body) => {
    calls.push({ method, p, body });
    if (p.endsWith('/launch')) return { code: 200, j: { ok: true, id: ID, options: opts, picked: body.picks === 'recommended' ? [1, 2] : body.picks, text: 'x', message: body.dry ? 'would launch' : 'launched 1, 2; sent' } };
    return { code: 200, j: { ok: true } };
  };
  const out = [], err = [];
  const run = async (argv) => { out.length = 0; err.length = 0; calls.length = 0; return FV.main(argv, { call }, (l) => out.push(l), (l) => err.push(l)); };

  assert.equal(await run(['launch', ID, '--from', FROM]), 0);
  assert.deepEqual(calls.at(-1), { method: 'POST', p: `/sessions/${ID}/launch`, body: { picks: 'recommended', from: FROM } });
  assert.ok(out.some((l) => l.startsWith('> ★ 1. One ship command')) && out.some((l) => l.startsWith('    3. A worktree')), out.join('\n'));
  assert.ok(out.includes('launched 1, 2; sent'));
  assert.equal(await run(['launch', ID, '3', '1']), 0);
  assert.deepEqual(calls.at(-1).body, { picks: [3, 1] });
  assert.equal(await run(['launch', ID, '--list']), 0);
  assert.deepEqual(calls.at(-1).body, { picks: 'recommended', dry: true });
  assert.ok(!out.some((l) => l.startsWith('>')), 'a list marks nothing as sent');
  assert.equal(await run(['launch', ID, '1', '--recommended']), 2);
  assert.equal(await run(['launch', ID, 'x']), 2);
  assert.equal(await run(['launch', ID, '0']), 2);
  ok('fv launch: recommended by default, numbers, --list (dry), --from; bad picks are usage errors');
}

(async () => {
  await endpoint();
  await cli();
  console.log(`\n${n} passed, 0 failed`);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
})().catch((e) => { console.error('FAIL', e && e.stack || e); process.exit(1); });
