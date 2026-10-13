// Code index: a build outlives a server restart, and a part-built index is picked up right (code-index.js).
//   node scripts/code-index-test.js        (Windows; CI_TEST_DIR picks the temp folder, CI_TEST_KEEP=1 keeps it)
// A fake CodeGraph (a codegraph.cmd first on PATH, running a small node script) builds an "index": a
// project_metadata table that reads "indexing", and a codegraph.lock with its pid, for as long as <checkout>\stub-ms
// says, then "complete". Like CodeGraph it refuses to build while the lock names a live process. Each "server" is a
// node process that requires code-index.js and wants the checkouts it is given, as fleet-view.js does; a server
// "restarts" by exiting, as with exit 75, which ends its cmd.exe child (node's job) but not the build below it.
//   1. a build the old server started still runs: the new server waits for it (no second build), logs it built,
//      and starts the next checkout only then
//   2. part-built, its lock names a pid that is gone: rebuilt at once (not after the 30 min a build may take)
//   3. part-built, no lock and no build running: rebuilt at once
//   4. part-built, its lock's pid is now an unrelated live process (pid reused): treated as gone, lock deleted, rebuilt
//   5. part-built while a build of it that Fleet View did not start runs: left alone
// Exit 0 = all pass.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

if (process.platform !== 'win32') { console.log('code-index-test: Windows only (its fake CodeGraph is a codegraph.cmd); skipped'); process.exit(0); }
const base = process.env.CI_TEST_DIR || os.tmpdir();
fs.mkdirSync(base, { recursive: true });
const T = fs.realpathSync(fs.mkdtempSync(path.join(base, 'fv-code-index-test-')));
const BIN = path.join(T, 'bin'), DATA = path.join(T, 'data'), CALLS = path.join(T, 'calls.txt');
const LOG = path.join(DATA, 'fleet-view', 'codegraph.log');
const CODE_INDEX = path.join(__dirname, '..', 'code-index.js');
process.env.LOCALAPPDATA = DATA; // before code-index.js is required: its log and records go there
const CI = require(CODE_INDEX);

let failures = 0, passes = 0;
const ok = (cond, what) => { if (cond) { passes++; console.log(`ok:   ${what}`); } else { failures++; console.log(`FAIL: ${what}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logText = () => { try { return fs.readFileSync(LOG, 'utf8'); } catch { return ''; } };
const calls = (top) => { try { return fs.readFileSync(CALLS, 'utf8').split('\n').filter((l) => l.endsWith(` ${top}`)).length; } catch { return 0; } };
const running = (top) => new Promise((r) => CI.nodes((list) => r((list || []).filter((p) => CI.runs(p.command, top)).map((p) => p.pid))));

// the fake CodeGraph
fs.mkdirSync(BIN, { recursive: true });
fs.writeFileSync(path.join(BIN, 'codegraph.cmd'), '@node --no-warnings "%~dp0codegraph.js" %*\r\n');
fs.writeFileSync(path.join(BIN, 'codegraph.js'), `'use strict';
const fs = require('fs'), path = require('path');
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('9.9.9'); process.exit(0); }
const top = a[a.length - 1], dir = path.join(top, '.codegraph'), lock = path.join(dir, 'codegraph.lock');
fs.appendFileSync(process.env.STUB_CALLS, a[0] + ' ' + top + '\\n');
fs.mkdirSync(dir, { recursive: true });
if (fs.existsSync(lock)) {
  const pid = parseInt(fs.readFileSync(lock, 'utf8'), 10);
  let alive = false; try { process.kill(pid, 0); alive = true; } catch {}
  if (alive) { process.stderr.write('CodeGraph database is locked by another process (PID ' + pid + ')\\n'); process.exit(1); }
  fs.unlinkSync(lock);
}
fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
const db = new (require('node:sqlite').DatabaseSync)(path.join(dir, 'codegraph.db'));
db.exec('create table if not exists project_metadata (key text primary key, value text, updated_at integer)');
const set = (k, v) => db.prepare('insert or replace into project_metadata values (?, ?, ?)').run(k, v, Date.now());
set('index_state', 'indexing'); set('indexed_with_extraction_version', '1');
let ms = 0; try { ms = Number(fs.readFileSync(path.join(top, 'stub-ms'), 'utf8')) || 0; } catch {}
setTimeout(() => { set('index_state', 'complete'); db.close(); try { fs.unlinkSync(lock); } catch {} process.exit(0); }, ms);
`);

// a server: wants its checkouts every second; exits with 75 after FV_TEST_EXIT_AFTER ms, or once every line in
// FV_TEST_UNTIL is in the log (at most FV_TEST_MAX_MS)
const SERVER = path.join(T, 'server.js');
fs.writeFileSync(SERVER, `'use strict';
const fs = require('fs');
const CI = require(${JSON.stringify(CODE_INDEX)});
const tops = process.argv.slice(2), t0 = Date.now();
const want = () => { for (const t of tops) CI.want(t, t); };
want(); setInterval(want, 1000);
const after = Number(process.env.FV_TEST_EXIT_AFTER), until = (process.env.FV_TEST_UNTIL || '').split('\\n').filter(Boolean);
if (after) setTimeout(() => process.exit(75), after);
setInterval(() => {
  let log = ''; try { log = fs.readFileSync(${JSON.stringify(LOG)}, 'utf8'); } catch {}
  if (!after && until.every((u) => log.includes(u))) process.exit(0);
  if (Date.now() - t0 > Number(process.env.FV_TEST_MAX_MS || 60000)) process.exit(3);
}, 200);
`);
const env = { ...process.env, LOCALAPPDATA: DATA, PATH: `${BIN};${process.env.PATH}`, STUB_CALLS: CALLS, FV_CODEGRAPH_POLL_MS: '500' };
function server(tops, o) {
  const r = spawnSync(process.execPath, [SERVER, ...tops], { env: { ...env, ...o }, encoding: 'utf8', windowsHide: true, timeout: 120e3 });
  if (r.stderr && r.stderr.trim()) console.log(`  server stderr: ${r.stderr.trim().slice(0, 600)}`);
  return r.status;
}
function checkout(name, ms) {
  const top = path.join(T, name);
  fs.mkdirSync(top, { recursive: true });
  fs.writeFileSync(path.join(top, 'stub-ms'), String(ms));
  return top;
}
// an index a build left part way: index_state "indexing", set just now (the old code waited 30 min after that)
function partial(top, lock) {
  const dir = path.join(top, '.codegraph');
  fs.mkdirSync(dir, { recursive: true });
  const db = new (require('node:sqlite').DatabaseSync)(path.join(dir, 'codegraph.db'));
  db.exec('create table project_metadata (key text primary key, value text, updated_at integer)');
  db.prepare('insert into project_metadata values (?, ?, ?), (?, ?, ?)').run('index_state', 'indexing', Date.now(), 'indexed_with_extraction_version', '1', Date.now());
  db.close();
  if (lock) fs.writeFileSync(path.join(dir, 'codegraph.lock'), String(lock));
}
const at = (text, line) => text.indexOf(line);

(async () => {
  const others = [];
  try {
    // 1
    const T1 = checkout('t1', 9000), T2 = checkout('t2', 300);
    const a = server([T1], { FV_TEST_EXIT_AFTER: '2500' });
    ok(a === 75, `1: the first server exited as an update restart does (exit ${a})`);
    const left = await running(T1);
    ok(left.length > 0, `1: the build outlived its server (pids ${left.join(', ') || 'none'})`);
    const b = server([T1, T2], { FV_TEST_UNTIL: `${T1}: built\n${T2}: built`, FV_TEST_MAX_MS: '45000' });
    let log = logText();
    ok(b === 0, `1: the next server saw both built (exit ${b})`);
    ok(log.includes(`${T1}: still building`), '1: the next server took the running build as its own');
    ok(log.split(`${T1}: building`).length - 1 === 1 && !log.includes(`${T1}: rebuilding`) && calls(T1) === 1, `1: no second build of it (${calls(T1)} build${calls(T1) === 1 ? '' : 's'})`);
    ok(at(log, `${T1}: built`) >= 0 && at(log, `${T1}: built`) < at(log, `${T2}: building`), '1: the next checkout started only once it was built');

    // 2, 3, 4, 5
    const T3 = checkout('t3', 300), T4 = checkout('t4', 300), T5 = checkout('t5', 300), T6 = checkout('t6', 0);
    const gone = spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid;
    partial(T3, gone);
    partial(T4, null);
    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120e3)'], { stdio: 'ignore', windowsHide: true });
    others.push(sleeper);
    partial(T5, sleeper.pid);
    fs.writeFileSync(path.join(T6, 'stub-ms'), '90000');
    const own = spawn(process.execPath, ['--no-warnings', path.join(BIN, 'codegraph.js'), 'index', '--quiet', T6], { env, stdio: 'ignore', windowsHide: true });
    others.push(own);
    await sleep(1500);
    const t0 = Date.now();
    const c = server([T3, T4, T5, T6], { FV_TEST_UNTIL: [T3, T4, T5].map((t) => `${t}: built`).join('\n'), FV_TEST_MAX_MS: '45000' });
    const secs = Math.round((Date.now() - t0) / 1000);
    log = logText();
    ok(c === 0, `2-4: all three rebuilt, in ${secs}s (exit ${c})`);
    ok(log.includes(`${T3}: rebuilding (the last build stopped part way; its lock named pid ${gone}, gone)`), '2: lock pid gone: rebuilt at once');
    ok(log.includes(`${T4}: rebuilding (the last build stopped part way)`), '3: no lock, no build running: rebuilt at once');
    ok(log.includes(`${T5}: rebuilding (the last build stopped part way; its lock named pid ${sleeper.pid}, now another process)`) && log.includes(`${T5}: built`), '4: lock pid reused by another process: treated as gone, rebuilt');
    ok(!log.includes(`${T6}:`) && calls(T6) === 1, '5: a build Fleet View did not start is left to run');
    ok(!fs.readdirSync(path.join(DATA, 'fleet-view', 'codegraph-builds')).some((f) => f.endsWith('.json')), 'no build record left behind');
  } catch (e) { failures++; console.log(`FAIL: ${e.stack || e.message}`); }
  finally {
    for (const p of others) try { process.kill(p.pid); } catch {}
    if (failures) console.log(`--- codegraph.log ---\n${logText()}`);
    await sleep(500);
    if (process.env.CI_TEST_KEEP !== '1') try { fs.rmSync(T, { recursive: true, force: true }); } catch (e) { console.log(`note: could not delete ${T}: ${e.code}`); }
  }
  console.log(failures ? `code-index-test: FAILED (${failures} of ${passes + failures})` : `code-index-test: ok (${passes} checks)`);
  process.exit(failures ? 1 : 0);
})();
