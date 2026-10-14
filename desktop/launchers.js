'use strict';
// Windows: every shortcut that starts Fleet View from the shell (the Start menu entry, a taskbar pin, the sign-in
// shortcut) must run fleet-view.vbs through wscript, which shows no window. Windows makes and rewrites some of these
// by itself: pinning the running window to the taskbar saved its own shortcut under User Pinned\ImplicitAppShortcuts
// as "cmd.exe /c fleet-view.cmd" (a console flashed up on every click), and the Start menu entry was found pointing at
// Fleet View.exe with no arguments (Electron's default app, not Fleet View). At each start the window puts every such
// shortcut back to wscript + fleet-view.vbs, with Fleet View's icon and app id (FleetView, so it groups with the
// window), and logs each one it changed.
//   repair({ repo, read, write, log, dirs? })   the shortcuts it changed (paths). read/write are Electron's
//                                               shell.readShortcutLink/writeShortcutLink (tests pass fakes).
const fs = require('fs');
const path = require('path');

const APP_ID = 'FleetView';
const LNK = 'Fleet View.lnk';

function defaultDirs() {
  const roaming = process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming');
  const programs = path.join(roaming, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  return { programs, startup: path.join(programs, 'Startup'), pinned: path.join(roaming, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned') };
}

// the .lnk files under dir, a few levels deep (User Pinned\TaskBar, User Pinned\ImplicitAppShortcuts\<hash>)
function lnksUnder(dir, depth = 3) {
  const out = [];
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth > 0) out.push(...lnksUnder(p, depth - 1));
    else if (e.isFile() && /\.lnk$/i.test(e.name)) out.push(p);
  }
  return out;
}

// a shortcut that starts Fleet View some other way: its app id, or a target or arguments naming our launchers or exe
function ours(l) {
  if (!l) return false;
  if (l.appUserModelId === APP_ID) return true;
  return /fleet-view\.(cmd|vbs)|[\\/]fleet-view[\\/]desktop[\\/]node_modules[\\/]electron[\\/]/i.test(`${l.target || ''} ${l.args || ''}`);
}

function repair({ repo, read, write, log = () => {}, dirs = defaultDirs() }) {
  const want = {
    target: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe'),
    args: `//nologo "${path.join(repo, 'fleet-view.vbs')}"`,
    cwd: repo,
    icon: path.join(repo, 'desktop', 'fleet-view.ico'),
    iconIndex: 0,
    appUserModelId: APP_ID,
    description: 'Fleet View: live view of every Claude Code session',
  };
  const right = (l) => l && String(l.target).toLowerCase() === want.target.toLowerCase() && l.args === want.args && l.appUserModelId === APP_ID;
  const changed = [];
  const fix = (file, l, why) => {
    try {
      if (!write(file, l ? 'update' : 'create', want)) throw new Error('Windows refused the write');
      changed.push(file);
      log(`launcher: ${why} ${file} (was ${l ? `${l.target || '?'} ${l.args || ''}`.trim() : 'missing'}); it now runs fleet-view.vbs`);
    } catch (e) { log(`launcher: could not fix ${file}: ${e.message}`); }
  };
  const look = (file) => { try { return read(file); } catch { return null; } };

  // the Start menu entry: made when missing, put right when it runs anything else
  const start = path.join(dirs.programs, LNK);
  const sl = fs.existsSync(start) ? look(start) : null;
  if (!right(sl)) fix(start, sl, sl ? 'repaired the Start menu shortcut' : 'made the Start menu shortcut');
  // the sign-in shortcut (fleet-view --install-startup) and taskbar pins: only ones already there
  for (const file of [path.join(dirs.startup, LNK), ...lnksUnder(dirs.pinned)]) {
    if (!fs.existsSync(file)) continue;
    const l = look(file);
    if (ours(l) && !right(l)) fix(file, l, 'repaired the shortcut');
  }
  return changed;
}

module.exports = { repair, ours, APP_ID };
