// bot-roles-test.js: a bot's role (bots.js checkRole, Henry 2026-10-13: "give them roles in their bot profile") in the
// team briefs and notes, through a --demo server on a spare port with its own data folder and home (USERPROFILE and
// HOME: its ~/.fleet-view.json holds one bot, Deploy watch, role QA, in a ~/Bots folder there; nothing is typed in the
// demo, and Henry's settings and bot folders are never read or touched). A bot with a role is "Deploy watch (role: QA)"
// in the lead's list, a led member's list of the others, a peer's list and "Your lead is ..."; a member without one is
// as before; GET /api/teams' roster and GET /api/status carry role. Then a bot request's routes (bots.js requestBot)
// through the server: /state's botRequests, the API's, and the page's Make it and Decline only from its Origin. Run: node scripts/bot-roles-test.js (exit 0 = all pass)
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const TS = require('./test-support.js');

let PORT = 0, ORIGIN = ''; // a free port, picked at the start

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

(async () => {
  PORT = await TS.freePort(); ORIGIN = `http://127.0.0.1:${PORT}`;
  const data = fs.mkdtempSync(path.join(process.env.FV_TEST_TMP || os.tmpdir(), 'fv-bot-roles-'));
  const [BOTCONV, L, P1, P2] = Array.from({ length: 4 }, () => crypto.randomUUID());
  const folder = path.join(data, 'Bots', 'deploy-watch');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(data, '.fleet-view.json'), JSON.stringify({
    bots: [{ id: 'abcabcabcabc', name: 'Deploy watch', brief: '', role: 'QA', account: 'B', model: 'dynamic', effort: 'dynamic', folder, createdAt: Date.now(), ids: [BOTCONV], told: [] }],
  }));
  const env = { ...process.env, LOCALAPPDATA: data, HOME: data, USERPROFILE: data, XDG_STATE_HOME: data };
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'fleet-view.js'), '--demo', '--port', String(PORT), '--no-open'], { env, stdio: 'ignore', windowsHide: true });
  try {
    let up = false;
    for (let i = 0; i < 120 && !up; i++) { try { up = (await req('GET', '/state')).code === 200; } catch {} if (!up) await new Promise((r) => setTimeout(r, 500)); }
    ok(up, 'the demo server answers /state');
    if (!up) return;
    const token = fs.readFileSync(path.join(TS.dataDirIn(data), 'api-token'), 'utf8').trim();
    const auth = { Authorization: `Bearer ${token}` };
    const tag = `(role: QA) (id ${BOTCONV},`;

    // peers first (both in no team yet): the bot in a team with no lead
    const r0 = await post('/teams', { members: [BOTCONV, P2], order: 'pair on the notes', name: 'peers' });
    ok(r0.code === 200 && !r0.j.team.lead && (r0.j.briefs[P2] || '').includes('You are working together with:') && r0.j.briefs[P2].includes(tag), `a peer's brief names the bot's role: ${r0.code} ${JSON.stringify(r0.j && r0.j.briefs)}`);

    // a team led by L, with the bot and a plain member: the lead's list names the bot's role; the plain one's has none
    const r = await post('/teams', { members: [L, BOTCONV, P1], order: 'ship the release', lead: L, name: 'release' });
    ok(r.code === 200 && r.j.ok, `the team is made: ${JSON.stringify(r.j && r.j.message)}`);
    const lead = r.j.briefs[L] || '';
    ok(lead.includes('You lead:') && lead.split('\n').some((l) => l.startsWith('- ') && l.includes(tag)), `the lead's brief lists the bot with its role: ${lead}`);
    ok(lead.split('\n').some((l) => l.startsWith('- ') && l.includes(`(id ${P1},`) && !l.includes('role:')), 'a member without a role is listed as before');
    ok(lead.split('\n').some((l) => new RegExp(`^- \\S.* \\(role: QA\\) \\(id ${BOTCONV}, repo [^,]+, branch [^)]+\\)$`).test(l)), 'the line is "- <name> (role: QA) (id <id>, repo <repo>, branch <branch>)"');
    const plainOne = r.j.briefs[P1] || '';
    ok(plainOne.includes('The others in the team') && plainOne.includes(tag), "a led member's list of the others names the bot's role");
    ok(!/role:/.test(r.j.briefs[BOTCONV].split('\n').filter((l) => l.startsWith('- ')).join('\n')), "the bot's own brief lists no role for the others (none has one)");

    // GET /api/teams: the roster carries the bot's role, and no role key for the others
    const ts = ((await req('GET', '/api/teams', null, auth)).j || {}).teams || [];
    const t = ts.find((x) => x.id === r.j.team.id);
    eq(t && t.roster.map((m) => m.role || null), [null, 'QA', null], "GET /api/teams: the roster's role");
    ok(t && !('role' in t.roster[0]), '... left out for a member that is not a bot with a role');

    // GET /api/status: the bot's row carries its role
    const st = await req('GET', `/api/status?team=${r.j.team.id}`, null, auth);
    eq(st.code === 200 && st.j.members.map((m) => m.role || null), [null, 'QA', null], 'GET /api/status: the role');

    // the bot leads: the others' "Your lead is" names its role
    const r2 = await post('/teams', { members: [BOTCONV, P1], order: 'watch the deploys', lead: BOTCONV, name: 'watch' });
    ok(r2.code === 200 && (r2.j.briefs[P1] || '').includes(`Your lead is `) && r2.j.briefs[P1].includes(`(role: QA) (id ${BOTCONV},`), `"Your lead is" names the bot's role: ${r2.j.briefs[P1]}`);

    // the demo lists no bots (it makes none), so state.bots stays empty
    const s = await req('GET', '/state');
    eq([s.code, (s.j && s.j.bots) || null], [200, []], 'GET /state: 200, state.bots empty in the demo');

    // a bot a session asks for (bots.js requestBot), through the server: /state always carries botRequests, the API's
    // routes reach bots.js (the demo makes none: 503), and the page's Make it and Decline need the page's own Origin
    eq((s.j && s.j.botRequests) || null, [], 'GET /state: botRequests, [] when none');
    const ask = await req('POST', '/api/bots/requests', { name: 'Scout' }, auth);
    eq([ask.code, ask.j && ask.j.message], [503, 'the demo makes no bots'], 'POST /api/bots/requests reaches bots.js');
    eq((await req('GET', '/api/bots/requests', null, auth)).j, { ok: true, requests: [] }, 'GET /api/bots/requests');
    eq(((await req('GET', '/api/bots', null, auth)).j || {}).requests, [], 'GET /api/bots carries requests');
    eq((await req('POST', '/api/bots/requests/abcdef012345/approve', {}, auth)).code, 403, 'a session cannot approve');
    // a session on this machine makes a bot itself (POST /api/bots, no relay header): it reaches bots.js (the demo
    // makes none: 503); with an Origin (a web page, this PC's own too) it never does; changing or removing one is 403
    const made = await req('POST', '/api/bots', { name: 'Abogadito', from: '00000042-0000-4000-8000-000000000000' }, auth);
    eq([made.code, made.j && made.j.message], [503, 'the demo makes no bots'], 'POST /api/bots from a session reaches bots.js');
    eq((await req('POST', '/api/bots', { name: 'Abogadito' }, { ...auth, Origin: 'http://evil.example' })).code, 403, 'POST /api/bots from another site: 403');
    eq((await req('POST', '/api/bots', { name: 'Abogadito' }, { ...auth, Origin: ORIGIN })).code, 403, 'POST /api/bots with this PC\'s Origin: 403');
    eq((await req('POST', '/api/bots/abcdef012345', { brief: 'x' }, auth)).code, 403, 'a session cannot change a bot');
    // removing: a session reaches bots.js too (a bot that is not there: 404; the demo has none), a page or a wrong relay key never does
    const rm = await req('POST', '/api/bots/abcdef012345/remove', { from: '00000042-0000-4000-8000-000000000000' }, auth);
    eq([rm.code, rm.j && rm.j.message], [404, 'no such bot (GET /api/bots lists them)'], 'POST /api/bots/:id/remove from a session reaches bots.js');
    eq((await req('POST', '/api/bots/abcdef012345/remove', { from: '00000042-0000-4000-8000-000000000000' }, { ...auth, Origin: 'http://evil.example' })).code, 403, 'remove from another site: 403');
    eq((await req('POST', '/api/bots/abcdef012345/remove', { from: '00000042-0000-4000-8000-000000000000', via: 'phone' }, auth)).code, 403, 'remove with a "via" and no relay key: 403');
    eq((await req('POST', '/api/bots/abcdef012345/remove', {}, { ...auth, 'x-fleet-view-relay': 'nope' })).code, 403, 'remove with a wrong relay key: 403');
    eq((await req('POST', '/bots/requests/abcdef012345/approve', {})).code, 403, 'the page route without an Origin: 403');
    eq((await req('POST', '/bots/requests/abcdef012345/approve', {}, { Origin: 'http://evil.example' })).code, 403, 'another site: 403');
    eq((await post('/bots/requests/abcdef012345/approve', {})).code, 404, 'the page: Make it on no such request: 404');
    eq((await post('/bots/requests/abcdef012345/decline', {})).code, 404, 'the page: Decline on no such request: 404');
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
