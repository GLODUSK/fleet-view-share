// Tests for sky-events.js (the map's sky event log and the kinds switched off): node scripts/sky-events-test.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSkyEvents, DEFAULT_OFF } = require(path.join(__dirname, '..', 'sky-events.js'));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-sky-'));
try {
  let t = new Date(2026, 9, 14, 15, 42, 7);
  const S = createSkyEvents({ dir, now: () => t });

  // nothing yet: only the kinds off by default (the lone planet, the drifting black hole and the rest of its kind)
  assert.deepStrictEqual(S.route('GET'), [200, { off: DEFAULT_OFF, recent: [] }]);
  for (const k of ['planet', 'lens', 'devour', 'scene-hunt', 'tde', 'evaporation']) assert.ok(DEFAULT_OFF.includes(k), k);

  // a line per event, with this machine's clock
  assert.deepStrictEqual(S.route('POST', { shown: { kind: 'kilonova', label: 'Kilonova', what: 'two neutron stars', ms: 26000.4, where: 'upper left', x: 120.6, y: 80, w: 1600, h: 900 } }), [200, { ok: true }]);
  t = new Date(2026, 9, 14, 15, 43, 30);
  S.log({ kind: 'nebula', label: 'Nebula drift', ms: 90000, where: 'across the sky' });
  const r = S.recent();
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r[0].local, '2026-10-14 15:42:07');
  assert.strictEqual(r[0].x, 121);
  assert.strictEqual(r[0].ms, 26000);
  assert.strictEqual(r[1].kind, 'nebula');
  assert.strictEqual(r[1].x, null);

  // a bad kind or body is refused, and logs nothing
  assert.strictEqual(S.route('POST', { shown: { kind: '../etc' } })[0], 400);
  assert.strictEqual(S.route('POST', null)[0], 400);
  assert.strictEqual(S.route('POST', {})[0], 400);
  assert.strictEqual(S.recent().length, 2);

  // switching kinds off and on; it survives a new instance (a restart)
  assert.deepStrictEqual(S.route('POST', { offAdd: 'frb' })[1].off, [...DEFAULT_OFF, 'frb']);
  assert.deepStrictEqual(S.route('POST', { offAdd: 'frb' })[1].off, [...DEFAULT_OFF, 'frb']);
  assert.deepStrictEqual(S.route('POST', { offAdd: 'big-bang' })[1].off, [...DEFAULT_OFF, 'frb', 'big-bang']);
  assert.deepStrictEqual(S.route('POST', { offRemove: 'frb' })[1].off, [...DEFAULT_OFF, 'big-bang']);
  assert.deepStrictEqual(createSkyEvents({ dir }).off(), [...DEFAULT_OFF, 'big-bang']);
  // a kind off by default switched on stays on after a restart, and can go off again
  const rest = DEFAULT_OFF.filter((k) => k !== 'planet');
  assert.deepStrictEqual(S.route('POST', { offRemove: 'planet' })[1].off, [...rest, 'big-bang']);
  assert.deepStrictEqual(createSkyEvents({ dir }).off(), [...rest, 'big-bang']);
  assert.deepStrictEqual(S.route('POST', { offAdd: 'planet' })[1].off, [...rest, 'big-bang', 'planet']);
  assert.deepStrictEqual(createSkyEvents({ dir }).off().sort(), [...DEFAULT_OFF, 'big-bang'].sort());
  // a file from before the defaults (no on list) gets them
  fs.writeFileSync(path.join(dir, 'sky-events.json'), JSON.stringify({ off: ['frb'] }));
  assert.deepStrictEqual(createSkyEvents({ dir }).off(), ['frb', ...DEFAULT_OFF]);
  assert.deepStrictEqual(S.route('POST', { off: ['jet', 'NOPE', 3, 'qpe'] })[1].off, ['jet', 'qpe']);
  assert.deepStrictEqual(S.route('GET')[1].off, ['jet', 'qpe']);

  // the newest RECENT (50) lines, newest last
  for (let i = 0; i < 60; i++) S.log({ kind: 'frb', label: 'Fast radio burst ' + i });
  const many = S.recent();
  assert.strictEqual(many.length, 50);
  assert.strictEqual(many[49].label, 'Fast radio burst 59');
  console.log('sky-events: ok');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
