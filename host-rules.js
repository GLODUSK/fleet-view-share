// host-rules.js: the stays-on rules (fleet-view.js hostRules; Henry, 2026-10-12: Blender work stays on BlackBox, every
// other chat follows him freely between the PC and the Mac). A rule: { id, repo: { origin, name } | null, paths: [globs],
// tools: [names, a trailing * for a prefix], host: a device's name, hostDevice?: its sync device id, pinOn?, note? }
// (sync-prefs.js cleanHostRule).
//
// What pins a conversation to a rule, and nothing else (a read, a search, a prompt or a file's text never does):
//   - a call of a tool the rule names;
//   - a write tool (Write, Edit, MultiEdit, NotebookEdit) whose file one of its paths matches;
//   - a shell tool (Bash, PowerShell) whose command names a matching path as a word of its own: never text in a
//     heredoc or a here-string, a quoted text with spaces (a commit message, a -c script) unless it reads as a path,
//     a word with * or ? (a pattern, like *.blend1 going into .gitignore), a bare .ext (a grep's) or a URL.
// A rule's pinOn narrows that (PIN_ON): 'any' (the default) all three, 'edits' its tools and its files written (a shell
// mention never pins), 'tools' only its tools, 'none' nothing: no chat is pinned, only its files stay.
// Paths have \ as /, and are from the repo's top where the caller can tell (relOf), else as written (a log laid down
// from the other machine names its paths); a glob matches a whole path or its tail, any case (globRe).
// What a conversation did is kept (seen: the tools it called, the paths it wrote or named, each with the kind of call
// that first named it, write or shell, and the first write of one a shell named first), not what it matched, so its
// pins are worked out again whenever the rules change, a pinOn too (pinsOf, cached per rules list).
//
//   createSeen() -> seen        note(seen, call, at, { relOf, rules })  (relOf(path) -> the path from its repo's top)
//   pinsOf(seen, rules) -> Map ruleId -> { tool, path, at, kind } (path null and kind 'tool' for a tool's, else kind
//     'write' or 'shell'): every rule it matched, each by its pinOn
//   firstPin(seen, rules, applies) -> the first rule (in the rules' order) it matched that applies(rule) says holds
//   hostIs(rule, { id, name }): its host is that device (hostDevice when set, else by name)
//   overridePin(choice) -> undefined (no choice) | null (let go) | a rule of its own (kept by hand); see pinOverrides
//   draftPins(seen, rules, draft) / withDraft(rules, draft) / countKept(root, globs) -> Promise { files, more }: the
//     "Keeps on a machine…" sheet's preview (fleet-view.js /rules/preview)
//   excludeSpecs(globs) / pickSpecs(globs) -> git pathspecs leaving those paths out / picking them, with the same
//     tail match (:(exclude,top,glob,icase)**/<glob>)
//   DEFAULT_RULES; migrate(list) -> the list, the old single built-in default replaced by DEFAULT_RULES
// Tests: node scripts/host-rules-test.js.
'use strict';

// Until set: the configurator's 3D files (in its repo), and Blender's tools in any workspace, stay on BlackBox
const DEFAULT_RULES = [
  { id: 'configurator-3d', repo: { origin: 'GLODUSK/detailforge-web', name: 'detailforge-web' },
    paths: ['assets/vehicles/**', '**/*.blend', '**/*.blend[0-9]*'], tools: [], host: 'BlackBox',
    note: '3D work on the configurator meshes happens on BlackBox' },
  { id: 'blender', repo: null, paths: [], tools: ['mcp__blender*'], host: 'BlackBox', note: 'Blender runs on BlackBox' },
];
// the single default before the pair (9a301af): a machine that still has it exactly gets the pair
const OLD_DEFAULT = { id: 'configurator-3d', repo: { origin: 'GLODUSK/detailforge-web', name: 'detailforge-web' },
  paths: ['assets/vehicles/**', '**/*.blend', '**/*.blend[0-9]*'], tools: ['mcp__blender*'], host: 'BlackBox',
  note: '3D work on the configurator meshes happens on BlackBox' };
const sig = (r) => JSON.stringify([r.id, r.repo ? [r.repo.origin || null, r.repo.name || null] : null, r.paths, r.tools, r.host, r.note || null]);
function migrate(list) {
  if (!Array.isArray(list) || list.length !== 1 || !list[0] || sig(list[0]) !== sig(OLD_DEFAULT)) return list;
  return DEFAULT_RULES.map((r) => ({ ...r, repo: r.repo ? { ...r.repo } : null, paths: r.paths.slice(), tools: r.tools.slice() }));
}

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
// what pins a chat to a rule (see the top): its tools always but for 'none', its paths by the kind of call
const PIN_ON = ['any', 'edits', 'tools', 'none'];
const pinOnOf = (r) => (r && PIN_ON.includes(r.pinOn) ? r.pinOn : 'any');
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const MAX_PATHS = 2000, MAX_TOOLS = 300;

// a path glob as a regex over a whole path or its tail ('/'-separated, any case): ** any folders, * and ? within one
// name, [..] a character class
function globRe(g) {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') { i++; if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*'; } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '[' && g.indexOf(']', i + 2) > i) { const j = g.indexOf(']', i + 2); re += '[' + g.slice(i + 1, j).replace(/[\\\]^]/g, '\\$&') + ']'; i = j; }
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('(?:^|/)' + re + '$', 'i');
}
const ruleRes = new WeakMap(); // a rule -> its paths' regexes
const pathResOf = (r) => { let v = ruleRes.get(r); if (!v) ruleRes.set(r, (v = r.paths.map(globRe))); return v; };
const matchesPath = (r, p) => r.paths.length > 0 && pathResOf(r).some((re) => re.test(p));
const toolMatches = (r, name) => r.tools.some((t) => (t.endsWith('*') ? name.startsWith(t.slice(0, -1)) : name === t));

// the words of a shell command that may name a file (see the top): \ as /
const PATHISH = /^(?:[A-Za-z]:[\\/]|[\\/]|~[\\/]|\.{1,2}[\\/])/;
function shellWords(cmd) {
  let s = String(cmd || '').slice(0, 20000);
  // a heredoc's body (<<EOF, <<'EOF', <<-"EOF" ... EOF) and a PowerShell here-string's (@' ... '@, @" ... "@)
  s = s.replace(/(?<!<)<<(?!<)-?[ \t]*(['"]?)([A-Za-z_][\w-]*)\1([^\n]*)\n(?:(?:[\s\S]*?\n)??[ \t]*\2[ \t]*(?=\r?\n|$)|[\s\S]*$)/g, (m, q, tag, rest) => ` ${rest}\n`);
  s = s.replace(/@(['"])\r?\n[\s\S]*?\r?\n\1@/g, ' ');
  const out = [];
  let cur = '', has = false, spaced = false, script = false;
  const flush = () => {
    if (has && !script) {
      const parts = spaced ? (PATHISH.test(cur) ? [cur] : []) : cur.split(/[=,]/);
      for (const w of parts) {
        const p = w.replace(/\\/g, '/');
        if (!p || /[*?]/.test(p) || p.includes('://') || /^\.[^/.]+$/.test(p) || !(p.includes('/') || p.includes('.'))) continue;
        out.push(p);
      }
    }
    cur = ''; has = false; spaced = false; script = false;
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\'' || c === '"') {
      const j = s.indexOf(c, i + 1), end = j < 0 ? s.length : j, body = s.slice(i + 1, end);
      if (/[\r\n]/.test(body)) script = true; else if (/\s/.test(body)) spaced = true;
      cur += body; has = true; i = end;
      continue;
    }
    if (/[\s;|&<>()`]/.test(c)) { flush(); continue; }
    cur += c; has = true;
  }
  flush();
  return out.slice(0, 400);
}
// the paths a tool call can pin by: a write tool's file, or a shell command's path words (see the top); [] for the rest
function callPaths(c) {
  const name = String((c && c.name) || ''), input = (c && c.input) || {};
  if (WRITE_TOOLS.has(name)) { const p = input.file_path || input.notebook_path; return typeof p === 'string' && p ? [p.replace(/\\/g, '/')] : []; }
  if (SHELL_TOOLS.has(name)) return shellWords(input.command);
  return [];
}

// ---------- what a conversation did, and the rules it matched ----------
const createSeen = () => ({ tools: new Map(), paths: new Map(), n: 0, cache: null });
// one tool call into seen; at: its time. o.relOf(p) -> p from its repo's top (or p); o.rules: the rules now, so a full
// list drops a path no rule matches first. A path's entry: { tool, at, kind: 'write' | 'shell', write?: { tool, at } }
// (write: the first write of a path a shell command named first)
// the kind of call a path came from (an entry kept before kinds were goes by its tool)
const kindOf = (e) => (e.kind === 'write' || e.kind === 'shell' ? e.kind : WRITE_TOOLS.has(e.tool) ? 'write' : 'shell');
function note(seen, c, at, o = {}) {
  const name = String((c && c.name) || '');
  if (!name) return;
  const t = Number(at) || 0;
  if (!seen.tools.has(name) && seen.tools.size < MAX_TOOLS) { seen.tools.set(name, t); seen.n++; }
  const rules = Array.isArray(o.rules) ? o.rules : [];
  const kind = WRITE_TOOLS.has(name) ? 'write' : 'shell';
  for (const raw of callPaths(c)) {
    let p = raw;
    if (typeof o.relOf === 'function') { try { p = String(o.relOf(raw) || raw).replace(/\\/g, '/'); } catch {} }
    const had = seen.paths.get(p);
    if (had) {
      if (kind === 'write' && kindOf(had) === 'shell' && !had.write) { had.write = { tool: name, at: t }; seen.n++; }
      continue;
    }
    if (seen.paths.size >= MAX_PATHS) {
      let gone = false;
      for (const k of seen.paths.keys()) if (!rules.some((r) => matchesPath(r, k))) { seen.paths.delete(k); gone = true; break; }
      if (!gone) continue;
    }
    seen.paths.set(p, { tool: name, at: t, kind });
    seen.n++;
  }
}
function pinsOf(seen, rules) {
  if (!seen || !Array.isArray(rules) || !rules.length) return new Map();
  const c = seen.cache;
  if (c && c.rules === rules && c.n === seen.n) return c.pins;
  const pins = new Map();
  for (const r of rules) {
    const on = pinOnOf(r);
    if (on === 'none') continue;
    let hit = null;
    for (const [tool, at] of seen.tools) if (toolMatches(r, tool) && (!hit || at < hit.at)) hit = { tool, path: null, at, kind: 'tool' };
    if (!hit && on !== 'tools' && r.paths.length) {
      for (const [p, e] of seen.paths) {
        if (!matchesPath(r, p)) continue;
        const k = kindOf(e);
        if (k === 'write' || on === 'any') { hit = { tool: e.tool, path: p, at: e.at, kind: k }; break; }
        if (e.write) { hit = { tool: e.write.tool, path: p, at: e.write.at, kind: 'write' }; break; }
      }
    }
    if (hit) pins.set(r.id, hit);
  }
  seen.cache = { rules, n: seen.n, pins };
  return pins;
}
function firstPin(seen, rules, applies) {
  const pins = pinsOf(seen, rules);
  if (!pins.size) return null;
  for (const r of rules) if (pins.has(r.id) && (typeof applies !== 'function' || applies(r))) return r;
  return null;
}

// ---------- whose machine, a chat's own choice, and a draft's preview ----------
// a rule's (or a pin's) host is this device ({ id, name }): by its sync device id when it has one (hostDevice), else by
// name, any case
function hostIs(x, dev) {
  if (!x || !dev) return false;
  if (x.hostDevice && dev.id) return String(dev.id).toLowerCase() === String(x.hostDevice).toLowerCase();
  return !!x.host && !!dev.name && String(dev.name).toLowerCase() === String(x.host).toLowerCase();
}
// a chat's own choice (sync-prefs.js cleanPinOverride) as the rule it goes by: undefined with none (the rules decide),
// null when it was let go (free), a rule of its own when kept by hand (stay: id 'manual', no paths or tools)
function overridePin(ov) {
  if (!ov || (ov.mode !== 'free' && ov.mode !== 'stay')) return undefined;
  if (ov.mode === 'free' || !ov.host) return null;
  return { id: 'manual', repo: null, paths: [], tools: [], host: ov.host, hostDevice: ov.hostDevice || null, manual: true };
}
// the rules with a draft in the place of the one with its id (else after them)
const withDraft = (rules, d) => (rules.some((r) => r.id === d.id) ? rules.map((r) => (r.id === d.id ? d : r)) : [...rules, d]);
// whether a draft rule pins a chat by what it did (seen), the draft in place in rules (its repo is the caller's to
// check); the chat's own cached pins are left as they were
function draftPins(seen, rules, draft) {
  if (!seen || !draft) return false;
  const keep = seen.cache;
  try { return pinsOf(seen, withDraft(Array.isArray(rules) ? rules : [], draft)).has(draft.id); } finally { seen.cache = keep; }
}
// how many files of a checkout some globs keep: git ls-files, tracked and untracked (not ignored: what a move would
// otherwise carry), with the same tail match (pickSpecs) -> Promise { files: a count of at most o.cap (20000), or null
// when git could not tell; more: the cap was reached, or git stopped early (o.timeout, 8 s; its output past 8 MB) }
function countKept(root, globs, o = {}) {
  const specs = pickSpecs(globs), cap = o.cap || 20000;
  if (!root || !specs.length) return Promise.resolve({ files: root ? 0 : null, more: false });
  const { execFile } = require('child_process');
  return new Promise((res) => execFile('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...specs],
    { timeout: o.timeout || 8000, windowsHide: true, maxBuffer: 8 << 20 }, (err, out) => {
      const n = new Set(String(out || '').split('\0').filter(Boolean)).size;
      if (err && !n) return res({ files: null, more: false });
      res({ files: Math.min(n, cap), more: !!err || n > cap });
    }));
}

// ---------- the same globs as git pathspecs ----------
// globRe matches a path's tail, so each glob gets a leading **/ (any folder) unless it has one
const tailGlob = (g) => (g.startsWith('**/') ? g : `**/${g.replace(/^\/+/, '')}`);
const okGlob = (g) => typeof g === 'string' && !!g && !/[\0\r\n]/.test(g);
const excludeSpecs = (globs) => (Array.isArray(globs) ? globs.filter(okGlob).map((g) => `:(exclude,top,glob,icase)${tailGlob(g)}`) : []);
const pickSpecs = (globs) => (Array.isArray(globs) ? globs.filter(okGlob).map((g) => `:(top,glob,icase)${tailGlob(g)}`) : []);

module.exports = {
  DEFAULT_RULES, OLD_DEFAULT, PIN_ON, pinOnOf, migrate, globRe, matchesPath, toolMatches, shellWords, callPaths,
  createSeen, note, pinsOf, firstPin, excludeSpecs, pickSpecs, WRITE_TOOLS, SHELL_TOOLS,
  hostIs, overridePin, withDraft, draftPins, countKept,
};
