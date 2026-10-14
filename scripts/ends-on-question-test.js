// ends-on-question-test.js: a check of ends-on-question.js, what makes a finished reply show as QUESTION ("ASKED YOU")
// instead of DONE. A reply that answered and closes on a polite offer ("If something looks wrong, tell me and I'll look
// into it.") is done, even with a clarifying question just before the offer. A question as the last line, a direct
// proposal ("Want me to merge it?"), a choice ("Let me know which one you want.") and an open task list at the end
// still ask. Most cases are real reply endings from Claude Code transcripts.
// Run: node scripts/ends-on-question-test.js (exit 0 = all pass)
'use strict';
const path = require('path');
const Q = require(path.join(__dirname, '..', 'ends-on-question.js'));

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.log(`FAIL ${n}`); } };
const asks = (text, n) => ok(Q.endsOnQuestion(text) === true, `asks: ${n}`);
const done = (text, n) => ok(Q.endsOnQuestion(text) === false, `done: ${n}`);

// the case that started it
done("That's 105 minutes in total. None of them has a part or tier label, so they're the generic tint steps, not per-window tasks.\n\n"
  + "What did you want to check on them? If something looks wrong, tell me what and I'll look into it.", 'the tint-steps reply (question before an offer)');
done("That's 105 minutes in total.\n\nWhat did you want to check on them?\n\nIf something looks wrong, tell me what and I'll look into it.",
  'the same with the offer in its own paragraph');

// offers that close a finished reply
done('Merged and live.\n\nLet me know if you want anything else.', 'let me know if you want anything else');
done("It's in.\n\nLet me know if you'd like me to change it.", "let me know if you'd like me to change it");
done('The flag is on for everyone.\n\nIf you want it only for staff, just say so.', 'if you want X, just say so');
done('Those are the three causes I found.\n\nHappy to dig further if needed.', 'happy to dig further if needed');
done('It is fixed.\n\nIs that what you meant? Let me know if you want anything else.', 'a clarifying question, then an offer');
done("It’s fixed. If anything looks off, let me know and I’ll take another look.", 'curly apostrophes');
done('It\'s merged (PR #425), restarted and live, and published to the share repo as **1.0.259**. The test servers and browser I started are closed and the worktree is removed. The moon is still pinned to the window; tell me if you want that changed too.',
  'real: tell me if you want that changed too');
done('I emailed the blurb to you with the subject "Depot / new car data: for standup". The "Need a call" part is cut.\n\nIf you wanted it at your Glodusk address instead, I can send it there too.',
  'real: if you wanted it elsewhere, I can send it there too');
done('Your last message ended at "only if", so I took it to mean "only if I have time." Tell me if you meant a different condition.',
  'real: tell me if you meant a different condition');
done('Apple should email you a case ID. If nothing arrives within a day or two, tell me and we\'ll chase it.\n\nThe Chrome tab is still open on the confirmation page. Tell me if you want me to close it.',
  'real: tell me if you want me to close it');
done('Lint and tests pass. I didn\'t open the menu myself to look at it, so tell me if anything looks off.', 'real: so tell me if anything looks off');
done('**Phone app:** it uses the same file for its Bots list, so its dots get the fix only with its next over-the-air update. I didn\'t push one; say if you want it.',
  'real: say if you want it');
done('To confirm it, send a short note along the lines of "Saw you signed up, want help setting up your shop?" If it\'s them, they\'ll say so. I can draft it from your Gmail if you want.',
  'real: a quoted question mid-reply, then I can ... if you want');

// real asks stay flagged
asks('The fix is ready.\n\nShould I ship it behind a flag?', 'should I ship it behind a flag');
asks('The PR is green.\n\nWant me to merge it?', 'want me to merge it');
asks('Both work.\n\nWhich one do you want: A or B?', 'which one: A or B');
asks('Both work.\n\nLet me know which one you want.', 'let me know which one (a choice)');
asks('Both work. Let me know whether to merge it.', 'let me know whether (a choice)');
asks('The build is ready.\n\nDo you want me to deploy it now?', 'a question as the last line');
asks('The PR is green.\n\nWant me to merge it? Let me know if you\'d like anything else first.', 'a direct proposal right before an offer');
asks('Here are the options:\n\n- [ ] **Ship it** (recommended): merge and deploy · Opus, low\n- [ ] **Hold**: wait for review · Opus, low\n\nLet me know if you want anything else.',
  'an open task list, then an offer: the options are still waiting');
asks('Two ways to go:\n\n- [ ] **Ship it** (recommended): merge and deploy · Opus, low\n- [ ] **Hold**: wait for review · Opus, low',
  'an open task list at the end');
asks('If you want it on, should I turn it on now?', 'an if-sentence that ends on a question');
asks('Want me to quit SignalRGB now? It won\'t free the 86 GB already lost, but if it\'s the cause, it stops the leak from growing until you reboot.',
  'real: a proposal, then a non-offer sentence');
asks('It\'s open in the Chrome tab.\n\nDo you want me to click **Send message**, or would you rather click it yourself?', 'real: a choice as the last line');
asks('Which number should go on it? You haven\'t given me one, and I shouldn\'t guess a phone number that 121 shop owners will call.\n\nSend it and I\'ll add it under "detailforge.app" in all 121 emails and send you a test.',
  'real: a question two lines up, no offer at the end');
asks('Which screen were you on? If it\'s the old Vehicles step you want back, I\'ll put it back. If it\'s something else, a screenshot would show me exactly where it went.',
  'real: a clarifying question, then a non-offer sentence');

// the open list fix: an unticked list in the middle of the reply does not count, and plain status is done
ok(Q.endsOnOpenList('- [ ] a\n- [ ] b\n  more of b\n'), 'endsOnOpenList: open list with an indented line at the end');
ok(!Q.endsOnOpenList('- [ ] a\n\nThen I merged it.'), 'endsOnOpenList: text after the list');
ok(!Q.endsOnOpenList('- [x] a\n- [x] b'), 'endsOnOpenList: ticked boxes are a progress list');
done('PR #12 merged and deployed. The worktree is removed.', 'plain status');
done('Use `foo?.bar` here, and see https://example.com/a?page=2 for more.', 'code and links are not questions');
done('', 'empty');

// isCloser: the final sentence alone
ok(Q.isCloser('Let me know if you want anything else.'), 'isCloser: let me know if');
ok(!Q.isCloser('Let me know which one you want.'), 'isCloser: let me know which is a choice');
ok(!Q.isCloser('Do you want me to deploy it now?'), 'isCloser: a question');
ok(!Q.ASKS_RE.test('Let me know if you want anything else.'), 'ASKS_RE: let me know if is no longer an ask');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
