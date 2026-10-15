#!/usr/bin/env node
// Tests that fv's text reaches scripts/fv.js whole through the real shims: fv.ps1 (PowerShell), fv.cmd (--file and
// --stdin only: cmd.exe cuts an argument at a newline, that's why they exist) and the sh fv (Git Bash, macOS). Each
// runs `fv send` with FV_DRY_RUN=1, which prints the arguments and the call fv would make and makes none; the port is
// 9 and the token folder an empty temp one besides, so nothing could reach a real Fleet View. Messages: newlines,
// %OS%, an odd number of ", & | < > ^, 9000 characters, emoji and accents. Prints PASS/FAIL per check, exits 1 on any.
//   node scripts/fv-args-test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { main, shimArgs } = require('./fv.js');

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`PASS: ${name}`);
  else { failures++; console.log(`FAIL: ${name}${detail ? ` (${detail})` : ''}`); }
};

const REPO = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-args-test-'));
const WIN = process.platform === 'win32';
const ID = '00000000-0000-4000-8000-000000000000';
const FROM = '11111111-1111-4111-8111-111111111111';

const long = Array.from({ length: 300 }, (_, i) => `${String(i).padStart(4, '0')} line, "q" & %OS% <x>|`).join('\n');
const MESSAGES = {
  newlines: 'Phone-side findings (yours to fix):\n1) lib/a.ts:172 first\n\n2) second\r\n3) third',
  percent: 'path %OS% and %PATH% and 100% and %%',
  quotes: 'say "hi and an odd " quote: "',
  operators: 'a & b | c < d > e ^ f && g || h; (i) `j` $k',
  long: long.slice(0, 9000).replace(/\s+$/, 'x'),
  unicode: 'café naïve façade 😀 — ✓ 日本語 ñ',
};
MESSAGES.all = Object.values(MESSAGES).filter((m) => m.length < 1000).join('\n');
const expected = (m) => m.replace(/\r\n/g, '\n').replace(/\s+$/, '');

const env = { ...process.env, FV_DRY_RUN: '1', PATH: REPO + path.delimiter + process.env.PATH };
delete env.FV_ARGS_B64;
delete env.FLEET_VIEW_PORT;
if (WIN) env.LOCALAPPDATA = TMP;
else env.HOME = TMP;

// the dry run's lines -> { argv, via, calls: [{ method, path, body }] }
function parse(stdout) {
  const r = { argv: null, via: null, calls: [] };
  for (const l of String(stdout).split(/\r?\n/)) {
    if (!l.startsWith('fv dry run: ')) continue;
    const j = JSON.parse(l.slice(12));
    if (j.argv) { r.argv = j.argv; r.via = j.via; } else r.calls.push(j);
  }
  return r;
}
const msgFile = (name, m) => { const f = path.join(TMP, `${name}.txt`); fs.writeFileSync(f, m, 'utf8'); return f; };
// one send through a shim got there: one POST to the session with the text and --from as given
function sent(name, res, m) {
  const r = parse(res.stdout);
  const c = r.calls[0];
  check(`${name}: one message call`, r.calls.length === 1 && c.method === 'POST' && c.path === `/api/sessions/${ID}/message`, `${res.status} ${String(res.stderr).trim().slice(0, 300)}`);
  check(`${name}: the text arrives whole`, !!c && c.body.text === expected(m), c ? `got ${JSON.stringify(c.body.text).slice(0, 200)}` : 'no call');
  check(`${name}: --from arrives`, !!c && c.body.from === FROM);
  return r;
}

// ---------- in process ----------
{
  const e = { FV_ARGS_B64: Buffer.from(JSON.stringify(['send', 'a\nb', 7]), 'utf8').toString('base64') };
  const a = shimArgs(e);
  check('shimArgs reads FV_ARGS_B64 as strings and drops it', JSON.stringify(a) === '["send","a\\nb","7"]' && !('FV_ARGS_B64' in e));
  check('shimArgs: none without FV_ARGS_B64', shimArgs({}) === null);
  let threw = false;
  try { shimArgs({ FV_ARGS_B64: 'bm90IGpzb24=' }); } catch { threw = true; }
  check('shimArgs refuses what is not a JSON list', threw);
}
(async () => {
  const calls = [];
  const call = async (method, p, body) => { calls.push({ method, p, body }); return { code: 200, j: { ok: true } }; };
  const quiet = () => {};
  const f = msgFile('inproc', '\uFEFFfrom a file\r\nline 2\r\n');
  check('send --file reads the file (BOM and trailing newline gone)', await main(['send', ID, '--file', f], { call }, quiet, quiet) === 0 && calls.pop().body.text === 'from a file\nline 2');
  const u16 = path.join(TMP, 'utf16.txt');
  fs.writeFileSync(u16, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('UTF-16 ✓ 😀\r\n', 'utf16le')]));
  check('send --file reads UTF-16 (PowerShell 5.1 >)', await main(['send', ID, '--file', u16], { call }, quiet, quiet) === 0 && calls.pop().body.text === 'UTF-16 ✓ 😀');
  check('send: text and --file both is bad usage', await main(['send', ID, 'x', '--file', f], { call }, quiet, quiet) === 2);
  check('send: --file and --stdin both is bad usage', await main(['send', ID, '--file', f, '--stdin'], { call }, quiet, quiet) === 2);
  check('send: a missing --file is bad usage', await main(['send', ID, '--file', path.join(TMP, 'none.txt')], { call }, quiet, quiet) === 2);
  check('send: an empty --file is bad usage', await main(['send', ID, '--file', msgFile('empty', '\r\n')], { call }, quiet, quiet) === 2);
  check('no call was made for the bad ones', calls.length === 0, JSON.stringify(calls));

  // ---------- fv.ps1 ----------
  const ps = WIN ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : null;
  if (ps && fs.existsSync(ps)) {
    // a script file (UTF-8 with BOM, as PowerShell 5.1 wants) run with -File; the message comes in through a variable
    // read from a file, as a session's $m = @'…'@ would hand it
    const runPs = (name, body, input) => {
      const f = path.join(TMP, `${name}.ps1`);
      fs.writeFileSync(f, '\uFEFF' + body.join('\r\n') + '\r\n', 'utf8');
      return spawnSync(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', f], { env, input, encoding: 'utf8', timeout: 60000, windowsHide: true });
    };
    const q = (s) => `'${s.replace(/'/g, "''")}'`;
    const which = runPs('which', ['(Get-Command fv).Source']);
    check('PowerShell finds fv.ps1 before fv.cmd', String(which.stdout).trim().toLowerCase() === path.join(REPO, 'fv.ps1').toLowerCase(), String(which.stdout).trim());
    for (const [name, m] of Object.entries(MESSAGES)) {
      const f = msgFile(`ps-${name}`, m);
      const res = runPs(`ps-${name}`, [
        `$m = [IO.File]::ReadAllText(${q(f)}, [Text.Encoding]::UTF8)`,
        `fv send ${ID} $m --from ${FROM} --port 9`,
        '"code:$LASTEXITCODE"',
        '"left:$([bool]$env:FV_ARGS_B64)"',
      ]);
      const r = sent(`fv.ps1 ${name}`, res, m);
      check(`fv.ps1 ${name}: the arguments came whole in FV_ARGS_B64`, r.via === 'FV_ARGS_B64' && JSON.stringify(r.argv) === JSON.stringify(['send', ID, m, '--from', FROM, '--port', '9']));
      check(`fv.ps1 ${name}: exit 0, FV_ARGS_B64 not left in PowerShell`, /code:0/.test(res.stdout) && /left:False/.test(res.stdout), String(res.stdout).slice(-200));
    }
    const piped = runPs('ps-stdin', [
      `$m = [IO.File]::ReadAllText(${q(msgFile('ps-stdin', MESSAGES.all))}, [Text.Encoding]::UTF8)`,
      '$was = $OutputEncoding.WebName',
      `$m | fv send ${ID} --stdin --from ${FROM} --port 9`,
      '"same:$($was -eq $OutputEncoding.WebName)"',
    ]);
    sent('fv.ps1 piped to --stdin', piped, MESSAGES.all);
    check('fv.ps1 puts $OutputEncoding back', /same:True/.test(piped.stdout), String(piped.stdout).slice(-100));
    const lines = runPs('ps-lines', [`Get-Content -Encoding UTF8 ${q(msgFile('ps-lines', MESSAGES.all))} | fv send ${ID} --stdin --from ${FROM} --port 9`]);
    sent('fv.ps1 Get-Content lines piped to --stdin', lines, MESSAGES.all);
    const u16f = path.join(TMP, 'ps-utf16.txt');
    const outFile = runPs('ps-file', [
      `$m = [IO.File]::ReadAllText(${q(msgFile('ps-file-src', MESSAGES.all))}, [Text.Encoding]::UTF8)`,
      `$m > ${q(u16f)}`,
      `fv send ${ID} --file ${q(u16f)} --from ${FROM} --port 9`,
    ]);
    sent('fv.ps1 --file written by PowerShell >', outFile, MESSAGES.all);
    const num = runPs('ps-num', [`fv send 01234567 hi --from 0x10 --wait 030 --port 9`]);
    const nr = parse(num.stdout);
    check('fv.ps1 keeps number-like arguments as typed', JSON.stringify(nr.argv) === JSON.stringify(['send', '01234567', 'hi', '--from', '0x10', '--wait', '030', '--port', '9']), JSON.stringify(nr.argv));
    const big = runPs('ps-big', [`$m = 'x' * 30000`, `fv send ${ID} $m --port 9`, '"code:$LASTEXITCODE"']);
    check('fv.ps1: text too long for an argument says to use --file, sends nothing', /code:2/.test(big.stdout) && /--file/.test(big.stderr) && !parse(big.stdout).calls.length, `${big.stdout} ${big.stderr}`);
  } else console.log('SKIP: fv.ps1 (no Windows PowerShell here)');

  // ---------- fv.cmd: --file and --stdin ----------
  if (WIN) {
    const runCmd = (line, input) => spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { env, input, encoding: 'utf8', timeout: 60000, windowsHide: true, windowsVerbatimArguments: true });
    const fvCmd = path.join(REPO, 'fv.cmd');
    for (const name of ['long', 'all']) {
      const m = MESSAGES[name];
      sent(`fv.cmd ${name} --file`, runCmd(`"${fvCmd}" send ${ID} --file "${msgFile(`cmd-${name}`, m)}" --from ${FROM} --port 9`), m);
      sent(`fv.cmd ${name} --stdin`, runCmd(`"${fvCmd}" send ${ID} --stdin --from ${FROM} --port 9`, Buffer.from(m, 'utf8')), m);
    }
  }

  // ---------- the sh fv (Git Bash on Windows, macOS, Linux) ----------
  const sh = WIN ? ['C:\\Program Files\\Git\\bin\\sh.exe', path.join(process.env.ProgramFiles || '', 'Git', 'bin', 'sh.exe')].find((p) => fs.existsSync(p)) : '/bin/sh';
  if (sh) {
    for (const [name, m] of Object.entries(MESSAGES)) {
      const res = spawnSync(sh, [path.join(REPO, 'fv'), 'send', ID, m, '--from', FROM, '--port', '9'], { env, encoding: 'utf8', timeout: 60000, windowsHide: true });
      sent(`sh fv ${name}`, res, m);
    }
    const res = spawnSync(sh, [path.join(REPO, 'fv'), 'send', ID, '--stdin', '--from', FROM, '--port', '9'], { env, input: Buffer.from(MESSAGES.all, 'utf8'), encoding: 'utf8', timeout: 60000, windowsHide: true });
    sent('sh fv --stdin', res, MESSAGES.all);
  } else console.log('SKIP: sh fv (no Git Bash sh here)');

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exitCode = failures ? 1 : 0;
})();
