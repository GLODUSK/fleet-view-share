// Tests for web/compose.js's decisions about a chat another machine runs (docs/sync-follow.md item 6, "Follow you"):
// followPlan (what Send does: type it here, send it there through the link, the offline note, or link the machines
// first; remote by default, Henry 2026-10-13: typing never moves a chat; 2026-10-17: nothing moves a chat between
// machines), hostOfChat, remoteMenu (the host's menu as the card's) and panelCommand.
// Run: node scripts/follow-plan-test.mjs
import assert from 'node:assert/strict';
import * as compose from '../web/compose.js';

const { followPlan, hostOfChat, remoteMenu, panelCommand, MODEL_IDS, EFFORTS } = compose;
// the Chat tab's move is gone with Continue on this machine (its phases' words with it)
assert.equal(compose.movePhaseText, undefined, 'no move phases in the chat box any more');

const PC = '0afc6f7f-c6f1-4f46-9d69-4e6006385910';
const host = { device: PC, name: 'BlackBox' };
// a chat BlackBox runs, as /state has it
const chat = (o = {}) => ({ id: 'c1', state: 'IDLE', workspace: { kind: 'portable', host }, syncOwner: { device: PC, name: 'BlackBox', live: false, moving: null }, ...o });
const idle = { busy: false, waiting: null };
const working = { busy: true, waiting: null };
const asking = { busy: false, waiting: 'menu' };

// ---------- hostOfChat ----------
assert.deepEqual(hostOfChat(chat()), host);
assert.deepEqual(hostOfChat(chat({ workspace: null })), host, 'syncOwner when /state has no workspace');
assert.equal(hostOfChat(chat({ workspace: { kind: 'portable', host: null }, syncOwner: { device: PC, name: 'BlackBox', moving: 'away' } })), null, 'moving away from here: it is this machine\'s still');
assert.equal(hostOfChat({ id: 'x', workspace: { kind: 'portable', host: null } }), null, 'this machine runs it');
assert.equal(hostOfChat(null), null);
assert.deepEqual(hostOfChat(chat({ workspace: { kind: 'portable', host: { device: PC, name: null } } })), { device: PC, name: 'the other machine' });

// ---------- followPlan ----------
const how = (s, o) => followPlan(s, o).how;
// this machine runs it, or nobody else does: typed in here as always
assert.equal(how({ id: 'x', state: 'IDLE', workspace: { kind: 'portable', host: null } }, {}), 'local');
assert.equal(how(chat(), { local: true }), 'local', 'running in this machine\'s session host: local');
// portable, idle there: sent there, and it stays there (remote by default)
assert.deepEqual(followPlan(chat(), { act: idle, online: true, linked: true }), { how: 'remote', host, kind: 'portable', why: 'idle' });
assert.equal(how(chat(), {}), 'remote', 'nothing read yet, idle by /state: sent there');
assert.equal(how(chat({ state: 'DONE' }), { act: null, online: null, linked: null }), 'remote');
// portable, busy there: sent there, queued
assert.deepEqual(followPlan(chat(), { act: working, online: true, linked: true }), { how: 'remote', host, kind: 'portable', why: 'busy' });
assert.equal(how(chat(), { act: asking, online: true, linked: true }), 'remote', 'waiting on a question there counts as busy');
for (const state of ['WORKING', 'AGENTS', 'ASKING', 'QUESTION']) assert.equal(how(chat({ state }), {}), 'remote', `${state} by /state before any read: sent there`);
assert.equal(followPlan(chat({ state: 'WORKING' }), { act: idle }).why, 'idle', 'the host\'s own reading wins over /state');
// portable and not linked, busy or idle: link first, never a move
assert.deepEqual(followPlan(chat(), { act: working, linked: false }), { how: 'link', host, kind: 'portable', why: 'busy' });
assert.deepEqual(followPlan(chat(), { act: idle, linked: false }), { how: 'link', host, kind: 'portable', why: 'idle' });
// nothing followPlan says is a move, pinned or not, offline or not: chats never move between machines
const pinned = (manual) => ({ workspace: { kind: 'portable', host, pin: { rule: manual ? null : 'r1', host: 'BlackBox', manual } } });
for (const k of [chat(), chat({ state: 'WORKING' }), chat({ workspace: { kind: 'bound', host } }), chat({ bot: 'a1b2c3d4e5f6' }), chat(pinned(true)), chat(pinned(false))]) {
  for (const o of [{}, { act: idle }, { act: working }, { act: asking }, { linked: false }, { online: true, linked: true }, { online: false }, { online: false, linked: false }]) {
    const p = followPlan(k, o);
    assert.ok(['remote', 'link', 'offline'].includes(p.how), `${JSON.stringify(o)}: ${p.how}`);
    assert.equal(p.force, undefined, 'never a forced move');
  }
}
// bound: always sent there
const bound = chat({ workspace: { kind: 'bound', host } });
assert.deepEqual(followPlan(bound, { act: idle, online: true, linked: true }), { how: 'remote', host, kind: 'bound', why: 'bound' });
assert.deepEqual(followPlan(bound, { act: working, online: true }), { how: 'remote', host, kind: 'bound', why: 'bound' });
assert.deepEqual(followPlan(bound, { linked: false }), { how: 'link', host, kind: 'bound', why: 'bound' }, 'bound and not linked: link first');
// bots: sent there too (a move would lose the role)
const bot = chat({ bot: 'a1b2c3d4e5f6' });
assert.deepEqual(followPlan(bot, { act: idle, online: true, linked: true }), { how: 'remote', host, kind: 'bound', why: 'bot' });
assert.equal(how(bot, { linked: false }), 'link');
// offline: the note (its chats come back when it's on), for portable, bound and pinned alike
assert.deepEqual(followPlan(chat(), { online: false, linked: true }), { how: 'offline', host, kind: 'portable' });
assert.deepEqual(followPlan(bound, { online: false, linked: true }), { how: 'offline', host, kind: 'bound' });
assert.deepEqual(followPlan(bot, { online: false }), { how: 'offline', host, kind: 'bound' });
assert.equal(how(chat(pinned(true)), { online: false }), 'offline', 'a chat pinned by hand: the same note');
// a move here under way (one an older phone started): wait for it
assert.equal(how(chat({ syncOwner: { device: PC, name: 'BlackBox', moving: 'here' } }), { online: true }), 'moving');

// ---------- remoteMenu ----------
const m = remoteMenu({ kind: 'permission', title: 'Do you want to proceed?', context: ['Bash(npm test)'], sig: 'abc123def456',
  options: [{ n: 1, label: 'Yes', desc: '', on: true }, { n: 2, label: 'No, and tell Claude what to do differently (esc)', on: false }] });
assert.deepEqual(m, { kind: 'permission', title: 'Do you want to proceed?', context: ['Bash(npm test)'], more: false,
  options: [{ n: 1, label: 'Yes', desc: '', on: true }, { n: 2, label: 'No, and tell Claude what to do differently (esc)', desc: '', on: false }],
  submit: null, sig: 'abc123def456', unnumbered: false, remote: true });
const q = remoteMenu({ kind: 'question', title: 'Which size?', options: [{ n: 1, label: 'Small', check: false }, { n: 2, label: 'Type something.', free: true }], submit: { on: false }, sig: 's' });
assert.equal(q.options[0].check, false);
assert.equal(q.options[1].free, true);
assert.deepEqual(q.submit, { on: false });
assert.deepEqual(q.context, []);
assert.equal(remoteMenu(null), null);
assert.equal(remoteMenu({ options: [] }), null);
assert.equal(remoteMenu({ options: [{ n: 'x' }] }), null, 'options without numbers: none');
assert.equal(remoteMenu({ options: [{ n: 1, label: 'A' }] }).kind, 'other');

// ---------- panelCommand ----------
assert.equal(panelCommand('/usage'), '/usage');
assert.equal(panelCommand('  /config  '), '/config');
assert.equal(panelCommand('/model'), '/model', '/model alone opens its picker');
assert.equal(panelCommand('/model opus'), null, '/model with a name just runs');
// what the model menu sends to a chat another machine runs (pickModel): each goes through the link as a message
for (const id of MODEL_IDS) assert.equal(panelCommand(`/model ${id}`), null, `/model ${id} goes to the host`);
for (const e of EFFORTS) assert.equal(panelCommand(`/effort ${e}`), null, `/effort ${e} goes to the host`);
assert.equal(panelCommand('/effort'), '/effort', '/effort alone opens its picker');
assert.equal(panelCommand('/compact'), null);
assert.equal(panelCommand('/my-skill do it'), null, 'a skill\'s command runs as a prompt');
assert.equal(panelCommand('hello /usage'), null, 'not at the start');
assert.equal(panelCommand(''), null);

console.log('follow-plan-test: all passed');
