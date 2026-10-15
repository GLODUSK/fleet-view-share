// Fleet View: what differs between Windows, macOS and Linux, in one place; a new platform check belongs here.
// On Windows every answer is what the code gave before this file existed.
//   isWin, isMac            the platform
//   dataDir()               Fleet View's own folder: %LOCALAPPDATA%\fleet-view on Windows,
//                           ~/Library/Application Support/fleet-view on macOS, ${XDG_STATE_HOME:-~/.local/state}/fleet-view elsewhere
//   hostSocketPath(tag)     where the session host listens: the named pipe \\.\pipe\fleet-view-host-<tag> on Windows,
//                           else the Unix socket <dataDir>/host-<tag>.sock (in the temp folder when that path is too long)
//   foldCase(p)             p lowercased where paths ignore case (Windows, macOS), as it is on Linux
//   killTree(pid, o)        ends a process (or a list of them) and everything it started; nothing waits for it
//                           (o.sync: wait for taskkill on Windows, ps on macOS and Linux; o.done(): called when done)
//   detachGroup             spawn option: on macOS and Linux a child started with it leads its own process group,
//                           so killTree can end the group; Windows keeps its old spawn options
//   processes(cb), processesSync()   [{ pid, ppid, command }] of every process (macOS and Linux only, through ps)
//   commandLines(cb, image) [{ pid, command }] of every process with its whole command line, or null when it can't
//                           tell (Windows: Win32_Process in a hidden PowerShell, only the image named, e.g. node.exe)
//   which(name)             the full path of a command on PATH (the login shell's PATH on macOS), or null
//   loginShellPath()        PATH as the user's login shell sets it (macOS: an app started from Finder or launchd
//                           gets a bare PATH without Homebrew, npm or ~/.local/bin); the process's own PATH elsewhere
//   applyLoginPath()        macOS and Linux: process.env.PATH = loginShellPath(), once for the process and its children
//   openTerminal(o)         a new terminal window running o.cmd in o.cwd: { cwd, cmd, title } -> Promise { ok, message }
//                           (Windows Terminal or a console window on Windows; Terminal.app on macOS, iTerm2 with
//                           FV_TERMINAL=iterm; x-terminal-emulator, gnome-terminal or konsole on Linux)
//   shellQuote(s)           s as one word for sh
//   resumeCommand(id, letter, configDir)   macOS and Linux: the sh line for `claude --resume <id>` in that account
//   keychainCredentials(dir, viaEnv)   macOS: a Claude account's sign-in from the Keychain (Promise; null elsewhere)
//   electronBinary(dir)     the Electron binary under <dir>/node_modules/electron/dist for this platform (on Windows
//                           the branded copy when it is ready, see brandedElectron)
//   brandedElectron(exe)    Windows: "Fleet View.exe" beside electron.exe when desktop/brand-exe.js made it from this
//                           very electron.exe (Task Manager then shows Fleet View and its logo, not Electron), else exe
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execFile } = require('child_process');

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

function dataDir() {
  if (isWin) return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'fleet-view');
  if (isMac) return path.join(os.homedir(), 'Library', 'Application Support', 'fleet-view');
  const x = process.env.XDG_STATE_HOME;
  return path.join(x && path.isAbsolute(x) ? x : path.join(os.homedir(), '.local', 'state'), 'fleet-view');
}

// A Unix socket path may hold about 104 bytes (macOS) or 108 (Linux); past 100 the temp folder is used instead
function hostSocketPath(tag) {
  if (isWin) return `\\\\.\\pipe\\fleet-view-host-${tag}`;
  const p = path.join(dataDir(), `host-${tag}.sock`);
  return Buffer.byteLength(p) <= 100 ? p : path.join(os.tmpdir(), `fleet-view-host-${tag}.sock`);
}

const foldCase = (p) => (isWin || isMac ? String(p).toLowerCase() : String(p));

// ---------- processes ----------
const detachGroup = isWin ? {} : { detached: true };

function parsePs(out) {
  const list = [];
  for (const line of String(out || '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s?(.*)$/.exec(line);
    if (m) list.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] || '' });
  }
  return list;
}
const PS_ARGS = ['-A', '-o', 'pid=,ppid=,command='];
function processesSync() {
  if (isWin) return null;
  try {
    const r = spawnSync('ps', PS_ARGS, { encoding: 'utf8', timeout: 10000, maxBuffer: 16 << 20 });
    return r.status === 0 ? parsePs(r.stdout) : null;
  } catch { return null; }
}
function processes(cb) {
  if (isWin) return cb(null);
  execFile('ps', PS_ARGS, { encoding: 'utf8', timeout: 20000, maxBuffer: 16 << 20 }, (err, out) => cb(err ? null : parsePs(out)));
}
function commandLines(cb, image) {
  if (!isWin) return processes((list) => cb(list && list.map(({ pid, command }) => ({ pid, command }))));
  const only = image ? ` -Filter "Name='${String(image).replace(/[^\w.-]/g, '')}'"` : '';
  const ps = `[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-CimInstance Win32_Process${only} | ForEach-Object { [string]$_.ProcessId + [char]9 + $_.CommandLine }`;
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 16 << 20 }, (err, out) => {
    if (err) return cb(null);
    cb(String(out).split(/\r?\n/).flatMap((l) => { const m = /^(\d+)\t(.*)$/.exec(l); return m ? [{ pid: Number(m[1]), command: m[2] }] : []; }));
  });
}
// processTable(cb, match): [{ pid, ppid, started, mb, command }] of every process, or null when it can't tell. started:
// when it started (ms since 1970, null when unknown), mb: its memory in MB. Only a command line holding the text
// match (any case) is filled in, the others read ''. Windows: Win32_Process in a hidden PowerShell, every process
// (a parent can be any program); macOS and Linux: ps, its elapsed time giving started
function processTable(cb, match) {
  const m = String(match || '').toLowerCase();
  if (!isWin) {
    execFile('ps', ['-A', '-o', 'pid=,ppid=,rss=,etime=,command='], { encoding: 'utf8', timeout: 20000, maxBuffer: 16 << 20 }, (err, out) => {
      if (err) return cb(null);
      const now = Date.now(), list = [];
      for (const line of String(out).split('\n')) {
        const r = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s?(.*)$/.exec(line);
        if (!r) continue;
        const secs = ((Number(r[4] || 0) * 24 + Number(r[5] || 0)) * 60 + Number(r[6])) * 60 + Number(r[7]);
        const command = r[8] || '';
        list.push({ pid: Number(r[1]), ppid: Number(r[2]), started: now - secs * 1000, mb: Math.round(Number(r[3]) / 1024), command: command.toLowerCase().includes(m) ? command : '' });
      }
      cb(list);
    });
    return;
  }
  const like = m.replace(/[^\w.-]/g, '');
  const ps = `[Console]::OutputEncoding = [Text.Encoding]::UTF8; $e = [datetime]'1970-01-01'; Get-CimInstance Win32_Process | ForEach-Object { $t = if ($_.CreationDate) { [long]($_.CreationDate.ToUniversalTime() - $e).TotalMilliseconds } else { '' }; $c = if ($_.CommandLine -like '*${like}*') { $_.CommandLine } else { '' }; [string]$_.ProcessId + [char]9 + [string]$_.ParentProcessId + [char]9 + [string]$t + [char]9 + [string]$_.WorkingSetSize + [char]9 + $c }`;
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 16 << 20 }, (err, out) => {
    if (err) return cb(null);
    cb(String(out).split(/\r?\n/).flatMap((l) => {
      const r = /^(\d+)\t(\d+)\t(\d*)\t(\d*)\t(.*)$/.exec(l);
      return r ? [{ pid: Number(r[1]), ppid: Number(r[2]), started: r[3] ? Number(r[3]) : null, mb: r[4] ? Math.round(Number(r[4]) / 1048576) : null, command: r[5] }] : [];
    }));
  });
}
// every process below pid (children, their children, ...), from one ps table
function descendants(pid, list) {
  const kids = new Map();
  for (const p of list || []) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(p.pid); }
  const out = [], todo = [pid], seen = new Set([pid]);
  while (todo.length) {
    for (const k of kids.get(todo.shift()) || []) if (!seen.has(k)) { seen.add(k); out.push(k); todo.push(k); }
  }
  return out;
}

// Windows: taskkill /T /F, as before. macOS and Linux: SIGTERM to the process's group (a pty's child and anything
// started with detachGroup leads one) and to every descendant ps finds (one that left the group too), then SIGKILL
// to the same after 3 s, from a small detached sh so it happens even when this process exits first.
// pid may be a list: one taskkill (one ps and one sh on macOS and Linux) for them all. Nothing waits for it but with
// o.sync, for a process about to exit (taskkill, or ps, runs to its end first: a few seconds at most); o.done() is
// called once it has done what it can (taskkill exited, the signals are sent).
function killTree(pid, o = {}) {
  const pids = [...new Set((Array.isArray(pid) ? pid : [pid]).filter((p) => Number.isInteger(p) && p > 0 && p !== process.pid))];
  let called = false;
  const done = () => { if (!called) { called = true; if (typeof o.done === 'function') o.done(); } };
  if (!pids.length) return done();
  if (isWin) {
    const args = ['/T', '/F', ...pids.flatMap((p) => ['/PID', String(p)])];
    try {
      if (o.sync) { spawnSync('taskkill', args, { windowsHide: true, stdio: 'ignore', timeout: Math.min(15000, 4800 + 200 * pids.length) }); return done(); }
      const c = spawn('taskkill', args, { windowsHide: true, stdio: 'ignore', timeout: 30000 });
      c.on('error', done);
      c.on('exit', done);
    } catch { done(); }
    return;
  }
  // the snapshot first: once a group is gone, a descendant that left it hangs from init (ppid 1) and is not found
  const go = (list) => {
    const kids = [...new Set(pids.flatMap((p) => descendants(p, list)))].filter((k) => k !== process.pid && !pids.includes(k));
    const groups = pids.filter((p) => { try { process.kill(-p, 'SIGTERM'); return true; } catch { return false; } });
    for (const p of [...pids, ...kids]) { try { process.kill(p, 'SIGTERM'); } catch {} }
    const targets = [...groups.map((p) => `-${p}`), ...pids.map(String), ...kids.map(String)];
    try {
      const c = spawn('/bin/sh', ['-c', `sleep 3; kill -9 ${targets.join(' ')} 2>/dev/null`], { detached: true, stdio: 'ignore' });
      c.on('error', () => {});
      c.unref();
    } catch {}
    done();
  };
  if (o.sync) go(processesSync());
  else processes(go);
}

// ---------- PATH and commands ----------
let loginPath = null;
function loginShellPath() {
  if (isWin) return process.env.PATH || process.env.Path || '';
  if (loginPath !== null) return loginPath;
  // a parent (the window, the server) already put it in this process's PATH: no shell again
  if (process.env.FV_LOGIN_PATH === '1' && process.env.PATH) return (loginPath = process.env.PATH);
  let got = [];
  if (isMac && process.env.FV_NO_LOGIN_SHELL !== '1') {
    const shell = process.env.SHELL && path.isAbsolute(process.env.SHELL) ? process.env.SHELL : '/bin/zsh';
    const mark = '_FV_PATH_';
    // interactive too (-i), as Terminal.app starts it: many keep PATH in ~/.zshrc. stdin is empty, so a profile
    // that asks something gets no answer and goes on; 8 s at most each
    for (const flags of ['-ilc', '-lc']) {
      try {
        const r = spawnSync(shell, [flags, `printf '%s%s%s' ${mark} "$PATH" ${mark}`], {
          encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, TERM: 'dumb' },
        });
        const m = new RegExp(`${mark}([^\\n]*?)${mark}`).exec(String(r.stdout || ''));
        if (m && m[1]) { got = m[1].split(':'); break; }
      } catch {}
    }
  }
  const home = os.homedir();
  const extra = isMac ? ['/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.local', 'bin')] : [path.join(home, '.local', 'bin')];
  const seen = new Set(), out = [];
  for (const d of [...got, ...String(process.env.PATH || '').split(':'), ...extra, '/usr/bin', '/bin', '/usr/sbin', '/sbin']) {
    if (!d || !path.isAbsolute(d) || seen.has(d)) continue;
    seen.add(d);
    out.push(d);
  }
  loginPath = out.join(':');
  return loginPath;
}

// macOS and Linux: this process's PATH becomes the login shell's, for everything it starts (git, gh, claude, node,
// codegraph, tailscale), and FV_LOGIN_PATH=1 tells its children so. Windows: nothing changes
function applyLoginPath() {
  if (isWin || process.env.FV_LOGIN_PATH === '1') return;
  process.env.PATH = loginShellPath();
  process.env.FV_LOGIN_PATH = '1';
}

function which(name) {
  if (typeof name !== 'string' || !/^[\w.+-]{1,80}$/.test(name)) return null;
  if (isWin) {
    try {
      const r = spawnSync('where', [name], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
      if (r.status !== 0) return null;
      return String(r.stdout).split(/\r?\n/).map((l) => l.trim()).find(Boolean) || null;
    } catch { return null; }
  }
  for (const d of loginShellPath().split(':')) {
    const f = path.join(d, name);
    try { if (fs.statSync(f).isFile()) { fs.accessSync(f, fs.constants.X_OK); return f; } } catch {}
  }
  return null;
}

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// ---------- a terminal window ----------
// o.cmd is a shell command line (sh on macOS and Linux, cmd on Windows); it runs after a cd to o.cwd. Nothing
// from this process's environment reaches it on macOS (Terminal starts its own shell): put what it needs in cmd.
function openTerminal(o = {}) {
  const cwd = typeof o.cwd === 'string' && o.cwd ? o.cwd : os.homedir();
  const title = String(o.title || 'Claude').replace(/[\x00-\x1f]/g, ' ').slice(0, 80);
  const cmd = String(o.cmd || '');
  return new Promise((resolve) => {
    const done = (ok, message) => resolve({ ok, message });
    if (isWin) {
      const t = title.replace(/[;"%&^|<>]/g, ' ');
      const wt = which('wt');
      const consoleWindow = () => {
        try {
          const c = spawn(process.env.ComSpec || 'cmd.exe', [`/d /c start "${t}" /D "${cwd}" cmd /k ${cmd.replace(/&/g, '^&')}`], { windowsVerbatimArguments: true, windowsHide: true, stdio: 'ignore' });
          c.on('error', (e) => done(false, `could not open a console window: ${e.message}`));
          c.on('exit', (code) => done(code === 0, code === 0 ? 'opened in a new console window' : `start said ${code}`));
        } catch (e) { done(false, `could not open a console window: ${e.message}`); }
      };
      if (!wt) return consoleWindow();
      try {
        const c = spawn(wt, ['-w', 'new', 'new-tab', '--title', t, '-d', cwd, 'cmd', '/k', cmd], { detached: true, stdio: 'ignore', windowsHide: true });
        c.on('spawn', () => done(true, 'opened in a new Windows Terminal tab'));
        c.on('error', consoleWindow);
        c.unref();
      } catch { consoleWindow(); }
      return;
    }
    const line = `cd ${shellQuote(cwd)} && ${cmd}`;
    if (isMac) {
      // the command and the title go in as arguments (argv), never into the AppleScript text
      const iterm = String(process.env.FV_TERMINAL || '').toLowerCase() === 'iterm';
      const script = iterm ? [
        'on run argv',
        'tell application "iTerm"',
        'activate',
        'set w to (create window with default profile)',
        'tell current session of w',
        'write text (item 1 of argv)',
        'try',
        'set name to (item 2 of argv)',
        'end try',
        'end tell',
        'end tell',
        'end run',
      ] : [
        'on run argv',
        'set wasRunning to application "Terminal" is running',
        'tell application "Terminal"',
        // a Terminal that was not running opens a window of its own as it starts: use that one
        'if wasRunning then',
        'set t to do script (item 1 of argv)',
        'else',
        'try',
        'set t to do script (item 1 of argv) in window 1',
        'on error',
        'set t to do script (item 1 of argv)',
        'end try',
        'end if',
        'try',
        'set custom title of t to (item 2 of argv)',
        'end try',
        'activate',
        'end tell',
        'end run',
      ];
      const app = iterm ? 'iTerm2' : 'Terminal';
      execFile('osascript', [...script.flatMap((l) => ['-e', l]), line, title], { timeout: 20000 }, (err, _out, errOut) => {
        if (err) return done(false, `could not open ${app}: ${String(errOut || err.message).trim().slice(0, 200)}`);
        done(true, `opened in a new ${app} window`);
      });
      return;
    }
    const keep = `${line}; exec "\${SHELL:-sh}"`;
    const tries = [['x-terminal-emulator', ['-e', 'sh', '-c', keep]], ['gnome-terminal', ['--', 'sh', '-c', keep]], ['konsole', ['-e', 'sh', '-c', keep]], ['xterm', ['-T', title, '-e', 'sh', '-c', keep]]];
    const next = (i) => {
      if (i >= tries.length) return done(false, 'no terminal found (x-terminal-emulator, gnome-terminal, konsole or xterm)');
      const [exe, args] = tries[i];
      const f = which(exe);
      if (!f) return next(i + 1);
      try {
        const c = spawn(f, args, { detached: true, stdio: 'ignore' });
        c.on('spawn', () => done(true, `opened in a new ${exe} window`));
        c.on('error', () => next(i + 1));
        c.unref();
      } catch { next(i + 1); }
    };
    next(0);
  });
}

// macOS and Linux: the sh line that resumes a conversation in a terminal under a Claude account. The account's
// launcher (claude-<letter> on PATH) when it has one and its own folder is the config folder, else claude with
// CLAUDE_CONFIG_DIR set in the line itself (B, the default ~/.claude, needs none). configDir: another config
// folder than the account's own (--root), or null.
function resumeCommand(id, letter, configDir) {
  const L = typeof letter === 'string' && /^[a-z]$/i.test(letter) ? letter.toLowerCase() : 'b';
  const own = path.join(os.homedir(), L === 'b' ? '.claude' : `.claude-${L}`);
  const dir = configDir ? path.resolve(configDir) : own;
  const tail = `--resume ${shellQuote(id)}`;
  if (foldCase(dir) === foldCase(own)) {
    if (L === 'b') return `claude ${tail}`;
    if (which(`claude-${L}`)) return `claude-${L} ${tail}`;
  }
  return `CLAUDE_CONFIG_DIR=${shellQuote(dir)} claude ${tail}`;
}

// macOS: Claude Code keeps its sign-in in the login Keychain, not in <config>/.credentials.json. The item is
// "Claude Code-credentials", with "-<first 8 hex of sha256(the folder)>" after it for a folder set through
// CLAUDE_CONFIG_DIR (viaEnv: every account but B). -> Promise of what the file would hold ({ claudeAiOauth }) or null.
// Read with `security`, which wrote the item, so no Keychain prompt; elsewhere always null
function keychainCredentials(configDir, viaEnv) {
  if (!isMac) return Promise.resolve(null);
  const hash = viaEnv ? `-${require('crypto').createHash('sha256').update(String(configDir)).digest('hex').slice(0, 8)}` : '';
  return new Promise((resolve) => {
    execFile('security', ['find-generic-password', '-s', `Claude Code-credentials${hash}`, '-w'], { encoding: 'utf8', timeout: 10000 }, (err, out) => {
      if (err) return resolve(null);
      try { const j = JSON.parse(String(out).trim()); resolve(j && typeof j === 'object' ? j : null); } catch { resolve(null); }
    });
  });
}

// desktop/brand-exe.js writes "Fleet View.exe" and then a stamp of the electron.exe it copied (size and time); a
// stamp that no longer matches (Electron was updated in place) means the copy is stale, and electron.exe runs instead
const BRANDED_EXE = 'Fleet View.exe';
function electronStamp(exe) {
  const st = fs.statSync(exe);
  return `${st.size}:${Math.round(st.mtimeMs)}`;
}
function brandedElectron(exe) {
  if (!isWin || !exe || path.basename(exe).toLowerCase() !== 'electron.exe') return exe;
  const copy = path.join(path.dirname(exe), BRANDED_EXE);
  try {
    if (fs.readFileSync(`${copy}.stamp`, 'utf8').trim() === electronStamp(exe) && fs.existsSync(copy)) return copy;
  } catch {}
  return exe;
}

function electronBinary(desktopDir) {
  const dist = path.join(desktopDir, 'node_modules', 'electron', 'dist');
  if (isWin) return brandedElectron(path.join(dist, 'electron.exe'));
  if (isMac) return path.join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron');
  return path.join(dist, 'electron');
}

module.exports = {
  isWin, isMac, dataDir, hostSocketPath, foldCase, detachGroup, processes, processesSync, commandLines, processTable, descendants, killTree,
  loginShellPath, applyLoginPath, which, shellQuote, openTerminal, resumeCommand, keychainCredentials, electronBinary,
  brandedElectron, BRANDED_EXE, electronStamp,
};
