// Fleet View desktop: the session host. A small standalone process that owns every live Claude session the
// window shows (the Session tab of the detail panel), so closing the window never ends them. main.js starts
// it when it is not running, with the same electron.exe run as plain Node:
//   ELECTRON_RUN_AS_NODE=1 electron.exe host.js      (detached, no window; the same node-pty build as before)
// and talks to it through terms.js. It keeps running after the window closes, and the next window reconnects
// to it and replays each session's screen.
//
// Each session is a pseudo-terminal (ConPTY, through node-pty) running the interactive `claude --resume <id>`,
// exactly what a terminal window runs; never `claude -p`. Each keeps its last ~512 KB of output, so a panel
// that attaches later (another conversation was picked, the page reloaded, the window reopened) replays it
// with snapshot() and then follows the live output.
//
// New sessions (create): a plain interactive `claude` in a repo folder, or a fork of a conversation (`claude
// --resume <id> --fork-session`: a new conversation with its history), keyed "new-<n>" until Claude Code
// says which conversation it is. Every interactive claude writes <config>/sessions/<pid>.json with its
// sessionId (~/.claude/sessions for account B, ~/.claude-<x>/sessions for the others; all are read, deduplicated by
// their real path). While any pty runs, those files are read every 800 ms: a new file whose process descends
// from a pending pty's shell (checked once per candidate through Win32_Process; without that check, a file
// in the same folder started after the pty) re-keys the pty to its sessionId, and a rekey event goes out.
// The same scan gives each hosted session its status ("busy" / "idle", from the file), and follows a session
// whose claude moved to another conversation (/clear starts a new one, /resume opens another): when its
// process's file names another sessionId, the pty is re-keyed to it the same way.
//
// Talking to it: the named pipe \\.\pipe\fleet-view-host-<username>, newline-delimited JSON. A client's first
// line is { t: 'hello', token }, with the random token from %LOCALAPPDATA%\fleet-view\host.json
// ({ pid, pipe, token, startedAt, version }); anything else, or a wrong token, closes the connection. Then:
//   { t: 'req', n?, op, a: [args] }  ->  { t: 'res', n, v } or { t: 'res', n, err }   (no n: no reply)
//   ops: open(o), create(o) (o.chrome, o.forkFrom, o.model, o.effort: see create below), write(id, data), resize(id, cols, rows), kill(id), list(), snapshot(id),
//        endAll(graceMs), killAll(), setUi(ui), quitAll({ ui }), restart({ now, by }) (see Restart), log(text)
//   events: { t: 'ev', e: 'data', id, d } / { e: 'exit', id, code } / { e: 'rekey', from, id } / { e: 'sessions', list }
// list() gives each session: id, pid, alive, exitCode, startedAt, pending, created, forkFrom, cwd, handoffFrom,
// pickingUp, account, status, waitingFor (what its pid file says it waits for, while waiting), claudePid,
// interrupted, restored, autoContinue (a note is due, see below), slashPanel (the "/" command whose panel is
// open, see Panels), cols, rows.
// The pipe is the lock: a second host finds the name taken and exits. The pipe keeps the default ACL (the
// user, SYSTEM and administrators), and the token keeps out anything that did not read the user's own folder.
//
// Restore list: %LOCALAPPDATA%\fleet-view\sessions.json is rewritten on every change:
//   { reason, sessions: [{ id, cwd, account, startedAt, busy, interrupted, cols, rows, pendingKey?, pickup?, handoffFrom?, restartBy? }],
//     ui: { selectedId, wide } }   (pickup / handoffFrom: a handoff's pickup that had no id yet, see Handoffs)
// busy: working, or waiting on a prompt mid-turn (anything but an open "/" panel). "Quit everything" (the tray)
// writes it with every running session and freezes it, then ends them all and the host exits. A reboot leaves
// the last one written (a session whose claude died first, with a non-zero
// exit, stays in it; one closed from the page, or that exited cleanly, leaves it). When a host starts, it resumes every listed
// conversation (claude --resume) and marks the ones that were busy as interrupted (list() says interrupted
// until Claude starts work again or Enter is typed); new sessions that never got an id are dropped, and so is a
// conversation a live claude elsewhere already has open.
//
// Auto-continue: `claude --resume` starts no turn, so a conversation cut off mid-turn, or whose background tasks
// died with the host, would sit idle for good. Each resumed one gets a one-line "[Fleet View] …" note typed into
// it (bracketed paste, then Enter) once it has loaded: idle for 2.5 s by its own pid file, no output for 1.5 s,
// and no menu on screen (../screen.js). It goes to one that was busy or interrupted, to the one that asked for a
// restart (restartBy), and to an idle one whose transcript, in what the resume wrote, shows a background task
// stopped or killed (a <task-notification>) that nothing answered; it looks for that for 20 s, then lets it be.
// Any key typed into the session first, the session starting work by itself, or 3 minutes without getting
// ready drops the note. "autoContinue": false in ~/.fleet-view.json turns it off.
//
// Panels: while a panel is open (/usage, /config, a picker) Claude Code holds back background-task updates, so
// one left open stalls the session. The host follows what is typed into each prompt; when a "/" command opened
// a panel ("dialog open" in the pid file) and no key came for a minute ("panelAutoCloseSec" in
// ~/.fleet-view.json, 0 = never), it sends Esc, at most 3 times, never two within 3 s (two quick Escs at the
// prompt open the rewind menu). A dialog no "/" command opened (trust, a notice at startup) is never touched.
//
// Restart: restart({ now, by }) (desktop/restart-host.js asks for it) runs `host.js --selfcheck` (this file, what
// it requires and a pty module load in a fresh process) and refuses if that fails; else it replies at once and
// waits (at most 10 minutes; not with now) until no session but the asking one (by: its CLAUDE_LAUNCH_KEY) is
// busy, checks again, saves the restore list (reason 'restart', the asker marked restartBy), ends every session
// and starts the next host (FV_HOST_SUCCESSOR=<pid>: it waits up to 15 s for the pipe instead of exiting), which
// resumes them. "Quit everything" while it waits cancels it.
//
// Handoffs (../handoff.js): every claude started here gets its own CLAUDE_LAUNCH_KEY. A session that checkpoints
// itself (its Stop hook, at ~200k context tokens) writes ~/.claude-handoffs/.restart/<that key>.json and is
// killed a few seconds later. When its pty exits, that request is taken (read and deleted) and the fresh
// conversation `claude [--effort <level>] "/pickup <file>"` starts in a new pty under the same key, in the request's folder and the
// same account; no exit goes out, so the panel showing it stays on it, the old screen above the new one. The
// pid-file scan then finds the new claude (as for a new session) and re-keys it to its id: the panel, its
// terminal and the selection follow it to the new conversation. A session ended from here (kill, endAll,
// "Quit everything") never restarts; its request is dropped. One still waiting for its id is saved in the
// restore list with the handoff file, and a host that restores it resumes the picked-up conversation when the
// handoff names it (next_session), else runs the pickup again.
//
// It logs to %LOCALAPPDATA%\fleet-view\host.log, and exits by itself only after 10 minutes with no session and
// no client. A changed host.js on disk takes effect when the host next starts; until then it logs that once.
// `node desktop/restart-host.js` asks it to restart (see Restart).
//
// Tests only: FV_HOST_PIPE=\\.\pipe\fleet-view-host-<name> uses another pipe, and its files go in
// %LOCALAPPDATA%\fleet-view\test-<name> (or FV_HOST_DIR); only with such a pipe does it honour FV_TERM_CMD (a
// harmless command instead of claude), FV_HOST_SESSIONS_DIR (one more folder of pid files),
// FV_HOST_IDLE_MS, FV_HOST_SETTINGS (another settings file), FV_HOST_PROJECTS_DIR (where transcripts are, instead
// of ~/.claude*/projects), FV_HOST_NUDGE_GIVEUP_MS and FV_HOST_PANEL_CLOSE_MS. desktop/host-test.js uses them.
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync, execFile } = require('child_process');
const HO = require(path.join(__dirname, '..', 'handoff.js'));

const ID_RE = /^[0-9a-f-]{36}$/i;
const NEW_RE = /^new-\d{1,9}$/; // a new session's key until Claude Code reports its id
const KEY_RE = /^(?:[0-9a-f-]{36}|new-\d{1,9})$/i;
const SCAN_MS = 800;
const BUFFER_MAX = 512 * 1024; // characters of output kept per pty for snapshot()
const MAX_PTYS = 24;
const FLUSH_MS = 6; // output goes out in small batches, not one message per ConPTY read
const PROTO = 1;
// what a terminal sends by itself, not a key: focus in/out, and its replies to Claude Code's queries (cursor
// position, status reports, device attributes, kitty keyboard flags, mode reports, DCS and OSC replies). A write
// made only of these is not input: it neither counts as a key nor goes into the typed line.
const AUTO_REPLY_RE = /^(?:\x1b\[[IO]|\x1b\[\??\d+;\d+R|\x1b\[\??[\d;]*n|\x1b\[[?>][\d;]*c|\x1b\[\?[\d;]*u|\x1b\[\??[\d;]*\$y|\x1bP[\s\S]*?\x1b\\|\x1b\][\s\S]*?(?:\x07|\x1b\\))+$/;
const PANEL_CLOSE_MS = 60 * 1000; // a "/" panel left open this long with no key is closed (panelAutoCloseSec)
const ESC_GAP_MS = 3000; // two Escs closer than this at Claude Code's prompt open its rewind menu
const NUDGE_GIVEUP_MS = 3 * 60 * 1000; // a resumed session not ready this long after its start gets no note
const NUDGE_IDLE_MS = 2500, NUDGE_QUIET_MS = 1500, NUDGE_TASKS_MS = 20000;

// ---------- where things live ----------
const userTag = () => { let u = ''; try { u = os.userInfo().username; } catch {} return (u || process.env.USERNAME || 'user').replace(/[^\w.-]/g, '_').slice(0, 60); };
const REAL_PIPE = `\\\\.\\pipe\\fleet-view-host-${userTag()}`;
const TEST_PIPE_RE = /^\\\\\.\\pipe\\fleet-view-host-[\w.-]{1,60}$/;
function pipeName() {
  const p = process.env.FV_HOST_PIPE;
  return p && TEST_PIPE_RE.test(p) ? p : REAL_PIPE;
}
const isTestPipe = () => pipeName() !== REAL_PIPE;
function dataDir() {
  const base = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'fleet-view');
  if (!isTestPipe()) return base;
  return process.env.FV_HOST_DIR || path.join(base, `test-${pipeName().split('\\').pop()}`);
}
const hostFile = () => path.join(dataDir(), 'host.json');
const sessionsFile = () => path.join(dataDir(), 'sessions.json');
const logFile = () => path.join(dataDir(), 'host.log');
const HOST_JS = __filename;

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}
function fileHash(file) { try { return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 12); } catch { return null; } }

// ~/.fleet-view.json, the Fleet View server's settings. The server writes it and keeps keys it does not know,
// so this only ever reads it: autoContinue (false: no notes after a restore), panelAutoCloseSec (0: never),
// newSessionEffort (see newEffort).
// Read at most every 30 s; the scan asks for it every 800 ms.
// newSessionEffort: the effort a new conversation starts at (`claude --effort <level>`), "medium" when unset;
// "last" adds no flag, so Claude Code's saved default (the last /effort typed anywhere) applies.
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
// a model name as create takes it (`claude --model <m>`): nothing cmd reads as special
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9.\-\[\]]{0,59}$/;
function newEffort(v) {
  if (v === 'last') return '';
  return EFFORT_LEVELS.has(v) ? v : 'medium';
}
const settingsFile = () => (isTestPipe() && process.env.FV_HOST_SETTINGS) || path.join(process.env.USERPROFILE || os.homedir(), '.fleet-view.json');
let settingsCache = null, settingsAt = 0;
function settings(fresh) {
  if (fresh || !settingsCache || Date.now() - settingsAt > 30000) {
    const j = readJson(settingsFile());
    settingsCache = j && typeof j === 'object' && !Array.isArray(j) ? j : {};
    settingsAt = Date.now();
  }
  return settingsCache;
}

// a conversation's transcript, <projects>/<folder>/<id>.jsonl: { file, size } or null. The folder is named
// after the cwd (every character but letters and digits a dash), tried first; else any project folder.
function projectRoots() {
  if (isTestPipe() && process.env.FV_HOST_PROJECTS_DIR) return [process.env.FV_HOST_PROJECTS_DIR];
  const home = process.env.USERPROFILE || os.homedir();
  return [path.join(home, '.claude', 'projects'), ...acctHomes().map((d) => path.join(d, 'projects'))];
}
// every other account's config folder: ~/.claude-<letter> (~/.claude-a is A, ~/.claude-c is C, ...)
function acctHomes() {
  const home = process.env.USERPROFILE || os.homedir();
  try { return fs.readdirSync(home).filter((e) => /^\.claude-[a-z]$/i.test(e)).map((e) => path.join(home, e)); } catch { return []; }
}
// an account letter as the callers send it: one letter, else B (the default ~/.claude)
const acctId = (a) => (typeof a === 'string' && /^[a-z]$/i.test(a) ? a.toUpperCase() : 'B');
// an account's config folder: B is the default ~/.claude, any other letter ~/.claude-<letter>
const acctDir = (a) => path.join(process.env.USERPROFILE || os.homedir(), acctId(a) === 'B' ? '.claude' : `.claude-${acctId(a).toLowerCase()}`);
// What "Send to Claude <X>" needs in account X: '' when it has it all, else why not. It needs the /handoff and
// /pickup commands (a skill or a command file, in X's folder or the conversation's own .claude folder), and the
// conversation's log in X's projects folder (two logins share it only when one's folder links to the other's).
function sendToMissing(id, account, cwd) {
  const dir = acctDir(account), L = acctId(account);
  const roots = [dir, ...(typeof cwd === 'string' && cwd ? [path.join(cwd, '.claude')] : [])];
  const isFile = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };
  const has = (n) => roots.some((r) => isFile(path.join(r, 'skills', n, 'SKILL.md')) || isFile(path.join(r, 'commands', `${n}.md`)));
  const lack = ['handoff', 'pickup'].filter((n) => !has(n));
  if (lack.length) return `Claude ${L} has no ${lack.map((n) => `/${n}`).join(' or ')} command, which sending a conversation there needs`;
  const projects = isTestPipe() && process.env.FV_HOST_PROJECTS_DIR ? process.env.FV_HOST_PROJECTS_DIR : path.join(dir, 'projects');
  if (!findTranscript(id, cwd, [projects])) return `Claude ${L} can't see this conversation: its log is not in ${projects}`;
  return '';
}
function findTranscript(id, cwd, roots = projectRoots()) {
  const name = `${String(id).toLowerCase()}.jsonl`;
  const at = (f) => { try { const st = fs.statSync(f); return st.isFile() ? { file: f, size: st.size } : null; } catch { return null; } };
  const slug = typeof cwd === 'string' && cwd ? cwd.replace(/[^A-Za-z0-9]/g, '-') : '';
  for (const root of roots) { const r = slug && at(path.join(root, slug, name)); if (r) return r; }
  for (const root of roots) {
    let dirs = [];
    try { dirs = fs.readdirSync(root); } catch { continue; }
    for (const d of dirs) { const r = at(path.join(root, d, name)); if (r) return r; }
  }
  return null;
}

// What the resume wrote to a transcript (from `offset`): 'tasks' when a background task stopped or was killed
// (a user entry that is a <task-notification> with that status), 'interrupted' when a tool call was cut off
// (a tool_result "[Tool call interrupted…"), and no real assistant entry came after it; else null. "No response
// requested." (and any '<synthetic>' entry) is Claude Code's own filler, not an answer.
function stoppedWork(file, offset) {
  let text = '';
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(Math.max(0, size - offset), 8 << 20);
      if (!len) return null;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, offset);
      text = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return null; }
  // content is a string or an array of blocks: [{ text, tool }] (tool: the text of a tool_result)
  const texts = (c, tool) => (typeof c === 'string' ? [{ text: c, tool }] : Array.isArray(c) ? c.flatMap((b) => (!b || typeof b !== 'object' ? []
    : b.type === 'text' && typeof b.text === 'string' ? [{ text: b.text, tool }] : b.type === 'tool_result' ? texts(b.content, true) : [])) : []);
  let found = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || typeof e !== 'object' || !e.message || typeof e.message !== 'object') continue;
    const parts = texts(e.message.content, false);
    if (e.type === 'user') {
      for (const p of parts) {
        const v = p.text.trimStart();
        if (p.tool && v.startsWith('[Tool call interrupted')) found = 'interrupted';
        else if (!p.tool && v.startsWith('<task-notification>') && /<status>(?:stopped|killed)<\/status>/.test(v)) found = found || 'tasks';
      }
    } else if (e.type === 'assistant' && found) {
      const synthetic = e.message.model === '<synthetic>' || (parts.length > 0 && parts.every((p) => p.text.trim() === 'No response requested.'));
      if (!synthetic) found = null;
    }
  }
  return found;
}

// ---------- the pty side (what terms.js did inside Electron before) ----------
// variables that must not leak from Fleet View's own environment into a Claude session it starts: the
// ones that would make claude think it runs inside another claude, pick an account, or turn colour off
const DROP_EXACT = new Set([
  'NO_COLOR', 'CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ATTENDED', 'WT_SESSION',
  // like the server's "Open in terminal": the account comes from `account` alone
  'CLAUDE_CONFIG_DIR', 'CLAUDE_SWAP_KEY', 'CLAUDE_SWAP_PAYER', 'CLAUDE_CODE_OAUTH_TOKEN',
  'ELECTRON_RUN_AS_NODE',
  // its own, set below: a launcher's key from Fleet View's environment would hand a restart to that launcher
  'CLAUDE_LAUNCH_KEY',
]);
const DROP_PREFIX = ['FLEET_VIEW_', 'FV_'];
const FV_DIR = path.resolve(__dirname, '..');
// Teammates talk through fv: every claude started here may run these fv commands without asking, so a message
// between conversations, a lead's status check or question, or a change to its team never waits on an approval
// click. Only these, nothing broader: send, status, ask, read, ls, teams, team, transcript. It is one argument,
// "--allowedTools=a,b,…" in quotes (the commas split the list; a comma inside parentheses would be kept): as two
// words the flag would take every word after it as one more tool, a prompt after it too.
const FV_ALLOWED = ['send', 'status', 'ask', 'read', 'ls', 'teams', 'team', 'transcript'];
const ALLOW_FV = `"--allowedTools=${FV_ALLOWED.map((c) => `Bash(fv ${c}:*)`).join(',')}"`;

function childEnv(account, launchKey) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    const K = k.toUpperCase();
    if (DROP_EXACT.has(K) || DROP_PREFIX.some((p) => K.startsWith(p))) continue;
    env[k] = v;
  }
  // account X: ~/.claude-x (A: ~/.claude-a, C: ~/.claude-c, ...); B (or anything else): the default ~/.claude, no CLAUDE_CONFIG_DIR
  if (acctId(account) !== 'B') env.CLAUDE_CONFIG_DIR = acctDir(account);
  // Fleet View's folder first on PATH, so `fv` runs in every session started here, also when this host was
  // started from an environment older than the PATH install.ps1 set (the key is Path, whatever its case)
  const pk = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'Path';
  const rest = String(env[pk] || '').split(';').filter((p) => p && normDir(p) !== normDir(FV_DIR));
  env[pk] = [FV_DIR, ...rest].join(';');
  env.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE = '1';
  if (launchKey) env.CLAUDE_LAUNCH_KEY = launchKey;
  env.COLORTERM = 'truecolor';
  env.TERM = 'xterm-256color';
  return env;
}

function dirOr(cwd) {
  try { if (typeof cwd === 'string' && cwd && fs.statSync(cwd).isDirectory()) return cwd; } catch {}
  return os.homedir();
}

const intIn = (v, lo, hi, dflt) => (Number.isInteger(v) && v >= lo && v <= hi ? v : dflt);

// the whole process tree: claude and whatever it started (shells, MCP servers)
function treeKill(pid, sync) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  const args = ['/T', '/F', '/PID', String(pid)];
  try {
    if (sync) spawnSync('taskkill', args, { windowsHide: true, stdio: 'ignore', timeout: 5000 });
    else spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
  } catch {}
}

// the folders Claude Code writes its sessions/<pid>.json into, one per real folder
function sessionDirs(extra) {
  const home = process.env.USERPROFILE || os.homedir();
  const out = [], seen = new Set();
  for (const d of [...(extra || []), path.join(home, '.claude', 'sessions'), ...acctHomes().map((h) => path.join(h, 'sessions'))]) {
    let real;
    try { real = fs.realpathSync(d).toLowerCase(); } catch { continue; }
    if (seen.has(real)) continue;
    seen.add(real);
    out.push(d);
  }
  return out;
}
const pidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};
// every live claude's pid file: [{ pid, sessionId, cwd, startedAt, kind, status, waitingFor, statusAt, updatedAt, file }]
// waitingFor, while waiting: "dialog open" (a panel or picker), "approve <Tool>(…)", "approve plan", a question…
function readPidFiles(dirs) {
  const out = [];
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const f of names) {
      if (!/^\d+\.json$/.test(f)) continue;
      let j = null;
      try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
      if (!j || !Number.isInteger(j.pid) || typeof j.sessionId !== 'string' || !ID_RE.test(j.sessionId)) continue;
      if (!pidAlive(j.pid)) continue;
      const wf = typeof j.waitingFor === 'string' ? j.waitingFor.trim().slice(0, 300) : '';
      out.push({
        pid: j.pid, sessionId: j.sessionId.toLowerCase(), cwd: typeof j.cwd === 'string' ? j.cwd : '', startedAt: Number(j.startedAt) || 0,
        kind: typeof j.kind === 'string' ? j.kind : '', status: typeof j.status === 'string' ? j.status : null, waitingFor: wf || null,
        statusAt: Number(j.statusUpdatedAt) || Number(j.updatedAt) || 0,
        updatedAt: Number(j.updatedAt) || Number(j.startedAt) || 0, file: path.join(dir, f),
      });
    }
  }
  return out;
}
const normDir = (p) => { try { return path.resolve(String(p)).replace(/[\\/]+$/, '').toLowerCase(); } catch { return ''; } };

// pid -> parent pid for every process, one PowerShell call (about a second); null when it fails
function parentMap(cb) {
  if (process.platform !== 'win32') return cb(null);
  const ps = "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.ParentProcessId }";
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 20000, maxBuffer: 4 << 20 }, (err, out) => {
    if (err) return cb(null);
    const m = new Map();
    for (const line of String(out).split(/\r?\n/)) { const [a, b] = line.trim().split(/\s+/).map(Number); if (a > 0 && b >= 0) m.set(a, b); }
    cb(m.size ? m : null);
  });
}
// does pid descend from root (at most 8 levels up)?
function descends(map, pid, root) {
  for (let i = 0, p = pid; i < 8 && p > 0; i++) { p = map.get(p); if (p === root) return true; if (p === undefined) return false; }
  return false;
}

// node-pty ships N-API prebuilds for win32 that load as they are (in Electron and in electron.exe run as
// Node); @lydell/node-pty is the fallback. Loaded on first use, so requiring this file costs nothing.
let ptyLib = null, ptyName = null, ptyError = null, ptyTried = false;
function loadPty() {
  if (ptyTried) return ptyLib;
  ptyTried = true;
  for (const name of ['node-pty', '@lydell/node-pty']) {
    try { ptyLib = require(name); ptyName = name; break; } catch (e) { ptyError = e; }
  }
  return ptyLib;
}

// opts: { send(event, ...args): to every client, changed(): the set or a status changed, command(id) -> command
//         line (test override), newCommand (test override), pickupCommand(file) (test override),
//         sessionDirs: more folders to read, log(text), settings() -> the settings file's keys,
//         panelCloseMs / nudgeGiveUpMs (test overrides) }
function createPtys(opts = {}) {
  const send = opts.send || (() => {});
  const changed = opts.changed || (() => {});
  const commandFor = opts.command || ((id) => `claude ${ALLOW_FV} --resume ${id}`);
  const newCommand = opts.newCommand || `claude ${ALLOW_FV}`;
  const pickupFor = opts.pickupCommand || ((file) => HO.pickupCommand(file).replace(/^claude /, `claude ${ALLOW_FV} `));
  const log = opts.log || (() => {});
  const dirs = () => sessionDirs(opts.sessionDirs);
  const getSettings = opts.settings || (() => settings());
  const nudgeGiveUpMs = opts.nudgeGiveUpMs > 0 ? opts.nudgeGiveUpMs : NUDGE_GIVEUP_MS;
  function panelCloseMs() {
    if (Number.isFinite(opts.panelCloseMs) && opts.panelCloseMs >= 0) return opts.panelCloseMs;
    const s = getSettings().panelAutoCloseSec;
    return Number.isInteger(s) && s >= 0 ? s * 1000 : PANEL_CLOSE_MS;
  }
  // key -> { id, pty, pid, alive, exitCode, startedAt, chunks, size, pending, timer, dismissed, cwd, account, cols, rows,
  //          isNew (still keyed new-<n>), created (started by create()), claudePid, status, known (pids there before),
  //          interrupted (restored after a shutdown that caught it mid-turn), restored, launchKey (its
  //          CLAUDE_LAUNCH_KEY), pickup (the handoff file it picks up, while it waits for its id), handoffFrom
  //          (the conversation it took over from), waitingFor (its pid file's, while waiting), seenIdle (a pid file
  //          of the claude this pty started said idle), idleSince (when that idle stretch began; 0 when not idle),
  //          outAt (its last output), inputAt (its last key), line / inPaste (what is typed into the prompt since
  //          the last Enter), slash (a "/" command sent with Enter, until its panel closes: see panelTick),
  //          nudge (the note due after a restore: see nudgeTick), restartBy (it asked for the host restart) }
  const terms = new Map();
  let newSeq = 0;
  let screenLib = null;

  function flush(t) {
    clearTimeout(t.timer);
    t.timer = null;
    if (!t.pending) return;
    const data = t.pending;
    t.pending = '';
    send('data', t.id, data);
  }

  function keep(t, data) {
    t.chunks.push(data);
    t.size += data.length;
    while (t.size > BUFFER_MAX && t.chunks.length > 1) t.size -= t.chunks.shift().length;
    if (t.size > BUFFER_MAX) { t.chunks[0] = t.chunks[0].slice(t.size - BUFFER_MAX); t.size = BUFFER_MAX; }
  }

  const aliveCount = () => [...terms.values()].filter((t) => t.alive).length;
  const noPty = () => ({ ok: false, message: `No pty module: ${ptyError ? ptyError.message : 'not installed'}` });

  // starts `command` in a pty under `key`; extra fields go onto the entry
  function spawnPty(key, command, o, extra) {
    if (aliveCount() >= MAX_PTYS) return { ok: false, message: `At most ${MAX_PTYS} sessions at once` };
    const cols = intIn(o.cols, 20, 1000, 120), rows = intIn(o.rows, 5, 500, 32);
    const shell = process.env.ComSpec || 'cmd.exe';
    const cwd = dirOr(o.cwd);
    const launchKey = HO.newLaunchKey();
    let p;
    try {
      // the command line is built from checked parts only (an id of hex and dashes, the fixed new command and
      // ALLOW_FV, or a handoff file path HO.safeFile checked: no quotes, % or cmd metacharacters). It goes to cmd as one string,
      // `/c "<command>"`, which /s strips to the command itself: node-pty would escape a quote in it as \" (which
      // cmd does not read), and it already quoted a command with spaces the same way before
      p = ptyLib.spawn(shell, `/d /s /c "${command}"`, {
        name: 'xterm-256color', cols, rows, cwd, env: childEnv(o.account, launchKey), useConpty: true,
      });
    } catch (e) {
      return { ok: false, message: `Could not start: ${e.message}` };
    }
    const t = {
      id: key, pty: p, pid: p.pid, alive: true, exitCode: null, startedAt: Date.now(), chunks: [], size: 0, pending: '', timer: null, dismissed: false,
      cwd, account: acctId(o.account), cols, rows, isNew: false, created: false, claudePid: null, status: null, known: null,
      interrupted: false, restored: false, launchKey, pickup: null, handoffFrom: null, waitingFor: null, seenIdle: false, idleSince: 0,
      outAt: 0, inputAt: 0, line: '', inPaste: false, slash: null, nudge: null, restartBy: false, ...extra,
    };
    terms.set(key, t);
    p.onData((data) => {
      if (terms.get(t.id) !== t) return;
      t.outAt = Date.now();
      keep(t, data);
      t.pending += data;
      if (!t.timer) t.timer = setTimeout(() => flush(t), FLUSH_MS);
    });
    p.onExit(({ exitCode }) => {
      if (!t.alive) return;
      t.alive = false;
      t.exitCode = Number.isInteger(exitCode) ? exitCode : null;
      if (terms.get(t.id) !== t) return;
      // it handed off (it asked for a restart, then was killed): the pickup takes its place under the same key
      const req = HO.takeRestart(t.launchKey);
      if (req && !t.dismissed && handoff(t, req)) return;
      flush(t);
      send('exit', t.id, t.exitCode);
      // killed from the page, or a new session that never got an id: forget it once it is gone
      if (t.dismissed || t.isNew) terms.delete(t.id);
      changed();
    });
    startScan();
    changed();
    return { ok: true, message: 'started', pid: t.pid, key };
  }

  // A session handed off: start `claude [--effort <level>] "/pickup <file>"` in its place, under its key, in the request's folder
  // (else its own) and its account, keeping its output so far. Returns false when it could not start (then the
  // exit goes out as usual).
  function handoff(t, req) {
    let cwd = t.cwd;
    try { if (req.cwd && fs.statSync(req.cwd).isDirectory()) cwd = req.cwd; } catch {}
    flush(t);
    const from = req.session || (ID_RE.test(t.id) ? t.id.toLowerCase() : t.handoffFrom);
    const r = startPickup(t.id, req.file, { cwd, account: t.account, cols: t.cols, rows: t.rows },
      { chunks: t.chunks.slice(), size: t.size, created: t.created, handoffFrom: from });
    log(`handoff: ${t.id} -> ${r.ok ? `pickup of ${path.basename(req.file)} (pid ${r.pid})` : `could not start the pickup: ${r.message}`}`);
    if (!r.ok) return false;
    const n = terms.get(t.id);
    const note = `\r\n\x1b[2m── handed off; a fresh conversation picks it up ──\x1b[0m\r\n`;
    keep(n, note);
    send('data', n.id, note);
    return true;
  }
  // the pickup itself (also what a restore runs for one that never got its id): a new claude, keyed like a
  // new session (key, or new-<n> when null) until its pid file says which conversation it is
  function startPickup(key, file, o, extra) {
    if (!loadPty()) return noPty();
    const known = new Set(readPidFiles(dirs()).map((f) => f.pid));
    return spawnPty(key || `new-${++newSeq}`, pickupFor(file), o || {}, { isNew: true, known, pickup: file, ...(extra || {}) });
  }

  // extra: { interrupted, restored, nudge } when the host resumes it after a shutdown
  function open(o, extra) {
    const { id } = o || {};
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error('bad conversation id');
    if (!loadPty()) return noPty();
    const old = terms.get(id);
    if (old && old.alive) return { ok: true, message: 'already running', pid: old.pid };
    if (old) terms.delete(id); // ended: start it again
    const r = spawnPty(id, commandFor(id), o, { ...(extra || {}) });
    delete r.key;
    return r;
  }

  // "Send to Claude B" (or A, C, ...): the conversation carries on under another account in a fresh conversation, when
  // that account has the /handoff and /pickup commands and can see its log (sendToMissing; else nothing is ended). Its
  // claude here, if one runs, is ended first (Ctrl+C, as kill does); then it is resumed under o.account with
  // /handoff as its first prompt. The summary's restart request starts the /pickup in its place under that same
  // account (handoff above). The prompt is fixed text: nothing from the caller goes into the command line.
  // Resolves like open().
  function sendTo(o) {
    const { id } = o || {};
    if (typeof id !== 'string' || !ID_RE.test(id)) return Promise.reject(new Error('bad conversation id'));
    if (!loadPty()) return Promise.resolve(noPty());
    const account = acctId(o.account);
    const old = terms.get(id);
    // nothing is ended when that account can't carry it on
    const why = sendToMissing(id, account, o.cwd || old?.cwd || null);
    if (why) { log(`send to ${account}: ${id} refused: ${why}`); return Promise.resolve({ ok: false, message: why }); }
    const gone = old && old.alive ? new Promise((r) => { old.dismissed = true; end(old, 2500, r); }) : Promise.resolve();
    return gone.then(() => {
      if (terms.get(id) === old) terms.delete(id);
      if (terms.get(id)?.alive) return { ok: false, message: 'it was started again meanwhile' };
      const note = `The user sent this conversation to account ${account} from Fleet View; the pickup carries on there`;
      const r = spawnPty(id, `${commandFor(id)} "/handoff ${note}"`, { ...o, account, cwd: o.cwd || old?.cwd || null }, {});
      log(`send to ${account}: ${id} ${r.ok ? `resumed with /handoff (pid ${r.pid})` : `failed: ${r.message}`}`);
      delete r.key;
      return r;
    });
  }

  // a new conversation: plain interactive `claude` in o.cwd (the caller has checked it), keyed new-<n>.
  // o.chrome true or false adds the fixed flag --chrome or --no-chrome (Claude in Chrome on or off); anything
  // else leaves the command as it is. No caller text ever goes into the command line. The reply echoes chrome
  // when a flag was added, so a caller can tell this host from an older one that ignores it.
  // o.forkFrom, a conversation id (hex and dashes only), starts `claude --resume <id> --fork-session` instead: a new
  // conversation that carries that one's history; the original stays as it was. The reply echoes forkFrom.
  // o.model (letters, digits, . - [ ] only) adds --model <m>, and o.effort (a level) --effort <e> in place of the set
  // one: for this session only, where /model and /effort typed in it would save them as the default for every new
  // session. The reply echoes both.
  function create(o) {
    if (!loadPty()) return noPty();
    o = o || {};
    const fork = typeof o.forkFrom === 'string' && ID_RE.test(o.forkFrom) ? o.forkFrom.toLowerCase() : null;
    const key = `new-${++newSeq}`;
    const flag = o.chrome === true ? ' --chrome' : o.chrome === false ? ' --no-chrome' : '';
    // the pid files already there are never this one
    const known = new Set(readPidFiles(dirs()).map((f) => f.pid));
    // a plain new conversation starts at the set effort, not at whatever /effort a session saved last
    const model = typeof o.model === 'string' && MODEL_RE.test(o.model) ? o.model : null;
    const asked = EFFORT_LEVELS.has(o.effort) ? o.effort : null;
    const effort = asked || (fork ? '' : newEffort(getSettings().newSessionEffort));
    const cmd = (fork ? `${commandFor(fork)} --fork-session` : newCommand) + (model ? ` --model ${model}` : '') + (effort ? ` --effort ${effort}` : '');
    const r = spawnPty(key, cmd + flag, o, { isNew: true, created: true, known, forkFrom: fork });
    if (r.ok && flag) r.chrome = o.chrome;
    if (r.ok && fork) r.forkFrom = fork;
    if (r.ok && model) r.model = model;
    if (r.ok && asked) r.effort = asked;
    return r;
  }

  // ---------- the sessions/<pid>.json scan: re-keys new sessions, gives every hosted one its status ----------
  let scanTimer = null, checking = false, noMapAt = 0;
  const verified = new Map(); // `${claudePid}:${ptyPid}` -> true | false
  function startScan() {
    if (scanTimer) return;
    scanTimer = setInterval(scan, SCAN_MS);
  }
  function rekey(t, f) {
    const old = t.id, id = f.sessionId;
    if (terms.get(old) !== t) return;
    if (terms.has(id) && terms.get(id).alive) { t.claudePid = f.pid; return; } // already hosted under that id (should not happen)
    flush(t); // output so far goes out under the old key, the rest under the new one
    terms.delete(old);
    t.id = id; t.isNew = false; t.claudePid = f.pid; t.status = f.status; t.waitingFor = f.status === 'waiting' ? f.waitingFor : null;
    terms.set(id, t);
    send('rekey', old, id);
    changed();
  }
  function scan() {
    const live = [...terms.values()].filter((t) => t.alive);
    if (!live.length) { clearInterval(scanTimer); scanTimer = null; return; }
    let files;
    try { files = readPidFiles(dirs()); } catch { return; }
    // status for the hosted ones: by the claude pid once known, else the newest file of that conversation
    let moved = false;
    const now = Date.now();
    for (const t of live) {
      const mine = files.filter((x) => (t.claudePid ? x.pid === t.claudePid : !t.isNew && x.sessionId === t.id.toLowerCase()));
      mine.sort((x, y) => y.updatedAt - x.updatedAt);
      // its claude is on another conversation now (/clear, /resume): the pty follows, unless that one is hosted
      if (t.claudePid && !t.isNew && mine.length && mine[0].sessionId !== t.id.toLowerCase() && !terms.has(mine[0].sessionId)) {
        rekey(t, mine[0]);
        continue; // rekey sent the status with the move
      }
      const f = mine.length ? mine[0] : null;
      const st = f ? f.status : null;
      const wf = st === 'waiting' ? f.waitingFor : null;
      // a file of the claude this pty started (not one left by a claude before it): only those say it has loaded
      const fresh = !!f && f.startedAt >= t.startedAt - 2000;
      if (fresh && st === 'idle') t.seenIdle = true;
      t.idleSince = fresh && st === 'idle' ? t.idleSince || now : 0;
      if (st !== t.status || wf !== t.waitingFor) {
        // a restored, interrupted one stops being "interrupted" once Claude works again (it was told to go on);
        // not on the 'busy' a resume says while it starts up, before it was ever idle
        if (t.interrupted && st === 'busy' && t.seenIdle) t.interrupted = false;
        t.status = st;
        t.waitingFor = wf;
        moved = true;
      }
    }
    if (moved) changed();
    for (const t of live) { if (t.alive) { panelTick(t, now); nudgeTick(t, now); } }
    const pend = live.filter((t) => t.isNew);
    // resumed ones not tied to their claude yet: the file with their id whose process runs in their pty (a
    // terminal elsewhere may have the same conversation open), so a later /clear or /resume can be followed
    const loose = live.filter((t) => !t.isNew && !t.claudePid);
    if (!pend.length && !loose.length) return;
    const claimed = new Set([...terms.values()].map((t) => t.claudePid).filter(Boolean));
    const cands = (t) => files.filter((f) => !claimed.has(f.pid) && !(t.known && t.known.has(f.pid)) && (!f.kind || f.kind === 'interactive')
      && f.startedAt >= t.startedAt - 2000 && !terms.has(f.sessionId));
    const unverified = [];
    for (const t of pend) {
      for (const f of cands(t)) {
        const v = verified.get(`${f.pid}:${t.pid}`);
        if (v === true) { rekey(t, f); claimed.add(f.pid); break; }
        if (v === undefined) unverified.push([t, f]);
      }
    }
    // no process list last time: the resumed ones wait a while before asking for it again
    for (const t of Date.now() - noMapAt > 30000 ? loose : []) {
      for (const f of files.filter((x) => x.sessionId === t.id.toLowerCase() && !claimed.has(x.pid))) {
        const v = verified.get(`${f.pid}:${t.pid}`);
        if (v === true) { t.claudePid = f.pid; claimed.add(f.pid); break; }
        if (v === undefined) unverified.push([t, f]);
      }
    }
    if (!unverified.length || checking) return;
    checking = true;
    parentMap((map) => {
      checking = false;
      if (!map) noMapAt = Date.now();
      for (const [t, f] of unverified) {
        if (!t.alive) continue;
        if (t.isNew) {
          // no process list: fall back to the folder (a claude started there after the pty, nobody else's)
          verified.set(`${f.pid}:${t.pid}`, map ? descends(map, f.pid, t.pid) : normDir(f.cwd) === normDir(t.cwd));
        } else if (!t.claudePid && map) {
          // a resumed one: only the process list can tell ours from a terminal elsewhere (no list: try again later)
          verified.set(`${f.pid}:${t.pid}`, descends(map, f.pid, t.pid));
        }
      }
      scan();
    });
  }

  function write(id, data) {
    const t = terms.get(id);
    if (!t || !t.alive || typeof data !== 'string' || !data) return;
    if (t.interrupted && data.includes('\r')) { t.interrupted = false; changed(); }
    if (!AUTO_REPLY_RE.test(data)) {
      t.inputAt = Date.now();
      // someone is at it: the note after a restore is theirs to send now
      if (t.nudge) { log(`auto-continue: ${t.id} cancelled (typed into)`); t.nudge = null; changed(); }
      track(t, data.length > 4096 ? data.slice(0, 4096) : data);
    }
    try { t.pty.write(data.length > 1 << 20 ? data.slice(0, 1 << 20) : data); } catch {}
  }

  // Roughly what is typed into the prompt since the last Enter (t.line, at most 200 characters), across writes:
  // the terminal sends keys one by one, the Chat tab a bracketed paste and then Enter on its own. A paste is
  // text (an Enter inside it is a newline); other escape sequences (arrows, Alt+key) are skipped; Backspace
  // takes one character off; Ctrl+C, Ctrl+U and Esc clear it. On Enter a line that starts with "/" and a letter
  // is a command that may open a panel: t.slash, for panelTick. Not while a dialog is open: the keys went to it.
  function track(t, data) {
    const add = (s) => { if (t.line.length < 200) t.line = (t.line + s).slice(0, 200); };
    let i = 0;
    while (i < data.length) {
      if (t.inPaste) {
        const end = data.indexOf('\x1b[201~', i);
        add(data.slice(i, end < 0 ? data.length : end).replace(/\r\n?/g, '\n'));
        if (end < 0) return;
        t.inPaste = false;
        i = end + 6;
        continue;
      }
      const ch = data[i];
      if (ch === '\x1b') {
        if (data.startsWith('\x1b[200~', i)) { t.inPaste = true; i += 6; continue; }
        const next = data[i + 1];
        if (next === undefined) { t.line = ''; return; } // Esc on its own
        if (next === '\r') { add('\n'); i += 2; continue; } // Alt+Enter: a new line in the prompt
        if (next === '[') { // CSI: parameters and intermediates up to the final byte
          let j = i + 2;
          while (j < data.length && !/[@-~]/.test(data[j])) j++;
          i = j + 1;
        } else i += next === 'O' ? 3 : 2; // SS3 (F1-F4, some arrows), or Alt+key
        continue;
      }
      if (ch === '\r') {
        const s = t.line.trimStart();
        if (/^\/[A-Za-z]/.test(s) && !(t.status === 'waiting' && t.waitingFor === 'dialog open')) t.slash = { cmd: s.split(/\s/)[0].slice(0, 40), at: Date.now(), seen: false, seenAt: 0, quietAt: 0, escs: 0, escAt: 0 };
        t.line = '';
      } else if (ch === '\x7f' || ch === '\b') t.line = t.line.slice(0, -1);
      else if (ch === '\x03' || ch === '\x15') t.line = '';
      else if (ch === '\n' || ch >= ' ') add(ch);
      i++;
    }
  }

  // A "/" command (t.slash) that opened a panel ("dialog open" in its pid file) is closed with Esc once nobody
  // has typed into it for panelCloseMs(): an open panel holds back background-task updates, so a /usage left
  // open stalls the session. A dialog no "/" command opened (trust, a startup notice) is never touched: Esc can
  // refuse those. Esc goes straight to the pty, as it is not the user's key.
  function panelTick(t, now) {
    const s = t.slash;
    if (!s) return;
    const open = t.status === 'waiting' && t.waitingFor === 'dialog open';
    if (open && !s.seen) { s.seen = true; s.seenAt = now; changed(); return; }
    if (!open) {
      if (s.seen) { t.slash = null; changed(); return; } // it closed (by hand, or the Esc below)
      // a command typed mid-turn runs after the turn; else one that opened nothing in 15 s opens nothing
      if (t.status === 'busy') s.quietAt = 0;
      else if (!s.quietAt) s.quietAt = now;
      else if (now - s.quietAt >= 15000) t.slash = null;
      return;
    }
    const closeMs = panelCloseMs();
    if (!closeMs) return;
    const inputAt = t.inputAt || 0;
    if (s.escs && inputAt > s.escAt) s.escs = 0; // someone is using it after all: start over
    const quiet = now - Math.max(inputAt, s.seenAt);
    if (!s.escs ? quiet < closeMs : now - s.escAt < ESC_GAP_MS) return;
    // still open after an Esc: a panel inside a panel, or a pid file that lags
    if (s.escs >= 3) { log(`panel: gave up closing ${s.cmd} in ${t.id}; still open after 3 Esc`); t.slash = null; changed(); return; }
    try { t.pty.write('\x1b'); } catch {}
    s.escs++;
    s.escAt = now;
    log(s.escs === 1 ? `panel: closed ${s.cmd} in ${t.id} after ${Math.round(quiet / 1000)} s with no keys` : `panel: ${s.cmd} in ${t.id} still open; Esc again (${s.escs})`);
  }

  // is a select menu up on its screen (a permission prompt, a question)? Then an Enter would pick an option
  function menuUp(t) {
    try {
      if (!screenLib) screenLib = require(path.join(__dirname, '..', 'screen.js'));
      return !!screenLib.menuShown(t.chunks.join(''), t.cols, t.rows);
    } catch (e) { log(`auto-continue: could not read the screen of ${t.id}: ${e.message}`); return true; }
  }

  // The note a resumed session gets once it has loaded (t.nudge = { kind, cause, file?, offset? }, from restore):
  // typed as a bracketed paste, checked again 300 ms later, then Enter.
  function noteFor(n) {
    if (n.kind === 'restart') return '[Fleet View] The session host restarted as you asked. Check that the newest "started:" line in %LOCALAPPDATA%\\fleet-view\\host.log shows the new version, then carry on.';
    if (n.kind === 'tasks') return `[Fleet View] Your background tasks stopped when ${n.cause}; the notes above say which. Check what they finished, start again what still needs to run, then carry on.`;
    return `[Fleet View] You were cut off mid-turn: ${n.cause}. Check what finished, then carry on.`;
  }
  const settled = (t, now) => t.alive && t.status === 'idle' && t.idleSince > 0 && now - t.idleSince >= NUDGE_IDLE_MS
    && now - (t.outAt || t.startedAt) >= NUDGE_QUIET_MS;
  function nudgeTick(t, now) {
    const n = t.nudge;
    if (!n || n.typing) return;
    const drop = (why) => { if (why) log(`auto-continue: ${t.id} ${why}`); t.nudge = null; changed(); };
    if (now - t.startedAt > nudgeGiveUpMs) return drop(`gave up: not ready ${Math.round(nudgeGiveUpMs / 1000)} s after it started`);
    if (t.seenIdle && t.status === 'busy') return drop('not needed: it started work');
    if (!settled(t, now)) return;
    if (n.kind === 'tasks') {
      // only what the resume wrote: a background task it reports stopped, that nothing answered
      if (!n.readyAt) n.readyAt = now;
      const found = n.file ? stoppedWork(n.file, n.offset || 0) : null;
      if (!found) { if (now - n.readyAt > NUDGE_TASKS_MS) drop(null); return; }
      if (found === 'interrupted') n.kind = 'interrupted';
    }
    if (menuUp(t)) return;
    n.typing = true;
    const at = Date.now();
    try { t.pty.write(`\x1b[200~${noteFor(n)}\x1b[201~`); } catch {}
    setTimeout(() => {
      if (!t.alive) return;
      const ok = t.nudge === n && t.status === 'idle' && (t.inputAt || 0) < at && !menuUp(t);
      if (!ok) {
        log(`auto-continue: ${t.id} note typed but not sent (${t.nudge !== n ? 'typed into' : t.status !== 'idle' ? `now ${t.status || 'unknown'}` : (t.inputAt || 0) >= at ? 'typed into' : 'a menu came up'})`);
        if (t.nudge === n) { t.nudge = null; changed(); }
        return;
      }
      try { t.pty.write('\r'); } catch {}
      t.interrupted = false;
      t.nudge = null;
      changed();
      log(`auto-continue: ${t.id} told to carry on (${n.kind})`);
    }, 300);
  }

  function resize(id, cols, rows) {
    const t = terms.get(id);
    if (!t || !t.alive) return;
    const c = intIn(cols, 2, 1000, 0), r = intIn(rows, 2, 500, 0);
    if (!c || !r) return;
    try { t.pty.resize(c, r); t.cols = c; t.rows = r; } catch {}
  }

  // Ask claude to quit the way a person would (Ctrl+C twice: claude reads it as a key in raw mode), so it
  // removes its ~/.claude/sessions/<pid>.json and finishes its log; whatever is still running after
  // `graceMs` loses its whole tree (taskkill /T /F). Calls done(t) once it is gone or given up on.
  function end(t, graceMs, done) {
    if (!t.alive) return done && done(t);
    let finished = false;
    const finish = () => { if (finished) return; finished = true; clearInterval(poll); if (done) done(t); };
    const poll = setInterval(() => { if (!t.alive) finish(); }, 50);
    try { t.pty.write('\x03'); } catch {}
    setTimeout(() => { if (t.alive) { try { t.pty.write('\x03'); } catch {} } }, 250);
    setTimeout(() => {
      if (!t.alive) return finish();
      treeKill(t.pid, false);
      setTimeout(() => { if (t.alive) { try { t.pty.kill(); } catch {} } finish(); }, 1500); // whatever taskkill missed
    }, graceMs);
  }

  // a running one: end it (above); the exit then goes out and it is forgotten.
  // An ended one: forget it now (the page's "Close" on the "Session ended" bar).
  function kill(id) {
    const t = terms.get(id);
    if (!t) return;
    if (!t.alive) { terms.delete(id); changed(); return; }
    if (t.dismissed) return; // already ending
    t.dismissed = true;
    end(t, 2500);
  }

  // all of them at once, the same way; resolves when they are gone
  function endAll(graceMs = 2500) {
    const live = [...terms.values()].filter((t) => t.alive);
    for (const t of live) t.dismissed = true;
    return Promise.all(live.map((t) => new Promise((r) => end(t, graceMs, r)))).then(() => killAll());
  }

  // the backstop: every tree that is left, synchronously. Once the ConPTY is closed here its exit event may
  // never come, so each one is marked ended and forgotten right away.
  function killAll() {
    for (const t of [...terms.values()]) {
      if (!t.alive) continue;
      t.dismissed = true;
      HO.takeRestart(t.launchKey); // a handoff it asked for is dropped: it never restarts after this
      treeKill(t.pid, true);
      try { t.pty.kill(); } catch {}
      if (!t.alive) continue; // its exit came in the meantime
      t.alive = false;
      flush(t);
      send('exit', t.id, null);
      terms.delete(t.id);
    }
    changed();
  }

  // pending: still keyed new-<n>; created: started by create() (a new conversation, maybe not in /state yet);
  // status: its pid file's "busy" / "idle" / "waiting" (null when unknown), waitingFor: what it waits for;
  // interrupted: resumed after Fleet View closed while it was mid-turn, nobody has told it to go on yet;
  // autoContinue: the note that tells it to go on is still due; slashPanel: the "/" command whose panel is open
  // (closed by itself after a while with no keys); cols, rows: the pty's size (api.js draws its screen)
  function list() {
    return [...terms.values()].map((t) => ({
      id: t.id, pid: t.pid, alive: t.alive, exitCode: t.alive ? null : t.exitCode, startedAt: t.startedAt,
      pending: !!t.isNew && !t.pickup, created: !!t.created, forkFrom: t.forkFrom || null, cwd: t.cwd, handoffFrom: t.handoffFrom || null, pickingUp: !!(t.isNew && t.pickup), account: t.account, status: t.alive ? t.status : null, claudePid: t.claudePid,
      waitingFor: t.alive && t.status === 'waiting' ? t.waitingFor : null, autoContinue: !!(t.alive && t.nudge),
      slashPanel: t.alive && t.slash && t.slash.seen && t.status === 'waiting' && t.waitingFor === 'dialog open' ? t.slash.cmd : null,
      interrupted: !!(t.alive && t.interrupted), restored: !!t.restored, cols: t.cols, rows: t.rows,
    }));
  }

  // mid-turn: working (or running a shell command), or waiting on a prompt inside a turn (a permission, a
  // question, the plan); an open "/" panel is not a turn
  const isBusy = (t) => t.status === 'busy' || t.status === 'shell' || (t.status === 'waiting' && t.waitingFor !== 'dialog open');

  // the ones to bring back after a restart: every running one, and one that ended without a clean exit (code
  // 0, e.g. /exit) and was not closed from the page. At a shutdown or reboot claude may die before this
  // process does, and its exit must not drop it from the list.
  function restoreList() {
    return [...terms.values()].filter((t) => !t.dismissed && (t.alive || (!t.isNew && t.exitCode !== 0))).map((t) => ({
      id: t.isNew ? null : t.id, cwd: t.cwd, account: t.account, startedAt: t.startedAt, busy: isBusy(t),
      interrupted: !!t.interrupted, cols: t.cols, rows: t.rows, ...(t.isNew ? { pendingKey: t.id } : {}),
      ...(t.isNew && t.pickup ? { pickup: t.pickup, handoffFrom: t.handoffFrom || null } : {}),
      ...(t.restartBy ? { restartBy: true } : {}),
    }));
  }

  // for the restart: the running sessions that are mid-turn, but the one with this CLAUDE_LAUNCH_KEY (the asker)
  const busyBut = (launchKey) => [...terms.values()].filter((t) => t.alive && isBusy(t) && !(launchKey && t.launchKey === launchKey)).map((t) => t.id);
  // marks the asker, so the next host tells it the restart is done; its id, or null when none is hosted here
  function markRestartBy(launchKey) {
    const t = launchKey ? [...terms.values()].find((x) => x.alive && x.launchKey === launchKey) : null;
    if (t) t.restartBy = true;
    return t ? t.id : null;
  }

  // everything kept so far. Pending output is sent first, so a client gets every chunk once: the ones it
  // received before the snapshot are in it, the ones after are new (see preload.js).
  function snapshot(id) {
    const t = terms.get(id);
    if (!t) return '';
    flush(t);
    return t.chunks.join('');
  }

  return { open, sendTo, create, startPickup, write, resize, kill, endAll, killAll, list, restoreList, busyBut, markRestartBy, snapshot, aliveCount, dirs };
}

// ---------- the host process ----------
function runHost() {
  const PIPE = pipeName();
  const TEST = isTestPipe();
  const DIR = dataDir();
  try { fs.mkdirSync(DIR, { recursive: true }); } catch {}
  const VERSION = fileHash(HOST_JS);
  const startedAt = Date.now();
  const token = crypto.randomBytes(32).toString('hex');
  const IDLE_MS = TEST && Number(process.env.FV_HOST_IDLE_MS) > 0 ? Number(process.env.FV_HOST_IDLE_MS) : 10 * 60 * 1000;
  const TEST_CMD = TEST && process.env.FV_TERM_CMD ? process.env.FV_TERM_CMD : null;
  const EXTRA_DIRS = TEST && process.env.FV_HOST_SESSIONS_DIR ? [process.env.FV_HOST_SESSIONS_DIR] : [];
  const testMs = (name) => (TEST && process.env[name] !== undefined && Number(process.env[name]) >= 0 ? Number(process.env[name]) : undefined);
  // started by a host that restarted itself: it may still hold the pipe for a moment
  const SUCCESSOR = /^\d{1,10}$/.test(process.env.FV_HOST_SUCCESSOR || '') ? Number(process.env.FV_HOST_SUCCESSOR) : null;

  function log(msg) {
    const line = `${new Date().toISOString()} [host ${process.pid}] ${msg}\n`;
    try {
      const f = logFile();
      try { if (fs.statSync(f).size > 1 << 20) fs.renameSync(f, `${f}.1`); } catch {}
      fs.appendFileSync(f, line);
    } catch {}
  }
  process.on('uncaughtException', (e) => log(`uncaught: ${e && e.stack ? e.stack : e}`));
  process.on('unhandledRejection', (e) => log(`unhandled rejection: ${e && e.stack ? e.stack : e}`));

  const clients = new Set(); // authed sockets
  function sendAll(msg) {
    const line = `${JSON.stringify(msg)}\n`;
    for (const c of clients) {
      if (c.sock.destroyed) continue;
      // a client that stopped reading must not grow this process without end
      if (c.sock.writableLength > 64 << 20) { log('a client stopped reading; dropping it'); c.sock.destroy(); continue; }
      c.sock.write(line);
    }
  }

  // ---------- restore list ----------
  let ui = null, frozen = false, saveTimer = null, sessionsTimer = null;
  function saveNow(reason) {
    clearTimeout(saveTimer); saveTimer = null;
    if (frozen && reason !== 'quit' && reason !== 'restart') return;
    try { writeJsonAtomic(sessionsFile(), { version: 1, savedAt: Date.now(), reason, hostPid: process.pid, sessions: ptys.restoreList(), ui }); } catch (e) { log(`could not write sessions.json: ${e.message}`); }
  }
  function changed() {
    if (!saveTimer && !frozen) saveTimer = setTimeout(() => saveNow('change'), 250);
    if (!sessionsTimer) sessionsTimer = setTimeout(() => { sessionsTimer = null; sendAll({ t: 'ev', e: 'sessions', list: ptys.list() }); }, 60);
  }

  const ptys = createPtys({
    send: (e, a, b) => {
      if (e === 'data') sendAll({ t: 'ev', e, id: a, d: b });
      else if (e === 'exit') sendAll({ t: 'ev', e, id: a, code: b });
      else if (e === 'rekey') sendAll({ t: 'ev', e, from: a, id: b });
    },
    changed,
    command: TEST_CMD ? () => TEST_CMD : undefined,
    newCommand: TEST_CMD || undefined,
    pickupCommand: TEST_CMD ? () => TEST_CMD : undefined,
    sessionDirs: EXTRA_DIRS,
    log,
    panelCloseMs: testMs('FV_HOST_PANEL_CLOSE_MS'),
    nudgeGiveUpMs: testMs('FV_HOST_NUDGE_GIVEUP_MS'),
  });

  // On start: resume every conversation the last list had running
  function restore() {
    const saved = readJson(sessionsFile());
    if (!saved || typeof saved !== 'object') return;
    if (saved.ui && typeof saved.ui === 'object') ui = saved.ui;
    const list = Array.isArray(saved.sessions) ? saved.sessions : [];
    if (!list.length) return;
    // a conversation some live claude already has open (a terminal resumed it meanwhile) is left alone;
    // pid files from before this boot are stale whatever their pid says now
    const bootAt = Date.now() - os.uptime() * 1000;
    const openNow = new Set(readPidFiles(ptys.dirs()).filter((f) => f.startedAt >= bootAt - 60000).map((f) => f.sessionId));
    // each resumed one is told to carry on once it has loaded (see Auto-continue), unless that is turned off
    const autoContinue = settings(true).autoContinue !== false;
    const cause = saved.reason === 'quit' ? 'Fleet View was quit' : saved.reason === 'restart' ? 'the session host restarted for an update'
      : 'the session host stopped (the PC shut down, or the host ended)';
    let n = 0;
    for (const s of list) {
      if (!s || typeof s !== 'object') continue;
      // a pickup that had no id yet: the conversation it started when the handoff names it, else the pickup again
      if (typeof s.pickup === 'string' && (typeof s.id !== 'string' || !ID_RE.test(s.id))) {
        const from = typeof s.handoffFrom === 'string' && ID_RE.test(s.handoffFrom) ? s.handoffFrom.toLowerCase() : null;
        const rec = from ? HO.readAll().bySession.get(from) : null;
        if (rec && rec.next) { s.id = rec.next; log(`restore: the handoff of ${from} was picked up as ${rec.next}`); }
        else {
          const file = HO.safeFile(s.pickup);
          let r = { ok: false, message: 'the handoff file is gone' };
          if (file) {
            try { r = ptys.startPickup(from, file, { cwd: s.cwd, account: acctId(s.account), cols: s.cols, rows: s.rows }, { restored: true, handoffFrom: from }); } catch (e) { r = { ok: false, message: e.message }; }
          }
          log(`restore: pickup of ${s.pickup} ${r.ok ? `started again (pid ${r.pid})` : `failed: ${r.message}`}`);
          if (r.ok) n++;
          continue;
        }
      }
      if (typeof s.id !== 'string' || !ID_RE.test(s.id)) { log(`restore: dropped a new session that never got an id (${s.pendingKey || '?'})`); continue; }
      const id = s.id.toLowerCase();
      if (openNow.has(id)) { log(`restore: ${id} is open in another claude; not resumed`); continue; }
      const interrupted = !!(s.busy || s.interrupted);
      let nudge = null;
      if (autoContinue) {
        nudge = { kind: s.restartBy ? 'restart' : interrupted ? 'interrupted' : 'tasks', cause };
        // an idle one only if its background tasks died with the host: the resume reports them stopped in the
        // transcript, after what is there now
        if (nudge.kind === 'tasks') {
          const tr = findTranscript(id, s.cwd);
          nudge = tr ? { ...nudge, file: tr.file, offset: tr.size } : null;
        }
      }
      let r;
      try {
        r = ptys.open({ id, cwd: s.cwd, account: acctId(s.account), cols: s.cols, rows: s.rows }, { interrupted, restored: true, nudge });
      } catch (e) { r = { ok: false, message: e.message }; }
      log(`restore: ${id} ${r.ok ? `resumed (pid ${r.pid})${interrupted ? ', was interrupted' : ''}${nudge ? `, note due (${nudge.kind})` : ''}` : `failed: ${r.message}`}`);
      if (r.ok) n++;
    }
    log(`restore: ${n} of ${list.length} resumed`);
  }

  // ---------- requests ----------
  let quitting = false;
  function quitAll(arg, reply) {
    if (quitting) return reply({ ok: true, message: 'already quitting' });
    if (restarting && restarting.going) return reply({ ok: true, message: 'restarting' }); // it saved and is ending them already
    if (restarting) { clearTimeout(restarting.timer); restarting = null; log('restart: cancelled by "quit everything"'); }
    quitting = true;
    if (arg && typeof arg.ui === 'object') ui = arg.ui;
    saveNow('quit'); // every running session, with whether it was busy, before they end
    frozen = true;
    const n = ptys.aliveCount();
    log(`quit everything: saved ${n} session(s) to the restore list, ending them`);
    ptys.endAll(2500).then(() => {
      reply({ ok: true, saved: n });
      log('quit everything: all ended; host exits');
      setTimeout(() => shutdown(0), 300);
    }, (e) => { ptys.killAll(); reply({ ok: true, saved: n, note: String(e) }); setTimeout(() => shutdown(0), 300); });
  }

  // `host.js --selfcheck` in a fresh process, as the next host would start: cb(null) when this file, what it
  // requires and a pty module all load, else cb(why). A broken host.js on disk must never end the sessions.
  function selfCheck(cb) {
    execFile(process.execPath, [HOST_JS, '--selfcheck'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 20000 }, (err, out, errOut) => {
      if (!err) return cb(null);
      const said = String(errOut || out || '').trim().split(/\r?\n/).slice(-3).join(' / ').slice(0, 400);
      cb(`${err.killed ? 'it did not finish in 20 s' : `exit ${err.code}`}${said ? `: ${said}` : ''}`);
    });
  }

  // restart({ now, by }): replies once the self-check passed, waits until no session but the asker (by, its
  // CLAUDE_LAUNCH_KEY) is mid-turn (now: not at all; at most 10 minutes), checks again, then saves the restore
  // list, ends every session and hands over to a new host, which resumes them.
  let restarting = null; // { by, now, timer, going }
  function restart(arg, reply) {
    if (quitting) return reply({ ok: false, message: 'the host is quitting' });
    if (restarting) return reply({ ok: true, message: 'already restarting' });
    const r = restarting = { by: arg.by, now: arg.now, timer: null, going: false };
    log(`restart: asked${r.by ? ` by ${r.by}` : ''}${r.now ? ', now' : ''}; checking the new host.js loads`);
    selfCheck((err) => {
      if (restarting !== r) return reply({ ok: false, message: 'cancelled' });
      if (err) { restarting = null; log(`restart: refused, the self-check failed (${err})`); return reply({ ok: false, message: `The new host.js failed its self-check: ${err}` }); }
      const waiting = r.now ? [] : ptys.busyBut(r.by);
      reply({ ok: true, waiting });
      const since = Date.now();
      let loggedAt = since;
      const tick = () => {
        if (restarting !== r) return;
        const busy = r.now ? [] : ptys.busyBut(r.by);
        if (busy.length && Date.now() - since < 10 * 60 * 1000) {
          if (Date.now() - loggedAt >= 60000) { loggedAt = Date.now(); log(`restart: still waiting on ${busy.join(', ')}`); }
          r.timer = setTimeout(tick, 2000);
          return;
        }
        if (busy.length) log(`restart: waited 10 minutes; restarting anyway (still busy: ${busy.join(', ')})`);
        // host.js may have changed again while it waited
        selfCheck((err2) => {
          if (restarting !== r) return;
          if (err2) { restarting = null; log(`restart: cancelled, the self-check failed (${err2})`); return; }
          handOver(r);
        });
      };
      if (waiting.length) log(`restart: waiting on ${waiting.join(', ')}`);
      tick();
    });
  }
  function handOver(r) {
    r.going = true;
    const asker = ptys.markRestartBy(r.by);
    saveNow('restart');
    frozen = true;
    log(`restart: saved ${ptys.aliveCount()} session(s) to the restore list${asker ? ` (asked from ${asker})` : ''}; ending them`);
    const next = () => {
      try {
        // the same electron.exe (or node) and file; FV_HOST_* test settings carry over (claude never sees FV_*)
        const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', FV_HOST_SUCCESSOR: String(process.pid) };
        const c = spawn(process.execPath, [HOST_JS], { detached: true, windowsHide: true, stdio: 'ignore', env, cwd: DIR });
        c.on('error', (e) => log(`restart: the next host failed: ${e.message}`));
        c.unref();
        log(`restart: started the next host (pid ${c.pid}); this one exits`);
      } catch (e) { log(`restart: could not start the next host: ${e.message}`); }
      shutdown(0);
    };
    ptys.endAll(2500).then(next, next);
  }

  function handle(c, msg) {
    if (msg.t !== 'req' || typeof msg.op !== 'string') return;
    const a = Array.isArray(msg.a) ? msg.a : [];
    const reply = (v) => { if (msg.n !== undefined && !c.sock.destroyed) c.sock.write(`${JSON.stringify({ t: 'res', n: msg.n, v })}\n`); };
    const fail = (e) => { if (msg.n !== undefined && !c.sock.destroyed) c.sock.write(`${JSON.stringify({ t: 'res', n: msg.n, err: String((e && e.message) || e) })}\n`); };
    try {
      switch (msg.op) {
        case 'open': {
          const o = a[0] && typeof a[0] === 'object' ? a[0] : {};
          return reply(ptys.open({ id: o.id, cwd: typeof o.cwd === 'string' ? o.cwd : null, account: acctId(o.account), cols: o.cols, rows: o.rows }));
        }
        case 'sendTo': {
          const o = a[0] && typeof a[0] === 'object' ? a[0] : {};
          return ptys.sendTo({ id: o.id, cwd: typeof o.cwd === 'string' ? o.cwd : null, account: acctId(o.account), cols: o.cols, rows: o.rows }).then(reply, fail);
        }
        case 'create': {
          const o = a[0] && typeof a[0] === 'object' ? a[0] : {};
          if (typeof o.cwd !== 'string' || !o.cwd) return reply({ ok: false, message: 'no folder given' });
          return reply(ptys.create({ cwd: o.cwd, account: acctId(o.account), cols: o.cols, rows: o.rows, chrome: typeof o.chrome === 'boolean' ? o.chrome : undefined,
            forkFrom: typeof o.forkFrom === 'string' && ID_RE.test(o.forkFrom) ? o.forkFrom : undefined,
            model: typeof o.model === 'string' && MODEL_RE.test(o.model) ? o.model : undefined, effort: EFFORT_LEVELS.has(o.effort) ? o.effort : undefined }));
        }
        case 'write': if (typeof a[0] === 'string' && KEY_RE.test(a[0])) ptys.write(a[0], a[1]); return reply(true);
        case 'resize': if (typeof a[0] === 'string' && KEY_RE.test(a[0])) ptys.resize(a[0], Number(a[1]), Number(a[2])); return reply(true);
        case 'kill': if (typeof a[0] === 'string' && KEY_RE.test(a[0])) ptys.kill(a[0]); return reply(true);
        case 'list': return reply(ptys.list());
        case 'snapshot': return reply(typeof a[0] === 'string' && KEY_RE.test(a[0]) ? ptys.snapshot(a[0]) : '');
        case 'endAll': return ptys.endAll(intIn(a[0], 0, 30000, 2500)).then(() => reply(true), fail);
        case 'killAll': ptys.killAll(); return reply(true);
        case 'setUi': {
          const u = a[0] && typeof a[0] === 'object' ? a[0] : {};
          ui = { selectedId: typeof u.selectedId === 'string' && KEY_RE.test(u.selectedId) ? u.selectedId : null, wide: !!u.wide };
          changed();
          return reply(true);
        }
        case 'quitAll': {
          const u = a[0] && a[0].ui && typeof a[0].ui === 'object' ? a[0].ui : null;
          return quitAll(u ? { ui: { selectedId: typeof u.selectedId === 'string' && KEY_RE.test(u.selectedId) ? u.selectedId : null, wide: !!u.wide } } : null, reply);
        }
        case 'restart': {
          const o = a[0] && typeof a[0] === 'object' ? a[0] : {};
          return restart({ now: o.now === true, by: typeof o.by === 'string' && o.by && o.by.length <= 100 ? o.by : null }, reply);
        }
        case 'log': log(`client ${c.pid || '?'}: ${String(a[0] || '').slice(0, 500)}`); return reply(true);
        default: return fail('unknown op');
      }
    } catch (e) { fail(e); }
  }

  let warnedHash = null;
  function onConnection(sock) {
    const c = { sock, authed: false, buf: '', pid: null };
    sock.setEncoding('utf8');
    const authTimer = setTimeout(() => { if (!c.authed) sock.destroy(); }, 5000);
    sock.on('data', (chunk) => {
      c.buf += chunk;
      if (c.buf.length > 8 << 20) { log('a client sent an oversized line; dropping it'); sock.destroy(); return; }
      let i;
      while ((i = c.buf.indexOf('\n')) >= 0) {
        const line = c.buf.slice(0, i);
        c.buf = c.buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { sock.destroy(); return; }
        if (!msg || typeof msg !== 'object') { sock.destroy(); return; }
        if (!c.authed) {
          const given = Buffer.from(typeof msg.token === 'string' ? msg.token : '');
          const want = Buffer.from(token);
          if (msg.t !== 'hello' || given.length !== want.length || !crypto.timingSafeEqual(given, want)) { sock.destroy(); return; }
          c.authed = true;
          c.pid = Number.isInteger(msg.pid) ? msg.pid : null;
          clearTimeout(authTimer);
          clients.add(c);
          const onDisk = fileHash(HOST_JS);
          if (onDisk && onDisk !== VERSION && onDisk !== warnedHash) {
            warnedHash = onDisk;
            log(`a newer host.js is on disk (${onDisk}, running ${VERSION}); it takes effect when the host next starts`);
          }
          log(`client connected (pid ${c.pid || '?'}), ${clients.size} now`);
          sock.write(`${JSON.stringify({ t: 'hello', ok: true, proto: PROTO, pid: process.pid, version: VERSION, onDisk, startedAt, ui, test: TEST })}\n`);
          sock.write(`${JSON.stringify({ t: 'ev', e: 'sessions', list: ptys.list() })}\n`);
          continue;
        }
        handle(c, msg);
      }
    });
    const gone = () => {
      clearTimeout(authTimer);
      if (clients.delete(c)) { log(`client disconnected (pid ${c.pid || '?'}), ${clients.size} left`); lastBusy = Date.now(); }
    };
    sock.on('close', gone);
    sock.on('error', gone);
  }

  // ---------- idle exit: no sessions and no clients for IDLE_MS ----------
  let lastBusy = Date.now();
  const idleTimer = setInterval(() => {
    if (clients.size || ptys.aliveCount() || quitting) { lastBusy = Date.now(); return; }
    if (Date.now() - lastBusy >= IDLE_MS) { log(`no sessions and no window for ${Math.round(IDLE_MS / 1000)} s; host exits`); shutdown(0); }
  }, Math.min(30000, Math.max(500, Math.floor(IDLE_MS / 4))));

  let server = null, down = false;
  function shutdown(code) {
    if (down) return;
    down = true;
    clearInterval(idleTimer);
    try { ptys.killAll(); } catch {}
    try { const h = readJson(hostFile()); if (h && h.pid === process.pid) fs.unlinkSync(hostFile()); } catch {}
    for (const c of clients) { try { c.sock.destroy(); } catch {} }
    try { server && server.close(); } catch {}
    setTimeout(() => process.exit(code), 100);
  }

  server = net.createServer(onConnection);
  // a successor waits for the host before it to let go of the pipe (it is ending its sessions); if the window
  // started a host of its own meanwhile, that one keeps it and this one exits, as usual
  const retryUntil = SUCCESSOR ? Date.now() + 15000 : 0;
  server.on('error', (e) => {
    if (e && e.code === 'EADDRINUSE' && Date.now() < retryUntil) {
      setTimeout(() => { try { server.close(); } catch {} server.listen(PIPE); }, 250);
      return;
    }
    if (e && e.code === 'EADDRINUSE') { log('another host already serves this pipe; exiting'); process.exit(0); }
    log(`pipe error: ${e && e.stack ? e.stack : e}`);
    process.exit(1);
  });
  server.listen(PIPE, () => {
    try {
      writeJsonAtomic(hostFile(), { pid: process.pid, pipe: PIPE, token, startedAt, version: VERSION });
    } catch (e) { log(`could not write host.json: ${e.message}`); process.exit(1); }
    loadPty();
    log(`started: pipe ${PIPE}, version ${VERSION}, node ${process.versions.node}${process.versions.electron ? `, electron ${process.versions.electron}` : ''}, pty ${ptyName || `none (${ptyError && ptyError.message})`}${TEST ? ', TEST' : ''}${TEST_CMD ? `, test command ${TEST_CMD}` : ''}${SUCCESSOR ? `, successor of ${SUCCESSOR}` : ''}`);
    try { restore(); } catch (e) { log(`restore failed: ${e && e.stack ? e.stack : e}`); }
  });
}

module.exports = {
  createPtys, sessionDirs, readPidFiles, normDir, pipeName, dataDir, hostFile, sessionsFile, logFile, fileHash, readJson,
  HOST_JS, ID_RE, KEY_RE, NEW_RE, PROTO, ptyName: () => ptyName, ptyError: () => ptyError,
};

// `host.js --selfcheck`: what a restart runs before it ends anything. Getting here means this file and
// handoff.js loaded; screen.js and a pty module must load too. Exit code 0 when they do, else 1.
function selfCheckMain() {
  try {
    require(path.join(__dirname, '..', 'screen.js'));
    if (!loadPty()) throw ptyError || new Error('no pty module');
    process.stdout.write(`selfcheck ok: pty ${ptyName}\n`);
  } catch (e) {
    process.stderr.write(`selfcheck failed: ${e && e.message ? e.message : e}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  if (process.argv.includes('--selfcheck')) selfCheckMain();
  else runHost();
}
