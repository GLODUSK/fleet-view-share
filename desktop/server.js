// The Fleet View server (fleet-view.js --web) belongs to the desktop app: started hidden when the app starts and
// nothing serves the port yet, restarted after an update (exit 75) or a crash, and stopped when the app quits.
// There is no console window to close by accident. A server some other way started (a test, `--tui`'s neighbour,
// an older launcher) is used as it is and left running. One stuck in its exit is ended after 5 s (#574).
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const P = require('../platform');

const EXIT_UPDATE = 75;
const SCRIPT = path.join(__dirname, '..', 'fleet-view.js');
// The server writes "exiting <code>" on this pipe as the last JS of its exit (fleet-view.js exitNotice). A server
// still running EXIT_WAIT_MS after that is stuck in its exit (something native holding teardown, #574): it is
// ended, and its exit code is acted on as if it had gone by itself.
const NOTICE_FD = 3;
const EXIT_WAIT_MS = 5000;

// the real server: Electron as node running fleet-view.js. macOS and Linux: in a process group of its own
// (P.detachGroup), so stop() ends it with its children
function spawnServer(port, env) {
  return spawn(process.execPath, [SCRIPT, '--web', '--no-open', '--port', String(port)], {
    cwd: path.dirname(SCRIPT), env: { ...env, FV_EXIT_NOTICE_FD: String(NOTICE_FD) },
    stdio: ['ignore', 'ignore', 'ignore', 'pipe'], windowsHide: true, ...P.detachGroup,
  });
}

// a process stuck in its exit runs no JS, so it can't act on a signal: taskkill /T /F on Windows (a plain kill may
// not end it), SIGKILL to its group and to it on macOS and Linux. done() once it is sent.
function killHard(pid, done) {
  if (P.isWin) return P.killTree(pid, { done });
  try { process.kill(-pid, 'SIGKILL'); } catch {}
  try { process.kill(pid, 'SIGKILL'); } catch {}
  done();
}

function probe(port, timeout = 1500) {
  return new Promise((done) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/state', timeout, headers: { Host: `127.0.0.1:${port}` } }, (res) => {
      res.resume();
      res.on('end', () => done(res.statusCode === 200));
      res.on('error', () => done(false));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => done(false));
  });
}

// spawnChild, kill, killTree, setTimer, clearTimer, now and exists are the real ones but in desktop/server-test.js
function create({ port, log = () => {}, spawnChild = spawnServer, kill = killHard, killTree = (pid) => P.killTree(pid, { sync: true }),
  setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now, exists = () => fs.existsSync(SCRIPT), exitWait = EXIT_WAIT_MS }) {
  let child = null, owned = false, stopping = false, crashes = [];

  function start(reason) {
    if (stopping || !exists()) return;
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', FLEET_VIEW_LOOP: '1', FV_SERVER_OWNER: 'electron' };
    if (reason) env.FV_RESTART_REASON = reason; else delete env.FV_RESTART_REASON;
    for (const k of ['FLEET_VIEW_CHILD', 'FV_NO_OPEN', 'FV_TEST_HIDDEN', 'FV_TERM_SELFTEST', 'FV_TERM_CMD']) delete env[k];
    const c = child = spawnChild(port, env);
    owned = true;
    log(`server: started pid ${c.pid}${reason ? ` (${reason})` : ''}`);
    // gone: acted on once, from its own 'exit' or from the watchdog that ended it (the 'exit' after that kill
    // brings taskkill's or the signal's code, not the one the server meant, and starts nothing more)
    const notice = c.stdio && c.stdio[NOTICE_FD];
    let gone = false, said = null, ended = false, timer = null, partial = '';
    const exited = (code) => {
      if (gone) return;
      gone = true;
      if (timer) { clearTimer(timer); timer = null; }
      if (child === c) child = null;
      try { if (notice) notice.destroy(); } catch {}
      if (stopping) return;
      if (code === EXIT_UPDATE) return start('an update (exit 75)');
      if (code === 0) { log('server: stopped (exit 0)'); return; } // another Fleet View took the port, or a clean stop
      const t = now();
      crashes = crashes.filter((x) => t - x < 120e3).concat(t);
      if (crashes.length >= 5) { log('server: gave up after 5 crashes within 2 minutes'); return; }
      log(`server: exited with ${code}; restarting in 3 s`);
      setTimer(() => start(`a crash (exit ${code})`), 3000);
    };
    c.on('error', (e) => log(`server: could not start: ${e.message}`));
    c.on('exit', (code) => exited(ended ? said : code));
    if (notice) {
      notice.on('error', () => {});
      notice.on('data', (b) => {
        const lines = (partial + b).split('\n');
        partial = lines.pop().slice(-200);
        for (const l of lines) {
          const m = /^exiting (-?\d+)\s*$/.exec(l);
          if (!m || gone || said !== null) continue;
          const code = said = Number(m[1]);
          timer = setTimer(() => {
            timer = null;
            if (gone || stopping) return;
            ended = true;
            log(`server: still running ${exitWait / 1000} s after its exit (${code}): ended pid ${c.pid}`);
            kill(c.pid, () => exited(code));
          }, exitWait);
        }
      });
    }
  }

  // make sure something serves the port; resolves true once /state answers (or false after `wait` ms)
  async function ensure(wait = 12000) {
    if (await probe(port)) { log('server: already running (not started by this app; left as it is)'); return true; }
    start(null);
    const until = Date.now() + wait;
    while (Date.now() < until) {
      if (await probe(port, 800)) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  }

  // the app is quitting: stop the server it started (with its gh / PowerShell children; taskkill /T on Windows,
  // its process group on macOS and Linux)
  function stop() {
    stopping = true;
    if (!child || !owned) return;
    const pid = child.pid;
    child = null;
    killTree(pid);
    log(`server: stopped pid ${pid} with the app`);
  }

  return { ensure, stop, owns: () => owned };
}

module.exports = { create, probe, spawnServer, killHard, NOTICE_FD, EXIT_WAIT_MS };
