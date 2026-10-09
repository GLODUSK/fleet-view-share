// Fleet View desktop: a test of the session host's auto-continue, panel auto-close and restart (host.js), run
// with the system node:   node desktop/host-test.js
// It starts a test host (its own pipe \\.\pipe\fleet-view-host-test-<random>, every file under one temp folder,
// never the real host's) whose sessions run a fake claude: a node script that reads its terminal in raw mode and
// appends whatever it receives to received.txt in its folder (each session has its own). The test plays Claude
// Code's side by writing the sessions/<pid>.json files (with its own pid, so they count as alive) and the
// transcripts, then checks what reached each fake. Every process it started is killed at the end, whatever
// happens. Exit code 0 when every case passes. FV_HOST_TEST_KEEP=1 keeps the temp folder (host.log) after a pass.
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms, step = 200) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(step); } return null; };

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-host-test-'));
const PIPE = `\\\\.\\pipe\\fleet-view-host-test-${crypto.randomBytes(4).toString('hex')}`;
const DATA = path.join(ROOT, 'data'), PIDS = path.join(ROOT, 'sessions'), PROJECTS = path.join(ROOT, 'projects');
const SETTINGS = path.join(ROOT, 'fleet-view.json'), FAKE = path.join(ROOT, 'fake-claude.js');
for (const d of [DATA, PIDS, PROJECTS, path.join(ROOT, 'handoffs')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(SETTINGS, JSON.stringify({ autoContinue: true }));
const PANEL_CLOSE_MS = 2500;

// node-pty lives in desktop/node_modules; a git worktree has none, so use the main checkout's
function nodePath() {
  if (fs.existsSync(path.join(__dirname, 'node_modules', 'node-pty'))) return path.join(__dirname, 'node_modules');
  const r = spawnSync('git', ['-C', __dirname, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', windowsHide: true });
  const main = r.status === 0 ? path.join(path.dirname(r.stdout.trim()), 'desktop', 'node_modules') : null;
  return main && fs.existsSync(path.join(main, 'node-pty')) ? main : null;
}

// the fake claude: notes its start (pid and CLAUDE_LAUNCH_KEY), records every byte it receives, ends on Ctrl+C
fs.writeFileSync(FAKE, `'use strict';
const fs = require('fs'), path = require('path');
fs.appendFileSync(path.join(process.cwd(), 'starts.txt'), process.pid + ' ' + (process.env.CLAUDE_LAUNCH_KEY || '') + '\\n');
process.stdout.write('fake claude ready\\r\\n');
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on('data', (d) => { fs.appendFileSync(path.join(process.cwd(), 'received.txt'), d); if (d.includes(3)) process.exit(0); });
process.stdin.resume();
`);

const NODE_PATH = nodePath();
const ENV = {
  ...process.env, FV_HOST_PIPE: PIPE, FV_HOST_DIR: DATA, FV_HOST_SESSIONS_DIR: PIDS, FV_HOST_SETTINGS: SETTINGS,
  FV_HOST_PROJECTS_DIR: PROJECTS, FV_HOST_NUDGE_GIVEUP_MS: '30000', FV_HOST_PANEL_CLOSE_MS: String(PANEL_CLOSE_MS),
  FV_TERM_CMD: `"${process.execPath}" "${FAKE}"`, FV_HANDOFF_DIR: path.join(ROOT, 'handoffs'),
  ...(NODE_PATH ? { NODE_PATH } : {}),
};
delete ENV.CLAUDE_LAUNCH_KEY;

// ---------- the sessions ----------
const S = {};
function session(name, extra) {
  const cwd = path.join(ROOT, `s-${name}`);
  fs.mkdirSync(cwd, { recursive: true });
  return (S[name] = { name, id: crypto.randomUUID(), cwd, pidFile: path.join(PIDS, `${9000 + Object.keys(S).length}.json`), ...extra });
}
const received = (s) => { try { return fs.readFileSync(path.join(s.cwd, 'received.txt'), 'latin1'); } catch { return ''; } };
const starts = (s) => { try { return fs.readFileSync(path.join(s.cwd, 'starts.txt'), 'utf8').split('\n').filter(Boolean); } catch { return []; } };
// the note's words, then Enter (ConPTY may hand a paste to a raw-mode app as plain keys: words, not exact bytes)
const noteSent = (s, words) => { const r = received(s), i = r.lastIndexOf(words); return i >= 0 && /[\r\n]/.test(r.slice(i + words.length)); };
function pidFile(s, status, waitingFor) {
  const now = Date.now();
  if (!s.startedAt) s.startedAt = now; // the claude "started" when its file first appeared: fresh for this pty
  fs.writeFileSync(s.pidFile, JSON.stringify({ pid: process.pid, sessionId: s.id, cwd: s.cwd, startedAt: s.startedAt, kind: 'interactive',
    status, ...(waitingFor ? { waitingFor } : {}), statusUpdatedAt: now, updatedAt: now }));
}
const dropPidFile = (s) => { try { fs.unlinkSync(s.pidFile); } catch {} s.startedAt = 0; };
function transcript(s) {
  const dir = path.join(PROJECTS, s.cwd.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${s.id}.jsonl`);
}
const jl = (o) => `${JSON.stringify(o)}\n`;
const userLine = (content) => jl({ type: 'user', message: { role: 'user', content } });
const asstLine = (text, model = 'claude-opus-5-5') => jl({ type: 'assistant', message: { role: 'assistant', model, content: [{ type: 'text', text }] } });
const STOPPED = '<task-notification>\n<task-id>b1</task-id>\n<status>killed</status>\n<summary>Background command "npm run build" was stopped</summary>\n</task-notification>';

// ---------- the host and a client of it ----------
const started = new Set(); // every host pid the test (or its host) started
function startHost() {
  const c = spawn(process.execPath, [path.join(__dirname, 'host.js')], { env: ENV, stdio: 'ignore', windowsHide: true });
  started.add(c.pid);
  return c;
}
const hostJson = () => { try { return JSON.parse(fs.readFileSync(path.join(DATA, 'host.json'), 'utf8')); } catch { return null; } };
const hostLog = () => { try { return fs.readFileSync(path.join(DATA, 'host.log'), 'utf8'); } catch { return ''; } };

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
          resolve({
            pid: m.pid,
            req: (op, ...a) => new Promise((res, rej) => { const k = ++n; waits.set(k, { res, rej }); s.write(`${JSON.stringify({ t: 'req', n: k, op, a })}\n`); }),
            close: () => s.destroy(),
          });
        } else if (m.t === 'res' && waits.has(m.n)) {
          const w = waits.get(m.n);
          waits.delete(m.n);
          if (m.err) w.rej(new Error(m.err)); else w.res(m.v);
        }
      }
    });
  });
}

// ---------- results ----------
const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass });
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'} ${name}${!pass && detail !== undefined ? ` :: ${JSON.stringify(detail).slice(0, 400)}` : ''}\n`);
}

function cleanup() {
  const pids = new Set(started);
  const hf = hostJson();
  if (hf && Number.isInteger(hf.pid)) pids.add(hf.pid);
  for (const m of hostLog().matchAll(/\[host (\d+)\]/g)) pids.add(Number(m[1])); // every host that ran on the test pipe
  for (const s of Object.values(S)) for (const l of starts(s)) pids.add(Number(l.split(' ')[0]));
  for (const pid of pids) {
    if (!(pid > 0) || pid === process.pid) continue;
    try { process.kill(pid, 0); } catch { continue; }
    spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore', timeout: 10000 });
  }
}
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

async function main() {
  if (!NODE_PATH) { check('node-pty found (desktop/node_modules)', false); return; }

  // ===== one host restores five conversations: a-c were busy, d1 / d2 idle with a transcript =====
  const NOTE_INT = 'You were cut off mid-turn: the session host stopped';
  const NOTE_TASKS = 'Your background tasks stopped when the session host stopped';
  const NOTE_RESTART = 'The session host restarted as you asked';
  const A = session('a', { busy: true }), B = session('b', { busy: true }), C = session('c', { busy: true });
  const D1 = session('d1', { busy: false }), D2 = session('d2', { busy: false });
  for (const d of [D1, D2]) fs.writeFileSync(transcript(d), userLine('build it') + asstLine('Started the build in the background.'));
  fs.writeFileSync(path.join(DATA, 'sessions.json'), JSON.stringify({ version: 1, savedAt: Date.now() - 60000, reason: 'change', hostPid: 1,
    sessions: [A, B, C, D1, D2].map((s) => ({ id: s.id, cwd: s.cwd, account: 'B', startedAt: Date.now() - 60000, busy: s.busy, interrupted: false, cols: 100, rows: 30 })), ui: null }));

  startHost();
  if (!await waitFor(() => hostJson(), 15000)) { check('the test host starts', false, hostLog()); return; }
  let cl = await waitFor(() => connect().catch(() => null), 10000);
  if (!cl) { check('connect to the test host', false); return; }
  const allUp = await waitFor(() => [A, B, C, D1, D2].every((s) => starts(s).length), 15000);
  check('restore resumes every conversation (each fake claude started)', allUp, [A, B, C, D1, D2].map((s) => starts(s).length));

  // b: a key typed before it is ready cancels its note
  await cl.req('write', B.id, 'x');
  // what each resume "writes" to its transcript: d1 a killed background task (and Claude Code's filler line),
  // d2 the same but answered
  fs.appendFileSync(transcript(D1), userLine([{ type: 'text', text: STOPPED }]) + asstLine('No response requested.'));
  fs.appendFileSync(transcript(D2), userLine(STOPPED) + asstLine('The build had finished; nothing to do.'));
  pidFile(A, 'idle'); pidFile(B, 'idle'); pidFile(C, 'waiting', 'approve Bash(npm test)'); pidFile(D1, 'idle'); pidFile(D2, 'idle');

  // e / e2: sessions opened from the window; "/usage" opens a panel in e, e2 shows a dialog nobody asked for
  const E = session('e'), E2 = session('e2');
  for (const s of [E, E2]) {
    const r = await cl.req('open', { id: s.id, cwd: s.cwd, account: 'B', cols: 100, rows: 30 });
    if (!r || !r.ok) check(`open ${s.name}`, false, r);
  }
  await waitFor(() => starts(E).length && starts(E2).length, 10000);
  pidFile(E, 'idle'); pidFile(E2, 'idle');
  await sleep(1000);
  await cl.req('write', E.id, '\x1b[200~/usage\x1b[201~'); // as the Chat tab sends it: a paste, then Enter
  await cl.req('write', E.id, '\r');
  await sleep(300);
  pidFile(E, 'waiting', 'dialog open'); pidFile(E2, 'waiting', 'dialog open');
  const panelAt = Date.now();
  const eBefore = received(E);
  if (!eBefore.includes('/usage')) check('e. panel: "/usage" reached the session', false, eBefore);

  // e: nothing more before the panel was quiet for PANEL_CLOSE_MS, then a lone Esc
  const eDone = await waitFor(() => received(E).length > eBefore.length, PANEL_CLOSE_MS + 8000, 50);
  const eMs = Date.now() - panelAt;
  check('e. panel: a "/usage" panel left with no keys gets an Esc, not before the delay', eDone && eMs >= PANEL_CLOSE_MS && received(E).slice(eBefore.length).startsWith('\x1b'),
    { before: eBefore, after: received(E), ms: eMs });
  pidFile(E, 'idle'); // the Esc closed it
  // a: interrupted, then idle: the note arrives
  const aOk = await waitFor(() => noteSent(A, NOTE_INT), 15000);
  check('a. interrupted restore: the note is typed and sent once it is idle', aOk, received(A));
  // d1: the killed background task gets the tasks note
  const d1Ok = await waitFor(() => noteSent(D1, NOTE_TASKS), 15000);
  check('d. tasks: a background task reported stopped gets the tasks note', d1Ok, received(D1));

  // c: still waiting on a permission: nothing yet; then idle: the note
  check('c. waiting blocks: no note while it waits on a prompt', !received(C).includes(NOTE_INT.slice(0, 20)), received(C));
  pidFile(C, 'idle');
  const cOk = await waitFor(() => noteSent(C, NOTE_INT), 15000);
  check('c. waiting blocks: the note arrives once it is idle', cOk, received(C));

  // b, d2, e2: nothing came
  await sleep(2000);
  check('b. typing cancels: only the typed key arrived, no note', received(B) === 'x', received(B));
  check('d. tasks: an answered stopped task gets no note', !received(D2).includes('[Fleet View]'), received(D2));
  check('e. panel: a dialog no "/" command opened gets no Esc', !received(E2).includes('\x1b'), received(E2));
  check('e. panel: exactly one Esc in all (it closed)', received(E).slice(eBefore.length) === '\x1b', received(E).slice(eBefore.length));
  const list = await cl.req('list');
  const la = list.find((x) => x.id === A.id), lb = list.find((x) => x.id === B.id);
  check('list(): autoContinue and waitingFor fields', la && la.autoContinue === false && la.interrupted === false && lb && lb.interrupted === true && 'waitingFor' in la && 'slashPanel' in la, list);

  // ===== f. restart: the host hands over to a successor, which resumes the sessions =====
  const keyA = (starts(A)[0] || '').split(' ')[1];
  for (const s of Object.values(S)) dropPidFile(s); // a live pid file would make the next host skip that conversation
  await sleep(1000);
  const oldPid = cl.pid;
  // asked the way a session asks: restart-host.js, with that session's CLAUDE_LAUNCH_KEY
  const asker = spawn(process.execPath, [path.join(__dirname, 'restart-host.js'), '--now'], { env: { ...ENV, CLAUDE_LAUNCH_KEY: keyA }, windowsHide: true });
  let said = '';
  asker.stdout.on('data', (d) => { said += d; });
  const askerDone = new Promise((r) => asker.on('exit', (code) => r(code)));
  await waitFor(() => hostLog().includes('restart: asked'), 10000, 20);
  const r2 = await Promise.race([cl.req('restart', { now: true, by: keyA }), sleep(5000).then(() => 'no answer')]).catch((e) => ({ err: e.message }));
  const code = await Promise.race([askerDone, sleep(30000).then(() => 'no exit')]);
  check('f. restart: restart-host.js asks (exit 0), and a second ask says it is already restarting', code === 0 && /restarts now/.test(said) && r2 && r2.message === 'already restarting', { code, said, r2 });
  cl.close();
  const succ = await waitFor(() => { const h = hostJson(); return h && h.pid !== oldPid && hostLog().includes(`successor of ${oldPid}`) ? h : null; }, 20000);
  check('f. restart: a new host serves the same pipe ("successor of" in its log)', succ && succ.pipe === PIPE, hostLog().split('\n').slice(-8));
  if (succ) started.add(succ.pid);
  const back = await waitFor(() => Object.values(S).every((s) => starts(s).length >= 2), 20000);
  check('f. restart: it resumes every session (each fake claude started again)', back, Object.values(S).map((s) => `${s.name}:${starts(s).length}`));
  pidFile(A, 'idle');
  const fOk = await waitFor(() => noteSent(A, NOTE_RESTART), 15000);
  check('f. restart: the session that asked is told it is done', fOk, received(A).slice(-300));
  cl = await connect().catch(() => null);
  if (cl) { await cl.req('killAll').catch(() => {}); cl.close(); }
}

main().catch((e) => check('the test ran to its end', false, e && e.stack ? e.stack : String(e))).finally(() => {
  cleanup();
  const failed = results.filter((r) => !r.pass).length;
  const keep = failed || process.env.FV_HOST_TEST_KEEP;
  process.stdout.write(`${results.length - failed} passed, ${failed} failed${keep ? ` (files kept in ${ROOT})` : ''}\n`);
  if (!keep) { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {} }
  process.exit(failed ? 1 : 0);
});
