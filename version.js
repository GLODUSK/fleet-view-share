#!/usr/bin/env node
// Fleet View's version number, MAJOR.MINOR.PATCH (1.0.12): the same number for the same code on every PC, so
// "which version are you on" has an answer that is not a commit hash. version.json at the repo root holds
// MAJOR.MINOR ("1.0"); PATCH is the count of commits on main (first parent) since version.json last changed, so
// every merge moves it by one and editing the number (1.1, 2.0) starts the count again at 0. The share repo's copy
// is already full ({ version: "1.0.12", commit: <the main commit it was published from> }, written by
// scripts/publish-share.js), so a friend's PC needs no history, nor even git, to know its version.
//
//   versionAt(dir, ref?) -> { version: '1.0.12' | '', commit: '<full sha>' | '', exact }
//     ref: a git ref (default HEAD: the working tree's version.json). version '' when it can't say (no
//     version.json, no git): the caller shows the short commit instead. exact is false when the count may be
//     short (a shallow clone). Never throws.
//   versionAtAsync(dir, ref?) -> Promise of the same, its git calls run without blocking (up to four: a server's
//     start and its update check spent up to 4.4 s in them on a busy disk, answering nothing, 2026-10-17)
//   current()  -> versionAt(this folder), worked out once per process; refresh() works it out again (after a pull)
//   currentAsync(), refreshAsync() -> Promise: the same, without blocking; what they work out is current()'s too
//   label(v, hash) -> '1.0.12', or the hash when there is no version
//   node version.js [dir]   prints the version (empty when unknown)
'use strict';
const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

const FULL = /^\d+\.\d+\.\d+$/, BASE = /^\d+\.\d+$/;
const NONE = Object.freeze({ version: '', commit: '', exact: false });

// one git call: its output trimmed, or null when it failed
const GIT_OPTS = () => ({ encoding: 'utf8', timeout: 5000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
function git(dir, args) {
  try {
    return execFileSync('git', ['-C', dir, ...args], { ...GIT_OPTS(), stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; }
}
// the same without blocking: a Promise of the output, or null
const gitAsync = (dir, args) => new Promise((done) => {
  try {
    const c = execFile('git', ['-C', dir, ...args], GIT_OPTS(), (err, out) => done(err ? null : String(out).trim()));
    if (c.stdin) c.stdin.end();
  } catch { done(null); }
});
// version.json's text, or null
function readText(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } }
const readTextAsync = (file) => fs.promises.readFile(file, 'utf8').catch(() => null);

function parse(text) {
  try { const j = JSON.parse(String(text).replace(/^﻿/, '')); return j && typeof j === 'object' ? j : null; } catch { return null; }
}

// versionAt's steps: each file read ({ read }) and git call ({ git: args }) is yielded and its answer (the text, or
// null) sent back in, so versionAt runs them synchronously and versionAtAsync without blocking, on one set of rules
function* steps(dir, ref) {
  let j = null;
  if (!ref) { const t = yield { read: path.join(dir, 'version.json') }; j = t === null ? null : parse(t); }
  else { const t = yield { git: ['show', `${ref}:version.json`] }; j = t === null ? null : parse(t); }
  if (!j) return { ...NONE };
  const v = String(j.version || '').trim();
  // the share repo's copy: already full
  if (FULL.test(v)) return { version: v, commit: /^[0-9a-f]{40}$/.test(String(j.commit || '')) ? j.commit : '', exact: true };
  if (!BASE.test(v)) return { ...NONE };
  // main's: count the commits since version.json last changed
  const commit = yield { git: ['rev-parse', '--verify', '--quiet', `${ref || 'HEAD'}^{commit}`] };
  if (!commit) return { ...NONE };
  const last = yield { git: ['log', '-1', '--first-parent', '--format=%H', commit, '--', 'version.json'] };
  if (!last) return { ...NONE }; // version.json is not committed yet
  const n = yield { git: ['rev-list', '--count', '--first-parent', `${last}..${commit}`] };
  if (!/^\d+$/.test(n || '')) return { ...NONE };
  return { version: `${v}.${n}`, commit, exact: (yield { git: ['rev-parse', '--is-shallow-repository'] }) !== 'true' };
}

function versionAt(dir, ref) {
  try {
    const g = steps(dir, ref);
    let r = g.next();
    while (!r.done) r = g.next(r.value.read ? readText(r.value.read) : git(dir, r.value.git));
    return r.value;
  } catch { return { ...NONE }; }
}
async function versionAtAsync(dir, ref) {
  try {
    const g = steps(dir, ref);
    let r = g.next();
    while (!r.done) r = g.next(await (r.value.read ? readTextAsync(r.value.read) : gitAsync(dir, r.value.git)));
    return r.value;
  } catch { return { ...NONE }; }
}

let cached = null, seq = 0, first = null;
function current() { return cached || (cached = versionAt(__dirname)); }
function refresh() { seq++; cached = null; return current(); }
// the same without blocking. Each refresh works it out anew (one asked for after a pull must not get one begun
// before it), and only the newest one asked for is kept
function refreshAsync() {
  const n = ++seq;
  return versionAtAsync(__dirname).then((v) => { if (n === seq) cached = v; return v; });
}
const currentAsync = () => (cached ? Promise.resolve(cached) : first || (first = refreshAsync().finally(() => { first = null; })));
const label = (v, hash) => (v && v.version) || hash || '';

if (require.main === module) process.stdout.write(`${versionAt(path.resolve(process.argv[2] || __dirname)).version}\n`);

module.exports = { versionAt, versionAtAsync, current, refresh, currentAsync, refreshAsync, label };
