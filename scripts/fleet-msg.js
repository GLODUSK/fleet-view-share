#!/usr/bin/env node
// fleet-msg: one Claude Code conversation sends a message to another through Fleet View's automation API
// (README: "Automation API" and "Teams"). The message is pasted into the other conversation's prompt after a line
// "[Message from teammate "<name>" (<id>)]", and Fleet View records it (its team's messages, the map's comet).
//
//   node fleet-msg.js --from <my id> --to <their id> "text"
//   echo text | node fleet-msg.js --from <my id> --to <their id>
//   node fleet-msg.js --list                  the sessions Fleet View hosts: id, name, status
//   --port <n>                                a server on another port (default 4777)
//   --wait <seconds>                          wait for their reply (at most 3600) and print it
//
// The receiver must be a session the desktop app hosts (its panel). The token comes from
// %LOCALAPPDATA%\fleet-view\api-token, as for every API call; nothing else is read or written. Exit code 1 when
// the message did not go in, e.g. while the receiver shows a permission prompt, a question or a plan approval
// (Fleet View then types nothing: an Enter would answer it).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const USAGE = `fleet-msg: send a message to another conversation through Fleet View

  node fleet-msg.js --from <your id> --to <their id> "message"
  node fleet-msg.js --from <your id> --to <their id>  < message.txt
  node fleet-msg.js --list           hosted sessions (id, name, status)

  --port <n>       Fleet View's port (default 4777)
  --wait <s>       wait up to s seconds for their reply and print it`;

const argv = process.argv.slice(2);
const args = { text: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--from' || a === '--to' || a === '--port' || a === '--wait') args[a.slice(2)] = argv[++i];
  else if (a === '--list') args.list = true;
  else if (a === '--help' || a === '-h') args.help = true;
  else args.text.push(a);
}
const fail = (msg) => { console.error(`fleet-msg: ${msg}`); process.exit(1); };
if (args.help || !argv.length) { console.log(USAGE); process.exit(argv.length ? 0 : 1); }

const port = args.port === undefined ? 4777 : Number(args.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) fail('--port must be a port number');
const tokenFile = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'fleet-view', 'api-token');
let token = '';
try { token = fs.readFileSync(tokenFile, 'utf8').trim(); } catch { fail(`no API token at ${tokenFile}; start Fleet View once to make it`); }

// one API call with node's http module (no Origin header: the API refuses any request that has one)
function call(method, p, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const req = http.request({ host: '127.0.0.1', port, path: '/api' + p, method, timeout: timeoutMs,
      headers: { Authorization: `Bearer ${token}`, ...(data ? { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length } : {}) } }, (res) => {
      const parts = [];
      res.on('data', (b) => parts.push(b));
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch {}
        resolve({ code: res.statusCode, j: j || {} });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Fleet View did not answer in time')));
    req.on('error', (e) => reject(e.code === 'ECONNREFUSED' ? new Error(`Fleet View is not running on port ${port}`) : e));
    if (data) req.write(data);
    req.end();
  });
}

// the message on stdin; a stdin that stays open with nothing on it (a tool runner's pipe) gives up after ms
function readStdin(ms) {
  return new Promise((resolve) => {
    const parts = [];
    let timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      process.stdin.removeAllListeners('data').removeAllListeners('end');
      try { process.stdin.destroy(); } catch {}
      resolve(Buffer.concat(parts).toString('utf8'));
    }
    process.stdin.on('data', (b) => { parts.push(b); clearTimeout(timer); timer = setTimeout(done, ms); });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

async function main() {
  if (args.list) {
    const { code, j } = await call('GET', '/sessions', null, 15000);
    if (code !== 200 || !j.ok) fail(j.message || `HTTP ${code}`);
    for (const s of j.sessions || []) console.log(`${s.id}  ${s.status || (s.alive ? '' : 'ended')}  ${s.name || ''}`.trimEnd());
    if (!(j.sessions || []).length) console.log('(no hosted sessions)');
    return;
  }
  if (!args.from || !args.to) fail('give --from <your conversation id> and --to <their id> (or --list)');
  let text = args.text.join(' ');
  if (!text && !process.stdin.isTTY) text = await readStdin(5000);
  text = text.replace(/\r\n/g, '\n').replace(/\s+$/, '');
  if (!text.trim()) fail('no message: give it as an argument or on stdin');
  const body = { text, from: args.from };
  let timeout = 30000;
  if (args.wait !== undefined) {
    const w = Number(args.wait);
    if (!Number.isInteger(w) || w < 1 || w > 3600) fail('--wait takes a number of seconds from 1 to 3600');
    body.wait = w;
    timeout = (w + 60) * 1000;
  }
  const { code, j } = await call('POST', `/sessions/${encodeURIComponent(args.to)}/message`, body, timeout);
  // they have a permission prompt, a question or a plan approval open: nothing was sent (an Enter would answer it)
  if (code === 409 && j.menu) {
    fail(`NOT SENT: ${args.to} is waiting on a menu (a permission prompt, a question or a plan approval), and Enter would answer it.\n`
      + `  Fleet View says: ${j.message || 'Claude is asking something: answer it first'}\n  Try again in a while, once the user has answered it.`);
  }
  if (code !== 200 || !j.ok) fail(j.message || `HTTP ${code}`);
  console.log(j.message || 'sent');
  if (j.reply) console.log(`\n${j.reply}`);
}
main().catch((e) => fail(e.message || String(e)));
