// version-test.js: version.js's version number, worked out synchronously (versionAt: scripts, `node version.js`) and
// without blocking (versionAtAsync: the server's start and its update check, whose four synchronous git calls held
// the event loop up to 4.4 s on 2026-10-17). On a temp repo: main's count of commits since version.json changed, at
// HEAD and at another ref; the share repo's full number with no git; nothing without version.json; both ways agree on
// each. Then currentAsync/refreshAsync fill current()'s answer, and the newest refresh asked for wins.
// Run: node scripts/version-test.js (exit 0 = all pass)
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const V = require(path.join(__dirname, '..', 'version.js'));

let n = 0;
const ok = (what) => { n++; console.log(`ok ${n} - ${what}`); };
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-version-'));
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

(async () => {
  try {
    const R = path.join(T, 'repo');
    fs.mkdirSync(R);
    git(R, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(R, 'version.json'), '{ "version": "1.0" }\n');
    git(R, 'add', '-A');
    git(R, 'commit', '-q', '-m', 'version 1.0');
    for (let i = 1; i <= 3; i++) { fs.writeFileSync(path.join(R, `f${i}.txt`), `${i}`); git(R, 'add', '-A'); git(R, 'commit', '-q', '-m', `change ${i}`); }
    const head = git(R, 'rev-parse', 'HEAD');
    const sync = V.versionAt(R), async1 = await V.versionAtAsync(R);
    assert.deepStrictEqual(sync, { version: '1.0.3', commit: head, exact: true });
    assert.deepStrictEqual(async1, sync);
    const back = git(R, 'rev-parse', 'HEAD~2');
    assert.deepStrictEqual(await V.versionAtAsync(R, 'HEAD~2'), { version: '1.0.1', commit: back, exact: true });
    assert.deepStrictEqual(V.versionAt(R, 'HEAD~2'), await V.versionAtAsync(R, 'HEAD~2'));
    ok(`main: commits since version.json changed, at HEAD (${sync.version}) and at another ref, the same both ways`);

    // the share repo's copy: full already, no git needed
    const S = path.join(T, 'share');
    fs.mkdirSync(S);
    fs.writeFileSync(path.join(S, 'version.json'), `\uFEFF{ "version": "1.0.42", "commit": "${'a'.repeat(40)}" }`);
    assert.deepStrictEqual(await V.versionAtAsync(S), { version: '1.0.42', commit: 'a'.repeat(40), exact: true });
    assert.deepStrictEqual(V.versionAt(S), await V.versionAtAsync(S));
    // nothing to go on: no version.json, a bad one, a ref git does not know
    const E = path.join(T, 'empty');
    fs.mkdirSync(E);
    const none = { version: '', commit: '', exact: false };
    assert.deepStrictEqual(await V.versionAtAsync(E), none);
    fs.writeFileSync(path.join(E, 'version.json'), 'not json');
    assert.deepStrictEqual(await V.versionAtAsync(E), none);
    assert.deepStrictEqual(await V.versionAtAsync(R, 'no-such-ref'), none);
    assert.deepStrictEqual(V.versionAt(R, 'no-such-ref'), none);
    ok('the share repo\'s full number without git; nothing without version.json, with a bad one, or at an unknown ref');

    // this checkout: currentAsync fills current(), and they agree with versionAt
    const here = V.versionAt(path.join(__dirname, '..'));
    const cur = await V.currentAsync();
    assert.deepStrictEqual(cur, here);
    assert.strictEqual(V.current(), cur, 'current() answers from what currentAsync worked out');
    const [x, y] = await Promise.all([V.refreshAsync(), V.refreshAsync()]);
    assert.deepStrictEqual([x, y], [here, here]);
    assert.deepStrictEqual(V.current(), here);
    ok(`this checkout: currentAsync and refreshAsync give current() its answer (${here.version || '(no version)'})`);
    console.log(`version-test: ${n} passed`);
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    fs.rmSync(T, { recursive: true, force: true });
  }
})();
