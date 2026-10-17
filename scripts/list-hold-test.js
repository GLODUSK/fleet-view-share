// list-hold-test.js: while the server's first list is not ready (startList reads the logs without blocking, so the
// server answers meanwhile), the page's /state (a browser's: sec-fetch-mode) and the API wait for it, LIST_HOLD_MS at
// most, so the map never empties for a moment and `fv` is never told a conversation is not there; a /state with no
// browser headers (another launch's and the window's checks that a server runs) and every other route are answered at
// once, so a slow start never looks like no server. Held ones go in the order they came once the list is ready, or on
// their own after LIST_HOLD_MS; one whose caller gave up meanwhile is dropped (nothing to answer, nothing done after its
// caller was told it failed). fleet-view.js's handle block runs here in a vm on a made-up clock.
// Run: node scripts/list-hold-test.js (exit 0 = all pass)
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let n = 0;
const ok = (what) => { n++; console.log(`ok ${n} - ${what}`); };

const src = fs.readFileSync(path.join(__dirname, '..', 'fleet-view.js'), 'utf8');
const from = src.indexOf('function handle(req, res) {'), to = src.indexOf('function handleRequest(req, res) {');
assert.ok(from > 0 && to > from, 'fleet-view.js has the request hold block');
const block = src.slice(from, to);

// timers on a made-up clock
let now = 0;
const timers = new Map();
let timerN = 0;
const setTimeoutX = (fn, ms) => { const id = ++timerN; timers.set(id, { at: now + ms, fn }); return id; };
const clearTimeoutX = (id) => { timers.delete(id); };
const advance = (ms) => {
  now += ms;
  for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) if (t.at <= now && timers.has(id)) { timers.delete(id); t.fn(); }
};

const handled = [];
const ctx = {
  setTimeout: setTimeoutX, clearTimeout: clearTimeoutX, String,
  boot: { first: new Set() }, bootServed: () => {}, bootMs: () => now,
  STALLS_JS: { label: (m, u) => `${m} ${u}` }, STALLS: { request: () => () => {}, timed: (name, fn) => fn() },
  handleRequest: (req) => { handled.push(`${req.method} ${req.url}`); }, requestFailed: () => {},
};
vm.createContext(ctx);
vm.runInContext(block + '\n;globalThis.T = { handle, listIsReady, LIST_HOLD_MS, get listReady() { return listReady; } };', ctx);
const T = ctx.T;
const req = (method, url, headers = {}) => ({ method, url, headers });
const res = () => ({ destroyed: false, once: () => {} });

// ---------- before the list is ready ----------
T.handle(req('GET', '/state', { 'sec-fetch-mode': 'cors' }), res());
T.handle(req('GET', '/api/conversations?state=WORKING'), res());
T.handle(req('POST', '/api/sessions/x/send'), res());
T.handle(req('GET', '/api'), res());
const gone = res();
T.handle(req('GET', '/api/sessions/y'), gone);
T.handle(req('GET', '/state'), res()); // the launcher's, the window's check
T.handle(req('GET', '/health'), res());
T.handle(req('POST', '/settings'), res());
T.handle(req('GET', '/'), res());
assert.deepStrictEqual(handled, ['GET /state', 'GET /health', 'POST /settings', 'GET /']);
ok('before the list: a browser\'s /state and the API wait; a check that a server runs, /health and the rest are answered at once');

// ---------- the list is ready: the held ones in order, but not one whose caller left ----------
gone.destroyed = true;
handled.length = 0;
T.listIsReady();
assert.strictEqual(T.listReady, true);
assert.deepStrictEqual(handled, ['GET /state', 'GET /api/conversations?state=WORKING', 'POST /api/sessions/x/send', 'GET /api']);
advance(T.LIST_HOLD_MS * 2);
assert.strictEqual(handled.length, 4, 'and each once: its own time limit does not run it again');
handled.length = 0;
T.handle(req('GET', '/state', { 'sec-fetch-mode': 'cors' }), res());
assert.deepStrictEqual(handled, ['GET /state'], 'once ready, nothing waits');
ok('the list ready: the held ones go in the order they came, each once, less one whose caller gave up');

// ---------- a list that takes longer than LIST_HOLD_MS ----------
const ctx2 = { ...ctx, boot: { first: new Set() } };
const handled2 = [];
ctx2.handleRequest = (r) => { handled2.push(`${r.method} ${r.url}`); };
vm.createContext(ctx2);
vm.runInContext(block + '\n;globalThis.T = { handle, listIsReady, LIST_HOLD_MS };', ctx2);
ctx2.T.handle(req('GET', '/api/conversations'), res());
advance(ctx2.T.LIST_HOLD_MS - 1);
assert.deepStrictEqual(handled2, []);
ctx2.T.handle(req('GET', '/state', { 'sec-fetch-mode': 'same-origin' }), res());
advance(1);
assert.deepStrictEqual(handled2, ['GET /api/conversations'], 'answered as it is after LIST_HOLD_MS');
advance(ctx2.T.LIST_HOLD_MS);
assert.deepStrictEqual(handled2, ['GET /api/conversations', 'GET /state']);
ctx2.T.listIsReady();
assert.strictEqual(handled2.length, 2, 'not again when the list is ready after all');
ok('a slow list: each held one is answered as things are after LIST_HOLD_MS of its own, and only once');

console.log(`list-hold-test: ${n} passed`);
