// share-health-test.js: share-health.js, with a fake gh and a temp data folder (no network, no live server):
// ciState (the newest finished push run on main decides; reds counted back to the last green; cancelled ones and other
// branches left out), ciLine, publishState (the newest share-publish.log entry), and createShareHealth: off without
// scripts/publish-share.js, red on a red run or a failed publish, one server.log line when it turns red and one when
// green again, GET /share-health.
// Run: node scripts/share-health-test.js (exit 0 = all pass)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require(path.join(__dirname, '..', 'share-health.js'));

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.log(`FAIL ${n}`); } };
const eq = (a, b, n) => ok(JSON.stringify(a) === JSON.stringify(b), `${n}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
const run = (id, conclusion, at, o = {}) => ({ databaseId: id, conclusion, status: 'completed', displayTitle: `Fleet View 1.0.${id}`, url: `https://github.com/x/runs/${id}`, createdAt: at, headBranch: 'main', event: 'push', ...o });

(async () => {
  // ---------- ciState / ciLine ----------
  const runs = [
    run(9, '', '2026-10-17T12:00:00Z', { status: 'in_progress' }),
    run(8, 'cancelled', '2026-10-17T11:00:00Z'),
    run(7, 'failure', '2026-10-17T10:00:00Z'),
    run(70, 'success', '2026-10-17T09:30:00Z', { headBranch: 'mac-test/x' }),
    run(6, 'failure', '2026-10-16T10:00:00Z'),
    run(5, 'success', '2026-10-15T10:00:00Z'),
    run(4, 'failure', '2026-10-14T10:00:00Z'),
  ];
  const c = H.ciState(runs);
  eq([c.state, c.running, c.id, c.reds, c.since, c.more], ['red', true, 7, 2, '2026-10-16T10:00:00Z', false], 'red: the newest finished run on main, 2 reds back to the last green, a run going');
  eq(H.ciLine(c), 'share CI: RED on the last 2 runs on main since 2026-10-16 10:00 UTC (Fleet View 1.0.7): https://github.com/x/runs/7', 'the red line');
  const g = H.ciState([run(3, 'success', '2026-10-17T10:00:00Z'), run(2, 'failure', '2026-10-16T10:00:00Z')]);
  eq([g.state, g.reds, g.since], ['green', 0, null], 'green when the newest finished one passed');
  eq(H.ciLine(g), 'share CI: green (Fleet View 1.0.3)', 'the green line');
  const all = H.ciState([run(2, 'failure', '2026-10-16T10:00:00Z'), run(1, 'failure', '2026-10-15T10:00:00Z')]);
  ok(all.more && /RED on the last 2\+ runs on main since at least 2026-10-15 10:00 UTC/.test(H.ciLine(all)), `every run read is red: "at least" (${H.ciLine(all)})`);
  eq([H.ciState([]).state, H.ciLine(H.ciState(null))], [null, null], 'no runs: no state, no line');

  // ---------- publishState ----------
  const log = [
    '--- 2026-10-17 09:00:00 after pull to aaaaaaa', 'origin/main 1.0.1 (aaaaaaa): 9 files', 'published: 1.0.1 (aaaaaaa) on X',
    '--- 2026-10-17 10:00:00 after pull to bbbbbbb', 'fatal: unable to access \'https://github.com/x/\': Could not resolve host: github.com',
  ].join('\n');
  const p = H.publishState(log);
  eq([p.state, p.sha, /Could not resolve host/.test(p.line), p.at === Date.parse('2026-10-17T10:00:00')], ['failed', 'bbbbbbb', true, true], 'the newest entry: failed');
  eq(H.publishState(log.split('\n').slice(0, 3).join('\n')).state, 'published', 'published');
  eq(H.publishState('--- 2026-10-17 09:00:00 after pull to ccccccc\norigin/main 1.0.2 (ccccccc): 9 files').state, 'running', 'still going');
  eq(H.publishState('--- 2026-10-17 09:00:00 after pull to ccccccc\nthe share repo already has this version').state, 'already', 'already');
  eq(H.publishState('nothing here'), null, 'no entry');

  // ---------- createShareHealth ----------
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-share-health-'));
  try {
    const root = path.join(T, 'checkout'), data = path.join(T, 'data');
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.mkdirSync(data, { recursive: true });
    const lines = [], asked = [];
    let answer = [run(2, 'success', '2026-10-17T10:00:00Z')];
    const gh = async (args) => { asked.push(args.join(' ')); if (answer instanceof Error) throw answer; return JSON.stringify(answer); };
    const off = H.createShareHealth({ root, dataDir: data, gh, log: (t) => lines.push(t) });
    eq([off.enabled, (await off.refresh()).enabled, asked.length], [false, false, 0], 'off without scripts/publish-share.js (a friend\'s install): gh never asked');

    fs.writeFileSync(path.join(root, 'scripts', 'publish-share.js'), '// stand-in\n');
    const sh = H.createShareHealth({ root, dataDir: data, gh, log: (t) => lines.push(t) });
    let v = await sh.refresh();
    eq([v.enabled, v.red, v.ci.state, v.publish], [true, false, 'green', null], 'on: green, no publish log yet');
    ok(/^run list -R GLODUSK\/fleet-view-share --workflow Mac --branch main --limit 30 --json /.test(asked[0]), `asks gh for the Mac workflow's runs on main: ${asked[0]}`);
    eq(lines, [], 'no log line for the first look');
    answer = [run(3, 'failure', '2026-10-17T11:00:00Z'), run(2, 'success', '2026-10-17T10:00:00Z')];
    v = await sh.refresh();
    ok(v.red && v.ci.state === 'red' && lines.length === 1 && /^share health: red: share CI: RED on the last 1 run on main/.test(lines[0]), `turns red, one log line: ${lines.join(' | ')}`);
    await sh.refresh();
    eq(lines.length, 1, 'still red: no second line');
    answer = [run(4, 'success', '2026-10-17T12:00:00Z')];
    v = await sh.refresh();
    ok(!v.red && lines[1] === 'share health: green again', `green again: ${lines.join(' | ')}`);
    // a failed publish is red too, the CI green
    fs.writeFileSync(path.join(data, 'share-publish.log'), log);
    v = await sh.refresh();
    ok(v.red && v.publish.state === 'failed' && /share health: red: publish failed: fatal/.test(lines[2] || ''), `a failed publish is red: ${JSON.stringify(v.publish)} ${lines.join(' | ')}`);
    // gh failing keeps the last CI state and says why
    answer = new Error('gh: not logged in');
    v = await sh.refresh();
    ok(v.ci.state === 'green' && /gh run list: gh: not logged in/.test(v.error), `gh failing: the last state kept, the error said (${v.error})`);
    // GET /share-health
    let sent = null;
    sh.handle({ method: 'GET' }, {}, '/share-health', { sendJson: (res, code, out) => { sent = [code, out]; } });
    ok(sent && sent[0] === 200 && sent[1].ok && sent[1].enabled && sent[1].red && sent[1].publish.state === 'failed', `GET /share-health: ${JSON.stringify(sent)}`);
    sh.handle({ method: 'POST' }, {}, '/share-health', { sendJson: (res, code, out) => { sent = [code, out]; } });
    eq(sent[0], 404, 'POST /share-health: 404');
    sh.stop(); off.stop();
  } finally { try { fs.rmSync(T, { recursive: true, force: true }); } catch {} }
})().catch((e) => { fail++; console.log(`FAIL ${e.stack || e}`); }).finally(() => {
  console.log(`${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
});
