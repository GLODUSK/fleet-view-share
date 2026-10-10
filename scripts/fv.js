#!/usr/bin/env node
// fv: Fleet View's automation API from the command line (README: "Automation API"), for a person or a Claude
// Code session that orchestrates other sessions: start one, send it a message, wait for it, read its menu and
// answer it, read its transcript, stop and remove it. `fv help` lists the commands; `fv api` asks the server.
//
// Node only, no dependencies. The token comes from %LOCALAPPDATA%\fleet-view\api-token (made by the server's first
// start), the port from --port, FLEET_VIEW_PORT or 4777. Nothing else is read or written. Output is short and
// human readable; --json prints the server's raw reply instead. Exit code 0 ok, 1 refused or failed, 2 bad usage.
// A text argument given as "-" is read from stdin. Ids may be shortened to their first 8+ hex characters.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const USAGE = `fv: drive Fleet View's Claude Code sessions (README: "Automation API")

  fv api                                    the server's endpoint list
  fv ls [--all] [--state S] [--repo R]      conversations Fleet View shows (* = hosted and alive)
  fv hosted                                 sessions the desktop app hosts
  fv start <repo> <prompt> [--account A|B|C…] [--name N] [--model M] [--effort E]
           [--fork <id>] [--temp] [--chrome|--no-chrome] [--wait [s]]
  fv send <id> <text> [--wait [s]] [--from <id>]
  fv wait <id> [--timeout s]                until it is ready for you (reply, question, menu, exit)
  fv read <id> [--tail n]                   status and latest reply (and the screen's last n chars)
  fv menu <id>                              the select menu it shows, if any
  fv answer <id> <n|esc> [--text T] [--sig S] [--allow-permission] [--wait [s]]
  fv interrupt <id>                         Esc: stop Claude mid-turn
  fv open <id> [--account A|B|C…] [--prompt P] [--wait [s]]   resume a conversation in the desktop app
  fv transcript <id> [--since n] [--limit m]
  fv stop <id> [--remove]
  fv rm <id>                                hide a conversation from the map (never deletes its log)

  --json         the raw JSON reply          --port <n>   Fleet View's port (default 4777)
  --wait         without a number: the API's default (30 minutes); with one: 1..3600 seconds
  A text argument "-" is read from stdin. Ids may be their first 8+ characters.
  Exit code 0 ok, 1 refused or failed, 2 bad usage.`;

class Usage extends Error {}
class Refused extends Error {}

// ---------- arguments ----------
const VALUE_FLAGS = new Set(['account', 'name', 'model', 'effort', 'fork', 'from', 'timeout', 'tail', 'text', 'sig',
  'prompt', 'since', 'limit', 'state', 'repo', 'port']);
const BOOL_FLAGS = new Set(['temp', 'chrome', 'no-chrome', 'all', 'remove', 'allow-permission', 'json', 'help']);
// -> { pos: [...], flags: { name: value | true } }; --wait takes the next argument only when it is a number
function parseArgs(argv) {
  const pos = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') { flags.help = true; continue; }
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith('--')) { pos.push(a); continue; }
    let name = a.slice(2), val;
    const eq = name.indexOf('=');
    if (eq >= 0) { val = name.slice(eq + 1); name = name.slice(0, eq); }
    if (name === 'wait') {
      if (val === undefined && i + 1 < argv.length && /^\d+$/.test(argv[i + 1])) val = argv[++i];
      flags.wait = val === undefined ? true : val;
    } else if (VALUE_FLAGS.has(name)) {
      if (val === undefined) {
        if (i + 1 >= argv.length) throw new Usage(`--${name} needs a value`);
        val = argv[++i];
      }
      flags[name] = val;
    } else if (BOOL_FLAGS.has(name)) {
      if (val !== undefined) throw new Usage(`--${name} takes no value`);
      flags[name] = true;
    } else throw new Usage(`unknown option --${name}`);
  }
  return { pos, flags };
}

// seconds for --wait/--timeout: a whole number from 1 to 3600
function seconds(v, what) {
  const n = Number(v);
  if (!/^\d+$/.test(String(v)) || n < 1 || n > 3600) throw new Usage(`${what} takes a number of seconds from 1 to 3600`);
  return n;
}
// --wait as the API takes it: true (its default) or seconds; undefined when not given
function waitValue(flags) {
  if (flags.wait === undefined) return undefined;
  return flags.wait === true ? true : seconds(flags.wait, '--wait');
}
// how long the HTTP call may take: the wait plus room for the start or send around it
function callMs(wait, base) {
  if (wait === true) return (1800 + 120) * 1000;
  if (typeof wait === 'number') return (wait + 120) * 1000;
  return base;
}
function count(v, what, min, max) {
  const n = Number(v);
  if (!/^\d+$/.test(String(v)) || n < min || n > max) throw new Usage(`${what} takes a number from ${min} to ${max}`);
  return n;
}

// ---------- the API ----------
function makeClient(port, token) {
  // one call with node's http module (no Origin header: the API refuses any request that has one)
  return function call(method, p, body, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const data = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
      const req = http.request({ host: '127.0.0.1', port, path: '/api' + p, method, timeout: timeoutMs,
        headers: { Authorization: `Bearer ${token}`, ...(data ? { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length } : {}) } }, (res) => {
        const parts = [];
        res.on('data', (b) => parts.push(b));
        res.on('end', () => {
          let j = null;
          try { j = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch {}
          resolve({ code: res.statusCode, j: j || { ok: false, message: `HTTP ${res.statusCode}` } });
        });
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('Fleet View did not answer in time')));
      req.on('error', (e) => reject(e.code === 'ECONNREFUSED' ? new Error(`Fleet View is not running on port ${port}`) : e));
      if (data) req.write(data);
      req.end();
    });
  };
}

function readToken() {
  const file = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'fleet-view', 'api-token');
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { throw new Refused(`no API token at ${file}; start Fleet View once to make it`); }
}

// all of stdin, for a text argument "-"
function readStdin() {
  return new Promise((resolve) => {
    const parts = [];
    process.stdin.on('data', (b) => parts.push(b));
    process.stdin.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    process.stdin.on('error', () => resolve(Buffer.concat(parts).toString('utf8')));
  });
}
async function textArg(v, what) {
  if (v === undefined) throw new Usage(`give the ${what}`);
  let t = v === '-' ? await readStdin() : v;
  t = t.replace(/\r\n/g, '\n').replace(/\s+$/, '');
  if (!t.trim()) throw new Usage(`the ${what} is empty`);
  return t;
}

// ---------- ids ----------
const FULL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// a full id or a host key ("new-3") as it is; a prefix of 8+ characters against every conversation Fleet View knows
// and every hosted session (a new one may not be in the conversation list yet)
async function resolveId(call, given) {
  if (given === undefined) throw new Usage('give a conversation id');
  if (FULL_ID.test(given) || /^new-\d+$/.test(given)) return given;
  if (!/^[0-9a-f-]{8,}$/i.test(given)) throw new Usage(`"${given}" is not a conversation id (give at least its first 8 characters)`);
  const ids = new Set();
  const [c, s] = await Promise.all([call('GET', '/conversations?all=1&limit=100000'), call('GET', '/sessions')]);
  if (c.code === 200 && c.j.ok) for (const x of c.j.conversations || []) if (x && x.id) ids.add(x.id);
  if (s.code === 200 && s.j.ok) for (const x of s.j.sessions || []) if (x && x.id) ids.add(x.id);
  if (!ids.size && c.code !== 200) throw new Refused(c.j.message || `HTTP ${c.code}`);
  const hits = [...ids].filter((id) => id.toLowerCase().startsWith(given.toLowerCase()));
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw new Refused(`no conversation id starts with ${given}`);
  throw new Refused(`${given} matches ${hits.length} conversations: ${hits.join(', ')}; give more characters`);
}

// ---------- output ----------
const short = (id) => (id && FULL_ID.test(id) ? id.slice(0, 8) : id || '?');
const clip = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const pad = (s, n) => { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); };

// a menu as lines: title, its context, the numbered options (with descriptions) and how to answer it
function menuLines(menu, id) {
  const out = [];
  out.push(`${menu.title || '(menu)'}   [${menu.kind || 'other'}]`);
  for (const l of menu.context || []) out.push(`  | ${l}`);
  for (const o of menu.options || []) {
    out.push(`  ${o.on ? '>' : ' '} ${o.n}. ${o.label}`);
    if (o.desc) out.push(`       ${o.desc}`);
  }
  const perm = menu.kind !== 'question';
  const sig = menu.sig ? ` --sig ${menu.sig}` : '';
  const free = (menu.options || []).find((o) => /^Type something/i.test(o.label || ''));
  out.push(`answer: fv answer ${id} <n>${sig}${perm ? ' --allow-permission' : ''}   (or: fv answer ${id} esc)`);
  if (free) out.push(`free answer: fv answer ${id} ${free.n} --text "..."${sig}`);
  if (perm) out.push('  (not a question: answer it only when the user asked you to; esc is always allowed)');
  return out;
}

// the end of a wait (start/send/answer/open with --wait, and fv wait): the reply, or the question/menu to answer
function waitLines(j, id) {
  const out = [];
  if (j.reply) out.push('', j.reply);
  if (j.timedOut) out.push('', `still not done (timed out); it keeps going. Wait again: fv wait ${id}`);
  else if (j.endedBy === 'question' || j.endedBy === 'menu') {
    if (j.question && j.endedBy === 'question' && !j.menu) out.push('', `Claude asks: ${j.question}`, `reply: fv send ${id} "..."`);
    if (j.menu) out.push('', ...menuLines(j.menu, id));
  }
  return out;
}

function printSession(s) {
  const out = [];
  out.push(`${s.id || s.key}  ${s.alive === false ? 'ended' : s.status || ''}  ${s.state || ''}${s.label ? ` (${s.label})` : ''}`.replace(/\s+$/, ''));
  if (s.name) out.push(`name: ${s.name}`);
  if (s.cwd) out.push(`cwd: ${s.cwd}${s.account ? `   account ${s.account}` : ''}`);
  if (s.waitingOn) out.push(`waiting on: ${s.waitingOn}`);
  if (s.lastReply) out.push('', s.lastReply);
  if (s.tail) out.push('', '--- screen ---', s.tail);
  return out;
}

function transcriptLines(j) {
  const out = [`${j.id}: items ${j.from}..${j.from + (j.items || []).length - 1} of ${j.total}`];
  for (const it of j.items || []) {
    const t = it.t ? new Date(it.t).toISOString().slice(11, 19) + ' ' : '';
    if (it.type === 'tool' && it.tool) {
      const r = it.tool.result ? ` -> ${clip(it.tool.result, 200)}` : '';
      out.push(`[${it.i}] ${t}tool ${it.tool.name}${it.tool.isError ? ' (error)' : ''}: ${clip(it.tool.input, 200)}${r}`);
    } else {
      out.push(`[${it.i}] ${t}${it.type}: ${it.text || ''}`);
    }
  }
  return out;
}

// ---------- commands ----------
// each: (ctx) -> { j, lines } (lines printed unless --json); a non-ok reply throws Refused with the server's message
async function run(argv, env) {
  const { pos, flags } = parseArgs(argv);
  const cmd = pos.shift();
  if (!cmd || flags.help || cmd === 'help') return { usage: true, ok: !!(cmd || flags.help) };
  const port = flags.port !== undefined ? flags.port : env.FLEET_VIEW_PORT || 4777;
  if (!/^\d+$/.test(String(port)) || Number(port) < 1 || Number(port) > 65535) throw new Usage('--port must be a port number');
  const call = env.call || makeClient(Number(port), env.token !== undefined ? env.token : readToken());
  const need = async (method, p, body, ms) => {
    const r = await call(method, p, body, ms);
    if (r.code !== 200 || r.j.ok === false) {
      const e = new Refused(r.j.message || `HTTP ${r.code}`);
      e.reply = r.j;
      throw e;
    }
    return r.j;
  };
  const noMore = (n) => { if (pos.length > n) throw new Usage(`unexpected argument "${pos[n]}"`); };
  const id = async () => encodeURIComponent(await resolveId(call, pos[0]));
  const acct = (a) => { if (a !== undefined && !/^[a-z]$/i.test(a)) throw new Usage('--account is one letter: A, B, C…'); return a === undefined ? a : a.toUpperCase(); };

  switch (cmd) {
    case 'api': {
      noMore(0);
      const j = await need('GET', '');
      const eps = j.endpoints || [];
      const w = Math.max(0, ...eps.map((e) => `${e.method} ${e.path}`.length));
      return { j, lines: [`Fleet View API v${j.version}`, ...eps.map((e) => `${pad(`${e.method} ${e.path}`, w)}  ${e.does || ''}${e.body ? `  ${typeof e.body === 'string' ? e.body : JSON.stringify(e.body)}` : ''}`)] };
    }
    case 'ls': {
      noMore(0);
      const q = new URLSearchParams();
      if (flags.all) q.set('all', '1');
      if (flags.state) q.set('state', flags.state);
      if (flags.repo) q.set('repo', flags.repo);
      if (flags.limit) q.set('limit', String(count(flags.limit, '--limit', 1, 100000)));
      const j = await need('GET', '/conversations' + (q.toString() ? '?' + q : ''));
      const cs = j.conversations || [];
      const rows = cs.map((c) => [`${short(c.id)}${c.hosted && c.alive ? '*' : c.hosted ? '+' : ' '}`, clip(c.name || '', 32), c.state || '', c.repo ? path.basename(c.repo) : '']);
      const w1 = Math.max(4, ...rows.map((r) => r[1].length)), w2 = Math.max(5, ...rows.map((r) => r[2].length));
      const lines = rows.map((r) => `${r[0]}  ${pad(r[1], w1)}  ${pad(r[2], w2)}  ${r[3]}`.replace(/\s+$/, ''));
      if (!lines.length) lines.push('(no conversations)');
      else lines.push(`${cs.length} conversation${cs.length === 1 ? '' : 's'}  (* hosted and alive, + hosted, ended)`);
      return { j, lines };
    }
    case 'hosted': {
      noMore(0);
      const j = await need('GET', '/sessions');
      const ss = j.sessions || [];
      const lines = ss.map((s) => `${short(s.id || s.key)}  ${pad(s.alive === false ? 'ended' : s.status || '', 5)}  ${pad(clip(s.name || '', 32), 32)}  ${s.cwd || ''}`.replace(/\s+$/, ''));
      if (!lines.length) lines.push('(no hosted sessions)');
      return { j, lines };
    }
    case 'start': {
      const repo = pos[0];
      if (!repo) throw new Usage('give the repo folder and the prompt');
      const prompt = await textArg(pos[1], 'prompt');
      noMore(2);
      if (flags.chrome && flags['no-chrome']) throw new Usage('--chrome or --no-chrome, not both');
      const body = { repo: path.resolve(repo), account: acct(flags.account) || 'B', prompt };
      if (flags.name !== undefined) body.name = flags.name;
      if (flags.model !== undefined) body.model = flags.model;
      if (flags.effort !== undefined) {
        if (!/^(low|medium|high|xhigh|max)$/.test(flags.effort)) throw new Usage('--effort is low, medium, high, xhigh or max');
        body.effort = flags.effort;
      }
      if (flags.fork !== undefined) body.forkFrom = await resolveId(call, flags.fork);
      if (flags.temp) body.temp = true;
      if (flags.chrome) body.chrome = true;
      if (flags['no-chrome']) body.chrome = false;
      const w = waitValue(flags);
      if (w !== undefined) body.wait = w;
      const j = await need('POST', '/sessions', body, callMs(w, 180000));
      return { j, lines: [`${j.id || j.key}  ${j.message || 'started'}`, ...waitLines(j, j.id || j.key)] };
    }
    case 'send': {
      const sid = await id();
      const text = await textArg(pos[1], 'text');
      noMore(2);
      const body = { text };
      if (flags.from !== undefined) body.from = await resolveId(call, flags.from);
      const w = waitValue(flags);
      if (w !== undefined) body.wait = w;
      const j = await need('POST', `/sessions/${sid}/message`, body, callMs(w, 60000));
      return { j, lines: [j.message || 'sent', ...waitLines(j, decodeURIComponent(sid))] };
    }
    case 'wait': {
      const sid = await id();
      noMore(1);
      const body = {};
      if (flags.timeout !== undefined) body.timeout = seconds(flags.timeout, '--timeout');
      const j = await need('POST', `/sessions/${sid}/wait`, body, ((body.timeout || 1800) + 60) * 1000);
      const head = j.timedOut ? 'timed out' : `ready: ${j.endedBy || 'done'}`;
      return { j, lines: [head, ...waitLines({ ...j, timedOut: false }, decodeURIComponent(sid)), ...(j.timedOut ? [`it keeps going. Wait again: fv wait ${decodeURIComponent(sid)}`] : [])] };
    }
    case 'read': {
      const sid = await id();
      noMore(1);
      const q = flags.tail !== undefined ? `?tail=${count(flags.tail, '--tail', 1, 20000)}` : '';
      const j = await need('GET', `/sessions/${sid}${q}`);
      return { j, lines: printSession(j) };
    }
    case 'menu': {
      const sid = await id();
      noMore(1);
      const j = await need('GET', `/sessions/${sid}/menu`);
      return { j, lines: j.menu ? menuLines(j.menu, decodeURIComponent(sid)) : ['(no menu)'] };
    }
    case 'answer': {
      const sid = await id();
      const opt = pos[1];
      noMore(2);
      if (opt === undefined) throw new Usage('give the option number or esc');
      const body = {};
      if (/^esc$/i.test(opt)) body.option = 'esc';
      else if (/^\d{1,2}$/.test(opt)) body.option = Number(opt);
      else throw new Usage('the option is a number or esc');
      if (flags.text !== undefined) {
        if (body.option === 'esc') throw new Usage('--text goes with a "Type something" option, not esc');
        body.text = await textArg(flags.text, '--text');
      }
      if (flags.sig !== undefined) body.sig = flags.sig;
      if (flags['allow-permission']) body.allowPermission = true;
      const w = waitValue(flags);
      if (w !== undefined) body.wait = w;
      const r = await call('POST', `/sessions/${sid}/answer`, body, callMs(w, 60000));
      const me = decodeURIComponent(sid);
      if (r.code !== 200 || r.j.ok === false) {
        // a stale sig: show the menu as it is now, so the caller can answer that one
        const e = new Refused(r.j.message || `HTTP ${r.code}`);
        e.reply = r.j;
        if (r.j.stale && r.j.menu) e.lines = ['the menu changed; it is now:', ...menuLines(r.j.menu, me)];
        throw e;
      }
      const j = r.j;
      const a = j.answered === 'esc' ? 'pressed Esc' : j.answered ? `answered ${j.answered.n}. ${j.answered.label}` : 'answered';
      const lines = [a];
      if (j.next && !j.done) lines.push('', 'next menu:', ...menuLines(j.next, me));
      lines.push(...waitLines(j, me));
      return { j, lines };
    }
    case 'interrupt': {
      const sid = await id();
      noMore(1);
      const j = await need('POST', `/sessions/${sid}/interrupt`, {});
      return { j, lines: [j.message || `interrupted ${short(decodeURIComponent(sid))}`] };
    }
    case 'open': {
      const sid = await id();
      noMore(1);
      const body = {};
      if (flags.account !== undefined) body.account = acct(flags.account);
      if (flags.prompt !== undefined) body.prompt = await textArg(flags.prompt, '--prompt');
      const w = waitValue(flags);
      if (w !== undefined) body.wait = w;
      const j = await need('POST', `/sessions/${sid}/open`, body, callMs(w, 180000));
      const head = j.alreadyRunning ? 'already running in the desktop app' : 'opened';
      return { j, lines: [`${j.id || decodeURIComponent(sid)}  ${j.message || head}`, ...waitLines(j, j.id || decodeURIComponent(sid))] };
    }
    case 'transcript': {
      const sid = await id();
      noMore(1);
      const q = new URLSearchParams();
      if (flags.since !== undefined) q.set('since', String(count(flags.since, '--since', 0, 1e9)));
      if (flags.limit !== undefined) q.set('limit', String(count(flags.limit, '--limit', 1, 500)));
      const j = await need('GET', `/sessions/${sid}/transcript` + (q.toString() ? '?' + q : ''));
      return { j, lines: transcriptLines(j) };
    }
    case 'stop': {
      const sid = await id();
      noMore(1);
      const j = await need('POST', `/sessions/${sid}/stop`, flags.remove ? { remove: true } : {});
      return { j, lines: [`stopped ${short(decodeURIComponent(sid))}${flags.remove ? ' and removed it from the map' : ''}`] };
    }
    case 'rm': case 'remove': {
      const sid = await id();
      noMore(1);
      const j = await need('POST', `/sessions/${sid}/remove`, {});
      return { j, lines: [`removed ${short(decodeURIComponent(sid))} from the map (its log is kept)`] };
    }
    default: throw new Usage(`unknown command "${cmd}" (fv help)`);
  }
}

// -> exit code; out/err are line printers (so a test can capture them)
async function main(argv, env = process.env, out = console.log, err = console.error) {
  let json = argv.includes('--json');
  try {
    const r = await run(argv, env);
    if (r.usage) { (r.ok ? out : err)(USAGE); return r.ok ? 0 : 2; }
    if (json) out(JSON.stringify(r.j, null, 2));
    else for (const l of r.lines) out(l);
    return 0;
  } catch (e) {
    if (e instanceof Usage) { err(`fv: ${e.message}`); return 2; }
    if (json && e.reply) out(JSON.stringify(e.reply, null, 2));
    else {
      err(`fv: ${e.message || e}`);
      if (e.lines) for (const l of e.lines) err(l);
      else if (e.reply && e.reply.menu && typeof e.reply.menu === 'object') for (const l of menuLines(e.reply.menu, e.reply.id || '<id>')) err(l);
      else if (e.reply && e.reply.menu === true) err('it shows a select menu: see it with fv menu <id>, answer it with fv answer');
    }
    return 1;
  }
}

if (require.main === module) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
module.exports = { main, parseArgs, resolveId, menuLines, waitLines, transcriptLines };
