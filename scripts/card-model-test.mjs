// Tests for web/card-model.js (the pure pieces cards.js re-exports and the phone app imports): the state tests, the
// time and cost text, the colours, and that cards.js hands the page the very same ones. Plain asserts, no
// dependencies: node scripts/card-model-test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as model from '../web/card-model.js';
import * as cards from '../web/cards.js';

const { C, isBusy, needsYou, ago, fmtCost } = model;

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok', name); };

test('isBusy: WORKING and AGENTS only', () => {
  for (const st of ['WORKING', 'AGENTS']) assert.equal(isBusy(st), true, st);
  for (const st of ['ASKING', 'QUESTION', 'ERROR', 'STALLED', 'DONE', 'HANDOFF', '', undefined, null]) assert.equal(isBusy(st), false, String(st));
});

test('needsYou: ASKING, QUESTION, ERROR and STALLED only', () => {
  for (const st of ['ASKING', 'QUESTION', 'ERROR', 'STALLED']) assert.equal(needsYou(st), true, st);
  for (const st of ['WORKING', 'AGENTS', 'DONE', 'HANDOFF', 'asking', '', undefined, null]) assert.equal(needsYou(st), false, String(st));
});

test('ago: seconds under a minute, minutes under an hour, then hours to one place', () => {
  assert.equal(ago(0), '0s');
  assert.equal(ago(-5000), '0s');
  assert.equal(ago(1499), '1s');
  assert.equal(ago(42e3), '42s');
  assert.equal(ago(59e3), '59s');
  assert.equal(ago(60e3), '1m');
  assert.equal(ago(7 * 60e3 + 29e3), '7m');
  assert.equal(ago(3599e3), '60m');
  assert.equal(ago(3600e3), '1.0h');
  assert.equal(ago(1.5 * 3600e3), '1.5h');
  assert.equal(ago(30 * 3600e3), '30.0h');
});

test('fmtCost: cents under $100, whole dollars with commas from $100, nothing as $0.00', () => {
  assert.equal(fmtCost(0), '$0.00');
  assert.equal(fmtCost(undefined), '$0.00');
  assert.equal(fmtCost(null), '$0.00');
  assert.equal(fmtCost(3.2), '$3.20');
  assert.equal(fmtCost(99.994), '$99.99');
  assert.equal(fmtCost(100), '$100');
  assert.equal(fmtCost(1234.5), '$1,235');
  assert.equal(fmtCost(1234567), '$1,234,567');
});

test('C: every colour is a hex string, and the ones the views name are there', () => {
  for (const [k, v] of Object.entries(C)) assert.match(v, /^#[0-9a-f]{6}$/i, k);
  for (const k of ['bg', 'panel', 'line', 'text', 'dim', 'faint', 'ember', 'gold', 'rose', 'violet', 'cyan', 'mint', 'red', 'agent', 'acctA', 'acctB', 'acctC']) assert.ok(k in C, k);
});

test('the module is pure: it imports nothing and names no browser global', () => {
  const src = readFileSync(new URL('../web/card-model.js', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(src, /\bimport\b/);
  assert.doesNotMatch(src, /\b(window|document|localStorage|fetch|navigator)\b/);
});

test('cards.js re-exports the very same pieces, so the page sees no change', () => {
  for (const name of ['C', 'isBusy', 'needsYou', 'ago', 'fmtCost']) assert.equal(cards[name], model[name], name);
});

console.log(`${n} tests passed`);
