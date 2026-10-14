#!/usr/bin/env node
// Tests desktop/launchers.js: repair() on a temp Start menu, Startup and User Pinned folder, with fake shortcut
// read/write (Electron's are Windows-only), so no real shortcut is touched. Prints PASS/FAIL per check, exits 1 on any.
//   node scripts/launchers-test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { repair, ours } = require('../desktop/launchers.js');

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`PASS: ${name}`);
  else { failures++; console.log(`FAIL: ${name}${detail ? ` (${detail})` : ''}`); }
};

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'launchers-test-'));
const dirs = { programs: path.join(ROOT, 'Programs'), startup: path.join(ROOT, 'Programs', 'Startup'), pinned: path.join(ROOT, 'User Pinned') };
const repo = 'Z:\\Github\\fleet-view';
const WSCRIPT = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');
const ARGS = `//nologo "${path.join(repo, 'fleet-view.vbs')}"`;

// fake shortcuts: the .lnk file holds its fields as JSON
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const writes = [];
const write = (f, op, o) => {
  writes.push({ f, op });
  const was = op === 'update' ? read(f) : {};
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ ...was, ...o }));
  return true;
};
const put = (f, l) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(l)); };

const start = path.join(dirs.programs, 'Fleet View.lnk');
const implicit = path.join(dirs.pinned, 'ImplicitAppShortcuts', 'f29102ba44c986a1', 'Fleet View.lnk');
const other = path.join(dirs.pinned, 'TaskBar', 'Slack.lnk');
const signin = path.join(dirs.startup, 'Fleet View.lnk');

// the state found on the PC: Start entry at Fleet View.exe, a taskbar pin running fleet-view.cmd through cmd.exe
put(start, { target: 'Z:\\Github\\fleet-view\\desktop\\node_modules\\electron\\dist\\Fleet View.exe', args: '', appUserModelId: 'FleetView' });
put(implicit, { target: 'C:\\Windows\\System32\\cmd.exe', args: '/c "Z:\\Github\\fleet-view\\fleet-view.cmd"', appUserModelId: 'FleetView', pinnedNote: 'kept' });
put(other, { target: 'C:\\Slack\\slack.exe', args: '', appUserModelId: 'com.squirrel.slack.slack' });
put(signin, { target: WSCRIPT, args: ARGS });

const logs = [];
const changed = repair({ repo, read, write, log: (m) => logs.push(m), dirs });
check('fixes the Start entry, the cmd.exe pin and the sign-in shortcut (no app id)', changed.length === 3 && changed.includes(start) && changed.includes(implicit) && changed.includes(signin), changed.join(', '));
check('leaves other apps\' pins alone', !changed.includes(other) && read(other).target === 'C:\\Slack\\slack.exe');
for (const f of [start, implicit, signin]) {
  const l = read(f);
  check(`${path.basename(path.dirname(f))}\\${path.basename(f)} runs wscript fleet-view.vbs as FleetView`, l.target === WSCRIPT && l.args === ARGS && l.appUserModelId === 'FleetView' && l.cwd === repo, JSON.stringify(l));
}
check('updates existing shortcuts in place (keeps their other fields)', read(implicit).pinnedNote === 'kept' && writes.every((w) => w.op === 'update'));
check('logs each change with what it was', logs.length === 3 && logs.some((m) => m.includes('cmd.exe')), logs.join(' | '));

writes.length = 0;
check('a second run changes nothing', repair({ repo, read, write, dirs }).length === 0 && writes.length === 0);

fs.unlinkSync(start);
fs.unlinkSync(signin);
const again = repair({ repo, read, write, dirs });
check('makes a missing Start entry, never a missing sign-in shortcut', again.length === 1 && again[0] === start && writes[0].op === 'create' && !fs.existsSync(signin));

check('ours(): matches by app id, launcher or exe, not others', ours({ appUserModelId: 'FleetView' }) && ours({ target: 'cmd.exe', args: '/c "D:\\x\\fleet-view.cmd"' })
  && ours({ target: 'Z:\\Github\\fleet-view\\desktop\\node_modules\\electron\\dist\\electron.exe' }) && !ours({ target: 'C:\\Other\\electron.exe' }) && !ours(null));

const failing = repair({ repo, read, write: () => false, log: (m) => logs.push(m), dirs: { ...dirs, programs: path.join(ROOT, 'none') } });
check('a refused write is logged, not thrown', failing.length === 0 && logs[logs.length - 1].startsWith('launcher: could not fix'));

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
