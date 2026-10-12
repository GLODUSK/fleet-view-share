// Tests for web/chats-model.js (the Bots tab's contact model): overseers only (map conversations left out), one row
// per bot across its handoffs and resumes, state.bots rows with no conversation, renames, the Chief row and its
// fallbacks, hidden ones, teams of overseers only, sorting, unread, a storage that throws and raw GET /state (the
// phone app), a row's moment and look (turnStart, lastAction, running, shape, color), doingOf (the avatar's hover), botChoices and
// botEdits (the New bot and Edit bot forms), mascot.js (thinking, the shapes, the same markup for the same call) and Dynamic
// (sizeTask, dynamicSwitch, the pick store, the switch notes folded into a message's chip) and a bot's Tasks strip (taskSchedule,
// taskWhen, taskLine, tasksHead). Plain asserts, no dependencies:
// node scripts/chats-model-test.mjs
import assert from 'node:assert/strict';
import { buildContacts, sortContacts, teamThread, createChainStore, unread, rawToContactsState, previewOf, replyLine, botFeed, setupNote, doingOf, botChoices, botEdits,
  sizeTask, dynamicSwitch, switchNote, reactionOf, DYNAMIC, taskSchedule, taskWhen, taskLine, tasksHead } from '../web/chats-model.js';
import { SHAPES, shapeFor, mascotState, mascotSVG } from '../web/mascot.js';

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

test('another machine\'s bot (elsewhere): a row while its chats are listed, live null so it has no Start', () => {
  const E = 'e1e1e1e1e1e1';
  const x = S('x', { bot: E, name: 'Panchito', last: T + 5 });
  const rows = build(st({ allSessions: [x, m], sessions: [m], bots: [BOT(E, { name: 'Panchito', convId: 'x', elsewhere: true })] }));
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].key, rows[0].id, rows[0].name, rows[0].live, rows[0].elsewhere], [`bot:${E}`, 'x', 'Panchito', null, true]);
  // its chats gone from the list: no quiet row (it can't be started here)
  assert.equal(build(st({ allSessions: [m], sessions: [m], bots: [BOT(E, { convId: 'x', elsewhere: true })] })).length, 0);
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

test('botFeed: Fleet View setup notes become small notes, the bare "ok" to one is left out', () => {
  assert.equal(setupNote('[Fleet View] You are Pan. Your id: x.'), 'You are Pan. Your id: x.');
  assert.equal(setupNote('[Fleet View · unsigned, not from Henry]\nhi'), null);
  assert.equal(setupNote('(quoted) [Fleet View] hi'), null);
  assert.equal(setupNote(' [Fleet View] hi'), null);
  assert.equal(setupNote(null), null);
  const items = [
    { key: 1, kind: 'user', text: '[Fleet View] You are Pan, one of the bots. Reply with just "ok".', _j: 'cached' },
    { key: 2, kind: 'thinking', text: 'hmm' },
    { key: 3, kind: 'assistant', text: 'ok' },
    { key: 4, kind: 'user', text: '[Fleet View] Your id: abc. Greet Henry in one short line, nothing more.' },
    { key: 5, kind: 'assistant', text: 'Pan here, ready when you are.' },
    { key: 6, kind: 'user', text: 'do the thing' },
    { key: 7, kind: 'assistant', text: 'OK.' }, // an answer to Henry: kept
    { key: 8, kind: 'user', text: '[Fleet View] x', images: [{ src: 'data:' }] }, // with an image: not Fleet View's
  ];
  const out = botFeed(items);
  assert.deepEqual(out.map((it) => it.key), [1, 2, 4, 5, 6, 7, 8]);
  assert.equal(out[0].kind, 'setup'); assert.equal(out[0].text, 'You are Pan, one of the bots. Reply with just "ok".');
  assert.equal('_j' in out[0], false); // the cached JSON of the user form is not carried over
  assert.equal(items[0].kind, 'user'); // the items themselves are left as they came
  assert.equal(out[2].kind, 'setup');
  assert.equal(out[6].kind, 'user');
  // a reply after a note that says something is kept, and "ok" after a note with Henry's message between is kept too
  assert.deepEqual(botFeed([{ key: 1, kind: 'user', text: '[Fleet View] a' }, { key: 2, kind: 'user', text: 'hi' }, { key: 3, kind: 'assistant', text: 'ok' }]).map((it) => it.key), [1, 2, 3]);
  assert.deepEqual(botFeed(null), []);
});

test("a bot row carries its conversation's moment and the bot's own look; a bad colour is left out", () => {
  const live = S('L', { bot: B1, state: 'WORKING', turnStart: T + 5, lastAction: { t: T + 2, verb: 'read', what: 'a.md' }, running: [{ tool: 'Bash', what: 'npm test', at: T + 6 }], waitingOn: null });
  const rows = build(st({ allSessions: [live], bots: [BOT(B1, { convId: 'L', live: true, shape: 'heart', color: '#FF6B80' }), BOT(B2, { shape: 'blob', color: 'red' })] }));
  const r1 = rows.find((r) => r.botId === B1), r2 = rows.find((r) => r.botId === B2);
  assert.deepEqual([r1.turnStart, r1.lastAction.what, r1.running[0].tool, r1.shape, r1.color], [T + 5, 'a.md', 'Bash', 'heart', '#FF6B80']);
  assert.deepEqual([r2.turnStart, r2.lastAction, r2.running, r2.shape, r2.color], [null, null, null, 'blob', null]); // a shape mascot.js does not know is ignored there
});
test("doingOf: what the avatar's hover says, per face", () => {
  const bot = (o) => ({ kind: 'bot', id: 'x', live: true, preview: '', ...o });
  assert.equal(doingOf(bot({}), 'thinking'), 'Thinking about your message');
  assert.equal(doingOf(bot({ running: [{ tool: 'Bash', what: 'npm test' }] }), 'working'), 'Working: Bash npm test');
  assert.equal(doingOf(bot({ running: [{ tool: 'Read', agent: 'scout', what: 'x' }] }), 'working'), 'Working: scout: Read x');
  assert.equal(doingOf(bot({ lastAction: { who: 'main', verb: 'edit', what: 'chats.js' } }), 'working'), 'Working: edit chats.js');
  assert.equal(doingOf(bot({}), 'working'), 'Working');
  assert.equal(doingOf(bot({ waitingOn: 'Ship it?' }), 'needs'), 'Needs you: Ship it?');
  assert.equal(doingOf(bot({ preview: 'All green.' }), 'done'), 'Done: All green.');
  assert.equal(doingOf(bot({}), 'idle'), 'Idle');
  assert.equal(doingOf(bot({ live: false }), 'idle'), 'Not running: Start it, or send it a message');
  assert.equal(doingOf(bot({ live: false, id: null }), 'new'), 'Not started yet');
  assert.equal(doingOf({ kind: 'chief', id: null }, 'new'), 'Not started yet');
  assert.equal(doingOf(null, 'idle'), '');
  assert.ok(doingOf(bot({ preview: 'x'.repeat(300) }), 'done').length < 140);
});
test('mascot.js: thinking until a tool runs in this turn; the shapes; the same call gives the same markup', () => {
  const w = { state: 'WORKING', turnStart: 1000 };
  assert.equal(mascotState(w), 'thinking');
  assert.equal(mascotState({ ...w, lastAction: { t: 900 } }), 'thinking'); // an action from before this turn
  assert.equal(mascotState({ ...w, lastAction: { t: 1000 } }), 'working');
  assert.equal(mascotState({ ...w, running: [{ tool: 'Bash' }] }), 'working');
  assert.equal(mascotState({ state: 'WORKING' }), 'working'); // no turnStart: it can't say
  assert.equal(mascotState({ state: 'AGENTS', turnStart: 1000 }), 'working');
  assert.equal(mascotState({ state: 'DONE' }), 'done');
  assert.equal(mascotState(null), 'idle');
  for (const k of ['clover', 'flower', 'heart']) assert.ok(SHAPES.includes(k));
  // a seed's pick is what it was before the new shapes came
  for (const seed of ['chief', 'bot:aaaaaaaaaaaa', 'x', '']) assert.ok(SHAPES.slice(0, 7).includes(shapeFor(seed)));
  for (const shape of SHAPES) {
    for (const state of ['working', 'thinking', 'needs', 'error', 'done', 'idle', 'new']) {
      const svg = mascotSVG('seed', { state, shape, color: '#58a6ff', size: 40 });
      assert.match(svg, new RegExp(`^<svg class="mascot m-${state} m-d[0-5]"`));
      assert.equal(svg, mascotSVG('seed', { state, shape, color: '#58a6ff', size: 40 })); // stable: a redraw is no rewrite
      assert.ok(!/NaN|undefined/.test(svg), `${shape} ${state}`);
    }
  }
  assert.match(mascotSVG('s', { state: 'thinking' }), /m-dot3/);
  assert.notEqual(mascotSVG('s', { size: 40 }), mascotSVG('s', { size: 36 }));
  assert.match(mascotSVG('s', { state: 'nope', shape: 'nope', color: 'url(x)' }), /class="mascot m-idle .*fill="#58a6ff"/);
});

test('botChoices: one list per picker, labels, a value no longer offered kept first', () => {
  const ml = (m) => m.toUpperCase();
  const ch = botChoices({ accounts: ['A', 'B'], models: ['m1', 'm2'], efforts: ['low', 'medium', 'xhigh'], modelLabel: ml });
  assert.deepEqual(ch.account, [{ value: 'A', label: 'Account A' }, { value: 'B', label: 'Account B' }]);
  // Dynamic first in the model and effort lists
  assert.deepEqual(ch.model.map((x) => x.label), ['Dynamic', 'M1', 'M2']);
  assert.deepEqual(ch.effort.map((x) => x.label), ['Dynamic', 'Low', 'Medium', 'Extra high']);
  assert.equal(ch.model[0].value, DYNAMIC); assert.equal(ch.effort[0].value, 'dynamic');
  const kept = botChoices({ accounts: ['A'], models: ['m1'], efforts: [], current: { account: 'C', model: 'old' } });
  assert.deepEqual(kept.account.map((x) => x.value), ['C', 'A']);
  assert.deepEqual(kept.model.map((x) => x.value), ['dynamic', 'old', 'm1']);
  assert.deepEqual(botChoices({ models: ['m1'], current: { model: 'dynamic' } }).model.map((x) => x.value), ['dynamic', 'm1']); // not twice
  assert.deepEqual(botChoices({ accounts: ['A'], current: { account: 'A' } }).account.length, 1); // offered: not twice
  assert.deepEqual(botChoices().effort.map((x) => x.value), ['dynamic']);
});
test('botEdits: only what changed, trimmed; the look back to auto is null; colours in lower case', () => {
  const bot = { name: 'Deploy', brief: 'watch it', account: 'B', model: 'm1', effort: 'medium', shape: 'heart', color: '#58a6ff' };
  const same = { name: ' Deploy ', brief: 'watch it\n', account: 'B', model: 'm1', effort: 'medium', shape: 'heart', color: '#58A6FF' };
  assert.deepEqual(botEdits(bot, same), {});
  assert.deepEqual(botEdits(bot, { ...same, name: 'Deploy watch ', effort: 'high' }), { name: 'Deploy watch', effort: 'high' });
  assert.deepEqual(botEdits(bot, { ...same, shape: '', color: '' }), { shape: null, color: null });
  assert.deepEqual(botEdits({ name: 'x' }, { name: 'x', shape: '', color: null }), {}); // auto already
  assert.deepEqual(botEdits({ name: 'x' }, { name: 'x', color: '#AABBCC', shape: 'star' }), { color: '#aabbcc', shape: 'star' });
  assert.deepEqual(botEdits(bot, { ...same, brief: '' }), { brief: '' });
  assert.deepEqual(botEdits(bot, { account: '' }), {}); // an empty pick never clears one
  assert.deepEqual(botEdits(null, { name: 'n' }), { name: 'n' });
});

test('sizeTask: quick questions low on Sonnet, tasks medium, plans and bugs high on Opus, big ones xhigh; go-aheads keep', () => {
  const sz = (t) => { const r = sizeTask(t); return [r.size, r.model || null, r.effort || null]; };
  // go-aheads and acknowledgements: nothing switches
  for (const t of ['ok', 'Yes, do it', 'go ahead please', '2 and 3', 'thanks!', 'sounds good, ship it', 'option 2', '', '   ']) assert.equal(sizeTask(t).size, 'keep', t);
  // quick: questions, greetings, short lookups
  assert.deepEqual(sz('what time is it in Tokyo?'), ['quick', 'sonnet', 'low']);
  assert.deepEqual(sz('hey'), ['quick', 'sonnet', 'low']);
  assert.equal(sizeTask('Good morning!').label, 'Hello');
  assert.deepEqual(sz('check my calendar for tomorrow'), ['quick', 'sonnet', 'low']);
  assert.deepEqual(sz('is the deploy green'), ['quick', 'sonnet', 'low']); // a question, though it names a change
  assert.deepEqual(sz('what should I fix first?'), ['quick', 'sonnet', 'low']);
  assert.deepEqual(sz('can you fix the login?'), ['normal', 'opus', 'medium']); // asks for a change
  assert.deepEqual(sz('can you remind me what we decided about the logo?'), ['quick', 'sonnet', 'low']);
  // normal: a task to do on Opus, a longer question on Sonnet
  assert.deepEqual(sz('fix the typo in the README heading'), ['normal', 'opus', 'medium']);
  assert.deepEqual(sz('draft a reply to the email from the landlord saying the date works'), ['normal', 'opus', 'medium']);
  assert.deepEqual(sz('I was wondering about the difference between the two accounts and which one I usually use for the phone app stuff these days'), ['normal', 'sonnet', 'medium']);
  // big: plans, builds, bug hunts, several parts
  assert.deepEqual(sz('plan the new onboarding flow'), ['big', 'opus', 'high']);
  assert.deepEqual(sz('implement dark mode for the settings page'), ['big', 'opus', 'high']);
  assert.deepEqual(sz('debug why the upload fails'), ['big', 'opus', 'high']);
  assert.deepEqual(sz('the app crashes on launch'), ['big', 'opus', 'high']);
  assert.deepEqual(sz('three things:\n- rename the bot\n- update the brief\n- send me the log'), ['big', 'opus', 'high']);
  // huge: a big plan, a hard bug, a long brief
  assert.deepEqual(sz('plan a full redesign of the whole dashboard'), ['huge', 'opus', 'xhigh']);
  assert.deepEqual(sz('debug the race condition in the sync'), ['huge', 'opus', 'xhigh']);
  assert.equal(sizeTask('word '.repeat(450)).label, 'Long brief');
  // a quoted reply is about the quote, not sized by it
  assert.deepEqual(sz(`> ${'plan the whole architecture '.repeat(20)}\n\nok`), ['keep', null, null]);
  assert.equal(typeof sizeTask(null).label, 'string');
});
test('dynamicSwitch: only what is dynamic and differs; the same family stays; nothing for a go-ahead', () => {
  const ids = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5-5[1m]', 'claude-sonnet-5-5', 'claude-sonnet-5-5[1m]'];
  const both = { model: true, effort: true };
  const plan = sizeTask('plan the migration'), quick = sizeTask('what is the status?');
  assert.deepEqual(dynamicSwitch(both, plan, { model: 'claude-sonnet-5-5', effort: 'low' }, ids), { model: 'claude-opus-5-5', effort: 'high' });
  assert.deepEqual(dynamicSwitch(both, plan, { model: 'claude-opus-5-5[1m]', effort: 'high' }, ids), {}); // Opus 1M is Opus
  assert.deepEqual(dynamicSwitch(both, quick, { model: 'claude-opus-5-5', effort: null }, ids), { model: 'claude-sonnet-5-5', effort: 'low' }); // unknown effort: set
  assert.deepEqual(dynamicSwitch({ model: false, effort: true }, plan, { model: 'claude-sonnet-5-5', effort: 'low' }, ids), { effort: 'high' });
  assert.deepEqual(dynamicSwitch({ model: true, effort: false }, plan, { model: 'claude-sonnet-5-5', effort: 'low' }, ids), { model: 'claude-opus-5-5' });
  assert.deepEqual(dynamicSwitch(both, sizeTask('ok go'), { model: 'claude-sonnet-5-5', effort: 'low' }, ids), {});
  assert.deepEqual(dynamicSwitch(both, plan, { model: null, effort: 'high' }, ids), { model: 'claude-opus-5-5' }); // model unknown: set
  assert.deepEqual(dynamicSwitch(both, plan, { model: 'claude-sonnet-5-5', effort: 'high' }, []), {}); // no id on offer for it
  assert.deepEqual(dynamicSwitch(null, plan, {}, ids), {});
});
test('botFeed: model and effort switch notes are all left out', () => {
  assert.deepEqual(switchNote('/model claude-opus-5-5'), { model: 'claude-opus-5-5' });
  assert.deepEqual(switchNote('/effort high'), { effort: 'high' });
  assert.deepEqual(switchNote('Set model to Opus 5.5'), {});
  assert.deepEqual(switchNote('Set effort level to high (this session only)'), {});
  assert.equal(switchNote('/model'), null);
  assert.equal(switchNote('Conversation compacted'), null);
  const items = [
    { key: 1, kind: 'assistant', text: 'hi' },
    { key: 2, kind: 'note', text: '/model claude-opus-5-5' },
    { key: 3, kind: 'note', text: 'Set model to Opus 5.5' },
    { key: 4, kind: 'note', text: '/effort high' },
    { key: 5, kind: 'note', text: 'Set effort level to high' },
    { key: 6, kind: 'user', text: 'plan it' },
    { key: 7, kind: 'assistant', text: 'Plan: ...' },
    { key: 8, kind: 'note', text: '/effort low' },
    { key: 9, kind: 'note', text: 'Conversation compacted' },
  ];
  const out = botFeed(items);
  assert.deepEqual(out.map((it) => it.key), [1, 6, 7, 9]);
  assert.equal('switched' in out[1], false);
  // a setup note after a switch is still one
  const s2 = botFeed([{ key: 1, kind: 'note', text: '/effort low' }, { key: 2, kind: 'user', text: '[Fleet View] x' }]);
  assert.deepEqual(s2.map((it) => [it.key, it.kind]), [[2, 'setup']]);
});

test('reactions: a reply starting "[react:<emoji>]" puts the emoji on your last message', () => {
  assert.deepEqual(reactionOf('[react:👍] On it.'), { emoji: '👍', text: 'On it.' });
  assert.deepEqual(reactionOf('  [React: ❤️ ]'), { emoji: '❤️', text: '' });
  assert.equal(reactionOf('[react:yes] hi'), null); // no emoji in it
  assert.equal(reactionOf('ok [react:👍]'), null); // only at the start
  assert.equal(reactionOf(null), null);
  const items = [
    { key: 1, kind: 'user', text: 'do this now', _j: 'cached' },
    { key: 2, kind: 'assistant', text: '[react:👍] Doing it.' },
    { key: 3, kind: 'tool', name: 'Bash' },
    { key: 4, kind: 'assistant', text: '[react:🎉] Done.' }, // one per message: the first stays
    { key: 5, kind: 'user', text: 'love it' },
    { key: 6, kind: 'assistant', text: '[react:❤️]' }, // the whole reply: nothing else shows
  ];
  const out = botFeed(items);
  assert.deepEqual(out.map((it) => [it.key, it.reaction || null, it.kind === 'assistant' ? it.text : null]),
    [[1, '👍', null], [2, null, 'Doing it.'], [3, null, null], [4, null, 'Done.'], [5, '❤️', null]]);
  assert.equal('_j' in out[0], false); // redrawn with its reaction
  assert.equal('reaction' in items[0], false); // the items stay as they came
  // after a setup note there is no message of yours to react to
  assert.deepEqual(botFeed([{ key: 1, kind: 'user', text: '[Fleet View] x' }, { key: 2, kind: 'assistant', text: '[react:👍]' }]).map((it) => it.key), [1]);
  assert.equal(replyLine('[react:👍] Shipped it.\nmore'), 'Shipped it.');
  assert.equal(replyLine('[react:👍]'), '👍');
});

test("a bot's tasks: the schedule's label, a run's time, the meta line, the folded strip's line", () => {
  const now = new Date(2026, 9, 11, 8, 0).getTime(); // Sunday Oct 11, 8:00 local
  const R = (every, o = {}) => ({ id: 'r', title: 'R', kind: 'recurring', status: 'open', valid: true, schedule: { every, h: 9, m: 0, ...o } });
  assert.equal(taskSchedule(R('daily')), 'Daily 9:00');
  assert.equal(taskSchedule(R('weekdays')), 'Weekdays 9:00');
  assert.equal(taskSchedule(R('weekly', { day: 1 })), 'Weekly Mon 9:00');
  assert.equal(taskSchedule(R('monthly', { day: 1 })), 'Monthly 1st 9:00');
  assert.equal(taskSchedule(R('monthly', { day: 23 })), 'Monthly 23rd 9:00');
  assert.equal(taskSchedule(R('hourly', { m: 5 })), 'Hourly :05');
  assert.equal(taskSchedule({ kind: 'once', schedule: { at: new Date(2026, 9, 12, 15, 0).getTime() } }), 'Once Oct 12 15:00');
  assert.equal(taskSchedule({ kind: 'once', schedule: null }), 'To do');
  assert.equal(taskSchedule({ kind: 'recurring', schedule: null, valid: false }), 'No valid schedule');
  assert.equal(taskWhen(now + 5 * 60e3, now), 'in 5 min');
  assert.equal(taskWhen(now + 3 * 3600e3, now), 'in 3 h');
  assert.equal(taskWhen(now - 10 * 60e3, now), '10 min ago');
  assert.equal(taskWhen(new Date(2026, 9, 12, 21, 0).getTime(), now), 'tomorrow 21:00');
  assert.equal(taskWhen(new Date(2026, 9, 10, 9, 0).getTime(), now), 'yesterday 9:00');
  assert.equal(taskWhen(new Date(2026, 9, 14, 9, 0).getTime(), now), 'Wed 9:00');
  assert.equal(taskWhen(new Date(2026, 10, 20, 9, 0).getTime(), now), 'Nov 20');
  assert.equal(taskWhen(null, now), '');
  const t = { ...R('daily'), nextRun: now + 3600e3, lastRun: now - 23 * 3600e3, runs: [{ at: now - 23 * 3600e3, result: 'all green' }] };
  assert.equal(taskLine(t, now), 'next in 1 h · last yesterday 9:00: all green');
  assert.equal(taskLine({ ...t, status: 'paused', nextRun: null }, now), 'paused · last yesterday 9:00: all green');
  assert.equal(taskLine({ ...t, valid: false }, now), 'its schedule makes no sense: ask the bot to fix it');
  assert.equal(taskLine({ id: 'x', title: 'X', kind: 'once', status: 'done', schedule: null }, now), 'done');
  assert.deepEqual(tasksHead([], now), { count: 0, open: 0, text: 'none yet' });
  assert.deepEqual(tasksHead([{ ...t, title: 'Deploys' }, { ...t, id: 'p', status: 'paused' }, { id: 'd', title: 'D', status: 'done' }], now), { count: 3, open: 1, text: 'next: Deploys, in 1 h' });
  assert.equal(tasksHead([{ id: 'x', title: 'X', status: 'open', nextRun: null }], now).text, '1 open');
  assert.equal(tasksHead([{ id: 'd', title: 'D', status: 'done' }], now).text, 'all done');
});

console.log(`${n} tests passed`);
