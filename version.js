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
//   current()  -> versionAt(this folder), worked out once per process; refresh() works it out again (after a pull)
//   label(v, hash) -> '1.0.12', or the hash when there is no version
//   node version.js [dir]   prints the version (empty when unknown)
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const FULL = /^\d+\.\d+\.\d+$/, BASE = /^\d+\.\d+$/;
const NONE = Object.freeze({ version: '', commit: '', exact: false });

// one git call: its output trimmed, or null when it failed
function git(dir, args) {
  try {
    return execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }).trim();
  } catch { return null; }
}

function parse(text) {
  try { const j = JSON.parse(String(text).replace(/^﻿/, '')); return j && typeof j === 'object' ? j : null; } catch { return null; }
}

function versionAt(dir, ref) {
  try {
    let j = null;
    if (!ref) { try { j = parse(fs.readFileSync(path.join(dir, 'version.json'), 'utf8')); } catch {} }
    else { const t = git(dir, ['show', `${ref}:version.json`]); j = t === null ? null : parse(t); }
    if (!j) return { ...NONE };
    const v = String(j.version || '').trim();
    // the share repo's copy: already full
    if (FULL.test(v)) return { version: v, commit: /^[0-9a-f]{40}$/.test(String(j.commit || '')) ? j.commit : '', exact: true };
    if (!BASE.test(v)) return { ...NONE };
    // main's: count the commits since version.json last changed
    const commit = git(dir, ['rev-parse', '--verify', '--quiet', `${ref || 'HEAD'}^{commit}`]);
    if (!commit) return { ...NONE };
    const last = git(dir, ['log', '-1', '--first-parent', '--format=%H', commit, '--', 'version.json']);
    if (!last) return { ...NONE }; // version.json is not committed yet
    const n = git(dir, ['rev-list', '--count', '--first-parent', `${last}..${commit}`]);
    if (!/^\d+$/.test(n || '')) return { ...NONE };
    return { version: `${v}.${n}`, commit, exact: git(dir, ['rev-parse', '--is-shallow-repository']) !== 'true' };
  } catch { return { ...NONE }; }
}

let cached = null;
function current() { return cached || (cached = versionAt(__dirname)); }
function refresh() { cached = null; return current(); }
const label = (v, hash) => (v && v.version) || hash || '';

if (require.main === module) process.stdout.write(`${versionAt(path.resolve(process.argv[2] || __dirname)).version}\n`);

module.exports = { versionAt, current, refresh, label };
