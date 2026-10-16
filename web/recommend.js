// A reply's recommendation when it gives one outside a task list, so the chat offers a Launch button for it as it
// does for a task list's options (chat.js recPick). Henry 2026-10-15: a reply with a recommendation, however it is
// written, always has the button. launch.js recommendationsOf is the same code for fv launch, and the phone's
// (phone/src/lib/chat/compose.ts) too: scripts/launch-test.js checks the page's and launch.js's agree.
//
// What counts, the most explicit kind first (the first kind found is the answer):
//  1. "(recommended)" in a line, an item, a heading or a table row: that line, without the mark
//  2. a label: "My recommendation: …", "**Recommendation:** …", "Recommended fix — …": the words after it; a label
//     alone on its line, or a heading "Recommendation(s)" / "My recommendation" / "What I'd do", takes what is under
//     it (the items of the list there, else the paragraph)
//  3. a sentence: "I recommend …", "I'd recommend …", "We'd strongly recommend …", "My recommendation is …": from that
//     sentence to the end of its paragraph. "I wouldn't recommend", "I don't recommend" and "I recommended" are not one
// A mark or a sentence inside inline code or quotes is talk about one, not one (2026-10-15: a summary of these rules
// got the button from its `(recommended)`)
// Advice to do nothing is not one (Henry 2026-10-15: "My recommendation is to leave him off for now." got the button,
// and launching it means nothing): one whose first sentence says hold off, wait, leave or keep it as is, don't, skip
// it, not yet, no change needed (holdOff) is left out, so a reply with only that has no button
// -> [text…]: each one line of plain words (markdown marks out), at most 400 characters, at most 5, each once

const MAX = 5;
const CUT = 400;
const MARK = /\s*\(recommended\)/gi;
const LABEL = /^(?:(?:my|our|the)\s+)?(?:(?:top|final|main|overall|short|quick)\s+)?(?:recommendations?|recommended(?:\s+[a-z]+){0,2}|recommend)\s*(?:[:—–]|\s-\s)\s*/i;
const HEAD = /^(?:(?:my|our)\s+)?(?:recommendations?|recommended(?:\s+[a-z]+){0,2}|what\s+i(?:['’]d|\s+would)\s+do)\s*:?$/i;
const SENT = /\b(?:i|we)(?:['’]d|\s+would)?\s+(?:(?:still|strongly|really|also|definitely)\s+)?recommend\b|\bmy\s+recommendation\s+(?:is|would\s+be|stays|remains)\b/gi;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

// hold-off advice (holdOff): the advice is what follows "I recommend" / "My recommendation is" in its first sentence
// (else the whole sentence), its lead-in words ("to", "that we", "just") out; it holds off when it starts with one of
// HOLD_START, or says one of HOLD_ANY anywhere
const ASK = /\b(?:i|we)(?:['’]d|\s+would)?\s+(?:(?:still|strongly|really|also|definitely)\s+)?recommend\b|\bmy\s+recommendation\s+(?:is|would\s+be|stays|remains)\b/i;
const LEAD = /^(?:[\s,:]*(?:is|would\s+be|to|that|we|you|should|just|simply|probably|honestly|still|for\s+now|for\s+the\s+moment|at\s+this\s+point)\b)*[\s,:]*/i;
const THING = '(?:\\s+[\\w’\'-]+){0,4}?\\s+';
const HOLD_START = new RegExp('^(?:' + [
  'not\\b', 'against\\b', 'nothing\\b', 'never\\b', 'don[\'’]?t\\b', 'do\\s+not\\b', '(?:do|doing)\\s+nothing\\b',
  'no\\s+(?:code\\s+)?(?:changes?|action|fix|further|new|work|move)\\b',
  'hold(?:ing)?\\s+(?:off|back|it|this|that)\\b', 'wait(?:ing)?\\b', 'stay(?:ing)?\\s+(?:put|as|with|the\\s+course)\\b',
  `leav(?:e|ing)${THING}(?:off|out|alone|as[\\s-]is|unchanged|in\\s+place|for\\s+now|be|where|there)\\b`,
  `keep(?:ing)?${THING}(?:as[\\s-]is|unchanged|off|out|for\\s+now|the\\s+same|disabled|where|in\\s+place|on\\s+hold)\\b`,
  'skip(?:ping)?\\s+(?:it|this|that|them|this\\s+one|that\\s+one|for\\s+now)\\b',
  '(?:park(?:ing)?|shelv(?:e|ing))\\s+(?:it|this|that|them)\\b', '(?:defer(?:ring)?|postpon(?:e|ing))\\b',
  'let(?:ting)?\\s+(?:it|this|that|them)\\s+(?:be|ride|sit)\\b',
].join('|') + ')', 'i');
const HOLD_ANY = /\bhold(?:ing)?\s+off\b|\bno\s+(?:code\s+)?changes?\s+(?:is\s+|are\s+)?(?:needed|required|necessary)\b|\bnothing\s+(?:needs\s+(?:to\s+)?(?:change|be\s+done)|to\s+(?:do|change|fix))\b|\b(?:leave|keep)\s+(?:it|this|that|them|things|everything)\s+(?:as[\s-]is|alone|unchanged)\b|\bnot\s+(?:yet|now|for\s+now)\b/i;

// whether a recommendation's advice is to do nothing (hold off, wait, leave it, don't, skip it, not yet)
export function holdOff(text) {
  const s = String(text || '').replace(/[\u0001\u0002]/g, '');
  const first = (s.match(/^[\s\S]*?[.!?](?=\s|$)/) || [s])[0];
  const m = ASK.exec(first);
  const advice = (m ? first.slice(m.index + m[0].length) : first).replace(LEAD, '');
  return HOLD_START.test(advice) || HOLD_ANY.test(advice);
}

// markdown inline marks out, as the page shows the words (launch.js plain)
export function plain(s) {
  return String(s || '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`+([^`]*)`+/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

// inline code's words stay in a block's text between these two, so a match inside it is known (out again at the end)
const CODE_IN = '\u0001', CODE_OUT = '\u0002';
const count = (s, c) => s.split(c).length - 1;
// whether text[i] is inside inline code or quotes ("…" or “…”)
function quoted(text, i) {
  const s = text.slice(0, i);
  return count(s, CODE_IN) > count(s, CODE_OUT) || count(s, '"') % 2 === 1 || count(s, '“') > count(s, '”');
}
// the first match of re (global) in text not inside code or quotes, else null
function said(re, text) {
  re.lastIndex = 0;
  for (let m; (m = re.exec(text));) if (!quoted(text, m.index + m[0].length - m[0].trimStart().length)) return m;
  return null;
}

// the reply in blocks, code left out: { kind: 'p' | 'li' | 'h' | 'row', indent, text } (text in plain words, inline
// code marked). A paragraph's or an item's lines join until a blank line, a heading, a rule, a table row or the next item
function blocksOf(md) {
  const out = [];
  let cur = null, fence = null;
  for (let line of String(md || '').replace(/\r\n?/g, '\n').split('\n')) {
    const f = FENCE.exec(line);
    if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null; continue; }
    if (f) { fence = f[1]; cur = null; continue; }
    line = line.replace(/^\s{0,3}(?:>\s?)+/, ''); // a quote's words count as the reply's
    if (!line.trim() || /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) { cur = null; continue; }
    let m;
    if ((m = /^\s{0,3}#{1,6}\s+(.*?)[\s#]*$/.exec(line))) { out.push({ kind: 'h', indent: 0, text: m[1] }); cur = null; continue; }
    if ((m = /^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(line))) { out.push(cur = { kind: 'li', indent: m[1].length, text: m[2] }); continue; }
    if (/^\s*\|/.test(line)) {
      if (!/^\s*\|?[\s:|-]+\|?\s*$/.test(line)) out.push({ kind: 'row', indent: 0, text: line.split('|').map((x) => x.trim()).filter(Boolean).join(' · ') });
      cur = null;
      continue;
    }
    if (cur) { cur.text += ` ${line.trim()}`; continue; }
    out.push(cur = { kind: 'p', indent: 0, text: line.trim() });
  }
  return out.map((b) => ({ ...b, text: plain(b.text.replace(/`+([^`]*)`+/g, `${CODE_IN}$1${CODE_OUT}`)) }));
}

// what is under a label or a heading: the items of the list right after it (at its first item's depth), else the
// block right after it (nothing past the next heading)
function under(bs, i) {
  const first = bs[i + 1];
  if (!first || first.kind === 'h') return [];
  if (first.kind !== 'li') return [first.text];
  const out = [];
  for (let k = i + 1; k < bs.length && bs[k].kind === 'li' && bs[k].indent >= first.indent; k++) {
    if (bs[k].indent === first.indent) out.push(bs[k].text);
  }
  return out;
}

export function recommendationsOf(md) {
  const bs = blocksOf(md);
  let found = [];
  for (const b of bs) {
    const m = said(MARK, b.text);
    if (m) found.push(b.text.slice(0, m.index) + b.text.slice(m.index + m[0].length));
  }
  if (!found.length) {
    bs.forEach((b, i) => {
      const m = LABEL.exec(b.text);
      const rest = m ? b.text.slice(m[0].length).trim() : '';
      if (rest) found.push(rest);
      else if (m || (HEAD.test(b.text) && (b.kind === 'h' || b.kind === 'p'))) found.push(...under(bs, i));
    });
  }
  if (!found.length) {
    for (const b of bs) {
      if (b.kind === 'h') continue;
      const m = said(SENT, b.text);
      if (!m) continue;
      // from the start of its sentence: just past the last ". ", "! " or "? " before it
      const before = b.text.slice(0, m.index);
      const at = Math.max(before.lastIndexOf('. '), before.lastIndexOf('! '), before.lastIndexOf('? '));
      found.push(b.text.slice(at < 0 ? 0 : at + 2));
    }
  }
  const seen = new Set();
  const out = [];
  for (const raw of found) {
    const t = raw.replace(/[\u0001\u0002]/g, '').replace(/\s+/g, ' ').trim();
    const k = t.toLowerCase();
    if (!t || seen.has(k) || holdOff(t)) continue;
    seen.add(k);
    out.push(t.length > CUT ? `${t.slice(0, CUT - 1)}…` : t);
    if (out.length === MAX) break;
  }
  return out;
}
