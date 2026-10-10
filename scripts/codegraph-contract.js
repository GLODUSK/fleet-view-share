#!/usr/bin/env node
// CodeGraph contract test: does this CodeGraph still do everything Fleet View and the Claude Code setup rely on?
//   node scripts/codegraph-contract.js [--bin <codegraph.cmd>]
// --bin tests a CodeGraph installed somewhere else (a side install of a new version) instead of the one on PATH.
// It builds a one-file project in a temp folder and checks:
//   1. `codegraph --version` prints a version
//   2. `codegraph init --yes <dir>` builds an index that code-index.js reads as complete, stamped with an extraction
//      version (code-index.js check(): project_metadata index_state and indexed_with_extraction_version)
//   3. `codegraph index --quiet <dir>` rebuilds it, still complete (how code-index.js rebuilds cut-short and stale ones)
//   4. neither writes anything outside .codegraph (no CLAUDE.md, AGENTS.md or .mcp.json edits)
//   5. `codegraph serve --mcp`, started the way the accounts' .claude.json start it, answers MCP: tools/list has
//      codegraph_explore, and a codegraph_explore call returns the project's code
//   6. the npm package has no install scripts (an install must not touch agent configs)
//   7. telemetry is off. A CodeGraph's first run can write a fresh default ("enabled") over the saved choice, so this
//      turns it off first and then checks that it stuck (the `telemetry` status, read without CODEGRAPH_TELEMETRY=0,
//      which every other command here gets).
// Exit code 0 when all pass, 1 when any fails. The updater (scripts/codegraph-update.ps1) runs it after every
// CodeGraph update and goes back to the last good version on a failure; docs/codegraph-update.md says what then.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const argv = process.argv.slice(2);
const binArg = argv.indexOf('--bin') >= 0 ? argv[argv.indexOf('--bin') + 1] : null;
const BIN = binArg ? path.resolve(binArg) : (process.platform === 'win32' ? 'codegraph.cmd' : 'codegraph');
const CI = require(path.join(__dirname, '..', 'code-index.js'));

let failures = 0;
const ok = (m) => console.log(`ok:   ${m}`);
const fail = (m) => { failures++; console.log(`FAIL: ${m}`); };

// run the command the way code-index.js does (cmd.exe, arguments quoted); CODEGRAPH_TELEMETRY=0 unless opts.env says
function cg(args, opts = {}) {
  const win = process.platform === 'win32';
  opts = { ...opts, env: opts.env || { ...process.env, CODEGRAPH_TELEMETRY: '0' } };
  const line = [BIN, ...args].map((a) => (/^[\w.:\\/-]+$/.test(a) ? a : `"${a}"`)).join(' ');
  return win
    ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { windowsHide: true, windowsVerbatimArguments: true, ...opts })
    : spawn(BIN, args, opts);
}
function run(args, opts) {
  return new Promise((resolve) => {
    const p = cg(args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => kill(p), 10 * 60e3);
    p.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out, err: err + e.message }); });
    p.on('exit', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}
function kill(p) {
  if (process.platform === 'win32') try { execFileSync('taskkill', ['/pid', String(p.pid), '/t', '/f'], { stdio: 'ignore' }); } catch {}
  else try { p.kill(); } catch {}
}
const checkIndex = (dir) => new Promise((resolve) => CI.check(dir, (state, info) => resolve({ state, ...info })));
// every file outside .codegraph, with its size and time, to see what a command wrote
function snapshot(dir) {
  const out = {};
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== '.codegraph' && e.name !== '.git') walk(f); }
      else { const s = fs.statSync(f); out[path.relative(dir, f)] = `${s.size}:${s.mtimeMs}`; }
    }
  })(dir);
  return out;
}
function changed(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((k) => before[k] !== after[k]);
}

// one MCP exchange over stdio: initialize, tools/list, a codegraph_explore call
function mcp(dir) {
  return new Promise((resolve) => {
    const env = { ...process.env, CODEGRAPH_TELEMETRY: '0', CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS: '1000', CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: '1000' };
    const p = cg(['serve', '--mcp'], { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const waiting = new Map();
    let buf = '', id = 0, err = '';
    p.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.id !== undefined && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
      }
    });
    const ask = (method, params) => new Promise((res, rej) => {
      const n = ++id;
      const t = setTimeout(() => { waiting.delete(n); rej(new Error(`${method}: no answer in 120 s`)); }, 120e3);
      waiting.set(n, (m) => { clearTimeout(t); res(m); });
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
    });
    (async () => {
      const init = await ask('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fleet-view-contract', version: '1' } });
      if (init.error) throw new Error(`initialize: ${JSON.stringify(init.error)}`);
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      const list = await ask('tools/list', {});
      const tools = ((list.result && list.result.tools) || []).map((t) => t.name);
      const call = tools.includes('codegraph_explore')
        ? await ask('tools/call', { name: 'codegraph_explore', arguments: { query: 'contractProbe', projectPath: dir } })
        : null;
      const text = call && call.result && Array.isArray(call.result.content) ? call.result.content.map((c) => c.text || '').join('\n') : '';
      return { tools, text };
    })().then((r) => { kill(p); resolve(r); }, (e) => { kill(p); resolve({ error: `${e.message}${err ? `\n    ${err.trim().slice(-600)}` : ''}` }); });
  });
}

async function rmrf(dir) {
  // a daemon that served the folder lets go of it a few seconds after the last client
  for (let i = 0; i < 30; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch { await new Promise((r) => setTimeout(r, 2000)); }
  }
  console.log(`note: could not delete ${dir}`);
}

(async () => {
  console.log(`CodeGraph contract test: ${BIN}`);
  // 1
  const v = await run(['--version']);
  const version = (v.out.match(/\d+\.\d+\.\d+[\w.-]*/) || [])[0];
  if (v.code === 0 && version) ok(`--version: ${version}`);
  else { fail(`--version: exit ${v.code}, "${(v.out + v.err).trim().slice(0, 300)}"`); return finish(version); }
  await run(['telemetry', 'off']); // its exit code is not reliable: 255 when it worked

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-codegraph-contract-'));
  try {
    fs.writeFileSync(path.join(dir, 'probe.js'), 'function contractProbe(n) { return contractHelper(n) + 1; }\nfunction contractHelper(n) { return n * 2; }\nmodule.exports = { contractProbe };\n');
    try { execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' }); } catch {}
    const before = snapshot(dir);

    // 2
    const init = await run(['init', '--yes', dir], { cwd: dir });
    const a = await checkIndex(dir);
    if (init.code !== 0) fail(`init: exit ${init.code} ${init.err.trim().slice(-400)}`);
    else if (!fs.existsSync(path.join(dir, '.codegraph', 'codegraph.db'))) fail('init: no .codegraph\\codegraph.db');
    else if (a.state !== 'done') fail(`init: code-index.js reads the new index as "${a.state}", not done (project_metadata index_state)`);
    else if (!Number.isInteger(a.extraction)) fail('init: no indexed_with_extraction_version in project_metadata (code-index.js finds stale indexes by it)');
    else ok(`init: complete, extraction ${a.extraction}`);

    // 3
    const idx = await run(['index', '--quiet', dir], { cwd: dir });
    const b = await checkIndex(dir);
    if (idx.code !== 0) fail(`index: exit ${idx.code} ${idx.err.trim().slice(-400)}`);
    else if (b.state !== 'done' || !Number.isInteger(b.extraction)) fail(`index: code-index.js reads the rebuilt index as "${b.state}", extraction ${b.extraction}`);
    else ok('index: rebuilt, complete');

    // 5
    const m = await mcp(dir);
    if (m.error) fail(`serve --mcp: ${m.error}`);
    else if (!m.tools.includes('codegraph_explore')) fail(`serve --mcp: no codegraph_explore tool (has ${m.tools.join(', ') || 'none'}); CLAUDE.md and the agent prompts name it`);
    else if (!/contractHelper/.test(m.text)) fail(`serve --mcp: codegraph_explore did not return the project's code: "${m.text.slice(0, 300)}"`);
    else ok(`serve --mcp: ${m.tools.length} tools, codegraph_explore returns the code`);

    // 4 (after init, index and serve)
    const wrote = changed(before, snapshot(dir));
    if (wrote.length) fail(`wrote outside .codegraph: ${wrote.join(', ')}`);
    else ok('nothing written outside .codegraph');
  } finally { await rmrf(dir); }

  // 6
  try {
    // --bin is a global npm folder's codegraph.cmd (<prefix>\node_modules\@colbymchenry\codegraph) or a local
    // install's node_modules\.bin\codegraph.cmd (node_modules\@colbymchenry\codegraph)
    const pkgDir = binArg
      ? [path.join(path.dirname(BIN), 'node_modules'), path.join(path.dirname(BIN), '..')].map((d) => path.join(d, '@colbymchenry', 'codegraph')).find((d) => fs.existsSync(path.join(d, 'package.json')))
      : path.join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8', shell: process.platform === 'win32' }).trim(), '@colbymchenry', 'codegraph');
    if (!pkgDir) throw new Error(`no @colbymchenry/codegraph package beside ${BIN}`);
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    const hooks = Object.keys(pkg.scripts || {}).filter((s) => /^(pre|post)?install$|^prepare$/.test(s));
    if (pkg.version !== version) fail(`package.json says ${pkg.version}, the command says ${version}`);
    else if (hooks.length) fail(`the npm package runs install scripts: ${hooks.join(', ')}`);
    else ok('npm package: no install scripts');
  } catch (e) { console.log(`note: npm package not checked (${e.message.split('\n')[0]})`); }

  // 7 (turned off after step 1)
  const saved = { ...process.env };
  delete saved.CODEGRAPH_TELEMETRY;
  const tel = await run(['telemetry'], { env: saved });
  if (/Telemetry:\s*disabled/i.test(tel.out)) ok('telemetry: off');
  else fail(`telemetry: not off after \`telemetry off\`: "${(tel.out + tel.err).trim().split('\n')[0]}"`);

  finish(version);
})().catch((e) => { fail(e.stack || e.message); finish(); });

function finish(version) {
  console.log(failures ? `contract: FAILED (${failures} check${failures > 1 ? 's' : ''}), CodeGraph ${version || '?'}` : `contract: ok, CodeGraph ${version}`);
  process.exit(failures ? 1 : 0);
}
