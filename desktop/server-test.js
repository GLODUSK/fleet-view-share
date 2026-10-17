#!/usr/bin/env node
// Tests desktop/server.js's supervisor, the watchdog for a server stuck in its exit (GLODUSK/fleet-view#574) above
// all: first against fake children and a fake clock (every exit path, the double-start guard, the app quitting),
// then once with real processes: a child that writes "exiting 75" on its notice pipe and hangs is ended and started
// again once, as an update. Prints PASS/FAIL per check and exits 1 on any failure. Takes about 6 s.
//   node desktop/server-test.js
'use strict';
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { spawn } = require('child_process');
const S = require('./server.js');

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`PASS: ${name}`);
  else { failures++; console.log(`FAIL: ${name}${detail ? ` (${detail})` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// ---------- fake children, fake clock ----------
function rig() {
  let t = 0, nextPid = 100;
  const timers = [], logs = [], kills = [], children = [], reasons = [];
  const r = {
    logs, kills, children, reasons, trees: [],
    advance(ms) {
      t += ms;
      for (;;) {
        const due = timers.filter((x) => !x.off && x.at <= t).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        due.off = true;
        due.fn();
      }
    },
    pending: () => timers.filter((x) => !x.off).length,
  };
  r.sup = S.create({
    port: 47991, log: (m) => logs.push(m), exists: () => true, now: () => t, exitWait: 5000,
    setTimer: (fn, ms) => { const x = { fn, at: t + ms, off: false }; timers.push(x); return x; },
    clearTimer: (x) => { if (x) x.off = true; },
    spawnChild: (port, env) => {
      const c = new EventEmitter();
      c.pid = nextPid++;
      c.stdio = [null, null, null, new PassThrough()];
      children.push(c);
      reasons.push(env.FV_RESTART_REASON || null);
      return c;
    },
    kill: (pid, done) => { kills.push(pid); r.killDone = done; },
    killTree: (pid) => r.trees.push(pid),
  });
  return r;
}
const notice = (c, text) => new Promise((done) => { c.stdio[3].write(text); setImmediate(done); });

(async () => {
  {
    const r = rig();
    await r.sup.ensure(0);
    check('starts one server', r.children.length === 1 && r.reasons[0] === null, JSON.stringify(r.reasons));
    const c = r.children[0];
    await notice(c, 'exiting 75\n');
    r.advance(1000);
    c.emit('exit', 75);
    check('notice then a normal exit 75: started again at once as an update', r.children.length === 2 && r.reasons[1] === 'an update (exit 75)', JSON.stringify(r.reasons));
    r.advance(10000);
    check('... the watchdog was cleared: nothing killed, no third start', r.kills.length === 0 && r.children.length === 2, JSON.stringify({ kills: r.kills, n: r.children.length }));
  }
  {
    const r = rig();
    await r.sup.ensure(0);
    const c = r.children[0];
    await notice(c, 'exit');
    await notice(c, 'ing 75\n'); // split across two chunks
    r.advance(4999);
    check('stuck in its exit: nothing done before 5 s', r.kills.length === 0 && r.children.length === 1);
    r.advance(1);
    check('stuck in its exit: ended after 5 s and logged', r.kills.length === 1 && r.kills[0] === c.pid
      && r.logs.includes(`server: still running 5 s after its exit (75): ended pid ${c.pid}`), r.logs.join(' | '));
    check('... no start before the kill is sent', r.children.length === 1);
    r.killDone();
    check('... then started again at once as an update (exit 75)', r.children.length === 2 && r.reasons[1] === 'an update (exit 75)', JSON.stringify(r.reasons));
    c.emit('exit', 1); // what taskkill /F leaves
    r.advance(10000);
    check('... its own exit afterwards starts nothing more (no 3 s crash restart)', r.children.length === 2 && !r.logs.some((l) => /restarting in 3 s/.test(l)), r.logs.join(' | '));
  }
  {
    const r = rig();
    await r.sup.ensure(0);
    const c = r.children[0];
    await notice(c, 'exiting 75\n');
    r.advance(5000);
    c.emit('exit', 4294967295); // the 'exit' after the kill comes before taskkill itself exits
    check('killed, exit event first: the server\'s own code (75) counts, started once', r.children.length === 2 && r.reasons[1] === 'an update (exit 75)', JSON.stringify(r.reasons));
    r.killDone();
    r.advance(10000);
    check('... and taskkill finishing starts nothing more', r.children.length === 2, String(r.children.length));
  }
  {
    const r = rig();
    await r.sup.ensure(0);
    const c = r.children[0];
    await notice(c, 'exiting 76\n');
    r.advance(5000);
    r.killDone();
    check('stuck after a crash exit (76): the 3 s crash path, not at once', r.children.length === 1 && r.logs.includes('server: exited with 76; restarting in 3 s'), r.logs.join(' | '));
    c.emit('exit', 1);
    r.advance(3000);
    check('... started once after 3 s as a crash (exit 76)', r.children.length === 2 && r.reasons[1] === 'a crash (exit 76)', JSON.stringify(r.reasons));
    r.advance(10000);
    check('... and only once', r.children.length === 2);
  }
  {
    const r = rig();
    await r.sup.ensure(0);
    const c = r.children[0];
    await notice(c, 'exiting 0\n');
    r.advance(5000);
    r.killDone();
    check('stuck after exit 0: ended, and stays stopped', r.kills.length === 1 && r.children.length === 1 && r.logs.includes('server: stopped (exit 0)'), r.logs.join(' | '));
  }
  {
    const r = rig();
    await r.sup.ensure(0);
    const c = r.children[0];
    await notice(c, 'exiting 75\n');
    r.sup.stop(); // the app quits while the server is in its exit (stop() ends the tree itself)
    r.advance(10000);
    c.emit('exit', 1);
    r.advance(10000);
    check('the app quitting: stop() ends the tree, no watchdog kill, no start after it', r.trees.length === 1 && r.trees[0] === c.pid && r.kills.length === 0 && r.children.length === 1, JSON.stringify({ trees: r.trees, kills: r.kills, n: r.children.length }));
  }
  {
    const r = rig();
    await r.sup.ensure(0);
    const c = r.children[0];
    await notice(c, 'hello\nexiting soon\n');
    r.advance(10000);
    check('other text on the pipe arms nothing', r.kills.length === 0 && r.pending() === 0);
    c.emit('exit', 75);
    check('... and a plain exit 75 still restarts it', r.children.length === 2);
  }
  {
    const r = rig();
    await r.sup.ensure(0);
    r.children[0].emit('exit', 75);
    check('no notice at all (an older fleet-view.js): exit 75 restarts as before', r.children.length === 2 && r.pending() === 0);
  }

  // ---------- real processes ----------
  {
    // the fake server: the first one writes its notice on the pipe the way fleet-view.js does, then never ends;
    // the second exits 0 by itself, its notice written from process.on('exit')
    const FAKE = `
      const fs = require('fs'), fd = Number(process.env.FV_EXIT_NOTICE_FD);
      setTimeout(() => {
        if (process.env.FAKE_MODE === 'hang') { fs.writeSync(fd, 'exiting 75\\n'); setInterval(() => {}, 1000); }
        else { process.on('exit', (c) => fs.writeSync(fd, 'exiting ' + c + '\\n')); process.exit(0); }
      }, 150);`;
    const logs = [], pids = [];
    const sup = S.create({
      port: 47991, log: (m) => logs.push(m), exists: () => true, exitWait: 600,
      spawnChild: (port, env) => {
        const c = spawn(process.execPath, ['-e', FAKE], {
          env: { ...env, FV_EXIT_NOTICE_FD: String(S.NOTICE_FD), FAKE_MODE: pids.length ? 'clean' : 'hang' },
          stdio: ['ignore', 'ignore', 'ignore', 'pipe'], windowsHide: true,
        });
        pids.push(c.pid);
        return c;
      },
    });
    await sup.ensure(0);
    await sleep(2500);
    check('real: the hung child was ended and logged', logs.includes(`server: still running 0.6 s after its exit (75): ended pid ${pids[0]}`), logs.join(' | '));
    check('real: the hung child is gone', pids[0] && !alive(pids[0]), String(pids[0]));
    check('real: started again as an update', logs.some((l) => l === `server: started pid ${pids[1]} (an update (exit 75))`), logs.join(' | '));
    await sleep(3800); // past the 3 s a crash restart would wait
    check('real: exactly one restart (no second start from the killed child\'s own exit)', pids.length === 2, JSON.stringify(pids));
    check('real: the second exited 0 with its notice and was left stopped', logs.includes('server: stopped (exit 0)')
      && !logs.some((l) => /restarting in 3 s|still running .* \(0\)/.test(l)), logs.join(' | '));
    sup.stop();
    for (const p of pids) if (alive(p)) { try { process.kill(p, 'SIGKILL'); } catch {} }
  }

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error(e.stack || e); process.exitCode = 1; });
