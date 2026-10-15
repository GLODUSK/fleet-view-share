// Fleet View desktop: ends the running session host the way the tray's "Quit everything" does, for install.ps1 when
// an update changes the desktop window's packages (npm ci can't replace them while the host holds them open). The
// host saves the restore list (every running session, the busy ones marked), ends every session and exits; the next
// Fleet View start resumes them. Close the window first: a window that loses its host starts a new one.
//   node desktop/quit-all.js
// It returns once the host's process is gone (90 s at most). Exit codes: 0 done (or no host is running), 1 refused, no
// answer, or the host still running. FV_HOST_PIPE picks a test host, as for host.js.
'use strict';
const net = require('net');
const H = require('./host');

const say = (text, code) => { process.stdout.write(`${text}\n`); process.exitCode = code; };

const hf = H.readJson(H.hostFile());
if (!hf || typeof hf.pipe !== 'string' || typeof hf.token !== 'string') {
  say('No session host is running.', 0);
} else {
  const s = net.connect(hf.pipe);
  let buf = '', hello = false, done = false, answered = false;
  const finish = (text, code) => { if (done) return; done = true; clearTimeout(timer); s.destroy(); say(text, code); };
  // ending the sessions takes a few seconds (8 s at most, then the host ends what is left as it exits); then this waits
  // for the host's process to be gone, as an installer that runs next replaces files it holds open
  const WAIT_MS = 90000, until = Date.now() + WAIT_MS;
  const timer = setTimeout(() => { if (!answered) finish(`The session host did not answer within ${WAIT_MS / 1000} s.`, 1); }, WAIT_MS);
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  // after its answer: done once the host's process is gone
  const whenGone = (text) => {
    if (done) return;
    if (!Number.isInteger(hf.pid) || !alive(hf.pid)) return finish(text, 0);
    if (Date.now() > until) return finish(`${text} It was still running ${WAIT_MS / 1000} s on.`, 1);
    setTimeout(() => whenGone(text), 200);
  };
  s.setEncoding('utf8');
  s.on('error', (e) => {
    if (answered) return; // it exits

    // macOS and Linux: a socket file a crashed host left behind refuses the connection
    if (e && (e.code === 'ENOENT' || (process.platform !== 'win32' && e.code === 'ECONNREFUSED'))) finish('No session host is running.', 0);
    else finish(`Could not reach the session host: ${e && e.message ? e.message : e}`, 1);
  });
  s.on('close', () => { if (!answered) finish('The session host closed the connection without an answer.', 1); });
  s.on('connect', () => s.write(`${JSON.stringify({ t: 'hello', token: hf.token, pid: process.pid })}\n`));
  s.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let m = null;
      try { m = JSON.parse(line); } catch {}
      if (!m) continue;
      if (!hello) {
        if (m.t !== 'hello' || !m.ok) return finish('The session host refused the connection (host.json may be stale).', 1);
        hello = true;
        s.write(`${JSON.stringify({ t: 'req', n: 1, op: 'quitAll', a: [{}] })}\n`);
        continue;
      }
      if (m.t !== 'res' || m.n !== 1) continue;
      if (m.err) return finish(`The session host failed: ${m.err}`, 1);
      const v = m.v || {};
      if (!v.ok) return finish(`Refused: ${v.message || 'no reason given'}`, 1);
      const n = Number.isInteger(v.saved) ? v.saved : 0;
      answered = true;
      whenGone(v.message ?`The session host (pid ${hf.pid}) says: ${v.message}.`
        : `The session host (pid ${hf.pid}) ended ${n} session${n === 1 ? '' : 's'} and exited; ${n === 1 ? 'it opens' : 'they open'} again when Fleet View starts.`);
    }
  });
}
