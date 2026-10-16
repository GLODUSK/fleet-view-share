// transcript-only-test.js: a resume's "didn't finish before the previous session ended" note opens no turn (Fleet View
// #552). Claude Code writes it to the log only (queueTranscriptOnly) when a claude is resumed or forked while the one
// before it had background tasks running; nothing answers it and the claude waits at its prompt. fleet-view.js read it
// as a prompt with no reply, so a fork made while its conversation had an agent running sat STALLED ("stopped mid-turn;
// tell it to continue") beside the conversation that carried on. conversation.js transcriptOnly tells such records, and
// fleet-view.js ingestMain (run here in a vm with its helpers stubbed) leaves the last turn as it was for them, while
// still taking their task ids as ended. The records are the shapes of the issue's transcripts.
// Run: node scripts/transcript-only-test.js (exit 0 = all pass)
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const CONV = require(path.join(__dirname, '..', 'conversation.js'));

let n = 0;
const ok = (what) => { n++; console.log(`ok ${n} - ${what}`); };
const FORK = '00f985e2-ae39-494a-a0ce-c5fb28f23893', SRC = '0a2cc1d1-5098-4aa6-93a7-2f686f18ce13';
const note = (status, extra) => ({
  type: 'user', timestamp: '2026-10-16T17:52:10.055Z', sessionId: FORK, cwd: 'Z:\\Github\\fleet-view\\.claude\\worktrees\\left-map', promptSource: 'system',
  message: { role: 'user', content: `<task-notification>\n<task-id>af990aa8fc0bd52dd</task-id>\n<output-file>B:\\Temp\\claude\\Z--Github-fleet-view\\${SRC}\\tasks\\af990aa8fc0bd52dd.output</output-file>\n<status>${status}</status>\n<summary>Background agent "Item 2: Left the map menu" didn't finish before the previous session ended</summary>\n</task-notification>` },
  ...extra,
});
const RESUMED = note('failed', { origin: { kind: 'task-notification' }, queueSkipAttachments: true, queueTranscriptOnly: true });
const FINISHED = note('completed', { origin: { kind: 'task-notification', producer: 'session-task' }, queueSkipAttachments: true }); // an agent that ends while its claude runs
const TYPED = { type: 'user', timestamp: '2026-10-16T17:38:00.000Z', sessionId: SRC, message: { role: 'user', content: 'start item 2' }, origin: { kind: 'human' }, promptSource: 'typed' };
const LAUNCH = { type: 'user', timestamp: '2026-10-16T17:38:47.116Z', sessionId: SRC, toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'af990aa8fc0bd52dd' },
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Async agent launched successfully.' }] } };
const END = { type: 'assistant', timestamp: '2026-10-16T17:38:49.486Z', sessionId: SRC, message: { model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Item 2 is now being built.' }] } };

// ---------- transcriptOnly ----------
assert.strictEqual(CONV.transcriptOnly(RESUMED), true);
for (const d of [FINISHED, TYPED, LAUNCH, END, null, undefined, 'x', { type: 'user', queueTranscriptOnly: 'true' }, { type: 'assistant', queueTranscriptOnly: true }]) assert.strictEqual(CONV.transcriptOnly(d), false, JSON.stringify(d));
ok('transcriptOnly: a user record with queueTranscriptOnly true, nothing else (a task that finished while its claude ran, a prompt, a reply)');

// ---------- ingestMain ----------
const src = fs.readFileSync(path.join(__dirname, '..', 'fleet-view.js'), 'utf8');
const fnSrc = (name) => { const i = src.indexOf(`\nfunction ${name}(`); assert.ok(i >= 0, `fleet-view.js has ${name}`); const m = /\r?\n\}/.exec(src.slice(i + 1)); return src.slice(i + 1, i + 1 + m.index + m[0].length) + '\n'; };
const ctx = {
  CONV, path, Date, String, Array, Math, JSON,
  noteBackground: () => {}, pushEvent: () => {}, noteTool: () => {}, noteResult: () => {}, describeTool: () => ['x', ''], addPr: () => {},
  hushOf: () => undefined, hushed: () => false, localCwd: (c) => c, projDirKey: () => '', endsOnQuestion: () => false,
  HO: { pickupIn: () => null }, SWITCH: { limitHit: () => null }, BG_TOOLS: /^$/, QUIET_REPLY: /^\[quiet\]$/, pickupGen: 0,
};
vm.createContext(ctx);
vm.runInContext(fnSrc('ingestMain'), ctx);
const fresh = () => ({ id: FORK, dir: 'x', finished: new Map(), bg: new Map([['af990aa8fc0bd52dd', Date.parse(LAUNCH.timestamp)]]), bgUse: new Map(), lastReply: '' });
const feed = (s, ...ds) => { ctx.s = s; ctx.recs = ds.map((d) => ({ d, raw: JSON.stringify(d) })); vm.runInContext('ingestMain(s, recs)', ctx); return s; };

// the fork: the copied history (a typed prompt, the agent launched, the turn ended), then the resume's note
let s = feed(fresh(), TYPED, LAUNCH, END, RESUMED);
assert.strictEqual(s.turnOpen, false, 'the turn the history ended stays ended');
assert.strictEqual(s.turnEndT, Date.parse(END.timestamp));
assert.strictEqual(s.prompt, 'start item 2', 'the note is no prompt');
assert.strictEqual(s.actT, Date.parse(END.timestamp), 'nor activity');
assert.strictEqual(s.lastSaid, 'Item 2 is now being built.');
assert.strictEqual(s.finished.get('af990aa8fc0bd52dd'), 'failed', 'its task is taken as ended');
assert.ok(!s.bg.has('af990aa8fc0bd52dd'), '... and no longer counts as running');
ok('ingestMain: a fork whose log ends on the resume\'s note has its last turn ended (DONE, not STALLED), the note\'s task ended, no new prompt or activity');

// a notification that does start a turn (an agent finishing while its claude runs) still opens one, as before
s = feed(fresh(), TYPED, LAUNCH, END, FINISHED);
assert.strictEqual(s.turnOpen, true);
assert.strictEqual(s.finished.get('af990aa8fc0bd52dd'), 'completed');
ok('ingestMain: a task notification that starts a turn still opens it');
// and what comes after the note is read as usual: a prompt typed into the fork opens its turn
s = feed(fresh(), TYPED, LAUNCH, END, RESUMED, { ...TYPED, timestamp: '2026-10-16T18:31:06.975Z', sessionId: FORK, message: { role: 'user', content: 'did u finish' } });
assert.strictEqual(s.turnOpen, true);
assert.strictEqual(s.prompt, 'did u finish');
ok('ingestMain: a prompt typed after the note opens a turn as usual');

console.log(`\n${n} passed, 0 failed`);
