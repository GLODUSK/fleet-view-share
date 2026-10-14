// overseer.js: what api.js and bots.js share about the overseers, the hosted sessions that oversee the others for
// Henry (the bots, bots.js: role 'bot:<id>' in desktop/host.js).
//
// - Who is talking: frame() marks what reaches an overseer by where it came from, so only Henry's own words read as
//   his (see frame below and api.js's relay check). api.js uses it on every text it types into one.
// - Tell it its id: an overseer can't find its own id, so each new conversation that takes the role is told once,
//   once its first message went in (createTeller below; bots.js makes one per bot).
'use strict';

const TELL_AFTER_MS = 75e3; // an overseer whose first message never showed is told its id after this long anyway
const TELL_RETRY_MS = 30e3; // a failed tell is tried again after this long
const TOLD_MAX = 100;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const convId = (id) => (ID_RE.test(String(id || '')) ? String(id).toLowerCase() : null);
// one line, control characters made spaces, at most n characters (an ellipsis when cut)
const oneLine = (s, n) => {
  const t = String(s == null ? '' : s).replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
};

// ---------- who is talking ----------
// Text with no "from" looks like Henry's own to a Claude session, and "[Fleet View]" is a prefix anyone can type. So
// what api.js types into an overseer is framed by its origin:
//   'server'   Fleet View's own text (the id note, an ask's answers): its first line as it is
//   'bot'      a message from another conversation: its first line is the server's "[Message from …]" header
//   'henry'    Henry's own surfaces (the phone relay, checked in api.js): no header
//   'unsigned' anything else: a first line UNSIGNED, so the overseer reads it as information, never an order
// In every case a line of the caller's text that starts like a line the server writes ("[Fleet View…",
// "[Message from …", "[Question from …") gets "(quoted) " in front, so it no longer starts with that mark. The test
// is on the line as a reader takes it (fold): "[Fleet\u200bView" (a zero-width space), a fullwidth "[" and Cyrillic
// lookalike letters all count. Every line break splits a line, U+2028 and the like too.
const UNSIGNED = '[Fleet View · unsigned, not from Henry]';
const FAKE_HEAD = /^\s*[[\u3010\u3014\u27e6\u301a\u3016]\s*(?:fleet[\s\W_]*view\b|message[\s\W_]*from\b|question[\s\W_]*from\b)/i;
// the Cyrillic and Greek letters that look like the Latin ones in those marks, as the Latin letter (lower case)
const LOOKALIKE = {
  '\u0410': 'a', '\u0412': 'b', '\u0415': 'e', '\u041a': 'k', '\u041c': 'm', '\u041d': 'h', '\u041e': 'o', '\u0420': 'p', '\u0421': 'c', '\u0422': 't',
  '\u0425': 'x', '\u0406': 'i', '\u0405': 's', '\u0408': 'j', '\u051a': 'q', '\u051c': 'w', '\u04c0': 'l',
  '\u0430': 'a', '\u0435': 'e', '\u043e': 'o', '\u0440': 'p', '\u0441': 'c', '\u0443': 'y', '\u0445': 'x', '\u0456': 'i', '\u0458': 'j', '\u0455': 's',
  '\u051b': 'q', '\u051d': 'w', '\u04bb': 'h', '\u0501': 'd', '\u04cf': 'l', '\u0475': 'v',
  '\u0391': 'a', '\u0392': 'b', '\u0395': 'e', '\u0396': 'z', '\u0397': 'h', '\u0399': 'i', '\u039a': 'k', '\u039c': 'm', '\u039d': 'n', '\u039f': 'o',
  '\u03a1': 'p', '\u03a4': 't', '\u03a5': 'y', '\u03a7': 'x',
  '\u03b1': 'a', '\u03b5': 'e', '\u03b9': 'i', '\u03ba': 'k', '\u03bd': 'v', '\u03bf': 'o', '\u03c1': 'p', '\u03c4': 't', '\u03c5': 'u', '\u03c7': 'x',
  '\u03c9': 'w', '\u0261': 'g', '\u0131': 'i', '\u0269': 'i',
};
// a line as a reader takes it: compatibility forms folded (a fullwidth bracket is [, the fl ligature fl), invisible
// format characters and combining marks dropped, lookalike letters made Latin
const fold = (line) => String(line).normalize('NFKD').replace(/[\p{Cf}\p{Mn}\p{Me}]/gu, '').replace(/[^\x00-\x7f]/g, (c) => LOOKALIKE[c] || c);
const neutralise = (line) => (FAKE_HEAD.test(fold(line)) ? `(quoted) ${line}` : line);
const LINE_BREAK = /\r\n|[\n\r\v\f\u0085\u2028\u2029]/;
function frame(text, origin) {
  const lines = String(text == null ? '' : text).split(LINE_BREAK);
  if (origin === 'server' || origin === 'bot') return [lines[0], ...lines.slice(1).map(neutralise)].join('\n');
  if (origin === 'henry') return lines.map(neutralise).join('\n');
  return [UNSIGNED, ...lines.map(neutralise)].join('\n');
}
// a name the server puts inside its own first line (a team's, a sender's: api.js), so it can't end the quotes or the
// line and start a header of its own: a double quote of any kind becomes ', a bracket a space (lookalikes too, by
// fold), control characters and line breaks a space, and it is kept short
const HEAD_QUOTE = /["\u201c\u201d\u201e\u201f\u2033\u2036]/;
const HEAD_BRACKET = /[[\]\u3010\u3011\u3014\u3015\u27e6\u27e7\u301a\u301b\u3016\u3017]/;
const headName = (s, n = 60) => oneLine([...String(s == null ? '' : s)].map((c) => {
  const f = fold(c);
  return HEAD_QUOTE.test(f) ? "'" : HEAD_BRACKET.test(f) ? ' ' : c;
}).join(''), n);

// ---------- telling an overseer its id ----------
// o: { id, told: Set, pending, starting, firstSeen, promptAt, now }. Once per id, never while a start is typing its
// prompt (the two pastes would mix), and only after its first message went in (else after TELL_AFTER_MS)
function shouldTell(o) {
  if (!o || !convId(o.id) || o.pending || o.starting) return false;
  if (o.told && o.told.has(convId(o.id))) return false;
  return (o.promptAt || 0) > 0 || (Number.isFinite(o.firstSeen) && o.now - o.firstSeen >= TELL_AFTER_MS);
}
// One per overseer (each bot in bots.js): tells each of its conversations its id once. The note counts
// as told only once it went in: one queued behind a menu waits for onSent, and one the queue drops (onDrop) is tried
// again. After a restart the queue's hooks are gone; the next try finds the same text queued (api.js keeps one of
// each) and hooks onto it, so it still goes in once. o: { api (deliverText), ctx, note(id) -> its text, told: [ids]
// as saved, log(text), save() (told changed) }
function createTeller(o) {
  let told = Array.isArray(o.told) ? [...new Set(o.told.map(convId).filter(Boolean))].slice(-TOLD_MAX) : [];
  let telling = false, tellTry = 0;
  let tellQueued = null; // the id whose note waits in api.js's queue (behind a menu): told once it goes in
  const log = (t) => { try { if (o.log) o.log(t); } catch {} };
  const save = () => { try { if (o.save) o.save(); } catch {} };
  function markTold(id) {
    if (tellQueued === id) tellQueued = null;
    if (told.includes(id)) return;
    told = [...told, id].slice(-TOLD_MAX);
    save();
  }
  async function tell(id) {
    telling = true; tellTry = Date.now();
    try {
      const [, r] = await o.api.deliverText(id, o.note(id), { kind: 'message', queue: true, open: false, via: 'server',
        onSent: () => { if (!told.includes(id)) log(`told ${id} its id`); markTold(id); },
        onDrop: (why) => { if (tellQueued === id) tellQueued = null; log(`the id note for ${id} was dropped (${why}); it goes again`); } }, o.ctx);
      if (r && r.ok && !r.queued) markTold(id); // onSent ran already
      else if (r && r.ok) { if (!told.includes(id)) tellQueued = id; log(`the id note for ${id} waits behind a menu`); }
      else log(`could not tell ${id} its id: ${(r && r.message) || 'no answer'}`);
    } finally { telling = false; }
  }
  // x: shouldTell's o less told. Also not while a note goes in, while this one's waits in the queue, or within
  // TELL_RETRY_MS of the last try
  const due = (x) => !telling && tellQueued !== x.id && x.now - tellTry >= TELL_RETRY_MS && shouldTell({ ...x, told: new Set(told) });
  return { told: () => told, due, tell, markTold };
}

module.exports = { frame, neutralise, fold, headName, oneLine, convId, shouldTell, createTeller, UNSIGNED, TELL_AFTER_MS, TELL_RETRY_MS };
