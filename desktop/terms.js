// Fleet View desktop: the window's side of the live Claude sessions (the Session tab of the detail panel).
// The sessions themselves live in the session host (host.js), a separate process, so closing the window never
// ends them; this is a thin client of it, with the API main.js uses (preload.js and the page see no change).
//
// connect() finds the host through its pipe (\\.\pipe\fleet-view-host-<username>, or FV_HOST_PIPE in tests) and
// the token in host.json, and starts it when it is not running: electron.exe host.js with ELECTRON_RUN_AS_NODE=1,
// detached and without a window, so it outlives the app. Its events come back through send():
//   send('fv:term-data', id, chunk), send('fv:term-exit', id, code), send('fv:term-rekey', oldKey, id)
// and onChange() runs whenever the hosted set or a status changes (the tray counts them). If the host goes
// away while the window is open, every session it had is reported ended and the client connects again,
// starting a new host, which resumes them from its restore list.
//
// The API: open(o), create(o), list() -> Promises; write, resize, kill fire and forget; snapshot(id, cb) calls
// cb(text) in order with the output events (so output before it is in it, output after it is new);
// aliveCount() / busyCount() from the last list the host sent; endAll(ms), killAll() (tests);
// setUi(ui) and quitEverything(ui) (the tray's "Quit everything": the host saves the restore list, ends every
// session and exits); close() on quit (the host keeps running).
'use strict';
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const H = require('./host');

const REQ_TIMEOUT = 15000;
const CONNECT_MS = 25000; // a first start on a slow PC (an antivirus scanning electron.exe) can take a while
const STUCK_MS = 4000; // a host on the pipe that won't let this window in this long is stuck: it is replaced

function createHost(opts = {}) {
  const send = opts.send || (() => {});
  const onChange = opts.onChange || (() => {});
  const log = opts.log || (() => {});
  const PIPE = H.pipeName();
  let sock = null, ready = false, buf = '', seq = 0, closed = false, quitting = false;
  let info = null; // the host's hello: { pid, version, onDisk, startedAt, ui }
  let cache = []; // the host's last list()
  const waits = new Map(); // n -> { cb, timer }
  let connecting = null, reconnectTimer = null;
  let why = ''; // why the last connect() failed, for the message the page shows
  // the window's own log (%LOCALAPPDATA%\fleet-view\window.log): what happens while there is no host to log to
  const wlog = (m) => {
    log(m);
    try {
      const f = path.join(H.dataDir(), 'window.log');
      try { if (fs.statSync(f).size > 1 << 20) fs.renameSync(f, `${f}.1`); } catch {}
      fs.appendFileSync(f, `${new Date().toISOString()} [window ${process.pid}] ${m}\n`);
    } catch {}
  };
  const lastLine = (f) => {
    let lines = [];
    try { lines = fs.readFileSync(f, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^Node\.js v/.test(l)); } catch {}
    return (lines.find((l) => /^\w*Error\b/.test(l)) || lines.pop() || '').slice(0, 300);
  };
  let exited = false; // the host this window started has exited before it was reached

  // ---------- the connection ----------
  function startHost() {
    try {
      const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
      const dir = H.dataDir();
      try { fs.mkdirSync(dir, { recursive: true }); } catch {}
      // what it prints before its own log is open (a file that does not load) lands in host-start.log
      let out = 'ignore';
      try { out = fs.openSync(path.join(dir, 'host-start.log'), 'w'); } catch {}
      const child = spawn(process.execPath, [H.HOST_JS], { detached: true, windowsHide: true, stdio: ['ignore', out, out], env, cwd: dir });
      if (typeof out === 'number') try { fs.closeSync(out); } catch {}
      child.on('error', (e) => { why = `it could not be started: ${e.message}`; wlog(`could not start the session host: ${e.message}`); });
      exited = false;
      child.on('exit', (code) => {
        if (ready) return;
        exited = true;
        const said = lastLine(path.join(dir, 'host-start.log')) || lastLine(H.logFile());
        why = `it stopped right after starting (exit ${code})${said ? `: ${said}` : ''}`;
        wlog(`the session host (pid ${child.pid}) exited with ${code} before this window reached it${said ? `: ${said}` : ''}`);
      });
      child.unref();
      wlog(`started the session host (pid ${child.pid})`);
      return true;
    } catch (e) { why = `it could not be started: ${e.message}`; wlog(`could not start the session host: ${e.message}`); return false; }
  }

  // a host holds the pipe but won't let this window in (host.json gone or another host's, or it hangs): end
  // it, so a new one can start; the new one resumes its sessions from the restore list
  function endStuckHost() {
    const hf = H.readJson(H.hostFile());
    let pid = hf && Number.isInteger(hf.pid) ? hf.pid : 0;
    if (!pid && !process.env.FV_HOST_PIPE) {
      // no host.json: look for electron.exe / node.exe running this host.js
      try {
        const ps = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          "Get-CimInstance Win32_Process -Filter \"Name='electron.exe' or Name='node.exe'\" | Where-Object { $_.CommandLine -like '*desktop*host.js*' -and $_.CommandLine -notlike '*--selfcheck*' -and $_.CommandLine -notlike '*restart-host*' } | ForEach-Object { $_.ProcessId }"],
        { encoding: 'utf8', windowsHide: true, timeout: 8000 });
        const pids = String(ps.stdout || '').split(/\s+/).map(Number).filter((n) => n > 0 && n !== process.pid);
        if (pids.length === 1) pid = pids[0];
      } catch {}
    }
    if (!pid || pid === process.pid) { wlog('a session host holds the pipe but will not answer, and its pid is unknown'); return false; }
    try { process.kill(pid); wlog(`ended a stuck session host (pid ${pid}) that held the pipe but would not let this window in`); return true; } catch (e) {
      wlog(`could not end the stuck session host (pid ${pid}): ${e.message}`); return false;
    }
  }

  // one attempt: connect, say hello with host.json's token; resolves true once the host answered
  function attempt() {
    return new Promise((resolve) => {
      const hf = H.readJson(H.hostFile());
      if (!hf || hf.pipe !== PIPE || typeof hf.token !== 'string') return resolve('nofile');
      const s = net.connect(PIPE);
      let done = false, b = '';
      const finish = (v) => { if (done) return; done = true; clearTimeout(timer); if (v !== true) s.destroy(); resolve(v); };
      const timer = setTimeout(() => finish('timeout'), 3000);
      s.setEncoding('utf8');
      s.on('error', (e) => finish(e && e.code === 'ENOENT' ? 'nopipe' : 'error'));
      s.on('close', () => finish('closed'));
      s.on('connect', () => s.write(`${JSON.stringify({ t: 'hello', token: hf.token, pid: process.pid })}\n`));
      const first = (chunk) => {
        b += chunk;
        const i = b.indexOf('\n');
        if (i < 0) return;
        let msg = null;
        try { msg = JSON.parse(b.slice(0, i)); } catch {}
        if (!msg || msg.t !== 'hello' || !msg.ok) return finish('refused');
        s.removeListener('data', first);
        s.removeAllListeners('close');
        s.removeAllListeners('error');
        info = msg;
        adopt(s, b.slice(i + 1));
        finish(true);
      };
      s.on('data', first);
    });
  }

  // connect, starting the host when nobody answers on its pipe; resolves true or false (gave up after ms)
  function connect(ms = 10000) {
    if (ready) return Promise.resolve(true);
    if (connecting) return connecting;
    connecting = (async () => {
      const end = Date.now() + ms;
      let started = false, replaced = false, stuckSince = 0;
      why = '';
      while (!closed && Date.now() < end) {
        const r = await attempt();
        if (r === true) { why = ''; return true; }
        let listening = r !== 'nopipe';
        if (r === 'nofile') listening = await new Promise((res) => { const p = net.connect(PIPE); p.on('connect', () => { p.destroy(); res(true); }); p.on('error', () => res(false)); });
        // nothing listens on the pipe: start a host (once per connect; it may take a moment to come up)
        if (!listening) { stuckSince = 0; if (!started) started = startHost(); else if (exited) break; }
        else if (!replaced) {
          // something listens but won't let this window in: give a host that is just starting a moment, then end
          // it and start a new one (once per connect)
          if (!stuckSince) stuckSince = Date.now();
          else if (Date.now() - stuckSince >= STUCK_MS) {
            replaced = true;
            wlog(`the session host on the pipe does not let this window in (${r}); replacing it`);
            if (endStuckHost()) { await new Promise((res) => setTimeout(res, 800)); started = startHost(); stuckSince = 0; }
            else why = 'one is running but will not let this window in; choose "Quit everything" from the tray icon and open Fleet View again';
          }
        }
        await new Promise((res) => setTimeout(res, 200));
      }
      if (!why) why = started ? 'it was started but did not answer in time' : 'it could not be reached';
      wlog(`could not reach the session host: ${why}`);
      return false;
    })().finally(() => { connecting = null; });
    return connecting;
  }

  function adopt(s, rest) {
    sock = s; ready = true; buf = '';
    if (info && info.onDisk && info.version && info.onDisk !== info.version) {
      log(`a newer host.js is on disk; the running host (pid ${info.pid}) keeps the old one until it next starts`);
    }
    s.on('data', (chunk) => { buf += chunk; drain(); });
    s.on('close', lost);
    s.on('error', () => {});
    if (rest) { buf = rest; drain(); }
  }

  function drain() {
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.t === 'ev') {
        if (m.e === 'data') send('fv:term-data', m.id, m.d);
        else if (m.e === 'exit') send('fv:term-exit', m.id, m.code);
        else if (m.e === 'rekey') send('fv:term-rekey', m.from, m.id);
        else if (m.e === 'sessions' && Array.isArray(m.list)) { cache = m.list; onChange(); }
      } else if (m.t === 'res') {
        const w = waits.get(m.n);
        if (!w) continue;
        waits.delete(m.n);
        clearTimeout(w.timer);
        try { w.cb(m.err ? new Error(m.err) : null, m.v); } catch {}
      }
    }
  }

  // the host went away (it exited, or was ended): its sessions ended with it
  function lost() {
    if (!ready) return;
    ready = false; sock = null; buf = '';
    for (const [n, w] of waits) { waits.delete(n); clearTimeout(w.timer); try { w.cb(new Error('the session host went away')); } catch {} }
    const had = cache.filter((x) => x.alive);
    cache = [];
    for (const x of had) send('fv:term-exit', x.id, null);
    onChange();
    if (closed || quitting) return;
    log('lost the session host; connecting again');
    const again = () => { reconnectTimer = null; if (closed || quitting || ready) return; connect(10000).then((ok) => { if (!ok && !closed && !quitting) reconnectTimer = setTimeout(again, 2000); }); };
    reconnectTimer = setTimeout(again, 500);
  }

  // a request; cb(err, value) runs in order with the events that came before the reply
  function call(op, args, cb, timeoutMs = REQ_TIMEOUT) {
    if (!ready || !sock) { if (cb) cb(new Error('the session host is not connected')); return; }
    const msg = { t: 'req', op, a: args };
    if (cb) {
      const n = ++seq;
      msg.n = n;
      waits.set(n, { cb, timer: setTimeout(() => { if (waits.delete(n)) cb(new Error('the session host did not answer')); }, timeoutMs) });
    }
    try { sock.write(`${JSON.stringify(msg)}\n`); } catch (e) { if (cb && msg.n && waits.delete(msg.n)) cb(e); }
  }
  const ask = (op, args, timeoutMs) => new Promise((resolve, reject) => call(op, args, (err, v) => (err ? reject(err) : resolve(v)), timeoutMs));
  const notRunning = () => `the session host is not running: ${why || 'it could not be reached'}. Details in %LOCALAPPDATA%\\fleet-view\\window.log`;
  // open and create answer { ok: false, message } instead of failing when the host is not there
  const askOk = async (op, o) => {
    if (!ready && !(await connect(CONNECT_MS))) return { ok: false, message: notRunning() };
    try { return await ask(op, [o]); } catch (e) { return { ok: false, message: e.message }; }
  };

  return {
    connect,
    open: (o) => {
      if (!o || typeof o.id !== 'string' || !H.ID_RE.test(o.id)) return Promise.reject(new Error('bad conversation id'));
      return askOk('open', o);
    },
    // "Send to Claude A/B/C..." (host.js sendTo): ends it here, then resumes it under o.account with /handoff
    sendTo: async (o) => {
      if (!o || typeof o.id !== 'string' || !H.ID_RE.test(o.id)) throw new Error('bad conversation id');
      if (!ready && !(await connect(CONNECT_MS))) return { ok: false, message: notRunning() };
      try { return await ask('sendTo', [o], 20000); } catch (e) { return { ok: false, message: e.message }; }
    },
    create: (o) => askOk('create', o),
    write: (id, data) => call('write', [id, data]),
    resize: (id, cols, rows) => call('resize', [id, cols, rows]),
    kill: (id) => call('kill', [id]),
    list: () => (ready ? ask('list', []) : Promise.resolve([])),
    snapshot: (id, cb) => call('snapshot', [id], (err, v) => cb(err || typeof v !== 'string' ? '' : v)),
    endAll: (ms) => ask('endAll', [ms], 40000),
    killAll: () => ask('killAll', [], 20000),
    setUi: (ui) => call('setUi', [ui]),
    // the tray's "Quit everything": resolves once the host has saved the list, ended every session and is exiting
    quitEverything: async (ui) => {
      if (!ready) return { ok: true, saved: 0, message: 'no host' };
      quitting = true;
      try { return await ask('quitAll', [{ ui }], 30000); } catch (e) { return { ok: false, message: e.message }; }
    },
    hostLog: (text) => call('log', [String(text)]),
    aliveCount: () => cache.filter((x) => x.alive).length,
    busyCount: () => cache.filter((x) => x.alive && x.status === 'busy').length,
    cached: () => cache.slice(),
    isConnected: () => ready,
    info: () => info,
    close: () => { closed = true; clearTimeout(reconnectTimer); if (sock) { try { sock.end(); } catch {} } },
    ID_RE: H.ID_RE, KEY_RE: H.KEY_RE, NEW_RE: H.NEW_RE,
  };
}

module.exports = { createHost, normDir: H.normDir, pipeName: H.pipeName, dataDir: H.dataDir };
