// bot-roles-test.js: a bot's role (bots.js checkRole, Henry 2026-10-13: "give them roles in their bot profile") in the
// team briefs and notes, through a --demo server on a spare port with its own data folder and home (USERPROFILE and
// HOME: its ~/.fleet-view.json holds one bot, Deploy watch, role QA, in a ~/Bots folder there; nothing is typed in the
// demo, and Henry's settings and bot folders are never read or touched). A bot with a role is "Deploy watch (role: QA)"
// in the lead's list, a led member's list of the others, a peer's list and "Your lead is ..."; a member without one is
// as before; GET /api/teams' roster and GET /api/status carry role. Run: node scripts/bot-roles-test.js (exit 0 = all pass)
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = 4793, ORIGIN = `http://127.0.0.1:${PORT}`;
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
    const token = fs.readFileSync(path.join(data, 'fleet-view', 'api-token'), 'utf8').trim();
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
