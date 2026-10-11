// Fleet View: keeps the fleet-view-feed mod (mod/fleet-view-feed) current in every Claude login that has it.
//
// The installer adds mod/ as the `fleet-view` marketplace and installs the mod in each login. Claude Code copies it to
// <login>/plugins/cache/fleet-view/fleet-view-feed/<version>/ and records that version. 2.1.296 reads a directory
// marketplace's plugin in place all the same (`claude plugin list --json` shows readFromFolder), but a Claude Code
// that runs the copy never sees a git pull of Fleet View. So at each server start (and the server restarts after
// every update) each login's installed version (plugins/installed_plugins.json) is compared with
// mod/fleet-view-feed/.claude-plugin/plugin.json's, and where they differ the login runs
//   claude plugin marketplace update fleet-view
//   claude plugin update fleet-view-feed@fleet-view --scope <scope>     (in the project's folder for project/local)
// with CLAUDE_CONFIG_DIR set for ~/.claude-<x>. Claude copies the new version beside the old; sessions already
// running keep theirs, new ones load the new one. Left alone: a login without the mod (only the installer adds it),
// and one whose fleet-view marketplace is another folder (a server run from a worktree, say). Logins that share one
// plugins folder (on Henry's PC ~/.claude-a is a junction to B's) are done once. One log line per login.
//
//   start(o)   check() 20 s after the server starts; o.off (a reason) logs that instead, as a demo does
//   check(o)   Promise<[{ login, status, line }]>, status: current | updated | failed | absent | shared | elsewhere
//              | skipped. o: { home, modDir, log, run } where run(args, { cfg, cwd }) -> Promise<{ code, out }>
//              runs `claude <args>` (runClaude, hidden; a test passes its own)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const P = require('./platform');

const MARKET = 'fleet-view';
const PLUGIN = 'fleet-view-feed@fleet-view';
const RUN_MS = 120e3; // one claude plugin command, at most
// what the server's own environment must not hand claude: another login's folder or token, a session's identity
const DROP_ENV = /^(CLAUDE_CONFIG_DIR|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_SWAP_KEY|CLAUDE_SWAP_PAYER|CLAUDE_LAUNCH_KEY|CLAUDECODE|CLAUDE_PID|ELECTRON_RUN_AS_NODE|CLAUDE_CODE_(CHILD_SESSION|SESSION_ID|MESSAGING_SOCKET|MESSAGING_TOKEN|ENTRYPOINT|SESSION_ATTENDED))$/i;

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const same = (a, b) => P.foldCase(real(a)) === P.foldCase(real(b));
const isDir = (d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } };

// ~/.claude, then each ~/.claude-<letter> folder: { name: '~/.claude-a', dir, cfg } (cfg: CLAUDE_CONFIG_DIR, null for B)
function logins(home) {
  const out = [];
  if (isDir(path.join(home, '.claude'))) out.push({ name: '~/.claude', dir: path.join(home, '.claude'), cfg: null });
  let names = [];
  try { names = fs.readdirSync(home).filter((n) => /^\.claude-[a-z]$/i.test(n)).sort(); } catch {}
  for (const n of names) if (isDir(path.join(home, n))) out.push({ name: `~/${n}`, dir: path.join(home, n), cfg: path.join(home, n) });
  return out;
}

// `claude <args>` in a login, hidden: through cmd on Windows (claude may be claude.cmd or claude.exe on PATH, as
// accounts.js runs it), else the claude on the login shell's PATH (a Mac app has a bare one). The words are fixed
// here, nothing a shell reads as special. Ended after RUN_MS
function runClaude(args, { cfg, cwd } = {}) {
  return new Promise((resolve) => {
    const env = {};
    for (const [k, v] of Object.entries(process.env)) if (!DROP_ENV.test(k)) env[k] = v;
    if (cfg) env.CLAUDE_CONFIG_DIR = cfg;
    if (!P.isWin) env.PATH = P.loginShellPath();
    const opts = { cwd: cwd || os.homedir(), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] };
    let child, out = '', done = false;
    const end = (code, more) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, out: (out + (more || '')).trim() }); };
    try {
      child = P.isWin
        ? spawn(process.env.ComSpec || 'cmd.exe', [`/d /s /c "claude ${args.join(' ')}"`], { ...opts, windowsVerbatimArguments: true })
        : spawn(P.which('claude') || 'claude', args, { ...opts, ...P.detachGroup });
    } catch (e) { return resolve({ code: -1, out: `could not start claude: ${e.message}` }); }
    const timer = setTimeout(() => { P.killTree(child.pid); end(-1, '\nstopped after 2 minutes'); }, RUN_MS);
    const take = (d) => { out = (out + d).slice(-4000); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', (e) => end(-1, `\nclaude did not start: ${e.message}`));
    child.on('close', (code) => end(code));
  });
}

const lastLine = (s) => String(s || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() || 'no output';

async function check(o = {}) {
  const home = o.home || os.homedir();
  const modDir = o.modDir || path.join(__dirname, 'mod');
  const log = o.log || (() => {});
  const run = o.run || runClaude;
  const want = (readJson(path.join(modDir, 'fleet-view-feed', '.claude-plugin', 'plugin.json')) || {}).version;
  if (!want) { log(`feed mod: no ${path.join(modDir, 'fleet-view-feed')} here, nothing to compare`); return []; }
  const results = [], seen = new Map(); // real installed_plugins.json -> the login that had it first
  const note = (l, status, line) => { results.push({ login: l.name, status, line }); log(`feed mod: ${line}`); };
  for (const l of logins(home)) {
    const file = path.join(l.dir, 'plugins', 'installed_plugins.json');
    const entries = ((readJson(file) || {}).plugins || {})[PLUGIN];
    if (!Array.isArray(entries) || !entries.length) { note(l, 'absent', `not installed in ${l.name}, left alone`); continue; }
    const key = P.foldCase(real(file));
    if (seen.has(key)) { note(l, 'shared', `${l.name} shares ${seen.get(key)}'s plugins folder, done there`); continue; }
    seen.set(key, l.name);
    const m = (readJson(path.join(l.dir, 'plugins', 'known_marketplaces.json')) || {})[MARKET];
    const from = m && (m.installLocation || (m.source && m.source.path));
    if (!from) { note(l, 'skipped', `${l.name} has no ${MARKET} marketplace, left alone`); continue; }
    if (!same(from, modDir)) { note(l, 'elsewhere', `${l.name} takes it from ${from}, not this folder, left alone`); continue; }
    // each scope it is installed in whose version differs; a project's scope runs in that project's folder
    const stale = entries.filter((e) => e && e.version !== want && (e.scope === 'user' || (['project', 'local'].includes(e.scope) && e.projectPath && isDir(e.projectPath))));
    const was = [...new Set(entries.map((e) => e && e.version).filter(Boolean))].join(', ');
    if (!stale.length) {
      const odd = entries.filter((e) => e && e.version !== want);
      note(l, 'current', `${want} is current in ${l.name}${odd.length ? ` (${odd.map((e) => `${e.version} in ${e.scope} ${e.projectPath || ''}`.trim()).join(', ')} left alone: no such folder)` : ''}`);
      continue;
    }
    const mk = await run(['plugin', 'marketplace', 'update', MARKET], { cfg: l.cfg, cwd: home });
    const fails = mk.code === 0 ? [] : [`marketplace update: ${lastLine(mk.out)}`];
    for (const e of stale) {
      const r = await run(['plugin', 'update', PLUGIN, '--scope', e.scope], { cfg: l.cfg, cwd: e.scope === 'user' ? home : e.projectPath });
      if (r.code !== 0) fails.push(`${e.scope}: ${lastLine(r.out)}`);
    }
    // what Claude wrote is the answer, whatever the commands said
    const after = ((readJson(file) || {}).plugins || {})[PLUGIN] || [];
    const still = after.filter((a) => stale.some((e) => e.scope === a.scope && (e.projectPath || '') === (a.projectPath || '')) && a.version !== want);
    const scopes = stale.map((e) => (e.scope === 'user' ? 'user' : `${e.scope} ${e.projectPath}`)).join(', ');
    if (!still.length) note(l, 'updated', `updated ${was} → ${want} in ${l.name} (${scopes})`);
    else note(l, 'failed', `still ${[...new Set(still.map((a) => a.version))].join(', ')} in ${l.name} after claude plugin update${fails.length ? ` (${fails.join('; ')})` : ''}`);
  }
  return results;
}

function start(o = {}) {
  const t = setTimeout(() => {
    if (o.off) return (o.log || (() => {}))(`feed mod: not checked (${o.off})`);
    check(o).catch((e) => (o.log || (() => {}))(`feed mod: check failed: ${e && e.message}`));
  }, o.delayMs == null ? 20e3 : o.delayMs);
  if (t.unref) t.unref();
}

module.exports = { check, start, logins, runClaude, PLUGIN, MARKET };
