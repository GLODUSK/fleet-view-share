// Share repo health, on Henry's own checkouts only (where scripts/publish-share.js is: a friend's install of the share
// repo has none, and this stays off there): is the share repo's CI green, and did the last publish go out?
//   - CI: the "Mac" workflow of GLODUSK/fleet-view-share (.github/workflows/mac.yml: every test on macOS and Windows,
//     the Mac install and app) on main, read with `gh run list` every 30 minutes, every 5 while a run is going or a
//     publish is recent (share-publish.log changed in the last 20 minutes: the run it starts takes about 5)
//   - publish: share-publish.log's newest entry (the post-merge hook's log on the PC; the Mac's ship.js publishes in
//     its own output, so there it is null)
// red: the newest finished run on main failed, or the newest publish failed. server.log gets one line when it turns red
// and one when it is green again; the page's header shows a red pill (web/share-health.js) and raises one desktop
// notification per red run; scripts/ship.js says the same line in its summary (ciLine).
//   GET /share-health -> { ok, enabled, red, ci: { state, title, url, at, since, reds } | null,
//                          publish: { state, at, line } | null, checkedAt, error? }
//     ci.state: 'green' | 'red' | null (no finished run read); ci.running: a run on main is going now; since: when the
//     first of the reds in a row ran; reds: how many in a row
//     publish.state: 'published' | 'already' | 'failed' | 'running'
'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const SHARE = process.env.FV_SHARE_REPO || 'GLODUSK/fleet-view-share';
const WORKFLOW = 'Mac';
const SLOW_MS = 30 * 60e3, FAST_MS = 5 * 60e3, FIRST_MS = 90e3, RECENT_PUBLISH_MS = 20 * 60e3;
const RUN_FIELDS = 'databaseId,conclusion,status,displayTitle,url,createdAt,headBranch,event';

// gh run list's runs (newest first) -> the state of main: the newest finished push run decides it; the reds counted
// back to the last green one
function ciState(runs) {
  const list = (Array.isArray(runs) ? runs : []).filter((r) => r && r.headBranch === 'main' && (!r.event || r.event === 'push'));
  const done = list.filter((r) => r.status === 'completed' && r.conclusion !== 'cancelled' && r.conclusion !== 'skipped');
  const running = list.some((r) => r.status && r.status !== 'completed');
  if (!done.length) return { state: null, running };
  const top = done[0];
  const ok = top.conclusion === 'success';
  let reds = 0, since = null;
  if (!ok) for (const r of done) { if (r.conclusion === 'success') break; reds++; since = r.createdAt || since; }
  return { state: ok ? 'green' : 'red', running, title: String(top.displayTitle || ''), url: String(top.url || ''), at: top.createdAt || null,
    id: top.databaseId || null, since: ok ? null : since, reds, more: !ok && reds === done.length };
}

// the line for a summary (ship.js): "share CI: green (Fleet View 1.0.398)" / "share CI: RED on the last 46 runs since
// 2026-10-11 05:21 UTC ... <url>"; null when nothing was read
function ciLine(ci) {
  if (!ci || !ci.state) return null;
  if (ci.state === 'green') return `share CI: green (${ci.title || 'the newest run on main'})${ci.running ? '; a run is going now' : ''}`;
  const when = ci.since ? ` since ${ci.more ? 'at least ' : ''}${String(ci.since).replace('T', ' ').replace(/:\d\d(?:\.\d+)?Z$/, ' UTC')}` : '';
  return `share CI: RED on the last ${ci.reds}${ci.more ? '+' : ''} run${ci.reds === 1 ? '' : 's'} on main${when} (${ci.title}): ${ci.url}`;
}

// share-publish.log's newest entry ("--- <date> after pull to <sha>" and the lines below it):
// { state: 'published' | 'already' | 'failed' | 'running', at, sha, line } or null
function publishState(text) {
  const lines = String(text || '').split(/\r?\n/);
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (/^--- .* after pull to [0-9a-f]{7,40}\s*$/.test(lines[i])) { start = i; break; }
  if (start < 0) return null;
  const head = /^--- (.*) after pull to ([0-9a-f]{7,40})/.exec(lines[start]);
  const body = lines.slice(start + 1).map((l) => l.trim()).filter(Boolean);
  const at = Date.parse(head[1].replace(' ', 'T')) || null;
  const pick = (re) => body.find((l) => re.test(l));
  let l;
  if ((l = pick(/^published: /))) return { state: 'published', at, sha: head[2], line: l };
  if ((l = pick(/the share repo already has this version/))) return { state: 'already', at, sha: head[2], line: l };
  // (the same lines as scripts/ship.js parsePublish)
  if ((l = pick(/^refused:|^\S*Error\b|^fatal:|^could not publish/))) return { state: 'failed', at, sha: head[2], line: l };
  return { state: 'running', at, sha: head[2], line: body[body.length - 1] || '' };
}

// o: { root (the checkout), dataDir, log, now?, gh? (args -> Promise of stdout) }
function createShareHealth(o) {
  const now = o.now || Date.now;
  const enabled = fs.existsSync(path.join(o.root, 'scripts', 'publish-share.js'));
  const logFile = path.join(o.dataDir, 'share-publish.log');
  const gh = o.gh || ((args) => new Promise((resolve, reject) => execFile('gh', args, { timeout: 30e3, windowsHide: true, maxBuffer: 4 << 20 },
    (err, out, errOut) => (err ? reject(new Error(String(errOut || err.message).trim().split(/\r?\n/)[0])) : resolve(String(out))))));
  let ci = null, publish = null, checkedAt = 0, error = '', wasRed = null, timer = null, busy = false;

  function readPublish() {
    try {
      const st = fs.statSync(logFile);
      const fd = fs.openSync(logFile, 'r');
      try {
        const n = Math.min(st.size, 64 << 10), buf = Buffer.alloc(n);
        fs.readSync(fd, buf, 0, n, st.size - n);
        const p = publishState(buf.toString('utf8'));
        return p ? { ...p, changedAt: st.mtimeMs } : null;
      } finally { fs.closeSync(fd); }
    } catch { return null; }
  }
  const red = () => !!((ci && ci.state === 'red') || (publish && publish.state === 'failed'));

  async function refresh() {
    if (!enabled || busy) return view();
    busy = true;
    try {
      publish = readPublish();
      try {
        ci = ciState(JSON.parse(await gh(['run', 'list', '-R', SHARE, '--workflow', WORKFLOW, '--branch', 'main', '--limit', '30', '--json', RUN_FIELDS])));
        error = '';
      } catch (e) { error = `gh run list: ${e.message}`; }
      checkedAt = now();
      const r = red();
      if (wasRed !== null && r !== wasRed && o.log) {
        o.log(r ? `share health: red: ${[ci && ci.state === 'red' ? ciLine(ci) : '', publish && publish.state === 'failed' ? `publish failed: ${publish.line}` : ''].filter(Boolean).join('; ')}`
          : 'share health: green again');
      }
      wasRed = r;
    } finally { busy = false; }
    return view();
  }
  function view() {
    return { ok: true, enabled, red: red(), ci, publish: publish ? { state: publish.state, at: publish.at, line: publish.line } : null, checkedAt, ...(error ? { error } : {}) };
  }
  function nextIn() {
    const recent = publish && publish.changedAt && now() - publish.changedAt < RECENT_PUBLISH_MS;
    return (ci && ci.running) || recent ? FAST_MS : SLOW_MS;
  }
  // one timer at a time: a look that ends after the timer was set again (a new publish meanwhile, or stop) sets none
  let gen = 0;
  function loop(ms) {
    clearTimeout(timer);
    const g = ++gen;
    timer = setTimeout(() => { refresh().catch(() => {}).finally(() => { if (g === gen) loop(nextIn()); }); }, ms);
    if (timer.unref) timer.unref();
  }
  function start() {
    if (!enabled || timer) return;
    loop(FIRST_MS);
    // a new publish: look again in about 6 minutes, once its run has finished
    try { fs.watchFile(logFile, { interval: 30e3 }, () => { if (timer) loop(6 * 60e3); }); } catch {}
  }
  function stop() { gen++; clearTimeout(timer); timer = null; try { fs.unwatchFile(logFile); } catch {} }
  // GET /share-health
  function handle(req, res, pathname, h) {
    if (pathname !== '/share-health' || req.method !== 'GET') return h.sendJson(res, 404, { ok: false, message: 'not found' });
    // the newest publish line at once (a file read); the CI as last looked
    if (enabled) publish = readPublish();
    return h.sendJson(res, 200, view());
  }
  return { enabled, start, stop, refresh, view, handle };
}

module.exports = { createShareHealth, ciState, ciLine, publishState, SHARE, WORKFLOW, RUN_FIELDS };
