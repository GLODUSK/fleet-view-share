// teams-nest-test.js: the page's team routes with nested teams (a leader of leaders), through a --demo server on a
// spare port with its own data folder (nothing is typed in the demo). Two teams with leads, then a team of those leads
// under a third: they keep leading theirs, and a mid-level lead's brief names both levels. A change that would make a
// lead report to itself is 409 and changes nothing. Adding a member moves only its plain seat; adding one as a lead
// moves the team it led and keeps its plain seat. Making another member the lead of a mid-level team gives the new
// lead the old one's seat above. /api/status from a mid-level lead lists both its teams, the one it leads first.
// Run: node scripts/teams-nest-test.js (exit 0 = all pass)
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = 4797, ORIGIN = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.log(`FAIL ${n}`); } };
const eq = (a, b, n) => ok(JSON.stringify(a) === JSON.stringify(b), `${n}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

function req(method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      let s = '';
      res.on('data', (c) => { s += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch {} resolve({ code: res.statusCode, j }); });
    });
    r.on('error', reject);
    r.setTimeout(20000, () => r.destroy(new Error('timeout')));
    if (data) r.write(data);
    r.end();
  });
}
const post = (p, b) => req('POST', p, b, { Origin: ORIGIN });
// every team (/state lists only those with a member on the map; these members are made-up ids)
let auth = {};
const teamsNow = async () => ((await req('GET', '/api/teams', null, auth)).j || {}).teams || [];
const byId = (ts, id) => ts.find((t) => t.id === id) || null;
const uuid = () => crypto.randomUUID();

(async () => {
  const data = fs.mkdtempSync(path.join(process.env.FV_TEST_TMP || os.tmpdir(), 'fv-teams-nest-'));
  const env = { ...process.env, LOCALAPPDATA: data, HOME: data, XDG_STATE_HOME: data };
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'fleet-view.js'), '--demo', '--port', String(PORT), '--no-open'], { env, stdio: 'ignore', windowsHide: true });
  try {
    let up = false;
    for (let i = 0; i < 120 && !up; i++) { try { up = (await req('GET', '/state')).code === 200; } catch {} if (!up) await new Promise((r) => setTimeout(r, 500)); }
    ok(up, 'the demo server answers /state');
    if (!up) return;
    const token = fs.readFileSync(path.join(data, 'fleet-view', 'api-token'), 'utf8').trim();
    auth = { Authorization: `Bearer ${token}` };
    const [T, A, B, a1, a2, b1] = Array.from({ length: 6 }, uuid);

    // two teams with leads, then a team of their leads under T
    const ta = (await post('/teams', { members: [A, a1, a2], order: 'build the web side', lead: A, name: 'web' })).j.team;
    const tb = (await post('/teams', { members: [B, b1], order: 'build the app side', lead: B, name: 'app' })).j.team;
    const r = await post('/teams', { members: [T, A, B], order: 'ship booking reminders', lead: T, name: 'top' });
    ok(r.code === 200 && r.j.ok, `a team of leads is made: ${JSON.stringify(r.j && r.j.message)}`);
    const top = r.j.team;
    let ts = await teamsNow();
    eq([byId(ts, ta.id).lead, byId(ts, ta.id).members.length, byId(ts, tb.id).lead, byId(ts, top.id).lead], [A, 3, B, T], 'the leads keep leading their teams, and T leads them');
    ok(!r.j.left, 'nobody left a team: only plain seats move');
    ok(/You also lead team "web"/.test(r.j.briefs[A]) && /fv status/.test(r.j.briefs[A]), 'a mid-level lead\'s brief in the team above names the team it leads');
    const own = await post('/teams', { members: [A, a1, a2], order: 'the web part, again', lead: A });
    ok(/You also report upward, in team "top"/.test(own.j.briefs[A]) && own.j.briefs[A].includes(`Your lead is`) && own.j.briefs[A].includes(T),
      'its own team\'s brief says where it reports, and to whom');
    eq(own.j.team.id, ta.id, 'the same set is the same team');

    // a loop is refused, and nothing changes
    const loop = await post('/teams/add', { id: ta.id, member: T });
    ok(loop.code === 409 && /report to itself/.test(loop.j.message), `T reporting to A, who reports to T, is 409: ${JSON.stringify(loop.j)}`);
    const loop2 = await post('/teams', { members: [a1, T], order: 'x', lead: a1 });
    ok(loop2.code === 409, 'a new team that would loop is 409 too');
    ts = await teamsNow();
    eq([byId(ts, ta.id).members, byId(ts, top.id).members, ts.length], [[A, a1, a2], [T, A, B], 4], '... and nothing changed (the demo has a team of its own)');

    // adding a member moves its plain seat
    const add = await post('/teams/add', { id: tb.id, member: a1 });
    ts = await teamsNow();
    ok(add.code === 200 && byId(ts, tb.id).members.includes(a1) && !byId(ts, ta.id).members.includes(a1), 'a member added to another team leaves its own');
    // adding a mid-level lead as a plain member elsewhere keeps the team it leads, and leaves its seat above
    const addLead = await post('/teams/add', { id: tb.id, member: A });
    ts = await teamsNow();
    eq([addLead.code, byId(ts, ta.id).lead, byId(ts, top.id).members, byId(ts, tb.id).members.includes(A)], [200, A, [T, B], true], 'a lead added as a member keeps its team and leaves its seat above');
    // ... back to the top team: the seat moves back, still leading
    await post('/teams/add', { id: top.id, member: A });
    ts = await teamsNow();
    eq([byId(ts, top.id).members, byId(ts, tb.id).members.includes(A), byId(ts, ta.id).lead], [[T, B, A], false, A], 'back above, still leading');

    // the lead of a mid-level team changes: the new lead takes the old one's seat above
    const sl = await post('/teams/lead', { id: ta.id, member: a2 });
    ts = await teamsNow();
    eq([sl.code, byId(ts, ta.id).lead, byId(ts, top.id).members, byId(ts, ta.id).members.includes(A)], [200, a2, [T, B, a2], true], 'a new mid-level lead takes the old one\'s seat above; the old one stays below');
    ok((sl.j.left || []).some((x) => x.id === top.id), 'the team above is told (left)');

    // joining another team as its lead: it leaves the team it led, and keeps its seat above
    const jl = await post('/teams/add', { id: tb.id, member: a2, lead: true });
    ts = await teamsNow();
    eq([jl.code, byId(ts, tb.id).lead, !!byId(ts, ta.id), byId(ts, top.id).members.includes(a2)], [200, a2, false, true], 'a lead joining another team as its lead leaves the one it led (one left: disbanded) and keeps its seat above');
    // B, the lead that was, has a seat above too: a2 has one already, so B leaves it
    ok(!byId(ts, top.id).members.includes(B) && byId(ts, tb.id).members.includes(B), 'the lead that was stays below and leaves its seat above when the new lead has one');

    // /api/status from a mid-level lead: both teams, the one it leads first, each member once
    const st = await req('GET', `/api/status?from=${a2}`, null, auth);
    const tops = byId(ts, top.id), tbs = byId(ts, tb.id);
    eq([st.code, st.j.team && st.j.team.id, (st.j.teams || []).map((t) => t.id)], [200, tb.id, [tb.id, top.id]], 'status from a mid-level lead: the team it leads first, both listed');
    const want = [...new Set([...tbs.members, ...tops.members])];
    eq(st.j.members.map((m) => m.id), want, '... each member once');
    eq(st.j.members.filter((m) => m.lead).map((m) => m.id).sort(), [a2, T].sort(), '... the leads of both marked');
  } catch (e) {
    fail++;
    console.log(`FAIL ${e && e.stack}`);
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 500));
    try { fs.rmSync(data, { recursive: true, force: true }); } catch {}
  }
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
