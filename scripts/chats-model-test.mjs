// Tests for web/chats-model.js (the Bots tab's contact model): overseers only (map conversations left out), one row
// per bot across its handoffs and resumes, state.bots rows with no conversation, renames, the Chief row and its
// fallbacks, hidden ones, teams of overseers only, sorting, unread, a storage that throws and raw GET /state (the
// phone app). Plain asserts, no dependencies: node scripts/chats-model-test.mjs
import assert from 'node:assert/strict';
import { buildContacts, sortContacts, teamThread, createChainStore, unread, rawToContactsState, previewOf, replyLine } from '../web/chats-model.js';

const KEY = 'fv.chats.chains';
const fake = (init = {}) => {
  const m = { ...init };
  return { m, getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); } };
};
const S = (id, o = {}) => ({ id, name: id, state: 'DONE', label: 'DONE', stateColor: '#fff', account: 'A', repo: null, last: 1000, lastReply: null, waitingOn: null, lastAction: null, goal: null, ...o });
const T = 1e12;
const B1 = 'b1b1b1b1b1b1', B2 = 'b2b2b2b2b2b2', GONE = 'dededededede';
const BOT = (id, o = {}) => ({ id, name: `bot ${id.slice(0, 2)}`, brief: '', account: 'B', model: 'claude-sonnet-5-5', effort: 'medium', folder: `C:\\Users\\h\\Bots\\${id}`, createdAt: T, convId: null, live: false, ...o });
let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok', name); };
const st = (o) => ({ allSessions: [], sessions: [], pending: [], finishedSessions: [], teams: [], ...o });
const build = (state, o = {}) => buildContacts(state, { chains: createChainStore(fake()), ...o });

// a bot's conversations a -> b -> c across two handoffs; c is live. m is a map conversation
const a = S('a', { bot: B1, last: T + 1, handoff: { next: 'b', at: T + 1 } });
const b = S('b', { bot: B1, last: T + 2, pickedUpFrom: { id: 'a' }, handoff: { next: 'c', at: T + 2 } });
const c = S('c', { bot: B1, last: T + 3, state: 'WORKING', label: 'WORKING', pickedUpFrom: { id: 'b' }, lastAction: { who: 'main', verb: 'edit', what: 'x.ts' } });
const m = S('m', { last: T + 50, state: 'ASKING', waitingOn: 'map work?' });

test('map conversations are left out; a bot is one row keyed bot:<id> across its handoffs', () => {
  const rows = build(st({ allSessions: [a, b, c, m], sessions: [m], bots: [BOT(B1, { name: 'Watcher', convId: 'c', live: true })] }));
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.deepEqual([r.key, r.kind, r.botId, r.id, r.name, r.live], [`bot:${B1}`, 'bot', B1, 'c', 'Watcher', true]);
  assert.deepEqual(r.ids, ['a', 'b', 'c']);
  assert.equal(r.at, T + 3);
  assert.equal(r.busy, true);
  assert.equal(r.preview, 'edit x.ts');
  assert.equal(build(st({ allSessions: [m], sessions: [m] })).length, 0);
});

test('a resume with no handoff link joins the same row; the running one (convId) is the one it opens', () => {
  const r2 = S('r', { bot: B1, last: T + 9 }); // DONE, its claude still up
  const rows = build(st({ allSessions: [a, b, c, r2], bots: [BOT(B1, { convId: 'r', live: true })] }));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].ids, ['a', 'b', 'c', 'r']);
  assert.equal(rows[0].id, 'r');
  // with no convId: the newest live one
  assert.equal(build(st({ allSessions: [a, b, c, r2], bots: [BOT(B1)] }))[0].id, 'c');
});

test('the name: a Fleet View rename (the newest) wins, else the bot\'s, else the conversation\'s', () => {
  const r1 = { ...a, name: 'old name', renamed: true }, r2 = { ...b, name: 'newer name', renamed: true };
  const bots = [BOT(B1, { name: 'Watcher' })];
  assert.equal(build(st({ allSessions: [r1, r2, c], bots }))[0].name, 'newer name');
  assert.equal(build(st({ allSessions: [a, b, c], bots }))[0].name, 'Watcher');
  assert.equal(build(st({ allSessions: [a, b, c] }))[0].name, 'c'); // no state.bots (an older server)
});

test('a removed bot (tagged, not in state.bots) gets no row; without state.bots every tag gets one', () => {
  const g = S('g', { bot: GONE, state: 'WORKING' });
  assert.deepEqual(build(st({ allSessions: [a, b, c, g], bots: [BOT(B1)] })).map((r) => r.key), [`bot:${B1}`]);
  assert.deepEqual(build(st({ allSessions: [a, b, c, g] })).map((r) => r.key).sort(), [`bot:${B1}`, `bot:${GONE}`]);
});

test('state.bots rows with no conversation listed: id null, NEW, the brief\'s first line or Not started yet', () => {
  const rows = build(st({ bots: [BOT(B1, { brief: '# Orders\n\n- Watch the **deploys** every hour\nmore', createdAt: T + 7 }), BOT(B2)] }));
  const r1 = rows.find((r) => r.botId === B1), r2 = rows.find((r) => r.botId === B2);
  assert.deepEqual([r1.key, r1.kind, r1.id, r1.ids, r1.state, r1.preview, r1.at, r1.live, r1.account], [`bot:${B1}`, 'bot', null, [], 'NEW', 'Watch the deploys every hour', T + 7, false, 'B']);
  assert.deepEqual([r2.name, r2.preview, r2.needsYou, r2.busy, r2.pinned], ['bot b2', 'Not started yet', false, false, false]);
  // its convId known (hidden from the lists): it opens that one; a live one says so
  const h = S('h', { bot: B2 });
  const rows2 = build(st({ allSessions: [h], settings: { hidden: [{ id: 'h', at: T }] }, bots: [BOT(B2, { convId: 'h' }), BOT(B1, { convId: 'zz', live: true })] }));
  const k = rows2.find((r) => r.botId === B2), l = rows2.find((r) => r.botId === B1);
  assert.deepEqual([k.id, k.ids, k.state, k.preview], ['h', ['h'], 'IDLE', 'Not running']);
  assert.deepEqual([l.id, l.live, l.preview], [null, true, 'Starting...']);
});

test('the Chief by its tag, renamed or not, and the placeholder', () => {
  const ch = S('ch', { bot: 'chief', state: 'IDLE', last: T + 4 });
  const rows = build(st({ allSessions: [ch, a, b, c], bots: [BOT(B1)] }), { chiefPlaceholder: true });
  const chief = rows.filter((r) => r.key === 'chief');
  assert.equal(chief.length, 1);
  assert.deepEqual([chief[0].kind, chief[0].pinned, chief[0].name, chief[0].id, chief[0].botId], ['chief', true, 'Chief', 'ch', undefined]);
  assert.equal(sortContacts(rows)[0].key, 'chief');
  const boss = { ...ch, renamed: true, name: 'Boss' };
  assert.deepEqual(build(st({ allSessions: [boss] }))[0].name, 'Boss');
  const none = build(st({ sessions: [m] }), { chiefPlaceholder: true });
  assert.equal(none.length, 1);
  const ph = none[0];
  assert.deepEqual([ph.key, ph.kind, ph.id, ph.ids, ph.name, ph.state, ph.preview, ph.pinned], ['chief', 'chief', null, [], 'Chief', 'NEW', 'Not started yet', true]);
  assert.equal(build(st({ sessions: [m] })).some((r) => r.key === 'chief'), false);
});

test('chiefId still finds an untagged Chief and its chain of handoffs', () => {
  const x = S('x', { last: T + 1, handoff: { next: 'y', at: T + 1 } });
  const y = S('y', { last: T + 2, state: 'IDLE', pickedUpFrom: { id: 'x' } });
  const rows = build(st({ allSessions: [x, y, m] }), { chiefId: 'x', chiefPlaceholder: true });
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].key, rows[0].id, rows[0].ids], ['chief', 'y', ['x', 'y']]);
  // the store remembers the chain when its first one has left the lists
  const store = createChainStore(fake());
  buildContacts(st({ allSessions: [x, y] }), { chains: store, chiefId: 'x' });
  const later = S('z', { last: T + 3, state: 'WORKING', pickedUpFrom: { id: 'y' } });
  const r2 = buildContacts(st({ allSessions: [y, later] }), { chains: store, chiefId: 'x' });
  assert.deepEqual([r2.length, r2[0].key, r2[0].id], [1, 'chief', 'z']);
  // a tag wins over the fallback
  assert.equal(build(st({ allSessions: [{ ...x, bot: B1 }] }), { chiefId: 'x' })[0].key, `bot:${B1}`);
});

test('hidden overseer conversations are left out unless they worked again after', () => {
  const ch = S('ch', { bot: 'chief', state: 'DONE', last: T + 4 });
  const hid = { hidden: [{ id: 'ch', at: T + 5 }] };
  assert.equal(build(st({ allSessions: [ch], settings: hid }), { chiefPlaceholder: true })[0].id, null);
  const back = { ...ch, state: 'WORKING', active: T + 9 };
  assert.equal(build(st({ allSessions: [back], settings: hid }), { chiefPlaceholder: true })[0].id, 'ch');
});

const ch = S('ch', { bot: 'chief', state: 'IDLE', last: T + 4 });
const q = S('q', { bot: B2, state: 'ASKING', waitingOn: 'which one?' });
const team = { id: 't1', name: 'duo', color: '#0f0', order: 'ship it', at: T + 10, lead: 'a', members: ['a', 'zzz', 'q', 'ch'], messages: [
  { t: T + 30, from: 'q', to: 'a', text: 'second' }, { t: T + 20, from: 'a', to: 'q', text: 'first' }, { t: T + 40, from: 'unknown-id-123456', to: 'a', text: 'last' }] };

test('teams: only when every member the state knows is an overseer; members resolve to their rows, the lead marked', () => {
  const rows = build(st({ allSessions: [a, b, c, q, ch, m], teams: [team, { ...team, id: 't2', members: ['nobody'] }, { ...team, id: 't3', members: ['c', 'm'] }] }));
  const teams = rows.filter((r) => r.kind === 'team');
  assert.deepEqual(teams.map((t) => t.key), ['team:t1']);
  const t = teams[0];
  assert.deepEqual(t.members, [{ id: 'c', name: 'c', lead: true }, { id: 'q', name: 'q', lead: false }, { id: 'ch', name: 'Chief', lead: false }]);
  assert.equal(t.at, T + 40); assert.equal(t.needsYou, true); assert.equal(t.busy, true);
  assert.equal(t.preview, 'unknown-: last');
  const noMsg = build(st({ allSessions: [a, b, c], teams: [{ ...team, messages: [] }] })).find((r) => r.kind === 'team');
  assert.equal(noMsg.preview, 'ship it'); assert.equal(noMsg.at, T + 10);
});

test('teamThread: oldest first, names resolved through handoffs, unknown ids shortened', () => {
  const th = teamThread(team, st({ allSessions: [a, b, c, S('q')] }));
  assert.deepEqual(th.map((x) => x.text), ['first', 'second', 'last']);
  assert.equal(th[0].fromName, 'c'); assert.equal(th[0].toName, 'q');
  assert.equal(th[2].fromName, 'unknown-');
});

test('previews: question, activity, first real reply line, goal; one line of at most 140 characters', () => {
  const p = (o) => build(st({ allSessions: [S('p', { bot: B1, ...o })] }))[0].preview;
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
  assert.equal(buildContacts(st({ allSessions: [S('k1', { state: 'IDLE' })] }), { chains: sb, chiefId: 'k1' })[0].key, 'chief');
  assert.equal(createChainStore(null).keyFor('k'), 'k');
});

test('raw GET /state: overseers get rows (tags and state.bots kept), map ones never; hidden and handed-off ones left out', () => {
  const live = S('live', { state: 'WORKING', label: 'WORKING', last: T + 9 });
  const fin = S('fin', { last: T + 5 });
  const hid = S('hid', { bot: B2, state: 'ASKING', last: T + 2 });
  const back = S('back', { bot: 'chief', state: 'WORKING', last: T + 50, active: T + 50 }); // hidden, worked again after
  const raw = {
    sessions: [a, b, c, live, fin, hid, back],
    finished: [{ id: 'a' }, { id: 'b' }, { id: 'fin' }],
    settings: { hidden: [{ id: 'hid', at: T + 3 }, { id: 'back', at: T + 10 }] },
    teams: [{ id: 't1', name: 'pair', members: ['live', 'fin'], messages: [] }, { id: 't2', name: 'overseers', members: ['c', 'back'], messages: [] }],
    bots: [BOT(B1, { name: 'Watcher', convId: 'c', live: true }), BOT(B2, { name: 'Asker' })],
  };
  const d = rawToContactsState(raw);
  assert.deepEqual(d.sessions.map((x) => x.id), ['live']);
  assert.deepEqual(d.finishedSessions.map((x) => x.id), ['fin']);
  assert.equal(d.allSessions.length, 7);
  assert.equal(d.allSessions.find((x) => x.id === 'c').bot, B1);
  assert.equal(d.bots.length, 2);
  assert.deepEqual(d.pending, []);
  const rows = build(raw);
  assert.deepEqual(rows.map((r) => r.key).sort(), [`bot:${B1}`, `bot:${B2}`, 'chief', 'team:t2']);
  assert.deepEqual(rows.find((r) => r.key === `bot:${B1}`).ids, ['a', 'b', 'c']);
  assert.equal(rows.find((r) => r.key === 'chief').id, 'back');
  assert.deepEqual([rows.find((r) => r.key === `bot:${B2}`).id, rows.find((r) => r.key === `bot:${B2}`).state], [null, 'NEW']); // its one conversation is hidden
  assert.equal(rows.find((r) => r.kind === 'team').members.length, 2);
  assert.deepEqual(rawToContactsState(null).sessions, []);
  assert.deepEqual(build(undefined), []);
});

test('replyLine: the first line that says something, marks stripped', () => {
  assert.equal(replyLine('## Done\n\n```js\n| a | b |\n|---|---|\n---\n- **Merged** `#248`, live.'), 'Merged #248, live.');
  assert.equal(replyLine('> 1. quoted step'), '1. quoted step');
  assert.equal(replyLine('2) second'), 'second');
  assert.equal(replyLine('# only a heading\n```'), '');
  assert.equal(replyLine(null), '');
});

test('previewOf: the question, then the action, then the last reply or the goal', () => {
  assert.equal(previewOf({ state: 'QUESTION', waitingOn: 'Which branch?', lastReply: 'x' }), 'Which branch?');
  assert.equal(previewOf({ state: 'ASKING', lastReply: '# Plan\nShall I merge?' }), 'Shall I merge?');
  assert.equal(previewOf({ state: 'WORKING', lastAction: { verb: 'edit', what: 'a.ts' } }), 'edit a.ts');
  assert.equal(previewOf({ state: 'AGENTS', lastAction: { who: 'build', verb: 'run', what: 'tests' } }), 'build: run tests');
  assert.equal(previewOf({ state: 'IDLE', lastReply: '\n\nShipped it.\nMore.' }), 'Shipped it.');
  assert.equal(previewOf({ state: 'DONE', goal: '  fix   the menu ' }), 'fix the menu');
  assert.equal(previewOf({ state: 'IDLE', lastReply: 'x'.repeat(200) }).length, 140);
  assert.equal(previewOf({ state: 'IDLE' }), '');
});

console.log(`${n} tests passed`);
