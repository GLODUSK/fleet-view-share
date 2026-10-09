// Fleet View desktop: a self-test of the live sessions (terms.js and the session host, host.js), run only when
// FV_TERM_SELFTEST is set, and only against a test host (FV_HOST_PIPE; main.js refuses otherwise).
// It drives window.fleetDesktop.term from inside the main window's page, so it goes through preload.js and
// the sender checks exactly as the panel does. Results go to stdout and to FV_TERM_SELFTEST_OUT (JSON).
//   FV_TERM_SELFTEST=1     with FV_TERM_CMD (a harmless command instead of claude, honoured by the test host):
//                          output, resize, snapshot, page reload, kill, endAll, killAll, the mini view having
//                          no access (skipped with FV_TEST_HIDDEN, which never opens the mini view)
//   FV_TERM_SELFTEST=real  FV_TERM_REAL_ID / _CWD / _ACCOUNT: opens that conversation's real `claude --resume`,
//                          types nothing, waits for Claude Code's screen in the buffer, then kills it
'use strict';
const fs = require('fs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alivePid = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b[=>()][0-9A-Za-z]?/g, '');

// page-side recorder: every onData / onExit the page sees, per id
const RECORDER = `(() => {
  if (window.__fvt) return true;
  const t = window.fleetDesktop && window.fleetDesktop.term;
  if (!t) return false;
  window.__fvt = { data: {}, exits: {} };
  t.onData((id, c) => { window.__fvt.data[id] = (window.__fvt.data[id] || '') + c; });
  t.onExit((id, code) => { window.__fvt.exits[id] = code; });
  return true;
})()`;

async function run(ctx) {
  const { win, terms, mode, log } = ctx;
  const results = [];
  const check = (name, pass, detail) => { results.push({ name, pass: !!pass, detail: detail === undefined ? null : detail }); log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 300) : ''}`); };
  const page = (js) => win.webContents.executeJavaScript(js, true);
  const waitFor = async (fn, ms, step = 150) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(step); } return null; };
  const loaded = () => new Promise((r) => win.webContents.once('did-finish-load', r));

  await page(RECORDER);
  check('fleetDesktop.term is exposed in the main window', await page('typeof (window.fleetDesktop && window.fleetDesktop.term) === "object"'));

  if (mode === 'real') {
    const id = process.env.FV_TERM_REAL_ID, cwd = process.env.FV_TERM_REAL_CWD || null, account = process.env.FV_TERM_REAL_ACCOUNT || 'B';
    const r = await page(`window.fleetDesktop.term.open(${JSON.stringify({ id, cwd, account, cols: 120, rows: 32 })})`);
    check('real: open', r && r.ok && r.pid > 0, r);
    // no input at all: only wait for Claude Code to draw its screen
    const snap = await waitFor(async () => {
      const s = await page(`window.fleetDesktop.term.snapshot(${JSON.stringify(id)})`);
      const plain = strip(s);
      // the resumed screen: the conversation's text, then the prompt box (a rule of ─) and the status line
      return /─{20}/.test(plain) && /(\/effort|for shortcuts|❯|Claude Code)/.test(plain) ? s : null;
    }, 45000, 1000);
    const last = snap || (await page(`window.fleetDesktop.term.snapshot(${JSON.stringify(id)})`));
    check('real: Claude Code screen rendered into the buffer', !!snap, { bytes: last.length, plainTail: strip(last).replace(/\s+/g, ' ').slice(-600) });
    const lst = await page('window.fleetDesktop.term.list()');
    const ent = lst.find((x) => x.id === id);
    check('real: listed alive', ent && ent.alive, ent);
    await page(`window.fleetDesktop.term.kill(${JSON.stringify(id)})`);
    const code = await waitFor(() => page(`(${JSON.stringify(id)} in window.__fvt.exits) ? String(window.__fvt.exits[${JSON.stringify(id)}]) : null`), 10000);
    check('real: kill ends it (onExit)', code !== null, code);
    await sleep(800);
    check('real: process tree gone', r && !alivePid(r.pid), r && r.pid);
    check('real: forgotten after kill', !(await page('window.fleetDesktop.term.list()')).some((x) => x.id === id));
    return results;
  }

  const id = '00000000-0000-4000-8000-0000000000f1';
  // 1. a bad id is refused
  const bad = await page(`window.fleetDesktop.term.open({ id: 'x & calc', cwd: null, account: 'B' }).then(() => 'resolved', (e) => 'rejected: ' + e.message)`);
  check('bad id rejected', /^rejected/.test(bad), bad);
  // 2. open (missing cwd falls back to home), output arrives
  const r = await page(`window.fleetDesktop.term.open({ id: '${id}', cwd: 'Z:\\\\no\\\\such\\\\dir', account: 'A', cols: 100, rows: 30 })`);
  check('open ok with pid', r && r.ok && r.pid > 0, r);
  const first = await waitFor(() => page(`/Columns:\\s+100/.test(window.__fvt.data['${id}'] || '')`), 10000);
  check('onData receives output (mode con shows 100 columns)', first);
  const again = await page(`window.fleetDesktop.term.open({ id: '${id}', cwd: null, account: 'A' })`);
  check('second open of a running id: ok, same pid, nothing new', again && again.ok && again.pid === r.pid, again);
  // 3. resize: the second `mode con` sees the new size
  await page(`window.fleetDesktop.term.resize('${id}', 90, 25)`);
  const resized = await waitFor(() => page(`/Columns:\\s+90/.test(window.__fvt.data['${id}'] || '')`), 12000);
  check('resize reaches the console (mode con shows 90 columns)', resized);
  // 4. snapshot replays exactly what was received
  await sleep(300);
  const snap = await page(`window.fleetDesktop.term.snapshot('${id}')`);
  const got = await page(`window.__fvt.data['${id}'] || ''`);
  check('snapshot equals the live output so far', snap.length > 0 && snap === got, { snap: snap.length, live: got.length });
  check('child env: FV_* dropped, account A config dir, truecolor', /CFG=.*\.claude-a\b/i.test(strip(snap)) && /FVX=%FV_TERM_SELFTEST%/.test(strip(snap)) && /CT=truecolor/.test(strip(snap)), strip(snap).match(/(CFG|FVX|CT)=[^\r\n]*/g));
  // 5. a page reload keeps the pty; the snapshot replays it
  const reload = loaded();
  win.webContents.reload();
  await reload;
  await page(RECORDER);
  const after = await page(`window.fleetDesktop.term.snapshot('${id}')`);
  const lst = await page('window.fleetDesktop.term.list()');
  check('pty survives a page reload, snapshot replays', after.startsWith(snap) && lst.some((x) => x.id === id && x.alive), { len: after.length, list: lst });
  // 6. (closing the window no longer asks or ends anything: the host keeps the sessions)
  // 7. kill ends the whole tree, onExit fires, then it is forgotten
  const kids = ctx.children(r.pid);
  await page(`window.fleetDesktop.term.kill('${id}')`);
  const code = await waitFor(() => page(`('${id}' in window.__fvt.exits) ? String(window.__fvt.exits['${id}']) : null`), 8000);
  check('kill: onExit fires', code !== null, code);
  await sleep(800);
  check('kill: process tree gone (cmd and its ping child)', kids.length > 0 && !alivePid(r.pid) && kids.every((k) => !alivePid(k.pid)), { pid: r.pid, children: kids, stillAlive: kids.filter((k) => alivePid(k.pid)) });
  check('kill: forgotten (list empty, snapshot empty)', (await page('window.fleetDesktop.term.list()')).length === 0 && (await page(`window.fleetDesktop.term.snapshot('${id}')`)) === '');
  // 8. endAll (what "Quit everything" runs in the host): Ctrl+C, then the tree
  const id2 = '00000000-0000-4000-8000-0000000000f2';
  const r2 = await page(`window.fleetDesktop.term.open({ id: '${id2}', cwd: null, account: 'B' })`);
  await waitFor(() => page(`/Columns/.test(window.__fvt.data['${id2}'] || '')`), 10000);
  const kids2 = ctx.children(r2.pid);
  const t0 = Date.now();
  await terms.endAll(1200);
  const ms = Date.now() - t0;
  await waitFor(() => terms.aliveCount() === 0, 2000, 50);
  check('endAll: Ctrl+C, then the tree; all gone, onExit reached the page', !alivePid(r2.pid) && kids2.length > 0 && kids2.every((k) => !alivePid(k.pid)) && terms.aliveCount() === 0
    && (await page(`'${id2}' in window.__fvt.exits`)), { ms, pid: r2.pid, children: kids2, kidsAlive: kids2.filter((k) => alivePid(k.pid)) });
  // the backstop: killAll ends every tree at once
  const id3 = '00000000-0000-4000-8000-0000000000f3';
  const r3 = await page(`window.fleetDesktop.term.open({ id: '${id3}', cwd: null, account: 'B' })`);
  await waitFor(() => page(`/Columns/.test(window.__fvt.data['${id3}'] || '')`), 10000);
  const kids3 = ctx.children(r3.pid);
  await terms.killAll();
  await waitFor(() => terms.aliveCount() === 0, 2000, 50);
  check('killAll ends every tree', !alivePid(r3.pid) && kids3.length > 0 && kids3.every((k) => !alivePid(k.pid)) && terms.aliveCount() === 0 && (await terms.list()).length === 0, { pid: r3.pid, children: kids3, kidsAlive: kids3.filter((k) => alivePid(k.pid)) });
  // 9. the mini view has no term (not with FV_TEST_HIDDEN: the mini view would show)
  if (!ctx.hidden) {
    const mini = await ctx.miniPage();
    check('mini view: no fleetDesktop.term', mini === 'undefined', mini);
  }
  return results;
}

module.exports = { run, write: (file, obj) => { try { if (file) fs.writeFileSync(file, JSON.stringify(obj, null, 2)); } catch {} } };
