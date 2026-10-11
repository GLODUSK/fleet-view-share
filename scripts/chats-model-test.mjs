// Tests for web/chats-model.js (the Chats tab's contact model): chains across handoffs, renames, the Chief row, teams,
// sorting, unread, a storage that throws and raw GET /state (the phone app). Plain asserts, no dependencies: node scripts/chats-model-test.mjs
import assert from 'node:assert/strict';
import { buildContacts, sortContacts, teamThread, createChainStore, unread, rawToContactsState } from '../web/chats-model.js';

const KEY = 'fv.chats.chains';
const fake = (init = {}) => {
  const m = { ...init };
  return { m, getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); } };
};
const S = (id, o = {}) => ({ id, name: id, state: 'DONE', label: 'DONE', stateColor: '#fff', account: 'A', repo: null, last: 1000, lastReply: null, waitingOn: null, lastAction: null, goal: null, ...o });
const T = 1e12;
let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok', name); };
const st = (o) => ({ allSessions: [], sessions: [], pending: [], finishedSessions: [], teams: [], ...o });
const build = (state, o = {}) => buildContacts(state, { chains: createChainStore(fake()), ...o });

// a -> b -> c across two handoffs; c is live
const a = S('a', { last: T + 1, handoff: { next: 'b', at: T + 1 } });
const b = S('b', { last: T + 2, pickedUpFrom: { id: 'a' }, handoff: { next: 'c', at: T + 2 } });
const c = S('c', { last: T + 3, state: 'WORKING', label: 'WORKING', pickedUpFrom: { id: 'b' }, lastAction: { who: 'main', verb: 'edit', what: 'x.ts' } });

test('a chain across two handoffs is one row', () => {
  const rows = build(st({ allSessions: [a, b, c], sessions: [c], finishedSessions: [a, b] }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'c');
  assert.deepEqual(rows[0].ids, ['a', 'b', 'c']);
  assert.equal(rows[0].key, 'a');
  assert.equal(rows[0].at, T + 3);
  assert.equal(rows[0].busy, true);
  assert.equal(rows[0].preview, 'edit x.ts');
});

test('list order does not matter, and the store remembers a chain whose middle left the lists', () => {
  const store = createChainStore(fake());
  buildContacts(st({ allSessions: [c, b, a], sessions: [c], finishedSessions: [b, a] }), { chains: store });
  assert.equal(store.keyFor('c'), 'a');
  const rows = buildContacts(st({ sessions: [c], finishedSessions: [a] }), { chains: store });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].ids, ['a', 'c']);
});

test('a rename anywhere in the chain wins, newest first', () => {
  const r1 = { ...a, name: 'old name', renamed: true }, r2 = { ...b, name: 'newer name', renamed: true };
  assert.equal(build(st({ allSessions: [r1, r2, c], sessions: [c], finishedSessions: [r1, r2] }))[0].name, 'newer name');
  assert.equal(build(st({ allSessions: [a, b, c], sessions: [c], finishedSessions: [a, b] }))[0].name, 'c');
});

test('a handoff stand-in folds into its chain', () => {
  const stand = { ...a, state: 'HANDOFF', label: 'HANDING OFF', handoff: { next: 'b', at: T } };
  const pick = S('b', { last: T + 5, state: 'WORKING', pickedUpFrom: { id: 'a' } });
  const rows = build(st({ allSessions: [a, pick], sessions: [stand, pick] }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'b');
  assert.deepEqual(rows[0].ids, ['a', 'b']);
  assert.equal(build(st({ allSessions: [a], sessions: [stand] }))[0].state, 'HANDOFF');
});

test('the Chief row, renamed or not, and the placeholder', () => {
  const rows = build(st({ allSessions: [a, b, c], sessions: [c], finishedSessions: [a, b] }), { chiefId: 'a' });
  assert.deepEqual([rows[0].kind, rows[0].key, rows[0].pinned, rows[0].name], ['chief', 'chief', true, 'Chief']);
  const boss = { ...c, renamed: true, name: 'Boss' };
  const ren = build(st({ allSessions: [boss], sessions: [boss] }), { chiefId: 'c' });
  assert.deepEqual([ren[0].name, ren[0].kind], ['Boss', 'chief']);
  const none = build(st({ sessions: [S('x', { state: 'WORKING' })] }), { chiefPlaceholder: true });
  const ph = none.find((r) => r.key === 'chief');
  assert.deepEqual([ph.kind, ph.id, ph.ids, ph.name, ph.state, ph.preview, ph.pinned], ['chief', null, [], 'Chief', 'NEW', 'Not started yet', true]);
  assert.equal(build(st({ sessions: [c] })).some((r) => r.key === 'chief'), false);
  assert.equal(build(st({ sessions: [c] }), { chiefId: 'c', chiefPlaceholder: true }).filter((r) => r.key === 'chief').length, 1);
});

const team = { id: 't1', name: 'duo', color: '#0f0', order: 'ship it', at: T + 10, lead: 'a', members: ['a', 'zzz', 'q'], messages: [
  { t: T + 30, from: 'q', to: 'a', text: 'second' }, { t: T + 20, from: 'a', to: 'q', text: 'first' }, { t: T + 40, from: 'unknown-id-123456', to: 'a', text: 'last' }] };

test('team rows resolve members through chains, mark the lead; needs and busy follow members', () => {
  const q = S('q', { state: 'ASKING', waitingOn: 'which one?' });
  const rows = build(st({ allSessions: [a, b, c, q], sessions: [c, q], finishedSessions: [a, b], teams: [team, { ...team, id: 't2', members: ['nobody'] }] }));
  const teams = rows.filter((r) => r.kind === 'team');
  assert.equal(teams.length, 1);
  const t = teams[0];
  assert.deepEqual(t.members, [{ id: 'c', name: 'c', lead: true }, { id: 'q', name: 'q', lead: false }]);
  assert.equal(t.at, T + 40); assert.equal(t.needsYou, true); assert.equal(t.busy, true);
  assert.equal(t.preview, 'unknown-: last');
  const noMsg = build(st({ sessions: [c], allSessions: [a, b, c], teams: [{ ...team, messages: [] }] })).find((r) => r.kind === 'team');
  assert.equal(noMsg.preview, 'ship it'); assert.equal(noMsg.at, T + 10);
});

test('teamThread: oldest first, names resolved through handoffs, unknown ids shortened', () => {
  const th = teamThread(team, st({ allSessions: [a, b, c, S('q')] }));
  assert.deepEqual(th.map((m) => m.text), ['first', 'second', 'last']);
  assert.equal(th[0].fromName, 'c'); assert.equal(th[0].toName, 'q');
  assert.equal(th[2].fromName, 'unknown-');
});

test('previews: question, activity, first real reply line, goal; one line of at most 140 characters', () => {
  const p = (o) => build(st({ sessions: [S('p', o)] }))[0].preview;
  assert.equal(p({ state: 'ASKING', waitingOn: 'Merge it?' }), 'Merge it?');
  assert.equal(p({ state: 'WORKING', lastAction: { who: 'build:x', verb: 'edit', what: 'a.ts' } }), 'build:x: edit a.ts');
  assert.equal(p({ lastReply: '# Title\n\n```js\n```\n| a | b |\n|---|---|\n**Shipped** the thing\nmore' }), 'Shipped the thing');
  assert.equal(p({ goal: 'Do the work' }), 'Do the work');
  const long = p({ lastReply: 'word '.repeat(100) });
  assert.ok(long.length <= 140 && !long.includes('\n'));
});

test('sortContacts: Chief, then needs-you longest waiting, then newest', () => {
  const r = (key, at, o = {}) => ({ key, kind: 'bot', at, needsYou: false, pinned: false, ...o });
  const out = sortContacts([r('new', 50), r('old', 10), r('n2', 40, { needsYou: true }), r('n1', 20, { needsYou: true }), r('chief', 1, { kind: 'chief', pinned: true })]);
  assert.deepEqual(out.map((x) => x.key), ['chief', 'n1', 'n2', 'new', 'old']);
});

test('unread', () => {
  assert.equal(unread({ key: 'k', at: 5 }, {}), true);
  assert.equal(unread({ key: 'k', at: 5 }, { k: 5 }), false);
  assert.equal(unread({ key: 'k', at: 6 }, { k: 5 }), true);
  assert.equal(unread({ key: 'k', at: 0 }, {}), false);
});

test('chain store: persists, saves only on change, caps at 2000, survives a throwing storage', () => {
  const f = fake(); let writes = 0; const set = f.setItem; f.setItem = (k, v) => { writes++; set(k, v); };
  const s1 = createChainStore(f);
  assert.equal(s1.keyFor('x'), 'x');
  s1.link('x', 'y'); s1.link('y', 'z'); s1.save(); s1.save();
  assert.equal(writes, 1); assert.equal(s1.keyFor('z'), 'x');
  assert.equal(createChainStore(f).keyFor('y'), 'x');
  const s2 = createChainStore(f); s2.link('x', 'y'); s2.save();
  assert.equal(writes, 1);
  const raw = fake(); const cap = createChainStore(raw);
  for (let i = 0; i < 2100; i++) cap.link('p' + i, 'q' + i);
  cap.save();
  const kept = JSON.parse(raw.m[KEY]);
  assert.equal(Object.keys(kept).length, 2000);
  assert.ok(!('p0' in kept) && 'q2099' in kept);
  const bad = { getItem() { throw new Error('no'); }, setItem() { throw new Error('full'); } };
  const sb = createChainStore(bad);
  sb.link('m', 'n'); sb.save(); sb.save();
  assert.equal(sb.keyFor('n'), 'm');
  assert.equal(buildContacts(st({ sessions: [c] }), { chains: sb }).length, 1);
  assert.equal(createChainStore(null).keyFor('k'), 'k');
});

test('raw GET /state: live and listed finished ones get rows, hidden and handed-off ones do not', () => {
  const live = S('live', { state: 'WORKING', label: 'WORKING', last: T + 9 });
  const fin = S('fin', { last: T + 5 });
  const old = S('old', { last: T + 1 }); // DONE, not in finished
  const hid = S('hid', { state: 'ASKING', last: T + 2 });
  const back = S('back', { state: 'WORKING', last: T + 50, active: T + 50 }); // hidden, worked again after
  const raw = {
    sessions: [a, b, c, live, fin, old, hid, back],
    finished: [{ id: 'a' }, { id: 'b' }, { id: 'fin' }],
    settings: { hidden: [{ id: 'hid', at: T + 3 }, { id: 'back', at: T + 10 }] },
    teams: [{ id: 't1', name: 'pair', members: ['live', 'fin'], messages: [] }],
  };
  const d = rawToContactsState(raw);
  assert.deepEqual(d.sessions.map((x) => x.id), ['c', 'live', 'back']);
  assert.deepEqual(d.finishedSessions.map((x) => x.id), ['fin']); // a and b handed off
  assert.equal(d.allSessions.length, 8);
  assert.deepEqual(d.pending, []);
  const rows = build(raw, { chiefId: 'live' });
  const keys = rows.map((r) => r.key).sort();
  assert.deepEqual(keys, ['a', 'back', 'chief', 'fin', 'team:t1']);
  assert.deepEqual(rows.find((r) => r.key === 'a').ids, ['c']); // the chain's live end, keyed by its first id
  assert.equal(rows.find((r) => r.key === 'chief').id, 'live');
  assert.equal(rows.find((r) => r.kind === 'team').members.length, 2);
  assert.deepEqual(rawToContactsState(null).sessions, []);
  assert.deepEqual(build(undefined), []);
});

console.log(`${n} tests passed`);
