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
// -> [text…]: each one line of plain words (markdown marks out), at most 400 characters, at most 5, each once

const MAX = 5;
const CUT = 400;
const MARK = /\s*\(recommended\)/i;
const LABEL = /^(?:(?:my|our|the)\s+)?(?:(?:top|final|main|overall|short|quick)\s+)?(?:recommendations?|recommended(?:\s+[a-z]+){0,2}|recommend)\s*(?:[:—–]|\s-\s)\s*/i;
const HEAD = /^(?:(?:my|our)\s+)?(?:recommendations?|recommended(?:\s+[a-z]+){0,2}|what\s+i(?:['’]d|\s+would)\s+do)\s*:?$/i;
const SENT = /\b(?:i|we)(?:['’]d|\s+would)?\s+(?:(?:still|strongly|really|also|definitely)\s+)?recommend\b|\bmy\s+recommendation\s+(?:is|would\s+be|stays|remains)\b/i;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

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

// the reply in blocks, code left out: { kind: 'p' | 'li' | 'h' | 'row', indent, text } (text in plain words). A
// paragraph's or an item's lines join until a blank line, a heading, a rule, a table row or the next item
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
  return out.map((b) => ({ ...b, text: plain(b.text) }));
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
  let found = bs.filter((b) => MARK.test(b.text)).map((b) => b.text.replace(MARK, ''));
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
      const m = SENT.exec(b.text);
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
    const t = raw.replace(/\s+/g, ' ').trim();
    const k = t.toLowerCase();
    if (!t || seen.has(k)) continue;
    seen.add(k);
    out.push(t.length > CUT ? `${t.slice(0, CUT - 1)}…` : t);
    if (out.length === MAX) break;
  }
  return out;
}
