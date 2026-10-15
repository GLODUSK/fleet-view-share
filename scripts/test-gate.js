#!/usr/bin/env node
// The test gate: runs the tests that cover what a branch changed, before it merges (CLAUDE.md, merge routine step 0),
// and every test in the share repo's workflow (.github/workflows/mac.yml, macOS and Windows).
//   node scripts/test-gate.js                 the tests for this branch: `git diff --name-only origin/main...HEAD`,
//                                             plus what is changed, staged or new and not committed yet
//   node scripts/test-gate.js --files a,b     the tests for these files instead (paths from the checkout's top)
//   node scripts/test-gate.js --all           every test
//   --list         say what would run and why, run nothing
//   --jobs <n>     at most n at once (default: half the cores, 2 to 6)
//   --timeout <s>  a test still running after s seconds is ended and fails (default 420: the slowest take two to
//                  three minutes on a busy PC)
//   --logs <dir>   keep each test's whole output there, one file per test
// Exit code 0 when everything run passed (a skipped test is not a failure), 1 when anything failed or timed out,
// 2 for a bad command line.
//
// What covers a changed file (mapFile below):
//   - a test file: itself
//   - x.js: scripts/x-test.js(.mjs) and desktop/x-test.js, by name; every test whose source names the file, or names a
//     module that loads it (followed through the modules' own require/import, but not through fleet-view.js, which a
//     test that starts a demo server only names); and the extra pairs in COVERS
//   - every changed .js/.mjs: `node --check` (web/*.js as an .mjs copy: the page's modules are ES modules)
//   - anything fleet-view.js loads: a boot of `fleet-view.js --demo --snapshot` (every module loads, one frame, exit 0)
//   - phone/: `tsc --noEmit` in phone/ and `vitest related --run` on the changed files (all of phone's tests for its
//     package files); web/ modules and fixtures the phone app imports go to `vitest related` too
//   - relay.js, scripts/phone-vectors.js, docs/phone-vectors.json: `node scripts/phone-vectors.js --check`
//   - .sh files and fv: `bash -n`; .ps1/.psm1: PowerShell's parser (Windows only)
// Never run here: scripts/sync-contract.js (the real `claude` on real projects folders) and scripts/codegraph-contract.js
// (the real CodeGraph and its settings). A change to what they check gets a note to run them by hand.
//
// Safety: nothing here talks to the live server or session host. Every test runs with FV_HOST_PIPE at a pipe of its own
// (a test pipe no host listens on, unless the test starts one), FV_HOST_DIR, FV_MERGE_LANE_DIR and, on Windows,
// LOCALAPPDATA in a temp folder, so a test that forgets to set them still never reaches the real ones. The tests that
// start a session host with a fake claude (HOST_LANE) run one at a time: their checks time a host's restore steps
// to the second, and two hosts plus their fakes at once on a busy machine made them miss.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const P = require(path.join(__dirname, '..', 'platform.js'));

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag) => { const i = argv.indexOf(flag); return i < 0 ? null : String(argv[i + 1] || '').trim(); };
const usage = (why) => { console.error(`test-gate: ${why}\nUsage: node scripts/test-gate.js [--files a,b | --all] [--list] [--jobs n] [--timeout s] [--logs dir]`); process.exit(2); };
for (const a of argv) if (a.startsWith('--') && !['--all', '--list', '--files', '--jobs', '--timeout', '--logs'].includes(a)) usage(`unknown option ${a}`);
const ALL = has('--all');
const filesArg = valueOf('--files');
if (filesArg !== null && !filesArg) usage('--files needs a comma-separated list');
if (ALL && filesArg !== null) usage('--all and --files go alone');
const JOBS = valueOf('--jobs') ? Number(valueOf('--jobs')) : Math.max(2, Math.min(6, Math.floor(os.cpus().length / 2)));
const TIMEOUT_S = valueOf('--timeout') ? Number(valueOf('--timeout')) : 420;
if (!(JOBS >= 1) || !(TIMEOUT_S > 0)) usage('--jobs and --timeout take a positive number');
const LOGS = valueOf('--logs') ? path.resolve(valueOf('--logs')) : null;

// ---------- the tests ----------
// every test the gate knows: scripts/*-test.js(.mjs) and desktop/*-test.js, run as `node <file>` from the checkout's top
const isTest = (f) => /^(?:scripts\/[\w.-]+-test\.m?js|desktop\/[\w.-]+-test\.js)$/.test(f);
// the contract tests: real Claude Code and real CodeGraph, never run by the gate
const MANUAL = {
  'scripts/sync-contract.js': 'it starts the real claude on made-up conversations in the real projects folders',
  'scripts/codegraph-contract.js': 'it runs the real CodeGraph and turns its telemetry setting off',
};
// what a change to these asks of a contract test, said as a note (the gate never runs them)
const MANUAL_FOR = [
  [/^(?:sync-(?:move|carry|clone|down|up)\.js|desktop\/host\.js|conversation\.js)$/, 'scripts/sync-contract.js'],
  [/^code-index\.js$/, 'scripts/codegraph-contract.js'],
];
// session-host tests (a host on a test pipe and fake claudes): one at a time, see the header
const HOST_LANE = new Set(['desktop/host-test.js', 'desktop/host-restore-test.js']);
// tests that need a file the share repo leaves out (publish-share.js LEAVE_OUT): skipped where it is missing
const NEEDS = {
  'scripts/sync-setup-test.js': ['private.json'],
  'scripts/relay-test.js': ['scripts/publish-share.js'],
  'scripts/sync-api-test.js': ['scripts/publish-share.js'],
};
// pairs the name rule and the source scan miss: [changed file (a RegExp on its path), tests that cover it]
const COVERS = [
  [/^handoff\.js$/, ['desktop/host-test.js', 'desktop/host-restore-test.js']],
  [/^scripts\/merge-lane\.js$/, ['scripts/merge-lane-test.js']],
  [/^bot\//, ['scripts/bot-tasks-test.mjs', 'scripts/bots-test.mjs']],
  [/^mod\/fleet-view-feed\//, ['scripts/feed-mod-update-test.js']],
];

// ---------- the checkout's files and who loads what ----------
const git = (...args) => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', maxBuffer: 64 << 20, windowsHide: true });
const lines = (s) => s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const exists = (f) => fs.existsSync(path.join(ROOT, f));
const read = (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { return ''; } };
const tracked = lines(git('ls-files', '--cached', '--others', '--exclude-standard')).filter(exists);
const trackedSet = new Set(tracked);
const tests = tracked.filter(isTest).sort();
// the modules a test or a module can name: .js/.mjs/.json outside phone/, node_modules and the page's vendor folder
const modules = tracked.filter((f) => /\.(?:m?js|json)$/.test(f) && !/^phone\/|(?:^|\/)node_modules\/|^web\/vendor\//.test(f));
const moduleSet = new Set(modules);

// the repo files a source names in its string literals: './x.js' and '../web/x.js' from its own folder, 'desktop/host.js'
// from the top, path.join(..., 'web', 'x.js') as web/x.js, and a bare 'x.js' (or path.join(..., '..', 'x.js')) in its
// own folder, else the top, else desktop/ or scripts/. A bare name after another folder (path.join(dir, 'src',
// 'app.js'), a made-up project's file) names nothing.
function namedIn(file) {
  const src = read(file), dir = path.posix.dirname(file), out = new Set();
  const add = (f) => { if (f && moduleSet.has(f) && f !== file) out.add(f); };
  // a page module loads only what it imports (its other literals are data: file names in a picker's sample list)
  if (/^web\//.test(file) && !isTest(file)) {
    for (const m of src.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)(['"])(\.{1,2}\/[^'"]+)\1/g)) add(path.posix.normalize(path.posix.join(dir, m[2])));
    return out;
  }
  const re = /(['"`])((?:\.{1,2}\/)*(?:[\w.-]+\/)*[\w.-]+\.(?:m?js|json))\1/g;
  let m;
  while ((m = re.exec(src))) {
    const lit = m[2];
    if (lit.startsWith('.')) { add(path.posix.normalize(path.posix.join(dir, lit))); continue; }
    if (lit.includes('/')) { add(lit); add(path.posix.join(dir, lit)); continue; }
    // path.join(..., 'web', 'x.js'): the folder is the literal before it
    const before = src.slice(Math.max(0, m.index - 60), m.index).match(/(['"])([^'"\s]*)\1\s*,\s*$/);
    if (before && /^(?:web|desktop|scripts|docs|bot)$/.test(before[2])) { add(`${before[2]}/${lit}`); continue; }
    if (before && !/^\.{1,2}$/.test(before[2])) continue;
    add([path.posix.join(dir, lit), lit, `desktop/${lit}`, `scripts/${lit}`].find((f) => moduleSet.has(f)));
  }
  return out;
}
const names = new Map(); // file -> the repo files it names
const namesOf = (f) => { if (!names.has(f)) names.set(f, namedIn(f)); return names.get(f); };
// everything a test reaches: what it names, then what those modules name, and so on, but not past fleet-view.js
// (tests start it as a demo server; the boot check covers what it loads)
function reach(start) {
  const seen = new Set(), todo = [...namesOf(start)];
  while (todo.length) {
    const f = todo.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    if (f === 'fleet-view.js' || !/\.m?js$/.test(f) || isTest(f)) continue;
    for (const g of namesOf(f)) todo.push(g);
  }
  return seen;
}
let reachCache = null;
const reaches = () => reachCache || (reachCache = new Map(tests.map((t) => [t, reach(t)])));
// what fleet-view.js loads, all the way down (the boot check covers these)
let bootSet = null;
const bootCovers = (f) => {
  if (!bootSet) {
    bootSet = new Set(['fleet-view.js']);
    const todo = [...namesOf('fleet-view.js')];
    while (todo.length) { const g = todo.pop(); if (bootSet.has(g) || !/\.m?js$/.test(g) || /^web\//.test(g)) continue; bootSet.add(g); todo.push(...namesOf(g)); }
  }
  return bootSet.has(f);
};

// ---------- the checks ----------
// a check: { key, name, why: [], args, cwd, env, lane, needs, skip, run }
const checks = new Map();
function want(key, make, why) {
  if (!checks.has(key)) checks.set(key, { key, why: [], ...make() });
  const c = checks.get(key);
  if (why && !c.why.includes(why)) c.why.push(why);
}
const node = (file, ...args) => ({ args: [process.execPath, file, ...args] });
const wantTest = (t, why) => want(`test:${t}`, () => ({ name: t, ...node(t), lane: HOST_LANE.has(t) ? 'host' : null, needs: NEEDS[t] || [] }), why);
const notes = new Set();
const uncovered = [];
const PHONE = exists('phone/package.json');
const phoneBin = (pkg, bin) => path.join(ROOT, 'phone', 'node_modules', pkg, bin);
const phoneFiles = new Set();
let phoneAll = false;

// a parse check of one file: node --check, a web/ module through an .mjs copy (an ES module in a .js file)
let tmpRoot = null;
const tmp = () => tmpRoot || (tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-test-gate-')));
function wantParse(f) {
  if (!/^web\//.test(f)) return want(`parse:${f}`, () => ({ name: `node --check ${f}`, ...node('--check', f) }));
  want(`parse:${f}`, () => {
    const copy = path.join(tmp(), 'web-' + f.slice(4).replace(/[\\/]/g, '-').replace(/\.js$/, '.mjs'));
    return { name: `node --check ${f} (as .mjs)`, before: () => fs.copyFileSync(path.join(ROOT, f), copy), ...node('--check', copy) };
  });
}
// Git for Windows' bash (not WSL's, which C:\Windows\System32\bash.exe starts); elsewhere the bash on PATH
function bashPath() {
  if (!P.isWin) return 'bash';
  try {
    const top = path.resolve(git('--exec-path').trim(), '..', '..', '..');
    return [path.join(top, 'bin', 'bash.exe'), path.join(top, 'usr', 'bin', 'bash.exe')].find((b) => fs.existsSync(b)) || null;
  } catch { return null; }
}

// what covers one changed file; returns true when anything does
function mapFile(f) {
  let any = false;
  const deleted = !exists(f);
  if (f in MANUAL) { notes.add(`${f} changed: run it by hand (the gate never does: ${MANUAL[f]})`); any = true; }
  for (const [re, t] of MANUAL_FOR) if (re.test(f)) notes.add(`${f} changed: consider \`node ${t}\` by hand (${MANUAL[t]})`);
  if (/^phone\//.test(f)) {
    if (/^phone\/(?:package(?:-lock)?\.json|tsconfig\.json|vitest\.config\.mts|test\/)/.test(f)) phoneAll = true;
    else if (!deleted && /\.(?:tsx?|m?js|json)$/.test(f)) phoneFiles.add(f);
    else phoneAll = phoneAll || deleted;
    return true;
  }
  if (isTest(f)) { if (!deleted) wantTest(f, 'changed'); return true; }
  if (/\.(?:m?js)$/.test(f) && !deleted && !/^web\/vendor\//.test(f)) { wantParse(f); any = true; }
  if (/(?:\.sh|^fv)$/.test(f) && !deleted) {
    const bash = bashPath();
    if (bash) want(`bash:${f}`, () => ({ name: `bash -n ${f}`, args: [bash, '-n', f] }));
    else notes.add(`${f}: no Git Bash found, its syntax was not checked`);
    any = true;
  }
  if (/\.ps(?:m?1)$/.test(f) && !deleted) {
    if (P.isWin) {
      const ps = `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${path.join(ROOT, f).replace(/'/g, "''")}', [ref]$null, [ref]$e); if ($e) { $e | ForEach-Object { Write-Output ('line ' + $_.Extent.StartLineNumber + ': ' + $_.Message) }; exit 1 }`;
      want(`ps:${f}`, () => ({ name: `PowerShell parse ${f}`, args: ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', ps] }));
    } else notes.add(`${f}: PowerShell files are parsed on Windows only`);
    any = true;
  }
  // by name: x.js -> scripts/x-test.js(.mjs), desktop/x-test.js (a web/ module only by the scan: three names are taken twice)
  if (/\.m?js$/.test(f) && !/^web\//.test(f)) {
    const base = path.posix.basename(f).replace(/\.m?js$/, '');
    for (const t of [`scripts/${base}-test.js`, `scripts/${base}-test.mjs`, `desktop/${base}-test.js`]) if (trackedSet.has(t)) { wantTest(t, `named after ${f}`); any = true; }
  }
  for (const [t, set] of reaches()) if (set.has(f)) { wantTest(t, `loads ${f}`); any = true; }
  for (const [re, ts] of COVERS) if (re.test(f)) for (const t of ts) if (trackedSet.has(t)) { wantTest(t, `covers ${f}`); any = true; }
  if (/^(?:relay\.js|scripts\/phone-vectors\.js|docs\/phone-vectors\.json)$/.test(f) && exists('scripts/phone-vectors.js')) {
    want('vectors', () => ({ name: 'node scripts/phone-vectors.js --check', ...node('scripts/phone-vectors.js', '--check') }), f);
    any = true;
  }
  // the phone app imports some of the page's modules and fixtures, and the relay's test vectors
  if (PHONE && !deleted && /^(?:web\/[\w.-]+\.js|web\/fixtures\/|docs\/phone-vectors\.json)/.test(f)) phoneFiles.add(f);
  if (!deleted && /\.m?js$/.test(f) && bootCovers(f)) {
    want('boot', () => {
      const home = path.join(tmp(), 'boot-home');
      fs.mkdirSync(home, { recursive: true });
      return { name: 'boot: fleet-view.js --demo --snapshot', ...node('fleet-view.js', '--demo', '--snapshot'),
        env: { LOCALAPPDATA: home, HOME: home, USERPROFILE: home, XDG_STATE_HOME: home } };
    }, f);
    any = true;
  }
  return any;
}

// the phone app: its typecheck, then its tests (those related to the changed files, or all of them)
function wantPhone() {
  if (!phoneAll && !phoneFiles.size) return;
  if (!PHONE) { notes.add('phone/ is not in this checkout: its typecheck and tests were not run'); return; }
  const tsc = phoneBin('typescript', path.join('bin', 'tsc')), vitest = phoneBin('vitest', 'vitest.mjs');
  const missing = !fs.existsSync(tsc) || !fs.existsSync(vitest) ? 'phone/node_modules is missing or incomplete (no typescript or vitest in it: npm ci in phone/)' : null;
  const cwd = path.join(ROOT, 'phone');
  const onlyPhoneSrc = [...phoneFiles].every((f) => /^phone\//.test(f));
  if (phoneAll || [...phoneFiles].some((f) => /^phone\//.test(f))) want('phone:tsc', () => ({ name: 'phone: tsc --noEmit', args: [process.execPath, tsc, '--noEmit'], cwd, missing }));
  const rel = [...phoneFiles].map((f) => path.join(ROOT, f));
  if (phoneAll) want('phone:vitest', () => ({ name: 'phone: vitest run', args: [process.execPath, vitest, 'run'], cwd, missing }));
  else want('phone:vitest', () => ({ name: `phone: vitest related (${phoneFiles.size} file${phoneFiles.size === 1 ? '' : 's'})`,
    args: [process.execPath, vitest, 'related', '--run', ...(onlyPhoneSrc ? [] : ['--passWithNoTests']), ...rel], cwd, missing, passWithNone: true }));
}

// ---------- what changed ----------
function changedFiles() {
  const out = new Set();
  let base = true;
  try { git('rev-parse', '--verify', '--quiet', 'origin/main'); } catch { base = false; }
  if (base) for (const f of lines(git('diff', '--name-only', 'origin/main...HEAD'))) out.add(f);
  else notes.add('no origin/main here: only uncommitted changes were looked at (git fetch first, or --all)');
  for (const f of lines(git('diff', '--name-only', 'HEAD'))) out.add(f);
  for (const f of lines(git('ls-files', '--others', '--exclude-standard'))) out.add(f);
  return [...out].map((f) => f.replace(/\\/g, '/')).sort();
}

let files = [];
if (ALL) {
  for (const t of tests) wantTest(t, 'all');
  if (exists('scripts/phone-vectors.js')) want('vectors', () => ({ name: 'node scripts/phone-vectors.js --check', ...node('scripts/phone-vectors.js', '--check') }), 'all');
  mapFile('fleet-view.js');
  for (const f of tracked) if (/(?:\.sh|^fv|\.psm?1)$/.test(f)) mapFile(f);
  phoneAll = PHONE;
  if (!PHONE) notes.add('phone/ is not in this checkout: its typecheck and tests were not run');
} else {
  files = filesArg !== null ? filesArg.split(',').map((f) => f.trim().replace(/\\/g, '/').replace(/^\.\//, '')).filter(Boolean) : changedFiles();
  for (const f of files) if (!mapFile(f)) uncovered.push(f);
}
wantPhone();

// ---------- running them ----------
const list = [...checks.values()];
// the safety environment every check gets (see the header), each with its own pipe and folders
let seq = 0;
function envFor(c) {
  const n = ++seq, dir = path.join(tmp(), `run-${n}`);
  fs.mkdirSync(dir, { recursive: true });
  const tag = `fleet-view-host-gate${process.pid}-${n}`;
  const env = { ...process.env, FV_HOST_PIPE: P.isWin ? `\\\\.\\pipe\\${tag}` : path.join(os.tmpdir(), `${tag}.sock`), FV_HOST_DIR: path.join(dir, 'host'),
    FV_MERGE_LANE_DIR: path.join(dir, 'merge-lane') };
  if (P.isWin) env.LOCALAPPDATA = path.join(dir, 'local');
  else if (!P.isMac) env.XDG_STATE_HOME = path.join(dir, 'state');
  delete env.CLAUDE_CODE_SESSION_ID;
  return { ...env, ...(c.env || {}) };
}
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;
const pad = (s, n) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
const tail = (s, n) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').split(/\r?\n/).filter((l) => l.trim()).slice(-n).map((l) => `      ${l.slice(0, 300)}`).join('\n');

// the tests running now: a Ctrl+C ends them and what they started (on macOS they lead their own process groups)
const live = new Set();
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { for (const c of live) P.killTree(c.pid, { sync: true }); process.exit(130); });

function runOne(c) {
  return new Promise((resolve) => {
    const gone = (c.needs || []).filter((f) => !exists(f));
    if (gone.length) return resolve({ c, status: 'SKIP', detail: `needs ${gone.join(', ')}, not in this checkout` });
    if (c.missing) return resolve({ c, status: 'FAIL', detail: c.missing, out: '' });
    try { if (c.before) c.before(); } catch (e) { return resolve({ c, status: 'FAIL', detail: e.message, out: '' }); }
    const t0 = Date.now();
    let out = '', timedOut = false;
    const child = spawn(c.args[0], c.args.slice(1), { cwd: c.cwd || ROOT, env: envFor(c), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...P.detachGroup });
    live.add(child);
    child.on('close', () => live.delete(child));
    const keep = (d) => { out += d; if (out.length > 4e6) out = out.slice(-2e6); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => { timedOut = true; P.killTree(child.pid, { sync: true }); }, (c.timeout || TIMEOUT_S) * 1000);
    child.on('error', (e) => { out += `\n${e.message}`; });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const ms = Date.now() - t0;
      if (LOGS) { try { fs.mkdirSync(LOGS, { recursive: true }); fs.writeFileSync(path.join(LOGS, c.name.replace(/[^\w.-]+/g, '_') + '.txt'), out); } catch {} }
      if (timedOut) return resolve({ c, status: 'TIME', ms, detail: `still running after ${c.timeout || TIMEOUT_S}s, ended`, out });
      // vitest related with nothing related: no tests is not a failure
      if (code !== 0 && c.passWithNone && /No test files found/i.test(out)) return resolve({ c, status: 'PASS', ms, detail: 'no related tests', out });
      resolve({ c, status: code === 0 ? 'PASS' : 'FAIL', ms, detail: code === 0 ? '' : signal ? `ended by ${signal}` : `exit ${code}`, out });
    });
  });
}

async function runAll() {
  const results = [], queue = [...list];
  // the slow ones first (host tests, the phone app), so the run ends sooner
  queue.sort((a, b) => (b.lane === 'host') - (a.lane === 'host') || /^phone:/.test(b.key) - /^phone:/.test(a.key));
  let running = 0, hostBusy = false;
  await new Promise((done) => {
    const next = () => {
      if (!queue.length && !running) return done();
      while (running < JOBS) {
        const i = queue.findIndex((c) => c.lane !== 'host' || !hostBusy);
        if (i < 0) break;
        const c = queue.splice(i, 1)[0];
        running++;
        if (c.lane === 'host') hostBusy = true;
        runOne(c).then((r) => {
          running--;
          if (c.lane === 'host') hostBusy = false;
          results.push(r);
          console.log(`${pad(r.status, 5)} ${pad(c.name, 46)} ${pad(r.ms !== undefined ? secs(r.ms) : '', 7)}${r.detail ? ` ${r.detail}` : ''}`);
          next();
        });
      }
    };
    next();
  });
  return results;
}

(async () => {
  const t0 = Date.now();
  if (!ALL) {
    console.log(`test-gate: ${files.length} changed file${files.length === 1 ? '' : 's'}${filesArg !== null ? ' (--files)' : ''}`);
    if (uncovered.length) console.log(`  no test covers: ${uncovered.join(', ')}`);
  }
  for (const n of notes) console.log(`  note: ${n}`);
  if (has('--list')) {
    for (const c of list) console.log(`  ${c.name}${c.lane === 'host' ? ' [one at a time]' : ''}${c.why.length ? `  <- ${c.why.slice(0, 4).join('; ')}${c.why.length > 4 ? ` (+${c.why.length - 4})` : ''}` : ''}`);
    console.log(`test-gate: ${list.length} check${list.length === 1 ? '' : 's'} would run`);
    return;
  }
  if (!list.length) { console.log('test-gate: nothing to run'); return; }
  console.log(`test-gate: ${list.length} check${list.length === 1 ? '' : 's'}, ${JOBS} at a time`);
  const results = await runAll();
  const bad = results.filter((r) => r.status === 'FAIL' || r.status === 'TIME');
  for (const r of bad) console.log(`\n--- ${r.c.name}: ${r.detail}\n${tail(r.out || '', 30) || '      (no output)'}`);
  const count = (s) => results.filter((r) => r.status === s).length;
  console.log(`\ntest-gate: ${count('PASS')} passed, ${count('FAIL')} failed, ${count('TIME')} timed out, ${count('SKIP')} skipped in ${secs(Date.now() - t0)}${bad.length ? ': RED, do not merge' : ''}`);
  if (tmpRoot) { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {} }
  process.exitCode = bad.length ? 1 : 0;
})().catch((e) => { console.error(`test-gate: ${e.stack || e}`); process.exit(1); });
