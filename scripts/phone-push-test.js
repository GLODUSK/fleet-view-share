// Phone notifications: a test of phone-push.js, run with the system node:   node scripts/phone-push-test.js
// A fake Fleet View (GET /state with its alerts, an ETag and 304) and a fake Expo push service, both on loopback, and a
// clock of its own. The alert kinds (question, error, stalled and an unfinished plan: needs; done: finished; merged;
// a finished plan and the others: nothing), the first read with no cursor sending nothing (catch-up), the cursor kept
// in push.json across a restart (nothing sent twice, the new ones sent), the read after no phone had a token taking
// the cursor anew, an alert over 10 minutes old never sent, coalescing (per chat and kind: needs 3 minutes, finished
// 2, merged per PR; a team's members as one, the most urgent kind of a chat in one read, several chats as one push
// per kind), content-free payloads (no name, no text, no PR number) unless the phone's names is on, and with it on a
// push per chat (its name, what happened, a line of its words: gist, askOf, detailOf), the chat another machine runs left to it
// when the phone is registered there (peers), DeviceNotRegistered dropping that token, Expo refusing or not answering
// (logged, no throw), and a log that never holds a token or a chat's name.
// Everything in a temp folder (PHONE_PUSH_TEST_DIR, or the system temp folder), deleted at the end. Never the real
// Expo, never the real server. Exit 0 = all pass.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const PP = require(path.join(ROOT, 'phone-push.js'));

let passed = 0, failed = 0;
const ok = (c, msg) => { if (c) passed++; else { failed++; console.log(`FAIL ${msg}`); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}: want ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const base = process.env.PHONE_PUSH_TEST_DIR || os.tmpdir();
fs.mkdirSync(base, { recursive: true });
const T = fs.mkdtempSync(path.join(base, 'phone-push-test-'));

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', C = '33333333-3333-4333-8333-333333333333';
const D = '44444444-4444-4444-8444-444444444444', E = '55555555-5555-4555-8555-555555555555';
const MAC = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const TOKEN1 = 'ExponentPushToken[phone1Token_abcdef]', TOKEN2 = 'ExponentPushToken[phone2Token_ghijkl]';

// ---------- the fake Fleet View ----------
const clock = { t: Date.UTC(2026, 9, 14, 12, 0, 0) };
let n = clock.t; // as fleet-view.js numbers its alerts: from the clock, then one up each
const st = { alerts: [], sessions: [], teams: [] };
const alert = (sid, kind, extra = {}) => { const a = { n: ++n, t: clock.t, sid, name: `Chat ${sid.slice(0, 4)}`, text: 'what it said', color: '#fff', kind, ...extra }; st.alerts.push(a); return a; };
let stateReads = 0, notModified = 0;
const fv = http.createServer((req, res) => {
  if (req.url !== '/state') { res.writeHead(404); return res.end(); }
  stateReads++;
  const body = JSON.stringify({ ...st, alerts: st.alerts.slice(-30) });
  const tag = `"${crypto.createHash('sha1').update(body).digest('base64url')}"`;
  if (req.headers['if-none-match'] === tag) { notModified++; res.writeHead(304, { ETag: tag }); return res.end(); }
  res.writeHead(200, { 'Content-Type': 'application/json', ETag: tag });
  res.end(body);
});

// ---------- the fake Expo ----------
const expo = { got: [], raw: [], answer: null, status: 200 };
const ex = http.createServer((req, res) => {
  const parts = [];
  req.on('data', (c) => parts.push(c));
  req.on('end', () => {
    const text = Buffer.concat(parts).toString('utf8');
    expo.raw.push(text);
    const list = JSON.parse(text);
    expo.got.push(...list);
    const data = expo.answer ? expo.answer(list) : list.map(() => ({ status: 'ok', id: crypto.randomUUID() }));
    res.writeHead(expo.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(expo.status === 200 ? { data } : { errors: [{ code: 'INTERNAL_SERVER_ERROR', message: 'down' }] }));
  });
});
const take = () => expo.got.splice(0);

async function main() {
  await new Promise((r) => fv.listen(0, '127.0.0.1', r));
  await new Promise((r) => ex.listen(0, '127.0.0.1', r));
  const port = fv.address().port, sendUrl = `http://127.0.0.1:${ex.address().port}/--/api/v2/push/send`;
  const dataDir = path.join(T, 'data');
  const logs = [], dropped = [];
  let targets = [{ dev: 'devPhone1aaaaaaa', token: TOKEN1, names: false, peers: [] }];
  const make = () => PP.createPush({ port, dataDir, sendUrl, now: () => clock.t, log: (t) => logs.push(t), targets: () => targets, drop: (dev, token, why) => dropped.push([dev, token, why]) });

  // ---------- the kinds ----------
  const k = (kind, text) => PP.kindOf({ kind, text });
  eq(['question', 'error', 'stalled', 'done', 'merged', 'live', 'checks', 'agentFail', 'overLimit', 'message'].map((x) => k(x)),
    ['needs', 'needs', 'needs', 'finished', 'merged', null, null, null, null, null], 'the alert kinds');
  eq([k('plan', 'plan Build it finished'), k('plan', 'plan Build it failed'), k('plan', 'plan Build it cancelled')], [null, 'needs', 'needs'], 'a plan: only one that did not finish');
  eq([PP.namesText(['a']), PP.namesText(['a', 'b']), PP.namesText(['a', 'b', 'c', 'd'])], ['a', 'a and b', 'a, b and 2 more'], 'namesText');

  // ---------- a line of what a chat said ----------
  const REPLY = '## Done\n\nAll three support items are **live** in production.\n\n```js\nconst x = 1;\n```\n\n1. Resolved tickets end\n2. [PR #12](https://x/12) merged\n\n| a | b |\n|---|---|';
  eq(PP.gist(REPLY), 'Done. All three support items are live in production. Resolved tickets end. PR #12 merged. a · b', 'gist: headings, code, list marks, links and tables out, lines run together');
  ok(PP.gist('word '.repeat(100)).length <= 240 && PP.gist('word '.repeat(100)).endsWith('…'), 'gist: at most 240 characters, cut between words');
  eq(PP.askOf('I found two ways.\n\nShould I ship it now, or wait for the review?\n\nEither is fine.'), 'I found two ways. Should I ship it now, or wait for the review?', 'askOf: the last line with a question, and the short one before it');
  eq(PP.askOf('Ship it?\nOr wait?'), 'Ship it? Or wait?', 'askOf: two short lines together');
  eq(PP.askOf(`${'A long opening line that sets the scene for what comes after it, '.repeat(2)}\nShall I go on?`), 'Shall I go on?', 'askOf: a long line before: the question alone');
  eq(PP.askOf('No question here.\nJust a note.'), 'No question here. Just a note.', 'askOf: no question: its end');
  const row = { repo: { name: 'web' }, lastReply: 'Built it.\n\nWant me to merge?' };
  eq(PP.detailOf({ kind: 'done', text: 'finished' }, row), { what: 'Finished · web', body: 'Built it. Want me to merge?' }, 'detailOf done: Finished, the repo, the reply');
  eq(PP.detailOf({ kind: 'done', text: 'finished' }, { ...row, doneReply: 'What its bot chat shows.' }).body, 'What its bot chat shows.', 'detailOf done: a bot\'s shown reply when it differs');
  eq(PP.detailOf({ kind: 'question', text: 'asked you a question' }, row), { what: 'Asks you · web', body: 'Built it. Want me to merge?' }, 'detailOf asked in a reply: the question');
  eq(PP.detailOf({ kind: 'question', text: 'waits on you: Allow Bash: npm test?' }, row), { what: 'Waits on you', body: 'Allow Bash: npm test?' }, 'detailOf a prompt on screen: its words');
  eq(PP.detailOf({ kind: 'merged', text: 'PR #482 merged' }, row), { what: 'Merged PR #482', body: 'Into web.' }, 'detailOf merged');
  eq(PP.detailOf({ kind: 'error', text: 'hit an API error, retry it' }, null).what, 'Hit an API error', 'detailOf error, no row');
  eq(PP.detailOf({ kind: 'plan', text: 'plan Build failed' }, null), { what: 'Plan failed', body: 'Plan Build failed' }, 'detailOf a failed plan');

  // ---------- catch-up: the first read sends nothing ----------
  alert(A, 'question'); alert(B, 'done');
  let push = make();
  await push.tick();
  ok(stateReads === 1 && !take().length, 'the first read (no cursor): nothing sent');
  const file = path.join(dataDir, 'relay', 'push.json');
  eq(JSON.parse(fs.readFileSync(file, 'utf8')).n, n, 'push.json keeps the newest n');
  await push.tick();
  ok(notModified === 1 && !take().length, 'nothing new: the If-None-Match read gets 304');

  // ---------- one alert, content-free ----------
  clock.t += 1000;
  alert(A, 'question', { name: 'Secret project', text: 'is asking you a question' });
  await push.tick();
  let got = take();
  eq(got, [{ to: TOKEN1, title: 'A chat needs you', data: { kind: 'needs', machine: 'devPhone1aaaaaaa', sid: A }, sound: 'default', priority: 'high', ttl: 21600 }], 'a question: "A chat needs you", data { kind, machine, sid }, no body');
  ok(!expo.raw.join('').includes('Secret project') && !expo.raw.join('').includes('asking'), 'names off: no name or text goes to Expo');
  // coalesced for 10 minutes per chat and kind
  clock.t += 60e3;
  alert(A, 'question');
  await push.tick();
  ok(!take().length, 'the same chat needs you again within 10 minutes: coalesced');
  clock.t += 30e3;
  alert(A, 'done');
  await push.tick();
  eq(take().map((m) => [m.title, m.data.sid]), [['A chat finished', A]], 'another kind for that chat goes');
  clock.t += 10 * 60e3;
  alert(A, 'question');
  await push.tick();
  eq(take().map((m) => m.title), ['A chat needs you'], '10 minutes on: it goes again');

  // ---------- several in one read ----------
  clock.t += 1000;
  alert(B, 'done'); alert(C, 'done'); alert(D, 'done'); alert(B, 'question');
  await push.tick();
  got = take();
  eq(got.map((m) => [m.title, m.data]), [['A chat needs you', { kind: 'needs', machine: 'devPhone1aaaaaaa', sid: B }], ['2 chats finished', { kind: 'finished', machine: 'devPhone1aaaaaaa' }]],
    'one read: B\'s most urgent kind (needs), and C and D as one push with no sid');

  // ---------- names on ----------
  targets = [{ dev: 'devPhone1aaaaaaa', token: TOKEN1, names: true, peers: [] }];
  clock.t += 11 * 60e3;
  alert(E, 'merged', { name: 'Fleet work', text: 'PR #482 merged' });
  await push.tick();
  eq(take().map((m) => [m.title, m.subtitle, m.body, m.data]), [['Fleet work', 'Merged PR #482', undefined, { kind: 'merged', machine: 'devPhone1aaaaaaa', sid: E }]], 'names on: the chat\'s name as the title, the PR as the subtitle');
  clock.t += 1000;
  alert(E, 'merged', { name: 'Fleet work', text: 'PR #483 merged' });
  await push.tick();
  eq(take().map((m) => m.subtitle), ['Merged PR #483'], 'another PR merged by that chat within 10 minutes: it goes (per PR)');
  st.sessions = [{ id: C, name: 'Gamma', repo: { name: 'web' }, lastReply: 'Two ways to do it.\n\nShould I keep the old route?' }];
  alert(C, 'question', { name: 'Gamma', text: 'asked you a question' }); alert(D, 'question', { name: 'Delta' }); alert(A, 'question', { name: 'Alpha' });
  await push.tick();
  got = take();
  eq(got.map((m) => [m.title, m.data.sid]), [['Gamma', C], ['Delta', D], ['Alpha', A]], 'three chats, names on: a push each, each opening its chat');
  eq([got[0].subtitle, got[0].body], ['Asks you · web', 'Two ways to do it. Should I keep the old route?'], 'the question it asks as the body');
  clock.t += 4 * 60e3;
  alert(A, 'done', { name: 'Alpha' }); alert(B, 'done', { name: 'Beta' }); alert(C, 'done', { name: 'Gamma' }); alert(D, 'done', { name: 'Delta' });
  await push.tick();
  eq(take().map((m) => [m.title, m.body]), [['4 chats finished', 'Alpha, Beta and 2 more']], 'four of a kind in one read: one push, the first two and how many more');
  clock.t += 60e3;
  alert(A, 'done', { name: 'Alpha' });
  await push.tick();
  ok(!take().length, 'finished again within 2 minutes: coalesced');
  clock.t += 61e3;
  alert(A, 'done', { name: 'Alpha' });
  await push.tick();
  eq(take().map((m) => m.title), ['Alpha'], 'finished again over 2 minutes on: it goes');
  st.sessions = [];

  // ---------- a team's members are one group chat ----------
  const TEAM = 't0123ab';
  st.teams = [{ id: TEAM, name: 'Team', members: [B, C] }];
  clock.t += 11 * 60e3;
  alert(B, 'done'); alert(C, 'done');
  await push.tick();
  eq(take().map((m) => [m.title, m.subtitle, m.data]), [['Team', `Chat ${B.slice(0, 4)} · Finished`, { kind: 'finished', machine: 'devPhone1aaaaaaa', sid: B, team: TEAM }]], 'two members finishing: one push for the team (its group chat), the member in the subtitle');
  st.teams = [];

  // ---------- another machine's chat ----------
  st.sessions = [{ id: D, name: 'On the Mac', workspace: { kind: 'portable', host: { device: MAC.toUpperCase(), name: 'Mac' } } }];
  targets = [
    { dev: 'devPhone1aaaaaaa', token: TOKEN1, names: false, peers: [MAC] },
    { dev: 'devPhone2bbbbbbb', token: TOKEN2, names: false, peers: [] },
  ];
  clock.t += 11 * 60e3;
  alert(D, 'question');
  await push.tick();
  eq(take().map((m) => m.to), [TOKEN2], 'a chat the Mac runs: only the phone not registered with the Mac hears it here');
  st.sessions = [];

  // ---------- old alerts ----------
  clock.t += 11 * 60e3;
  st.alerts.push({ n: ++n, t: clock.t - 11 * 60e3, sid: A, name: 'old', text: '', kind: 'question' });
  await push.tick();
  ok(!take().length, 'an alert over 10 minutes old is never sent');

  // ---------- DeviceNotRegistered ----------
  expo.answer = (list) => list.map((m) => (m.to === TOKEN2 ? { status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered' } } : { status: 'ok', id: 'x' }));
  alert(B, 'question');
  await push.tick();
  ok(take().length === 2, 'both phones were sent to');
  eq(dropped.map(([dev, token]) => [dev, token]), [['devPhone2bbbbbbb', TOKEN2]], 'DeviceNotRegistered: that token is dropped');
  expo.answer = (list) => list.map(() => ({ status: 'error', message: 'no APNs key', details: { error: 'InvalidCredentials' } }));
  clock.t += 1000;
  alert(C, 'done');
  await push.tick();
  ok(take().length === 2 && dropped.length === 1 && logs.some((l) => /InvalidCredentials/.test(l)), 'another error: logged, nothing dropped');
  expo.answer = null;

  // ---------- Expo refusing, or not there ----------
  expo.status = 500;
  clock.t += 1000;
  alert(D, 'done');
  let threw = null;
  try { await push.tick(); } catch (e) { threw = e; }
  ok(!threw && logs.some((l) => /refused 2: INTERNAL_SERVER_ERROR/.test(l)), `Expo answering 500: logged, no throw (${logs.slice(-1)})`);
  take();
  expo.status = 200;
  push.stop();
  const deadUrl = 'http://127.0.0.1:9/--/api/v2/push/send';
  const pushDead = PP.createPush({ port, dataDir: path.join(T, 'dead'), sendUrl: deadUrl, now: () => clock.t, log: (t) => logs.push(t), targets: () => targets });
  await pushDead.tick();
  clock.t += 1000;
  alert(E, 'done');
  await pushDead.tick();
  ok(logs.some((l) => /could not be reached/.test(l)), 'Expo out of reach: logged');

  // ---------- a restart keeps the cursor ----------
  clock.t += 11 * 60e3;
  alert(A, 'question');
  push = make();
  push.start();
  await push.tick();
  push.stop();
  eq(take().map((m) => [m.title, m.data.sid]), [['A chat needs you', A], ['A chat needs you', A]], 'after a restart: only what came after the kept cursor (once per phone)');
  push = make();
  push.start();
  await push.tick();
  ok(!take().length, 'and again after another: nothing twice');

  // ---------- no phone, then one ----------
  targets = [];
  const reads = stateReads;
  await push.tick();
  ok(stateReads === reads, 'no phone with a token: /state is not even read');
  clock.t += 11 * 60e3;
  alert(B, 'question'); alert(C, 'done');
  targets = [{ dev: 'devPhone1aaaaaaa', token: TOKEN1, names: false, peers: [] }];
  await push.tick();
  ok(!take().length, 'a phone takes a token: the first read catches up silently');
  clock.t += 1000;
  alert(D, 'question');
  await push.tick();
  eq(take().map((m) => m.data.sid), [D], 'then the new ones go');
  push.stop();

  // ---------- a bot a session asks for (/state botRequests) ----------
  clock.t += 1000;
  const RQ = 'abcdef012345';
  st.botRequests = [{ id: RQ, name: 'Deploy watch', role: 'QA', brief: 'b', why: 'for the release', from: A, fromName: 'Release lead', at: clock.t }];
  targets = [{ dev: 'devPhone1aaaaaaa', token: TOKEN1, names: false, peers: [] }, { dev: 'devPhone2bbbbbbb', token: TOKEN2, names: true, peers: [] }];
  push = make();
  push.start();
  await push.tick();
  let rgot = take();
  eq(rgot.map((m) => [m.to, m.title, m.body || null, m.data]), [
    [TOKEN1, 'A session asks to make a bot', null, { kind: 'bot-request', request: RQ, machine: 'devPhone1aaaaaaa' }],
    [TOKEN2, 'Release lead asks to make a bot: Deploy watch', 'QA', { kind: 'bot-request', request: RQ, machine: 'devPhone2bbbbbbb' }],
  ], 'a bot request: one push per phone, names off says only that a session asks, names on who, which bot and its role');
  await push.tick();
  ok(!take().length, 'a bot request pushes once');
  push.stop();
  push = make();
  push.start();
  await push.tick();
  ok(!take().length, 'and not again after a restart (reqAt in push.json)');
  eq(JSON.parse(fs.readFileSync(path.join(dataDir, 'relay', 'push.json'), 'utf8')).reqAt, clock.t, 'push.json keeps the newest request seen');
  clock.t += 1000;
  st.botRequests = [{ id: 'bbbbbbbbbbbb', name: 'Notes', role: '', why: 'keeps the notes', from: null, fromName: null, at: clock.t }, ...st.botRequests,
    { id: 'cccccccccccc', name: 'Old', role: 'x', at: clock.t - 11 * 60e3 }];
  await push.tick();
  rgot = take();
  eq(rgot.map((m) => [m.title, m.body || null, m.data.request]), [['A session asks to make a bot', null, 'bbbbbbbbbbbb'], ['A session asks to make a bot: Notes', 'keeps the notes', 'bbbbbbbbbbbb']],
    'a new request goes (no role: its why; no name for the session: A session), an old one never');
  push.stop();
  delete st.botRequests;

  // ---------- a bot a session made (/state bots with bySession) ----------
  clock.t += 1000;
  const MB = 'dddddddddddd';
  st.bots = [{ id: MB, name: 'Abogadito', role: 'Reads contracts', createdAt: clock.t, bySession: true, madeBy: A, madeByName: 'Release lead' },
    { id: 'eeeeeeeeeeee', name: 'Mine', role: 'x', createdAt: clock.t, bySession: false, madeBy: null, madeByName: null }];
  push = make();
  push.start();
  await push.tick();
  rgot = take();
  eq(rgot.map((m) => [m.to, m.title, m.body || null, m.data]), [
    [TOKEN1, 'A session made a bot', null, { kind: 'bot-made', bot: MB, machine: 'devPhone1aaaaaaa' }],
    [TOKEN2, 'Release lead made a bot: Abogadito', 'Reads contracts', { kind: 'bot-made', bot: MB, machine: 'devPhone2bbbbbbb' }],
  ], "a bot a session made: one push per phone after the fact (names off: only that a session made one); Henry's own pushes nothing");
  await push.tick();
  ok(!take().length, 'a bot a session made pushes once');
  push.stop();
  push = make();
  push.start();
  await push.tick();
  ok(!take().length, 'and not again after a restart (madeAt in push.json)');
  eq(JSON.parse(fs.readFileSync(path.join(dataDir, 'relay', 'push.json'), 'utf8')).madeAt, clock.t, 'push.json keeps the newest made bot seen');
  clock.t += 1000;
  st.bots = [...st.bots, { id: 'ffffffffffff', name: 'Quiet', role: '', createdAt: clock.t, bySession: true, madeBy: null, madeByName: null },
    { id: '111111111111', name: 'Old', role: 'x', createdAt: clock.t - 11 * 60e3, bySession: true }];
  await push.tick();
  eq(take().map((m) => [m.title, m.body || null, m.data.kind, m.data.bot]), [['A session made a bot', null, 'bot-made', 'ffffffffffff'], ['A session made a bot: Quiet', null, 'bot-made', 'ffffffffffff']],
    'a new one goes (no name for the session: A session; no role: no body), an old one never');
  push.stop();
  delete st.bots;

  // ---------- a bot a session removed (/state botRemovals) ----------
  clock.t += 1000;
  const RB = 'abababababab';
  st.botRemovals = [{ id: RB, name: 'Scout', removedBy: A, removedByName: 'Release lead', removedAt: clock.t }];
  push = make();
  push.start();
  await push.tick();
  rgot = take();
  eq(rgot.map((m) => [m.to, m.title, m.data]), [
    [TOKEN1, 'A session removed a bot', { kind: 'bot-removed', bot: RB, machine: 'devPhone1aaaaaaa' }],
    [TOKEN2, 'Release lead removed a bot: Scout', { kind: 'bot-removed', bot: RB, machine: 'devPhone2bbbbbbb' }],
  ], 'a bot a session removed: one push per phone after the fact (names off: only that a session removed one)');
  await push.tick();
  ok(!take().length, 'a removal pushes once');
  push.stop();
  push = make();
  push.start();
  await push.tick();
  ok(!take().length, 'and not again after a restart (removedAt in push.json)');
  eq(JSON.parse(fs.readFileSync(path.join(dataDir, 'relay', 'push.json'), 'utf8')).removedAt, clock.t, 'push.json keeps the newest removal seen');
  clock.t += 1000;
  st.botRemovals = [{ id: 'cdcdcdcdcdcd', name: 'Quiet', removedBy: null, removedByName: null, removedAt: clock.t }, { id: '111111111111', name: 'Old', removedAt: clock.t - 11 * 60e3 }, ...st.botRemovals];
  await push.tick();
  eq(take().map((m) => [m.title, m.data.kind, m.data.bot]), [['A session removed a bot', 'bot-removed', 'cdcdcdcdcdcd'], ['A session removed a bot: Quiet', 'bot-removed', 'cdcdcdcdcdcd']],
    'a new one goes (no name for the session: A session), an old one never');
  push.stop();
  delete st.botRemovals;

  // ---------- the log ----------
  const logText = logs.join('\n');
  ok(![TOKEN1, TOKEN2, 'phone1Token', 'Secret project', 'Fleet work', 'Gamma', 'old route'].some((s) => logText.includes(s)), 'the log never holds a token, a chat\'s name or its words');

  fv.close(); ex.close();
  try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
