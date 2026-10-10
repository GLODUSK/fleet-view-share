// Chat tab, the bottom half: the compose box that types into the conversation's live Claude Code session.
//
// Everything below the chat feed is this module's: the activity line (Claude is working: its spinner verb, the
// time and tokens), the card for a menu Claude shows (a permission prompt, a question, the plan approval), the
// card for a command's panel (/usage, /status, /config, /mcp…: what the session draws there, with keys that drive
// it; see parsePanel; sending text closes it first), the text box with its image attachments, the permission-mode picker, the Remote Control switch (see parseRemote) and Send. While Claude works and the box is
// empty, Send is a red Stop button (so is Esc in an empty box); with text in the box it sends, as always. A sent message goes to the feed at once
// (the 'fv-chat-sent' event): chat.js shows it until the transcript has it. Interrupt on a queued message there
// ('fv-chat-sendnow') presses Claude Code's "send now" chord, Ctrl+X then Ctrl+S: it stops the step Claude is on
// and sends every queued message as the next turn, the way that terminal's "ctrl+x ctrl+s to send now" does.
// Unsend there ('fv-chat-unsend') takes one message back out of Claude Code's queue the way its terminal does:
// Up pulls every queued message into the prompt, Ctrl+U clears it a line at a time (Ctrl+C or Esc would stop
// Claude), and the others are queued again, each as it was. Rewind on a message ('fv-chat-rewind') types /rewind,
// moves up its list to that message and presses Enter; Claude Code then asks what to restore (a menu card here).
// What it puts back in its prompt comes to this box instead, to edit and send again. An Edit in the feed is a
// Rewind with the new text (the event's `edit`): that is sent as soon as the restore puts the old one back.
//
// It never starts a headless claude. Text goes into the same interactive pty the Session tab shows
// (window.fleetDesktop.term, see term.js), exactly the way api.js sends a message: bracketed pastes of one line
// at most 400 characters each, Alt+Enter between lines (term.js typeInto: a long or multi-line paste reaches
// the model as <pasted_content>, not the user's words), 300 ms, then Enter on its own. A
// conversation that isn't running here is started first (term.js ensureLive: like the Session tab's explicit
// open, then wait until Claude is idle). Images go to the server first (POST /chat/image saves them under
// %LOCALAPPDATA%\fleet-view\chat-images and answers the path); the message then carries their paths after the
// text, and Claude Code turns a pasted image path into [Image #N]. Any other file (dropped, picked with the clip,
// or pasted from Explorer) goes in as its own path, which the desktop window knows (fleetDesktop.pathForFile).
//
// ↑ in an empty box (or with the caret at its start) brings back your last message, and again the one before;
// ↓ goes forward again, back to what you had typed. The list: your messages in the feed, then the ones sent from
// here that it doesn't show yet. Ctrl+R searches the same list, like the terminal's: a small list over the box,
// newest first, filtered as you type; ↑↓ and Enter put one in the box, Esc closes it. (The desktop window takes
// Ctrl+R for reloading the page before the page sees it; in Edge it works.)
//
// Bash mode, as in Claude Code: "!" typed as the first character of an empty box turns the box into a shell
// command ("! bash", monospace, a rose border); Backspace in the empty box, or Esc, turns it back. Sending types
// "!" into the session as a key of its own (Claude Code switches to its bash mode only on a typed "!", never a pasted
// one), waits a moment, then pastes the command and presses Enter: it runs in the session's shell and its output
// goes into the conversation. A pasted "!" stays text, as it does there. (Claude Code's old "#" for adding a memory
// is gone from it, so the box has no such mode.)
// While Claude runs a shell command that can go to the background (its screen says "ctrl+b to run in background"),
// the activity line has a Run in background button and Ctrl+B in the Chat tab does the same: it sends Ctrl+B.
//
// Handed over from another tab (handto.js: review comments from Changes, a screenshot from Preview): when the box
// mounts and on every 'fv-handto' for its conversation it takes what waits, puts the text after what is typed (a
// blank line between) and the images with the attachments, and focuses the box; one marked send goes at once,
// as Send would.
//
// What Claude is doing comes from its screen: term.js screenText reads the rendered lines of the session's
// xterm (made off-screen when the Session tab never showed it), every 400 ms while the box is on screen. The
// readers (parseSpinner, parseMenu, parseMode) are plain functions over those lines, exported for tests.
//
// Drafts (text and attachments) are kept per conversation while the page lives, and the text also in
// localStorage (fv.draft.<id>), so switching conversations or reloading keeps what you typed.

import { esc } from './cards.js';
import { voiceSupported, startVoice, stopVoice, onVoice } from './voice.js';
import { icon } from './icons.js';
import { termApi, hosts, closePanel as closeHostPanel, typeInto, ensureLive, isStarting, screenText, screenMarked, screenReady, growRows, keepSession, openElsewhere, quoteSelection, onRekey } from './term.js';
import { takeHandoff } from './handto.js';

const POLL_MS = 400;
const ENTER_DELAY_MS = 300; // the paste, then Enter on its own (api.js waits the same)
const CHORD_MS = 150; // between the two keys of a chord (Ctrl+X, Ctrl+S)
const BANG_MS = 150; // bash mode: the typed "!", then the command
const HS_MAX = 60; // Ctrl+R: rows shown at most
const MODE_STEP_MS = 250, MODE_MAX_PRESSES = 5;
const IMG_MAX = 15 * 1024 * 1024; // the server's limit for one image
const ATT_MAX = 10;
const HIST_MAX = 100; // messages ↑ goes back through, per conversation
const IMG_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const ELSEWHERE_CONFIRM_MS = 15000;
const PANEL_LINES = 80; // a command's panel can fill a tall screen
const REWIND_ROWS = 24; // /rewind's list needs about this many rows to show its entries and ❯
const PANEL_STEP_MS = 300; // Esc, then look again
const PANEL_OWN_MS = 15000; // a panel that comes up this soon after a "/command" sent from here is that command's
// a panel's keys, as the terminal sends them
const PANEL_KEYS = {
  left: ['←', '\x1b[D', 'Left'], right: ['→', '\x1b[C', 'Right'], up: ['↑', '\x1b[A', 'Up'], down: ['↓', '\x1b[B', 'Down'],
  tab: ['Tab', '\t', 'Next tab'], enter: ['Enter', '\r', 'Select'], esc: ['Esc', '\x1b', 'Close'],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isFixture = () => { try { return new URLSearchParams(location.search).has('fixture'); } catch { return false; } };
// icons the chat view adds to icons.js; a stand-in until it has them
const ALT = { send: 'push', attach: 'file', image: 'file', check: 'checks', copy: 'file', shield: 'alert', mode: 'plan' };
const ic = (name, size = 14) => icon(name, size) || icon(ALT[name] || 'dot', size);

// The prompt box at the bottom (between its two rules), from the screen's rows as drawn (screenText would glue a
// row that fills the width to the next one): { text, lines } with the ❯ gone, text '' when it shows
// only its hint; null when it isn't on screen (a menu or panel covers it)
const BOX_HINT = /^(?:Press up to edit queued messages|Try ".*")$/;
export function parsePromptBox(lines) {
  const L = (Array.isArray(lines) ? lines : []).map((l) => String(l ?? ''));
  let b = L.length - 1;
  while (b >= Math.max(0, L.length - 6) && !isRule(L[b])) b--;
  if (b < 1 || !isRule(L[b])) return null;
  let a = b - 1;
  while (a >= 0 && !isRule(L[a])) a--;
  if (a < 0 || b - a < 2 || !/^\s*[❯>](\s|$)/.test(L[a + 1])) return null;
  const rows = L.slice(a + 1, b);
  const text = rows.map((l, i) => (i ? l.replace(/^ {2}/, '') : l.replace(/^\s*[❯>]\s?/, '')).trimEnd()).join('\n').trim();
  return { text: BOX_HINT.test(text) ? '' : text, lines: rows.length };
}
// /rewind's list ("Restore the code and/or conversation to the point before…"): the entry the ❯ is on, and a
// signature of where it is (so a press of ↑ that moved nothing shows); null when the list isn't on screen
export function parseRewind(lines) {
  const L = (Array.isArray(lines) ? lines : []).map((l) => String(l ?? ''));
  const top = L.findLastIndex((l) => /Restore the code and\/or conversation/.test(l));
  if (top < 0) return null;
  let sel = null, at = -1, above = 0;
  for (let i = top + 1; i < L.length && sel == null; i++) {
    const u = /↑\s*(\d+)\s+more/.exec(L[i]);
    if (u) above = +u[1];
    const m = /^\s*❯\s+(.*\S)\s*$/.exec(L[i]);
    if (m) { sel = m[1]; at = i - top; }
  }
  return sel == null ? null : { sel, sig: `${at}|${above}|${sel}` };
}
// does a /rewind entry ("Reply ALPHA.…", its first line cut to the width) show this message?
const flat = (v) => String(v || '').replace(/\[Image #\d+\]\s*/g, '').replace(/\s+/g, ' ').trim();
export function rewindMatches(sel, text) {
  const e = flat(sel).replace(/…$/, '').trim(), t = flat(String(text || '').split('\n')[0]);
  if (!e || e === '(current)') return false;
  return t === e || (t.startsWith(e) && /…$/.test(String(sel).trim()));
}

// ---------- what goes into the prompt ----------
// \r\n made \n, then nothing but printable text, \n and \t: no control character can end the paste early or
// press a key (the same rule as the API's)
export const cleanText = (v) => String(v ?? '').replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
// the text, then each image's path, separated by spaces (a path with a space in it is quoted)
export function messageText(text, paths = []) {
  const ps = paths.filter(Boolean).map((p) => (/\s/.test(p) ? `"${p}"` : p));
  return [text.trim(), ...ps].filter(Boolean).join(' ');
}

// ---------- reading Claude Code's screen (plain functions over screenText's lines) ----------
const isRule = (l) => /^\s*[─━═]{6,}/.test(l) && !/[╭╮╰╯┌┐└┘]/.test(l);
const isBoxEdge = (l) => /^\s*[╭╰┌└][─━═]/.test(l);
// a line of an older boxed dialog: "│ text │" -> "  text"
const unbox = (l) => String(l ?? '').replace(/^(\s*)[│┃](\s?)/, '$1 $2').replace(/\s*[│┃]\s*$/, '');
const OPT_RE = /^(\s*)([❯›])?\s*(\d{1,2})[.)]\s+(.*\S)\s*$/;

// The spinner line while Claude works, e.g. "✻ Brewing… (12s · ↓ 1.2k tokens · esc to interrupt)", whose
// parentheses may run onto the next line when the screen is narrow. -> { verb, detail, strong } or null.
// strong: it carries the time, tokens or "esc to interrupt", so it is the live spinner and not some text.
const SPIN_RE = /^\s*([·✢✳✶✻✽✺*])\s+([A-Z][A-Za-z']*(?: [a-z][A-Za-z']*){0,2})…\s*(?:\((.*))?$/;
export function parseSpinner(lines) {
  const L = Array.isArray(lines) ? lines : [];
  for (let i = L.length - 1; i >= Math.max(0, L.length - 30); i--) {
    const m = SPIN_RE.exec(String(L[i] ?? ''));
    if (!m) continue;
    let inner = m[3] ?? null;
    if (inner != null) {
      for (let j = i + 1; !inner.includes(')') && j < L.length && j <= i + 2; j++) inner += ` ${String(L[j]).trim()}`;
      inner = inner.replace(/\).*$/, '');
    }
    const parts = (inner || '').split(/\s+·\s+/).map((p) => p.trim()).filter(Boolean);
    const strong = parts.some((p) => /esc to interrupt|^\d+(?:h|m|s)\b|\d+(?:\.\d+)?k? tokens/i.test(p));
    const detail = parts.filter((p) => !/^esc to interrupt$|^ctrl\+\w to /i.test(p)).join(' · ');
    return { verb: m[2], detail, strong };
  }
  return null;
}

// The permission mode, from the footer under the prompt: 'bypass', 'acceptEdits', 'plan', 'auto', 'default'
// (no mode line, but the prompt or "? for shortcuts" is there), or null when the footer isn't on screen (a menu
// covers it): the caller then keeps what it read last.
export function parseMode(lines) {
  const L = (Array.isArray(lines) ? lines : []).slice(-8).map((l) => String(l ?? ''));
  for (let i = L.length - 1; i >= 0; i--) {
    const l = L[i];
    if (!/⏵⏵|⏸|shift\+tab/i.test(l)) continue;
    if (/bypass permissions on/i.test(l)) return 'bypass';
    if (/accept edits on/i.test(l)) return 'acceptEdits';
    if (/plan mode on/i.test(l)) return 'plan';
    if (/auto mode on/i.test(l)) return 'auto';
  }
  if (L.some((l) => /\?\s*for shortcuts/i.test(l))) return 'default';
  // the prompt line right under the box's top rule ("❯ ", or "> " in older versions)
  for (let i = 1; i < L.length; i++) if (/^\s*[❯>](\s|$)/.test(L[i]) && isRule(L[i - 1])) return 'default';
  return null;
}

// A select menu at the bottom of the screen: Claude Code's permission prompts ("Do you want to proceed?",
// "Do you want to make this edit to x?"), AskUserQuestion, the plan approval ("Would you like to proceed?"),
// the folder trust question. Only when at least two options numbered one after another sit in the last ~30
// non-empty lines and one of them carries the ❯ pointer; the prompt box (❯ under a rule, where a typed
// "1. … 2. …" list would look the same) and a menu with the prompt drawn under it are not menus.
// -> { title, context: [lines], more, options: [{ n, label, desc, on }], sig } or null
export function parseMenu(lines) {
  const raw = (Array.isArray(lines) ? lines : []).map((l) => String(l ?? ''));
  const L = raw.map(unbox);
  let start = L.length, seen = 0;
  while (start > 0 && seen < 30) { start--; if (L[start].trim()) seen++; }
  const opts = [];
  for (let i = start; i < L.length; i++) {
    const m = OPT_RE.exec(L[i]);
    if (m) opts.push({ i, n: +m[3], on: !!m[2], label: m[4], col: L[i].indexOf(m[3]), boxed: /^\s*[│┃]/.test(raw[i]) });
  }
  // runs of options numbered one after another, at most 8 lines (descriptions, wrapped in a narrow panel) between two
  let run = null, cur = [];
  const close = () => { if (cur.length >= 2 && cur.some((o) => o.on)) run = cur; };
  for (const o of opts) {
    const last = cur[cur.length - 1];
    if (last && o.n === last.n + 1 && o.i - last.i <= 9) cur.push(o);
    else { close(); cur = [o]; }
  }
  close();
  if (!run) return null;
  const first = run[0], last = run[run.length - 1];
  let k = first.i - 1;
  while (k >= 0 && !L[k].trim()) k--;
  if (first.on && k >= 0 && isRule(L[k])) return null; // the prompt box with a typed list in it
  // the prompt drawn under it: the menu is not what Claude waits on
  for (let j = last.i + 1; j < L.length; j++) if (/^\s*❯(\s|$)/.test(L[j]) && !OPT_RE.test(L[j])) return null;
  // descriptions: the lines under an option indented past its number
  const options = run.map((o, x) => {
    const end = x + 1 < run.length ? run[x + 1].i : Math.min(L.length, o.i + 3);
    const desc = [];
    for (let j = o.i + 1; j < end; j++) {
      const l = L[j];
      if (!l.trim() || isRule(l)) continue;
      if (l.search(/\S/) > o.col) desc.push(l.trim());
      else break;
    }
    return { n: o.n, label: o.label.replace(/\s+/g, ' '), desc: desc.join(' ').slice(0, 200), on: o.on };
  });
  // the title: the line above the first option; the context: what's above it, up to the dialog's top
  let title = '';
  if (k >= 0 && !isRule(L[k]) && !isBoxEdge(L[k]) && !OPT_RE.test(L[k])) { title = L[k].trim(); k--; }
  const ctx = [];
  for (; k >= 0 && ctx.length < 30; k--) {
    const l = L[k];
    if (isRule(l) || /^\s*[●⎿]/.test(l) || (isBoxEdge(l) && /^\s*[╭┌]/.test(l) && first.boxed)) break;
    if (isBoxEdge(l)) continue;
    ctx.unshift(l.replace(/\s+$/, ''));
  }
  // the question reads better as the title than a note under it ("Do you trust the files in this folder?")
  const qi = /\?$/.test(title) ? -1 : ctx.map((l) => /\?$/.test(l)).lastIndexOf(true);
  if (qi >= 0) {
    const pad = ctx[qi].match(/^\s*/)[0];
    const q = ctx.splice(qi, 1)[0].trim();
    if (title) ctx.push(pad + title);
    title = q;
  }
  while (ctx.length && !ctx[0].trim()) ctx.shift();
  while (ctx.length && !ctx[ctx.length - 1].trim()) ctx.pop();
  const squeezed = ctx.filter((l, x) => l.trim() || (ctx[x - 1] || '').trim()); // no two blank lines in a row
  const ind = Math.min(...squeezed.filter((l) => l.trim()).map((l) => l.search(/\S/)), 99);
  const context = squeezed.map((l) => l.slice(Math.min(ind, l.match(/^\s*/)[0].length)));
  const more = context.length > 8;
  const sig = JSON.stringify([title, options.map((o) => [o.n, o.label, o.on])]);
  return { title, context: context.slice(0, 8), more, options, sig };
}

// A command's panel: what /usage, /status, /config, /help, /mcp, /permissions, /theme, /resume and the like draw
// in place of the prompt. Claude Code edges it with a full-width ▔ line on top and names its keys inside it
// ("Esc to cancel", "↑/↓ to navigate · Enter to confirm · Esc to cancel"), with no prompt box under it; a tall
// one scrolls within itself ("↓ 20 more"), so it fits the screen. lines may carry screenMarked's \x01…\x02 marks:
// the tab row's marked word is the tab it shows. o.loose: the keys line may be missing (a tab still loading, of a
// panel already known to be up).
// -> { title, tabs: [{ label, on }], body: [lines], keys, sig } or null
const PANEL_TOP = /^\s*▔{12,}\s*$/;
const PANEL_ESC = /\besc to (?:cancel|close|clear|go back|exit|quit)\b/i;
const unmark = (l) => String(l ?? '').replace(/[\x01\x02]/g, '');
export function parsePanel(lines, o = {}) {
  const M = (Array.isArray(lines) ? lines : []).map((l) => String(l ?? '').replace(/\s+$/, ''));
  const L = M.map(unmark);
  let top = -1;
  for (let i = L.length - 1; i >= 0 && top < 0; i--) if (PANEL_TOP.test(L[i])) top = i;
  if (top < 0) return null;
  while (top + 1 < L.length && /^\s*▔+\s*$/.test(L[top + 1])) top++; // an edge wider than the screen, wrapped onto two rows
  const body = L.slice(top + 1), marked = M.slice(top + 1);
  // the prompt box under it: an old frame above the prompt, not a panel that is up
  for (let i = 1; i < body.length; i++) if (isRule(body[i - 1]) && /^\s*[❯>](\s|$)/.test(body[i])) return null;
  if (!o.loose && !body.some((l) => PANEL_ESC.test(l))) return null;
  while (body.length && !body[body.length - 1].trim()) { body.pop(); marked.pop(); }
  // its keys, when they close it: the last line, and a line of them above it that it wrapped from
  let keys = '';
  const last = body.length - 1;
  if (last >= 0 && PANEL_ESC.test(body[last])) {
    let k = last;
    if (k > 0 && / to /.test(body[k - 1]) && / · /.test(body[k - 1]) && body[k - 1].trim()) k--;
    keys = body.splice(k).map((l) => l.trim()).join(' ');
    marked.splice(k);
    while (body.length && !body[body.length - 1].trim()) { body.pop(); marked.pop(); }
  }
  // the title: its first line; a row of tabs ("Settings  Status   Config   Usage   Stats") when it has three or
  // more words two spaces apart, the first of them its name
  let f = 0;
  while (f < body.length && !body[f].trim()) f++;
  let title = '', tabs = [];
  if (f < body.length) {
    const parts = marked[f].trim().split(/(?:\s{2,}|(?=\x01)|(?<=\x02))/).map((p) => p.trim()).filter((p) => unmark(p).trim());
    if (parts.length >= 3) {
      title = unmark(parts[0]).trim();
      tabs = parts.slice(1).map((p) => ({ label: unmark(p).trim(), on: p.includes('\x01') }));
    } else title = body[f].trim();
    body.splice(0, f + 1);
  }
  while (body.length && !body[0].trim()) body.shift();
  const squeezed = body.filter((l, x) => l.trim() || (body[x - 1] || '').trim()); // no two blank lines in a row
  const ind = Math.min(...squeezed.filter((l) => l.trim()).map((l) => l.search(/\S/)), 99);
  const out = squeezed.map((l) => l.slice(Math.min(ind, l.match(/^\s*/)[0].length)));
  const sig = JSON.stringify([title, tabs.map((t) => [t.label, t.on]), out, keys]);
  return { title, tabs, body: out, keys, sig };
}

// The effort in the footer under the prompt ("◐ medium · /effort"), or null when it isn't on screen.
export function parseEffort(lines) {
  const L = (Array.isArray(lines) ? lines : []).slice(-8);
  for (let i = L.length - 1; i >= 0; i--) {
    const m = /(?:^|\s)(low|medium|high|xhigh|max)\s+·\s+\/effort\b/i.exec(String(L[i] ?? ''));
    if (m) return m[1].toLowerCase();
  }
  return null;
}

// ---------- slash commands (GET /chat/commands, see commands.js) ----------
const cmdLists = new Map(); // cwd -> Promise<[{ name, desc, hint, src }]>
function commandsFor(cwd) {
  const key = String(cwd || '');
  let p = cmdLists.get(key);
  if (!p) {
    p = isFixture()
      ? Promise.resolve([{ name: 'compact', desc: 'Free up context by summarizing the conversation so far', hint: '[instructions]' }, { name: 'context', desc: 'Show current context usage', hint: '' }, { name: 'effort', desc: 'Set effort level for model usage', hint: '<low|medium|high|xhigh|max>' }, { name: 'model', desc: 'Set the AI model for Claude Code', hint: '<model>' }, { name: 'handoff', desc: 'Close this session with a handoff summary', hint: '' }])
      : fetch(`/chat/commands?cwd=${encodeURIComponent(key)}`).then((r) => r.json()).then((j) => (Array.isArray(j?.commands) ? j.commands : []));
    p = p.catch(() => { cmdLists.delete(key); return []; });
    cmdLists.set(key, p);
    setTimeout(() => { if (cmdLists.get(key) === p) cmdLists.delete(key); }, 60000); // new commands on disk show within a minute
  }
  return p;
}
// what "/<q>" matches: names starting with it first (or a part after ":" starting with it), then names containing it
export function matchCommands(list, q, max = 50) {
  const k = String(q || '').toLowerCase();
  const starts = [], has = [];
  for (const c of list || []) {
    const n = String(c.name || '').toLowerCase();
    if (!k || n.startsWith(k) || n.split(':').some((p) => p.startsWith(k))) starts.push(c);
    else if (n.includes(k)) has.push(c);
  }
  return starts.concat(has).slice(0, max);
}
// Claude Code runs a command only at the start of a message, so one typed mid-sentence ("compare these /deep-research
// for me") moves to the front: "/deep-research compare these for me". Only a name on the list counts (a path like
// "/usr" or a URL stays as typed), and a message that already starts with "/" is left alone.
export function hoistCommand(text, names) {
  const t = String(text ?? '');
  if (/^\s*\//.test(t)) return t;
  const known = new Set([...(names || [])].map((n) => String(n).toLowerCase()));
  const re = /(^|\s)\/([^\s/]+)(?=\s|$)/g;
  for (let m; (m = re.exec(t));) {
    if (!known.has(m[2].toLowerCase())) continue;
    const start = m.index + m[1].length, end = start + 1 + m[2].length;
    const before = t.slice(0, start).replace(/[ \t]+$/, ''), after = t.slice(end).replace(/^[ \t]+/, '');
    const rest = (before && after && !/\n$/.test(before) && !/^\n/.test(after) ? `${before} ${after}` : before + after).trim();
    return rest ? `/${m[2]} ${rest}` : `/${m[2]}`;
  }
  return t;
}

// ---------- "@" mentions (GET /chat/files, see files.js) ----------
const FIXTURE_FILES = ['web', 'web/app.js', 'web/compose.js', 'web/compose.css', 'web/chat.js', 'desktop', 'desktop/main.js', 'README.md', 'fleet-view.js']
  .map((p) => ({ path: p, dir: !p.includes('.') }));
const fileLists = new Map(); // `${cwd}\n${q}` -> Promise<[{ path, dir }]>, for a few seconds
function filesFor(cwd, q) {
  const key = `${cwd || ''}\n${q}`;
  let p = fileLists.get(key);
  if (!p) {
    p = isFixture()
      ? Promise.resolve(FIXTURE_FILES.filter((f) => f.path.toLowerCase().includes(String(q).toLowerCase())))
      : fetch(`/chat/files?cwd=${encodeURIComponent(cwd || '')}&q=${encodeURIComponent(q)}`).then((r) => r.json()).then((j) => (Array.isArray(j?.files) ? j.files : []));
    p = p.catch(() => []);
    fileLists.set(key, p);
    setTimeout(() => fileLists.delete(key), 5000);
  }
  return p;
}
const baseName = (p) => String(p || '').split('/').pop();
// what goes in the box for a picked file or folder: "@web/app.js " or "@web/" (to go on into it); a path with a
// space is quoted, the way Claude Code writes it: @"My Folder/a b.txt"
export function mentionRef(p, dir) {
  const s = dir ? `${p}/` : p;
  if (/\s/.test(s)) return `@"${s}" `;
  return dir ? `@${s}` : `@${s} `;
}

// ---------- model and effort (sent as /model <alias> and /effort <level>) ----------
// the newest of each family, sent as its full id so the menu says which version you get
export const MODEL_IDS = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5-5[1m]', 'claude-sonnet-5-5', 'claude-sonnet-5-5[1m]', 'claude-haiku-5-5'];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// 'claude-opus-5-5[1m]' -> 'Opus 5.5' (with big: ' · 1M context'); a date at the end ('-20250929') is dropped
export function modelLabel(id, short = false) {
  const raw = String(id || ''), big = /\[1m\]$/i.test(raw);
  const parts = raw.replace(/\[1m\]$/i, '').replace(/^claude-/, '').replace(/-\d{8}$/, '').split('-');
  const fam = parts.find((p) => /^[a-z]+$/i.test(p)) || parts[0] || '';
  const ver = parts.filter((p) => /^\d+$/.test(p)).join('.');
  const name = [fam.charAt(0).toUpperCase() + fam.slice(1), ver].filter(Boolean).join(' ');
  return big ? `${name}${short ? ' 1M' : ' · 1M context'}` : name;
}
// the id the session runs, as the menu names it: with [1m] when its context is the 1M one
const modelKey = (model, big) => {
  const m = String(model || '').replace(/\[1m\]$/i, '');
  return m ? (big ? `${m}[1m]` : m) : null;
};

// ---------- drafts, per conversation ----------
// quote: what Reply took from the feed, as "> " lines; it shows as a bubble above the text and goes in first.
// shell: the box is in bash mode (the text is a shell command, without its "!")
const drafts = new Map(); // id -> { text, quote, shell, atts: [{ key, blob, mime, name, size, url, path? }] }
const draftKey = (id) => `fv.draft.${id}`;
const quoteKey = (id) => `fv.quote.${id}`;
const shellKey = (id) => `fv.shell.${id}`;
function draftOf(id) {
  let d = drafts.get(id);
  if (!d) {
    let text = '', quote = '', shell = false;
    try { text = localStorage.getItem(draftKey(id)) || ''; quote = localStorage.getItem(quoteKey(id)) || ''; shell = localStorage.getItem(shellKey(id)) === '1'; } catch {}
    d = { text, quote, shell, atts: [] };
    drafts.set(id, d);
  }
  return d;
}
function storeShell(id, on) {
  try { if (on) localStorage.setItem(shellKey(id), '1'); else localStorage.removeItem(shellKey(id)); } catch {}
}
function storeText(id, text) {
  try { if (text) localStorage.setItem(draftKey(id), text); else localStorage.removeItem(draftKey(id)); } catch {}
}
function storeQuote(id, quote) {
  try { if (quote) localStorage.setItem(quoteKey(id), quote); else localStorage.removeItem(quoteKey(id)); } catch {}
}
const dropAtt = (a) => { try { if (a.url) URL.revokeObjectURL(a.url); } catch {} };
// a new conversation (new-<n>) got its id: its draft and any box showing it move along. Registered when this
// module loads, before app.js's own onRekey, so the box's update() for the id finds the draft already there.
const boxes = new Set(); // st of each mounted box
onRekey((oldKey, id) => {
  const d = drafts.get(oldKey);
  if (d && !drafts.has(id)) { drafts.delete(oldKey); drafts.set(id, d); }
  const h = sentTexts.get(oldKey);
  if (h && !sentTexts.has(id)) { sentTexts.delete(oldKey); sentTexts.set(id, h); }
  try {
    const t = localStorage.getItem(draftKey(oldKey));
    if (t && !localStorage.getItem(draftKey(id))) localStorage.setItem(draftKey(id), t);
    localStorage.removeItem(draftKey(oldKey));
    const q = localStorage.getItem(quoteKey(oldKey));
    if (q && !localStorage.getItem(quoteKey(id))) localStorage.setItem(quoteKey(id), q);
    localStorage.removeItem(quoteKey(oldKey));
    const r = localStorage.getItem(rcKey(oldKey));
    if (r) localStorage.setItem(rcKey(id), r);
    localStorage.removeItem(rcKey(oldKey));
    if (localStorage.getItem(shellKey(oldKey))) localStorage.setItem(shellKey(id), '1');
    localStorage.removeItem(shellKey(oldKey));
  } catch {}
  for (const st of boxes) if (st.id === oldKey) st.id = id;
});

// ---------- Remote Control, per running session ----------
// Claude Code's /remote-control lets the phone app and claude.ai/code drive the session. It is off whenever a session
// starts (settings.json has remoteControlAtStartup: false, and a session started here follows it), and on only
// for the run it was turned on in: a restarted session is off again. Nothing about it goes in the transcript,
// so the box remembers what it did (fv.rc.<id> = the run it is on in, "<pid>:<startedAt>"), and the screen
// corrects that when it shows: "· /rc" after the folder in the header, "/remote-control is active · Continue
// here…" (a new one), "Remote Control disconnected.".
const rcKey = (id) => `fv.rc.${id}`;
const runOf = (h) => (h && h.alive ? `${h.pid}:${h.startedAt}` : '');
function rcStored(id) {
  const run = runOf(hosts.get(id));
  if (!run) return false;
  try { return localStorage.getItem(rcKey(id)) === run; } catch { return false; }
}
function rcStore(id, on) {
  const run = runOf(hosts.get(id));
  try { if (on && run) localStorage.setItem(rcKey(id), run); else localStorage.removeItem(rcKey(id)); } catch {}
}
// -> { header: 'on' | 'connecting' | 'off' | null (the header isn't on screen), active: how many "/remote-control is
// active" lines show, last: 'active' | 'disconnected' | null, the lower (newer) of the two }. An "is active" line
// stays in the history after it goes off again, so only a new one (more than the last read saw) means it went on.
export function parseRemote(lines) {
  const L = (Array.isArray(lines) ? lines : []).map((l) => String(l ?? ''));
  let header = null, active = 0, last = null;
  for (const l of L) {
    if (/^\s*▝▝\s+▝▝\s+\S/.test(l)) header = /\s·\s+\/rc connecting/i.test(l) ? 'connecting' : /\s·\s+\/rc\s*$/.test(l) ? 'on' : 'off';
    if (/\/remote-control is active/i.test(l)) { active++; last = 'active'; }
    if (/Remote Control disconnected/i.test(l)) last = 'disconnected';
  }
  return { header, active, last };
}
// the Remote Control menu (/remote-control while it is on): "Disconnect this session", "Show QR code", "Continue"
const rcMenuUp = (lines) => lines.some((l) => /^\s*(❯\s*)?Disconnect this session\s*$/.test(String(l ?? '')));
const rcOnDisconnect = (lines) => lines.some((l) => /^\s*❯\s*Disconnect this session\s*$/.test(String(l ?? '')));

// ---------- what was sent from here, per conversation (↑ finds it before the feed shows it) ----------
const sentTexts = new Map(); // id -> [text]
function rememberSent(id, text) {
  if (!text) return;
  const l = sentTexts.get(id) || [];
  l.push(text);
  if (l.length > HIST_MAX) l.shift();
  sentTexts.set(id, l);
}
// the feed's user messages and slash commands, oldest first, then what was sent and isn't there yet; repeats in
// a row once. A bash command (the transcript's <bash-input>) is "!<command>"; what it printed isn't a message.
export function pastMessages(items, sent) {
  const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  const out = [], have = new Set();
  const push = (t) => {
    const v = String(t || '').trim();
    if (!v || out[out.length - 1] === v) return;
    out.push(v);
    have.add(norm(v));
  };
  for (const it of items || []) {
    const t = String(it.text || '');
    if (it.kind === 'user') {
      if (/^\s*<bash-(?:stdout|stderr)>/.test(t)) continue;
      const b = /^\s*<bash-input>([\s\S]*?)<\/bash-input>\s*$/.exec(t);
      push(b ? `!${b[1]}` : t);
    } else if (it.kind === 'note' && /^\/\S/.test(t)) push(t);
  }
  for (const t of sent || []) if (!have.has(norm(t))) push(t);
  return out.slice(-HIST_MAX);
}
// Ctrl+R's list: the past messages holding every word of q (any case), newest first
export function searchPast(list, q, max = HS_MAX) {
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  const out = [];
  for (let i = (list || []).length - 1; i >= 0 && out.length < max; i--) {
    const t = String(list[i]), l = t.toLowerCase();
    if (words.every((w) => l.includes(w)) && !out.includes(t)) out.push(t);
  }
  return out;
}

let attSeq = 0;
const hex = (n) => { const b = new Uint8Array(n); crypto.getRandomValues(b); return [...b].map((x) => x.toString(16).padStart(2, '0')).join(''); };
const toBase64 = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
  r.onerror = () => reject(r.error || new Error('could not read the image'));
  r.readAsDataURL(blob);
});
// POST /chat/image -> the saved file's path (kept on the attachment, so a retry doesn't upload it twice)
async function uploadImage(a) {
  if (a.path) return a.path;
  const data = await toBase64(a.blob);
  if (isFixture()) {
    // fixture data: nothing reaches a server; recorded like app.js records its POSTs
    try { window.__fvPosts?.push({ url: '/chat/image', body: { mime: a.mime, bytes: a.size } }); } catch {}
    a.path = `C:\\Users\\you\\AppData\\Local\\fleet-view\\chat-images\\${hex(8)}.${IMG_TYPES[a.mime]}`;
    return a.path;
  }
  let r, j = null;
  try { r = await fetch('/chat/image', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data, mime: a.mime }) }); } catch { throw new Error('the server did not answer'); }
  try { j = await r.json(); } catch {}
  if (!r.ok || !j || typeof j.path !== 'string') throw new Error((j && j.error) || `the server said ${r.status}`);
  a.path = j.path;
  return a.path;
}

// ---------- the modes Shift+Tab cycles through ----------
const MODES = [
  { k: 'default', label: 'Ask before edits', short: 'Default' },
  { k: 'acceptEdits', label: 'Accept edits', short: 'Accept edits' },
  { k: 'plan', label: 'Plan mode', short: 'Plan' },
  { k: 'bypass', label: 'Bypass permissions', short: 'Bypass' },
];
const modeShort = (k) => (k === 'auto' ? 'Auto' : MODES.find((m) => m.k === k)?.short || 'Mode');

// ---------- the box ----------
// slot: the element under the feed (chat.js); s: the conversation from /state. -> { update(s), destroy() }
export function mountCompose(slot, s) {
  slot.innerHTML = `<div class="cmp">
<div class="cmp-act" hidden aria-live="polite"><span class="cmp-dot" aria-hidden="true"></span><span class="cmp-verb"></span><span class="cmp-det"></span><button type="button" class="cmp-bgb" data-c="bg" hidden title="Let the shell command go on in the background and Claude carry on (Ctrl+B)">${ic('shell', 12)}<span>Run in background</span><kbd>Ctrl+B</kbd></button></div>
<div class="cmp-card" hidden tabindex="0" role="group" aria-label="Claude is asking"></div>
<div class="cmp-panel" hidden tabindex="0" role="group" aria-label="command panel"></div>
<div class="cmp-box">
  <div class="cmp-quote" hidden></div>
  <div class="cmp-atts" hidden></div>
  <div class="cmp-slash" role="listbox" aria-label="slash commands" hidden></div>
  <div class="cmp-hs" hidden><div class="cmp-hs-h">${ic('search', 13)}<input type="text" class="cmp-hs-in" spellcheck="false" autocomplete="off" placeholder="Search your messages" aria-label="search your past messages"><span class="cmp-hs-n"></span><kbd>Esc</kbd><button type="button" class="cmp-pnl-x cmp-hs-x" title="Close (Esc)" aria-label="close the search" tabindex="-1">${ic('close', 12)}</button></div><div class="cmp-hs-l" role="listbox" aria-label="past messages"></div></div>
  <div class="cmp-shtag" hidden title="Bash mode: the command runs in the session's shell and its output goes into the conversation. Backspace or Esc in the empty box leaves it"><b>!</b> bash</div>
  <div class="cmp-taw"><textarea class="cmp-ta" rows="1" spellcheck="true" placeholder="Message Claude…" aria-label="message to Claude"></textarea><div class="cmp-ghost" aria-hidden="true" hidden><span class="cmp-ghost-pad"></span><span class="cmp-ghost-t"></span></div></div>
  <div class="cmp-notes" hidden></div>
  <div class="cmp-foot">
    <button type="button" class="cmp-ib" data-c="attach" title="Attach files or images (or paste, or drop them here)" aria-label="attach files">${ic('attach', 16)}</button>
    <button type="button" class="cmp-ib" data-c="folder" title="Attach a folder (or paste, or drop one here): Claude gets its path" aria-label="attach a folder">${ic('folder', 16)}</button>
    <span class="cmp-modew"><button type="button" class="cmp-modeb" data-c="mode" aria-haspopup="menu" aria-expanded="false" title="Permission mode (Shift+Tab in the session)">${ic('mode', 13)}<span class="cmp-model-t">Mode</span>${icon('chevron', 11)}</button><div class="cmp-menu" role="menu" hidden></div></span>
    <span class="cmp-modew cmp-modelw"><button type="button" class="cmp-modeb cmp-modelb" data-c="model" aria-haspopup="menu" aria-expanded="false" title="Model and effort">${icon('model', 13)}<span class="cmp-model-t mono">Model</span>${icon('chevron', 11)}</button><div class="cmp-menu cmp-menu-model" role="menu" hidden></div></span>
    <button type="button" class="cmp-modeb cmp-rcb" data-c="remote" aria-pressed="false" data-cur="off" aria-label="Remote Control">${ic('phone', 14)}</button>
    <span class="cmp-hint">Enter to send · Shift+Enter new line · / for commands · ! for bash · ↑ last message</span>
    <span class="grow"></span>
    <button type="button" class="cmp-ib cmp-mic" data-c="mic" title="Talk instead of typing: it listens until you click again" aria-label="dictate" aria-pressed="false">${ic('mic', 16)}</button>
    <button type="button" class="cmp-send" data-c="send" title="Send (Enter)" aria-label="send">${ic('send', 16)}</button>
  </div>
</div>
<input type="file" class="cmp-file" multiple hidden>
</div>`;
  const $ = (sel) => slot.querySelector(sel);
  const root = $('.cmp'), act = $('.cmp-act'), card = $('.cmp-card'), panelEl = $('.cmp-panel'), atts = $('.cmp-atts'), quoteEl = $('.cmp-quote');
  const ta = $('.cmp-ta'), notes = $('.cmp-notes'), sendBtn = $('.cmp-send'), fileIn = $('.cmp-file');
  const modeBtn = $('.cmp-modeb'), modeMenu = $('.cmp-menu'), slashEl = $('.cmp-slash');
  const modelBtn = $('.cmp-modelb'), modelMenu = $('.cmp-modelw .cmp-menu');
  const rcBtn = $('.cmp-rcb');
  const hsEl = $('.cmp-hs'), hsIn = $('.cmp-hs-in'), hsList = $('.cmp-hs-l'), hsN = $('.cmp-hs-n'), shTag = $('.cmp-shtag'), bgBtn = $('.cmp-bgb');
  const boxEl = $('.cmp-box'), ghost = $('.cmp-ghost'), ghostPad = $('.cmp-ghost-pad'), ghostT = $('.cmp-ghost-t');
  // the chat pane around us: drops anywhere on it land here, and chat.js sends its quotes to it
  const pane = slot.closest('.chat-pane') || slot.parentElement || slot;
  // a new pty takes the whole Chat tab's size, not a split slice's (a few rows: Claude Code's lists don't fit)
  const sizeEl = () => pane.closest('.d-chat') || pane;

  const st = {
    s, id: s.id, d: draftOf(s.id),
    busy: false, menu: null, mode: null, effort: null, rewound: null, // what the screen said last (rewound: a Rewind waiting for its message, see takeRewound)
    panel: null, cmdAt: 0, cmd: '', panelOwned: false, // a command's panel on screen; the last "/command" sent from here, and when
    want: null, // { model?, effort?, from, at }: picked here, shown until the session says so
    rcSeen: null, rcConnecting: false, rcBusy: false, rcHold: 0, // Remote Control: "is active" lines the last read saw, the header's word, a switch under way, its click trusted until
    slash: { open: false, items: [], sel: 0, q: null, shut: null, seq: 0, kind: 'cmd', at: 0 }, // the "/" and "@" list
    sending: false, step: '', switching: false,
    hist: null, // ↑ / ↓ through past messages: { list, i, draft, draftShell, shown } while browsing
    hs: null, // Ctrl+R's search while it is open: { list, rows, sel }
    bgHint: false, // the screen offers "ctrl+b to run in background" (a shell command Claude runs)
    errs: [], // [{ key, text }] until dismissed or the next send works
    elsewhereAt: 0, answeredSig: null, answeredAt: 0,
    dict: null, drain: null, // the mic: listening, and stopped but still writing out its last words: { token, ready, note, busy, live }
    sendAfter: false, // Send was pressed while the mic still had words to write out: it sends once they are in
    // (live: { text, stretch }, the preview of what is being said, drawn after the text until its final comes)
    drawn: {}, timer: 0, saveTimer: 0, alive: true,
  };
  boxes.add(st);

  // ----- the text box -----
  const maxHeight = () => Math.max(64, Math.round((pane.clientHeight || window.innerHeight * 0.6) * 0.4));
  function grow() {
    const live = liveText();
    ta.style.paddingBottom = '';
    ta.style.height = 'auto';
    const max = maxHeight();
    let h = ta.scrollHeight + 2;
    if (live) {
      // the preview takes lines of its own: the box makes room for them below its text (a taller bottom padding, so
      // the text itself is untouched) and the ghost, laid out like the text, scrolls with it
      const cs = getComputedStyle(ta);
      ghost.hidden = false;
      ghost.style.font = cs.font;
      ghost.style.letterSpacing = cs.letterSpacing;
      ghost.style.padding = cs.padding;
      ghost.style.width = `${ta.clientWidth}px`;
      ghost.style.height = 'auto';
      ghostPad.textContent = joinSpoken(ta.value, 'x').slice(0, -1); // the text, and the space the final will get
      ghostT.textContent = live;
      const g = ghost.scrollHeight + 2;
      if (g > h) { ta.style.paddingBottom = `${parseFloat(cs.paddingBottom) + g - h}px`; h = g; }
    }
    ta.style.height = `${Math.min(h, max)}px`;
    ta.style.overflowY = h > max ? 'auto' : 'hidden';
    ta.classList.toggle('live', !!live);
    if (live) {
      ghost.style.width = `${ta.clientWidth}px`;
      ghost.style.height = `${ta.clientHeight}px`;
      ghost.scrollTop = ta.scrollTop;
    } else if (!ghost.hidden) {
      ghost.hidden = true;
      ghostPad.textContent = ''; ghostT.textContent = '';
    }
  }
  // the words being said right now (the mic's preview): never in ta.value, so the draft, Send and history don't see it
  function liveText() { const v = st.dict || st.drain; return (v && v.live && v.live.text) || ''; }
  function loadDraft() {
    ta.value = st.d.text;
    drawShell();
    grow();
    drawAtts();
    drawQuote();
  }
  // ----- bash mode (see the top) -----
  function setShell(on) {
    on = !!on;
    if (st.d.shell === on) return;
    st.d.shell = on;
    storeShell(st.id, on);
    if (on) shutSlash();
    drawShell(); drawSend();
  }
  function drawShell() {
    const on = !!st.d.shell;
    boxEl.classList.toggle('shell', on);
    shTag.hidden = !on;
    ta.placeholder = on ? 'Run a shell command: its output goes into the conversation' : 'Message Claude…';
    ta.setAttribute('aria-label', on ? 'shell command to run in the session (bash mode)' : 'message to Claude');
    ta.spellcheck = !on;
  }
  // the Reply quote: a bubble with its text (the "> " marks off) and a button that drops it
  function drawQuote() {
    const q = st.d.quote;
    quoteEl.hidden = !q;
    const html = q ? `<div class="cmp-quote-t">${esc(q.replace(/\n+$/, '').split('\n').map((l) => l.replace(/^> ?/, '')).join('\n'))}</div>`
      + `<button type="button" class="cmp-quote-x" data-q="x" title="Remove the quote" aria-label="remove the quote">${icon('close', 11)}</button>` : '';
    if (st.drawn.quote !== html) { quoteEl.innerHTML = html; st.drawn.quote = html; }
  }
  function setQuote(q) {
    st.d.quote = q;
    storeQuote(st.id, q);
    drawQuote(); drawSend();
  }
  function saveDraftSoon() {
    st.d.text = ta.value;
    clearTimeout(st.saveTimer);
    const id = st.id, text = ta.value;
    st.saveTimer = setTimeout(() => storeText(id, text), 300);
  }

  // ----- attachments -----
  // the file's own path on disk (the desktop window knows it for a dropped, picked or pasted file), or ''
  const pathOf = (f) => { try { return String(window.fleetDesktop?.pathForFile?.(f) || ''); } catch { return ''; } };
  // images become thumbnails (uploaded on send, like a pasted screenshot); any other file goes in as its path.
  // quiet: leave out, without a word, what can't go in (a paste carries odd file kinds next to its text)
  function addFiles(files, quiet = false) {
    const list = [...(files || [])];
    let added = 0;
    for (const f of list) {
      if (!f) continue;
      if (st.d.atts.length >= ATT_MAX) { err(`At most ${ATT_MAX} attachments in one message`); break; }
      if (IMG_TYPES[f.type] && f.size <= IMG_MAX) {
        st.d.atts.push({ key: `a${++attSeq}`, blob: f, mime: f.type, name: f.name || `pasted.${IMG_TYPES[f.type]}`, size: f.size, url: URL.createObjectURL(f) });
        added++;
        continue;
      }
      const p = pathOf(f);
      if (!p) {
        if (quiet) continue;
        if (/^image\//.test(f.type || '')) err(f.size > IMG_MAX ? `${f.name || 'the image'} is over 15 MB` : `Only PNG, JPEG, GIF and WebP images (${f.name || f.type} is ${f.type})`);
        else err(window.fleetDesktop ? `Couldn't tell where ${f.name || 'that file'} is on disk` : 'Files other than images go in from the desktop window');
        continue;
      }
      if (addPath(p, f.name, f.size)) added++;
    }
    if (added) { drawAtts(); drawSend(); }
  }
  // a file or folder by its path (a folder goes in as its path too); the server says which it is (GET /chat/kind),
  // and a folder then shows as one. dir: known already (the folder picker). -> added
  function addPath(p, name, size = 0, dir = null) {
    if (st.d.atts.some((a) => a.path === p && a.file)) return false;
    if (st.d.atts.length >= ATT_MAX) { err(`At most ${ATT_MAX} attachments in one message`); return false; }
    const a = { key: `a${++attSeq}`, file: true, dir, name: name || p.split(/[\\/]/).filter(Boolean).pop() || p, size, path: p };
    st.d.atts.push(a);
    if (dir == null) {
      fetch(`/chat/kind?path=${encodeURIComponent(p)}`).then((r) => r.json()).then((k) => { if (k && k.dir) { a.dir = true; drawAtts(); } }).catch(() => {});
    }
    return true;
  }
  async function attachFolder() {
    const fd = window.fleetDesktop;
    if (typeof fd?.pickFolder !== 'function') return;
    let r = null;
    try { r = await fd.pickFolder(); } catch { r = null; }
    if (r && r.ok && r.path && addPath(r.path, null, 0, true)) { drawAtts(); drawSend(); }
    ta.focus();
  }
  function drawAtts() {
    const list = st.d.atts;
    atts.hidden = !list.length;
    const html = list.map((a) => (a.file
      ? `<span class="cmp-att cmp-attf${a.dir ? ' dir' : ''}" title="${a.dir ? 'folder: ' : ''}${esc(a.path)}">${icon(a.dir ? 'folder' : 'file', 14)}<span class="cmp-attf-n">${esc(a.name)}${a.dir ? '/' : ''}</span>`
      : `<span class="cmp-att"><button type="button" class="cmp-thumb" data-a="${a.key}" title="${esc(a.name)}"><img src="${esc(a.url)}" alt="${esc(a.name)}"></button>`)
      + `<button type="button" class="cmp-x" data-x="${a.key}" title="Remove" aria-label="remove ${esc(a.name)}">${icon('close', 11)}</button></span>`).join('');
    if (st.drawn.atts !== html) { atts.innerHTML = html; st.drawn.atts = html; }
  }
  function removeAtt(key) {
    const i = st.d.atts.findIndex((a) => a.key === key);
    if (i < 0) return;
    dropAtt(st.d.atts[i]);
    st.d.atts.splice(i, 1);
    drawAtts(); drawSend();
  }
  function preview(key) {
    const a = st.d.atts.find((x) => x.key === key);
    if (!a) return;
    const lb = document.createElement('div');
    lb.className = 'cmp-lightbox';
    lb.tabIndex = -1;
    lb.innerHTML = `<button type="button" class="cmp-lb-x" aria-label="close" title="close (Esc)">${ic('close', 18) || '×'}</button>`
      + `<img src="${esc(a.url)}" alt="${esc(a.name)}"><div class="cmp-lb-t">${esc(a.name)} · ${Math.max(1, Math.round(a.size / 1024))} KB</div>`;
    const shut = () => { lb.remove(); ta.focus(); };
    lb.addEventListener('click', shut);
    lb.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); shut(); } });
    document.body.appendChild(lb);
    lb.focus();
  }

  // ----- notes and errors -----
  function err(text) {
    st.errs = st.errs.filter((x) => x.text !== text).concat({ key: `e${++attSeq}`, text });
    if (st.errs.length > 3) st.errs.shift();
    drawNotes();
  }
  function drawNotes() {
    const t = termApi();
    const h = hosts.get(st.id);
    const bits = [];
    if (!t) bits.push(`<span class="cmp-chip">${icon('info', 13)}<span>Sending needs the desktop window</span></span>`);
    else if (st.step || isStarting(st.id)) bits.push(`<span class="cmp-chip info"><span class="cmp-spin" aria-hidden="true"></span><span>${esc(st.step || 'Starting session…')}</span></span>`);
    else if (st.switching) bits.push(`<span class="cmp-chip info"><span class="cmp-spin" aria-hidden="true"></span><span>Switching mode…</span></span>`);
    else if (h && !h.alive) bits.push(`<span class="cmp-chip">${icon('info', 13)}<span>The session ended${h.exitCode != null ? ` (code ${esc(h.exitCode)})` : ''}; sending starts it again</span></span>`);
    // waiting with no menu or panel card here: a panel such as /usage this tab can't read (it holds back
    // background updates), a startup dialog, or a prompt this tab can't show. An older host sends no waitingFor.
    else if (h && h.status === 'waiting' && !st.menu && !st.panel) {
      const w = h.waitingFor;
      // slashPanel: a "/" command opened it (the host saw it typed), so Esc closes it and sending does that first.
      // Any other dialog (trusting a folder, a new MCP server) is answered in the terminal: Esc there refuses it.
      if (h.slashPanel) bits.push(`<span class="cmp-chip warn">${icon('alert', 13)}<span>The ${esc(h.slashPanel)} panel is open; background updates wait until it closes (sending closes it)</span><button type="button" class="cmp-chip-b" data-c="panel-esc">Close (Esc)</button></span>`);
      else if (!w || w === 'dialog open') bits.push(`<span class="cmp-chip warn">${icon('alert', 13)}<span>A dialog or panel is open in this session: answer or close it in the Session tab</span></span>`);
      else bits.push(`<span class="cmp-chip info">${icon('info', 13)}<span>Claude is waiting: ${esc(w.length > 120 ? `${w.slice(0, 119)}…` : w)} — answer it in the Session tab</span></span>`);
    }
    else if (!h && openElsewhere(st.s)) bits.push(`<span class="cmp-chip warn">${icon('alert', 13)}<span>Open in another window: sending here starts a second copy</span></span>`);
    const v = st.dict || st.drain;
    if (v && (v.note || v.busy || st.sendAfter)) bits.push(`<span class="cmp-chip info"><span class="cmp-spin" aria-hidden="true"></span><span>${esc(v.note || (st.sendAfter ? 'Sending as soon as what you said is written out…' : 'Writing out what you said…'))}</span></span>`);
    for (const e of st.errs) bits.push(`<span class="cmp-chip err">${icon('error', 13)}<span>${esc(e.text)}</span><button type="button" class="cmp-chip-x" data-e="${e.key}" title="Dismiss" aria-label="dismiss">${icon('close', 11)}</button></span>`);
    const html = bits.join('');
    if (st.drawn.notes !== html) { notes.innerHTML = html; st.drawn.notes = html; }
    notes.hidden = !html;
  }

  // ----- Send -----
  // (in bash mode only the command goes: the quote and attachments wait for a message)
  const hasDraft = () => !!(ta.value.trim() || (!st.d.shell && (st.d.atts.length || st.d.quote)));
  function drawSend() {
    const t = termApi();
    const empty = !hasDraft() && !liveText(); // words still being written out count: Send waits for them
    // Claude is working and there's nothing to send: the button stops it instead
    const halt = empty && st.busy && !st.sending;
    const key = `${!!t}|${empty}|${st.sending}|${halt}`;
    if (st.drawn.send === key) return;
    st.drawn.send = key;
    sendBtn.classList.toggle('sending', st.sending);
    sendBtn.classList.toggle('stop', halt);
    sendBtn.dataset.c = halt ? 'stop' : 'send';
    sendBtn.title = halt ? 'Stop Claude (Esc)' : 'Send (Enter)';
    sendBtn.setAttribute('aria-label', halt ? 'stop' : 'send');
    sendBtn.disabled = !t || st.sending || (empty && !halt);
    if (st.drawn.sendIcon !== halt) { sendBtn.innerHTML = halt ? icon('stop', 17) : ic('send', 16); st.drawn.sendIcon = halt; }
  }
  function writeKey(data) {
    const t = termApi();
    if (!t || !hosts.get(st.id)?.alive) return false;
    try { t.write(st.id, data); } catch (e) { err(String(e?.message || e)); return false; }
    keepSession(st.id); // pressing keys in it is typing: a preview session becomes the user's
    return true;
  }
  const stop = () => { writeKey('\x1b'); };
  // Claude Code's "send now" for queued messages: Ctrl+X, then Ctrl+S on its own (a chord)
  const sendNow = (id) => {
    if (id !== st.id || !st.busy || !writeKey('\x18')) return false;
    setTimeout(() => { if (st.id === id) writeKey('\x13'); }, CHORD_MS);
    return true;
  };

  // ----- Unsend and Rewind (see the top) -----
  // the screen's rows as drawn, colour marks dropped (rules and the rows by them fill the width, which screenText joins)
  const screenRows = (id, n) => (hosts.get(id)?.alive ? screenMarked(id, n).map((l) => l.replace(/[\x01\x02]/g, '')) : []);
  const boxNow = (id) => parsePromptBox(screenRows(id, 60));
  const pasteKeys = (id, text) => typeInto(writeKey, cleanText(text));
  // Ctrl+U until the prompt is empty -> true when it is
  async function clearBox(id) {
    for (let i = 0; i < 40; i++) {
      const b = boxNow(id);
      if (!b) return false;
      if (!b.text) return true;
      if (!writeKey('\x15'.repeat(Math.min(b.lines + 1, 30)))) return false;
      await sleep(120);
    }
    return !boxNow(id)?.text;
  }
  let working = false; // one Unsend or Rewind at a time
  // -> true when it left the queue
  async function unsendQueued(id, text, queueOf) {
    if (id !== st.id || working) return false;
    if (!termApi() || !hosts.get(id)?.alive) { err('The session isn\'t running here'); return false; }
    // the others in the transcript's queue (which may lag the send by a moment)
    const want = flat(text);
    let rest = null;
    for (let i = 0; i < 8 && !rest; i++) {
      const q = (queueOf() || []).slice();
      let k = q.findIndex((x) => flat(x) === want);
      if (k < 0 && want) k = q.findIndex((x) => flat(x).includes(want.slice(0, 80)));
      if (k >= 0) { q.splice(k, 1); rest = q; } else await sleep(250);
    }
    if (!rest) { err('It isn\'t queued any more: Claude already took it'); return false; }
    if (st.menu || st.panel) { err('Answer or close what is open in the session first'); return false; }
    const b0 = boxNow(id);
    if (!b0 || b0.text) { err('Something is typed in the session\'s prompt: clear it in the Session tab first'); return false; }
    working = true;
    try {
      if (!writeKey('\x1b[A')) return false;
      let b = null;
      for (let i = 0; i < 10 && !(b && b.text); i++) { await sleep(150); b = boxNow(id); }
      if (!b || !b.text) { err('Couldn\'t take it back: the queue was empty'); return false; }
      if (!(await clearBox(id))) { err('Couldn\'t clear the prompt: the queued messages are in it (Session tab)'); return false; }
      for (const m of rest) {
        if (!m) continue;
        await pasteKeys(id, m);
        await sleep(ENTER_DELAY_MS);
        writeKey('\r');
        await sleep(250);
      }
      return true;
    } finally { working = false; }
  }
  // A session not running here is started first (as Send does), and one mid-turn is stopped first (Esc, as the
  // Stop button does), waiting until it is idle: the rewind never fails just because of either.
  // edit: the text to send in the message's place once Claude Code has restored (Edit in the feed)
  async function rewindTo(id, text, nth, edit = null) {
    if (id !== st.id || working) return;
    if (!termApi()) { err('Rewinding needs the desktop window'); return; }
    if (st.menu) { err('Answer the question above first'); return; }
    working = true;
    st.step = 'Rewinding…'; drawNotes();
    try {
      if (!hosts.get(id)?.alive) {
        if (openElsewhere(st.s)) { err('It is open in another window: end it there, then rewind here'); return; }
        const r = await ensureLive(st.s, { sizeEl: sizeEl(), onStep: (x) => { if (st.id === id) { st.step = x; drawNotes(); } } });
        if (st.id !== id) return;
        st.step = 'Rewinding…'; drawNotes();
        if (!r || !r.ok) { err((r && r.message) || 'Could not start the session to rewind it'); return; }
        for (let i = 0; i < 60 && !screenReady(id); i++) await sleep(150);
      }
      const midTurn = () => hosts.get(id)?.status === 'busy' || !!parseSpinner(screenRows(id, 40))?.strong;
      if (midTurn()) {
        st.step = 'Stopping Claude, then rewinding…'; drawNotes();
        if (!writeKey('\x1b')) return;
        let idle = false;
        for (let i = 0; i < 60 && !idle; i++) { await sleep(250); idle = !midTurn(); }
        if (!idle) { err('Claude didn\'t stop: press Esc in the Session tab, then rewind'); return; }
        await sleep(500); // let the prompt come back before /rewind is typed (two quick Escs open Claude Code's own rewind)
        st.step = 'Rewinding…'; drawNotes();
      }
      if (menuNow(id) && !typesText(menuNow(id))) { err('Claude is asking something: answer it first, then rewind'); return; }
      if (screenReady(id) && !(await closePanel(id))) { err('A panel is open in the session: close it (Esc) first'); return; }
      const b = boxNow(id);
      if (!b || b.text) { err('Something is typed in the session\'s prompt: clear it first'); return; }
      if (growRows(id, REWIND_ROWS)) await sleep(600); // the pty takes the new size and Claude Code redraws
      await pasteKeys(id, '/rewind');
      await sleep(ENTER_DELAY_MS);
      writeKey('\r');
      let r = null;
      for (let i = 0; i < 20 && !r; i++) { await sleep(150); r = parseRewind(screenRows(id, PANEL_LINES)); }
      if (!r) { err('/rewind didn\'t open its list'); return; }
      let seen = 0, last = r.sig;
      for (let i = 0; i < 500; i++) {
        if (!writeKey('\x1b[A')) return;
        let n = null;
        for (let j = 0; j < 8; j++) { await sleep(60); n = parseRewind(screenRows(id, PANEL_LINES)); if (!n || n.sig !== last) break; }
        if (!n) { err('The /rewind list closed'); return; }
        if (n.sig === last) break; // the top, and it wasn't there
        last = n.sig;
        if (rewindMatches(n.sel, text) && seen++ === nth) {
          writeKey('\r');
          st.rewound = { id, text, at: Date.now(), edit: edit || null, sawMenu: false, emptyAt: 0 };
          return;
        }
      }
      writeKey('\x1b');
      err('That message isn\'t in /rewind\'s list');
    } finally { working = false; st.step = ''; drawNotes(); }
  }
  // after the restore Claude Code puts the message back in its prompt: it moves to this box, to edit and resend
  async function takeRewound() {
    const r = st.rewound;
    if (!r || r.id !== st.id || working) return;
    const box = boxNow(r.id);
    if (!box) return;
    if (Date.now() - r.at > 120000) { st.rewound = null; if (r.edit) putBack(r.edit); return; }
    if (!box.text) {
      // an Edit whose restore left the conversation as it was ("Restore code" only, or "Never mind"): the prompt
      // stays empty once the restore menu is gone, and the edited text waits in this box instead of going in
      if (r.edit && r.sawMenu) {
        if (!r.emptyAt) r.emptyAt = Date.now();
        else if (Date.now() - r.emptyAt > 1500) { st.rewound = null; putBack(r.edit); }
      }
      return;
    }
    st.rewound = null;
    working = true;
    try { if (!(await clearBox(r.id))) return; } finally { working = false; }
    if (st.id !== r.id) return;
    if (r.edit) { send(r.edit); return; }
    if (ta.value.trim()) return;
    ta.value = r.text;
    saveDraftSoon(); grow(); drawSend();
    ta.focus();
    ta.setSelectionRange(r.text.length, r.text.length);
  }

  // an edited message that didn't go in: into the box (after what is typed there already), to send or drop
  function putBack(text) {
    ta.value = ta.value.trim() ? `${ta.value.replace(/\s+$/, '')}\n\n${text}` : text;
    saveDraftSoon(); grow(); drawSend();
  }

  // a menu on the live screen now, not the one the last poll saw (it is up to 400 ms old)
  const menuNow = (id) => (hosts.get(id)?.alive ? parseMenu(screenText(id, 40, { rows: true })) : null);
  // a command's panel on the live screen now, and closing it: Esc until it is gone (one with a search box takes
  // two: the first clears the search). -> true when none is up
  const panelNow = (id) => (hosts.get(id)?.alive ? parsePanel(screenMarked(id, PANEL_LINES)) : null);
  async function closePanel(id) {
    const t = termApi();
    for (let i = 0; i < 3 && panelNow(id); i++) {
      try { t.write(id, '\x1b'); } catch { return false; }
      await sleep(PANEL_STEP_MS);
    }
    return !panelNow(id);
  }
  const typesText = (m) => { const on = m && m.options.find((o) => o.on); return !!on && /^(type something|other\b|chat about this)/i.test(on.label); };

  // what the box holds, or (cmd) a command the model picker sends; the draft stays as it is then. In bash mode the
  // box holds a shell command: a typed "!" goes first (see the top), and only the command goes.
  // -> true when it went in
  async function send(cmd = null) {
    const t = termApi();
    if (!t || st.sending) return false;
    const fromBox = cmd == null;
    // the mic is on or still writing out: stop listening, and send once every word said is in the box
    if (fromBox && (st.dict || st.drain)) {
      if (st.dict) stopDictation(true);
      if (st.dict || st.drain) { st.sendAfter = true; drawNotes(); drawSend(); return false; }
    }
    const shell = fromBox && !!st.d.shell;
    const raw = fromBox ? ta.value : cmd;
    const quote = fromBox && !shell ? st.d.quote : '';
    // the quote's "> " lines, a blank line, then what was typed (chat.js shows the quote as its own block)
    let text = cleanText(quote ? `${quote}\n${raw.replace(/^\n+/, '')}` : raw);
    const list = fromBox && !shell ? st.d.atts.slice() : [];
    if (shell && !text.trim()) return false;
    if (!text.trim() && !list.length) return false;
    if (fromBox) stopDictation(false);
    shutSlash();
    const id = st.id, s0 = st.s;
    // a menu is up: typed text would land in it (a digit picks an option); "Type something" takes text, though
    if (st.menu && hosts.get(id)?.alive) {
      const on = st.menu.options.find((o) => o.on);
      if (!on || !/^(type something|other\b|chat about this)/i.test(on.label)) { err('Answer the question above first (or press Esc)'); return; }
    }
    // a terminal elsewhere has it open: a second copy runs only when asked twice
    if (!hosts.has(id) && openElsewhere(s0) && Date.now() - st.elsewhereAt > ELSEWHERE_CONFIRM_MS) {
      st.elsewhereAt = Date.now();
      err('Send again to open a second copy here');
      return;
    }
    st.sending = true;
    st.errs = [];
    drawSend(); drawNotes();
    try {
      // the images first: a failed upload keeps the whole draft
      const paths = [];
      for (const a of list) {
        try { paths.push(await uploadImage(a)); } catch (e) { err(`Couldn't upload ${a.name}: ${e?.message || e}`); return; }
      }
      if (!shell && /(^|\s)\/[^\s/]/.test(text)) text = hoistCommand(text, (await commandsFor(s0.cwd)).map((c) => c.name));
      const msg = messageText(text, paths);
      if (!msg) return;
      const r = await ensureLive(s0, { sizeEl: sizeEl(), onStep: (x) => { if (st.id === id) { st.step = x; drawNotes(); } } });
      if (st.id === id) { st.step = ''; drawNotes(); }
      if (!r.ok) { err(r.message || 'could not start the session'); return; }
      // a permission prompt may have come up since: the text would land in it and Enter would pick an option
      const blocked = () => { const m = menuNow(id); return m && !typesText(m); };
      if (blocked()) { err('Claude is asking something: answer it first, then send'); return; }
      // a command's panel is up: the text would land in it, so it closes first. Read from the screen; while the
      // screen can't be read yet, from the host's list (then only a panel a "/" command opened). Never both: two
      // quick Escs at Claude Code's prompt open its rewind menu.
      if (screenReady(id)) {
        if (!(await closePanel(id))) { err('A panel is open in the session: close it (Esc), then send'); return; }
      } else {
        const why = await closeHostPanel(id);
        if (why) { err(why); return; }
      }
      if (shell) {
        // bash mode: "!" as a key of its own into an empty prompt (a "!" after text, or a pasted one, is just text)
        const b = screenReady(id) ? boxNow(id) : null;
        if (b && b.text) { err('Something is typed in the session\'s prompt: clear it in the Session tab first'); return; }
        t.write(id, '!');
        await sleep(BANG_MS);
      }
      await typeInto((w) => t.write(id, w), msg.replace(/\r\n?/g, '\n'));
      await sleep(ENTER_DELAY_MS);
      if (blocked()) { err('A question came up before Enter: the text is in Claude\'s prompt, not sent'); return; }
      t.write(id, '\r');
      keepSession(id);
      // a command: the panel it opens shows here (see tick)
      const cmdName = shell ? null : /^\/[^\s/]+/.exec(msg)?.[0];
      if (cmdName && st.id === id) { st.cmdAt = Date.now(); st.cmd = cmdName; }
      // the feed shows it now; the transcript has it a moment later (later still while Claude is mid-turn)
      const shots = list.filter((a) => !a.file).map((a) => { try { return URL.createObjectURL(a.blob); } catch { return null; } }).filter(Boolean);
      // a file's path stays in the message as text (an image's becomes [Image #N]), so the bubble shows it too
      const shown = shell ? `!${msg}` : messageText(text, list.filter((a) => a.file).map((a) => a.path));
      pane.dispatchEvent(new CustomEvent('fv-chat-sent', { detail: { id, text: shown, images: shots, busy: st.busy } }));
      rememberSent(id, shown);
      if (!fromBox) return true;
      // sent: the draft goes (what was typed meanwhile stays); a bash command leaves bash mode, as Claude Code's prompt does
      const d = drafts.get(id) || st.d;
      if (shell) { d.shell = false; storeShell(id, false); if (st.id === id) drawShell(); }
      for (const a of list) { dropAtt(a); const i = d.atts.indexOf(a); if (i >= 0) d.atts.splice(i, 1); }
      d.text = d.text.startsWith(raw) ? d.text.slice(raw.length).replace(/^\s+/, '') : d.text;
      storeText(id, d.text);
      if (d.quote === quote) { d.quote = ''; storeQuote(id, ''); }
      if (st.id === id) { ta.value = d.text; grow(); drawAtts(); drawQuote(); }
      return true;
    } catch (e) {
      err(`Couldn't send: ${e?.message || e}`);
    } finally {
      st.sending = false;
      st.step = '';
      drawSend(); drawNotes();
    }
  }

  // ----- ↑ / ↓: past messages -----
  // ↑ with the box empty or the caret at its start (while showing a past one: on its first line) goes back one;
  // ↓ with the caret on the last line goes forward, and past the newest back to what was typed. -> handled
  function recall(by) {
    if (ta.selectionStart !== ta.selectionEnd) return false;
    const v = ta.value, at = ta.selectionStart;
    const browsing = !!st.hist && v === st.hist.shown;
    if (!browsing) st.hist = null;
    if (by < 0 ? !(browsing ? !v.slice(0, at).includes('\n') : !v || at === 0) : !(browsing && !v.slice(at).includes('\n'))) return false;
    if (!st.hist) {
      const c = pane._chat;
      const list = pastMessages(c && c.id === st.id ? c.items : [], sentTexts.get(st.id));
      if (!list.length) return false;
      st.hist = { list, i: list.length, draft: v, draftShell: !!st.d.shell, shown: null };
    }
    const h = st.hist, i = h.i + by;
    if (i < 0) return true; // the oldest already: stay on it
    let next;
    if (i >= h.list.length) { next = h.draft; setShell(h.draftShell); st.hist = null; } else {
      h.i = i;
      // a past bash command ("!ls") comes back in bash mode
      const bang = /^!\S/.test(h.list[i]);
      setShell(bang);
      next = h.shown = bang ? h.list[i].slice(1) : h.list[i];
    }
    ta.value = next;
    shutSlash();
    st.slash.shut = next; // a past "/command" doesn't open the list
    saveDraftSoon(); grow(); drawSend();
    ta.setSelectionRange(next.length, next.length);
    ta.scrollTop = ta.scrollHeight;
    return true;
  }

  // ----- Ctrl+R: search your past messages (the list ↑ goes through), newest first -----
  let inserting = false; // the box's text is being put in by the page, not typed
  function openSearch() {
    if (ta.disabled) return;
    const c = pane._chat;
    shutSlash();
    st.hs = { list: pastMessages(c && c.id === st.id ? c.items : [], sentTexts.get(st.id)), rows: [], sel: 0 };
    hsIn.value = '';
    hsEl.hidden = false;
    drawSearch();
    hsIn.focus();
  }
  function shutSearch(focus = true) {
    if (!st.hs) return;
    st.hs = null;
    hsEl.hidden = true;
    if (focus) ta.focus();
  }
  function drawSearch() {
    const h = st.hs;
    if (!h) return;
    h.rows = searchPast(h.list, hsIn.value);
    h.sel = Math.max(0, Math.min(h.sel, h.rows.length - 1));
    hsN.textContent = h.list.length ? `${h.rows.length}${h.rows.length >= HS_MAX ? '+' : ''} of ${h.list.length}` : '';
    hsList.innerHTML = h.rows.length
      ? h.rows.map((t, i) => `<button type="button" role="option" class="cmp-hs-r${i === h.sel ? ' on' : ''}${/^!\S/.test(t) ? ' bash' : ''}" data-hs="${i}" tabindex="-1" aria-selected="${i === h.sel}">${esc(t.replace(/\s+/g, ' ').slice(0, 300))}</button>`).join('')
      : `<div class="cmp-hs-none">${h.list.length ? 'No message has that' : 'No messages in this conversation yet'}</div>`;
    hsList.querySelector('.cmp-hs-r.on')?.scrollIntoView({ block: 'nearest' });
  }
  function moveSearch(by) {
    const h = st.hs;
    if (!h || !h.rows.length) return;
    h.sel = (h.sel + by + h.rows.length) % h.rows.length;
    for (const b of hsList.querySelectorAll('.cmp-hs-r')) {
      const on = +b.dataset.hs === h.sel;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
    }
    hsList.querySelector('.cmp-hs-r.on')?.scrollIntoView({ block: 'nearest' });
  }
  // the picked one replaces what is in the box (as in the terminal); Ctrl+Z brings that back
  function pickSearch(i) {
    const t = st.hs?.rows[i];
    if (t == null) return;
    shutSearch(false);
    const bang = /^!\S/.test(t), v = bang ? t.slice(1) : t;
    setShell(bang);
    st.hist = null;
    st.slash.shut = v; // a past "/command" doesn't open the list
    ta.focus();
    ta.select();
    let ok = false;
    inserting = true;
    try { ok = document.execCommand('insertText', false, v); } catch {} finally { inserting = false; }
    if (!ok || ta.value !== v) ta.value = v;
    saveDraftSoon(); grow(); drawSend();
    ta.setSelectionRange(v.length, v.length);
    ta.scrollTop = ta.scrollHeight;
  }
  hsIn.addEventListener('input', () => { if (st.hs) { st.hs.sel = 0; drawSearch(); } });
  hsIn.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); moveSearch(e.key === 'ArrowDown' ? 1 : -1); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickSearch(st.hs?.sel ?? 0); }
    else if (e.key === 'Escape') { e.preventDefault(); shutSearch(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r') { e.preventDefault(); moveSearch(1); } // again: the next one, as in the terminal
  });
  hsIn.addEventListener('blur', () => setTimeout(() => { if (st.hs && !hsEl.contains(document.activeElement)) shutSearch(false); }, 150));
  hsList.addEventListener('pointerdown', (e) => e.preventDefault()); // the search box keeps the focus
  const hsX = hsEl.querySelector('.cmp-hs-x');
  hsX.addEventListener('pointerdown', (e) => e.preventDefault());
  hsX.addEventListener('click', (e) => { e.stopPropagation(); shutSearch(); });
  hsList.addEventListener('click', (e) => { const b = e.target.closest('[data-hs]'); if (b) pickSearch(+b.dataset.hs); });

  // ----- the menu card -----
  function drawCard() {
    const m = st.menu;
    card.hidden = !m;
    if (!m) { st.drawn.card = ''; return; }
    const sent = st.answeredSig === m.sig && Date.now() - st.answeredAt < 1500;
    const key = `${m.sig}|${m.context.join('\n')}|${sent}`;
    if (st.drawn.card === key) return;
    st.drawn.card = key;
    const ctx = m.context.length ? `<pre class="cmp-ctx">${esc(m.context.join('\n'))}${m.more ? '\n…' : ''}</pre>` : '';
    const opts = m.options.map((o) => {
      const label = esc(o.label).replace(/\s*\((esc|shift\+tab)\)$/i, ' <span class="cmp-k">($1)</span>');
      return `<button type="button" class="cmp-opt${o.on ? ' on' : ''}" data-n="${o.n}"${sent ? ' disabled' : ''}${o.on ? ' aria-current="true"' : ''}>`
        + `<span class="cmp-n">${o.n}</span><span class="cmp-l">${label}${o.desc ? `<small>${esc(o.desc)}</small>` : ''}</span></button>`;
    }).join('');
    card.innerHTML = `<div class="cmp-card-h"><span class="cmp-shield">${ic('shield', 16)}</span><span class="cmp-card-t">${esc(m.title || 'Claude is asking')}</span></div>`
      + ctx + `<div class="cmp-opts">${opts}</div>`
      + `<div class="cmp-card-f"><button type="button" class="cmp-esc" data-c="esc"${sent ? ' disabled' : ''}>Esc</button><span class="cmp-card-hint">or press 1–${Math.min(9, m.options[m.options.length - 1].n)} here</span></div>`;
  }
  function answer(n) {
    const m = st.menu;
    if (!m || !m.options.some((o) => o.n === n)) return;
    if (st.answeredSig === m.sig && Date.now() - st.answeredAt < 1500) return; // one click, one answer
    // the same question still on screen (a new prompt may have replaced it since the last poll)
    const now = menuNow(st.id);
    if (!now || now.sig !== m.sig) { st.menu = now; drawCard(); return; }
    if (!writeKey(String(n))) return;
    st.answeredSig = m.sig; st.answeredAt = Date.now();
    drawCard();
  }

  // ----- a command's panel: what Claude Code shows for /usage, /status, /config, /mcp…, and its keys -----
  // The panel as the session draws it, as text (its bars in colour), with its tabs; the keycaps (and the keyboard,
  // while the card has the focus) press the same keys in the session. A tab click presses Tab until it is on.
  const BAR_RE = /[█▉▊▋▌▍▎▏]+/g;
  function drawPanel() {
    const p = st.panel;
    panelEl.hidden = !p;
    if (!p) { st.drawn.panel = ''; return; }
    if (st.drawn.panel === p.sig) return;
    st.drawn.panel = p.sig;
    const name = st.panelOwned && st.cmd ? st.cmd : '';
    const title = p.title || name || 'Panel';
    const tabs = p.tabs.length ? `<div class="cmp-pnl-tabs" role="tablist">${p.tabs.map((t, i) => `<button type="button" role="tab" class="cmp-pnl-tab${t.on ? ' on' : ''}" data-ptab="${i}" aria-selected="${t.on}" tabindex="-1">${esc(t.label)}</button>`).join('')}</div>` : '';
    const body = p.body.map((l) => esc(l).replace(BAR_RE, (b) => `<span class="cmp-pnl-bar">${b}</span>`)).join('\n');
    const caps = ['up', 'down', 'left', 'right', ...(p.tabs.length ? ['tab'] : []), 'enter', 'esc']
      .map((k) => `<button type="button" class="cmp-pk${k === 'esc' ? ' esc' : ''}" data-pk="${k}" title="${esc(PANEL_KEYS[k][2])}" tabindex="-1">${esc(PANEL_KEYS[k][0])}</button>`).join('');
    panelEl.innerHTML = `<div class="cmp-pnl-h"><span class="cmp-pnl-t">${esc(title)}</span>${name && name !== title ? `<span class="cmp-pnl-cmd mono">${esc(name)}</span>` : ''}`
      + `<span class="grow"></span><button type="button" class="cmp-pnl-x" data-pk="esc" title="Close (Esc)" aria-label="close" tabindex="-1">${icon('close', 12)}</button></div>`
      + tabs + (body.trim() ? `<pre class="cmp-pnl-b">${body}</pre>` : '')
      + `<div class="cmp-pnl-f"><span class="cmp-pnl-keys">${caps}</span>${p.keys ? `<span class="cmp-card-hint">${esc(p.keys)}</span>` : ''}</div>`;
  }
  function panelKey(k) {
    const def = PANEL_KEYS[k];
    if (def && st.panel) writeKey(def[1]);
  }
  // a tab click: Tab until that one is on (the panel cycles through them; the last read says which is on now)
  async function panelTab(i) {
    const p = st.panel, id = st.id;
    if (!p || !p.tabs[i] || st.panelTabbing) return;
    const cur = p.tabs.findIndex((t) => t.on);
    if (cur < 0 || cur === i) return;
    st.panelTabbing = true;
    try {
      for (let n = (i - cur + p.tabs.length) % p.tabs.length; n > 0 && st.id === id; n--) {
        if (!writeKey('\t')) break;
        await sleep(90);
      }
    } finally { st.panelTabbing = false; }
  }
  // the keyboard on the card: the keys the session's panel reads, typed letters too (a search box takes them)
  function panelKeydown(e) {
    if (e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return;
    const named = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Enter: 'enter', Escape: 'esc' }[e.key];
    let data = named ? PANEL_KEYS[named][1] : null;
    if (e.key === 'Tab') data = e.shiftKey ? '\x1b[Z' : '\t';
    else if (e.key === 'Backspace') data = '\x7f';
    else if (!data && e.key.length === 1) data = e.key;
    if (data == null) return;
    e.preventDefault(); e.stopPropagation();
    writeKey(data);
  }

  // ----- the mode picker -----
  function drawMode() {
    const alive = !!hosts.get(st.id)?.alive;
    const label = alive && st.mode ? modeShort(st.mode) : 'Mode';
    const key = `${label}|${alive}|${st.switching}|${st.mode}|${!!(st.menu || st.panel)}`;
    if (st.drawn.mode === key) return;
    st.drawn.mode = key;
    modeBtn.querySelector('.cmp-model-t').textContent = label;
    // not while Claude asks something: Shift+Tab there answers it ("allow all edits during this session")
    modeBtn.disabled = !alive || st.switching || !!st.menu || !!st.panel;
    modeBtn.dataset.cur = st.mode || '';
    modeBtn.title = alive ? 'Permission mode (Shift+Tab in the session)' : 'The mode shows once the session runs here';
    modeMenu.innerHTML = MODES.map((m) => `<button type="button" role="menuitemradio" class="cmp-mi${m.k === st.mode ? ' on' : ''}" data-mode="${m.k}" aria-checked="${m.k === st.mode}">`
      + `<span class="cmp-mi-c">${m.k === st.mode ? ic('check', 13) : ''}</span><span>${esc(m.label)}</span></button>`).join('');
  }
  function openModeMenu(open) {
    modeMenu.hidden = !open;
    modeBtn.setAttribute('aria-expanded', String(open));
    if (open) (modeMenu.querySelector('.cmp-mi.on') || modeMenu.querySelector('.cmp-mi'))?.focus();
  }
  async function switchMode(want) {
    openModeMenu(false);
    const id = st.id;
    if (st.switching || !hosts.get(id)?.alive) return;
    const read = () => parseMode(screenText(id, 40));
    // only from a mode it can read, and never over a question (Shift+Tab would answer it)
    const from = read();
    if (from === want) return;
    if (!from || menuNow(id)) { err(menuNow(id) ? 'Answer the question first, then switch modes' : 'Couldn\'t read the current mode yet'); return; }
    st.switching = true;
    drawMode(); drawNotes();
    let now = from, ok = false;
    try {
      for (let i = 0; i < MODE_MAX_PRESSES; i++) {
        if (menuNow(id) || !writeKey('\x1b[Z')) break;
        await sleep(MODE_STEP_MS);
        now = read() || now;
        if (now === want) { ok = true; break; }
        if (from && now === from) break; // round the whole cycle without it
      }
    } finally {
      st.switching = false;
      if (st.id === id) {
        if (now) st.mode = now;
        if (!ok) err(`Couldn't switch to ${MODES.find((m) => m.k === want)?.label || want}${want === 'bypass' ? ' (only a session started with it has it)' : ''}`);
        st.drawn.mode = null;
        drawMode(); drawNotes();
      }
    }
  }

  // ----- the list above the box: "/" commands while the caret ends a "/<name>" at the start of the box or after a
  // space (one mid-sentence moves to the front when sent, see hoistCommand), or the conversation's files and folders after an "@" at the caret (GET /chat/files). Picking a file puts
  // "@path " in its place, which Claude Code reads as a mention when the message goes in; a folder puts "@path/"
  // and the list stays open on what is inside it. -----
  // the "/<name>" the caret ends: { q, at } (at: where the "/" is), or null
  const slashQuery = () => {
    if (ta.selectionStart !== ta.selectionEnd || /^\S/.test(ta.value.slice(ta.selectionStart))) return null;
    const m = /(^|\s)\/([^\s/]*)$/.exec(ta.value.slice(0, ta.selectionStart));
    return m ? { q: m[2], at: m.index + m[1].length } : null;
  };
  // the "@<text>" the caret is in: { q, at } (at: where the "@" is), or null
  const mentionQuery = () => {
    if (ta.selectionStart !== ta.selectionEnd) return null;
    const m = /(^|\s)@([^\s@"]*)$/.exec(ta.value.slice(0, ta.selectionStart));
    return m ? { q: m[2], at: m.index + m[1].length } : null;
  };
  function shutSlash() {
    const sl = st.slash;
    if (!sl.open) return;
    sl.open = false; sl.items = [];
    slashEl.hidden = true;
    ta.removeAttribute('aria-activedescendant');
  }
  async function drawSlash() {
    const sl = st.slash, cmd = slashQuery(), at = cmd == null ? mentionQuery() : null;
    const q = cmd != null ? `/${cmd.q}` : at ? `@${at.q}` : null;
    // no list in bash mode: a shell command's "/" and "@" are its own
    if (q == null || ta.disabled || st.d.shell || sl.shut === ta.value) { sl.q = null; shutSlash(); return; }
    const seq = ++sl.seq;
    const items = cmd != null ? matchCommands(await commandsFor(st.s.cwd), cmd.q) : await filesFor(st.s.cwd, at.q);
    const now = slashQuery(), nowAt = now == null ? mentionQuery() : null;
    if (seq !== sl.seq || (now != null ? `/${now.q}` : nowAt ? `@${nowAt.q}` : null) !== q) return; // typed on meanwhile
    if (!items.length) { shutSlash(); return; }
    if (sl.q !== q) sl.sel = 0;
    sl.q = q; sl.items = items; sl.open = true; sl.kind = cmd != null ? 'cmd' : 'file'; sl.at = (cmd || at).at;
    sl.sel = Math.min(sl.sel, items.length - 1);
    slashEl.setAttribute('aria-label', sl.kind === 'cmd' ? 'slash commands' : 'files');
    slashEl.innerHTML = items.map((c, i) => `<button type="button" role="option" id="cmp-sl-${i}" class="cmp-sl${sl.kind === 'file' ? ' cmp-slf' : ''}${i === sl.sel ? ' on' : ''}" data-sl="${i}" tabindex="-1" aria-selected="${i === sl.sel}">`
      + (sl.kind === 'cmd'
        ? `<span class="cmp-sl-n mono">/${esc(c.name)}</span>${c.hint ? `<span class="cmp-sl-h mono">${esc(c.hint)}</span>` : ''}<span class="cmp-sl-d">${esc(c.desc || '')}</span>`
        : `<span class="cmp-sl-i">${icon(c.dir ? 'folder' : 'file', 13)}</span><span class="cmp-sl-n mono">${esc(baseName(c.path))}${c.dir ? '/' : ''}</span><span class="cmp-sl-d mono">${esc(c.path)}</span>`)
      + '</button>').join('');
    slashEl.hidden = false;
    ta.setAttribute('aria-activedescendant', `cmp-sl-${sl.sel}`);
    slashEl.querySelector('.cmp-sl.on')?.scrollIntoView({ block: 'nearest' });
  }
  function moveSlash(by) {
    const sl = st.slash;
    if (!sl.open) return;
    sl.sel = (sl.sel + by + sl.items.length) % sl.items.length;
    for (const b of slashEl.querySelectorAll('.cmp-sl')) {
      const on = +b.dataset.sl === sl.sel;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
    }
    ta.setAttribute('aria-activedescendant', `cmp-sl-${sl.sel}`);
    slashEl.querySelector('.cmp-sl.on')?.scrollIntoView({ block: 'nearest' });
  }
  // a command: Tab and Enter put "/<name> " in place of the "/<text>", so more words can follow; Enter (run) sends
  // at once only a built-in that takes nothing (/context, /clear) alone in the box. A file or folder: Tab and Enter
  // both put it in place of the "@<text>"
  function pickSlash(i, run) {
    const sl = st.slash, c = sl.items[i];
    if (!c) return;
    if (sl.kind === 'file') {
      const end = ta.selectionStart, ref = mentionRef(c.path, c.dir);
      ta.value = ta.value.slice(0, sl.at) + ref + ta.value.slice(end);
      const caret = sl.at + ref.length;
      shutSlash();
      saveDraftSoon(); grow(); drawSend();
      ta.focus();
      ta.setSelectionRange(caret, caret);
      if (c.dir) drawSlash(); // on into the folder
      return;
    }
    const after = ta.value.slice(ta.selectionStart), spaced = /^\s/.test(after);
    const now = run && c.src === 'built-in' && !c.hint && !ta.value.slice(0, sl.at).trim() && !after.trim();
    const ins = now || spaced ? `/${c.name}` : `/${c.name} `;
    ta.value = ta.value.slice(0, sl.at) + ins + after;
    const caret = sl.at + ins.length + (spaced ? 1 : 0);
    shutSlash();
    saveDraftSoon(); grow(); drawSend();
    ta.focus();
    ta.setSelectionRange(caret, caret);
    if (now) send();
  }

  // ----- the model and effort picker -----
  // what the session runs: the screen's effort when it shows, else the last reply's; what was picked here wins
  // until the session shows it (the model shows with the next reply) or 10 minutes pass
  function current() {
    const s = st.s, big = !!(s.context && s.context.limit >= 1000000);
    let model = modelKey(s.model, big), effort = st.effort || s.effort || null;
    const w = st.want;
    if (w && Date.now() - w.at > 10 * 60e3) st.want = null;
    else if (w) {
      if (w.model && s.model !== w.from) w.model = null; // a reply named the model it runs now
      if (w.effort && (st.effort || s.effort) === w.effort) w.effort = null;
      if (w.model) model = w.model;
      if (w.effort) effort = w.effort;
      if (!w.model && !w.effort) st.want = null;
    }
    return { model, effort };
  }
  function drawModel() {
    const t = termApi();
    const { model, effort } = current();
    const name = model ? modelLabel(model, true) : 'Model';
    const label = effort ? `${name} · ${effort}` : name;
    const key = `${label}|${model}|${effort}|${!!t}|${!!(st.menu || st.panel)}|${st.sending}`;
    if (st.drawn.model === key) return;
    st.drawn.model = key;
    modelBtn.querySelector('.cmp-model-t').textContent = label;
    modelBtn.disabled = !t || !!st.menu || !!st.panel || st.sending;
    modelBtn.title = !t ? 'Changing the model needs the desktop window' : `Model and effort${st.s.model ? ` (now ${st.s.model}${effort ? `, ${effort} effort` : ''})` : ''}`;
    const item = (k, label, on, attr) => `<button type="button" role="menuitemradio" class="cmp-mi${on ? ' on' : ''}" ${attr}="${esc(k)}" aria-checked="${on}">`
      + `<span class="cmp-mi-c">${on ? ic('check', 13) : ''}</span><span>${esc(label)}</span></button>`;
    // the one it runs comes first in the list when it isn't one of the newest (an older version)
    const ids = model && !MODEL_IDS.includes(model) ? [model, ...MODEL_IDS] : MODEL_IDS;
    modelMenu.innerHTML = '<div class="cmp-mh">Model</div>' + ids.map((k) => item(k, modelLabel(k), k === model, 'data-model')).join('')
      + '<div class="cmp-msep" role="separator"></div><div class="cmp-mh">Effort</div>' + EFFORTS.map((e) => item(e, e === 'xhigh' ? 'Extra high' : e[0].toUpperCase() + e.slice(1), e === effort, 'data-effort')).join('')
      + '<div class="cmp-mnote">Also becomes the default for new sessions</div>';
  }
  function openModelMenu(open) {
    modelMenu.hidden = !open;
    modelBtn.setAttribute('aria-expanded', String(open));
    if (open) (modelMenu.querySelector('.cmp-mi.on') || modelMenu.querySelector('.cmp-mi'))?.focus();
  }
  async function pickModel(kind, v) {
    openModelMenu(false);
    const from = st.s.model || null;
    if (!(await send(kind === 'model' ? `/model ${v}` : `/effort ${v}`))) return;
    st.want = { ...(st.want || {}), [kind]: v, from, at: Date.now() };
    st.drawn.model = null;
    drawModel();
  }

  // ----- Remote Control -----
  // the screen's word, when it gives one, becomes what the box remembers (a switch made in the Session tab too)
  function readRemote(lines) {
    if (!lines.length) return;
    const r = parseRemote(lines);
    let on = null;
    if (r.last === 'disconnected') on = false;
    else if (st.rcSeen != null && r.active > st.rcSeen) on = true;
    if (r.header) on = r.header !== 'off';
    st.rcSeen = r.active;
    st.rcConnecting = r.header === 'connecting';
    // a click's result shows a moment later: until then the screen's old word doesn't undo it
    if (on != null && !st.rcBusy && Date.now() > st.rcHold && on !== rcStored(st.id)) rcStore(st.id, on);
  }
  function drawRemote() {
    const t = termApi(), on = rcStored(st.id);
    const cur = !on ? 'off' : st.rcConnecting ? 'connecting' : 'on';
    const key = `${cur}|${!!t}|${st.rcBusy}|${st.sending}|${!!(st.menu || st.panel)}`;
    if (st.drawn.rc === key) return;
    st.drawn.rc = key;
    rcBtn.dataset.cur = cur;
    rcBtn.setAttribute('aria-pressed', String(on));
    // just the phone icon: off is dim, on lights up mint, connecting gold; the word is in the label and tooltip
    rcBtn.setAttribute('aria-label', st.rcBusy ? 'Remote Control: switching' : cur === 'off' ? 'Remote Control: off' : cur === 'on' ? 'Remote Control: on' : 'Remote Control: connecting');
    rcBtn.disabled = !t || st.rcBusy || st.sending || !!st.menu || !!st.panel;
    rcBtn.title = !t ? 'Remote Control needs the desktop window'
      : cur === 'connecting' ? 'Remote Control is connecting. Click to turn it off'
      : on ? 'Remote Control is on: the Claude phone app and claude.ai/code can see and drive this session. Click to turn it off'
        : 'Remote Control is off. Click to let the Claude phone app and claude.ai/code see and drive this session (off again when the session restarts)';
  }
  async function toggleRemote() {
    const id = st.id;
    if (st.rcBusy || st.sending) return;
    const on = rcStored(id);
    st.rcBusy = true;
    drawRemote();
    const here = () => st.alive && st.id === id && !!hosts.get(id)?.alive;
    const screen = () => screenText(id, 40);
    try {
      if (!on) {
        if (await send('/remote-control')) rcStore(id, true);
        return;
      }
      // /remote-control while it is on opens its menu (Disconnect this session, Show QR code, Continue)
      for (let round = 0; round < 2; round++) {
        if (!(await send('/remote-control'))) return;
        let up = false;
        for (let w = 0; w < 20 && here() && !(up = rcMenuUp(screen())); w++) await sleep(200);
        if (!here()) return;
        if (!up) continue; // it was off after all, and that turned it on: once more brings up the menu
        for (let i = 0; i < 4 && here() && !rcOnDisconnect(screen()); i++) { writeKey('\x1b[A'); await sleep(200); }
        if (!here()) return;
        if (!rcOnDisconnect(screen())) { writeKey('\x1b'); err('Couldn\'t pick Disconnect in the Remote Control menu'); return; }
        writeKey('\r');
        rcStore(id, false);
        return;
      }
      err('Couldn\'t turn Remote Control off: its menu didn\'t come up');
    } finally {
      st.rcBusy = false;
      st.rcHold = Date.now() + 3000;
      if (st.id === id) { st.drawn.rc = null; drawRemote(); drawNotes(); }
    }
  }

  // ----- the activity line -----
  function drawAct(spin) {
    act.hidden = !st.busy;
    if (!st.busy) return;
    const verb = spin ? `${spin.verb}…` : 'Working…';
    const det = spin && spin.detail ? `(${spin.detail})` : '';
    const key = `${verb}|${det}|${st.bgHint}`;
    if (st.drawn.act === key) return;
    st.drawn.act = key;
    act.querySelector('.cmp-verb').textContent = verb;
    act.querySelector('.cmp-det').textContent = det;
    bgBtn.hidden = !st.bgHint;
  }
  // Ctrl+B: the shell command Claude runs goes on in the background (only while the screen offers it)
  function runInBackground() {
    if (!st.bgHint || !writeKey('\x02')) return false;
    st.bgHint = false;
    st.drawn.act = null;
    bgBtn.hidden = true;
    return true;
  }
  // Ctrl+B anywhere in the Chat tab (before the chat box's own keys)
  const onPaneKey = (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'b' && st.bgHint) {
      e.preventDefault(); e.stopPropagation();
      runInBackground();
    }
  };

  // ----- every 400 ms: read the screen -----
  const shown = () => slot.isConnected && slot.getClientRects().length > 0;
  function tick() {
    if (!st.alive) return;
    const h = hosts.get(st.id);
    const alive = !!(termApi() && h?.alive);
    let lines = [];
    if (alive && shown()) lines = screenText(st.id, PANEL_LINES, { sizeEl: sizeEl() });
    // a command's panel (only when its top edge is on screen: reading the colours costs more)
    const loose = !!st.panel || Date.now() - st.cmdAt < PANEL_OWN_MS;
    let panel = alive && lines.some((l) => /▔{12}/.test(l)) ? parsePanel(screenMarked(st.id, PANEL_LINES), { loose }) : null;
    lines = lines.slice(-40);
    const spin = parseSpinner(lines);
    let menu = alive && lines.length ? parseMenu(screenText(st.id, 40, { rows: true })) : null;
    // the one a "/command" sent from here opened is that command's, numbered list or not (/model); else a numbered
    // menu is a question Claude asks (a permission prompt), which the menu card answers
    const owned = !!panel && (st.panelOwned || Date.now() - st.cmdAt < PANEL_OWN_MS);
    if (panel && menu && !owned) panel = null;
    else if (panel) menu = null;
    if (owned && !st.panelOwned) pane.dispatchEvent(new CustomEvent('fv-chat-panel', { detail: { id: st.id, cmd: st.cmd } }));
    st.panelOwned = owned;
    const had = !!st.panel;
    st.panel = panel;
    const focus = panel && !had && document.activeElement === ta && !ta.value.trim() ? panelEl // the command just sent: its keys go to it
      : !panel && had && panelEl.contains(document.activeElement) ? ta : null;
    const mode = alive ? parseMode(lines) : null;
    if (mode) st.mode = mode;
    else if (!alive) st.mode = null;
    const effort = alive ? parseEffort(lines) : null;
    if (effort) st.effort = effort;
    else if (!alive) st.effort = null;
    if (alive) readRemote(lines);
    else { st.rcSeen = null; st.rcConnecting = false; }
    st.busy = alive && (h.status === 'busy' || !!(spin && spin.strong)) && !menu && !panel;
    st.bgHint = st.busy && lines.some((l) => /ctrl\+b\b/i.test(l) && /\bbackground\b/i.test(l));
    if (st.rewound && menu) { st.rewound.sawMenu = true; st.rewound.emptyAt = 0; }
    if (st.rewound && alive && !menu && !panel) takeRewound();
    if ((st.menu && st.menu.sig) !== (menu && menu.sig)) { st.menu = menu; st.drawn.card = null; }
    else st.menu = menu;
    root.classList.toggle('busy', st.busy);
    root.classList.toggle('asking', !!menu);
    drawAct(spin);
    drawCard();
    drawPanel();
    drawMode();
    drawModel();
    drawRemote();
    drawSend();
    drawNotes();
    focus?.focus({ preventScroll: true });
  }

  // ----- static bits: enabled or not, the model -----
  function drawStatic() {
    const t = termApi();
    ta.disabled = !t;
    root.classList.toggle('nodesk', !t);
    $('[data-c="attach"]').disabled = !t;
    const fb = $('[data-c="folder"]');
    fb.hidden = typeof window.fleetDesktop?.pickFolder !== 'function';
    fb.disabled = !t;
    const mic = $('[data-c="mic"]');
    mic.hidden = !voiceSupported();
    mic.disabled = !t;
    if (!t) stopDictation(false);
    drawModel();
    drawRemote();
  }

  // ----- the mic: voice.js records it and Whisper (on this PC) writes out each stretch of speech after its pause;
  // the words go in after what is in the box. It listens until the mic is clicked again (what was said up to then
  // is still written out) or the message is sent (it goes once the last words are in), and stops at once, dropping
  // what was not written yet, when the box shows another conversation. -----
  const joinSpoken = (a, b) => (!b ? a : !a || /\s$/.test(a) ? a + b : `${a} ${b}`);
  function drawMic() {
    const mic = $('[data-c="mic"]'), d = st.dict, w = st.drain;
    mic.classList.toggle('on', !!d);
    mic.classList.toggle('wait', !!d && !d.ready);
    mic.classList.toggle('busy', !d && !!w);
    mic.setAttribute('aria-pressed', String(!!d));
    mic.title = d ? (d.ready ? 'Listening: click to stop' : 'Starting the mic…')
      : w ? 'Writing out the last words…' : 'Talk instead of typing: it listens until you click again';
    drawNotes();
    if (!ghost.hidden && !liveText()) grow(); // the mic stopped (or was dropped): its preview goes too
    drawSend();
  }
  // the preview moved: redrawn after the text, kept in view while the caret is at the end
  function drawLive() {
    grow(); drawSend();
    if (liveText() && ta.selectionEnd === ta.value.length) { ta.scrollTop = ta.scrollHeight; ghost.scrollTop = ta.scrollTop; }
  }
  async function dictate() {
    if (ta.disabled || !voiceSupported()) return;
    if (st.dict) { stopDictation(true); return; }
    if (st.sendAfter) { st.sendAfter = false; drawNotes(); drawSend(); } // talking again: the send waits for the next press
    const d = { token: null, ready: false, note: '', busy: 0, live: null };
    st.dict = d;
    drawMic();
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    let r = null;
    try { r = await startVoice(); } catch (e) { r = { ok: false, message: String(e?.message || e) }; }
    if (st.dict !== d) { if (r && r.ok) stopVoice(r.token, false); return; } // stopped while it started
    if (!r || !r.ok) { st.dict = null; drawMic(); err(`Could not start the mic: ${r?.message || 'unknown error'}`); return; }
    d.token = r.token;
  }
  // flush: write out what was said up to now (the mic button); otherwise drop it (sending, another conversation)
  function stopDictation(flush) {
    const d = st.dict;
    if (!d) return;
    st.dict = null;
    if (d.token != null) {
      if (flush) st.drain = d;
      stopVoice(d.token, flush);
    }
    drawMic();
  }
  const offVoice = onVoice((token, ev) => {
    const d = st.dict && st.dict.token === token ? st.dict : st.drain && st.drain.token === token ? st.drain : null;
    if (!st.alive || !d || !ev) return;
    const text = String(ev.text || '');
    if (ev.t === 'ready') { d.ready = true; drawMic(); }
    else if (ev.t === 'status') { d.note = text; drawNotes(); }
    else if (ev.t === 'busy') { d.busy = Number(text) || 0; drawNotes(); }
    else if (ev.t === 'partial') {
      // a newer preview replaces it; an empty one clears it (its stretch held no words after all)
      if (text) d.live = { text, stretch: ev.stretch };
      else if (d.live && d.live.stretch <= ev.stretch) d.live = null;
      drawLive();
    } else if (ev.t === 'final') {
      if (d.live && d.live.stretch <= ev.stretch) d.live = null; // the words take the preview's place
      ta.value = joinSpoken(ta.value, text);
      ta.setSelectionRange(ta.value.length, ta.value.length);
      ta.scrollTop = ta.scrollHeight;
      saveDraftSoon(); grow(); drawSend();
    } else if (ev.t === 'end' || ev.t === 'error') {
      d.live = null;
      if (st.dict === d) st.dict = null;
      if (st.drain === d) st.drain = null;
      drawMic();
      if (ev.t === 'error') err(`The mic stopped: ${text}`);
      if (st.sendAfter && !st.dict && !st.drain) { st.sendAfter = false; drawNotes(); drawSend(); send(); }
    }
  });

  // ----- events -----
  ta.addEventListener('input', (e) => {
    // "!" typed as the first character of an empty box: bash mode, the "!" is the mode (a pasted one stays text)
    if (!st.d.shell && !inserting && e.inputType === 'insertText' && e.data === '!' && ta.value === '!') {
      ta.value = '';
      setShell(true);
    }
    saveDraftSoon(); grow(); drawSend(); drawSlash();
  });
  ta.addEventListener('scroll', () => { if (!ghost.hidden) ghost.scrollTop = ta.scrollTop; }); // the mic's preview scrolls with the text
  ta.addEventListener('click', () => drawSlash()); // the caret moved: the list shows only with it at the end
  ta.addEventListener('keyup', (e) => { if (/^(ArrowLeft|ArrowRight|Home|End)$/.test(e.key)) drawSlash(); }); // so did this
  ta.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== ta) shutSlash(); }, 150));
  ta.addEventListener('keydown', (e) => {
    // the box owns the keyboard: none of the page's single-key shortcuts fire while typing here (app.js listens on
    // the document; the filter box does the same)
    e.stopPropagation();
    const plain = !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !e.isComposing;
    if (st.slash.open && plain) {
      // the "/" list has the arrows, Tab and Enter; Esc closes it until the text changes
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); moveSlash(e.key === 'ArrowDown' ? 1 : -1); return; }
      if (e.key === 'Tab') { e.preventDefault(); pickSlash(st.slash.sel, false); return; }
      if (e.key === 'Enter') { e.preventDefault(); pickSlash(st.slash.sel, true); return; }
      if (e.key === 'Escape') { e.preventDefault(); st.slash.shut = ta.value; shutSlash(); return; }
    }
    if (e.key === 'Enter' && plain) { e.preventDefault(); send(); return; }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && plain && recall(e.key === 'ArrowUp' ? -1 : 1)) { e.preventDefault(); return; }
    // Ctrl+R: search your past messages, as in the terminal
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'r') { e.preventDefault(); openSearch(); return; }
    // bash mode ends with Backspace (or Esc) in the empty box, as Claude Code's does
    if (st.d.shell && !ta.value && ((e.key === 'Backspace' && plain) || e.key === 'Escape')) { e.preventDefault(); setShell(false); return; }
    if (e.key === 'Escape') {
      e.preventDefault();
      if (st.panel && !ta.value) panelKey('esc'); // the panel closes, as Esc in the session does
      else if (st.busy && !ta.value) stop();
      else ta.blur();
    }
  });
  ta.addEventListener('paste', (e) => {
    const items = [...(e.clipboardData?.items || [])];
    const files = items.filter((it) => it.kind === 'file').map((it) => it.getAsFile()).filter(Boolean);
    if (!files.length) return;
    // a screenshot or files copied in Explorer: no text comes with them; text copied with a picture (a web page)
    // still pastes as text, and only its images come along
    const withText = items.some((it) => it.kind === 'string' && it.type === 'text/plain');
    if (!withText) e.preventDefault();
    addFiles(withText ? files.filter((f) => IMG_TYPES[f.type]) : files, withText);
  });
  fileIn.addEventListener('change', () => { addFiles(fileIn.files); fileIn.value = ''; ta.focus(); });

  pane.addEventListener('fv-chat-sendnow', (e) => { if (e.detail && sendNow(e.detail.id)) e.detail.ok = true; });
  pane.addEventListener('fv-chat-unsend', (e) => { const x = e.detail; if (x) x.done = unsendQueued(x.id, x.text, typeof x.queue === 'function' ? x.queue : () => x.queue); });
  pane.addEventListener('fv-chat-rewind', (e) => { const x = e.detail; if (x) rewindTo(x.id, x.text, x.nth | 0, typeof x.edit === 'string' ? x.edit : null); });
  root.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !root.contains(b)) return;
    if (b.dataset.a) { preview(b.dataset.a); return; }
    if (b.dataset.x) { removeAtt(b.dataset.x); return; }
    if (b.dataset.q) { setQuote(''); ta.focus(); return; }
    if (b.dataset.e) { st.errs = st.errs.filter((x) => x.key !== b.dataset.e); drawNotes(); return; }
    if (b.dataset.n) { answer(+b.dataset.n); return; }
    if (b.dataset.mode) { switchMode(b.dataset.mode); return; }
    if (b.dataset.model) { pickModel('model', b.dataset.model); return; }
    if (b.dataset.effort) { pickModel('effort', b.dataset.effort); return; }
    if (b.dataset.sl) { pickSlash(+b.dataset.sl, false); return; }
    const c = b.dataset.c;
    if (c === 'send') send();
    else if (c === 'bg') runInBackground();
    else if (c === 'mic') dictate();
    else if (c === 'stop') stop();
    else if (c === 'esc') { if (writeKey('\x1b')) { st.answeredSig = st.menu?.sig || null; st.answeredAt = Date.now(); drawCard(); } }
    else if (c === 'panel-esc') writeKey('\x1b');
    else if (c === 'attach') fileIn.click();
    else if (c === 'folder') attachFolder();
    else if (c === 'remote') { openModeMenu(false); openModelMenu(false); toggleRemote(); }
    else if (c === 'mode') { openModelMenu(false); openModeMenu(modeMenu.hidden); }
    else if (c === 'model') { openModeMenu(false); openModelMenu(modelMenu.hidden); }
  });
  panelEl.addEventListener('pointerdown', (e) => { if (e.target.closest('button')) e.preventDefault(); }); // the card keeps the focus
  panelEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pk],[data-ptab]');
    if (!b) return;
    if (b.dataset.ptab) panelTab(+b.dataset.ptab); else panelKey(b.dataset.pk);
    panelEl.focus({ preventScroll: true });
  });
  panelEl.addEventListener('keydown', panelKeydown);
  card.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (/^[1-9]$/.test(e.key)) { e.preventDefault(); e.stopPropagation(); answer(+e.key); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (writeKey('\x1b')) { st.answeredSig = st.menu?.sig || null; st.answeredAt = Date.now(); drawCard(); } }
  });
  const menuKeys = (menu, open, btn) => (e) => {
    e.stopPropagation();
    const items = [...menu.querySelectorAll('.cmp-mi')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); open(false); btn.focus(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus(); }
  };
  modeMenu.addEventListener('keydown', menuKeys(modeMenu, openModeMenu, modeBtn));
  modelMenu.addEventListener('keydown', menuKeys(modelMenu, openModelMenu, modelBtn));
  // the "/" list: a click must not take the focus from the box first
  slashEl.addEventListener('pointerdown', (e) => e.preventDefault());
  const outside = (e) => {
    const w = e.target.closest?.('.cmp-modew');
    if (!modeMenu.hidden && w !== modeMenu.parentElement) openModeMenu(false);
    if (!modelMenu.hidden && w !== modelMenu.parentElement) openModelMenu(false);
  };
  document.addEventListener('pointerdown', outside, true);

  // drops: anywhere on the chat pane
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  let dragDepth = 0;
  const onDragEnter = (e) => { if (!hasFiles(e) || !termApi()) return; dragDepth++; root.classList.add('drop'); };
  const onDragOver = (e) => { if (!hasFiles(e) || !termApi()) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; };
  const onDragLeave = (e) => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; root.classList.remove('drop'); } };
  const onDrop = (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    root.classList.remove('drop');
    if (!termApi()) return;
    addFiles(e.dataTransfer.files);
    ta.focus();
  };
  // a quote from the feed (chat.js): a bubble above the text (another Reply adds to it)
  const onQuote = (e) => {
    const q = quoteSelection(e.detail?.text);
    if (!q || ta.disabled) return;
    setQuote(st.d.quote ? `${st.d.quote}>\n${q}` : q);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.scrollTop = ta.scrollHeight;
  };
  // handed over from another tab (handto.js). One to send at once goes as its own message (send(text): what is
  // typed in the box, its quote and attachments stay where they are); if it can't go now (a question is up, a send
  // is under way...) it lands in the box instead. The others: the text after what is typed, the images as
  // attachments.
  async function takeHanded() {
    if (!st.alive) return;
    const items = takeHandoff(st.id);
    if (!items.length) return;
    const files = [];
    let boxed = false;
    const toBox = (text) => {
      if (!text) return;
      if (st.d.shell) setShell(false); // it is a message, not a shell command
      ta.value = ta.value.trim() ? `${ta.value.replace(/\s+$/, '')}\n\n${text}` : text;
      boxed = true;
    };
    for (const it of items) {
      const text = String(it.text || '').replace(/\s+$/, '');
      const imgs = (it.images || []).filter((im) => im && im.blob);
      if (it.send && text && !imgs.length) {
        if (await send(text) === true) continue;
        if (!st.alive) return;
      }
      toBox(text);
      for (const im of imgs) {
        const blob = im.blob, type = blob.type || 'image/png';
        files.push(blob instanceof File ? blob : new File([blob], im.name || `screenshot.${IMG_TYPES[type] || 'png'}`, { type }));
      }
    }
    if (!boxed && !files.length) return;
    st.hist = null;
    if (files.length) addFiles(files);
    shutSlash();
    st.slash.shut = ta.value;
    saveDraftSoon(); grow(); drawSend();
    // focused once the panel shows the Chat tab (it may switch to it just after this)
    const focus = () => { if (!st.alive) return; ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); ta.scrollTop = ta.scrollHeight; };
    focus();
    requestAnimationFrame(() => { if (document.activeElement !== ta) focus(); });
  }
  const onHandto = (e) => { if (e.detail && e.detail.id === st.id) takeHanded(); };
  const onResize = () => grow();
  window.addEventListener('fv-handto', onHandto);
  pane.addEventListener('keydown', onPaneKey, true);
  pane.addEventListener('dragenter', onDragEnter);
  pane.addEventListener('dragover', onDragOver);
  pane.addEventListener('dragleave', onDragLeave);
  pane.addEventListener('drop', onDrop);
  pane.addEventListener('fv-chat-quote', onQuote);
  window.addEventListener('resize', onResize);

  loadDraft();
  drawStatic();
  tick();
  st.timer = setInterval(tick, POLL_MS);
  takeHanded();

  return {
    update(next) {
      if (!next || !st.alive) return;
      if (next.id !== st.id) {
        // another conversation in the same box: keep this draft, show that one's
        stopDictation(false);
        st.sendAfter = false;
        st.d.text = ta.value;
        storeText(st.id, ta.value);
        st.id = next.id;
        st.d = draftOf(next.id);
        shutSlash(); st.slash.shut = null; st.hist = null; shutSearch(false); st.bgHint = false;
        st.panel = null; st.panelOwned = false; st.cmdAt = 0; st.cmd = '';
        st.menu = null; st.mode = null; st.effort = null; st.want = null; st.busy = false; st.errs = []; st.step = ''; st.elsewhereAt = 0;
        st.rcSeen = null; st.rcConnecting = false;
        st.drawn = {};
        loadDraft();
        st.s = next;
        drawStatic();
        tick();
        takeHanded();
        return;
      }
      st.s = next;
      drawStatic();
      tick();
    },
    destroy() {
      if (!st.alive) return;
      stopDictation(false);
      offVoice();
      st.alive = false;
      boxes.delete(st);
      clearInterval(st.timer);
      clearTimeout(st.saveTimer);
      st.d.text = ta.value;
      storeText(st.id, ta.value);
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('fv-handto', onHandto);
      pane.removeEventListener('keydown', onPaneKey, true);
      pane.removeEventListener('dragenter', onDragEnter);
      pane.removeEventListener('dragover', onDragOver);
      pane.removeEventListener('dragleave', onDragLeave);
      pane.removeEventListener('drop', onDrop);
      pane.removeEventListener('fv-chat-quote', onQuote);
      window.removeEventListener('resize', onResize);
      slot.innerHTML = '';
    },
  };
}
