// A Launch from outside the page: what the chat's Launch button sends, built from a conversation's transcript, so a
// bot (or any session) picking options from another conversation's list sends exactly what Henry's click sends, and
// the page and the phone grey those options as Launched (POST /api/sessions/:id/launch, fv launch).
//
// A reply offers a choice when it has a markdown task list with every box unticked (one ticked box makes it progress,
// read-only). Its options are every task item in reading order, nested ones too, numbered from 1 as the page numbers
// them. An either/or list writes "- ( ) …" instead of "- [ ] …": the ( ) items of one list (at one level) are a
// pick-one group, counted and numbered with the rest; a launch takes one of them at most, and once one is launched
// the group is decided (the others count as done). "(x)", "(X)" or "(•)" is a ticked one, as "[x]" is.
// "(recommended)" in an option's own line marks it (the page's badge); it is not part of the option's text. An
// option is launched once a user message of the conversation has a "Go with these:" list naming it (the words before
// its first ": ", case and spaces folded), sent from the page, the phone or here.
// A reply with no such list that gives a recommendation another way ("My recommendation: …", "I'd recommend …",
// "(recommended)" on a plain item: web/recommend.js) offers that, every one recommended, launched with REC_LINE: the
// session picks each one's model and effort.
//
// LAUNCH_HEAD and LAUNCH_LINE are the page's (web/chat.js) and the phone's (phone/src/lib/chat/compose.ts), word for
// word: scripts/launch-test.js checks the three agree.
'use strict';

const fs = require('fs');
const path = require('path');

const LAUNCH_HEAD = 'Go with these:';
const LAUNCH_LINE = 'Launch subagents accordingly with model and effort: first check which items touch the same files and run those one after another (the rest in parallel), one subagent per item at its stated model and effort, each in its own worktree; then review every diff yourself, run the checks, and ship.';
// a recommendation's launch line: it seldom names a model or effort, so the session works them out (CLAUDE.md "Plans")
const REC_LINE = 'Launch subagents accordingly: one subagent per item, at the model and effort it names, else the ones the work calls for (say which you picked: code edits keep this session\'s model, lookups and research go to Haiku or Sonnet; effort low for lookups and mechanical edits, medium for routine code on a clear spec, high for a feature across several files or anything touching money, permissions or migrations, xhigh for design calls, hard bugs and security); an item that needs no work, say so and skip it; items that touch the same files one after another (the rest in parallel), each in its own worktree; then review every diff yourself, run the checks, and ship.';
const REC =/\s*\(recommended\)/i;
const TASK = /^(\s*)(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s+(.*)$/;
// a pick-one item: "( ) " right after a bullet, as "[ ] " (web/chat.js, phone markdown.ts read it the same way)
const ONE = /^(\s*)[-*+]\s+\(([ xX•])\)\s+(.*)$/;
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

// a reply's options when it offers a choice -> [{ n (1-based), text, rec, group? }], else null (no task list, or a box
// ticked). group: a pick-one item's, numbered from 1 in reading order, the same for the ( ) items of one list.
// An option's lines: its own, then the ones under it indented past its marker (its wrapped text), up to the next item
// or a line back at its indent; a nested list's items are options of their own, after it
function optionsOf(md) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const found = [];
  let fence = null, cur = null, gid = 0;
  // the lists open at this line, outermost first: an item at an indent ends the deeper ones, other text the ones it
  // is not under
  const lists = [];
  const listAt = (ind) => {
    while (lists.length && lists[lists.length - 1].indent > ind) lists.pop();
    if (!lists.length || lists[lists.length - 1].indent < ind) lists.push({ indent: ind, id: ++gid });
    return lists[lists.length - 1].id;
  };
  const endLists = (ind) => { while (lists.length && lists[lists.length - 1].indent >= ind) lists.pop(); };
  for (const line of lines) {
    const ind = line.length - line.trimStart().length;
    const f = FENCE.exec(line);
    if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null; cur = null; continue; }
    if (f) { fence = f[1]; cur = null; endLists(ind); continue; }
    const m = TASK.exec(line);
    const one = !m && ONE.exec(line);
    if (m || one) {
      const at = (m || one)[1].length;
      const list = listAt(at);
      cur = { indent: at, checked: (m || one)[2] !== ' ', own: (m || one)[3], ...(one ? { group: list } : {}) };
      found.push(cur);
      continue;
    }
    if (ITEM.test(line)) { listAt(ind); cur = null; continue; }
    if (!line.trim()) { cur = null; continue; }
    if (cur && ind > cur.indent) { cur.own += ` ${line.trim()}`; continue; }
    cur = null;
    endLists(ind);
  }
  if (!found.length || found.some((o) => o.checked)) return null;
  // groups numbered 1, 2… in reading order
  const ids = new Map();
  for (const o of found) if (o.group && !ids.has(o.group)) ids.set(o.group, ids.size + 1);
  return found.map((o, i) => ({ n: i + 1, text: optionText(o.own), rec: REC.test(o.own), ...(o.group ? { group: ids.get(o.group) } : {}) }));
}

// the page's recommendation reader (web/recommend.js: an ES module with no imports), run as it stands, so the page and
// fv launch read a recommendation the same way
const { recommendationsOf } = new Function(`${fs.readFileSync(path.join(__dirname, 'web', 'recommend.js'), 'utf8').replace(/^export /gm, '')}\nreturn { recommendationsOf };`)();
// a reply's recommendation as options -> [{ n, text, rec: true }], or null when it gives none
function recOptionsOf(md) {
  const recs = recommendationsOf(md);
  return recs.length ? recs.map((text, i) => ({ n: i + 1, text, rec: true })) : null;
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

// the message a Launch sends: the picked options numbered as they stand in the list, then the launch line (for a
// recommendation's, rec, REC_LINE)
function launchText(options, ns, rec = false) {
  const byN = new Map(options.map((o) => [o.n, o]));
  const lines = [...new Set(ns)].sort((a, b) => a - b).filter((n) => byN.has(n)).map((n) => `${n}. ${byN.get(n).text}`);
  return `${LAUNCH_HEAD}\n${lines.join('\n')}\n\n${rec ? REC_LINE : LAUNCH_LINE}`;
}

// The newest reply in a transcript (items as conversation.js transcriptOf gives them: { i, type, text, t }) that
// offers a choice (a task list, else a recommendation), with what is launched already (every user message's launch,
// before it or after) -> { item, options: [{ n, text, rec, done }], rec } (rec: it is a recommendation's) or null
function latestChoice(items) {
  const launched = launchedKeys((items || []).filter((it) => it && it.type === 'user').map((it) => it.text));
  for (let k = (items || []).length - 1; k >= 0; k--) {
    const it = items[k];
    if (!it || it.type !== 'assistant') continue;
    const list = optionsOf(it.text);
    const options = list || recOptionsOf(it.text);
    if (options) return { item: it, options: decide(options.map((o) => ({ ...o, done: launched.has(launchKey(o.text)) }))), rec: !list };
  }
  return null;
}
// a pick-one group with a launched option is decided: its other options get decided: true (not launched, not
// launchable)
function decide(options) {
  const gone = new Set(options.filter((o) => o.group && o.done).map((o) => o.group));
  return options.map((o) => (o.group && !o.done && gone.has(o.group) ? { ...o, decided: true } : o));
}

// which options to launch: 'recommended' (the marked ones not launched yet, the first marked one of a pick-one group)
// or a list of numbers (1-based) -> { ns } or { error } (none marked, a number not in the list, two of one pick-one
// group, every one picked launched already). An option of a decided group counts as launched.
function choose(options, picks) {
  const done = (n) => options.find((o) => o.n === n && (o.done || o.decided));
  if (picks === 'recommended') {
    const rec = options.filter((o) => o.rec && (!o.group || options.find((x) => x.rec && x.group === o.group) === o));
    if (!rec.length) return { error: 'no option in the list is marked (recommended): give the numbers to launch' };
    const ns = rec.filter((o) => !o.done && !o.decided).map((o) => o.n);
    return ns.length ? { ns } : { error: `the recommended option${rec.length > 1 ? 's are' : ' is'} launched already (${rec.map((o) => o.n).join(', ')})` };
  }
  if (!Array.isArray(picks) || !picks.length) return { error: 'picks must be "recommended" or a list of option numbers' };
  const bad = picks.filter((n) => !Number.isInteger(n) || !options.some((o) => o.n === n));
  if (bad.length) return { error: `the list has options 1 to ${options.length}; no ${bad.join(', ')}` };
  const asked = [...new Set(picks)].sort((x, y) => x - y);
  // a pick-one group takes one
  const byGroup = new Map();
  for (const n of asked) {
    const g = options.find((o) => o.n === n).group;
    if (g) byGroup.set(g, [...(byGroup.get(g) || []), n]);
  }
  const two = [...byGroup.values()].find((ns) => ns.length > 1);
  if (two) return { error: `options ${two.join(', ')} are one pick-one list (either/or): launch one of them` };
  const ns = asked.filter((n) => !done(n));
  if (!ns.length) return { error: `option${asked.length > 1 ? 's' : ''} ${asked.join(', ')} ${asked.length > 1 ? 'are' : 'is'} launched already${asked.some((n) => options.find((o) => o.n === n).decided) ? ' (or another of its pick-one list is)' : ''}` };
  return { ns, skipped: asked.filter((n) => done(n)) };
}

module.exports = { LAUNCH_HEAD, LAUNCH_LINE, REC_LINE, recommendationsOf, recOptionsOf, plain, optionText, optionsOf, launchKey, launchedKeys, launchText, latestChoice, decide, choose };
