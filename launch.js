// A Launch from outside the page: what the chat's Launch button sends, built from a conversation's transcript, so a
// bot (or any session) picking options from another conversation's list sends exactly what Henry's click sends, and
// the page and the phone grey those options as Launched (POST /api/sessions/:id/launch, fv launch).
//
// A reply offers a choice when it has a markdown task list with every box unticked (one ticked box makes it progress,
// read-only). Its options are every task item in reading order, nested ones too, numbered from 1 as the page numbers
// them. "(recommended)" in an option's own line marks it (the page's badge); it is not part of the option's text. An
// option is launched once a user message of the conversation has a "Go with these:" list naming it (the words before
// its first ": ", case and spaces folded), sent from the page, the phone or here.
//
// LAUNCH_HEAD and LAUNCH_LINE are the page's (web/chat.js) and the phone's (phone/src/lib/chat/compose.ts), word for
// word: scripts/launch-test.js checks the three agree.
'use strict';

const LAUNCH_HEAD = 'Go with these:';
const LAUNCH_LINE = 'Launch subagents accordingly with model and effort: first check which items touch the same files and run those one after another (the rest in parallel), one subagent per item at its stated model and effort, each in its own worktree; then review every diff yourself, run the checks, and ship.';
const REC = /\s*\(recommended\)/i;
const TASK = /^(\s*)(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s+(.*)$/;
const ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

// markdown inline marks out, as the page's text of the rendered option reads: links to their text, code and
// emphasis to their words (underscores stay: they are in names like snake_case far more often than emphasis; raw
// HTML stays too: the page shows it as text)
function plain(s) {
  return String(s || '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`+([^`]*)`+/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}
// an option's words on one line as a launch lists it: without "(recommended)", cut at 400 characters (the page's)
function optionText(raw) {
  const t = plain(String(raw || '').replace(REC, ''));
  return t.length > 400 ? `${t.slice(0, 399)}…` : t;
}

// a reply's options when it offers a choice -> [{ n (1-based), text, rec }], else null (no task list, or a box ticked).
// An option's lines: its own, then the ones under it indented past its marker (its wrapped text), up to the next item
// or a line back at its indent; a nested list's items are options of their own, after it
function optionsOf(md) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const found = [];
  let fence = null, cur = null;
  for (const line of lines) {
    const f = FENCE.exec(line);
    if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null; cur = null; continue; }
    if (f) { fence = f[1]; cur = null; continue; }
    const m = TASK.exec(line);
    if (m) {
      cur = { indent: m[1].length, checked: m[2] !== ' ', own: m[3] };
      found.push(cur);
      continue;
    }
    if (!cur) continue;
    const ind = line.length - line.trimStart().length;
    if (!line.trim() || ITEM.test(line) || ind <= cur.indent) { cur = null; continue; }
    cur.own += ` ${line.trim()}`;
  }
  if (!found.length || found.some((o) => o.checked)) return null;
  return found.map((o, i) => ({ n: i + 1, text: optionText(o.own), rec: REC.test(o.own) }));
}

// what an option is known by in a launch: its name before the first ": " (else all of it), case and spaces folded
// (web/chat.js launchKey)
function launchKey(t) {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  const at = s.indexOf(': ');
  return (at > 0 && at <= 160 ? s.slice(0, at) : s).toLowerCase();
}
// the options launched in these user messages: the numbered lines after each "Go with these:" (at the start of the
// message or of a line), up to the first other line that is not blank -> Set of launchKey
function launchedKeys(texts) {
  const out = new Set();
  for (const raw of texts || []) {
    const s = String(raw || '').replace(/\r\n?/g, '\n');
    const at = s.startsWith(LAUNCH_HEAD) ? 0 : s.indexOf(`\n${LAUNCH_HEAD}`) + 1;
    if (!at && !s.startsWith(LAUNCH_HEAD)) continue;
    for (const line of s.slice(at).split('\n').slice(1)) {
      const m = /^\s*\d+[.)]\s+(.+)$/.exec(line);
      if (m) out.add(launchKey(m[1]));
      else if (line.trim()) break;
    }
  }
  return out;
}

// the message a Launch sends: the picked options numbered as they stand in the list, then the launch line
function launchText(options, ns) {
  const byN = new Map(options.map((o) => [o.n, o]));
  const lines = [...new Set(ns)].sort((a, b) => a - b).filter((n) => byN.has(n)).map((n) => `${n}. ${byN.get(n).text}`);
  return `${LAUNCH_HEAD}\n${lines.join('\n')}\n\n${LAUNCH_LINE}`;
}

// The newest reply in a transcript (items as conversation.js transcriptOf gives them: { i, type, text, t }) that
// offers a choice, with what is launched already (every user message's launch, before it or after) ->
// { item, options: [{ n, text, rec, done }] } or null
function latestChoice(items) {
  const launched = launchedKeys((items || []).filter((it) => it && it.type === 'user').map((it) => it.text));
  for (let k = (items || []).length - 1; k >= 0; k--) {
    const it = items[k];
    if (!it || it.type !== 'assistant') continue;
    const options = optionsOf(it.text);
    if (options) return { item: it, options: options.map((o) => ({ ...o, done: launched.has(launchKey(o.text)) })) };
  }
  return null;
}

// which options to launch: 'recommended' (the marked ones not launched yet) or a list of numbers (1-based) ->
// { ns } or { error } (none marked, a number not in the list, every one picked launched already)
function choose(options, picks) {
  const done = (n) => options.find((o) => o.n === n && o.done);
  if (picks === 'recommended') {
    const rec = options.filter((o) => o.rec);
    if (!rec.length) return { error: 'no option in the list is marked (recommended): give the numbers to launch' };
    const ns = rec.filter((o) => !o.done).map((o) => o.n);
    return ns.length ? { ns } : { error: `the recommended option${rec.length > 1 ? 's are' : ' is'} launched already (${rec.map((o) => o.n).join(', ')})` };
  }
  if (!Array.isArray(picks) || !picks.length) return { error: 'picks must be "recommended" or a list of option numbers' };
  const bad = picks.filter((n) => !Number.isInteger(n) || !options.some((o) => o.n === n));
  if (bad.length) return { error: `the list has options 1 to ${options.length}; no ${bad.join(', ')}` };
  const asked = [...new Set(picks)].sort((x, y) => x - y);
  const ns = asked.filter((n) => !done(n));
  if (!ns.length) return { error: `option${asked.length > 1 ? 's' : ''} ${asked.join(', ')} ${asked.length > 1 ? 'are' : 'is'} launched already` };
  return { ns, skipped: asked.filter((n) => done(n)) };
}

module.exports = { LAUNCH_HEAD, LAUNCH_LINE, plain, optionText, optionsOf, launchKey, launchedKeys, launchText, latestChoice, choose };
