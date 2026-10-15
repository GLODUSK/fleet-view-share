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
//                                                   screenMarked(id, n, { dim: true }) (only those two: no colours);
//                                                   marks 'bg': inverse runs and runs on a background colour read
//                                                   "\x01text\x02", and no dim marks, as screenMarked(id, n) reads
//                                                   them (a panel's tab that is on)
//   createScreen(cols, rows, { maxLines }) -> { write, resize, lines, serialize, size }   the same terminal, fed a
//                                                   piece at a time; serialize() draws its screen again, colours and
//                                                   all. The session host plays into one what falls off the output
//                                                   it keeps, so a snapshot starts with the screen as it stood there
//   menuDetails(lines) -> { kind, title, context, more, options: [{ n, label, desc, on }], sig, unnumbered? } | null
//                                                   (unnumbered: options drawn without numbers, numbered 1..k here;
//                                                   pick one with ↑/↓ and Enter, a digit does nothing)
//   menuDetailsShown(raw, cols, rows) -> the same, from raw output (its rows unjoined)
//   menuIn(lines) -> { options: [{ n, label, on }] } | null   (menuDetails, cut down)
//   menuShown(raw, cols, rows) -> the same, from raw output
//   promptBox(lines), spinner(lines), effortShown(lines): ports of compose.js parsePromptBox, parseSpinner and
//                                                   parseEffort, for api.js's chat verbs (unsend, activity, model)
//   bashBox(lines): the prompt box in bash mode (its prefix "!"), as promptBox reads the other
//   panelDetails(lines, o) -> { title, tabs: [{ label, on }], body: [lines], keys, sig } | null   a port of compose.js
//                                                   parsePanel (a command's panel: /usage, /config...), for api.js's
//                                                   /activity and POST .../panel
//   panelShown(raw, cols, rows, o) -> the same, from raw output (its rows unjoined, with the 'bg' marks)
//   modeShown(lines), bgOffered(lines): compose.js parseMode and its tick's bgHint reading, for api.js's /mode,
//                                                   /background and the activity line
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

const DIM = 1, INV = 2, BG = 4; // a style's marks (render's): SGR 2 and 7, and a background colour (SGR 4x, 10x, 48)
// the DECSET modes serialize() draws again: 1 cursor keys, 7 auto-wrap, 25 the cursor shown, 1000-1006 and 1015 mouse
// reports, 1004 focus reports, 2004 bracketed paste
const MODES = new Set([1, 7, 25, 1000, 1002, 1003, 1004, 1005, 1006, 1015, 2004]);
const clampInt = (v, lo, hi, def) => (Number.isInteger(v) && v >= lo && v <= hi ? v : def);

// The terminal itself, fed a piece of output at a time: createScreen(cols, rows, { maxLines }) ->
//   write(s)              plays s in (a sequence cut off at its end waits for the next write)
//   resize(cols, rows)    the pty's new size (rows at the top of a shorter screen go to the scrollback)
//   lines(lastN, join, marks) -> [line]   as render() gives them
//   serialize() -> string  output that draws this screen again in a fresh terminal of the same size: the
//                          scrollback, the screen with its colours, the scroll region, the cursor and the pen, and
//                          then the cut-off sequence write() still holds
// A mode set once (DECSET: cursor keys, bracketed paste, focus and mouse reports, the cursor shown) is kept too.
// Each cell keeps its style (an index into styles: its SGR, as "\x1b[0;…m", and its marks), so serialize() draws the
// colours too.
function createScreen(cols, rows, o = {}) {
  let W = clampInt(cols, 2, 1000, 120), Hh = clampInt(rows, 2, 500, 32);
  const MAXL = clampInt(o.maxLines, 100, 100000, 5000); // lines kept, scrollback and screen
  const blank = () => ({ c: [], a: [], w: false }); // a: each cell's style
  let main = { lines: Array.from({ length: Hh }, blank) }, alt = null;
  let L = main.lines; // the active buffer: scrollback, then the Hh rows of the screen at its end
  const styles = [{ sgr: '\x1b[0m', f: 0 }], styleOf = new Map([['', 0]]);
  // the pen: what SGR has set (colours as their own parameters, '' for the default)
  let pen = { b: 0, d: 0, i: 0, u: '', k: 0, v: 0, h: 0, s: 0, fg: '', bg: '' };
  let attr = 0; // the pen's style
  let x = 0, y = 0, wrapNext = false, top = 0, bot = Hh - 1, saved = { x: 0, y: 0 }, savedMain = null;
  let rest = ''; // a sequence the last write() ended in the middle of
  const modes = new Map(); // DECSET number -> 'h' | 'l', for the ones in MODES
  const row = (r) => L[L.length - Hh + r];
  const setRow = (r, v) => { L[L.length - Hh + r] = v; };
  const clampCur = () => { x = Math.max(0, Math.min(W - 1, x)); y = Math.max(0, Math.min(Hh - 1, y)); wrapNext = false; };
  const styleFor = (key, f) => {
    let k = styleOf.get(key);
    if (k == null) { k = styles.length; styles.push({ sgr: `\x1b[0;${key}m`, f }); styleOf.set(key, k); }
    return k;
  };
  // what an erase leaves (as xterm does it): blanks in the pen's background colour, nothing else
  const eraseAttr = () => (pen.bg ? styleFor(pen.bg, BG) : 0);
  // a new row: empty, or with a background colour set, a whole row of blanks in it
  const fresh = (w = false) => { const e = eraseAttr(); return e ? { c: Array(W).fill(' '), a: Array(W).fill(e), w } : { c: [], a: [], w }; };
  const penStyle = () => {
    const p = [];
    if (pen.b) p.push(1);
    if (pen.d) p.push(2);
    if (pen.i) p.push(3);
    if (pen.u) p.push(pen.u);
    if (pen.k) p.push(5);
    if (pen.v) p.push(7);
    if (pen.h) p.push(8);
    if (pen.s) p.push(9);
    if (pen.fg) p.push(pen.fg);
    if (pen.bg) p.push(pen.bg);
    return styleFor(p.join(';'), (pen.d ? DIM : 0) | (pen.v ? INV : 0) | (pen.bg ? BG : 0));
  };
  // the rows top..bot move up n (new blank rows at bot); the whole screen scrolling keeps the top rows as scrollback
  const scrollUp = (n) => {
    for (let k = 0; k < n; k++) {
      if (top === 0 && bot === Hh - 1 && L === main.lines) { L.push(fresh()); continue; }
      L.splice(L.length - Hh + top, 1);
      L.splice(L.length - Hh + bot + 1, 0, fresh());
    }
    if (L.length > MAXL) L.splice(0, L.length - MAXL);
  };
  const scrollDown = (n) => {
    for (let k = 0; k < n; k++) {
      L.splice(L.length - Hh + bot, 1);
      L.splice(L.length - Hh + top, 0, fresh());
    }
  };
  const lineFeed = () => { if (y === bot) scrollUp(1); else if (y < Hh - 1) y++; };
  const erase = (r, from, to) => {
    const l = row(r), e = eraseAttr(), end = e ? Math.min(to, W) : Math.min(to, l.c.length);
    if (from >= end) return;
    while (l.c.length < from) { l.c.push(' '); l.a.push(0); }
    for (let i = from; i < end; i++) { l.c[i] = ' '; l.a[i] = e; }
  };
  const put = (ch, w) => {
    if (w === 0) { const l = row(y); const i = Math.max(0, x - 1); if (l.c[i] != null) l.c[i] += ch; return; }
    if (wrapNext || (w === 2 && x === W - 1)) { x = 0; lineFeed(); row(y).w = true; wrapNext = false; }
    const l = row(y);
    while (l.c.length < x) { l.c.push(' '); l.a.push(0); }
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
  // SGR: every attribute, a colour's own parameters kept whole (38;5;n, 38;2;r;g;b, or one 38:2::r:g:b)
  const sgr = (params) => {
    const seg = params.split(';');
    for (let k = 0; k < seg.length; k++) {
      const q = seg[k] === '' ? 0 : parseInt(seg[k], 10);
      if (q === 38 || q === 48 || q === 58) {
        let v = seg[k];
        if (!/:/.test(seg[k])) {
          const m = parseInt(seg[k + 1], 10), n = m === 5 ? 2 : m === 2 ? 4 : 0;
          v = seg.slice(k, k + 1 + n).join(';');
          k += n;
        }
        if (q === 38) pen.fg = v; else if (q === 48) pen.bg = v; // 58 (the underline's colour) is not kept
        continue;
      }
      if (!Number.isFinite(q) || q === 0) pen = { b: 0, d: 0, i: 0, u: '', k: 0, v: 0, h: 0, s: 0, fg: '', bg: '' };
      else if (q === 1) pen.b = 1;
      else if (q === 2) pen.d = 1;
      else if (q === 3) pen.i = 1;
      else if (q === 4) pen.u = seg[k] === '4:0' ? '' : seg[k];
      else if (q === 21) pen.u = '21';
      else if (q === 5 || q === 6) pen.k = 1;
      else if (q === 7) pen.v = 1;
      else if (q === 8) pen.h = 1;
      else if (q === 9) pen.s = 1;
      else if (q === 22) { pen.b = 0; pen.d = 0; }
      else if (q === 23) pen.i = 0;
      else if (q === 24) pen.u = '';
      else if (q === 25) pen.k = 0;
      else if (q === 27) pen.v = 0;
      else if (q === 28) pen.h = 0;
      else if (q === 29) pen.s = 0;
      else if ((q >= 30 && q <= 37) || (q >= 90 && q <= 97)) pen.fg = String(q);
      else if (q === 39) pen.fg = '';
      else if ((q >= 40 && q <= 47) || (q >= 100 && q <= 107)) pen.bg = String(q);
      else if (q === 49) pen.bg = '';
    }
    attr = penStyle();
  };

  function write(raw) {
    const s = rest + String(raw || '');
    rest = '';
    let i = 0;
    const wait = () => { rest = s.length - i > 65536 ? '' : s.slice(i); }; // (a sequence that never ends is dropped)
    while (i < s.length) {
      const code = s.charCodeAt(i);
      if (code === 0x1b) {
        if (i + 1 >= s.length) { wait(); break; }
        const nx = s[i + 1];
        if (nx === '[') {
          // CSI: parameters, intermediates, one final byte
          let j = i + 2;
          while (j < s.length && s.charCodeAt(j) >= 0x30 && s.charCodeAt(j) <= 0x3f) j++;
          const params = s.slice(i + 2, j);
          while (j < s.length && s.charCodeAt(j) >= 0x20 && s.charCodeAt(j) <= 0x2f) j++;
          if (j >= s.length) { wait(); break; }
          const fin = s[j];
          i = j + 1;
          const priv = /^[?<=>]/.test(params);
          const ps = (priv ? params.slice(1) : params).split(';').map((p) => (p === '' ? NaN : parseInt(p, 10)));
          const p1 = Number.isFinite(ps[0]) ? ps[0] : 0, n = Math.max(1, p1);
          if (priv) {
            if ((fin === 'h' || fin === 'l') && params[0] === '?') for (const p of ps) if (MODES.has(p)) modes.set(p, fin);
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
              if (p1 === 0) { erase(y, x, W); for (let r = y + 1; r < Hh; r++) setRow(r, fresh()); }
              else if (p1 === 1) { erase(y, 0, x + 1); for (let r = 0; r < y; r++) setRow(r, fresh()); }
              else if (p1 === 2) { for (let r = 0; r < Hh; r++) setRow(r, fresh()); }
              else if (p1 === 3) { if (L.length > Hh) L.splice(0, L.length - Hh); }
              wrapNext = false;
              break;
            case 'K':
              if (p1 === 0) erase(y, x, W); else if (p1 === 1) erase(y, 0, x + 1); else if (p1 === 2) setRow(y, fresh(row(y).w));
              wrapNext = false;
              break;
            case 'X': erase(y, x, x + n); wrapNext = false; break;
            case 'P': { const l = row(y), e = eraseAttr(); l.c.splice(x, n); l.a.splice(x, n); if (e) while (l.c.length < W) { l.c.push(' '); l.a.push(e); } wrapNext = false; break; }
            case '@': { const l = row(y); if (l.c.length > x) { l.c.splice(x, 0, ...Array(n).fill(' ')); l.c.length = Math.min(l.c.length, W); l.a.splice(x, 0, ...Array(n).fill(eraseAttr())); l.a.length = Math.min(l.a.length, W); } wrapNext = false; break; }
            case 'L': if (y >= top && y <= bot) { const t0 = top; top = y; scrollDown(Math.min(n, bot - y + 1)); top = t0; } x = 0; wrapNext = false; break;
            case 'M': if (y >= top && y <= bot) { const t0 = top; top = y; for (let k = 0; k < Math.min(n, bot - y + 1); k++) { L.splice(L.length - Hh + top, 1); L.splice(L.length - Hh + bot + 1, 0, fresh()); } top = t0; } x = 0; wrapNext = false; break;
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
            case 'm': sgr(params); break;
            default: break; // the rest draw nothing
          }
          continue;
        }
        if (nx === ']') { // OSC: up to BEL or ST
          const a = s.indexOf('\x07', i + 2), b = s.indexOf('\x1b\\', i + 2);
          const end = a < 0 ? b : b < 0 ? a : Math.min(a, b);
          if (end < 0) { wait(); break; }
          i = end + (end === b ? 2 : 1);
          continue;
        }
        if (nx === 'P' || nx === 'X' || nx === '^' || nx === '_') { const e = s.indexOf('\x1b\\', i + 2); if (e < 0) { wait(); break; } i = e + 2; continue; }
        if (nx === '(' || nx === ')' || nx === '*' || nx === '+' || nx === '#' || nx === '%') { if (i + 2 >= s.length) { wait(); break; } i += 3; continue; }
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
      if (code >= 0xd800 && code <= 0xdbff && i + 1 >= s.length) { wait(); break; } // half of a pair: the rest comes next
      const cp = s.codePointAt(i);
      const ch = String.fromCodePoint(cp);
      i += ch.length;
      put(ch, widthOf(cp));
    }
    return api;
  }

  function resize(c, r) {
    const nc = clampInt(c, 2, 1000, W), nr = clampInt(r, 2, 500, Hh);
    for (const b of [main, alt]) {
      if (!b) continue;
      if (nr > Hh) for (let k = Hh; k < nr; k++) b.lines.push(blank());
      else if (nr < Hh && b === alt) b.lines.splice(0, Hh - nr); // the alternate screen keeps no scrollback
    }
    if (nr < Hh) { y = Math.max(0, y - (Hh - nr)); if (savedMain) savedMain.y = Math.max(0, savedMain.y - (Hh - nr)); }
    W = nc; Hh = nr; top = 0; bot = Hh - 1;
    if (savedMain) { savedMain.top = 0; savedMain.bot = Hh - 1; }
    clampCur();
    return api;
  }

  function lines(lastN = 40, join = true, marks = false) {
    const out = [];
    for (const l of L) {
      let text = '';
      if (!marks) text = l.c.map((c) => (c == null ? ' ' : c)).join('');
      else {
        // what reads as highlighted (\x01…\x02) and as dim (\x03…\x04): 'bg' counts a background colour too, and no dim
        const HL = marks === 'bg' ? INV | BG : INV, DM = marks === 'bg' ? 0 : DIM;
        let on = 0;
        for (let k = 0; k < l.c.length; k++) {
          const v = l.c[k] == null ? 0 : styles[l.a[k] || 0].f;
          if ((on & DM) && !(v & DM)) text += '\x04';
          if (!(on & HL) !== !(v & HL)) text += v & HL ? '\x01' : '\x02';
          if ((v & DM) && !(on & DM)) text += '\x03';
          on = v;
          text += l.c[k] == null ? ' ' : l.c[k];
        }
        if (on & DM) text += '\x04';
        if (on & HL) text += '\x02';
      }
      text = text.replace(/\s+$/, '');
      if (join && l.w && out.length) out[out.length - 1] += text; else out.push(text);
    }
    while (out.length && !out[out.length - 1].replace(/[\x01-\x04]/g, '').trim()) out.pop();
    return out.slice(-lastN);
  }

  // one row as output: each style change, then its characters (trailing default blanks left out; full: padded to
  // the width, so the row after it, wrapped, follows on its own)
  const rowOut = (l, full) => {
    let end = l.c.length;
    if (!full) while (end > 0 && (l.c[end - 1] == null || l.c[end - 1] === ' ') && !(l.a[end - 1] || 0)) end--;
    let s = '', cur = 0;
    for (let k = 0; k < end; k++) {
      const ch = l.c[k];
      if (ch === '') continue; // the second half of a wide character
      const a = ch == null ? 0 : l.a[k] || 0;
      if (a !== cur) { s += styles[a].sgr; cur = a; }
      s += ch == null ? ' ' : ch;
    }
    if (cur) s += '\x1b[0m';
    if (full && end < W) s += ' '.repeat(W - end);
    return s;
  };
  function serialize() {
    let s = '\x1b[0m';
    const M = main.lines;
    for (const [n, v] of modes) s += `\x1b[?${n}${v}`;
    // a wrapped row follows the one before it (padded to the width) with no new line, unless it is empty
    for (let k = 0; k < M.length; k++) {
      const r = rowOut(M[k], k + 1 < M.length && M[k + 1].w);
      if (k) s += M[k].w && r ? '' : '\r\n';
      s += r;
    }
    if (alt) {
      s += '\x1b[?1049h\x1b[H\x1b[2J';
      for (let r = 0; r < Hh; r++) s += `\x1b[${r + 1};1H${rowOut(alt.lines[r], false)}`;
    }
    if (top !== 0 || bot !== Hh - 1) s += `\x1b[${top + 1};${bot + 1}r`;
    s += `\x1b[${y + 1};${x + 1}H${styles[attr].sgr}`;
    return s + rest;
  }

  const api = { write, resize, lines, serialize, size: () => ({ cols: W, rows: Hh }) };
  return api;
}

function render(raw, cols, rows, lastN = 40, join = true, marks = false) {
  return createScreen(cols, rows).write(raw).lines(lastN, join, marks);
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
// A choice drawn on one line: an MCP server's elicitation dialog (2.1.296: "❯ Accept    Decline" over "Esc to cancel ·
// ↑/↓ to navigate"). Read strictly, so a reply or the prompt box never reads as one: two to six labels 2+ spaces apart,
// one ❯ at the line's start or (the pointer moved) right before a later label, its keys line within 3 lines under it,
// and a line of its own above it that is no rule (the prompt box's ❯ sits right under one). -> its labels numbered 1..k
// in screen order, the one after the ❯ on, or null
const INLINE_KEYS = /\bEsc to cancel\b|[↑←]\/[↓→] to (?:navigate|select)\b/i;
function inlineRun(L, raw, start) {
  let h = L.length - 1;
  while (h >= start && !INLINE_KEYS.test(L[h])) h--;
  if (h < start) return null;
  let e = h - 1;
  while (e >= Math.max(start, h - 3) && !L[e].trim()) e--;
  if (e < Math.max(start, h - 3)) return null;
  const l = L[e];
  if (OPT_RE.test(l) || (l.match(/❯/g) || []).length !== 1 || !/^(?:\s{0,2}❯ |\s{1,4}[^\s❯›])/.test(l)) return null;
  const parts = l.trim().split(/\s{2,}/);
  if (parts.length < 2 || parts.length > 6) return null;
  const got = [];
  for (const p of parts) {
    const q = /^(❯ )?([^\s❯›].{0,39})$/.exec(p);
    if (!q) return null;
    got.push({ i: e, on: !!q[1], label: q[2], col: l.indexOf(p) + (q[1] ? 2 : 0), boxed: /^\s*[│┃]/.test(raw[e]) });
  }
  if (got.filter((o) => o.on).length !== 1) return null;
  let k = e - 1;
  while (k >= start && !L[k].trim()) k--;
  if (k < start || isRule(L[k]) || isBoxEdge(L[k])) return null;
  // a list in a command's panel (its ▔ edge above, no rule between): the panel reader's, not a menu
  for (let i = e - 1; i >= start && !isRule(L[i]); i--) if (/^\s*▔{12,}\s*$/.test(L[i])) return null;
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
//                "Do you want to create x?", or a "Yes, and don't ask again" / "Yes, allow" option), and an MCP
//                server's elicitation ("MCP server “x” requests your input": its Accept may run what it asks)
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
    || labels.some((l) => /^Yes, (?:and don't ask again|allow)\b/i.test(l))
    || /^\s*MCP server\b.*\brequests your input\b/im.test(all)) return 'permission';
  if (/^Ready to submit your answers\?/i.test(title) || labels.some((l) => /^(?:Type something\.?|Chat about this)$/i.test(l))
    || above.some((l) => /^\s*(?:←\s*)?[☐☒✔]/.test(l) && /[☐☒]\s*\S/.test(l) && /✔\s*Submit\s*(?:→\s*)?$/.test(l))
    // one question's header alone ("☐ Layout"), as one with option previews shows it (no "Type something" there)
    || above.some((l) => /^\s*[☐☒]\s+\S.{0,40}$/.test(l) && !/[│┃]/.test(l))) return 'question';
  return 'other';
}

// A select menu at the bottom of the screen: Claude Code's permission prompts, AskUserQuestion, the plan
// approval, the folder trust question, an MCP server's elicitation. Only when at least two options numbered one after
// another sit in the last ~30 non-empty lines and one of them carries the ❯ pointer (or, with none numbered, an
// unnumbered menu as plainRun or inlineRun reads it: its options are numbered 1..k here and it is marked unnumbered); the prompt box (❯ under a rule, where a typed
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
  // or all on one line (an MCP server's elicitation), the same way: ↑/↓ walks it, as its keys line says
  if (!run && (run = inlineRun(L, raw, start))) unnumbered = true;
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
const dropDim = (l, first, lead = '[❯>]') => (first ? l.replace(new RegExp(`^(\\s*${lead}\\s?)\\x01[^\\x02]\\x02(?=\\x03)`), '$1') : l)
  .replace(/\x03[^\x04]*(\x04|$)/g, '').replace(/[\x01-\x04]/g, '');
// the background agents Claude Code lists under its footer ("● main", a row per agent): where the rows end without it
const AGENT_ROW = /^\s*[●◯]\s+\S/;
function agentListStart(L) {
  let e = L.length;
  while (e > 0 && (AGENT_ROW.test(L[e - 1]) || !L[e - 1].trim())) e--;
  return L.slice(e).some((l) => /^\s*●\s+main\b/.test(l)) ? e : L.length;
}
// lead: the box's prefix, "❯" (or ">" in older versions), or "!" in bash mode (bashBox)
function boxWith(lines, lead) {
  const M = (Array.isArray(lines) ? lines : []).map((l) => String(l ?? ''));
  const L = M.map((l) => l.replace(/[\x01-\x04]/g, ''));
  const end = agentListStart(L);
  let b = end - 1;
  while (b >= Math.max(0, end - 6) && !isRule(L[b])) b--;
  if (b < 1 || !isRule(L[b])) return null;
  let a = b - 1;
  while (a >= 0 && !isRule(L[a])) a--;
  if (a < 0 || b - a < 2 || !new RegExp(`^\\s*${lead}(\\s|$)`).test(L[a + 1])) return null;
  const rows = M.slice(a + 1, b).map((l, k) => dropDim(l, !k, lead));
  const text = rows.map((l, i) => (i ? l.replace(/^ {2}/, '') : l.replace(new RegExp(`^\\s*${lead}\\s?`), '')).trimEnd()).join('\n').trim();
  return { text: BOX_HINT.test(text) ? '' : text, lines: rows.length };
}
const promptBox = (lines) => boxWith(lines, '[❯>]');
// The box in bash mode: Claude Code draws its prefix "!" instead of the ❯ once a "!" typed into an empty box switched it
// (its binary: mode "bash" -> "!"), and the text after it is the shell command. -> { text, lines } or null (not in bash
// mode, or not on screen). promptBox reads null for it, so nothing that types a message ever types into bash mode
const bashBox = (lines) => boxWith(lines, '!');
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

// parseMode: the permission mode, from the footer under the prompt: 'bypass', 'acceptEdits', 'plan', 'auto', 'default'
// (no mode line, but the prompt or "? for shortcuts" is there), or null when the footer isn't on screen (a menu covers
// it)
function modeShown(lines) {
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
// the tick's bgHint: a shell command Claude runs that can go to the background ("ctrl+b to run in background" on
// screen). Only worth anything while Claude works (the caller checks)
const bgOffered = (lines) => (Array.isArray(lines) ? lines : []).some((l) => /ctrl\+b\b/i.test(String(l ?? '')) && /\bbackground\b/i.test(String(l ?? '')));

// parseRewind: /rewind's list ("Restore the code and/or conversation to the point before…", its entries newest at the
// bottom, "(current)" last): the entry the ❯ is on, and a signature of where it is (the ❯'s row and the "↑ N more"
// above it), so a press of ↑ that moved nothing shows. -> { sel, sig }, or null when the list isn't on screen
function rewindList(lines) {
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
// rewindMatches: does a /rewind entry ("Reply ALPHA.…", the message's first line cut to the width) show this message?
// Never the "(current)" entry
const flatText = (v) => String(v || '').replace(/\[Image #\d+\]\s*/g, '').replace(/\s+/g, ' ').trim();
function rewindMatches(sel, text) {
  const e = flatText(sel).replace(/…$/, '').trim(), t = flatText(String(text || '').split('\n')[0]);
  if (!e || e === '(current)') return false;
  return t === e || (t.startsWith(e) && /…$/.test(String(sel).trim()));
}

// parsePanel: a command's panel, what /usage, /status, /config, /help, /mcp, /permissions, /theme, /resume and the like
// draw in place of the prompt. Claude Code edges it with a full-width ▔ line on top and names its keys inside it ("Esc
// to cancel", "↑/↓ to navigate · Enter to confirm · Esc to cancel"), with no prompt box under it; a tall one scrolls
// within itself ("↓ 20 more"), so it fits the screen. lines may carry render's 'bg' marks (\x01…\x02): the tab row's
// marked word is the tab it shows. o.loose: the keys line may be missing (a tab still loading, of a panel already known
// to be up). -> { title, tabs: [{ label, on }], body: [lines], keys, sig } or null
const PANEL_TOP = /^\s*▔{12,}\s*$/;
const PANEL_ESC = /\besc to (?:cancel|close|clear|go back|exit|quit)\b/i;
const unmark = (l) => String(l ?? '').replace(/[\x01\x02]/g, '');
function panelDetails(lines, o = {}) {
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
// over the rows as drawn (a buffer row each, as the page's screenMarked reads them), the last PANEL_LINES of them: a
// command's panel can fill a tall screen
const PANEL_LINES = 80;
const panelShown = (raw, cols, rows, o) => panelDetails(render(raw, cols, rows, PANEL_LINES, false, 'bg'), o);

module.exports = { render, createScreen, menuIn, menuShown, menuDetails, menuDetailsShown, widthOf, promptBox, bashBox, spinner, effortShown, modeShown, bgOffered, rewindList, rewindMatches,
  panelDetails, panelShown };
