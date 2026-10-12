// sync-work-stay-test.js: a check of sync-work.js's stay option: a big untracked .blend1 over the cap is refused without it, left out
// with it (and the rest still packed), and putAway with it in keep leaves it in place. Run: node scripts/sync-work-stay-test.js (exit 0 = all pass)
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const W = require(path.join(__dirname, '..', 'sync-work.js'));
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'stay-check-'));
const repo = path.join(T, 'detailforge-web');
const g = (...a) => cp.execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
let fail = 0;
const ok = (c, n) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${n}`); if (!c) fail++; };
(async () => {
  try {
    fs.mkdirSync(repo, { recursive: true });
    g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
    g('remote', 'add', 'origin', 'https://github.com/GLODUSK/detailforge-web.git');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n'); g('add', '.'); g('commit', '-qm', 'one');
    g('update-ref', 'refs/remotes/origin/main', 'HEAD');
    const dir = path.join(repo, 'assets', 'vehicles', 'template', 'coupe', '0003');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'coupe.blend1'), Buffer.alloc(300 * 1024, 7));
    fs.writeFileSync(path.join(repo, 'web.ts'), 'export {}\n');
    const cap = 100 * 1024;
    let refused = null;
    try { await W.pack(repo, { home: T, cap }); } catch (e) { refused = e; }
    ok(refused && refused.code === 'refused' && /coupe\.blend1/.test(refused.message), `no stay: refused over the cap (${refused && refused.message})`);
    const stay = (rel) => /(^|\/)assets\/vehicles\//.test(rel) || /\.blend\d*$/.test(rel);
    const p = await W.pack(repo, { home: T, cap, stay });
    ok(p.manifest.untracked.map((e) => e.path).join() === 'web.ts', `stay: only web.ts packed (${p.manifest.untracked.map((e) => e.path)})`);
    ok(JSON.stringify(p.stayed) === JSON.stringify(['assets/vehicles/template/coupe/0003/coupe.blend1']), `stay: stayed lists the blend1 (${p.stayed})`);
    ok(p.manifest.notes.some((n) => /stays on this machine/.test(n)) && !('stayed' in p.manifest), 'stay: a note, and stayed is not in the manifest');
    const sha = await W.putAway(repo, 'fleet-view: moved (test)', { keep: p.stayed });
    ok(!!sha && fs.existsSync(path.join(dir, 'coupe.blend1')) && !fs.existsSync(path.join(repo, 'web.ts')), 'putAway: web.ts put away, the blend1 left in place');
  } finally { fs.rmSync(T, { recursive: true, force: true }); }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
