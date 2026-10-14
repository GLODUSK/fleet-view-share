// Tests for bots.js (the server side of Bots): name and brief checks, the folder's slug and its clash suffix, the
// CLAUDE.md fill, /state's tags (sessions, finished, removed; the Chief's too), state.bots, and make / start / follow /
// tell / change / remove against a fake session host, a bot's look (shape and colour: checked, saved, set by the page
// and by the bot itself through POST /api/bots/look), every folder under a temp one (never ~/Bots). No live host:
// node scripts/bots-test.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SHAPES as MASCOT_SHAPES } from '../web/mascot.js';

const require = createRequire(import.meta.url);
const B = require('../bots.js');
const C = require('../chief.js');
const API = require('../api.js');

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok', name); };
const T = 1.8e12;
const id = (k) => `${String(k).padStart(8, '0')}-0000-4000-8000-000000000000`;
const BID = 'aaaaaaaaaaaa', BID2 = 'bbbbbbbbbbbb';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-bots-test-'));

// ---------- checks ----------
test('a name is 1 to 40 characters on one line, without control characters', () => {
  for (const bad of [undefined, 5, '', '   ', 'a'.repeat(41), 'two\nlines', 'tab\there', 'bell\x07', 'line sep', '​']) {
    assert.ok(B.checkName(bad, []).err, JSON.stringify(bad));
  }
  // DEL and the C1 controls are refused (the name goes into the first line of the bot's prompts)
  for (const k of [0x7f, 0x80, 0x85, 0x9b, 0x9f]) assert.ok(B.checkName('bot' + String.fromCharCode(k) + 'name', []).err, `C1 ${k}`);
  assert.equal(B.checkName('Café ' + String.fromCharCode(0xa0) + 'bot', []).err, undefined); // 0xa0 and up are fine
  assert.equal(B.checkName('a'.repeat(40), []).name, 'a'.repeat(40));
  assert.equal(B.checkName('  Web watcher  ', []).name, 'Web watcher');
  assert.equal(B.checkName('Re​view', []).name, 'Review'); // invisible characters dropped, as cleanText does
});
test("a name is no other bot's, in any case; a removed bot's is free again", () => {
  const bots = [{ id: BID, name: 'Web' }, { id: BID2, name: 'Docs', removed: true }];
  assert.match(B.checkName('web', bots).err, /already/);
  assert.match(B.checkName(' WEB ', bots).err, /already/);
  assert.equal(B.checkName('Docs', bots).name, 'Docs');
  assert.equal(B.checkName('WEB', bots, BID).name, 'WEB'); // its own name, when it is the one being changed
});
test('a brief is up to 4000 characters, cleaned like cleanText; blank or left out is none', () => {
  assert.deepEqual(B.checkBrief(undefined), { brief: '' });
  assert.deepEqual(B.checkBrief(null), { brief: '' });
  assert.deepEqual(B.checkBrief('   \n '), { brief: '' });
  assert.deepEqual(B.checkBrief('​'), { brief: '' });
  assert.equal(B.checkBrief('x'.repeat(4000)).brief.length, 4000);
  assert.ok(B.checkBrief('x'.repeat(4001)).err);
  assert.ok(B.checkBrief('bad\x07char').err);
  assert.ok(B.checkBrief('lone\rreturn').err);
  assert.ok(B.checkBrief(12).err);
  assert.equal(B.checkBrief(' watch\r\nthe deploys​ ').brief, 'watch\nthe\ndeploys');
});
test('account, model and effort: the defaults, or what POST /api/sessions takes', () => {
  assert.deepEqual(B.checkOpts({}, C.DEFAULTS, ['A', 'B']), { account: 'B', model: 'claude-sonnet-5-5', effort: 'medium' });
  assert.deepEqual(B.checkOpts({ account: 'A', model: 'opus', effort: 'high' }, C.DEFAULTS, ['A', 'B']), { account: 'A', model: 'opus', effort: 'high' });
  assert.ok(B.checkOpts({ account: 'Z' }, C.DEFAULTS, ['A', 'B']).err);
  assert.equal(B.checkOpts({ account: 'dynamic' }, C.DEFAULTS, ['A', 'B']).account, 'dynamic');
  // a Dynamic account: the one with the most usage left, by the fuller of its two limits, the weekly one breaking a tie
  const u = (five, week) => ({ five: five == null ? null : { pct: five }, week: week == null ? null : { pct: week } });
  assert.equal(B.roomiest(['A', 'B'], { A: u(80, 20), B: u(10, 50) }), 'B');
  assert.equal(B.roomiest(['A', 'B'], { A: u(10, 30), B: u(30, 10) }), 'B');
  assert.equal(B.roomiest(['A', 'B'], { A: u(5, 5) }), 'A', 'an account with no read comes after one with a read');
  assert.equal(B.roomiest(['A', 'B'], {}), 'B', 'none read: the default');
  assert.equal(B.roomiest(['A'], null), 'A');
  assert.ok(B.checkOpts({ account: 'a' }, C.DEFAULTS, ['A', 'B']).err);
  assert.ok(B.checkOpts({ model: 'x y' }, C.DEFAULTS, ['A', 'B']).err);
  assert.ok(B.checkOpts({ effort: 'huge' }, C.DEFAULTS, ['A', 'B']).err);
  // Dynamic: either may be 'dynamic'; a session of the bot starts on the dynamic base for that part
  assert.deepEqual(B.checkOpts({ model: 'dynamic', effort: 'dynamic' }, C.DEFAULTS, ['A', 'B']), { account: 'B', model: 'dynamic', effort: 'dynamic' });
  assert.ok(B.checkOpts({ model: 'Dynamic' }, C.DEFAULTS, ['A', 'B']).err === undefined); // a name MODEL_RE takes, not Dynamic
  // long context: a session runs on the model's 1M-context version, where it has one
  assert.deepEqual(B.runOpts({ model: 'dynamic', effort: 'high' }), { model: `${B.DYNAMIC_START.model}[1m]`, effort: 'high' });
  assert.deepEqual(B.runOpts({ model: 'opus', effort: 'dynamic' }), { model: 'opus[1m]', effort: B.DYNAMIC_START.effort });
  assert.deepEqual(['claude-opus-5-5', 'claude-sonnet-5-5[1m]', 'claude-haiku-5-5', 'haiku', 'claude-fable-5-1'].map(B.longModel),
    ['claude-opus-5-5[1m]', 'claude-sonnet-5-5[1m]', 'claude-haiku-5-5', 'haiku', 'claude-fable-5-1']);
});
test("the bot's model in its folder's .claude/settings.json: only model set, the rest kept, a file that is not JSON left alone", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-botmodel-'));
  try {
    const bot = { folder: dir, model: 'dynamic', effort: 'dynamic' };
    const file = path.join(dir, '.claude', 'settings.json');
    assert.equal(B.writeModel(bot), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { model: `${B.DYNAMIC_START.model}[1m]` });
    assert.equal(B.writeModel(bot), false); // the same: not written again
    fs.writeFileSync(file, JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, model: 'haiku' }));
    assert.equal(B.writeModel({ ...bot, model: 'claude-opus-5-5' }), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { permissions: { allow: ['Bash(ls)'] }, model: 'claude-opus-5-5[1m]' });
    fs.writeFileSync(file, '{ not json');
    assert.equal(B.writeModel(bot), false);
    assert.equal(fs.readFileSync(file, 'utf8'), '{ not json');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- the folder and its CLAUDE.md ----------
test('the slug: lower case letters, digits and dashes; "bot" when nothing is left; never a Windows device name', () => {
  assert.equal(B.slugOf('Web Watcher!'), 'web-watcher');
  assert.equal(B.slugOf('  --Ünïcödé  café--'), 'unicode-cafe');
  assert.equal(B.slugOf('日本'), 'bot');
  assert.equal(B.slugOf('CON'), 'con-bot');
  assert.equal(B.slugOf('com1'), 'com1-bot');
  assert.equal(B.slugOf('x'.repeat(30) + ' yy zz'), 'x'.repeat(30) + '-y');
  assert.ok(B.slugOf('a'.repeat(40)).length <= 32);
});
test('the folder: -2, -3 when a bot (a removed one too) has it or something is there already', () => {
  const base = path.join(dir, 'pick');
  const there = new Set([path.join(base, 'notes'), path.join(base, 'notes-2')]);
  const exists = (p) => there.has(p);
  assert.equal(B.pickFolder(base, 'web', [], exists), path.join(base, 'web'));
  assert.equal(B.pickFolder(base, 'web', [{ folder: path.join(base, 'web'), removed: true }], exists), path.join(base, 'web-2'));
  assert.equal(B.pickFolder(base, 'notes', [], exists), path.join(base, 'notes-3'));
  assert.equal(B.pickFolder(base, 'web', [{ folder: path.join(base, 'WEB') }], exists), process.platform === 'linux' ? path.join(base, 'web') : path.join(base, 'web-2'));
  assert.equal(B.pickFolder(base, 'x', [], () => true), null);
});
test('the Bots folder and every folder in it are never a workspace', () => {
  const base = path.join(dir, 'Bots');
  assert.equal(B.inBots(base, base), true);
  assert.equal(B.inBots(path.join(base, 'web'), base), true);
  assert.equal(B.inBots(path.join(base, 'web', 'sub'), base), true);
  assert.equal(B.inBots(path.join(dir, 'Botsy'), base), false);
  assert.equal(B.inBots(dir, base), false);
  assert.equal(B.inBots(null, base), false);
});
test('another machine\'s bots: one per ~/Bots folder no bot here owns, from its synced chats', () => {
  const base = path.join(dir, 'Bots');
  const mine = { id: 'aaaaaaaaaaaa', folder: path.join(base, 'mine') }, gone = { id: 'bbbbbbbbbbbb', folder: path.join(base, 'gone'), removed: true };
  const pan = path.join(base, 'panchito');
  const convs = [
    { id: 'p1', root: pan, name: 'Panchito', last: 1, account: 'A' },
    { id: 'p2', cwd: path.join(pan, 'notes'), name: 'Panchito', last: 3, account: 'B' },
    { id: 'm1', root: path.join(base, 'mine'), name: 'Mine', last: 2 },
    { id: 'g1', root: path.join(base, 'gone', 'x'), name: 'Gone', last: 2 },
    { id: 'b0', root: base, name: 'in Bots itself', last: 2 },
    { id: 'r1', root: path.join(dir, 'repo'), name: 'a repo', last: 2 },
    { id: 'q1', root: path.join(base, 'quiet'), name: '', last: 1 },
  ];
  const out = B.elsewhereBots(convs, base, [mine, gone]);
  assert.equal(out.length, 2);
  const p = out.find((x) => x.folder === pan), q = out.find((x) => x.folder === path.join(base, 'quiet'));
  assert.deepEqual([p.name, p.ids, p.convId, p.account, p.at], ['Panchito', ['p1', 'p2'], 'p2', 'B', 3]);
  assert.match(p.id, /^[0-9a-f]{12}$/);
  assert.equal(B.elsewhereBots(convs.slice(0, 1), base, []).find((x) => x.folder === pan).id, p.id); // the same id each time
  assert.equal(q.name, 'quiet'); // no name: the folder's
  const v = B.elsewhereView(p);
  assert.deepEqual([v.id, v.name, v.convId, v.live, v.elsewhere, v.tasks, v.shape, v.color], [p.id, 'Panchito', 'p2', false, true, [], null, null]);
  // the look its machine gave it (sync-prefs.js botLooks), by its folder's name; a bad one is not worn
  assert.equal(p.slug, 'panchito');
  const worn = B.elsewhereView(p, { slug: 'panchito', shape: 'heart', color: '#FF6B80' });
  assert.deepEqual([worn.shape, worn.color], ['heart', '#ff6b80']);
  assert.deepEqual([B.elsewhereView(p, { color: '#58a6ff' }).shape, B.elsewhereView(p, { color: '#58a6ff' }).color], [null, '#58a6ff']);
  assert.deepEqual([B.elsewhereView(p, { shape: 'blob', color: 'red' }).shape, B.elsewhereView(p, { shape: 'blob', color: 'red' }).color], [null, null]);
  assert.deepEqual(B.elsewhereBots(convs, base, [mine, gone, { id: 'cccccccccccc', folder: pan }, { id: 'dddddddddddd', folder: path.join(base, 'quiet') }]), []);
});
test('CLAUDE.md: the template with the name and the brief, in one pass', () => {
  const tpl = fs.readFileSync(B.TEMPLATE_FILE, 'utf8').split(String.fromCharCode(13)).join(''); // a CRLF checkout too
  const out = B.fillBrief(tpl, { name: 'Scout', brief: 'Watch the deploys.\nSay {{name}} never.' });
  assert.ok(out.startsWith('# Scout\n'));
  assert.ok(out.includes("You are Scout, one of Henry's bots in Fleet View: an overseer, not a conversation on the map."));
  assert.ok(out.includes('Watch the deploys.\nSay {{name}} never.')); // the brief's own text is left as it is
  assert.ok(!/\{\{(?:name|brief)\}\}/.test(out.replace('Say {{name}} never.', '')));
  assert.ok(out.includes('[Fleet View · unsigned, not from Henry]'));
  assert.ok(out.includes('`fv start`'));
  assert.ok(B.fillBrief(tpl, { name: 'Scout', brief: '' }).includes('None yet.'));
});

// ---------- /state ----------
test('/state tags: a bot\'s conversations (a removed bot\'s too) and the Chief\'s, in sessions, finished and removed', () => {
  const bots = [{ id: BID, ids: [id(1), id(2)] }, { id: BID2, ids: [id(3)], removed: true }];
  const tagOf = B.tagger([id(9)], bots);
  const st = {
    sessions: [{ id: id(1) }, { id: id(2) }, { id: id(4) }, { id: id(9) }],
    finished: [{ id: id(3) }, { id: id(5) }],
    removed: [{ id: id(2) }, { id: id(6) }],
    feed: [{ sid: id(1) }],
  };
  B.tagState(st, tagOf);
  assert.deepEqual(st.sessions.map((x) => x.bot || null), [BID, BID, null, 'chief']);
  assert.ok(!('bot' in st.sessions[2]));
  assert.deepEqual(st.finished.map((x) => x.bot || null), [BID2, null]);
  assert.deepEqual(st.removed.map((x) => x.bot || null), [BID, null]);
  assert.ok(!('bot' in st.feed[0]));
  assert.equal(B.tagger([], [])(id(1)), null);
});
test('state.bots: not the removed ones, newest first, convId the running one else the newest, live', () => {
  const mk = (bid, at, o = {}) => ({ id: bid, name: bid, brief: '', account: 'B', model: 'm', effort: 'low', folder: `/b/${bid}`, createdAt: at, ids: [], told: [], ...o });
  const bots = [mk(BID, T, { ids: [id(1), id(2)] }), mk(BID2, T + 1), mk('cccccccccccc', T + 2, { removed: true })];
  const v = B.listView(bots, new Map([[BID2, { id: id(7) }]]));
  assert.deepEqual(v.map((x) => x.id), [BID2, BID]);
  assert.deepEqual(Object.keys(v[0]).sort(), ['account', 'brief', 'color', 'convId', 'createdAt', 'effort', 'folder', 'id', 'ids', 'live', 'map', 'model', 'name', 'shape', 'watches']);
  assert.equal(v[0].map, null); assert.deepEqual(v[0].watches, []);
  assert.equal(v[0].shape, null); assert.equal(v[0].color, null);
  assert.deepEqual(B.listView([mk(BID, T, { shape: 'heart', color: '#ff6b80' })], new Map()).map((x) => [x.shape, x.color]), [['heart', '#ff6b80']]);
  assert.equal(v[0].convId, id(7)); assert.equal(v[0].live, true);
  assert.equal(v[1].convId, id(2)); assert.equal(v[1].live, false);
  assert.equal(B.listView([mk(BID, T)], new Map())[0].convId, null);
});
test('the registry as saved: a bad entry is dropped, ids are checked and capped', () => {
  const ok = { id: BID, name: 'Web', folder: path.join(dir, 'w'), createdAt: T, ids: [...Array.from({ length: 60 }, (_, i) => id(i)), 'nope'], told: [id(1), 'x'] };
  const out = B.loadBots([ok, { ...ok }, { id: 'XYZ', name: 'n', folder: dir }, { id: BID2, name: 'r', folder: 'relative' }, null,
    { id: 'cccccccccccc', name: 'out', folder: path.dirname(dir) }, { id: 'dddddddddddd', name: 'base', folder: dir }], dir);
  assert.equal(out.length, 1); // outside the Bots folder, or the Bots folder itself: dropped
  assert.equal(B.loadBots([ok]).length, 0); // the default Bots folder is ~/Bots, which dir is not in
  assert.equal(out[0].ids.length, B.IDS_MAX);
  assert.equal(out[0].ids[B.IDS_MAX - 1], id(59));
  assert.deepEqual(out[0].told, [id(1)]);
  assert.equal(out[0].account, 'B'); assert.equal(out[0].model, 'claude-sonnet-5-5'); assert.equal(out[0].effort, 'medium');
});
test("a look: a shape from mascot.js's list, a #rrggbb colour; null or blank clears; left out stays", () => {
  assert.deepEqual(B.checkLook({}), {});
  assert.deepEqual(B.checkLook({ shape: 'heart', color: '#FF6B80' }), { shape: 'heart', color: '#ff6b80' });
  assert.deepEqual(B.checkLook({ shape: null, color: '' }), { shape: null, color: null });
  for (const bad of [{ shape: 'blob' }, { shape: 3 }, { color: 'red' }, { color: '#fff' }, { color: '#12345g' }, { color: 'ff6b80' }, { color: '#ff6b80;x' }]) assert.ok(B.checkLook(bad).err, JSON.stringify(bad));
  // the server's list and the page's are one list
  assert.deepEqual(B.SHAPES, MASCOT_SHAPES);
});
test('the registry as saved keeps a valid look and drops a bad one', () => {
  const one = (o) => B.loadBots([{ id: BID, name: 'Web', folder: path.join(dir, 'w'), createdAt: T, ids: [], told: [], ...o }], dir)[0];
  assert.deepEqual([one({ shape: 'clover', color: '#ABCDEF' }).shape, one({ shape: 'clover', color: '#ABCDEF' }).color], ['clover', '#abcdef']);
  const bad = one({ shape: 'blob', color: 'red' });
  assert.ok(!('shape' in bad) && !('color' in bad));
  assert.equal(one({ shape: 'clover', lookAt: T + 5 }).lookAt, T + 5);
  assert.ok(!('lookAt' in one({ lookAt: 'soon' })));
});
test('a look goes to the other machines by its folder\'s name (botLooks): lookAt when it changed, the bots here from the registry', () => {
  const bot = { id: BID, folder: path.join(dir, 'Bots', 'Petal'), createdAt: T };
  B.applyLook(bot, {}, T + 1);
  assert.ok(!('lookAt' in bot)); // nothing changed
  B.applyLook(bot, { shape: 'flower', color: '#f78fd0' }, T + 2);
  assert.equal(bot.lookAt, T + 2);
  B.applyLook(bot, { shape: 'flower' }, T + 3);
  assert.equal(bot.lookAt, T + 2); // the same look: not changed
  assert.deepEqual(B.lookItem(bot), { slug: 'petal', shape: 'flower', color: '#f78fd0', at: T + 2 });
  assert.deepEqual(B.lookItem({ folder: '/b/Web', createdAt: T, color: '#000000' }), { slug: 'web', color: '#000000', at: T }); // no lookAt: when it was made
  assert.equal(B.lookItem({ folder: '/b/plain', createdAt: T }), null);
  const reg = [bot, { id: BID2, folder: '/b/gone', createdAt: T, shape: 'heart', removed: true }, { id: 'cccccccccccc', folder: '/b/plain', createdAt: T }];
  const others = [{ slug: 'petal', shape: 'heart' }, { slug: 'gone', shape: 'star' }, { slug: 'panchito', color: '#58a6ff' }];
  // its own bots' looks (not a removed one's), then the others' for folders none of its bots owns (a removed one's is free)
  assert.deepEqual(B.lookItems(reg, others), [B.lookItem(bot), { slug: 'gone', shape: 'star' }, { slug: 'panchito', color: '#58a6ff' }]);
  assert.deepEqual(B.othersOf(reg, [...others, { slug: 'PETAL', shape: 'tri' }, null]), [{ slug: 'gone', shape: 'star' }, { slug: 'panchito', color: '#58a6ff' }]);
});
test('api.js: the Chief and the bots are overseers; the API lists the bot routes', () => {
  assert.equal(API.isOverseer('chief'), true);
  assert.equal(API.isOverseer(`bot:${BID}`), true);
  for (const r of [null, undefined, '', 'boss', 'bot:', 'bot:XYZ', 'bot:AAAAAAAAAAAA', `bot:${BID}0`, `x bot:${BID}`]) assert.equal(API.isOverseer(r), false, String(r));
  const paths = API.ENDPOINTS.map((e) => `${e.method} ${e.path}`);
  for (const p of ['GET /api/bots', 'POST /api/bots', 'POST /api/bots/:id', 'POST /api/bots/:id/start', 'POST /api/bots/:id/remove', 'POST /api/bots/look']) assert.ok(paths.includes(p), p);
  assert.equal(B.botOfRole(`bot:${BID}`), BID);
  assert.equal(B.botOfRole('chief'), null);
});

// ---------- on the map and watching ----------
test('the registry as saved keeps a map spot and watches that make sense, and drops the rest', () => {
  const one = (o) => B.loadBots([{ id: BID, name: 'Web', folder: path.join(dir, 'w'), createdAt: T, ids: [], told: [], ...o }], dir)[0];
  assert.deepEqual(one({ map: { x: 12.345, y: -3 } }).map, { x: 12.3, y: -3 });
  assert.deepEqual(one({ map: { x: 1e9, y: -1e9 } }).map, { x: 100000, y: -100000 }); // kept within the map
  for (const bad of ['x', null, { x: '1', y: 2 }, { x: 1 }, { x: NaN, y: 0 }, { x: Infinity, y: 0 }]) assert.ok(!('map' in one({ map: bad })), JSON.stringify(bad));
  assert.deepEqual(one({}).watches, []);
  const U = id(70).toUpperCase();
  const w = one({ watches: [
    { id: U, job: 'report', since: T, last: { at: T + 1, what: 'asks' } },
    { id: id(70), job: 'answer', since: T }, // the same conversation again
    { id: id(71), job: 'boss', since: T }, // no such job
    { id: 'nope', job: 'report', since: T },
    { id: id(72), job: 'review', since: 'soon', last: { at: T, what: 'exploded' } },
    { id: id(73), job: 'constructor' },
    null,
  ] }).watches;
  assert.deepEqual(w, [{ id: id(70), job: 'report', since: T, last: { at: T + 1, what: 'asks' } }, { id: id(72), job: 'review', since: 0 }]);
  const many = one({ watches: Array.from({ length: 12 }, (_, i) => ({ id: id(100 + i), job: 'report', since: T })) }).watches;
  assert.equal(many.length, B.WATCHES_MAX);
  // a removed bot is neither on the map nor watching
  const gone = one({ removed: true, map: { x: 1, y: 2 }, watches: [{ id: id(70), job: 'report', since: T }] });
  assert.ok(!('map' in gone)); assert.deepEqual(gone.watches, []);
});
test('POST /bots/:id/map\'s at: { x, y } numbers (rounded, kept within the map) or null', () => {
  assert.deepEqual(B.checkAt({ x: 1.26, y: -0.04 }), { at: { x: 1.3, y: 0 } });
  assert.deepEqual(B.checkAt(null), { at: null });
  for (const bad of [undefined, 'x', 5, {}, { x: 1 }, { x: '1', y: '2' }, { x: NaN, y: 1 }]) assert.ok(B.checkAt(bad).err, JSON.stringify(bad));
});
test('the watch jobs: report, answer, review, each with the page\'s label and the line for the bot', () => {
  assert.deepEqual(Object.keys(B.WATCH_JOBS), ['report', 'answer', 'review']);
  assert.deepEqual(Object.values(B.WATCH_JOBS).map((j) => j.label), ['Tell me when it needs me', 'Answer its questions', "Review its work when it's done"]);
  for (const j of Object.values(B.WATCH_JOBS)) assert.ok(j.line.includes('<id>'));
});
test('watchEvent: the first sight only records; an event once the state held 10 s, once per situation', () => {
  const S = B.WATCH_SETTLE_MS;
  let r = B.watchEvent(null, { state: 'ASKING', replyAt: T - 5e3 }, T);
  assert.equal(r.event, null);
  // asking already when first seen (a restart, a new watch): never news, however long it lasts
  r = B.watchEvent(r.seen, { state: 'ASKING', replyAt: T - 5e3 }, T + S + 1);
  assert.equal(r.event, null);
  // it works, then rests with a new reply: finished, once it held 10 s from that reply
  r = B.watchEvent(r.seen, { state: 'WORKING', replyAt: T - 5e3 }, T + 20e3);
  assert.equal(r.event, null);
  r = B.watchEvent(r.seen, { state: 'IDLE', replyAt: T + 24e3 }, T + 25e3);
  assert.equal(r.event, null);
  r = B.watchEvent(r.seen, { state: 'IDLE', replyAt: T + 24e3 }, T + 24e3 + S - 1);
  assert.equal(r.event, null, 'not settled yet');
  r = B.watchEvent(r.seen, { state: 'IDLE', replyAt: T + 24e3 }, T + 25e3 + S);
  assert.deepEqual(r.event, { what: 'finished', key: `finished:${T + 24e3}` });
  r = B.watchEvent(r.seen, { state: 'IDLE', replyAt: T + 24e3 }, T + 60e3);
  assert.equal(r.event, null, 'once');
  // a newer reply while it stays idle (a turn between two looks): finished again, for that reply
  r = B.watchEvent(r.seen, { state: 'DONE', replyAt: T + 61e3 }, T + 62e3);
  assert.equal(r.event, null); // DONE is a rest too: held from the new reply
  r = B.watchEvent(r.seen, { state: 'DONE', replyAt: T + 61e3 }, T + 62e3 + S);
  assert.deepEqual(r.event, { what: 'finished', key: `finished:${T + 61e3}` });
  // a flicker: asking for 5 s, then working again, is no news
  let t = T + 100e3;
  r = B.watchEvent(r.seen, { state: 'ASKING', replyAt: T + 61e3 }, t);
  r = B.watchEvent(r.seen, { state: 'ASKING', replyAt: T + 61e3 }, t + 5e3);
  assert.equal(r.event, null);
  r = B.watchEvent(r.seen, { state: 'WORKING', replyAt: T + 61e3 }, t + 6e3);
  assert.equal(r.event, null);
  // each kind: asks (ASKING or QUESTION, one situation), error, stalled
  const kind = (state, seen) => {
    let x = B.watchEvent(seen, { state, replyAt: T + 61e3 }, t += 1e3);
    assert.equal(x.event, null);
    x = B.watchEvent(x.seen, { state, replyAt: T + 61e3 }, t += S);
    return x;
  };
  r = kind('QUESTION', r.seen); assert.equal(r.event.what, 'asks'); assert.match(r.event.key, /^asks:\d+$/);
  const asked = r.event.key;
  r = B.watchEvent(r.seen, { state: 'ASKING', replyAt: T + 61e3 }, t += S); // a menu after the question: the same situation
  assert.equal(r.event, null);
  r = kind('ERROR', r.seen); assert.equal(r.event.what, 'error');
  r = kind('STALLED', r.seen); assert.equal(r.event.what, 'stalled');
  r = kind('QUESTION', r.seen); assert.equal(r.event.what, 'asks'); assert.notEqual(r.event.key, asked); // asking again later: news again
  // a rest with no newer reply (interrupted), or not listed: nothing
  r = kind('IDLE', r.seen); assert.equal(r.event, null);
  r = kind(null, r.seen); assert.equal(r.event, null);
  // first sight at rest: its last reply is not news
  r = B.watchEvent(null, { state: 'IDLE', replyAt: T }, T + 1);
  assert.equal(B.watchEvent(r.seen, { state: 'IDLE', replyAt: T }, T + 60e3).event, null);
});
test('the watch note: one block per update, the job line with the id in it', () => {
  const X = id(70), Y = id(71);
  const one = B.watchNote([{ id: X, name: 'Fix "login"', what: 'finished', lastReply: 'Merged\n#12.', job: 'report' }]);
  assert.equal(one, [`[Fleet View] Watch: "Fix 'login'" (${X}) finished its turn.`, 'Its last reply: Merged #12.',
    `Your job for it: tell Henry in one or two lines what happened and whether he needs to do anything (\`fv read ${X}\` for more).`].join('\n'));
  const two = B.watchNote([{ id: X, name: 'A', what: 'asks', lastReply: null, job: 'answer' }, { id: Y, name: null, what: 'error', lastReply: 'x'.repeat(500), job: 'review' }]).split('\n');
  assert.equal(two[0], '[Fleet View] Watch: 2 updates.');
  assert.equal(two[1], '');
  assert.equal(two[2], `"A" (${X}) is asking something.`);
  assert.equal(two[3], 'Its last reply: none');
  assert.ok(two[4].startsWith(`Your job for it: when it asks something`) && two[4].includes(`\`fv menu ${X}\``) && two[4].includes('--from <your id>'));
  assert.equal(two[5], '');
  assert.equal(two[6], `"${Y.slice(0, 8)}" (${Y}) hit an error.`); // no name: the start of its id
  assert.equal(two[7].length, 'Its last reply: '.length + 400);
  assert.ok(two[8].includes(`\`fv transcript ${Y}\``));
});

// ---------- the server loop, against a fake host ----------
const sessionsFile = path.join(dir, 'sessions.json');
const writeFile = (sessions) => {
  fs.writeFileSync(sessionsFile, JSON.stringify({ version: 1, sessions }));
  const t = new Date(Date.now() + Math.random() * 1e6);
  fs.utimesSync(sessionsFile, t, t);
};
let seq = 100;
function harness(o = {}) {
  const base = o.base || fs.mkdtempSync(path.join(dir, 'base-'));
  let list = o.list || [];
  const calls = { deliver: [], startBot: [], openBot: [], end: [], trust: [], rename: [], switch: [], hostList: 0, facts: [] };
  let saved = o.saved || [];
  const logs = new Set(o.logs || []); // conversation ids whose log is on disk
  const promptAt = new Map();
  // watching: the watched conversations' facts (id -> fact), the ones Fleet View knows, their names, the Chief's ids
  const facts = new Map(), known = new Set(), names = new Map(), chief = [];
  let down = !!o.down, deliverCode = null;
  const roleOfConv = (cid) => { const b = bots._state().bots.find((x) => x.ids.includes(cid)); return b ? `bot:${b.id}` : null; };
  const api = {
    hostList: async () => { calls.hostList++; return down ? null : list; },
    deliverText: async (to, text, opts) => {
      calls.deliver.push({ to, text, opts });
      if (deliverCode) return [deliverCode, { ok: false, message: 'it did not go in' }];
      if (opts.onSent) opts.onSent(to, Date.now(), 'idle');
      return [200, { ok: true, id: to }];
    },
    startBot: async (b) => {
      calls.startBot.push(b);
      const nid = id(++seq);
      list = [...list, { id: nid, alive: true, role: b.role, status: 'busy', pending: false }];
      logs.add(nid);
      return [200, { ok: true, key: 'new-1', id: nid, promptSent: true, message: 'started, and the prompt was sent' }];
    },
    openBot: async (cid) => {
      calls.openBot.push(cid);
      list = [...list.filter((x) => x.id !== cid), { id: cid, alive: true, role: roleOfConv(cid), status: 'idle', pending: false }];
      return [200, { ok: true, id: cid, alreadyRunning: false, ready: true }];
    },
    switchModel: async (key, b, ctx, via) => {
      calls.switch.push({ key, b, via });
      return [200, { ok: true, id: key, ...b, said: [], defaultKept: true }];
    },
    endHosted: async (key) => {
      calls.end.push(key);
      list = list.map((x) => (x.id === key ? { ...x, alive: false } : x));
      return [200, { ok: true, id: key }];
    },
  };
  const bots = B.createBots({
    api, ctx: {}, saved, save: () => { saved = bots.saveShape(); }, log: () => {}, demo: !!o.demo,
    exists: (x) => logs.has(x), turnInfo: (x) => ({ promptAt: promptAt.get(x) || 0 }), sessionsFile,
    trustFolder: (f) => calls.trust.push(f), accounts: () => ['A', 'B'], rename: (x, name) => calls.rename.push({ id: x, name }),
    watchFacts: (ids) => { calls.facts.push([...ids]); return ids.filter((x) => facts.has(x)).map((x) => ({ id: x, name: names.get(x) || null, ...facts.get(x) })); },
    known: (x) => known.has(x) || logs.has(x), nameOf: (x) => names.get(x) || null, chiefIds: () => chief,
    base, template: B.TEMPLATE_FILE,
  });
  return { bots, calls, base, logs, promptAt, facts, known, names, chief, setList: (l) => { list = l; }, list: () => list, saved: () => saved,
    setDown: (v) => { down = v; }, setDeliver: (c) => { deliverCode = c; } };
}
const realNow = Date.now;
const clock = (t) => { Date.now = () => t; };

await (async () => {
  // make: checks first, then the folder, its CLAUDE.md, trust, and the start
  {
    const h = harness();
    assert.equal((await h.bots.create({ name: '' }))[0], 400);
    assert.equal((await h.bots.create({ name: 'x', brief: 'a\x07' }))[0], 400);
    assert.equal((await h.bots.create({ name: 'x', effort: 'huge' }))[0], 400);
    assert.equal(h.calls.startBot.length, 0);
    assert.deepEqual(fs.readdirSync(h.base), []);
    const [code, out] = await h.bots.create({ name: 'Web Watcher', brief: 'Watch the web deploys.' });
    assert.equal(code, 200); assert.equal(out.ok, true);
    const bot = out.bot;
    assert.match(bot.id, /^[0-9a-f]{12}$/);
    assert.equal(bot.folder, path.join(h.base, 'web-watcher'));
    assert.equal(bot.name, 'Web Watcher'); assert.equal(bot.account, 'B'); assert.equal(bot.model, 'dynamic'); assert.equal(bot.effort, 'dynamic'); // a new bot's
    assert.equal(bot.live, true); assert.equal(bot.convId, out.id); assert.equal(out.key, 'new-1');
    const md = fs.readFileSync(path.join(bot.folder, 'CLAUDE.md'), 'utf8');
    assert.ok(md.startsWith('# Web Watcher\n') && md.includes('Watch the web deploys.'));
    assert.deepEqual(h.calls.trust, [bot.folder]);
    const sb = h.calls.startBot[0];
    assert.deepEqual({ ...sb, prompt: null }, { repo: bot.folder, account: 'B', model: `${B.DYNAMIC_START.model}[1m]`, effort: B.DYNAMIC_START.effort, prompt: null, name: 'Web Watcher', role: `bot:${bot.id}` });
    assert.equal(JSON.parse(fs.readFileSync(path.join(bot.folder, '.claude', 'settings.json'), 'utf8')).model, `${B.DYNAMIC_START.model}[1m]`); // a resume runs on it too
    assert.equal(sb.prompt, "[Fleet View] You are Web Watcher, one of Henry's bots. Your standing instructions are in CLAUDE.md in this folder. Your conversation id comes in the next message: reply to this one with just \"ok\".");
    assert.deepEqual(h.saved()[0].ids, [out.id]);
    // the same name in another case is refused; a clash of folders gets -2; a folder that is there already is left alone
    assert.equal((await h.bots.create({ name: 'web watcher' }))[0], 400);
    const [, o2] = await h.bots.create({ name: 'Web watcher!' });
    assert.equal(o2.bot.folder, path.join(h.base, 'web-watcher-2'));
    fs.mkdirSync(path.join(h.base, 'notes'));
    fs.writeFileSync(path.join(h.base, 'notes', 'CLAUDE.md'), 'mine');
    const [, o3] = await h.bots.create({ name: 'Notes', account: 'A', model: 'opus', effort: 'high' });
    assert.equal(o3.bot.folder, path.join(h.base, 'notes-2'));
    assert.equal(fs.readFileSync(path.join(h.base, 'notes', 'CLAUDE.md'), 'utf8'), 'mine');
    assert.deepEqual([h.calls.startBot[2].account, h.calls.startBot[2].model, h.calls.startBot[2].effort], ['A', 'opus[1m]', 'high']);
    // state.bots: newest first
    assert.deepEqual(h.bots.view().map((x) => x.name), ['Notes', 'Web watcher!', 'Web Watcher']);
    assert.deepEqual(h.bots.list()[1].bots.map((x) => x.id), h.bots.view().map((x) => x.id));
    n++; console.log('ok make: checks, folder, CLAUDE.md, trust, start; name and folder clashes');
  }
  // Dynamic's switch (POST /bots/:id/switch): only a dynamic part, only in one of the bot's conversations, as Henry's
  {
    const h = harness();
    const [, made] = await h.bots.create({ name: 'Sizer' });
    const bid = made.bot.id, cid = made.id;
    const [c1, o1] = await h.bots.switchTo(bid, { id: cid, model: 'claude-opus-5-5', effort: 'high' });
    assert.equal(c1, 200); assert.equal(o1.ok, true);
    assert.deepEqual(h.calls.switch, [{ key: cid, b: { model: 'claude-opus-5-5', effort: 'high' }, via: 'henry' }]);
    assert.equal((await h.bots.switchTo(bid, { id: id(999), effort: 'high' }))[0], 400); // not its conversation
    assert.equal((await h.bots.switchTo(bid, { id: cid }))[0], 400); // nothing to switch
    assert.equal((await h.bots.switchTo(bid, { id: cid, effort: 'huge' }))[0], 400);
    assert.equal((await h.bots.switchTo(bid, { id: cid, model: 'x y' }))[0], 400);
    assert.equal((await h.bots.switchTo('ffffffffffff', { id: cid, effort: 'low' }))[0], 404);
    // a fixed effort is never changed here; the dynamic model still is
    await h.bots.update(bid, { effort: 'medium' });
    assert.equal((await h.bots.switchTo(bid, { id: cid, effort: 'low' }))[0], 409);
    assert.equal((await h.bots.switchTo(bid, { id: cid, model: 'claude-sonnet-5-5' }))[0], 200);
    assert.equal(h.calls.switch.length, 2);
    await h.bots.remove(bid);
    assert.equal((await h.bots.switchTo(bid, { id: cid, model: 'claude-sonnet-5-5' }))[0], 404);
    n++; console.log('ok dynamic switch: dynamic parts only, its own conversation, as Henry');
  }
  // the look: made with one, changed or cleared by the page (CLAUDE.md untouched, nobody told), and by the bot itself
  // from its own conversation only (POST /api/bots/look)
  {
    const h = harness();
    assert.equal((await h.bots.create({ name: 'Bad look', shape: 'blob' }))[0], 400);
    assert.equal(h.calls.startBot.length, 0);
    const [, made] = await h.bots.create({ name: 'Petal', shape: 'flower', color: '#F78FD0' });
    assert.deepEqual([made.bot.shape, made.bot.color], ['flower', '#f78fd0']);
    assert.ok(h.saved()[0].lookAt > 0); // when the look was given (botLooks)
    assert.deepEqual(h.bots.lookItems([]).map((x) => [x.slug, x.shape, x.color]), [['petal', 'flower', '#f78fd0']]);
    const bid = made.bot.id, conv = made.id;
    const md = fs.readFileSync(path.join(made.bot.folder, 'CLAUDE.md'), 'utf8');
    const [uc, uo] = await h.bots.update(bid, { shape: 'heart' });
    assert.equal(uc, 200); assert.deepEqual([uo.bot.shape, uo.bot.color], ['heart', '#f78fd0']);
    assert.equal(h.calls.deliver.length, 0); // a look is not in CLAUDE.md: nothing to tell it
    assert.equal(fs.readFileSync(path.join(made.bot.folder, 'CLAUDE.md'), 'utf8'), md);
    assert.equal((await h.bots.update(bid, { color: 'pink' }))[0], 400);
    const [, cleared] = await h.bots.update(bid, { color: null });
    assert.equal(cleared.bot.color, null);
    assert.ok(!('color' in h.saved().find((x) => x.id === bid)));
    // the bot itself: from its own conversation
    assert.equal(h.bots.look({ shape: 'star' })[0], 400); // no from
    assert.equal(h.bots.look({ from: id(999), shape: 'star' })[0], 403); // not a bot's conversation
    assert.equal(h.bots.look({ from: conv })[0], 400); // nothing to change
    assert.equal(h.bots.look({ from: conv, name: 'Boss', shape: 'star' })[0], 400); // only its look
    assert.equal(h.bots.look({ from: conv, shape: 'blob' })[0], 400);
    const [lc, lo] = h.bots.look({ from: conv, shape: 'star', color: '#58A6FF' });
    assert.equal(lc, 200); assert.deepEqual([lo.bot.shape, lo.bot.color], ['star', '#58a6ff']);
    assert.equal(lo.bot.name, 'Petal');
    assert.deepEqual([h.saved()[0].shape, h.saved()[0].color], ['star', '#58a6ff']);
    assert.equal(h.bots.look({ from: conv, shape: null })[1].bot.shape, null);
    // a removed bot's conversation changes nothing
    await h.bots.remove(bid);
    assert.equal(h.bots.look({ from: conv, shape: 'heart' })[0], 403);
    assert.deepEqual(h.bots.lookItems([]), []); // removed: its look leaves the other machines
    n++; console.log('ok a look: made with one, changed by the page, and by the bot itself from its own conversation only');
  }
  // start: the running one is taken; else the newest conversation resumed; else a new one. Two at once start one
  {
    const h = harness();
    const [, made] = await h.bots.create({ name: 'Scout' });
    const bid = made.bot.id, first = made.id;
    const [c1, again] = await h.bots.start(bid);
    assert.equal(c1, 200); assert.equal(again.started, false); assert.equal(again.id, first); assert.equal(h.calls.startBot.length, 1);
    // it ended: its newest conversation is resumed with the role
    h.setList(h.list().map((x) => ({ ...x, alive: false })));
    const [, res] = await h.bots.start(bid);
    assert.equal(res.resumed, true); assert.deepEqual(h.calls.openBot, [first]); assert.equal(h.calls.startBot.length, 1);
    // ended again, and its log is gone: a new conversation
    h.setList([]);
    h.logs.delete(first);
    const [, fresh] = await h.bots.start(bid);
    assert.equal(fresh.started, true); assert.equal(h.calls.startBot.length, 2);
    assert.deepEqual(h.bots._state().bots[0].ids, [first, fresh.id]);
    // two clicks at once: one start, the second finds it running
    h.setList([]);
    h.logs.clear();
    const [a, b] = await Promise.all([h.bots.start(bid), h.bots.start(bid)]);
    assert.equal(h.calls.startBot.length, 3);
    assert.equal(a[1].started, true); assert.equal(b[1].started, false); assert.equal(a[1].id, b[1].id);
    assert.equal((await h.bots.start('cccccccccccc'))[0], 404);
    // the desktop app is down: made, but not started
    const down = harness({ down: true });
    const [dc, dout] = await down.bots.create({ name: 'Later' });
    assert.equal(dc, 503); assert.equal(dout.ok, false); assert.equal(dout.bot.name, 'Later'); assert.match(dout.message, /did not start/);
    assert.equal(down.bots.view().length, 1);
    const demo = harness({ demo: true });
    assert.equal((await demo.bots.create({ name: 'x' }))[0], 503);
    assert.deepEqual(demo.bots.view(), []);
    n++; console.log('ok start: running, resumed, new; serialised; host down; demo');
  }
  // follow and tell: a pickup's new id joins the bot's ids; each id is told once, never twice, not again after a restart
  {
    const h = harness();
    let t = T;
    clock(t);
    const [, made] = await h.bots.create({ name: 'Scout' });
    const bid = made.bot.id, first = made.id, role = `bot:${bid}`;
    writeFile([{ id: first, role }]);
    await h.bots.tick();
    assert.equal(h.calls.deliver.length, 0); // no first message yet
    h.promptAt.set(first, t);
    clock(t += 11e3);
    await h.bots.tick();
    assert.equal(h.calls.deliver.length, 1);
    assert.equal(h.calls.deliver[0].to, first);
    // the conversation the start began: its id note asks for the one hello
    assert.equal(h.calls.deliver[0].text, `[Fleet View] You are Scout, one of Henry's bots. Your id: ${first}. Greet Henry in one short line, nothing more.`);
    assert.equal(h.calls.deliver[0].opts.via, 'server');
    for (let i = 0; i < 4; i++) { clock(t += 11e3); await h.bots.tick(); }
    assert.equal(h.calls.deliver.length, 1);
    assert.deepEqual(h.saved()[0].told, [first]);
    // a handoff: the pickup is a new conversation with the role
    const next = id(500);
    h.setList([{ id: next, alive: true, role, status: 'busy', pending: false }]);
    writeFile([{ id: next, role }]);
    h.promptAt.set(next, t);
    clock(t += 11e3);
    await h.bots.tick();
    assert.deepEqual(h.saved()[0].ids, [first, next]);
    assert.equal(h.bots.view()[0].convId, next);
    // the one /state keeps listed however quiet: the row's conversation, not the earlier one
    assert.deepEqual(h.bots.chatIds(), [next]);
    assert.equal(h.calls.deliver.length, 2); assert.equal(h.calls.deliver[1].to, next);
    // a pickup is no new bot: just "ok", no second hello
    assert.equal(h.calls.deliver[1].text, `[Fleet View] You are Scout, one of Henry's bots. Your id: ${next}. Reply with just "ok".`);
    // another bot's role and a session with none are left alone
    h.setList([{ id: next, alive: true, role, pending: false }, { id: id(501), alive: true, role: 'bot:dddddddddddd' }, { id: id(502), alive: true, role: null }]);
    writeFile([{ id: next, role }]);
    clock(t += 11e3);
    await h.bots.tick();
    assert.deepEqual(h.saved()[0].ids, [first, next]);
    // a restart: the ids and the told ones come back from settings
    const again = harness({ saved: h.saved(), base: h.base, list: [{ id: next, alive: true, role, status: 'idle', pending: false }] });
    again.promptAt.set(next, t);
    writeFile([{ id: next, role }]);
    clock(t += 11e3);
    await again.bots.tick();
    assert.equal(again.calls.deliver.length, 0);
    assert.equal(again.bots.view()[0].live, true);
    // the tags follow it: both its conversations, and the Chief's
    const tagOf = again.bots.tagOf([id(900)]);
    assert.equal(tagOf(first), bid); assert.equal(tagOf(next), bid); assert.equal(tagOf(id(900)), 'chief'); assert.equal(tagOf(id(502)), null);
    // resumable: its conversation in its folder, with its role
    assert.deepEqual(again.bots.vouch(next), { role, folder: made.bot.folder });
    assert.equal(again.bots.vouch(id(502)), null);
    // no bot in sessions.json: the host's list is not asked for
    writeFile([]);
    const asked = again.calls.hostList;
    clock(t += 11e3);
    await again.bots.tick();
    assert.equal(again.calls.hostList, asked);
    assert.equal(again.bots.view()[0].live, false);
    n++; console.log('ok follows each bot and tells each id once');
  }
  // change: CLAUDE.md written again, a running bot told once, its conversation renamed; bad input refused
  {
    const h = harness();
    const [, made] = await h.bots.create({ name: 'Scout', brief: 'old' });
    const bid = made.bot.id, md = path.join(made.bot.folder, 'CLAUDE.md');
    const [code, out] = await h.bots.update(bid, { name: 'Ranger', brief: 'Watch the merges.', effort: 'high' });
    assert.equal(code, 200); assert.equal(out.bot.name, 'Ranger'); assert.equal(out.bot.effort, 'high'); assert.equal(out.bot.folder, made.bot.folder);
    assert.ok(fs.readFileSync(md, 'utf8').startsWith('# Ranger\n') && fs.readFileSync(md, 'utf8').includes('Watch the merges.'));
    assert.equal(h.calls.deliver.length, 1);
    assert.equal(h.calls.deliver[0].to, made.id); assert.equal(h.calls.deliver[0].text, B.CHANGED_NOTE); assert.equal(h.calls.deliver[0].opts.via, 'server');
    assert.deepEqual(h.calls.rename, [{ id: made.id, name: 'Ranger' }]);
    // the model alone: CLAUDE.md is the same, so nothing is typed
    await h.bots.update(bid, { model: 'opus' });
    assert.equal(h.calls.deliver.length, 1);
    assert.equal(h.saved()[0].model, 'opus');
    const [, other] = await h.bots.create({ name: 'Other' });
    assert.equal((await h.bots.update(other.bot.id, { name: 'ranger' }))[0], 400);
    assert.equal((await h.bots.update(bid, { brief: 'x'.repeat(4001) }))[0], 400);
    assert.equal((await h.bots.update(bid, { account: 'Q' }))[0], 400);
    assert.equal((await h.bots.update('cccccccccccc', { name: 'x' }))[0], 404);
    assert.equal(h.saved().find((x) => x.id === bid).name, 'Ranger');
    n++; console.log('ok change: CLAUDE.md, the note, the rename, the checks');
  }
  // remove: its session ended, off state.bots, its ids still tagged, its folder kept; its name is free again
  {
    const h = harness();
    let t = T;
    clock(t);
    const [, made] = await h.bots.create({ name: 'Scout' });
    const bid = made.bot.id, role = `bot:${bid}`;
    const [code, out] = await h.bots.remove(bid);
    assert.equal(code, 200); assert.equal(out.ok, true); assert.equal(out.bot.live, false);
    assert.deepEqual(h.calls.end, [made.id]);
    assert.deepEqual(h.bots.view(), []);
    assert.deepEqual(h.bots.chatIds(), []); // a removed bot's chat ages off like any other
    assert.equal(h.saved()[0].removed, true);
    assert.equal(h.bots.tagOf([])(made.id), bid);
    assert.equal(h.bots.vouch(made.id), null); // not resumed through the API any more
    assert.ok(fs.existsSync(path.join(made.bot.folder, 'CLAUDE.md')));
    assert.equal((await h.bots.start(bid))[0], 404);
    assert.equal((await h.bots.update(bid, { name: 'x' }))[0], 404);
    assert.equal((await h.bots.remove(bid))[0], 404);
    const [, again] = await h.bots.create({ name: 'Scout' });
    assert.equal(again.bot.folder, path.join(h.base, 'scout-2'));
    // a removed bot's session that comes back (a restore): it ends
    h.setList([{ id: made.id, alive: true, role, status: 'idle', pending: false }]);
    writeFile([{ id: made.id, role }]);
    clock(t += 11e3);
    await h.bots.tick();
    assert.deepEqual(h.calls.end, [made.id, made.id]);
    n++; console.log('ok remove: ended, off the list, still tagged, folder kept');
  }
  // on the map (POST /bots/:id/map: put, move, off) and watching (POST /bots/:id/watch: add, change the job, stop, the
  // refusals); off the map and removing stop every watch
  {
    const h = harness();
    const t = T + 5e5;
    clock(t);
    const [, made] = await h.bots.create({ name: 'Pablito' });
    const bid = made.bot.id, mine = made.id;
    assert.equal(made.bot.map, null); assert.deepEqual(made.bot.watches, []);
    assert.equal(h.bots.setMap(bid, {})[0], 400);
    assert.equal(h.bots.setMap(bid, { at: { x: 'a', y: 1 } })[0], 400);
    assert.equal(h.bots.setMap('ffffffffffff', { at: { x: 1, y: 1 } })[0], 404);
    let [mc, mo] = h.bots.setMap(bid, { at: { x: 10.04, y: -20 } });
    assert.equal(mc, 200); assert.deepEqual(mo.bot.map, { x: 10, y: -20 }); assert.match(mo.message, /put Pablito on the map/);
    [, mo] = h.bots.setMap(bid, { at: { x: 30, y: 40 } });
    assert.deepEqual(mo.bot.map, { x: 30, y: 40 }); assert.match(mo.message, /moved/);
    assert.deepEqual(h.saved()[0].map, { x: 30, y: 40 });
    assert.deepEqual(h.bots.view()[0].map, { x: 30, y: 40 });
    // the refusals: not a conversation id, no such job (left out is not a stop), its own conversation, another bot's,
    // the Chief's, one Fleet View does not know; nobody is told
    const X = id(700), Y = id(701);
    h.known.add(X); h.known.add(Y); h.names.set(X, 'Fix login');
    const [, other] = await h.bots.create({ name: 'Other' });
    h.chief.push(id(800)); h.known.add(id(800));
    const sent = h.calls.deliver.length;
    assert.equal((await h.bots.setWatch(bid, { id: 'nope', job: 'report' }))[0], 400);
    assert.equal((await h.bots.setWatch(bid, { id: X, job: 'boss' }))[0], 400);
    assert.equal((await h.bots.setWatch(bid, { id: X }))[0], 400);
    assert.match((await h.bots.setWatch(bid, { id: mine, job: 'report' }))[1].message, /Pablito's own/);
    assert.match((await h.bots.setWatch(bid, { id: other.id, job: 'report' }))[1].message, /a bot's \(Other\)/);
    assert.match((await h.bots.setWatch(bid, { id: id(800), job: 'report' }))[1].message, /Chief/);
    assert.equal((await h.bots.setWatch(bid, { id: id(801), job: 'report' }))[0], 400);
    assert.equal((await h.bots.setWatch('ffffffffffff', { id: X, job: 'report' }))[0], 404);
    assert.equal(h.calls.deliver.length, sent);
    // add: the bot is told once, as Fleet View
    const [wc, wo] = await h.bots.setWatch(bid, { id: X.toUpperCase(), job: 'report' });
    assert.equal(wc, 200); assert.equal(wo.ok, true); assert.match(wo.message, /it was told/);
    assert.deepEqual(wo.bot.watches, [{ id: X, job: 'report', since: t, name: 'Fix login', last: null }]);
    const note = h.calls.deliver.at(-1);
    assert.equal(note.to, mine);
    assert.equal(note.text, `[Fleet View] Henry set you to watch "Fix login" (${X}) with the job: tell Henry in one or two lines what happened and whether he needs to do anything (\`fv read ${X}\` for more). Fleet View will message you when its turn ends, it asks something, errors or stalls; you never need to poll it. Reply with just "ok".`);
    assert.deepEqual(note.opts, { kind: 'message', queue: true, open: false, via: 'server' });
    // the same job again: nothing to tell; a new job: told again, since kept
    const n1 = h.calls.deliver.length;
    assert.match((await h.bots.setWatch(bid, { id: X, job: 'report' }))[1].message, /already/);
    assert.equal(h.calls.deliver.length, n1);
    const [, jo] = await h.bots.setWatch(bid, { id: X, job: 'review' });
    assert.equal(jo.bot.watches[0].job, 'review'); assert.equal(jo.bot.watches[0].since, t);
    assert.equal(h.calls.deliver.length, n1 + 1); assert.match(h.calls.deliver.at(-1).text, /with the job: when it says its work is done/);
    // not running: started (its last conversation resumed) to be told; it need not be on the map
    h.setList(h.list().map((x) => ({ ...x, alive: false })));
    await h.bots.setWatch(bid, { id: Y, job: 'answer' });
    assert.deepEqual(h.calls.openBot, [mine]);
    assert.equal(h.calls.deliver.at(-1).to, mine);
    assert.ok(h.calls.deliver.at(-1).text.startsWith(`[Fleet View] Henry set you to watch "${Y.slice(0, 8)}" (${Y}) with the job: when it asks something`));
    // 8 at most
    for (let i = 0; i < 6; i++) { h.known.add(id(710 + i)); assert.equal((await h.bots.setWatch(bid, { id: id(710 + i), job: 'report' }))[0], 200); }
    h.known.add(id(720));
    assert.equal((await h.bots.setWatch(bid, { id: id(720), job: 'report' }))[0], 409);
    assert.equal(h.saved().find((x) => x.id === bid).watches.length, 8);
    // stop: told while it runs, never started for it
    const [sc2, so2] = await h.bots.setWatch(bid, { id: X, job: null });
    assert.equal(sc2, 200); assert.equal(so2.bot.watches.length, 7);
    assert.equal(h.calls.deliver.at(-1).text, `[Fleet View] Henry stopped your watch on "Fix login" (${X}). Reply with just "ok".`);
    h.setList(h.list().map((x) => ({ ...x, alive: false })));
    const opened = h.calls.openBot.length, started = h.calls.startBot.length, n2 = h.calls.deliver.length;
    const [, so3] = await h.bots.setWatch(bid, { id: Y, job: null });
    assert.match(so3.message, /not told \(it is not running\)/);
    assert.equal(h.calls.deliver.length, n2); assert.equal(h.calls.openBot.length, opened); assert.equal(h.calls.startBot.length, started);
    assert.match((await h.bots.setWatch(bid, { id: Y, job: null }))[1].message, /was not watching/);
    // the note did not go in: watching all the same, and the answer says so
    h.setDeliver(500);
    h.known.add(id(721));
    const [fc, fo] = await h.bots.setWatch(bid, { id: id(721), job: 'report' });
    assert.equal(fc, 200); assert.equal(fo.ok, true); assert.match(fo.message, /^watching it; could not tell Pablito/);
    h.setDeliver(null);
    // off the map: every watch stops, the bot is not told of each
    const n3 = h.calls.deliver.length;
    const [oc, oo] = h.bots.setMap(bid, { at: null });
    assert.equal(oc, 200); assert.equal(oo.bot.map, null); assert.deepEqual(oo.bot.watches, []);
    assert.match(oo.message, /off the map and stopped its 7 watches/);
    assert.equal(h.calls.deliver.length, n3);
    assert.ok(!('map' in h.saved().find((x) => x.id === bid))); assert.deepEqual(h.saved().find((x) => x.id === bid).watches, []);
    // removed: off the map and watching nothing
    h.bots.setMap(bid, { at: { x: 1, y: 2 } });
    await h.bots.setWatch(bid, { id: X, job: 'report' });
    assert.equal(h.saved().find((x) => x.id === bid).watches.length, 1);
    await h.bots.remove(bid);
    const gone = h.saved().find((x) => x.id === bid);
    assert.ok(!('map' in gone)); assert.deepEqual(gone.watches, []);
    assert.equal(h.bots.setMap(bid, { at: { x: 1, y: 2 } })[0], 404);
    assert.equal((await h.bots.setWatch(bid, { id: X, job: 'report' }))[0], 404);
    n++; console.log('ok map and watch: put, move, off; add, change, stop, refusals; off the map and remove stop every watch');
  }
  // the watcher (watchTick): first sight, settle, one note for several, the job's filter, started first, the desktop
  // app down, retries then dropped, a handoff moves the watch, one gone ends it
  {
    const h = harness();
    let t = T + 1e6;
    clock(t);
    const [, made] = await h.bots.create({ name: 'Pablito' });
    const bid = made.bot.id, mine = made.id;
    const X = id(730), Y = id(731), Z = id(732);
    for (const c of [X, Y, Z]) h.known.add(c);
    h.names.set(X, 'Fix login'); h.names.set(Y, 'Docs'); h.names.set(Z, 'Deploy');
    const tick = async (ms) => { clock(t += ms); await h.bots.watchTick(); };
    await tick(0);
    assert.equal(h.calls.facts.length, 0); // nothing watched: nothing read
    await h.bots.setWatch(bid, { id: X, job: 'report' });
    await h.bots.setWatch(bid, { id: Y, job: 'review' });
    await h.bots.setWatch(bid, { id: Z, job: 'answer' });
    const told = h.calls.deliver.length; // the three "set you to watch" notes
    h.facts.set(X, { state: 'WORKING', lastReply: 'old', replyAt: t - 60e3 });
    h.facts.set(Y, { state: 'WORKING', lastReply: null, replyAt: 0 });
    h.facts.set(Z, { state: 'WORKING', lastReply: null, replyAt: 0 });
    await tick(0); // first sight
    assert.deepEqual([...h.calls.facts.at(-1)].sort(), [X, Y, Z].sort()); // only the watched ids are read
    // X finishes, Y asks (review: not its job), Z errors; nothing until each held 10 s
    clock(t += 5e3);
    h.facts.set(X, { state: 'IDLE', lastReply: 'Merged #12.\nAll green.', replyAt: t - 1e3 });
    h.facts.set(Y, { state: 'ASKING', lastReply: null, replyAt: 0 });
    h.facts.set(Z, { state: 'ERROR', lastReply: 'API Error: 529', replyAt: 0 });
    await tick(0);
    assert.equal(h.calls.deliver.length, told);
    await tick(11e3);
    assert.equal(h.calls.deliver.length, told + 1);
    const note = h.calls.deliver.at(-1);
    assert.equal(note.to, mine); assert.equal(note.opts.via, 'server'); assert.equal(note.opts.open, false);
    assert.equal(note.text.split('\n')[0], '[Fleet View] Watch: 2 updates.');
    assert.ok(note.text.includes(`\n\n"Fix login" (${X}) finished its turn.\nIts last reply: Merged #12. All green.\nYour job for it: tell Henry`));
    assert.ok(note.text.includes(`\n\n"Deploy" (${Z}) hit an error.\nIts last reply: API Error: 529\nYour job for it: when it asks something`));
    assert.ok(!note.text.includes(Y));
    const v = h.bots.view()[0].watches;
    assert.deepEqual(v.map((w) => [w.id, w.name, w.last && w.last.what]), [[X, 'Fix login', 'finished'], [Y, 'Docs', null], [Z, 'Deploy', 'error']]);
    assert.equal(v[0].last.at, t);
    assert.deepEqual(h.saved()[0].watches[0].last, { at: t, what: 'finished' }); // saved: the page shows it after a restart
    await tick(11e3);
    assert.equal(h.calls.deliver.length, told + 1); // once
    // not running: started first (its last conversation resumed), then told
    h.setList(h.list().map((x) => ({ ...x, alive: false })));
    h.facts.set(Z, { state: 'WORKING', lastReply: null, replyAt: 0 });
    await tick(1e3);
    h.facts.set(Z, { state: 'QUESTION', lastReply: 'Which branch?', replyAt: 0 });
    await tick(1e3);
    await tick(11e3);
    assert.deepEqual(h.calls.openBot, [mine]);
    assert.equal(h.calls.deliver.at(-1).text.split('\n')[0], `[Fleet View] Watch: "Deploy" (${Z}) is asking something.`);
    assert.equal(h.calls.deliver.at(-1).text.split('\n')[1], 'Its last reply: Which branch?');
    // the desktop app down: nothing goes in, and it does once the app is back
    const d0 = h.calls.deliver.length;
    h.setDown(true);
    h.facts.set(X, { state: 'WORKING', lastReply: 'x', replyAt: t - 60e3 });
    await tick(1e3);
    clock(t += 1e3);
    h.facts.set(X, { state: 'IDLE', lastReply: 'Second fix shipped.', replyAt: t });
    await tick(0);
    await tick(11e3);
    assert.equal(h.calls.deliver.length, d0);
    h.setDown(false);
    await tick(5e3);
    assert.equal(h.calls.deliver.length, d0 + 1);
    assert.match(h.calls.deliver.at(-1).text, /^\[Fleet View\] Watch: "Fix login" .* finished its turn\.\nIts last reply: Second fix shipped\./);
    // a note that does not go in: tried again each pass, 3 times, then dropped
    h.setDeliver(500);
    const d1 = h.calls.deliver.length;
    h.facts.set(X, { state: 'WORKING', lastReply: 'x', replyAt: t - 60e3 });
    await tick(1e3);
    clock(t += 1e3);
    h.facts.set(X, { state: 'IDLE', lastReply: 'Third.', replyAt: t });
    await tick(0);
    await tick(11e3); await tick(5e3); await tick(5e3); await tick(5e3);
    assert.equal(h.calls.deliver.length, d1 + 3);
    h.setDeliver(null);
    await tick(5e3);
    assert.equal(h.calls.deliver.length, d1 + 3);
    assert.equal(h.saved()[0].watches[0].last.what, 'finished'); // still the last one that went in
    // a handoff: the watch goes on in the pickup (saved), no note; the pickup's first sight is no news
    const X2 = id(740);
    h.facts.set(X, { state: 'DONE', lastReply: 'Handing off.', replyAt: t, next: X2 });
    await tick(1e3);
    assert.deepEqual(h.saved()[0].watches.map((w) => [w.id, w.job]), [[X2, 'report'], [Y, 'review'], [Z, 'answer']]);
    h.facts.set(X2, { state: 'IDLE', lastReply: 'Picked up.', replyAt: t });
    await tick(11e3); await tick(11e3);
    assert.equal(h.calls.deliver.length, d1 + 3);
    // gone from Fleet View: the watch ends, and the running bot is told
    h.facts.set(Y, { state: 'WORKING', gone: true });
    await tick(1e3);
    assert.deepEqual(h.saved()[0].watches.map((w) => w.id), [X2, Z]);
    assert.equal(h.calls.deliver.at(-1).text, `[Fleet View] "Docs" (${Y}), which you were watching, is gone from Fleet View; the watch ended. Reply with just "ok".`);
    // gone while the bot is not running: the watch ends, nobody is started for it
    h.setList(h.list().map((x) => ({ ...x, alive: false })));
    const o1 = h.calls.openBot.length, d2 = h.calls.deliver.length;
    h.facts.set(Z, { gone: true });
    await tick(1e3);
    assert.deepEqual(h.saved()[0].watches.map((w) => w.id), [X2]);
    assert.equal(h.calls.openBot.length, o1); assert.equal(h.calls.deliver.length, d2);
    // the demo watches nothing
    const demo = harness({ demo: true });
    await demo.bots.watchTick();
    assert.equal(demo.calls.facts.length, 0);
    n++; console.log('ok the watcher: settle, once, one note for several, job filter, started first, host down, retries, handoff, gone');
  }

  {
    // /api/bots with the token: anyone may start a bot; making, changing or removing one takes Henry's phone (the
    // relay's key with "via": "phone"), since every session can read the token
    API.ensureToken();
    const tok = fs.readFileSync(path.join(require('../platform.js').dataDir(), 'api-token'), 'utf8').trim();
    const did = [];
    const ctx = {
      log: () => {}, sendJson: (res, code, out) => res.done([code, out]),
      readBody: (req, res, cb) => cb(req.body),
      bots: {
        list: () => [200, []], create: () => (did.push('create'), [200, { ok: true }]), update: () => (did.push('update'), [200, { ok: true }]),
        start: () => (did.push('start'), [200, { ok: true }]), remove: () => (did.push('remove'), [200, { ok: true }]),
        look: (b) => (did.push(`look ${b.from}`), [200, { ok: true }]),
      },
    };
    const { EventEmitter } = await import('node:events');
    const call = (pathname, body, extra = {}) => new Promise((resolve) => {
      const req = { method: 'POST', url: pathname, body, headers: { authorization: `Bearer ${tok}`, ...extra } };
      const res = Object.assign(new EventEmitter(), { destroyed: false, writableFinished: true, done: resolve });
      API.handle(req, res, pathname, ctx);
    });
    const relay = { 'x-fleet-view-relay': API.relayKey() };
    assert.equal((await call('/api/bots', { name: 'x' }))[0], 403);
    assert.equal((await call(`/api/bots/${BID}`, { brief: 'new orders' }))[0], 403);
    assert.equal((await call(`/api/bots/${BID}/remove`, {}))[0], 403);
    assert.equal((await call('/api/bots', { name: 'x', via: 'phone' }))[0], 403); // no key
    assert.equal((await call('/api/bots', { name: 'x', via: 'phone' }, { 'x-fleet-view-relay': 'nope' }))[0], 403);
    assert.equal((await call('/api/bots', { name: 'x' }, relay))[0], 403); // the key without "via": "phone"
    assert.deepEqual(did, []);
    assert.equal((await call(`/api/bots/${BID}/start`, {}))[0], 200);
    assert.equal((await call('/api/bots', { name: 'x', via: 'phone' }, relay))[0], 200);
    assert.equal((await call(`/api/bots/${BID}`, { brief: 'b', via: 'phone' }, relay))[0], 200);
    assert.equal((await call(`/api/bots/${BID}/remove`, { via: 'phone' }, relay))[0], 200);
    assert.deepEqual(did, ['start', 'create', 'update', 'remove']);
    // a bot's own look: any token caller reaches bots.look (it checks from); not a bot id, and POST only
    did.length = 0;
    assert.equal((await call('/api/bots/look', { from: 'x', shape: 'heart' }))[0], 200);
    assert.deepEqual(did, ['look x']);
    n++; console.log('ok /api/bots: start for anyone; make, change and remove only from the phone relay; look goes to bots.look');
  }
})().finally(() => { Date.now = realNow; try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

console.log(`${n} tests passed`);
