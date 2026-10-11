// Fleet View desktop: a test of the session host's auto-continue, panel auto-close, restart and the roles: the chief
// (its allowed and blocked fv commands, kept through a re-key, a restore and a handoff; one at a time; dropped when it
// resumes an older conversation) and a bot's (the usual commands; kept and dropped the same ways) (host.js), run
// with the system node:   node desktop/host-test.js
// It starts a test host (its own pipe \\.\pipe\fleet-view-host-test-<random>, on macOS and Linux the socket
// <temp>/fleet-view-host-test-<random>.sock; every file under one temp folder,
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
const P = require(path.join(__dirname, '..', 'platform.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms, step = 200) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(step); } return null; };

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-host-test-'));
const TEST_TAG = `fleet-view-host-test-${crypto.randomBytes(4).toString('hex')}`;
const PIPE = P.isWin ? `\\\\.\\pipe\\${TEST_TAG}` : path.join(os.tmpdir(), `${TEST_TAG}.sock`);
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

// the fake claude: notes its start (pid and CLAUDE_LAUNCH_KEY) and its arguments (the host runs it in place of
// `claude`, with claude's arguments), records every byte it receives, ends on Ctrl+C. With want-id.txt in its
// folder it also writes the pid file Claude Code would, naming that conversation id, so the host re-keys it
fs.writeFileSync(FAKE, `'use strict';
const fs = require('fs'), path = require('path');
fs.appendFileSync(path.join(process.cwd(), 'starts.txt'), process.pid + ' ' + (process.env.CLAUDE_LAUNCH_KEY || '') + '\\n');
fs.appendFileSync(path.join(process.cwd(), 'args.txt'), JSON.stringify(process.argv.slice(2)) + '\\n');
let pidFile = null;
try {
  const id = fs.readFileSync(path.join(process.cwd(), 'want-id.txt'), 'utf8').trim();
  pidFile = path.join(${JSON.stringify(PIDS)}, process.pid + '.json');
  const now = Date.now();
  fs.writeFileSync(pidFile, JSON.stringify({ pid: process.pid, sessionId: id, cwd: process.cwd(), startedAt: now, kind: 'interactive', status: 'idle', statusUpdatedAt: now, updatedAt: now }));
} catch {}
process.on('exit', () => { if (pidFile) { try { fs.unlinkSync(pidFile); } catch {} } });
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
// the arguments of each start, oldest first
const argsOf = (s) => { try { return fs.readFileSync(path.join(s.cwd, 'args.txt'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
// the fv commands one start may run without asking: its --allowedTools argument (exactly one) as [cmd]; null if not one
function allowedFv(args) {
  const a = (args || []).filter((x) => x.startsWith('--allowedTools'));
  if (a.length !== 1 || !a[0].startsWith('--allowedTools=')) return null;
  return a[0].slice('--allowedTools='.length).split(',').map((t) => (/^Bash\(fv (\w+):\*\)$/.exec(t) || [])[1] || `?${t}`);
}
// the fv commands one start may never run: its --disallowedTools argument as [cmd]; [] with none, null if more than one
function deniedFv(args) {
  const a = (args || []).filter((x) => x.startsWith('--disallowedTools'));
  if (!a.length) return [];
  if (a.length !== 1 || !a[0].startsWith('--disallowedTools=')) return null;
  return a[0].slice('--disallowedTools='.length).split(',').map((t) => (/^Bash\(fv (\w+):\*\)$/.exec(t) || [])[1] || `?${t}`);
}
const FV_BASE = ['send', 'status', 'ask', 'read', 'ls', 'teams', 'team', 'transcript'];
const FV_CHIEF_EXTRA = ['start', 'open', 'hosted', 'wait', 'menu'];
const FV_CHIEF_DENIED = ['answer', 'stop', 'rm', 'remove', 'interrupt'];
const BOT1 = `bot:${'a1'.repeat(6)}`, BOT2 = `bot:${'b2'.repeat(6)}`; // two bots' roles (bots.js)
const sameSet = (a, b) => !!a && a.length === b.length && b.every((x) => a.includes(x));
const savedList = () => { try { return JSON.parse(fs.readFileSync(path.join(DATA, 'sessions.json'), 'utf8')).sessions || []; } catch { return []; } };
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
    P.killTree(pid, { sync: true }); // taskkill /T /F on Windows; the process group on macOS and Linux
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

  // ===== g. roles: a chief gets the Chief's fv commands; an ordinary session, or one with an unknown role, does not =====
  const G = session('g'), O = session('o'), X = session('x');
  for (const s of [G, O, X]) fs.writeFileSync(path.join(s.cwd, 'want-id.txt'), s.id);
  const rg = await cl.req('create', { cwd: G.cwd, account: 'B', role: 'chief', cols: 100, rows: 30 });
  const ro = await cl.req('create', { cwd: O.cwd, account: 'B', cols: 100, rows: 30 });
  const rx = await cl.req('create', { cwd: X.cwd, account: 'B', role: 'boss', cols: 100, rows: 30 });
  check('g. role: create echoes role "chief"; none for an ordinary one or an unknown role', rg && rg.ok && rg.role === 'chief' && ro && ro.ok && !('role' in ro) && rx && rx.ok && !('role' in rx), { rg, ro, rx });
  await waitFor(() => [G, O, X].every((s) => argsOf(s).length), 10000);
  const ga = allowedFv(argsOf(G)[0]), oa = allowedFv(argsOf(O)[0]), xa = allowedFv(argsOf(X)[0]);
  check('g. role: a chief may run the usual fv commands plus start, open, hosted, wait and menu (one --allowedTools argument)', sameSet(ga, [...FV_BASE, ...FV_CHIEF_EXTRA]), argsOf(G));
  check('g. role: an ordinary session, and one with an unknown role, gets the usual fv commands only', sameSet(oa, FV_BASE) && sameSet(xa, FV_BASE), { o: argsOf(O), x: argsOf(X) });
  check('g. role: none may answer, stop, rm or interrupt without asking', [ga, oa, xa].every((l) => l && !l.some((c) => ['answer', 'stop', 'rm', 'interrupt'].includes(c))), { ga, oa, xa });
  check('g. role: the chief is blocked from answer, stop, rm, remove and interrupt (one --disallowedTools argument); the others block nothing',
    sameSet(deniedFv(argsOf(G)[0]), FV_CHIEF_DENIED) && [O, X].every((s) => sameSet(deniedFv(argsOf(s)[0]), [])), { g: argsOf(G), o: argsOf(O) });
  // each fake wrote its pid file: the host re-keys it to its id, and the role stays with it
  const keyed = await waitFor(async () => { const l = await cl.req('list'); return [G, O, X].every((s) => l.some((x) => x.id === s.id && !x.pending)) ? l : null; }, 20000);
  const lg = keyed && keyed.find((x) => x.id === G.id), lo = keyed && keyed.find((x) => x.id === O.id);
  check('g. role: list() says role "chief" after the re-key, null for an ordinary one', lg && lg.role === 'chief' && lo && lo.role === null, keyed);
  const saved = await waitFor(() => { const l = savedList(); const g = l.find((x) => x.id === G.id), o = l.find((x) => x.id === O.id); return g && o ? { g, o } : null; }, 5000);
  check('g. role: sessions.json records role "chief" (and none for an ordinary one)', saved && saved.g.role === 'chief' && !('role' in saved.o), savedList());

  // g. one Chief at a time: a second create is refused with the running one's id; open as the chief starts without the role
  const startsO = argsOf(O).length;
  const rc = await cl.req('create', { cwd: O.cwd, account: 'B', role: 'chief', cols: 100, rows: 30 });
  await sleep(500);
  check('g. one chief: a second create as the chief is refused (chiefRunning: the chief\'s id) and starts nothing',
    rc && rc.ok === false && rc.chiefRunning === G.id && argsOf(O).length === startsO, { rc, starts: argsOf(O).length });
  const Z = session('z');
  const rz = await cl.req('open', { id: Z.id, cwd: Z.cwd, account: 'B', role: 'chief', cols: 100, rows: 30 });
  await waitFor(() => argsOf(Z).length, 10000);
  const lz = (await cl.req('list')).find((x) => x.id === Z.id);
  check('g. one chief: open as the chief while one runs starts it without the role (usual fv commands, nothing blocked, a log line)',
    rz && rz.ok && lz && lz.role === null && sameSet(allowedFv(argsOf(Z)[0]), FV_BASE) && sameSet(deniedFv(argsOf(Z)[0]), [])
    && hostLog().includes(`chief: open ${Z.id} starts without the role: ${G.id} is the Chief`), { rz, lz, args: argsOf(Z), log: hostLog().split('\n').slice(-5) });

  // g. a bot's role ('bot:<12 lowercase hex>'): the usual fv commands, nothing blocked; several bots at once, while the
  // Chief runs; a malformed one is no role
  const Y1 = session('y1'), Y2 = session('y2'), Y3 = session('y3');
  for (const s of [Y1, Y2, Y3]) fs.writeFileSync(path.join(s.cwd, 'want-id.txt'), s.id);
  const ry1 = await cl.req('create', { cwd: Y1.cwd, account: 'B', role: BOT1, cols: 100, rows: 30 });
  const ry2 = await cl.req('create', { cwd: Y2.cwd, account: 'B', role: BOT2, cols: 100, rows: 30 });
  const ry3 = await cl.req('create', { cwd: Y3.cwd, account: 'B', role: 'bot:A1A1A1A1A1A1', cols: 100, rows: 30 });
  check('g. bot: create echoes each bot\'s role while the Chief runs; a malformed one gets none', ry1 && ry1.ok && ry1.role === BOT1 && ry2 && ry2.ok && ry2.role === BOT2
    && ry3 && ry3.ok && !('role' in ry3), { ry1, ry2, ry3 });
  await waitFor(() => [Y1, Y2, Y3].every((s) => argsOf(s).length), 10000);
  check('g. bot: the usual fv commands, nothing blocked', [Y1, Y2, Y3].every((s) => sameSet(allowedFv(argsOf(s)[0]), FV_BASE) && sameSet(deniedFv(argsOf(s)[0]), [])),
    [Y1, Y2, Y3].map((s) => argsOf(s)));
  const keyedY = await waitFor(async () => { const l = await cl.req('list'); return [Y1, Y2, Y3].every((s) => l.some((x) => x.id === s.id && !x.pending)) ? l : null; }, 20000);
  const roleIn = (l, s) => { const x = (l || []).find((y) => y.id === s.id); return x ? x.role : undefined; };
  check('g. bot: list() keeps the role after the re-key', roleIn(keyedY, Y1) === BOT1 && roleIn(keyedY, Y2) === BOT2 && roleIn(keyedY, Y3) === null, keyedY);
  const savedY = await waitFor(() => { const l = savedList(); return l.some((x) => x.id === Y1.id) && l.some((x) => x.id === Y3.id) ? l : null; }, 5000);
  check('g. bot: sessions.json records the role (none for a malformed one)', savedY && roleIn(savedY, Y1) === BOT1 && savedY.some((x) => x.id === Y3.id && !('role' in x)), savedList());

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
  if (!cl) { check('connect to the new host', false); return; }

  // g. the restored chief keeps its role and its commands; an ordinary one stays ordinary
  const l2 = await waitFor(async () => { const l = await cl.req('list'); const g = l.find((x) => x.id === G.id); return g && g.alive ? l : null; }, 10000);
  const g2 = l2 && l2.find((x) => x.id === G.id), o2 = l2 && l2.find((x) => x.id === O.id);
  const gArgs = argsOf(G).slice(-1)[0] || [];
  check('g. restore: the resumed chief keeps role "chief" and its commands (an ordinary one stays ordinary)', g2 && g2.role === 'chief' && g2.restored && o2 && o2.role === null
    && sameSet(allowedFv(gArgs), [...FV_BASE, ...FV_CHIEF_EXTRA]) && gArgs.includes('--resume') && gArgs.includes(G.id) && sameSet(allowedFv(argsOf(O).slice(-1)[0]), FV_BASE), { l2, gArgs });
  const gSaved = await waitFor(() => savedList().find((x) => x.id === G.id && x.role === 'chief'), 5000);
  check('g. restore: the new host\'s sessions.json still records role "chief"', gSaved, savedList());
  const y1Args = argsOf(Y1).slice(-1)[0] || [];
  check('g. restore: a resumed bot keeps its role and the usual commands', roleIn(l2, Y1) === BOT1 && roleIn(l2, Y2) === BOT2 && roleIn(l2, Y3) === null
    && y1Args.includes('--resume') && y1Args.includes(Y1.id) && sameSet(allowedFv(y1Args), FV_BASE), { l2, y1Args });

  // ===== h. handoff: the chief checkpoints itself; the pickup that carries on is the chief too =====
  const [gPid, gKey] = (starts(G).slice(-1)[0] || '').split(' ');
  const hoFile = path.join(ROOT, 'handoffs', `2026-10-10_120000_${G.id.slice(0, 8)}.md`);
  fs.writeFileSync(hoFile, `---\nsession: ${G.id}\ncwd: ${G.cwd}\ncreated: ${new Date().toISOString()}\n---\n# Handoff\n`);
  const G2 = crypto.randomUUID();
  fs.writeFileSync(path.join(G.cwd, 'want-id.txt'), G2); // the pickup is a new conversation
  fs.mkdirSync(path.join(ROOT, 'handoffs', '.restart'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'handoffs', '.restart', `${gKey}.json`), JSON.stringify({ file: hoFile, cwd: G.cwd, session: G.id }));
  P.killTree(Number(gPid), { sync: true }); // claude is killed after it asked, as the Stop hook has it
  const picked = await waitFor(() => argsOf(G).length >= 3, 15000);
  const pArgs = argsOf(G).slice(-1)[0] || [];
  check('h. handoff: the pickup runs /pickup with the Chief\'s commands', picked && pArgs.includes(`/pickup ${hoFile}`) && sameSet(allowedFv(pArgs), [...FV_BASE, ...FV_CHIEF_EXTRA]), argsOf(G));
  const l3 = await waitFor(async () => { const l = await cl.req('list'); return l.some((x) => x.id === G2) ? l : null; }, 20000);
  const p3 = l3 && l3.find((x) => x.id === G2);
  check('h. handoff: the picked-up conversation is re-keyed to its id and keeps role "chief"', p3 && p3.role === 'chief' && p3.handoffFrom === G.id, l3 || await cl.req('list'));
  const s3 = await waitFor(() => savedList().find((x) => x.id === G2), 5000);
  check('h. handoff: sessions.json records the pickup\'s role', s3 && s3.role === 'chief', savedList());
  // a bot hands off the same way: its pickup is that bot (bots.js follows it by the role)
  const [y1Pid, y1Key] = (starts(Y1).slice(-1)[0] || '').split(' ');
  const yFile = path.join(ROOT, 'handoffs', `2026-10-10_120001_${Y1.id.slice(0, 8)}.md`);
  fs.writeFileSync(yFile, `---\nsession: ${Y1.id}\ncwd: ${Y1.cwd}\ncreated: ${new Date().toISOString()}\n---\n# Handoff\n`);
  const Y1b = crypto.randomUUID();
  fs.writeFileSync(path.join(Y1.cwd, 'want-id.txt'), Y1b);
  fs.writeFileSync(path.join(ROOT, 'handoffs', '.restart', `${y1Key}.json`), JSON.stringify({ file: yFile, cwd: Y1.cwd, session: Y1.id }));
  P.killTree(Number(y1Pid), { sync: true });
  const ly = await waitFor(async () => (await cl.req('list')).find((x) => x.id === Y1b) || null, 20000);
  const yp = argsOf(Y1).slice(-1)[0] || [];
  check('h. handoff: a bot\'s pickup runs /pickup with the usual commands, is re-keyed and keeps the bot\'s role', ly && ly.role === BOT1 && ly.handoffFrom === Y1.id
    && yp.includes(`/pickup ${yFile}`) && sameSet(allowedFv(yp), FV_BASE), { ly, yp });

  // ===== i. the chief's claude moves on: /clear (a new conversation) keeps the role, /resume of an older one drops it =====
  // its pid file (the fake's own) names another conversation, as Claude Code's does after /clear or /resume
  const fakePid = Number((starts(G).slice(-1)[0] || '').split(' ')[0]);
  const fakeFile = path.join(PIDS, `${fakePid}.json`);
  const moveTo = (id) => { const f = JSON.parse(fs.readFileSync(fakeFile, 'utf8')); const now = Date.now(); fs.writeFileSync(fakeFile, JSON.stringify({ ...f, sessionId: id, statusUpdatedAt: now, updatedAt: now })); };
  const listed = (id) => waitFor(async () => (await cl.req('list')).find((x) => x.id === id) || null, 10000);
  const N1 = crypto.randomUUID();
  moveTo(N1); // no transcript yet: a new conversation
  const ln = await listed(N1);
  check('i. move: after /clear (a new conversation) the chief keeps its role', ln && ln.role === 'chief', ln || await cl.req('list'));
  const OLD = crypto.randomUUID();
  const oldDir = path.join(PROJECTS, G.cwd.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(oldDir, { recursive: true });
  fs.writeFileSync(path.join(oldDir, `${OLD}.jsonl`), jl({ type: 'user', timestamp: new Date(Date.now() - 3600000).toISOString(), message: { role: 'user', content: 'old work' } }));
  moveTo(OLD);
  const lo2 = await listed(OLD);
  check('i. move: after /resume of a conversation begun an hour ago it is no longer the chief (a log line)',
    lo2 && lo2.role === null && hostLog().includes(`went on in an older conversation (${OLD})`), { lo2, log: hostLog().split('\n').slice(-5) });
  const oSaved = await waitFor(() => savedList().find((x) => x.id === OLD), 5000);
  check('i. move: sessions.json records the old conversation without the role', oSaved && !('role' in oSaved), savedList());
  // the same for a bot: a /resume of an older conversation drops its role (once the host tied the resumed one to its claude)
  await waitFor(async () => (await cl.req('list')).find((x) => x.id === Y2.id && x.claudePid), 15000);
  const y2File = path.join(PIDS, `${Number((starts(Y2).slice(-1)[0] || '').split(' ')[0])}.json`);
  const OLD2 = crypto.randomUUID();
  const y2Dir = path.join(PROJECTS, Y2.cwd.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(y2Dir, { recursive: true });
  fs.writeFileSync(path.join(y2Dir, `${OLD2}.jsonl`), jl({ type: 'user', timestamp: new Date(Date.now() - 3600000).toISOString(), message: { role: 'user', content: 'old work' } }));
  { const f = JSON.parse(fs.readFileSync(y2File, 'utf8')); const now = Date.now(); fs.writeFileSync(y2File, JSON.stringify({ ...f, sessionId: OLD2, statusUpdatedAt: now, updatedAt: now })); }
  const ly2 = await listed(OLD2);
  check('i. move: a bot that resumes an older conversation loses its role too (a log line)',
    ly2 && ly2.role === null && hostLog().includes(`${BOT2}: ${Y2.id} went on in an older conversation (${OLD2})`), { ly2, log: hostLog().split('\n').slice(-5) });
  // with no Chief left, a new one may start
  const W = session('w');
  fs.writeFileSync(path.join(W.cwd, 'want-id.txt'), W.id);
  const rw = await cl.req('create', { cwd: W.cwd, account: 'B', role: 'chief', cols: 100, rows: 30 });
  check('i. move: once the old one lost the role, a new Chief starts', rw && rw.ok && rw.role === 'chief', rw);
  await cl.req('killAll').catch(() => {});
  cl.close();
}

main().catch((e) => check('the test ran to its end', false, e && e.stack ? e.stack : String(e))).finally(() => {
  cleanup();
  const failed = results.filter((r) => !r.pass).length;
  const keep = failed || process.env.FV_HOST_TEST_KEEP;
  process.stdout.write(`${results.length - failed} passed, ${failed} failed${keep ? ` (files kept in ${ROOT})` : ''}\n`);
  if (!keep) { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {} }
  process.exit(failed ? 1 : 0);
});
