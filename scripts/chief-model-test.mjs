// Tests for web/chief-model.js (the Chief's strip in the Bots view: the briefing card, Ask the Chief and the Watch
// mode switch; chats.js draws it and the phone app imports it): the switch, POST /settings's body, the briefing's
// short and long views, the times, the fixture briefing, and that the module stays pure. Plain asserts, no
// dependencies: node scripts/chief-model-test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as m from '../web/chief-model.js';

const { watchOn, watchBody, briefLines, briefSections, briefTime, since, fixtureBriefing } = m;

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok', name); };

const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);
const MIN = 60000;

test('constants: the Chief defaults, the Ask text, the note and the timings', () => {
  assert.deepEqual(m.CHIEF_DEFAULTS, { account: 'B', model: 'claude-sonnet-5-5', effort: 'medium' });
  assert.equal(m.ASK_TEXT, 'Brief me');
  assert.match(m.WATCH_NOTE, /^Off: .+ On: .+/);
  assert.equal(m.WATCH_HOLD_MS, 6000);
  assert.equal(m.BRIEF_MS, 60000);
});

test('watchOn: /state when nothing was flipped', () => {
  assert.equal(watchOn({ settings: { chief: { watch: true } } }, null, NOW), true);
  assert.equal(watchOn({ settings: { chief: { watch: false } } }, null, NOW), false);
  for (const st of [{}, { settings: {} }, { settings: { chief: null } }, null, undefined]) assert.equal(watchOn(st, null, NOW), false);
});

test('watchOn: a just-flipped switch wins for WATCH_HOLD_MS, then /state does', () => {
  const st = { settings: { chief: { watch: false } } };
  assert.equal(watchOn(st, { on: true, at: NOW - 1000 }, NOW), true);
  assert.equal(watchOn(st, { on: true, at: NOW - 5999 }, NOW), true);
  assert.equal(watchOn(st, { on: true, at: NOW - 6000 }, NOW), false);
  assert.equal(watchOn({ settings: { chief: { watch: true } } }, { on: false, at: NOW }, NOW), false);
  assert.equal(watchOn(st, { on: 'yes', at: NOW }, NOW), false, 'only a boolean flip counts');
});

test('watchBody: exactly { chief: { watch } }, a boolean', () => {
  assert.deepEqual(watchBody(true), { chief: { watch: true } });
  assert.deepEqual(watchBody(false), { chief: { watch: false } });
  assert.deepEqual(watchBody(1), { chief: { watch: true } });
  assert.deepEqual(watchBody(undefined), { chief: { watch: false } });
});

test('briefLines: the text as its non-empty lines', () => {
  assert.deepEqual(briefLines({ text: '2 need you:\n- a: asks\n\n   \nFinished: x.  ' }), ['2 need you:', '- a: asks', 'Finished: x.']);
  assert.deepEqual(briefLines({ text: '' }), []);
  assert.deepEqual(briefLines({}), []);
  assert.deepEqual(briefLines(null), []);
});

test('since: now, minutes, hours, days, and empty for none', () => {
  assert.equal(since(NOW - 20e3, NOW), 'now');
  assert.equal(since(NOW - 7 * MIN, NOW), '7m');
  assert.equal(since(NOW - 3 * 60 * MIN, NOW), '3h');
  assert.equal(since(NOW - 2 * 1440 * MIN, NOW), '2d');
  assert.equal(since(NOW + 5 * MIN, NOW), 'now', 'a time ahead of now');
  for (const v of [0, null, undefined, NaN]) assert.equal(since(v, NOW), '');
});

test('briefTime: local HH:MM, empty for none', () => {
  const at = new Date(2026, 9, 11, 9, 5).getTime();
  assert.equal(briefTime({ at }), '09:05');
  assert.equal(briefTime({ at: 0 }), '');
  assert.equal(briefTime({}), '');
  assert.equal(briefTime(null), '');
});

const BRIEF = {
  at: NOW,
  needsYou: [{ id: 's1', name: 'web-fix', repo: 'detailforge-web', what: 'asks: run the migration?', since: NOW - 4 * MIN }],
  working: [{ id: 's2', name: 'phone', repo: null, doing: 'editing bots.tsx', since: NOW - 30 * MIN }],
  finished: [],
  deploys: [{ repo: 'detailforge-web', state: 'live', title: 'Fix the invoice total', at: NOW - 2 * MIN }, { repo: 'x', state: 'bad state!', title: null, at: 0 }],
  text: '1 needs you:',
};

test('briefSections: the non-empty lists, in order, as rows', () => {
  const secs = briefSections(BRIEF, NOW);
  assert.deepEqual(secs.map((s) => [s.key, s.title, s.rows.length]), [['needs', 'Needs you', 1], ['work', 'Working', 1], ['dep', 'Deploys', 2]]);
  assert.deepEqual(secs[0].rows[0], { id: 's1', name: 'web-fix', repo: 'detailforge-web', what: 'asks: run the migration?', when: '4m' });
  assert.deepEqual(secs[1].rows[0], { id: 's2', name: 'phone', repo: '', what: 'editing bots.tsx', when: '30m' });
});

test('briefSections: a deploy row has no id, its state in the repo slot, and a safe state for styling', () => {
  const dep = briefSections(BRIEF, NOW).find((s) => s.key === 'dep').rows;
  assert.deepEqual(dep[0], { id: null, name: 'detailforge-web', repo: 'live', what: 'Fix the invoice total', when: '2m', state: 'live' });
  assert.equal(dep[1].state, '', 'a state that is not one word is not a class');
  assert.equal(dep[1].what, '');
  assert.equal(dep[1].when, '');
});

test('briefSections: none, junk entries and a missing briefing', () => {
  assert.deepEqual(briefSections(null, NOW), []);
  assert.deepEqual(briefSections({ at: NOW }, NOW), []);
  assert.deepEqual(briefSections({ needsYou: [null, 'x', 3], working: 'no' }, NOW), []);
  const rows = briefSections({ finished: [{ id: 42, name: 'n', summary: 's', at: NOW }] }, NOW)[0].rows;
  assert.equal(rows[0].id, null, 'an id that is not a string opens nothing');
});

test('fixtureBriefing: the server shape, from a /state', () => {
  const st = {
    allSessions: [
      { id: 'a', name: 'asker', state: 'QUESTION', waitingOn: 'which branch?', repo: { name: 'r1' }, lastAction: { t: NOW - MIN } },
      { id: 'b', name: 'worker', state: 'WORKING', turnStart: NOW - 5 * MIN, lastAction: { verb: 'editing', what: 'x.js' } },
      { id: 'c', name: 'idle', state: 'IDLE' },
    ],
    finished: [{ id: 'f', name: 'done-one', summary: 'shipped', endedAt: NOW - MIN, repo: { name: 'r2' } }],
    deploys: [{ name: 'web', state: 'live', title: 't', readyAt: NOW }],
  };
  const b = fixtureBriefing(st, NOW);
  assert.equal(b.at, NOW);
  assert.deepEqual(b.needsYou, [{ id: 'a', name: 'asker', repo: 'r1', since: NOW - MIN, what: 'which branch?' }]);
  assert.deepEqual(b.working, [{ id: 'b', name: 'worker', repo: '', doing: 'editing x.js', since: NOW - 5 * MIN }]);
  assert.deepEqual(b.finished, [{ id: 'f', name: 'done-one', repo: 'r2', summary: 'shipped', at: NOW - MIN }]);
  assert.deepEqual(b.deploys, [{ repo: 'web', state: 'live', title: 't', at: NOW }]);
  assert.match(b.text, /^1 needs you: asker \(which branch\?\)\n1 working: worker\n1 finished: done-one \(shipped\)\nDeploy live: web/);
  assert.equal(fixtureBriefing({}, NOW).text, 'Nothing is going on.');
  assert.equal(fixtureBriefing(null, NOW).text, 'Nothing is going on.');
});

test('the module is pure: it imports nothing and names no browser global', () => {
  const src = readFileSync(new URL('../web/chief-model.js', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(src, /\bimport\b/);
  assert.doesNotMatch(src, /\b(window|document|localStorage|fetch|navigator|location)\b/);
});

console.log(`${n} tests passed`);
