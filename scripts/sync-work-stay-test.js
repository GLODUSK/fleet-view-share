// sync-work-stay-test.js: a check of sync-work.js's stay option (the stays-on rules' globs, host-rules.js): a big
// untracked .blend1 over the cap is refused without it; with it, a web chat's pack leaves out every file the globs name,
// tracked or not, staged or not (a path with spaces too, and 150 untracked .blend files: no 100-file cap), the other
// side lays it down and verifies, and putAway leaves every one of them in place. Then sync-carry.js: a chat in a linked
// worktree asks for the main checkout's globs (its repo), and a chat pinned here gets no turn's snapshot.
// Run: node scripts/sync-work-stay-test.js (exit 0 = all pass)
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const W = require(path.join(__dirname, '..', 'sync-work.js'));
const CARRY = require(path.join(__dirname, '..', 'sync-carry.js'));
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stay-check-')));
const repo = path.join(T, 'detailforge-web');
const g = (dir, ...a) => cp.execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();
const w = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const GLOBS = ['assets/vehicles/**', '**/*.blend', '**/*.blend[0-9]*']; // host-rules.js DEFAULT_RULES' configurator-3d
let fail = 0, pass = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.log(`FAIL ${n}`); } };
(async () => {
  try {
    fs.mkdirSync(repo, { recursive: true });
    g(repo, 'init', '-q', '-b', 'main'); g(repo, 'config', 'user.email', 't@t'); g(repo, 'config', 'user.name', 't'); g(repo, 'config', 'core.autocrlf', 'false');
    g(repo, 'remote', 'add', 'origin', 'https://github.com/GLODUSK/detailforge-web.git');
    const veh = path.join(repo, 'assets', 'vehicles');
    w(path.join(repo, 'a.txt'), 'a\n');
    w(path.join(repo, 'src', 'app.ts'), 'export const a = 1;\n');
    w(path.join(veh, '0001', 'manifest.json'), '{"v":1}\n');
    w(path.join(veh, '0002 with space', 'm.json'), '{"v":1}\n');
    w(path.join(repo, 'models', 'tracked.blend'), 'blend v1\n');
    g(repo, 'add', '.'); g(repo, 'commit', '-qm', 'one');
    g(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    const head = g(repo, 'rev-parse', 'HEAD');

    // the Blender chat's work in the shared checkout: tracked edits (unstaged and staged, one in a folder with a space),
    // a staged new file, a tracked .blend changed, a big backup and 150 untracked .blend files outside assets/
    w(path.join(veh, '0001', 'manifest.json'), '{"v":2}\n');
    w(path.join(veh, '0002 with space', 'm.json'), '{"v":2}\n'); g(repo, 'add', 'assets/vehicles/0002 with space/m.json');
    w(path.join(veh, 'new.glb'), 'glb\n'); g(repo, 'add', 'assets/vehicles/new.glb');
    w(path.join(repo, 'models', 'tracked.blend'), 'blend v2\n');
    w(path.join(veh, 'template', 'coupe', '0003', 'coupe.blend1'), Buffer.alloc(300 * 1024, 7));
    for (let i = 0; i < 150; i++) w(path.join(repo, 'models', 'kit', `part ${String(i).padStart(3, '0')}.blend`), `part ${i}\n`);
    // the web chat's work: a tracked edit, a staged one, and a new file
    w(path.join(repo, 'src', 'app.ts'), 'export const a = 2;\n');
    w(path.join(repo, 'a.txt'), 'a, staged\n'); g(repo, 'add', 'a.txt');
    w(path.join(repo, 'web.ts'), 'export {}\n');

    const cap = 100 * 1024;
    let refused = null;
    try { await W.pack(repo, { home: T, cap }); } catch (e) { refused = e; }
    ok(refused && refused.code === 'refused' && /coupe\.blend1/.test(refused.message), `no stay: refused over the cap (${refused && refused.message})`);

    const p = await W.pack(repo, { home: T, cap, stay: GLOBS });
    const m = p.manifest;
    ok(m.untracked.map((e) => e.path).join() === 'web.ts', `stay: only web.ts packed of the untracked (${m.untracked.map((e) => e.path)})`);
    const diffs = [m.staged, m.unstaged].filter(Boolean).map((h) => p.blobs.get(h).toString('utf8')).join('\n');
    ok(/src\/app\.ts/.test(diffs) && /a\.txt/.test(diffs), 'stay: the web chat\'s tracked edits are carried');
    ok(!/assets\/vehicles|\.blend/.test(diffs), 'stay: no tracked edit under assets/vehicles, nor a .blend, in the diffs');
    ok(m.summary.files === 3, `stay: 3 files counted (a.txt, src/app.ts, web.ts): ${m.summary.files}`);
    ok(Array.isArray(p.stayed) && p.stayed.length === 100 && p.stayed.includes('assets/vehicles/0002 with space/m.json'), `stay: stayed names the first 100 (${p.stayed && p.stayed.length})`);
    ok(m.notes.some((n) => /^not carried \(it stays on this machine\): 155 files/.test(n)) && !('stayed' in m), `stay: one note for all 155, and stayed is not in the manifest (${m.notes})`);

    // the other machine lays it down and verifies it (the trees leave the staying files as HEAD has them)
    const mac = path.join(T, 'mac', 'detailforge-web');
    cp.execFileSync('git', ['-c', 'core.autocrlf=false', 'clone', '-q', repo, mac]);
    g(mac, 'config', 'core.autocrlf', 'false');
    g(mac, 'remote', 'set-url', 'origin', 'https://github.com/GLODUSK/detailforge-web.git');
    g(mac, 'update-ref', 'refs/remotes/origin/main', head);
    let laid = null, why = null;
    try { laid = await W.unpack(m, p.blobs, { root: mac, fetch: false, home: T }); } catch (e) { why = e; }
    ok(!!laid, `unpack: laid down and verified on the other side (${why && why.message})`);
    if (laid) {
      ok(read(path.join(laid.into, 'src', 'app.ts')) === 'export const a = 2;\n' && read(path.join(laid.into, 'web.ts')) === 'export {}\n', 'unpack: the web work is there');
      ok(read(path.join(laid.into, 'assets', 'vehicles', '0001', 'manifest.json')) === '{"v":1}\n' && read(path.join(laid.into, 'models', 'tracked.blend')) === 'blend v1\n'
        && !fs.existsSync(path.join(laid.into, 'assets', 'vehicles', 'new.glb')), 'unpack: the staying files are as HEAD has them');
    }

    // the put-away after the move: the web work goes into the stash, every staying file stays as it was
    const sha = await W.putAway(repo, 'fleet-view: moved (test)', { keep: [], stay: GLOBS });
    ok(!!sha && !fs.existsSync(path.join(repo, 'web.ts')) && read(path.join(repo, 'src', 'app.ts')) === 'export const a = 1;\n' && read(path.join(repo, 'a.txt')) === 'a\n', 'putAway: the web work put away');
    const kitLeft = fs.readdirSync(path.join(repo, 'models', 'kit')).length;
    ok(kitLeft === 150 && fs.existsSync(path.join(veh, 'template', 'coupe', '0003', 'coupe.blend1')), `putAway: all 150 .blend files and the blend1 left in place (${kitLeft})`);
    ok(read(path.join(veh, '0001', 'manifest.json')) === '{"v":2}\n' && read(path.join(veh, '0002 with space', 'm.json')) === '{"v":2}\n' && read(path.join(repo, 'models', 'tracked.blend')) === 'blend v2\n',
      'putAway: the tracked edits that stay are left in place');
    const staged = g(repo, 'diff', '--cached', '--name-only');
    ok(staged.includes('assets/vehicles/new.glb') && staged.includes('assets/vehicles/0002 with space/m.json') && !staged.includes('a.txt'), `putAway: what stays is still staged (${staged})`);

    // sync-carry.js: a chat in a linked worktree goes by its repo (the main checkout), and a chat kept here gets no snapshot
    const wt = path.join(repo, '.claude', 'worktrees', 'blender');
    g(repo, 'worktree', 'add', '-q', '-b', 'blender', wt);
    w(path.join(wt, 'assets', 'vehicles', '0001', 'manifest.json'), '{"v":3}\n');
    const log = path.join(T, 'log.jsonl');
    fs.writeFileSync(log, `${JSON.stringify({ type: 'user', cwd: wt })}\n`);
    const asked = [], packs = [];
    let inspects = 0;
    const work = { ...W, inspect: (...a) => { inspects++; return W.inspect(...a); }, pack: async (cwd, o) => { packs.push(o); throw Object.assign(new Error('stop here'), { code: 'refused' }); } };
    const pinned = 'aaaaaaaa-0000-4000-8000-000000000001';
    const carry = CARRY.createCarry({ api: { rest: async () => [] }, key: crypto.randomBytes(32), dataDir: T, home: T, work,
      stays: (root) => { asked.push(root); return GLOBS; }, pinnedHere: (id) => id === pinned });
    const r = await carry.packOut({ id: 'aaaaaaaa-0000-4000-8000-000000000002', file: log, canCarry: true, noWork: true, list: [] });
    ok(r.work && r.work.refused === 'stop here', 'carry: packOut reached the pack');
    ok(asked.length === 1 && path.resolve(asked[0]) === path.resolve(repo), `carry: a worktree's globs are asked for by its main checkout (${asked[0]})`);
    ok(packs.length === 1 && JSON.stringify(packs[0].stay) === JSON.stringify(GLOBS), 'carry: the pack got the globs');
    const n0 = inspects;
    ok((await carry.snapshot({ id: pinned, file: log })) === null && inspects === n0, 'carry: a chat kept here gets no snapshot (nothing looked at)');
    g(repo, 'worktree', 'remove', '--force', wt);
  } finally { fs.rmSync(T, { recursive: true, force: true }); }
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
