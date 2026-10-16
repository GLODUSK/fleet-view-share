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

// ---------- a recommendation outside a task list (web/recommend.js, run by launch.js as it stands) ----------
// the reply Henry asked about 2026-10-15: a bold label after a progress list and a sentence saying "I recommended"
const REC_REPLY = [
  'No. The change wouldn\'t touch anything Cris uses.',
  '',
  '**What I checked on production:**',
  '',
  '- All five of Cris\'s services use the line-based pricing.',
  '- The code skips lines like his (`lineHoursAreTimeOnly` in `lib/configurator/pricing.ts`).',
  '',
  '**What that means:** your current pricing already works the way I recommended.',
  '',
  '**My recommendation:** remove it in one small PR. It\'s leftover code, not a bug anyone can hit.',
].join('\n');
{
  const R = L.recommendationsOf;
  assert.deepEqual(R(REC_REPLY), ['remove it in one small PR. It\'s leftover code, not a bug anyone can hit.']);
  assert.deepEqual(R('Recommendation — ship **it** today'), ['ship it today']);
  assert.deepEqual(R('Recommended fix: guard the null'), ['guard the null']);
  assert.deepEqual(R('**My recommendation:**\n\n1. **Fix the parser** first\n   - a detail under it\n2. Then ship\n\nAnything else?'), ['Fix the parser first', 'Then ship']);
  assert.deepEqual(R('## Recommendation\n\nGo with B.\n\n## Other notes\n\nnone'), ['Go with B.']);
  assert.deepEqual(R('## What I\'d do\n\n- Drop the cache'), ['Drop the cache']);
  ok('recommendationsOf: a label (bold, a dash, a word after it), or a label or heading alone takes the list or paragraph under it');

  assert.deepEqual(R('Two ways:\n\n- **A**: fast\n- **B** (recommended): safe'), ['B: safe']);
  assert.deepEqual(R('### Option two (Recommended)\n\nmore'), ['Option two']);
  assert.deepEqual(R('| Plan | Cost |\n|---|---|\n| Plan A (recommended) | low |\n| Plan B | high |'), ['Plan A · low']);
  assert.deepEqual(R('> **Recommendation:** ship it Monday'), ['ship it Monday']);
  // a mark beats a label and a sentence
  assert.deepEqual(R('I recommend A.\n\nRecommendation: B\n\n- C (recommended)'), ['C']);
  ok('recommendationsOf: "(recommended)" on a plain item, a heading or a table row; a quote counts; the most explicit kind wins');

  assert.deepEqual(R('It works. I\'d strongly recommend adding a test for it. Otherwise fine.\n\nDone.'), ['I\'d strongly recommend adding a test for it. Otherwise fine.']);
  assert.deepEqual(R('My recommendation is to ship.'), ['My recommendation is to ship.']);
  assert.deepEqual(R('We would recommend B over A.'), ['We would recommend B over A.']);
  assert.deepEqual(R('I wouldn\'t recommend that. I don\'t recommend this. I would not recommend it. I recommended it before. It\'s the recommended way. Recommendations vary.'), []);
  assert.deepEqual(R('```\nI recommend nothing\nRecommendation: none\n```\nok'), []);
  assert.deepEqual(R('no options here'), []);
  assert.equal(R(`Recommendation: ${'w'.repeat(500)}`)[0].length, 400);
  assert.equal(R(Array.from({ length: 8 }, (_, i) => `- item ${i} (recommended)`).join('\n')).length, 5);
  assert.deepEqual(R('- Same (recommended)\n- same (recommended)'), ['Same']);
  // talk about the rules is not a recommendation: the summary that got the button 2026-10-15 (its items were launched)
  assert.deepEqual(R([
    '**What gets the button:** any reply without a `- [ ]` option list that gives a recommendation:',
    '- `(recommended)` on any line, plain list item, heading or table row',
    '- a label: `**My recommendation:** …`, `Recommendation — …`, `Recommended fix: …`',
    '- a sentence: "I recommend …", "I\'d strongly recommend …", "My recommendation is …"',
    '',
    'It skips "I wouldn\'t recommend", “I recommended” and code blocks.',
  ].join('\n')), []);
  // a real one keeps its code's words, and one outside the quotes still counts
  assert.deepEqual(R('I\'d recommend running `npm ci` first.'), ['I\'d recommend running npm ci first.']);
  assert.deepEqual(R('- `fast` mode\n- `safe` mode (recommended)'), ['safe mode']);
  assert.deepEqual(R('You asked "which one?". I recommend the second.'), ['I recommend the second.']);
  ok('recommendationsOf: a sentence from its start to its paragraph\'s end; negatives, past tense and code are not one; 400 characters, 5 at most, each once');

  // advice to do nothing gets no button (2026-10-15: this one got "Launch recommendation")
  assert.deepEqual(R('My recommendation is to leave him off for now. Getting Ember to greet callers reliably is still being worked on, and a missed or garbled greeting would reach his paying customers first. Once the greeting works reliably on the GLODUSK demo shop, adding him is a one-line change I can make.'), []);
  for (const s of [
    'I\'d recommend holding off until the fix lands.', 'Recommendation: hold off.', 'I recommend we wait until Monday.',
    'My recommendation: don\'t add him yet.', 'I\'d recommend not merging this.', 'I recommend keeping it as is.',
    'My recommendation: no change needed.', 'Recommendation: skip it for now.', 'I\'d recommend against it.',
    '**My recommendation:** leave it for now. It\'s leftover code.', '- Leave it as is (recommended)\n- Rewrite it',
  ]) assert.deepEqual(R(s), [], s);
  // advice to do something still counts, even with "wait", "leave", "keep", "skip" or "not yet" in it
  assert.deepEqual(R('My recommendation is to add him now. The greeting works.'), ['My recommendation is to add him now. The greeting works.']);
  assert.deepEqual(R('My recommendation is to add a wait for the port.'), ['My recommendation is to add a wait for the port.']);
  assert.deepEqual(R('I recommend leaving a comment on the PR.'), ['I recommend leaving a comment on the PR.']);
  assert.deepEqual(R('I recommend keeping the old flag but renaming the new one.'), ['I recommend keeping the old flag but renaming the new one.']);
  assert.deepEqual(R('If it\'s not yet merged, I\'d recommend merging it today.'), ['If it\'s not yet merged, I\'d recommend merging it today.']);
  assert.deepEqual(R('Recommended fix: skip the cache on reload'), ['skip the cache on reload']);
  // only the hold-off one goes when there are several
  assert.deepEqual(R('- Fix the parser (recommended)\n- Leave the docs as is (recommended)'), ['Fix the parser']);
  assert.equal(L.latestChoice([{ i: 0, type: 'assistant', text: 'My recommendation: hold off for now.' }]), null);
  ok('recommendationsOf: hold-off advice (hold off, wait, leave or keep it as is, don\'t, not, skip it, no change needed) is not one');

  // as options: every one recommended; latestChoice falls back to it; the message has REC_LINE
  assert.equal(L.optionsOf(REC_REPLY), null);
  const items = [
    { i: 0, type: 'assistant', text: REPLY },
    { i: 1, type: 'user', text: 'will this affect Cris?' },
    { i: 2, type: 'assistant', text: REC_REPLY },
  ];
  const c = L.latestChoice(items);
  assert.equal(c.item.i, 2);
  assert.equal(c.rec, true);
  assert.deepEqual(c.options.map((o) => [o.n, o.rec, o.done]), [[1, true, false]]);
  assert.deepEqual(L.choose(c.options, 'recommended'), { ns: [1] });
  const text = L.launchText(c.options, [1], true);
  assert.equal(text, `Go with these:\n1. ${c.options[0].text}\n\n${L.REC_LINE}`);
  assert.equal(L.latestChoice([...items, { i: 3, type: 'user', text }]).options[0].done, true);
  assert.equal(L.latestChoice(items.slice(0, 1)).rec, false);
  ok('a recommendation as options: latestChoice falls back to it (rec), launched with REC_LINE, and its launch marks it done');

  // the page reads it with the same file, and says REC_LINE word for word (the phone too)
  const web = fs.readFileSync(path.join(ROOT, 'web', 'chat.js'), 'utf8');
  const phone = fs.readFileSync(path.join(ROOT, 'phone', 'src', 'lib', 'chat', 'compose.ts'), 'utf8');
  assert.match(web, /import \{ recommendationsOf \} from '\.\/recommend\.js';/);
  assert.equal(/const REC_LINE = '((?:[^'\\]|\\.)+)';/.exec(web)[1].replace(/\\'/g, '\''), L.REC_LINE);
  assert.equal(/REC_LINE =\s*'((?:[^'\\]|\\.)+)';/.exec(phone)[1].replace(/\\'/g, '\''), L.REC_LINE);
  ok('REC_LINE: web/chat.js, phone compose.ts and launch.js agree word for word; the page imports recommend.js');
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
  items[0] = { i: 7, type: 'assistant', text: REC_REPLY };
  [code, j] = await API.launchPicks(ID, { dry: true }, ctx, () => false);
  assert.deepEqual([code, j.picked, j.recommendation], [200, [1], true]);
  assert.ok(j.text.endsWith(L.REC_LINE));
  assert.ok(API.ENDPOINTS.some((e) => e.method === 'POST' && e.path === '/api/sessions/:id/launch'));
  // the server routes every session endpoint GET /api lists (1.0.324 listed launch but answered 404 to it)
  for (const e of API.ENDPOINTS.filter((x) => x.path.startsWith('/api/sessions'))) {
    assert.ok(API.ROUTE.test(e.path.replace(':id', ID)), `${e.method} ${e.path} is listed but not routed`);
  }
  ok('POST .../launch: dry run gives the picks and the exact text; bad picks 400; no such reply or option 409; listed in GET /api and routed');
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
