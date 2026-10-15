// node scripts/settings-file-test.js [dir]: the cases settings-file.js (safe saves of ~/.fleet-view.json) must get
// right, on files in a fresh folder under dir (default the temp folder), removed at the end. Exit code 0 when all pass.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const SF = require('../settings-file.js');

let failed = 0, passed = 0;
const ok = (cond, name) => { if (cond) passed++; else { failed++; console.log(`FAIL ${name}`); } };
const dir = fs.mkdtempSync(path.join(process.argv[2] || os.tmpdir(), 'settings-file-test-'));
let fileN = 0;
const fresh = () => path.join(dir, `s${++fileN}`, '.fleet-view.json');
const put = (f, text) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const ls = (f) => fs.readdirSync(path.dirname(f));
const json = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const logger = () => { const lines = []; const log = (t) => lines.push(t); log.lines = lines; return log; };

// 1. a BOM (PowerShell 5.1, old Notepad) is stripped, not taken for a broken file
{
  const f = fresh();
  put(f, '\uFEFF{"restoreIdle":true,"bots":[{"id":"b1"}]}');
  const log = logger();
  const s = SF.read(f, { log });
  ok(s.restoreIdle === true && s.bots[0].id === 'b1', 'BOM: read');
  ok(!log.lines.length && ls(f).length === 1, 'BOM: nothing moved aside, nothing logged');
  ok(SF.peek(f) && SF.peek(f).restoreIdle === true, 'BOM: peek');
}

// 2. a file that does not parse is moved to .corrupt-<time> and .bak is used
{
  const f = fresh();
  put(f, '{"bots":[{"id":"b1"}], "names": {"x":');
  put(f + '.bak', JSON.stringify({ bots: [{ id: 'b0' }], teams: [1] }));
  const log = logger();
  const s = SF.read(f, { log });
  ok(s.bots && s.bots[0].id === 'b0' && s.teams.length === 1, 'corrupt: .bak used');
  const aside = ls(f).filter((n) => /^\.fleet-view\.json\.corrupt-\d{8}-\d{6}$/.test(n));
  ok(aside.length === 1 && !fs.existsSync(f), 'corrupt: moved to .corrupt-<time>');
  ok(fs.readFileSync(path.join(path.dirname(f), aside[0]), 'utf8').startsWith('{"bots"'), 'corrupt: the broken text kept');
  ok(log.lines.some((l) => l.includes('does not parse')) && log.lines.some((l) => l.includes('.bak')), 'corrupt: logged');
  // the next save writes the file again and leaves .bak (the only good copy) alone
  SF.write(f, s);
  ok(json(f).bots[0].id === 'b0' && json(f + '.bak').bots[0].id === 'b0', 'corrupt: next save keeps .bak');
}

// 3. corrupt and no usable .bak: {}; an empty file and a JSON array count as corrupt too
{
  const f = fresh();
  put(f, '');
  const log = logger();
  ok(JSON.stringify(SF.read(f, { log })) === '{}', 'empty file, no .bak: {}');
  ok(log.lines.some((l) => l.includes('empty')) && log.lines.some((l) => l.includes('no ')), 'empty file: logged');
  const g = fresh();
  put(g, '[1,2]');
  put(g + '.bak', 'nope');
  ok(JSON.stringify(SF.read(g)) === '{}' && ls(g).some((n) => n.includes('.corrupt-')), 'array, bad .bak: {} and moved aside');
  ok(SF.peek(g + '.bak') === null, 'peek: a bad file is null');
  // readOnly (the demo): .bak is still used, the broken file is left where it is
  const h = fresh();
  put(h, '{');
  put(h + '.bak', '{"n":1}');
  ok(SF.read(h, { readOnly: true }).n === 1 && ls(h).length === 2 && fs.readFileSync(h, 'utf8') === '{', 'readOnly: nothing moved');
}

// 4. a missing file: the fallback file (the old Agent Pulse one), else {}; nothing logged, nothing made
{
  const f = fresh();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const old = path.join(path.dirname(f), '.agent-pulse.json');
  const log = logger();
  ok(JSON.stringify(SF.read(f, { log, fallback: old })) === '{}', 'missing, no fallback file: {}');
  put(old, '{"view":"map"}');
  ok(SF.read(f, { log, fallback: old }).view === 'map', 'missing: fallback read');
  ok(!log.lines.length && ls(f).length === 1, 'missing: nothing logged or made');
  ok(SF.peek(f) === null, 'peek: missing is null');
}

// 5. a save goes through a tmp file and leaves none behind; the same content is not written again
{
  const f = fresh();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  ok(SF.write(f, { a: 1 }) === true, 'write: first');
  ok(json(f).a === 1 && JSON.stringify(ls(f)) === '[".fleet-view.json"]', 'write: no tmp, no .bak for a new file');
  const t = fs.statSync(f).mtimeMs;
  ok(SF.write(f, { a: 1 }) === false && fs.statSync(f).mtimeMs === t && !fs.existsSync(f + '.bak'), 'write: unchanged is skipped');
}

// 6. .bak rolls: each save copies the file it replaces
{
  const f = fresh();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  SF.write(f, { n: 1 });
  SF.write(f, { n: 2 });
  ok(json(f).n === 2 && json(f + '.bak').n === 1, '.bak: one behind');
  SF.write(f, { n: 3 });
  ok(json(f).n === 3 && json(f + '.bak').n === 2, '.bak: rolls');
  ok(ls(f).length === 2, '.bak: only the file and .bak');
  // a file broken by hand before a save is kept as .corrupt-<time>, and never becomes .bak
  fs.writeFileSync(f, '{"n": 4,,}');
  const log = logger();
  SF.write(f, { n: 5 }, { log });
  ok(json(f).n === 5 && json(f + '.bak').n === 2, '.bak: a broken file is not copied to .bak');
  ok(ls(f).some((n) => n.includes('.corrupt-')) && log.lines.some((l) => l.includes('did not parse')), '.bak: broken file kept aside');
}

// 7. a rename something holds (EPERM on Windows) is tried again; one held for good is written in place
{
  const f = fresh();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  SF.write(f, { n: 1 });
  const real = fs.renameSync;
  let fails = 2, tries = 0;
  fs.renameSync = (a, b) => { tries++; if (fails-- > 0) { const e = new Error('held'); e.code = 'EPERM'; throw e; } return real(a, b); };
  try { SF.write(f, { n: 2 }); } finally { fs.renameSync = real; }
  ok(json(f).n === 2 && tries === 3 && ls(f).length === 2, 'rename: retried after EPERM, no tmp left');
  fs.renameSync = () => { const e = new Error('held'); e.code = 'EBUSY'; throw e; };
  const log = logger();
  try { SF.write(f, { n: 3 }, { log }); } finally { fs.renameSync = real; }
  ok(json(f).n === 3 && ls(f).length === 2 && log.lines.some((l) => l.includes('in place')), 'rename: held for good, written in place, no tmp left');
  fs.renameSync = () => { const e = new Error('gone'); e.code = 'ENOENT'; throw e; };
  let threw = false;
  try { SF.write(f, { n: 4 }); } catch { threw = true; } finally { fs.renameSync = real; }
  ok(threw && json(f).n === 3 && ls(f).length === 2, 'rename: another error throws, file untouched, no tmp left');
}

// 8. a file another program holds open for reading (EBUSY) is tried again, then .bak is used (never {})
{
  const f = fresh();
  put(f, '{"n":2}');
  put(f + '.bak', '{"n":1}');
  const real = fs.readFileSync;
  let fails = 1;
  fs.readFileSync = (p, ...a) => { if (p === f && fails-- > 0) { const e = new Error('busy'); e.code = 'EBUSY'; throw e; } return real(p, ...a); };
  try { ok(SF.read(f).n === 2, 'locked read: retried'); } finally { fs.readFileSync = real; }
  fs.readFileSync = (p, ...a) => { if (p === f) { const e = new Error('busy'); e.code = 'EBUSY'; throw e; } return real(p, ...a); };
  const log = logger();
  try { ok(SF.read(f, { log }).n === 1 && fs.existsSync(f), 'locked for good: .bak used, file left alone'); } finally { fs.readFileSync = real; }
}

// 9. B2: a save keeps a key edited by hand since the last save, unless this server changed that key too
{
  const f = fresh();
  put(f, JSON.stringify({ view: 'cards', restoreIdle: false, usageAlertPct: 10, prefsSync: { at: 1 }, names: { a: 'A' } }, null, 2));
  let saved = SF.read(f), base = SF.snapshot(saved);
  // the server's flush: { ...saved, and what it computes }
  const flush = (mine) => {
    const { out, base: next } = SF.merge({ ...saved, ...mine }, base, SF.peek(f));
    SF.write(f, out);
    base = next;
  };
  // hand edit while running: restoreIdle on, and a new key
  fs.writeFileSync(f, JSON.stringify({ ...json(f), restoreIdle: true, newSessionEffort: 'high' }, null, 2));
  flush({ view: 'map', names: { a: 'A' } });
  let d = json(f);
  ok(d.view === 'map', 'B2: the server\'s change is saved');
  ok(d.restoreIdle === true && d.newSessionEffort === 'high', 'B2: the hand edit is kept');
  ok(d.usageAlertPct === 10 && d.names.a === 'A', 'B2: untouched keys stay');
  // a second hand edit, a flush with nothing new from the server: still kept
  fs.writeFileSync(f, JSON.stringify({ ...json(f), restoreIdle: false, usageAlertPct: 20 }, null, 2));
  flush({ view: 'map', names: { a: 'A' } });
  d = json(f);
  ok(d.restoreIdle === false && d.usageAlertPct === 20, 'B2: a later hand edit is kept too');
  // the server changes a key the hand also changed: the server's wins; a key the server dropped goes
  fs.writeFileSync(f, JSON.stringify({ ...json(f), names: { a: 'hand' } }, null, 2));
  delete saved.prefsSync;
  flush({ view: 'map', names: { a: 'A', b: 'B' } });
  d = json(f);
  ok(d.names.b === 'B' && d.names.a === 'A', 'B2: the server\'s change to a key wins over the hand\'s');
  ok(!('prefsSync' in d), 'B2: a key the server deleted is gone');
  ok(d.usageAlertPct === 20 && d.view === 'map', 'B2: the rest as they were');
  // a key removed by hand (and not changed here) stays removed
  const { newSessionEffort, ...rest } = json(f);
  fs.writeFileSync(f, JSON.stringify(rest, null, 2));
  flush({ view: 'map', names: { a: 'A', b: 'B' } });
  ok(newSessionEffort === 'high' && !('newSessionEffort' in json(f)), 'B2: a key removed by hand stays removed');
  // the file gone or broken: ours is written whole
  const m = SF.merge({ a: 1 }, base, null);
  ok(JSON.stringify(m.out) === '{"a":1}', 'merge: no disk, ours');
  // what was loaded counts as the base: a mutation of saved after the snapshot is the server's change
  saved = { parity: [1] };
  base = SF.snapshot(saved);
  saved.parity = [2];
  ok(SF.merge({ ...saved }, base, { parity: [1] }).out.parity[0] === 2, 'merge: the snapshot is a copy');
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
