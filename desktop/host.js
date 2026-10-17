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
// with snapshot() and then follows the live output. What falls off the front of those 512 KB is played into a
// screen (screen.js createScreen), and snapshot() starts with that screen drawn again: ConPTY sends only the cells
// that change, so Claude Code's prompt box, drawn once, would otherwise be gone from a replay after a long turn
// (and with it the Chat tab's Unsend, Rewind and Fork: "Couldn't read the session's prompt").
//
// New sessions (create): a plain interactive `claude` in a repo folder, or a fork of a conversation (`claude
// --resume <id> --fork-session`: a new conversation with its history), keyed "new-<n>" until Claude Code
// says which conversation it is. Every interactive claude writes <config>/sessions/<pid>.json with its
// sessionId (~/.claude/sessions for account B, ~/.claude-<x>/sessions for the others; all are read, deduplicated by
// their real path). While any pty runs, those files are read every 800 ms (every 150 ms while one starts): a new file whose process descends
// from a pending pty's shell (checked once per candidate through Win32_Process; without that check, a file
// in the same folder started after the pty) re-keys the pty to its sessionId, and a rekey event goes out.
// The same scan gives each hosted session its status ("busy" / "idle", from the file), and follows a session
// whose claude moved to another conversation (/clear starts a new one, /resume opens another): when its
// process's file names another sessionId, the pty is re-keyed to it the same way.
//
// macOS and Linux: the same, with /bin/sh in a node-pty pty instead of cmd in ConPTY, the Unix socket
// <data dir>/host-<username>.sock (mode 600) instead of the pipe, ps instead of Win32_Process, and process-group
// kills instead of taskkill (../platform.js). Paths below say %LOCALAPPDATA%\fleet-view: on macOS that is
// ~/Library/Application Support/fleet-view.
//
// Talking to it: the named pipe \\.\pipe\fleet-view-host-<username>, newline-delimited JSON. A client's first
// line is { t: 'hello', token }, with the random token from %LOCALAPPDATA%\fleet-view\host.json
// ({ pid, pipe, token, startedAt, version }); anything else, or a wrong token, closes the connection. Then:
//   { t: 'req', n?, op, a: [args] }  ->  { t: 'res', n, v } or { t: 'res', n, err }   (no n: no reply)
//   ops: open(o), create(o) (o.chrome, o.forkFrom, o.model, o.effort, o.role: see create below), write(id, data), resize(id, cols, rows), kill(id), list(), snapshot(id),
//        endAll(graceMs), killAll(), setUi(ui), quitAll({ ui }), restart({ now, by }) (see Restart), log(text), parked(),
//        sendTo(o), switchAccount({ id, account, rescue }) (see Switching accounts)
//   write answers true, or { ok: false, reason } when nothing (or not all of it) was typed: 'not found', 'ended',
//   'ending' (a restart, a quit or a close is ending it), 'truncated' (past 1 MB in one write)
//   events: { t: 'ev', e: 'data', id, d } / { e: 'exit', id, code } / { e: 'rekey', from, id } / { e: 'sessions', list }
// list() gives each session: id, pid, alive, exitCode, startedAt, pending, created, forkFrom, cwd, handoffFrom,
// pickingUp, account, status, waitingFor (what its pid file says it waits for, while waiting), claudePid,
// interrupted, restored, autoContinue (a note is due, see below), slashPanel (the "/" command whose panel is
// open, see Panels), role ('bot:<id>' or null, see Roles), cols, rows, moving (a switchAccount is ending it).
// The pipe is the lock: a second host finds the name taken and exits. The pipe keeps the default ACL (the
// user, SYSTEM and administrators), and the token keeps out anything that did not read the user's own folder.
//
// Away (sync's "Continue here", ../sync-move.js): a conversation another device owns, or one moving there, is
// listed in <data dir>/sync/away.json (the server's sync runner keeps it; see awayOf). open() and sendTo() of such a
// conversation start, end and write nothing, and answer the value (not an error)
//   { ok: false, away: { device }, message: 'This conversation is on <device>: use Continue here' }
// One already running here is still attached to by open() ('already running'): the mover ends it. A restore skips
// such conversations, with a log line. Every client (the window, live.js's remote browsers, api.js) gets that value.
//
// Restore list: %LOCALAPPDATA%\fleet-view\sessions.json is rewritten on every change:
//   { reason, sessions: [{ id, cwd, account, startedAt, busy, interrupted, cols, rows, pendingKey?, pickup?, handoffFrom?, restartBy?, role?, draft? }],
//     ui: { selectedId, wide } }   (pickup / handoffFrom: a handoff's pickup that had no id yet, see Handoffs; draft: its
//     unsent text, see Unsent text)
// Each save first copies the file it replaces to sessions.json.bak; one that does not parse when a host starts is moved
// aside to sessions.json.corrupt-<ms> (never written over) and the .bak resumed instead.
// busy: working, or waiting on a prompt mid-turn (anything but an open "/" panel). "Quit everything" (the tray)
// writes it with every running session and freezes it, then ends them all and the host exits. A reboot leaves
// the last one written (a session whose claude died first, with a non-zero
// exit, stays in it; one closed from the page, or that exited cleanly, leaves it). When a host starts, it brings the
// listed conversations back (claude --resume) and marks the ones that were busy as interrupted (list() says interrupted
// until Claude starts work again or Enter is typed); new sessions that never got an id are dropped, and so is a
// conversation another device has (see Away); one a live claude elsewhere has open waits (see below).
// The restore runs after the pipe listens and never blocks it: its own work goes in short turns (RESTORE_SLICE_MS), the
// handoff files are read ahead without blocking before HO.readAll() reads them (warmHandoffs), and the starts go at most
// RESTORE_CONCURRENT loading at once (a start holds its slot until its claude first says idle, RESTORE_SLOT_MS at most),
// two starts at least RESTORE_GAP_MS apart (each open() is ~0.3-0.5 s of synchronous work), so a client is let in and
// answered throughout and 40 sessions never start at once (2026-10-13: a 12 s synchronous restore made the window take
// the host for stuck, kill it and start another, five times in 71 s; 2026-10-16: 10 s of cold synchronous handoff reads
// before the first start did it once more). Tests: FV_HOST_RESTORE_GAP_MS, FV_HOST_RESTORE_SLOT_MS,
// FV_HOST_RESTORE_CONCURRENT. Started straight away, in restoreOrder: the restart asker (restartBy) and the conversation
// the window showed (ui.selectedId); then the RESTORE_FIRST most recently active (their transcript's mtime) of the rest;
// then the busy or interrupted ones; bots (role) and pickups; idle ones whose transcript
// shows background tasks still running (runningTasks, read before the resume reports them stopped), or whose log ends
// mid-turn (openTurn: saved idle only because claude died first, as at a shutdown; resumed as interrupted). Those two
// checks run alongside the starts, and one they find joins the queue. Every other idle
// one is parked: not started, kept in the restore list (parked: true) across saves and hosts until it is opened, and
// then resumed as the restore would have (its saved folder, account and role). open() or sendTo() of one still waiting
// (parked, or its turn not come) starts it at once and takes it out of the queue; kill() of one forgets it; a quit or
// restart mid-restore stops the queue and saves the rest as they were. parked() lists the waiting ones; list() only
// running ones, so a parked conversation is, to every client, one not running here that opens on a click.
// "restoreIdle": true in ~/.fleet-view.json starts the idle ones too (after the others, at the same pace).
// One a live claude elsewhere still has open (at the start or in its turn), or whose start fails, is not dropped: it
// stays held and is tried once more RESTORE_RETRY_MS later (FV_HOST_RESTORE_RETRY_MS in tests), as a claude of a host
// that was killed dies a few seconds after it; if that fails too it is parked until opened. One on another device
// (Away) is still dropped.
//
// Auto-continue: `claude --resume` starts no turn, so a conversation cut off mid-turn, or whose background tasks
// died with the host, would sit idle for good. Each resumed one gets a one-line "[Fleet View] …" note typed into
// it (bracketed paste, then Enter) once it has loaded: idle for 2.5 s by its own pid file, no output for 1.5 s,
// and no menu on screen (../screen.js). It goes to one that was busy or interrupted, to the one that asked for a
// restart (restartBy), and to an idle one whose transcript, in what the resume wrote, shows a background task
// stopped or killed (a <task-notification>) that nothing answered; it looks for that for 20 s, then lets it be.
// Any key typed into the session first, the session starting work by itself, or 3 minutes without getting
// ready drops the note. A session that stalls while it runs (idle 2 minutes, no key typed, its log ending mid-turn)
// gets a note too (stallTick). "autoContinue": false in ~/.fleet-view.json turns it off.
//
// Panels: while a panel is open (/usage, /config, a picker) Claude Code holds back background-task updates, so
// one left open stalls the session. The host follows what is typed into each prompt; when a "/" command opened
// a panel ("dialog open" in the pid file) and no key came for a minute ("panelAutoCloseSec" in
// ~/.fleet-view.json, 0 = never), it sends Esc, at most 3 times, never two within 3 s (two quick Escs at the
// prompt open the rewind menu). A dialog no "/" command opened (trust, a notice at startup) is never touched.
//
// Restart: restart({ now, by }) (desktop/restart-host.js asks for it) runs `host.js --selfcheck` (this file, what
// it requires and a pty module load in a fresh process) and refuses if that fails; else it replies at once and
// waits (not with now) until no session but the asking one (by: its CLAUDE_LAUNCH_KEY) is busy: one working is
// never cut off, however long it takes; one waiting on an answer (a permission, a question) gets 10 minutes, then
// is ended, resumed and told to carry on, so its question comes back. One idle at its prompt whose background tasks
// still run (a subagent, a Monitor, a shell task: runningTasks of its transcript, read again at most every
// TASKS_LOOK_MS) gets the same 10 minutes for them to finish; past that it is ended too, and resumed and told its
// tasks stopped (Auto-continue). The reply names both kinds (waiting, tasks). It checks again (the self-check again, then the
// pid files as they are then: one that started work meanwhile is waited for), starts the next host
// (FV_HOST_SUCCESSOR=<pid>: it waits up to 60 s for the pipe instead of exiting, and ends a predecessor still holding it
// after 30 s), saves the restore list (reason 'restart', the asker marked restartBy), ends every session and exits; the
// next host then takes the pipe and resumes them. Ending never blocks the host, never takes it over END_WATCHDOG_MS,
// and a session mid-turn gets no Ctrl+C (see endAll). "Quit everything" while it waits cancels it.
//
// Unsent text: Claude Code takes the Ctrl+C that ends an idle session as "clear the prompt", so text typed into its box
// and not sent would be gone after a restart or a quit. Before either ends them, each one typed into here has its box
// read off its screen (draftOf) and saved with it in the restore list (draft); the restore hands it to the resumed one
// (a parked one keeps it until opened), which types it back as a bracketed paste with no Enter once it has loaded and
// is at rest, after the note when one is due (draftTick). A key typed into it first drops the text. What Claude Code
// draws in place of text (a long paste's "[Pasted text #1 …]", an image's "[Image #1]") comes back as those words.
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
// handoff names it (next_session), else runs the pickup again. So is one whose request is there when the list is
// saved (a restart or "Quit everything" in the seconds before its kill: it looks idle then): the next host starts
// its pickup, never the old conversation (2026-10-15: a restart went ahead 6 s after a handoff and parked it). A
// restore also starts the pickup of a listed conversation whose log stops right after a handoff nothing picked up
// (leftHandoff: the same loss when the list was saved before the request, e.g. the PC went down).
//
// Roles: create({ role: 'bot:<id>' }) (id: 12 lowercase hex, which the server makes) starts one of the user's bots
// (../bots.js), the sessions that oversee the others for the user. Any other value is ignored, the old 'chief' too
// (a restore list that still has one starts it as an ordinary session). A bot gets the usual fv commands; the server
// keeps each bot to one session. The role stays with the session: through a re-key, in the
// restore list (a host that resumes it gives it back), when it is opened again after it ended, sent to another
// account, and when it hands off (the pickup gets it). A /clear keeps it; a /resume of an older conversation (one
// begun more than ROLE_NEW_MS ago) drops it, so an old conversation never takes a role by being resumed there.
//
// Switching accounts (the server's "Switch accounts when one runs low", ../account-switch.js): switchAccount({ id,
// account, rescue }) ends a running conversation at a pause and resumes the same conversation under the other account,
// under the same key (no exit goes out, the panel stays on it), with its role, folder and size; with rescue it is told
// "continue" once it has loaded. It refuses (a value, not an error) one that is busy, waiting, typed into, or away.
//
// It logs to %LOCALAPPDATA%\fleet-view\host.log, and exits by itself only after 10 minutes with no session and
// no client. A changed host.js on disk takes effect when the host next starts; until then it logs that once.
// `node desktop/restart-host.js` asks it to restart (see Restart).
//
// Tests only: FV_HOST_PIPE=\\.\pipe\fleet-view-host-<name> uses another pipe, and its files go in
// %LOCALAPPDATA%\fleet-view\test-<name> (or FV_HOST_DIR); only with such a pipe does it honour FV_TERM_CMD (a
// harmless command in place of `claude`, given the same arguments), FV_HOST_SESSIONS_DIR (one more folder of pid files),
// FV_HOST_IDLE_MS, FV_HOST_SETTINGS (another settings file), FV_HOST_PROJECTS_DIR (where transcripts are, instead
// of ~/.claude*/projects), FV_HOST_NUDGE_GIVEUP_MS, FV_HOST_STALL_IDLE_MS, FV_HOST_STALL_LOOK_MS, FV_HOST_PANEL_CLOSE_MS, FV_HOST_RESTORE_GAP_MS, FV_HOST_RESTORE_SLOT_MS,
// FV_HOST_RESTORE_CONCURRENT, FV_HOST_RESTORE_RETRY_MS and FV_HOST_TEST_END_HANG (a restart's end phase never finishes, see handOver).
// desktop/host-test.js and desktop/host-restore-test.js use them.
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const HO = require(path.join(__dirname, '..', 'handoff.js'));
const P = require(path.join(__dirname, '..', 'platform.js'));

const ID_RE = /^[0-9a-f-]{36}$/i;
const NEW_RE = /^new-\d{1,9}$/; // a new session's key until Claude Code reports its id
const KEY_RE = /^(?:[0-9a-f-]{36}|new-\d{1,9})$/i;
const SCAN_MS = 800;
const SCAN_FAST_MS = 150, SCAN_FAST_FOR_MS = 60 * 1000, SCAN_FIRST_TURN_MS = 15 * 1000; // the scan while a session starts (see startScan)
const BUFFER_MAX = 512 * 1024; // characters of output kept per pty for snapshot()
const KEYFRAME_LINES = 1000; // lines (scrollback and screen) the screen of what fell off that output keeps
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
// a live session idle this long, with no key typed, whose log ends mid-turn is told to carry on (see stallTick);
// its log is looked at no more often than STALL_LOOK_MS, and a session gets at most STALL_MAX notes an hour
const STALL_IDLE_MS = 2 * 60 * 1000, STALL_LOOK_MS = 30 * 1000, STALL_MAX = 3;
// a restart that waits on an idle session's background tasks (see Restart) reads its transcript again at most this often
const TASKS_LOOK_MS = 30 * 1000;
// unsent text kept for a session across a restart or a quit (see Unsent text): at most this many characters
const DRAFT_MAX = 20000;
// a restore (see Restore list): after the restart asker and the shown one, the RESTORE_FIRST most recently used ones
// start first; at most RESTORE_CONCURRENT load at once (a start's slot is freed when its claude says idle, or
// RESTORE_SLOT_MS after it began); two starts at least RESTORE_GAP_MS apart; its own work in turns of about
// RESTORE_SLICE_MS at most, yielding in between
const RESTORE_FIRST = 3;
const RESTORE_CONCURRENT = 3;
const RESTORE_GAP_MS = 250;
const RESTORE_SLOT_MS = 10000;
const RESTORE_SLICE_MS = 15;
const RESTORE_RETRY_MS = 15000; // a restore tries one it could not start once more this much later (see Restore list)
const END_GAP_MS = P.isWin ? 40 : 0; // between two Ctrl+Cs when every session ends at once (see endAll)
const OUT_BUSY_MS = 3000; // a session with no status known that wrote output this recently is working (see midTurn)
const END_WATCHDOG_MS = 8000; // a restart or a quit moves on this long after it began ending the sessions, whatever happens
const SUCCESSOR_WAIT_MS = 60000; // a successor waits this long for the pipe (see Restart)
const PREDECESSOR_STUCK_MS = 30000; // and ends a predecessor that still holds it after this long

// ---------- where things live ----------
const userTag = () => { let u = ''; try { u = os.userInfo().username; } catch {} return (u || process.env.USERNAME || 'user').replace(/[^\w.-]/g, '_').slice(0, 60); };
// Windows: the named pipe \\.\pipe\fleet-view-host-<user>. macOS and Linux: the Unix socket
// <data dir>/host-<user>.sock (platform.js hostSocketPath). A test pipe is \\.\pipe\fleet-view-host-<name> on
// Windows, else a socket file anywhere named fleet-view-host-<name>.sock (at most 100 bytes of path)
const REAL_PIPE = P.hostSocketPath(userTag());
const TEST_PIPE_RE = P.isWin ? /^\\\\\.\\pipe\\fleet-view-host-[\w.-]{1,60}$/ : /^\/(?:.*\/)?fleet-view-host-[\w.-]{1,60}\.sock$/;
function pipeName() {
  const p = process.env.FV_HOST_PIPE;
  return p && TEST_PIPE_RE.test(p) && (P.isWin || Buffer.byteLength(p) <= 100) ? p : REAL_PIPE;
}
const isTestPipe = () => pipeName() !== REAL_PIPE;
function dataDir() {
  const base = P.dataDir();
  if (!isTestPipe()) return base;
  const name = P.isWin ? pipeName().split('\\').pop() : path.basename(pipeName(), '.sock');
  return process.env.FV_HOST_DIR || path.join(base, `test-${name}`);
}
const hostFile = () => path.join(dataDir(), 'host.json');
const sessionsFile = () => path.join(dataDir(), 'sessions.json');
const logFile = () => path.join(dataDir(), 'host.log');
const HOST_JS = __filename;

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
// (macOS and Linux: readable by the user alone, like the folder %LOCALAPPDATA% is on Windows: host.json holds the token)
function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true, ...(P.isWin ? {} : { mode: 0o700 }) });
  const tmp = `${file}.${process.pid}.tmp`;
  // on disk before the rename: a power cut can keep the rename and lose unflushed data, leaving an empty file
  // where the restore list was (2026-10-10: the PC went down and the next host resumed nothing)
  const fd = fs.openSync(tmp, 'w', P.isWin ? undefined : 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(obj, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}
function fileHash(file) { try { return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 12); } catch { return null; } }

// ~/.fleet-view.json, the Fleet View server's settings. The server writes it and keeps keys it does not know,
// so this only ever reads it: autoContinue (false: no notes after a restore), panelAutoCloseSec (0: never),
// newSessionEffort (see newEffort), restoreIdle (true: a restore starts idle conversations too, see Restore list).
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
  const at = (f) => { try { const st = fs.statSync(f); return st.isFile() ? { file: f, size: st.size, mtimeMs: st.mtimeMs } : null; } catch { return null; } };
  const slug = typeof cwd === 'string' && cwd ? cwd.replace(/[^A-Za-z0-9]/g, '-') : '';
  for (const root of roots) { const r = slug && at(path.join(root, slug, name)); if (r) return r; }
  for (const root of roots) {
    let dirs = [];
    try { dirs = fs.readdirSync(root); } catch { continue; }
    for (const d of dirs) { const r = at(path.join(root, d, name)); if (r) return r; }
  }
  return null;
}
// when a conversation began: the first timestamp in its transcript's first 8 KB, else the file's birth time; null
// when it has no transcript yet
function transcriptStart(id, cwd) {
  const hit = findTranscript(id, cwd);
  if (!hit) return null;
  let fd = null;
  try {
    fd = fs.openSync(hit.file, 'r');
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.toString('utf8', 0, n).split('\n')) {
      const m = /^\{.*?"timestamp"\s*:\s*"([^"]+)"/.exec(line);
      const at = m ? Date.parse(m[1]) : NaN;
      if (Number.isFinite(at)) return at;
    }
  } catch {} finally { if (fd !== null) { try { fs.closeSync(fd); } catch {} } }
  try { return fs.statSync(hit.file).birthtimeMs || null; } catch { return null; }
}
// The permission mode a conversation last ran in, as `claude --permission-mode` names it: the last "permissionMode"
// its transcript records (Claude Code writes one on each prompt), read from the end 1 MiB at a time; null when there is
// none, and the account's default stands. `claude --resume` starts in the account's default mode, not the
// conversation's, so a chat running in bypass on the PC came back in auto on the Mac (Henry, 2026-10-12: a chat keeps
// its own mode on every machine). The transcript's "default" is the command line's "manual"; a mode not named here
// gives null, so nothing but these fixed words goes into the command line.
const RESUME_MODES = { default: 'manual', manual: 'manual', acceptEdits: 'acceptEdits', auto: 'auto', bypassPermissions: 'bypassPermissions', dontAsk: 'dontAsk', plan: 'plan' };
function lastModeOf(id, cwd) {
  const hit = findTranscript(id, cwd);
  if (!hit) return null;
  const CHUNK = 1 << 20, OVERLAP = 64; // the overlap keeps a record cut at a chunk's edge whole in the chunk before it
  let fd = null;
  try {
    fd = fs.openSync(hit.file, 'r');
    for (let end = hit.size; end > 0;) {
      const start = Math.max(0, end - CHUNK);
      const buf = Buffer.alloc(end - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      // a record's own key: quoted as JSON writes it (inside a tool's output text the quotes are escaped, \")
      const re = /"permissionMode":"([A-Za-z]+)"/g;
      let m, last = null;
      while ((m = re.exec(buf.toString('utf8')))) last = m[1];
      if (last) return Object.prototype.hasOwnProperty.call(RESUME_MODES, last) ? RESUME_MODES[last] : null;
      if (start === 0) break;
      end = start + OVERLAP;
    }
  } catch {} finally { if (fd !== null) { try { fs.closeSync(fd); } catch {} } }
  return null;
}
const modeFlag = (id, cwd) => { const m = lastModeOf(id, cwd); return m ? ` --permission-mode ${m}` : ''; };

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

// How many background tasks a transcript says still run, from its last 8 MB, as conversation.js keeps them (L.bg):
// launched (a tool result whose toolUseResult has backgroundTaskId, or taskId / agentId when async_launched or from
// a Monitor) with no <task-notification> status for it after, no TaskStop (KillShell) of it, and under a day old (a
// monitor with a timeout: until then). A restore asks this before the resume, which then reports them stopped.
const BG_MAX_MS = 24 * 3600e3;
function runningTasks(file, now = Date.now()) {
  let text = '';
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size, len = Math.min(size, 8 << 20);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      text = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return 0; }
  const uses = new Map(), bg = new Map(); // tool_use id -> 'monitor' | 'stop:<task id>'; task id -> running until
  const KEYS_RE = /"name":"(?:Monitor|TaskStop|KillShell)"|backgroundTaskId|async_launched|"taskId"/;
  for (const line of text.split('\n')) {
    if (line.includes('task-notification')) {
      for (const m of line.matchAll(/<task-id>([^<]+)<\/task-id>[\s\S]*?<status>(\w+)<\/status>/g)) if (m[2] !== 'running') bg.delete(m[1].trim());
    }
    if (!KEYS_RE.test(line) && !(uses.size && [...uses.keys()].some((k) => line.includes(k)))) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (!d || typeof d !== 'object' || d.isSidechain || !d.message || !Array.isArray(d.message.content)) continue;
    for (const b of d.message.content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_use' && typeof b.id === 'string') {
        const i = b.input && typeof b.input === 'object' ? b.input : {};
        const tid = i.task_id || i.shell_id;
        if (b.name === 'Monitor') uses.set(b.id, 'monitor');
        else if ((b.name === 'TaskStop' || b.name === 'KillShell') && typeof tid === 'string') uses.set(b.id, `stop:${tid}`);
      } else if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        const u = uses.get(b.tool_use_id) || '', r = d.toolUseResult;
        uses.delete(b.tool_use_id);
        if (u.startsWith('stop:')) { if (!b.is_error) bg.delete(u.slice(5)); continue; }
        if (!r || typeof r !== 'object') continue;
        const tid = r.backgroundTaskId || (r.status === 'async_launched' || u === 'monitor' ? r.taskId || r.agentId : null);
        if (typeof tid !== 'string' || !tid) continue;
        const t = Date.parse(d.timestamp) || now;
        bg.set(tid, u === 'monitor' && !r.persistent && Number.isFinite(r.timeoutMs) ? t + r.timeoutMs : t + BG_MAX_MS);
      }
    }
  }
  return [...bg.values()].filter((until) => until > now).length;
}

// Unsent text as the restore list keeps it (see Unsent text): line breaks as \n, no other control characters (it goes
// back in as a bracketed paste, which an Esc in it would end early), at most DRAFT_MAX characters; null when empty
function cleanDraft(v) {
  if (typeof v !== 'string') return null;
  const s = v.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').slice(0, DRAFT_MAX).trim();
  return s || null;
}

// Was the transcript's last turn left open: its last real entry (from the end 2 MB, the main thread only) a tool call
// with no answer (an assistant entry that stopped for tool_use) or a tool's result with no reply after it? That is a
// turn cut off mid-way (the PC went down, claude died, a stream broke), never one that ended: an ended turn's last
// entry is the assistant's (end_turn), and one stopped with Esc ends on "[Request interrupted by user…]". Claude
// Code's own filler ('<synthetic>', "No response requested.") and entries that are not user or assistant are passed
// over. A user prompt that never got an answer does not count: a /command's output looks just like one.
const recentLog = (file, now = Date.now()) => { try { return now - fs.statSync(file).mtimeMs < 24 * 3600e3; } catch { return false; } };

// The handoff a conversation left that nothing picked up, when it was the last thing it did: its newest handoff file
// (all: HO.readAll()) has no next session, was written in the last day, and the conversation's log stops within
// HANDOFF_TAIL_MS after it (the handoff's tool result and last words). Its restart was lost: a restart or a shutdown
// ended it in the seconds between the handoff and the kill that starts the pickup. A conversation that went on after
// its handoff (opened and typed into) is left alone. Returns the handoff file (checked by HO.safeFile) or null
const HANDOFF_TAIL_MS = 2 * 60e3;
function leftHandoff(id, cwd, all, now = Date.now()) {
  const rec = all.bySession.get(id);
  const file = rec && !rec.next ? HO.safeFile(rec.file) : null;
  if (!file) return null;
  try {
    const at = fs.statSync(file).mtimeMs;
    if (now - at >= 24 * 3600e3) return null;
    const tr = findTranscript(id, cwd);
    return tr && fs.statSync(tr.file).mtimeMs - at <= HANDOFF_TAIL_MS ? file : null;
  } catch { return null; }
}
function openTurn(file) {
  let text = '';
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size, len = Math.min(size, 2 << 20);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      text = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return false; }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || typeof e !== 'object' || e.isSidechain || !e.message || typeof e.message !== 'object') continue;
    const c = e.message.content;
    const blocks = Array.isArray(c) ? c.filter((b) => b && typeof b === 'object') : [];
    if (e.type === 'assistant') {
      const said = blocks.filter((b) => b.type === 'text').map((b) => String(b.text || '').trim());
      if (e.message.model === '<synthetic>' || (said.length && said.every((s) => s === 'No response requested.'))) continue;
      return e.message.stop_reason === 'tool_use' || blocks.some((b) => b.type === 'tool_use');
    }
    if (e.type !== 'user' || e.isMeta) continue;
    const results = blocks.filter((b) => b.type === 'tool_result');
    if (!results.length) return false;
    const said = (b) => (typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((x) => (x && x.text) || '').join(' ') : '');
    return !results.some((b) => /interrupted by user|doesn't want to proceed/i.test(said(b)));
  }
  return false;
}

// ---------- the restore's order and pace (see Restore list) ----------
// The order a restore starts its queue in. items: [{ key, tier, at }], tier 0 the restart asker and the shown one, 1 busy
// or interrupted, 2 bots and pickups, 3 idle with background tasks running, 4 idle (restoreIdle); at: its last activity
// (its transcript's mtime). Tier 0 first, in the list's order; then the `first` most recently active of the rest; then
// the others by tier, the most recent first within one. A new array; the items are left as they are.
function restoreOrder(items, first = RESTORE_FIRST) {
  const top = items.filter((x) => x.tier === 0);
  const rest = items.filter((x) => x.tier !== 0).sort((a, b) => (b.at || 0) - (a.at || 0));
  const n = Math.max(0, Math.floor(Number(first) || 0));
  return [...top, ...rest.slice(0, n), ...rest.slice(n).sort((a, b) => a.tier - b.tier || (b.at || 0) - (a.at || 0))];
}

// Starts a restore's queue. o.pending: the items to start (the caller may push more onto it meanwhile, while o.more()
// says more may come), started in restoreOrder, its `first` going down as each one past tier 0 starts; at most o.limit
// load at once (a start holds its slot until o.loaded(pid) or o.slotMs after it began); two starts at least o.gap ms
// apart, never two in one turn of the event loop. One o.held(item) no longer holds (opened or closed meanwhile) leaves
// the queue with no wait (o.gone(item)). o.start(item) -> { r: 'ok' | 'failed' | 'skipped', pid? } (skipped: not tried,
// so no gap after it). o.stopped() ends it at once. o.now and o.sleep (a clock and a timer) are for tests.
// Resolves { n: how many started, last: when the last one tried was, stopped }.
async function startPool(o) {
  const now = o.now || Date.now, sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))), poll = o.poll || 100;
  const pending = o.pending, loading = []; // loading: [{ pid, at }]
  let first = o.first ?? RESTORE_FIRST, n = 0, last = -Infinity;
  for (;;) {
    if (o.stopped()) return { n, last, stopped: true };
    for (let i = pending.length - 1; i >= 0; i--) if (!o.held(pending[i])) { const [g] = pending.splice(i, 1); if (o.gone) o.gone(g); }
    const t = now();
    for (let i = loading.length - 1; i >= 0; i--) if (t - loading[i].at >= o.slotMs || o.loaded(loading[i].pid)) loading.splice(i, 1);
    if (!pending.length) {
      if (!o.more()) return { n, last, stopped: false };
      await sleep(poll);
      continue;
    }
    const wait = loading.length >= o.limit ? poll : last + o.gap - t;
    if (wait > 0) { await sleep(Math.min(wait, poll)); continue; }
    const item = restoreOrder(pending, first)[0];
    pending.splice(pending.indexOf(item), 1);
    if (item.tier !== 0 && first > 0) first--;
    const res = o.start(item) || {};
    if (res.r !== 'skipped') last = now();
    if (res.r === 'ok') { n++; if (res.pid) loading.push({ pid: res.pid, at: now() }); }
    await sleep(0);
  }
}

// Reads, without blocking the event loop, what HO.readAll() then reads synchronously: each handoff file's first 4 KB
// and its session's .state file, `n` at once. After a boot none of it is in the file cache (and an antivirus scans each
// file on its first open): HO.readAll()'s ~1,700 synchronous reads then held a host's event loop over 10 s before its
// first start, and the window, let in by nothing and seeing no session under it, ended it and started a second host
// (2026-10-16 09:17). Warm, the same reads take a few hundred ms. Resolves how many handoff files there are.
async function warmHandoffs(n = 8) {
  const d = HO.dir(), fsp = fs.promises;
  let names = [];
  try { names = (await fsp.readdir(d)).filter((x) => /\.md$/i.test(x)); } catch { return 0; }
  let i = 0;
  const one = async (name) => {
    let fh = null;
    try {
      fh = await fsp.open(path.join(d, name), 'r');
      const b = Buffer.alloc(4096);
      const { bytesRead } = await fh.read(b, 0, b.length, 0);
      const s = String(HO.parseFront(b.toString('utf8', 0, bytesRead)).session || '').trim().toLowerCase();
      if (ID_RE.test(s)) await fsp.readFile(path.join(d, '.state', `${s}.json`)).catch(() => {});
    } catch {} finally { if (fh) await fh.close().catch(() => {}); }
  };
  await Promise.all(Array.from({ length: n }, async () => { while (i < names.length) await one(names[i++]); }));
  return names.length;
}

// ---------- conversations on another device (sync's "Continue here", ../sync-move.js) ----------
// <data dir>/sync/away.json, which the server's sync runner writes (temp file + rename) and deletes:
//   { v: 1, at, ids: { <id>: { device: <that device's name>, why: 'owned' | 'moving' } } }
// awayOf(id) -> { device, why } or null. Read again only when the file's mtime or size changes (one stat per call);
// a missing or unreadable file means nothing is away, and one that could not be read is tried again next call.
const awayFile = () => path.join(dataDir(), 'sync', 'away.json');
let awayCache = { key: null, ids: null };
function awayOf(id) {
  if (typeof id !== 'string') return null;
  let st;
  try { st = fs.statSync(awayFile()); } catch { awayCache = { key: null, ids: null }; return null; }
  const key = `${st.mtimeMs}:${st.size}`;
  if (awayCache.key !== key) {
    const j = readJson(awayFile());
    const ids = j && typeof j === 'object' && j.ids && typeof j.ids === 'object' && !Array.isArray(j.ids) ? j.ids : null;
    awayCache = { key: j ? key : null, ids };
  }
  const ids = awayCache.ids, k = id.toLowerCase();
  const e = ids && Object.prototype.hasOwnProperty.call(ids, k) ? ids[k] : null;
  if (!e || typeof e !== 'object') return null;
  const name = typeof e.device === 'string' ? e.device.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 100) : '';
  const device = name || 'another device';
  return { device, why: e.why === 'moving' ? 'moving' : 'owned' };
}
// what open() and sendTo() answer for such a conversation (a value, not an error)
const awayRefusal = (a) => ({ ok: false, away: { device: a.device }, message: `This conversation is on ${a.device}: use Continue here` });

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
// click, and a session can raise or lower its own effort (fv effort) or launch options from another's list the way
// the chat's Launch button does (fv launch). Only these, nothing broader: send, launch, status, ask, read, ls, teams,
// team, transcript, effort. It is one argument,
// "--allowedTools=a,b,…" in quotes (the commas split the list; a comma inside parentheses would be kept): as two
// words the flag would take every word after it as one more tool, a prompt after it too.
const FV_ALLOWED = ['send', 'launch', 'status', 'ask', 'read', 'ls', 'teams', 'team', 'transcript', 'effort'];
const ALLOW_FV = `"--allowedTools=${FV_ALLOWED.map((c) => `Bash(fv ${c}:*)`).join(',')}"`;
// a session with a role whose claude goes on in a conversation begun longer ago than this resumed an old one: it
// loses the role
const ROLE_NEW_MS = 10 * 60 * 1000;
// a role as create takes it: 'bot:<id>', else none (an old restore list's 'chief' too)
const BOT_ROLE_RE = /^bot:[0-9a-f]{12}$/;
const roleOf = (v) => (typeof v === 'string' && BOT_ROLE_RE.test(v) ? v : null);

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
  // started from an environment older than the PATH install.ps1 set (the key is Path, whatever its case).
  // macOS: the login shell's PATH (an app started from Finder has a bare one, without claude or node on it)
  const pk = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || (P.isWin ? 'Path' : 'PATH');
  const base = P.isWin ? String(env[pk] || '') : P.loginShellPath();
  const rest = base.split(path.delimiter).filter((p) => p && normDir(p) !== normDir(FV_DIR));
  env[pk] = [FV_DIR, ...rest].join(path.delimiter);
  env.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE = '1';
  if (launchKey) env.CLAUDE_LAUNCH_KEY = launchKey;
  // macOS and Linux: the terminal type the pty speaks (one started by launchd or Finder may have none, or "dumb")
  if (!P.isWin) env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.TERM = 'xterm-256color';
  return env;
}

function dirOr(cwd) {
  try { if (typeof cwd === 'string' && cwd && fs.statSync(cwd).isDirectory()) return cwd; } catch {}
  return os.homedir();
}

const intIn = (v, lo, hi, dflt) => (Number.isInteger(v) && v >= lo && v <= hi ? v : dflt);

// the whole process tree: claude and whatever it started (shells, MCP servers). Windows: taskkill /T /F; macOS
// and Linux: the pty's process group and every descendant, SIGTERM then SIGKILL (platform.js killTree). pid may be a
// list (one taskkill, or one ps, for them all); done() once it has run. Only sync waits for it (see killAll)
function treeKill(pid, sync, done) {
  P.killTree(pid, { sync: !!sync, done });
}

// the folders Claude Code writes its sessions/<pid>.json into, one per real folder
function sessionDirs(extra) {
  const home = process.env.USERPROFILE || os.homedir();
  const out = [], seen = new Set();
  for (const d of [...(extra || []), path.join(home, '.claude', 'sessions'), ...acctHomes().map((h) => path.join(h, 'sessions'))]) {
    let real;
    try { real = P.foldCase(fs.realpathSync(d)); } catch { continue; }
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
// a folder as a key: resolved, no slash at its end, lowercased where paths ignore case (Windows, macOS)
const normDir = (p) => {
  try {
    const r = path.resolve(String(p));
    return P.foldCase(P.isWin ? r.replace(/[\\/]+$/, '') : r.length > 1 ? r.replace(/\/+$/, '') : r);
  } catch { return ''; }
};

// pid -> parent pid for every process, one PowerShell call (about a second; ps on macOS and Linux); null when it fails
function parentMap(cb) {
  if (!P.isWin) {
    return P.processes((list) => {
      const m = new Map();
      for (const x of list || []) if (x.pid > 0 && x.ppid >= 0) m.set(x.pid, x.ppid);
      cb(m.size ? m : null);
    });
  }
  const ps = "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.ParentProcessId }";
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 20000, maxBuffer: 4 << 20 }, (err, out) => {
    if (err) return cb(null);
    const m = new Map();
    for (const line of String(out).split(/\r?\n/)) { const [a, b] = line.trim().split(/\s+/).map(Number); if (a > 0 && b >= 0) m.set(a, b); }
    cb(m.size ? m : null);
  });
}
// does pid descend from root (at most 8 levels up)? Or is it root: sh -c runs a lone command in its own process
// (macOS, Linux), so claude can be the pty's process itself
function descends(map, pid, root) {
  if (pid === root) return true;
  for (let i = 0, p = pid; i < 8 && p > 0; i++) { p = map.get(p); if (p === root) return true; if (p === undefined) return false; }
  return false;
}

// node-pty ships N-API prebuilds for win32 and darwin that load as they are (in Electron and in electron.exe run as
// Node); @lydell/node-pty is the fallback. Loaded on first use, so requiring this file costs nothing.
let ptyLib = null, ptyName = null, ptyError = null, ptyTried = false;
function loadPty() {
  if (ptyTried) return ptyLib;
  ptyTried = true;
  hidePtyForks();
  for (const name of ['node-pty', '@lydell/node-pty']) {
    try { ptyLib = require(name); ptyName = name; if (!P.isWin) spawnHelperExecutable(name); break; } catch (e) { ptyError = e; }
  }
  return ptyLib;
}
// Windows: killing a pty makes node-pty fork() its conpty_console_list_agent with no windowsHide. This process has
// no console, so the agent got a new one, which Windows Terminal (the default terminal) tried to host and showed
// "error 0x800700e8 when launching ... conpty_console_list_agent" in a window. Every fork from here runs hidden.
function hidePtyForks() {
  if (!P.isWin) return;
  const cp = require('child_process');
  if (cp.fork.fleetHidden) return;
  const fork = cp.fork;
  cp.fork = function (modulePath, args, options) {
    if (args && !Array.isArray(args) && typeof args === 'object') { options = args; args = []; }
    return fork.call(this, modulePath, args || [], { ...options, windowsHide: true });
  };
  cp.fork.fleetHidden = true;
}
// macOS: node-pty starts each pty through its spawn-helper program, and an install that lost the file's execute
// bit fails every spawn ("posix_spawnp failed"): put the bit back
function spawnHelperExecutable(name) {
  let dir;
  try { dir = path.dirname(require.resolve(`${name}/package.json`)); } catch { return; }
  for (const f of [path.join(dir, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'), path.join(dir, 'build', 'Release', 'spawn-helper')]) {
    try { const st = fs.statSync(f); if (st.isFile() && !(st.mode & 0o100)) fs.chmodSync(f, st.mode | 0o755); } catch {}
  }
}

// opts: { send(event, ...args): to every client, changed(): the set or a status changed, program: what runs in
//         place of `claude`, with the same arguments (test override),
//         sessionDirs: more folders to read, log(text), settings() -> the settings file's keys,
//         panelCloseMs / nudgeGiveUpMs / stallIdleMs / stallLookMs (test overrides) }
function createPtys(opts = {}) {
  const send = opts.send || (() => {});
  const changed = opts.changed || (() => {});
  const program = opts.program || 'claude';
  // each command line: claude, the fv commands it may run without asking, then the rest; a resume in the mode
  // the conversation last ran in (lastModeOf; cwd: where to look for its transcript first)
  const commandFor = (id, cwd) => `${program} ${ALLOW_FV}${modeFlag(id, cwd)} --resume ${id}`;
  const newCommand = () => `${program} ${ALLOW_FV}`;
  const pickupFor = (file) => HO.pickupCommand(file).replace(/^claude /, () => `${program} ${ALLOW_FV} `);
  const log = opts.log || (() => {});
  const dirs = () => sessionDirs(opts.sessionDirs);
  const getSettings = opts.settings || (() => settings());
  const nudgeGiveUpMs = opts.nudgeGiveUpMs > 0 ? opts.nudgeGiveUpMs : NUDGE_GIVEUP_MS;
  const stallIdleMs = opts.stallIdleMs > 0 ? opts.stallIdleMs : STALL_IDLE_MS, stallLookMs = opts.stallLookMs > 0 ? opts.stallLookMs : STALL_LOOK_MS;
  function panelCloseMs() {
    if (Number.isFinite(opts.panelCloseMs) && opts.panelCloseMs >= 0) return opts.panelCloseMs;
    const s = getSettings().panelAutoCloseSec;
    return Number.isInteger(s) && s >= 0 ? s * 1000 : PANEL_CLOSE_MS;
  }
  // key -> { id, pty, pid, alive, exitCode, startedAt, chunks, size, pending, timer, dismissed, cwd, account, cols, rows,
  //          dims / dim / base / baseOut (each chunk's pty size, the size now, and the screen of what fell off: see drop),
  //          isNew (still keyed new-<n>), created (started by create()), claudePid, status, known (pids there before),
  //          interrupted (restored after a shutdown that caught it mid-turn), restored, launchKey (its
  //          CLAUDE_LAUNCH_KEY), pickup (the handoff file it picks up, while it waits for its id), handoffFrom
  //          (the conversation it took over from), waitingFor (its pid file's, while waiting), seenIdle (a pid file
  //          of the claude this pty started said idle), idleSince (when that idle stretch began; 0 when not idle),
  //          outAt (its last output), inputAt (its last key), line / inPaste (what is typed into the prompt since
  //          the last Enter), slash (a "/" command sent with Enter, until its panel closes: see panelTick),
  //          nudge (the note due after a restore: see nudgeTick), restartBy (it asked for the host restart),
  //          cutOff (a restart or a quit found it mid-turn: see markCutOff), role ('bot:<id>' or null: see Roles),
  //          draft (unsent text a restore is to type back into its prompt: see Unsent text), tasksSeen (what tasksOf
  //          last read of its transcript) }
  const terms = new Map();
  let newSeq = 0;
  let screenLib = null;
  // what a restore has not started (see Restore list): its lowercased id ('pickup:<n>' for a pickup with no id) ->
  // { s: its entry as sessions.json keeps it, extra: () -> open()'s extra when the restore starts it in its turn; null:
  // parked until it is opened }. restoreList() carries these on
  const held = new Map();
  const hold = (key, s, extra) => { held.set(key, { s, extra: extra || null }); };
  const heldOf = (key) => held.get(String(key).toLowerCase()) || null;
  // the restore's turn for one: it leaves the map (null when a client opened or closed it meanwhile)
  function take(key) { const h = held.get(key) || null; held.delete(key); return h; }
  // (s.parked: parked by a restore that could not start it, keeping what open() gets for it)
  const parked = () => [...held.values()].map(({ s, extra }) => ({ id: s.id, cwd: s.cwd, account: s.account, role: roleOf(s.role), pickup: !!s.pickup, parked: !extra || !!s.parked }));

  function flush(t) {
    clearTimeout(t.timer);
    t.timer = null;
    if (!t.pending) return;
    const data = t.pending;
    t.pending = '';
    send('data', t.id, data);
  }

  const screens = () => screenLib || (screenLib = require(path.join(__dirname, '..', 'screen.js')));
  // What falls off the front of the kept output goes into t.base, a screen (screen.js createScreen) at the pty's size
  // when that output came (t.dims, one per chunk): the screen as it stood where the kept output begins. null until
  // something falls off; false once it failed (a snapshot is the kept output alone then, as before it).
  function drop(t, data, dim) {
    if (t.base === false || !data) return;
    t.baseOut = null;
    try {
      if (!t.base) t.base = screens().createScreen(dim.cols, dim.rows, { maxLines: KEYFRAME_LINES });
      else { const s = t.base.size(); if (s.cols !== dim.cols || s.rows !== dim.rows) t.base.resize(dim.cols, dim.rows); }
      t.base.write(data);
    } catch (e) {
      t.base = false;
      log(`snapshot: could not keep the screen of ${t.id} (${e.message}); its replays start from the kept output`);
    }
  }
  function keep(t, data) {
    t.chunks.push(data);
    t.dims.push(t.dim);
    t.size += data.length;
    while (t.size > BUFFER_MAX && t.chunks.length > 1) { const c = t.chunks.shift(); t.size -= c.length; drop(t, c, t.dims.shift()); }
    if (t.size > BUFFER_MAX) {
      const cut = t.size - BUFFER_MAX;
      drop(t, t.chunks[0].slice(0, cut), t.dims[0]);
      t.chunks[0] = t.chunks[0].slice(cut);
      t.size = BUFFER_MAX;
    }
  }
  // everything kept, as a terminal replays it: the screen where the kept output begins drawn again, then that output
  function kept(t) {
    if (t.base && t.baseOut == null) {
      try { t.baseOut = t.base.serialize(); } catch (e) { t.base = false; t.baseOut = null; log(`snapshot: could not draw the screen of ${t.id} again (${e.message})`); }
    }
    return (t.base ? t.baseOut : '') + t.chunks.join('');
  }
  // what a pty that carries on in its place (a handoff's pickup, a switch of account) starts its output with
  const carried = (t) => ({ chunks: t.chunks.slice(), dims: t.dims.slice(), size: t.size, base: t.base, baseOut: t.baseOut });

  const aliveCount = () => [...terms.values()].filter((t) => t.alive).length;
  const noPty = () => ({ ok: false, message: `No pty module: ${ptyError ? ptyError.message : 'not installed'}` });

  // starts `command` in a pty under `key`; extra fields go onto the entry. No cap on how many run at once (Henry,
  // 2026-10-12: "dont have a limit")
  function spawnPty(key, command, o, extra) {
    const cols = intIn(o.cols, 20, 1000, 120), rows = intIn(o.rows, 5, 500, 32);
    const cwd = dirOr(o.cwd);
    const launchKey = HO.newLaunchKey();
    let p;
    try {
      // the command line is built from checked parts only (an id of hex and dashes, the fixed new command and
      // ALLOW_FV, or a handoff file path HO.safeFile checked: no quotes, % or cmd metacharacters). It goes to cmd as one string,
      // `/c "<command>"`, which /s strips to the command itself: node-pty would escape a quote in it as \" (which
      // cmd does not read), and it already quoted a command with spaces the same way before.
      // macOS and Linux: /bin/sh -c '<command>'. The same parts read the same way in sh (double quotes keep each
      // quoted word whole, and none holds a $ or a backquote); the pty's child leads its own process group
      if (P.isWin) {
        p = ptyLib.spawn(process.env.ComSpec || 'cmd.exe', `/d /s /c "${command}"`, {
          name: 'xterm-256color', cols, rows, cwd, env: childEnv(o.account, launchKey), useConpty: true,
        });
      } else {
        p = ptyLib.spawn('/bin/sh', ['-c', command], { name: 'xterm-256color', cols, rows, cwd, env: childEnv(o.account, launchKey) });
      }
    } catch (e) {
      return { ok: false, message: `Could not start: ${e.message}` };
    }
    const t = {
      id: key, pty: p, pid: p.pid, alive: true, exitCode: null, startedAt: Date.now(), chunks: [], size: 0, pending: '', timer: null, dismissed: false,
      dims: [], dim: { cols, rows }, base: null, baseOut: null,
      cwd, account: acctId(o.account), cols, rows, isNew: false, created: false, claudePid: null, status: null, known: null,
      interrupted: false, restored: false, launchKey, pickup: null, handoffFrom: null, waitingFor: null, seenIdle: false, firstIdleAt: 0, firstBusy: false, idleSince: 0,
      outAt: 0, inputAt: 0, line: '', inPaste: false, slash: null, nudge: null, restartBy: false, role: null, draft: null, tasksSeen: null, ...extra,
    };
    t.role = roleOf(t.role);
    t.draft = cleanDraft(t.draft);
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
      // switchAccount ended it: it goes on under the other account, under the same key
      if (t.moveTo && !t.dismissed && moveOn(t)) return;
      if (t.moveTo) { t.moveTo.done({ ok: false, message: t.dismissed ? 'it was ended meanwhile' : 'it ended, and could not start again under the other account' }); t.moveTo = null; }
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
  // (else its own) and its account, with its role, keeping its output so far. Returns false when it could not start (then the
  // exit goes out as usual).
  function handoff(t, req) {
    let cwd = t.cwd;
    try { if (req.cwd && fs.statSync(req.cwd).isDirectory()) cwd = req.cwd; } catch {}
    flush(t);
    const from = req.session || (ID_RE.test(t.id) ? t.id.toLowerCase() : t.handoffFrom);
    // one switchAccount was moving: the pickup starts under the account it was moving to
    const account = t.moveTo ? t.moveTo.account : t.account;
    const r = startPickup(t.id, req.file, { cwd, account, cols: t.cols, rows: t.rows },
      { ...carried(t), created: t.created, handoffFrom: from, role: t.role });
    log(`handoff: ${t.id} -> ${r.ok ? `pickup of ${path.basename(req.file)} (pid ${r.pid})` : `could not start the pickup: ${r.message}`}`);
    if (!r.ok) return false;
    if (t.moveTo) { t.moveTo.done({ ok: true, pid: r.pid, message: 'it handed off; the pickup starts under the other account' }); t.moveTo = null; }
    const n = terms.get(t.id);
    const note = `\r\n\x1b[2m── handed off; a fresh conversation picks it up ──\x1b[0m\r\n`;
    keep(n, note);
    send('data', n.id, note);
    return true;
  }
  // the pickup itself (also what a restore runs for one that never got its id): a new claude, keyed like a
  // new session (key, or new-<n> when null) until its pid file says which conversation it is. extra.role: the
  // role of the session it carries on
  function startPickup(key, file, o, extra) {
    if (!loadPty()) return noPty();
    const known = new Set(readPidFiles(dirs()).map((f) => f.pid));
    const k = key || `new-${++newSeq}`;
    const role = roleOf(extra && extra.role);
    return spawnPty(k, pickupFor(file), o || {}, { isNew: true, known, pickup: file, ...(extra || {}), role });
  }

  // extra: { interrupted, restored, nudge, role } when the host resumes it after a shutdown. o.role ('bot:<id>')
  // opens it with that role; one that ended here keeps the role it had
  function open(o, extra) {
    const { id } = o || {};
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error('bad conversation id');
    if (!loadPty()) return noPty();
    const old = terms.get(id);
    if (old && old.alive) { held.delete(id.toLowerCase()); return { ok: true, message: 'already running', pid: old.pid }; }
    // another device has it (or it is moving there): never start it here (one running here is only attached to, above)
    const away = awayOf(id);
    if (away) { log(`open: ${id} refused: it is on ${away.device}`); return awayRefusal(away); }
    if (old) terms.delete(id); // ended: start it again
    // one the restore holds (parked, or its turn not come yet): it starts now, as the restore would have started it, in
    // its saved folder and account (the caller's size, when it gives one, as the panel resizes it anyway)
    const h = heldOf(id);
    if (h) {
      held.delete(id.toLowerCase());
      o = { ...o, cwd: h.s.cwd || o.cwd, account: h.s.account || o.account, cols: o.cols || h.s.cols, rows: o.rows || h.s.rows };
      if (!extra) extra = h.extra ? h.extra() : { restored: true, role: h.s.role, draft: h.s.draft || null };
      log(`open: ${id} ${h.extra ? 'was waiting for its turn in the restore; it starts now' : 'was parked; resumed'}`);
    }
    const role = roleOf(extra && extra.role) || roleOf(o.role) || (old ? old.role : null);
    const r = spawnPty(id, commandFor(id, o.cwd), o, { ...(extra || {}), role });
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
    // on another device: nothing here is ended or started
    const away = awayOf(id);
    if (away) { log(`send to ${acctId(o.account)}: ${id} refused: it is on ${away.device}`); return Promise.resolve(awayRefusal(away)); }
    if (!loadPty()) return Promise.resolve(noPty());
    const account = acctId(o.account);
    const old = terms.get(id);
    // one the restore holds (not running yet): it goes with its saved folder and role
    const h = old && old.alive ? null : heldOf(id);
    const cwd = o.cwd || old?.cwd || h?.s.cwd || null;
    // nothing is ended when that account can't carry it on
    const why = sendToMissing(id, account, cwd);
    if (why) { log(`send to ${account}: ${id} refused: ${why}`); return Promise.resolve({ ok: false, message: why }); }
    if (h) { held.delete(id.toLowerCase()); changed(); }
    const gone = old && old.alive ? new Promise((r) => { old.dismissed = true; end(old, 2500, r); }) : Promise.resolve();
    return gone.then(() => {
      if (terms.get(id) === old) terms.delete(id);
      if (terms.get(id)?.alive) return { ok: false, message: 'it was started again meanwhile' };
      const note = `The user sent this conversation to account ${account} from Fleet View; the pickup carries on there`;
      const role = old ? old.role : h ? roleOf(h.s.role) : null;
      const r = spawnPty(id, `${commandFor(id, cwd)} "/handoff ${note}"`, { ...o, account, cwd }, { role });
      log(`send to ${account}: ${id} ${r.ok ? `resumed with /handoff (pid ${r.pid})` : `failed: ${r.message}`}`);
      delete r.key;
      return r;
    });
  }

  // Switching accounts when one runs low (the server decides: ../account-switch.js): the SAME conversation carries on
  // under o.account, with no /handoff (a bot never hands off, and Henry wants the conversation itself to go on). Only at
  // a pause: idle for MOVE_IDLE_MS by its pid file, no menu on its screen, nothing typed in its prompt, no key for
  // MOVE_KEYS_MS, no note or "/" panel due, not moving or ending already, and not on another device (away.json). Its
  // claude is ended as kill does (Ctrl+C twice, then the tree); when it exits it is resumed (`claude --resume <id>`, as
  // open does) under o.account, under the same key, keeping its folder, size, role and screen, so the panel showing it
  // stays on it (no exit goes out). o.rescue: it hit its limit mid-turn, so once the resumed one has loaded it is told
  // "continue" (the auto-continue note's way: typed only while idle, with no menu and nobody typing). Fixed text only:
  // nothing from a caller goes into the command line or the note. Resolves { ok, message, pid? }.
  const MOVE_IDLE_MS = 3000, MOVE_KEYS_MS = 20000;
  function switchAccount(o) {
    const { id } = o || {};
    if (typeof id !== 'string' || !ID_RE.test(id)) return Promise.reject(new Error('bad conversation id'));
    const account = acctId(o.account);
    const away = awayOf(id);
    if (away) { log(`switch to ${account}: ${id} refused: it is on ${away.device}`); return Promise.resolve(awayRefusal(away)); }
    if (!loadPty()) return Promise.resolve(noPty());
    const t = terms.get(id) || terms.get(id.toLowerCase());
    const now = Date.now();
    const why = !t || !t.alive ? 'it is not running here'
      : t.isNew ? 'it has no conversation id yet'
        : t.dismissed ? 'it is ending'
          : t.moveTo ? 'it is moving already'
            : t.account === account ? `it is on ${account} already`
              : t.status !== 'idle' ? `it is not idle (${t.status || 'status unknown'})`
                : !t.idleSince || now - t.idleSince < MOVE_IDLE_MS ? 'it has not been idle long enough'
                  : t.line.trim() || t.inPaste ? 'something is typed in its prompt'
                    : now - (t.inputAt || 0) < MOVE_KEYS_MS ? 'someone typed into it just now'
                      : t.nudge ? 'a note is due to it'
                        : t.slash ? 'a "/" panel is open in it'
                          : menuUp(t) ? 'a menu is up on its screen' : '';
    if (why) return Promise.resolve({ ok: false, message: why });
    return new Promise((resolve) => {
      let settled = false;
      const done = (r) => { if (!settled) { settled = true; resolve(r); } };
      t.moveTo = { account, from: t.account, rescue: !!o.rescue, done };
      log(`switch to ${account}: ending ${t.id} on ${t.account}${o.rescue ? ' (it hit its limit)' : ''}`);
      // its exit (onExit) resumes it; this is the backstop when that never comes
      // (within api.js's 8 s for a call: 2.5 s grace, 1.5 s for the tree, then this)
      end(t, 2500, () => setTimeout(() => done({ ok: false, message: 'it did not end' }), 1500));
    });
  }
  // the resume after switchAccount ended it (from its exit): false when it could not start (the exit goes out then)
  function moveOn(t) {
    const m = t.moveTo;
    flush(t);
    const role = t.role;
    const r = spawnPty(t.id, commandFor(t.id, t.cwd), { cwd: t.cwd, account: m.account, cols: t.cols, rows: t.rows },
      { ...carried(t), created: t.created, forkFrom: t.forkFrom || null, handoffFrom: t.handoffFrom, role, draft: t.draft,
        nudge: m.rescue ? { kind: 'continue', cause: `it hit the limit of Claude ${m.from}` } : null });
    log(`switch to ${m.account}: ${t.id} ${r.ok ? `resumed under ${m.account} (pid ${r.pid})${m.rescue ? ', "continue" due once it has loaded' : ''}` : `could not start again: ${r.message}`}`);
    t.moveTo = null;
    if (!r.ok) { m.done({ ok: false, message: r.message }); return false; }
    const n = terms.get(t.id);
    const note = `\r\n\x1b[2m── moved from Claude ${m.from} to Claude ${m.account} ──\x1b[0m\r\n`;
    keep(n, note);
    send('data', n.id, note);
    m.done({ ok: true, pid: r.pid, message: `moved to ${m.account}` });
    return true;
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
  // o.role 'bot:<id>' starts a bot (see Roles): the usual command. The reply echoes role.
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
    const role = roleOf(o.role);
    const cmd = (fork ? `${commandFor(fork, o.cwd)} --fork-session` : newCommand()) + (model ? ` --model ${P.isWin ? model : `'${model}'`}` : '') + (effort ? ` --effort ${effort}` : '');
    const r = spawnPty(key, cmd + flag, o, { isNew: true, created: true, known, forkFrom: fork, role });
    if (r.ok && flag) r.chrome = o.chrome;
    if (r.ok && fork) r.forkFrom = fork;
    if (r.ok && model) r.model = model;
    if (r.ok && asked) r.effort = asked;
    if (r.ok && role) r.role = role;
    return r;
  }

  // ---------- the sessions/<pid>.json scan: re-keys new sessions, gives every hosted one its status ----------
  // While a session starts (its claude has not said idle yet, or has and not taken up its first message, for up to
  // SCAN_FAST_FOR_MS) the scan runs every SCAN_FAST_MS too, so a message waiting to go into it (the chat box, the API)
  // hears it is ready at once, and that it was taken up, not up to SCAN_MS later; scan() stops that timer once none is
  // starting.
  let scanTimer = null, fastTimer = null, checking = false, noMapAt = 0;
  const verified = new Map(); // `${claudePid}:${ptyPid}` -> true | false
  const starting = (t, now) => t.alive && now - t.startedAt < SCAN_FAST_FOR_MS &&
    (!t.seenIdle || (!t.firstBusy && now - t.firstIdleAt < SCAN_FIRST_TURN_MS));
  function startScan() {
    if (!fastTimer) fastTimer = setInterval(scan, SCAN_FAST_MS);
    if (scanTimer) return;
    scanTimer = setInterval(scan, SCAN_MS);
  }
  function rekey(t, f) {
    const old = t.id, id = f.sessionId;
    if (terms.get(old) !== t) return;
    if (terms.has(id) && terms.get(id).alive) { t.claudePid = f.pid; return; } // already hosted under that id (should not happen)
    flush(t); // output so far goes out under the old key, the rest under the new one
    terms.delete(old);
    held.delete(id); // (a parked conversation it went on in is running now)
    t.id = id; t.isNew = false; t.claudePid = f.pid; t.status = f.status; t.waitingFor = f.status === 'waiting' ? f.waitingFor : null;
    terms.set(id, t);
    send('rekey', old, id);
    changed();
  }
  function scan() {
    const live = [...terms.values()].filter((t) => t.alive);
    if (!live.length) { clearInterval(scanTimer); scanTimer = null; clearInterval(fastTimer); fastTimer = null; return; }
    let files;
    try { files = readPidFiles(dirs()); } catch { return; }
    // (this scan's news still counts: a session that says idle in it is no longer starting from the next one)
    if (fastTimer && !live.some((t) => starting(t, Date.now()))) { clearInterval(fastTimer); fastTimer = null; }
    // status for the hosted ones: by the claude pid once known, else the newest file of that conversation
    let moved = false;
    const now = Date.now();
    for (const t of live) {
      const mine = files.filter((x) => (t.claudePid ? x.pid === t.claudePid : !t.isNew && x.sessionId === t.id.toLowerCase()));
      mine.sort((x, y) => y.updatedAt - x.updatedAt);
      // its claude is on another conversation now (/clear, /resume): the pty follows, unless that one is hosted
      if (t.claudePid && !t.isNew && mine.length && mine[0].sessionId !== t.id.toLowerCase() && !terms.has(mine[0].sessionId)) {
        // a role carries on in a new conversation (/clear), not in an older one it resumed
        const began = t.role ? transcriptStart(mine[0].sessionId, t.cwd) : null;
        if (began !== null && now - began > ROLE_NEW_MS) {
          log(`${t.role}: ${t.id} went on in an older conversation (${mine[0].sessionId}), which does not take the role`);
          t.role = null;
        }
        rekey(t, mine[0]);
        continue; // rekey sent the status with the move
      }
      const f = mine.length ? mine[0] : null;
      const st = f ? f.status : null;
      const wf = st === 'waiting' ? f.waitingFor : null;
      // a file of the claude this pty started (not one left by a claude before it): only those say it has loaded
      const fresh = !!f && f.startedAt >= t.startedAt - 2000;
      if (fresh && st === 'idle' && !t.seenIdle) { t.seenIdle = true; t.firstIdleAt = now; }
      if (t.seenIdle && st === 'busy') t.firstBusy = true;
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
    for (const t of live) { if (t.alive) { panelTick(t, now); stallTick(t, now); nudgeTick(t, now); draftTick(t, now); } }
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

  // -> null when it went in, else why not: 'not found', 'ended', 'ending' (a restart, a quit or a close is ending it:
  // the keys would go into a claude on its way out), 'truncated' (past 1 MB in one write: the rest is cut off)
  function write(id, data) {
    const t = terms.get(id);
    if (typeof data !== 'string' || !data) return null;
    if (!t) return 'not found';
    if (!t.alive) return 'ended';
    if (t.dismissed) return 'ending';
    if (t.interrupted && data.includes('\r')) { t.interrupted = false; changed(); }
    if (!AUTO_REPLY_RE.test(data)) {
      t.inputAt = Date.now();
      // someone is at it: the note after a restore is theirs to send now
      if (t.nudge) { log(`auto-continue: ${t.id} cancelled (typed into)`); t.nudge = null; changed(); }
      track(t, data.length > 4096 ? data.slice(0, 4096) : data);
    }
    try { t.pty.write(data.length > 1 << 20 ? data.slice(0, 1 << 20) : data); } catch { return 'ended'; }
    return data.length > 1 << 20 ? 'truncated' : null;
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
      return !!screens().menuShown(kept(t), t.cols, t.rows);
    } catch (e) { log(`auto-continue: could not read the screen of ${t.id}: ${e.message}`); return true; }
  }

  // The note a resumed session gets once it has loaded (t.nudge = { kind, cause, file?, offset? }, from restore):
  // typed as a bracketed paste, checked again 300 ms later, then Enter.
  function noteFor(n) {
    if (n.kind === 'continue') return 'continue'; // switchAccount's rescue: the turn the limit cut off goes on
    if (n.kind === 'restart') return `[Fleet View] The session host restarted as you asked. Check that the newest "started:" line in ${P.isWin ? '%LOCALAPPDATA%\\fleet-view\\host.log' : logFile()} shows the new version, then carry on.`;
    if (n.kind === 'tasks') return `[Fleet View] Your background tasks stopped when ${n.cause}; the notes above say which. Check what they finished, start again what still needs to run, then carry on.`;
    if (n.kind === 'stalled') return '[Fleet View] Your turn stopped mid-way and you have been idle since. Check what finished, then carry on.';
    return `[Fleet View] You were cut off mid-turn: ${n.cause}. Check what finished, then carry on.`;
  }
  const settled = (t, now) => t.alive && t.status === 'idle' && t.idleSince > 0 && now - t.idleSince >= NUDGE_IDLE_MS
    && now - (t.outAt || t.startedAt) >= NUDGE_QUIET_MS;
  function nudgeTick(t, now) {
    const n = t.nudge;
    if (!n || n.typing) return;
    const drop = (why) => { if (why) log(`auto-continue: ${t.id} ${why}`); t.nudge = null; changed(); };
    if (now - (n.at || t.startedAt) > nudgeGiveUpMs) return drop(`gave up: not ready ${Math.round(nudgeGiveUpMs / 1000)} s after ${n.at ? 'it stalled' : 'it started'}`);
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

  // Stalls: a live session whose claude has sat idle for STALL_IDLE_MS, with no key typed into it since (a draft in its
  // box would take the note on its end: someone at it decides), while
  // its log ends mid-turn (openTurn: a tool call or result with no reply) stopped without ending its turn: a stream
  // that broke, a claude resumed by hand after it died. Claude Code starts no turn by itself, so it gets the note
  // (nudgeTick types it, as after a restore). Its log is looked at again only once it has grown; STALL_MAX notes an
  // hour at most, so one that stalls again at once is left to you. "autoContinue": false turns this off too.
  function stallTick(t, now) {
    if (t.nudge || t.isNew || t.status !== 'idle' || !t.seenIdle || !t.idleSince || now - t.idleSince < stallIdleMs) return;
    if ((t.inputAt || 0) >= t.idleSince || now - (t.stallLook || 0) < stallLookMs) return;
    if (getSettings().autoContinue === false) return;
    t.stallLook = now;
    const tr = findTranscript(t.id, t.cwd);
    if (!tr || tr.size === t.stallSize) return;
    t.stallSize = tr.size;
    if (!openTurn(tr.file)) return;
    t.stalls = (t.stalls || []).filter((at) => now - at < 3600e3);
    if (t.stalls.length >= STALL_MAX) { log(`auto-continue: ${t.id} stalled again; ${STALL_MAX} notes this hour already, so it is left to you`); return; }
    t.stalls.push(now);
    t.nudge = { kind: 'stalled', at: now };
    changed();
    log(`auto-continue: ${t.id} idle ${Math.round((now - t.idleSince) / 1000)} s with its turn left open; note due (stalled)`);
  }

  // Unsent text (see Unsent text): what sits in its prompt box now, for the restore list of a restart or a quit. The box
  // as its screen shows it (screen.js promptBox: Claude Code's grey suggestion is not text; null when a menu or a panel
  // covers it, or in bash mode), or, when it is the same text, what was typed since the last Enter (t.line), which keeps
  // its own line breaks where the box wraps a long line into rows of its own. Only one typed into here can hold any (a
  // screen costs some 30 ms to read); one whose text a restore still has to type back keeps that (t.draft).
  const flatText = (s) => String(s).replace(/\s+/g, ' ').trim();
  function draftOf(t) {
    if (!t.alive || t.isNew || !t.inputAt) return t.draft || null;
    let box = null;
    try { box = screens().promptBox(screens().render(kept(t), t.cols, t.rows, 60, false, true)); } catch (e) { log(`draft: could not read the screen of ${t.id}: ${e.message}`); }
    if (!box || !box.text) return t.draft || null;
    const typed = !t.inPaste && t.line.length < 200 && flatText(t.line) === flatText(box.text) ? cleanDraft(t.line) : null;
    return typed || cleanDraft(box.text);
  }
  // A restore's unsent text (t.draft) goes back into the prompt once it has loaded and is at rest, as the note does (idle
  // 2.5 s by its pid file, no output for 1.5 s, no menu on screen), after the note when one is due (it waits for the turn
  // the note starts to end): a bracketed paste with no Enter, so it sits there unsent as it did. A key typed into the
  // session first drops it (someone is at it, and the two would mix).
  function draftTick(t, now) {
    if (!t.draft || t.nudge) return;
    if (t.inputAt) { log(`draft: ${t.id} was typed into first; its unsent text (${t.draft.length} characters) is not typed back`); t.draft = null; changed(); return; }
    if (!settled(t, now) || menuUp(t)) return;
    const paste = `\x1b[200~${t.draft}\x1b[201~`;
    const n = t.draft.length;
    t.draft = null;
    try { t.pty.write(paste); } catch {}
    track(t, paste); // it is in the prompt now: a stall note and a switch of account hold off, as for text typed there
    t.inputAt = now;
    changed();
    log(`draft: ${t.id}: its unsent text (${n} characters) typed back into its prompt`);
  }

  function resize(id, cols, rows) {
    const t = terms.get(id);
    if (!t || !t.alive) return;
    const c = intIn(cols, 2, 1000, 0), r = intIn(rows, 2, 500, 0);
    if (!c || !r) return;
    try { t.pty.resize(c, r); t.cols = c; t.rows = r; t.dim = { cols: c, rows: r }; } catch {}
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
      // whatever taskkill missed; not a pty whose root is gone already (its exit is on the way, see gone)
      setTimeout(() => { if (t.alive && pidAlive(t.pid)) { try { t.pty.kill(); } catch {} } finish(); }, 1500);
    }, graceMs);
  }

  // a running one: end it (above); the exit then goes out and it is forgotten.
  // An ended one: forget it now (the page's "Close" on the "Session ended" bar). One the restore holds: forgotten too.
  function kill(id) {
    const t = terms.get(id);
    if (!t) {
      if (held.delete(String(id).toLowerCase())) { log(`restore: ${id} was closed before it started; it leaves the restore list`); changed(); }
      return;
    }
    if (!t.alive) { terms.delete(id); changed(); return; }
    if (t.dismissed) return; // already ending
    t.dismissed = true;
    end(t, 2500);
  }

  // Several trees to end, never blocking this process. Windows: one taskkill at a time, each once the one before has
  // exited, so their ptys never exit at the same moment: node-pty's ConPTY exit threads each take their pty off one
  // shared list with no lock, and ptys that exit together can crash this process (0xC0000005; #452: a restarting host
  // that died at "ending them" and never started the next one, and one taskkill for several trees did the same).
  // macOS and Linux: all in one go (one ps).
  const killQueue = [];
  let killing = false;
  function killTrees(list) {
    if (!P.isWin) { if (list.length) treeKill(list.map((t) => t.pid)); return; }
    for (const t of list) if (!killQueue.includes(t)) killQueue.push(t);
    if (killing) return;
    killing = true;
    const step = () => {
      let t;
      while ((t = killQueue.shift()) && !(t.alive && pidAlive(t.pid)));
      if (!t) { killing = false; return; }
      treeKill(t.pid, false, step);
    };
    step();
  }

  // All of them at once, the same way, without ever blocking this process: the ones still running after graceMs lose
  // their trees (killTrees). Resolves once they are gone or given up on (marked ended: gone). Windows: the Ctrl+Cs go
  // END_GAP_MS apart, for the same reason killTrees goes one at a time.
  // o.resume (a restart, or a quit whose next host resumes them): one marked cutOff (mid-turn, see markCutOff) gets no
  // Ctrl+C, its tree goes at once. Claude Code takes a Ctrl+C at a tool call for the user rejecting it ("The user doesn't
  // want to proceed with this tool use ... STOP") and the model stops (#402); killed, its resume shows the tool call
  // interrupted, and the note after the restore (Auto-continue) tells it to carry on.
  function endAll(graceMs = 2500, o = {}) {
    const live = [...terms.values()].filter((t) => t.alive);
    for (const t of live) t.dismissed = true;
    const hard = o.resume ? live.filter((t) => t.cutOff) : [];
    const soft = live.filter((t) => !hard.includes(t));
    if (hard.length) {
      log(`ending: ${hard.map((t) => t.id).join(', ')} mid-turn, so no Ctrl+C: ${hard.length === 1 ? 'its tree ends' : 'their trees end'} now`);
      killTrees(hard);
    }
    const spread = Math.max(0, soft.length - 1) * END_GAP_MS;
    return new Promise((resolve) => {
      let over = false;
      const left = () => live.filter((t) => t.alive);
      const finish = () => {
        if (over) return;
        over = true;
        clearInterval(poll); clearTimeout(grace); clearTimeout(cap);
        const l = left();
        if (l.length) log(`ending: no exit came from ${l.map((t) => t.id).join(', ')}; marked ended`);
        for (const t of l) gone(t);
        if (l.length) changed();
        resolve();
      };
      const poll = setInterval(() => { if (!left().length) finish(); }, 50);
      // given up on after this: a taskkill takes a few tenths of a second, and node-pty's exit comes about a second
      // after the root process ended
      const cap = setTimeout(finish, graceMs + spread + 3000 + 500 * live.length);
      soft.forEach((t, i) => setTimeout(() => {
        if (over || !t.alive) return;
        try { t.pty.write('\x03'); } catch {}
        setTimeout(() => { if (!over && t.alive) { try { t.pty.write('\x03'); } catch {} } }, 250);
      }, i * END_GAP_MS));
      const grace = setTimeout(() => {
        const l = left();
        if (!l.length) return;
        log(`ending: ${l.length} still running ${graceMs} ms after Ctrl+C; ending their trees`);
        killTrees(l);
      }, graceMs + spread);
    });
  }

  // One that is ending and whose exit has not come: marked ended and forgotten now (once its ConPTY is closed here the
  // exit may never come). pty.kill() only while its root process still runs: for one already gone node-pty would start
  // its console-list agent (a whole process) for nothing, which then fails ("AttachConsole failed").
  function gone(t) {
    if (!t.alive) return;
    t.dismissed = true;
    HO.takeRestart(t.launchKey); // a handoff it asked for is dropped: it never restarts after this
    if (pidAlive(t.pid)) { try { t.pty.kill(); } catch {} }
    if (!t.alive) return; // its exit came in the meantime
    t.alive = false;
    flush(t);
    send('exit', t.id, null);
    terms.delete(t.id);
  }

  // the backstop: every tree that is left, waited for (Windows: one taskkill after the other, as killTrees; macOS and
  // Linux: one ps). It runs as this process exits (shutdown), where waiting is right: once it has exited, the ConPTYs
  // close and each tree loses its root before an async taskkill could walk it, leaving claude's children running. By
  // then endAll has normally ended them all, so it costs nothing. Then each one is marked ended and forgotten (gone).
  function killAll() {
    const live = [...terms.values()].filter((t) => t.alive);
    killQueue.length = 0;
    for (const t of live) t.dismissed = true;
    if (!P.isWin) { if (live.length) treeKill(live.map((t) => t.pid), true); }
    else for (const t of live) if (pidAlive(t.pid)) treeKill(t.pid, true);
    for (const t of live) gone(t);
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
      interrupted: !!(t.alive && t.interrupted), restored: !!t.restored, role: t.role || null, cols: t.cols, rows: t.rows,
      moving: !!(t.alive && t.moveTo),
    }));
  }

  // mid-turn: working (or running a shell command), or waiting on a prompt inside a turn (a permission, a
  // question, the plan); an open "/" panel is not a turn
  const isBusy = (t) => t.status === 'busy' || t.status === 'shell' || (t.status === 'waiting' && t.waitingFor !== 'dialog open');
  // working as a restart or a quit sees it: by its pid file, or with no status known (no pid file yet, or one that
  // lags) while it still writes output (Claude Code's spinner redraws while it works); mid-turn: that or waiting on a prompt
  const working = (t, now) => t.status === 'busy' || t.status === 'shell' || (t.status === null && now - (t.outAt || 0) < OUT_BUSY_MS);
  const midTurn = (t, now) => isBusy(t) || working(t, now);
  // a restart or a quit, just before it saves the restore list: the running ones mid-turn now are marked cutOff. They are
  // saved busy (the next host resumes them and tells them to carry on) and endAll({ resume }) ends them without Ctrl+C
  function markCutOff() {
    const now = Date.now();
    for (const t of terms.values()) t.cutOff = t.alive && midTurn(t, now);
  }

  // the ones to bring back after a restart: every running one, and one that ended without a clean exit (code
  // 0, e.g. /exit) and was not closed from the page. At a shutdown or reboot claude may die before this
  // process does, and its exit must not drop it from the list. Then, as they were saved, the ones the restore
  // holds: parked, or not started yet.
  // One that has asked for its handoff's restart and is still to be killed (the few seconds after its Stop hook wrote
  // the request, while it already looks idle) is saved as that pickup: the restart or quit that ends it here drops
  // the request (see Handoffs), and the next host starts the pickup in its place.
  // o.drafts (a restart or a quit, before it ends them): each one's unsent text is read off its screen (draftOf) and kept as
  // draft; any other save keeps only the text a restore has still to type back.
  function restoreList(o = {}) {
    const asked = HO.restartKeys();
    return [...terms.values()].filter((t) => !t.dismissed && (t.alive || (!t.isNew && t.exitCode !== 0))).map((t) => {
      const ho = t.alive && asked.has(t.launchKey) ? HO.peekRestart(t.launchKey) : null;
      if (ho) {
        return { id: null, cwd: ho.cwd || t.cwd, account: t.moveTo ? t.moveTo.account : t.account, startedAt: t.startedAt, busy: false, interrupted: false,
          cols: t.cols, rows: t.rows, pendingKey: t.id, pickup: ho.file, handoffFrom: ho.session || (ID_RE.test(t.id) ? t.id.toLowerCase() : t.handoffFrom || null),
          ...(t.role ? { role: t.role } : {}) };
      }
      const draft = o.drafts ? draftOf(t) : t.draft;
      return {
        id: t.isNew ? null : t.id, cwd: t.cwd, account: t.account, startedAt: t.startedAt, busy: isBusy(t) || !!t.cutOff,
        interrupted: !!t.interrupted, cols: t.cols, rows: t.rows, ...(t.isNew ? { pendingKey: t.id } : {}),
        ...(t.isNew && t.pickup ? { pickup: t.pickup, handoffFrom: t.handoffFrom || null } : {}),
        ...(t.restartBy ? { restartBy: true } : {}),
        ...(t.role ? { role: t.role } : {}),
        ...(draft ? { draft } : {}),
      };
    }).concat([...held.values()].filter((h) => !(h.s.id && terms.has(h.s.id))).map((h) => h.s));
  }

  // for the restart: the running sessions that are mid-turn, but the one with this CLAUDE_LAUNCH_KEY (the asker)
  const others = (launchKey, is) => { const now = Date.now(); return [...terms.values()].filter((t) => t.alive && is(t, now) && !(launchKey && t.launchKey === launchKey)).map((t) => t.id); };
  const busyBut = (launchKey) => others(launchKey, midTurn);
  // of those, the ones working (or running a shell command), not waiting on an answer
  const workingBut = (launchKey) => others(launchKey, working);
  // How many background tasks its transcript says still run (runningTasks: a subagent, a Monitor, a shell task), for a
  // restart that waits on an idle session's (see Restart). Read again at most every TASKS_LOOK_MS (a read is up to 8 MB),
  // and then only when the transcript changed or last said some run; none in one still for a day (BG_MAX_MS)
  function tasksOf(t, now) {
    const c = t.tasksSeen;
    if (c && now - c.at < TASKS_LOOK_MS) return c.n;
    const tr = findTranscript(t.id, t.cwd);
    const key = tr ? `${tr.size}:${tr.mtimeMs}` : '';
    const n = !tr || now - tr.mtimeMs >= BG_MAX_MS ? 0 : c && c.key === key && !c.n ? 0 : runningTasks(tr.file, now);
    t.tasksSeen = { at: now, key, n };
    return n;
  }
  // the running sessions not mid-turn whose background tasks still run, but the asker's
  const tasksBut = (launchKey) => others(launchKey, (t, now) => !t.isNew && !midTurn(t, now) && tasksOf(t, now) > 0);
  // marks the asker, so the next host tells it the restart is done; its id, or null when none is hosted here
  function markRestartBy(launchKey) {
    const t = launchKey ? [...terms.values()].find((x) => x.alive && x.launchKey === launchKey) : null;
    if (t) t.restartBy = true;
    return t ? t.id : null;
  }

  // everything kept so far (see kept). Pending output is sent first, so a client gets every chunk once: the ones it
  // received before the snapshot are in it, the ones after are new (see preload.js).
  function snapshot(id) {
    const t = terms.get(id);
    if (!t) return '';
    flush(t);
    return kept(t);
  }
  // has the session in the pty with this pid loaded: its own claude said idle once (seenIdle, from the scan), or it is
  // gone? (By the pty's pid, which a pickup's re-key keeps.) The restore frees a start's slot on it (see Restore list).
  function loaded(pid) {
    for (const t of terms.values()) if (t.pid === pid) return !t.alive || t.seenIdle;
    return true;
  }

  return { open, sendTo, switchAccount, create, startPickup, write, resize, kill, endAll, killAll, list, restoreList, busyBut, workingBut, tasksBut, markRestartBy, markCutOff, snapshot, aliveCount, dirs,
    hold, heldOf, take, parked, loaded, rescan: scan };
}

// ---------- the host process ----------
function runHost() {
  const PIPE = pipeName();
  const TEST = isTestPipe();
  const DIR = dataDir();
  try { fs.mkdirSync(DIR, { recursive: true, ...(P.isWin ? {} : { mode: 0o700 }) }); } catch {}
  // macOS and Linux: the socket's folder (a test socket may sit anywhere)
  if (!P.isWin) { try { fs.mkdirSync(path.dirname(PIPE), { recursive: true, mode: 0o700 }); } catch {} }
  const VERSION = fileHash(HOST_JS);
  const startedAt = Date.now();
  const token = crypto.randomBytes(32).toString('hex');
  const IDLE_MS = TEST && Number(process.env.FV_HOST_IDLE_MS) > 0 ? Number(process.env.FV_HOST_IDLE_MS) : 10 * 60 * 1000;
  // a restart waits this long for a session waiting on an answer (a permission, a question); one working, for ever
  const ASK_WAIT_MS = TEST && Number(process.env.FV_HOST_ASK_WAIT_MS) > 0 ? Number(process.env.FV_HOST_ASK_WAIT_MS) : 10 * 60 * 1000;
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
  // sessions.json.bak, the last good list: each save first copies the file it replaces there, while this host knows that
  // file is whole (it read it at its start, or wrote it itself). One that does not parse at the start is moved aside and
  // the .bak read instead (see restore), so a list cut short is never all there is, nor written over.
  let ui = null, frozen = false, saveTimer = null, sessionsTimer = null, listWhole = true;
  const sessionsBak = () => `${sessionsFile()}.bak`;
  function saveNow(reason) {
    clearTimeout(saveTimer); saveTimer = null;
    if (frozen && reason !== 'quit' && reason !== 'restart') return;
    try {
      if (listWhole) { try { fs.copyFileSync(sessionsFile(), sessionsBak()); } catch {} }
      // a restart or a quit keeps each one's unsent text too (see Unsent text), read off its screen before it is ended
      writeJsonAtomic(sessionsFile(), { version: 1, savedAt: Date.now(), reason, hostPid: process.pid, sessions: ptys.restoreList({ drafts: reason === 'quit' || reason === 'restart' }), ui });
      listWhole = true;
    } catch (e) { log(`could not write sessions.json: ${e.message}`); }
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
    program: TEST_CMD || undefined,
    sessionDirs: EXTRA_DIRS,
    log,
    panelCloseMs: testMs('FV_HOST_PANEL_CLOSE_MS'),
    nudgeGiveUpMs: testMs('FV_HOST_NUDGE_GIVEUP_MS'),
    stallIdleMs: testMs('FV_HOST_STALL_IDLE_MS'),
    stallLookMs: testMs('FV_HOST_STALL_LOOK_MS'),
  });

  // On start, once the pipe listens: the conversations the last list had (see Restore list). restore() itself reads
  // sessions.json and holds every listed one at once, reading no other file, so a save from then on keeps them all. The
  // rest runs in turns of its own (about RESTORE_SLICE_MS at most each), so a client is let in and answered throughout:
  // the handoff files go into the file cache without blocking (warmHandoffs), then each listed one is sorted (the
  // conversation a pickup started, away, a handoff nothing picked up, its last activity), then the starts begin
  // (startPool: restoreOrder, RESTORE_CONCURRENT loading at once, RESTORE_GAP apart) while, alongside, one per turn, the
  // idle ones it would park are checked for an open turn or running background tasks and join the queue when they have.
  const RESTORE_GAP = testMs('FV_HOST_RESTORE_GAP_MS') ?? RESTORE_GAP_MS;
  const RESTORE_SLOT = testMs('FV_HOST_RESTORE_SLOT_MS') ?? RESTORE_SLOT_MS;
  const RESTORE_LIMIT = Math.max(1, Math.floor(testMs('FV_HOST_RESTORE_CONCURRENT') || RESTORE_CONCURRENT));
  const RESTORE_RETRY = testMs('FV_HOST_RESTORE_RETRY_MS') ?? RESTORE_RETRY_MS;
  const restoreStopped = () => quitting || frozen || down;
  function restore() {
    const t0 = Date.now();
    let saved = readJson(sessionsFile());
    // one that does not parse (cut short when the PC went down?) is kept aside, never written over, and the last good
    // list (sessions.json.bak, see saveNow) is resumed in its place
    if ((!saved || typeof saved !== 'object') && fs.existsSync(sessionsFile())) {
      const aside = `${sessionsFile()}.corrupt-${Date.now()}`;
      try { fs.renameSync(sessionsFile(), aside); } catch { listWhole = false; }
      const bak = readJson(sessionsBak());
      saved = bak && typeof bak === 'object' && Array.isArray(bak.sessions) ? bak : null;
      log(`restore: sessions.json could not be read (cut short when the PC went down?); ${listWhole ? `kept as ${path.basename(aside)}` : 'could not move it aside'}; `
        + (saved ? `resuming sessions.json.bak (saved ${new Date(Number(saved.savedAt) || 0).toISOString()}) instead` : 'no sessions.json.bak to fall back on, nothing resumed'));
    }
    if (!saved || typeof saved !== 'object') return;
    if (saved.ui && typeof saved.ui === 'object') ui = saved.ui;
    const list = Array.isArray(saved.sessions) ? saved.sessions : [];
    if (!list.length) return;
    // a conversation some live claude already has open (a terminal resumed it meanwhile, or the claude of a host that
    // was killed has not died yet) is not started: asked at its turn, and again at the retry. Pid files from before
    // this boot are stale whatever their pid says now
    const bootAt = Date.now() - os.uptime() * 1000;
    const openNow = () => new Set(readPidFiles(ptys.dirs()).filter((f) => f.startedAt >= bootAt - 60000).map((f) => f.sessionId));
    // each resumed one is told to carry on once it has loaded (see Auto-continue), unless that is turned off
    const set = settings(true);
    const autoContinue = set.autoContinue !== false, restoreIdle = set.restoreIdle === true;
    const cause = saved.reason === 'quit' ? 'Fleet View was quit' : saved.reason === 'restart' ? 'the session host restarted for an update'
      : 'the session host stopped (the PC shut down, or the host ended)';
    const shown = ui && typeof ui.selectedId === 'string' ? ui.selectedId.toLowerCase() : null;
    // what open() gets for one, worked out when it starts (from the transcript as it is then)
    const extraFor = (id, s, interrupted, role) => () => {
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
      return { interrupted, restored: true, nudge, role, draft: s.draft || null };
    };
    // the tier a conversation starts in (see restoreOrder); -1: parked, unless a check finds it should start
    const tierOf = (id, s, pickup) => (s.restartBy || id === shown ? 0 : s.busy || s.interrupted ? 1 : s.role || pickup ? 2 : restoreIdle ? 4 : -1);
    // held at once as it would be held once sorted (parked, or waiting for its turn with what open() gets), so an open()
    // of one meanwhile starts it as its turn would: [{ key, s, pickup?, from? }]
    const entries = [];
    let pickups = 0;
    for (const s0 of list) {
      if (!s0 || typeof s0 !== 'object') continue;
      const role = roleOf(s0.role), draft = cleanDraft(s0.draft);
      // as this host keeps it in the restore list while it waits
      const s = { id: typeof s0.id === 'string' && ID_RE.test(s0.id) ? s0.id.toLowerCase() : null, cwd: typeof s0.cwd === 'string' ? s0.cwd : null,
        account: acctId(s0.account), startedAt: Number(s0.startedAt) || 0, busy: !!s0.busy, interrupted: !!s0.interrupted,
        cols: Number.isInteger(s0.cols) ? s0.cols : null, rows: Number.isInteger(s0.rows) ? s0.rows : null,
        ...(typeof s0.pendingKey === 'string' ? { pendingKey: s0.pendingKey } : {}), ...(s0.restartBy ? { restartBy: true } : {}), ...(role ? { role } : {}),
        ...(draft ? { draft } : {}) };
      // a pickup that had no id yet: sorted below (the conversation it started when the handoff names it, else the pickup again)
      if (typeof s0.pickup === 'string' && !s.id) {
        const from = typeof s0.handoffFrom === 'string' && ID_RE.test(s0.handoffFrom) ? s0.handoffFrom.toLowerCase() : null;
        const key = `pickup:${++pickups}`;
        ptys.hold(key, { ...s, pickup: s0.pickup, handoffFrom: from }, null);
        entries.push({ key, s, pickup: s0.pickup, from });
        continue;
      }
      if (!s.id) { log(`restore: dropped a new session that never got an id (${s0.pendingKey || '?'})`); continue; }
      if (ptys.heldOf(s.id)) continue; // listed twice
      const tier = tierOf(s.id, s, false);
      if (tier < 0) ptys.hold(s.id, { ...s, parked: true }, null);
      else ptys.hold(s.id, s, extraFor(s.id, s, !!(s.busy || s.interrupted), role));
      entries.push({ key: s.id, s });
    }
    const stopped = (left) => log(`restore: stopped (${quitting ? 'quitting' : 'the host is ending'}) with ${left} not started; they stay in the restore list`);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const turn = () => new Promise((r) => setImmediate(r));
    const mtimeOf = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
    (async () => {
      const tw = Date.now();
      const nHandoffs = await warmHandoffs();
      const warmMs = Date.now() - tw;
      if (restoreStopped()) return stopped(entries.length);
      let hos = null;
      const handoffs = () => hos || (hos = HO.readAll()); // read once, when the first one needs it
      const queue = [], checks = []; // queue: [{ key, tier, at }]; checks: [{ id, s, extra }]
      let sliceAt = Date.now(), dropped = false;
      for (const e of entries) {
        if (Date.now() - sliceAt >= RESTORE_SLICE_MS) { await turn(); sliceAt = Date.now(); }
        if (restoreStopped()) return stopped(entries.length);
        if (!ptys.heldOf(e.key)) continue; // opened or closed meanwhile
        let { s } = e, pickup = false;
        if (e.pickup) {
          const rec = e.from ? handoffs().bySession.get(e.from) : null;
          if (!(rec && rec.next && ID_RE.test(rec.next))) {
            if (HO.safeFile(e.pickup)) { queue.push({ key: e.key, tier: 2, at: mtimeOf(e.pickup) }); continue; }
            ptys.take(e.key); dropped = true;
            log(`restore: pickup of ${e.pickup} failed: the handoff file is gone`);
            continue;
          }
          ptys.take(e.key); dropped = true;
          s = { ...s, id: rec.next.toLowerCase() };
          pickup = true;
          log(`restore: the handoff of ${e.from} was picked up as ${rec.next}`);
          if (ptys.heldOf(s.id)) continue; // listed too
        }
        const id = s.id, role = roleOf(s.role);
        // another device has it now (sync, away.json): resuming it here would run it in two places
        const away = awayOf(id);
        if (away) {
          ptys.take(id); dropped = true;
          log(`restore: ${id} is on ${away.device}${away.why === 'moving' ? ' (it was moving there)' : ''}; not resumed`);
          continue;
        }
        // its handoff was the last thing it did and nothing picked it up (its restart was lost): the pickup starts in
        // its place, as for one saved while it waited for its id
        const left = s.restartBy || pickup ? null : leftHandoff(id, s.cwd, handoffs());
        if (left) {
          ptys.take(id); dropped = true;
          const key = `pickup:${++pickups}`;
          ptys.hold(key, { ...s, id: null, busy: false, interrupted: false, pickup: left, handoffFrom: id }, null);
          queue.push({ key, tier: 2, at: mtimeOf(left) });
          log(`restore: ${id} handed off to ${path.basename(left)} and nothing picked it up; the pickup starts`);
          continue;
        }
        const interrupted = !!(s.busy || s.interrupted);
        const tier = tierOf(id, s, pickup);
        const extra = extraFor(id, s, interrupted, role);
        if (tier < 0) { checks.push({ id, s, extra }); continue; } // (held parked already)
        ptys.hold(id, s, extra);
        const tr = findTranscript(id, s.cwd);
        queue.push({ key: id, tier, at: tr ? tr.mtimeMs : s.startedAt });
      }
      if (dropped) changed();
      log(`restore: ${list.length} listed: ${queue.length} to resume, ${RESTORE_LIMIT} at a time${checks.length ? `, ${checks.length} idle to park unless their background tasks were running` : ''}`
        + ` (sorted in ${Date.now() - t0} ms; ${nHandoffs} handoff files read ahead in ${warmMs} ms)`);
      // the idle ones it would park, one per turn, alongside the starts: one that should run joins the queue
      let checking = true;
      const checked = (async () => {
        for (const c of checks) {
          await turn();
          if (restoreStopped()) break;
          if (!ptys.heldOf(c.id)) continue; // opened or closed meanwhile
          const tr = findTranscript(c.id, c.s.cwd);
          // not one whose log has been still for a day: no open turn counts then (recentLog), and no background task does
          // either (runningTasks counts one at most a day after its launch, which the log's mtime is after), so the
          // large reads are skipped for it
          if (!tr || !recentLog(tr.file)) continue;
          // saved idle, but its log ends mid-turn: its claude died before the list was saved (a shutdown kills claude
          // first, and its pid file goes with it), so it was cut off as surely as a busy one, and is told to carry on
          if (openTurn(tr.file)) {
            const s = { ...c.s, interrupted: true };
            ptys.hold(c.id, s, extraFor(c.id, s, true, roleOf(s.role)));
            queue.push({ key: c.id, tier: 1, at: tr.mtimeMs });
            log(`restore: ${c.id} was saved idle but its log ends mid-turn; it is resumed`);
            continue;
          }
          const k = runningTasks(tr.file);
          if (!k) continue;
          ptys.hold(c.id, c.s, c.extra);
          queue.push({ key: c.id, tier: 3, at: tr.mtimeMs });
          log(`restore: ${c.id} had ${k} background task(s) running; it is resumed`);
        }
      })().catch((e) => log(`restore: checking the idle ones failed: ${e && e.stack ? e.stack : e}`)).finally(() => { checking = false; });
      // one start: { r: 'ok' | 'failed' (it was tried) | 'skipped' (open in another claude, or away), pid }. One that could
      // not start is held again: for the retry the first time, parked until opened (keeping what open() gets) the second
      const again = []; // [{ key, at }]: the ones to try once more
      const startOne = (key, h, retry) => {
        const s = h.s;
        const keep = (why) => {
          ptys.hold(key, retry ? { ...s, parked: true } : s, h.extra);
          if (!retry) again.push({ key, at: Date.now() });
          else changed(); // (saved marked parked)
          log(`restore: ${s.id || `pickup of ${s.pickup}`} ${why}; ${retry ? 'parked until opened' : `tried again in ${Math.round(RESTORE_RETRY / 1000)} s`}`);
        };
        let r;
        if (!s.id) {
          try { r = ptys.startPickup(s.handoffFrom, HO.safeFile(s.pickup), { cwd: s.cwd, account: s.account, cols: s.cols, rows: s.rows }, { restored: true, handoffFrom: s.handoffFrom, role: s.role }); } catch (e) { r = { ok: false, message: e.message }; }
          if (!r.ok) { keep(`failed: ${r.message}`); return { r: 'failed' }; }
          log(`restore: pickup of ${s.pickup} started (pid ${r.pid})`);
          return { r: 'ok', pid: r.pid };
        }
        if (openNow().has(s.id)) { keep('is open in another claude'); return { r: 'skipped' }; }
        const away = awayOf(s.id);
        if (away) { log(`restore: ${s.id} is on ${away.device}${away.why === 'moving' ? ' (it was moving there)' : ''}; not resumed`); changed(); return { r: 'skipped' }; }
        const x = h.extra();
        try { r = ptys.open({ id: s.id, cwd: s.cwd, account: s.account, cols: s.cols, rows: s.rows }, x); } catch (e) { r = { ok: false, message: e.message }; }
        if (!r.ok) { keep(`failed: ${r.message}`); return { r: 'failed' }; }
        log(`restore: ${s.id} resumed (pid ${r.pid})${x.role ? `, as the ${x.role}` : ''}${x.interrupted ? ', was interrupted' : ''}${x.nudge ? `, note due (${x.nudge.kind})` : ''}`);
        return { r: 'ok', pid: r.pid };
      };
      const pool = await startPool({
        pending: queue, limit: RESTORE_LIMIT, gap: RESTORE_GAP, slotMs: RESTORE_SLOT, first: RESTORE_FIRST,
        held: (q) => !!ptys.heldOf(q.key), gone: (q) => log(`restore: ${q.key} was opened or closed meanwhile`),
        loaded: (pid) => ptys.loaded(pid), more: () => checking, stopped: restoreStopped,
        start: (q) => {
          const h = ptys.take(q.key);
          if (!h) { log(`restore: ${q.key} was opened or closed meanwhile`); return { r: 'skipped' }; }
          return startOne(q.key, h, false);
        },
      });
      await checked;
      let { last } = pool;
      if (pool.stopped || restoreStopped()) return stopped(queue.length + again.length);
      const p = ptys.parked().filter((x) => x.parked).length;
      log(`restore: ${pool.n} of ${list.length} resumed${p ? `, ${p} parked until opened` : ''}${again.length ? `, ${again.length} to try again` : ''} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
      if (!again.length) return;
      let n2 = 0;
      for (const [i, a] of again.entries()) {
        const wait = Math.max(a.at + RESTORE_RETRY, last + RESTORE_GAP) - Date.now();
        if (wait > 0) await sleep(wait);
        if (restoreStopped()) return stopped(again.length - i);
        const h = ptys.take(a.key);
        if (!h) { log(`restore: ${a.key} was opened or closed meanwhile`); continue; }
        const r = startOne(a.key, h, true);
        if (r.r !== 'skipped') last = Date.now();
        if (r.r === 'ok') n2++;
      }
      log(`restore: tried again: ${n2} of ${again.length} resumed`);
    })().catch((e) => log(`restore failed: ${e && e.stack ? e.stack : e}`));
  }

  // ---------- requests ----------
  let quitting = false;
  function quitAll(arg, reply) {
    if (quitting) return reply({ ok: true, message: 'already quitting' });
    if (restarting && restarting.going) return reply({ ok: true, message: 'restarting' }); // it saved and is ending them already
    if (restarting) { clearTimeout(restarting.timer); restarting = null; log('restart: cancelled by "quit everything"'); }
    quitting = true;
    if (arg && typeof arg.ui === 'object') ui = arg.ui;
    ptys.markCutOff(); // the ones mid-turn: saved busy, and ended without Ctrl+C (see endAll)
    saveNow('quit'); // every running session, with whether it was busy, before they end
    frozen = true;
    const n = ptys.aliveCount();
    log(`quit everything: saved ${n} session(s) to the restore list, ending them`);
    // it moves on after END_WATCHDOG_MS whatever happens; shutdown ends what is left
    let over = false;
    const next = (why, note) => {
      if (over) return;
      over = true;
      clearTimeout(watchdog);
      reply({ ok: true, saved: n, ...(note ? { note } : {}) });
      log(`quit everything: ${why}; host exits`);
      setTimeout(() => shutdown(0), 300);
    };
    const watchdog = setTimeout(() => next(`not all ended after ${END_WATCHDOG_MS / 1000} s`), END_WATCHDOG_MS);
    ptys.endAll(2500, { resume: true }).then(() => next('all ended'), (e) => next('ending them failed', String(e)));
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
  // CLAUDE_LAUNCH_KEY) is mid-turn or idle with background tasks running (now: not at all; one working as long as it
  // takes, one waiting on an answer or on its tasks ASK_WAIT_MS at most), checks again, then saves the restore list, ends
  // every session and hands over to a new host, which resumes them. The reply: { ok, waiting: [mid-turn ids], tasks:
  // [ids idle with background tasks running] }.
  let restarting = null; // { by, now, timer, going }
  function restart(arg, reply) {
    if (quitting) return reply({ ok: false, message: 'the host is quitting' });
    if (restarting) return reply({ ok: true, message: 'already restarting' });
    const r = restarting = { by: arg.by, now: arg.now, timer: null, going: false };
    log(`restart: asked${r.by ? ` by ${r.by}` : ''}${r.now ? ', now' : ''}; checking the new host.js loads`);
    selfCheck((err) => {
      if (restarting !== r) return reply({ ok: false, message: 'cancelled' });
      if (err) { restarting = null; log(`restart: refused, the self-check failed (${err})`); return reply({ ok: false, message: `The new host.js failed its self-check: ${err}` }); }
      const waiting = r.now ? [] : ptys.busyBut(r.by), tasks = r.now ? [] : ptys.tasksBut(r.by);
      reply({ ok: true, waiting, tasks });
      let loggedAt = Date.now();
      const askingSince = new Map(); // id -> when it was first seen waiting on an answer or on its tasks, while still so
      // what still holds it back: { held, asked, ran }. A working one is never cut off; one waiting on an answer is given
      // ASK_WAIT_MS (its question comes back: it is resumed and told to carry on); asked: the ones past that wait. One idle
      // whose background tasks still run (tasksBut) is given the same wait, so they can finish; ran: the ones past it
      const holding = () => {
        const busy = r.now ? [] : ptys.busyBut(r.by), working = r.now ? [] : ptys.workingBut(r.by), bg = r.now ? [] : ptys.tasksBut(r.by);
        const asking = busy.filter((id) => !working.includes(id)), now = Date.now();
        const capped = [...asking, ...bg];
        for (const id of [...askingSince.keys()]) if (!capped.includes(id)) askingSince.delete(id);
        for (const id of capped) if (!askingSince.has(id)) askingSince.set(id, now);
        const over = (id) => now - askingSince.get(id) >= ASK_WAIT_MS;
        const asked = asking.filter(over), ran = bg.filter(over);
        return { held: [...busy.filter((id) => !asked.includes(id)), ...bg.filter((id) => !ran.includes(id))], asked, ran };
      };
      const waitText = ASK_WAIT_MS >= 60000 ? `${Math.round(ASK_WAIT_MS / 60000)} min` : `${Math.round(ASK_WAIT_MS / 1000)} s`;
      const tick = () => {
        if (restarting !== r) return;
        const { held, asked, ran } = holding(), now = Date.now();
        if (held.length) {
          if (now - loggedAt >= 10 * 60000) { loggedAt = now; log(`restart: still waiting on ${held.join(', ')}`); }
          r.timer = setTimeout(tick, 2000);
          return;
        }
        if (asked.length) log(`restart: ${asked.join(', ')} waited ${waitText} for an answer; restarting (they are told to carry on)`);
        if (ran.length) log(`restart: ${ran.join(', ')} still had background tasks running after ${waitText}; restarting (they are told their tasks stopped)`);
        // host.js may have changed again while it waited
        selfCheck((err2) => {
          if (restarting !== r) return;
          if (err2) { restarting = null; log(`restart: cancelled, the self-check failed (${err2})`); return; }
          // checked again right before anything is saved or ended, from the pid files as they are now (the scan reads
          // them every 0.8 s, and the self-check took a while): one that started work meanwhile is waited for (#402)
          ptys.rescan();
          const again = holding().held;
          if (again.length) {
            log(`restart: ${again.join(', ')} started work meanwhile; waiting again`);
            r.timer = setTimeout(tick, 2000);
            return;
          }
          handOver(r);
        });
      };
      if (waiting.length) log(`restart: waiting on ${waiting.join(', ')}`);
      if (tasks.length) log(`restart: waiting on ${tasks.join(', ')}: idle, with background tasks running (${waitText} at most)`);
      tick();
    });
  }
  // The next host starts first (FV_HOST_SUCCESSOR: it waits for this one to let go of the pipe, then resumes the
  // restore list), so there is one whatever becomes of this one while it ends the sessions (#452: this process died at
  // "ending them" and none came after it). One that could not start cancels the restart: nothing is saved or ended.
  // Then the restore list is saved, every session ended (the ones mid-turn without Ctrl+C: see endAll) and this one
  // exits, END_WATCHDOG_MS after it began at most (shutdown ends what is left).
  function handOver(r) {
    r.going = true;
    const cancel = (why) => { if (restarting === r) restarting = null; log(`restart: could not start the next host (${why}); cancelled, the sessions go on here`); };
    let c;
    try {
      // the same electron.exe (or node) and file, or "Fleet View.exe" once desktop/brand-exe.js has made it;
      // FV_HOST_* test settings carry over (claude never sees FV_*)
      const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', FV_HOST_SUCCESSOR: String(process.pid) };
      c = spawn(P.brandedElectron(process.execPath), [HOST_JS], { detached: true, windowsHide: true, stdio: 'ignore', env, cwd: DIR });
    } catch (e) { return cancel(e.message); }
    let begun = false;
    c.once('error', (e) => { if (begun) log(`restart: the next host failed: ${e.message}`); else cancel(e.message); });
    c.once('spawn', () => {
      begun = true;
      c.unref();
      log(`restart: started the next host (pid ${c.pid}); it takes over once this one exits`);
      const asker = ptys.markRestartBy(r.by);
      ptys.markCutOff();
      saveNow('restart');
      frozen = true;
      log(`restart: saved ${ptys.aliveCount()} session(s) to the restore list${asker ? ` (asked from ${asker})` : ''}; ending them`);
      let over = false;
      const next = (why) => {
        if (over) return;
        over = true;
        clearTimeout(watchdog);
        log(`restart: ${why}; this one exits`);
        shutdown(0);
      };
      const watchdog = setTimeout(() => next(`the sessions had not all ended after ${END_WATCHDOG_MS / 1000} s`), END_WATCHDOG_MS);
      // (tests: FV_HOST_TEST_END_HANG=1 makes the first host's end phase never finish, for the watchdog)
      const ending = TEST && !SUCCESSOR && process.env.FV_HOST_TEST_END_HANG === '1' ? new Promise(() => {}) : ptys.endAll(2500, { resume: true });
      ending.then(() => next('the sessions ended'), (e) => next(`ending the sessions failed (${e && e.message ? e.message : e})`));
    });
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
          return reply(ptys.open({ id: o.id, cwd: typeof o.cwd === 'string' ? o.cwd : null, account: acctId(o.account), cols: o.cols, rows: o.rows, role: roleOf(o.role) }));
        }
        case 'sendTo': {
          const o = a[0] && typeof a[0] === 'object' ? a[0] : {};
          return ptys.sendTo({ id: o.id, cwd: typeof o.cwd === 'string' ? o.cwd : null, account: acctId(o.account), cols: o.cols, rows: o.rows }).then(reply, fail);
        }
        case 'switchAccount': {
          const o = a[0] && typeof a[0] === 'object' ? a[0] : {};
          return ptys.switchAccount({ id: o.id, account: acctId(o.account), rescue: o.rescue === true }).then(reply, fail);
        }
        case 'create': {
          const o = a[0] && typeof a[0] === 'object' ? a[0] : {};
          if (typeof o.cwd !== 'string' || !o.cwd) return reply({ ok: false, message: 'no folder given' });
          return reply(ptys.create({ cwd: o.cwd, account: acctId(o.account), cols: o.cols, rows: o.rows, chrome: typeof o.chrome === 'boolean' ? o.chrome : undefined,
            forkFrom: typeof o.forkFrom === 'string' && ID_RE.test(o.forkFrom) ? o.forkFrom : undefined,
            model: typeof o.model === 'string' && MODEL_RE.test(o.model) ? o.model : undefined, effort: EFFORT_LEVELS.has(o.effort) ? o.effort : undefined,
            role: roleOf(o.role) || undefined }));
        }
        // true, or { ok: false, reason } when it could not be typed (ptys.write), so a sender can say "not sent" at once
        case 'write': {
          const why = typeof a[0] === 'string' && KEY_RE.test(a[0]) ? ptys.write(a[0], a[1]) : 'not found';
          return reply(why ? { ok: false, reason: why } : true);
        }
        case 'resize': if (typeof a[0] === 'string' && KEY_RE.test(a[0])) ptys.resize(a[0], Number(a[1]), Number(a[2])); return reply(true);
        case 'kill': if (typeof a[0] === 'string' && KEY_RE.test(a[0])) ptys.kill(a[0]); return reply(true);
        case 'list': return reply(ptys.list());
        case 'parked': return reply(ptys.parked());
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
    const left = ptys.aliveCount();
    if (left) log(`exiting: ending the trees of the ${left} session(s) still running`);
    try { ptys.killAll(); } catch {}
    try { const h = readJson(hostFile()); if (h && h.pid === process.pid) fs.unlinkSync(hostFile()); } catch {}
    for (const c of clients) { try { c.sock.destroy(); } catch {} }
    try { server && server.close(); } catch {}
    setTimeout(() => process.exit(code), 100);
  }

  server = net.createServer(onConnection);
  // a successor waits for the host before it to let go of the pipe (it is ending its sessions, END_WATCHDOG_MS and
  // its last taskkill at most); if the window started a host of its own meanwhile, that one keeps it and this one
  // exits, as usual. A predecessor that still holds it PREDECESSOR_STUCK_MS on (host.json still names it) is stuck: it
  // is ended, once, and this one takes over
  const retryUntil = SUCCESSOR ? Date.now() + SUCCESSOR_WAIT_MS : 0;
  let stuckAt = SUCCESSOR ? Date.now() + PREDECESSOR_STUCK_MS : 0;
  const endStuck = () => {
    if (!stuckAt || Date.now() < stuckAt) return;
    stuckAt = 0;
    const h = readJson(hostFile());
    if (!h || h.pid !== SUCCESSOR || !pidAlive(SUCCESSOR)) return;
    log(`the host before this one (pid ${SUCCESSOR}) still holds the pipe after ${PREDECESSOR_STUCK_MS / 1000} s; ending it`);
    try { process.kill(SUCCESSOR, 'SIGKILL'); } catch (e) { log(`could not end it: ${e.message}`); }
  };
  // macOS and Linux: a socket file outlives a host that crashed, and listen then says EADDRINUSE too. Only a
  // socket that answers is another host; one that doesn't is removed and listen tries again (twice at most)
  let staleTries = 0;
  const staleSocket = (cb) => {
    if (P.isWin || staleTries >= 2) return cb(false);
    const probe = net.connect(PIPE);
    const done = (alive) => { probe.removeAllListeners(); probe.destroy(); cb(alive); };
    probe.setTimeout(1500, () => done(true));
    probe.on('connect', () => done(true));
    probe.on('error', (err) => {
      if (!err || !['ECONNREFUSED', 'ENOTSOCK', 'ENOENT'].includes(err.code)) return done(true);
      staleTries++;
      try { if (!fs.lstatSync(PIPE).isSocket()) return done(true); fs.unlinkSync(PIPE); log(`removed a stale socket file ${PIPE}`); } catch {}
      probe.removeAllListeners(); probe.destroy(); cb(false, true);
    });
  };
  server.on('error', (e) => {
    if (e && e.code === 'EADDRINUSE') {
      return staleSocket((alive, removed) => {
        if (removed) { try { server.close(); } catch {} server.listen(PIPE); return; }
        if (Date.now() < retryUntil) { endStuck(); setTimeout(() => { try { server.close(); } catch {} server.listen(PIPE); }, 250); return; }
        log('another host already serves this pipe; exiting');
        process.exit(0);
      });
    }
    log(`pipe error: ${e && e.stack ? e.stack : e}`);
    process.exit(1);
  });
  server.listen(PIPE, () => {
    // the socket file is the user's alone (the token still guards it, as on Windows)
    if (!P.isWin) { try { fs.chmodSync(PIPE, 0o600); } catch (e) { log(`could not chmod the socket: ${e.message}`); } }
    try {
      writeJsonAtomic(hostFile(), { pid: process.pid, pipe: PIPE, token, startedAt, version: VERSION });
    } catch (e) { log(`could not write host.json: ${e.message}`); process.exit(1); }
    loadPty();
    log(`started: pipe ${PIPE}, version ${VERSION}, node ${process.versions.node}${process.versions.electron ? `, electron ${process.versions.electron}` : ''}, pty ${ptyName || `none (${ptyError && ptyError.message})`}${TEST ? ', TEST' : ''}${TEST_CMD ? `, test command ${TEST_CMD}` : ''}${SUCCESSOR ? `, successor of ${SUCCESSOR}` : ''}`);
    try { restore(); } catch (e) { log(`restore failed: ${e && e.stack ? e.stack : e}`); }
  });
}

module.exports = {
  createPtys, sessionDirs, readPidFiles, normDir, pipeName, dataDir, hostFile, sessionsFile, logFile, fileHash, readJson, runningTasks, openTurn,
  restoreOrder, startPool, warmHandoffs, RESTORE_FIRST, RESTORE_CONCURRENT, RESTORE_GAP_MS, RESTORE_SLOT_MS,
  HOST_JS, ID_RE, KEY_RE, NEW_RE, PROTO, FV_ALLOWED, BOT_ROLE_RE, ptyName: () => ptyName, ptyError: () => ptyError,
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
