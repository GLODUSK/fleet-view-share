// Tests for web/compose.js's memory of sends, kept per window in sessionStorage so a reload keeps it: the texts typed
// into a session's prompt (sent or not: the next Send clears one of them first, so a message never goes in twice glued to
// itself), and a send to the machine that runs a chat under the page's own id (cid, t0: the same text sent again after
// no answer goes under the same id, which the relay there never runs twice; a new text, or an answer, takes a new one).
// Run: node scripts/compose-sends-test.mjs
import assert from 'node:assert/strict';

// the window's sessionStorage, as a page has it (set before compose.js loads)
const store = new Map();
globalThis.sessionStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const { rememberTyped, typedTexts, linkSendOf, keepLinkSend } = await import('../web/compose.js');

let n = 0;
const ok = (what) => { n++; console.log(`ok ${n} - ${what}`); };
const ID = '0000000e-0000-4000-8000-000000000000';

// ---------- typed texts ----------
assert.deepEqual(typedTexts(ID), []);
rememberTyped(ID, 'fix the build');
rememberTyped(ID, 'and the tests');
rememberTyped(ID, 'fix the build'); // again: once, as the newest
assert.deepEqual(typedTexts(ID), ['and the tests', 'fix the build']);
for (let i = 0; i < 8; i++) rememberTyped(ID, `text ${i}`);
assert.equal(typedTexts(ID).length, 5);
assert.equal(typedTexts(ID).at(-1), 'text 7');
// what a reload finds: the same, from sessionStorage
assert.deepEqual(JSON.parse(store.get('fv.typedTexts'))[ID], typedTexts(ID));
store.set('fv.typedTexts', 'not json');
assert.deepEqual(typedTexts(ID), []);
ok('typed texts: the last five per conversation, newest last, kept in sessionStorage; a bad store reads as none');

// ---------- a send to the other machine ----------
const a = linkSendOf(ID, 'run the tests');
assert.match(a.cid, /^[A-Za-z0-9_-]{16,32}$/);
assert.ok(Math.abs(a.t0 - Date.now()) < 1000);
assert.notEqual(linkSendOf(ID, 'run the tests').cid, a.cid, 'not kept: a new id each time');
keepLinkSend(ID, a);
const again = linkSendOf(ID, 'run the tests');
assert.deepEqual(again, a, 'kept (no answer came): the same id and first try\'s time');
assert.notEqual(linkSendOf(ID, 'run the tests, then deploy').cid, a.cid, 'another text: a new id');
keepLinkSend(ID, null);
assert.notEqual(linkSendOf(ID, 'run the tests').cid, a.cid, 'answered (let go): a new id');
// an old one (30 minutes) is let go
keepLinkSend(ID, { ...a, t0: Date.now() - 31 * 60e3 });
assert.notEqual(linkSendOf(ID, 'run the tests').cid, a.cid);
ok('link sends: a kept one gives the same cid and t0 for the same text; another text, an answer or 30 minutes give a new one');

console.log(`\nall ${n} passed`);
