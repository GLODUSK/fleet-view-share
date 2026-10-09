// Fleet View desktop: asks the running session host to restart, so a changed host.js takes effect without
// killing it by hand. The host checks the new file loads, waits until no other session is mid-turn (not with
// --now), saves the restore list, ends the sessions and starts a new host that resumes them; the session this
// runs in (its CLAUDE_LAUNCH_KEY) is told when it is done. See host.js, Restart.
//   node desktop/restart-host.js [--now]
// Exit codes: 0 asked (or no host is running), 1 refused or no answer, 2 the running host is too old to restart
// itself (end it the old way). FV_HOST_PIPE picks a test host, as for host.js.
'use strict';
const net = require('net');
const H = require('./host');

const now = process.argv.slice(2).includes('--now');
const say = (text, code) => { process.stdout.write(`${text}\n`); process.exitCode = code; };

const hf = H.readJson(H.hostFile());
if (!hf || typeof hf.pipe !== 'string' || typeof hf.token !== 'string') {
  say('No session host is running (no host.json); the next Fleet View window starts one with the current host.js.', 0);
} else {
  const s = net.connect(hf.pipe);
  let buf = '', hello = false, done = false;
  const finish = (text, code) => { if (done) return; done = true; clearTimeout(timer); s.destroy(); say(text, code); };
  // the self-check takes a few seconds, at most 20
  const timer = setTimeout(() => finish('The session host did not answer within 40 s.', 1), 40000);
  s.setEncoding('utf8');
  s.on('error', (e) => {
    if (e && e.code === 'ENOENT') finish(`No session host is running (nothing on ${hf.pipe}); the next Fleet View window starts one with the current host.js.`, 0);
    else finish(`Could not reach the session host: ${e && e.message ? e.message : e}`, 1);
  });
  s.on('close', () => finish('The session host closed the connection without an answer.', 1));
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
        s.write(`${JSON.stringify({ t: 'req', n: 1, op: 'restart', a: [{ now, by: process.env.CLAUDE_LAUNCH_KEY || null }] })}\n`);
        continue;
      }
      if (m.t !== 'res' || m.n !== 1) continue;
      if (m.err === 'unknown op') return finish(`The running session host (pid ${hf.pid}) is too old to restart itself; restart it the old way: end that process (electron.exe running host.js), and the window starts a new host that resumes the sessions.`, 2);
      if (m.err) return finish(`The session host failed: ${m.err}`, 1);
      const v = m.v || {};
      if (!v.ok) return finish(`Refused: ${v.message || 'no reason given'}`, 1);
      if (v.message) return finish(`The session host (pid ${hf.pid}) says: ${v.message}.`, 0);
      const w = Array.isArray(v.waiting) ? v.waiting : [];
      finish(`The session host (pid ${hf.pid}) restarts ${now ? 'now' : w.length ? `once ${w.length} busy session(s) finish (${w.join(', ')}; at most 10 minutes)` : 'now (no other session is busy)'}; its sessions resume in the new host.`, 0);
    }
  });
}
