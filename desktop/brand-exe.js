'use strict';
// Windows: Task Manager names a process from its exe's file description and draws its icon, so Fleet View's window,
// server and session host (all desktop\node_modules\electron\dist\electron.exe) show up as "Electron" with
// Electron's logo. This makes "Fleet View.exe" beside it: a copy of electron.exe with Fleet View's name and icon
// written into it by rcedit (Electron's own tool, fetched once into <dataDir>\tools and checked against its SHA-256).
// platform.js brandedElectron() picks the copy up from then on: the next window, the server it starts and the next
// session host run as Fleet View. Nothing running is touched; the copy goes in under a temp name and is renamed.
//   prepare(desktopDir, log)   Promise<string|null>: the branded exe (made now or already there), null when it
//                              could not be made (logged; electron.exe keeps working as before)
//   node desktop/brand-exe.js  the same from the command line (install.ps1 runs it after npm ci)
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execFile } = require('child_process');
const P = require(path.join(__dirname, '..', 'platform.js'));

const RCEDIT = {
  url: 'https://github.com/electron/rcedit/releases/download/v2.0.0/rcedit-x64.exe',
  file: 'rcedit-x64-2.0.0.exe',
  sha256: '3e7801db1a5edbec91b49a24a094aad776cb4515488ea5a4ca2289c400eade2a',
};
const ICON = path.join(__dirname, 'fleet-view.ico');

const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

// GET url into file, following GitHub's redirects to its download host
function download(url, file, hops = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'fleet-view' }, timeout: 60000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 5) {
        res.resume();
        return download(new URL(res.headers.location, url).toString(), file, hops + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} from ${url}`)); }
      const out = fs.createWriteStream(file);
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve()));
      out.on('error', reject);
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('download timed out')); });
  });
}

async function rcedit() {
  const dir = path.join(P.dataDir(), 'tools');
  const exe = path.join(dir, RCEDIT.file);
  if (fs.existsSync(exe) && sha256(exe) === RCEDIT.sha256) return exe;
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${exe}.download`;
  await download(RCEDIT.url, tmp);
  const got = sha256(tmp);
  if (got !== RCEDIT.sha256) { fs.rmSync(tmp, { force: true }); throw new Error(`rcedit's SHA-256 is ${got}, not the expected one`); }
  fs.renameSync(tmp, exe);
  return exe;
}

const run = (exe, args) => new Promise((resolve, reject) => {
  execFile(exe, args, { windowsHide: true, timeout: 60000 }, (err, out, errOut) => (err ? reject(new Error(String(errOut || err.message).trim())) : resolve()));
});

async function prepare(desktopDir, log = () => {}) {
  if (!P.isWin) return null;
  const src = path.join(desktopDir, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (!fs.existsSync(src)) return null;
  const ready = P.brandedElectron(src);
  if (ready !== src) return ready;
  const dest = path.join(path.dirname(src), P.BRANDED_EXE);
  const tmp = `${dest}.tmp`;
  try {
    const stamp = P.electronStamp(src);
    const tool = await rcedit();
    fs.copyFileSync(src, tmp);
    await run(tool, [tmp,
      '--set-version-string', 'FileDescription', 'Fleet View',
      '--set-version-string', 'ProductName', 'Fleet View',
      '--set-version-string', 'OriginalFilename', P.BRANDED_EXE,
      '--set-icon', ICON]);
    fs.rmSync(`${dest}.stamp`, { force: true });
    fs.renameSync(tmp, dest); // fails while a stale copy still runs: electron.exe is used until it can go in
    fs.writeFileSync(`${dest}.stamp`, stamp);
    log(`brand: made ${P.BRANDED_EXE} (Fleet View's name and icon in Task Manager); the next window and session host run it`);
    return dest;
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    log(`brand: could not make ${P.BRANDED_EXE} (${e.message}); electron.exe runs as before`);
    return null;
  }
}

module.exports = { prepare, RCEDIT };

if (require.main === module) {
  prepare(__dirname, (m) => console.log(m)).then((exe) => {
    if (exe) console.log(exe);
    process.exit(exe || !P.isWin ? 0 : 1);
  });
}
