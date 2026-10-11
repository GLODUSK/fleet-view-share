#!/usr/bin/env node
// Tests conversation.js's queue (the messages typed while Claude works, from the log's queue-operation lines): a
// log is written to a temp file a few lines at a time and read as the server reads it. Prints PASS/FAIL per check
// and exits 1 on any failure.
//   node scripts/conversation-queue-test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { transcriptOf } = require('../conversation.js');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-queue-test-'));
const FILE = path.join(DIR, 'log.jsonl');
let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) console.log(`PASS: ${name}`);
  else { failures++; console.log(`FAIL: ${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`); }
};
const op = (operation, content) => ({ type: 'queue-operation', operation, timestamp: new Date().toISOString(), sessionId: 's', ...(content == null ? {} : { content }) });
const add = (...recs) => fs.appendFileSync(FILE, recs.map((r) => JSON.stringify(r) + '\n').join(''));
const queue = async () => (await transcriptOf(FILE)).queue;

(async () => {
  try {
    add({ type: 'custom-title', customTitle: 'x', sessionId: 's' },
      { type: 'user', uuid: 'u1', timestamp: new Date().toISOString(), message: { role: 'user', content: 'start' } });
    check('nothing queued', await queue(), []);
    add(op('enqueue', 'pillar looks good'));
    check('a message typed mid-turn is queued', await queue(), ['pillar looks good']);
    add(op('enqueue', 'second one'));
    check('two, oldest first', await queue(), ['pillar looks good', 'second one']);
    add(op('remove', 'pillar looks good'));
    check('absorbed mid-turn: out of the queue', await queue(), ['second one']);
    add(op('dequeue'));
    check('a dequeue with no content takes the oldest', await queue(), []);
  } finally {
    fs.rmSync(DIR, { recursive: true, force: true });
  }
  console.log(failures ? `${failures} failed` : 'all passed');
  process.exit(failures ? 1 : 0);
})();
