#!/usr/bin/env node
// fv: Fleet View's automation API from the command line (README: "Automation API"), for a person or a Claude
// Code session that orchestrates other sessions: start one, send it a message, wait for it, read its menu and
// answer it, read its transcript, stop and remove it, make teams of them (led by one, or peers), see what they are
// doing for free (fv status) and ask several one question (fv ask). `fv help` lists the commands; `fv api` asks the
// server.
//
// Node only, no dependencies. The token comes from %LOCALAPPDATA%\fleet-view\api-token (made by the server's first
// start), the port from --port, FLEET_VIEW_PORT or 4777. Nothing else is read (but the folder's version.json and git
// history, for fv version) or written. Output is short and
// human readable; --json prints the server's raw reply instead. Exit code 0 ok, 1 refused or failed, 2 bad usage.
// A text argument given as "-" is read from stdin. Ids may be shortened to their first 8+ hex characters.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const USAGE = `fv: drive Fleet View's Claude Code sessions (README: "Automation API")

  fv api                                    the server's endpoint list
  fv version                                Fleet View's version here (and the running server's); also --version
  fv ls [--all] [--state S] [--repo R]      conversations Fleet View shows (* = hosted and alive)
  fv hosted                                 sessions the desktop app hosts
  fv start <repo> <prompt> [--account A|B|C…] [--name N] [--model M] [--effort E]
           [--fork <id>] [--temp] [--chrome|--no-chrome] [--wait [s]]
  fv send <id> <text> [--wait [s]] [--from <your id>] [--no-open]
                                            with --from: waits behind a menu, resumes one not running
  fv wait <id> [--timeout s]                until it is ready for you (reply, question, menu, exit)
  fv read <id> [--tail n]                   status and latest reply (and the screen's last n chars)
  fv menu <id>                              the select menu it shows, if any
  fv answer <id> <n|esc> [--text T] [--sig S] [--allow-permission] [--wait [s]]
  fv interrupt <id>                         Esc: stop Claude mid-turn
  fv open <id> [--account A|B|C…] [--prompt P] [--wait [s]]   resume a conversation in the desktop app
  fv transcript <id> [--since n] [--limit m]
  fv stop <id> [--remove]
  fv rm <id>                                hide a conversation from the map (never deletes its log)

  fv teams                                  teams and their members (★ the lead)
  fv team new <id> <id>… --order T [--name N] [--lead <id>]
                                            make a team; each gets the order and its teammates.
                                            --lead: that one directs the rest, and they report to it
  fv team add <team> <id> [--lead]          add a conversation (it gets the order, the others its id);
                                            --lead: it joins as the team's lead
  fv team lead <team> <id>|none             make a member the lead, or none: no lead, peers again
  fv team rm <team> <id>                    take one out (it and the others are told)
  fv team disband <team>                    end the team (every member is told)
  fv team say <team> <text> [--from <your id>]   a message to every member (but you)
  <team> is a team's id, the start of it, or its name.

  fv status [<team>|<id>…] [--from <your id>]
                                            free (costs them nothing): what each is doing, its last
                                            reply, branch, PR, context (★ the lead). No target: your
                                            team with --from, else every unfinished conversation
  fv ask <team>|<id>… <question> --from <your id> [--within s] [--wait [s]]
                                            each answers in its own turn; the answers are typed into
                                            your chat as one message (later ones one by one). --wait:
                                            print here the ones in within s (default 100, at most 540; a Bash call stops at 2 minutes)

  --json         the raw JSON reply          --port <n>   Fleet View's port (default 4777)
  --wait         without a number: the API's default (30 minutes); with one: 1..3600 seconds
  A text argument "-" is read from stdin. Ids may be their first 8+ characters.
  Exit code 0 ok, 1 refused or failed, 2 bad usage.`;

class Usage extends Error {}
class Refused extends Error {}

// ---------- arguments ----------
const VALUE_FLAGS = new Set(['account', 'name', 'model', 'effort', 'fork', 'from', 'timeout', 'tail', 'text', 'sig',
  'prompt', 'since', 'limit', 'state', 'repo', 'port', 'order', 'within']);
const BOOL_FLAGS = new Set(['temp', 'chrome', 'no-chrome', 'all', 'remove', 'allow-permission', 'json', 'help', 'version', 'no-open']);
// -> { pos: [...], flags: { name: value | true } }; --wait takes the next argument only when it is a number, --lead
// only when it is not an option (fv team new … --lead <id>; fv team add … --lead stands alone)
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
    } else if (name === 'lead') {
      if (val === undefined && i + 1 < argv.length && !argv[i + 1].startsWith('--')) val = argv[++i];
      flags.lead = val === undefined ? true : val;
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

// a team: its id, the start of its id, or its name (any case), when just one team has it
async function resolveTeam(call, given) {
  if (given === undefined) throw new Usage('give the team (its id, the start of it, or its name)');
  const r = await call('GET', '/teams');
  if (r.code !== 200 || !r.j.ok) throw new Refused(r.j.message || `HTTP ${r.code}`);
  const ts = r.j.teams || [], g = String(given).toLowerCase();
  const exact = ts.find((t) => t.id === g);
  if (exact) return exact;
  const hits = ts.filter((t) => t.id.startsWith(g) || String(t.name || '').toLowerCase() === g);
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw new Refused(`no team is called or starts with "${given}" (fv teams lists them)`);
  throw new Refused(`"${given}" matches ${hits.length} teams: ${hits.map((t) => `${t.id} "${t.name}"`).join(', ')}; give its id`);
}
// The targets of fv status and fv ask: each one a team when it matches one (its id or the start of it, or its name
// or the start of it, any case; a team id starts with t, which no conversation id does), else a conversation id as
// resolveId takes it. -> { teams: [team as GET /api/teams lists it], ids: [conversation id] }
async function resolveTargets(call, list) {
  const r = await call('GET', '/teams');
  const ts = r.code === 200 && r.j.ok ? r.j.teams || [] : [];
  const out = { teams: [], ids: [] };
  for (const given of list) {
    const g = String(given).toLowerCase();
    let hits = ts.filter((t) => t.id === g || String(t.name || '').toLowerCase() === g);
    if (!hits.length) hits = ts.filter((t) => t.id.startsWith(g) || (!/^[0-9a-f-]{8,}$/.test(g) && String(t.name || '').toLowerCase().startsWith(g)));
    if (hits.length > 1) throw new Refused(`"${given}" matches ${hits.length} teams: ${hits.map((t) => `${t.id} "${t.name}"`).join(', ')}; give its id`);
    if (hits.length) { if (!out.teams.some((t) => t.id === hits[0].id)) out.teams.push(hits[0]); continue; }
    if (!/^[0-9a-f-]{8,}$/i.test(given) && !/^new-\d+$/.test(given)) throw new Refused(`no team is called or starts with "${given}", and it is not a conversation id (fv teams and fv ls list them)`);
    const id = await resolveId(call, given);
    if (!out.ids.includes(id)) out.ids.push(id);
  }
  return out;
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

// what a team call told each conversation: "  name (1234abcd): sent" | "queued: …" | "not told: why"
function toldLines(list) {
  return (list || []).map((x) => `  ${x.name || short(x.id)} (${short(x.id)}): ${x.ok ? (x.queued ? 'queued, it goes in once its question or prompt is answered' : 'sent') : `not told: ${x.message || 'failed'}`}`);
}
function teamLines(t) {
  const lead = t.lead ? (t.roster || []).find((m) => m.id === t.lead) : null;
  const out = [`${t.id}  "${t.name}"  ${(t.members || []).length} members${t.lead ? ` · led by ${lead ? lead.name : short(t.lead)}` : ''} · ${clip(t.order, 70)}`];
  for (const m of t.roster || []) out.push(`${m.id === t.lead ? '★ ' : '  '}${short(m.id)}  ${pad(clip(m.name || '', 32), 32)}  ${pad(m.state || 'gone', 8)}  ${m.repo || ''}${m.branch ? ` · ${m.branch}` : ''}${m.removed ? '  (removed from the map)' : ''}`.replace(/\s+$/, ''));
  return out;
}
// "5 min ago", "2 h ago" for a time in ms
function ago(t) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
}
// fv status: a few lines per member (★ the lead): state and what it does, where its work is, its last reply's first line
function statusLines(j) {
  const out = [];
  if (j.team) out.push(`team ${j.team.id} "${j.team.name}"${j.team.lead ? '' : ' (no lead: peers)'}`);
  for (const m of j.members || []) {
    out.push(`${m.lead ? '★ ' : '  '}${short(m.id)}  ${clip(m.name || '', 40)}  ${m.state || 'gone'}${m.doing && m.doing !== m.state ? ` · ${clip(m.doing, 80)}` : ''}${m.queued ? ' · text waiting for it' : ''}${m.removed ? ' · removed from the map' : ''}`);
    const where = [m.repo, m.branch ? `branch ${m.branch}` : '', m.pr ? `PR #${m.pr.number}${m.pr.state ? ` (${m.pr.state})` : ''}` : '',
      m.ctx != null ? `ctx ${Math.round(m.ctx * 100)}%` : '', m.cost ? `$${Number(m.cost).toFixed(2)}` : ''].filter(Boolean).join(' · ');
    if (where) out.push(`      ${where}`);
    if (m.lastReply) out.push(`      last reply${m.lastReplyAt ? ` ${ago(m.lastReplyAt)}` : ''}: ${clip(String(m.lastReply).split('\n').find((l) => l.trim()) || '', 110)}`);
  }
  if (!(j.members || []).length) out.push('(nobody)');
  return out;
}
// one answer of an ask as fv ask --wait prints it (the reply clipped to 3000 characters) -> [lines]
function answerLines(x, at) {
  const head = `── ${x.name || short(x.id)} (${x.id})`;
  if (x.status === 'answered') {
    const r = String(x.reply || '').trim() || `(no text; fv transcript ${x.id} shows what it did)`;
    const ms = (x.at || Date.now()) - at;
    return [`${head} · ${ms < 60e3 ? 'answered within a minute' : `answered after ${Math.round(ms / 60e3)} min`}`,
      r.length > 3000 ? `${r.slice(0, 3000)}\n… (clipped: fv transcript ${x.id} for the rest)` : r];
  }
  if (x.status === 'failed') return [`${head} · no answer: ${x.message || 'failed'}`];
  if (x.status === 'asking') return [`${head} · showing a question/permission prompt${x.message ? `: ${x.message}` : ''}; its answer will be typed into your chat after the user answers that`];
  return [`${head} · still working; its answer will be typed into your chat when it's done`];
}
// the teams other teams' members were pulled out of (a new team, an add)
function leftLines(left) {
  return (left || []).map((x) => `${x.disbanded ? `team "${x.name}" is disbanded` : `team "${x.name}" lost a member`}; told ${x.told.filter((y) => y.ok).length}`);
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

// fv version: this folder's version (version.js, read directly: no server needed), and the running server's (GET /api's
// fleetView) when it answers within a second and a half; a server that is down or older says nothing
async function versionReply(env, port) {
  const root = path.join(__dirname, '..');
  let here = { version: '', commit: '' };
  try { here = require(path.join(root, 'version.js')).versionAt(root); } catch {}
  let running = '';
  try {
    const call = env.call || makeClient(port, env.token !== undefined ? env.token : readToken());
    const r = await call('GET', '', null, 1500);
    if (r.code === 200 && r.j && typeof r.j.fleetView === 'string') running = r.j.fleetView;
  } catch {}
  const lines = [`Fleet View ${here.version || 'version unknown'}${here.commit ? ` (${here.commit.slice(0, 7)})` : ''}`];
  if (running) lines.push(running === here.version ? `running: the same, on port ${port}` : `running on port ${port}: ${running}`);
  return { j: { ok: true, version: here.version, commit: here.commit, running: running || null }, lines };
}

// ---------- commands ----------
// each: (ctx) -> { j, lines } (lines printed unless --json); a non-ok reply throws Refused with the server's message
async function run(argv, env) {
  const { pos, flags } = parseArgs(argv);
  const cmd = pos.shift();
  if (flags.help || cmd === 'help' || (!cmd && !flags.version)) return { usage: true, ok: !!(cmd || flags.help) };
  const port = flags.port !== undefined ? flags.port : env.FLEET_VIEW_PORT || 4777;
  if (!/^\d+$/.test(String(port)) || Number(port) < 1 || Number(port) > 65535) throw new Usage('--port must be a port number');
  if (cmd === 'version' || (!cmd && flags.version)) {
    if (pos.length) throw new Usage(`unexpected argument "${pos[0]}"`);
    return versionReply(env, Number(port));
  }
  const call = env.call || makeClient(Number(port), env.token !== undefined ? env.token : readToken());
  const need = async (method, p, body, ms) => {
    const r = await call(method, p, body, ms);
    // 202: queued behind a menu
    if ((r.code !== 200 && r.code !== 202) || r.j.ok === false) {
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
      return { j, lines: [`Fleet View API v${j.version}${j.fleetView ? ` (Fleet View ${j.fleetView})` : ''}`, ...eps.map((e) => `${pad(`${e.method} ${e.path}`, w)}  ${e.does || ''}${e.body ? `  ${typeof e.body === 'string' ? e.body : JSON.stringify(e.body)}` : ''}`)] };
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
      // from another conversation: it waits behind a menu and resumes one not running (the server's default)
      if (flags.from !== undefined) body.from = await resolveId(call, flags.from);
      if (flags['no-open']) body.open = false;
      const w = waitValue(flags);
      if (w !== undefined) body.wait = w;
      const j = await need('POST', `/sessions/${sid}/message`, body, callMs(w, 180000));
      const moved = j.redirected ? [`${j.queued ? 'queued for' : 'sent to'} ${j.redirected.to} (it picked up ${j.redirected.from})`] : [];
      return { j, lines: [...moved, j.message || 'sent', ...waitLines(j, j.id || decodeURIComponent(sid))] };
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
    case 'teams': {
      noMore(0);
      const j = await need('GET', '/teams');
      const lines = (j.teams || []).flatMap(teamLines);
      if (!lines.length) lines.push('(no teams)');
      return { j, lines };
    }
    case 'team': {
      const sub = pos.shift();
      // briefs and adds may resume a conversation first: up to a minute each, side by side
      const long = 240000;
      if (sub === 'new') {
        if (pos.length < 2) throw new Usage('give two or more conversation ids: fv team new <id> <id>… --order "…"');
        const order = await textArg(flags.order, '--order');
        const members = [];
        for (const g of pos) members.push(await resolveId(call, g));
        const body = { members, order };
        if (flags.name !== undefined) body.name = flags.name;
        if (flags.lead === true) throw new Usage('--lead needs the id of the member that leads');
        if (flags.lead !== undefined) body.lead = await resolveId(call, flags.lead);
        const j = await need('POST', '/teams', body, long);
        const led = j.team.lead ? `, led by ${short(j.team.lead)}` : '';
        return { j, lines: [`made team ${j.team.id} "${j.team.name}" of ${j.team.members.length}${led}; the brief:`, ...toldLines(j.sent), ...leftLines(j.left)] };
      }
      if (sub === 'lead') {
        const t = await resolveTeam(call, pos[0]);
        if (pos[1] === undefined) throw new Usage('give the member that leads, or none: fv team lead <team> <id>|none');
        const m = /^none$/i.test(pos[1]) ? null : await resolveId(call, pos[1]);
        noMore(2);
        const j = await need('POST', `/teams/${t.id}/lead`, { member: m }, long);
        if (j.message && !j.brief && !(j.told || []).length) return { j, lines: [j.message] };
        return { j, lines: [m ? `${short(m)} leads "${t.name}" now; its brief:` : `"${t.name}" has no lead now (peers)`, ...(j.brief ? toldLines([j.brief]) : []), 'the others:', ...toldLines(j.told)] };
      }
      if (sub === 'add' || sub === 'rm' || sub === 'remove') {
        // fv team add <team> --lead <id>: the id was read as --lead's value
        if (sub === 'add' && typeof flags.lead === 'string') { pos.push(flags.lead); flags.lead = true; }
        const t = await resolveTeam(call, pos[0]);
        const m = await resolveId(call, pos[1]);
        noMore(2);
        if (sub === 'add') {
          const j = await need('POST', `/teams/${t.id}/add`, { member: m, ...(flags.lead ? { lead: true } : {}) }, long);
          return { j, lines: [`added ${short(m)} to "${t.name}"${flags.lead ? ' as its lead' : ''}; the brief:`, ...toldLines([j.brief]), 'the others:', ...toldLines(j.told), ...leftLines(j.left)] };
        }
        const j = await need('POST', `/teams/${t.id}/remove`, { member: m });
        return { j, lines: [`took ${short(m)} out of "${t.name}"${j.disbanded ? '; the team is disbanded (one member left)' : ''}`, ...toldLines(j.told)] };
      }
      if (sub === 'disband') {
        const t = await resolveTeam(call, pos[0]);
        noMore(1);
        const j = await need('POST', `/teams/${t.id}/disband`, {});
        return { j, lines: [`disbanded "${t.name}"`, ...toldLines(j.told)] };
      }
      if (sub === 'say') {
        const t = await resolveTeam(call, pos[0]);
        const text = await textArg(pos[1], 'text');
        noMore(2);
        const body = { text };
        if (flags.from !== undefined) body.from = await resolveId(call, flags.from);
        const j = await need('POST', `/teams/${t.id}/message`, body, long);
        return { j, lines: [`"${t.name}": ${j.message}`, ...toldLines(j.results)] };
      }
      throw new Usage(sub ? `unknown team command "${sub}" (fv help)` : 'fv team new | add | lead | rm | disband | say (fv help)');
    }
    case 'status': {
      const q = new URLSearchParams();
      if (pos.length) {
        const tg = await resolveTargets(call, pos);
        if (tg.teams.length === 1 && !tg.ids.length) q.set('team', tg.teams[0].id);
        else q.set('ids', [...new Set([...tg.teams.flatMap((t) => t.members || []), ...tg.ids])].join(','));
      } else if (flags.from !== undefined) q.set('from', await resolveId(call, flags.from));
      const j = await need('GET', '/status' + (q.toString() ? '?' + q : ''));
      return { j, lines: statusLines(j) };
    }
    case 'ask': {
      if (pos.length < 2) throw new Usage('give the team or the conversations, then the question: fv ask <team>|<id>… "question" --from <your id>');
      if (flags.from === undefined) throw new Usage('give --from <your conversation id>: the answers are typed into it');
      const question = await textArg(pos.pop(), 'question');
      const from = await resolveId(call, flags.from);
      const tg = await resolveTargets(call, pos);
      const body = { from, question };
      // one team: the server's own member list (the ones removed from the map left out); more: their members as ids
      if (tg.teams.length === 1) body.team = tg.teams[0].id;
      const to = [...new Set([...(tg.teams.length > 1 ? tg.teams.flatMap((t) => (t.roster || []).filter((m) => !m.removed).map((m) => m.id)) : []), ...tg.ids])].filter((m) => m !== from);
      if (to.length) body.to = to;
      if (flags.within !== undefined) body.within = count(flags.within, '--within', 30, 3600);
      let wait;
      if (flags.wait !== undefined) wait = flags.wait === true ? 100 : count(flags.wait, '--wait', 1, 540);
      const j = await need('POST', '/ask', body, 240000);
      const lines = [`ask ${j.ask}: ${j.message || 'asked'}`, ...toldLines(j.asked)];
      // open in a terminal outside Fleet View: nothing can be typed into it, so the answers are only printed here
      if (j.typedIn === false && !wait) wait = 100;
      if (j.typedIn === false) lines.push('You are open in a terminal outside Fleet View, so the answers cannot be typed into your chat: they are printed here.');
      if (!wait) {
        if ((j.asked || []).some((x) => x.ok)) lines.push('Their answers will be typed into your chat as one message once all have answered'
          + ` (or after ${body.within || 600} s), and any later one on its own. Nothing to wait for: carry on.`);
        return { j, lines };
      }
      const r = await need('GET', `/ask/${j.ask}?wait=${wait}`, null, (wait + 30) * 1000);
      const a = r.ask;
      // the ones not reached are in the lines above already
      const shown = a.answers.filter((x) => (j.asked || []).some((y) => y.ok && y.id === x.id) || !(j.asked || []).some((y) => y.id === x.id));
      const done = shown.filter((x) => x.status === 'answered' || x.status === 'failed');
      if (done.length) await need('POST', `/ask/${j.ask}/collected`, { ids: done.map((x) => x.id) }).catch(() => {});
      if (shown.length) lines.push('', ...shown.flatMap((x) => answerLines(x, a.at)));
      const later = shown.length - done.length;
      if (later) lines.push('', j.typedIn === false ? `${later} still to answer: see ${later === 1 ? 'its reply' : 'their replies'} later with fv transcript <id>.`
        : `${later} still to answer: ${later === 1 ? 'its answer' : 'their answers'} will be typed into your chat by itself; nothing to wait for.`);
      return { j: { ...j, answers: a.answers }, lines };
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
module.exports = { main, parseArgs, resolveId, resolveTeam, menuLines, waitLines, transcriptLines };
