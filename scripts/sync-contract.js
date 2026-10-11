#!/usr/bin/env node
// Sync contract test: does this Claude Code still behave the way Fleet View's conversation sync relies on?
// The recipe and the evidence behind it: docs/sync-move-recipe.md.
//   node scripts/sync-contract.js [--claude <command>] [--config-dir <dir>] [--pty-from <folder>] [--keep]
// --claude runs another claude (a side install of a new version) instead of the one on PATH; --config-dir tests another
// account's folder (~/.claude-a) instead of ~/.claude; --pty-from finds node-pty in another folder than desktop/ (a
// worktree has no npm install); --keep leaves the test files for a look.
//
// It never spends model tokens: no prompt is ever sent, and it never runs `claude -p`. Each live check writes a small
// made-up conversation (no real content) into a projects folder, starts the interactive `claude --resume <id>` in a
// pseudo-terminal the way desktop/host.js does, reads the screen, and ends it with Ctrl+C before anything is typed.
//
// Format, read from this machine's newest real conversations (read only):
//   F1. a conversation is <projects>/<slug of the folder it started in>/<session id>.jsonl, slug = every character but
//       letters and digits made '-'; each line names that session id
//   F2. its user/assistant lines carry cwd, sessionId, uuid, timestamp, version
//   F3. an "environment" attachment with snapshot.workingDirectory: what makes Claude Code tell the model
//       "Primary working directory: <new> (was <old>)" after a move, which is why sync leaves cwd fields alone
//   F4. subagents in <slug>/<id>/subagents/agent-<agentId>.jsonl (+ .meta.json), sidechain lines with that agentId
// Live (the recipe itself):
//   L1. a conversation copied byte for byte into the slug folder of a folder it never ran in (cwd fields still
//       naming the other machine's path) resumes there: its prompt, its reply and its title are on the screen, no
//       folder-trust question, no "No conversation found"; afterwards the copy is a byte prefix of the file (Claude
//       Code only appended) and nothing was written into the folder itself
//   L2. two different copies of one conversation, one in that folder's slug folder: the resume there picks that one,
//       and the other copy is not touched
//   L3. (note only) a single copy in another folder's slug folder: whether the resume still finds it and where it
//       writes (2.1.296: found, and it appends to that other file; with two such copies: "No conversation found")
// Exit code 0 when every check passes, 1 when any fails. The test files are removed at the end: the two slug
// folders it made (and what Claude Code put in them), the test folder, and session-env/file-history entries named
// after its made-up session ids. The test folder has a fixed name, so Claude Code's own entry for it in .claude.json
// is reused by every run instead of piling up.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const argv = process.argv.slice(2);
const arg = (k) => (argv.indexOf(k) >= 0 ? argv[argv.indexOf(k) + 1] : null);
const CLAUDE = arg('--claude') || 'claude';
const KEEP = argv.includes('--keep');
const WIN = process.platform === 'win32';
const CONFIG = path.resolve(arg('--config-dir') || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
const PROJECTS = path.join(CONFIG, 'projects');
const SETTINGS_JSON = arg('--config-dir') || process.env.CLAUDE_CONFIG_DIR ? path.join(CONFIG, '.claude.json') : path.join(os.homedir(), '.claude.json');
const DATA = WIN ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'fleet-view')
  : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support', 'fleet-view') : path.join(os.homedir(), '.local', 'share', 'fleet-view');
const BASE = path.join(DATA, 'sync-contract');
const TARGET = path.join(BASE, 'target'); // the folder the conversation is resumed in ("this machine's checkout")
// the other machine's checkout: a path that does not exist here, so nothing can work in it by accident
const SOURCE = WIN ? 'C:\\fleet-sync-contract\\other-machine\\repo' : '/fleet-sync-contract/other-machine/repo';
const SOURCE2 = `${SOURCE}-2`; // a second other folder, for two copies that are both elsewhere
const slug = (p) => p.replace(/[^A-Za-z0-9]/g, '-');
const COLS = 140, ROWS = 50;

let failures = 0;
const ok = (m) => console.log(`ok:   ${m}`);
const fail = (m) => { failures++; console.log(`FAIL: ${m}`); };
const note = (m) => console.log(`note: ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- format, from the newest real conversations ----------
function newestTranscripts(n) {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS); } catch { return out; }
  for (const d of dirs) {
    if (d.startsWith(slug(BASE)) || d.startsWith(slug(SOURCE))) continue; // never our own test files
    let ents = [];
    try { ents = fs.readdirSync(path.join(PROJECTS, d)); } catch { continue; }
    for (const f of ents) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/.test(f)) continue;
      try { const p = path.join(PROJECTS, d, f); out.push({ p, dir: d, id: f.slice(0, -6), m: fs.statSync(p).mtimeMs }); } catch {}
    }
  }
  return out.sort((a, b) => b.m - a.m).slice(0, n);
}
function headLines(file, bytes = 512 * 1024) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    const lines = buf.subarray(0, n).toString('utf8').split('\n');
    if (n === bytes) lines.pop(); // cut off mid-line
    return lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((j) => j && typeof j === 'object');
  } finally { fs.closeSync(fd); }
}
function formatChecks() {
  const recent = newestTranscripts(40);
  if (!recent.length) return fail(`F1-F4: no conversations in ${PROJECTS} to read the format from`);
  let slugOk = 0, slugBad = [], idBad = [], fieldBad = [], env = 0;
  for (const t of recent) {
    let lines;
    try { lines = headLines(t.p); } catch { continue; }
    const first = lines.find((j) => typeof j.cwd === 'string');
    if (first) { if (slug(first.cwd) === t.dir) slugOk++; else slugBad.push(`${t.dir}/${t.id} (first cwd ${first.cwd})`); }
    if (lines.some((j) => j.sessionId && j.sessionId !== t.id && !j.isSidechain)) idBad.push(`${t.dir}/${t.id}`);
    for (const j of lines) {
      if (j.type !== 'user' && j.type !== 'assistant') continue;
      const miss = ['cwd', 'sessionId', 'uuid', 'timestamp', 'version'].filter((k) => typeof j[k] !== 'string');
      if (miss.length) { fieldBad.push(`${t.id} ${j.type} lacks ${miss.join(', ')}`); break; }
    }
    if (lines.some((j) => j.type === 'attachment' && j.attachment && j.attachment.type === 'environment' && j.attachment.snapshot && typeof j.attachment.snapshot.workingDirectory === 'string')) env++;
  }
  if (slugOk && !slugBad.length) ok(`F1 ${slugOk} newest conversations sit in the slug folder of the folder they started in`);
  else fail(`F1 the slug rule no longer holds: ${slugBad.slice(0, 3).join('; ') || 'no conversation with a cwd'}`);
  if (!idBad.length) ok('F1 every line names its own file\'s session id');
  else fail(`F1 lines name another session id: ${idBad.slice(0, 3).join('; ')}`);
  if (!fieldBad.length) ok('F2 user/assistant lines carry cwd, sessionId, uuid, timestamp, version');
  else fail(`F2 ${fieldBad.slice(0, 3).join('; ')}`);
  if (env) ok(`F3 "environment" attachments with snapshot.workingDirectory (${env} of the ${recent.length} newest)`);
  else fail('F3 no "environment" attachment with snapshot.workingDirectory in the newest conversations: Claude Code may no longer tell a moved conversation where it is now (docs/sync-move-recipe.md, "Why cwd fields stay as they are")');
  // F4: the newest conversation that ran a subagent
  const withSubs = newestTranscripts(400).find((t) => { try { return fs.readdirSync(path.join(PROJECTS, t.dir, t.id, 'subagents')).some((f) => /^agent-.+\.jsonl$/.test(f)); } catch { return false; } });
  if (!withSubs) return note('F4 skipped: none of the 400 newest conversations ran a subagent');
  const sub = path.join(PROJECTS, withSubs.dir, withSubs.id, 'subagents');
  const f = fs.readdirSync(sub).find((x) => /^agent-.+\.jsonl$/.test(x));
  const agentId = f.slice(6, -6);
  const lines = headLines(path.join(sub, f), 64 * 1024);
  const shapeOk = lines.length && lines.every((j) => !j.type || !['user', 'assistant'].includes(j.type) || (j.isSidechain === true && j.agentId === agentId));
  if (shapeOk && fs.existsSync(path.join(sub, `agent-${agentId}.meta.json`))) ok(`F4 subagents live in <slug>/<id>/subagents/agent-<agentId>.jsonl + .meta.json (${withSubs.id.slice(0, 8)})`);
  else fail(`F4 the subagent layout changed (${sub}\\${f}): sidechain lines with agentId ${agentId} and a .meta.json expected`);
}

// ---------- a made-up conversation in the current line shapes (taken from a real 2.1.296 one, content invented) ----------
function fabricate({ id, cwd, version, word, title, extra }) {
  const t0 = Date.now() - 60e3, ts = (n) => new Date(t0 + n * 1000).toISOString();
  const u1 = crypto.randomUUID(), a1 = crypto.randomUUID(), s1 = crypto.randomUUID(), env = crypto.randomUUID();
  const common = { userType: 'external', entrypoint: 'cli', cwd, sessionId: id, version, gitBranch: 'main' };
  const usage = { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1, service_tier: 'standard' };
  const lines = [
    { type: 'mode', mode: 'normal', sessionId: id },
    { parentUuid: null, isSidechain: false, promptId: crypto.randomUUID(), type: 'user', message: { role: 'user', content: `Sync contract check: remember the word ${word}.` },
      uuid: u1, timestamp: ts(0), origin: { kind: 'human' }, promptSource: 'typed', turnOrigin: 'human', turnPosition: { promptIndex: 1, turnIndex: 1 }, ...common },
    { parentUuid: u1, isSidechain: false, attachment: { type: 'environment', snapshot: { workingDirectory: cwd, isWorktree: false, isGitRepo: true, additionalWorkingDirectories: [], platform: WIN ? 'win32' : process.platform } },
      type: 'attachment', uuid: env, timestamp: ts(1), rendered: [{ content: `<system-reminder>\n# Environment\n - Primary working directory: ${cwd}\n</system-reminder>` }], renderedRole: 'system', ...common },
    { parentUuid: env, isSidechain: false, message: { model: 'claude-sonnet-5-5', id: `msg_${crypto.randomBytes(12).toString('hex')}`, type: 'message', role: 'assistant',
      content: [{ type: 'text', text: `Noted: ${word}${extra ? ` ${extra}` : ''}.` }], stop_reason: 'end_turn', stop_sequence: null, usage },
      requestId: `req_${crypto.randomBytes(12).toString('hex')}`, type: 'assistant', uuid: a1, timestamp: ts(3), ...common },
    { parentUuid: a1, isSidechain: false, type: 'system', subtype: 'turn_duration', durationMs: 3000, messageCount: 3, timestamp: ts(4), uuid: s1, isMeta: false, ...common },
    { type: 'last-prompt', lastPrompt: `Sync contract check: remember the word ${word}.`, leafUuid: s1, sessionId: id },
    { type: 'custom-title', customTitle: title, sessionId: id },
    { type: 'agent-name', agentName: title, sessionId: id },
  ];
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

// ---------- the interactive claude in a pseudo-terminal, as desktop/host.js starts it ----------
// node-pty comes with desktop/ (its npm install); --pty-from <folder> looks in another one (a worktree has none)
function loadPty() {
  const from = [arg('--pty-from'), path.join(__dirname, '..', 'desktop'), __dirname].filter(Boolean);
  for (const name of ['node-pty', '@lydell/node-pty']) {
    try { return require(require.resolve(name, { paths: from })); } catch {}
  }
  return null;
}
function childEnv() {
  const env = {};
  const drop = new Set(['NO_COLOR', 'CLAUDECODE', 'CLAUDE_PID', 'WT_SESSION', 'CLAUDE_CONFIG_DIR', 'CLAUDE_LAUNCH_KEY', 'CLAUDE_EFFORT', 'ELECTRON_RUN_AS_NODE']);
  for (const [k, v] of Object.entries(process.env)) {
    const K = k.toUpperCase();
    if (drop.has(K) || K.startsWith('FV_') || K.startsWith('FLEET_VIEW_') || (K.startsWith('CLAUDE_CODE_') && K !== 'CLAUDE_CODE_GIT_BASH_PATH')) continue;
    env[k] = v;
  }
  if (arg('--config-dir') || process.env.CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = CONFIG;
  env.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE = '1';
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  return env;
}
const SCREEN = require(path.join(__dirname, '..', 'screen.js'));
// resume <id> in cwd, wait until want(screen) / a known refusal / timeout, then Ctrl+C twice. -> { screen, why, exitCode }
async function resumeAndRead(pty, id, cwd, want) {
  if (!/^[0-9a-f-]{36}$/.test(id) || /["%&|<>^]/.test(CLAUDE)) throw new Error('bad id or claude command');
  const p = WIN
    ? pty.spawn(process.env.ComSpec || 'cmd.exe', `/d /s /c "${CLAUDE} --resume ${id}"`, { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd, env: childEnv(), useConpty: true })
    : pty.spawn(CLAUDE, ['--resume', id], { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd, env: childEnv() });
  let raw = '', exitCode = null;
  p.onData((d) => { raw += d; });
  p.onExit((e) => { exitCode = e.exitCode; });
  const screen = () => SCREEN.render(raw, COLS, ROWS, 400, false).join('\n');
  let why = 'timeout';
  for (const until = Date.now() + 45e3; Date.now() < until;) {
    await sleep(400);
    const s = screen();
    if (/Yes, I trust this folder/.test(s)) { why = 'trust'; break; }
    if (/No conversation found/i.test(s)) { why = 'not-found'; break; }
    if (want(s)) { await sleep(1500); why = 'shown'; break; } // let it settle (pid file, footer) before leaving
    if (exitCode !== null) { why = 'exited'; break; }
  }
  const shown = screen();
  if (exitCode === null) {
    p.write(why === 'trust' ? '\x1b' : '\x03'); // the trust question: Esc says no and exits; else Ctrl+C twice
    await sleep(500);
    if (exitCode === null && why !== 'trust') p.write('\x03');
    for (const until = Date.now() + 8000; exitCode === null && Date.now() < until;) await sleep(200);
  }
  if (exitCode === null) {
    note(`claude did not exit after Ctrl+C; ending its process tree (${p.pid})`);
    try { if (WIN) execFileSync('taskkill', ['/pid', String(p.pid), '/t', '/f'], { stdio: 'ignore' }); else p.kill('SIGKILL'); } catch {}
    await sleep(500);
  }
  return { screen: shown, why, exitCode };
}

// ---------- the test files, and only those, out again ----------
const made = { dirs: new Set(), ids: new Set() };
function place(dirSlug, id, text) {
  const d = path.join(PROJECTS, dirSlug);
  if (!fs.existsSync(d)) made.dirs.add(d);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `${id}.jsonl`), text);
  made.ids.add(id);
  return path.join(d, `${id}.jsonl`);
}
function inside(parent, p) { const r = path.relative(parent, p); return r && !r.startsWith('..') && !path.isAbsolute(r); }
function rmTree(p, parent) {
  if (!inside(parent, p)) { note(`not removing ${p}: outside ${parent}`); return; }
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { note(`could not remove ${p}: ${e.code || e.message}`); }
}
function cleanUp() {
  if (KEEP) return note(`--keep: left ${[...made.dirs].join(', ')} and ${TARGET}`);
  // only folders this run made, named after the test folder or the made-up source paths
  for (const d of made.dirs) if ([slug(TARGET), slug(SOURCE), slug(SOURCE2)].includes(path.basename(d))) rmTree(d, PROJECTS);
  for (const id of made.ids) for (const sub of ['session-env', 'file-history', 'tasks', 'todos']) {
    const p = path.join(CONFIG, sub, id);
    if (fs.existsSync(p)) rmTree(p, CONFIG);
  }
  // a pid file left by a claude that had to be killed, if it names one of our ids
  try {
    for (const f of fs.readdirSync(path.join(CONFIG, 'sessions'))) {
      if (!f.endsWith('.json')) continue;
      const p = path.join(CONFIG, 'sessions', f);
      try { const j = JSON.parse(fs.readFileSync(p, 'utf8')); if (made.ids.has(j.sessionId)) fs.unlinkSync(p); } catch {}
    }
  } catch {}
  rmTree(BASE, DATA);
}

function claudeVersion() {
  try {
    const out = WIN ? execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${CLAUDE} --version"`], { encoding: 'utf8', windowsVerbatimArguments: true, timeout: 60e3 })
      : execFileSync(CLAUDE, ['--version'], { encoding: 'utf8', timeout: 60e3 });
    const m = /(\d+\.\d+\.\d+)/.exec(out);
    return m ? m[1] : null;
  } catch { return null; }
}

async function live() {
  const pty = loadPty();
  if (!pty) return fail('L1-L3 skipped: node-pty is not installed (it comes with desktop/: npm install there)');
  const version = claudeVersion();
  if (!version) return fail(`L1-L3 skipped: \`${CLAUDE} --version\` did not run`);
  console.log(`      Claude Code ${version}, config ${CONFIG}`);
  // a fresh, empty test folder (fixed name: Claude Code keeps one entry for it in .claude.json, not one per run)
  rmTree(BASE, DATA);
  fs.mkdirSync(TARGET, { recursive: true });
  // what a run that was cut short left (these names are this test's own)
  for (const d of [slug(TARGET), slug(SOURCE), slug(SOURCE2)]) if (fs.existsSync(path.join(PROJECTS, d))) rmTree(path.join(PROJECTS, d), PROJECTS);
  const rand = () => crypto.randomBytes(3).toString('hex').toUpperCase();

  // L1: the recipe's move: a byte-for-byte copy in the target's slug folder, cwd fields naming the other machine
  {
    const id = crypto.randomUUID(), word = `PLUM-${rand()}`, title = `sync-contract-${rand().toLowerCase()}`;
    const text = fabricate({ id, cwd: SOURCE, version, word, title });
    const file = place(slug(TARGET), id, text);
    const r = await resumeAndRead(pty, id, TARGET, (s) => s.includes(`remember the word ${word}`) && s.includes(`Noted: ${word}`));
    if (r.why === 'shown') ok('L1 a copy in the slug folder of a folder it never ran in resumes there: prompt and reply on screen');
    else if (r.why === 'trust') fail(`L1 claude asked whether to trust ${TARGET}; the test folder must be trusted (its parent folder is, normally: the home folder)`);
    else if (r.why === 'not-found') fail('L1 claude says "No conversation found" for a copy in the slug folder of its own working folder');
    else fail(`L1 the conversation did not show (${r.why}); last screen:\n${r.screen.split('\n').filter((l) => l.trim()).slice(-12).join('\n')}`);
    if (r.why === 'shown') {
      if (r.screen.includes(title)) ok('L1 its title (the custom-title line) shows without custom-title.json');
      else fail(`L1 the title "${title}" is not on the screen: titles may need custom-title.json now`);
    }
    const after = fs.readFileSync(file);
    const before = Buffer.from(text, 'utf8');
    if (after.length >= before.length && after.subarray(0, before.length).equals(before)) ok(`L1 claude only appended to the copy (${after.length - before.length} bytes added; the copy is a byte prefix)`);
    else fail('L1 claude rewrote the copied lines instead of appending: the append-only upload (chunks by byte offset) breaks');
    const inTarget = fs.readdirSync(TARGET);
    if (!inTarget.length) ok('L1 nothing was written into the working folder');
    else fail(`L1 claude wrote into the working folder: ${inTarget.join(', ')}`);
  }

  // L2: two different copies; the one in the working folder's slug folder wins, the other is left alone
  {
    const id = crypto.randomUUID(), word = `FIG-${rand()}`, title = `sync-contract-${rand().toLowerCase()}`;
    const mine = fabricate({ id, cwd: SOURCE, version, word, title, extra: 'from the target copy' });
    const other = fabricate({ id, cwd: SOURCE, version, word, title, extra: 'from the other copy, which must not load' });
    place(slug(TARGET), id, mine);
    const otherFile = place(slug(SOURCE), id, other);
    const r = await resumeAndRead(pty, id, TARGET, (s) => s.includes(`Noted: ${word}`));
    if (r.why === 'shown' && r.screen.includes('from the target copy') && !r.screen.includes('must not load')) ok('L2 with two copies, the resume picks the one in its working folder\'s slug folder');
    else fail(`L2 with two copies the resume did not pick the working folder's (${r.why}${r.screen.includes('must not load') ? ', it loaded the other copy' : ''})`);
    if (fs.readFileSync(otherFile, 'utf8') === other) ok('L2 the other copy was not touched');
    else fail('L2 the resume wrote to the other copy');
  }

  // L3 (note only): one copy, in another folder's slug folder
  {
    const id = crypto.randomUUID(), word = `KIWI-${rand()}`, title = `sync-contract-${rand().toLowerCase()}`;
    const text = fabricate({ id, cwd: SOURCE, version, word, title });
    const file = place(slug(SOURCE), id, text);
    const r = await resumeAndRead(pty, id, TARGET, (s) => s.includes(`Noted: ${word}`));
    const grew = fs.statSync(file).size - Buffer.byteLength(text);
    const ownCopy = fs.existsSync(path.join(PROJECTS, slug(TARGET), `${id}.jsonl`));
    if (r.why === 'shown') note(`L3 a single copy in another folder's slug folder is found from any folder (it appended ${grew} bytes to that copy${ownCopy ? ' and also made one in the working folder\'s slug folder' : ', none in the working folder\'s slug folder'}). The recipe still puts it in the working folder's slug folder; desktop/host.js findTranscript's "any project folder" fallback relies on this lookup`);
    else note(`L3 a single copy in another folder's slug folder is NOT found from the working folder (${r.why}): desktop/host.js findTranscript's "any project folder" fallback no longer matches what claude does`);
    // and two copies, both elsewhere
    place(slug(SOURCE2), id, text);
    const r2 = await resumeAndRead(pty, id, TARGET, (s) => s.includes(`Noted: ${word}`));
    if (r2.why === 'not-found') note('L3 two copies, both in other folders\' slug folders: "No conversation found" (claude will not pick one; findTranscript would)');
    else note(`L3 two copies, both in other folders' slug folders: ${r2.why === 'shown' ? 'claude picked one' : r2.why}`);
  }
}

(async () => {
  console.log('Fleet View sync contract (docs/sync-move-recipe.md)');
  try { formatChecks(); } catch (e) { fail(`format checks crashed: ${e.stack || e.message}`); }
  try { await live(); } catch (e) { fail(`live checks crashed: ${e.stack || e.message}`); }
  try { cleanUp(); } catch (e) { note(`clean-up: ${e.message}`); }
  console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
  process.exit(failures ? 1 : 0);
})();
