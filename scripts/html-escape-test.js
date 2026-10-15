// The page's HTML builders escape what they put in: a test, run with the system node:   node scripts/html-escape-test.js
// web/*.js build much of the page as HTML strings (innerHTML), each name, title and message going in through esc().
// One that slips past it lets a name with " or < in it (a team or bot name any Claude session can set with `fv`) add
// its own attributes or tags, and so run script in a page that can type into every terminal. This reads every
// template literal in web/*.js that holds markup (an HTML or SVG tag, or an attribute opening right before a ${...})
// and checks each ${...} in it: esc(...), a number, a literal, a constant, a nested template whose own ${...} pass, a
// ternary / || / && / + of those, a name by what it was set to (and what was pushed onto it), a function of the same
// file by what it returns, a list by what is in it (.map(...).join(...)). What it fails on is a field read straight
// into the markup (c.name, par.name, x[0]) or text made from one (.slice, .trim, .join(', '), String(...)), unless the
// field is a count (.length, .size) or listed in OK below after a look. Helpers from other files (icon, acctTag) and
// parameters it can't follow are let through: their own templates are checked where they are written.
//   --list   also print what it let through as a helper call or a name it could not follow, to look over by hand
// Exit 0 = nothing unescaped.
'use strict';
const fs = require('fs');
const path = require('path');

const WEB = path.resolve(__dirname, '..', 'web');
const LIST = process.argv.includes('--list');

// fields looked at and safe in that file, though the rule can't tell: "<file>: <field>" -> why
const OK = new Map([
  ['app.js: wk[a].left', 'a percentage the server works out from the plan usage'],
  ['app.js: h.level', 'only drawn when SYNC_TINT has that level'],
  ['app.js: state.hiddenDone', 'a count'],
  ['botnote.js: n.face', 'markup by design: mascotSVG() of the bot'],
  ['changes.js: f.added', 'a count from the server\'s diff'],
  ['changes.js: f.removed', 'a count from the server\'s diff'],
  ['changes.js: r.a', 'a line number from the server\'s diff'],
  ['changes.js: r.b', 'a line number from the server\'s diff'],
  ['changes.js: row.a', 'a line number from the server\'s diff'],
  ['changes.js: row.b', 'a line number from the server\'s diff'],
  ['changes.js: f.hunks?.[0]?.lines?.find((r) => r.b)?.b', 'a line number from the server\'s diff'],
  ['chat.js: n.add', 'a count (diffCount)'],
  ['chat.js: n.del', 'a count (diffCount)'],
  ['chat.js: c.bgOpen', 'a boolean'],
  ['chats.js: node.depth', 'a number (contactTree)'],
  ['chats.js: head.open', 'a count (tasksHead)'],
  ['compose.js: a.key', 'a key this file makes (a1, a2...)'],
  ['compose.js: e.key', 'a key this file makes'],
  ['compose.js: o.n', 'an option\'s number: +digits from the screen, or its place'],
  ['compose.js: t.on', 'a boolean'],
  ['compose.js: m.k', 'a key of MODES'],
  ['ctxmenu.js: it.art', 'markup by design (openCtxMenu\'s art: built with esc by each caller)'],
  ['ctxmenu.js: spec.art', 'markup by design (openCtxMenu\'s art: built with esc by each caller)'],
  ['ctxmenu.js: a.key', 'a key this file makes'],
  ['detail.js: p.attr', 'an attribute written in this file (pinOf: esc(s.id) inside)'],
  ['detail.js: p.on', 'a boolean'],
  ['detail.js: list.start', 'a number'],
  ['housekeeping.js: g.v', 'a group of GROUPS'],
  ['housekeeping.js: g.label', 'a group of GROUPS'],
  ['housekeeping.js: report.lastRun.removed', 'a count'],
  ['housekeeping.js: report.lastRun.failed', 'a count'],
  ['keeps.js: p.k', 'a key of PIN_ON'],
  ['mascot.js: b.d', 'path data from the shapes table'],
  ['mini.js: c.live', 'a count'],
  ['mini.js: c.waiting', 'a count'],
  ['phone.js: code.svg', 'the QR code SVG relay.js draws (qrSvg)'],
  ['picker.js: o.grid', 'a number of columns'],
  ['picker.js: c.btn', 'markup by design (mountPicker\'s btn: built with esc by each caller)'],
  ['picker.js: x.art', 'markup by design (mountPicker\'s art)'],
  ['picker.js: x.html', 'markup by design (mountPicker\'s html)'],
  ['update.js: st.behind', 'a count of commits'],
  ['usage.js: b.here', 'a number'],
  ['usage.js: b.away', 'a number'],
  ['usage.js: u.away5', 'a number'],
]);
const okUsed = new Set();

// ---------- a small JS lexer: every template literal, with its text parts and its ${...} sources ----------
const KEYWORDS_BEFORE_REGEX = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
function lex(src) {
  const out = [];
  const lineAt = (i) => { let n = 1; for (let k = 0; k < i; k++) if (src.charCodeAt(k) === 10) n++; return n; };
  function skipString(i, q) {
    for (i++; i < src.length; i++) { if (src[i] === '\\') i++; else if (src[i] === q) return i + 1; }
    return i;
  }
  function skipRegex(i) {
    let cls = false;
    for (i++; i < src.length; i++) {
      const c = src[i];
      if (c === '\\') i++;
      else if (c === '[') cls = true;
      else if (c === ']') cls = false;
      else if (c === '/' && !cls) { i++; break; }
      else if (c === '\n') break;
    }
    while (i < src.length && /[a-z]/i.test(src[i])) i++;
    return i;
  }
  // code up to an unmatched } (stop) or the end; returns where it stopped
  function code(i, stop) {
    let depth = 0, prev = null; // prev: the last token, to tell a regex from a division
    while (i < src.length) {
      const c = src[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
      if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
      if (c === '"' || c === "'") { i = skipString(i, c); prev = 'v'; continue; }
      if (c === '`') { i = template(i); prev = 'v'; continue; }
      if (c === '/') {
        const regexOk = prev === null || (prev.length === 1 && !/[)\]}v]/.test(prev)) || KEYWORDS_BEFORE_REGEX.has(prev);
        if (regexOk) { i = skipRegex(i); prev = 'v'; continue; }
        i++; prev = '/'; continue;
      }
      if (c === '{') { depth++; i++; prev = '{'; continue; }
      if (c === '}') { if (!depth && stop) return i; depth--; i++; prev = '}'; continue; }
      if (/[A-Za-z_$0-9]/.test(c)) {
        let j = i;
        while (j < src.length && /[A-Za-z_$0-9]/.test(src[j])) j++;
        const w = src.slice(i, j);
        prev = KEYWORDS_BEFORE_REGEX.has(w) ? w : 'v';
        i = j; continue;
      }
      prev = c; i++;
    }
    return i;
  }
  function template(i) {
    const t = { at: i, line: lineAt(i), quasis: [], exprs: [] };
    out.push(t);
    let cur = '';
    for (i++; i < src.length; i++) {
      const c = src[i];
      if (c === '\\') { cur += c + (src[i + 1] || ''); i++; continue; }
      if (c === '`') { t.quasis.push(cur); return i + 1; }
      if (c === '$' && src[i + 1] === '{') {
        t.quasis.push(cur); cur = '';
        const e = code(i + 2, true);
        t.exprs.push(src.slice(i + 2, e));
        i = e;
        continue;
      }
      cur += c;
    }
    t.quasis.push(cur);
    return i;
  }
  code(0, false);
  return out;
}

// ---------- is a ${...} safe in markup? ----------
// every character of an expression outside strings, templates and regexes, with its bracket depth (before it, for an
// opener; after it, for a closer); visit returning false stops it
function walk(e, visit) {
  let depth = 0, prev = null;
  for (let i = 0; i < e.length; i++) {
    const c = e[i];
    if (c === '"' || c === "'") { for (i++; i < e.length; i++) { if (e[i] === '\\') i++; else if (e[i] === c) break; } prev = 'v'; continue; }
    if (c === '`') {
      // skipped whole (a template's ${...} are looked at on their own)
      let d = 0;
      for (i++; i < e.length; i++) { if (e[i] === '\\') i++; else if (e[i] === '$' && e[i + 1] === '{') { d++; i++; } else if (e[i] === '}' && d) d--; else if (e[i] === '`' && !d) break; }
      prev = 'v'; continue;
    }
    if (c === '/' && e[i + 1] === '/') { while (i + 1 < e.length && e[i + 1] !== '\n') i++; continue; }
    if (c === '/' && e[i + 1] === '*') { const end = e.indexOf('*/', i + 2); i = end < 0 ? e.length : end + 1; continue; }
    if (c === '/' && (prev === null || (prev.length === 1 && !/[)\]}v]/.test(prev)) || KEYWORDS_BEFORE_REGEX.has(prev))) {
      let cls = false;
      for (i++; i < e.length; i++) { if (e[i] === '\\') i++; else if (e[i] === '[') cls = true; else if (e[i] === ']') cls = false; else if (e[i] === '/' && !cls) break; }
      while (/[a-z]/i.test(e[i + 1] || '')) i++;
      prev = 'v'; continue;
    }
    if (/\s/.test(c)) { if (visit(i, c, depth) === false) return; continue; }
    if (/[\w$]/.test(c)) {
      let j = i;
      while (j + 1 < e.length && /[\w$]/.test(e[j + 1])) j++;
      const w = e.slice(i, j + 1);
      prev = KEYWORDS_BEFORE_REGEX.has(w) ? w : 'v';
      for (let k = i; k <= j; k++) if (visit(k, e[k], depth) === false) return;
      i = j; continue;
    }
    if ('([{'.includes(c)) { if (visit(i, c, depth) === false) return; depth++; prev = c; continue; }
    if (')]}'.includes(c)) { depth--; prev = c; if (visit(i, c, depth) === false) return; continue; }
    prev = c;
    if (visit(i, c, depth) === false) return;
  }
}
// the top level of an expression: depth 0, outside brackets, strings, templates and regexes
const topLevel = (e, visit) => walk(e, (i, c, depth) => (depth || '([{)]}'.includes(c) ? undefined : visit(i, c)));
// the matching closer of the bracket at i, or -1
function closer(e, i) {
  let r = -1, at = -1;
  walk(e, (k, c, depth) => {
    if (k === i) at = depth;
    else if (at >= 0 && k > i && depth === at && ')]}'.includes(c)) { r = k; return false; }
  });
  return r;
}
const wrapped = (e) => e[0] === '(' && closer(e, 0) === e.length - 1;
// split at a top-level binary operator (op: a string); null when it isn't there
function splitAt(e, op) {
  const parts = [];
  let last = 0;
  topLevel(e, (i) => {
    if (e.startsWith(op, i)) {
      const before = e[i - 1], after = e[i + op.length];
      if (op === '+' && (before === '+' || after === '+' || after === '=')) return;
      if (op === '+' && !e.slice(last, i).trim()) return; // unary +
      if ((op === '||' || op === '&&' || op === '??') && after === '=') return;
      parts.push(e.slice(last, i));
      last = i + op.length;
    }
  });
  if (!parts.length) return null;
  parts.push(e.slice(last));
  return parts.map((p) => p.trim());
}
// a ternary's condition and two branches, or null
function ternary(e) {
  let q = -1;
  topLevel(e, (i, c) => {
    if (c === '?' && e[i + 1] !== '.' && e[i + 1] !== '?' && e[i - 1] !== '?') { q = i; return false; }
  });
  if (q < 0) return null;
  // its : at the same level, past any ternary nested in the true branch
  let nest = 0, colon = -1;
  const rest = e.slice(q + 1);
  topLevel(rest, (i, c) => {
    if (c === '?' && rest[i + 1] !== '.' && rest[i + 1] !== '?' && rest[i - 1] !== '?') nest++;
    else if (c === ':') { if (nest) nest--; else { colon = i; return false; } }
  });
  if (colon < 0) return null;
  return [e.slice(0, q).trim(), rest.slice(0, colon).trim(), rest.slice(colon + 1).trim()];
}

const NUMBER_FNS = /^(Number|parseInt|parseFloat|Math\.[a-z0-9]+|isFinite|Boolean)\(/i;
const SAFE_FNS = /^(esc|escAttr|escHtml|encodeURIComponent|encodeURI)\(/;
// text (or a list) made of what they are called on and their arguments
const TEXT_METHODS = new Set(['slice', 'substring', 'substr', 'trim', 'trimStart', 'trimEnd', 'toLowerCase', 'toUpperCase', 'replace', 'replaceAll', 'padStart', 'padEnd', 'toString', 'concat', 'at', 'charAt', 'repeat', 'normalize']);
const ARRAY_METHODS = new Set(['map', 'flatMap', 'filter', 'sort', 'reverse', 'flat']);
// a field that holds a number or a boolean wherever it is read here
const COUNT_FIELDS = /\.(length|size)$/;

// split at a top-level separator (',' or ':')
function splitTop(e, sep) {
  const out = [];
  let last = 0;
  topLevel(e, (i, c) => { if (c === sep) { out.push(e.slice(last, i).trim()); last = i + 1; } });
  out.push(e.slice(last).trim());
  return out.filter((x, i) => x || i < out.length - 1);
}
// R.m(args) with its ( closing at the end of e: { recv, method, args }, or null
function methodCall(e) {
  if (!e.endsWith(')')) return null;
  let open = -1;
  const stack = [];
  walk(e, (i, c) => { if ('([{'.includes(c)) stack.push(i); else if (')]}'.includes(c)) { const o = stack.pop(); if (i === e.length - 1) open = o; } });
  if (open < 0) return null;
  const m = /\??\.\s*([A-Za-z_$][\w$]*)\s*$/.exec(e.slice(0, open));
  if (!m) return null;
  return { recv: e.slice(0, open - m[0].length).trim(), method: m[1], args: splitTop(e.slice(open + 1, -1), ',').filter(Boolean) };
}
const isFn = (a) => /^(async\s*)?(\([^()]*\)|[\w$]+)\s*=>/.test(a) || /^function\b/.test(a);
// what a callback written in place gives: its expression, or each return in its block
function fnBody(f, seen, ctx) {
  const r = returnsOf(`const __fn = ${f}`, 0, '__fn');
  if (!r) { seen.push(f); return []; }
  const names = new Set([...(ctx ? ctx.names : []), ...r.names]);
  return r.rets.flatMap((x) => check(x.e, seen, ctx && { ...ctx, names, depth: ctx.depth + 1 }));
}
// a list joined into the markup: each thing in it has to pass
function checkList(e, seen, ctx) {
  e = e.trim();
  while (wrapped(e)) e = e.slice(1, -1).trim();
  if (e[0] === '[' && closer(e, 0) === e.length - 1) {
    return splitTop(e.slice(1, -1), ',').flatMap((x) => (x.startsWith('...') ? checkList(x.slice(3), seen, ctx) : check(x, seen, ctx)));
  }
  const mc = methodCall(e);
  if (mc && (mc.method === 'map' || mc.method === 'flatMap') && mc.args.length) {
    const f = mc.args[0];
    if (isFn(f)) return fnBody(f, seen, ctx);
    if (SAFE_FNS.test(`${f}(`) || NUMBER_FNS.test(`${f}(`)) return [];
    return check(`${f}()`, seen, ctx);
  }
  if (mc && ARRAY_METHODS.has(mc.method)) return checkList(mc.recv, seen, ctx);
  if (mc && mc.method === 'concat') return [...checkList(mc.recv, seen, ctx), ...mc.args.flatMap((a) => checkList(a, seen, ctx))];
  if (mc && mc.method === 'slice') return checkList(mc.recv, seen, ctx);
  if (/^[A-Za-z_$][\w$]*$/.test(e)) {
    if (/^[A-Z][A-Z0-9_]*$/.test(e)) return [];
    const init = ctx && !ctx.names.has(e) && ctx.depth < 6 ? initOf(ctx.src, ctx.at, e) : null;
    if (init == null) { seen.push(e); return []; }
    // and what is pushed onto it before the template
    const sub = { ...ctx, names: new Set(ctx.names).add(e), depth: ctx.depth + 1 };
    const pushed = [];
    const re = new RegExp(`\\b${e.replace(/\$/g, '\\$')}\\.(push|unshift)\\(`, 'g');
    for (let m; (m = re.exec(ctx.src)) && m.index < ctx.at;) {
      if (m.index < init.from) continue;
      const open = m.index + m[0].length - 1, end = closer(ctx.src.slice(open, open + 4000), 0);
      if (end > 0) pushed.push(...splitTop(ctx.src.slice(open + 1, open + end), ','));
    }
    const bad = [...checkList(init.e, seen, sub), ...pushed.flatMap((x) => (x.startsWith('...') ? checkList(x.slice(3), seen, sub) : check(x, seen, { ...sub, at: ctx.at })))];
    return bad.length ? [`${e} = ${bad.join(' | ')}`] : [];
  }
  seen.push(e);
  return [];
}

// what the name was set to by its nearest `const|let|var name =` (or `, name =` in one) before at in src whose block
// is still open at at, or null
function initOf(src, at, name) {
  const re = new RegExp(`(?:\\b(?:const|let|var)\\s+|,\\s*)${name.replace(/\$/g, '\\$')}\\s*=(?![=>])`, 'g');
  const found = [];
  for (let m; (m = re.exec(src)) && m.index < at;) found.push(m.index + m[0].length);
  const open = (i) => { let shut = false; walk(src.slice(i, at), (k, c, depth) => { if (depth < 0) { shut = true; return false; } }); return !shut; };
  let from = -1;
  for (let k = found.length - 1; k >= 0 && from < 0; k--) if (open(found[k])) from = found[k];
  if (from < 0) return null;
  return { e: exprAt(src, from), from };
}
// the expression starting at from: up to a top-level ; or , or a line break the next line does not carry on from
function exprAt(src, from) {
  const s = src.slice(from, from + 4000);
  let end = s.length;
  walk(s, (i, c, depth) => {
    if (depth < 0 || (!depth && (c === ';' || c === ','))) { end = i; return false; }
    if (!depth && c === '\n' && !/^(\s*\/\/[^\n]*\n)*\s*([?:+.|&]|\$\{)/.test(s.slice(i + 1))) { end = i; return false; }
  });
  return s.slice(0, end).trim();
}
// what a function of this file returns: { names (its parameters), rets: [{ e, at }] } for `function name(...)` or
// `const name = (...) =>` (the nearest one before at, else the first), or null when it is not defined here
function returnsOf(src, at, name) {
  const n = name.replace(/\$/g, '\\$');
  const re = new RegExp(`\\bfunction\\s+${n}\\s*\\(|\\b(?:const|let|var)\\s+${n}\\s*=\\s*(?:async\\s*)?(?=\\(|[\\w$]+\\s*=>)`, 'g');
  let pick = null;
  for (let m; (m = re.exec(src));) { if (!pick || m.index < at) pick = m; if (m.index >= at) break; }
  if (!pick) return null;
  let i = pick.index + pick[0].length, params;
  if (pick[0].startsWith('function')) i--;
  if (src[i] === '(') {
    const end = closer(src.slice(i, i + 2000), 0);
    if (end < 0) return null;
    params = src.slice(i + 1, i + end);
    i += end + 1;
  } else { params = /^[\w$]+/.exec(src.slice(i))[0]; i += params.length; }
  const arrow = /^\s*=>\s*/.exec(src.slice(i));
  if (arrow) i += arrow[0].length;
  else if (!pick[0].startsWith('function')) return null;
  while (/\s/.test(src[i])) i++;
  const names = params.match(/[A-Za-z_$][\w$]*/g) || [];
  if (src[i] !== '{') return { names, rets: [{ e: exprAt(src, i), at: i }] };
  const end = closer(src.slice(i, i + 200000), 0);
  if (end < 0) return null;
  const body = src.slice(i, i + end), rets = [];
  for (const m of body.matchAll(/\breturn\b[ \t]*(?![;\n}])/g)) rets.push({ e: exprAt(src, i + m.index + m[0].length), at: i + m.index });
  return { names, rets };
}

// the expression without its // and /* */ comments
function noComments(e) {
  if (!e.includes('//') && !e.includes('/*')) return e;
  let out = '', q = null, depth = 0;
  for (let i = 0; i < e.length; i++) {
    const c = e[i];
    if (q) {
      out += c;
      if (c === '\\') { out += e[++i] || ''; continue; }
      if (q === '`' && c === '$' && e[i + 1] === '{') { out += '{'; i++; depth++; q = null; continue; }
      if (c === q) q = null;
      continue;
    }
    if (c === '/' && e[i + 1] === '/') { while (i + 1 < e.length && e[i + 1] !== '\n') i++; continue; }
    if (c === '/' && e[i + 1] === '*') { const end = e.indexOf('*/', i + 2); i = end < 0 ? e.length : end + 1; continue; }
    if (c === '"' || c === "'" || c === '`') q = c;
    else if (c === '}' && depth) { depth--; q = '`'; }
    out += c;
  }
  return out;
}

// returns [] when safe, else the parts that are not; notes (plain names, helper calls) go to seen.
// ctx: { src, at, names, depth }: the file and the template's place in it, to look plain names up (not those in
// names: a callback's own parameters, or one being looked up already)
function check(e, seen, ctx) {
  e = noComments(e).trim();
  while (wrapped(e)) e = e.slice(1, -1).trim();
  if (!e) return [];
  const t = ternary(e);
  if (t) {
    // a branch that is the very value the condition just checked against a pattern or a list (RE.test(x) ? x : ...)
    const checked = (b) => { const m = /^(?:String\()?([A-Za-z_$][\w$.?]*)/.exec(b); return !!m && /\.(test|includes|has)\(/.test(t[0]) && t[0].includes(m[1]); };
    return [...(checked(t[1]) ? [] : check(t[1], seen, ctx)), ...check(t[2], seen, ctx)];
  }
  for (const op of ['||', '??']) { const p = splitAt(e, op); if (p) return p.flatMap((x) => check(x, seen, ctx)); }
  { const p = splitAt(e, '&&'); if (p) return check(p[p.length - 1], seen, ctx); } // the rest give false, 0, '' or null
  for (const op of ['===', '!==', '==', '!=', '>=', '<=', ' > ', ' < ', ' instanceof ', ' in ']) if (splitAt(e, op)) return []; // a boolean
  { const p = splitAt(e, '+'); if (p && p.length > 1) return p.flatMap((x) => check(x, seen, ctx)); }
  for (const op of [' - ', ' * ', ' / ', ' % ', '-', '*', '/', '%', ' | ', ' >> ']) { const p = splitAt(e, op); if (p && p.length > 1 && p[0]) return []; } // a number
  if (/^(!|\+|-|\+\+|--|~)[\w$.[\]?]+$/.test(e) || /^[\w$.]+(\+\+|--)$/.test(e)) return []; // a number or a boolean
  if (/^!/.test(e) || /^typeof\s/.test(e) || /^-?[\d.]+(e[+-]?\d+)?$/i.test(e) || /^(true|false|null|undefined|NaN)$/.test(e)) return [];
  if (/^'([^'\\]|\\.)*'$/.test(e) || /^"([^"\\]|\\.)*"$/.test(e)) return [];
  if (e[0] === '`' && closer('(' + e + ')', 0) >= 0) {
    // a nested template: its own ${...} have to pass
    const t2 = lex(e)[0];
    if (t2) return t2.exprs.flatMap((x) => check(x, seen, ctx));
  }
  if (e[0] === '[' && closer(e, 0) === e.length - 1) return checkList(e, seen, ctx);
  // a lookup in a table written here: { ok: 'done', ... }[st]
  if (e[0] === '{' && /\]$/.test(e)) {
    const end = closer(e, 0);
    if (end > 0 && e[end + 1] === '[' && closer(e, end + 1) === e.length - 1) {
      return splitTop(e.slice(1, end), ',').flatMap((p) => { const v = splitTop(p, ':'); return v.length > 1 ? check(v.slice(1).join(':'), seen, ctx) : [p]; });
    }
  }
  // a method call at the end: what it gives is made of what it is called on (and its arguments)
  const mc = methodCall(e);
  if (mc) {
    const { recv, method, args } = mc;
    if (/^(toFixed|toLocale\w*|indexOf|lastIndexOf|findIndex|includes|has|test|some|every|startsWith|endsWith)$/.test(method)) return [];
    if (method === 'toString' && args.length && /^\d+$/.test(args[0])) return []; // a number in some base
    if (TEXT_METHODS.has(method)) {
      const fromArgs = args.filter((a, i) => !((method === 'replace' || method === 'replaceAll') && i === 0)).flatMap((a) => (isFn(a) ? fnBody(a, seen, ctx) : check(a, seen, ctx)));
      return [...check(recv, seen, ctx), ...fromArgs];
    }
    if (method === 'join') return [...checkList(recv, seen, ctx), ...(args.length ? check(args[0], seen, ctx) : [])];
    if (ARRAY_METHODS.has(method)) return checkList(e, seen, ctx);
    seen.push(e);
    return [];
  }
  // a call of a plain function
  const call = /^([A-Za-z_$][\w$]*)\s*\(/.exec(e);
  if (call && closer(e, call[0].length - 1) === e.length - 1) {
    if (SAFE_FNS.test(e) || NUMBER_FNS.test(e)) return [];
    if (call[1] === 'String') return check(e.slice(call[0].length, -1), seen, ctx);
    // a function of this file: what it returns has to pass
    const fn = ctx && !ctx.names.has(call[1]) && ctx.depth < 6 ? returnsOf(ctx.src, ctx.at, call[1]) : null;
    if (!fn) { seen.push(e); return []; }
    const names = new Set([...ctx.names, ...fn.names, call[1]]);
    const bad = fn.rets.flatMap((r) => check(r.e, seen, { ...ctx, at: r.at, names, depth: ctx.depth + 1 }));
    return bad.length ? [`${call[1]}() returns ${bad.join(' | ')}`] : [];
  }
  // a plain name: a constant in capitals is markup or text written here; another is checked by what it was set to
  // (its nearest const / let before the template), else noted
  if (/^[A-Za-z_$][\w$]*$/.test(e)) {
    if (/^[A-Z][A-Z0-9_]*$/.test(e)) return [];
    const init = ctx && !ctx.names.has(e) && ctx.depth < 6 ? initOf(ctx.src, ctx.at, e) : null;
    if (init == null) { seen.push(e); return []; }
    const bad = check(init.e, seen, { ...ctx, names: new Set(ctx.names).add(e), depth: ctx.depth + 1 });
    return bad.length ? [`${e} = ${bad.join(' | ')}`] : [];
  }
  if (COUNT_FIELDS.test(e)) return [];
  // a field of a constant table in capitals (C.cyan, COL.gold, ACCT_COLORS[a]): written here too
  if (/^[A-Z][A-Z0-9_]*(\??\.[\w$]+|\[[^\]]*\])+$/.test(e)) return [];
  // a field, an index, anything else: not escaped, unless OK lists it for this file
  const ok = ctx && `${ctx.file}: ${e}`;
  if (ok && OK.has(ok)) { okUsed.add(ok); return []; }
  return [e];
}

// markup: an HTML or SVG tag (not text like `fv send <id>`), or an attribute opening right before a ${...}
const TAGS = new Set(('a abbr b blockquote br button canvas caption circle cite clipPath code col dd defs del details dialog div dl dt '
  + 'ellipse em feGaussianBlur fieldset figure filter footer form g h1 h2 h3 h4 h5 h6 header hr i iframe img input ins kbd label legend '
  + 'li line linearGradient main mark marker mask meter nav ol optgroup option output p path pattern polygon polyline pre progress q '
  + 'radialGradient rect s section select small source span stop strong style sub summary sup svg symbol table tbody td template text '
  + 'textarea th thead time title tr tspan u ul use video wbr').split(' '));
const isMarkup = (t) => [...t.quasis.join('').matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)(?=[\s>/]|$)/g)].some((m) => TAGS.has(m[1]))
  || t.quasis.slice(0, -1).some((q) => /[\s"'][a-zA-Z:-]+=["']?$/.test(q));

let failures = 0, checked = 0;
const notes = [];
for (const name of fs.readdirSync(WEB).filter((f) => f.endsWith('.js')).sort()) {
  const src = fs.readFileSync(path.join(WEB, name), 'utf8');
  for (const t of lex(src)) {
    if (!isMarkup(t)) continue;
    for (const x of t.exprs) {
      checked++;
      const seen = [];
      const bad = check(x, seen, { file: name, src, at: t.at, names: new Set(), depth: 0 });
      if (bad.length) { failures++; console.log(`FAIL web/${name}:${t.line}  \${${x.trim()}}  (not escaped: ${bad.join(' | ')})`); }
      for (const s of seen) notes.push(`web/${name}:${t.line}  ${s}`);
    }
  }
}
if (LIST) for (const n of notes) console.log(`note ${n}`);
for (const k of OK.keys()) if (!okUsed.has(k)) { failures++; console.log(`FAIL OK lists "${k}", which no markup reads any more`); }

// the rules themselves, on made-up builders: what has to fail does, what has to pass does
const rule = (code) => { const t = lex(code)[0]; return t.exprs.flatMap((x) => check(x, [], { file: '-', src: code, at: 0, names: new Set(), depth: 0 })); };
const must = [
  ['`<b title="${c.name}">`', true], ['`<b title="${esc(c.name)}">`', false], ['`<b>${x ? ` leads ${par.name}` : \'\'}</b>`', true],
  ['`<b>${list.map((m) => m.name).join(\', \')}</b>`', true], ['`<b>${list.map((m) => esc(m.name)).join(\', \')}</b>`', false],
  ['`<b>${String(c.name).trim()}</b>`', true], ['`<b>${n + 1} of ${list.length}</b>`', false], ['`<b>${C.cyan}</b>`', false],
];
for (const [code, bad] of must) if (!!rule(code).length !== bad) { failures++; console.log(`FAIL the rule got ${code} wrong: it should ${bad ? 'fail' : 'pass'}`); }
console.log(`${failures ? 'FAIL' : 'ok'}: ${checked} interpolations in markup checked, ${failures} failed${LIST ? `, ${notes.length} notes` : ''}`);
process.exit(failures ? 1 : 0);
