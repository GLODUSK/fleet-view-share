// pgrest-filter.js: the PostgREST row filters the sync tests' fake Supabase servers understand, read the way PostgREST
// reads them (https://postgrest.org, "Horizontal filtering"): col=op.value and col=not.op.value with eq, neq, gt, gte,
// lt, lte, like, ilike (* or % for any text), in.(a,b,"c") and is.null / is.true / is.false; and the logic trees
// or=(...), and=(...), not.or=(...), not.and=(...), nested as or(...), and(...), not.or(...), not.and(...), with
// values in double quotes when they hold reserved characters. SQL's way with a null: it never equals, differs or
// compares (and not of that is still not true); only is.null finds it. Numbers compare as numbers, ISO times as times.
//
//   matcher(searchParams) -> (row) => boolean     (select, order, limit, offset, on_conflict and columns are not filters)
'use strict';

const NOT_FILTERS = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns']);
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

// a,b,(c,d),"e,f" -> ['a', 'b', '(c,d)', '"e,f"']: split on the commas outside parentheses and quotes
function splitTop(s) {
  const out = [];
  let depth = 0, quoted = false, cur = '';
  for (const ch of s) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === '(') depth++;
    else if (!quoted && ch === ')') depth--;
    if (ch === ',' && !quoted && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur !== '' || out.length) out.push(cur);
  return out;
}
const unquote = (v) => (v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v);
const inner = (v) => { if (!v.startsWith('(') || !v.endsWith(')')) throw new Error(`not a list: ${v}`); return v.slice(1, -1); };

function compare(a, b) {
  const na = Number(a), nb = Number(b);
  if (a !== '' && b !== '' && Number.isFinite(na) && Number.isFinite(nb) && typeof a !== 'boolean') return na - nb;
  if (ISO_RE.test(String(a)) && ISO_RE.test(String(b))) {
    const ta = Date.parse(a), tb = Date.parse(b);
    if (Number.isFinite(ta) && Number.isFinite(tb)) return ta - tb;
  }
  const sa = String(a), sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}
// one test: true, false, or null (unknown: a null met something other than is)
function test(v, op, raw) {
  if (op === 'is') {
    const w = raw.toLowerCase();
    if (w === 'null') return v == null;
    if (v == null) return false;
    return w === 'true' ? v === true : w === 'false' ? v === false : false;
  }
  if (v == null) return null;
  if (op === 'in') return splitTop(inner(raw)).map(unquote).some((x) => String(v) === x || (typeof v === 'number' && compare(v, x) === 0));
  const val = unquote(raw);
  if (op === 'eq') return String(v) === val || (typeof v === 'number' && compare(v, val) === 0);
  if (op === 'neq') return !(String(v) === val || (typeof v === 'number' && compare(v, val) === 0));
  if (op === 'gt') return compare(v, val) > 0;
  if (op === 'gte') return compare(v, val) >= 0;
  if (op === 'lt') return compare(v, val) < 0;
  if (op === 'lte') return compare(v, val) <= 0;
  if (op === 'like' || op === 'ilike') {
    const re = new RegExp(`^${val.split(/[*%]/).map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, op === 'ilike' ? 'is' : 's');
    return re.test(String(v));
  }
  throw new Error(`no such operator: ${op}`);
}
const not = (r) => (r === null ? null : !r);
// col and op.value (or not.op.value) -> (row) => true | false | null
function leaf(col, expr) {
  let neg = false, rest = expr;
  if (rest.startsWith('not.')) { neg = true; rest = rest.slice(4); }
  const i = rest.indexOf('.');
  if (i < 0) throw new Error(`not a filter: ${col}=${expr}`);
  const op = rest.slice(0, i), raw = rest.slice(i + 1);
  return (row) => { const r = test(row[col], op, raw); return neg ? not(r) : r; };
}
// or / and over a list of items -> (row) => true | false | null
function tree(kind, list, neg) {
  const parts = splitTop(list).map(item);
  return (row) => {
    const rs = parts.map((p) => p(row));
    let r;
    if (kind === 'or') r = rs.some((x) => x === true) ? true : rs.some((x) => x === null) ? null : false;
    else r = rs.some((x) => x === false) ? false : rs.some((x) => x === null) ? null : true;
    return neg ? not(r) : r;
  };
}
// an item of a logic tree: or(...), and(...), not.or(...), not.and(...), or col.op.value / col.not.op.value
function item(s) {
  const m = /^(not\.)?(or|and)\((.*)\)$/s.exec(s);
  if (m) return tree(m[2], m[3], !!m[1]);
  const i = s.indexOf('.');
  if (i < 0) throw new Error(`not a filter: ${s}`);
  return leaf(s.slice(0, i), s.slice(i + 1));
}

function matcher(params) {
  const tests = [];
  for (const [k, v] of params) {
    if (NOT_FILTERS.has(k)) continue;
    const m = /^(not\.)?(or|and)$/.exec(k);
    tests.push(m ? tree(m[2], inner(v), !!m[1]) : leaf(k, v));
  }
  return (row) => tests.every((t) => t(row) === true);
}

module.exports = { matcher, splitTop };
