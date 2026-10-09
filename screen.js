// Fleet View server: what a hosted session's screen shows, from its raw output (the session host's snapshot).
//
// The page reads a session's screen from its xterm (web/term.js screenText) and looks for Claude Code's select
// menus there (web/compose.js parseMenu). The server has no xterm, and the raw output can't simply be read as
// text: ConPTY and Claude Code redraw by moving the cursor, so the same rows are written over many times. So
// render() plays the output into a small grid the way a terminal would (printable text with auto-wrap, the
// cursor moves, erases, scroll regions, insert and delete, the alternate screen) and gives back its lines, and
// menuIn() is a port of parseMenu's test for "a menu is up" over those lines. api.js uses them so that a message
// is never pasted, and never followed by Enter, while Claude shows a permission prompt, a question or the plan
// approval: the Enter would pick the highlighted option.
//
//   render(raw, cols, rows, lastN = 40) -> [line]  the last lastN lines (soft-wrapped rows joined, blank rows at
//                                                   the bottom dropped), like term.js screenText
//   menuIn(lines) -> { options: [{ n, label, on }] } | null
//   menuShown(raw, cols, rows) -> the same, from raw output
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

const clampInt = (v, lo, hi, def) => (Number.isInteger(v) && v >= lo && v <= hi ? v : def);

function render(raw, cols, rows, lastN = 40) {
  const W = clampInt(cols, 2, 1000, 120), Hh = clampInt(rows, 2, 500, 32);
  const s = String(raw || '');
  const blank = () => ({ c: [], w: false });
  let main = { lines: Array.from({ length: Hh }, blank) }, alt = null;
  let L = main.lines; // the active buffer: scrollback, then the Hh rows of the screen at its end
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
  const erase = (r, from, to) => { const l = row(r); for (let i = from; i < to && i < l.c.length; i++) l.c[i] = ' '; };
  const put = (ch, w) => {
    if (w === 0) { const l = row(y); const i = Math.max(0, x - 1); if (l.c[i] != null) l.c[i] += ch; return; }
    if (wrapNext || (w === 2 && x === W - 1)) { x = 0; lineFeed(); row(y).w = true; wrapNext = false; }
    const l = row(y);
    while (l.c.length < x) l.c.push(' ');
    l.c[x] = ch;
    if (w === 2) l.c[x + 1] = '';
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
          case 'P': { const l = row(y); l.c.splice(x, n); wrapNext = false; break; }
          case '@': { const l = row(y); if (l.c.length > x) { l.c.splice(x, 0, ...Array(n).fill(' ')); l.c.length = Math.min(l.c.length, W); } wrapNext = false; break; }
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
          default: break; // colours (m) and the rest draw nothing
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
    const text = l.c.map((c) => (c == null ? ' ' : c)).join('').replace(/\s+$/, '');
    if (l.w && out.length) out[out.length - 1] += text; else out.push(text);
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.slice(-lastN);
}

// ---------- the menu (a port of web/compose.js parseMenu's test; keep the two in step) ----------
const isRule = (l) => /^\s*[─━═]{6,}/.test(l) && !/[╭╮╰╯┌┐└┘]/.test(l);
const unbox = (l) => String(l ?? '').replace(/^(\s*)[│┃](\s?)/, '$1 $2').replace(/\s*[│┃]\s*$/, '');
const OPT_RE = /^(\s*)([❯›])?\s*(\d{1,2})[.)]\s+(.*\S)\s*$/;
// A select menu at the bottom: at least two options numbered one after another in the last ~20 non-empty lines,
// one of them with the ❯ pointer; not the prompt box (❯ under a rule, a typed "1. … 2. …" list), and not a menu
// with the prompt drawn under it.
function menuIn(lines) {
  const L = (Array.isArray(lines) ? lines : []).map((l) => unbox(String(l ?? '')));
  let start = L.length, seen = 0;
  while (start > 0 && seen < 20) { start--; if (L[start].trim()) seen++; }
  const opts = [];
  for (let i = start; i < L.length; i++) {
    const m = OPT_RE.exec(L[i]);
    if (m) opts.push({ i, n: +m[3], on: !!m[2], label: m[4] });
  }
  let run = null, cur = [];
  const close = () => { if (cur.length >= 2 && cur.some((o) => o.on)) run = cur; };
  for (const o of opts) {
    const last = cur[cur.length - 1];
    if (last && o.n === last.n + 1 && o.i - last.i <= 5) cur.push(o);
    else { close(); cur = [o]; }
  }
  close();
  if (!run) return null;
  const first = run[0], last = run[run.length - 1];
  let k = first.i - 1;
  while (k >= 0 && !L[k].trim()) k--;
  if (first.on && k >= 0 && isRule(L[k])) return null;
  for (let j = last.i + 1; j < L.length; j++) if (/^\s*❯(\s|$)/.test(L[j]) && !OPT_RE.test(L[j])) return null;
  return { options: run.map((o) => ({ n: o.n, label: o.label.replace(/\s+/g, ' '), on: o.on })) };
}

const menuShown = (raw, cols, rows) => menuIn(render(raw, cols, rows, 40));

module.exports = { render, menuIn, menuShown, widthOf };
