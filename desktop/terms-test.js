// Fleet View desktop: a test of the window's side of the session host when a host on the pipe does not let it in
// (terms.js connect, judgeStuck), run with the system node:   node desktop/terms-test.js
// It never starts a real host and never ends a process: each case runs createHost() on a test pipe of its own
// (\\.\pipe\fleet-view-host-tt-<random>, on macOS and Linux a socket file in the temp folder) with a fake host on it
// (a pipe server that never answers the hello, or one that lets the window in) and fakes for the process table, the
// kill and the start of a host, and shortened times. It checks: a busy host (claudes under it) is never ended, is
// waited on, reported after the busy time, and connected to once it answers; a pid in host.json that runs something
// else now (or nothing) is never ended; a stuck host.js with no session under it is ended and replaced; a host the
// window started that finds another serving the pipe (exit 0) is not a failure: the window connects to that one.
// Exit code 0 when every case passes.
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const P = require(path.join(__dirname, '..', 'platform.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-terms-test-'));
const TIMES = { hello: 150, stuck: 300, busy: 1500, check: 200 };

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass });
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'} ${name}${!pass && detail !== undefined ? ` :: ${JSON.stringify(detail).slice(0, 600)}` : ''}\n`);
}

// a case: its own test pipe and data folder (set before createHost reads them), and the fakes
function setup(name) {
  const tag = `fleet-view-host-tt-${crypto.randomBytes(4).toString('hex')}`;
  const pipe = P.isWin ? `\\\\.\\pipe\\${tag}` : path.join(os.tmpdir(), `${tag}.sock`);
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  process.env.FV_HOST_PIPE = pipe;
  process.env.FV_HOST_DIR = dir;
  const H = require(path.join(__dirname, 'host.js'));
  if (H.pipeName() !== pipe || H.dataDir() !== dir) throw new Error(`not on the test pipe (${H.pipeName()}): stopping`);
  const c = { pipe, dir, table: [], kills: [], spawns: 0, onSpawn: null, servers: [] };
  c.hostJson = (pid, token) => fs.writeFileSync(path.join(dir, 'host.json'), JSON.stringify({ pid, pipe, token }));
  c.log = () => { try { return fs.readFileSync(path.join(dir, 'window.log'), 'utf8'); } catch { return ''; } };
  // a fake host on the pipe: answers the hello with ok when c.answer is set, else never
  c.serve = (token) => new Promise((resolve) => {
    const socks = new Set();
    const srv = net.createServer((s) => {
      socks.add(s);
      s.on('close', () => socks.delete(s));
      s.on('error', () => {});
      s.setEncoding('utf8');
      s.on('data', (d) => { if (c.answer && d.includes('"hello"') && d.includes(token)) s.write(`${JSON.stringify({ t: 'hello', ok: true, pid: 1, proto: 1 })}\n`); });
    });
    srv.stop = () => new Promise((r) => { for (const s of socks) s.destroy(); srv.close(() => r()); });
    c.servers.push(srv);
    srv.listen(pipe, () => resolve(srv));
  });
  c.terms = require(path.join(__dirname, 'terms.js')).createHost({
    times: TIMES,
    sys: {
      processTable: (cb) => setImmediate(() => cb(c.table)),
      kill: (pid) => { c.kills.push(pid); if (c.onKill) c.onKill(pid); },
      spawnHost: () => { c.spawns++; const ch = new EventEmitter(); ch.pid = 70000 + c.spawns; ch.unref = () => {}; if (c.onSpawn) setImmediate(() => c.onSpawn(ch)); return ch; },
    },
  });
  c.done = async () => { c.terms.close(); for (const s of c.servers) await s.stop().catch(() => {}); };
  return c;
}
const hostCmd = P.isWin ? '"C:\\fv\\desktop\\node_modules\\electron\\dist\\electron.exe" C:\\fv\\desktop\\host.js' : '/fv/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron /fv/desktop/host.js';

async function busyHost() {
  // a host (pid 4242) with two sessions under it (cmd /c claude, and the claude under that; a bare claude) that
  // does not answer: never ended, waited on; reported after the busy time; connected to once it answers
  const c = setup('busy');
  c.table = [
    { pid: 4242, ppid: 1, command: hostCmd },
    { pid: 5000, ppid: 4242, command: 'C:\\Windows\\system32\\cmd.exe /d /s /c "claude --resume 1111"' },
    { pid: 5001, ppid: 5000, command: 'C:\\Users\\u\\.local\\bin\\claude.exe --resume 1111' },
    { pid: 5002, ppid: 4242, command: 'claude --resume 2222' },
    { pid: 5003, ppid: 4242, command: 'C:\\Windows\\System32\\conhost.exe 0x4' },
  ];
  c.hostJson(4242, 'tok-busy');
  await c.serve('tok-busy');
  const t0 = Date.now();
  const ok1 = await c.terms.connect(1000);
  check('busy host: connect gives up within its time, nothing ended or started', ok1 === false && Date.now() - t0 < 2500 && !c.kills.length && !c.spawns, { ok1, kills: c.kills, spawns: c.spawns });
  check('busy host: the window log says it is busy with 2 sessions and is waited on', /pid 4242\) does not let this window in \(timeout\) but runs 2 session\(s\): it is busy; waiting for it, never ending it/.test(c.log()), c.log());
  // past the busy time (across connects, as lost() reconnects): reported, still never ended
  await c.terms.connect(1500);
  check('busy host: past the busy time it is reported and left running, never ended', /has not answered for \d+ s; it is left running with its 2 session\(s\)/.test(c.log()) && !c.kills.length && !c.spawns, { log: c.log(), kills: c.kills });
  check('busy host: no "replacing it"', !c.log().includes('replacing it'), c.log());
  // it answers again: the window gets in
  c.answer = true;
  const ok2 = await c.terms.connect(2000);
  check('busy host: once it answers the window connects to it', ok2 === true && c.terms.isConnected() && !c.kills.length, { ok2 });
  await c.done();
}

async function notOurs() {
  // host.json names pid 4343, which now runs something else (pid reuse); then a pid no process has: never ended
  const c = setup('reused');
  c.table = [{ pid: 4343, ppid: 1, command: 'C:\\Windows\\notepad.exe' }];
  c.hostJson(4343, 'tok-r');
  await c.serve('tok-r');
  const ok = await c.terms.connect(1200);
  check('pid reuse: a pid in host.json that runs something else is never ended', ok === false && !c.kills.length && !c.spawns, { kills: c.kills, spawns: c.spawns });
  check('pid reuse: the window log says so and leaves it', c.log().includes('host.json names pid 4343, but that runs something else now') && c.log().includes('its pid is unknown; it is left running'), c.log());
  c.table = [{ pid: 1, ppid: 0, command: 'init' }];
  await c.terms.connect(1200);
  check('pid reuse: a pid in host.json that no process has is never ended', !c.kills.length && c.log().includes('host.json names pid 4343, but no such process runs'), c.log());
  // a process table that can't be read: nothing is ended blind
  c.table = null;
  await c.terms.connect(1200);
  check('process table unreadable: nothing is ended', !c.kills.length && c.log().includes('the process list could not be read; it is left running'), c.log());
  await c.done();
}

async function stuckHost() {
  // a host.js (pid 4444) with no session under it (only its console host) that does not answer: ended and replaced;
  // the new host (fake) serves the pipe and lets the window in
  const c = setup('stuck');
  c.table = [{ pid: 4444, ppid: 1, command: hostCmd }, { pid: 6000, ppid: 4444, command: 'C:\\Windows\\System32\\conhost.exe 0x4' }];
  c.hostJson(4444, 'tok-old');
  const old = await c.serve('tok-old');
  c.onKill = () => { old.stop(); };
  c.onSpawn = async () => { await sleep(100); c.answer = true; c.hostJson(7001, 'tok-new'); await c.serve('tok-new'); };
  const ok = await c.terms.connect(6000);
  check('stuck host with no session: it is ended (its pid) and a new host started', c.kills.length === 1 && c.kills[0] === 4444 && c.spawns === 1, { kills: c.kills, spawns: c.spawns });
  check('stuck host with no session: the window connects to the new one', ok === true && c.terms.isConnected(), ok);
  check('stuck host with no session: the window log says why', c.log().includes('does not let this window in (timeout) and runs no session; replacing it') && c.log().includes('ended a stuck session host (pid 4444)'), c.log());
  await c.done();
}

async function lostRace() {
  // nothing on the pipe: the window starts a host, which finds another host serving the pipe and exits 0; that one
  // comes up a moment later. The window connects to it, ending nothing
  const c = setup('race');
  let first = true;
  c.onSpawn = async (ch) => {
    if (!first) return;
    first = false;
    ch.emit('exit', 0);
    await sleep(600);
    c.answer = true;
    c.hostJson(7100, 'tok-other');
    await c.serve('tok-other');
  };
  const ok = await c.terms.connect(5000);
  check('lost race: the window connects to the host that serves the pipe', ok === true && c.terms.isConnected(), { ok, log: c.log() });
  check('lost race: nothing ended; the window log says so', !c.kills.length && c.log().includes('found another one serving the pipe; connecting to that one') && !c.log().includes('could not reach'), c.log());
  await c.done();
}

async function main() {
  await busyHost();
  await notOurs();
  await stuckHost();
  await lostRace();
}

main().catch((e) => check('the test ran to its end', false, e && e.stack ? e.stack : String(e))).finally(() => {
  const failed = results.filter((r) => !r.pass).length;
  process.stdout.write(`${results.length - failed} passed, ${failed} failed${failed ? ` (files kept in ${ROOT})` : ''}\n`);
  if (!failed) { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {} }
  process.exit(failed ? 1 : 0);
});
