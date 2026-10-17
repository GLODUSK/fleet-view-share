// Tests for page-errors.js (the log of the page's own errors) and the map's guards against odd data (web/map.js
// saneSession, healPos, loaded as an ES module with a stub document): node scripts/page-errors-test.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { createPageErrors, PER_MIN } = require(path.join(__dirname, '..', 'page-errors.js'));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-page-errors-'));
(async () => {
  // ---------- page-errors.js ----------
  let t = new Date(2026, 9, 17, 9, 5, 3);
  const E = createPageErrors({ dir, version: () => '1.0.400', now: () => t });
  assert.deepStrictEqual(E.route('GET'), [200, { recent: [] }]);

  // a line per error, with this machine's clock and the server's version; long text is cut
  assert.deepStrictEqual(E.route('POST', { where: 'map frame', message: "Cannot read properties of undefined (reading 'startsWith')", stack: 'at drawLook (map.js:10062)', more: 3 }), [200, { ok: true }]);
  E.log({ message: 'x'.repeat(900), stack: 's'.repeat(5000), more: -2 });
  let r = E.recent();
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r[0].local, '2026-10-17 09:05:03');
  assert.strictEqual(r[0].version, '1.0.400');
  assert.strictEqual(r[0].where, 'map frame');
  assert.strictEqual(r[0].more, 3);
  assert.strictEqual(r[1].where, 'page');
  assert.strictEqual(r[1].message.length, 300);
  assert.strictEqual(r[1].stack.length, 2000);
  assert.strictEqual(r[1].more, 0);

  // a body without a message is refused, and logs nothing
  assert.strictEqual(E.route('POST', null)[0], 400);
  assert.strictEqual(E.route('POST', {})[0], 400);
  assert.strictEqual(E.route('POST', { message: 42 })[0], 400);
  assert.strictEqual(E.recent().length, 2);

  // at most PER_MIN lines a minute, from all pages together; the next minute takes more again
  for (let i = 2; i < PER_MIN; i++) assert.strictEqual(E.route('POST', { message: 'm' + i })[0], 200);
  assert.strictEqual(E.route('POST', { message: 'one too many' })[0], 429);
  assert.strictEqual(E.recent(100).length, PER_MIN);
  t = new Date(2026, 9, 17, 9, 6, 0);
  assert.strictEqual(E.route('POST', { message: 'next minute' })[0], 200);
  r = E.recent(100);
  assert.strictEqual(r[r.length - 1].message, 'next minute');
  console.log('ok page-errors.js');

  // ---------- web/map.js: saneSession, healPos ----------
  // the page's modules are ES modules: copied with a package.json saying so, and a document stub for what runs on load
  const web = path.join(dir, 'web');
  fs.mkdirSync(web);
  fs.writeFileSync(path.join(web, 'package.json'), '{"type":"module"}');
  for (const f of ['map.js', 'sky-far.js']) fs.copyFileSync(path.join(__dirname, '..', 'web', f), path.join(web, f));
  global.document = { addEventListener() {}, hidden: false, documentElement: { classList: { contains: () => false } } };
  const M = await import(pathToFileURL(path.join(web, 'map.js')).href);

  // unusable: off the map
  for (const s of [null, 'x', 7, {}, { id: '' }, { id: 'a' }, { id: 'a', state: 3 }]) assert.strictEqual(M.saneSession(s), false, JSON.stringify(s));
  // a new one has no state yet
  assert.strictEqual(M.saneSession({ id: 'new-1', pending: true }), true);
  // sound lists are left as they are (the same arrays)
  const agents = [{ id: 'g' }], files = [{ key: 'k', t: 1 }], steps = [['checks', 'ok']];
  const good = { id: 'a', state: 'IDLE', agents, files, ship: { pr: 4, steps } };
  assert.strictEqual(M.saneSession(good), true);
  assert.ok(good.agents === agents && good.files === files && good.ship.steps === steps);
  // odd entries are dropped, lists that aren't lists become none
  const odd = { id: 'b', state: 'RUN', agents: [null, { id: 'g' }, 3], files: [null, { key: 'k', t: 1 }], ship: { pr: 5, steps: [null, ['merged', 'ok'], 'x'] } };
  assert.strictEqual(M.saneSession(odd), true);
  assert.deepStrictEqual(odd.agents, [{ id: 'g' }]);
  assert.deepStrictEqual(odd.files, [{ key: 'k', t: 1 }]);
  assert.deepStrictEqual(odd.ship.steps, [['merged', 'ok']]);
  const worse = { id: 'c', state: 'IDLE', agents: { id: 'g' }, files: 'f', ship: 'pr' };
  assert.strictEqual(M.saneSession(worse), true);
  assert.deepStrictEqual(worse.agents, []);
  assert.deepStrictEqual(worse.files, []);
  assert.strictEqual(worse.ship, null);
  const noSteps = { id: 'd', state: 'IDLE', ship: { pr: 6, steps: 'x' } };
  assert.strictEqual(M.saneSession(noSteps), true);
  assert.strictEqual(noSteps.ship.steps, null);

  // NaN and Infinity positions start again beside their base, at rest; sound ones stay put
  const ns = [
    { id: 'r:z', kind: 'repo', p: { x: NaN, y: 5, vx: 1, vy: 1 } },
    { id: 's:a', kind: 'session', p: { x: Infinity, y: 0, vx: NaN, vy: 0 } },
    { id: 's:b', kind: 'session', p: { x: 10, y: 20, vx: NaN, vy: 2 } },
    { id: 's:c', kind: 'session', p: { x: 1, y: 2, vx: 0.5, vy: 0.5 } },
    { id: 'x', kind: 'pr' },
  ];
  assert.strictEqual(M.healPos(ns, () => ({ x: 100, y: -100 })), 2);
  assert.deepStrictEqual(ns[0].p, { x: 100, y: -100, vx: 0, vy: 0 }); // a repo: right on its home
  const a = ns[1].p;
  assert.ok(Number.isFinite(a.x) && Number.isFinite(a.y) && a.vx === 0 && a.vy === 0);
  assert.ok(Math.abs(Math.hypot(a.x - 100, a.y + 100) - 60) < 1e-9); // a session: on a ring beside its hub
  assert.deepStrictEqual(ns[2].p, { x: 10, y: 20, vx: 0, vy: 0 }); // only its speed was bad
  assert.deepStrictEqual(ns[3].p, { x: 1, y: 2, vx: 0.5, vy: 0.5 });
  assert.strictEqual(M.healPos(ns, () => ({ x: 0, y: 0 })), 0);
  assert.strictEqual(M.healPos(undefined, () => ({ x: 0, y: 0 })), 0);
  console.log('ok map.js saneSession, healPos');
})().then(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('page-errors-test: all ok');
}, (e) => {
  fs.rmSync(dir, { recursive: true, force: true });
  console.error(e);
  process.exit(1);
});
