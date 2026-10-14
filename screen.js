// Fleet View server: what a hosted session's screen shows, from its raw output (the session host's snapshot).
//
// The page reads a session's screen from its xterm (web/term.js screenText) and looks for Claude Code's select
// menus there (web/compose.js parseMenu). The server has no xterm, and the raw output can't simply be read as
// text: ConPTY and Claude Code redraw by moving the cursor, so the same rows are written over many times. So
// render() plays the output into a small grid the way a terminal would (printable text with auto-wrap, the
// cursor moves, erases, scroll regions, insert and delete, the alternate screen) and gives back its lines, and
// menuDetails() is a port of parseMenu over those lines. api.js uses them so that a message is never pasted, and
// never followed by Enter, while Claude shows a permission prompt, a question or the plan approval (the Enter
// would pick the highlighted option), and to show a caller that menu and answer it (GET/POST /api/sessions/:id/menu,
// /answer).
//
//   render(raw, cols, rows, lastN = 40, join = true, marks = false) -> [line]  the last lastN lines (soft-wrapped
//                                                   rows joined unless join is false, blank rows at the bottom
//                                                   dropped), like term.js screenText; marks: inverse runs read
//                                                   "\x01text\x02" and dim ones "\x03text\x04", like term.js
//                                                   screenMarked(id, n, { dim: true }) (only those two: no colours)
//   menuDetails(lines) -> { kind, title, context, more, options: [{ n, label, desc, on }], sig, unnumbered? } | null
//                                                   (unnumbered: options drawn without numbers, numbered 1..k here;
//                                                   pick one with ↑/↓ and Enter, a digit does nothing)
//   menuDetailsShown(raw, cols, rows) -> the same, from raw output (its rows unjoined)
//   menuIn(lines) -> { options: [{ n, label, on }] } | null   (menuDetails, cut down)
//   menuShown(raw, cols, rows) -> the same, from raw output
//   promptBox(lines), spinner(lines), effortShown(lines): ports of compose.js parsePromptBox, parseSpinner and
//                                                   parseEffort, for api.js's chat verbs (unsend, activity, model)
'use strict';

// ---------- the terminal ----------
// how many columns a code point takes: 0 for combining marks and joiners, 2 for wide (CJK, most emoji), else 1
function widthOf(cp) {
  if (cp < 0x300) return 1;
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0x20e3) return 0;
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) || (cp >= 0xac00 && cp <= 0xd7a3)
    || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6)
    || (cp >= 0x1f300 && cp <= 0x1f64f) || (cp >= 0x1f900 && cp <= 0x1f9ff) || (cp >= 0x20000 && cp <= 0x3fffd)) return 2;
  return 1;
}

const DIM = 1, INV = 2; // render's cell attributes
const clampInt = (v, lo, hi, def) => (Number.isInteger(v) && v >= lo && v <= hi ? v : def);

function render(raw, cols, rows, lastN = 40, join = true, marks = false) {
  const W = clampInt(cols, 2, 1000, 120), Hh = clampInt(rows, 2, 500, 32);
  const s = String(raw || '');
  const blank = () => ({ c: [], a: [], w: false }); // a: each cell's DIM | INV
  let main = { lines: Array.from({ length: Hh }, blank) }, alt = null;
  let L = main.lines; // the active buffer: scrollback, then the Hh rows of the screen at its end
  let attr = 0; // the pen's DIM | INV (SGR 2 and 7)
  let x = 0, y = 0, wrapNext = false, top = 0, bot = Hh - 1, saved = { x: 0, y: 0 }, savedMain = null;
  const row = (r) => L[L.length - Hh + r];
  const setRow = (r, v) => { L[L.length - Hh + r] = v; };
  const clampCur = () => { x = Math.max(0, Math.min(W - 1, x)); y = Math.max(0, Math.min(Hh - 1, y)); wrapNext = false; };
  // the rows top..bot move up n (new blank rows at bot); the whole screen scrolling keeps the top rows as scrollback
  const scrollUp = (n) => {
    for (let k = 0; k < n; k++) {
      if (top === 0 && bot === Hh - 1 && L === main.lines) { L.push(blank()); continue; }
      L.splice(L.length - Hh + top, 1);
      L.splice(L.length - Hh + bot + 1, 0, blank());
    }
    if (L.length > 5000) L.splice(0, L.length - 5000);
  };
  const scrollDown = (n) => {
    for (let k = 0; k < n; k++) {
      L.splice(L.length - Hh + bot, 1);
      L.splice(L.length - Hh + top, 0, blank());
    }
  };
  const lineFeed = () => { if (y === bot) scrollUp(1); else if (y < Hh - 1) y++; };
  const erase = (r, from, to) => { const l = row(r); for (let i = from; i < to && i < l.c.length; i++) { l.c[i] = ' '; l.a[i] = 0; } };
  const put = (ch, w) => {
    if (w === 0) { const l = row(y); const i = Math.max(0, x - 1); if (l.c[i] != null) l.c[i] += ch; return; }
    if (wrapNext || (w === 2 && x === W - 1)) { x = 0; lineFeed(); row(y).w = true; wrapNext = false; }
    const l = row(y);
    while (l.c.length < x) l.c.push(' ');
    l.c[x] = ch;
    l.a[x] = attr;
    if (w === 2) { l.c[x + 1] = ''; l.a[x + 1] = attr; }
    x += w;
    if (x >= W) { x = W - 1; wrapNext = true; }
  };
  const altScreen = (on) => {
    if (on && !alt) {
      savedMain = { x, y, top, bot };
      alt = { lines: Array.from({ length: Hh }, blank) };
      L = alt.lines; x = 0; y = 0; top = 0; bot = Hh - 1;
    } else if (!on && alt) {
      alt = null; L = main.lines;
      ({ x, y, top, bot } = savedMain || { x: 0, y: 0, top: 0, bot: Hh - 1 });
    }
    wrapNext = false;
  };

  for (let i = 0; i < s.length;) {
    const code = s.charCodeAt(i);
    if (code === 0x1b) {
      const nx = s[i + 1];
      if (nx === '[') {
        // CSI: parameters, intermediates, one final byte
        let j = i + 2;
        while (j < s.length && s.charCodeAt(j) >= 0x30 && s.charCodeAt(j) <= 0x3f) j++;
        const params = s.slice(i + 2, j);
        while (j < s.length && s.charCodeAt(j) >= 0x20 && s.charCodeAt(j) <= 0x2f) j++;
        if (j >= s.length) break;
        const fin = s[j];
        i = j + 1;
        const priv = /^[?<=>]/.test(params);
        const ps = (priv ? params.slice(1) : params).split(';').map((p) => (p === '' ? NaN : parseInt(p, 10)));
        const p1 = Number.isFinite(ps[0]) ? ps[0] : 0, n = Math.max(1, p1);
        if (priv) {
          if ((fin === 'h' || fin === 'l') && ps.some((p) => p === 1049 || p === 1047 || p === 47)) altScreen(fin === 'h');
          continue;
        }
        switch (fin) {
          case 'A': y = Math.max(y >= top ? top : 0, y - n); clampCur(); break;
          case 'B': case 'e': y = Math.min(y <= bot ? bot : Hh - 1, y + n); clampCur(); break;
          case 'C': case 'a': x += n; clampCur(); break;
          case 'D': x -= n; clampCur(); break;
          case 'E': y = Math.min(bot, y + n); x = 0; clampCur(); break;
          case 'F': y = Math.max(top, y - n); x = 0; clampCur(); break;
          case 'G': case '`': x = n - 1; clampCur(); break;
          case 'd': y = n - 1; clampCur(); break;
          case 'H': case 'f': y = n - 1; x = (Number.isFinite(ps[1]) ? Math.max(1, ps[1]) : 1) - 1; clampCur(); break;
          case 'J':
            if (p1 === 0) { erase(y, x, W); for (let r = y + 1; r < Hh; r++) setRow(r, blank()); }
            else if (p1 === 1) { erase(y, 0, x + 1); for (let r = 0; r < y; r++) setRow(r, blank()); }
            else if (p1 === 2) { for (let r = 0; r < Hh; r++) setRow(r, blank()); }
            else if (p1 === 3) { if (L.length > Hh) L.splice(0, L.length - Hh); }
            wrapNext = false;
            break;
          case 'K':
            if (p1 === 0) erase(y, x, W); else if (p1 === 1) erase(y, 0, x + 1); else if (p1 === 2) setRow(y, { c: [], w: row(y).w });
            wrapNext = false;
            break;
          case 'X': erase(y, x, x + n); wrapNext = false; break;
          case 'P': { const l = row(y); l.c.splice(x, n); l.a.splice(x, n); wrapNext = false; break; }
          case '@': { const l = row(y); if (l.c.length > x) { l.c.splice(x, 0, ...Array(n).fill(' ')); l.c.length = Math.min(l.c.length, W); l.a.splice(x, 0, ...Array(n).fill(0)); l.a.length = Math.min(l.a.length, W); } wrapNext = false; break; }
          case 'L': if (y >= top && y <= bot) { const t0 = top; top = y; scrollDown(Math.min(n, bot - y + 1)); top = t0; } x = 0; wrapNext = false; break;
          case 'M': if (y >= top && y <= bot) { const t0 = top; top = y; for (let k = 0; k < Math.min(n, bot - y + 1); k++) { L.splice(L.length - Hh + top, 1); L.splice(L.length - Hh + bot + 1, 0, blank()); } top = t0; } x = 0; wrapNext = false; break;
          case 'S': scrollUp(n); break;
          case 'T': scrollDown(n); break;
          case 'r': {
            const a = (Number.isFinite(ps[0]) ? Math.max(1, ps[0]) : 1) - 1, b = (Number.isFinite(ps[1]) ? Math.max(1, ps[1]) : Hh) - 1;
            if (a < b && b < Hh) { top = a; bot = b; } else { top = 0; bot = Hh - 1; }
            x = 0; y = 0; wrapNext = false;
            break;
          }
          case 's': saved = { x, y }; break;
          case 'u': ({ x, y } = saved); clampCur(); break;
          case 'm': // only dim and inverse are kept (render's marks); a colour's own numbers (38;5;n, 38;2;r;g;b) skipped
            for (let k = 0; k < ps.length; k++) {
              const q = Number.isFinite(ps[k]) ? ps[k] : 0;
              if (q === 38 || q === 48 || q === 58) { if (!/:/.test(params.split(';')[k] || '')) k += ps[k + 1] === 5 ? 2 : ps[k + 1] === 2 ? 4 : 0; }
              else if (q === 0) attr = 0;
              else if (q === 2) attr |= DIM;
              else if (q === 22) attr &= ~DIM;
              else if (q === 7) attr |= INV;
              else if (q === 27) attr &= ~INV;
            }
            break;
          default: break; // the rest draw nothing
        }
        continue;
      }
      if (nx === ']') { // OSC: up to BEL or ST
        const a = s.indexOf('\x07', i + 2), b = s.indexOf('\x1b\\', i + 2);
        const end = a < 0 ? b : b < 0 ? a : Math.min(a, b);
        if (end < 0) break;
        i = end + (end === b ? 2 : 1);
        continue;
      }
      if (nx === 'P' || nx === 'X' || nx === '^' || nx === '_') { const e = s.indexOf('\x1b\\', i + 2); if (e < 0) break; i = e + 2; continue; }
      if (nx === '(' || nx === ')' || nx === '*' || nx === '+' || nx === '#' || nx === '%') { i += 3; continue; }
      if (nx === '7') saved = { x, y };
      else if (nx === '8') { ({ x, y } = saved); clampCur(); }
      else if (nx === 'D') lineFeed();
      else if (nx === 'E') { x = 0; lineFeed(); }
      else if (nx === 'M') { if (y === top) scrollDown(1); else if (y > 0) y--; }
      else if (nx === 'c') { altScreen(false); for (let r = 0; r < Hh; r++) setRow(r, blank()); x = 0; y = 0; top = 0; bot = Hh - 1; }
      i += 2;
      continue;
    }
    if (code < 0x20 || code === 0x7f) {
      if (code === 0x0d) { x = 0; wrapNext = false; }
      else if (code === 0x0a || code === 0x0b || code === 0x0c) { lineFeed(); wrapNext = false; }
      else if (code === 0x08) { x = Math.max(0, x - 1); wrapNext = false; }
      else if (code === 0x09) { x = Math.min(W - 1, (Math.floor(x / 8) + 1) * 8); }
      i++;
      continue;
    }
    if (code >= 0x80 && code <= 0x9f) { i++; continue; } // C1 controls
    const cp = s.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    i += ch.length;
    put(ch, widthOf(cp));
  }

  const out = [];
  for (const l of L) {
    let text = '';
    if (!marks) text = l.c.map((c) => (c == null ? ' ' : c)).join('');
    else {
      let on = 0;
      for (let k = 0; k < l.c.length; k++) {
        const v = l.c[k] == null ? 0 : l.a[k] || 0;
        if ((on & DIM) && !(v & DIM)) text += '\x04';
        if ((on & INV) !== (v & INV)) text += v & INV ? '\x01' : '\x02';
        if ((v & DIM) && !(on & DIM)) text += '\x03';
        on = v;
        text += l.c[k] == null ? ' ' : l.c[k];
      }
      if (on & DIM) text += '\x04';
      if (on & INV) text += '\x02';
    }
    text = text.replace(/\s+$/, '');
    if (join && l.w && out.length) out[out.length - 1] += text; else out.push(text);
  }
  while (out.length && !out[out.length - 1].replace(/[\x01-\x04]/g, '').trim()) out.pop();
  return out.slice(-lastN);
}

// ---------- the menu (a port of web/compose.js parseMenu; keep the two in step) ----------
const isRule = (l) => /^\s*[─━═]{6,}/.test(l) && !/[╭╮╰╯┌┐└┘]/.test(l);
const isBoxEdge = (l) => /^\s*[╭╰┌└][─━═]/.test(l);
// a line of an older boxed dialog: "│ text │" -> "  text"
const unbox = (l) => String(l ?? '').replace(/^(\s*)[│┃](\s?)/, '$1 $2').replace(/\s*[│┃]\s*$/, '');
const OPT_RE = /^(\s*)([❯›])?\s*(\d{1,2})[.)]\s+(.*\S)\s*$/;
// AskUserQuestion's parts: a multiple-choice option's box ("[ ] Small", "[✔] Small"), the Submit row under its options
// (no number: the ❯ on it points at no option), the text option ("Type something." until text goes in, then that
// text, so it is also known as the one right above "Chat about this"), and an option's preview drawn beside it
const CHECK_RE = /^\[([ ✔✓xX×])\]\s+/;
const SUBMIT_RE = /^\s*(❯)?\s*Submit\s*$/;
const FREE_RE = /^(?:type something\.?|other)$/i;
const PREVIEW_RE = /\s{3,}[┌└│╭╰┃].*$/;
const isPreview = (l) => /^\s*[┌└│╭╰┃]/.test(l) || /^\s*Notes: press n\b/.test(l);
// The prompt box: a "❯" row right under a rule, closed by another rule below it. A past message on the screen
// ("❯ 4. text" in the scrollback) and the text typed in the box look like a pointed-at option, so a reply ending
// in "3. …" over a box holding "4. … 5. …" would read as a menu. AskUserQuestion's "❯ 4. Chat about this" sits
// under a rule too, but nothing closes it: its keys line ("Enter to select · ↑/↓ to navigate") follows.
const MENU_KEYS = /\bEnter to (?:select|confirm)\b|↑\/↓ to (?:navigate|select)|\bEsc to cancel\b/i;
function promptBoxAt(L, i) {
  if (!/^\s*❯(\s|$)/.test(L[i])) return false;
  let k = i - 1;
  while (k >= 0 && !L[k].trim()) k--;
  if (k < 0 || !isRule(L[k])) return false;
  for (let j = i + 1; j < L.length && j <= i + 30; j++) {
    if (MENU_KEYS.test(L[j])) return false;
    if (isRule(L[j])) return true;
  }
  return false;
}
// A menu drawn without numbers: Claude Code 2.1.296's folder trust question ("❯ No, exit" over "  Yes, I trust this
// folder", then "Enter to confirm · Esc to cancel"). Read strictly, so a reply's text never reads as one: two or more
// lines in a row at one indentation, the ❯ two columns left of exactly one of their labels, and the keys line within
// 3 lines under them. -> its options numbered 1..k in screen order (like OPT_RE's), or null
const PLAIN_KEYS = /\bEnter to (?:confirm|select)\b/i;
function plainRun(L, raw, start) {
  let h = L.length - 1;
  while (h >= start && !PLAIN_KEYS.test(L[h])) h--;
  if (h < start) return null;
  let e = h - 1;
  while (e >= Math.max(start, h - 3) && !L[e].trim()) e--;
  if (e < Math.max(start, h - 3)) return null;
  // one line as an option: its label's column, and whether the ❯ is on it
  const row = (l) => {
    if (OPT_RE.test(l) || isRule(l) || isBoxEdge(l) || PLAIN_KEYS.test(l)) return null;
    const p = /^(\s*)[❯›] (\S.*?)\s*$/.exec(l);
    if (p) return { col: p[1].length + 2, on: true, label: p[2] };
    const q = /^( +)([^\s❯›].*?)\s*$/.exec(l);
    return q ? { col: q[1].length, on: false, label: q[2] } : null;
  };
  const got = [];
  const col = row(L[e])?.col;
  for (let i = e; i >= start && got.length < 20; i--) {
    const r = row(L[i]);
    if (!r || r.col !== col) break;
    got.unshift({ i, on: r.on, label: r.label, col, boxed: /^\s*[│┃]/.test(raw[i]) });
  }
  if (got.length < 2 || got.filter((o) => o.on).length !== 1) return null;
  // a list in a command's panel (its ▔ edge above, no rule between): the panel reader's, not a menu
  for (let i = got[0].i - 1; i >= start && !isRule(L[i]); i--) if (/^\s*▔{12,}\s*$/.test(L[i])) return null;
  return got.map((o, x) => ({ ...o, n: x + 1 }));
}

// What kind of menu it is, so a caller can tell a question it may answer from a tool call it must not approve:
//   'question'   AskUserQuestion: its tab bar (☐ / ☒ / ✔ Submit), its "Type something." / "Chat about this"
//                options, or its last step ("Ready to submit your answers?")
//   'trust'      the folder trust question at startup ("Do you trust the files in this folder?", and 2.1.296's
//                "Accessing workspace: … Is this a project you created or one you trust?" with "Yes, I trust this folder")
//   'chrome'     Claude Code's one-time "Claude in Chrome extension detected" offer at startup: its "Yes, use my
//                browser" option, with its title or its "No, keep browser tools off" option (api.js answers it Yes)
//   'plan'       the plan approval ("Would you like to proceed?" with auto-accept edits / keep planning)
//   'permission' a tool's permission prompt ("Do you want to proceed?", "Do you want to make this edit to x?",
//                "Do you want to create x?", or a "Yes, and don't ask again" / "Yes, allow" option)
//   'other'      anything else (a picker, a notice)
// above: the few lines around the dialog's top rule or box edge, where the tab bar sits
function kindOf(title, context, options, above) {
  const labels = options.map((o) => o.label);
  const all = [title, ...context].join('\n');
  // permission, plan and trust first: a question is the one kind answered without allowPermission, so a doubt fails closed
  if (/trust the files in this folder|do you trust|a project you created or one you trust|^\s*Accessing workspace:/im.test(all)
    || labels.some((l) => /\btrust this folder\b/i.test(l))) return 'trust';
  if (labels.some((l) => /^Yes, use my browser$/i.test(l))
    && (labels.some((l) => /^No, keep browser tools off$/i.test(l)) || /Claude in Chrome extension detected/i.test(all))) return 'chrome';
  if (/would you like to proceed\?/i.test(title)
    && (labels.some((l) => /auto-accept|keep planning|manually approve|bypass permissions|clear context/i.test(l)) || /\bplan\b/i.test(all))) return 'plan';
  if (/^Do you want to (?:proceed|make this edit|create|allow|run|write|delete|overwrite|fetch|use)\b/i.test(title)
    || labels.some((l) => /^Yes, (?:and don't ask again|allow)\b/i.test(l))) return 'permission';
  if (/^Ready to submit your answers\?/i.test(title) || labels.some((l) => /^(?:Type something\.?|Chat about this)$/i.test(l))
    || above.some((l) => /^\s*(?:←\s*)?[☐☒✔]/.test(l) && /[☐☒]\s*\S/.test(l) && /✔\s*Submit\s*(?:→\s*)?$/.test(l))
    // one question's header alone ("☐ Layout"), as one with option previews shows it (no "Type something" there)
    || above.some((l) => /^\s*[☐☒]\s+\S.{0,40}$/.test(l) && !/[│┃]/.test(l))) return 'question';
  return 'other';
}

// A select menu at the bottom of the screen: Claude Code's permission prompts, AskUserQuestion, the plan
// approval, the folder trust question. Only when at least two options numbered one after another sit in the last
// ~30 non-empty lines and one of them carries the ❯ pointer (or, with none numbered, an unnumbered menu as plainRun
// reads it: its options are numbered 1..k here and it is marked unnumbered); the prompt box (❯ under a rule, where a typed
// "1. … 2. …" list would look the same) and a menu with the prompt drawn under it are not menus. Read it over the
// rows as drawn (render(..., join = false)): joined soft-wrapped rows hide a narrow panel's menu.
// -> { kind, title, context: [lines], more, options: [{ n, label, desc, on, check?, free? }], submit, sig, unnumbered? }
// or null; everything but kind is exactly what parseMenu gives for the same lines
function menuDetails(lines) {
  const raw = (Array.isArray(lines) ? lines : []).map((l) => String(l ?? ''));
  const L = raw.map(unbox);
  let start = L.length, seen = 0;
  while (start > 0 && seen < 40) { start--; if (L[start].trim()) seen++; }
  const opts = [];
  for (let i = start; i < L.length; i++) {
    const m = OPT_RE.exec(L[i]);
    if (m) opts.push({ i, n: +m[3], on: !!m[2], label: m[4], col: L[i].indexOf(m[3]), boxed: /^\s*[│┃]/.test(raw[i]) });
  }
  // runs of options numbered one after another, at most 13 lines (descriptions, wrapped in a narrow panel) between
  // two; the one Claude waits on has the ❯ on an option, or on a multiple-choice question's Submit row among them
  let run = null, cur = [];
  const pointed = (c) => c.some((o) => o.on) || L.slice(c[0].i, c[c.length - 1].i).some((l) => /^\s*❯\s*Submit\s*$/.test(l));
  const close = () => { if (cur.length >= 2 && pointed(cur)) run = cur; };
  for (const o of opts) {
    const last = cur[cur.length - 1];
    if (last && o.n === last.n + 1 && o.i - last.i <= 14) cur.push(o);
    else { close(); cur = [o]; }
  }
  close();
  // none numbered: one drawn without numbers (2.1.296's trust question), picked with ↑/↓ and Enter, never a digit
  let unnumbered = false;
  if (!run && (run = plainRun(L, raw, start))) unnumbered = true;
  if (!run) return null;
  const first = run[0], last = run[run.length - 1];
  let k = first.i - 1;
  while (k >= 0 && !L[k].trim()) k--;
  if (first.on && k >= 0 && isRule(L[k])) return null; // the prompt box with a typed list in it
  // the prompt drawn under it: the menu is not what Claude waits on
  for (let j = last.i + 1; j < L.length; j++) if (/^\s*❯(\s|$)/.test(L[j]) && !OPT_RE.test(L[j])) return null;
  // the prompt box among its options or under them (a typed "4. …" continuing a reply's "3. …"): no menu is up,
  // since Claude Code hides the box while one is
  for (let j = first.i; j < L.length; j++) if (promptBoxAt(L, j)) return null;
  // descriptions: the lines under an option indented past its number (not a preview's box beside them)
  let submit = null;
  const options = run.map((o, x) => {
    const end = x + 1 < run.length ? run[x + 1].i : Math.min(L.length, o.i + 3);
    const label = o.label.replace(PREVIEW_RE, '').replace(/\s+/g, ' ');
    const box = CHECK_RE.exec(label);
    const desc = [];
    for (let j = unnumbered ? end : o.i + 1; j < end; j++) {
      const l = L[j];
      if (!l.trim() || isRule(l) || isPreview(l)) continue;
      const sm = box && SUBMIT_RE.exec(l);
      if (sm) { submit = { on: !!sm[1] }; continue; }
      if (l.search(/\S/) > o.col) desc.push(l.replace(PREVIEW_RE, '').trim());
      else break;
    }
    const opt = { n: o.n, label: box ? label.slice(box[0].length) : label, desc: desc.join(' ').slice(0, 200), on: o.on };
    if (box) opt.check = box[1] !== ' ';
    return opt;
  });
  if (!unnumbered) options.forEach((o, x) => { if (FREE_RE.test(o.label) || /^chat about this$/i.test(options[x + 1]?.label || '')) o.free = true; });
  // the title: the line above the first option; the context: what's above it, up to the dialog's top
  let title = '';
  if (k >= 0 && !isRule(L[k]) && !isBoxEdge(L[k]) && !OPT_RE.test(L[k])) { title = L[k].trim(); k--; }
  const ctx = [];
  let top = k;
  for (; k >= 0 && ctx.length < 30; k--) {
    const l = L[k];
    top = k;
    // (Claude's own "● …" lines start at the edge; the answers listed before a question's submit step are indented)
    if (isRule(l) || /^●|^\s*⎿/.test(l) || (isBoxEdge(l) && /^\s*[╭┌]/.test(l) && first.boxed)) break;
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
  // an unnumbered menu's question can end mid-line ("Quick safety check: Is this a project you created or one you
  // trust? (Like your own code, …"): the title is up to its "?", the rest of the line stays in the context
  const qm = unnumbered && qi < 0 && !/\?$/.test(title) ? ctx.map((l) => /\?\s/.test(l)).lastIndexOf(true) : -1;
  if (qm >= 0) {
    const l = ctx[qm], pad = l.match(/^\s*/)[0], cut = l.search(/\?\s/) + 1, rest = l.slice(cut).trim();
    if (rest) ctx[qm] = pad + rest; else ctx.splice(qm, 1);
    if (title) ctx.push(pad + title);
    title = l.slice(0, cut).trim();
  }
  while (ctx.length && !ctx[0].trim()) ctx.shift();
  while (ctx.length && !ctx[ctx.length - 1].trim()) ctx.pop();
  const squeezed = ctx.filter((l, x) => l.trim() || (ctx[x - 1] || '').trim()); // no two blank lines in a row
  const ind = Math.min(...squeezed.filter((l) => l.trim()).map((l) => l.search(/\S/)), 99);
  const context = squeezed.map((l) => l.slice(Math.min(ind, l.match(/^\s*/)[0].length)));
  const more = context.length > 8;
  const sig = JSON.stringify([title, options.map((o) => [o.n, o.label, o.on, o.check ?? null]), submit && submit.on]);
  let kind = kindOf(title, context, options, L.slice(Math.max(0, top - 3), Math.min(first.i, top + 3)));
  if (unnumbered && kind === 'question') kind = 'other'; // AskUserQuestion is always numbered: fail closed
  const out = { kind, title, context: context.slice(0, 8), more, options, submit, sig };
  if (unnumbered) out.unnumbered = true;
  return out;
}

// the test for "a menu is up" (api.js before typing, the host before its auto-continue note): menuDetails, cut down
function menuIn(lines) {
  const m = menuDetails(lines);
  return m ? { options: m.options.map(({ n, label, on }) => ({ n, label, on })) } : null;
}

// over the rows as drawn: Claude Code pads a menu's rows to the full width, which ConPTY then marks as wrapped,
// and joined they'd hide its options ("❯ 1. Yes      Some description   2. No" on one line)
const menuDetailsShown = (raw, cols, rows) => menuDetails(render(raw, cols, rows, 40, false));
const menuShown = (raw, cols, rows) => menuIn(render(raw, cols, rows, 40, false));

// ---------- the rest of the chat's screen readers (ports of web/compose.js; keep each in step with its original) ----------
// parsePromptBox: the prompt box at the bottom (between its two rules), over the rows as drawn: { text, lines } with
// the ❯ gone, text '' when it shows only its hint; null when it isn't on screen (a menu or panel covers it). lines
// may carry render's marks: what the box draws dim is Claude Code's grey suggestion of a next message, not typed text
const BOX_HINT = /^(?:Press up to edit queued messages|Try ".*")$/;
const dropDim = (l, first) => (first ? l.replace(/^(\s*[❯>]\s?)\x01[^\x02]\x02(?=\x03)/, '$1') : l)
  .replace(/\x03[^\x04]*(\x04|$)/g, '').replace(/[\x01-\x04]/g, '');
function promptBox(lines) {
  const M = (Array.isArray(lines) ? lines : []).map((l) => String(l ?? ''));
  const L = M.map((l) => l.replace(/[\x01-\x04]/g, ''));
  let b = L.length - 1;
  while (b >= Math.max(0, L.length - 6) && !isRule(L[b])) b--;
  if (b < 1 || !isRule(L[b])) return null;
  let a = b - 1;
  while (a >= 0 && !isRule(L[a])) a--;
  if (a < 0 || b - a < 2 || !/^\s*[❯>](\s|$)/.test(L[a + 1])) return null;
  const rows = M.slice(a + 1, b).map((l, k) => dropDim(l, !k));
  const text = rows.map((l, i) => (i ? l.replace(/^ {2}/, '') : l.replace(/^\s*[❯>]\s?/, '')).trimEnd()).join('\n').trim();
  return { text: BOX_HINT.test(text) ? '' : text, lines: rows.length };
}
// parseSpinner: the spinner line while Claude works ("✻ Brewing… (12s · ↓ 1.2k tokens · esc to interrupt)", its
// parentheses maybe running onto the next rows) -> { verb, detail, strong } or null; strong: it carries the time,
// tokens or "esc to interrupt", so it is the live spinner and not some text
const SPIN_RE = /^\s*([·✢✳✶✻✽✺*])\s+([A-Z][A-Za-z']*(?: [a-z][A-Za-z']*){0,2})…\s*(?:\((.*))?$/;
function spinner(lines) {
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
// parseEffort: the effort in the footer under the prompt ("◐ medium · /effort"), or null when it isn't on screen.
// Claude Code draws it right-aligned on a row that may hold other text, and the row can read as glued to it ("…new
// sessions○ low · /effort"): nothing is asked of what comes before the level (xhigh first, so it is not read as high)
function effortShown(lines) {
  const L = (Array.isArray(lines) ? lines : []).slice(-8);
  for (let i = L.length - 1; i >= 0; i--) {
    const m = /(xhigh|low|medium|high|max)\s*·\s*\/effort\b/i.exec(String(L[i] ?? ''));
    if (m) return m[1].toLowerCase();
  }
  return null;
}

module.exports = { render, menuIn, menuShown, menuDetails, menuDetailsShown, widthOf, promptBox, spinner, effortShown };
