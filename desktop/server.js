// The Fleet View server (fleet-view.js --web) belongs to the desktop app: started hidden when the app starts and
// nothing serves the port yet, restarted after an update (exit 75) or a crash, and stopped when the app quits.
// There is no console window to close by accident. A server some other way started (a test, `--tui`'s neighbour,
// an older launcher) is used as it is and left running.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const EXIT_UPDATE = 75;
const SCRIPT = path.join(__dirname, '..', 'fleet-view.js');

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

function create({ port, log = () => {} }) {
  let child = null, owned = false, stopping = false, crashes = [];

  function start(reason) {
    if (stopping || !fs.existsSync(SCRIPT)) return;
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', FLEET_VIEW_LOOP: '1', FV_SERVER_OWNER: 'electron' };
    if (reason) env.FV_RESTART_REASON = reason; else delete env.FV_RESTART_REASON;
    for (const k of ['FLEET_VIEW_CHILD', 'FV_NO_OPEN', 'FV_TEST_HIDDEN', 'FV_TERM_SELFTEST', 'FV_TERM_CMD']) delete env[k];
    child = spawn(process.execPath, [SCRIPT, '--web', '--no-open', '--port', String(port)], {
      cwd: path.dirname(SCRIPT), env, stdio: 'ignore', windowsHide: true,
    });
    owned = true;
    log(`server: started pid ${child.pid}${reason ? ` (${reason})` : ''}`);
    child.on('error', (e) => log(`server: could not start: ${e.message}`));
    child.on('exit', (code) => {
      child = null;
      if (stopping) return;
      if (code === EXIT_UPDATE) return start('an update (exit 75)');
      if (code === 0) { log('server: stopped (exit 0)'); return; } // another Fleet View took the port, or a clean stop
      const now = Date.now();
      crashes = crashes.filter((t) => now - t < 120e3).concat(now);
      if (crashes.length >= 5) { log('server: gave up after 5 crashes within 2 minutes'); return; }
      log(`server: exited with ${code}; restarting in 3 s`);
      setTimeout(() => start(`a crash (exit ${code})`), 3000);
    });
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

  // the app is quitting: stop the server it started (with its gh / PowerShell children)
  function stop() {
    stopping = true;
    if (!child || !owned) return;
    const pid = child.pid;
    child = null;
    try {
      if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
      else process.kill(pid);
    } catch {}
    log(`server: stopped pid ${pid} with the app`);
  }

  return { ensure, stop, owns: () => owned };
}

module.exports = { create, probe };
