// Fleet View desktop: a test of the session host's staggered restore and parked idle conversations (host.js, Restore
// list), run with the system node:   node desktop/host-restore-test.js
// Like host-test.js it starts a test host on its own pipe (every file under one temp folder, never the real host's)
// whose sessions run a fake claude: a node script that notes when it started, with what arguments, in which folder and
// under which account, and ends on Ctrl+C. It checks: the host answers list() while it restores; the starts go one at a
// time, about FV_HOST_RESTORE_GAP_MS apart, in their order (the restart asker and the shown one, the busy ones, bots,
// idle ones with background tasks still running); other idle ones are parked (never started, kept in sessions.json and
// across a host restart) until opened, then resumed in their saved folder, account and size; open of one still queued
// starts it once, not twice; kill of a parked one forgets it; a quit mid-restore keeps the ones not started; restoreIdle
// starts them all; a restart waits for a working one however long it takes, and for one waiting on an answer only
// FV_HOST_ASK_WAIT_MS; one a live claude elsewhere has open is not dropped but tried again FV_HOST_RESTORE_RETRY_MS
// later, then parked (keeping its restore state) when still open; a restart checks again right before it ends anything
// (one that started work meanwhile is waited for); a quit ends one mid-turn without Ctrl+C and saves it busy; a restart
// whose end phase hangs (FV_HOST_TEST_END_HANG) still hands over after its watchdog. Also runningTasks() on its own. Every process it
// started is killed at the end. Exit code 0 when every case passes. FV_HOST_TEST_KEEP=1 keeps the temp folder (host.log)
// after a pass.
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const P = require(path.join(__dirname, '..', 'platform.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms, step = 100) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(step); } return null; };

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-host-restore-test-'));
const TEST_TAG = `fleet-view-host-rtest-${crypto.randomBytes(4).toString('hex')}`;
const PIPE = P.isWin ? `\\\\.\\pipe\\${TEST_TAG}` : path.join(os.tmpdir(), `${TEST_TAG}.sock`);
const DATA = path.join(ROOT, 'data'), PIDS = path.join(ROOT, 'sessions'), PROJECTS = path.join(ROOT, 'projects');
const SETTINGS = path.join(ROOT, 'fleet-view.json'), FAKE = path.join(ROOT, 'fake-claude.js');
for (const d of [DATA, PIDS, PROJECTS, path.join(ROOT, 'handoffs')]) fs.mkdirSync(d, { recursive: true });
const GAP = 1000, ASK_WAIT = 3000, RETRY = 3000;

function nodePath() {
  if (fs.existsSync(path.join(__dirname, 'node_modules', 'node-pty'))) return path.join(__dirname, 'node_modules');
  const r = spawnSync('git', ['-C', __dirname, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', windowsHide: true });
  const main = r.status === 0 ? path.join(path.dirname(r.stdout.trim()), 'desktop', 'node_modules') : null;
  return main && fs.existsSync(path.join(main, 'node-pty')) ? main : null;
}

// the fake claude: one line per start in starts.txt (pid, time, arguments, account folder), in the folder it runs in;
// every byte it receives in received.txt
fs.writeFileSync(FAKE, `'use strict';
const fs = require('fs'), path = require('path');
fs.appendFileSync(path.join(process.cwd(), 'starts.txt'), JSON.stringify({ pid: process.pid, at: Date.now(), args: process.argv.slice(2), config: process.env.CLAUDE_CONFIG_DIR || '-' }) + '\\n');
process.stdout.write('fake claude ready\\r\\n');
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on('data', (d) => { fs.appendFileSync(path.join(process.cwd(), 'received.txt'), d); if (d.includes(3)) process.exit(0); });
process.stdin.resume();
`);

const NODE_PATH = nodePath();
const ENV = {
  ...process.env, FV_HOST_PIPE: PIPE, FV_HOST_DIR: DATA, FV_HOST_SESSIONS_DIR: PIDS, FV_HOST_SETTINGS: SETTINGS,
  FV_HOST_PROJECTS_DIR: PROJECTS, FV_HOST_RESTORE_GAP_MS: String(GAP), FV_HOST_NUDGE_GIVEUP_MS: '30000', FV_HOST_ASK_WAIT_MS: String(ASK_WAIT), FV_HOST_RESTORE_RETRY_MS: String(RETRY),
  FV_TERM_CMD: `"${process.execPath}" "${FAKE}"`, FV_HANDOFF_DIR: path.join(ROOT, 'handoffs'),
  ...(NODE_PATH ? { NODE_PATH } : {}),
};
delete ENV.CLAUDE_LAUNCH_KEY;
const settings = (o) => fs.writeFileSync(SETTINGS, JSON.stringify({ autoContinue: true, ...o }));

// ---------- conversations, the restore list, the host ----------
const ALL = [];
function conv(name, extra) {
  const cwd = path.join(ROOT, `s-${name}`);
  fs.mkdirSync(cwd, { recursive: true });
  const c = { name, id: crypto.randomUUID(), cwd, ...extra };
  ALL.push(c);
  return c;
}
const starts = (c) => { try { return fs.readFileSync(path.join(c.cwd, 'starts.txt'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const received = (c) => { try { return fs.readFileSync(path.join(c.cwd, 'received.txt'), 'latin1'); } catch { return ''; } };
const entry = (c) => ({ id: c.id, cwd: c.cwd, account: c.account || 'B', startedAt: Date.now() - 60000, busy: !!c.busy, interrupted: false, cols: c.cols || 100, rows: 30,
  ...(c.role ? { role: c.role } : {}), ...(c.restartBy ? { restartBy: true } : {}) });
const writeList = (cs, ui = null) => fs.writeFileSync(path.join(DATA, 'sessions.json'), JSON.stringify({ version: 1, savedAt: Date.now(), reason: 'change', hostPid: 1, sessions: cs.map(entry), ui }));
const savedList = () => { try { return JSON.parse(fs.readFileSync(path.join(DATA, 'sessions.json'), 'utf8')).sessions || []; } catch { return []; } };
const savedOf = (c) => savedList().find((x) => x.id === c.id);
function transcript(c, lines) {
  const dir = path.join(PROJECTS, c.cwd.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${c.id}.jsonl`), lines.map((o) => `${JSON.stringify(o)}\n`).join(''));
}
const iso = (ago = 0) => new Date(Date.now() - ago).toISOString();
const bashBg = (tool, task, ago = 60000) => [
  { type: 'assistant', timestamp: iso(ago), message: { role: 'assistant', content: [{ type: 'tool_use', id: tool, name: 'Bash', input: { command: 'npm run build', run_in_background: true } }] } },
  { type: 'user', timestamp: iso(ago), toolUseResult: { backgroundTaskId: task }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tool, content: `Command running in background with ID: ${task}` }] } },
];
// the reply that ends a turn
const ended = () => ({ type: 'assistant', timestamp: iso(), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'It builds in the background.' }] } });
const notice = (task, status) => ({ type: 'user', timestamp: iso(), message: { role: 'user', content: `<task-notification>\n<task-id>${task}</task-id>\n<status>${status}</status>\n<summary>done</summary>\n</task-notification>` } });

const started = new Set();
const hostJson = () => { try { return JSON.parse(fs.readFileSync(path.join(DATA, 'host.json'), 'utf8')); } catch { return null; } };
const hostLog = () => { try { return fs.readFileSync(path.join(DATA, 'host.log'), 'utf8'); } catch { return ''; } };
// c's pid file, as its claude writes one: the host reads a resumed one's status by the conversation's id
let pidN = 0;
function pidFile(c, status, waitingFor) {
  const now = Date.now();
  if (!c.pidFile) { c.pidFile = path.join(PIDS, `${9000 + ++pidN}.json`); c.pidAt = now; }
  fs.writeFileSync(c.pidFile, JSON.stringify({ pid: process.pid, sessionId: c.id, cwd: c.cwd, startedAt: c.pidAt, kind: 'interactive',
    status, ...(waitingFor ? { waitingFor } : {}), statusUpdatedAt: now, updatedAt: now }));
}
function startHost(extra) {
  try { fs.unlinkSync(path.join(DATA, 'host.json')); } catch {}
  const c = spawn(process.execPath, [path.join(__dirname, 'host.js')], { env: { ...ENV, ...extra }, stdio: 'ignore', windowsHide: true });
  started.add(c.pid);
  return c;
}
function connect() {
  return new Promise((resolve, reject) => {
    const hf = hostJson();
    if (!hf) return reject(new Error('no host.json'));
    const s = net.connect(hf.pipe);
    let buf = '', n = 0, ok = false;
    const waits = new Map();
    s.setEncoding('utf8');
    s.on('error', (e) => { if (!ok) reject(e); });
    s.on('connect', () => s.write(`${JSON.stringify({ t: 'hello', token: hf.token, pid: process.pid })}\n`));
    s.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (!ok) {
          if (m.t !== 'hello' || !m.ok) return reject(new Error('refused'));
          ok = true;
          resolve({ pid: m.pid, req: (op, ...a) => new Promise((res, rej) => { const k = ++n; waits.set(k, { res, rej }); s.write(`${JSON.stringify({ t: 'req', n: k, op, a })}\n`); }), close: () => s.destroy() });
        } else if (m.t === 'res' && waits.has(m.n)) {
          const w = waits.get(m.n);
          waits.delete(m.n);
          if (m.err) w.rej(new Error(m.err)); else w.res(m.v);
        }
      }
    });
  });
}
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass });
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'} ${name}${!pass && detail !== undefined ? ` :: ${JSON.stringify(detail).slice(0, 600)}` : ''}\n`);
}
function cleanup() {
  const pids = new Set(started);
  const hf = hostJson();
  if (hf && Number.isInteger(hf.pid)) pids.add(hf.pid);
  for (const m of hostLog().matchAll(/\[host (\d+)\]/g)) pids.add(Number(m[1]));
  for (const c of ALL) for (const s of starts(c)) pids.add(s.pid);
  for (const pid of pids) {
    if (!(pid > 0) || pid === process.pid || !pidAlive(pid)) continue;
    P.killTree(pid, { sync: true });
  }
}
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

function unitRunningTasks(H) {
  const f = path.join(ROOT, 'tasks.jsonl');
  const run = (lines) => { fs.writeFileSync(f, lines.map((o) => `${JSON.stringify(o)}\n`).join('')); return H.runningTasks(f); };
  const agent = (tool, id) => [
    { type: 'assistant', timestamp: iso(), message: { role: 'assistant', content: [{ type: 'tool_use', id: tool, name: 'Agent', input: { description: 'look' } }] } },
    { type: 'user', timestamp: iso(), toolUseResult: { status: 'async_launched', agentId: id }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tool, content: 'launched' }] } },
  ];
  const stop = (tool, task) => [
    { type: 'assistant', timestamp: iso(), message: { role: 'assistant', content: [{ type: 'tool_use', id: tool, name: 'TaskStop', input: { task_id: task } }] } },
    { type: 'user', timestamp: iso(), toolUseResult: { message: 'stopped' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tool, content: 'ok' }] } },
  ];
  const monitor = (tool, task, ago, timeoutMs) => [
    { type: 'assistant', timestamp: iso(ago), message: { role: 'assistant', content: [{ type: 'tool_use', id: tool, name: 'Monitor', input: { description: 'watch' } }] } },
    { type: 'user', timestamp: iso(ago), toolUseResult: { taskId: task, timeoutMs, persistent: false }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tool, content: 'watching' }] } },
  ];
  check('runningTasks: a background shell and an async agent with no notice are running', run([...bashBg('t1', 'b1'), ...agent('t2', 'a2')]) === 2);
  check('runningTasks: a <task-notification> with a status ends one; "running" does not', run([...bashBg('t1', 'b1'), ...bashBg('t2', 'b2'), notice('b1', 'completed'), notice('b2', 'running')]) === 1);
  check('runningTasks: a TaskStop of it ends it', run([...bashBg('t1', 'b1'), ...stop('t3', 'b1')]) === 0);
  check('runningTasks: one launched over a day ago is not counted', run(bashBg('t1', 'b1', 25 * 3600e3)) === 0);
  check('runningTasks: a monitor counts until its timeout', run(monitor('t4', 'm1', 1000, 600000)) === 1 && run(monitor('t4', 'm1', 700000, 600000)) === 0);
  check('runningTasks: none in a plain transcript, 0 for a missing file', run([{ type: 'user', message: { role: 'user', content: 'hi' } }]) === 0 && H.runningTasks(path.join(ROOT, 'nope.jsonl')) === 0);
}

function unitOpenTurn(H) {
  const f = path.join(ROOT, 'turn.jsonl');
  const run = (lines) => { fs.writeFileSync(f, lines.map((o) => `${JSON.stringify(o)}
`).join('')); return H.openTurn(f); };
  const asst = (stop, content, o = {}) => ({ type: 'assistant', message: { role: 'assistant', stop_reason: stop, content }, ...o });
  const user = (content, o = {}) => ({ type: 'user', message: { role: 'user', content }, ...o });
  const call = asst('tool_use', [{ type: 'tool_use', id: 'u1', name: 'Bash', input: {} }]);
  const result = (text) => user([{ type: 'tool_result', tool_use_id: 'u1', content: text }]);
  const ended = asst('end_turn', [{ type: 'text', text: 'Done.' }]);
  const extra = [{ type: 'system', subtype: 'turn_duration' }, { type: 'custom-title', customTitle: 'x' }];
  check('openTurn: a tool result with no reply after it is open', run([user('go'), call, result('Exit code 4'), ...extra]) === true);
  check('openTurn: a tool call with no result is open', run([user('go'), call]) === true);
  check('openTurn: a turn that ended is closed', run([user('go'), call, result('ok'), ended, ...extra]) === false);
  check('openTurn: one stopped with Esc is closed', run([user('go'), call, result('[Request interrupted by user for tool use]'), user([{ type: 'text', text: '[Request interrupted by user for tool use]' }])]) === false);
  check('openTurn: Claude Code filler after a resume is passed over', run([user('go'), call, result('[Tool call interrupted]'), asst('stop_sequence', [{ type: 'text', text: 'No response requested.' }], { message: { role: 'assistant', model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'No response requested.' }] } })]) === true);
  check('openTurn: an agent entries (sidechain) and a prompt with no answer do not count', run([ended, { ...call, isSidechain: true }]) === false && run([ended, user('hello?')]) === false);
  check('openTurn: false for a missing file', H.openTurn(path.join(ROOT, 'nope.jsonl')) === false);
}

async function main() {
  if (!NODE_PATH) { check('node-pty found (desktop/node_modules)', false); return; }
  unitRunningTasks(require(path.join(__dirname, 'host.js')));
  unitOpenTurn(require(path.join(__dirname, 'host.js')));

  // ===== 1. a restore: 7 to start, 6 idle ones to park =====
  const BOT = `bot:${'c3'.repeat(6)}`;
  const R = conv('r', { restartBy: true }), SEL = conv('sel'), B1 = conv('b1', { busy: true }), B2 = conv('b2', { busy: true });
  const BT = conv('bt', { role: BOT }), T = conv('t'), M = conv('m');
  const T2 = conv('t2'), P1 = conv('p1', { account: 'A', cols: 111 }), P2 = conv('p2'), P3 = conv('p3'), P4 = conv('p4'), P5 = conv('p5');
  transcript(T, [...bashBg('t1', 'bt1'), ended()]); // still running when the host stopped
  transcript(M, bashBg('t1', 'bm1').map((e) => ({ ...e, toolUseResult: undefined }))); // saved idle, but its log ends on a tool's result: cut off mid-turn
  transcript(T2, [...bashBg('t1', 'bt2'), notice('bt2', 'completed')]); // finished: parked
  const EAGER = [R, SEL, B1, B2, M, BT, T], PARKED = [T2, P1, P2, P3, P4, P5];
  // in the list's order: parked ones between the others, the shown one and the asker late
  writeList([P1, B1, T2, BT, P2, T, P3, B2, P4, SEL, P5, R, M], { selectedId: SEL.id, wide: false });
  settings({});
  const t0 = Date.now();
  startHost();
  if (!await waitFor(() => hostJson(), 15000)) { check('the test host starts', false, hostLog()); return; }
  let cl = await waitFor(() => connect().catch(() => null), 10000);
  check('1. a client is let in at once while the restore starts', !!cl && Date.now() - t0 < 6000, Date.now() - t0);
  if (!cl) return;
  // list() every 250 ms until all six started: each answered quickly, some while starts were still to come
  let maxMs = 0, during = 0;
  const allUp = await waitFor(async () => {
    const a = Date.now();
    await cl.req('list');
    maxMs = Math.max(maxMs, Date.now() - a);
    const n = EAGER.filter((c) => starts(c).length).length;
    if (n < EAGER.length) during++;
    return n === EAGER.length;
  }, 30000, 250);
  check('1. list() is answered while the restore runs (every answer under 1 s)', allUp && during >= 3 && maxMs < 1000, { allUp, during, maxMs });
  const at = EAGER.map((c) => (starts(c)[0] || {}).at || 0);
  const order = EAGER.map((c, i) => ({ n: c.name, at: at[i] })).sort((a, b) => a.at - b.at);
  const gaps = order.slice(1).map((x, i) => x.at - order[i].at);
  check(`1. starts are staggered (about ${GAP} ms apart, never two at once)`, gaps.every((g) => g >= GAP * 0.6), { order, gaps });
  const names = order.map((x) => x.n).join(',');
  check('1. order: the restart asker and the shown one, the busy ones, the one whose log ends mid-turn, the bot, then the idle one with running tasks', /^(r,sel|sel,r),b1,b2,m,bt,t$/.test(names), names);
  check('1. the idle one whose transcript shows a background task running is resumed (a log line)', hostLog().includes(`restore: ${T.id} had 1 background task(s) running; it is resumed`), hostLog().split('\n').filter((l) => l.includes('restore')));
  check('1. the one saved idle whose log ends mid-turn is resumed as interrupted, a note due (log lines)', hostLog().includes(`restore: ${M.id} was saved idle but its log ends mid-turn; it is resumed`)
    && new RegExp(`restore: ${M.id} resumed \\(pid \\d+\\), was interrupted, note due \\(interrupted\\)`).test(hostLog()), hostLog().split('\n').filter((l) => l.includes(M.id)));
  await sleep(GAP + 800);
  check('1. the other idle ones are parked: never started', PARKED.every((c) => starts(c).length === 0), PARKED.map((c) => starts(c).length));
  check('1. the log says how many resumed and parked', hostLog().includes(`restore: 7 of 13 resumed, 6 parked until opened`), hostLog().split('\n').filter((l) => l.includes('restore')));
  const list1 = await cl.req('list'), parked1 = await cl.req('parked');
  check('1. list() has only the running ones; parked() lists the parked ones', EAGER.every((c) => list1.some((x) => x.id === c.id && x.alive)) && PARKED.every((c) => !list1.some((x) => x.id === c.id))
    && PARKED.every((c) => parked1.some((x) => x.id === c.id && x.parked)) && parked1.length === PARKED.length, { list1: list1.map((x) => x.id), parked1 });
  const bt1 = list1.find((x) => x.id === BT.id);
  check('1. the bot is resumed with its role', bt1 && bt1.role === BOT && starts(BT)[0].args.includes('--resume'), bt1);

  // a change (a kill) saves the list: the parked ones are still in it, marked parked
  await cl.req('kill', P2.id);
  const s1 = await waitFor(() => (!savedOf(P2) ? savedList() : null), 5000);
  check('1. kill of a parked one forgets it (sessions.json, parked(), a log line)', s1 && !(await cl.req('parked')).some((x) => x.id === P2.id) && hostLog().includes(`restore: ${P2.id} was closed before it started`), savedList());
  check('1. after that save the other parked ones are still in sessions.json, parked, with their folder, account and size',
    s1 && [T2, P1, P3, P4, P5].every((c) => { const x = savedOf(c); return x && x.parked === true && x.cwd === c.cwd && x.account === (c.account || 'B'); }) && savedOf(P1).cols === 111
    && EAGER.every((c) => savedOf(c) && !savedOf(c).parked), savedList());

  // open of a parked one: resumed once, in its saved folder and account (not the caller's), at its saved size
  const r1 = await cl.req('open', { id: P1.id, cwd: ROOT, account: 'B' });
  await waitFor(() => starts(P1).length, 10000);
  await sleep(500);
  const lp1 = (await cl.req('list')).find((x) => x.id === P1.id);
  const p1s = starts(P1);
  check('1. open of a parked one resumes it once, in its saved folder and account, at its saved size', r1 && r1.ok && p1s.length === 1 && /[\\/]\.claude-a$/i.test(p1s[0].config)
    && p1s[0].args.includes('--resume') && p1s[0].args.includes(P1.id) && lp1 && lp1.alive && lp1.account === 'A' && lp1.cols === 111 && lp1.restored
    && hostLog().includes(`open: ${P1.id} was parked; resumed`), { r1, p1s, lp1 });
  const s2 = await waitFor(() => { const x = savedOf(P1); return x && !x.parked ? x : null; }, 5000);
  check('1. once opened it is a normal live session in sessions.json (not parked)', s2 && !(await cl.req('parked')).some((x) => x.id === P1.id), savedList());
  const r1b = await cl.req('open', { id: P1.id, cwd: P1.cwd, account: 'A' });
  check('1. a second open attaches (already running), starting nothing', r1b && r1b.message === 'already running' && starts(P1).length === 1, r1b);

  // ===== 2. a host restart: the parked ones stay parked, and stay in the list =====
  const oldPid = cl.pid;
  const rr = await cl.req('restart', { now: true });
  check('2. restart asked', rr && rr.ok, rr);
  cl.close();
  const succ = await waitFor(() => { const h = hostJson(); return h && h.pid !== oldPid ? h : null; }, 30000);
  if (succ) started.add(succ.pid);
  cl = succ ? await waitFor(() => connect().catch(() => null), 10000) : null;
  check('2. a successor host serves the pipe', !!cl, hostLog().split('\n').slice(-8));
  if (!cl) return;
  const done2 = await waitFor(() => hostLog().split('\n').some((l) => l.includes(`[host ${succ.pid}]`) && / of \d+ resumed/.test(l)), 30000);
  await sleep(500);
  const parked2 = await cl.req('parked');
  check('2. after the restart the parked ones are still parked (not started) and listed by parked()', done2 && [T2, P3, P4, P5].every((c) => starts(c).length === 0 && parked2.some((x) => x.id === c.id && x.parked)), { parked2, log: hostLog().split('\n').filter((l) => l.includes('restore')).slice(-6) });
  check('2. and still in sessions.json, parked', [T2, P3, P4, P5].every((c) => (savedOf(c) || {}).parked === true), savedList());
  check('2. the bot comes back at once; a killed parked one does not come back', starts(BT).length === 2 && starts(P2).length === 0 && !savedOf(P2), { bt: starts(BT).length, p2: starts(P2).length });

  // ===== 3. open of a queued one, then quit mid-restore: the ones not started yet stay in the restore list =====
  await cl.req('quitAll', {}).catch(() => null);
  cl.close();
  await waitFor(() => !pidAlive(succ.pid), 15000);
  const Q = [1, 2, 3, 4, 5, 6, 7].map((i) => conv(`q${i}`, { busy: true }));
  writeList(Q);
  startHost();
  if (!await waitFor(() => hostJson(), 15000)) { check('3. the host starts', false, hostLog()); return; }
  cl = await waitFor(() => connect().catch(() => null), 10000);
  await waitFor(() => starts(Q[0]).length, 10000, 50);
  // q3 is still queued: open it now
  const ro = await cl.req('open', { id: Q[2].id, cwd: Q[2].cwd, account: 'B' });
  await waitFor(() => starts(Q[2]).length, 5000, 50);
  const ql = (await cl.req('list')).find((x) => x.id === Q[2].id);
  check('3. open of a queued one starts it at once with its restore state (interrupted)', ro && ro.ok && starts(Q[2]).length === 1 && ql && ql.interrupted && ql.restored
    && hostLog().includes(`open: ${Q[2].id} was waiting for its turn in the restore; it starts now`), { ro, ql });
  // its turn comes and goes (q4 starts after it): it is not started again
  await waitFor(() => starts(Q[3]).length, 10000, 50);
  check('3. when its turn comes the restore skips it (a log line), so it started once only', starts(Q[2]).length === 1 && hostLog().includes(`restore: ${Q[2].id} was opened or closed meanwhile`), starts(Q[2]));
  const hp = hostJson().pid;
  const rq = await cl.req('quitAll', {}).catch((e) => ({ err: e.message }));
  cl.close();
  await waitFor(() => !pidAlive(hp), 15000);
  await sleep(GAP * 2);
  const sq = savedList();
  const notStarted = Q.filter((c) => !starts(c).length);
  check('3. quit mid-restore stops the queue (nothing starts after it; a log line)', rq && rq.ok && notStarted.length >= 2 && hostLog().includes('restore: stopped (quitting)'), { rq, starts: Q.map((c) => starts(c).length), log: hostLog().split('\n').filter((l) => l.includes('restore')).slice(-4) });
  check('3. sessions.json keeps every one: the ones not started still busy, the started ones interrupted', Q.every((c) => sq.some((x) => x.id === c.id))
    && notStarted.every((c) => sq.find((x) => x.id === c.id).busy) && Q.filter((c) => starts(c).length).every((c) => { const x = sq.find((y) => y.id === c.id); return x.busy || x.interrupted; }), sq);

  // ===== 4. restoreIdle: idle ones are started too, still one at a time =====
  const I = [1, 2, 3].map((i) => conv(`i${i}`));
  writeList(I);
  settings({ restoreIdle: true });
  startHost();
  if (!await waitFor(() => hostJson(), 15000)) { check('4. the host starts', false, hostLog()); return; }
  cl = await waitFor(() => connect().catch(() => null), 10000);
  const iUp = await waitFor(() => I.every((c) => starts(c).length === 1), 15000);
  const iAt = I.map((c) => starts(c)[0].at).sort((a, b) => a - b);
  check('4. restoreIdle: every idle one is resumed, staggered, none parked', iUp && iAt[1] - iAt[0] >= GAP * 0.6 && iAt[2] - iAt[1] >= GAP * 0.6
    && (await cl.req('parked')).length === 0 && hostLog().includes('restore: 3 of 3 resumed'), { iAt, parked: await cl.req('parked') });
  await cl.req('killAll').catch(() => {});
  const hp4 = cl.pid;
  await cl.req('quitAll', {}).catch(() => null);
  cl.close();
  await waitFor(() => !pidAlive(hp4), 15000);

  // ===== 5. a restart waits for a working one however long it takes; one waiting on an answer gets ASK_WAIT =====
  settings({});
  const W = conv('w', { busy: true }), A = conv('a', { busy: true });
  writeList([W, A]);
  startHost();
  if (!await waitFor(() => hostJson(), 15000)) { check('5. the host starts', false, hostLog()); return; }
  cl = await waitFor(() => connect().catch(() => null), 10000);
  await waitFor(() => starts(W).length && starts(A).length, 15000);
  pidFile(W, 'busy');
  pidFile(A, 'waiting', 'approve Bash(npm test)');
  const st5 = await waitFor(async () => {
    const l = await cl.req('list'), w = l.find((x) => x.id === W.id), a = l.find((x) => x.id === A.id);
    return w && a && w.status === 'busy' && a.status === 'waiting' ? l : null;
  }, 10000);
  const hp5 = hostJson().pid;
  const r5 = await cl.req('restart', {});
  check('5. restart asked: it waits on the working one and the one waiting on an answer', st5 && r5 && r5.ok && [W.id, A.id].every((id) => (r5.waiting || []).includes(id)), { r5, st5 });
  await sleep(ASK_WAIT * 2 + 2000);
  check('5. the working one is not cut off: past the answer wait nothing is saved or ended', pidAlive(hp5) && !hostLog().includes(`[host ${hp5}] restart: saved`) && starts(W).length === 1, hostLog().split('\n').slice(-5));
  const idleAt = Date.now();
  pidFile(W, 'idle');
  const saved5 = await waitFor(() => hostLog().split('\n').find((l) => l.includes(`[host ${hp5}] restart: saved`)), 15000);
  check('5. once it is idle the restart goes on; the one waiting on an answer past its wait is logged', saved5 && Date.parse(saved5.slice(0, 24)) >= idleAt - 500
    && hostLog().includes(`restart: ${A.id} waited ${ASK_WAIT / 1000} s for an answer`), hostLog().split('\n').slice(-6));
  for (const c of [W, A]) try { fs.unlinkSync(c.pidFile); } catch {}
  cl.close();
  const succ5 = await waitFor(() => { const h = hostJson(); return h && h.pid !== hp5 ? h : null; }, 30000);
  if (succ5) {
    started.add(succ5.pid);
    const c5 = await waitFor(() => connect().catch(() => null), 10000);
    if (c5) { await c5.req('quitAll', {}).catch(() => null); c5.close(); }
    await waitFor(() => !pidAlive(succ5.pid), 15000);
  }

  // ===== 6. one a live claude elsewhere has open (a killed host's claude not dead yet) is tried again RETRY later; =====
  // one still open then is parked, keeping its restore state, not dropped
  settings({});
  const O0 = conv('o0', { busy: true }), O1 = conv('o1', { busy: true }), O2 = conv('o2', { busy: true });
  writeList([O0, O1, O2]);
  pidFile(O1, 'idle');
  pidFile(O2, 'idle');
  startHost();
  if (!await waitFor(() => hostJson(), 15000)) { check('6. the host starts', false, hostLog()); return; }
  cl = await waitFor(() => connect().catch(() => null), 10000);
  const held6 = await waitFor(() => [O1, O2].every((c) => hostLog().includes(`restore: ${c.id} is open in another claude; tried again in ${RETRY / 1000} s`)), 10000);
  const parked6 = cl ? await cl.req('parked') : [];
  check('6. one open in another claude is held for a retry, not dropped (a log line, parked() lists it as waiting)', held6 && starts(O0).length === 1
    && [O1, O2].every((c) => starts(c).length === 0 && parked6.some((x) => x.id === c.id && !x.parked)), { parked6, log: hostLog().split('\n').filter((l) => l.includes('restore')).slice(-6) });
  // O1's other claude ends before the retry; O2's does not
  fs.unlinkSync(O1.pidFile);
  const retried = await waitFor(() => hostLog().includes('restore: tried again: 1 of 2 resumed'), RETRY + 10000);
  check('6. at the retry the one no longer open elsewhere is resumed, once', retried && starts(O1).length === 1 && hostLog().includes(`restore: ${O1.id} resumed`),
    { o1: starts(O1).length, log: hostLog().split('\n').filter((l) => l.includes('restore')).slice(-4) });
  const parked6b = await cl.req('parked');
  check('6. the one still open elsewhere is parked until opened (a log line, parked()), never started', starts(O2).length === 0
    && hostLog().includes(`restore: ${O2.id} is open in another claude; parked until opened`) && parked6b.some((x) => x.id === O2.id && x.parked), parked6b);
  const s6 = await waitFor(() => (savedOf(O2) || {}).parked === true && savedOf(O1) ? savedList() : null, 5000);
  check('6. sessions.json keeps it, parked, with its restore state (busy)', s6 && savedOf(O2).busy === true, savedList());
  const ro6 = await cl.req('open', { id: O2.id, cwd: ROOT, cols: 90, rows: 30 });
  await waitFor(() => starts(O2).length, 5000);
  const l6 = await cl.req('list'), o2l = l6.find((x) => x.id === O2.id);
  check('6. open of it resumes it as the restore would have (interrupted)', ro6 && ro6.ok && starts(O2).length === 1 && o2l && o2l.interrupted && o2l.restored, { ro6, o2l });
  try { fs.unlinkSync(O2.pidFile); } catch {}
  const hp6 = cl.pid;
  await cl.req('quitAll', {}).catch(() => null);
  cl.close();
  await waitFor(() => !pidAlive(hp6), 15000);

  // ===== 7. one that starts work between the restart's check and its end: the restart waits again (nothing saved or =====
  // ended); a quit then ends the one mid-turn without Ctrl+C (Claude Code would record it as the user rejecting its
  // tool call), saved busy, and the idle one with Ctrl+C
  settings({ autoContinue: false });
  const X = conv('x', { busy: true }), Y = conv('y', { busy: true });
  writeList([X, Y]);
  startHost();
  if (!await waitFor(() => hostJson(), 15000)) { check('7. the host starts', false, hostLog()); return; }
  cl = await waitFor(() => connect().catch(() => null), 10000);
  await waitFor(() => starts(X).length && starts(Y).length, 15000);
  pidFile(X, 'idle');
  pidFile(Y, 'idle');
  await waitFor(async () => (await cl.req('list')).filter((x) => x.status === 'idle').length === 2, 10000);
  const hp7 = hostJson().pid;
  const r7 = await cl.req('restart', {});
  pidFile(Y, 'busy'); // it answered after its first check, and runs the self-check again now
  const waited7 = await waitFor(() => hostLog().includes(`[host ${hp7}] restart: ${Y.id} started work meanwhile; waiting again`), 15000);
  await sleep(2500);
  check('7. one that starts work between the restart\'s check and its end: the restart waits again, nothing is saved or ended', r7 && r7.ok && !(r7.waiting || []).length && waited7
    && pidAlive(hp7) && !hostLog().includes(`[host ${hp7}] restart: saved`) && !received(X).includes('\x03') && !received(Y).includes('\x03'), { r7, log: hostLog().split('\n').filter((l) => l.includes(`[host ${hp7}] restart`)) });
  const yPid = (starts(Y)[0] || {}).pid;
  const q7 = await cl.req('quitAll', {}).catch((e) => ({ err: e.message }));
  cl.close();
  await waitFor(() => !pidAlive(hp7), 15000);
  check('7. quit: the one mid-turn gets no Ctrl+C (its tree ends; a log line), the idle one does', q7 && q7.ok && !received(Y).includes('\x03') && received(X).includes('\x03')
    && !pidAlive(yPid) && hostLog().includes(`[host ${hp7}] ending: ${Y.id} mid-turn, so no Ctrl+C`), { q7, x: received(X), y: received(Y), yAlive: pidAlive(yPid) });
  check('7. quit: sessions.json has the one mid-turn busy (resumed and told to carry on), the idle one not', (savedOf(Y) || {}).busy === true && (savedOf(X) || {}).busy === false, savedList());
  for (const c of [X, Y]) try { fs.unlinkSync(c.pidFile); } catch {}

  // ===== 8. a restart whose end phase never finishes still hands over: the watchdog moves on after 8 s =====
  settings({ autoContinue: false });
  const Z = conv('z', { busy: true });
  writeList([Z]);
  startHost({ FV_HOST_TEST_END_HANG: '1' });
  if (!await waitFor(() => hostJson(), 15000)) { check('8. the host starts', false, hostLog()); return; }
  cl = await waitFor(() => connect().catch(() => null), 10000);
  await waitFor(() => starts(Z).length, 15000);
  const hp8 = hostJson().pid, t8 = Date.now();
  const r8 = await cl.req('restart', { now: true });
  cl.close();
  const succ8 = await waitFor(() => { const h = hostJson(); return h && h.pid !== hp8 ? h : null; }, 30000);
  if (succ8) started.add(succ8.pid);
  const back8 = succ8 ? await waitFor(() => starts(Z).length === 2, 15000) : null;
  check('8. a restart whose end phase hangs moves on after 8 s (a log line), and the next host takes over and resumes the session',
    r8 && r8.ok && succ8 && back8 && hostLog().includes(`[host ${hp8}] restart: the sessions had not all ended after 8 s; this one exits`)
    && hostLog().includes(`successor of ${hp8}`) && Date.now() - t8 >= 8000, { r8, succ8, back8, log: hostLog().split('\n').filter((l) => l.includes(`${hp8}`)).slice(-6) });
  const c8 = succ8 ? await waitFor(() => connect().catch(() => null), 10000) : null;
  if (c8) { await c8.req('quitAll', {}).catch(() => null); c8.close(); }
  if (succ8) await waitFor(() => !pidAlive(succ8.pid), 15000);
}

// a host that died mid-request leaves an answer that never comes: the event loop drains with main() still waiting
process.on('beforeExit', () => { check('the test ran to its end', false, 'a request got no answer (did the host die?)'); finish(); });
main().catch((e) => check('the test ran to its end', false, e && e.stack ? e.stack : String(e))).finally(finish);
function finish() {
  cleanup();
  const failed = results.filter((r) => !r.pass).length;
  const keep = failed || process.env.FV_HOST_TEST_KEEP;
  process.stdout.write(`${results.length - failed} passed, ${failed} failed${keep ? ` (files kept in ${ROOT})` : ''}\n`);
  if (!keep) { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {} }
  process.exit(failed ? 1 : 0);
}
