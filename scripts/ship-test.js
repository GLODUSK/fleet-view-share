#!/usr/bin/env node
// Tests scripts/ship.js: its pure parts (classify, the log parsers, the window finder, the plan), then whole runs of
// ship() against a fake world (gh, git, the merge lane, server.log, the window, share-publish.log), so nothing real
// is merged, restarted or touched. Prints PASS/FAIL per check and exits 1 on any failure. Takes under a second.
//   node scripts/ship-test.js
'use strict';
const path = require('path');
const crypto = require('crypto');
const S = require('./ship.js');

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`PASS: ${name}`);
  else { failures++; console.log(`FAIL: ${name}${detail ? ` (${detail})` : ''}`); }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------- parseArgs ----------
check('args: a PR number', same(S.parseArgs(['492']), { pr: 492, dry: false, noHost: false }));
check('args: --dry-run --no-host, #N', same(S.parseArgs(['--dry-run', '#7', '--no-host']), { pr: 7, dry: true, noHost: true }));
check('args: no PR is a usage error', S.parseArgs(['--dry-run']) === null);
check('args: an unknown flag is a usage error', S.parseArgs(['5', '--admin']) === null);

// ---------- mainDir ----------
check('mainDir: FV_MAIN wins', S.mainDir({ env: { FV_MAIN: 'X:\\fv' }, platform: 'win32' }) === 'X:\\fv');
check('mainDir: the PC place', S.mainDir({ env: {}, platform: 'win32' }) === 'Z:\\Github\\fleet-view');
check('mainDir: the Mac place', S.mainDir({ env: {}, platform: 'darwin', home: '/Users/h' }) === path.join('/Users/h', 'code', 'fleet-view'));
check('mainDir: else the shared .git\'s folder', S.mainDir({ env: {}, platform: 'win32', exists: () => false, commonDir: 'D:/src/fleet-view/.git' }) === 'D:/src/fleet-view');

// ---------- classify ----------
{
  const c = S.classify(['fleet-view.js', 'web/app.js', 'handoff.js', 'desktop/host.js', 'desktop/main.js', 'desktop/terms-test.js',
    'CLAUDE.md', 'scripts/fv.js', 'phone/App.tsx', 'desktop/package-lock.json'], 'win32');
  check('classify PC: server', same(c.server, ['fleet-view.js', 'web/app.js', 'handoff.js']), JSON.stringify(c.server));
  check('classify PC: host (host.js and handoff.js)', same(c.host, ['handoff.js', 'desktop/host.js']), JSON.stringify(c.host));
  check('classify PC: window (not tests, packages included)', same(c.window, ['desktop/main.js', 'desktop/package-lock.json']), JSON.stringify(c.window));
  check('classify PC: notes for phone/ and desktop packages', c.notes.length === 2 && /phone/.test(c.notes[0]) && /npm ci/.test(c.notes[1]), JSON.stringify(c.notes));
  const m = S.classify(['desktop/package-lock.json', 'desktop/icon.js', 'scripts/mac-app.sh', 'desktop/preload.js'], 'darwin');
  check('classify Mac: app files install.sh rebuilds for', same(m.app, ['desktop/package-lock.json', 'desktop/icon.js', 'scripts/mac-app.sh']) && same(m.window, ['desktop/preload.js']) && !m.notes.length, JSON.stringify(m));
  const none = S.classify(['scripts/merge-lane.js', 'docs/x.md', 'README.md'], 'win32');
  check('classify: scripts and docs restart nothing', !none.server.length && !none.window.length && !none.host.length);
  const plat = S.classify(['platform.js'], 'win32');
  check('classify: platform.js restarts the server, with a note that desktop/ loads it too', same(plat.server, ['platform.js']) && !plat.host.length && /desktop\//.test(plat.notes[0] || ''), JSON.stringify(plat));
}

// ---------- parseStart ----------
{
  const log = [
    '2026-10-14 22:33:45.696 [node 54044] start: port 4777, version 1.0.320 (574f6fe), file 2026-10-15 05:21:17 UTC, node v24.21.0, --no-open, restarted after an update (exit 75)',
    '2026-10-14 22:34:00.000 [node 54044] sync-carry: something',
    '2026-10-14 22:34:21.327 [node 59252] start: port 4777, version 1.0.321 (d6613d3), file 2026-10-15 05:33:55 UTC, node v24.21.0, --no-open',
    '2026-10-14 22:35:00.000 [node 59252] other line'].join('\r\n');
  const s = S.parseStart(log);
  check('parseStart: the newest start line', s && s.port === 4777 && s.version === '1.0.321' && s.commit === 'd6613d3', JSON.stringify(s));
  const h = S.parseStart('x start: port 4791, version abc1234, file 2026-10-15 05:33:55 UTC, node v24');
  check('parseStart: a version that is only a hash', h && h.commit === 'abc1234' && h.version === '', JSON.stringify(h));
  const u = S.parseStart('x start: port 4777, version unknown, node v24');
  check('parseStart: unknown version, no commit', u && u.commit === '', JSON.stringify(u));
  check('parseStart: none', S.parseStart('nothing here') === null);

// ---------- parseStuck (#574) ----------
{
  const log = [
    '2026-10-16 21:33:01.000 [node 20820] start: port 4777, version 1.0.387 (29eccaf), node v24; loaded in 120 ms',
    '2026-10-17 01:06:46.145 [node 20820] fleet-view.js changed on disk: reloading (exit 75)',
    '2026-10-17 01:06:46.153 [node 20820] sync: stopped (stopped)',
    '2026-10-17 01:06:46.154 [node 20820] stop: exit code 75 (update)',
  ].join('\r\n');
  const s = S.parseStuck(log);
  check('parseStuck: the stop line after the last start', s && s.pid === 20820 && s.code === 75 && s.at === new Date(2026, 9, 17, 1, 6, 46, 154).getTime(), JSON.stringify(s));
  check('parseStuck: a start after the stop is no stuck server', S.parseStuck(`${log}\n2026-10-17 01:08:30.636 [node 32916] start: port 4777, version 1.0.389 (f5e5426)`) === null);
  check('parseStuck: no stop line', S.parseStuck(log.split('\r\n')[0]) === null && S.parseStuck('') === null);
}
}

// ---------- parsePublish / publishOk ----------
{
  const log = [
    '--- 2026-10-14 21:23:09 after pull to 52c26d2',
    'origin/main 1.0.317 (52c26d2): 245 files to publish to GLODUSK/fleet-view-share',
    'the share repo already has this version (1.0.316): main 1.0.317 (52c26d2) changed only files that are not published',
    '--- 2026-10-14 22:33:42 after pull to d6613d3',
    'origin/main 1.0.321 (d6613d3): 254 files to publish to GLODUSK/fleet-view-share',
    'published: 1.0.321 (d6613d3) on GLODUSK/fleet-view-share',
    '--- 2026-10-14 22:40:00 after pull to aaaaaaa',
    'origin/main 1.0.322 (aaaaaaa): 254 files to publish to GLODUSK/fleet-view-share',
    '--- 2026-10-14 22:41:00 after pull to bbbbbbb',
    'refused: 1 thing that must not reach the public share repo GLODUSK/fleet-view-share:',
  ].join('\n');
  const full = (s) => s + '0'.repeat(40 - s.length);
  check('parsePublish: published', S.parsePublish(log, full('d6613d3')).state === 'published');
  check('parsePublish: already has it', S.parsePublish(log, full('52c26d2')).state === 'already');
  check('parsePublish: still running', S.parsePublish(log, full('aaaaaaa')).state === 'running');
  check('parsePublish: refused is a failure', S.parsePublish(log, full('bbbbbbb')).state === 'failed');
  check('parsePublish: no entry', S.parsePublish(log, full('ccccccc')).state === 'none');
  check('publishOk: published', S.publishOk('x\npublished: 1.0.3 (abc) on X\n').ok);
  check('publishOk: already', S.publishOk('the share repo already has this version').ok);
  check('publishOk: anything else is not', !S.publishOk('origin/main 1.0.3: 3 files\n').ok);
}

// ---------- findWindowPid ----------
{
  const main = 'Z:\\Github\\fleet-view';
  const list = [
    { pid: 10, command: '"Z:\\Github\\fleet-view\\.claude\\worktrees\\x\\desktop\\node_modules\\electron\\dist\\electron.exe" Z:\\Github\\fleet-view\\.claude\\worktrees\\x\\desktop --url=http://127.0.0.1:4791/' },
    { pid: 11, command: '"Z:\\Github\\fleet-view\\desktop\\node_modules\\electron\\dist\\Fleet View.exe" --type=renderer --url=x' },
    { pid: 59252, command: '"Z:\\Github\\fleet-view\\desktop\\node_modules\\electron\\dist\\Fleet View.exe" Z:\\Github\\fleet-view\\fleet-view.js --web --no-open --port 4777' },
    { pid: 61188, command: '"Z:\\Github\\fleet-view\\desktop\\node_modules\\electron\\dist\\Fleet View.exe" Z:\\Github\\fleet-view\\desktop --url=http://127.0.0.1:4777/?glass=1' },
  ];
  check('findWindowPid: the main checkout\'s window, not a worktree\'s, a child or the server', S.findWindowPid(list, main) === 61188);
  check('findWindowPid: electron.exe before branding, any case', S.findWindowPid([{ pid: 5, command: 'z:/github/fleet-view/desktop/node_modules/electron/dist/electron.exe z:/github/fleet-view/desktop --url=http://x' }], main) === 5);
  check('findWindowPid: none', S.findWindowPid(list.slice(0, 3), main) === null);
}

// ---------- hostHash, plan, note, summary ----------
check('hostHash: SHA-1, 12 hex', S.hostHash(Buffer.from('abc')) === crypto.createHash('sha1').update('abc').digest('hex').slice(0, 12));
{
  const cls = S.classify(['web/app.js', 'desktop/host.js', 'desktop/main.js'], 'win32');
  const plan = S.buildPlan({ pr: 9, cls, platform: 'win32', main: 'Z:\\fv', noHost: false, merged: false }).join('\n');
  check('plan PC: lane, merge, server, window, publish, host last', /merge lane/.test(plan) && /gh pr merge 9/.test(plan) && /server \(web\/app\.js\)/.test(plan)
    && /window \(desktop\/main\.js\)/.test(plan) && /share-publish\.log/.test(plan) && /last: host/.test(plan.split('\n').pop()), plan);
  const noHost = S.buildPlan({ pr: 9, cls, platform: 'win32', main: 'Z:\\fv', noHost: true, merged: true }).join('\n');
  check('plan PC --no-host, merged: no merge, host left to you', /merged already/.test(noHost) && /--no-host/.test(noHost), noHost);
  const mac = S.buildPlan({ pr: 9, cls: S.classify(['desktop/main.js', 'desktop/icon.js'], 'darwin'), platform: 'darwin', main: '/m', noHost: false, merged: false }).join('\n');
  check('plan Mac: install.sh last with what it restarts', /install\.sh --after-update/.test(mac) && /window, app rebuild/.test(mac) && /publish-share\.js/.test(mac), mac);
  check('laneNote', S.laneNote(9, cls, 'win32') === 'PR #9, ship.js: restarts server, window, host');
  {
    // the post-merge hook: the tracked copy, LF only, written when missing or different, left when the same
    const files = { [path.join('M', 'scripts', 'post-merge-hook.sh')]: Buffer.from('#!/bin/sh\r\nexit 0\r\n') };
    const io = { main: 'M', readBytes: (f) => files[f] || null, writeFile: (f, t) => { files[f] = Buffer.from(t); } };
    const hook = path.join('M', '.git', 'hooks', 'post-merge');
    check('hook: installed when missing, LF', /^installed/.test(S.ensureHook(io) || '') && files[hook].toString() === '#!/bin/sh\nexit 0\n');
    check('hook: the same one is left', S.ensureHook(io) === null);
    files[hook] = Buffer.from('#!/bin/sh\nold\n');
    check('hook: a different one is updated', /^updated/.test(S.ensureHook(io) || '') && files[hook].toString() === '#!/bin/sh\nexit 0\n');
    delete files[path.join('M', 'scripts', 'post-merge-hook.sh')];
    check('hook: no tracked copy, nothing done', S.ensureHook(io) === null);
  }
  check('summary', S.summary({ version: '1.0.322', short: 'abc1234', restarted: ['server', 'window'], published: true, hostNext: true })
    === '1.0.322 (abc1234) live and published; restarted: server, window; host restart next');
}

// ---------- whole runs against a fake world ----------
const MERGE = 'c'.repeat(40), BEFORE = 'b'.repeat(40), AFTER = MERGE;
function world(o = {}) {
  const platform = o.platform || 'win32';
  const calls = [], said = [];
  let t = 0, laneHeld = !!o.laneHeld, serverCommit = '0b0b0b0', windowPid = 100, windowAlive = true, head = o.alreadyPulled ? AFTER : BEFORE;
  let prState = o.prState || 'OPEN', publishLog = '', touched = false;
  const io = {
    platform, main: 'M', dataDir: 'D', node: 'node', who: 'tester',
    say: (s) => said.push(s),
    now: () => t,
    sleep: async (ms) => { t += ms; },
    exec(cmd, args) {
      const line = [cmd, ...args].join(' ');
      calls.push(line);
      const ok = (out = '') => ({ code: 0, out });
      if (/merge-lane\.js take/.test(line)) {
        if (laneHeld && !/--wait/.test(line)) return { code: 1, out: 'merge lane is held by other' };
        laneHeld = false;
        return ok('merge lane taken by tester');
      }
      if (/merge-lane\.js release/.test(line)) return ok('merge lane released');
      if (/^gh pr view/.test(line)) return ok(JSON.stringify({ number: 9, title: 'A change', state: prState, baseRefName: 'main', mergeCommit: prState === 'MERGED' ? { oid: MERGE } : null, files: (o.files || []).map((p) => ({ path: p })) }));
      if (/^gh pr merge/.test(line)) { prState = 'MERGED'; return ok('Merged pull request #9'); }
      if (/ rev-parse --abbrev-ref HEAD$/.test(line)) return ok('main');
      if (/ rev-parse HEAD$/.test(line)) return ok(head);
      if (/ rev-parse c+\^1$/.test(line)) return ok('e'.repeat(40));
      if (/ cat-file -e/.test(line)) return { code: 1, out: '' };
      if (/ pull --ff-only$/.test(line)) { if (o.pullFails) return { code: 1, out: 'fatal: Not possible to fast-forward' }; head = AFTER; publishLog = o.hook === false ? '' : `--- now after pull to ${AFTER.slice(0, 7)}\npublished: 1.0.322 (${AFTER.slice(0, 7)}) on X\n`; return ok('Updating'); }
      if (/ merge-base --is-ancestor/.test(line)) { const [, a, b] = /--is-ancestor (\S+) (\S+)$/.exec(line); return { code: a === MERGE && (b === 'HEAD' ? head === AFTER : b === AFTER || b === MERGE.slice(0, 7)) ? 0 : 1, out: '' }; }
      if (/ diff --name-only/.test(line)) return ok((o.files || []).join('\n'));
      if (/publish-share\.js/.test(line)) return ok('origin/main 1.0.322: 9 files\npublished: 1.0.322 (ccccccc) on X');
      if (/version\.js/.test(line)) return ok('1.0.322\n');
      if (/restart-host\.js/.test(line)) return ok('asked');
      if (/^gh run list -R GLODUSK\/fleet-view-share --workflow Mac --branch main /.test(line)) return o.runs ? ok(JSON.stringify(o.runs)) : { code: 1, out: 'gh: not logged in' };
      return { code: 1, out: `unexpected: ${line}` };
    },
    readTail(file) {
      if (/server\.log$/.test(file)) return o.serverLog || `x start: port 4777, version 1.0.3 (${serverCommit}), node v24`;
      if (/share-publish\.log$/.test(file)) return publishLog;
      if (/update-install\.log$/.test(file)) return 'Desktop window ready';
      return '';
    },
    readBytes: () => Buffer.from('host'),
    touch(file) { calls.push(`touch ${file}`); touched = true; serverCommit = MERGE.slice(0, 7); },
    alive: (pid) => (pid === 100 ? windowAlive : o.dead ? !o.dead.includes(pid) : true),
    windows: () => [{ pid: windowPid, command: `"M\\desktop\\node_modules\\electron\\dist\\Fleet View.exe" M\\desktop --url=http://x` }],
    closeWindow(pid) { calls.push(`close ${pid}`); windowAlive = !!o.stuck; return true; },
    detached(cmd, args) { calls.push(`detached ${[cmd, ...args].join(' ')}`); if (cmd === 'wscript.exe') windowPid = 200; return { pid: 1, exited: Promise.resolve(0) }; },
  };
  return { io, calls, said, touched: () => touched };
}
const idx = (calls, re) => calls.findIndex((c) => re.test(c));

(async () => {
  {
    const w = world({ files: ['web/app.js', 'desktop/main.js', 'desktop/host.js'] });
    const code = await S.ship({ pr: 9 }, w.io);
    const c = w.calls;
    check('PC run: exit 0', code === 0, w.said.join(' | '));
    check('PC run: lane, merge, pull, touch, close, vbs, release, restart-host in that order',
      [/merge-lane\.js take/, /^gh pr merge 9 -R GLODUSK\/fleet-view --merge$/, / pull --ff-only/, /^touch M.fleet-view\.js/, /^close 100/, /^detached wscript\.exe \/\/nologo M.fleet-view\.vbs/, /merge-lane\.js release/, /restart-host\.js/]
        .map((re) => idx(c, re)).every((v, i, a) => v >= 0 && (i === 0 || v > a[i - 1])), c.join('\n'));
    check('PC run: never --admin', !c.some((l) => /--admin/.test(l)));
    check('PC run: restart-host is the last call', /restart-host\.js/.test(c[c.length - 1]), c[c.length - 1]);
    check('PC run: the summary line', w.said.includes('1.0.322 (ccccccc) live and published; restarted: server, window; host restart next'), w.said.join('\n'));
    check('PC run: says the host version to expect', w.said.some((s) => s.includes(S.hostHash(Buffer.from('host')))));
  }
  {
    // the share repo's CI: its newest finished run on main decides (the one this publish started is still going)
    const run = (id, conclusion, at, status = 'completed') => ({ databaseId: id, conclusion, status, displayTitle: `Fleet View 1.0.${id}`, url: `https://github.com/GLODUSK/fleet-view-share/actions/runs/${id}`, createdAt: at, headBranch: 'main', event: 'push' });
    const red = world({ files: ['web/app.js'], runs: [run(5, '', '2026-10-17T10:00:00Z', 'in_progress'), run(4, 'failure', '2026-10-17T09:00:00Z'), run(3, 'failure', '2026-10-16T09:00:00Z'), run(2, 'success', '2026-10-15T09:00:00Z')] });
    await S.ship({ pr: 9, noHost: true }, red.io);
    check('share CI red: ship says so, since when, and the run', red.said.includes('share CI: RED on the last 2 runs on main since 2026-10-16 09:00 UTC (Fleet View 1.0.4): https://github.com/GLODUSK/fleet-view-share/actions/runs/4'), red.said.join('\n'));
    const green = world({ files: ['web/app.js'], runs: [run(7, 'success', '2026-10-17T11:00:00Z')] });
    await S.ship({ pr: 9, noHost: true }, green.io);
    check('share CI green: one plain line', green.said.includes('share CI: green (Fleet View 1.0.7)'), green.said.join('\n'));
    const none = world({ files: ['web/app.js'] });
    const code = await S.ship({ pr: 9, noHost: true }, none.io);
    check('share CI unknown (gh fails): no line, the ship goes on', code === 0 && !none.said.some((s) => /share CI/.test(s)), none.said.join('\n'));
  }
  {
    const w = world({ files: ['desktop/host.js'] });
    const code = await S.ship({ pr: 9, noHost: true }, w.io);
    check('--no-host: no restart-host, says to run it', code === 0 && idx(w.calls, /restart-host/) < 0 && w.said.some((s) => /--no-host/.test(s)), w.said.join(' | '));
  }
  {
    const w = world({ files: ['web/app.js'] });
    const code = await S.ship({ pr: 9, dry: true }, w.io);
    check('dry run: no lane, merge, pull, touch or publish', code === 0 && !w.calls.some((l) => /merge-lane|pr merge|pull|touch|publish-share/.test(l)), w.calls.join('\n'));
    check('dry run: prints the plan', w.said.some((s) => /server \(web\/app\.js\)/.test(s)) && w.said.some((s) => /dry run: nothing/.test(s)), w.said.join('\n'));
  }
  {
    const w = world({ files: ['web/app.js'], pullFails: true });
    let err = null;
    try { await S.ship({ pr: 9 }, w.io); } catch (e) { err = e; }
    check('a failed pull stops it with a message', err instanceof S.Stop && /pull --ff-only failed/.test(err.message), err && err.message);
    check('... and the lane is released', idx(w.calls, /merge-lane\.js release/) > idx(w.calls, / pull --ff-only/));
  }
  {
    const w = world({ files: ['desktop/main.js'], stuck: true });
    let err = null;
    try { await S.ship({ pr: 9 }, w.io); } catch (e) { err = e; }
    check('a window that will not close: stops, never killed, no vbs, lane released', err instanceof S.Stop && /not killed/.test(err.message)
      && idx(w.calls, /wscript/) < 0 && idx(w.calls, /merge-lane\.js release/) > idx(w.calls, /^close/), err && err.message);
  }
  {
    const stuckLog = 'x [node 1] start: port 4777, version 1.0.3 (0b0b0b0), node v24\n2026-10-17 01:06:46.154 [node 20820] stop: exit code 75 (update)';
    for (const platform of ['win32', 'darwin']) {
      const w = world({ platform, files: ['web/app.js'], serverLog: stuckLog });
      let err = null;
      try { await S.ship({ pr: 9 }, w.io); } catch (e) { err = e; }
      const end = platform === 'win32' ? 'Stop-Process -Id 20820 -Force' : 'kill -9 20820';
      check(`a server stuck in its exit (${platform}): names its pid, #574 and how to end it`, err instanceof S.Stop
        && /^the old server \(pid 20820\) is still running after it logged its exit \(75\): #574; the window ends it after 5 s/.test(err.message) && err.message.endsWith(end), err && err.message);
      check(`... and the lane is released (${platform})`, idx(w.calls, /merge-lane\.js release/) > idx(w.calls, /^touch/));
    }
    const w = world({ files: ['web/app.js'], serverLog: stuckLog, dead: [20820] });
    let err = null;
    try { await S.ship({ pr: 9 }, w.io); } catch (e) { err = e; }
    check('a stop line whose server is gone: the plain "did not start" message', err instanceof S.Stop && /^the server did not start on the merge within 60 s/.test(err.message), err && err.message);
  }
  {
    const w = world({ files: ['web/app.js'], laneHeld: true });
    const code = await S.ship({ pr: 9 }, w.io);
    check('lane held: waits with --wait 3600 and says so', code === 0 && idx(w.calls, /take .*--wait 3600/) > 0 && w.said.some((s) => /waiting up to an hour/.test(s)), w.calls.join('\n'));
  }
  {
    const w = world({ files: ['scripts/fv.js'], hook: false });
    const code = await S.ship({ pr: 9 }, w.io);
    check('no hook entry: runs publish-share.js itself; nothing restarted', code === 0 && idx(w.calls, /publish-share\.js/) > 0 && !w.touched()
      && w.said.some((s) => /restarted: nothing/.test(s)), w.said.join('\n'));
  }
  {
    const w = world({ files: ['web/app.js'], prState: 'MERGED', alreadyPulled: true });
    const code = await S.ship({ pr: 9 }, w.io);
    check('merged and pulled already: no merge, restarts from the merge\'s parent', code === 0 && idx(w.calls, /pr merge/) < 0 && idx(w.calls, / diff --name-only e{40} c{40}/) > 0 && w.touched(), w.calls.join('\n'));
  }
  {
    const w = world({ platform: 'darwin', files: ['web/app.js', 'desktop/host.js'] });
    const code = await S.ship({ pr: 9 }, w.io);
    const c = w.calls;
    check('Mac run: publish-share.js, release, then install.sh detached last', code === 0 && idx(c, /publish-share\.js/) > 0 && idx(c, /merge-lane\.js release/) > idx(c, /publish-share/)
      && /^detached nohup bash M.install\.sh --after-update --from b{40}$/.test(c[c.length - 1]) && idx(c, /restart-host/) < 0 && idx(c, /^close/) < 0, c.join('\n'));
    check('Mac run: summary says install.sh next', w.said.some((s) => /restarted: server; install\.sh next/.test(s)), w.said.join('\n'));
  }
  {
    const w = world({ platform: 'darwin', files: ['desktop/main.js'] });
    const code = await S.ship({ pr: 9 }, w.io);
    check('Mac run, window only: waits for install.sh and shows its log', code === 0 && w.said.some((s) => /install\.sh exited 0/.test(s)), w.said.join('\n'));
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error(e.stack || e); process.exitCode = 1; });
