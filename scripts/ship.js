#!/usr/bin/env node
// Ship a merged-to-be PR: CLAUDE.md's "Restart after every update" steps 1-7 as one command, run from anywhere.
//   node scripts/ship.js <PR#> [--dry-run] [--no-host]
// 1. takes the merge lane (scripts/merge-lane.js; waits up to an hour when another session holds it)
// 2. merges the PR (gh pr merge --merge, never --admin; one already merged is carried on with) and pulls main in the
//    main checkout (<main>: Z:\Github\fleet-view on the PC, ~/code/fleet-view on the Mac; FV_MAIN overrides)
// 3. restarts what the merge changed (git diff <before> <new main>):
//      server  a root .js file or web/: touches fleet-view.js and waits for server.log's newest "start: port" line to
//              name a commit holding the merge
//      window  desktop/ (not host.js, tests or docs), PC: closes the Fleet View window gracefully (CloseMainWindow,
//              never a kill) and starts it again with fleet-view.vbs. Mac: install.sh --after-update does it
//      host    desktop/host.js or handoff.js: desktop/restart-host.js, last (PC; on the Mac install.sh runs it)
// 4. checks the share repo publish: PC, the post-merge hook's entry in share-publish.log (runs publish-share.js
//    itself when the hook left none; puts scripts/post-merge-hook.sh in .git/hooks when the hook is missing or
//    differs); Mac, runs publish-share.js
//    and says how the share repo's CI stands (its newest finished run on main: green, or red since when; share-health.js)
// 5. releases the lane and prints one line: the version, what it restarted, whether a host restart follows
// 6. host restart last (it ends the session that runs this; --no-host leaves it to you). On the Mac, install.sh
//    --after-update --from <before> runs last, detached, logging to update-install.log.
// --dry-run merges, restarts and writes nothing: it prints the plan from the PR's files.
// Any failure stops it with a message (exit 1), and a lane it took is always released. Exit 2: a usage error.
// The logic is in pure functions with exec and fs passed in (makeIo); scripts/ship-test.js tests them.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const REPO = 'GLODUSK/fleet-view';
const DESKTOP_LOADS = ['platform.js', 'screen.js'];
const LIMITS = { serverMs: 60000, closeMs: 30000, backMs: 60000, publishMs: 180000, entryMs: 20000, installMs: 300000, pollMs: 2000 };

class Stop extends Error {}

// ---------- pure ----------

// where the main checkout is: FV_MAIN, else the platform's place when it is there, else the folder holding this
// clone's shared .git (git rev-parse --git-common-dir, passed in as commonDir)
function mainDir({ env = {}, platform, home, exists = () => true, commonDir = '' }) {
  if (env.FV_MAIN) return env.FV_MAIN;
  const def = platform === 'win32' ? 'Z:\\Github\\fleet-view' : platform === 'darwin' ? path.join(home || '', 'code', 'fleet-view') : '';
  if (def && exists(def)) return def;
  if (commonDir) return path.dirname(commonDir.replace(/[\\/]+$/, ''));
  return def;
}

// what a merge's changed files restart: { server, window, host, app, notes } (lists of files; app: Mac only, the
// files install.sh rebuilds Fleet View.app for, which it handles itself)
function classify(files, platform) {
  const out = { server: [], window: [], host: [], app: [], notes: [] };
  const mac = platform === 'darwin';
  let phone = false, pkgs = false;
  for (const raw of files) {
    const f = String(raw).replace(/\\/g, '/');
    if (/\.md$/i.test(f) || /-test\.m?js$/.test(f)) continue;
    if (/^phone\//.test(f)) { phone = true; continue; }
    if (f === 'handoff.js') { out.server.push(f); out.host.push(f); continue; }
    if (f === 'desktop/host.js') { out.host.push(f); continue; }
    if (/^[^/]+\.js$/.test(f) || /^web\//.test(f)) { out.server.push(f); continue; }
    if (mac && (/^desktop\/package(?:-lock)?\.json$/.test(f) || f === 'desktop/icon.js' || f === 'scripts/mac-app.sh')) { out.app.push(f); continue; }
    if (/^desktop\//.test(f)) { if (/^desktop\/package(?:-lock)?\.json$/.test(f)) pkgs = true; out.window.push(f); }
  }
  // root modules desktop/ loads besides handoff.js: CLAUDE.md restarts only the server for them, so say so
  const shared = out.server.filter((f) => DESKTOP_LOADS.includes(f));
  if (shared.length) out.notes.push(`${shared.join(', ')}: desktop/ (the window, the session host) loads ${shared.length === 1 ? 'it' : 'them'} too and keeps the old copy until its next restart`);
  if (phone) out.notes.push('phone/ changed: ship does not update the phone app (eas update is its own step)');
  if (pkgs && !mac) out.notes.push("desktop/'s packages changed: the window restart does not reinstall them (npm ci in desktop/ with Fleet View quit)");
  return out;
}

// the newest "start: port" line of server.log: { port, version, commit, line }, or null
function parseStart(text) {
  const lines = String(text || '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /\bstart: port (\d+), version (?:(\d+\.\d+\.\d+) \(([0-9a-f]{7,40})\)|([0-9a-f]{7,40})\b|[^,]*)/.exec(lines[i]);
    if (m) return { port: Number(m[1]), version: m[2] || '', commit: m[3] || m[4] || '', line: lines[i] };
  }
  return null;
}

// server.log's newest "stop: exit code N" line when no "start: port" line came after it: the server that logged its
// exit, { pid, code, at (ms, local time as logged; 0 when unreadable), line }, or null. With that pid still alive the
// server is stuck in its exit (#574).
function parseStuck(text) {
  const lines = String(text || '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/\bstart: port \d+/.test(lines[i])) return null;
    const m = /^(?:(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)\.(\d{3}) )?\[node (\d+)\] stop: exit code (-?\d+)/.exec(lines[i]);
    if (m) return { pid: Number(m[8]), code: Number(m[9]), at: m[1] ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]).getTime() : 0, line: lines[i] };
  }
  return null;
}

// the Stop for a server that did not start: names the old one when it is still running after its stop line
function notStarted(io, text, last) {
  const s = parseStuck(text);
  if (s && io.alive(s.pid)) {
    const ago = s.at ? Math.round((io.now() - s.at) / 1000) : -1;
    const end = io.platform === 'win32' ? `Stop-Process -Id ${s.pid} -Force` : `kill -9 ${s.pid}`;
    return new Stop(`the old server (pid ${s.pid}) is still running${ago >= 0 && ago < 86400 ? ` ${ago} s` : ''} after it logged its exit (${s.code}): #574; the window ends it after 5 s, or end it with ${end}`);
  }
  return new Stop(`the server did not start on the merge within ${LIMITS.serverMs / 1000} s; newest start line: ${last ? last.line : '(none)'}`);
}

// share-publish.log's newest entry ("--- <date> after pull to <sha>" and the lines below it) for the main commit sha:
// { state: 'none' | 'running' | 'published' | 'already' | 'failed', line, entry }
function parsePublish(text, sha) {
  const lines = String(text || '').split(/\r?\n/);
  let found = null;
  for (let i = 0; i < lines.length; i++) {
    const m = /^--- .* after pull to ([0-9a-f]{7,40})\s*$/.exec(lines[i]);
    if (!m) continue;
    let j = i + 1;
    while (j < lines.length && !/^--- .* after pull to /.test(lines[j])) j++;
    if (sha && String(sha).startsWith(m[1])) found = lines.slice(i, j).filter((l) => l.trim());
    i = j - 1;
  }
  if (!found) return { state: 'none', line: '', entry: [] };
  const pick = (re) => found.find((l) => re.test(l));
  let l;
  if ((l = pick(/^published: /))) return { state: 'published', line: l, entry: found };
  if ((l = pick(/the share repo already has this version/))) return { state: 'already', line: l, entry: found };
  if ((l = pick(/^refused:|^\S*Error\b|^fatal:|^could not publish/))) return { state: 'failed', line: l, entry: found };
  return { state: 'running', line: found[found.length - 1], entry: found };
}

// a publish-share.js run's own output: ok when its last line says it published or had this version already
function publishOk(out) {
  const last = String(out || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() || '';
  return { ok: /^published: /.test(last) || /the share repo already has this version/.test(last), line: last };
}

// the Fleet View window of the main checkout in a process list [{ pid, command }]: the Electron (Fleet View.exe or
// electron.exe) under <main>\desktop started with --url=, not a child process (--type=)
function findWindowPid(list, main) {
  const top = String(main).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase() + '\\desktop\\';
  for (const p of list || []) {
    const c = String(p.command || '');
    if (!/--url=/.test(c) || /--type=/.test(c)) continue;
    const exe = c.replace(/^\s*"/, '').replace(/\//g, '\\').toLowerCase();
    if (exe.startsWith(top) && /\\(?:fleet view|electron)\.exe/.test(exe)) return p.pid;
  }
  return null;
}

// the session host's version for a host.js: the first 12 hex of its SHA-1 (host.js, fileHash)
const hostHash = (buf) => crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12);

const names = (list) => (list.length > 3 ? `${list.slice(0, 3).join(', ')} +${list.length - 3}` : list.join(', '));

// the steps, as lines to print: what would restart and why
function buildPlan({ pr, cls, platform, main, noHost, merged }) {
  const mac = platform === 'darwin';
  const lines = [];
  lines.push(`1. take the merge lane (note "${laneNote(pr, cls, platform)}"), waiting up to an hour if another session holds it`);
  lines.push(`2. ${merged ? `PR #${pr} is merged already: no merge` : `gh pr merge ${pr} -R ${REPO} --merge`}; git -C ${main} pull --ff-only`);
  let n = 3;
  if (cls.server.length) lines.push(`${n++}. server (${names(cls.server)}): touch fleet-view.js, wait for server.log's "start: port" line to name the merge`);
  if (!mac && cls.window.length) lines.push(`${n++}. window (${names(cls.window)}): close the Fleet View window gracefully, start fleet-view.vbs, wait for it to come back`);
  if (!cls.server.length && (mac || !cls.window.length)) lines.push(`${n++}. nothing to restart now${mac ? '' : ' (no server or window change)'}`);
  lines.push(`${n++}. publish: ${mac ? 'run scripts/publish-share.js, check its last line' : "wait for the post-merge hook's entry in share-publish.log (or run publish-share.js)"}`);
  lines.push(`${n++}. release the lane; print the version and what restarted`);
  if (mac) {
    const what = [cls.window.length && 'window', cls.app.length && 'app rebuild', cls.host.length && 'host'].filter(Boolean);
    if (cls.host.length && noHost) lines.push(`${n++}. host changed but --no-host: install.sh (which would restart it) is left for you`);
    else lines.push(`${n++}. last: install.sh --after-update --from <before>, detached${what.length ? ` (restarts: ${what.join(', ')})` : ''}`);
  } else if (cls.host.length) {
    lines.push(noHost ? `${n++}. host (${names(cls.host)}) changed but --no-host: run desktop/restart-host.js yourself, last`
      : `${n++}. last: host (${names(cls.host)}): node desktop/restart-host.js (ends this session)`);
  }
  return lines;
}

function laneNote(pr, cls, platform) {
  const r = [cls.server.length && 'server', (platform !== 'darwin' && cls.window.length) && 'window',
    cls.app.length && 'app', cls.host.length && 'host'].filter(Boolean);
  return `PR #${pr}, ship.js: ${r.length ? `restarts ${r.join(', ')}` : 'no restart'}`;
}

function summary({ version, short, restarted, published, hostNext, installNext }) {
  const tail = [hostNext && 'host restart next', installNext && 'install.sh next'].filter(Boolean);
  return `${version ? `${version} (${short})` : short} live${published ? ' and published' : ''}; restarted: ${restarted.length ? restarted.join(', ') : 'nothing'}${tail.length ? `; ${tail.join('; ')}` : ''}`;
}

// ---------- the real world ----------
function makeIo() {
  const platform = process.platform;
  const P = require(path.join(__dirname, '..', 'platform.js'));
  let commonDir = '';
  try { commonDir = spawnSync('git', ['-C', __dirname, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', windowsHide: true }).stdout.trim(); } catch {}
  const main = mainDir({ env: process.env, platform, home: os.homedir(), exists: (p) => fs.existsSync(path.join(p, 'fleet-view.js')), commonDir });
  return {
    platform, main, dataDir: P.dataDir(), node: process.execPath,
    who: process.env.CLAUDE_CODE_SESSION_ID || `ship.js-${process.pid}`,
    say: (s) => console.log(s),
    exec(cmd, args, o = {}) {
      const r = spawnSync(cmd, args, { cwd: o.cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 << 20, stdio: o.inherit ? 'inherit' : 'pipe', ...(o.timeout ? { timeout: o.timeout } : {}) });
      const out = `${r.stdout || ''}${r.stderr || ''}`.replace(/^\uFEFF/, '');
      return { code: r.status === null ? 1 : r.status, out: r.error ? `${out}${r.error.message}` : out };
    },
    readTail(file, bytes = 256 * 1024) {
      try {
        const fd = fs.openSync(file, 'r');
        try { const size = fs.fstatSync(fd).size, n = Math.min(size, bytes), buf = Buffer.alloc(n); fs.readSync(fd, buf, 0, n, size - n); return buf.toString('utf8'); } finally { fs.closeSync(fd); }
      } catch { return ''; }
    },
    readBytes(file) { try { return fs.readFileSync(file); } catch { return null; } },
    writeFile(file, text) { fs.writeFileSync(file, text, { mode: 0o755 }); },
    touch(file) { const t = new Date(); fs.utimesSync(file, t, t); },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } },
    // PC: the Electron processes with their command lines
    windows() {
      const ps = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-CimInstance Win32_Process -Filter \"Name='Fleet View.exe' or Name='electron.exe'\" | ForEach-Object { [string]$_.ProcessId + [char]9 + $_.CommandLine }";
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
      if (r.status !== 0) return null;
      return String(r.stdout).split(/\r?\n/).flatMap((l) => { const m = /^(\d+)\t(.*)$/.exec(l); return m ? [{ pid: Number(m[1]), command: m[2] }] : []; });
    },
    closeWindow(pid) {
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$p = Get-Process -Id ${Number(pid)} -ErrorAction Stop; $p.CloseMainWindow()`], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
      return r.status === 0 && /True/.test(r.stdout || '');
    },
    // a detached process, no console; with log, its output appended there. Returns { pid, exited: Promise<code> }
    detached(cmd, args, o = {}) {
      let fd = 'ignore';
      if (o.log) { fs.mkdirSync(path.dirname(o.log), { recursive: true }); fd = fs.openSync(o.log, 'a'); }
      const c = spawn(cmd, args, { cwd: o.cwd, detached: true, windowsHide: true, stdio: ['ignore', fd, fd] });
      const exited = new Promise((r) => { c.on('exit', (code) => r(code)); c.on('error', () => r(-1)); });
      c.unref();
      if (typeof fd === 'number') fs.closeSync(fd);
      return { pid: c.pid, exited };
    },
  };
}

// ---------- the steps ----------
const J = (io, ...p) => path.join(io.main, ...p);
const gitIn = (io, ...args) => io.exec('git', ['-C', io.main, ...args]);
const gitOut = (io, ...args) => { const r = gitIn(io, ...args); return r.code === 0 ? r.out.trim() : null; };
const isAncestor = (io, a, b) => gitIn(io, 'merge-base', '--is-ancestor', a, b).code === 0;

function prInfo(io, pr) {
  const r = io.exec('gh', ['pr', 'view', String(pr), '-R', REPO, '--json', 'number,title,state,baseRefName,mergeCommit,files']);
  if (r.code !== 0) throw new Stop(`gh pr view ${pr} failed: ${r.out.trim().split(/\r?\n/)[0] || `exit ${r.code}`}`);
  let j;
  try { j = JSON.parse(r.out); } catch { throw new Stop(`gh pr view ${pr} gave no JSON: ${r.out.slice(0, 200)}`); }
  return { title: j.title || '', state: j.state || '', base: j.baseRefName || '', merge: (j.mergeCommit && j.mergeCommit.oid) || '', files: (j.files || []).map((f) => f.path) };
}

// a merged PR's files from git (gh lists at most 100), else gh's list
function prFiles(io, info) {
  if (info.merge && gitIn(io, 'cat-file', '-e', `${info.merge}^{commit}`).code === 0) {
    const out = gitOut(io, 'diff', '--name-only', `${info.merge}^1`, info.merge);
    if (out !== null) return out.split(/\r?\n/).filter(Boolean);
  }
  return info.files;
}

async function waitFor(io, ms, fn) {
  const end = io.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (io.now() >= end) return null;
    await io.sleep(LIMITS.pollMs);
  }
}

async function restartServer(io, merge) {
  const log = path.join(io.dataDir, 'server.log');
  io.touch(J(io, 'fleet-view.js'));
  io.say('server: touched fleet-view.js; waiting for it to start again');
  let last = null, text = '';
  const ok = await waitFor(io, LIMITS.serverMs, () => {
    last = parseStart(text = io.readTail(log));
    return last && last.commit && isAncestor(io, merge, last.commit) ? last : null;
  });
  if (!ok) throw notStarted(io, text, last);
  io.say(`server: started, version ${ok.version || '?'} (${ok.commit})`);
}

async function restartWindow(io) {
  const list = io.windows();
  if (!list) throw new Stop('could not list processes to find the Fleet View window');
  const pid = findWindowPid(list, io.main);
  if (!pid) { io.say('window: no Fleet View window of the main checkout is running; nothing to restart'); return false; }
  if (!io.closeWindow(pid)) throw new Stop(`the Fleet View window (pid ${pid}) did not take the close (CloseMainWindow); close it yourself, then: wscript //nologo ${J(io, 'fleet-view.vbs')}`);
  io.say(`window: asked pid ${pid} to close; waiting for it to exit`);
  const gone = await waitFor(io, LIMITS.closeMs, () => !io.alive(pid));
  if (!gone) throw new Stop(`the Fleet View window (pid ${pid}) is still running after ${LIMITS.closeMs / 1000} s; it was not killed. Close it, then: wscript //nologo ${J(io, 'fleet-view.vbs')}`);
  io.detached('wscript.exe', ['//nologo', J(io, 'fleet-view.vbs')], { cwd: io.main });
  const back = await waitFor(io, LIMITS.backMs, () => { const p = findWindowPid(io.windows() || [], io.main); return p && p !== pid ? p : null; });
  if (!back) throw new Stop(`the Fleet View window did not come back within ${LIMITS.backMs / 1000} s after fleet-view.vbs`);
  io.say(`window: back (pid ${back})`);
  return true;
}

// the share repo's CI on main, as of its newest finished run (the one this publish starts takes about 5 minutes):
// share-health.js's line, "share CI: RED on the last 3 runs ... <url>" or "share CI: green (...)"; null when gh can't say
// (in 30 s: the merge is done by now, so a slow or missing gh never holds the ship up)
function shareCi(io) {
  try {
    const H = require(path.join(__dirname, '..', 'share-health.js'));
    const r = io.exec('gh', ['run', 'list', '-R', H.SHARE, '--workflow', H.WORKFLOW, '--branch', 'main', '--limit', '30', '--json', H.RUN_FIELDS], { timeout: 30000 });
    return r.code === 0 ? H.ciLine(H.ciState(JSON.parse(r.out))) : null;
  } catch { return null; }
}

function runPublish(io) {
  const r = io.exec(io.node, [J(io, 'scripts', 'publish-share.js')], { cwd: io.main });
  const p = publishOk(r.out);
  if (r.code !== 0 || !p.ok) throw new Stop(`publish-share.js did not publish (exit ${r.code}): ${p.line || '(no output)'}`);
  return p.line;
}

// PC: the main checkout's .git/hooks/post-merge is scripts/post-merge-hook.sh (LF line endings: the working copy may
// have CRLF, which sh can't run); put there when it is missing or differs, for the next pull (this one's publish is
// checked below either way). Returns what it did, or null
function ensureHook(io) {
  const want = io.readBytes(J(io, 'scripts', 'post-merge-hook.sh'));
  if (!want) return null;
  const text = want.toString('utf8').replace(/\r\n/g, '\n');
  const file = J(io, '.git', 'hooks', 'post-merge');
  const have = io.readBytes(file);
  if (have && have.toString('utf8') === text) return null;
  io.writeFile(file, text);
  return `${have ? 'updated' : 'installed'} the post-merge hook (.git/hooks/post-merge) from scripts/post-merge-hook.sh`;
}

async function checkPublish(io, sha) {
  if (io.platform === 'darwin') return runPublish(io);
  try { const h = ensureHook(io); if (h) io.say(`publish: ${h}`); } catch (e) { io.say(`publish: could not write the post-merge hook: ${e.message}`); }
  const log = path.join(io.dataDir, 'share-publish.log');
  const t0 = io.now();
  let last = { state: 'none' };
  const done = await waitFor(io, LIMITS.publishMs, () => {
    last = parsePublish(io.readTail(log), sha);
    if (last.state === 'none') return io.now() - t0 >= LIMITS.entryMs ? 'missing' : null;
    return last.state === 'running' ? null : last.state;
  });
  if (done === 'missing') { io.say(`publish: share-publish.log has no entry for ${sha.slice(0, 7)}; running publish-share.js`); return runPublish(io); }
  if (done === 'published' || done === 'already') return last.line;
  if (done === 'failed') throw new Stop(`the share publish failed: ${last.line}`);
  throw new Stop(`the share publish for ${sha.slice(0, 7)} did not finish within ${LIMITS.publishMs / 1000} s; its log so far: ${last.line || '(nothing)'}`);
}

async function ship(o, io) {
  const { pr, dry, noHost } = o;
  const mac = io.platform === 'darwin';
  const info = prInfo(io, pr);
  if (info.base !== 'main') throw new Stop(`PR #${pr} is into ${info.base || '?'}, not main`);
  if (info.state === 'CLOSED') throw new Stop(`PR #${pr} is closed without a merge`);
  const merged = info.state === 'MERGED';
  const files = prFiles(io, info);
  const cls = classify(files, io.platform);
  if (dry) {
    io.say(`ship --dry-run: PR #${pr} "${info.title}" (${info.state}${info.merge ? `, merge ${info.merge.slice(0, 7)}` : ''}), ${files.length} file${files.length === 1 ? '' : 's'}; main ${io.main} (${io.platform})`);
    const kinds = (f) => ['server', 'window', 'app', 'host'].filter((k) => cls[k].includes(f)).join(' + ') || '-';
    for (const f of files) io.say(`  ${f}  -> ${kinds(f)}`);
    for (const line of buildPlan({ pr, cls, platform: io.platform, main: io.main, noHost, merged })) io.say(line);
    for (const n of cls.notes) io.say(`note: ${n}`);
    io.say('dry run: nothing merged, restarted or written');
    return 0;
  }

  const lane = J(io, 'scripts', 'merge-lane.js');
  const note = laneNote(pr, cls, io.platform);
  let r = io.exec(io.node, [lane, 'take', '--who', io.who, '--note', note]);
  io.say(r.out.trim());
  if (r.code === 1) {
    io.say('ship: another session holds the merge lane; waiting up to an hour for it');
    r = io.exec(io.node, [lane, 'take', '--who', io.who, '--note', note, '--wait', '3600'], { inherit: true });
  }
  if (r.code !== 0) throw new Stop(`could not take the merge lane (exit ${r.code})`);

  let result;
  try { result = await shipLocked(o, io, info, merged); }
  finally {
    const rel = io.exec(io.node, [lane, 'release', '--who', io.who]);
    io.say(rel.out.trim() || `merge lane release: exit ${rel.code}`);
  }
  const { cls: done, restarted, published, newMain, from } = result;
  const hostNext = !mac && done.host.length && !noHost;
  const install = mac && !(done.host.length && noHost);
  const version = io.exec(io.node, [J(io, 'version.js')], { cwd: io.main }).out.trim();
  io.say(`publish: ${published}`);
  const ci = shareCi(io);
  if (ci) io.say(ci);
  for (const n of done.notes) io.say(`note: ${n}`);
  io.say(summary({ version, short: newMain.slice(0, 7), restarted, published: true, hostNext, installNext: install }));

  if (mac) {
    if (!install) { io.say(`--no-host: desktop/host.js changed; install.sh (which restarts the host) was not run. Run it yourself, last:\n  nohup bash ${J(io, 'install.sh')} --after-update --from ${from} </dev/null >> "${path.join(io.dataDir, 'update-install.log')}" 2>&1 &`); return 0; }
    const ends = done.host.length || done.app.length;
    if (ends) io.say(`install.sh --after-update --from ${from.slice(0, 7)} runs now, detached (log: update-install.log). It ${done.host.length ? 'restarts the session host' : 'rebuilds Fleet View.app'}, which ends this session; when you come back, check host.log's newest "started:" line${done.host.length ? ` reads version ${hostHash(io.readBytes(J(io, 'desktop', 'host.js')) || '')}` : ''}.`);
    const child = io.detached('nohup', ['bash', J(io, 'install.sh'), '--after-update', '--from', from], { cwd: io.main, log: path.join(io.dataDir, 'update-install.log') });
    if (ends) return 0;
    let exit = null;
    child.exited.then((c) => { exit = c; });
    const code = (await waitFor(io, LIMITS.installMs, () => exit !== null)) ? exit : 'timeout';
    const tail = io.readTail(path.join(io.dataDir, 'update-install.log'), 4096).split(/\r?\n/).filter((l) => l.trim()).slice(-6);
    io.say(`install.sh ${code === 'timeout' ? `still running after ${LIMITS.installMs / 1000} s` : `exited ${code}`}; update-install.log ends:\n  ${tail.join('\n  ')}`);
    return code === 0 ? 0 : 1;
  }
  if (done.host.length) {
    if (noHost) { io.say(`--no-host: ${names(done.host)} changed; run node ${J(io, 'desktop', 'restart-host.js')} yourself, as your last step`); return 0; }
    const buf = io.readBytes(J(io, 'desktop', 'host.js'));
    io.say(`host: restarting the session host (desktop/restart-host.js). It ends this session; when you come back with the [Fleet View] note, check host.log's newest "started:" line reads version ${buf ? hostHash(buf) : '?'}.`);
    const h = io.exec(io.node, [J(io, 'desktop', 'restart-host.js')], { cwd: io.main, inherit: true });
    if (h.code === 2) { io.say('host: the running host is too old to restart itself: end it the old way once (see the auto-restart-after-updates memory)'); return 1; }
    if (h.code !== 0) { io.say(`host: restart-host.js refused or got no answer (exit ${h.code})`); return 1; }
  }
  return 0;
}

// steps 2-4, while holding the lane
async function shipLocked({ pr }, io, info, merged) {
  const mac = io.platform === 'darwin';
  const branch = gitOut(io, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (branch !== 'main') throw new Stop(`the main checkout ${io.main} is on ${branch || '?'}, not main`);
  const before = gitOut(io, 'rev-parse', 'HEAD');
  let merge = info.merge;
  if (!merged) {
    const m = io.exec('gh', ['pr', 'merge', String(pr), '-R', REPO, '--merge']);
    io.say(m.out.trim() || `merged PR #${pr}`);
    if (m.code !== 0) throw new Stop(`gh pr merge ${pr} failed (exit ${m.code})`);
    merge = await waitFor(io, 20000, () => { const i = prInfo(io, pr); return i.state === 'MERGED' && i.merge ? i.merge : null; });
    if (!merge) throw new Stop(`PR #${pr} does not show as merged on GitHub after the merge`);
  } else io.say(`PR #${pr} is merged already (${merge.slice(0, 7)}); carrying on`);
  let pulled = false;
  for (let i = 0; i < 3 && !pulled; i++) {
    if (i) await io.sleep(5000);
    const p = gitIn(io, 'pull', '--ff-only');
    if (p.code !== 0) throw new Stop(`git -C ${io.main} pull --ff-only failed: ${p.out.trim().split(/\r?\n/).pop()}`);
    pulled = isAncestor(io, merge, 'HEAD');
  }
  if (!pulled) throw new Stop(`main in ${io.main} still lacks the merge ${merge.slice(0, 7)} after pulling`);
  const newMain = gitOut(io, 'rev-parse', 'HEAD');
  // main had the merge before this pull (an earlier run): restart for the PR's own changes and after
  const from = before && !isAncestor(io, merge, before) ? before : gitOut(io, 'rev-parse', `${merge}^1`);
  const changed = (gitOut(io, 'diff', '--name-only', from, newMain) || '').split(/\r?\n/).filter(Boolean);
  const cls = classify(changed, io.platform);
  io.say(`main: ${from.slice(0, 7)} -> ${newMain.slice(0, 7)}, ${changed.length} file${changed.length === 1 ? '' : 's'} changed`);
  const restarted = [];
  if (cls.server.length) { await restartServer(io, merge); restarted.push('server'); }
  if (!mac && cls.window.length && await restartWindow(io)) restarted.push('window');
  const published = await checkPublish(io, newMain);
  return { cls, restarted, published, newMain, from };
}

// ---------- the command line ----------
function parseArgs(argv) {
  const pr = argv.find((a) => /^#?\d+$/.test(a));
  const bad = argv.filter((a) => a !== pr && !['--dry-run', '--no-host'].includes(a));
  if (!pr || bad.length) return null;
  return { pr: Number(pr.replace('#', '')), dry: argv.includes('--dry-run'), noHost: argv.includes('--no-host') };
}

if (require.main === module) {
  const o = parseArgs(process.argv.slice(2));
  if (!o) { console.error('usage: node scripts/ship.js <PR#> [--dry-run] [--no-host]'); process.exit(2); }
  ship(o, makeIo()).then((code) => { process.exitCode = code; }, (e) => {
    console.error(e instanceof Stop ? `ship: stopped: ${e.message}` : `ship: ${e.stack || e}`);
    process.exitCode = 1;
  });
}

module.exports = { mainDir, classify, parseStart, parseStuck, parsePublish, publishOk, ensureHook, findWindowPid, hostHash, buildPlan, laneNote, summary, parseArgs, ship, Stop, LIMITS };
