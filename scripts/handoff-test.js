// handoff-test.js: handoff.js's chain links (the cards' "handed off" / "picked up from", the map's handoff lines,
// teams' successorOf), from the handoff files and from the logs. A log's HANDOFF text (what `/pickup` leaves) is
// read in the command's message or the next one, with \ or / paths (the Mac's /Users/...), and links both ways
// with no handoff file (the other machine); a file, when there is one, wins; nothing links to itself. The summary
// (GET /handoff-summary) comes from the file, or from that HANDOFF text in the log's head (summaryFromLog).
// Run: node scripts/handoff-test.js   (exit 0 = all pass)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-test-'));
process.env.FV_HANDOFF_DIR = T;
const HO = require(path.join(__dirname, '..', 'handoff.js'));

let pass = 0, fail = 0;
const ok = (c, name) => { if (c) pass++; else { fail++; console.log(`FAIL ${name}`); } };
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), `${name}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

const OLD = '66ad4663-2ec9-4510-b94b-7d60804e1d9e', NEW = '3399988e-8505-42ce-b164-4fc9142b954b';
const FILE = '2026-10-12_150002_66ad4663.md';
const winText = `HANDOFF C:\\Users\\henry\\.claude-handoffs\\${FILE}\r\nfrom session ${OLD.toUpperCase()} (account A), folder Z:\\P4V\\x, 2026-10-12T15:00:02-07:00\r\n\r\n# Title\n\n## Goal\n...`;
const macText = `HANDOFF /Users/henry/.claude-handoffs/${FILE}\nfrom session ${OLD} (account B), folder /Users/henry/code/x, 2026-10-12T15:00:02-07:00\n\n# Title`;
const none = { bySession: new Map(), byNext: new Map() };

try {
  // ---------- reading the HANDOFF text ----------
  eq(HO.pickupOf(winText), { from: OLD, file: `C:\\Users\\henry\\.claude-handoffs\\${FILE}`, created: Date.parse('2026-10-12T15:00:02-07:00') }, 'Windows path, CRLF, id lower-cased');
  eq(HO.pickupOf(macText), { from: OLD, file: `/Users/henry/.claude-handoffs/${FILE}`, created: Date.parse('2026-10-12T15:00:02-07:00') }, 'Mac path');
  eq(HO.pickupOf(`(Note: this handoff was already picked up by session ${OLD}.)\r\n` + winText), HO.pickupOf(winText), 'picked up again: the Note line first');
  ok(HO.summaryBody(`(Note: this handoff was already picked up by session ${OLD}.)\n` + winText) === HO.summaryBody(winText), 'picked up again: the Note line stays out of the summary');
  ok(HO.pickupOf('we talked about HANDOFF C:\\x.md\nfrom session ' + OLD) === null, 'not at the start: not a pickup');
  ok(HO.pickupOf('HANDOFF C:\\x.md\nfrom session not-an-id') === null && HO.pickupOf(null) === null, 'no id: null');
  // the command's message, then the next (isMeta) one with the text block
  const cmd = '<command-message>pickup</command-message>\n<command-name>/pickup</command-name>\n<command-args>C:\\Users\\henry\\.claude-handoffs\\' + FILE + '</command-args>';
  ok(HO.pickupIn(cmd) === null, 'the command message alone names no old session');
  eq(HO.pickupIn([{ type: 'text', text: winText }]).from, OLD, 'the HANDOFF text block in the next message');
  eq(HO.pickupIn([{ type: 'tool_result', content: winText }, { type: 'text', text: 'hi' }, { type: 'text', text: macText }]).from, OLD, 'only text blocks, any of them');
  eq(HO.pickupIn(cmd + '\n' + winText), null, 'the text must start with HANDOFF');
  eq(HO.pickupIn(winText).from, OLD, 'string content');

  // ---------- no handoff file: the logs link both ways ----------
  const oldS = { id: OLD }, newS = { id: NEW, pickupFrom: OLD, pickupAt: 1000, pickupFile: `/Users/henry/.claude-handoffs/${FILE}` };
  const all = [oldS, newS];
  const succ = HO.successorsFromLogs(all);
  eq(HO.linksOf(oldS, none, succ, all), { h: null, next: NEW, at: 1000, from: null }, 'no file: the old one hands off to the one whose log names it');
  eq(HO.linksOf(newS, none, succ, all), { h: null, next: null, at: null, from: { id: OLD, rec: null } }, 'no file: the new one picked up from the old one');
  ok(HO.localFile(newS.pickupFile) === null, 'no file here: localFile is null');
  fs.writeFileSync(path.join(T, FILE), '---\nsession: x\n---\n');
  eq(HO.localFile(newS.pickupFile), path.join(T, FILE), 'the same name in the handoff folder: localFile finds it (Mac path on any machine)');
  eq(HO.localFile(`C:\\Users\\henry\\.claude-handoffs\\${FILE}`), path.join(T, FILE), 'and from a Windows path');
  fs.unlinkSync(path.join(T, FILE));

  // a later pickup of the same old one wins; a self-reference is ignored
  const again = { id: 'aaaaaaaa-0000-4000-8000-000000000001', pickupFrom: OLD, pickupAt: 2000 };
  eq(HO.successorsFromLogs([...all, again]).get(OLD).id, again.id, 'picked up twice: the later one');
  const self = { id: OLD, pickupFrom: OLD, pickupAt: 5 };
  ok(!HO.successorsFromLogs([self]).has(OLD), 'self: no successor by log');
  eq(HO.linksOf(self, none, new Map([[OLD, { id: OLD, at: 5 }]]), [self]), { h: null, next: null, at: null, from: null }, 'self: links to nothing');

  // ---------- with the file: the file wins (same result when they agree) ----------
  const rec = { file: path.join(T, FILE), session: OLD, next: NEW, created: 500, handedOffAt: 600, title: 'Title' };
  const links = { bySession: new Map([[OLD, rec]]), byNext: new Map([[NEW, rec]]) };
  eq(HO.linksOf(oldS, links, succ, all), { h: rec, next: NEW, at: 600, from: null }, 'file: next and the handoff time from the file');
  eq(HO.linksOf(newS, links, succ, all), { h: null, next: null, at: null, from: { id: OLD, rec } }, 'file: picked up from, with the file record');
  // the file names another successor: it wins over the log
  const OTHER = 'bbbbbbbb-0000-4000-8000-000000000002';
  const rec2 = { ...rec, next: OTHER };
  eq(HO.linksOf(oldS, { bySession: new Map([[OLD, rec2]]), byNext: new Map([[OTHER, rec2]]) }, succ, all).next, OTHER, 'file and log disagree: the file wins');
  // a file without next_session: the conversation that ran /pickup <that file>, then the log
  const rec3 = { ...rec, next: null, handedOffAt: null };
  const picker = { id: OTHER, pickupArg: `C:\\Users\\henry\\.claude-handoffs\\${FILE}` };
  eq(HO.linksOf(oldS, { bySession: new Map([[OLD, rec3]]), byNext: new Map() }, succ, [oldS, picker]).next, OTHER, 'file without next: the /pickup <file> conversation');
  eq(HO.linksOf(oldS, { bySession: new Map([[OLD, rec3]]), byNext: new Map() }, succ, all), { h: rec3, next: NEW, at: 500, from: null }, 'file without next and no /pickup arg seen: the log, at the file\'s time');
  eq(HO.linksOf({ id: OTHER, pickupArg: picker.pickupArg }, { bySession: new Map([[OLD, rec3]]), byNext: new Map() }, new Map(), []).from, { id: OLD, rec: rec3 }, '/pickup <file> on this machine: picked up from, by the file');
  // a file naming itself as next is no link
  const selfRec = { ...rec, next: OLD };
  eq(HO.linksOf(oldS, { bySession: new Map([[OLD, selfRec]]), byNext: new Map([[OLD, selfRec]]) }, new Map(), [oldS]), { h: selfRec, next: null, at: 600, from: null }, 'file naming itself: no next, no from');

  // ---------- the summary (GET /handoff-summary): the file here, else the copy in the new conversation's log ----------
  const L = path.join(T, 'logs');
  fs.mkdirSync(L);
  let n = 0;
  const log = (records, raw = '') => {
    const f = path.join(L, `log${++n}.jsonl`);
    fs.writeFileSync(f, records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + (records.length ? '\n' : '') + raw);
    return f;
  };
  const head = [{ type: 'custom-title', customTitle: 'x', sessionId: NEW }, { type: 'mode', mode: 'normal' }, { type: 'file-history-snapshot', snapshot: {} }];
  const cmdRec = { type: 'user', message: { role: 'user', content: cmd } };
  const tail = '\n\nThe handoff above is from the previous session, which closed on purpose to keep sessions short.\n\n- Don\'t re-check everything.';
  const body = '# Title\n\n## Goal\nfix it\n\n## Next\n- step one';
  const crlfText = `HANDOFF C:\\Users\\henry\\.claude-handoffs\\${FILE}\r\nfrom session ${OLD} (account A), folder Z:\\P4V\\x, 2026-10-12T15:00:02-07:00\r\n\r\n${body.replace(/\n/g, '\r\n')}`;
  // the real shape: the command's message, then an isMeta one with the HANDOFF text block, CRLF, the command's text after it
  let r = HO.summaryFromLog(log([...head, cmdRec, { type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: crlfText + tail.replace(/\n/g, '\r\n') }] } }, { type: 'assistant', message: { content: [{ type: 'text', text: 'Picked up' }] } }]));
  eq(r && r.text, body, 'isMeta block, CRLF: the summary, header and the command\'s own text gone');
  eq(r && [r.from, r.file], [OLD, `C:\\Users\\henry\\.claude-handoffs\\${FILE}`], 'and the old id and the file it names');
  r = HO.summaryFromLog(log([...head, { type: 'user', message: { role: 'user', content: `${macText}\n\n## Goal\nmore\n\nCHECK BEFORE STOPPING: the wait above counts only if …` } }]));
  eq(r && r.text, '# Title\n\n## Goal\nmore', 'string content (Mac path), handoff.py\'s CHECK line cut');
  r = HO.summaryFromLog(log([...head, { type: 'user', message: { content: [{ type: 'tool_result', content: winText }, { type: 'text', text: winText }] } }]));
  eq(r && r.text, '# Title\n\n## Goal\n...', 'block content: only a text block counts');
  eq(r && r.at, null, 'a record with no timestamp: at is null');
  r = HO.summaryFromLog(log([...head, { type: 'user', timestamp: '2026-10-12T22:00:05.000Z', message: { content: winText } }]));
  eq(r && r.at, Date.parse('2026-10-12T22:00:05.000Z'), 'at: the pickup record\'s time (a long log\'s pickupAt, fleet-view.js headPickup)');
  ok(HO.summaryFromLog(log([...head, cmdRec, { type: 'user', message: { content: 'hello' } }, { type: 'assistant', message: { content: [{ type: 'text', text: winText }] } }])) === null, 'no HANDOFF text in a user record: null');
  ok(HO.summaryFromLog(log([...head, { type: 'user', isSidechain: true, message: { content: winText } }])) === null, 'a subagent\'s record: null');
  ok(HO.summaryFromLog(log([...head, { type: 'user', message: { content: `HANDOFF C:\\x.md\nfrom session ${OLD} (account A)\n\n` } }])) === null, 'a header with no summary under it: null');
  ok(HO.summaryFromLog(path.join(L, 'none.jsonl')) === null && HO.summaryFromLog(L) === null, 'no file, or a folder: null');
  // the last line with no newline yet (a log being written)
  r = HO.summaryFromLog(log([...head], JSON.stringify({ type: 'user', message: { content: winText } })));
  eq(r && r.from, OLD, 'the last line, with no newline yet');
  // only the head of a log is read: past LOG_LINES lines, or a line that starts after LOG_HEAD bytes, is never looked at
  const filler = Array.from({ length: 45 }, (_, i) => ({ type: 'file-history-snapshot', i }));
  ok(HO.summaryFromLog(log([...filler, { type: 'user', message: { content: winText } }])) === null, 'past 40 lines: not read');
  const big = { type: 'attachment', attachment: { content: 'x'.repeat(70 << 10) } };
  ok(HO.summaryFromLog(log([...head, big, { type: 'user', message: { content: winText } }])) === null, 'a line that starts past 64 KB: not read');
  eq(HO.summaryFromLog(log([...head, { type: 'user', message: { content: winText }, pad: 'y'.repeat(100 << 10) }]))?.from, OLD, 'a long line that starts within the head: read whole');
  // a huge log: the scan stops at the cap, it never reads the rest (opts shrink the caps; a 20 MB log returns at once)
  const hugeF = path.join(L, 'huge.jsonl');
  fs.writeFileSync(hugeF, JSON.stringify({ type: 'attachment', s: 'z'.repeat(20 << 20) }) + '\n' + JSON.stringify({ type: 'user', message: { content: winText } }) + '\n');
  const t0 = Date.now();
  ok(HO.summaryFromLog(hugeF) === null, 'a 20 MB first line: past LOG_LINE_MAX, null');
  ok(Date.now() - t0 < 1000, `a huge log is read only up to the cap (${Date.now() - t0} ms)`);
  ok(HO.summaryFromLog(log([...head, { type: 'user', message: { content: winText } }]), { lines: 2 }) === null, 'opts.lines caps the lines');
  // remembered: a find stays while the log only grows; a miss is read again once the log changes
  const growF = log([...head]);
  ok(HO.summaryFromLog(growF) === null, 'grow: nothing yet');
  fs.appendFileSync(growF, JSON.stringify({ type: 'user', message: { content: winText } }) + '\n');
  eq(HO.summaryFromLog(growF)?.from, OLD, 'grow: found once the pickup is written');
  fs.appendFileSync(growF, JSON.stringify({ type: 'assistant', message: { content: 'ok' } }) + '\n');
  eq(HO.summaryFromLog(growF)?.from, OLD, 'grow: still found as the log grows');
  // the file: its markdown without the front matter; only a .md right in the handoff folder
  fs.writeFileSync(path.join(T, FILE), `---\r\nsession: ${OLD}\r\nnext_session: ${NEW}\r\n---\r\n\r\n${body}\r\n`);
  eq(HO.summaryFromFile(path.join(T, FILE)), body, 'summaryFromFile: front matter gone, CRLF');
  ok(HO.summaryFromFile(path.join(L, 'log1.jsonl')) === null && HO.summaryFromFile(path.join(L, FILE)) === null, 'summaryFromFile: nothing outside the handoff folder');
  ok(HO.summaryFromFile(path.join(T, 'missing.md')) === null, 'summaryFromFile: no such file');
  fs.unlinkSync(path.join(T, FILE));

  // ---------- the restart request (.restart/<key>.json): peek leaves it, take deletes it ----------
  eq([...HO.restartKeys()], [], 'restartKeys: no .restart folder, none');
  const RF = path.join(T, FILE), RQ = path.join(T, '.restart', 'k-1.json');
  fs.writeFileSync(RF, `---\nsession: ${OLD}\n---\n# H\n`);
  fs.mkdirSync(path.dirname(RQ), { recursive: true });
  fs.writeFileSync(RQ, JSON.stringify({ file: RF, cwd: 'Z:\\x', session: OLD.toUpperCase() }));
  fs.writeFileSync(path.join(T, '.restart', 'notes.txt'), 'x');
  eq([...HO.restartKeys()], ['k-1'], 'restartKeys: the keys with a .json request');
  const want = { file: path.resolve(RF), cwd: 'Z:\\x', session: OLD };
  eq(HO.peekRestart('k-1'), want, 'peekRestart: the request');
  ok(fs.existsSync(RQ), 'peekRestart: the request stays');
  eq(HO.takeRestart('k-1'), want, 'takeRestart: the same request');
  ok(!fs.existsSync(RQ) && HO.peekRestart('k-1') === null && HO.takeRestart('k-1') === null, 'takeRestart: deleted, gone for both');
  fs.writeFileSync(RQ, JSON.stringify({ file: path.join(T, 'missing.md'), session: OLD }));
  ok(HO.peekRestart('k-1') === null, 'peekRestart: a handoff file that is not there: null');
  ok(HO.peekRestart('../k') === null && HO.peekRestart(null) === null, 'peekRestart: a key that is not one: null');
  fs.unlinkSync(RF);
} finally {
  fs.rmSync(T, { recursive: true, force: true });
}
console.log(`handoff-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
