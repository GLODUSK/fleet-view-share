// Fleet View chat: the slash commands the compose box offers as you type "/" (web/compose.js), served as
// GET /chat/commands?cwd=<folder> -> { commands: [{ name, desc, hint, src }] }.
//
// Claude Code doesn't publish its list, so this is a best guess at what the session has: its built-in commands
// (BUILTIN, from Claude Code 2.1), the bundled skills you can call, and what is on disk: your commands
// (~/.claude/commands/**/*.md, a subfolder giving "dir:name"), your skills (~/.claude/skills/<name>/SKILL.md,
// and the synced ones further down), and the same two folders in the conversation's folder and its
// repo root. A command missing here still works when typed: the box sends whatever you type.
//
// Reading the folders is cheap but not free: a list is kept per cwd for CACHE_MS.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const CACHE_MS = 30000;
const MAX_FILES = 400; // per folder walked, so a huge commands folder can't stall the server

// [name, description, argument hint]
const BUILTIN = [
  ['add-dir', 'Add a new working directory', '<path>'],
  ['branch', 'Create a branch of the current conversation at this point'],
  ['btw', 'Ask a quick side question without interrupting the main conversation', '<question>'],
  ['clear', 'Start a new session with empty context (the old one stays resumable)'],
  ['color', 'Set the prompt bar color for this session'],
  ['compact', 'Free up context by summarizing the conversation so far', '[instructions]'],
  ['config', 'Open settings'],
  ['context', 'Show current context usage'],
  ['copy', "Copy Claude's last response to the clipboard"],
  ['diff', 'View uncommitted changes'],
  ['doctor', "Health-check Claude Code's setup"],
  ['effort', 'Set effort level for model usage', '<low|medium|high|xhigh|max>'],
  ['exit', 'Exit the session'],
  ['export', 'Export the current conversation to a file or clipboard'],
  ['fast', 'Toggle fast mode'],
  ['feedback', 'Send feedback to Anthropic or report a bug'],
  ['fork', 'Copy this conversation into a new background session'],
  ['goal', 'Set a goal Claude checks before stopping', '<condition>'],
  ['help', 'Show help and available commands'],
  ['hooks', 'View hook configurations for tool events'],
  ['ide', 'Manage IDE integrations and show status'],
  ['init', 'Initialize a new CLAUDE.md file with codebase documentation'],
  ['mcp', 'Manage MCP servers'],
  ['memory', 'Edit CLAUDE.md files and memory settings'],
  ['model', 'Set the AI model for Claude Code', '<model>'],
  ['output-style', 'List output styles or switch to one'],
  ['permissions', 'Manage allow and deny tool permission rules'],
  ['plan', 'Enable plan mode or view the current session plan'],
  ['plugin', 'Manage Claude Code plugins'],
  ['recap', 'Generate a one-line session recap now'],
  ['reload-plugins', 'Activate pending plugin changes in the current session'],
  ['reload-skills', 'Pick up skills added or changed on disk during this session'],
  ['rename', 'Rename the current conversation', '<name>'],
  ['resume', 'Resume a previous conversation'],
  ['skills', 'List available skills'],
  ['status', 'Show version, model, account and tool status'],
  ['tasks', 'View and manage everything running in the background'],
  ['theme', 'Change the theme'],
  ['usage', 'Show session cost, plan usage and activity stats'],
  ['workflows', 'Browse running and completed workflows'],
  // bundled skills
  ['code-review', 'Review the current diff for correctness bugs', '[low|medium|high|xhigh|max]'],
  ['loop', 'Run a prompt or slash command on a recurring interval', '[interval] <prompt>'],
  ['schedule', 'Create and manage scheduled remote Claude Code agents'],
  ['security-review', 'Complete a security review of the pending changes on the current branch'],
  ['simplify', 'Review the changed code for reuse and simplification, then apply the fixes'],
];

// the frontmatter of a .md file: { description, 'argument-hint', name } (plain "key: value" lines only)
function front(file) {
  let text = '';
  try {
    const fd = fs.openSync(file, 'r');
    try { const b = Buffer.alloc(4096); text = b.toString('utf8', 0, fs.readSync(fd, b, 0, b.length, 0)); } finally { fs.closeSync(fd); }
  } catch { return {}; }
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out = {};
  if (!m) {
    // no frontmatter: the first line that isn't a heading's mark says what it does
    const first = text.split(/\r?\n/).find((l) => l.trim());
    if (first) out.description = first.replace(/^#+\s*/, '').trim();
    return out;
  }
  for (const l of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z-]+):\s*(.*)$/.exec(l);
    if (kv) out[kv[1].toLowerCase()] = kv[2].trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return out;
}

// <dir>/**/*.md as commands: "a/b.md" -> "a:b"
function commandsIn(dir, src, out) {
  let n = 0;
  const walk = (d, pre) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (n >= MAX_FILES) return;
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) walk(path.join(d, e.name), pre + e.name + ':');
      else if (e.isFile() && /\.md$/i.test(e.name)) {
        n++;
        const f = front(path.join(d, e.name));
        out.push({ name: pre + e.name.replace(/\.md$/i, ''), desc: f.description || '', hint: f['argument-hint'] || '', src });
      }
    }
  };
  walk(dir, '');
}

// <dir>/<name>/SKILL.md as skills; deeper for folders that hold skills: the synced ones
// (~/.claude/skills/synced/<x>/<name>) are named "anthropic-skills:<name>" in the session
function skillsIn(dir, src, out, depth = 0, pre = '') {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents.slice(0, MAX_FILES)) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue; // .trash holds deleted ones
    const sub = path.join(dir, e.name), file = path.join(sub, 'SKILL.md');
    if (fs.existsSync(file)) {
      const f = front(file);
      if (f['user-invocable'] === 'false') continue;
      out.push({ name: pre + (f.name || e.name), desc: f.description || '', hint: f['argument-hint'] || '', src });
    } else if (depth < 2) skillsIn(sub, src, out, depth + 1, depth === 0 && e.name === 'synced' ? 'anthropic-skills:' : pre);
  }
}

// the repo root above a folder (the nearest one with .git), or null
function repoRoot(dir) {
  for (let d = dir, i = 0; d && i < 30; i++) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}

const cache = new Map(); // cwd -> { at, out }
function list(cwd) {
  const key = String(cwd || '');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.out;
  const found = [];
  const home = path.join(os.homedir(), '.claude');
  const dirs = [];
  if (cwd && path.isAbsolute(cwd) && fs.existsSync(cwd)) {
    dirs.push(cwd);
    const r = repoRoot(cwd);
    if (r && path.resolve(r) !== path.resolve(cwd)) dirs.push(r);
  }
  for (const d of dirs) {
    commandsIn(path.join(d, '.claude', 'commands'), 'project', found);
    skillsIn(path.join(d, '.claude', 'skills'), 'project', found);
  }
  commandsIn(path.join(home, 'commands'), 'user', found);
  skillsIn(path.join(home, 'skills'), 'user', found);
  for (const [name, desc, hint] of BUILTIN) found.push({ name, desc, hint: hint || '', src: 'built-in' });
  // the first of a name wins: a project's command over yours over a built-in, as in Claude Code
  const seen = new Set(), commands = [];
  for (const c of found) {
    if (!c.name || seen.has(c.name)) continue;
    seen.add(c.name);
    commands.push({ ...c, desc: c.desc.slice(0, 200) });
  }
  commands.sort((a, b) => a.name.localeCompare(b.name));
  const out = { commands };
  cache.set(key, { at: Date.now(), out });
  if (cache.size > 50) cache.delete(cache.keys().next().value);
  return out;
}

module.exports = { list, _test: { front, BUILTIN } };
