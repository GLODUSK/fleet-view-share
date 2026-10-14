// Fleet View: does a finished reply wait on you? fleet-view.js shows a turn that ends this way as QUESTION ("ASKED
// YOU") instead of DONE. Tested by scripts/ends-on-question-test.js.
//
// A reply that closes on a question is waiting on you; anything else is a finished turn.
// The question may sit in the last few lines ("Should I merge?" then "Up to you."), carry a short tail
// ("Merge now? (yes/no)"), or be one sentence of several ("Do you want the 24-hour change? Or I can ...").
// Code and links are left out first, so "foo?.bar" and "?page=2" are not questions.
//
// A reply that ends on a polite offer ("If something looks wrong, tell me and I'll look into it.", "Let me know if
// you want anything else.", "Happy to dig further if needed.") has answered and is done, even with a question just
// before the offer ("What did you want to check? If something looks wrong, tell me."). The exceptions: a direct
// proposal right before it ("Want me to merge it? Let me know if you'd like anything else.") or unticked options
// anywhere above it still ask.
'use strict';

// a direct ask in a sentence: a proposal (want me to, should I) or a choice the user must make (which one, let me know
// which/whether). "let me know if ..." is an offer, not an ask: see CLOSER_RES.
const ASKS_RE = /(?:^|[.!:]\s+)(?:want me to|should i|shall i|do you want|would you like|which (?:one|do you)|let me know (?:whether|which))\b/i;

// a final sentence that offers more help without asking for anything (checked on lower case, straight apostrophes):
const CLOSER_RES = [
  // "If something looks wrong, tell me what and I'll look into it." "If you want X, just say so."
  // "If you wanted it at your other address, I can send it there too."
  /^(?:and |or |but )?if\b.*\b(?:tell me|let me know|say so|just say|say the word|ping me|shout|i can|i could|i'll|i will|i'd|happy to|glad to)\b/,
  // "Let me know if you want anything else." "Tell me if you want that changed too." "Say if you want it."
  /\b(?:tell me|let me know|say|ping me|shout)\s+if\b/,
  // "Happy to dig further if needed." "Glad to help with anything else."
  /^(?:i'm |i am |i'd be |i would be |and i'm )?(?:happy|glad) to\b/,
  // "I can draft it from your Gmail if you want." "I could add a flag for it if you'd like."
  /^(?:i can|i could|i'm happy to|i'd be happy to)\b.*\bif (?:you(?:'d)? (?:want|like|prefer)|needed|useful|helpful)\b/,
];

// A reply that ends on a task list with unticked boxes ("- [ ] **Short name** …", the options the chat turns into
// checkboxes) is waiting on you too: nothing runs until you tick and launch. Only the list at the very end counts:
// after its last open box there may be nothing but blank lines or the indented lines of its items.
function endsOnOpenList(text) {
  const lines = String(text || '').split('\n');
  let last = -1;
  lines.forEach((l, i) => { if (/^\s*[-*+]\s+\[ \]\s/.test(l)) last = i; });
  return last >= 0 && lines.slice(last + 1).every((l) => !l.trim() || /^\s/.test(l));
}

// the reply's last three lines, code and links left out, trailing markup trimmed
function lastLines(text) {
  return String(text || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(-3)
    .map((l) => l.replace(/`[^`]*`/g, '').replace(/\bhttps?:\/\/\S+/g, '').replace(/[*_`\]"'\s]+$/, ''));
}

// a sentence that offers more help and asks nothing: no question mark in it, and one of CLOSER_RES
function isCloser(sentence) {
  const s = String(sentence || '').replace(/^[\s>*_#-]+/, '').replace(/[‘’]/g, "'").toLowerCase().trim();
  return !!s && !s.includes('?') && CLOSER_RES.some((re) => re.test(s));
}

function endsOnQuestion(text) {
  if (endsOnOpenList(text)) return true;
  const lines = lastLines(text);
  const sentences = lines.flatMap((l) => l.split(/(?<=[.!?])\s+/)).map((s) => s.trim()).filter(Boolean);
  if (isCloser(sentences[sentences.length - 1])) {
    // the offer ends it; only unticked options above it or a direct proposal right before it still ask
    if (/^\s*[-*+]\s+\[ \]\s/m.test(String(text || ''))) return true;
    const prev = sentences[sentences.length - 2] || '';
    return /\?\s*$/.test(prev) && ASKS_RE.test(prev);
  }
  return lines.some((l) => /\?[^?]{0,14}$/.test(l) || /\?(?=[\s)*_"'\]]|$)/.test(l)) || ASKS_RE.test(lines[lines.length - 1] || '');
}

module.exports = { ASKS_RE, endsOnOpenList, endsOnQuestion, isCloser };
